import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, FACTORY, SENDER, word, bytes } from './lifecycle-fixture.js';

// Synthetic authenticated inputs and real EthereumJS execution. These are
// behavioral controls, not provider observations or expected poststate inputs.
const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const BENEFICIARY=addr(0x4444),IMPLEMENTATION=addr(0x5555),MIDDLE=addr(0x6666),GETTER=addr(0x7777);
const sd=target=>'73'+target.slice(2)+'ff',FLAG='60005260206000f3';
const call=(target,{value=0,gas=65535,kind='CALL'}={})=>'6000600060006000'+(kind==='CALL'?'60'+value.toString(16).padStart(2,'0'):'')+'73'+target.slice(2)+'61'+gas.toString(16).padStart(4,'0')+({CALL:'f1',STATICCALL:'fa',DELEGATECALL:'f4'}[kind]);
const account=(state,a)=>state.getAccount(createAddressFromString(a));
const code=(state,a)=>state.getCode(createAddressFromString(a)).then(bytesToHex);
const slot=(state,a,n)=>state.getStorage(createAddressFromString(a),bytes(word(n))).then(value=>value.length?BigInt(bytesToHex(value)):0n);
const deletion=address=>({address,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT});
async function gone(f,target){
  const calls=f.calls.length;
  assert.equal(await account(f.stateManager,target),undefined);
  assert.equal(await code(f.stateManager,target),'0x');
  assert.equal(await slot(f.stateManager,target,0),0n);assert.equal(await slot(f.stateManager,target,991),0n);
  const copy=f.stateManager.shallowCopy();assert.equal(await code(copy,target),'0x');assert.equal(await slot(copy,target,992),0n);
  assert.equal(f.calls.length,calls,'deleted storage reads must not restore original proof facts');
}

test('root constructor SELFDESTRUCT transfers value and removes the whole new account only at finalization',async()=>{
  const f=await lifecycleFixture(),target=createdAddress({creator:SENDER,nonce:1n});
  const result=await executeEthereumCall({...f,request:{from:SENDER,to:null,data:'0x602a600055'+sd(BENEFICIARY),value:'5',gas:'5000000'}});
  assert.equal(result.execution.status,'success',JSON.stringify(result.execution));assert.equal(result.execution.returnData,'0x');
  assert.deepEqual(result.trace.selfdestruct,{beneficiary:BENEFICIARY});assert.equal(result.trace.to,target);
  assert.deepEqual(result.lifecycle,{finalizedDeletions:[deletion(target)]});assert.equal(result.execution.gasRefundCounter,'0');
  assert.equal((await account(f.stateManager,SENDER)).balance,999995n);assert.equal((await account(f.stateManager,BENEFICIARY)).balance,5n);
  assert.equal(f.stateManager.snapshotChanges().accounts.some(row=>row.address===target),false);await gone(f,target);
});

test('CREATE and CREATE2 remove prefunded targets with original balance loss and no surviving constructor state',async()=>{
  for(const kind of ['CREATE','CREATE2']){
    const init='602a600055'+sd(BENEFICIARY),target=createdAddress({kind,init});
    const f=await lifecycleFixture({code:factoryCode(init,{kind,value:5}),accounts:{[target]:{nonce:0n,balance:17n,code:'0x'}}});
    const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success',JSON.stringify(result.execution));
    assert.deepEqual(result.trace.calls[0].selfdestruct,{beneficiary:BENEFICIARY});assert.equal(result.trace.calls[0].type,kind);
    assert.deepEqual(result.lifecycle,{finalizedDeletions:[deletion(target)]});
    assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(row=>row.address===target),{address:target,existence:{before:true,after:false,basis:'same_invocation_created_contract_deletion'},balance:{before:'0x11',after:'0x0'}});
    assert.equal((await account(f.stateManager,BENEFICIARY)).balance,22n);await gone(f,target);
  }
});

test('self-beneficiary burns constructor value and prefunding without inventing a beneficiary credit',async()=>{
  const target=createdAddress({creator:SENDER,nonce:1n}),f=await lifecycleFixture({accounts:{[target]:{nonce:0n,balance:17n,code:'0x'}}});
  const result=await executeEthereumCall({...f,request:{from:SENDER,to:null,data:'0x'+sd(target),value:'7',gas:'5000000'}});
  assert.equal(result.execution.status,'success');assert.deepEqual(result.trace.selfdestruct,{beneficiary:target});
  assert.equal((await account(f.stateManager,SENDER)).balance,999993n);assert.equal(f.stateManager.snapshotChanges().accounts.length,2);await gone(f,target);
});

test('fresh runtime remains callable until finalization and repeated SELFDESTRUCT transfers are retained',async()=>{
  const init=initcode(sd(BENEFICIARY),'602a600055'),target=createdAddress();
  const tail='50'+call(target)+'50'+call(target,{value:7})+FLAG;
  const f=await lifecycleFixture({code:factoryCode(init,{value:5,tail})}),result=await executeEthereumCall(f);
  assert.equal(result.execution.status,'success');assert.equal(result.execution.returnData,word(1));
  assert.equal(result.trace.calls[0].output,'0x'+sd(BENEFICIARY));
  assert.deepEqual(result.trace.calls.slice(1).map(frame=>frame.selfdestruct),[{beneficiary:BENEFICIARY},{beneficiary:BENEFICIARY}]);
  assert.equal((await account(f.stateManager,BENEFICIARY)).balance,12n);assert.equal((await account(f.stateManager,FACTORY)).balance,988n);
  assert.deepEqual(result.lifecycle,{finalizedDeletions:[deletion(target)]});await gone(f,target);
});

test('funding a scheduled deletion again is burned at finalization rather than causing an unsupported outcome',async()=>{
  const init=initcode(sd(BENEFICIARY),''),target=createdAddress();
  const f=await lifecycleFixture({code:factoryCode(init,{value:5,tail:'50'+call(target)+'50'+call(IMPLEMENTATION)+'5000'}),accounts:{[IMPLEMENTATION]:{nonce:1n,balance:7n,code:'0x'+sd(target)}}});
  let atDeletion;const finalize=f.stateManager.finalizeCreatedContractDeletion.bind(f.stateManager);
  f.stateManager.finalizeCreatedContractDeletion=async address=>{atDeletion=(await account(f.stateManager,address.toString())).balance;await finalize(address);};
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');assert.equal(atDeletion,7n);
  assert.equal((await account(f.stateManager,BENEFICIARY)).balance,5n);assert.equal((await account(f.stateManager,IMPLEMENTATION)).balance,0n);
  assert.equal(await code(f.stateManager,IMPLEMENTATION),'0x'+sd(target));await gone(f,target);
});

test('same-invocation CREATE2 collision remains until finalization, then a fresh invocation can recreate',async()=>{
  const init=sd(BENEFICIARY),target=createdAddress({kind:'CREATE2',init});
  const f=await lifecycleFixture({code:factoryCode(init,{kind:'CREATE2',value:0,repeat:2})});
  for(let i=0;i<2;i++){
    const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');assert.equal(result.execution.returnData,word(0));
    assert.equal(result.trace.calls[0].error,null);assert.equal(result.trace.calls[1].error,'create collision');
    assert.deepEqual(result.lifecycle,{finalizedDeletions:[deletion(target)]});await gone(f,target);
  }
  assert.equal((await account(f.stateManager,FACTORY)).nonce,11n);
});

test('root and caught ancestor reverts discard committed-child deletion plans and value changes',async()=>{
  for(const caught of [false,true]){
    const init=sd(BENEFICIARY),middleCode=factoryCode(init,{value:5,tail:'5060006000fd'});
    const target=createdAddress({creator:caught?MIDDLE:FACTORY,nonce:caught?1n:7n});
    const f=await lifecycleFixture({code:caught?'0x'+call(MIDDLE)+FLAG:middleCode,accounts:{[MIDDLE]:{nonce:1n,balance:100n,code:middleCode}}});
    const result=await executeEthereumCall(f);assert.equal(result.execution.status,caught?'success':'reverted');
    const child=caught?result.trace.calls[0].calls[0]:result.trace.calls[0];assert.deepEqual(child.selfdestruct,{beneficiary:BENEFICIARY});
    assert.equal(Object.hasOwn(result,'lifecycle'),false);assert.equal(await account(f.stateManager,BENEFICIARY),undefined);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
    assert.equal(await account(f.stateManager,target),undefined);
  }
});

test('delegate SELFDESTRUCT deletes a new execution account but leaves old implementation intact',async()=>{
  const runtime=call(IMPLEMENTATION,{kind:'DELEGATECALL'})+'5000',init=initcode(runtime,''),target=createdAddress();
  const f=await lifecycleFixture({code:factoryCode(init,{value:5,tail:'50'+call(target)+FLAG}),accounts:{[IMPLEMENTATION]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');
  const delegated=result.trace.calls[1].calls[0];assert.equal(delegated.executionAddress,target);assert.equal(delegated.to,IMPLEMENTATION);
  assert.deepEqual(delegated.selfdestruct,{beneficiary:BENEFICIARY});assert.deepEqual(result.lifecycle,{finalizedDeletions:[deletion(target)]});
  assert.equal((await account(f.stateManager,IMPLEMENTATION)).balance,17n);assert.equal(await code(f.stateManager,IMPLEMENTATION),'0x'+sd(BENEFICIARY));await gone(f,target);
});

test('failed STATICCALL and OOG SELFDESTRUCT instructions produce no successful opcode evidence or deletion',async()=>{
  for(const options of [{kind:'STATICCALL'},{gas:5000}]){
    const init=initcode(sd(BENEFICIARY),''),target=createdAddress();
    const f=await lifecycleFixture({code:factoryCode(init,{value:5,tail:'50'+call(target,options)+FLAG})}),result=await executeEthereumCall(f);
    assert.equal(result.execution.status,'success');assert.equal(result.execution.returnData,word(0));
    assert.equal(Object.hasOwn(result.trace.calls[1],'selfdestruct'),false);assert.equal(Object.hasOwn(result,'lifecycle'),false);
    assert.equal((await account(f.stateManager,target)).balance,5n);assert.equal(await code(f.stateManager,target),'0x'+sd(BENEFICIARY));
  }
});

test('finalizer failure after a deletion rolls back every account and the sender nonce',async()=>{
  const init=sd(BENEFICIARY),targets=[7n,8n].map(nonce=>createdAddress({nonce}));
  const f=await lifecycleFixture({code:factoryCode(init,{value:5,repeat:2})}),calls=[];
  const finalize=f.stateManager.finalizeCreatedContractDeletion.bind(f.stateManager);
  f.stateManager.finalizeCreatedContractDeletion=async address=>{calls.push(address.toString());await finalize(address);if(calls.length===2)throw Error('synthetic finalizer failure');};
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'unavailable');assert.equal(result.stateDisposition,'rolled_back');
  assert.deepEqual(calls,[...targets].sort());assert.equal(Object.hasOwn(result,'lifecycle'),false);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f.stateManager,SENDER)).nonce,1n);assert.equal((await account(f.stateManager,FACTORY)).nonce,7n);
  assert.equal(await account(f.stateManager,BENEFICIARY),undefined);for(const target of targets)assert.equal(await account(f.stateManager,target),undefined);
});

test('deadline after deletion and missing finalizer fail closed with complete rollback',async()=>{
  for(const missing of [false,true]){
    const f=await lifecycleFixture({code:factoryCode(sd(BENEFICIARY))});let expired=false;
    if(missing)f.stateManager.finalizeCreatedContractDeletion=undefined;
    else{const finalize=f.stateManager.finalizeCreatedContractDeletion.bind(f.stateManager);f.stateManager.finalizeCreatedContractDeletion=async address=>{await finalize(address);expired=true;};}
    const result=await executeEthereumCall({...f,limits:{wallMs:100},now:()=>expired?101:0});
    assert.equal(result.execution.status,missing?'unsupported':'unavailable');assert.equal(result.execution.error.code,missing?'LOCAL_LIFECYCLE_UNSUPPORTED':'LOCAL_RESOURCE_LIMIT');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f.stateManager,SENDER)).nonce,1n);
  }
});

test('fresh after-query sees finalized absence and preserves the prefunded deletion overlay',async()=>{
  const init=sd(BENEFICIARY),target=createdAddress();
  // The getter is only an ABI-shaped query. Its bytecode reads native BALANCE;
  // the measurement is not evidence of token identity or economics.
  const f=await lifecycleFixture({code:factoryCode(init,{value:5}),accounts:{[target]:{nonce:0n,balance:17n,code:'0x'},[GETTER]:{nonce:1n,balance:0n,code:'0x73'+target.slice(2)+'3160005260206000f3'}}});
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}]});
  assert.equal(result.original.output.execution.status,'success');assert.equal(result.status,'complete',JSON.stringify(result));
  assert.equal(result.measurements[0].status,'measured');assert.deepEqual(result.measurements[0].values.map(row=>[row.beforeRaw,row.afterRaw,row.deltaRaw]),[['17','0','-17']]);
  assert.deepEqual(result.original.output.lifecycle,{finalizedDeletions:[deletion(target)]});
  assert.deepEqual(result.measurements[0].after.changesBefore.accounts.find(row=>row.address===target),result.original.changes.accounts.find(row=>row.address===target));
});
