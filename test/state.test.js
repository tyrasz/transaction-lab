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
});
