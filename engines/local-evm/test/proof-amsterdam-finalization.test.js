// Authenticated synthetic prestate and real bytecode controls only. The raw
// Amsterdam EVM here does not enable the public wrapper or parent validators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { Common, Sepolia, Hardfork } from '@ethereumjs/common';
import { createEVM } from '@ethereumjs/evm';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH } from '../verified-state-proof.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';

const MODE = Object.freeze({ mode: 'amsterdam_eip8246' });
const BASIS = 'same_invocation_created_contract_clearing_eip8246';
const target = createdAddress(), address = createAddressFromString(target);
const BENEFICIARY = '0x' + '44'.repeat(20), DONOR = '0x' + '55'.repeat(20);
const account = (state, key) => state.getAccount(createAddressFromString(key));
const code = (state, key) => state.getCode(createAddressFromString(key)).then(bytesToHex);
const slot = async (state, key, n) => { const v = await state.getStorage(createAddressFromString(key), bytes(word(n))); return v.length ? BigInt(bytesToHex(v)) : 0n; };
const sd = key => '73' + key.slice(2) + 'ff';
const call = (key, value = 0) => '600060006000600060' + value.toString(16).padStart(2, '0') + '73' + key.slice(2) + '620f4240f150';
async function fixture(prefunded = false) { return lifecycleFixture({ accounts: prefunded ? { [target]: { nonce: 0n, balance: 17n, code: '0x' } } : {} }); }
async function create(state, { key = target, balance = 23n, nonce = 1n } = {}) {
  const a = createAddressFromString(key); await state.getAccount(a); await state.clearStorage(a); state.beginContractCreation(a);
  await state.putAccount(a, new Account(1n, balance));
  if (nonce !== 1n) await state.putAccount(a, new Account(nonce, balance));
  await state.putCode(a, bytes('0x600000'));
  await state.putStorage(a, bytes(word(0)), bytes('0x2a'));
}
async function cleared(state, key, balance) {
  const a = await account(state, key);
  if (balance === 0n) assert.equal(a, undefined);
  else { assert.equal(a.nonce, 0n); assert.equal(a.balance, balance); assert.equal(bytesToHex(a.codeHash), EMPTY_CODE_HASH); assert.equal(bytesToHex(a.storageRoot), EMPTY_STORAGE_ROOT); }
  assert.equal(await code(state, key), '0x');
  for (const n of [0, 1, 991]) assert.equal(await slot(state, key, n), 0n);
  assert.equal(state.created(key), false);
}

test('explicit Amsterdam clearing preserves exact residual native balance or removes the zero empty account', async () => {
  for (const prefunded of [false, true]) for (const balance of [0n, 17n, 23n, (1n << 256n) - 1n]) {
    const f = await fixture(prefunded), s = f.stateManager;
    await s.checkpoint(); await create(s, { balance, nonce: 7n });
    const metadata = await s.finalizeCreatedContractClearing(address, MODE); await s.commit();
    assert.deepEqual(metadata, { address: target, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: EMPTY_STORAGE_ROOT,
      preservedBalance: '0x' + balance.toString(16) });
    const calls = f.calls.length; await cleared(s, target, balance); assert.equal(f.calls.length, calls);
    const row = s.snapshotChanges().accounts.find(row => row.address === target);
    if (prefunded && balance === 0n) assert.deepEqual(row, { address: target, existence: { before: true, after: false, basis: BASIS }, balance: { before: '0x11', after: '0x0' } });
    else if ((prefunded && balance === 17n) || (!prefunded && balance === 0n)) assert.equal(row, undefined);
    else {
      assert.deepEqual(row.balance, { before: prefunded ? '0x11' : '0x0', after: '0x' + balance.toString(16) });
      assert.equal(row.nonce, undefined); assert.equal(row.code, undefined); assert.equal(row.storage, undefined);
      if (!prefunded) assert.deepEqual(row.existence, { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' });
    }
    await s.checkpoint(); await assert.rejects(s.putCode(address, bytes('0x00')), { code: 'LOCAL_STATE_UNSUPPORTED' });
    await assert.rejects(s.putStorage(address, bytes(word(1)), bytes('0x01')), { code: 'LOCAL_STATE_UNSUPPORTED' }); await s.revert();
  }
});

test('clearing and nested commits remain atomically reversible, including creation/write eligibility', async () => {
  const f = await fixture(true), s = f.stateManager;
  await s.checkpoint(); await create(s); const before = s.snapshotChanges();
  await s.checkpoint(); await s.checkpoint(); await s.finalizeCreatedContractClearing(address, MODE); await s.commit();
  await cleared(s, target, 23n); await s.revert(); assert.deepEqual(s.snapshotChanges(), before);
  assert.equal((await account(s, target)).nonce, 1n); assert.equal(await code(s, target), '0x600000'); assert.equal(await slot(s, target, 0), 42n);
  assert.equal(s.created(target), true); await s.putStorage(address, bytes(word(1)), bytes('0x02'));
  await s.revert(); assert.deepEqual(s.snapshotChanges().accounts, []); assert.equal((await account(s, target)).balance, 17n);
});

test('settled copies preserve balance-only clearing and can recreate without stale code or storage', async () => {
  const f = await fixture(), s = f.stateManager;
  await s.checkpoint(); await create(s); await s.finalizeCreatedContractClearing(address, MODE); await s.commit();
  const copy = s.shallowCopy(); await cleared(copy, target, 23n);
  await copy.checkpoint(); await create(copy, { balance: 31n }); await copy.putStorage(address, bytes(word(1)), bytes('0x07')); await copy.commit();
  assert.equal((await account(copy, target)).balance, 31n); assert.equal(await slot(copy, target, 1), 7n);
  await cleared(s, target, 23n);
  await copy.checkpoint(); await copy.finalizeCreatedContractClearing(address, MODE); await copy.revert();
  assert.equal(await code(copy, target), '0x600000'); assert.equal(await slot(copy, target, 1), 7n);
});

test('old nonempty namespaces retain immutable reset provenance and old-equal writes never resurrect after clearing', async () => {
  const oldCode = '0x60005400', key = FACTORY, a = createAddressFromString(key);
  const f = await lifecycleFixture({ accounts: { [key]: { nonce: 7n, balance: 11n, code: oldCode, storage: { [word(0)]: 42n, [word(991)]: 99n } } } }), s = f.stateManager;
  await s.checkpoint(); await s.finalizeShanghaiContractDeletion(a); await s.commit();
  const initialRoot = s.base.get(key).storageRoot, calls = f.calls.length;
  await s.checkpoint(); await create(s, { key, balance: 11n });
  assert.deepEqual(s.snapshotChanges().accounts.find(row => row.address === key).storage, [{ slot: word(0), before: word(0), after: word(42) }]);
  const metadata = await s.finalizeCreatedContractClearing(a, MODE); await s.commit();
  assert.equal(metadata.initialStorageRoot, initialRoot); await cleared(s, key, 11n); assert.equal(f.calls.length, calls);
  assert.deepEqual(s.snapshotChanges().accounts.find(row => row.address === key), { address: key, nonce: { before: '0x7', after: '0x0' },
    reset: { basis: BASIS, initialStorageRoot: initialRoot }, code: { before: oldCode, after: '0x' } });
  const copy = s.shallowCopy(); await copy.checkpoint(); await create(copy, { key, balance: 11n }); await copy.commit();
  assert.deepEqual(copy.snapshotChanges().accounts.find(row => row.address === key).storage, [{ slot: word(0), before: word(0), after: word(42) }]);
  assert.equal(await slot(copy, key, 991), 0n); assert.equal(f.calls.length, calls);
});

test('invalid modes, ineligible accounts and repeated marker consumption cannot mutate the overlay', async () => {
  const f = await fixture(true), s = f.stateManager; let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, 'mode', { enumerable: true, get() { invoked = true; return MODE.mode; } });
  const proxy = new Proxy(MODE, { getPrototypeOf() { invoked = true; throw Error('trap'); } });
  const hidden = {}; Object.defineProperty(hidden, 'mode', { value: MODE.mode });
  await s.checkpoint(); await create(s); const before = s.snapshotChanges(), calls = f.calls.length;
  for (const mode of [undefined, null, {}, { mode: 'cancun' }, { mode: MODE.mode, extra: true }, accessor, proxy, hidden, { ...MODE, [Symbol('extra')]: 1 }]) {
    await assert.rejects(s.finalizeCreatedContractClearing(address, mode), { code: 'LOCAL_STATE_INVALID' }); assert.deepEqual(s.snapshotChanges(), before);
  }
  assert.equal(invoked, false); assert.equal(f.calls.length, calls);
  await assert.rejects(s.finalizeCreatedContractClearing(createAddressFromString(FACTORY), MODE), { code: 'LOCAL_STATE_UNSUPPORTED' });
  assert.deepEqual(s.snapshotChanges(), before);
  await s.finalizeCreatedContractClearing(address, MODE); const after = s.snapshotChanges();
  await assert.rejects(s.finalizeCreatedContractClearing(address, MODE), { code: 'LOCAL_STATE_UNSUPPORTED' }); assert.deepEqual(s.snapshotChanges(), after);
  await s.revert(); await assert.rejects(s.finalizeCreatedContractClearing(address, MODE), { code: 'LOCAL_STATE_INVALID' });
  assert.deepEqual(s.snapshotChanges().accounts, []);
});

async function amsterdamFixture(options) {
  const f = await lifecycleFixture(options), common = new Common({ chain: Sepolia, hardfork: Hardfork.Amsterdam });
  const block = createBlock({ header: { stateRoot: f.header.stateRoot, number: 12018196n, timestamp: 1793261160n,
    gasLimit: 60000000n, baseFeePerGas: 0n }, withdrawals: [] }, { common });
  const h = block.header.toJSON(), mapping = { sha3Uncles: 'uncleHash', miner: 'coinbase', transactionsRoot: 'transactionsTrie', receiptsRoot: 'receiptTrie' };
  for (const key of Object.keys(f.header)) delete f.header[key];
  for (const key of ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash', 'blockAccessListHash', 'slotNumber']) f.header[key] = h[mapping[key] ?? key];
  f.header.hash = bytesToHex(block.hash()); assert.equal(verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: 11155111 }).hardfork, 'amsterdam');
  f.inputs = createRpcStateInputs({ chainId: 11155111, blockHash: f.header.hash, header: f.header, rpc: f.rpc });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  return { ...f, common, block };
}
async function executeRaw(f, { finalize = true } = {}) {
  const s = f.stateManager; s.originalStorageCache.clear(); await s.checkpoint();
  const evm = await createEVM({ common: f.common, stateManager: s, blockchain: f.inputs.blockchain });
  evm.events.on('newContract', event => s.beginContractCreation(event.address));
  evm.journal.addAlwaysWarmAddress(SENDER); evm.journal.addAlwaysWarmAddress(FACTORY);
  const result = await evm.runCall({ caller: createAddressFromString(SENDER), to: createAddressFromString(FACTORY),
    value: 0n, data: new Uint8Array(), gasLimit: 5000000n, gasPrice: 0n, block: f.block });
  const metadata = [];
  if (finalize && !result.execResult.exceptionError) for (const key of [...(result.execResult.selfdestruct?.keys() ?? [])].sort()) {
    if (result.execResult.createdAddresses.has(key)) metadata.push(await s.finalizeCreatedContractClearing(createAddressFromString(key), MODE));
  }
  if (finalize) await s.commit();
  return { result, metadata };
}

test('real Amsterdam constructor self-beneficiary keeps prefunding and endowment while finalization clears its state', async () => {
  const init = '602a60005530ff', key = createdAddress({ init });
  const f = await amsterdamFixture({ code: factoryCode(init, { value: 7 }), accounts: { [key]: { nonce: 0n, balance: 17n } } });
  const { result } = await executeRaw(f, { finalize: false }); assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await account(f.stateManager, key)).balance, 24n); assert.equal(await slot(f.stateManager, key, 0), 42n);
  const metadata = await f.stateManager.finalizeCreatedContractClearing(createAddressFromString(key), MODE); await f.stateManager.commit();
  assert.equal(metadata.preservedBalance, '0x18'); await cleared(f.stateManager, key, 24n);
  assert.equal((await account(f.stateManager, FACTORY)).balance, 993n);
});

test('real Amsterdam SELFDESTRUCT transfers and later refills preserve exact residual value at finalization', async () => {
  const init = initcode(sd(BENEFICIARY), '602a600055'), key = createdAddress({ init });
  const f = await amsterdamFixture({ code: factoryCode(init, { value: 5, tail: '50' + call(key) + call(DONOR) + '00' }),
    accounts: { [DONOR]: { nonce: 1n, balance: 7n, code: '0x' + sd(key) } } });
  const { result, metadata } = await executeRaw(f); assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await account(f.stateManager, BENEFICIARY)).balance, 5n); assert.equal((await account(f.stateManager, DONOR)).balance, 0n);
  assert.equal(await code(f.stateManager, DONOR), '0x' + sd(key)); assert.equal(metadata[0].preservedBalance, '0x7'); await cleared(f.stateManager, key, 7n);
  const selfInit = initcode('30ff', ''), self = createdAddress({ init: selfInit });
  const repeated = await amsterdamFixture({ code: factoryCode(selfInit, { value: 5, tail: '50' + call(self) + call(self, 7) + '00' }) });
  const second = await executeRaw(repeated); assert.equal(second.result.execResult.exceptionError, undefined); await cleared(repeated.stateManager, self, 12n);
  assert.equal((await account(repeated.stateManager, FACTORY)).balance, 988n);
});

test('real root rollback discards clearing eligibility; later CREATE2 can reuse a settled balance-only account', async () => {
  const init = '602a60005530ff', key = createdAddress({ kind: 'CREATE2', init });
  const reverted = await amsterdamFixture({ code: factoryCode(init, { kind: 'CREATE2', value: 5, tail: '5060006000fd' }) });
  const r = await executeRaw(reverted); assert.equal(r.result.execResult.exceptionError.error, 'revert'); assert.deepEqual(r.metadata, []);
  assert.equal(await account(reverted.stateManager, key), undefined); assert.equal((await account(reverted.stateManager, FACTORY)).nonce, 7n);
  const f = await amsterdamFixture({ code: factoryCode(init, { kind: 'CREATE2', value: 5 }) });
  for (const balance of [5n, 10n]) { const r = await executeRaw(f); assert.equal(r.result.execResult.exceptionError, undefined); await cleared(f.stateManager, key, balance); }
  assert.equal((await account(f.stateManager, FACTORY)).nonce, 9n); assert.equal((await account(f.stateManager, FACTORY)).balance, 990n);
});
