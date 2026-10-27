import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectProspectiveCensus, COLLECTOR_LIMITS } from './cohort-collector.mjs';
import { createCohortTransport, createCohortWireBudget } from './cohort-wire.mjs';
const require = createRequire(new URL('../../engines/local-evm/package.json', import.meta.url));
const { RLP } = await import(require.resolve('@ethereumjs/rlp'));
const { keccak_256 } = await import(require.resolve('@noble/hashes/sha3.js'));
const source = readFileSync(new URL('../../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const template = JSON.parse(source).selectedHeader;
const H = BigInt(template.number), q = n => '0x' + BigInt(n).toString(16), word = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const EMPTY = '0x' + Buffer.from(keccak_256(RLP.encode(new Uint8Array()))).toString('hex');
const ORDER = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const INTEGER = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
function sign(h) {
  const bytes = ORDER.map(k => { let s = h[k].slice(2); if (INTEGER.has(k)) { s = BigInt(h[k]) === 0n ? '' : BigInt(h[k]).toString(16); if (s.length % 2) s = '0' + s; } return Buffer.from(s, 'hex'); });
  h.hash = '0x' + Buffer.from(keccak_256(RLP.encode(bytes))).toString('hex'); return h;
}
// Synthetic bodies and chain transitions: the genuine saved header only supplies
// a fork-complete shape. These fixtures are not observed Ethereum transactions.
function chain(count = 5) {
  const headers = [];
  for (let i = 0; i < count; i++) {
    const transactions = [1, 2].includes(i) ? [{ hash: word(i), from: addr(1), to: addr(2), input: '0x', value: '0x0', gas: '0x5208', nonce: q(i), blockHash: word(0), blockNumber: q(H + BigInt(i)), transactionIndex: '0x0', type: '0x2', chainId: '0x1', maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x2', accessList: [], v: '0x0', r: '0x1', s: '0x2' }] : [];
    const h = sign({ ...structuredClone(template), number: q(H + BigInt(i)), parentHash: i ? headers.at(-1).hash : word(999), timestamp: q(BigInt(template.timestamp) + BigInt(i * 12)), baseFeePerGas: '0x1', gasUsed: q(transactions.length * 21000), transactionsRoot: transactions.length ? word(900 + i) : EMPTY, transactions, withdrawals: [], uncles: [] });
    transactions.forEach(t => { t.blockHash = h.hash; }); headers.push(h);
  }
  return headers;
}
const falseHeader = h => ({ ...structuredClone(h), transactions: h.transactions.map(t => typeof t === 'string' ? t : t.hash) });
function harness({ counts = [4, 5], onCall, save, waitUntil } = {}) {
  const headers = chain(Math.max(...counts, 3)), calls = [], stages = [], waits = [];
  let time = Date.parse('2026-10-27T00:00:00.000Z');
  const state = { headers, calls, stages, waits, get time() { return time; }, set time(v) { time = v; } };
  const result = (provider, method, params) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') return falseHeader(headers[0]);
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') return falseHeader(headers[counts[provider === 'drpc' ? 0 : 1] - 1]);
    if (method === 'eth_getBlockByHash') { const h = headers.find(h => h.hash === params[0]); assert(h, 'Unplanned hash'); return params[1] ? structuredClone(h) : falseHeader(h); }
    throw Error('Unplanned method');
  };
  state.respond = result;
  state.options = {
    transports: Object.fromEntries(['drpc', 'publicnode'].map(provider => [provider, { provider, profile: 'census', async call(method, params, { signal }) {
      assert(!signal?.aborted); const call = { provider, method, params: structuredClone(params), at: time }; calls.push(call);
      const changed = onCall?.(call, state); return changed === undefined ? result(provider, method, params) : changed;
    } }])),
    seed: word(77), sampleSize: 16, now: () => time,
    save(event) { stages.push(structuredClone(event)); save?.(event, state); },
    async waitUntil(deadline, options) { waits.push({ before: time, deadline }); if (waitUntil) await waitUntil(deadline, options, state); else time = deadline; },
  };
  return state;
}

test('anchor declaration is saved before waiting or any target read; result retains exact source data', async () => {
  const h = harness({ save(event, state) { if (event.kind === 'anchor_declared') assert.equal(state.calls.length, 2); }, waitUntil(deadline, _options, state) { assert(state.stages.some(s => s.kind === 'anchor_declared')); assert.equal(state.calls.length, 2); state.time = deadline; } });
  const r = await collectProspectiveCensus(h.options);
  assert.equal(r.status, 'complete'); assert.equal(r.census.census.length, 2); assert.equal(r.census.selected.length, 2);
  assert.equal(h.waits.length, 20); assert.ok(h.waits.every(w => w.deadline - w.before <= 60_000));
  const declared = r.artifacts.anchorDeclaration;
  assert.deepEqual(declared.latestHeader, falseHeader(h.headers[0])); assert.equal(declared.verifiedHeader.blockHash, declared.anchor.blockHash);
  assert.deepEqual(declared.targetBlockNumbers, [(H + 1n).toString(), (H + 2n).toString()]);
  assert(h.calls.filter(c => c.method === 'eth_getBlockByHash').every(c => c.at >= Date.parse(declared.waitDeadline)));
  assert.equal(h.calls.filter(c => c.params[0] === 'latest').length, 1);
  for (const provider of ['drpc', 'publicnode']) {
    assert.equal(h.calls.filter(c => c.provider === provider && c.params[0] === 'finalized').length, 1);
    assert.equal(h.calls.filter(c => c.provider === provider && c.method === 'eth_chainId').length, 1);
  }
  assert.equal(h.calls.filter(c => c.method === 'eth_getBlockByHash' && c.params[1]).length, 4);
  assert.equal(h.calls.filter(c => c.provider === 'drpc' && c.method === 'eth_getBlockByHash' && c.params[0] === h.headers[0].hash).length, 0);
  assert.equal(h.calls.filter(c => c.provider === 'publicnode' && c.method === 'eth_getBlockByHash' && c.params[0] === h.headers[0].hash).length, 1);
  assert.equal(r.artifacts.parsedResultsOnly, true); assert.equal(r.artifacts.saveStatus, 'saved'); assert.equal(r.artifacts.failure, null);
  assert.ok(Object.isFrozen(r.artifacts.anchorDeclaration.latestHeader));
});

test('fixed finalized target gets one full-body view and exactly the same committed header', async () => {
  const h = harness({ counts: [3, 3] }), r = await collectProspectiveCensus(h.options);
  assert.equal(r.status, 'complete'); assert.equal(h.calls.length, 10);
  for (const provider of ['drpc', 'publicnode']) assert.equal(h.calls.filter(c => c.provider === provider && c.method === 'eth_getBlockByHash' && c.params[0] === h.headers[2].hash && c.params[1] === true).length, 1);
  const bad = harness({ counts: [3, 3], onCall(call, state) { if (call.method === 'eth_getBlockByHash' && call.params[0] === state.headers[2].hash) { const header = structuredClone(state.headers[2]); header.stateRoot = word(19); return sign(header); } } });
  const failed = await collectProspectiveCensus(bad.options); assert.equal(failed.status, 'selection_failed'); assert.equal(failed.artifacts.failure.code, 'collector_header_invalid');
});

test('exact maximum is 514 calls: 2 chains + latest + 2 tips +512 headers minus primary H and2 reusable tips', async () => {
  const h = harness({ counts: [256, 256] }), r = await collectProspectiveCensus(h.options);
  assert.equal(r.status, 'complete'); assert.equal(h.calls.length, 2 + 1 + 2 + 512 - 1 - 2); assert.equal(h.calls.length, COLLECTOR_LIMITS.calls);
  assert.equal(r.artifacts.observations[0].headers.length, 256); assert.equal(r.artifacts.observations[1].headers.length, 256);
});

test('late finality or ancestry cap rejects after both fixed tips and before target bodies', async () => {
  for (const [counts, code] of [[[2, 5], 'collector_finality_below_targets'], [[257, 5], 'collector_ancestry_cap']]) {
    const h = harness({ counts }), r = await collectProspectiveCensus(h.options);
    assert.equal(r.status, 'selection_failed'); assert.equal(r.artifacts.failure.code, code); assert.equal(r.artifacts.finalizedObservations.length, 2);
    assert.equal(h.calls.length, 5); assert.equal(h.calls.filter(c => c.method === 'eth_getBlockByHash').length, 0);
  }
});

test('a failed target read is retained once with no replacement, retry or later branch traversal', async () => {
  const h = harness({ onCall(call) { if (call.method === 'eth_getBlockByHash' && call.params[1]) throw Object.assign(Error('private transport message'), { code: 'rpc_error' }); } });
  const r = await collectProspectiveCensus(h.options); assert.equal(r.status, 'selection_failed'); assert.equal(r.census, null);
  assert.equal(r.artifacts.attempts.at(-1).status, 'failed'); assert.equal(r.artifacts.attempts.at(-1).error, 'rpc_error');
  assert.equal(h.calls.filter(c => c.method === 'eth_getBlockByHash' && c.params[1]).length, 1); assert.equal(r.artifacts.attempts.length, h.calls.length);
  assert.doesNotMatch(JSON.stringify(r), /private transport message/);
});

test('aborted wait, unfinished wait and backwards clock never reach finality or body reads', async () => {
  const controller = new AbortController();
  const aborted = harness({ waitUntil(_deadline, _options, state) { controller.abort(); state.time += 1; } }); aborted.options.signal = controller.signal;
  const early = harness({ waitUntil() {} });
  const backwards = harness({ waitUntil(_deadline, _options, state) { state.time--; } });
  for (const [h, code] of [[aborted, 'collector_cancelled'], [early, 'collector_wait_incomplete'], [backwards, 'collector_clock_invalid']]) {
    const r = await collectProspectiveCensus(h.options); assert.equal(r.status, 'selection_failed'); assert.equal(r.artifacts.failure.code, code); assert.equal(h.calls.length, 2); assert(r.artifacts.anchorDeclaration);
  }
});

test('global cancellation interrupts an injected wait that ignores its signal and never resolves', async () => {
  const controller = new AbortController();
  const h = harness({ waitUntil() { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  h.options.signal = controller.signal;
  const r = await collectProspectiveCensus(h.options);
  assert.equal(r.status, 'selection_failed'); assert.equal(r.artifacts.failure.code, 'collector_cancelled'); assert.equal(h.calls.length, 2);
  assert.equal(h.stages.at(-1).kind, 'selection_failed');
});

test('save failure before anchor continuation latches; completed parsed results remain available', async () => {
  for (const kind of ['anchor_declared', 'wait_chunk_started', 'call_completed']) {
    const h = harness({ save(event) { if (event.kind === kind) throw Error('disk full'); } }), r = await collectProspectiveCensus(h.options);
    assert.equal(r.status, 'selection_failed'); assert.equal(r.artifacts.failure.code, 'collector_save_failed'); assert.equal(r.artifacts.saveStatus, 'failed');
    assert.equal(h.waits.length, 0); assert.equal(h.calls.length, kind === 'call_completed' ? 1 : 2);
    assert.equal(r.artifacts.attempts.at(-1).status, 'completed'); assert(r.artifacts.attempts.at(-1).result);
  }
  const planned = harness({ save(event) { if (event.kind === 'call_planned') throw Error('disk full'); } });
  const r = await collectProspectiveCensus(planned.options); assert.equal(planned.calls.length, 0); assert.equal(r.artifacts.attempts[0].transportInvoked, false);
  const asyncSave = harness(); asyncSave.options.save = async () => {};
  assert.equal((await collectProspectiveCensus(asyncSave.options)).artifacts.failure.code, 'collector_save_failed'); assert.equal(asyncSave.calls.length, 0);
});

test('bad chain, unsafe input descriptors and unsafe response descriptors fail without guessing', async () => {
  const wrong = harness({ onCall(call) { if (call.method === 'eth_chainId') return '0x2'; } });
  assert.equal((await collectProspectiveCensus(wrong.options)).artifacts.failure.code, 'collector_wrong_chain'); assert.equal(wrong.calls.length, 1);
  const input = harness(); Object.defineProperty(input.options, 'seed', { enumerable: true, get() { throw Error('should not run'); } });
  assert.equal((await collectProspectiveCensus(input.options)).status, 'selection_failed'); assert.equal(input.calls.length, 0);
  const response = harness({ onCall(call, state) { if (call.params[0] === 'latest') { const h = falseHeader(state.headers[0]); Object.defineProperty(h, 'stateRoot', { enumerable: true, get() { throw Error('should not run'); } }); return h; } } });
  assert.equal((await collectProspectiveCensus(response.options)).artifacts.failure.code, 'collector_result_shape'); assert.equal(response.calls.length, 2);
  const invalidSlots = harness(); invalidSlots.options.sampleSize = 15; assert.equal((await collectProspectiveCensus(invalidSlots.options)).status, 'selection_failed'); assert.equal(invalidSlots.calls.length, 0);
});

test('transport identities and call methods are captured before asynchronous continuation', async () => {
  const h = harness({ save(event, state) { if (event.kind === 'anchor_declared') { state.options.transports.drpc = { call() { throw Error('replacement'); } }; state.options.transports.publicnode.call = () => { throw Error('replacement'); }; } } });
  assert.equal((await collectProspectiveCensus(h.options)).status, 'complete');
  const wrong = harness(); wrong.options.transports.publicnode.provider = 'drpc'; assert.equal((await collectProspectiveCensus(wrong.options)).status, 'selection_failed'); assert.equal(wrong.calls.length, 0);
});

test('provider body disagreement is retained as selection_failed rather than a partial census', async () => {
  const h = harness({ onCall(call, state) { if (call.provider === 'publicnode' && call.params[1] === true) { const h = state.respond(call.provider, call.method, call.params); h.transactions[0].value = '0x1'; return h; } } });
  const r = await collectProspectiveCensus(h.options); assert.equal(r.status, 'selection_failed'); assert.equal(r.census, null); assert.equal(r.artifacts.observations.length, 2); assert.equal(r.artifacts.failure.code, 'COHORT_CENSUS_INVALID');
  assert.equal(r.artifacts.observations[1].headers[1].transactions[0].value, '0x1');
});

test('backwards traversal cannot silently replace the primary predeclared anchor branch', async () => {
  const h = harness({ onCall(call, state) { if (call.method === 'eth_getBlockByHash' && call.params[0] === state.headers[1].hash) { const h = structuredClone(state.headers[1]); h.parentHash = word(22); return sign(h); } } });
  const r = await collectProspectiveCensus(h.options); assert.equal(r.status, 'selection_failed'); assert.equal(r.artifacts.failure.code, 'collector_header_invalid');
  assert.equal(h.calls.filter(c => c.params[0] === 'latest').length, 1);
});

test('real census transports retain every exact synthetic wire while collector only uses parsed results', async () => {
  const h = harness({ counts: [3, 3] }), budget = createCohortWireBudget(), wires = [];
  h.options.transports = Object.fromEntries(['drpc', 'publicnode'].map(provider => [provider, createCohortTransport({ budget, provider, profile: 'census', save(wire) { wires.push(wire); }, async fetchImpl(_url, options) {
    const request = JSON.parse(options.body), result = h.respond(provider, request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  } })]));
  const r = await collectProspectiveCensus(h.options); assert.equal(r.status, 'complete'); assert.equal(wires.length, 10); assert.equal(r.artifacts.attempts.length, wires.length);
  for (let i = 0; i < wires.length; i++) { assert.equal(wires[i].request.method, r.artifacts.attempts[i].method); assert.deepEqual(wires[i].request.params, r.artifacts.attempts[i].params); assert.deepEqual(wires[i].parsed.result, r.artifacts.attempts[i].result); }
  assert.equal(budget.snapshot().calls, 10);
});
