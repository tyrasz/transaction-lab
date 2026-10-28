import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { executeUnsignedCall } from '../execute.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, RUNTIME, SENDER, bytes, word } from './lifecycle-fixture.js';

const target=createdAddress({creator:SENDER,nonce:1n});
const senderAddress=createAddressFromString(SENDER),targetAddress=createAddressFromString(target);
async function run({init=initcode(),value='5',gasLimit='5000000',accounts={},limits,chainId=1,to=null,requestPatch={},withoutDeletionFinalizer=false}={}){
  const f=await lifecycleFixture({accounts}),origins=[];
  if(withoutDeletionFinalizer)f.stateManager.finalizeCreatedContractDeletion=undefined;
  const begin=f.stateManager.beginContractCreation.bind(f.stateManager);
  f.stateManager.beginContractCreation=(address,origin)=>{origins.push({address:address.toString(),origin});return begin(address,origin);};
  const request={from:SENDER,to,data:'0x'+init,value,gasLimit,...requestPatch};
  const result=await executeUnsignedCall({request,block:{...f.header,baseFeePerGas:'0'},stateManager:f.stateManager,blockchain:f.inputs.blockchain,chainId,...(limits?{limits}:{})});
  return{...f,result,origins};
}
async function nonceOnly(f){
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  assert.equal((await f.stateManager.getAccount(senderAddress)).balance,1000000n);
  assert.equal(await f.stateManager.getAccount(targetAddress),undefined);
  assert.equal(bytesToHex(await f.stateManager.getCode(targetAddress)),'0x');
  assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(targetAddress,bytes(word(0))))),0n);
}

test('explicit root CREATE executes constructor storage/value and derives address from original sender nonce',async()=>{
  const f=await run(),{result:r}=f;
  assert.equal(r.execution.status,'success',JSON.stringify(r));assert.equal(r.execution.returnData,'0x'+RUNTIME);
  assert.equal(r.trace.type,'CREATE');assert.equal(r.trace.from,SENDER);assert.equal(r.trace.caller,SENDER);
  assert.equal(r.trace.to,target);assert.equal(r.trace.executionAddress,target);assert.equal(r.trace.input,'0x'+initcode());
  assert.equal(r.trace.value,'0x5');assert.equal(r.trace.depth,0);assert.deepEqual(r.trace.calls,[]);
  assert.deepEqual(f.origins,[{address:target,origin:'top_level_contract_creation'}]);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(row=>row.address===target).existence,{before:false,after:true,basis:'top_level_contract_creation'});
  const account=await f.stateManager.getAccount(targetAddress);
  assert.equal(account.nonce,1n);assert.equal(account.balance,5n);assert.equal(bytesToHex(await f.stateManager.getCode(targetAddress)),'0x'+RUNTIME);
  assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(targetAddress,bytes(word(0))))),42n);
  assert.equal((await f.stateManager.getAccount(senderAddress)).nonce,2n);assert.equal((await f.stateManager.getAccount(senderAddress)).balance,999995n);
  assert.equal(r.stateDisposition,'message_result_retained_in_supplied_manager');
  assert.equal(r.semantics.warmAddresses,'sender_coinbase_and_fork_active_precompiles_creation_target_warmed_by_EVM_no_access_list');
  assert.equal(r.semantics.lifecycle,'top_level_CREATE_and_internal_CREATE_CREATE2_with_proven_deployable_targets_fork_selected_SELFDESTRUCT_finalization');
});

test('constructor ADDRESS, CALLER, ORIGIN and CALLVALUE use the new root context',async()=>{
  const f=await run({init:initcode(RUNTIME,'30600055336001553260025534600355'),value:'17'});
  assert.equal(f.result.execution.status,'success');
  for(const [slot,expected]of [[0,BigInt(target)],[1,BigInt(SENDER)],[2,BigInt(SENDER)],[3,17n]]){
    assert.equal(BigInt(bytesToHex(await f.stateManager.getStorage(targetAddress,bytes(word(slot))))),expected);
  }
});

test('prefunded deployable target retains funding without a false existence transition',async()=>{
  const f=await run({accounts:{[target]:{nonce:0n,balance:17n,code:'0x'}}});
  assert.equal(f.result.execution.status,'success');assert.equal((await f.stateManager.getAccount(targetAddress)).balance,22n);
  const row=f.stateManager.snapshotChanges().accounts.find(a=>a.address===target);
  assert.equal(Object.hasOwn(row,'existence'),false);assert.deepEqual(row.balance,{before:'0x11',after:'0x16'});assert.deepEqual(row.nonce,{before:'0x0',after:'0x1'});
});

test('collision consumes message budget, preserves target and increments only sender nonce',async()=>{
  for(const spec of [{nonce:1n,balance:17n,code:'0x'},{nonce:0n,balance:17n,code:'0x00'}]){
    const f=await run({accounts:{[target]:spec}});
    assert.equal(f.result.execution.status,'failed');assert.equal(f.result.execution.error,'create collision');assert.equal(f.result.execution.executionGasUsed,'5000000');
    assert.equal(f.result.trace.type,'CREATE');assert.equal(f.result.trace.to,target);assert.deepEqual(f.origins,[]);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
    const account=await f.stateManager.getAccount(targetAddress);assert.equal(account.nonce,spec.nonce);assert.equal(account.balance,17n);
    assert.equal(bytesToHex(await f.stateManager.getCode(targetAddress)),spec.code);
  }
});

test('constructor REVERT, invalid opcode and invalid runtime roll back target/value while retaining sender nonce',async()=>{
  for(const [init,status]of [['602a60005560006000fd','reverted'],['602a600055fe','failed'],[initcode('ef','602a600055'),'failed']]){
    const f=await run({init});assert.equal(f.result.execution.status,status);assert.equal(f.result.trace.to,target);await nonceOnly(f);
  }
});

test('code-deposit gas exact boundary and runtime-size bound execute through EthereumJS',async()=>{
  // Five PUSHes, CODECOPY base3 +copy3 +memory3 =24 execution gas,
  // followed by 200 gas for each of the 11 installed runtime bytes.
  const exact=24+200*(RUNTIME.length/2);
  const success=await run({init:initcode(RUNTIME,''),gasLimit:String(exact),value:'0'});
  assert.equal(success.result.execution.status,'success');assert.equal(success.result.execution.executionGasUsed,String(exact));
  const short=await run({init:initcode(RUNTIME,''),gasLimit:String(exact-1),value:'0'});
  assert.equal(short.result.execution.status,'failed');assert.equal(short.result.execution.executionGasUsed,String(exact-1));await nonceOnly(short);
  const oversized=await run({init:initcode('00'.repeat(24577),''),value:'0'});
  assert.equal(oversized.result.execution.status,'failed');await nonceOnly(oversized);
});

test('empty initcode creates an empty-runtime nonce-one account and accepts zero message gas',async()=>{
  const f=await run({init:'',value:'0',gasLimit:'0'});
  assert.equal(f.result.execution.status,'success');assert.equal(f.result.execution.executionGasUsed,'0');assert.equal(f.result.execution.returnData,'0x');
  assert.equal(f.result.trace.type,'CREATE');assert.equal(f.result.trace.to,target);
  assert.equal((await f.stateManager.getAccount(targetAddress)).nonce,1n);assert.equal(bytesToHex(await f.stateManager.getCode(targetAddress)),'0x');
  assert.equal(Object.hasOwn(f.stateManager.snapshotChanges().accounts.find(a=>a.address===target),'code'),false);
});

test('root constructor can perform nested creation with distinct origin markers and correct caller',async()=>{
  const nested=createdAddress({creator:target,nonce:1n});
  const f=await run({init:factoryCode(initcode(),{value:0,tail:'5060006000f3'}).slice(2),value:'0'});
  assert.equal(f.result.execution.status,'success');assert.equal(f.result.trace.type,'CREATE');assert.equal(f.result.trace.calls[0].type,'CREATE');
  assert.equal(f.result.trace.calls[0].from,target);assert.equal(f.result.trace.calls[0].caller,target);assert.equal(f.result.trace.calls[0].to,nested);
  assert.deepEqual(f.origins,[{address:target,origin:'top_level_contract_creation'},{address:nested,origin:'internal_contract_creation'}]);
  assert.equal((await f.stateManager.getAccount(targetAddress)).nonce,2n);
  assert.equal(bytesToHex(await f.stateManager.getCode(createAddressFromString(nested))),'0x'+RUNTIME);
});

test('missing deletion finalizer and host resource failure roll back all changes including sender nonce',async()=>{
  const destruct=await run({init:'602a60005573'+SENDER.slice(2)+'ff',withoutDeletionFinalizer:true});
  assert.equal(destruct.result.execution.status,'unsupported');assert.equal(destruct.result.execution.error.code,'LOCAL_LIFECYCLE_UNSUPPORTED');
  assert.deepEqual(destruct.stateManager.snapshotChanges().accounts,[]);assert.equal((await destruct.stateManager.getAccount(senderAddress)).nonce,1n);
  const limited=await run({limits:{returnBytes:1}});
  assert.equal(limited.result.execution.status,'unavailable');assert.equal(limited.result.execution.error.code,'LOCAL_RESOURCE_LIMIT');
  assert.deepEqual(limited.stateManager.snapshotChanges().accounts,[]);assert.equal((await limited.stateManager.getAccount(senderAddress)).nonce,1n);
});

test('missing destination, legacy chain creation, root salt and blob creation are rejected before any state read',async()=>{
  for(const options of [{requestPatch:{to:undefined}},{chainId:999},{requestPatch:{salt:word(1)}},{requestPatch:{blobVersionedHashes:['0x01'+'00'.repeat(31)]}}]){
    const f=await run(options);assert.equal(f.result.execution.error.code,'LOCAL_INVALID_INPUT');assert.deepEqual(f.calls,[]);assert.equal(f.result.trace,null);
  }
});

test('EthereumJS warms the derived CREATE address, including an explicitly empty access list',async()=>{
  const plain=await run({init:initcode(RUNTIME,''),value:'0'});
  const selfBalance=await run({init:initcode(RUNTIME,'303150'),value:'0',requestPatch:{accessList:[]}});
  assert.equal(selfBalance.result.execution.status,'success');
  // ADDRESS2 + warm BALANCE100 + POP2; a missing creation-target warming
  // would charge the cold2600 address access instead.
  assert.equal(BigInt(selfBalance.result.execution.executionGasUsed)-BigInt(plain.result.execution.executionGasUsed),104n);
  assert.equal(selfBalance.result.semantics.warmAddresses,'sender_coinbase_fork_active_precompiles_and_declared_access_list_creation_target_warmed_by_EVM');
});
