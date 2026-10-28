import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { lifecycleFixture, createdAddress, FACTORY, bytes, word } from './lifecycle-fixture.js';
const target=createdAddress(),address=createAddressFromString(target);
async function fixture(storage=true){return lifecycleFixture({accounts:{[target]:{nonce:0n,balance:0n,code:'0x',storage:storage?{[word(0)]:word(42)}:{}}}});}

test('empty-account cleanup removes an authenticated nonempty storage trie without enumerating it',async()=>{
  const f=await fixture(),m=f.stateManager;
  assert.equal((await m.getAccount(address)).isEmpty(),true);
  const initialRoot=m.base.get(target).storageRoot;
  await m.checkpoint();m.beginEmptyAccountCleanup();await m.deleteAccount(address);
  assert.deepEqual(m.endEmptyAccountCleanup(),[{address:target,scope:'entire_account_including_code_and_storage',initialStorageRoot:initialRoot}]);
  await m.commit();const reads=f.calls.length;
  assert.equal(await m.getAccount(address),undefined);assert.equal(bytesToHex(await m.getCode(address)),'0x');
  for(const slot of [0,1,999])assert.ok((await m.getStorage(address,bytes(word(slot)))).every(v=>v===0));
  assert.equal(f.calls.length,reads);assert.equal(f.calls.some(c=>c.method==='eth_getProof'&&c.params[1].length>0),false);
  assert.deepEqual(m.snapshotChanges().accounts,[{address:target,existence:{before:true,after:false,basis:'eip161_empty_account_cleanup'}}]);
  const copy=m.shallowCopy();assert.equal(await copy.getAccount(address),undefined);assert.ok((await copy.getStorage(address,bytes(word(0)))).every(v=>v===0));
  assert.equal(copy.snapshotInputs().accounts[target].exists,true);
});

test('cleanup rollback restores loaded storage and account existence without changing immutable facts',async()=>{
  const {stateManager:m}=await fixture();assert.equal(bytesToHex(await m.getStorage(address,bytes(word(0)))),word(42));
  await m.checkpoint();await m.checkpoint();m.beginEmptyAccountCleanup();await m.deleteAccount(address);m.endEmptyAccountCleanup();await m.commit();
  assert.equal(await m.getAccount(address),undefined);await m.revert();
  assert.equal((await m.getAccount(address)).isEmpty(),true);assert.equal(bytesToHex(await m.getStorage(address,bytes(word(0)))),word(42));
  assert.deepEqual(m.snapshotChanges().accounts,[]);
});

test('cleanup window rejects arbitrary deletion, nested activation and live accounts',async()=>{
  const {stateManager:m}=await fixture();
  assert.throws(()=>m.beginEmptyAccountCleanup(),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(m.deleteAccount(address),{code:'LOCAL_STATE_UNSUPPORTED'});
  await m.checkpoint();m.beginEmptyAccountCleanup();
  assert.throws(()=>m.beginEmptyAccountCleanup(),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(m.deleteAccount(createAddressFromString(FACTORY)),{code:'LOCAL_STATE_UNSUPPORTED'});
  assert.deepEqual(m.endEmptyAccountCleanup(),[]);assert.throws(()=>m.endEmptyAccountCleanup(),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(m.deleteAccount(address),{code:'LOCAL_STATE_UNSUPPORTED'});await m.revert();
});

test('positive funding preserves an existing empty account and its storage',async()=>{
  const {stateManager:m}=await fixture();const account=await m.getAccount(address);account.balance=7n;await m.putAccount(address,account);
  await m.checkpoint();m.beginEmptyAccountCleanup();await assert.rejects(m.deleteAccount(address),{code:'LOCAL_STATE_UNSUPPORTED'});m.endEmptyAccountCleanup();await m.revert();
  assert.equal((await m.getAccount(address)).balance,7n);assert.equal(bytesToHex(await m.getStorage(address,bytes(word(0)))),word(42));
});

test('rematerializing an initially nonempty trie stays unsupported until its reset can be represented',async()=>{
  const {stateManager:m}=await fixture();await m.checkpoint();m.beginEmptyAccountCleanup();await m.deleteAccount(address);m.endEmptyAccountCleanup();await m.commit();
  await assert.rejects(m.putAccount(address,new Account(0n,7n)),{code:'LOCAL_STATE_UNSUPPORTED'});assert.ok((await m.getStorage(address,bytes(word(0)))).every(v=>v===0));
  await m.checkpoint();assert.throws(()=>m.beginContractCreation(address),{code:'LOCAL_STATE_UNSUPPORTED'});await m.revert();
});
