import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeBlockViews } from '../src/block-views.js';
import { EvaluationBudgetV2, V2_PROVIDERS } from '../src/evaluation-v2-budget.js';
import { buildV2Population, scheduleV2Rows, selectProspectiveCohortV2, coverageMetricsV2, attributeV2DiscoveryBudget, runCoverageEvaluationV2 } from '../src/evaluate-coverage-v2.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const reportBytes = await readFile(new URL('../reports/block-view-normalization/report.json', import.meta.url));
assert.equal(sha(reportBytes), '5eb44e479cbedfefe440a1c8c5dcfceb05c76dc78a4b08401d4a602655493d5a');
const saved = JSON.parse(reportBytes);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const fixture = (index = 1) => structuredClone(saved.cases[index].input);
function normalized(input) {
  return { number: input.block.number, hash: input.block.hash, timestamp: BigInt(input.official.ordinary.result.timestamp).toString(), input,
    normalization: normalizeBlockViews(input), viewStability: { status: 'stable' }, envelopeDiscovery: { status: 'complete' }, anchorOccurrences: [] };
}
// The first block bodies are genuine saved development evidence. The empty
// second block and all changed fields/transport envelopes are synthetic controls.
function emptyInput() {
  const input = fixture(); input.block.number = String(BigInt(input.block.number) + 1n); input.block.hash = hash(777);
  for (const packet of [input.official.ordinary, ...input.providers.map(provider => provider.block)]) {
    packet.request = { ...packet.request, method: 'eth_getBlockByHash', params: [input.block.hash, false] };
    packet.result = { ...packet.result, number: hex(input.block.number), hash: input.block.hash, parentHash: saved.cases[1].input.block.hash, timestamp: hex(BigInt(packet.result.timestamp) + 1n), transactions: [] };
  }
  input.official.system.request = { ...input.official.system.request, method: 'eth_getSystemTxsByBlockHash', params: [input.block.hash] }; input.official.system.result = [];
  for (const provider of input.providers) provider.transactions = [];
  return input;
}
function population(input = fixture()) { return buildV2Population([normalized(input), normalized(emptyInput())]); }

test('saved A5/B8 and later A8/B8 map eight references without changing literal indices or boundaries', () => {
  for (const i of [1, 2]) {
    const result = population(fixture(i)); assert.equal(result.N_enumerated, 8); assert.deepEqual(result.referenceCounts, { ordinary: 5, hypercore_system: 3 });
    assert.equal(result.unresolvedOccurrenceRows, 0); assert.equal(result.ledger.length, 8);
    assert.deepEqual(result.ledger.map(row => row.kind), ['ordinary', 'hypercore_system', 'ordinary', 'hypercore_system', 'ordinary', 'hypercore_system', 'ordinary', 'ordinary']);
    assert.ok(result.ledger.every(row => row.replayBoundary === 'unknown' && row.executionOrder === 'unknown'));
    const first = result.ledger[0]; assert.equal(first.transactionIndex, '3'); assert.equal(first.representations.A.reportedTransactionIndex, '3');
    assert.deepEqual(first.representations.A.listOrdinals, [i === 1 ? 0 : 3]);
    assert.equal(first.transactionHash, '0x1774921234db960d6e8e1591b95d6d70d182b1227eb4d20f1232760ca527b392');
  }
});

test('missing official enumeration, unknown transaction semantics and missing ordinary envelopes retain unresolved rows with null fractions', () => {
  for (const mutate of [
    input => { input.official.system.status = 'unavailable'; delete input.official.system.result; },
    input => { for (const provider of input.providers) provider.transactions[3].result.type = '0x4'; },
    input => { input.providers[0].transactions.splice(3, 1); },
  ]) {
    const input = fixture(); mutate(input); const result = population(input);
    assert.equal(result.N_enumerated, null); assert.ok(result.knownReferenceRows >= 5); assert.ok(result.unresolvedOccurrenceRows > 0);
    const measuredLooking = result.ledger.map(row => ({ ...row, attempted: true, executionAvailability: { status: 'complete' }, comparison: { retrieval: { status: 'matched' } } }));
    const metrics = coverageMetricsV2(result, measuredLooking);
    assert.equal(metrics.combined.executionAvailability.fraction, null); assert.equal(metrics.combined.retrievalAgreement.fraction, null);
    assert.equal(metrics.strata.ordinary.executionAvailability.fraction, null); assert.equal(metrics.strata.unresolved.retrievalAgreement.fraction, null);
  }
});

test('unavailable full-enumeration progress, source-view changes and cross-block duplicates cannot admit N', () => {
  const first = normalized(fixture()), second = normalized(emptyInput());
  for (const mutation of [
    x => { x.envelopeDiscovery.status = 'incomplete'; },
    x => { x.viewStability.status = 'unresolved_or_changed'; },
  ]) { const changed = structuredClone(first); mutation(changed); assert.equal(buildV2Population([changed, second]).N_enumerated, null); }
  const duplicate = structuredClone(first); duplicate.number = second.number; duplicate.hash = second.hash;
  const conflict = buildV2Population([first, duplicate]); assert.equal(conflict.N_enumerated, null); assert.equal(conflict.knownReferenceRows, 16); assert.ok(conflict.notes.length);
});

test('unknown extra anchor occurrences and structural rejection retain raw occurrence rows', () => {
  const first = normalized(fixture()), second = normalized(emptyInput()), raw = { hash: hash(900), unfamiliar: true };
  first.viewStability.status = 'unresolved_or_changed'; first.anchorOccurrences = [{ id: 'A:anchor:99', raw, mappingStatus: 'unresolved' }];
  const result = buildV2Population([first, second]); assert.equal(result.N_enumerated, null); assert.equal(result.unresolvedOccurrenceRows, 1); assert.deepEqual(result.ledger.find(row => row.kind === 'unresolved').raw, raw);
  first.normalization = null; first.unparsedLists = { official: [hash(1), raw], A: [hash(1)] };
  const rejected = buildV2Population([first, second]); assert.equal(rejected.N_enumerated, null); assert.equal(rejected.ledger.length, 3); assert.equal(rejected.knownReferenceRows, 0);
});

test('fixed sixteen-slot schedule preserves system and unresolved strata and every omitted row', () => {
  const rows = ['ordinary','hypercore_system','unresolved'].flatMap(kind => Array.from({ length: 12 }, (_, i) => ({ id: kind + i, kind, blockNumber: '100', rawOrdinal: i })));
  const ordered = scheduleV2Rows(rows); assert.equal(ordered.length, 36); assert.deepEqual(ordered.slice(0, 6).map(row => row.kind), ['ordinary','hypercore_system','unresolved','ordinary','hypercore_system','unresolved']);
  const first = ordered.slice(0, 16); assert.equal(first.filter(row => row.kind === 'hypercore_system').length, 5); assert.equal(first.filter(row => row.kind === 'unresolved').length, 5);
  assert.equal(new Set(ordered.map(row => row.id)).size, 36); assert.ok(ordered.every(row => row.replayBoundary === 'unknown'));
});

const response = (request, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
function selectionHarness({ mutate, onFetch } = {}) {
  const input = fixture(), empty = emptyInput(), number = BigInt(input.block.number), final = { ...empty.official.ordinary.result };
  const first = { ...input.official.ordinary.result, number: hex(number - 1n), hash: input.official.ordinary.result.parentHash, timestamp: hex(BigInt(input.official.ordinary.result.timestamp) - 1n), transactions: [] };
  const t0 = Number(BigInt(input.official.ordinary.result.timestamp) * 1000n) - 120000; let time = t0, finalizedA = 0;
  const all = new Map(input.providers.flatMap(provider => provider.transactions.map(packet => [packet.result.hash, packet.result])));
  const full = provider => ({ ...input.providers.find(p => p.id === provider).block.result, transactions: input.providers.find(p => p.id === provider).block.result.transactions.map(hash => structuredClone(all.get(hash))) });
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error'); const provider = Object.keys(V2_PROVIDERS).find(id => V2_PROVIDERS[id] === String(url)); assert.ok(provider);
    const request = JSON.parse(options.body); calls.push({ provider, request }); await onFetch?.({ provider, request });
    const [arg, include] = request.params; let result = null;
    if (request.method === 'eth_chainId') result = '0x3e7';
    else if (request.method === 'eth_getBlockByNumber') {
      if (arg === 'finalized') result = provider === 'A' && ++finalizedA === 1 ? first : final;
      else if (BigInt(arg) === number) result = input.providers.find(p => p.id === provider).block.result;
      else if (BigInt(arg) === number + 1n) result = empty.providers.find(p => p.id === provider).block.result;
    } else if (request.method === 'eth_getBlockByHash') {
      if (arg === input.block.hash) result = provider === 'official' ? input.official.ordinary.result : include ? full(provider) : input.providers.find(p => p.id === provider).block.result;
      else if (arg === empty.block.hash) result = empty.official.ordinary.result;
    } else if (request.method === 'eth_getSystemTxsByBlockHash') result = arg === input.block.hash ? input.official.system.result : [];
    else if (request.method === 'eth_getTransactionByHash') result = all.get(arg) ?? null;
    result = structuredClone(result); if (mutate) { const changed = mutate({ provider, request, result }); if (changed !== undefined) result = changed; }
    return response(request, result);
  };
  return { t0, now: () => time, sleep: async ms => { time += ms; }, fetchImpl, calls };
}

test('scheduled selection uses only fixed hash-bound official methods and seals genuine composites as development controls', async () => {
  const h = selectionHarness(), budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl });
  const result = await selectProspectiveCohortV2({ budget, ...h });
  assert.equal(result.status, 'selected'); assert.equal(result.population.N_enumerated, 8); assert.equal(budget.rpcCount, 21);
  assert.deepEqual(h.calls.filter(c => c.provider === 'official').map(c => c.request.method), ['eth_chainId','eth_getBlockByHash','eth_getSystemTxsByBlockHash','eth_getBlockByHash','eth_getSystemTxsByBlockHash']);
  assert.ok(h.calls.filter(c => c.request.method === 'eth_getBlockByHash' && c.provider !== 'official').every(c => c.request.params[1] === true));
  assert.deepEqual(result.blocks[0].envelopeDiscovery, { status: 'complete', plannedLookups: 3, attemptedLookups: 3 });
  assert.equal(result.blocks[0].anchorOccurrences.length, 13); assert.ok(result.blocks[0].anchorOccurrences.every(o => o.replayBoundary === 'unknown'));
  assert.equal(result.selectionRpcSha256, sha(JSON.stringify(result.raw, null, 2) + '\n'));
  const before = budget.rpcCount; attributeV2DiscoveryBudget(budget, result.ledger); assert.equal(budget.rpcCount, before);
  assert.equal(result.ledger.filter(row => row.kind === 'hypercore_system').reduce((n, row) => n + row.discoveryRpcCount, 0), 3);
  assert.equal([...budget.transactionCounts.values()].reduce((n, x) => n + x, 0), 3);
});

test('same-hash anchor/full representation change is retained and not repaired by later successful normalization', async () => {
  const h = selectionHarness({ mutate: ({ provider, request, result }) => {
    if (provider === 'A' && request.method === 'eth_getBlockByHash' && request.params[1] === true && result.transactions.length) {
      const input = fixture(); result.transactions = input.providers[1].block.result.transactions.map(hash => input.providers[1].transactions.find(p => p.result.hash === hash).result);
    } return result;
  } });
  const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
  assert.equal(result.status, 'enumeration_inconclusive'); assert.equal(result.population.N_enumerated, null); assert.equal(result.blocks[0].normalization.denominator.N_enumerated, 8);
  assert.equal(result.blocks[0].viewStability.status, 'unresolved_or_changed'); assert.equal(result.blocks[0].anchorOccurrences.filter(o => o.provider === 'A').length, 5);
});

test('a malformed selected header retains the other anchor occurrences without admitting a block identity', async () => {
  for (const missing of ['A', 'B']) {
    const h = selectionHarness({ mutate: ({ provider, request, result }) => provider === missing && request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized' ? null : result });
    const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
    assert.equal(result.status, 'selection_failed'); assert.equal(result.population.N_enumerated, null);
    const retained = missing === 'A' ? fixture().providers[1].block.result.transactions : fixture().providers[0].block.result.transactions;
    assert.equal(result.ledger.length, retained.length); assert.deepEqual(result.ledger.map(row => row.raw), retained);
    assert.ok(result.ledger.every(row => row.kind === 'unresolved' && row.blockHash === null && row.transactionHash === null && row.replayBoundary === 'unknown'));
    assert.equal(result.blocks[0].hash, null); assert.equal(budget.rpcCount, 8); assert.equal(h.calls.some(c => c.request.method === 'eth_getBlockByHash'), false);
  }
});

test('anchor-only changes in complete header fields prevent stable-view admission', async () => {
  for (const [field, changed] of [['baseFeePerGas', '0xdeadbeef'], ['stateRoot', hash(9123)]]) {
    const h = selectionHarness({ mutate: ({ provider, request, result }) => {
      if (provider === 'A' && request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized' && result.transactions.length) result[field] = changed;
      return result;
    } });
    const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
    assert.equal(result.status, 'enumeration_inconclusive'); assert.equal(result.population.N_enumerated, null); assert.equal(result.blocks[0].normalization.denominator.N_enumerated, 8);
    assert.equal(result.blocks[0].viewStability.status, 'unresolved_or_changed');
    assert.equal(result.blocks[0].viewStability.observations.find(o => o.provider === 'A').anchor.result[field], changed);
  }
});

test('unexpected full objects in hash-only anchors remain raw unresolved observations', async () => {
  const raw = { ...fixture().providers[0].transactions[3].result, input: '0xdeadbeef', value: '0x777', blockHash: hash(8) };
  const h = selectionHarness({ mutate: ({ provider, request, result }) => {
    if (provider === 'A' && request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized') result.transactions[0] = raw;
    return result;
  } });
  const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
  assert.equal(result.status, 'selection_failed'); assert.equal(result.population.N_enumerated, null); assert.equal(result.ledger.length, 13);
  assert.deepEqual(result.ledger[0].raw, raw); assert.equal(result.ledger[0].identityStatus, 'unresolved'); assert.equal(result.blocks[0].hash, null);
  assert.equal(result.blocks[0].anchorOccurrences[0].mappingStatus, 'unresolved'); assert.equal(h.calls.some(c => c.request.method === 'eth_getTransactionByHash'), false);
});

test('structural normalizer rejection retains every attempted null lookup packet with exact request identity', async () => {
  let nested = {}; for (let i = 0; i < 40; i++) nested = { nested };
  const h = selectionHarness({ mutate: ({ provider, request, result }) => {
    if (provider === 'A' && request.method === 'eth_getBlockByHash' && result?.transactions?.length) result.syntheticTooDeep = nested;
    if (request.method === 'eth_getTransactionByHash') return null;
    return result;
  } });
  const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
  assert.equal(result.status, 'enumeration_inconclusive'); assert.equal(result.population.N_enumerated, null); assert.equal(result.blocks[0].normalization, null);
  const calls = result.raw.records.filter(r => r.request.method === 'eth_getTransactionByHash'); assert.equal(calls.length, 3);
  const retained = result.ledger.filter(row => row.occurrenceId.startsWith('A:lookup:')); assert.equal(retained.length, 3);
  for (const [i, row] of retained.entries()) { assert.deepEqual(row.raw.request, calls[i].request); assert.equal(row.raw.result, null); assert.equal(row.transactionHash, null); assert.equal(row.raw.provenance.responseSha256, calls[i].responseSha256); }
});

test('unsupported system-by-hash result cannot become empty or trigger method fallback', async () => {
  const h = selectionHarness({ mutate: ({ request }) => request.method === 'eth_getSystemTxsByBlockHash' ? {} : undefined });
  const budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl }); const result = await selectProspectiveCohortV2({ budget, ...h });
  assert.equal(result.status, 'enumeration_inconclusive'); assert.equal(result.population.N_enumerated, null); assert.ok(result.population.knownReferenceRows >= 5); assert.ok(result.population.unresolvedOccurrenceRows > 0);
  assert.equal(h.calls.some(c => c.request.method === 'eth_getSystemTxsByBlockNumber'), false);
});

test('finality/parent failure and exhausted envelope-discovery budget preserve bounded evidence without replacement', async () => {
  const bad = selectionHarness({ mutate: ({ request, result }) => { if (request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized') result.parentHash = hash(9123); return result; } });
  const b = new EvaluationBudgetV2({ t0: bad.t0, now: bad.now, fetchImpl: bad.fetchImpl }); const failed = await selectProspectiveCohortV2({ budget: b, ...bad });
  assert.equal(failed.status, 'selection_failed'); assert.equal(failed.population.N_enumerated, null); assert.ok(failed.ledger.length >= 13); assert.equal(bad.calls.some(c => c.request.method === 'eth_getSystemTxsByBlockHash'), false);
  const h = selectionHarness(), budget = new EvaluationBudgetV2({ t0: h.t0, now: h.now, fetchImpl: h.fetchImpl, limits: { totalRpc: 12 } });
  const incomplete = await selectProspectiveCohortV2({ budget, ...h }); assert.equal(budget.rpcCount, 12); assert.equal(incomplete.population.N_enumerated, null); assert.ok(incomplete.raw.records.length === 12);
});

test('v2 budget charges official and engine calls together, rejects fallback/write methods and clones retained results', async () => {
  let fetches = 0; const budget = new EvaluationBudgetV2({ t0: Date.now(), limits: { totalRpc: 2, perTransactionRpc: 1 }, fetchImpl: async (_, o) => { fetches++; return response(JSON.parse(o.body), { nested: 1 }); } });
  const official = budget.client('official', { phase: 'selection', caseId: 'same' });
  const value = await official.call('eth_getSystemTxsByBlockHash', [hash(1)]); value.nested = 2; assert.equal(budget.records[0].response.result.nested, 1);
  await assert.rejects(budget.client('A', { phase: 'product', caseId: 'same' }).call('eth_chainId'), { code: 'BUDGET_TRANSACTION_RPC' });
  await assert.rejects(official.call('eth_getSystemTxsByBlockNumber', ['0x1']), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(official.call('eth_sendRawTransaction', ['0x']), { code: 'METHOD_NOT_ALLOWED' });
  await budget.client('B', { phase: 'comparator' }).call('eth_chainId'); await assert.rejects(official.call('eth_chainId'), { code: 'BUDGET_TOTAL_RPC' });
  assert.equal(fetches, 2); assert.equal(budget.records[0].endpoint, V2_PROVIDERS.official); assert.equal(budget.records[0].provider, 'official');
});

test('official transport counts error bodies without retaining secret text and seals ignored late completions', async () => {
  const secret = 'credentials=SYNTHETIC_SECRET';
  const budget = new EvaluationBudgetV2({ t0: Date.now(), fetchImpl: async () => new Response(secret, { status: 500 }) });
  await assert.rejects(budget.client('official').call('eth_chainId'), { code: 'RPC_HTTP_ERROR' }); assert.equal(budget.responseBytes, Buffer.byteLength(secret)); assert.equal(budget.records[0].responseSha256, sha(secret)); assert.equal(JSON.stringify(budget.records).includes(secret), false);
  let release, canceled = 0; const late = new EvaluationBudgetV2({ t0: Date.now(), limits: { requestMs: 5 }, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(late.client('official').call('eth_chainId'), { code: 'RPC_TIMEOUT' }); const sealed = JSON.stringify(late.records);
  release({ status: 200, ok: true, body: { getReader() { return { cancel() { canceled++; return Promise.resolve(); } }; } } });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(JSON.stringify(late.records), sealed); assert.equal(late.responseBytes, 0); assert.equal(canceled, 1);
});

test('every v2 endpoint rejects invalid UTF-8 without losing the complete raw-byte hash or count', async () => {
  for (const provider of ['A', 'B', 'official']) {
    const bytes = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const budget = new EvaluationBudgetV2({ t0: Date.now(), fetchImpl: async () => new Response(bytes, { status: 200 }) });
    await assert.rejects(budget.client(provider).call('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
    assert.equal(budget.responseBytes, bytes.length); assert.equal(budget.records[0].responseSha256, sha(bytes)); assert.equal(budget.records[0].bodyComplete, true);
    assert.equal(budget.records[0].responseRaw, undefined); assert.equal(budget.records[0].response, undefined); assert.equal(budget.records[0].bodyRetained, false);
  }
});

test('every v2 endpoint rejects BOM-prefixed JSON without changing the complete byte evidence', async () => {
  for (const provider of ['A', 'B', 'official']) {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x3e7"}')]);
    const budget = new EvaluationBudgetV2({ t0: Date.now(), fetchImpl: async () => new Response(bytes, { status: 200 }) });
    await assert.rejects(budget.client(provider).call('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
    assert.equal(budget.responseBytes, bytes.length); assert.equal(budget.records[0].responseSha256, sha(bytes)); assert.equal(budget.records[0].bodyComplete, true);
    assert.equal(budget.records[0].responseRaw, undefined); assert.equal(budget.records[0].response, undefined); assert.equal(budget.records[0].bodyRetained, false);
  }
});

test('runnable offline v2 seals all eight product failures before comparator, preserves all rows and immutable files', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'coverage-v2-')), directory = path.join(temp, 'run'); let productCalls = 0, comparisons = 0;
  try {
    const h = selectionHarness({ onFetch: async ({ request }) => { if (request.method === 'eth_getTransactionReceipt') { const seal = JSON.parse(await readFile(path.join(directory, 'product-seal.json'))); assert.equal(seal.products.length, 8); assert.equal(seal.comparatorHasStarted, false); comparisons++; } } });
    const result = await runCoverageEvaluationV2({ outputDirectory: directory, ...h, productImpl: async (input, rpc) => { productCalls++; await rpc.call('eth_getTransactionByHash', [input.transactionHash]); throw new Error('Synthetic unsupported product outcome'); }, stateContextFactory: () => { throw new Error('No valid original state in this synthetic control'); } });
    assert.equal(result.status, 'completed_with_scoped_inconclusive_metrics'); assert.equal(result.sourceUnchanged, true); assert.equal(result.evaluationValid, true);
    assert.equal(productCalls, 8); assert.equal(comparisons, 8); assert.equal(result.metrics.population.N_enumerated, 8);
    assert.equal(result.metrics.combined.executionAvailability.passed, 0); assert.equal(result.metrics.strata.hypercore_system.exactReplayAgreement.passed, 0);
    const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'))); assert.equal(ledger.rows.length, 8); assert.ok(ledger.rows.every(row => row.replayBoundary === 'unknown'));
    const artifacts = JSON.parse(await readFile(path.join(directory, 'artifact-index.json'))); for (const entry of artifacts.artifacts) assert.equal(sha(await readFile(path.join(directory, entry.file))), entry.sha256);
    const files = await readdir(directory); assert.equal(files.filter(file => /^product-\d+\.json$/.test(file)).length, 8); assert.equal(files.filter(file => /^comparison-\d+\.json$/.test(file)).length, 8);
    await assert.rejects(runCoverageEvaluationV2({ outputDirectory: directory, ...h }), { code: 'EEXIST' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
