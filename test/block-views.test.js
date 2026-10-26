import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeBlockViews, SYSTEM_IDENTITY_FIELDS, BLOCK_VIEW_LIMITS } from '../src/block-views.js';

// These immutable development inputs combine earlier block-list observations
// with later saved ordinary lookups. Every packet retains its actual capture and
// timestamp; this is not a simultaneous capture or a prospective evaluation.
const sha = value => createHash('sha256').update(value).digest('hex');
async function saved(file, expected) {
  const bytes = await readFile(new URL('../' + file, import.meta.url));
  assert.equal(sha(bytes), expected);
  return { data: JSON.parse(bytes), artifact: file, captureSha256: expected };
}
const pilot = await saved('reports/coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/rpc.json', 'e4155c2816bdf27761869f7fc7eea8cf84ce59475c89a801a1ee5a7e144379a9');
const system = await saved('reports/system-transaction-diagnostic/capture.json', 'e7a2811020a5970f5a665d9948b543fc6d6155673ae823e8c86bff4f752f362c');
const position = await saved('reports/system-position-diagnostic/capture.json', 'be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b');
const BLOCK_HASH = '0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4';
const ORDINARY = [
  '0x1774921234db960d6e8e1591b95d6d70d182b1227eb4d20f1232760ca527b392',
  '0x52e44bd70312e00d0a5a096a653d83a90bccb7e27fb66dcc1fd7e28034e33486',
  '0x5e6e562b55c65dd43a0f980b2a18f81cf047dd7a9702400bfababa98563f12d7',
  '0x1229c2ee75bf04b07356ce7e7b19b2108404020785614abde5bac429abf80c26',
  '0x45d1d4ea98b031fd653f69b6f186f6680379d05dca91f7b0d512c9979e272799',
];
const OFFICIAL_SYSTEM = [
  '0xd8e0b682c5a475c94ef471bbe8cfc18cdb9265bb42eab9f513ce4e1b335c1901',
  '0x76fdff61e64fc6f0e37f12ec1ddc86d12613bfda6d362be12a72a2d3b02c1282',
  '0x1f460dc26603c831d5e46aaf30a48508513da0b66f6e9e06d44a0a6e96be1737',
];
const PROVIDER_SYSTEM = [
  '0xc9d5e5dfb1b07ed8d7bb0373618767191bd7ad9bcc11d9185bff886ba7ab088a',
  '0x14f094947b7c9ca7d83baad145e0e26e3c770a884709e7dc4b3e539d222664d8',
  '0x395725735b69f19ffcb48893a82942e932bfd719ef10faf666ae739d2a510939',
];
function packet(record, artifact) {
  assert.ok(record); assert.equal(record.response.id, record.request.id); assert.equal(record.response.jsonrpc, '2.0');
  assert.equal(Object.hasOwn(record.response, 'error'), false); assert.equal(record.httpStatus, 200);
  assert.equal(sha(record.responseRaw), record.responseSha256); assert.deepEqual(JSON.parse(record.responseRaw), record.response);
  return { status: 'available', request: structuredClone(record.request), result: structuredClone(record.response.result), provenance: {
    endpoint: record.url ?? record.endpoint, artifact: artifact.artifact, captureSha256: artifact.captureSha256, responseSha256: record.responseSha256, observedAt: record.completedAt,
  } };
}
function fixture(later = false) {
  const ordinary = packet(system.data.calls.find(record => record.request.id === 2), system), systems = packet(system.data.calls.find(record => record.request.id === 3), system);
  return { block: { chainId: 999, number: '49544166', hash: BLOCK_HASH }, official: { ordinary, system: systems }, providers: ['A', 'B'].map(id => {
    const blockRecord = later ? position.data.records.find(record => record.provider === id && record.request.method === 'eth_getBlockByNumber')
      : pilot.data.records.find(record => record.provider === id && record.request.method === 'eth_getBlockByNumber' && record.response.result?.hash === BLOCK_HASH);
    const lookups = [
      ...system.data.calls.filter(record => record.endpoint === id && record.request.method === 'eth_getTransactionByHash').map(record => packet(record, system)),
      ...position.data.records.filter(record => record.provider === id && record.request.method === 'eth_getTransactionByHash').map(record => packet(record, position)),
    ];
    return { id, block: packet(blockRecord, later ? position : pilot), transactions: lookups };
  }) };
}
function noReplayInference(result) {
  assert.ok(result.occurrences.every(item => item.replayBoundary === 'unknown'));
  assert.ok(result.referenceActions.every(item => item.replayBoundary === 'unknown' && item.executionOrder === 'unknown' && item.execution === 'not_assessed'));
  assert.equal(result.denominator.fraction, null);
}

test('recorded five/eight views retain every reference, alias and occurrence without replay-index inference', () => {
  const input = fixture(), unchanged = structuredClone(input), result = normalizeBlockViews(input);
  assert.deepEqual(input, unchanged); assert.deepEqual(result.sources, input);
  assert.equal(result.enumeration.status, 'complete'); assert.equal(result.identityMapping.status, 'complete');
  assert.deepEqual(result.views.map(view => [view.provider, view.classification]), [['A', 'ordinary_only'], ['B', 'system_inclusive']]);
  assert.deepEqual(result.referenceActions.map(action => [action.kind, action.referenceHash]), [...ORDINARY.map(value => ['ordinary', value]), ...OFFICIAL_SYSTEM.map(value => ['hypercore_system', value])]);
  assert.deepEqual(result.denominator, { completeness: 'complete_for_enumerated_references', N_enumerated: 8, knownReferenceRows: 8, unresolvedOccurrences: 0, distinctObservedHashes: 11, fraction: null });
  assert.equal(result.occurrences.length, 37); assert.deepEqual(result.unresolvedOccurrences, []);
  const ordinaryA = result.occurrences.filter(item => item.sourceId === 'provider:A:block');
  assert.deepEqual(ordinaryA.map(item => [item.hash, item.listOrdinal, item.reportedTransactionIndex]), ORDINARY.map((value, index) => [value, index, String(index + 3)]));
  const blockB = result.occurrences.filter(item => item.sourceId === 'provider:B:block');
  assert.deepEqual(blockB.map(item => [item.hash, item.listOrdinal, item.reportedTransactionIndex]), [...PROVIDER_SYSTEM, ...ORDINARY].map((value, index) => [value, index, String(index)]));
  for (const [index, action] of result.referenceActions.filter(item => item.kind === 'hypercore_system').entries()) {
    assert.equal(action.referenceHash, OFFICIAL_SYSTEM[index]); assert.equal(action.representations.length, 4, 'Official reference, B list and two actual lookups are retained');
    assert.ok(action.mappingEvidence.every(item => item.basis === 'diagnosed_system_12_field_correspondence'));
    for (const evidence of action.mappingEvidence) {
      assert.deepEqual(evidence.matchedFields, SYSTEM_IDENTITY_FIELDS); assert.deepEqual(Object.keys(evidence.representationDifferences), ['hash', 'r', 's', 'v']);
      assert.equal(evidence.representationDifferences.hash.observed, PROVIDER_SYSTEM[index]); assert.equal(evidence.cryptographicEquivalence, 'not_assessed');
    }
  }
  assert.ok(result.referenceActions.filter(item => item.kind === 'ordinary').every(item => item.referenceEnvelope === null));
  noReplayInference(result);
});

test('later genuine eight/eight responses are separate per-response views, never a permanent endpoint profile', () => {
  const earlier = normalizeBlockViews(fixture()), later = normalizeBlockViews(fixture(true));
  assert.deepEqual(later.views.map(view => view.classification), ['system_inclusive', 'system_inclusive']);
  assert.equal(later.occurrences.length, 40); assert.equal(later.denominator.N_enumerated, 8); assert.equal(later.denominator.distinctObservedHashes, 11);
  assert.equal(earlier.views[0].classification, 'ordinary_only');
  assert.notEqual(earlier.views[0].provenance.captureSha256, later.views[0].provenance.captureSha256);
  assert.deepEqual(earlier.sources.providers[0].block.result.transactions, ORDINARY);
  assert.deepEqual(later.sources.providers[0].block.result.transactions, [...PROVIDER_SYSTEM, ...ORDINARY]);
  noReplayInference(later);
});

test('ambiguous twelve-field system matches retain both reference rows and withhold a combined denominator', () => {
  const input = fixture(), extra = structuredClone(input.official.system.result[0]); extra.hash = '0x' + 'fe'.repeat(32);
  input.official.system.result.push(extra);
  const result = normalizeBlockViews(input);
  assert.equal(result.referenceActions.length, 9); assert.equal(result.denominator.N_enumerated, null); assert.equal(result.identityMapping.status, 'conflicting');
  const observed = result.occurrences.find(item => item.sourceId === 'provider:B:block' && item.hash === PROVIDER_SYSTEM[0]);
  assert.equal(observed.mapping.status, 'unresolved'); assert.equal(observed.mapping.candidates.length, 2); assert.match(observed.mapping.reason, /ambiguous/);
  assert.ok(result.issues.some(issue => issue.code === 'ambiguous_system_action_fields')); noReplayInference(result);
});

test('changed, missing, unfamiliar and unbound system envelope evidence is never an alias wildcard', () => {
  const mutations = [
    tx => { tx.nonce = '0x999'; }, tx => { tx.input += '00'; }, tx => { tx.gas = '0x1'; }, tx => { tx.from = '0x' + '11'.repeat(20); },
    tx => { tx.to = '0x' + '22'.repeat(20); }, tx => { tx.transactionIndex = '0x3'; }, tx => { tx.blockNumber = '0x1'; },
    tx => { tx.blockHash = '0x' + '33'.repeat(32); }, tx => { delete tx.nonce; }, tx => { tx.r = '0x2'; }, tx => { tx.s = '0x0'; }, tx => { tx.v = '0x7f3'; },
    tx => { tx.authorizationList = []; }, tx => { tx.accessList = []; }, tx => { tx.newSemanticField = '0x0'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = fixture(); mutate(input.providers[1].transactions[0].result);
    const result = normalizeBlockViews(input), observed = result.occurrences.find(item => item.sourceId === 'provider:B:lookup' && item.id.endsWith(':0'));
    assert.equal(observed.mapping.status, 'unresolved', 'mutation ' + index); assert.equal(result.denominator.N_enumerated, null);
    assert.deepEqual(result.sources.providers[1].transactions[0].result, input.providers[1].transactions[0].result);
  }
});

test('ordinary hash/envelope conflicts, duplicate occurrences, overlap and reordering are preserved, not trimmed', () => {
  const mutations = [
    input => { input.providers[1].transactions[3].result.gas = '0x1'; },
    input => { input.providers[1].block.result.transactions.push(ORDINARY[0]); },
    input => { input.providers[0].transactions.push(structuredClone(input.providers[0].transactions[3])); },
    input => { input.official.ordinary.result.transactions.push(OFFICIAL_SYSTEM[0]); },
    input => { input.providers[0].block.result.transactions.reverse(); },
    input => { input.providers[1].block.result.transactions.splice(0, 2, PROVIDER_SYSTEM[1], PROVIDER_SYSTEM[0]); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = fixture(); mutate(input); const result = normalizeBlockViews(input);
    assert.equal(result.identityMapping.status, 'conflicting', 'mutation ' + index); assert.equal(result.denominator.N_enumerated, null);
    assert.equal(result.occurrences.filter(item => item.sourceId === 'provider:B:block').length, input.providers[1].block.result.transactions.length);
    assert.deepEqual(result.sources, input);
  }
});

test('unknown extra actions and missing envelopes remain visible without claiming an all-action fraction', () => {
  const input = fixture(), unknown = structuredClone(input.providers[1].transactions[3]);
  unknown.result.hash = '0x' + 'ab'.repeat(32); unknown.request.id = 999; unknown.request.params[0] = unknown.result.hash;
  input.providers[1].block.result.transactions.push(unknown.result.hash); input.providers[1].transactions.push(unknown);
  const result = normalizeBlockViews(input);
  assert.equal(result.referenceActions.length, 8); assert.equal(result.denominator.N_enumerated, null); assert.equal(result.denominator.completeness, 'inconclusive');
  assert.equal(result.occurrences.filter(item => item.hash === unknown.result.hash).length, 2);
  assert.equal(result.unresolvedOccurrences.length, 2); assert.equal(result.denominator.distinctObservedHashes, 12);
  const missing = fixture(); missing.providers[0].transactions.splice(3, 1);
  const incomplete = normalizeBlockViews(missing);
  assert.equal(incomplete.denominator.N_enumerated, null); assert.ok(incomplete.occurrences.some(item => item.hash === ORDINARY[0] && item.mapping.reason === 'required_bound_envelope_unavailable'));
});

test('unavailable official system enumeration differs from a successfully observed empty list', () => {
  const unavailable = fixture(); unavailable.official.system = { ...unavailable.official.system, status: 'unavailable', reason: 'method_unsupported' }; delete unavailable.official.system.result;
  const missing = normalizeBlockViews(unavailable);
  assert.equal(missing.enumeration.status, 'unavailable'); assert.equal(missing.referenceActions.length, 5); assert.equal(missing.denominator.N_enumerated, null);
  assert.equal(missing.unresolvedOccurrences.length, 9, 'B system list plus both providers\' system lookups stay unresolved');
  const empty = fixture(); empty.official.system.result = [];
  for (const provider of empty.providers) { provider.block.result.transactions = [...ORDINARY]; provider.transactions = provider.transactions.slice(3); }
  const unboundEmpty = normalizeBlockViews(empty);
  assert.equal(unboundEmpty.enumeration.status, 'unavailable'); assert.equal(unboundEmpty.denominator.N_enumerated, null);
  assert.equal(unboundEmpty.identityMapping.status, 'partial');
  // Synthetic positive control: the genuine saved number-only response was not empty.
  empty.official.system.request.method = 'eth_getSystemTxsByBlockHash'; empty.official.system.request.params = [BLOCK_HASH];
  const observed = normalizeBlockViews(empty);
  assert.equal(observed.enumeration.status, 'complete'); assert.equal(observed.enumeration.systemReferences, 0); assert.equal(observed.denominator.N_enumerated, 5);
  assert.equal(observed.identityMapping.status, 'complete'); noReplayInference(observed);
});

test('different system counts and interleaved lists never imply arithmetic execution boundaries', () => {
  const input = fixture(); input.official.system.result = input.official.system.result.slice(0, 2);
  for (const provider of input.providers) {
    provider.transactions.splice(2, 1);
    provider.block.result.transactions = [ORDINARY[0], PROVIDER_SYSTEM[0], ...ORDINARY.slice(1, 3), PROVIDER_SYSTEM[1], ...ORDINARY.slice(3)];
  }
  const result = normalizeBlockViews(input);
  assert.equal(result.denominator.N_enumerated, 7); assert.deepEqual(result.views.map(view => view.classification), ['system_inclusive', 'system_inclusive']);
  assert.deepEqual(result.occurrences.filter(item => item.sourceId === 'provider:A:block').map(item => [item.listOrdinal, item.reportedTransactionIndex]), [[0,'3'],[1,'0'],[2,'4'],[3,'5'],[4,'1'],[5,'6'],[6,'7']]);
  noReplayInference(result);
});

test('unknown system targets are retained as unassessed actions, independent of execution outcomes', () => {
  const input = fixture(), unknownTarget = '0x' + 'aa'.repeat(20);
  input.official.system.result[0].to = unknownTarget;
  for (const provider of input.providers) provider.transactions[0].result.to = unknownTarget;
  const result = normalizeBlockViews(input), action = result.referenceActions.find(item => item.referenceHash === OFFICIAL_SYSTEM[0]);
  assert.equal(result.denominator.N_enumerated, 8); assert.equal(action.referenceEnvelope.to, unknownTarget); assert.equal(action.execution, 'not_assessed');
  assert.equal(Object.hasOwn(result, 'accuracy'), false); noReplayInference(result);
});

test('untrusted provenance, inline malformed envelopes and conflicting block fields cannot produce complete mapping', () => {
  for (const mutate of [
    input => { delete input.official.system.provenance.responseSha256; },
    input => { input.official.system.provenance.captureSha256 = [input.official.system.provenance.captureSha256]; },
    input => { input.official.system.provenance.responseSha256 = [input.official.system.provenance.responseSha256]; },
    input => { input.providers[0].block.request.params[0] = 'latest'; },
    input => { input.providers[1].block.result.timestamp = '0x1'; },
    input => { input.providers[0].block.result.transactions[0] = { ...input.providers[0].transactions[3].result, unexpectedField: true }; },
    input => { input.providers[0].transactions[3].request.params[0] = ORDINARY[1]; },
  ]) {
    const input = fixture(); mutate(input); const result = normalizeBlockViews(input);
    assert.equal(result.denominator.N_enumerated, null); assert.notEqual(result.identityMapping.status, 'complete'); assert.deepEqual(result.sources, input);
  }
});

test('bounded pure API rejects excessive or non-JSON input without returning a truncated population', () => {
  const oversized = fixture(); oversized.providers[0].block.result.transactions = Array(BLOCK_VIEW_LIMITS.maxListEntries + 1).fill(ORDINARY[0]);
  assert.throws(() => normalizeBlockViews(oversized), RangeError);
  const sparse = fixture(); sparse.official.system.result = Array(2); assert.throws(() => normalizeBlockViews(sparse), TypeError);
  let invoked = false; const accessor = fixture(); Object.defineProperty(accessor.block, 'number', { enumerable: true, get() { invoked = true; return '49544166'; } });
  assert.throws(() => normalizeBlockViews(accessor), TypeError); assert.equal(invoked, false);
  const alien = fixture(); alien.block.chainId = 1; assert.throws(() => normalizeBlockViews(alien), /HyperEVM/);
});
