import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, RUNTIME, FACTORY, SENDER, bytes, hex, word } from './lifecycle-fixture.js';

for (const kind of ['CREATE','CREATE2']) test(`${kind} deploys runtime and constructor storage from proven absent state`, async()=>{
  const init=initcode(), target=createdAddress({kind,init}), f=await lifecycleFixture({code:factoryCode(init,{kind})});
  const result=await executeEthereumCall(f); assert.equal(result.execution.status,'success'); assert.equal(result.execution.returnData,'0x'+target.slice(2).padStart(64,'0'));
  const child=result.trace.calls[0]; assert.equal(child.type,kind); assert.equal(child.to,target); assert.equal(child.executionAddress,target); assert.equal(child.error,null); assert.equal(child.input,'0x'+init); assert.equal(child.output,'0x'+RUNTIME);
  const addr=createAddressFromString(target), account=await f.stateManager.getAccount(addr);
  assert.equal(account.nonce,1n); assert.equal(account.balance,5n); assert.equal(hex(account.codeHash),hex(keccak_256(bytes('0x'+RUNTIME))));
  assert.equal(bytesToHex(await f.stateManager.getCode(addr)),'0x'+RUNTIME); assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(addr,bytes(word(0))))),42n);
  const change=f.stateManager.snapshotChanges().accounts.find(a=>a.address===target);
  assert.deepEqual(change.existence,{before:false,after:true,basis:'internal_contract_creation'}); assert.deepEqual(change.code,{before:'0x',after:'0x'+RUNTIME}); assert.deepEqual(change.storage,[{slot:word(0),before:word(0),after:word(42)}]);
  assert.deepEqual(f.stateManager.snapshotInputs().accounts[target],{exists:false});
  assert.equal((await f.stateManager.getAccount(createAddressFromString(FACTORY))).nonce,8n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(FACTORY))).balance,995n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(SENDER))).nonce,2n);
});

test('prefunded deployable targets retain existing balance and never fabricate account existence',async()=>{
  const target=createdAddress(),f=await lifecycleFixture({accounts:{[target]:{balance:17n}}});
  assert.equal((await executeEthereumCall(f)).execution.status,'success');
  const change=f.stateManager.snapshotChanges().accounts.find(a=>a.address===target);
  assert.equal(Object.hasOwn(change,'existence'),false); assert.deepEqual(change.balance,{before:'0x11',after:'0x16'}); assert.deepEqual(change.nonce,{before:'0x0',after:'0x1'}); assert.deepEqual(change.code,{before:'0x',after:'0x'+RUNTIME});
});

test('constructor REVERT and EVM faults return zero, revert child state and retain creator nonce when parent continues',async()=>{
  for(const init of ['602a60005560006000fd','602a600055fe',initcode('ef','602a600055')]){
    const target=createdAddress({init}),f=await lifecycleFixture({code:factoryCode(init)}),r=await executeEthereumCall(f);
    assert.equal(r.execution.status,'success'); assert.equal(r.execution.returnData,word(0)); assert.ok(r.trace.calls[0].error); assert.equal(r.trace.calls[0].to,target);
    assert.equal(await f.stateManager.getAccount(createAddressFromString(target)),undefined); assert.equal(bytesToHex(await f.stateManager.getCode(createAddressFromString(target))),'0x');
    assert.equal(f.stateManager.snapshotChanges().accounts.some(a=>a.address===target),false); assert.equal((await f.stateManager.getAccount(createAddressFromString(FACTORY))).nonce,8n);
    assert.equal((await f.stateManager.getAccount(createAddressFromString(FACTORY))).balance,1000n);
  }
});

test('parent REVERT removes deployed code, storage, funding and creator nonce while retaining outer sender nonce',async()=>{
  const f=await lifecycleFixture({code:factoryCode(initcode(),{tail:'5060006000fd'})}),r=await executeEthereumCall(f);
  assert.equal(r.execution.status,'reverted'); assert.equal(r.trace.calls[0].error,null);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  const addr=createAddressFromString(createdAddress()); assert.equal(await f.stateManager.getAccount(addr),undefined); assert.equal(bytesToHex(await f.stateManager.getCode(addr)),'0x'); assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(addr,bytes(word(0))))),0n);
  await assert.rejects(f.stateManager.putCode(addr,bytes('0x00')),{code:'LOCAL_STATE_UNSUPPORTED'});
});

test('CREATE2 collision preserves first deployment and charges the second creator nonce without replacing code',async()=>{
  const init=initcode(),target=createdAddress({kind:'CREATE2',init}),f=await lifecycleFixture({code:factoryCode(init,{kind:'CREATE2',repeat:2})}),r=await executeEthereumCall(f);
  assert.equal(r.execution.status,'success');assert.equal(r.execution.returnData,word(0));assert.equal(r.trace.calls.length,2);assert.equal(r.trace.calls[0].error,null);assert.equal(r.trace.calls[1].error,'create collision');
  assert.equal((await f.stateManager.getAccount(createAddressFromString(FACTORY))).nonce,9n);assert.equal((await f.stateManager.getAccount(createAddressFromString(target))).balance,5n);assert.equal(bytesToHex(await f.stateManager.getCode(createAddressFromString(target))),'0x'+RUNTIME);
});

test('empty-runtime creation is still an existing nonce-one account',async()=>{
  const init='60006000f3',target=createdAddress({init}),f=await lifecycleFixture({code:factoryCode(init,{value:0})}),r=await executeEthereumCall(f);
  assert.equal(r.execution.status,'success'); const change=f.stateManager.snapshotChanges().accounts.find(a=>a.address===target);
  assert.deepEqual(change.existence,{before:false,after:true,basis:'internal_contract_creation'});assert.deepEqual(change.nonce,{before:'0x0',after:'0x1'});assert.equal(Object.hasOwn(change,'code'),false);
});

test('constructor SELFDESTRUCT without a deletion finalizer atomically rolls back attempted changes',async()=>{
  const f=await lifecycleFixture({code:factoryCode('602a60005573'+SENDER.slice(2)+'ff')});f.stateManager.finalizeCreatedContractDeletion=undefined;const r=await executeEthereumCall(f);
  assert.equal(r.execution.status,'unsupported');assert.equal(r.execution.error.code,'LOCAL_LIFECYCLE_UNSUPPORTED');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
});

test('created-account zero slot derivation respects the shared input slot limit and rolls back exhaustion',async()=>{
  const f=await lifecycleFixture({code:factoryCode(initcode(RUNTIME,'602a600055602b600155')),limits:{slots:1}}),r=await executeEthereumCall(f);
  assert.equal(r.execution.status,'unavailable');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal(f.inputs.snapshotUsage().status,'unavailable');
});

test('creation state survives a settled copy without aliasing mutable code or storage',async()=>{
  const target=createdAddress(),f=await lifecycleFixture();assert.equal((await executeEthereumCall(f)).execution.status,'success');
  const copy=f.stateManager.shallowCopy(),addr=createAddressFromString(target);await copy.putStorage(addr,bytes(word(0)),bytes('0x63'));
  assert.equal(BigInt(bytesToHex(await copy.getStorage(addr,bytes(word(0))))),99n);assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(addr,bytes(word(0))))),42n);
  const code=await copy.getCode(addr);code[0]=0;assert.equal(bytesToHex(await f.stateManager.getCode(addr)),'0x'+RUNTIME);await assert.rejects(copy.putCode(addr,bytes('0x00')),{code:'LOCAL_STATE_UNSUPPORTED'});
});
