import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStateOverrides, createStateContext } from '../src/state.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

test('empty state diffs and nonce-only diffs are valid, without fabricating storage', () => {
  assert.deepEqual(buildStateOverrides({ pre: {}, post: {} }), {});
  assert.deepEqual(buildStateOverrides({ pre: { [ACCOUNT]: { nonce: 3 } }, post: { [ACCOUNT]: { nonce: 4 } } }), { [ACCOUNT]: { nonce: '0x4' } });
});

test('state reconstruction includes inserted, changed and cleared slots plus native balance changes', () => {
  const diff = {
    pre: { [TOKEN]: { balance: '0x1', nonce: 2, code: '0xab', storage: { [word(1n)]: word(10n), [word(2n)]: word(20n) } } },
    post: { [TOKEN]: { balance: '0x3', nonce: 3, storage: { [word(1n)]: word(11n), [word(3n)]: word(30n) } } },
  };
  assert.deepEqual(buildStateOverrides(diff), { [TOKEN]: { balance: '0x3', nonce: '0x3', stateDiff: { [word(1n)]: word(11n), [word(2n)]: word(0n), [word(3n)]: word(30n) } } });
});

test('storage, account and numeric resource bounds reject malformed or unbounded state', () => {
  const cases = [
    { pre: { [ACCOUNT]: { nonce: `0x${(1n << 64n).toString(16)}` } }, post: { [ACCOUNT]: { nonce: 1 } } },
    { pre: { [ACCOUNT]: { balance: `0x${(1n << 256n).toString(16)}` } }, post: { [ACCOUNT]: {} } },
    { pre: { [TOKEN]: { storage: { [word(1n)]: 123 } } }, post: { [TOKEN]: {} } },
    { pre: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`0x${i.toString(16).padStart(40, '0')}`, {}])), post: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`0x${i.toString(16).padStart(40, '0')}`, {}])) },
    { pre: { [TOKEN]: { storage: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [word(BigInt(i)), word(1n)])) } }, post: { [TOKEN]: {} } },
  ];
  for (const diff of cases) assert.throws(() => buildStateOverrides(diff));
});

test('lazy context snapshots request identity and shares in-flight preparation', async () => {
  const request = { chainId: 999, from: ACCOUNT, to: TOKEN, value: '0', data: '0x' };
  const block = { hash: word(42n), number: '42', timestamp: '123' };
  const calls = [];
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'eth_getBlockByHash') return { hash: block.hash, number: '0x2a', timestamp: '0x7b' };
    if (method === 'debug_traceCall') return { pre: {}, post: {} };
    return word(0n);
  } };
  const context = createStateContext({ request, block, rpc });
  assert.equal(calls.length, 0);
  request.value = '1';
  assert.equal(context.matches({ request, block, rpc }), false);
  await Promise.all([context.prepare(), context.prepare()]);
  assert.equal(calls.filter(call => call.method === 'debug_traceCall').length, 1);
  assert.equal(calls.find(call => call.method === 'debug_traceCall').params[0].value, '0x0');
  assert.equal(context.executionIdentity.headerContext, 'provider_unpriced_call_unverified');
  assert.equal(context.executionIdentity.feePolicy, 'gas_price_omitted');
  assert.equal(context.executionIdentity.headerValidation, 'not_performed', 'Pinning state does not establish unchanged EVM header fields');
});

test('shared canonical failure is sanitized and remains latched after a later successful check', async () => {
  for (const failure of ['mismatch', 'rpc']) {
    const request = { chainId: 999, from: ACCOUNT, to: TOKEN, value: '0', data: '0x' };
    const block = { hash: word(42n), number: '42', timestamp: '123' };
    const header = { hash: block.hash, number: '0x2a', timestamp: '0x7b' };
    let checks = 0;
    const rpc = { async call(method) {
      if (method === 'eth_getBlockByHash') return header;
      if (method === 'debug_traceCall') return { pre: {}, post: {} };
      if (method === 'eth_getBlockByNumber') {
        if (++checks === 2) {
          if (failure === 'rpc') throw new Error('PRIVATE_PROVIDER_URL_SECRET');
          return { ...header, hash: word(1n) };
        }
        return header;
      }
      return word(0n);
    } };
    const context = createStateContext({ request, block, rpc });
    assert.equal(context.canonicalFailure, null);
    await context.verifyCanonical();
    assert.equal(context.canonicalFailure, null);
    await assert.rejects(context.verifyCanonical());
    const firstFailure = context.canonicalFailure;
    assert.equal(typeof firstFailure, 'string');
    assert.doesNotMatch(firstFailure, /PRIVATE_PROVIDER_URL_SECRET/);
    await context.verifyCanonical();
    assert.equal(context.canonicalFailure, firstFailure, 'another consumer cannot clear the failed binding');
    assert.equal(checks, 3, 'the getter adds no RPC requests');
    assert.doesNotMatch(JSON.stringify(context.snapshotEvidence()), /PRIVATE_PROVIDER_URL_SECRET/);
  }
});

test('an isolated token query failure does not latch a canonical failure', async () => {
  const request = { chainId: 999, from: ACCOUNT, to: TOKEN, value: '0', data: '0x' };
  const block = { hash: word(42n), number: '42', timestamp: '123' };
  const rpc = { async call(method) {
    if (method.startsWith('eth_getBlock')) return { hash: block.hash, number: '0x2a', timestamp: '0x7b' };
    if (method === 'debug_traceCall') return { pre: {}, post: {} };
    throw new Error('PRIVATE_QUERY_SECRET');
  } };
  const context = createStateContext({ request, block, rpc });
  await assert.rejects(context.readPair({ to: TOKEN, data: '0x' }));
  assert.equal(context.canonicalFailure, null);
  await context.verifyCanonical();
  assert.equal(context.canonicalFailure, null);
});

function pairHarness(handler = () => word(0n)) {
  const request = { chainId: 999, from: ACCOUNT, to: TOKEN, value: '0', data: '0x' };
  const block = { hash: word(42n), number: '42', timestamp: '123' };
  const calls = [];
  const rpc = { async call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method.startsWith('eth_getBlock')) return { hash: block.hash, number: '0x2a', timestamp: '0x7b' };
    if (method === 'debug_traceCall') return { pre: {}, post: {} };
    return handler(method, params);
  } };
  return { context: createStateContext({ request, block, rpc }), calls };
}

test('concurrent normalized queries share one pair and callers cannot mutate cached values', async () => {
  const { context, calls } = pairHarness((method, params) => word(params.length === 2 ? 10n : 7n));
  const query = { to: '0x' + 'aB'.repeat(20), data: '0xAB' };
  const first = context.readPair(query);
  query.data = '0xff';
  const [a, b] = await Promise.all([first, context.readPair({ to: '0x' + 'ab'.repeat(20), data: '0xab' })]);
  assert.deepEqual(a, { before: 10n, after: 7n, delta: -3n });
  assert.deepEqual(a, b);
  a.after = 999n;
  assert.equal(b.after, 7n);
  assert.equal((await context.readPair({ to: '0x' + 'AB'.repeat(20), data: '0xAB' })).after, 7n);
  assert.equal(calls.filter(call => call.method === 'eth_call').length, 2);
  assert.ok(calls.filter(call => call.method === 'eth_call').every(call => call.params[0].data === '0xab'));
});

test('query failures are cached without hidden retries or leaking provider details', async () => {
  const { context, calls } = pairHarness(() => { throw new Error('PRIVATE_PROVIDER_SECRET'); });
  const query = { to: TOKEN, data: '0x01' };
  const results = await Promise.allSettled([context.readPair(query), context.readPair(query)]);
  assert.ok(results.every(result => result.status === 'rejected'));
  await assert.rejects(context.readPair(query));
  assert.equal(calls.filter(call => call.method === 'eth_call').length, 1);
  assert.doesNotMatch(JSON.stringify(context.snapshotEvidence()), /PRIVATE_PROVIDER_SECRET/);
});

test('shared context limits distinct pairs and total requests before contacting the provider', async () => {
  const { context, calls } = pairHarness();
  await Promise.all(Array.from({ length: 12 }, (_, index) => context.readPair({ to: TOKEN, data: `0x${index.toString(16).padStart(2, '0')}` })));
  await assert.rejects(context.readPair({ to: TOKEN, data: '0xff' }), /12 token\/account pair/);
  assert.equal(calls.length, 26);
  await Promise.all(Array.from({ length: 38 }, () => context.verifyCanonical()));
  assert.equal(calls.length, 64);
  await assert.rejects(context.verifyCanonical(), /64-RPC limit/);
  assert.equal(calls.length, 64);
  assert.equal(context.snapshotEvidence().request.length, 64);
});

test('non-JSON and oversized results retain one sanitized terminal error per request', async () => {
  for (const result of [1n, undefined, 'PRIVATE_' + 'x'.repeat(8 * 1024 * 1024)]) {
    const { context, calls } = pairHarness(() => result);
    await assert.rejects(context.readPair({ to: TOKEN, data: '0x01' }), /non-JSON evidence|size limit/);
    const evidence = context.snapshotEvidence();
    assert.equal(evidence.request.length, calls.length);
    assert.equal(evidence.response.length, calls.length);
    assert.ok(evidence.response.at(-1).error.code.startsWith('STATE_'));
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_/);
  }
});

test('individually bounded responses cannot exceed the shared evidence budget', async () => {
  const block = { hash: word(42n), number: '42', timestamp: '123' };
  const request = { chainId: 999, from: ACCOUNT, to: TOKEN, value: '0', data: '0x' };
  const header = { hash: block.hash, number: '0x2a', timestamp: '0x7b', extra: 'x'.repeat(6 * 1024 * 1024) };
  let calls = 0;
  const context = createStateContext({ request, block, rpc: { async call(method) { calls++; return method === 'debug_traceCall' ? { pre: {}, post: {} } : header; } } });
  await context.prepare();
  for (let i = 0; i < 4; i++) await context.verifyCanonical();
  await assert.rejects(context.verifyCanonical(), /size limit/);
  assert.equal(calls, 7);
  const evidence = context.snapshotEvidence();
  assert.equal(evidence.request.length, evidence.response.length);
  assert.equal(evidence.response.at(-1).error.code, 'STATE_EVIDENCE_LIMIT');
  assert.equal(evidence.response.filter(record => record.result?.extra).length, 5);
  assert.ok(context.canonicalFailure);
});
