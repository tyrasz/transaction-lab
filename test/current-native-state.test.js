import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createVerifiedCurrentStateContext } from '../src/current-state.js';
import { USDC } from '../src/config.js';
import { QUERY_IMPLEMENTATIONS } from '../src/query-validation.js';

const a = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const h = n => '0x' + BigInt(n).toString(16), w = n => BigInt(n).toString(16).padStart(64, '0');
const S = a(11), T = a(12), R = a(13), I = a(14), PROBE = a(0xba1a);
const HEADER = { hash: '0x' + w(90), parentHash: '0x' + w(89), mixHash: '0x' + w(91), miner: a(92),
  number: h(9000001), timestamp: h(1700000000), gasLimit: h(30000000), baseFeePerGas: h(17000000000) };
const HEADER_WORDS = [9000001, 1700000000, 30000000, 0, 91, 92, 999, 89];
const balanceQuery = account => ({ to: USDC, data: '0x70a08231' + account.slice(2).padStart(64, '0') });
const frame = (from, to, value, extra = {}) => ({ type: 'CALL', from, to, input: '0x', output: '0x',
  value: h(value), gas: h(5000000), gasUsed: h(21000), ...extra });

// Entirely synthetic transport controls: no VM, provider or historical result.
// Initial balance reads, the raw original diff and witness outputs are separate
// fixture channels, and tamper controls change only the named channel.
function fixture({ value = 100n, self = false, fresh = false, refund = 0n, rootCode = '0x', configure, transform, now } = {}) {
  const target = self ? S : T;
  const initial = { [S]: 1000n, [T]: fresh ? 0n : 500n, [R]: 50n };
  const final = { ...initial, [S]: initial[S] - (self ? 0n : value) + refund };
  if (!self) final[T] = initial[T] + value - refund;
  const request = { chainId: 999, from: S, to: target, data: '0x', value: value.toString() };
  const trace = frame(S, target, value);
  if (refund) { rootCode = '0x6000'; trace.calls = [frame(T, S, refund)]; }
  const diff = { pre: { [S]: { nonce: 7, balance: h(initial[S]) } },
    post: { [S]: { nonce: 8, ...(final[S] === initial[S] ? {} : { balance: h(final[S]) }) } } };
  if (!self) { if (!fresh) diff.pre[T] = { balance: h(initial[T]) }; diff.post[T] = { balance: h(final[T]) }; }
  const codes = { [target]: rootCode, [S]: '0x', [PROBE]: '0x' };
  const state = { request, trace, diff, initial, final, codes };
  configure?.(state);
  const records = [], pinned = { blockHash: HEADER.hash, requireCanonical: true };
  const rpc = { async call(method, params) {
    const input = method === 'debug_traceCall' ? params[0] : null;
    const options = method === 'debug_traceCall' ? params[2] : null;
    const after = Boolean(options?.stateOverrides?.[S]);
    let result, stage = method;
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') result = structuredClone(HEADER);
    else if (method === 'eth_getBalance') result = h(initial[params[0]] ?? 0n);
    else if (method === 'eth_getTransactionCount') result = params[0] === S ? '0x7' : '0x0';
    else if (method === 'eth_getCode') result = codes[params[0]] ?? '0x';
    else if (input?.to === PROBE) {
      const isDiff = options.tracer === 'prestateTracer';
      const accounts = [...options.stateOverrides[PROBE].code.matchAll(/73([0-9a-f]{40})3161/g)].map(match => '0x' + match[1]);
      stage = `${accounts.length ? 'native' : 'header'}_${after ? 'after' : 'before'}_${isDiff ? 'diff' : 'trace'}`;
      if (isDiff) result = { pre: { [S]: { nonce: after ? 8 : 7, balance: h(after ? final[S] : initial[S]) } }, post: { [S]: { nonce: after ? 9 : 8 } } };
      else result = frame(S, PROBE, 0n, { gas: input.gas, output: '0x' + [...HEADER_WORDS, ...accounts.map(account => (after ? final : initial)[account] ?? 0n)].map(w).join('') });
    } else if (input?.to === USDC && input.data.startsWith('0x70a08231')) {
      const isDiff = options.tracer === 'prestateTracer'; stage = `token_${after ? 'after' : 'before'}_${isDiff ? 'diff' : 'trace'}`;
      result = isDiff ? { pre: { [S]: { nonce: after ? 8 : 7, balance: h(after ? final[S] : initial[S]) } }, post: { [S]: { nonce: after ? 9 : 8 } } }
        : frame(S, USDC, 0n, { input: input.data, gas: input.gas, output: '0x' + w(after ? 2 : 1), calls: [frame(USDC, QUERY_IMPLEMENTATIONS[USDC], 0n,
          { type: 'DELEGATECALL', input: input.data, output: '0x' + w(after ? 2 : 1) })] });
    } else if (input) { assert.equal(options.tracer, 'prestateTracer'); stage = 'original_diff'; result = structuredClone(diff); }
    else assert.fail('Unexpected method ' + method);
    if (method === 'debug_traceCall') assert.deepEqual(params[1], pinned);
    else if (['eth_getBalance', 'eth_getTransactionCount', 'eth_getCode'].includes(method)) assert.deepEqual(params[1], pinned);
    const replacement = await transform?.({ method, params, stage, result, ...state, records });
    if (replacement !== undefined) result = replacement;
    records.push({ method, params: structuredClone(params), stage, result: structuredClone(result) });
    return result;
  } };
  const context = createVerifiedCurrentStateContext({ request, block: { hash: HEADER.hash, number: '9000001', timestamp: '1700000000' }, rpc, trace, ...(now ? { now } : {}) });
  return { ...state, context, records };
}
const amounts = result => result.measurements.map(row => [row.account, row.before, row.after, row.delta]);

test('positive HYPE transfer keeps original value and defers optional anchors and native witnesses', async () => {
  const f = fixture(); await f.context.prepare();
  assert.equal(f.records.length, 9);
  assert.equal(f.records.filter(row => row.method === 'eth_getBalance').length, 1);
  assert.equal(f.records.find(row => row.stage === 'original_diff').params[0].value, '0x64');
  const identity = f.context.executionIdentity, result = await f.context.readNativeBalances();
  assert.deepEqual(amounts(result), [[S, 1000n, 900n, -100n], [T, 500n, 600n, 100n]]);
  assert.equal(result.feeScope, 'excluded'); assert.equal(result.maxAccounts, 8);
  assert.deepEqual(result.counts, { candidates: 2, selected: 2, omitted: 0 });
  assert.equal(f.records.length, 14); assert.deepEqual(f.context.executionIdentity, identity);
  assert.equal(identity.validation.reservedCanonicalCalls, 4);
  const evidence = f.context.snapshotEvidence();
  for (const [index, row] of result.measurements.entries()) {
    assert.equal(evidence.request[row.anchorEvidenceId - 1].method, 'eth_getBalance');
    assert.equal(evidence.request[row.anchorEvidenceId - 1].params[0], row.account);
    assert.deepEqual(row.queryEvidence.map(q => q.state), ['before', 'after']);
    for (const q of row.queryEvidence) {
      assert.equal(q.wordIndex, 8 + index);
      assert.equal(evidence.request[q.traceEvidenceId - 1].params[2].tracer, 'callTracer');
      assert.equal(evidence.request[q.mutationEvidenceId - 1].params[2].tracer, 'prestateTracer');
      assert.deepEqual(evidence.request[q.traceEvidenceId - 1].params[2].stateOverrides, evidence.request[q.mutationEvidenceId - 1].params[2].stateOverrides);
    }
  }
});

test('self-transfer measures zero net while insufficient upfront value is rejected', async () => {
  assert.deepEqual(amounts(await fixture({ self: true }).context.readNativeBalances()), [[S, 1000n, 1000n, 0n]]);
  const f = fixture({ self: true, value: 1001n });
  await assert.rejects(f.context.prepare(), /cannot fund/); assert.equal(f.records.length, 3);
  assert.match(f.context.canonicalFailure, /cannot fund/);
});

test('token consumers and native witnesses use the sender balance after a refund; identity stays fixed', async () => {
  const f = fixture({ refund: 40n });
  assert.deepEqual(await f.context.readPair(balanceQuery(S)), { before: 1n, after: 2n, delta: 1n });
  const identity = f.context.executionIdentity;
  const result = await f.context.readNativeBalances();
  assert.deepEqual(amounts(result), [[S, 1000n, 940n, -60n], [T, 500n, 560n, 60n]]);
  assert.deepEqual(f.context.executionIdentity, identity);
  assert.equal(f.records.find(row => row.stage === 'token_after_diff').result.pre[S].balance, h(940));
  const bad = fixture({ refund: 40n, transform: x => { if (x.stage === 'token_after_diff') x.result.pre[S].balance = h(1000); } });
  await assert.rejects(bad.context.readPair(balanceQuery(S)), /native balance/);
  assert.equal(bad.context.canonicalFailure, null);
  assert.deepEqual(amounts(await bad.context.readNativeBalances()), [[S, 1000n, 940n, -60n], [T, 500n, 560n, 60n]]);
});

test('funded-empty normalization uses independent zero balance/nonce/code and preserves the raw diff', async () => {
  const f = fixture({ fresh: true }), original = structuredClone(f.diff);
  const result = await f.context.readNativeBalances();
  assert.deepEqual(amounts(result), [[S, 1000n, 900n, -100n], [T, 0n, 100n, 100n]]);
  assert.deepEqual(f.records.find(row => row.stage === 'original_diff').result, original);
  assert.equal(original.pre[T], undefined); assert.equal(result.stateNormalization.length, 1);
  const normalization = result.stateNormalization[0], evidence = f.context.snapshotEvidence();
  for (const [field, method] of [['balanceEvidenceId', 'eth_getBalance'], ['nonceEvidenceId', 'eth_getTransactionCount'], ['codeEvidenceId', 'eth_getCode']]) {
    assert.equal(evidence.request[normalization[field] - 1].method, method);
    assert.equal(evidence.request[normalization[field] - 1].params[0], T);
  }
  for (const transform of [
    x => x.method === 'eth_getBalance' && x.params[0] === T ? '0x1' : undefined,
    x => x.method === 'eth_getTransactionCount' && x.params[0] === T ? '0x1' : undefined,
    x => x.method === 'eth_getCode' && x.params[0] === T ? '0x6000' : undefined,
    x => { if (x.stage === 'original_diff') x.result.post[T].nonce = 1; },
    x => { if (x.stage === 'original_diff') x.result.post[T].storage = { ['0x' + w(1)]: '0x' + w(2) }; },
  ]) {
    const bad = fixture({ fresh: true, transform }); await assert.rejects(bad.context.readNativeBalances()); assert.equal(typeof bad.context.canonicalFailure, 'string');
  }
});

test('explicit final zero and omitted unchanged balance stay distinct from unsupported missing prebalance', async () => {
  const drained = await fixture({ value: 1000n }).context.readNativeBalances();
  assert.equal(drained.measurements[0].after, 0n); assert.equal(drained.measurements[0].delta, -1000n);
  const omitted = fixture({ fresh: true, configure: f => { f.diff.pre[T] = {}; } });
  assert.equal((await omitted.context.readNativeBalances()).measurements[1].before, 0n);
  const wrong = fixture({ configure: f => { delete f.diff.pre[T].balance; } });
  await assert.rejects(wrong.context.readNativeBalances(), /Omitted native prebalance/);
});

test('caught ancestor reverts discard descendants; DELEGATECALL/CALLCODE values do not transfer funds', async () => {
  const f = fixture({ rootCode: '0x6000', configure: f => {
    f.trace.calls = [frame(T, R, 80n, { error: 'execution reverted', calls: [frame(R, S, 50n)] }),
      frame(T, I, 100n, { type: 'DELEGATECALL' }), frame(T, I, 7n, { type: 'CALLCODE', calls: [frame(T, R, 7n, { type: 'DELEGATECALL' })] })];
  } });
  assert.deepEqual(amounts(await f.context.readNativeBalances()), [[S, 1000n, 900n, -100n], [T, 500n, 600n, 100n]]);
  const bad = fixture({ rootCode: '0x6000', configure: f => { f.trace.calls = [frame(T, I, 1n, { type: 'DELEGATECALL' })]; } });
  await assert.rejects(bad.context.prepare(), /delegate value/);
});

test('root failures, unsupported lifecycle, empty-code behavior and contradictory native evidence fail closed', async () => {
  for (const configure of [
    f => { f.trace.error = 'execution reverted'; },
    f => { f.trace.value = '0x65'; },
    f => { f.trace.calls = [frame(T, R, 0n)]; },
    f => { f.trace.output = '0x01'; },
    f => { f.codes[T] = '0x6000'; f.trace.calls = [frame(T, R, 0n, { error: 'execution reverted', calls: [frame(R, I, 0n, { type: 'SELFDESTRUCT' })] })]; },
    f => { f.diff.post[T].balance = h(601); },
    f => { delete f.diff.post[T]; },
    f => { delete f.diff.pre[T]; delete f.diff.post[T]; },
  ]) {
    const f = fixture({ configure }); await assert.rejects(f.context.readNativeBalances());
    assert.equal(typeof f.context.canonicalFailure, 'string');
    assert.equal(f.records.some(row => row.stage.startsWith('native_')), false);
  }
});

test('native anchors, both complete witnesses and nonce-only mutations are independently checked', async () => {
  for (const transform of [
    x => x.method === 'eth_getBalance' && x.params[0] === T ? h(501) : undefined,
    x => { if (x.stage === 'native_before_trace') x.result.output = x.result.output.slice(0, -64) + w(501); },
    x => { if (x.stage === 'native_after_trace') x.result.output = x.result.output.slice(0, -64) + w(601); },
    x => { if (x.stage === 'native_after_trace') x.result.output = '0x' + w(9000002) + x.result.output.slice(66); },
    x => { if (x.stage === 'native_before_diff') x.result.post[S].balance = h(999); },
    x => { if (x.stage === 'native_after_diff') x.result.pre[S].balance = h(1000); },
    x => { if (x.stage === 'native_after_diff') x.result.post[S].nonce = 10; },
    x => { if (x.stage === 'native_before_diff') x.result.pre[R] = {}; },
    x => { if (x.stage === 'native_after_trace') x.result.logs = [{ address: PROBE, topics: [], data: '0x' }]; },
  ]) {
    const f = fixture({ transform }); await assert.rejects(f.context.readNativeBalances());
    assert.equal(typeof f.context.canonicalFailure, 'string');
    const count = f.records.length; await assert.rejects(f.context.readNativeBalances()); assert.equal(f.records.length, count);
  }
});

test('native cache deduplicates concurrent calls, clones results and refuses cached data after shared failure', async () => {
  const f = fixture(); const [first, second] = await Promise.all([f.context.readNativeBalances(), f.context.readNativeBalances()]);
  assert.deepEqual(first, second); assert.equal(f.records.length, 14);
  first.measurements[0].before = 1n; first.candidates[0].account = R;
  assert.deepEqual(amounts(await f.context.readNativeBalances()), [[S, 1000n, 900n, -100n], [T, 500n, 600n, 100n]]);
  const bad = fixture({ transform: x => { if (x.method === 'eth_getBlockByNumber') x.result.hash = '0x' + w(999); } });
  await bad.context.readPair(balanceQuery(S)); await bad.context.readNativeBalances();
  await assert.rejects(bad.context.verifyCanonical());
  await assert.rejects(bad.context.readNativeBalances()); await assert.rejects(bad.context.readPair(balanceQuery(S)));
});

test('native late deadline failure is latched, and cached success is not a deadline bypass', async () => {
  let time = 0;
  const f = fixture({ now: () => time, transform: x => { if (x.stage === 'native_after_diff') time = 120001; } });
  await assert.rejects(f.context.readNativeBalances(), /120-second/);
  assert.equal(f.context.snapshotEvidence().response.at(-1).error.code, 'STATE_CONTEXT_TIMEOUT');
  time = 0; await assert.rejects(f.context.readNativeBalances(), /120-second/);
  const cached = fixture({ now: () => time }); await cached.context.readNativeBalances(); time = 120001;
  await assert.rejects(cached.context.readNativeBalances(), /120-second/);
});

function fanout(f, count) {
  f.trace.calls = Array.from({ length: count }, (_, i) => frame(T, a(100 + i), 1n));
  f.codes[T] = '0x6000'; f.final[T] -= BigInt(count); f.diff.post[T].balance = h(f.final[T]);
  for (let i = 0; i < count; i++) {
    const account = a(100 + i); f.initial[account] = 0n; f.final[account] = 1n;
    f.diff.pre[account] = { balance: '0x0', nonce: 1 }; f.diff.post[account] = { balance: '0x1' };
  }
}

test('eight-account display cap retains omitted candidates and validates their balance changes', async () => {
  const f = fixture({ configure: f => fanout(f, 9) }), result = await f.context.readNativeBalances();
  assert.deepEqual(result.counts, { candidates: 11, selected: 8, omitted: 3 });
  assert(result.candidates.filter(row => !row.selected).every(row => row.reason === 'account-limit'));
  assert.equal(result.measurements.length, 8);
  const bad = fixture({ configure: f => { fanout(f, 9); f.diff.post[a(108)].balance = '0x2'; } });
  await assert.rejects(bad.context.prepare(), /committed CALL/);
});

test('optional native display cannot consume token queries or reserved canonical calls', async () => {
  const f = fixture({ configure: f => fanout(f, 9) });
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.context.readPair(balanceQuery(a(500 + i)))));
  assert.equal(f.records.length, 57);
  const result = await f.context.readNativeBalances();
  assert.deepEqual(result.counts, { candidates: 11, selected: 0, omitted: 11 });
  assert.equal(f.records.length, 57); assert.equal(f.context.canonicalFailure, null);
  assert(result.candidates.slice(0, 8).every(row => row.reason === 'rpc-budget'));
  await Promise.all(Array.from({ length: 4 }, () => f.context.verifyCanonical())); assert.equal(f.records.length, 61);
});

test('mandatory missing balance anchors cannot silently truncate complete after-state validation', async () => {
  const f = fixture({ configure: f => {
    fanout(f, 60);
    for (let i = 0; i < 60; i++) delete f.diff.pre[a(100 + i)].balance;
  } });
  await assert.rejects(f.context.readNativeBalances(), /reserved RPC budget/);
  assert.equal(typeof f.context.canonicalFailure, 'string'); assert(f.records.length < 64);
  assert.equal(f.records.some(row => row.stage.startsWith('header_') || row.stage.startsWith('native_')), false);
});

test('zero native candidates preserve existing preparation witnesses and add no native RPCs', async () => {
  const f = fixture({ value: 0n, configure: f => { delete f.diff.pre[T]; delete f.diff.post[T]; } });
  await f.context.prepare(); const count = f.records.length;
  const result = await f.context.readNativeBalances();
  assert.equal(count, 9); assert.equal(f.records.length, count);
  assert.deepEqual(result.counts, { candidates: 0, selected: 0, omitted: 0 }); assert.deepEqual(result.measurements, []);
  assert.equal(f.context.executionIdentity.validation.reservedCanonicalCalls, 3);
});

// Observed provider compatibility, not a universal Geth tracer guarantee. These
// four immutable captures end at the BEFORE mutation witness. Replaying their
// saved prefix must reach the missing after witness and remain unavailable; no
// after result or completed measurement is invented by these controls.
const WHYPE_PREFIXES = [
  ['003-whype-deposit-drpc', '44a33de02bed3b4ea3b9bfa9297938c0e8413589a0e93e6a5dd22efd0fae2f4d'],
  ['003-whype-deposit-hyperlend-archive', '437e48dcec9c71602c8ed03153b21e355e10098bb7f3731eae00270e1fa76648'],
  ['004-whype-withdraw-drpc', '9e3c7a96f65072ea8f7ed35a94167586ba65c0333692fb0b6e3a0ff155940f87'],
  ['004-whype-withdraw-hyperlend-archive', 'b3df969633f3b9a441c9738ab9cdd7f952ac31be28935f1fe4ea021702170a8f'],
];
for (const [name, hash] of WHYPE_PREFIXES) test(`saved ${name} before witness is accepted without inventing an after observation`, async () => {
  const raw = readFileSync(new URL(`../research/hype-native-current-v039/capture-001/${name}.json`, import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), hash);
  const packet = JSON.parse(raw), saved = packet.records.slice(3), untouched = structuredClone(saved);
  assert.equal(packet.report.nativeBalanceChanges.status, 'unavailable');
  assert.equal(saved.length, 12); assert.equal(saved.at(-1).params[2].tracer, 'prestateTracer');
  const target = packet.report.request.to;
  assert.deepEqual(Object.keys(saved.at(-1).result.pre[target]).sort(), ['balance', 'code']);
  assert.deepEqual(saved.at(-1).result.post[target], {});
  let index = 0, missing, mismatch;
  const rpc = { async call(method, params) {
    if (index === saved.length) {
      missing = { method, params: structuredClone(params) };
      throw Object.assign(new Error('The capture contains no after witness.'), { code: 'RPC_CONNECTION_ERROR' });
    }
    const row = saved[index++];
    try { assert.deepEqual({ method, params }, { method: row.method, params: row.params }); }
    catch (error) { mismatch = error; throw error; }
    return structuredClone(row.result);
  } };
  const source = packet.report.source;
  const context = createVerifiedCurrentStateContext({ request: packet.report.request,
    block: { hash: source.blockHash, number: source.blockNumber, timestamp: source.timestamp }, rpc, trace: packet.records[2].result });
  await assert.rejects(context.readNativeBalances(), /provider failed a read-only RPC request/);
  assert.equal(mismatch, undefined); assert.equal(index, saved.length);
  const expectedAfter = structuredClone(saved.at(-2));
  expectedAfter.params[2].stateOverrides = { ...saved[8].params[2].stateOverrides,
    [PROBE]: saved.at(-2).params[2].stateOverrides[PROBE] };
  assert.deepEqual(missing, { method: expectedAfter.method, params: expectedAfter.params });
  const evidence = context.snapshotEvidence();
  assert.deepEqual(evidence.response.at(-2).result, saved.at(-1).result);
  assert.equal(evidence.response.at(-1).error.code, 'RPC_CONNECTION_ERROR');
  assert.deepEqual(saved, untouched);
  await assert.rejects(context.readNativeBalances(), /provider failed/);
});

function addNativeTouch(x, account = T) {
  const after = x.stage === 'native_after_diff';
  x.result.pre[account] = { balance: h((after ? x.final : x.initial)[account]), code: x.codes[account] ?? '0x', nonce: 0 };
  x.result.post[account] = {};
}

test('synthetic before and after native witnesses allow only anchored unchanged selected-account touches', async () => {
  const f = fixture({ refund: 40n, transform: x => {
    if (['native_before_diff', 'native_after_diff'].includes(x.stage)) addNativeTouch(x);
  } });
  assert.deepEqual(amounts(await f.context.readNativeBalances()), [[S, 1000n, 940n, -60n], [T, 500n, 560n, 60n]]);
  assert.equal(f.records.length, 14); // No compatibility RPCs were introduced.
  const evidence = f.context.snapshotEvidence();
  for (const stage of ['native_before_diff', 'native_after_diff']) {
    const record = f.records.find(row => row.stage === stage);
    assert.deepEqual(record.result.post[T], {});
    assert.equal(record.result.pre[T].code, '0x6000');
    assert.deepEqual(evidence.response[f.records.indexOf(record)].result, record.result);
  }
  const zero = fixture({ fresh: true, transform: x => {
    if (['native_before_diff', 'native_after_diff'].includes(x.stage)) {
      addNativeTouch(x); if (x.stage === 'native_before_diff') delete x.result.pre[T].balance;
    }
  } });
  assert.deepEqual(amounts(await zero.context.readNativeBalances()), [[S, 1000n, 900n, -100n], [T, 0n, 100n, 100n]]);
});

test('native touch compatibility rejects changed fields, storage, lifecycle, wrong anchors and unrelated accounts', async () => {
  const mutations = [
    x => { x.result.pre[T].balance = h(501); },
    x => { delete x.result.pre[T].balance; },
    x => { x.result.pre[T].code = '0x6001'; },
    x => { x.result.pre[T].storage = {}; },
    x => { x.result.pre[T].storage = { ['0x' + w(1)]: '0x' + w(2) }; },
    x => { x.result.post[T].balance = x.result.pre[T].balance; },
    x => { x.result.post[T].balance = h(501); },
    x => { x.result.post[T].nonce = 0; },
    x => { x.result.post[T].code = '0x6000'; },
    x => { x.result.post[T].storage = {}; },
    x => { delete x.result.post[T]; },
    x => { delete x.result.pre[T]; },
    x => { x.result.pre[R] = { balance: h(50), code: '0x' }; x.result.post[R] = {}; },
    x => { x.result.pre[PROBE] = { balance: '0x0', code: '0x' }; x.result.post[PROBE] = {}; },
  ];
  for (const mutate of mutations) for (const phase of ['native_before_diff', 'native_after_diff']) {
    const f = fixture({ rootCode: '0x6000', transform: x => {
      if (['native_before_diff', 'native_after_diff'].includes(x.stage)) addNativeTouch(x);
      if (x.stage === phase) mutate(x);
    } });
    await assert.rejects(f.context.readNativeBalances()); assert.equal(typeof f.context.canonicalFailure, 'string');
    const count = f.records.length; await assert.rejects(f.context.readNativeBalances()); assert.equal(f.records.length, count);
  }
  const omitted = fixture({ configure: f => fanout(f, 9), transform: x => {
    if (x.stage === 'native_before_diff') addNativeTouch(x, a(108));
  } });
  await assert.rejects(omitted.context.readNativeBalances()); // Candidate, but outside the probe's selected rows.
});

test('native compatibility never relaxes token query mutation validation or the fixed probe trace', async () => {
  for (const phase of ['token_before_diff', 'token_after_diff']) {
    const f = fixture({ rootCode: '0x6000', transform: x => {
      if (x.stage === phase) { x.result.pre[T] = { balance: h(500), code: '0x6000' }; x.result.post[T] = {}; }
    } });
    await assert.rejects(f.context.readPair(balanceQuery(S)), /outside its sender nonce/);
  }
  for (const mutate of [
    x => { x.result.calls = [frame(PROBE, T, 0n)]; },
    x => { x.result.logs = [{ address: PROBE, topics: [], data: '0x' }]; },
    x => { x.result.value = '0x1'; },
  ]) {
    const f = fixture({ rootCode: '0x6000', transform: x => { if (x.stage === 'native_before_trace') mutate(x); } });
    await assert.rejects(f.context.readNativeBalances());
    assert.equal(f.records.some(row => row.stage === 'native_before_diff'), false);
  }
});
