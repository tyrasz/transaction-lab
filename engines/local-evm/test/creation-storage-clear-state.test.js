// Authenticated synthetic state-manager controls only. These do not enable
// storage-only creation in the executor or establish client agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { createProofStateManager } from '../proof-state.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, SENDER, bytes, word } from './lifecycle-fixture.js';

const TARGET = '0x' + '33'.repeat(20), OTHER = SENDER;
const ADDRESS = createAddressFromString(TARGET), OTHER_ADDRESS = createAddressFromString(OTHER);
const MODE = Object.freeze({ mode: 'ethereum_nonce_code_collision' });
const BASIS = 'contract_creation_storage_clear', ZERO = word(0);
const numeric = value => value.length ? BigInt(bytesToHex(value)) : 0n;
const storage = async (s, n, address = ADDRESS) => numeric(await s.getStorage(address, bytes(word(n))));
const original = async (s, n, address = ADDRESS) => numeric(await s.originalStorageCache.get(address, bytes(word(n))));
const row = s => s.snapshotChanges().accounts.find(value => value.address === TARGET);
async function fixture(overrides = {}) {
  return lifecycleFixture({ accounts: {
    [TARGET]: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(0)]: 999n, [word(1)]: 888n, [word(991)]: 123456n }, ...overrides },
    [OTHER]: { nonce: 1n, balance: 1000000n, code: '0x', storage: { [word(0)]: 12n } },
  } });
}
async function begin(s, address = ADDRESS) {
  await s.clearStorageForContractCreation(address, MODE);
  s.beginContractCreation(address);
  const account = await s.getAccount(address) ?? new Account();
  account.nonce = 1n;
  await s.putAccount(address, account);
}

test('explicit creation clearing preserves prefunding and masks loaded and hidden storage without old proof reads', async () => {
  const f = await fixture(), s = f.stateManager;
  assert.equal(await storage(s, 0), 999n);
  const initial = await s.getAccount(ADDRESS), initialRoot = bytesToHex(initial.storageRoot);
  assert.notEqual(initialRoot, EMPTY_STORAGE_ROOT);
  await s.checkpoint();
  const funded = await s.getAccount(ADDRESS); funded.balance += 8n; await s.putAccount(ADDRESS, funded);
  const reads = f.calls.length;
  await s.clearStorageForContractCreation(ADDRESS, MODE);
  const cleared = await s.getAccount(ADDRESS);
  assert.equal(cleared.balance, 25n); assert.equal(cleared.nonce, 0n);
  assert.equal(bytesToHex(cleared.codeHash), EMPTY_CODE_HASH);
  assert.equal(bytesToHex(cleared.storageRoot), EMPTY_STORAGE_ROOT);
  assert.equal(bytesToHex(await s.getCode(ADDRESS)), '0x');
  for (const slot of [0, 1, 991, 992]) assert.equal(await storage(s, slot), 0n);
  assert.equal(f.calls.length, reads);
  assert.equal(s.base.get(TARGET).storage.size, 1, 'hidden original slots stay undemanded');
  assert.equal(s.base.get(TARGET).storageRoot, initialRoot);
  s.beginContractCreation(ADDRESS);
  await s.putAccount(ADDRESS, new Account(1n, 25n));
  await s.commit();
  assert.deepEqual(row(s), { address: TARGET, nonce: { before: '0x0', after: '0x1' },
    balance: { before: '0x11', after: '0x19' }, reset: { basis: BASIS, initialStorageRoot: initialRoot } });
});

test('new storage has a complete zero baseline including old-equal writes and excludes later zeroed writes', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.getAccount(ADDRESS); const reads = f.calls.length;
  await s.checkpoint(); await begin(s);
  await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(999)));
  await s.putStorage(ADDRESS, bytes(word(9)), bytes(word(7)));
  await s.putStorage(ADDRESS, bytes(word(10)), bytes(word(8)));
  await s.putStorage(ADDRESS, bytes(word(10)), new Uint8Array());
  await s.putCode(ADDRESS, bytes('0x600000')); await s.commit();
  assert.deepEqual(row(s).storage, [
    { slot: word(0), before: ZERO, after: word(999) },
    { slot: word(9), before: ZERO, after: word(7) },
  ]);
  assert.deepEqual(row(s).code, { before: '0x', after: '0x600000' });
  for (const n of [1, 10, 991]) assert.equal(await storage(s, n), 0n);
  assert.equal(f.calls.length, reads);
  assert.equal(s.base.get(TARGET).storage.size, 0);
  assert.equal(row(s).reset.initialStorageRoot, s.base.get(TARGET).storageRoot);
});

test('failed creation and committed child followed by ancestor rollback restore the previous namespace', async () => {
  for (const childCommits of [false, true]) {
    const f = await fixture(), s = f.stateManager;
    assert.equal(await storage(s, 0), 999n); const prior = s.snapshotChanges();
    const accountBefore = (await s.getAccount(ADDRESS)).serialize();
    await s.checkpoint();
    await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(1000)));
    await s.putStorage(ADDRESS, bytes(word(23)), bytes(word(77)));
    const ancestor = s.snapshotChanges();
    await s.checkpoint(); await begin(s);
    assert.equal(await storage(s, 23), 0n, 'clearing masks earlier local writes as well as proof-backed slots');
    await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(42)));
    await s.putStorage(ADDRESS, bytes(word(9)), bytes(word(7)));
    await s.putCode(ADDRESS, bytes('0x00'));
    if (childCommits) await s.commit();
    else {
      await s.revert(); assert.deepEqual(s.snapshotChanges(), ancestor);
      assert.equal(await storage(s, 0), 1000n); assert.equal(await storage(s, 23), 77n);
    }
    await s.revert();
    assert.deepEqual((await s.getAccount(ADDRESS)).serialize(), accountBefore);
    assert.equal(bytesToHex(await s.getCode(ADDRESS)), '0x');
    assert.equal(await storage(s, 0), 999n); assert.equal(await storage(s, 991), 123456n);
    assert.equal(await storage(s, 9), 0n); assert.equal(s.created(TARGET), false);
    assert.deepEqual(s.snapshotChanges(), prior);
  }
});

test('late immutable proofs seed original ancestors but cannot resurrect the cleared child namespace', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await s.checkpoint(); await begin(s); await s.checkpoint();
  await s.loadSlot(TARGET, word(991));
  assert.equal(await storage(s, 991), 0n); await s.commit();
  assert.equal(await storage(s, 991), 0n); await s.revert();
  assert.equal(await storage(s, 991), 123456n);
  assert.equal((await s.getAccount(ADDRESS)).nonce, 0n);
  await s.commit(); assert.deepEqual(s.snapshotChanges().accounts, []);
});

test('unbound clears cannot commit or snapshot, and only the matching creation consumes the pending clear', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await s.checkpoint();
  await s.clearStorageForContractCreation(ADDRESS, MODE);
  assert.throws(() => s.snapshotChanges(), { code: 'LOCAL_STATE_INVALID' });
  await assert.rejects(s.commit(), { code: 'LOCAL_STATE_INVALID' });
  await assert.rejects(s.putStorage(ADDRESS, bytes(word(1)), bytes('0x01')), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.clearStorage(ADDRESS); // The legacy method cannot authenticate this clear.
  const absent = createAddressFromString('0x' + '44'.repeat(20));
  await s.getAccount(absent); s.beginContractCreation(absent);
  assert.throws(() => s.snapshotChanges(), { code: 'LOCAL_STATE_INVALID' });
  await assert.rejects(s.commit(), { code: 'LOCAL_STATE_INVALID' });
  await s.revert(); await s.commit();
  assert.equal(await storage(s, 991), 123456n); assert.deepEqual(s.snapshotChanges().accounts, []);
  await s.checkpoint(); await s.clearStorageForContractCreation(ADDRESS, MODE);
  await s.checkpoint(); s.beginContractCreation(ADDRESS); await s.revert();
  await assert.rejects(s.commit(), { code: 'LOCAL_STATE_INVALID' });
  assert.throws(() => s.snapshotChanges(), { code: 'LOCAL_STATE_INVALID' });
  await s.revert(); assert.deepEqual(s.snapshotChanges().accounts, []);
});

test('settled copies keep independent reset writes and start new original-value baselines', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await begin(s); await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(42))); await s.commit();
  const reads = f.calls.length, first = s.shallowCopy(), second = s.shallowCopy();
  assert.deepEqual(first.snapshotChanges(), s.snapshotChanges());
  assert.equal(await original(s, 0), 0n);
  assert.equal(await original(first, 0), 42n); assert.equal(await original(second, 0), 42n);
  await first.checkpoint(); await first.putStorage(ADDRESS, bytes(word(0)), bytes(word(43))); await first.commit();
  assert.equal(await storage(first, 0), 43n); assert.equal(await storage(second, 0), 42n); assert.equal(await storage(s, 0), 42n);
  assert.equal(await original(first, 0), 42n);
  await first.checkpoint(); await first.putStorage(ADDRESS, bytes(word(1)), bytes(word(7))); await first.revert();
  for (const state of [s, first, second]) assert.equal(await storage(state, 991), 0n);
  assert.equal(f.calls.length, reads);
});

test('original storage creation markers survive child and ancestor rollback without clearing other accounts', async () => {
  for (const childCommits of [false, true]) {
    const f = await fixture(), s = f.stateManager;
    assert.equal(await original(s, 0), 999n);
    assert.equal(await original(s, 0, OTHER_ADDRESS), 12n);
    await s.checkpoint(); await s.putStorage(OTHER_ADDRESS, bytes(word(0)), bytes(word(55)));
    await s.checkpoint(); await s.clearStorageForContractCreation(ADDRESS, MODE);
    assert.equal(await original(s, 0), 999n, 'clearing alone is not a creation marker');
    s.beginContractCreation(ADDRESS); await s.putAccount(ADDRESS, new Account(1n, 17n));
    await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(42)));
    const reads = f.calls.length;
    assert.equal(await original(s, 0), 0n, 'the creation marker overrides an already cached old value');
    assert.equal(await original(s, 991), 0n);
    assert.equal(await original(s, 0, OTHER_ADDRESS), 12n, 'creation must not globally invalidate cached originals');
    assert.equal(f.calls.length, reads);
    if (childCommits) await s.commit(); else await s.revert();
    await s.revert();
    assert.equal(await storage(s, 0), 999n); assert.equal(await original(s, 0), 0n);
    assert.equal(await original(s, 991), 0n); assert.equal(s.created(TARGET), false);
    const copy = s.shallowCopy();
    assert.equal(await original(copy, 0), 999n, 'a copied query overlay has a fresh invocation baseline');
    s.originalStorageCache.clear();
    assert.equal(await original(s, 0), 999n); assert.equal(await original(s, 991), 123456n);
    assert.equal(await original(s, 0, OTHER_ADDRESS), 12n);
  }
});

test('no checkpoint, invalid modes, repeated clears and active creation are rejected without extra authority', async () => {
  const f = await fixture(), s = f.stateManager;
  await assert.rejects(s.clearStorageForContractCreation(ADDRESS, MODE), { code: 'LOCAL_STATE_INVALID' });
  await s.checkpoint(); let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, 'mode', { enumerable: true, get() { invoked = true; return MODE.mode; } });
  const hidden = {}; Object.defineProperty(hidden, 'mode', { value: MODE.mode });
  const proxy = new Proxy(MODE, { getPrototypeOf() { invoked = true; throw Error('trap'); } });
  for (const options of [undefined, null, {}, { mode: 'amsterdam' }, { mode: MODE.mode, extra: true }, accessor, hidden, proxy, { ...MODE, [Symbol('x')]: true }]) {
    const reads = f.calls.length;
    await assert.rejects(s.clearStorageForContractCreation(ADDRESS, options), { code: 'LOCAL_STATE_INVALID' });
    assert.equal(f.calls.length, reads); assert.deepEqual(s.snapshotChanges().accounts, []);
  }
  assert.equal(invoked, false);
  await s.clearStorageForContractCreation(ADDRESS, MODE);
  await assert.rejects(s.clearStorageForContractCreation(ADDRESS, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
  s.beginContractCreation(ADDRESS);
  await assert.rejects(s.clearStorageForContractCreation(ADDRESS, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert();
  await s.checkpoint(); await begin(s); await s.commit();
  assert.equal(row(s).reset.basis, BASIS);
});

test('nonce or code collisions remain ineligible and generic storage clearing remains closed', async () => {
  for (const collision of [{ nonce: 1n }, { code: '0x00' }, { code: '0xef0100' + '55'.repeat(20) }]) {
    const f = await fixture(collision), s = f.stateManager;
    await s.getAccount(ADDRESS); const before = s.snapshotChanges(); await s.checkpoint();
    await assert.rejects(s.clearStorageForContractCreation(ADDRESS, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
    assert.deepEqual(s.snapshotChanges(), before); assert.equal(await storage(s, 0), 999n);
    await s.revert();
  }
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await assert.rejects(s.clearStorage(ADDRESS), { code: 'LOCAL_STATE_UNSUPPORTED' });
  assert.throws(() => s.beginContractCreation(ADDRESS), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await s.revert(); assert.deepEqual(s.snapshotChanges().accounts, []);
});

test('zero-balance storage-only, absent and empty-storage targets preserve their exact creation starting balances', async () => {
  for (const kind of ['storage_zero_balance', 'absent', 'empty_storage']) {
    const f = await fixture(kind === 'storage_zero_balance' ? { balance: 0n } : { storage: {} });
    const s = kind === 'absent' ? createProofStateManager({ inputs: f.inputs }) : f.stateManager;
    const address = kind === 'absent' ? createAddressFromString('0x' + '44'.repeat(20)) : ADDRESS;
    const before = await s.getAccount(address), balance = before?.balance ?? 0n;
    await s.checkpoint();
    if (kind === 'storage_zero_balance') await s.clearStorageForContractCreation(address, MODE);
    else {
      await assert.rejects(s.clearStorageForContractCreation(address, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
      await s.clearStorage(address);
    }
    const cleared = await s.getAccount(address);
    assert.equal(cleared?.balance ?? 0n, balance);
    assert.equal(cleared === undefined, before === undefined, 'the clear alone does not create or delete the account');
    s.beginContractCreation(address); await s.putAccount(address, new Account(1n, balance)); await s.commit();
    assert.equal((await s.getAccount(address)).balance, balance);
    assert.equal((await s.getAccount(address)).nonce, 1n);
    assert.equal(await storage(s, 991, address), 0n);
  }
});

test('a prior authenticated deletion retains its own reset lineage through ordinary recreation', async () => {
  const f = await fixture({ nonce: 3n, code: '0x00' }), s = f.stateManager;
  await s.checkpoint(); await s.finalizeShanghaiContractDeletion(ADDRESS); await s.commit();
  const initialRoot = s.base.get(TARGET).storageRoot;
  await s.checkpoint(); await s.putAccount(ADDRESS, new Account(0n, 17n));
  const before = s.snapshotChanges();
  await assert.rejects(s.clearStorageForContractCreation(ADDRESS, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
  assert.deepEqual(s.snapshotChanges(), before);
  await s.clearStorage(ADDRESS); s.beginContractCreation(ADDRESS);
  await s.putAccount(ADDRESS, new Account(1n, 17n));
  await s.putStorage(ADDRESS, bytes(word(0)), bytes(word(999))); await s.commit();
  assert.deepEqual(row(s).reset, { basis: 'shanghai_selfdestruct_deletion', initialStorageRoot: initialRoot });
  assert.deepEqual(row(s).storage, [{ slot: word(0), before: ZERO, after: word(999) }]);
  assert.equal(await storage(s, 991), 0n);
});
