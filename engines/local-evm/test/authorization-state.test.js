import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { lifecycleFixture, bytes, word } from './lifecycle-fixture.js';
const A='0x'+'77'.repeat(20),D='0x'+'88'.repeat(20),E='0x'+'99'.repeat(20),ZERO='0x'+'00'.repeat(20);
const addr=createAddressFromString,designation=target=>'0xef0100'+target.slice(2);

test('authorization installation/replacement/clear preserve authenticated balance and nonempty storage',async()=>{
  const f=await lifecycleFixture({accounts:{[A]:{nonce:4n,balance:27n,code:'0x',storage:{[word(9)]:42n}}}}),s=f.stateManager;
  await s.checkpoint();await s.applyAuthorization(addr(A),4n,D);
  await s.checkpoint();await s.applyAuthorization(addr(A),5n,E);await s.revert();
  assert.equal(bytesToHex(await s.getCode(addr(A))),designation(D));assert.equal((await s.getAccount(addr(A))).nonce,5n);
  await s.applyAuthorization(addr(A),5n,ZERO);await s.commit();
  const a=await s.getAccount(addr(A));assert.equal(a.balance,27n);assert.equal(a.nonce,6n);assert.equal(bytesToHex(await s.getCode(addr(A))),'0x');
  assert.equal(BigInt(bytesToHex(await s.getStorage(addr(A),bytes(word(9))))),42n);
  assert.deepEqual(s.snapshotChanges().accounts,[{address:A,nonce:{before:'0x4',after:'0x6'}}]);
});
test('absent authorized account and demanded storage carry through settled copies without altering immutable proofs',async()=>{
  const f=await lifecycleFixture(),s=f.stateManager;
  await s.checkpoint();await s.applyAuthorization(addr(A),0n,D);await s.putStorage(addr(A),bytes(word(1)),new Uint8Array([42]));await s.commit();
  const before=s.snapshotChanges();assert.equal(before.accounts[0].existence.basis,'eip7702_authorization_materialization');
  assert.equal(f.inputs.snapshotInputs().accounts[A].exists,false);
  // The account exclusion proves every initial slot zero; the collector may
  // derive this demanded fact without a redundant storage RPC.
  assert(f.calls.some(c=>c.method==='eth_getProof'&&c.params[0]===A));
  assert.equal(before.accounts[0].storage[0].before,word(0));
  const copy=s.shallowCopy();await copy.checkpoint();await copy.applyAuthorization(addr(A),1n,E);await copy.putStorage(addr(A),bytes(word(2)),new Uint8Array([7]));await copy.commit();
  assert.deepEqual(s.snapshotChanges(),before);assert.equal(bytesToHex(await copy.getCode(addr(A))),designation(E));
  assert.equal(copy.snapshotChanges().accounts[0].existence.basis,'eip7702_authorization_materialization');
});
test('outer rollback removes authorization materialization, code, nonce, slots and provenance',async()=>{
  const f=await lifecycleFixture(),s=f.stateManager;
  await s.checkpoint();await s.applyAuthorization(addr(A),0n,D);
  await s.checkpoint();await s.applyAuthorization(addr(A),1n,E);await s.putStorage(addr(A),bytes(word(2)),new Uint8Array([9]));await s.commit();
  await s.revert();assert.equal(await s.getAccount(addr(A)),undefined);assert.equal(bytesToHex(await s.getCode(addr(A))),'0x');assert.deepEqual(s.snapshotChanges().accounts,[]);
  await assert.rejects(s.putStorage(addr(A),bytes(word(2)),new Uint8Array([9])),{code:'LOCAL_STATE_UNSUPPORTED'});
  await s.checkpoint();await s.putAccount(addr(A),createAccount({balance:1n}));await s.commit();
  assert.equal(s.snapshotChanges().accounts[0].existence.basis,'positive_native_funding_of_proof_absent_account');
});
test('authorization setter refuses no checkpoint, nonce mismatch, malformed designation and generic runtime replacement',async()=>{
  const f=await lifecycleFixture({accounts:{[A]:{nonce:1n,code:'0x00'}}}),s=f.stateManager;
  await assert.rejects(s.applyAuthorization(addr(A),1n,D),{code:'LOCAL_STATE_INVALID'});
  await s.checkpoint();await assert.rejects(s.applyAuthorization(addr(A),1n,D),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(s.applyAuthorization(addr(E),1n,D),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(s.applyAuthorization(addr(E),0n,'0x12'),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(s.putCode(addr(E),bytes(designation(D))),{code:'LOCAL_STATE_UNSUPPORTED'});
  await s.revert();assert.deepEqual(s.snapshotChanges().accounts,[]);
});
