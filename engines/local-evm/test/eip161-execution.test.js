import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';

// Authenticated synthetic initial accounts and real bytecode execution. Neither
// provider poststate nor an expected execution result is supplied to the engine.
const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const TARGET = addr(0x4444), SECOND = addr(0x5555), MIDDLE = addr(0x6666);
const RIPEMD160 = addr(3), FLAG = '60005260206000f3', REVERT = '5060006000fd';
const emptyWithStorage = () => ({ nonce: 0n, balance: 0n, code: '0x', storage: { [word(0)]: 42n, [word(999)]: 99n } });
const call = (target, { kind = 'CALL', value = 0, gas = 65535 } = {}) =>
  '6000600060006000' + (['CALL', 'CALLCODE'].includes(kind) ? '60' + value.toString(16).padStart(2, '0') : '') +
  '73' + target.slice(2) + '61' + gas.toString(16).padStart(4, '0') +
  ({ CALL: 'f1', CALLCODE: 'f2', DELEGATECALL: 'f4', STATICCALL: 'fa' }[kind]);
const account = (f, target) => f.stateManager.getAccount(createAddressFromString(target));
const storage = (f, target, n) => f.stateManager.getStorage(createAddressFromString(target), bytes(word(n)))
  .then(value => value.length ? BigInt(bytesToHex(value)) : 0n);
const nonceChange = { address: SENDER, nonce: { before: '0x1', after: '0x2' } };
const removed = target => ({ address: target, existence: { before: true, after: false, basis: 'eip161_empty_account_cleanup' } });
async function stillPresent(f, target) {
  const value = await account(f, target);
  assert.ok(value); assert.equal(value.nonce, 0n); assert.equal(value.balance, 0n);
  assert.equal(await storage(f, target, 0), 42n); assert.equal(await storage(f, target, 999), 99n);
}
async function whollyRemoved(f, target) {
  const count = f.calls.length;
  assert.equal(await account(f, target), undefined);
  assert.equal(bytesToHex(await f.stateManager.getCode(createAddressFromString(target))), '0x');
  assert.equal(await storage(f, target, 0), 0n); assert.equal(await storage(f, target, 999), 0n);
  const copy = f.stateManager.shallowCopy();
  assert.equal(await copy.getAccount(createAddressFromString(target)), undefined);
  assert.ok((await copy.getStorage(createAddressFromString(target), bytes(word(1234)))).every(byte => byte === 0));
  assert.equal(f.calls.length, count, 'cleanup must cover storage not individually demanded before execution');
}
function cleanup(result, target, initialStorageRoot) {
  assert.deepEqual(result.lifecycle.emptyAccountCleanup.deletions, [{
    address: target, scope: 'entire_account_including_code_and_storage', initialStorageRoot,
  }]);
  assert.equal(result.lifecycle.emptyAccountCleanup.basis, 'eip161_transaction_end');
  assert.equal(result.lifecycle.emptyAccountCleanup.scope, 'unsigned_message_touches_no_fee_settlement');
  assert.ok(result.lifecycle.emptyAccountCleanup.touchedAccounts.includes(target));
}

for (const kind of ['CALL', 'STATICCALL']) test(`${kind} with zero value deletes a touched empty account and its nonempty storage`, async () => {
  const f = await lifecycleFixture({ code: '0x' + call(TARGET, { kind }) + FLAG, accounts: { [TARGET]: emptyWithStorage() } });
  const initialStorageRoot = bytesToHex((await account(f, TARGET)).storageRoot);
  assert.notEqual(initialStorageRoot, EMPTY_STORAGE_ROOT);
  assert.equal(await storage(f, TARGET, 0), 42n);
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success', JSON.stringify(result.execution));
  assert.equal(result.execution.returnData, word(1));
  cleanup(result, TARGET, initialStorageRoot);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [removed(TARGET), nonceChange]);
  await whollyRemoved(f, TARGET);
});

test('a zero-value root CALL also cleans up an existing empty destination', async () => {
  const f = await lifecycleFixture({ accounts: { [TARGET]: emptyWithStorage() } });
  const initialStorageRoot = bytesToHex((await account(f, TARGET)).storageRoot);
  const result = await executeEthereumCall({ ...f, request: { ...f.request, to: TARGET } });
  assert.equal(result.execution.status, 'success'); assert.equal(result.execution.returnData, '0x');
  cleanup(result, TARGET, initialStorageRoot); await whollyRemoved(f, TARGET);
});

test('BALANCE and access-list warming do not touch or delete an empty account', async () => {
  const f = await lifecycleFixture({ code: '0x73' + TARGET.slice(2) + '3160005260206000f3', accounts: { [TARGET]: emptyWithStorage() } });
  const result = await executeEthereumCall({ ...f, request: { ...f.request, accessList: [{ address: TARGET, storageKeys: [word(0)] }] } });
  assert.equal(result.execution.status, 'success'); assert.equal(result.execution.returnData, word(0));
  assert.equal(Object.hasOwn(result, 'lifecycle'), false);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [nonceChange]); await stillPresent(f, TARGET);
});

test('ordinary empty-account touches revert with their root or caught ancestor frame', async () => {
  for (const caught of [false, true]) {
    const body = '0x' + call(TARGET) + REVERT;
    const f = await lifecycleFixture({ code: caught ? '0x' + call(MIDDLE) + FLAG : body,
      accounts: { [TARGET]: emptyWithStorage(), [MIDDLE]: { nonce: 1n, code: body } } });
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, caught ? 'success' : 'reverted');
    assert.equal(result.execution.returnData, caught ? word(0) : '0x');
    assert.equal(Object.hasOwn(result, 'lifecycle'), false);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [nonceChange]); await stillPresent(f, TARGET);
  }
});

test('a failed RIPEMD160 call retains its sticky touch through child and root reverts', async () => {
  for (const rootReverts of [false, true]) {
    const f = await lifecycleFixture({ code: '0x' + call(RIPEMD160, { gas: 1 }) + (rootReverts ? REVERT : FLAG), accounts: { [RIPEMD160]: emptyWithStorage() } });
    const initialStorageRoot = bytesToHex((await account(f, RIPEMD160)).storageRoot);
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, rootReverts ? 'reverted' : 'success', JSON.stringify(result.execution));
    assert.equal(result.trace.calls[0].error, 'out of gas');
    assert.equal(result.execution.returnData, rootReverts ? '0x' : word(0));
    cleanup(result, RIPEMD160, initialStorageRoot);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [removed(RIPEMD160), nonceChange]); await whollyRemoved(f, RIPEMD160);
  }
});

test('failed SHA256 has no RIPEMD160 sticky-touch exception', async () => {
  const target = addr(2), f = await lifecycleFixture({ code: '0x' + call(target, { gas: 1 }) + FLAG, accounts: { [target]: emptyWithStorage() } });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success'); assert.equal(result.trace.calls[0].error, 'out of gas');
  assert.equal(Object.hasOwn(result, 'lifecycle'), false); await stillPresent(f, target);
});

test('a zero-value call to proven absence remains absent without a fabricated deletion', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(TARGET) + FLAG });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success'); assert.equal(result.execution.returnData, word(1));
  assert.equal(Object.hasOwn(result, 'lifecycle'), false);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [nonceChange]); await whollyRemoved(f, TARGET);
});

test('positive funding retains both initially empty and initially absent recipients', async () => {
  for (const exists of [false, true]) {
    const f = await lifecycleFixture({ code: '0x' + call(TARGET, { value: 7 }) + FLAG, accounts: exists ? { [TARGET]: emptyWithStorage() } : {} });
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, 'success'); assert.equal(result.execution.returnData, word(1));
    assert.equal(Object.hasOwn(result, 'lifecycle'), false);
    assert.equal((await account(f, TARGET)).balance, 7n); assert.equal((await account(f, FACTORY)).balance, 993n);
    assert.equal((await account(f, TARGET)).nonce, 0n);
    assert.equal(await storage(f, TARGET, 999), exists ? 99n : 0n);
    const changed = f.stateManager.snapshotChanges().accounts.find(row => row.address === TARGET);
    assert.deepEqual(changed.balance, { before: '0x0', after: '0x7' });
    assert.equal(changed.existence?.after ?? true, true);
  }
});

test('DELEGATECALL and CALLCODE do not touch their separate empty code address', async () => {
  for (const kind of ['DELEGATECALL', 'CALLCODE']) {
    const f = await lifecycleFixture({ code: '0x' + call(TARGET, { kind }) + FLAG, accounts: { [TARGET]: emptyWithStorage() } });
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, 'success'); assert.equal(result.execution.returnData, word(1));
    assert.equal(result.trace.calls[0].to, TARGET); assert.equal(result.trace.calls[0].executionAddress, FACTORY);
    assert.equal(Object.hasOwn(result, 'lifecycle'), false);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [nonceChange]); await stillPresent(f, TARGET);
  }
});

test('host failure after partial cleanup restores both accounts, storage and sender nonce', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(TARGET) + '50' + call(SECOND) + FLAG,
    accounts: { [TARGET]: emptyWithStorage(), [SECOND]: emptyWithStorage() } });
  const original = f.stateManager.deleteAccount.bind(f.stateManager), deleted = [];
  f.stateManager.deleteAccount = async address => { await original(address); deleted.push(address.toString()); if (deleted.length === 2) throw Error('synthetic cleanup failure'); };
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'unavailable'); assert.equal(result.stateDisposition, 'rolled_back');
  assert.deepEqual(deleted.sort(), [TARGET, SECOND]); assert.equal(Object.hasOwn(result, 'lifecycle'), false);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []); assert.equal((await account(f, SENDER)).nonce, 1n);
  await stillPresent(f, TARGET); await stillPresent(f, SECOND);
  // A fresh invocation also checks that the exceptional cleanup window closed.
  f.stateManager.deleteAccount = original;
  const retry = await executeEthereumCall(f); assert.equal(retry.execution.status, 'success');
  await whollyRemoved(f, TARGET); await whollyRemoved(f, SECOND);
});

test('a host deadline during cleanup rolls back completed deletions and closes the cleanup window', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(TARGET) + FLAG, accounts: { [TARGET]: emptyWithStorage() } });
  let expired = false;
  const original = f.stateManager.deleteAccount.bind(f.stateManager);
  f.stateManager.deleteAccount = async address => { await original(address); expired = true; };
  const result = await executeEthereumCall({ ...f, limits: { wallMs: 100 }, now: () => expired ? 101 : 0 });
  assert.equal(result.execution.status, 'unavailable'); assert.equal(result.execution.error.code, 'LOCAL_RESOURCE_LIMIT');
  assert.equal(result.stateDisposition, 'rolled_back'); assert.equal(Object.hasOwn(result, 'lifecycle'), false);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []); assert.equal((await account(f, SENDER)).nonce, 1n);
  await stillPresent(f, TARGET);
  f.stateManager.deleteAccount = original;
  assert.equal((await executeEthereumCall(f)).execution.status, 'success'); await whollyRemoved(f, TARGET);
});
