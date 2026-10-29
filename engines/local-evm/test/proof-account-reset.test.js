// Direct controls use authenticated synthetic prestate. They exercise retained
// manager namespaces without claiming a public multi-transaction API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { lifecycleFixture, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';

const ADDRESS = createAddressFromString(FACTORY), ZERO = word(0);
const OLD_CODE = '0x73' + SENDER.slice(2) + 'ff';
const NEW_CODE = '0x60005460005260206000f3';
const fixture = (overrides = {}) => lifecycleFixture({ accounts: {
  [FACTORY]: { nonce: 7n, balance: 11n, code: OLD_CODE, storage: { [word(0)]: 41n, [word(991)]: 99n }, ...overrides },
} });
const value = async (state, slot) => { const bytes = await state.getStorage(ADDRESS, hexToBytes(word(slot))); return bytes.length ? BigInt(bytesToHex(bytes)) : 0n; };
const row = state => state.snapshotChanges().accounts.find(item => item.address === FACTORY);
const root = state => state.base.get(FACTORY).storageRoot;
async function deleted(f) { await f.stateManager.checkpoint(); await f.stateManager.finalizeShanghaiContractDeletion(ADDRESS); await f.stateManager.commit(); }
async function create(state, { code = NEW_CODE, balance = 0n } = {}) {
  await state.putAccount(ADDRESS, new Account(0n, balance));
  await state.clearStorage(ADDRESS); state.beginContractCreation(ADDRESS);
  await state.putAccount(ADDRESS, new Account(1n, balance));
  if (code !== '0x') await state.putCode(ADDRESS, bytes(code));
}
async function masked(state) {
  assert.equal(await state.getAccount(ADDRESS), undefined);
  assert.equal(bytesToHex(await state.getCode(ADDRESS)), '0x');
  assert.equal(await value(state, 0), 0n); assert.equal(await value(state, 991), 0n);
}

test('funding a deleted nonempty account retains explicit reset provenance and no old namespace', async () => {
  const f = await fixture(), s = f.stateManager;
  assert.equal(await value(s, 0), 41n); await deleted(f);
  const calls = f.calls.length, initialRoot = root(s), prior = s.snapshotChanges();
  await assert.rejects(s.putAccount(ADDRESS, new Account(0n, 5n)), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.checkpoint(); await s.putAccount(ADDRESS, new Account(0n, 5n)); await s.commit();
  assert.deepEqual(row(s), { address: FACTORY, nonce: { before: '0x7', after: '0x0' }, balance: { before: '0xb', after: '0x5' }, reset: { basis: 'shanghai_selfdestruct_deletion', initialStorageRoot: initialRoot }, code: { before: OLD_CODE, after: '0x' } });
  assert.equal(await value(s, 0), 0n); assert.equal(await value(s, 991), 0n); assert.equal(await value(s, 992), 0n);
  assert.equal(f.calls.length, calls); assert.notDeepEqual(s.snapshotChanges(), prior);
  const copy = s.shallowCopy(); assert.deepEqual(copy.snapshotChanges(), s.snapshotChanges());
  assert.equal((await copy.getAccount(ADDRESS)).balance, 5n); assert.equal(await value(copy, 991), 0n);
});

test('recreation writes use zero baselines, retain old-equal values, and never fetch old slot proofs', async () => {
  const f = await fixture(), s = f.stateManager; await deleted(f);
  const calls = f.calls.length; await s.checkpoint(); await create(s, { balance: 3n });
  await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(41)));
  await s.putStorage(ADDRESS, bytes(word(23)), bytes(word(88)));
  await s.putStorage(ADDRESS, bytes(word(24)), bytes(word(5))); await s.putStorage(ADDRESS, bytes(word(24)), new Uint8Array());
  await s.commit();
  assert.deepEqual(row(s).storage, [{ slot: word(0), before: ZERO, after: word(41) }, { slot: word(23), before: ZERO, after: word(88) }]);
  assert.deepEqual(row(s).code, { before: OLD_CODE, after: NEW_CODE });
  assert.equal(await value(s, 991), 0n); assert.equal(await value(s, 24), 0n); assert.equal(f.calls.length, calls);
  assert.equal(s.base.get(FACTORY).storage.size, 0, 'immutable proofs are not invented for the cleared namespace');
  await assert.rejects(s.clearStorage(ADDRESS), { code: 'LOCAL_STATE_UNSUPPORTED' });
});

test('a lazily discovered old proof seeds each rollback namespace independently', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await s.checkpoint(); await s.finalizeShanghaiContractDeletion(ADDRESS); await s.checkpoint();
  // Explicitly demand the immutable fact after reset to stress the lazy loader:
  // it must seed the two original ancestor frames, but neither reset frame.
  await s.loadSlot(FACTORY, word(991));
  assert.equal(await value(s, 991), 0n); await s.commit(); assert.equal(await value(s, 991), 0n);
  await s.revert(); assert.equal(await value(s, 991), 99n);
  assert.equal((await s.getAccount(ADDRESS)).nonce, 7n); assert.equal(bytesToHex(await s.getCode(ADDRESS)), OLD_CODE);
  await s.commit(); assert.deepEqual(s.snapshotChanges().accounts, []);
});

test('nested recreation commits roll back atomically and independent copies retain their own namespaces', async () => {
  const f = await fixture(), s = f.stateManager; await deleted(f); const prior = s.snapshotChanges();
  await s.checkpoint(); await s.checkpoint(); await create(s); await s.putStorage(ADDRESS, bytes(word(23)), bytes(word(88))); await s.commit();
  assert.equal(await value(s, 23), 88n); await s.revert(); await masked(s); assert.deepEqual(s.snapshotChanges(), prior);
  const first = s.shallowCopy(), second = s.shallowCopy();
  await first.checkpoint(); await create(first); await first.putStorage(ADDRESS, bytes(word(23)), bytes(word(88))); await first.commit();
  await masked(second); await masked(s); assert.equal(await value(first, 23), 88n);
  await first.checkpoint(); await first.putStorage(ADDRESS, bytes(word(23)), bytes(word(77))); await first.revert(); assert.equal(await value(first, 23), 88n);
});

test('repeated deletion clears new writes and records the original root when a recreated contract is deleted', async () => {
  const f = await fixture({ nonce: 1n, code: NEW_CODE }), s = f.stateManager;
  await deleted(f); const initialRoot = root(s); await s.checkpoint(); await create(s); await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(41)));
  const metadata = await s.finalizeCreatedContractDeletion(ADDRESS); await s.commit();
  assert.deepEqual(metadata, { address: FACTORY, scope: 'entire_account_including_code_and_storage', initialStorageRoot: initialRoot });
  await masked(s); assert.equal(row(s).existence.basis, 'same_invocation_created_contract_deletion');
  await s.checkpoint(); await create(s, { balance: 11n }); await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(41))); await s.commit();
  assert.deepEqual(row(s), { address: FACTORY, reset: { basis: 'same_invocation_created_contract_deletion', initialStorageRoot: initialRoot }, storage: [{ slot: word(0), before: ZERO, after: word(41) }] });
  assert.equal(await value(s, 991), 0n, 'an unchanged code/nonce/balance tuple still has a different cleared trie');
});

test('a reset removes stale authorization write authority and rollback restores the previous incarnation', async () => {
  const f = await fixture(), s = f.stateManager; await deleted(f);
  await s.checkpoint(); await s.applyAuthorization(ADDRESS, 0n, SENDER); await s.putStorage(ADDRESS, bytes(word(23)), bytes(word(1))); await s.commit();
  const prior = s.snapshotChanges(); await s.checkpoint(); await s.finalizeShanghaiContractDeletion(ADDRESS);
  await s.putAccount(ADDRESS, new Account(0n, 5n));
  await assert.rejects(s.putStorage(ADDRESS, bytes(word(23)), bytes(word(2))), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert(); assert.deepEqual(s.snapshotChanges(), prior);
  await s.checkpoint(); await s.putStorage(ADDRESS, bytes(word(23)), bytes(word(3))); await s.commit(); assert.equal(await value(s, 23), 3n);
});

test('empty-account cleanup authenticates an otherwise unknown nonempty trie reset before funding and creation', async () => {
  const f = await fixture({ nonce: 0n, balance: 0n, code: '0x' }), s = f.stateManager;
  await s.checkpoint(); await s.getAccount(ADDRESS); s.beginEmptyAccountCleanup(); await s.deleteAccount(ADDRESS); const cleanup = s.endEmptyAccountCleanup(); await s.commit();
  assert.notEqual(cleanup[0].initialStorageRoot, EMPTY_STORAGE_ROOT); const calls = f.calls.length;
  await s.checkpoint(); await s.putAccount(ADDRESS, new Account(0n, 5n)); await s.commit();
  assert.deepEqual(row(s).reset, { basis: 'eip161_empty_account_cleanup', initialStorageRoot: cleanup[0].initialStorageRoot });
  assert.equal(await value(s, 991), 0n);
  await s.checkpoint(); await create(s, { balance: 5n }); await s.commit(); assert.equal(bytesToHex(await s.getCode(ADDRESS)), NEW_CODE); assert.equal(f.calls.length, calls);
});

test('creation still rejects original nonempty state and unsupported root replacement', async () => {
  const f = await fixture(), s = f.stateManager; await s.checkpoint();
  await assert.rejects(s.clearStorage(ADDRESS), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await assert.rejects(s.putCode(ADDRESS, bytes(NEW_CODE)), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert(); await deleted(f); await s.checkpoint();
  const replacement = new Account(0n, 1n, hexToBytes(root(s)));
  await assert.rejects(s.putAccount(ADDRESS, replacement), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.putAccount(ADDRESS, new Account(0n, 1n));
  s.resetStack.at(-1).set(FACTORY, 'unverified_override');
  assert.throws(() => s.snapshotChanges(), { code: 'LOCAL_STATE_INVALID' }); await assert.rejects(s.commit(), { code: 'LOCAL_STATE_INVALID' }); await s.revert(); await masked(s);
});

test('each real execution refreshes SSTORE original-value gas caching after a namespace reset', async () => {
  const f = await fixture(), s = f.stateManager;
  assert.equal(BigInt(bytesToHex(await s.originalStorageCache.get(ADDRESS, bytes(word(0))))), 41n);
  await deleted(f); await s.checkpoint(); await create(s, { code: '0x600160005500' }); await s.commit();
  const output = await executeEthereumCall(f);
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  assert.equal(output.execution.executionGasUsed, '22106'); assert.equal(output.execution.gasRefundCounter, '0');
  assert.equal(await value(s, 0), 1n); assert.equal(await value(s, 991), 0n);
  assert.equal((await s.originalStorageCache.get(ADDRESS, bytes(word(0)))).some(byte => byte !== 0), false);
  assert.deepEqual(row(s).storage, [{ slot: word(0), before: ZERO, after: word(1) }]);
});
