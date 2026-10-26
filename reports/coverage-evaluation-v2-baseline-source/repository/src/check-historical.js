import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { replay } from './server.js';
import { RpcClient, RpcError, assertNoProviderErrorResult } from './rpc.js';
import { EXAMPLES, USDC, HUSDC, VUSDC } from './config.js';

export const HISTORICAL_PROVIDERS = [
  { id: 'drpc', url: 'https://hyperliquid.drpc.org' },
  { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' },
];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DIRECTORY = resolve(ROOT, 'reports/historical-comparisons');
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const UINT = /^(?:0x[0-9a-f]+|[0-9]+)$/i;
const INT = /^-?(?:0|[1-9][0-9]*)$/;
const MAX = (1n << 256n) - 1n;
const IDENTITY_FIELDS = ['transactionHash', 'transactionIndex', 'postTransactionIndex', 'stateBlockHash', 'blockNumber', 'timestamp', 'stateBinding', 'headerContext', 'method'];
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const choose = (object, fields) => Object.fromEntries(fields.map(field => [field, object?.[field] ?? null]));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function exact(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? INT : UINT).test(value)) throw new Error('Invalid exact amount.');
  const result = BigInt(value);
  if (result > MAX || result < (signed ? -MAX : 0n)) throw new Error('Exact amount exceeds supported bounds.');
  return result.toString();
}
function optionalQuantity(value) { return value === undefined || value === null ? null : exact(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value); }
function logProjection(log, receipt = false) {
  return {
    address: lower(log.address), topics: (log.topics ?? []).map(lower), data: lower(log.data),
    ...(receipt ? { logIndex: optionalQuantity(log.logIndex), transactionIndex: optionalQuantity(log.transactionIndex), transactionHash: lower(log.transactionHash), blockHash: lower(log.blockHash), blockNumber: optionalQuantity(log.blockNumber) } : { position: optionalQuantity(log.position) }),
  };
}
function traceProjection(frame) {
  if (!frame || typeof frame !== 'object' || !frame.type) throw new Error('Missing original trace.');
  return {
    type: frame.type.toUpperCase(), from: lower(frame.from), to: lower(frame.to), input: lower(frame.input ?? '0x'), output: lower(frame.output ?? '0x'),
    value: optionalQuantity(frame.value ?? '0'), gas: optionalQuantity(frame.gas), gasUsed: optionalQuantity(frame.gasUsed),
    error: frame.error ?? null, revertReason: frame.revertReason ?? null,
    logs: (frame.logs ?? []).map(log => logProjection(log)), calls: (frame.calls ?? []).map(traceProjection),
  };
}
function receiptProjection(receipt) {
  if (!receipt || !HASH.test(receipt.transactionHash ?? '') || !Array.isArray(receipt.logs)) throw new Error('Missing original receipt.');
  return {
    transactionHash: lower(receipt.transactionHash), blockHash: lower(receipt.blockHash), from: lower(receipt.from), to: lower(receipt.to),
    ...Object.fromEntries(['transactionIndex', 'blockNumber', 'status', 'type', 'gasUsed', 'cumulativeGasUsed', 'effectiveGasPrice'].map(field => [field, optionalQuantity(receipt[field])])),
    logs: receipt.logs.map(log => logProjection(log, true)),
  };
}
function balanceProjection(measurement) {
  if (measurement?.status !== 'measured' || !Array.isArray(measurement.assets) || !measurement.assets.length) throw new Error('Historical measurement unavailable.');
  const seen = new Set();
  const assets = measurement.assets.map(item => {
    if (!ADDRESS.test(item.account ?? '') || !ADDRESS.test(item.asset?.address ?? '')) throw new Error('Invalid balance identity.');
    const key = `${lower(item.account)}:${lower(item.asset.address)}`;
    if (seen.has(key)) throw new Error('Duplicate balance entry.');
    seen.add(key);
    const beforeRaw = exact(item.beforeRaw), afterRaw = exact(item.afterRaw), deltaRaw = exact(item.deltaRaw, true);
    if (BigInt(afterRaw) - BigInt(beforeRaw) !== BigInt(deltaRaw)) throw new Error('Inconsistent measured delta.');
    return { account: lower(item.account), address: lower(item.asset.address), role: item.asset.role ?? null, beforeRaw, afterRaw, deltaRaw };
  }).sort((a, b) => `${a.account}:${a.address}`.localeCompare(`${b.account}:${b.address}`));
  return { status: measurement.status, basis: measurement.basis, executionIdentity: choose(measurement.executionIdentity, IDENTITY_FIELDS), assets };
}
function eventProjection(report) {
  return {
    movements: (report.movements ?? []).map(item => ({ address: lower(item.address), from: lower(item.from), to: lower(item.to), amountRaw: exact(item.amountRaw) })),
    positions: (report.positionChanges ?? []).map(item => choose(item, ['token', 'account', 'event', 'role', 'valueRaw', 'accruedInterestRaw', 'indexRaw', 'deltaRaw'])),
    interest: (report.interestAccruals ?? []).map(item => choose(item, ['address', 'caller', 'onBehalfOf', 'valueRaw', 'balanceIncreaseRaw', 'mintEventImpliedPrincipalRaw', 'indexRaw'])),
    protocol: choose(report.protocol, ['name', 'operation', 'asset', 'account', 'recipient', 'onBehalfOf', 'amountRaw', 'actualAmountRaw', 'positionToken', 'positionAccount', 'positionDeltaRaw', 'transferredDepositPrincipalRaw', 'mintEventImpliedPrincipalRaw', 'roundingDifferenceRaw']),
    incoming: report.inAssets, outgoing: report.outAssets,
  };
}

// Amounts independently transcribed from original receipt events and calldata in
// reports/lending-discovery/*-decoded.json and the historical supply evidence.
const KNOWN = {
  supply: { cash: '-15066115', eventPositionDelta: '15066114', eventValue: '15066497', eventInterest: '383', positionToken: HUSDC, gasUsed: '165727' },
  withdraw: { cash: '503900226', eventPositionDelta: '-503900226', eventValue: '503885190', eventInterest: '15036', positionToken: HUSDC, gasUsed: '415253' },
  borrow: { cash: '835474410', eventPositionDelta: '835474410', eventValue: '835476148', eventInterest: '1738', positionToken: VUSDC, gasUsed: '426217' },
  repay: { cash: '-199626280', eventPositionDelta: '-199626279', eventValue: '199626071', eventInterest: '208', positionToken: VUSDC, gasUsed: '164961' },
};

/** Read saved original execution evidence; never derive expected amounts from the analyzer. */
export async function loadHistoricalCases() {
  const cases = [];
  for (const operation of ['supply', 'withdraw', 'borrow', 'repay']) {
    const id = `hyperlend-usdc-${operation}`;
    const example = EXAMPLES.find(item => item.id === id);
    const fixturePath = `fixtures/hyperlend-observed-historical-${operation}.json`;
    const fixtureBytes = await readFile(resolve(ROOT, fixturePath));
    const fixture = JSON.parse(fixtureBytes);
    const sourceBytes = await readFile(resolve(ROOT, fixture.provenance.sourceArtifact));
    // Earlier fixtures used sorted-key canonical JSON; later captures retained
    // insertion order. Verify either recorded encoding, then compare source data.
    const traceHashes = [sha256(JSON.stringify(fixture.input.trace)), sha256(JSON.stringify(stable(fixture.input.trace)))];
    if (!example || example.transactionHash !== fixture.provenance.transactionHash || sha256(sourceBytes) !== fixture.provenance.sourceSha256 || !traceHashes.includes(fixture.provenance.traceCanonicalJsonSha256)) throw new Error('Saved historical evidence failed integrity checks.');
    const source = JSON.parse(sourceBytes);
    const receipt = operation === 'supply' ? source.results.find(item => item.id === fixture.provenance.sourceResultId)?.response?.evidence?.receipt : source.captures.receipt.response.result;
    const originalTrace = operation === 'supply' ? source.results.find(item => item.id === fixture.provenance.sourceResultId)?.response?.evidence?.traceResponse : source.captures.historicalTrace.response.result;
    if (!same(originalTrace, fixture.input.trace)) throw new Error('Saved historical trace differs from its source.');
    const transactionIndex = exact(receipt.transactionIndex);
    const block = fixture.input.block;
    cases.push({ id, operation, request: { chainId: 999, transactionHash: example.transactionHash }, originalRequest: fixture.input.request,
      expected: { ...KNOWN[operation], transactionHash: example.transactionHash, transactionIndex, block, account: lower(fixture.input.request.from) },
      evidence: { fixture: fixturePath, fixtureSha256: sha256(fixtureBytes), sourceArtifact: fixture.provenance.sourceArtifact, sourceSha256: fixture.provenance.sourceSha256, traceCanonicalJsonSha256: fixture.provenance.traceCanonicalJsonSha256, receipt, trace: fixture.input.trace },
    });
  }
  return cases;
}

function validateReport(report, item) {
  const checks = [];
  const check = (name, actual, expected) => checks.push({ name, equal: same(actual, expected), actual, expected });
  const expected = item.expected;
  check('historical successful execution', report.execution?.status, 'success');
  check('recorded gas usage', report.execution?.gasUsed, expected.gasUsed);
  check('original transaction request', report.request, item.originalRequest);
  check('original historical source identity', choose(report.source, ['chainId', 'transactionHash', 'transactionIndex', 'blockNumber', 'blockHash', 'timestamp', 'mode', 'blockBinding']), {
    chainId: 999, transactionHash: expected.transactionHash, transactionIndex: expected.transactionIndex,
    blockNumber: expected.block.number, blockHash: expected.block.hash, timestamp: expected.block.timestamp, mode: 'historical_trace', blockBinding: 'transaction_hash',
  });
  check('original receipt evidence', receiptProjection(report.evidence?.receipt), receiptProjection(item.evidence.receipt));
  check('original call trace evidence', traceProjection(report.evidence?.traceResponse), traceProjection(item.evidence.trace));
  const balances = balanceProjection(report.balanceChanges);
  check('historical balance basis', balances.basis, 'historical_transaction_position_balanceOf');
  check('historical balance execution identity', balances.executionIdentity, {
    transactionHash: expected.transactionHash, transactionIndex: expected.transactionIndex, postTransactionIndex: (BigInt(expected.transactionIndex) + 1n).toString(),
    stateBlockHash: expected.block.hash, blockNumber: expected.block.number, timestamp: expected.block.timestamp,
    stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', method: 'debug_traceCallMany',
  });
  const cash = balances.assets.find(asset => asset.account === expected.account && asset.address === USDC);
  const position = balances.assets.find(asset => asset.account === expected.account && asset.address === expected.positionToken);
  check('independent known historical USDC cash delta', cash?.deltaRaw ?? null, expected.cash);
  check('position balance is present', Boolean(position), true);
  check('known operation', report.protocol?.operation, item.operation);
  const absoluteCash = (BigInt(expected.cash) < 0n ? -BigInt(expected.cash) : BigInt(expected.cash)).toString();
  check('independent original requested principal', report.protocol?.amountRaw ?? null, absoluteCash);
  check('independent actual historical principal', item.operation === 'supply' ? report.protocol?.transferredDepositPrincipalRaw : report.protocol?.actualAmountRaw, absoluteCash);
  const cashMovement = (report.movements ?? []).filter(movement => lower(movement.address) === USDC);
  check('independent known USDC Transfer amount', cashMovement.length === 1 ? exact(cashMovement[0].amountRaw) : null, absoluteCash);
  check('independent known USDC Transfer direction', cashMovement.length === 1 ? { from: lower(cashMovement[0].from), to: lower(cashMovement[0].to) } : null,
    BigInt(expected.cash) < 0n ? { from: expected.account, to: HUSDC } : { from: HUSDC, to: expected.account });
  const positionEvent = item.operation === 'supply' ? (report.interestAccruals ?? []).find(entry => lower(entry.address) === HUSDC) : (report.positionChanges ?? []).find(entry => lower(entry.token) === expected.positionToken && lower(entry.account) === expected.account);
  check('independent known position event value', positionEvent?.valueRaw ?? null, expected.eventValue);
  check('independent known accrued interest', positionEvent?.balanceIncreaseRaw ?? positionEvent?.accruedInterestRaw ?? null, expected.eventInterest);
  check('independent known event-implied position delta', item.operation === 'supply' ? report.protocol?.mintEventImpliedPrincipalRaw : report.protocol?.positionDeltaRaw, expected.eventPositionDelta);
  check('liability excluded from spendable assets', [...(report.inAssets ?? []), ...(report.outAssets ?? [])].filter(asset => lower(asset.asset?.address) === VUSDC).length, 0);
  if (expected.positionToken === VUSDC) check('debt balance classified as liability', position?.role ?? null, 'liability');
  return { checks, balances, observations: position ? [{
    kind: 'measured_position_vs_event_implied', token: expected.positionToken, measuredDeltaRaw: position.deltaRaw,
    eventImpliedDeltaRaw: expected.eventPositionDelta, differenceRaw: (BigInt(position.deltaRaw) - BigInt(expected.eventPositionDelta)).toString(),
    differs: position.deltaRaw !== expected.eventPositionDelta,
    explanation: 'Measured historical balances are compared independently with event-implied principal. A difference is reported explicitly; events are not substituted for balance queries.',
  }] : [] };
}

/** Compare exact original executions and measured positions, excluding run IDs and timing. */
export function compareHistoricalReports(left, right, item) {
  try {
    if (!left || !right) throw new Error('Both reports are required.');
    const validated = [validateReport(left, item), validateReport(right, item)];
    const checks = validated.flatMap((result, index) => result.checks.map(check => ({ ...check, provider: index === 0 ? 'left' : 'right' })));
    const compare = (name, a, b) => checks.push({ name, equal: same(a, b), left: a, right: b });
    compare('cross-provider original receipt', receiptProjection(left.evidence.receipt), receiptProjection(right.evidence.receipt));
    compare('cross-provider original call trace', traceProjection(left.evidence.traceResponse), traceProjection(right.evidence.traceResponse));
    compare('cross-provider interpreted events', eventProjection(left), eventProjection(right));
    compare('cross-provider exact historical balances', validated[0].balances, validated[1].balances);
    const matches = checks.every(check => check.equal);
    return { status: matches ? 'matched' : 'mismatched', matches, checks, observations: validated.map(result => result.observations) };
  } catch {
    return { status: 'incomplete', matches: false, checks: [], observations: [], reason: 'Both providers must return well-formed original execution evidence and measured historical balances with valid exact amounts.' };
  }
}

function safeError(error) {
  const codes = new Set(['RPC_ERROR', 'METHOD_NOT_ALLOWED', 'INVALID_RPC_URL', 'RPC_HTTP_ERROR', 'RPC_RESPONSE_TOO_LARGE', 'RPC_INVALID_RESPONSE', 'RPC_EXECUTION_ERROR', 'RPC_TIMEOUT', 'RPC_CONNECTION_ERROR', 'RPC_CHAIN_MISMATCH', 'BLOCK_UNAVAILABLE', 'BLOCK_MISMATCH', 'TRACE_UNAVAILABLE', 'TRACE_MISMATCH', 'TRANSACTION_UNAVAILABLE', 'TRACE_RECEIPT_MISMATCH', 'TRANSACTION_CHANGED']);
  return { code: error instanceof RpcError && codes.has(error.code) ? error.code : 'HISTORICAL_CHECK_ERROR', message: 'The read-only historical check could not be completed.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}
function trackedClient(provider, rpcFactory) {
  const rpc = rpcFactory({ url: provider.url });
  const records = [], call = rpc.call.bind(rpc);
  let sequence = 0;
  rpc.call = async (method, params = []) => {
    const record = { sequence: ++sequence, request: { jsonrpc: '2.0', id: rpc.nextId, method, params: structuredClone(params) } };
    records.push(record);
    const start = performance.now();
    try { const result = await call(method, params); assertNoProviderErrorResult(method, result); record.response = { jsonrpc: '2.0', id: record.request.id, result: structuredClone(result) }; return result; }
    catch (error) { record.error = safeError(error); throw error; }
    finally { record.durationMs = Math.round(performance.now() - start); }
  };
  return { rpc, records };
}

/** Exactly four original transaction hashes × two fixed public providers; no retries. */
export async function runHistoricalChecks({ outputDirectory = DEFAULT_DIRECTORY, writeReport = true, rpcFactory = options => new RpcClient(options), replayImpl = replay } = {}) {
  const createdAt = new Date().toISOString();
  const report = { schemaVersion: '1.0', createdAt, kind: 'bounded_historical_transaction_position_comparison', status: 'incomplete', providers: HISTORICAL_PROVIDERS, cases: [],
    summary: { matched: 0, mismatched: 0, incomplete: 0, total: 4 },
    limitations: [
      'Four known historical transactions and two providers form a reviewed regression check, not held-out evaluation or a general accuracy claim.',
      'Providers may share infrastructure or the same execution engine; agreement does not prove independent implementation correctness.',
      'Durations are individual observations, not a performance benchmark or ranking.',
      'Original transaction hashes and positions remain fixed; no alternate blocks, retries, signatures or broadcasts are used.',
      'Full successful public RPC requests/results and API responses are retained. Arbitrary provider exception text is replaced with fixed messages and bounded codes.',
      'No vendor score or security detection assessment is produced. Event-derived principal is compared with measured historical positions rather than treated as a balance query.',
    ],
  };
  try {
    for (const item of await loadHistoricalCases()) {
      const runs = [];
      for (const provider of HISTORICAL_PROVIDERS) {
        let tracked;
        const start = performance.now();
        try {
          tracked = trackedClient(provider, rpcFactory);
          const response = await replayImpl(structuredClone(item.request), tracked.rpc);
          runs.push({ provider: provider.id, request: item.request, response, durationMs: Math.round(performance.now() - start), rpcCalls: tracked.records });
        } catch (error) {
          runs.push({ provider: provider.id, request: item.request, error: safeError(error), durationMs: Math.round(performance.now() - start), rpcCalls: tracked?.records ?? [] });
        }
      }
      const comparison = compareHistoricalReports(runs[0].response, runs[1].response, item);
      report.cases.push({ id: item.id, operation: item.operation, expected: item.expected, evidence: item.evidence, status: comparison.status, comparison, runs });
      report.summary[comparison.status]++;
    }
    report.status = report.summary.matched === report.summary.total ? 'passed' : 'failed';
  } catch (error) {
    report.error = safeError(error);
    report.summary.incomplete = report.summary.total - report.summary.matched - report.summary.mismatched;
    report.status = 'failed';
  }
  if (writeReport) {
    await mkdir(outputDirectory, { recursive: true });
    report.outputPath = resolve(outputDirectory, createdAt.replace(/[:.]/g, '-') + '.json');
    await writeFile(report.outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { console.error('Usage: node src/check-historical.js'); process.exitCode = 1; }
  else try {
    const report = await runHistoricalChecks();
    console.log(`Historical comparison: ${report.summary.matched}/${report.summary.total} matched (${report.summary.mismatched} mismatched, ${report.summary.incomplete} incomplete).`);
    for (const item of report.cases) for (const [index, observations] of (item.comparison.observations ?? []).entries()) for (const observation of observations) {
      if (observation.differs) console.log(`${item.id} ${report.providers[index].id}: measured position ${observation.measuredDeltaRaw}, event-implied ${observation.eventImpliedDeltaRaw}, difference ${observation.differenceRaw} raw units.`);
    }
    if (report.outputPath) console.log(`Evidence: ${report.outputPath}`);
    console.log('No vendor score; these observations are not a performance benchmark.');
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch { console.error('The historical check could not be saved or completed.'); process.exitCode = 1; }
}
