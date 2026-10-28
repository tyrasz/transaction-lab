import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { lifecycleFixture, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';

const address = createAddressFromString(FACTORY);
const code = '0x73' + SENDER.slice(2) + 'ff';
const fixture = (storage = { [word(0)]: 41n, [word(1)]: 99n }) => lifecycleFixture({
  code, accounts: { [FACTORY]: { nonce: 7n, balance: 11n, code, storage } },
});
const zero = value => assert.equal(value.some(byte => byte !== 0), false);

test('Shanghai whole-account reset masks both demanded and unknown storage and survives a query copy', async () => {
  const f = await fixture(), s = f.stateManager;
  assert.equal(bytesToHex(await s.getStorage(address, bytes(word(0)))), word(41));
  await s.checkpoint();
  const row = await s.finalizeShanghaiContractDeletion(address);
  assert.equal(row.address, FACTORY);
  assert.equal(row.initialStorageRoot, f.inputs.snapshotInputs().provenance.find(p => p.account === FACTORY).accountProof.storageRoot);
  await s.commit();
  const reads = f.calls.length;
  for (const state of [s, s.shallowCopy()]) {
    assert.equal(await state.getAccount(address), undefined);
    assert.equal(bytesToHex(await state.getCode(address)), '0x');
    zero(await state.getStorage(address, bytes(word(0))));
    zero(await state.getStorage(address, bytes(word(1))));
    assert.deepEqual(state.snapshotChanges().accounts, [{ address: FACTORY,
      existence: { before: true, after: false, basis: 'shanghai_selfdestruct_deletion' },
      balance: { before: '0xb', after: '0x0' },
    }]);
  }
  assert.equal(f.calls.length, reads, 'No old storage proof may resurrect a deleted namespace');
});

test('Shanghai deletion rolls back code, account and lazily read storage through nested checkpoints', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await s.checkpoint();
  await s.finalizeShanghaiContractDeletion(address);
  zero(await s.getStorage(address, bytes(word(1))));
  await s.revert();
  assert.equal((await s.getAccount(address)).nonce, 7n);
  assert.equal(bytesToHex(await s.getCode(address)), code);
  assert.equal(bytesToHex(await s.getStorage(address, bytes(word(1)))), word(99));
  await s.commit();
  assert.deepEqual(s.snapshotChanges().accounts, []);
});

test('transient funding of deleted code cannot escape as a balance-only row or outer commit', async () => {
  const f = await fixture({}), s = f.stateManager;
  await s.checkpoint(); await s.finalizeShanghaiContractDeletion(address); await s.commit();
  const before = s.snapshotChanges();
  await assert.rejects(s.putAccount(address, new Account(0n, 1n)), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.checkpoint();
  await s.putAccount(address, new Account(0n, 1n));
  assert.equal((await s.getAccount(address)).balance, 1n);
  assert.throws(() => s.snapshotChanges(), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await assert.rejects(s.commit(), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert();
  assert.deepEqual(s.snapshotChanges(), before);
  await s.checkpoint(); await s.putAccount(address, new Account()); await s.commit();
  assert.equal(await s.getAccount(address), undefined);
  assert.deepEqual(s.snapshotChanges(), before);
});

test('Shanghai deletion entrypoint requires a checkpoint and an execution-capable authenticated account', async () => {
  const f = await fixture(), s = f.stateManager;
  await assert.rejects(s.finalizeShanghaiContractDeletion(address), { code: 'LOCAL_STATE_INVALID' });
  await s.checkpoint();
  await assert.rejects(s.finalizeShanghaiContractDeletion(createAddressFromString(SENDER)), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await assert.rejects(s.deleteAccount(address), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert();
  assert.deepEqual(s.snapshotChanges().accounts, []);
});
