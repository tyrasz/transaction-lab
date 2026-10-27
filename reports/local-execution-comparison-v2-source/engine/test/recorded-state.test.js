import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createRecordedStateManager } from '../recorded-state.js';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const address = createAddressFromString(A), absent = createAddressFromString(B);
const slot = '0x' + '00'.repeat(32), otherSlot = '0x' + '00'.repeat(31) + '01';
const value = '0x' + '00'.repeat(31) + '07';
const entry = () => ({ exists: true, nonce: '3', balance: '100', code: '0x600100', storage: { [slot]: value } });
const create = extra => createRecordedStateManager({ accounts: { [A]: entry(), ...extra } });
const hasCode = code => error => error.code === code;

test('recorded input preserves explicit zero and rejects an unknown slot instead of inventing zero', async () => {
  const record = entry(); record.storage[slot] = '0x' + '00'.repeat(32);
  const state = await createRecordedStateManager({ accounts: { [A]: record } });
  assert.equal(BigInt(bytesToHex(await state.getStorage(address, hexToBytes(slot)))), 0n);
  await assert.rejects(state.getStorage(address, hexToBytes(otherSlot)), error => error.code === 'LOCAL_STATE_MISSING' && error.detail.slot === otherSlot);
  await assert.rejects(state.putStorage(address, hexToBytes(otherSlot), new Uint8Array([1])), hasCode('LOCAL_STATE_MISSING'));
  assert.deepEqual(state.snapshotChanges().accounts, []);
});

test('missing account, code and storage are unavailable while explicitly absent account remains distinct', async () => {
  const state = await create();
  for (const read of [() => state.getAccount(absent), () => state.getCode(absent), () => state.getStorage(absent, hexToBytes(slot))]) await assert.rejects(read(), hasCode('LOCAL_STATE_MISSING'));
  const knownAbsent = await create({ [B]: { exists: false } });
  assert.equal(await knownAbsent.getAccount(absent), undefined);
  assert.equal(bytesToHex(await knownAbsent.getCode(absent)), '0x');
  assert.equal(bytesToHex(await knownAbsent.getStorage(absent, hexToBytes(slot))), '0x');
  await assert.rejects(knownAbsent.putAccount(absent, new Account()), hasCode('LOCAL_STATE_UNSUPPORTED'));
});

test('nested checkpoints commit successful child changes and roll back reverted parent state', async () => {
  const state = await create();
  await state.checkpoint();
  let account = await state.getAccount(address); account.nonce++; await state.putAccount(address, account);
  await state.checkpoint();
  await state.putStorage(address, hexToBytes(slot), new Uint8Array([9]));
  await state.commit();
  assert.equal(state.snapshotChanges().accounts[0].storage[0].after, '0x' + '00'.repeat(31) + '09');
  await state.revert();
  assert.deepEqual(state.snapshotChanges().accounts, []);
  assert.equal((await state.getAccount(address)).nonce, 3n);
  assert.equal(BigInt(bytesToHex(await state.getStorage(address, hexToBytes(slot)))), 7n);
  assert.ok(state.snapshotReads().reads.some(read => read.kind === 'account'), 'Attempted read evidence survives a revert');
});

test('zeroing a known slot and later reverting never converts it into unknown state', async () => {
  const state = await create();
  await state.checkpoint();
  await state.putStorage(address, hexToBytes(slot), new Uint8Array());
  assert.equal(bytesToHex(await state.getStorage(address, hexToBytes(slot))), '0x');
  assert.equal(state.snapshotChanges().accounts[0].storage[0].after, '0x' + '00'.repeat(32));
  await state.revert();
  assert.equal(BigInt(bytesToHex(await state.getStorage(address, hexToBytes(slot)))), 7n);
});

test('external input and returned mutable arrays/accounts cannot change the recorded base', async () => {
  const record = entry(), state = await createRecordedStateManager({ accounts: { [A]: record } });
  record.storage[slot] = '0x' + 'ff'.repeat(32); record.balance = '999';
  const account = await state.getAccount(address); account.balance = 999n;
  const code = await state.getCode(address); code[0] = 0;
  const storage = await state.getStorage(address, hexToBytes(slot)); storage[31] = 0;
  assert.equal((await state.getAccount(address)).balance, 100n);
  assert.equal(bytesToHex(await state.getCode(address)), '0x600100');
  assert.equal(bytesToHex(await state.getStorage(address, hexToBytes(slot))), value);
  assert.deepEqual(state.snapshotChanges().accounts, []);
});

test('unsupported lifecycle mutations and unbalanced checkpoints cannot destroy recorded facts', async () => {
  const state = await create();
  for (const write of [() => state.putCode(address, new Uint8Array()), () => state.deleteAccount(address), () => state.clearStorage(address)]) await assert.rejects(write(), hasCode('LOCAL_STATE_UNSUPPORTED'));
  for (const operation of ['commit', 'revert']) await assert.rejects(state[operation](), hasCode('LOCAL_STATE_INVALID'));
  assert.throws(() => state.shallowCopy(), hasCode('LOCAL_STATE_UNSUPPORTED'));
  assert.deepEqual(state.snapshotChanges().accounts, []);
});

test('input records reject omitted basic fields, unknown fields and case-colliding addresses/slots', async () => {
  for (const field of ['nonce', 'balance', 'code', 'storage']) {
    const record = entry(); delete record[field];
    await assert.rejects(createRecordedStateManager({ accounts: { [A]: record } }), hasCode('LOCAL_STATE_INVALID'));
  }
  await assert.rejects(createRecordedStateManager({ accounts: { [A]: { ...entry(), unknown: '0' } } }), hasCode('LOCAL_STATE_INVALID'));
  const mixed = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  await assert.rejects(createRecordedStateManager({ accounts: { [mixed]: entry(), [mixed.toUpperCase().replace('0X', '0x')]: entry() } }), hasCode('LOCAL_STATE_INVALID'));
  const wordA = '0x' + 'ab'.repeat(32), record = entry(); record.storage = { [wordA]: value, [wordA.toUpperCase().replace('0X', '0x')]: value };
  await assert.rejects(createRecordedStateManager({ accounts: { [A]: record } }), hasCode('LOCAL_STATE_INVALID'));
});

test('nonce, balance, code and storage bounds reject malformed or oversized state', async () => {
  for (const override of [{ nonce: (1n << 64n).toString() }, { balance: '-1' }, { balance: 1 }, { code: '0xz0' }, { code: '0x' + '00'.repeat(262145) }, { storage: { '0x01': value } }, { storage: { [slot]: ['0x' + '00'.repeat(32)] } }]) {
    await assert.rejects(createRecordedStateManager({ accounts: { [A]: { ...entry(), ...override } } }), hasCode('LOCAL_STATE_INVALID'));
  }
});
