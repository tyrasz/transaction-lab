// Separately versioned prospective runner. Importing this module makes no RPC.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { replay } from './server.js';
import { createHistoricalStateContext } from './historical-state.js';
import { normalizeBlockViews, BLOCK_VIEW_LIMITS } from './block-views.js';
import { EvaluationBudgetV2, V2_PROVIDERS } from './evaluation-v2-budget.js';
import { EVALUATION_LIMITS, safeEvaluationError } from './evaluation-budget.js';
import { COMPARISON_RULES, ORACLE_TOKENS, compareTraces, compareRetrieval, compareOriginalReplay, validateHistoricalEvidence, independentInventory, integer, lower } from './evaluation-comparator.js';
import { compareObservedPairs, validateProductProvenance } from './evaluate-coverage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^0x[0-9a-f]{64}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hex = value => '0x' + BigInt(value).toString(16);
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const V2_RULES = Object.freeze({ version: 'prospective-system-views-2.0', protocol: 'research/coverage-evaluation/PLAN-V2.md',
  scheduling: 'block order, then ordinary/system/unresolved round-robin in reference/occurrence order; this is not execution order',
  systemReplay: 'unsupported_no_validated_system_invocation_profile', combinedFractions: 'withheld_unless_enumeration_and_all_identity_mappings_complete',
  ordinaryReplay: 'unchanged strict original-header/index guard, full ordered trace and absolute state-diff checks; no inferred boundaries or synthetic merged headers',
  scope: 'RPC-enumerated EVM references; completeness of all chain activity, independent engine correctness and all effects remain unproven' });

function hashList(block) {
  if (!Array.isArray(block?.transactions) || block.transactions.length > BLOCK_VIEW_LIMITS.maxListEntries) throw new Error('Incomplete or excessive block list.');
  return block.transactions.map(item => { const value = typeof item === 'string' ? item : item?.hash; if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Malformed list identity.'); return value.toLowerCase(); });
}
function anchorHashList(block) {
  const hashes = hashList(block);
  if (block.transactions.some(item => typeof item !== 'string')) throw new Error('Hash-only anchor returned a full object.');
  return hashes;
}
function headerIdentity(block) {
  if (!block || typeof block.hash !== 'string' || !HASH.test(block.hash) || typeof block.parentHash !== 'string' || !HASH.test(block.parentHash)) throw new Error('Incomplete header.');
  return { hash: lower(block.hash), parentHash: lower(block.parentHash), number: integer(block.number), timestamp: integer(block.timestamp) };
}
function headerForComparison(block) {
  // Only project full objects to their exact hashes; preserve their order and
  // cardinality. This never merges system/user lists or substitutes an index.
  return { ...structuredClone(block), transactions: hashList(block) };
}
function packet(record, captureSha256) {
  if (!record) return { status: 'unavailable', reason: 'not_attempted_or_budget_exhausted' };
  return { status: record.response ? 'available' : 'unavailable', request: record.request, ...(record.response ? { result: record.response.result } : { error: record.error }),
    provenance: { endpoint: record.endpoint, artifact: 'selection-rpc.json', captureSha256, responseSha256: record.responseSha256 ?? record.observedPrefixSha256 ?? '', observedAt: record.completedAt } };
}

/** Round-robin is an allocation policy only, never a claim about execution order. */
export function scheduleV2Rows(rows) {
  const ordered = [], blocks = [...new Set(rows.map(row => row.blockNumber))].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  for (const block of blocks) {
    const groups = ['ordinary', 'hypercore_system', 'unresolved'].map(kind => rows.filter(row => row.blockNumber === block && row.kind === kind));
    for (let i = 0; groups.some(group => i < group.length); i++) for (const group of groups) if (group[i]) ordered.push(group[i]);
  }
  return ordered.map((row, index) => ({ ...row, attemptOrdinal: index, executionOrder: 'unknown', replayBoundary: 'unknown' }));
}

/** Pure accounting can be exercised on old development captures without turning
 * them into a new prospective cohort. Every raw occurrence remains in input. */
export function buildV2Population(blocks) {
  const rows = [], notes = []; let complete = blocks.length === 2;
  const seenReferenceHashes = new Set();
  for (const block of blocks) {
    const view = block.normalization;
    if (!view || view.denominator.N_enumerated === null || block.viewStability?.status !== 'stable' || block.envelopeDiscovery?.status !== 'complete') complete = false;
    if (!view) {
      // A structural/budget rejection cannot silently erase available entries.
      for (const [sourceId, list] of Object.entries(block.unparsedLists ?? {})) if (Array.isArray(list)) for (const [ordinal, raw] of list.entries()) rows.push({
        id: `${block.number}:${block.hash}:unresolved:${sourceId}:${ordinal}`, kind: 'unresolved', blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, raw,
        occurrenceId: `${sourceId}:${ordinal}`, identityStatus: 'unresolved', reason: 'normalizer_unavailable', transactionHash: null, transactionIndex: null });
      continue;
    }
    const byId = new Map(view.occurrences.map(item => [item.id, item]));
    for (const action of view.referenceActions) {
      if (action.referenceHash && seenReferenceHashes.has(action.referenceHash)) { complete = false; notes.push({ code: 'cross_block_or_reference_hash_duplicate', referenceHash: action.referenceHash }); }
      if (action.referenceHash) seenReferenceHashes.add(action.referenceHash);
      const representations = {};
      for (const provider of ['A', 'B']) {
        const matches = action.representations.map(id => byId.get(id)).filter(occ => occ?.provider === provider && occ.mapping.status === 'matched');
        const hashes = [...new Set(matches.map(occ => occ.hash))], indexes = [...new Set(matches.map(occ => occ.reportedTransactionIndex))];
        representations[provider] = { status: hashes.length === 1 && indexes.length === 1 && indexes[0] !== null ? 'resolved' : 'unresolved',
          transactionHash: hashes.length === 1 ? hashes[0] : null, reportedTransactionIndex: indexes.length === 1 ? indexes[0] : null,
          occurrenceIds: matches.map(occ => occ.id), listOrdinals: matches.filter(occ => occ.role === 'list').map(occ => occ.listOrdinal), replayBoundary: 'unknown' };
      }
      const primary = representations.A;
      rows.push({ id: action.id, kind: action.kind, referenceHash: action.referenceHash, referenceOrdinal: action.referenceOrdinal, referenceStatus: action.referenceStatus,
        blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, representations,
        identityStatus: primary.status, transactionHash: primary.status === 'resolved' ? primary.transactionHash : null,
        transactionIndex: primary.status === 'resolved' ? primary.reportedTransactionIndex : null,
        indexBasis: 'provider_reported_transactionIndex_not_replay_boundary', normalizationReferenceId: action.id });
    }
    for (const id of view.unresolvedOccurrences) {
      const occ = byId.get(id); rows.push({ id: `${block.hash}:unresolved:${id}`, kind: 'unresolved', blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
        occurrenceId: id, sourceId: occ.sourceId, raw: occ.raw, identityStatus: 'unresolved', reason: occ.mapping.reason ?? 'unresolved_reference_or_occurrence', transactionHash: null, transactionIndex: null });
    }
    for (const occ of block.anchorOccurrences ?? []) if (occ.mappingStatus !== 'matched') rows.push({ id: `${block.hash}:unresolved:${occ.id}`, kind: 'unresolved',
      blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, occurrenceId: occ.id, raw: occ.raw, identityStatus: 'unresolved',
      reason: 'selection_anchor_occurrence_unresolved', transactionHash: null, transactionIndex: null });
  }
  const known = rows.filter(row => row.kind !== 'unresolved'), unresolved = rows.filter(row => row.kind === 'unresolved');
  return { completeness: complete ? 'complete_for_enumerated_references' : 'inconclusive', N_enumerated: complete ? known.length : null,
    referenceCounts: { ordinary: known.filter(row => row.kind === 'ordinary').length, hypercore_system: known.filter(row => row.kind === 'hypercore_system').length },
    knownReferenceRows: known.length, unresolvedOccurrenceRows: unresolved.length, notes, ledger: scheduleV2Rows(rows), scope: V2_RULES.scope };
}

/** Required methods are fixed before selection. No endpoint/method fallback. */
export async function selectProspectiveCohortV2({ budget, now, sleep, t0 }) {
  const schedule = [], selections = [], clients = Object.fromEntries(Object.keys(V2_PROVIDERS).map(id => [id, budget.client(id, { phase: 'selection' })]));
  async function observe(provider, method, params, caseId = null) {
    if (budget.exhausted()) return null;
    const before = budget.records.length;
    try { await (caseId ? budget.client(provider, { phase: 'selection', caseId }) : clients[provider]).call(method, params); } catch { /* Evidence and fixed diagnostics remain in the shared ledger. */ }
    return budget.records.slice(before).find(record => record.provider === provider && record.request.method === method && isDeepStrictEqual(record.request.params, params)) ?? null;
  }
  async function at(offset, label, callback) {
    const target = t0 + offset;
    while (now() < target) { if (budget.exhausted()) throw new Error('Selection budget exhausted.'); await sleep(Math.min(30000, target - now())); }
    schedule.push({ label, scheduledAt: new Date(target).toISOString(), calledAt: new Date(now()).toISOString(), lateByMs: Math.max(0, now() - target) });
    return callback();
  }
  let selectionFailure = null, F = null;
  try {
    for (const provider of ['A', 'B', 'official']) { const chain = await observe(provider, 'eth_chainId', []); if (integer(chain?.response?.result) !== '999') throw new Error('Chain identity unavailable.'); }
    const first = await at(60000, 'A finalized observation selecting F', () => observe('A', 'eth_getBlockByNumber', ['finalized', false]));
    const firstHeader = headerIdentity(first?.response?.result); F = firstHeader.number;
    const numbers = [BigInt(F) + 1n, BigInt(F) + 2n];
    const finalized = await at(180000, 'A and B finalized confirmation', async () => {
      const results = []; for (const provider of ['A', 'B']) results.push(await observe(provider, 'eth_getBlockByNumber', ['finalized', false])); return results;
    });
    if (finalized.some(record => BigInt(headerIdentity(record?.response?.result).number) < numbers[1])) throw new Error('Future blocks not finalized.');
    for (const [i, number] of numbers.entries()) {
      const anchors = {};
      for (const provider of ['A', 'B']) anchors[provider] = await observe(provider, 'eth_getBlockByNumber', [hex(number), false]);
      // Preserve both partially observed anchors before interpreting either. A
      // failed binding has a requested number, but no admitted hash or timestamp.
      const entry = { number: number.toString(), hash: null, parentHash: null, timestamp: null, anchors, full: {}, lookups: { A: [], B: [] }, official: {}, envelopeDiscovery: { status: 'incomplete', plannedLookups: 0, attemptedLookups: 0 } }; selections.push(entry);
      const a = headerIdentity(anchors.A?.response?.result), b = headerIdentity(anchors.B?.response?.result);
      if (!isDeepStrictEqual(a, b) || a.number !== number.toString() || a.parentHash !== (i ? selections[i - 1].hash : firstHeader.hash) || BigInt(a.timestamp) * 1000n <= BigInt(Math.floor(t0))) throw new Error('Selected identity, parent or future timestamp mismatch.');
      for (const provider of ['A', 'B']) anchorHashList(anchors[provider]?.response?.result);
      Object.assign(entry, a); entry.envelopeDiscovery.status = 'complete';
      for (const provider of ['A', 'B']) entry.full[provider] = await observe(provider, 'eth_getBlockByHash', [a.hash, true]);
      entry.official.ordinary = await observe('official', 'eth_getBlockByHash', [a.hash, false]);
      entry.official.system = await observe('official', 'eth_getSystemTxsByBlockHash', [a.hash]);
      // A fixed union of observed provider hashes, in A-anchor/B-anchor/A-full/
      // B-full order. Look up only envelopes absent from that provider's full
      // response. Unknown/malformed inline envelopes are never replaced.
      const union = new Set();
      for (const record of [anchors.A, anchors.B, entry.full.A, entry.full.B]) {
        try { for (const value of hashList(record?.response?.result)) union.add(value); } catch { /* Raw lists remain available to normalization/partial accounting. */ }
      }
      for (const provider of ['A', 'B']) {
        const fullList = entry.full[provider]?.response?.result?.transactions;
        const inline = new Set((Array.isArray(fullList) ? fullList : []).filter(item => item && typeof item === 'object').map(item => lower(item.hash)));
        for (const hash of union) if (!inline.has(hash)) {
          entry.envelopeDiscovery.plannedLookups++;
          if (entry.lookups[provider].length >= BLOCK_VIEW_LIMITS.maxLookupsPerProvider || budget.exhausted()) { entry.envelopeDiscovery.status = 'incomplete'; continue; }
          const record = await observe(provider, 'eth_getTransactionByHash', [hash], `enumeration:${a.hash}:${hash}`);
          entry.lookups[provider].push(record); if (record) entry.envelopeDiscovery.attemptedLookups++;
          if (!record?.response?.result) entry.envelopeDiscovery.status = 'incomplete';
        }
      }
    }
  } catch (error) { selectionFailure = safeEvaluationError(error); }
  await budget.waitForIdle();
  const raw = { records: structuredClone(budget.records.filter(record => record.phase === 'selection')) }, captureSha256 = sha(json(raw));
  const blocks = selections.map(entry => {
    const input = { block: { chainId: 999, number: entry.number, hash: entry.hash },
      providers: ['A', 'B'].map(id => ({ id, block: packet(entry.full[id], captureSha256), transactions: entry.lookups[id].map(record => packet(record, captureSha256)) })),
      official: { ordinary: packet(entry.official.ordinary, captureSha256), system: packet(entry.official.system, captureSha256) } };
    const viewStability = { status: 'stable', observations: [] };
    for (const provider of ['A', 'B']) {
      let matches = false; try { anchorHashList(entry.anchors[provider]?.response?.result); matches = isDeepStrictEqual(frozenView(entry.anchors[provider]?.response?.result), frozenView(entry.full[provider]?.response?.result)); } catch {}
      if (!matches) viewStability.status = 'unresolved_or_changed';
      viewStability.observations.push({ provider, anchor: packet(entry.anchors[provider], captureSha256), matchesFullList: matches });
    }
    let normalization = null, normalizationError = null;
    try { normalization = normalizeBlockViews(input); } catch (error) { normalizationError = safeEvaluationError(error); }
    const anchorOccurrences = [];
    for (const provider of ['A', 'B']) {
      const values = entry.anchors[provider]?.response?.result?.transactions;
      if (Array.isArray(values)) for (const [listOrdinal, raw] of values.entries()) {
        const hash = typeof raw === 'string' ? lower(raw) : lower(raw?.hash);
        const matches = typeof raw === 'string' ? normalization?.occurrences.filter(occ => occ.provider === provider && occ.hash === hash && occ.mapping.status === 'matched') ?? [] : [];
        anchorOccurrences.push({ id: `${provider}:anchor:${listOrdinal}`, provider, listOrdinal, raw, hash: typeof hash === 'string' && HASH.test(hash) ? hash : null,
          reportedTransactionIndex: typeof raw === 'object' ? raw?.transactionIndex ?? null : null, replayBoundary: 'unknown', mappingStatus: matches.length ? 'matched' : 'unresolved',
          referenceIds: [...new Set(matches.map(occ => occ.mapping.referenceId))], provenance: packet(entry.anchors[provider], captureSha256).provenance });
      }
    }
    return { number: entry.number, hash: entry.hash, parentHash: entry.parentHash, timestamp: entry.timestamp, input, normalization, normalizationError, viewStability, anchorOccurrences, envelopeDiscovery: entry.envelopeDiscovery,
      unparsedLists: { 'official:ordinary': input.official.ordinary.result?.transactions, 'official:system': input.official.system.result, 'A:full': input.providers[0].block.result?.transactions, 'B:full': input.providers[1].block.result?.transactions,
        'A:anchor': entry.anchors.A?.response?.result?.transactions, 'B:anchor': entry.anchors.B?.response?.result?.transactions,
        'A:lookup': input.providers[0].transactions, 'B:lookup': input.providers[1].transactions } };
  });
  const population = buildV2Population(blocks);
  if (selectionFailure) { population.completeness = 'inconclusive'; population.N_enumerated = null; }
  return { schemaVersion: '2.0', status: selectionFailure ? 'selection_failed' : population.N_enumerated === null ? 'enumeration_inconclusive' : population.N_enumerated === 0 ? 'empty' : 'selected', F, schedule,
    blocks, population, ledger: population.ledger, selectionFailure, raw, selectionRpcSha256: captureSha256, noRetries: true };
}

// Ordinary execution validation retains the v1 comparator and context guards.
async function sourceFingerprint() {
  const files = ['package.json', 'research/coverage-evaluation/PLAN-V2.md'];
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

async function adjudicateOrdinary({ row, block, product, rpc, records, budget, stateContextFactory }) {
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

function frozenView(block) {
  const projected = headerForComparison(block);
  return Object.fromEntries(Object.entries(projected).filter(([key]) => key !== 'size').map(([key, value]) => [key, typeof value === 'string' ? lower(value) : value]));
}
function checkRunViews(records, provider, row, block) {
  try {
    const headers = records.filter(record => record.caseId === row.id && record.provider === provider && ['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(record.request.method));
    if (!headers.length) return { status: 'incomplete', reason: 'No execution-phase header to compare with the sealed view.' };
    return { status: headers.every(record => isDeepStrictEqual(frozenView(record.response?.result), frozenView(block))) ? 'matched' : 'mismatched', recordIds: headers.map(record => record.id) };
  } catch { return { status: 'incomplete', reason: 'Execution-phase header/list is unavailable or malformed.' }; }
}

async function adjudicateSystem({ row, product, rpc, records, block }) {
  const result = { retrieval: { status: 'incomplete' }, exactReplay: { status: 'incomplete', reason: V2_RULES.systemReplay }, inventory: { completeness: 'inconclusive', assets: [], allowances: [] }, assetPairs: [], allowancePairs: [], allAssetEffects: 'inconclusive', allPermissionEffects: 'inconclusive' };
  const secondary = row.representations.B;
  if (secondary.status !== 'resolved') return { ...result, reason: 'No unambiguous secondary provider system representation.' };
  const otherRow = { ...row, transactionHash: secondary.transactionHash, transactionIndex: secondary.reportedTransactionIndex };
  const requests = [['transaction', 'eth_getTransactionByHash', [otherRow.transactionHash]], ['receipt', 'eth_getTransactionReceipt', [otherRow.transactionHash]],
    ['trace', 'debug_traceTransaction', [otherRow.transactionHash, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]],
    ['prestate', 'debug_traceTransaction', [otherRow.transactionHash, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { disableStorage: true } }]]];
  const evidence = {}, failures = [];
  await Promise.all(requests.map(async ([field, method, params]) => { try { evidence[field] = await rpc.call(method, params); } catch (error) { evidence[field] = null; failures.push({ field, error: safeEvaluationError(error) }); } }));
  result.oracleEvidence = evidence; result.retrievalFailures = failures;
  result.oracleIdentity = validateHistoricalEvidence({ ...evidence, row: otherRow, block });
  if (result.oracleIdentity.status === 'complete') {
    result.inventory = independentInventory(evidence);
    result.assetPairs = result.inventory.assets.map(pair => ({ ...pair, status: 'oracle_unavailable' }));
    result.allowancePairs = result.inventory.allowances.map(pair => ({ ...pair, status: 'oracle_unavailable' }));
    if (row.executionAvailability?.status === 'complete') result.traceAgreement = compareTraces(product?.evidence?.traceResponse, evidence.trace);
    if (otherRow.transactionHash === row.transactionHash && otherRow.transactionIndex === row.transactionIndex) result.retrieval = compareRetrieval({ product, oracle: evidence, row, block, productTransaction: transactionFromRecords(records, 'A', row.id) });
    else result.retrieval.reason = 'System action correspondence does not authorize rewriting receipt or transaction hash/index identities.';
  }
  return result;
}

/** Move already charged discovery counts to their unique resolved action budget.
 * Raw records keep their original discovery labels; this is accounting only. */
export function attributeV2DiscoveryBudget(budget, ledger) {
  const owners = new Map();
  for (const row of ledger.filter(row => row.kind !== 'unresolved')) {
    const hashes = new Set([row.referenceHash, ...Object.values(row.representations ?? {}).map(value => value.transactionHash)].filter(Boolean));
    for (const record of budget.records) if (record.phase === 'selection' && record.caseId && record.request.method === 'eth_getTransactionByHash' && hashes.has(lower(record.request.params[0])) && record.caseId.startsWith(`enumeration:${row.blockHash}:`)) {
      if (!owners.has(record.caseId)) owners.set(record.caseId, new Set()); owners.get(record.caseId).add(row.id);
    }
  }
  for (const [caseId, ids] of owners) if (ids.size === 1) {
    const id = [...ids][0], count = budget.transactionCounts.get(caseId) ?? 0, row = ledger.find(row => row.id === id);
    budget.transactionCounts.delete(caseId); budget.transactionCounts.set(id, (budget.transactionCounts.get(id) ?? 0) + count);
    (row.discoveryBudgetLabels ??= []).push(caseId); row.discoveryRpcCount = (row.discoveryRpcCount ?? 0) + count;
  }
}

export function coverageMetricsV2(population, ledger) {
  const counts = (rows, denominator) => {
    const metric = (field, status) => { const passed = rows.filter(row => field === 'executionAvailability' ? row[field]?.status === status : row.comparison?.[field]?.status === status).length; return { passed, denominator, fraction: denominator ? passed / denominator : null }; };
    return { rows: rows.length, attemptedSlots: rows.filter(row => row.attempted).length, productCalls: rows.filter(row => row.productInvoked).length,
      budgetUnattempted: rows.filter(row => row.status === 'budget_unattempted').length, identityUnresolved: rows.filter(row => row.status === 'identity_unresolved').length,
      executionAvailability: metric('executionAvailability', 'complete'), retrievalAgreement: metric('retrieval', 'matched'), exactReplayAgreement: metric('exactReplay', 'matched'),
      success: rows.filter(row => row.executionAvailability?.status === 'complete' && row.executionAvailability.outcome === 'success').length,
      genuineRevert: rows.filter(row => row.executionAvailability?.status === 'complete' && row.executionAvailability.outcome === 'revert').length };
  };
  const references = ledger.filter(row => row.kind !== 'unresolved'), N = population.N_enumerated;
  const pairCounts = key => {
    const pairs = references.flatMap(row => row.comparison?.[key] ?? []), result = { denominator: pairs.length, matched: 0, mismatched: 0, unmeasured: 0, oracle_unavailable: 0, completeness: 'inconclusive_observed_candidates_only' };
    for (const pair of pairs) if (Object.hasOwn(result, pair.status)) result[pair.status]++; return result;
  };
  return { population: { completeness: population.completeness, N_enumerated: N, knownReferenceRows: population.knownReferenceRows, unresolvedOccurrenceRows: population.unresolvedOccurrenceRows, scope: population.scope },
    combined: counts(references, N), strata: Object.fromEntries(['ordinary', 'hypercore_system', 'unresolved'].map(kind => { const rows = ledger.filter(row => row.kind === kind); return [kind, counts(rows, N === null || kind === 'unresolved' ? null : rows.length)]; })),
    observedAssetPairs: pairCounts('assetPairs'), observedAllowancePairs: pairCounts('allowancePairs'),
    allAssetEffects: { passed: 0, denominator: N, fraction: N ? 0 : null, completeness: 'inconclusive' }, allPermissionEffects: { passed: 0, denominator: N, fraction: N ? 0 : null, completeness: 'inconclusive' },
    systemExactReplay: 'unsupported; every system reference remains a non-pass, including retrieved traces' };
}

/** Offline tests inject transport/product/context. Default execution is read-only
 * and only starts when explicitly called or invoked with --run. */
export async function runCoverageEvaluationV2({ outputDirectory, fetchImpl = fetch, productImpl = replay, stateContextFactory = createHistoricalStateContext, now = Date.now, sleep = sleepDefault, limits = {} } = {}) {
  const fingerprint = await sourceFingerprint(), t0 = now(), runId = `${new Date(t0).toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(outputDirectory ?? path.join(ROOT, 'reports/coverage-evaluation-v2', runId));
  await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory, { recursive: false });
  const artifacts = [];
  async function save(file, value) { const content = json(value); await writeFile(path.join(directory, file), content, { flag: 'wx', mode: 0o444 }); const artifact = { file, sha256: sha(content), bytes: Buffer.byteLength(content) }; artifacts.push(artifact); return artifact; }
  const budget = new EvaluationBudgetV2({ t0, limits, fetchImpl, now });
  const manifest = await save('manifest.json', { schemaVersion: '2.0', runId, T0: new Date(t0).toISOString(), rules: V2_RULES, implementation: fingerprint, providers: Object.fromEntries(Object.entries(V2_PROVIDERS).map(([id, url]) => [id, { url, nodeIdentity: 'unknown', executionClient: 'unknown', infrastructureIndependence: 'unproven' }])), limits: budget.limits, policyLimits: EVALUATION_LIMITS, comparator: COMPARISON_RULES, oracleTokens: ORACLE_TOKENS,
    discipline: 'No retries, fallback methods/endpoints, replacements or invented replay boundaries. Every successful raw response is retained and hashed; arbitrary error bodies are charged/hashed but sanitized. All product outputs are sealed before comparator adjudication.',
    budgetAccounting: 'One shared budget covers official enumeration, A/B lists and envelope discovery, product internals and comparator calls. Resolved discovery lookups are charged to the same action RPC cap before any execution. A cap-crossing chunk is charged but never retained as usable evidence.',
    unassessed: 'No vendor score, security classification, all-EVM accuracy or independent-engine proof.' });
  const cohort = await selectProspectiveCohortV2({ budget, now, sleep, t0 });
  const selectionRaw = await save('selection-rpc.json', cohort.raw); if (selectionRaw.sha256 !== cohort.selectionRpcSha256) throw new Error('Selection evidence seal mismatch.');
  const { raw: unusedRaw, ...cohortWithoutRaw } = cohort;
  const cohortArtifact = await save('cohort.json', cohortWithoutRaw);
  const ledger = cohort.ledger.map(row => ({ ...row, attempted: false, productInvoked: false, status: 'budget_unattempted', reason: 'Attempt cap or exhausted budget; reference retained.' }));
  attributeV2DiscoveryBudget(budget, ledger);
  const products = new Map(), seals = [];
  for (const [index, row] of ledger.entries()) {
    if (cohort.status === 'selection_failed' || index >= budget.limits.attempts || budget.exhausted()) continue;
    row.attempted = true; delete row.reason;
    if (row.kind === 'unresolved' || row.identityStatus !== 'resolved' || row.transactionHash === null || row.transactionIndex === null) { row.status = 'identity_unresolved'; row.reason = 'No unambiguous provider representation; no input was invented.'; continue; }
    row.status = 'attempted'; row.productInvoked = true;
    let result;
    try {
      const output = await productImpl({ chainId: 999, transactionHash: row.transactionHash }, budget.client('A', { phase: 'product', caseId: row.id }));
      result = { status: 'returned', output: structuredClone(output) }; products.set(row.id, result.output);
      row.productCoverage = output.coverage?.status ?? 'unknown'; row.productProvenance = validateProductProvenance(output, fingerprint.engine);
    } catch (error) { result = { status: 'unavailable', error: safeEvaluationError(error) }; }
    await budget.waitForIdle();
    const artifact = await save(`product-${index}.json`, { row: structuredClone(row), ...result }); seals.push({ caseId: row.id, ...artifact }); row.productArtifact = artifact;
    const selected = cohort.blocks.find(block => block.hash === row.blockHash), block = selected.input.providers.find(provider => provider.id === 'A').block.result;
    const product = products.get(row.id), tx = transactionFromRecords(budget.records, 'A', row.id);
    try { row.executionAvailability = validateHistoricalEvidence({ transaction: tx, receipt: product?.evidence?.receipt, trace: product?.evidence?.traceResponse, row, block: headerForComparison(block) }); }
    catch { row.executionAvailability = { status: 'incomplete' }; }
    if (product) row.productView = validateProductView(product, tx, row);
    row.productBlockView = checkRunViews(budget.records, 'A', row, block);
    if (row.productProvenance?.status === 'mismatched' || row.productView?.status === 'mismatched' || row.productBlockView.status === 'mismatched') row.executionAvailability = { status: 'mismatched', reason: 'Product identity, presentation or block view differs from frozen evidence.' };
    else if (row.productView?.status !== 'matched' || row.productBlockView.status !== 'matched') row.executionAvailability = { status: 'incomplete', reason: 'Product identity/presentation or the unchanged block view is not complete.' };
  }
  const productSeal = await save('product-seal.json', { sealedAt: new Date(now()).toISOString(), manifestSha256: manifest.sha256, cohortSha256: cohortArtifact.sha256, products: seals, productRpc: budget.records.filter(record => record.phase === 'product'), comparatorHasStarted: false });
  for (const [index, row] of ledger.entries()) {
    if (!row.productInvoked) continue;
    if (budget.exhausted()) { row.comparison = { retrieval: { status: 'incomplete' }, exactReplay: { status: 'incomplete' }, reason: 'Budget exhausted before comparator; row retained.' }; continue; }
    const selected = cohort.blocks.find(block => block.hash === row.blockHash), originalBlock = selected.input.providers.find(provider => provider.id === 'B').block.result;
    const args = { row, block: null, product: products.get(row.id), rpc: budget.client('B', { phase: 'comparator', caseId: row.id }), records: budget.records, budget, stateContextFactory };
    try {
      args.block = headerForComparison(originalBlock);
      // Explicitly retrieve the execution-phase header once even when the
      // original-position adapter cannot prepare; view changes stay visible.
      await args.rpc.call('eth_getBlockByHash', [row.blockHash, false]);
      row.comparison = row.kind === 'hypercore_system' ? await adjudicateSystem(args) : await adjudicateOrdinary(args);
      row.comparatorBlockView = checkRunViews(budget.records, 'B', row, originalBlock);
      if (row.executionAvailability?.status !== 'complete' || row.comparatorBlockView.status !== 'matched') {
        for (const key of ['retrieval', 'exactReplay']) if (row.comparison[key]?.status === 'matched') row.comparison[key] = { status: 'incomplete', reason: 'Primary execution identity or frozen provider view is not complete/stable.' };
        for (const key of ['assetPairs', 'allowancePairs']) for (const pair of row.comparison[key] ?? []) if (pair.status === 'matched') pair.status = 'oracle_unavailable';
      }
    } catch (error) { row.comparison = { retrieval: { status: 'incomplete' }, exactReplay: { status: 'incomplete' }, error: safeEvaluationError(error) }; }
    await budget.waitForIdle(); row.comparisonArtifact = await save(`comparison-${index}.json`, row.comparison);
  }
  const finalFingerprint = await sourceFingerprint(), sourceUnchanged = fingerprint.sha256 === finalFingerprint.sha256;
  const productProvenanceValid = ledger.every(row => !row.productProvenance || row.productProvenance.status === 'matched');
  const raw = await save('rpc.json', { records: budget.records, accounting: budget.snapshot() });
  const ledgerArtifact = await save('ledger.json', { population: cohort.population, rows: ledger });
  const report = { schemaVersion: '2.0', runId, directory, status: !sourceUnchanged ? 'invalid_source_changed_during_run' : !productProvenanceValid ? 'invalid_product_provenance' : cohort.status === 'selected' ? 'completed_with_scoped_inconclusive_metrics' : cohort.status,
    evaluationValid: sourceUnchanged && productProvenanceValid && ['selected', 'empty'].includes(cohort.status), sourceUnchanged, productProvenanceValid, generatedAt: new Date(now()).toISOString(), manifest, cohort: cohortArtifact, selectionRaw, productSeal, raw, ledger: ledgerArtifact,
    metrics: coverageMetricsV2(cohort.population, ledger), budget: budget.snapshot(), security: { status: 'not_assessed', findings: [] }, noRetries: true,
    limitations: ['V1 artifacts and its selection failure remain unchanged.', V2_RULES.scope, 'System correspondence is not invocation semantics, authorization, receipt rewriting or original-position proof. System exact replay is unsupported.', 'Ordinary full-envelope and original-state requirements remain strict; effective-gas-price substitution is not exact typed/signed replay.', 'All-effects coverage remains inconclusive; observed pair agreement is separate and uses shared adapter assumptions.', 'Two adjacent blocks and sixteen scheduled attempts are correlated development feasibility evidence, not a representative accuracy or vendor comparison.'] };
  const reportArtifact = await save('report.json', report); await save('artifact-index.json', { artifacts, reportSha256: reportArtifact.sha256 }); return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--run') { process.stderr.write('Usage: node src/evaluate-coverage-v2.js --run\nFreeze and review PLAN-V2 and sources first. No network on import.\n'); process.exitCode = 2; }
  else try { const result = await runCoverageEvaluationV2(); process.stdout.write(json({ status: result.status, report: path.join(result.directory, 'report.json'), N_enumerated: result.metrics.population.N_enumerated, rpc: result.budget.rpcCount })); if (!result.evaluationValid) process.exitCode = 1; }
  catch (error) { process.stderr.write(json(safeEvaluationError(error))); process.exitCode = 1; }
}
