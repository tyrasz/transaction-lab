import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { ethereumCallGas, ethereumCommon, ethereumContextProfile } from '../ethereum-profile.js';
import { lifecycleFixture, createdAddress, initcode, RUNTIME, FACTORY, SENDER, word } from './lifecycle-fixture.js';

// Synthetic authenticated prestate and real EVM execution only. No provider
// trace, expected poststate or public-chain observation supplies input facts.
async function creation(init = '', options = {}) {
  const f = await lifecycleFixture(options);
  f.request = { ...f.request, to: null, data: '0x' + init };
  return f;
}
const target = () => createdAddress({ creator: SENDER, nonce: 1n });
const getter = account => ({ to: FACTORY, data: '0x70a08231' + account.slice(2).padStart(64, '0') });
const preview = (f, queries) => executeEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries });
const CREATION_FIELDS = ['operation', 'initcodeBytes', 'creationIntrinsicGas', 'initcodeWordGas'];

test('creation intrinsic charges exact initcode word boundaries, with unchanged legacy gas shape', async () => {
  const f = await creation(), common = ethereumCommon(f.header);
  for (const [length, intrinsic, wordGas] of [[0, 53000n, 0n], [1, 53006n, 2n], [31, 53126n, 2n], [32, 53130n, 2n], [33, 53136n, 4n]]) {
    const data = '0x' + '00'.repeat(length), costs = ethereumCallGas(data, common, { to: null });
    assert.equal(costs.intrinsic, intrinsic); assert.equal(costs.initcodeWordGas, wordGas);
    assert.equal(costs.creationIntrinsic, 32000n); assert.equal(costs.initcodeBytes, BigInt(length));
    assert.equal(costs.minimum, intrinsic); assert.equal(costs.floor, 21000n + 10n * BigInt(length));
    assert.deepEqual(ethereumContextProfile({ to: null, data }, f.header), {
      operation: 'create', initcodeBytes: String(length), creationIntrinsicGas: '32000', initcodeWordGas: String(wordGas),
    });
  }
  assert.deepEqual(ethereumCallGas('0x0001', common), { intrinsic: 21020n, floor: 21050n, minimum: 21050n, zeroBytes: 1n, nonzeroBytes: 1n });
  assert.deepEqual(ethereumContextProfile({ to: FACTORY, data: '0x0001' }, f.header), {});
});

test('creation charges duplicate access-list occurrences while the calldata floor stays independent', async () => {
  const f = await creation('00'), accessList = [
    { address: FACTORY, storageKeys: [word(0), word(0)] }, { address: FACTORY, storageKeys: [word(0)] },
  ];
  const request = { ...f.request, accessList }, costs = ethereumCallGas(request.data, ethereumCommon(f.header), request);
  assert.equal(costs.intrinsic, 63506n); assert.equal(costs.floor, 21010n);
  const profile = ethereumContextProfile(request, f.header);
  assert.deepEqual(profile.accessList, accessList); assert.notEqual(profile.accessList, accessList);
  assert.equal(profile.accessListIntrinsicGas, '10500'); assert.equal(profile.accessListAddressCount, '2');
  assert.equal(profile.accessListStorageKeyCount, '3'); assert.equal(profile.creationIntrinsicGas, '32000');
});

test('large initcode uses the active calldata floor without subtracting that floor from message gas', async () => {
  const f = await creation('00' + '01'.repeat(1999)); f.request.gas = '100970';
  const costs = ethereumCallGas(f.request.data, ethereumCommon(f.header), f.request);
  assert.equal(costs.intrinsic, 85114n); assert.equal(costs.floor, 100970n); assert.equal(costs.minimum, 100970n);
  const previous = ethereumCallGas(f.request.data, ethereumCommon({ ...f.header, timestamp: '1710338135' }), f.request);
  assert.equal(previous.intrinsic, 85114n); assert.equal(previous.floor, 0n); assert.equal(previous.minimum, 85114n);
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success'); assert.equal(result.execution.executionGasUsed, '0');
  assert.equal(result.profile.messageGasLimit, '15856'); assert.equal(result.profile.initcodeWordGas, '126');
  assert.deepEqual(result.gasAccounting, { beforeRefund: '85114', appliedRefund: '0', floorAdjustment: '15856', gasUsed: '100970' });
  const short = await creation(f.request.data.slice(2)); short.request.gas = '100969';
  assert.equal((await executeEthereumCall(short)).execution.status, 'invalid'); assert.equal(short.calls.length, 0);
});

test('empty initcode admits exactly 53000 gas and increments the proven sender nonce once', async () => {
  const f = await creation(); f.request.gas = '53000';
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success'); assert.equal(result.execution.executionGasUsed, '0');
  assert.equal(result.execution.returnData, '0x'); assert.equal(result.gasAccounting.gasUsed, '53000');
  assert.equal(result.trace.type, 'CREATE'); assert.equal(result.trace.to, target());
  assert.equal(result.trace.executionAddress, target()); assert.equal(result.trace.input, '0x'); assert.equal(result.trace.gas, '0x0');
  assert.equal((await f.stateManager.getAccount(createAddressFromString(SENDER))).nonce, 2n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(target()))).nonce, 1n);
  assert.equal(bytesToHex(await f.stateManager.getCode(createAddressFromString(target()))), '0x');
  const insufficient = await creation(); insufficient.request.gas = '52999';
  assert.equal((await executeEthereumCall(insufficient)).execution.status, 'invalid'); assert.equal(insufficient.calls.length, 0);
});

test('creation returns deployed runtime bytes and retains constructor writes without charging code deposit twice', async () => {
  const f = await creation(initcode()); f.request.value = '5';
  const result = await executeEthereumCall(f), address = createAddressFromString(target());
  assert.equal(result.execution.status, 'success'); assert.equal(result.profile.operation, 'create');
  assert.equal(result.execution.returnData, '0x' + RUNTIME); assert.equal(result.trace.output, '0x' + RUNTIME);
  assert.equal(result.profile.feesSettled, false); assert.equal(result.profile.outerSignatureVerified, false);
  assert.equal(bytesToHex(await f.stateManager.getCode(address)), '0x' + RUNTIME);
  assert.equal((await f.stateManager.getAccount(address)).balance, 5n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(SENDER))).balance, 999995n);
  const row = f.stateManager.snapshotChanges().accounts.find(item => item.address === target());
  assert.deepEqual(row.storage, [{ slot: word(0), before: word(0), after: word(42) }]);
  // Two PUSHes + a cold zero-to-nonzero SSTORE cost22106; the copy/return
  // constructor costs24 and the eleven runtime bytes cost2200 to deposit.
  assert.equal(result.execution.executionGasUsed, '24330');
  assert.equal(BigInt(result.gasAccounting.beforeRefund), BigInt(result.profile.intrinsicGas) + BigInt(result.execution.executionGasUsed));
});

test('the 32 KiB product initcode bound remains stricter than EIP-3860 and rejects before any proof read', async () => {
  const f = await creation('00'.repeat(32768)), result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success'); assert.equal(result.profile.initcodeBytes, '32768');
  assert.equal(result.profile.initcodeWordGas, '2048'); assert.equal(result.profile.intrinsicGas, '186120');
  const oversized = await creation('00'.repeat(32769));
  assert.equal((await executeEthereumCall(oversized)).execution.status, 'invalid'); assert.equal(oversized.calls.length, 0);
  assert.deepEqual(oversized.stateManager.snapshotChanges().accounts, []);
});

test('missing or malformed destinations, root salts, blob creation and insufficient gas never touch state', async () => {
  const changes = [
    r => { delete r.to; }, r => { r.to = undefined; }, r => { r.to = ''; }, r => { r.to = '0x'; },
    r => { r.to = [FACTORY]; }, r => { r.from = [SENDER]; }, r => { r.salt = word(1); },
    r => { r.operation = 'CREATE2'; }, r => { r.blobVersionedHashes = ['0x01' + '00'.repeat(31)]; },
    r => { r.gas = '52999'; }, r => { r.value = (1n << 256n).toString(); },
  ];
  for (const change of changes) {
    const f = await creation(); change(f.request);
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, 'invalid'); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  }
});

test('creation preview retains explicit getter identities and never turns an absent before-contract into zero', async () => {
  const getterCode = '60005460005260206000f3';
  const code = '0x361560' + (5 + getterCode.length / 2).toString(16).padStart(2, '0') + '57' + getterCode + '5b602a60005500';
  const call = '6000600060006000600073' + FACTORY.slice(2) + '61fffff150';
  const f = await creation(initcode(RUNTIME, call + '602a600055'), { code, accounts: { [FACTORY]: { nonce: 7n, balance: 1000n, code, storage: { [word(0)]: word(7) } } } });
  f.request.accessList = [{ address: FACTORY, storageKeys: [word(0), word(0)] }];
  const queries = [getter(SENDER), { to: target(), data: getter(SENDER).data }], result = await preview(f, queries);
  assert.equal(result.status, 'partial'); assert.equal(result.original.output.execution.status, 'success');
  assert.equal(result.original.output.trace.type, 'CREATE'); assert.equal(result.original.output.profile.operation, 'create');
  const measured = result.measurements[0]; assert.equal(measured.status, 'measured');
  assert.deepEqual(measured.query, queries[0]);
  assert.deepEqual(measured.values.map(({ beforeRaw, afterRaw, deltaRaw }) => ({ beforeRaw, afterRaw, deltaRaw })), [{ beforeRaw: '7', afterRaw: '42', deltaRaw: '35' }]);
  for (const side of [measured.before, measured.after]) {
    assert.equal(side.output.trace.type, 'CALL'); assert.equal(side.output.trace.to, FACTORY);
    assert.equal(side.mutationValidation.status, 'verified');
    for (const field of [...CREATION_FIELDS, 'accessList', 'accessListIntrinsicGas']) assert.equal(Object.hasOwn(side.output.profile, field), false);
  }
  const absentBefore = result.measurements[1]; assert.deepEqual(absentBefore.query, queries[1]);
  assert.equal(absentBefore.status, 'unavailable'); assert.equal(absentBefore.values, null);
  assert.equal(absentBefore.before.values, null); assert.equal(absentBefore.before.output.execution.returnData, '0x');
  assert.equal(absentBefore.after, null); assert.equal(result.usage.executions, 4);
  assert.deepEqual(result.original.changes.accounts.find(item => item.address === SENDER).nonce, { before: '0x1', after: '0x2' });
  assert.deepEqual(result.original.changes.accounts.find(item => item.address === target()).code, { before: '0x', after: '0x' + RUNTIME });
});

test('a genuine constructor revert remains completed while existing getters measure unchanged state', async () => {
  const f = await creation('602a60005560006000fd', { code: '0x60005460005260206000f3', accounts: { [FACTORY]: { nonce: 7n, code: '0x60005460005260206000f3', storage: { [word(0)]: word(7) } } } });
  const result = await preview(f, [getter(SENDER)]);
  assert.equal(result.status, 'complete'); assert.equal(result.original.output.execution.status, 'reverted');
  assert.equal(result.original.output.trace.type, 'CREATE'); assert.equal(result.original.output.trace.to, target());
  assert.deepEqual(result.original.changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
  assert.deepEqual(result.measurements[0].values.map(({ beforeRaw, afterRaw, deltaRaw }) => ({ beforeRaw, afterRaw, deltaRaw })), [{ beforeRaw: '7', afterRaw: '7', deltaRaw: '0' }]);
});

test('preview rejects malformed creation envelopes and forbidden blob context before state transport', async () => {
  for (const change of [r => { delete r.to; }, r => { r.to = ''; }, r => { r.salt = word(1); }, r => { r.data = '0x' + '00'.repeat(32769); }, r => { r.blobVersionedHashes = ['0x01' + '00'.repeat(31)]; }]) {
    const f = await creation(); change(f.request);
    const result = await preview(f, [getter(SENDER)]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_INPUT');
    assert.equal(result.original, null); assert.deepEqual(result.measurements, []); assert.equal(f.calls.length, 0);
  }
});
