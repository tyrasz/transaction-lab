import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { lifecycleFixture, createdAddress, FACTORY, bytes, word } from './lifecycle-fixture.js';

const target = createdAddress(), address = createAddressFromString(target);
const zero = value => value.every(byte => byte === 0);
async function fixture(prefunded = false) {
  return lifecycleFixture({ accounts: prefunded ? { [target]: { nonce: 0n, balance: 17n, code: '0x' } } : {} });
}
async function create(manager) {
  await manager.getAccount(address);
  manager.beginContractCreation(address);
  await manager.putAccount(address, new Account(1n, 23n));
  await manager.putCode(address, bytes('0x600000'));
  await manager.putStorage(address, bytes(word(0)), bytes('0x2a'));
}

test('final deletion removes code and demanded and undemanded storage without loading more RPC inputs', async () => {
  for (const prefunded of [false, true]) {
    const { stateManager: manager, calls } = await fixture(prefunded);
    await manager.checkpoint(); await create(manager);
    await manager.finalizeCreatedContractDeletion(address); await manager.commit();
    const count = calls.length;
    assert.equal(await manager.getAccount(address), undefined);
    assert.equal(bytesToHex(await manager.getCode(address)), '0x');
    for (const n of [0, 1, 999]) assert.ok(zero(await manager.getStorage(address, bytes(word(n)))));
    assert.equal(calls.length, count);
    assert.deepEqual(manager.snapshotChanges().accounts, prefunded ? [{ address: target,
      existence: { before: true, after: false, basis: 'same_invocation_created_contract_deletion' },
      balance: { before: '0x11', after: '0x0' } }] : []);
    assert.equal(manager.created(target), false);
  }
});

test('nested deletion rollback restores the created account, code, storage and creation eligibility marker', async () => {
  const { stateManager: manager } = await fixture(true);
  await manager.checkpoint(); await create(manager);
  const before = manager.snapshotChanges();
  await manager.checkpoint(); await manager.finalizeCreatedContractDeletion(address);
  await manager.revert();
  assert.deepEqual(manager.snapshotChanges(), before);
  assert.equal((await manager.getAccount(address)).nonce, 1n);
  assert.equal(bytesToHex(await manager.getCode(address)), '0x600000');
  assert.equal(bytesToHex(await manager.getStorage(address, bytes(word(0)))), '0x2a');
  assert.equal(manager.created(target), true);
  await manager.revert(); assert.deepEqual(manager.snapshotChanges().accounts, []);
  assert.equal((await manager.getAccount(address)).balance, 17n);
});

test('a copied deletion can be funded and recreated without restoring old code or storage in either overlay', async () => {
  for (const prefunded of [false, true]) {
    const { stateManager: manager } = await fixture(prefunded);
    await manager.checkpoint(); await create(manager);
    await manager.finalizeCreatedContractDeletion(address); await manager.commit();
    const copy = manager.shallowCopy();
    await copy.putAccount(address, new Account(0n, 31n));
    assert.equal((await copy.getAccount(address)).balance, 31n);
    assert.equal(await manager.getAccount(address), undefined);
    assert.equal(bytesToHex(await copy.getCode(address)), '0x');
    assert.ok(zero(await copy.getStorage(address, bytes(word(0)))));
    await assert.rejects(copy.putStorage(address, bytes(word(1)), bytes('0x01')), { code: 'LOCAL_STATE_UNSUPPORTED' });
    await copy.checkpoint(); await copy.clearStorage(address); copy.beginContractCreation(address);
    await copy.putAccount(address, new Account(1n, 31n)); await copy.putCode(address, bytes('0x600100'));
    await copy.putStorage(address, bytes(word(1)), bytes('0x63'));
    await copy.commit();
    assert.ok(zero(await copy.getStorage(address, bytes(word(0)))));
    assert.equal(bytesToHex(await copy.getStorage(address, bytes(word(1)))), '0x63');
    assert.ok(zero(await manager.getStorage(address, bytes(word(1)))));
    assert.equal(bytesToHex(await manager.getCode(address)), '0x');
    assert.deepEqual(copy.snapshotChanges().accounts[0].storage, [{ slot: word(1), before: word(0), after: word(99) }]);
  }
});

test('zero-value touches after deletion stay absent and rollback preserves the deletion marker', async () => {
  const { stateManager: manager } = await fixture(true);
  await manager.checkpoint(); await create(manager); await manager.finalizeCreatedContractDeletion(address); await manager.commit();
  const before = manager.snapshotChanges();
  await manager.checkpoint(); await manager.putAccount(address, new Account());
  assert.equal(await manager.getAccount(address), undefined);
  await manager.putAccount(address, new Account(0n, 3n)); await manager.revert();
  assert.deepEqual(manager.snapshotChanges(), before);
  assert.equal(await manager.getAccount(address), undefined);
});

test('deletion requires a checkpoint and a retained authenticated creation marker', async () => {
  const { stateManager: manager } = await fixture(true);
  await assert.rejects(manager.finalizeCreatedContractDeletion(address), { code: 'LOCAL_STATE_INVALID' });
  await manager.checkpoint();
  await assert.rejects(manager.finalizeCreatedContractDeletion(address), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await assert.rejects(manager.finalizeCreatedContractDeletion(createAddressFromString(FACTORY)), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await create(manager); await manager.finalizeCreatedContractDeletion(address);
  await assert.rejects(manager.finalizeCreatedContractDeletion(address), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await manager.revert(); assert.deepEqual(manager.snapshotChanges().accounts, []);
});
