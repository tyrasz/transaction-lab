import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { createMPT } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { proofFixture, A, B, C, word, bytes, hex, minimalProof } from './proof-fixture.js';

const address = createAddressFromString(A), absent = createAddressFromString(C), blockHash = word(999);
async function fixture({ mutate } = {}) {
  const root = await proofFixture({ requested: [] }), records = [];
  const inputs = createRpcStateInputs({ chainId: 1, blockHash, header: { hash: blockHash, stateRoot: root.input.stateRoot }, rpc: { async call(method, params) {
    records.push({ method, params: structuredClone(params) });
    assert.deepEqual(params.at(-1), { blockHash, requireCanonical: true });
    const proof = await proofFixture({ address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
    const value = method === 'eth_getProof' ? proof.input.proof : proof.input.code;
    return mutate ? mutate({ method, params, value }) : value;
  } } });
  return { manager: createProofStateManager({ inputs }), inputs, records };
}

test('first reads and writes fetch proven prior account/storage values without zero-filling', async () => {
  const { manager, records } = await fixture();
  await manager.putStorage(address, hexToBytes(word(0)), new Uint8Array([9]));
  assert.equal(records.length, 3); assert.deepEqual(records.map(row => row.method), ['eth_getProof', 'eth_getCode', 'eth_getProof']);
  assert.equal((await manager.getAccount(address)).nonce, 3n);
  assert.equal(bytesToHex(await manager.getCode(address)), '0x600100');
  assert.deepEqual(manager.snapshotChanges().accounts[0].storage, [{ slot: word(0), before: word(7), after: word(9) }]);
  assert.equal(manager.snapshotInputs().accounts[A].storage[word(0)], word(7));
});

test('facts first loaded inside nested checkpoints survive rollback while mutable writes do not', async () => {
  const { manager, records } = await fixture();
  await manager.checkpoint(); await manager.checkpoint();
  const account = await manager.getAccount(address); account.balance = 10n; await manager.putAccount(address, account);
  await manager.putStorage(address, hexToBytes(word(0)), new Uint8Array([9])); await manager.commit();
  assert.equal(manager.snapshotChanges().accounts.length, 1); await manager.revert();
  assert.deepEqual(manager.snapshotChanges().accounts, []);
  const count = records.length;
  assert.equal((await manager.getAccount(address)).balance, 123456789n);
  assert.equal(bytesToHex(await manager.getStorage(address, hexToBytes(word(0)))), word(7));
  assert.equal(records.length, count); assert.equal(manager.snapshotInputEvidence().length, 3);
});

test('proof-absent zero-value touches remain absent; positive native funding and unsigned nonce materialization are explicit', async () => {
  const { manager } = await fixture(); assert.equal(await manager.getAccount(absent), undefined);
  await manager.putAccount(absent, new Account()); assert.equal(await manager.getAccount(absent), undefined); assert.deepEqual(manager.snapshotChanges().accounts, []);
  await manager.checkpoint(); await manager.putAccount(absent, new Account(0n, 123n));
  assert.equal((await manager.getAccount(absent)).balance, 123n);
  assert.deepEqual(manager.snapshotChanges().accounts[0].existence, { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' });
  await manager.revert(); assert.equal(await manager.getAccount(absent), undefined);
  await manager.putAccount(absent, new Account(1n, 0n));
  assert.equal(manager.snapshotChanges().accounts[0].existence.basis, 'unsigned_sender_nonce_materialization');
  assert.deepEqual(manager.snapshotInputs().accounts[C], { exists: false });
});

test('returned objects, copied overlays and immutable proof facts cannot mutate one another', async () => {
  const { manager } = await fixture();
  const account = await manager.getAccount(address); account.balance = 0n;
  const code = await manager.getCode(address); code[0] = 0;
  const slot = await manager.getStorage(address, hexToBytes(word(0))); slot[31] = 99;
  assert.equal((await manager.getAccount(address)).balance, 123456789n); assert.equal(bytesToHex(await manager.getCode(address)), '0x600100');
  const copy = manager.shallowCopy(); await copy.putStorage(address, hexToBytes(word(0)), new Uint8Array([9]));
  assert.equal(bytesToHex(await manager.getStorage(address, hexToBytes(word(0)))), word(7));
  assert.equal(bytesToHex(await copy.getStorage(address, hexToBytes(word(0)))), '0x09');
  assert.equal(copy.snapshotInputs().accounts[A].storage[word(0)], word(7));
});

test('invalid storage proof blocks a write and prior overlay state remains available for rollback', async () => {
  const { manager } = await fixture({ mutate: ({ method, params, value }) => { if (method === 'eth_getProof' && params[1].length) value.storageProof = []; return value; } });
  await manager.checkpoint(); const account = await manager.getAccount(address); account.balance = 10n; await manager.putAccount(address, account);
  await assert.rejects(manager.putStorage(address, hexToBytes(word(0)), new Uint8Array([9])));
  await manager.revert(); assert.deepEqual(manager.snapshotChanges().accounts, []); assert.equal(manager.snapshotInputs().status, 'unavailable');
  await assert.rejects(manager.getAccount(address), { code: 'LOCAL_STATE_MISSING' });
});

test('proven existing empty accounts fail closed rather than inventing transaction-cleanup semantics', async () => {
  const trie = await createMPT({ useKeyHashing: true });
  await trie.put(bytes(A), RLP.encode([new Uint8Array(), new Uint8Array(), bytes(EMPTY_STORAGE_ROOT), bytes(EMPTY_CODE_HASH)]));
  const proof = { address: A, accountProof: await minimalProof(trie, A), balance: '0x0', nonce: '0x0', codeHash: EMPTY_CODE_HASH, storageHash: EMPTY_STORAGE_ROOT, storageProof: [] };
  const inputs = createRpcStateInputs({ chainId: 1, blockHash, header: { hash: blockHash, stateRoot: hex(trie.root()) }, rpc: { async call(method) { return method === 'eth_getProof' ? structuredClone(proof) : '0x'; } } });
  const manager = createProofStateManager({ inputs }); await manager.checkpoint();
  await assert.rejects(manager.getAccount(address), { code: 'LOCAL_STATE_UNSUPPORTED' }); await manager.revert();
  assert.deepEqual(manager.snapshotChanges().accounts, []);
  assert.deepEqual(inputs.snapshotInputs().accounts[A], { exists: true, nonce: '0', balance: '0', code: '0x', storage: {} });
});

test('runtime code/lifecycle changes, fake collectors and unsettled copies stay unsupported', async () => {
  assert.throws(() => createProofStateManager({ inputs: { getAccount() {} } }), { code: 'LOCAL_STATE_INVALID' });
  const { manager } = await fixture(); await manager.getAccount(address);
  for (const operation of [() => manager.putCode(address, new Uint8Array()), () => manager.clearStorage(address), () => manager.deleteAccount(address), () => manager.consumeBAL({})]) await assert.rejects(operation(), { code: 'LOCAL_STATE_UNSUPPORTED' });
  const modified = await manager.getAccount(address); modified.storageRoot = hexToBytes(word(3));
  await assert.rejects(manager.putAccount(address, modified), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await assert.rejects(manager.putStorage(absent, hexToBytes(word(0)), new Uint8Array([1])), { code: 'LOCAL_STATE_UNSUPPORTED' });
  await manager.checkpoint(); assert.throws(() => manager.shallowCopy(), { code: 'LOCAL_STATE_UNSUPPORTED' }); await manager.revert();
  await assert.rejects(manager.revert(), { code: 'LOCAL_STATE_INVALID' });
  await assert.rejects(manager.commit(), { code: 'LOCAL_STATE_INVALID' });
});
