import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalSimulation, simulateLocal } from '../src/local-simulation.js';
import { validateStandardSimulation } from '../src/standard-simulation.js';
import { InputError } from '../src/validate.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { lifecycleFixture, FACTORY, SENDER } from '../engines/local-evm/test/lifecycle-fixture.js';
import { authorizationFixture, AUTHORITY, DELEGATE, TARGET, RETURN42, query as authorizationQuery } from '../engines/local-evm/test/authorization-fixture.js';

const tuple = () => ({ chainId: '0x1', address: '0x3333333333333333333333333333333333333333', nonce: '0x0', yParity: '0x0', r: '0x0', s: '0x0' });
const query = { to: FACTORY, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') };
const input = () => ({ chainId: 1, from: SENDER, to: FACTORY, data: '0x', value: '0', queries: [query] });

test('local admission detaches ordered authorizations while provider admission remains unchanged', () => {
  const original = { ...input(), authorizationList: [tuple(), tuple()] }, normalized = validateLocalSimulation(original);
  assert.deepEqual(normalized.authorizationList, original.authorizationList); assert.notEqual(normalized.authorizationList, original.authorizationList);
  original.authorizationList[0].nonce = '0x1'; assert.equal(normalized.authorizationList[0].nonce, '0x0');
  assert.equal(Object.hasOwn(validateLocalSimulation(input()), 'authorizationList'), false);
  assert.throws(() => validateStandardSimulation({ ...input(), authorizationList: [tuple()] }), InputError);
});

test('invalid and incompatible local authorization inputs are rejected before transport', async () => {
  for (const change of [{ authorizationList: [] }, { authorizationList: undefined }, { authorizationList: null },
    { authorizationList: Array.from({ length: 17 }, tuple) }, { authorizationList: [{ ...tuple(), chainId: 1 }] },
    { authorizationList: [{ ...tuple(), nonce: '0x10000000000000000' }] }, { authorizationList: [{ ...tuple(), yParity: '0x100' }] },
    { authorizationList: [{ ...tuple(), r: '0x00' }] }, { authorizationList: [{ ...tuple(), authority: SENDER }] },
    { authorizationList: [tuple()], to: null }, { authorizationList: [tuple()], blobVersionedHashes: ['0x01' + 'ab'.repeat(31)] }]) {
    await assert.rejects(simulateLocal({ ...input(), ...change }, { call() { assert.fail('Invalid authorization dispatched'); } }), InputError);
  }
  const bad = input(); Object.defineProperty(bad, 'authorizationList', { enumerable: true, get() { assert.fail('Accessor executed'); } });
  assert.throws(() => validateLocalSimulation(bad), InputError);
});

// Synthetic MPT state and invalid-signature tuples intentionally exercise the
// accepted-but-skipped protocol path through the actual API/transport/child.
test('actual local API forwards original authorizations and keeps fresh queries authorization-free', async () => {
  const f = await lifecycleFixture({ code: '0x602a60005260206000f3' }), wires = [];
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request);
    const result = request.method === 'eth_chainId' ? '0x1' : ['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(request.method) ? f.header : await f.rpc.call(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  const result = await simulateLocal({ ...input(), block: f.header.hash, authorizationList: [tuple()] }, rpc);
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.equal(result.execution.status, 'success');
  assert.equal(result.source.canonicalStatus, 'verified'); assert.deepEqual(result.apiRequest.authorizationList, [tuple()]);
  const preview = result.attempt.preview, original = preview.original.output;
  assert.equal(original.profile.authorizationCount, '1'); assert.equal(original.profile.authorizationIntrinsicGas, '25000');
  assert.equal(original.profile.intrinsicGas, '46000'); assert.equal(original.authorizationProcessing.gasRefundCounter, '0');
  assert.deepEqual(original.authorizationProcessing.entries, [{ index: 0, authority: null, status: 'skipped', reason: 'invalid_signature' }]);
  assert.equal(preview.measurements[0].status, 'measured'); assert.equal(preview.measurements[0].values[0].beforeRaw, '42');
  assert.equal(preview.measurements[0].values[0].afterRaw, '42');
  for (const side of ['before', 'after']) {
    const probe = preview.measurements[0][side].output;
    assert.equal(Object.hasOwn(probe.profile, 'authorizationList'), false); assert.equal(Object.hasOwn(probe, 'authorizationProcessing'), false);
    assert.equal(probe.profile.intrinsicGas, '21432');
  }
  assert.equal(wires.at(-1).method, 'eth_getBlockByNumber');
});

test('API retains applied authority changes and refund on both original success and revert', async () => {
  for (const [status, targetCode] of [['success', '0x' + RETURN42], ['reverted', '0x3615600f57' + RETURN42 + '5b60006000fd']]) {
    const f = await authorizationFixture({ targetCode });
    const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const result = request.method === 'eth_chainId' ? '0x1' : ['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(request.method) ? f.header : await f.rpc.call(request.method, request.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } });
    const { gas, ...envelope } = f.request;
    const report = await simulateLocal({ ...envelope, chainId: 1, block: f.header.hash, queries: [authorizationQuery(TARGET)] }, rpc);
    assert.equal(report.status, 'complete', JSON.stringify(report.error)); assert.equal(report.execution.status, status);
    assert.equal(report.source.canonicalStatus, 'verified');
    const original = report.attempt.preview.original, output = original.output;
    assert.equal(output.authorizationProcessing.gasRefundCounter, '12500'); assert.equal(output.execution.gasRefundCounter, '0');
    assert.deepEqual(output.authorizationProcessing.entries, [{ index: 0, authority: AUTHORITY, status: 'applied', reason: null }]);
    const beforeRefund = 46000n + BigInt(output.execution.executionGasUsed), capped = beforeRefund / 5n < 12500n ? beforeRefund / 5n : 12500n;
    assert.equal(output.gasAccounting.beforeRefund, beforeRefund.toString()); assert.equal(output.gasAccounting.appliedRefund, capped.toString());
    assert.equal(output.gasAccounting.gasUsed, (beforeRefund - capped).toString());
    const authority = original.changes.accounts.find(row => row.address === AUTHORITY);
    assert.deepEqual(authority.nonce, { before: '0x0', after: '0x1' }); assert.deepEqual(authority.code, { before: '0x', after: '0xef0100' + DELEGATE.slice(2) });
    assert.equal(report.measurements[0].values[0].beforeRaw, '42'); assert.equal(report.measurements[0].values[0].afterRaw, '42');
    const pair = report.attempt.preview.measurements[0];
    assert.deepEqual(pair.after.changesBefore, original.changes);
    for (const side of ['before', 'after']) {
      assert.equal(Object.hasOwn(pair[side].output, 'authorizationProcessing'), false);
      assert.equal(Object.hasOwn(pair[side].output.profile, 'authorizationList'), false);
    }
  }
});
