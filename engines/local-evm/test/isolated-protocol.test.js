import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, normalizeLimits, validateRpcRequest } from '../isolated-protocol.js';
const blockHash = '0x' + 'ab'.repeat(32), address = '0x' + '12'.repeat(20), slot = '0x' + '00'.repeat(32);
const request = () => ({ v: 1, type: 'rpc', id: 1, method: 'eth_getProof', params: [address, [slot], { blockHash, requireCanonical: true }] });

test('protocol admits only canonical proof/code selectors, bounded unique slots and sequential IDs', () => {
  assert.doesNotThrow(() => validateRpcRequest(request(), blockHash, 1));
  assert.doesNotThrow(() => validateRpcRequest({ ...request(), method: 'eth_getCode', params: [address, { blockHash, requireCanonical: true }] }, blockHash, 1));
  for (const change of [{ method: 'eth_call' }, { id: '1' }, { v: 2 }, { extra: true }, { params: [address, [slot, slot], { blockHash, requireCanonical: true }] }, { params: [address, ['0x0'], { blockHash, requireCanonical: true }] }]) assert.throws(() => validateRpcRequest({ ...request(), ...change }, blockHash, 1));
  assert.throws(() => validateRpcRequest(request(), blockHash, 2));
});

test('JSON boundaries reject accessors, hidden fields, sparse arrays and UTF8 byte overflow', () => {
  let invoked = false; const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { invoked = true; return 1; } });
  for (const value of [getter, { toJSON() { invoked = true; } }, Array(1), { value: NaN }, { value: 1n }]) assert.throws(() => encode(value, 1024));
  assert.equal(invoked, false); assert.throws(() => encode('é'.repeat(10), 20));
  assert.throws(() => decode('"' + 'é'.repeat(10) + '"', 20)); assert.throws(() => decode('{}trailing', 1024));
  const safe = { value: 'é', entries: [0, true, null] }; assert.deepEqual(decode(encode(safe, 1024), 1024), safe);
});

test('all configured limits only tighten fixed ceilings, and nested clocks respect process deadline', () => {
  const limits = normalizeLimits({ wallMs: 250, heapMiB: 64, inputs: { slots: 3 }, execution: { steps: 100 } });
  assert.equal(limits.inputs.wallMs, 250); assert.equal(limits.execution.wallMs, 250); assert.equal(limits.inputs.slots, 3);
  for (const value of [{ wallMs: 145001 }, { heapMiB: 512 }, { heapMiB: 32 }, { calls: 0 }, { execution: { steps: 1000001 } }, { inputs: { poststate: {} } }, { workerPath: '/tmp/worker' }]) assert.throws(() => normalizeLimits(value));
});

test('data boundaries reject proxy traps and inherited array serializers before executing caller code', () => {
  let invoked = 0;
  const trap = () => { invoked++; throw new Error('must not execute'); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const array = [];
  Object.setPrototypeOf(array, { toJSON: trap });
  for (const value of [proxy, { nested: proxy }, array]) assert.throws(() => encode(value, 1024));
  assert.throws(() => normalizeLimits(proxy)); assert.equal(invoked, 0);
});
