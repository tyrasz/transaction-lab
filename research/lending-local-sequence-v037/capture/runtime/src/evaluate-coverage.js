import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { replay } from './server.js';
import { createHistoricalStateContext } from './historical-state.js';
import { EvaluationBudget, EVALUATION_PROVIDERS, EVALUATION_LIMITS, safeEvaluationError } from './evaluation-budget.js';
import { COMPARISON_RULES, ORACLE_TOKENS, compareTraces, compareRetrieval, compareOriginalReplay, validateHistoricalEvidence, independentInventory, integer, lower } from './evaluation-comparator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^0x[0-9a-f]{64}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => '0x' + BigInt(value).toString(16);
const json = value => JSON.stringify(value, null, 2) + '\n';
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const UNASSESSED = 'No security classification, vendor score, all-EVM accuracy estimate or independent-engine proof is assessed.';

async function sourceFingerprint() {
  const files = ['package.json', 'research/coverage-evaluation/PLAN.md'];
  async function walk(relative) {
    for (const entry of await readdir(path.join(ROOT, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(relative, entry.name));
      else if (entry.isFile()) files.push(path.join(relative, entry.name));
    }
  }
  await walk('src'); await walk('public');
  const sources = [], contents = new Map();
  for (const file of files.sort()) { const bytes = await readFile(path.join(ROOT, file)); contents.set(file, bytes); sources.push({ file, sha256: sha(bytes) }); }
  const pkg = JSON.parse(contents.get('package.json').toString('utf8'));
  const list = contents.get('src/server.js').toString('utf8').match(/const engineFiles = (\[[^\n]+\]);/)?.[1];
  if (!list || !/^\[(?:'[-a-z.]+',?)+\]$/.test(list)) throw new Error('Engine source-file manifest is not a literal reviewed list.');
  const engineFiles = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);
  if (new Set(engineFiles).size !== engineFiles.length || engineFiles.some(file => !contents.has(`src/${file}`))) throw new Error('Engine source manifest is incomplete.');
  const version = contents.get('src/config.js').toString('utf8').match(/export const VERSION = '([^']+)';/)?.[1];
  if (!version || version !== pkg.version) throw new Error('Package and engine versions disagree before freeze.');
  const engineHash = createHash('sha256');
  for (const file of engineFiles) engineHash.update(file + '\0').update(contents.get(`src/${file}`)).update('\0');
  return { version, files: sources, sha256: sha(json(sources)), engine: { name: 'Transaction Lab', version, sourceFiles: engineFiles, sourceSha256: engineHash.digest('hex') } };
}
function normalizeHeader(block) {
  if (!block || !HASH.test(block.hash ?? '') || !Array.isArray(block.transactions) || block.transactions.some(hash => !HASH.test(hash)) || new Set(block.transactions.map(lower)).size !== block.transactions.length) throw new Error('Incomplete selected header.');
  if (!HASH.test(block.parentHash ?? '')) throw new Error('Missing parent hash.');
  return { hash: lower(block.hash), parentHash: lower(block.parentHash), number: integer(block.number), timestamp: integer(block.timestamp), transactions: block.transactions.map(lower) };
}
async function settledCalls(calls) {
  const results = await Promise.allSettled(calls.map(call => call()));
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results.map(result => result.value);
}

/** Exactly the preregistered observations; no latest tag, retries or substitutions. */
export async function selectProspectiveCohort({ budget, now, sleep, t0 }) {
  const a = budget.client('A', { phase: 'selection' }), b = budget.client('B', { phase: 'selection' });
  const schedule = [];
  async function at(offset, label, task) {
    const target = t0 + offset;
    while (now() < target) {
      if (budget.exhausted()) throw new Error('Selection budget exhausted.');
      await sleep(Math.min(30000, target - now()));
    }
    const actual = now(); schedule.push({ label, scheduledAt: new Date(target).toISOString(), calledAt: new Date(actual).toISOString(), lateByMs: Math.max(0, actual - target) });
    return task();
  }
  try {
    await settledCalls([() => a.verifyChain(), () => b.verifyChain()]);
    const first = await at(60000, 'A finalized observation selecting F', () => a.call('eth_getBlockByNumber', ['finalized', false]));
    if (!first || !HASH.test(first.hash ?? '')) throw new Error('Finalized header unavailable.');
    const f = BigInt(integer(first.number)), numbers = [f + 1n, f + 2n];
    const finalized = await at(180000, 'A and B finalized confirmation', () => settledCalls([() => a.call('eth_getBlockByNumber', ['finalized', false]), () => b.call('eth_getBlockByNumber', ['finalized', false])]));
    if (finalized.some(header => !HASH.test(header?.hash ?? '') || BigInt(integer(header.number)) < numbers[1])) throw new Error('Selected future blocks not finalized.');
    const headers = await settledCalls(numbers.flatMap(number => [() => a.call('eth_getBlockByNumber', [hex(number), false]), () => b.call('eth_getBlockByNumber', [hex(number), false])]));
    const blocks = [];
    for (let i = 0; i < numbers.length; i++) {
      const left = normalizeHeader(headers[i * 2]), right = normalizeHeader(headers[i * 2 + 1]);
      if (left.number !== numbers[i].toString() || json(left) !== json(right) || left.parentHash !== (i ? blocks[i - 1].hash : lower(first.hash)) || BigInt(left.timestamp) * 1000n <= BigInt(Math.floor(t0))) throw new Error('Selected block identity, parent continuity, order or future timestamp disagreement.');
      blocks.push({ ...left, originalHeaders: { A: headers[i * 2], B: headers[i * 2 + 1] } });
    }
    const hashes = blocks.flatMap(block => block.transactions);
    if (new Set(hashes).size !== hashes.length) throw new Error('Duplicate transaction across selected blocks.');
    const ledger = blocks.flatMap(block => block.transactions.map((transactionHash, index) => ({ id: `${block.number}:${index}`, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, transactionIndex: String(index), transactionHash })));
    return { status: ledger.length ? 'selected' : 'empty', F: f.toString(), schedule, blocks, N: ledger.length, ledger };
  } catch (error) {
    await budget.waitForIdle();
    return { status: 'selection_failed', schedule, N: null, ledger: [], error: safeEvaluationError(error), reason: 'A required finalized/header/chain/order/timing observation failed. No fallback or replacement was attempted; available bounded responses remain in the RPC ledger.' };
  }
}

function transactionFromRecords(records, provider, caseId) {
  return records.find(record => record.provider === provider && record.caseId === caseId && record.request.method === 'eth_getTransactionByHash' && record.response)?.response.result;
}
function productState(product) {
  const evidence = ['balanceMeasurement', 'affectedBalanceMeasurement', 'allowanceMeasurement'].map(key => product?.evidence?.[key]).filter(value => Array.isArray(value?.request) && Array.isArray(value?.response) && value.request.length);
  // Completed shared snapshots should agree; prefer the largest complete one.
  evidence.sort((a, b) => b.request.length - a.request.length);
  const identity = [product?.balanceChanges, product?.affectedBalanceChanges, product?.allowanceChanges].find(value => value?.status === 'measured')?.executionIdentity;
  return { evidence: evidence[0] ?? null, identity };
}
function measuredProductPairs(product, kind) {
  const groups = kind === 'balance' ? [product?.balanceChanges, product?.affectedBalanceChanges] : [product?.allowanceChanges];
  const values = new Map();
  for (const group of groups) {
    if (group?.status !== 'measured') continue;
    const items = group[kind === 'balance' ? 'assets' : 'allowances'];
    if (!Array.isArray(items)) { values.malformed = true; continue; }
    for (const item of items) {
      if (!item || typeof item !== 'object') { values.malformed = true; continue; }
      const token = lower(item.asset?.address), key = kind === 'balance' ? `${token}:${lower(item.account)}` : `${token}:${lower(item.owner)}:${lower(item.spender)}`;
      const value = { beforeRaw: item.beforeRaw, afterRaw: item.afterRaw, deltaRaw: item.deltaRaw };
      const prior = values.get(key);
      values.set(key, { ...value, conflicting: Boolean(prior && (prior.conflicting || json(value) !== json({ beforeRaw: prior.beforeRaw, afterRaw: prior.afterRaw, deltaRaw: prior.deltaRaw }) || !isDeepStrictEqual(prior.identity, group.executionIdentity) || prior.basis !== group.basis)), identity: group.executionIdentity, basis: group.basis });
    }
  }
  return values;
}
function measuredIdentity(identity, row) {
  try { return identity?.transactionHash === row.transactionHash && identity.stateBlockHash === row.blockHash && integer(identity.transactionIndex) === row.transactionIndex && integer(identity.postTransactionIndex) === String(BigInt(row.transactionIndex) + 1n) && identity.stateBinding === 'block_hash_and_transaction_index' && identity.headerContext === 'original_block'; }
  catch { return false; }
}
function pairComparison(candidate, measured, product, row) {
  if (!measured) return { ...candidate, status: 'oracle_unavailable' };
  if (product.malformed) return { ...candidate, status: 'mismatched', oracle: measured, reason: 'Product claimed a measured collection with malformed contents.' };
  const value = product.get(candidate.key);
  if (!value) return { ...candidate, status: 'unmeasured', oracle: measured };
  const matches = !value.conflicting && value.basis === (candidate.kind === 'balance' ? 'historical_transaction_position_balanceOf' : 'historical_transaction_position_allowance') && measuredIdentity(value.identity, row) && ['beforeRaw', 'afterRaw', 'deltaRaw'].every(key => typeof value[key] === 'string' && value[key] === measured[key]);
  return { ...candidate, status: matches ? 'matched' : 'mismatched', oracle: measured, product: value };
}
export function compareObservedPairs({ candidates, measurements, product, row, kind }) {
  const productPairs = measuredProductPairs(product, kind);
  return candidates.map(pair => pairComparison(pair, measurements.get(pair.key), productPairs, row));
}
async function adjudicate({ row, block, product, rpc, records, budget, stateContextFactory }) {
  const report = { retrieval: { status: 'incomplete' }, exactReplay: { status: 'incomplete' }, inventory: { completeness: 'inconclusive', assets: [], allowances: [] }, assetPairs: [], allowancePairs: [], allAssetEffects: 'inconclusive', allPermissionEffects: 'inconclusive' };
  try {
    const retrieved = await Promise.allSettled([
      () => rpc.call('eth_getTransactionByHash', [row.transactionHash]),
      () => rpc.call('eth_getTransactionReceipt', [row.transactionHash]),
      () => rpc.call('debug_traceTransaction', [row.transactionHash, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]),
      () => rpc.call('debug_traceTransaction', [row.transactionHash, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { disableStorage: true } }]),
    ].map(call => call()));
    const [transaction, receipt, trace, prestate] = retrieved.map(result => result.status === 'fulfilled' ? result.value : null);
    report.retrievalFailures = retrieved.flatMap((result, index) => result.status === 'rejected' ? [{ field: ['transaction', 'receipt', 'trace', 'prestate'][index], error: safeEvaluationError(result.reason) }] : []);
    report.oracleEvidence = { transaction, receipt, trace, prestate };
    const identity = validateHistoricalEvidence({ transaction, receipt, trace, row, block });
    report.oracleIdentity = identity;
    report.retrieval = compareRetrieval({ product, oracle: { transaction, receipt, trace }, row, block, productTransaction: transactionFromRecords(records, 'A', row.id) });
    if (identity.status !== 'complete') return report;
    report.inventory = independentInventory({ transaction, receipt, trace, prestate });
    // Candidate denominators are established before any optional state query or
    // product inspection can fail. No later exception may erase known pairs.
    report.assetPairs = report.inventory.assets.map(pair => ({ ...pair, status: 'oracle_unavailable' }));
    report.allowancePairs = report.inventory.allowances.map(pair => ({ ...pair, status: 'oracle_unavailable' }));
    const pairs = [...report.inventory.assets, ...report.inventory.allowances], observations = new Map();
    const context = stateContextFactory({ request: { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: integer(transaction.value) }, block: { hash: row.blockHash, number: row.blockNumber, timestamp: row.timestamp }, rpc, transaction, receipt, trace });
    let contextReady = false;
    try { await context.prepare(); contextReady = true; }
    catch (error) { report.statePreparation = { status: 'unavailable', error: safeEvaluationError(error) }; }
    for (const [index, pair] of pairs.entries()) {
      if (!contextReady || index >= budget.limits.oraclePairs || pair.semanticSupport !== 'verified_token_query') continue;
      try {
        const data = pair.kind === 'balance' ? '0x70a08231' + pair.account.slice(2).padStart(64, '0') : '0xdd62ed3e' + pair.owner.slice(2).padStart(64, '0') + pair.spender.slice(2).padStart(64, '0');
        const result = await context.readPair({ to: pair.token, data });
        observations.set(pair.key, { beforeRaw: result.before.toString(), afterRaw: result.after.toString(), deltaRaw: result.delta.toString(), basis: 'second_provider_shared_adapter_original_position_query' });
      } catch (error) {
        (report.queryFailures ??= []).push({ key: pair.key, error: safeEvaluationError(error) });
      }
    }
    if (contextReady) {
      try { await context.verifyCanonical(); if (context.canonicalFailure) throw new Error('Canonical binding failed.'); }
      catch (error) { observations.clear(); report.canonicalVerification = { status: 'unavailable', error: safeEvaluationError(error) }; contextReady = false; }
    }
    report.stateEvidence = context.snapshotEvidence();
    report.stateIdentity = contextReady ? context.executionIdentity : null;
    const original = productState(product);
    report.exactReplay = compareOriginalReplay({ transaction, originalTrace: trace, row, productEvidence: original.evidence, oracleEvidence: report.stateEvidence, productIdentity: original.identity, oracleIdentity: report.stateIdentity });
    if (report.retrieval.status !== 'matched' && report.exactReplay.status === 'matched') report.exactReplay = { status: 'incomplete', reason: 'Original transaction retrieval/envelope agreement is not complete.', strictReplayEvidence: report.exactReplay };
    report.assetPairs = compareObservedPairs({ candidates: report.inventory.assets, measurements: observations, product, row, kind: 'balance' });
    report.allowancePairs = compareObservedPairs({ candidates: report.inventory.allowances, measurements: observations, product, row, kind: 'allowance' });
    report.extraProductPairs = {
      assets: [...measuredProductPairs(product, 'balance').keys()].filter(key => !report.inventory.assets.some(pair => pair.key === key)),
      allowances: [...measuredProductPairs(product, 'allowance').keys()].filter(key => !report.inventory.allowances.some(pair => pair.key === key)),
    };
    report.observedAssetPairScope = report.assetPairs.length ? 'partial_observed_candidate_inventory' : 'not_applicable_no_candidates_observed';
    report.observedAllowancePairScope = report.allowancePairs.length ? 'partial_observed_candidate_inventory' : 'not_applicable_no_candidates_observed';
  } catch (error) { report.error = safeEvaluationError(error); }
  return report;
}

export function coverageMetrics(ledger) {
  const N = ledger.length, attempted = ledger.filter(row => row.attempted).length;
  const metric = (key, passed) => ({ passed, denominator: N, fraction: N ? passed / N : null, attemptedDenominator: attempted, attemptedFraction: attempted ? passed / attempted : null, name: key });
  const comparison = key => {
    const matched = ledger.filter(row => row.comparison?.[key]?.status === 'matched').length;
    const mismatched = ledger.filter(row => row.comparison?.[key]?.status === 'mismatched').length;
    return { ...metric(key, matched), matched, mismatched, incomplete: N - matched - mismatched, completeComparisons: matched + mismatched, matchedFractionOfComplete: matched + mismatched ? matched / (matched + mismatched) : null };
  };
  const pairs = key => {
    const values = ledger.flatMap(row => row.comparison?.[key] ?? []), counts = { matched: 0, mismatched: 0, unmeasured: 0, oracle_unavailable: 0 };
    for (const value of values) counts[value.status]++;
    return { denominator: values.length, ...counts, inventoryCompleteness: 'inconclusive', scope: 'Observed candidate pairs only; not a complete all-effects denominator', transactionsWithoutOracleInventory: ledger.filter(row => !row.comparison?.oracleIdentity || row.comparison.oracleIdentity.status !== 'complete').length };
  };
  return { N, attempted, budgetUnattempted: ledger.filter(row => row.status === 'budget_unattempted').length,
    executionAvailability: metric('complete_product_execution_evidence', ledger.filter(row => row.executionAvailability?.status === 'complete').length), retrievalAgreement: comparison('retrieval'), exactReplayAgreement: comparison('exactReplay'),
    measuredAssetCoverage: { ...metric('all_asset_effects', 0), inconclusive: N, reason: COMPARISON_RULES.completeness }, measuredAllowanceCoverage: { ...metric('all_permission_effects', 0), inconclusive: N, reason: COMPARISON_RULES.completeness },
    observedAssetPairs: pairs('assetPairs'), observedAllowancePairs: pairs('allowancePairs'),
    reasonMatrix: { success: ledger.filter(row => row.executionAvailability?.status === 'complete' && row.executionAvailability?.outcome === 'success').length, genuineRevert: ledger.filter(row => row.executionAvailability?.status === 'complete' && row.executionAvailability?.outcome === 'revert').length, mismatch: ledger.filter(row => row.executionAvailability?.status === 'mismatched' || row.comparison?.retrieval?.status === 'mismatched' || row.comparison?.exactReplay?.status === 'mismatched' || [...(row.comparison?.assetPairs ?? []), ...(row.comparison?.allowancePairs ?? [])].some(pair => pair.status === 'mismatched')).length, unsupportedOrPartialProduct: ledger.filter(row => row.productCoverage && row.productCoverage !== 'supported').length, productUnavailable: ledger.filter(row => row.attempted && row.executionAvailability?.status !== 'complete').length, oracleUnavailable: ledger.filter(row => row.attempted && row.comparison?.oracleIdentity?.status !== 'complete').length, budgetUnattempted: ledger.filter(row => row.status === 'budget_unattempted').length },
  };
}
export function validateProductProvenance(product, frozen) {
  const actual = product?.implementation;
  return { status: actual?.name === frozen.name && actual.version === frozen.version && actual.sourceSha256 === frozen.sourceSha256 && JSON.stringify(actual.sourceFiles) === JSON.stringify(frozen.sourceFiles) ? 'matched' : 'mismatched', expected: frozen, actual: actual ?? null };
}
function validateProductView(product, transaction, row) {
  try {
    const source = product.source, request = product.request;
    const checks = [integer(source.chainId) === '999', source.mode === 'historical_trace', source.blockBinding === 'transaction_hash', lower(source.transactionHash) === row.transactionHash,
      lower(source.blockHash) === row.blockHash, integer(source.blockNumber) === row.blockNumber, integer(source.timestamp) === row.timestamp, integer(source.transactionIndex) === row.transactionIndex,
      integer(request.chainId) === '999', lower(request.from) === lower(transaction.from), lower(request.to) === lower(transaction.to), lower(request.data) === lower(transaction.input), integer(request.value) === integer(transaction.value),
      product.execution.status === (integer(product.evidence.receipt.status) === '1' ? 'success' : 'reverted'), integer(product.execution.gasUsed) === integer(product.evidence.receipt.gasUsed)];
    return { status: checks.every(Boolean) ? 'matched' : 'mismatched' };
  } catch { return { status: 'incomplete' }; }
}

/** No network on import. All injected adapters are for deterministic offline tests. */
export async function runCoverageEvaluation({ outputDirectory, fetchImpl = fetch, productImpl = replay, stateContextFactory = createHistoricalStateContext, now = Date.now, sleep = sleepDefault, limits = {} } = {}) {
  const fingerprint = await sourceFingerprint(), t0 = now(), runId = `${new Date(t0).toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(outputDirectory ?? path.join(ROOT, 'reports/coverage-evaluation', runId));
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false });
  const artifacts = [];
  async function save(file, value) {
    const content = json(value);
    await writeFile(path.join(directory, file), content, { flag: 'wx', mode: 0o444 });
    const artifact = { file, sha256: sha(content), bytes: Buffer.byteLength(content) }; artifacts.push(artifact); return artifact;
  }
  const budget = new EvaluationBudget({ t0, limits, fetchImpl, now });
  const manifest = { schemaVersion: '1.0', runId, T0: new Date(t0).toISOString(), protocol: 'research/coverage-evaluation/PLAN.md', implementation: fingerprint, providers: Object.fromEntries(Object.entries(EVALUATION_PROVIDERS).map(([id, url]) => [id, { url, nodeIdentity: 'unknown', executionClient: 'unknown', infrastructureIndependence: 'unproven' }])), limits: budget.limits, policyLimits: EVALUATION_LIMITS, comparator: COMPARISON_RULES, oracleTokens: ORACLE_TOKENS,
    budgetAccounting: 'Every attempted HTTP RPC is reserved before fetch, including engine internals. Response body bytes include HTTP and RPC errors. A stream chunk that crosses a byte cap is observed and counted, canceled immediately and never retained as usable truncated evidence; this can exceed the numerical cap by the final received chunk. No further calls start after a global cap.',
    retention: 'Successful, validated public JSON-RPC response bodies are preserved verbatim and hashed. Arbitrary HTTP/RPC error bodies are budgeted and hashed but omitted to avoid leaking provider credentials; fixed classifications are retained. Timed-out late responses cannot mutate sealed records.',
    discipline: 'No retries, replacements, fallback endpoints, latest tag or input editing. All product outputs are sealed before comparator adjudication. Once inspected for fixes this cohort becomes development data.', unassessed: UNASSESSED };
  const manifestArtifact = await save('manifest.json', manifest);
  const cohort = await selectProspectiveCohort({ budget, now, sleep, t0 });
  const cohortArtifact = await save('cohort.json', cohort);
  const ledger = cohort.ledger.map(row => ({ ...row, status: 'budget_unattempted', attempted: false, reason: 'Attempt cap or an exhausted global budget.' }));
  const products = new Map(), seals = [];
  for (const [index, row] of ledger.entries()) {
    if (index >= budget.limits.attempts || budget.exhausted()) continue;
    row.attempted = true; row.status = 'attempted'; delete row.reason;
    let result;
    try {
      const output = await productImpl({ chainId: 999, transactionHash: row.transactionHash }, budget.client('A', { phase: 'product', caseId: row.id }));
      result = { status: 'returned', output: structuredClone(output) };
      products.set(row.id, result.output);
      row.productCoverage = output.coverage?.status ?? 'unknown';
      row.productProvenance = validateProductProvenance(output, fingerprint.engine);
    } catch (error) { result = { status: 'unavailable', error: safeEvaluationError(error) }; }
    await budget.waitForIdle();
    const artifact = await save(`product-${index}.json`, { row: { ...row }, ...result }); seals.push({ caseId: row.id, ...artifact }); row.productArtifact = artifact;
    const product = products.get(row.id), block = cohort.blocks.find(value => value.hash === row.blockHash)?.originalHeaders.A;
    row.executionAvailability = validateHistoricalEvidence({ transaction: transactionFromRecords(budget.records, 'A', row.id), receipt: product?.evidence?.receipt, trace: product?.evidence?.traceResponse, row, block });
    if (product) {
      row.productView = validateProductView(product, transactionFromRecords(budget.records, 'A', row.id), row);
      if (row.executionAvailability.status === 'complete' && row.productView.status !== 'matched') row.executionAvailability = { status: row.productView.status, reason: 'Product request, source identity or execution presentation does not match the raw evidence.' };
    }
    if (row.productProvenance?.status === 'mismatched') row.executionAvailability = { status: 'mismatched', reason: 'Returned implementation provenance differs from the frozen source manifest.' };
  }
  const productSeal = await save('product-seal.json', { sealedAt: new Date(now()).toISOString(), manifestSha256: manifestArtifact.sha256, cohortSha256: cohortArtifact.sha256, products: seals, productRpc: budget.records.filter(record => record.phase === 'product'), comparatorHasStarted: false });
  for (const [index, row] of ledger.entries()) {
    if (!row.attempted) continue;
    if (budget.exhausted()) { row.comparison = { retrieval: { status: 'incomplete' }, exactReplay: { status: 'incomplete' }, reason: 'Global budget exhausted before comparator; this attempted transaction remains in N.' }; continue; }
    const block = cohort.blocks.find(value => value.hash === row.blockHash).originalHeaders.B;
    row.comparison = await adjudicate({ row, block, product: products.get(row.id), rpc: budget.client('B', { phase: 'comparator', caseId: row.id }), records: budget.records, budget, stateContextFactory });
    await budget.waitForIdle();
    row.comparisonArtifact = await save(`comparison-${index}.json`, row.comparison);
  }
  const finalFingerprint = await sourceFingerprint();
  const sourceUnchanged = finalFingerprint.sha256 === fingerprint.sha256;
  const productProvenanceValid = ledger.every(row => !row.productProvenance || row.productProvenance.status === 'matched');
  const rawArtifact = await save('rpc.json', { records: budget.records, accounting: budget.snapshot() });
  const ledgerArtifact = await save('ledger.json', { N: cohort.N, rows: ledger });
  const report = { schemaVersion: '1.0', status: !sourceUnchanged ? 'invalid_source_changed_during_run' : !productProvenanceValid ? 'invalid_product_provenance' : cohort.status === 'selection_failed' ? 'selection_failed' : cohort.status === 'empty' ? 'empty' : 'completed_with_scoped_inconclusive_metrics', evaluationValid: sourceUnchanged && productProvenanceValid && cohort.status !== 'selection_failed', generatedAt: new Date(now()).toISOString(), runId, directory, manifest: manifestArtifact, cohort: cohortArtifact, productSeal, raw: rawArtifact, ledger: ledgerArtifact, sourceUnchanged, productProvenanceValid,
    metrics: cohort.N === null ? null : coverageMetrics(ledger), budget: budget.snapshot(), noRetries: true, security: { status: 'not_assessed', findings: [] }, limitations: [UNASSESSED, 'Two adjacent future blocks and at most sixteen attempts are a correlated feasibility sample, not a representative accuracy estimate.', 'Complete envelopes, inventory completeness and unavailable evidence are never inferred from matching decoders or event counts.', 'Second-provider state queries reuse the product adapter and verified-token query scope. Shared infrastructure and implementation assumptions may cause correlated errors.', 'All-effects asset and allowance coverage remains inconclusive even when observed candidate pairs match.'] };
  const reportArtifact = await save('report.json', report);
  await save('artifact-index.json', { createdAt: new Date(now()).toISOString(), artifacts: [...artifacts], reportSha256: reportArtifact.sha256 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--run') {
    process.stderr.write('Usage: node src/evaluate-coverage.js --run\nThis selects a future public cohort and takes at least three minutes. Freeze and review the source first.\n');
    process.exitCode = 2;
  } else {
    // The parent directory is created separately; each immutable run directory
    // must be new, so reruns cannot overwrite a failed cohort.
    await mkdir(path.join(ROOT, 'reports/coverage-evaluation'), { recursive: true });
    try {
      const result = await runCoverageEvaluation();
      process.stdout.write(json({ status: result.status, report: path.join(result.directory, 'report.json'), N: result.metrics?.N ?? null, attempted: result.metrics?.attempted ?? 0, rpc: result.budget.rpcCount }));
      if (!result.evaluationValid) process.exitCode = 1;
    } catch (error) { process.stderr.write(json(safeEvaluationError(error))); process.exitCode = 1; }
  }
}
