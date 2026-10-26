import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createVerifiedCurrentStateContext } from '../src/current-state.js';
import { buildStateOverrides, StateValidationError } from '../src/state.js';
import { canonicalStateDiff } from '../src/state-diff.js';
import { USDC, HUSDC, VUSDC } from '../src/config.js';

const PROBE = '0x000000000000000000000000000000000000ba1a';
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const address = value => '0x' + BigInt(value).toString(16).padStart(40, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = await readFile(new URL('../reports/current-query-capability/capture.json', import.meta.url));
assert.equal(hash(raw), '3c11faec39109a330d91428d9ad359ee1601fc3820f5ae17b9971c61e7ddfae2');
const capture = JSON.parse(raw);
const plan = JSON.parse(await readFile(new URL('../reports/current-query-capability/plan.json', import.meta.url)));
const expected = {
  supply: [['344156193', '329090078'], ['3179075937', '3194142051'], ['115792089237316195423570985008687907853269984665640564039457584003202135963444', '115792089237316195423570985008687907853269984665640564039457584003202120897329']],
  borrow: [['569439069', '1404913479'], ['5677678780', '5677678780'], ['2', '835474412'], ['0', '0']],
};
const balanceQuery = (token, account) => ({ to: token, data: '0x70a08231' + account.slice(2).padStart(64, '0') });

// Recorded query/diff/witness responses are unchanged and matched by exact RPC
// parameters. The capability packet omitted a direct root eth_getCode request.
// This one preparation control is explicitly SYNTHETIC, returning the genuine
// original diff's root pre.code. These are not complete recorded production runs.
function setup({ provider = 'A', caseId = 'supply', mutateInput, transform, syntheticQueries = false, syntheticOverrides = false, now } = {}) {
  const item = structuredClone(plan.cases.find(item => item.id === caseId));
  const records = capture.records.filter(record => record.provider === provider && record.caseId === caseId);
  const original = records.find(record => record.label === 'original-trace').response.result;
  const originalDiff = records.find(record => record.label === 'original-diff').response.result;
  const input = { request: { chainId: 999, from: item.original.from, to: item.original.to, data: item.original.data, value: '0' }, block: { hash: item.header.hash, number: BigInt(item.header.number).toString(), timestamp: BigInt(item.header.timestamp).toString() }, trace: structuredClone(original) };
  mutateInput?.(input);
  const calls = [];
  const rpc = { async call(method, params) {
    let record = records.find(record => record.request.method === method && isDeepStrictEqual(record.request.params, params));
    let result, label, origin = 'recorded';
    if (!record && syntheticOverrides && method === 'debug_traceCall' && params[2]?.stateOverrides) {
      // Explicit override-forwarding fault controls use recorded return shapes,
      // not a claim those return values were measured under changed overrides.
      const lookup = structuredClone(params), baseline = buildStateOverrides(originalDiff);
      lookup[2].stateOverrides = params[0].to === PROBE ? { ...baseline, [PROBE]: params[2].stateOverrides[PROBE] } : baseline;
      record = records.find(record => record.request.method === method && isDeepStrictEqual(record.request.params, lookup));
      origin = 'synthetic_override_forwarding_control';
    }
    if (record) { result = structuredClone(record.response.result); label = record.label; }
    else if (method === 'eth_getCode' && params[0] === item.original.to && isDeepStrictEqual(params[1], item.pinned)) {
      result = originalDiff.pre[item.original.to].code; label = 'root-code'; origin = 'synthetic_preparation_control';
    } else if (syntheticQueries && method === 'debug_traceCall' && params[0].data.startsWith('0x70a08231')) {
      // Explicit synthetic resource controls: rewrite only the queried account
      // of a genuine USDC view. Never used in the recorded numerical tests.
      const stage = (params[2].stateOverrides ? 'after' : 'before') + '-' + (params[2].tracer === 'callTracer' ? 'trace' : 'diff');
      record = records.find(record => record.label === 'usdc-' + stage);
      result = structuredClone(record.response.result); label = 'synthetic-usdc-' + stage; origin = 'synthetic_query_control';
      if (params[2].tracer === 'callTracer') { result.input = params[0].data; result.calls[0].input = params[0].data; }
    } else {
      assert.fail('No exact recorded response or explicitly declared synthetic control for ' + method);
    }
    const call = { method, params: structuredClone(params), label, origin, result: structuredClone(result) }; calls.push(call);
    return transform ? transform(result, call, calls) : result;
  } };
  const context = createVerifiedCurrentStateContext({ ...input, rpc, ...(now ? { now } : {}) });
  return { context, input, rpc, item, records, calls, originalDiff, queries: item.queries.map(({ to, data }) => ({ to, data })) };
}

test('capability evidence remains immutable and each retained response binds its exact bytes and request', () => {
  assert.equal(capture.records.length, 126);
  for (const entry of capture.records) {
    assert.equal(entry.httpStatus, 200); assert.equal(entry.bodyComplete, true);
    assert.equal(hash(entry.responseRaw), entry.responseSha256);
    assert.equal(Buffer.byteLength(entry.responseRaw), entry.responseBytes);
    assert.deepEqual(JSON.parse(entry.responseRaw), entry.response);
    assert.equal(entry.request.id, entry.response.id);
  }
});

for (const provider of ['A', 'B']) for (const caseId of ['supply', 'borrow']) test(`recorded ${caseId} queries on ${provider}, with explicitly synthetic root-code preparation control`, async () => {
  const s = setup({ provider, caseId });
  assert.equal(s.calls.length, 0); assert.equal(s.context.executionIdentity, null);
  for (let i = 0; i < s.queries.length; i++) {
    const actual = await s.context.readPair(s.queries[i]), [before, after] = expected[caseId][i].map(BigInt);
    assert.deepEqual(actual, { before, after, delta: after - before });
  }
  await s.context.verifyCanonical();
  assert.equal(s.calls.length, 10 + 4 * s.queries.length);
  assert.deepEqual(s.calls.filter(call => call.origin !== 'recorded').map(call => call.label), ['root-code']);
  const identity = s.context.executionIdentity;
  assert.equal(identity.headerContext, 'synthetic_unpriced_basefee_zero');
  assert.equal(identity.validation.actualBlockBaseFeeRaw, BigInt(s.item.header.baseFeePerGas).toString());
  assert.equal(identity.validation.queryImplementation, 'configured_address_paths_before_and_after_no_runtime_code_attestation');
  assert.equal(s.context.measurementBasis, 'current_pinned_state_validated_query');
  assert.equal(s.context.allowanceMeasurementBasis, 'current_pinned_state_validated_allowance');
  assert.equal(s.context.canonicalFailure, null);
  const fullOverrides = buildStateOverrides(canonicalStateDiff(s.originalDiff));
  for (const call of s.calls.filter(call => call.method === 'debug_traceCall')) {
    assert.deepEqual(call.params[1], s.item.pinned);
    assert.ok(!['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce'].some(field => Object.hasOwn(call.params[0], field)));
    if (call.label.includes('-after-')) assert.deepEqual(call.params[2].stateOverrides, fullOverrides);
  }
  const evidence = s.context.snapshotEvidence();
  for (let i = 0; i < s.calls.length; i++) {
    assert.deepEqual(evidence.request[i], { id: i + 1, method: s.calls[i].method, params: s.calls[i].params });
    assert.deepEqual(evidence.response[i], { id: i + 1, method: s.calls[i].method, result: s.calls[i].result });
  }
});

test('context snapshots inputs, caches inflight/completed queries, and returns isolated values and evidence', async () => {
  const s = setup(), q = s.queries[0];
  assert.equal(Object.isFrozen(s.context), true);
  assert.equal(s.context.matches({ ...s.input, rpc: s.rpc }), true);
  assert.equal(s.context.matches({ ...s.input, rpc: {} }), false);
  assert.equal(s.context.matches({ ...s.input, rpc: s.rpc, block: { ...s.input.block, hash: word(8) } }), false);
  s.input.request.from = address(3); s.input.trace.calls = [];
  const [a, b] = await Promise.all([s.context.readPair(q), s.context.readPair({ to: q.to.toUpperCase().replace('0X', '0x'), data: q.data.toUpperCase().replace('0X', '0x') })]);
  assert.deepEqual(a, b); assert.equal(s.calls.length, 13);
  a.before = 0n; assert.notEqual((await s.context.readPair(q)).before, 0n);
  const evidence = s.context.snapshotEvidence(); evidence.request.length = 0;
  const identity = s.context.executionIdentity; identity.stateBlockHash = word(6);
  assert.equal(s.context.snapshotEvidence().request.length, 13);
  assert.equal(s.context.executionIdentity.stateBlockHash, s.item.header.hash);
});

test('malformed ABI and unknown/debt-allowance queries fail without preparing or making RPC calls', async () => {
  const s = setup();
  for (const q of [{ to: address(1), data: s.queries[0].data }, { ...s.queries[0], data: s.queries[0].data + '00' }, { to: USDC, data: ['0x70a08231'] }, { to: VUSDC, data: s.queries[2].data }, { to: USDC, data: '0x70a08231' + 'f'.repeat(64) }]) await assert.rejects(s.context.readPair(q), StateValidationError);
  assert.equal(s.calls.length, 0);
});

test('original failure, envelope mismatch and every lifecycle branch are rejected before any extra RPC', async () => {
  const mutations = [
    input => { input.trace.error = 'execution reverted'; },
    input => { input.trace.from = address(1); }, input => { input.trace.input = '0x'; },
    input => { input.trace.gas = '0x4c4b3f'; }, input => { input.trace.gasUsed = '0x0'; },
    input => { input.request.value = '1'; }, input => { input.request.chainId = 1; },
    input => { input.request.gasPrice = '0x0'; }, input => { input.request.nonce = '0x1'; },
    input => { input.block.number = '0'; }, input => { input.block.hash = [input.block.hash]; },
    ...['CREATE', 'CREATE2', 'SELFDESTRUCT'].map(type => input => { input.trace.calls.push({ type: 'CALL', from: address(1), to: address(2), gasUsed: '0x100', error: 'execution reverted', calls: [{ type, from: address(2), to: address(3), gasUsed: '0x10' }] }); }),
    input => { input.trace.calls.push({ type: 'CALL', from: input.request.to, to: PROBE, gasUsed: '0x10' }); },
  ];
  for (const mutateInput of mutations) {
    const s = setup({ mutateInput }); await assert.rejects(s.context.prepare(), StateValidationError);
    assert.equal(s.calls.length, 0); assert.equal(typeof s.context.canonicalFailure, 'string');
  }
});

test('pinned header, sender/root/witness classification, and direct nonce/native reads fail closed', async () => {
  const controls = [
    ['header', result => ({ ...result, hash: word(1) })],
    ['header', result => ({ ...result, mixHash: undefined })],
    ['sender-nonce', () => '0xffffffffffffffff'], ['sender-nonce', () => []],
    ['sender-balance', () => '-1'], ['sender-code', () => '0xef0100' + address(4).slice(2)],
    ['root-code', () => '0x'], ['root-code', () => ['0x6000']], ['witness-code', () => '0x6000'],
  ];
  for (const [label, change] of controls) {
    const s = setup({ transform: (result, call) => call.label === label ? change(result) : result });
    await assert.rejects(s.context.prepare(), StateValidationError);
    assert.equal(s.context.executionIdentity, null); assert.equal(typeof s.context.canonicalFailure, 'string');
  }
});

test('original diff must be strict, complete for sender nonce, and free of lifecycle/code changes', async () => {
  const sender = plan.cases[0].original.from, root = plan.cases[0].original.to;
  const mutations = [
    diff => { diff.unknown = {}; }, diff => { diff.pre[sender].extra = 1; },
    diff => { diff.pre = {}; diff.post = {}; }, diff => { delete diff.post[sender].nonce; },
    diff => { diff.pre[sender].nonce++; }, diff => { diff.post[sender].nonce++; },
    diff => { diff.pre[sender].balance = '0x0'; }, diff => { diff.pre[sender].storage = {}; },
    diff => { diff.pre[address(90)] = {}; }, diff => { diff.post[address(90)] = { code: '0x6000' }; },
    diff => { diff.post[root].code = '0x6000'; }, diff => { diff.pre[root].code = '0x6000'; },
    diff => { diff.pre[PROBE] = {}; diff.post[PROBE] = {}; },
  ];
  for (const mutation of mutations) {
    const s = setup({ transform: (result, call) => { if (call.label === 'original-diff') mutation(result); return result; } });
    await assert.rejects(s.context.prepare(), StateValidationError);
    assert.ok(s.calls.every(call => !call.label.startsWith('header-before')));
    assert.equal(typeof s.context.canonicalFailure, 'string');
  }
});

test('every witnessed header field is validated before and after with BASEFEE explicitly zero', async () => {
  for (const label of ['header-before', 'header-after']) for (let index = 0; index < 8; index++) {
    const s = setup({ transform: (result, call) => {
      if (call.label === label) { const offset = 2 + index * 64; result.output = result.output.slice(0, offset) + word(BigInt('0x' + result.output.slice(offset, offset + 64)) + 1n).slice(2) + result.output.slice(offset + 64); }
      return result;
    } });
    await assert.rejects(s.context.prepare(), /BASEFEE-zero profile/);
    assert.equal(typeof s.context.canonicalFailure, 'string');
  }
});

test('synthetic override-fidelity control preserves cleared/new slots and all accounts in both isolated after tracers', async () => {
  const cleared = word(400), inserted = word(401), other = address(900);
  const s = setup({ syntheticOverrides: true, transform: (result, call) => {
    if (call.label === 'original-diff') {
      result.pre[USDC].storage[cleared] = word(7); delete result.post[USDC].storage[cleared];
      result.post[USDC].storage[inserted] = word(8);
      result.pre[other] = { balance: '0x20' }; result.post[other] = { balance: '0x21' };
    }
    return result;
  } });
  await s.context.readPair(s.queries[0]);
  const after = s.calls.filter(call => ['usdc-after-trace', 'usdc-after-diff'].includes(call.label));
  assert.equal(after.length, 2); assert.deepEqual(after[0].params[2].stateOverrides, after[1].params[2].stateOverrides);
  const overrides = after[0].params[2].stateOverrides;
  assert.equal(overrides[USDC].stateDiff[cleared], word(0));
  assert.equal(overrides[USDC].stateDiff[inserted], word(8));
  assert.deepEqual(overrides[other], { balance: '0x21' });
  assert.equal(Object.hasOwn(overrides[USDC], 'state'), false);
  assert.equal(BigInt(overrides[s.item.original.from].nonce), BigInt(s.records.find(record => record.label === 'sender-nonce').response.result) + 1n);
  const witness = s.calls.find(call => call.label === 'header-after').params[2].stateOverrides;
  const { [PROBE]: probe, ...witnessOriginal } = witness;
  assert.deepEqual(witnessOriginal, overrides); assert.ok(probe.code);
  assert.ok(s.calls.filter(call => call.label.startsWith('usdc-before-')).every(call => !Object.hasOwn(call.params[2], 'stateOverrides')));
});

test('shared preparation failure is cached across all consumers without further RPC or identity', async () => {
  const s = setup({ transform: (result, call) => { if (call.label === 'header-after') throw new Error('SECRET_PREPARATION_FAILURE'); return result; } });
  const results = await Promise.allSettled(s.queries.map(query => s.context.readPair(query)));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(s.calls.length, 9); assert.equal(s.context.executionIdentity, null);
  assert.match(s.context.canonicalFailure, /provider failed/);
  await assert.rejects(s.context.prepare()); await assert.rejects(s.context.verifyCanonical());
  assert.equal(s.calls.length, 9);
  assert.equal(JSON.stringify(s.context.snapshotEvidence()).includes('SECRET_PREPARATION_FAILURE'), false);
});

test('post override queries must follow the configured token and Pool implementations even for unchanged output', async () => {
  for (const [caseId, queryIndex, mutate] of [
    ['supply', 0, trace => { trace.calls[0].to = address(91); }],
    ['supply', 1, trace => { trace.calls[0].calls[0].calls[0].to = address(92); }],
    ['borrow', 2, trace => { trace.calls[0].calls[0].input = '0x386497fd' + word(0).slice(2); }],
    ['borrow', 2, trace => { trace.calls[0].calls[0].output = word(0); trace.calls[0].calls[0].calls[0].output = word(0); }],
  ]) {
    const s = setup({ caseId, transform: (result, call) => { if (call.label === plan.cases.find(item => item.id === caseId).queries[queryIndex].id + '-after-trace') mutate(result); return result; } });
    await assert.rejects(s.context.readPair(s.queries[queryIndex]), StateValidationError);
    assert.equal(s.context.canonicalFailure, null);
    assert.equal(s.context.executionIdentity.headerContext, 'synthetic_unpriced_basefee_zero');
  }
});

test('successful-looking query outputs cannot hide malformed/failed/static/extra-child traces', async () => {
  const mutations = [
    trace => { trace.error = 'execution reverted'; }, trace => { trace.type = 'STATICCALL'; },
    trace => { trace.calls[0].from = address(4); }, trace => { trace.calls.push(structuredClone(trace.calls[0])); },
    trace => { trace.output = '0x'; }, trace => { trace.output = [trace.output]; },
    trace => { trace.logs = [{ address: USDC, topics: [word(1)], data: '0x' }]; },
    trace => { trace.calls[0].output = word(8); }, trace => { trace.gasUsed = '0x493e1'; },
    trace => { trace.gas = '0x493df'; }, trace => { delete trace.gas; },
  ];
  for (const mutate of mutations) {
    const s = setup({ transform: (result, call) => { if (call.label === 'usdc-before-trace') mutate(result); return result; } });
    await assert.rejects(s.context.readPair(s.queries[0]), StateValidationError);
    assert.equal(s.context.canonicalFailure, null);
  }
});

test('header witnesses require their exact 300000-gas envelope before and after', async () => {
  for (const label of ['header-before', 'header-after']) for (const gas of [undefined, '0x493df']) {
    const s = setup({ transform: (result, call) => { if (call.label === label) { if (gas === undefined) delete result.gas; else result.gas = gas; } return result; } });
    await assert.rejects(s.context.prepare(), /300000-gas/);
    assert.equal(typeof s.context.canonicalFailure, 'string');
  }
});

test('fake monotonic clock expires before a new RPC and never resumes cached results or requests', async () => {
  let time = 1000;
  const s = setup({ now: () => time });
  await s.context.readPair(s.queries[0]);
  assert.equal(s.calls.length, 13);
  assert.equal(s.context.executionIdentity.validation.maxContextMs, 120000);
  assert.equal(s.context.executionIdentity.validation.maxInFlightRpcMs, 25000);
  assert.match(s.context.executionIdentity.validation.inFlightRpcBound, /conditional/);
  time = 121000;
  await assert.rejects(s.context.readPair(s.queries[1]), /120-second/);
  await assert.rejects(s.context.readPair(s.queries[0]), /120-second/);
  await assert.rejects(s.context.verifyCanonical(), /120-second/);
  assert.equal(s.calls.length, 13); assert.match(s.context.canonicalFailure, /120-second/);
  time = 1000; // A synthetic clock rewind must not clear a deadline latch.
  await assert.rejects(s.context.prepare(), /120-second/); assert.equal(s.calls.length, 13);
});

test('fake clock discards late successful and failed RPC results, retaining fixed terminal timeout evidence', async () => {
  for (const mode of ['success', 'failure']) {
    let time = 0;
    const s = setup({ now: () => time, transform: (result, call) => {
      if (call.label === 'usdc-after-trace') {
        time = 120000;
        if (mode === 'failure') throw new Error('SECRET_LATE_PROVIDER');
      }
      return result;
    } });
    await assert.rejects(s.context.readPair(s.queries[0]), /120-second/);
    const evidence = s.context.snapshotEvidence();
    assert.equal(evidence.request.length, 12); assert.equal(evidence.response.length, 12);
    assert.deepEqual(evidence.response.at(-1), { id: 12, method: 'debug_traceCall', error: { code: 'STATE_CONTEXT_TIMEOUT', message: 'Current state measurement exceeded its 120-second context deadline.' } });
    assert.equal(Object.hasOwn(evidence.response.at(-1), 'result'), false);
    assert.equal(JSON.stringify(evidence).includes('SECRET_LATE_PROVIDER'), false);
    const calls = s.calls.length;
    await assert.rejects(s.context.verifyCanonical(), /120-second/);
    assert.equal(s.calls.length, calls);
  }
});

test('fake clock timeout is shared across pending queries and every in-flight request settles before evidence finalization', async () => {
  let time = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup({ now: () => time, transform: async (result, call) => {
    if (call.label === 'usdc-before-trace') await gate;
    if (call.label === 'husdc-before-trace') { time = 120000; release(); }
    return result;
  } });
  await s.context.prepare();
  const outcomes = await Promise.allSettled([s.context.readPair(s.queries[0]), s.context.readPair(s.queries[1])]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && /120-second/.test(outcome.reason.message)));
  assert.equal(s.calls.length, 11);
  const evidence = s.context.snapshotEvidence();
  assert.equal(evidence.response.length, 11);
  assert.ok(evidence.response.slice(-2).every(entry => entry.error?.code === 'STATE_CONTEXT_TIMEOUT'));
  await assert.rejects(s.context.readPair(s.queries[2]), /120-second/); assert.equal(s.calls.length, 11);
});

test('query mutations require exactly independent sender nonce increments and unchanged absolute native balance', async () => {
  const sender = plan.cases[0].original.from;
  const mutations = [
    diff => { diff.pre[sender].nonce--; }, diff => { diff.post[sender].nonce++; },
    diff => { delete diff.pre[sender].nonce; }, diff => { delete diff.pre[sender].balance; },
    diff => { diff.pre[sender].balance = '0x1'; }, diff => { diff.post[sender].balance = '0x1'; },
    diff => { diff.pre[sender].storage = {}; }, diff => { diff.post[sender].code = '0x'; },
    diff => { diff.pre[USDC] = { storage: { [word(1)]: word(2) } }; diff.post[USDC] = { storage: { [word(1)]: word(3) } }; },
    diff => { diff.pre[address(0)] = { balance: '0x0' }; diff.post[address(0)] = { balance: '0x1' }; },
    diff => { diff.extra = {}; }, diff => { diff.pre = {}; diff.post = {}; },
  ];
  for (const stage of ['before', 'after']) for (const mutate of mutations) {
    const s = setup({ transform: (result, call) => { if (call.label === 'usdc-' + stage + '-diff') mutate(result); return result; } });
    await assert.rejects(s.context.readPair(s.queries[0]), StateValidationError);
    assert.equal(s.context.canonicalFailure, null);
  }
  const valid = setup({ transform: (result, call) => { if (call.label === 'usdc-before-diff' || call.label === 'usdc-after-diff') result.post[sender].balance = result.pre[sender].balance; return result; } });
  assert.equal((await valid.context.readPair(valid.queries[0])).delta, -15066115n);
});

test('failed pairs are cached, unrelated successful queries and canonical checks remain usable', async () => {
  const s = setup({ transform: (result, call) => { if (call.label === 'usdc-after-trace') result.calls[0].to = address(7); return result; } });
  await assert.rejects(s.context.readPair(s.queries[0])); const count = s.calls.length;
  await assert.rejects(s.context.readPair(s.queries[0])); assert.equal(s.calls.length, count);
  assert.equal((await s.context.readPair(s.queries[1])).delta, 15066114n);
  await s.context.verifyCanonical(); assert.equal(s.context.canonicalFailure, null);
});

test('canonical errors latch across concurrent/later successful checks and never expose provider secrets', async () => {
  for (const fault of ['hash', 'header', 'rpc']) {
    let checks = 0;
    const s = setup({ transform: (result, call) => {
      if (call.label === 'canonical' && ++checks === 2) {
        if (fault === 'rpc') throw new Error('SECRET_PROVIDER_CREDENTIAL');
        if (fault === 'hash') result.hash = word(3); else result.gasLimit = '0x1234';
      }
      return result;
    } });
    await s.context.readPair(s.queries[0]);
    const outcomes = await Promise.allSettled([s.context.verifyCanonical(), s.context.verifyCanonical()]);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    const latched = s.context.canonicalFailure; assert.equal(typeof latched, 'string');
    await s.context.verifyCanonical(); assert.equal(s.context.canonicalFailure, latched);
    assert.equal(JSON.stringify(s.context.snapshotEvidence()).includes('SECRET_PROVIDER_CREDENTIAL'), false);
  }
});

test('RPC/provider and local non-JSON/size failures retain only bounded terminal diagnostics', async () => {
  for (const mode of ['error-envelope', 'exception', 'non-json', 'response-size']) {
    const s = setup({ transform: (result, call) => {
      if (call.label !== 'usdc-before-trace') return result;
      if (mode === 'error-envelope') return { error: { code: -32603, message: 'SECRET_PROVIDER_CREDENTIAL', data: 'SECRET_PROVIDER_CREDENTIAL' } };
      if (mode === 'exception') throw Object.assign(new Error('SECRET_PROVIDER_CREDENTIAL'), { detail: { rpcCode: -32603 } });
      if (mode === 'non-json') return 1n;
      return 'é'.repeat(4 * 1024 * 1024);
    } });
    await assert.rejects(s.context.readPair(s.queries[0]), StateValidationError);
    const evidence = s.context.snapshotEvidence();
    assert.equal(evidence.request.length, evidence.response.length);
    assert.ok(evidence.response.at(-1).error);
    assert.equal(JSON.stringify(evidence).includes('SECRET_PROVIDER_CREDENTIAL'), false);
    assert.equal(s.context.canonicalFailure, null);
  }
});

test('32 MiB retained response evidence limit uses UTF-8 bytes and canonical failure is latched', async () => {
  const s = setup({ transform: (result, call) => { if (call.label === 'canonical') result.syntheticSizeControl = 'é'.repeat(3 * 1024 * 1024); return result; } });
  await s.context.prepare();
  for (let i = 0; i < 5; i++) await s.context.verifyCanonical();
  await assert.rejects(s.context.verifyCanonical(), /size limit/);
  assert.equal(s.context.snapshotEvidence().response.at(-1).error.code, 'STATE_EVIDENCE_LIMIT');
  assert.match(s.context.canonicalFailure, /size limit/);
});

test('12 distinct query cap shares inflight promises and leaves three canonical checks within 64 RPC', async () => {
  const s = setup({ syntheticQueries: true });
  const queries = Array.from({ length: 12 }, (_, i) => balanceQuery(USDC, address(100 + i)));
  const results = await Promise.all(queries.flatMap(query => [s.context.readPair(query), s.context.readPair(query)]));
  assert.equal(results.length, 24); assert.equal(s.calls.length, 57);
  await assert.rejects(s.context.readPair(balanceQuery(USDC, address(200))), /12 token/);
  assert.equal(s.calls.length, 57);
  await Promise.all([s.context.verifyCanonical(), s.context.verifyCanonical(), s.context.verifyCanonical()]);
  assert.equal(s.calls.length, 60);
  for (let i = 0; i < 4; i++) await s.context.verifyCanonical();
  assert.equal(s.calls.length, 64);
  await assert.rejects(s.context.verifyCanonical(), /64-RPC/); assert.equal(s.calls.length, 64);
  assert.equal(typeof s.context.canonicalFailure, 'string');
});
