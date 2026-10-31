import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from './server.js';
import { RpcClient, RpcError, normalizeBlock } from './rpc.js';
import { EXAMPLES, USDC } from './config.js';

const PROVIDERS = [
  { id: 'drpc', url: 'https://hyperliquid.drpc.org' },
  { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' },
];
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../reports/comparisons/', import.meta.url));
const HASH = /^0x[0-9a-f]{64}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const exact = value => value == null ? null : BigInt(value).toString();
const choose = (object, fields) => Object.fromEntries(fields.map(field => [field, object?.[field] ?? null]));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function assets(items, direction) {
  return (items ?? []).map(item => ({
    address: lower(item.asset?.address), decimals: item.asset?.decimals ?? null,
    transfers: (item[direction] ?? []).map(transfer => ({ amountRaw: exact(transfer.rawValue), value: transfer.value ?? null })),
  })).sort((a, b) => String(a.address).localeCompare(String(b.address)));
}

/** Excludes run IDs, timestamps, provider names, timings and trace-specific paths. */
export function comparisonProjection(report) {
  const protocol = choose(report.protocol, ['name', 'operation', 'asset', 'amountRaw',
    'requestedDepositPrincipalRaw', 'transferredDepositPrincipalRaw', 'mintEventImpliedPrincipalRaw',
    'roundingDifferenceRaw', 'actualAmountRaw', 'positionToken', 'positionAccount', 'positionDeltaRaw']);
  protocol.principalReconciliation = choose(report.protocol?.principalReconciliation,
    ['status', 'model', 'minImpliedPrincipalRaw', 'maxImpliedPrincipalRaw', 'scaledAmountRaw', 'indexRaw', 'implementation']);
  return {
    request: choose(report.request, ['chainId', 'from', 'to', 'data', 'value']),
    block: choose(report.source, ['chainId', 'blockNumber', 'blockHash']),
    execution: {
      status: report.execution?.status ?? null, gasUsed: report.execution?.gasUsed ?? null,
      returnData: lower(report.execution?.returnData) ?? null,
      revert: report.execution?.revert ? choose(report.execution.revert, ['selector', 'kind', 'code', 'message', 'source']) : null,
    },
    eventMovements: (report.movements ?? []).map(movement => ({
      address: lower(movement.address), from: lower(movement.from), to: lower(movement.to), amountRaw: exact(movement.amountRaw),
    })),
    incoming: assets(report.inAssets, 'transferIn'), outgoing: assets(report.outAssets, 'transferOut'),
    principalAndRounding: protocol,
    interest: (report.interestAccruals ?? []).map(item => choose(item,
      ['address', 'caller', 'onBehalfOf', 'valueRaw', 'balanceIncreaseRaw', 'mintEventImpliedPrincipalRaw', 'indexRaw'])),
    positions: (report.positionChanges ?? []).map(item=>choose(item,['token','account','event','role','valueRaw','accruedInterestRaw','indexRaw','deltaRaw'])),
    allowances: report.allowanceChanges?.status==='measured' ? {
      status:'measured', executionIdentity:report.allowanceChanges.executionIdentity,
      values:report.allowanceChanges.allowances.map(item=>({address:item.asset.address,...choose(item,['owner','spender','beforeRaw','afterRaw','deltaRaw','changed'])})).sort((a,b)=>`${a.address}:${a.owner}:${a.spender}`.localeCompare(`${b.address}:${b.owner}:${b.spender}`)),
    } : {status:report.allowanceChanges?.status??'not_present'},
  };
}

function usableReport(report) {
  return report && ['success', 'reverted', 'failed'].includes(report.execution?.status) &&
    typeof report.execution?.gasUsed === 'string' && DECIMAL.test(report.execution.gasUsed) &&
    typeof report.source?.blockNumber === 'string' && DECIMAL.test(report.source.blockNumber) &&
    HASH.test(report.source?.blockHash ?? '') && Array.isArray(report.movements);
}

function balanceProjection(report) {
  const measured = report.balanceChanges;
  if (measured?.status !== 'measured') return null;
  return {
    status: measured.status, basis: measured.basis,
    executionIdentity: choose(measured.executionIdentity, ['stateBlockHash', 'blockNumber', 'timestamp', 'stateBinding', 'headerContext', 'method']),
    assets: (measured.assets ?? []).map(item => ({
      address: lower(item.asset?.address), decimals: item.asset?.decimals ?? null, account: lower(item.account),
      beforeRaw: exact(item.beforeRaw), afterRaw: exact(item.afterRaw), deltaRaw: exact(item.deltaRaw),
    })).sort((a, b) => `${a.account}:${a.address}`.localeCompare(`${b.account}:${b.address}`)),
  };
}

/** Compares interpreted semantics only. Original full responses stay in the report. */
export function compareReports(left, right, pinnedBlock) {
  if (!usableReport(left) || !usableReport(right)) {
    return { status: 'incomplete', matches: false, checks: [], reason: 'Both providers must return valid simulation reports.' };
  }
  let leftProjection, rightProjection, leftBalances, rightBalances;
  try {
    leftProjection = comparisonProjection(left); rightProjection = comparisonProjection(right);
    leftBalances = balanceProjection(left); rightBalances = balanceProjection(right);
  } catch {
    return { status: 'incomplete', matches: false, checks: [], reason: 'A response contains malformed exact amounts.' };
  }
  const checks = [];
  const blockIdentityMatches = [left, right].every(report => report.source.chainId === 999 &&
    report.source.blockNumber === pinnedBlock.number && lower(report.source.blockHash) === lower(pinnedBlock.hash));
  checks.push({ name: 'pinned block identity', assessed: true, equal: blockIdentityMatches,
    expected: { chainId: 999, number: pinnedBlock.number, hash: lower(pinnedBlock.hash) },
    left: leftProjection.block, right: rightProjection.block });
  for (const field of ['request', 'execution', 'eventMovements', 'incoming', 'outgoing', 'principalAndRounding', 'interest', 'positions', 'allowances']) {
    checks.push({ name: field, assessed: true, equal: equal(leftProjection[field], rightProjection[field]),
      left: leftProjection[field], right: rightProjection[field] });
  }
  if (leftBalances || rightBalances) {
    checks.push({ name: 'measured balances', assessed: true, equal: equal(leftBalances, rightBalances), left: leftBalances, right: rightBalances });
    const identitiesMatch = [leftBalances, rightBalances].every(measured => measured && measured.assets.length > 0 &&
      lower(measured.executionIdentity.stateBlockHash) === lower(pinnedBlock.hash) &&
      measured.executionIdentity.blockNumber === pinnedBlock.number && measured.executionIdentity.timestamp === pinnedBlock.timestamp &&
      measured.executionIdentity.stateBinding === 'block_hash' && measured.executionIdentity.headerContext === 'unchanged');
    checks.push({ name: 'balance execution identity', assessed: true, equal: identitiesMatch,
      expected: pinnedBlock, left: leftBalances?.executionIdentity ?? null, right: rightBalances?.executionIdentity ?? null });
  } else {
    checks.push({ name: 'measured balances', assessed: false, equal: null,
      leftStatus: left.balanceChanges?.status ?? 'not_present', rightStatus: right.balanceChanges?.status ?? 'not_present',
      reason: 'Neither report contains measured balances. Unavailable or inapplicable measurements are not zero balance changes.' });
  }
  const matches = checks.every(check => !check.assessed || check.equal);
  return { status: matches ? 'matched' : 'mismatched', matches, checks };
}

function trackedClient(provider, rpcFactory) {
  const rpc = rpcFactory({ url: provider.url });
  const records = [];
  const call = rpc.call.bind(rpc);
  rpc.call = async (method, params = []) => {
    const record = { request: { jsonrpc: '2.0', id: rpc.nextId, method, params: structuredClone(params) } };
    const start = performance.now();
    try {
      const result = await call(method, params);
      record.response = { jsonrpc: '2.0', id: record.request.id, result: structuredClone(result) };
      return result;
    } catch (error) {
      record.error = safeError(error);
      throw error;
    } finally {
      record.durationMs = Math.round(performance.now() - start);
      records.push(record);
    }
  };
  return { rpc, records };
}

function safeError(error) {
  const knownCodes = new Set(['RPC_ERROR', 'METHOD_NOT_ALLOWED', 'INVALID_RPC_URL', 'RPC_HTTP_ERROR',
    'RPC_RESPONSE_TOO_LARGE', 'RPC_INVALID_RESPONSE', 'RPC_EXECUTION_ERROR', 'RPC_TIMEOUT',
    'RPC_CONNECTION_ERROR', 'RPC_CHAIN_MISMATCH', 'BLOCK_UNAVAILABLE', 'BLOCK_MISMATCH',
    'TRACE_UNAVAILABLE', 'TRACE_MISMATCH', 'TRANSACTION_UNAVAILABLE', 'TRACE_RECEIPT_MISMATCH', 'TRANSACTION_CHANGED']);
  return {
    code: error instanceof RpcError && knownCodes.has(error.code) ? error.code : 'COMPARISON_ERROR',
    message: 'The read-only comparison request could not be completed.',
    rpcCode: Number.isSafeInteger(error?.detail?.rpcCode) ? error.detail.rpcCode : null,
  };
}

function comparisonCases(block) {
  const supply = EXAMPLES.find(example => example.id === 'hyperlend-usdc-supply').request;
  const excessiveAmount = 1_000_000_000_000n;
  const excessiveData = supply.data.slice(0, 74) + excessiveAmount.toString(16).padStart(64, '0') + supply.data.slice(138);
  return [
    { id: 'hyperlend-supply', expectedExecution: 'success', request: { ...supply, block } },
    { id: 'hyperlend-excessive-supply', expectedExecution: 'reverted', request: { ...supply, data: excessiveData, block } },
    ...['withdraw','borrow','repay'].map(operation=>({id:`hyperlend-${operation}`,operation,expectedExecution:'success',request:{...EXAMPLES.find(e=>e.id===`hyperlend-usdc-${operation}`).request,block}})),
    ...['usdc-max-approval','usdc-revoke-approval'].map(id=>({id,operation:'approve',expectedExecution:'success',request:{...EXAMPLES.find(e=>e.id===id).request,block}})),
  ];
}

function outcomeMatches(item, report) {
  if (report.execution?.status !== item.expectedExecution) return false;
  if (item.expectedExecution === 'reverted') return report.inAssets?.length === 0 && report.outAssets?.length === 0;
  if(item.operation==='approve') return report.allowanceChanges?.status==='measured' && report.allowanceChanges.allowances.length===1 && report.allowanceChanges.allowances[0].afterKind===(item.id==='usdc-max-approval'?'uint256_max':'zero');
  if(['withdraw','borrow','repay'].includes(item.operation)) return report.protocol?.operation===item.operation && report.protocol.reconciliation?.status==='reconciled' && report.balanceChanges?.status==='measured';
  return report.balanceChanges?.status === 'measured' && (report.outAssets?.some(asset => lower(asset.asset?.address) === USDC &&
    asset.transferOut?.some(transfer => exact(transfer.rawValue) === '15066115')) ?? false);
}

/** Bounded opt-in live check: seven cases and two fixed public providers. */
export async function runProviderComparison({ block, outputDirectory = DEFAULT_DIRECTORY, writeReport = true,
  rpcFactory = options => new RpcClient(options), simulateImpl = simulate } = {}) {
  if (block !== undefined && (typeof block !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(block))) {
    throw new Error('block must be a hexadecimal block number.');
  }
  const createdAt = new Date().toISOString();
  const selection = trackedClient(PROVIDERS[0], rpcFactory);
  let pinnedBlock = null;
  const report = {
    schemaVersion: '1.0', createdAt, kind: 'bounded_same_block_provider_comparison', status: 'incomplete',
    providers: PROVIDERS, selection: null, pinnedBlock: null, cases: [],
    summary: { matched: 0, mismatched: 0, incomplete: 0, total: 7 },
    limitations: [
      'Two providers and seven transaction inputs do not establish general accuracy, availability or security coverage.',
      'These providers may share infrastructure or use the same execution engine. Agreement is not proof of independent implementation correctness.',
      'Provider durations are individual observations, not a performance benchmark, percentile estimate or ranking.',
      'The excessive input is a read-only simulation, not a signed or broadcast transaction. Public wallet state may change the expected outcomes.',
      'No Dynamic or Blockaid service is called or scored by this comparison.',
      'Successful public RPC request/result payloads are retained. Transport/provider exceptions are reduced to bounded codes and fixed messages.',
    ],
  };
  try {
    await selection.rpc.verifyChain();
    let head = null;
    if (block === undefined) {
      head = normalizeBlock(await selection.rpc.call('eth_getBlockByNumber', ['latest', false]));
      const number = BigInt(head.number) > 5n ? BigInt(head.number) - 5n : 0n;
      block = '0x' + number.toString(16);
    }
    pinnedBlock = normalizeBlock(await selection.rpc.call('eth_getBlockByNumber', [block, false]));
    if (pinnedBlock.number !== BigInt(block).toString()) throw new RpcError('Provider returned the wrong selection block.', 'BLOCK_MISMATCH');
    report.selection = { provider: PROVIDERS[0].id, mode: head ? 'observed_head_minus_five_blocks' : 'explicit_numeric_block', head, numericBlock: block, rpcCalls: selection.records };
    report.pinnedBlock = pinnedBlock;
    for (const item of comparisonCases(block)) {
      const runs = [];
      // Run sequentially to avoid provider bursts and make this fourteen-run bound
      // explicit. No retries, transactions or alternate blocks are hidden here.
      for (const provider of PROVIDERS) {
        const tracked = trackedClient(provider, rpcFactory);
        const start = performance.now();
        try {
          const response = await simulateImpl(item.request, tracked.rpc);
          runs.push({ provider: provider.id, request: structuredClone(item.request), response,
            outcomeMatches: outcomeMatches(item, response), durationMs: Math.round(performance.now() - start), rpcCalls: tracked.records });
        } catch (error) {
          runs.push({ provider: provider.id, request: structuredClone(item.request), error: safeError(error),
            outcomeMatches: false, durationMs: Math.round(performance.now() - start), rpcCalls: tracked.records });
        }
      }
      const comparison = compareReports(runs[0].response, runs[1].response, pinnedBlock);
      const expectedOutcomesMatch = runs.every(run => run.outcomeMatches);
      const status = comparison.status === 'incomplete' ? 'incomplete' : comparison.matches && expectedOutcomesMatch ? 'matched' : 'mismatched';
      report.cases.push({ id: item.id, expectedExecution: item.expectedExecution, status, expectedOutcomesMatch, comparison, runs });
      report.summary[status]++;
    }
    report.status = report.summary.matched === report.summary.total ? 'passed' : 'failed';
  } catch (error) {
    report.selection = { provider: PROVIDERS[0].id, error: safeError(error), rpcCalls: selection.records };
    report.summary.incomplete = report.summary.total;
    report.status = 'failed';
  }
  if (writeReport) {
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = resolve(outputDirectory, createdAt.replace(/[:.]/g, '-') + '.json');
    report.outputPath = outputPath;
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

export async function testComparisonHelpers() {
  const assert = (await import('node:assert/strict')).default;
  const block = { number: '1', hash: '0x' + 'a'.repeat(64), timestamp: '10' };
  const base = {
    id: 'left', timing: { totalMs: 5 }, request: { chainId: 999, from: 'a', to: 'b', data: '0x', value: '0' },
    source: { chainId: 999, blockNumber: block.number, blockHash: block.hash, provider: 'one' },
    execution: { status: 'success', gasUsed: '10', returnData: '0x' },
    movements: [{ address: 'token', from: 'a', to: 'b', amountRaw: '9007199254740993', framePath: '0' }],
    inAssets: [], outAssets: [], interestAccruals: [], protocol: null,
  };
  const other = structuredClone(base);
  other.id = 'right'; other.timing.totalMs = 900; other.source.provider = 'two'; other.movements[0].framePath = '0.1';
  assert.equal(compareReports(base, other, block).matches, true);
  other.movements[0].amountRaw = '9007199254740992';
  assert.equal(compareReports(base, other, block).matches, false);
  other.movements[0].amountRaw = base.movements[0].amountRaw; other.execution.gasUsed = '11';
  assert.equal(compareReports(base, other, block).matches, false);
  other.execution.gasUsed = '10'; other.source.blockHash = '0x' + 'b'.repeat(64);
  assert.equal(compareReports(base, other, block).matches, false);
  assert.equal(compareReports(base, undefined, block).status, 'incomplete');
  other.source.blockHash = block.hash;
  const balances = { status: 'measured', basis: 'prestate_diff_balanceOf',
    executionIdentity: { stateBlockHash: block.hash, blockNumber: block.number, timestamp: block.timestamp,
      stateBinding: 'block_hash', headerContext: 'unchanged', method: 'fixture' },
    assets: [{ asset: { address: 'token', decimals: 6 }, account: 'a', beforeRaw: '100', afterRaw: '90', deltaRaw: '-10' }] };
  base.balanceChanges = structuredClone(balances); other.balanceChanges = structuredClone(balances);
  assert.equal(compareReports(base, other, block).matches, true);
  other.balanceChanges.assets[0].beforeRaw = '101';
  assert.equal(compareReports(base, other, block).matches, false);
  other.balanceChanges = structuredClone(balances); other.balanceChanges.executionIdentity.stateBlockHash = '0x' + 'b'.repeat(64);
  assert.equal(compareReports(base, other, block).matches, false);
  other.balanceChanges = { status: 'unavailable', assets: [] };
  assert.equal(compareReports(base, other, block).matches, false);
  other.balanceChanges = structuredClone(balances);
  base.positionChanges = [{token:'debt',account:'a',role:'liability',event:'Mint',valueRaw:'10',accruedInterestRaw:'1',indexRaw:'100',deltaRaw:'9'}];
  other.positionChanges = structuredClone(base.positionChanges);
  assert.equal(compareReports(base,other,block).matches,true);
  other.positionChanges[0].deltaRaw='10';
  assert.equal(compareReports(base,other,block).matches,false);
  other.positionChanges = structuredClone(base.positionChanges);
  base.allowanceChanges = {status:'measured',executionIdentity:balances.executionIdentity,allowances:[{asset:{address:'token'},owner:'a',spender:'b',beforeRaw:'10',afterRaw:'0',deltaRaw:'-10',changed:true}]};
  other.allowanceChanges=structuredClone(base.allowanceChanges);
  assert.equal(compareReports(base,other,block).matches,true);
  other.allowanceChanges.allowances[0].afterRaw='1';
  assert.equal(compareReports(base,other,block).matches,false);
  assert.doesNotMatch(JSON.stringify(safeError(new RpcError('Bearer private-key', 'RPC_ERROR', {token:'private-key'}))), /private-key|Bearer/);
  return 14;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--self-test') {
      const count = await testComparisonHelpers();
      console.log(`Comparison helper checks: ${count}/${count} passed. No network requests.`);
    } else if (!args.length || (args.length === 2 && args[0] === '--block')) {
      const report = await runProviderComparison({ block: args[1] });
      console.log(`Provider comparison: ${report.summary.matched}/${report.summary.total} cases matched; block ${report.pinnedBlock?.number ?? 'unavailable'}.`);
      console.log('Two-provider observation only; no performance or security ranking.');
      console.log(`Saved ${report.outputPath}`);
      process.exitCode = report.status === 'passed' ? 0 : 1;
    } else {
      throw new Error('Usage: node src/compare-providers.js [--block 0xNUMBER | --self-test]');
    }
  } catch (error) {
    console.error(error instanceof RpcError ? error.message : 'Comparison could not complete. Use --self-test or an optional --block 0xNUMBER.');
    process.exitCode = 1;
  }
}
