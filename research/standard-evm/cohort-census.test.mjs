import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateCohortCensus, CohortCensusError, CENSUS_LIMITS } from './cohort-census.mjs';
import { createCohortSelection } from './cohort-accounting.mjs';
const require = createRequire(new URL('../../engines/local-evm/package.json', import.meta.url));
const { RLP } = await import(require.resolve('@ethereumjs/rlp'));
const { keccak_256 } = await import(require.resolve('@noble/hashes/sha3.js'));

// The saved header is a convenient fork-complete template, NOT the source of
// real transaction bodies for these synthetic provider-control fixtures.
const source = readFileSync(new URL('../../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const template = JSON.parse(source).selectedHeader;
const H = BigInt(template.number), q = n => '0x' + BigInt(n).toString(16), word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const clone = structuredClone;
const EMPTY_TRIE = '0x' + Buffer.from(keccak_256(RLP.encode(new Uint8Array()))).toString('hex');
const ORDER = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const INTEGER = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
function signHeader(h) {
  const values = ORDER.map(k => { let s = h[k].slice(2); if (INTEGER.has(k)) { s = BigInt(h[k]) === 0n ? '' : BigInt(h[k]).toString(16); if (s.length % 2) s = '0' + s; } return Buffer.from(s, 'hex'); });
  h.hash = '0x' + Buffer.from(keccak_256(RLP.encode(values))).toString('hex'); return h;
}
function tx(id, changes = {}) {
  return { hash: word(id), from: addr(1), to: addr(2), input: '0x', value: '0x0', gas: '0x5208', nonce: q(id), blockHash: word(0), blockNumber: '0x0', transactionIndex: '0x0', type: '0x2', chainId: '0x1', maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x2', gasPrice: '0x3', accessList: [], v: '0x0', r: '0x1', s: '0x2', ...changes };
}
function bodyFixture(bodies = [[tx(1), tx(2)], [tx(3)]]) {
  const headers = [];
  for (let i = 0; i < 5; i++) {
    const transactions = i === 1 || i === 2 ? clone(bodies[i - 1]) : [];
    const h = signHeader({ ...clone(template), number: q(H + BigInt(i)), parentHash: i ? headers.at(-1).hash : word(999), timestamp: q(BigInt(template.timestamp) + BigInt(i * 12)), baseFeePerGas: '0x1', transactions, transactionsRoot: transactions.length ? word(900 + i) : EMPTY_TRIE, gasUsed: q(transactions.length * 21000), withdrawals: [], uncles: [], size: '0x1234', totalDifficulty: '0x0' });
    if (i === 1 || i === 2) h.transactions.forEach((t, index) => Object.assign(t, { blockHash: h.hash, blockNumber: h.number, transactionIndex: q(index) }));
    headers.push(h);
  }
  return {
    chainId: 1, anchor: { blockNumber: H.toString(), blockHash: headers[0].hash }, targetBlockNumbers: [(H + 1n).toString(), (H + 2n).toString()], anchorObservedAt: '2026-10-27T00:00:00.000Z', seed: word(7), sampleSize: 16,
    observations: [
      { provider: 'drpc', chainId: '0x1', finalizedObservedAt: '2026-10-27T00:20:00.000Z', finalizedBlockHash: headers[3].hash, headers: clone(headers.slice(0, 4)) },
      { provider: 'publicnode', chainId: '0x1', finalizedObservedAt: '2026-10-27T00:20:01.000Z', finalizedBlockHash: headers[4].hash, headers: clone(headers) },
    ],
  };
}
function both(input, fn) { input.observations.forEach(o => fn(o)); return input; }
function legacy(id = 10) { const t = tx(id, { type: '0x0', v: '0x25', gasPrice: '0x3' }); for (const k of ['maxFeePerGas', 'maxPriorityFeePerGas', 'accessList']) delete t[k]; return t; }
const expectBad = (input, message) => assert.throws(() => validateCohortCensus(input), message ?? CohortCensusError);

test('complete two-provider census validates every contiguous header and preserves exact source data', () => {
  const input = bodyFixture(), before = clone(input), out = validateCohortCensus(input);
  assert.deepEqual(input, before); assert.equal(out.census.length, 3); assert.equal(out.selected.length, 3);
  assert.deepEqual(out.providers.map(p => p.headerCount), [4, 5]);
  assert.deepEqual(out.providers[0].originalHeaders, input.observations[0].headers);
  assert.deepEqual(out.envelopes[0].providerEnvelopes[0].envelope, input.observations[0].headers[1].transactions[0]);
  assert.equal(out.trust.headerHashesRecomputed, true); assert.equal(out.trust.consensusFinalityVerified, false); assert.equal(out.trust.blockBodyTrieVerified, false); assert.equal(out.trust.transactionHashesRecomputed, false);
  assert.equal(out.selected[0].projection.status, 'projectable'); assert.equal(out.selected[0].projection.request.block, input.anchor.blockHash);
  assert.equal(out.selected[0].projection.originalPositionReplay, false); assert.equal(out.selected[0].projection.prerequisites.senderCode, 'not_checked');
  assert.ok(Object.isFrozen(out.envelopes[0].providerEnvelopes[0].envelope)); assert.match(out.censusId, /^[a-f0-9]{64}$/);
});

test('selected second-block parent header is primary source shape with only object→hash transaction transformation', () => {
  const input = bodyFixture(); input.observations[0].headers[1].transactions[0].hash = input.observations[0].headers[1].transactions[0].hash.toUpperCase().replace('0X', '0x');
  const out = validateCohortCensus(input), row = out.selected.find(r => r.blockNumber === (H + 2n).toString()), parent = input.observations[0].headers[1];
  assert.deepEqual(row.parentHeader, { ...parent, transactions: parent.transactions.map(t => t.hash) });
  assert.equal(row.projection.request.block, parent.hash); assert.equal(row.projection.request.value, '0');
});

test('declared optional provider normalizations preserve originals and reject contradictory helpers', () => {
  const input = bodyFixture([[legacy(), tx(2)], [tx(3)]]), b = input.observations[1];
  delete b.headers[1].transactions[0].type; delete b.headers[1].transactions[0].chainId;
  b.headers[1].transactions[0].r = word(1); b.headers[1].transactions[0].yParity = '0x0';
  for (const h of b.headers) { delete h.size; delete h.totalDifficulty; delete h.withdrawals; delete h.uncles; }
  for (const h of b.headers.slice(1, 3)) for (const t of h.transactions) if (t.type === '0x2') { t.yParity = t.v; delete t.v; delete t.gasPrice; }
  const out = validateCohortCensus(input); assert.equal(out.census.length, 3); assert.equal(out.envelopes[0].normalizedEnvelope.chainId, '1');
  b.headers[2].transactions[0].gasPrice = '0x4'; expectBad(input, /effective gasPrice/);
});

test('creation, access-list, blob, authorization, high-gas, large-input and unknown types stay in census and sample', () => {
  const one = tx(2, { type: '0x1', gasPrice: '0x3' }); delete one.maxFeePerGas; delete one.maxPriorityFeePerGas;
  const cases = [tx(1, { to: null }), one, tx(3, { type: '0x3', maxFeePerBlobGas: '0x4', blobVersionedHashes: [word(100)] }), tx(4, { type: '0x4', authorizationList: [{ chainId: '0x0', address: addr(4), nonce: '0x0', yParity: '0x1', r: '0x1', s: '0x2' }] }), tx(5, { gas: q(5_000_001) }), tx(6, { input: '0x' + '01'.repeat(32 * 1024 + 1) }), tx(7, { type: '0x7e', futureContext: { id: 'unchanged' } }), tx(8, { accessList: [{ address: addr(9), storageKeys: [word(1)] }] })];
  const out = validateCohortCensus(bodyFixture([cases, []]));
  assert.equal(out.census.length, 8); assert.equal(out.selected.length, 8); assert.equal(out.selected.filter(r => r.projection.status === 'unsupported').length, 8);
  assert.deepEqual(out.selected.map(r => r.projection.reasons[0]), ['contract_creation', 'access_list_context_unsupported', 'blob_context_unsupported', 'authorization_context_unsupported', 'original_gas_limit_exceeds_profile', 'calldata_exceeds_profile', 'unknown_transaction_type', 'access_list_context_unsupported']);
  assert.ok(out.selected.every(r => !Object.hasOwn(r.projection, 'request')));
  assert.equal(out.envelopes[6].providerEnvelopes[0].envelope.futureContext.id, 'unchanged');
});

test('optional mined blockTimestamp is header-bound, retained raw and normalized across provider omission', () => {
  const input = bodyFixture([[legacy(), tx(2)], [tx(3)]]);
  for (const h of input.observations[0].headers.slice(1, 3)) for (const t of h.transactions) t.blockTimestamp = h.timestamp;
  input.observations[1].headers[1].transactions[1].blockTimestamp = input.observations[1].headers[1].timestamp.toUpperCase().replace('0X', '0x');
  const before = clone(input), out = validateCohortCensus(input);
  assert.deepEqual(input, before);
  assert.ok(out.selected.every(r => r.projection.status === 'projectable'));
  for (const e of out.envelopes) {
    assert.deepEqual(e.normalizedEnvelope.extensions, {});
    assert.equal(Object.hasOwn(e.normalizedEnvelope, 'blockTimestamp'), false);
    assert.equal(e.providerEnvelopes[0].envelope.blockTimestamp, input.observations[0].headers.find(h => h.hash === e.blockHash).timestamp);
  }
  both(input, o => { o.headers[1].transactions[0].futureTimestamp = o.headers[1].timestamp; });
  const changed = validateCohortCensus(input);
  assert.deepEqual(changed.selected[0].projection.reasons, ['unrecognized_envelope_fields']);
  assert.equal(changed.envelopes[0].normalizedEnvelope.extensions.futureTimestamp, input.observations[0].headers[1].timestamp);
});

test('blockTimestamp contradictions and malformed quantities reject even when both providers agree', () => {
  for (const value of [null, 0, '0x00', '0x', '0x10000000000000000', '-1', '0x1']) {
    const input = bodyFixture(); both(input, o => { o.headers[1].transactions[0].blockTimestamp = value; });
    expectBad(input, /blockTimestamp/);
  }
  const input = bodyFixture();
  both(input, o => { o.headers[1].transactions[0].blockTimestamp = o.headers[1].timestamp; });
  input.observations[1].headers[1].transactions[0].blockTimestamp = input.observations[1].headers[2].timestamp;
  expectBad(input, /blockTimestamp disagrees/);
});

test('selection ranks the full census before unsupported projection and never replaces selected slots', () => {
  const input = bodyFixture([Array.from({ length: 12 }, (_, i) => tx(i + 1, { to: i % 2 ? addr(2) : null })), Array.from({ length: 12 }, (_, i) => tx(i + 13))]);
  const out = validateCohortCensus(input), expected = createCohortSelection({ chainId: 1, census: out.census, seed: input.seed, sampleSize: 16 });
  assert.equal(out.census.length, 24); assert.equal(out.selected.length, 16); assert.deepEqual(out.selection, expected);
  assert.deepEqual(out.selected.map(x => x.transactionHash), expected.rows.filter(x => x.selected).map(x => x.transactionHash));
  assert.ok(out.selected.some(x => x.projection.status === 'unsupported'));
});

test('empty complete-looking bodies produce a zero-size sample without an accuracy claim', () => {
  const out = validateCohortCensus(bodyFixture([[], []])); assert.equal(out.selection.sampleSize, 0); assert.equal(out.selected.length, 0); assert.equal(out.trust.censusCompletenessCryptographicallyEstablished, false);
});

test('even matching provider bodies cannot contradict empty transaction-trie commitments', () => {
  const omitted = bodyFixture(); both(omitted, o => { o.headers[1].transactions = []; }); expectBad(omitted, /emptiness contradicts/);
  const invented = bodyFixture([[], []]); both(invented, o => { const h = o.headers[1]; h.transactions = [tx(5, { blockHash: h.hash, blockNumber: h.number, transactionIndex: '0x0' })]; }); expectBad(invented, /emptiness contradicts/);
});

test('header commitment tampering anywhere through the finalized tip fails admission', () => {
  for (const index of [0, 1, 2, 3]) for (const key of ['stateRoot', 'transactionsRoot', 'parentHash']) {
    const input = bodyFixture(); input.observations[0].headers[index][key] = word(99); expectBad(input, /hash\/shape/);
  }
});

test('validly rehashed fork, missing ancestry, wrong finality anchor and target substitutions fail', () => {
  const mutations = [
    i => { const h = i.observations[1].headers[3]; h.stateRoot = word(99); signHeader(h); i.observations[1].headers[4].parentHash = h.hash; signHeader(i.observations[1].headers[4]); i.observations[1].finalizedBlockHash = i.observations[1].headers[4].hash; },
    i => i.observations[0].headers.splice(1, 1),
    i => { i.observations[0].finalizedBlockHash = i.observations[0].headers[2].hash; },
    i => { i.observations[0].headers = i.observations[0].headers.slice(0, 2); },
    i => { i.targetBlockNumbers[1] = (H + 3n).toString(); },
    i => { i.anchor.blockHash = word(99); },
    i => { i.observations[0].headers[2].timestamp = i.observations[0].headers[1].timestamp; signHeader(i.observations[0].headers[2]); },
  ];
  for (const mutate of mutations) { const input = bodyFixture(); mutate(input); expectBad(input); }
});

test('chain, timing, provider identity and declared bounds fail closed without alternatives', () => {
  const mutations = [
    i => { i.chainId = 999; }, i => { i.observations[1].chainId = '0xa'; }, i => { i.observations[1].provider = 'drpc'; },
    i => { i.observations[0].finalizedObservedAt = '2026-10-27T00:19:59.999Z'; },
    i => { i.anchorObservedAt = '2026-02-30T00:00:00.000Z'; },
    i => { i.observations[0].headers = Array(257).fill(i.observations[0].headers[0]); },
    i => { i.sampleSize = 17; }, i => { i.seed = '0x01'; }, i => { i.targetBlockNumbers[0] = '01'; },
  ];
  for (const mutate of mutations) { const input = bodyFixture(); mutate(input); expectBad(input); }
  assert.equal(CENSUS_LIMITS.headersPerProvider, 256);
});

test('body and envelope disagreement, duplicate hashes and index gaps fail entire census', () => {
  const mutations = [
    i => i.observations[1].headers[1].transactions.reverse(),
    i => i.observations[1].headers[1].transactions.pop(),
    i => { i.observations[1].headers[1].transactions[0].value = '0x1'; },
    i => both(i, o => { o.headers[1].transactions[1].transactionIndex = '0x2'; }),
    i => both(i, o => { o.headers[1].transactions[1].hash = o.headers[1].transactions[0].hash; }),
    i => both(i, o => { o.headers[2].transactions[0].hash = o.headers[1].transactions[0].hash; }),
    i => { i.observations[1].headers[3].transactions = [word(999)]; },
    i => both(i, o => { o.headers[2].transactions[0].blockHash = word(12); }),
  ];
  for (const mutate of mutations) { const input = bodyFixture(); mutate(input); expectBad(input); }
});

test('missing required envelope data and noncanonical quantities are never projected with defaults', () => {
  for (const key of ['from', 'to', 'input', 'value', 'nonce', 'gas', 'r', 's', 'blockHash', 'blockNumber', 'transactionIndex', 'accessList', 'maxFeePerGas', 'chainId']) {
    const input = bodyFixture(); both(input, o => { delete o.headers[1].transactions[0][key]; }); expectBad(input);
  }
  for (const [key, value] of [['value', '0x00'], ['gas', '21000'], ['nonce', '-1'], ['type', '0x100'], ['input', '0x1'], ['to', word(1)], ['chainId', '0x2'], ['v', '0x1']]) {
    const input = bodyFixture(); both(input, o => { o.headers[1].transactions[0][key] = value; if (key === 'v') o.headers[1].transactions[0].yParity = '0x0'; }); expectBad(input);
  }
});

test('known typed field inconsistencies and malformed helper fields are rejected', () => {
  const mutations = [
    t => { t.authorizationList = []; }, t => { t.blobVersionedHashes = []; }, t => { t.maxPriorityFeePerGas = '0x65'; },
    t => { t.accessList = [{ address: addr(2), storageKeys: ['0x01'] }]; },
    t => { t.type = '0x3'; t.maxFeePerBlobGas = '0x1'; t.blobVersionedHashes = []; },
    t => { t.type = '0x4'; t.authorizationList = []; },
  ];
  for (const mutate of mutations) { const input = bodyFixture(); both(input, o => mutate(o.headers[1].transactions[0])); expectBad(input); }
  for (const change of [{ size: '0x01' }, { withdrawals: [{ address: addr(1) }] }, { uncles: [word(1)] }]) { const input = bodyFixture(); Object.assign(input.observations[0].headers[0], change); expectBad(input); }
});

test('unprotected legacy signatures are preserved but never asserted chain-protected or verified', () => {
  const t = legacy(); t.v = '0x1b'; delete t.chainId;
  const out = validateCohortCensus(bodyFixture([[t], []])); assert.equal(out.envelopes[0].normalizedEnvelope.chainId, null); assert.equal(out.selected[0].projection.status, 'projectable');
  const wrong = legacy(); wrong.v = '0x27'; expectBad(bodyFixture([[wrong], []]), /unsupported chain/);
});

test('JSON evidence cannot execute accessors, hide sparse items, contain cycles or mutate output aliases', () => {
  const accessor = bodyFixture(); Object.defineProperty(accessor.observations[0].headers[1].transactions[0], 'value', { enumerable: true, get() { throw Error('executed'); } }); expectBad(accessor, /unsupported property/);
  const sparse = bodyFixture(); delete sparse.observations[0].headers[1].transactions[0]; expectBad(sparse, /dense/);
  const cycle = bodyFixture(); cycle.extra = cycle; expectBad(cycle, /cycles/);
  const large = bodyFixture(); large.observations[0].headers[1].transactions[0].input = 'a'.repeat(CENSUS_LIMITS.fieldBytes + 1); expectBad(large, /string exceeds/);
  const input = bodyFixture(), result = validateCohortCensus(input); input.observations[0].headers[1].transactions[0].value = '0x2'; assert.equal(result.envelopes[0].providerEnvelopes[0].envelope.value, '0x0');
});
