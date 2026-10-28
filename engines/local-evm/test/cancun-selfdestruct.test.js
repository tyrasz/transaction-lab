import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeUnsignedCall } from '../execute.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';

// Synthetic authenticated starting facts; every effect comes from real bytecode.
const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const BENEFICIARY=address(0x4444),CHILD=address(0x5555),MIDDLE=address(0x6666),GETTER=address(0x7777);
const sd=target=>'73'+target.slice(2)+'ff';
const call=(target,{value=0,gas=65535,kind='CALL'}={})=>'6000600060006000'+(kind==='CALL'?'60'+value.toString(16).padStart(2,'0'):'')+'73'+target.slice(2)+'61'+gas.toString(16).padStart(4,'0')+({CALL:'f1',DELEGATECALL:'f4',STATICCALL:'fa'}[kind]);
const flag='60005260206000f3';
async function fixture({code='0x'+sd(BENEFICIARY),balance=1000n,accounts={}}={}){
  return lifecycleFixture({code,accounts:{[FACTORY]:{nonce:7n,balance,code,storage:{[word(0)]:9n}},...accounts}});
}
const account=(f,a)=>f.stateManager.getAccount(createAddressFromString(a));
const code=(f,a)=>f.stateManager.getCode(createAddressFromString(a)).then(bytesToHex);
const storage=(f,a)=>f.stateManager.getStorage(createAddressFromString(a),bytes(word(0))).then(b=>BigInt(bytesToHex(b)));
function noDeletion(f){assert.ok(f.stateManager.snapshotChanges().accounts.every(row=>!row.code&&!row.storage&&row.existence?.after!==false));}

test('Cancun SELFDESTRUCT transfers value to a proven absent beneficiary and preserves code/storage/nonce',async()=>{
  const f=await fixture();f.request.value='5';const result=await executeEthereumCall(f);
  assert.equal(result.execution.status,'success',JSON.stringify(result));assert.equal(result.execution.returnData,'0x');assert.equal(result.execution.gasRefundCounter,'0');
  assert.equal(result.semantics.lifecycle,'preexisting_Cancun_SELFDESTRUCT_without_deletion_same_invocation_creation_and_Shanghai_SELFDESTRUCT_unsupported');
  assert.equal((await account(f,FACTORY)).balance,0n);assert.equal((await account(f,FACTORY)).nonce,7n);
  assert.equal((await account(f,BENEFICIARY)).balance,1005n);assert.equal((await account(f,BENEFICIARY)).nonce,0n);
  assert.equal((await account(f,SENDER)).balance,999995n);assert.equal(await code(f,FACTORY),'0x'+sd(BENEFICIARY));assert.equal(await storage(f,FACTORY),9n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(row=>row.address===BENEFICIARY).existence,{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'});
  assert.equal(result.execution.executionGasUsed,'32603');assert.deepEqual(result.logs,[]);noDeletion(f);
});

test('self-beneficiary keeps the entire balance and zero-value absent recipient stays absent',async()=>{
  const self=await fixture({code:'0x'+sd(FACTORY)}),a=await executeEthereumCall(self);
  assert.equal(a.execution.status,'success');assert.equal((await account(self,FACTORY)).balance,1000n);assert.equal(await storage(self,FACTORY),9n);
  assert.deepEqual(self.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  const zero=await fixture({balance:0n}),b=await executeEthereumCall(zero);
  assert.equal(b.execution.status,'success');assert.equal(await account(zero,BENEFICIARY),undefined);assert.equal(await code(zero,FACTORY),'0x'+sd(BENEFICIARY));
  assert.deepEqual(zero.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
});

test('retained code can SELFDESTRUCT again after refunding within the same invocation',async()=>{
  const f=await fixture({code:'0x'+call(CHILD)+'50'+call(CHILD,{value:7})+'50'+'00',accounts:{
    [CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY),storage:{[word(0)]:23n}},[BENEFICIARY]:{nonce:1n,balance:5n,code:'0x'},
  }});
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');assert.equal(result.trace.calls.length,2);
  assert.equal((await account(f,BENEFICIARY)).balance,29n);assert.equal((await account(f,CHILD)).balance,0n);assert.equal((await account(f,FACTORY)).balance,993n);
  assert.equal(await code(f,CHILD),'0x'+sd(BENEFICIARY));assert.equal(await storage(f,CHILD),23n);assert.equal(result.execution.gasRefundCounter,'0');noDeletion(f);
});

test('DELEGATECALL destroys neither implementation nor proxy and transfers only execution-context balance',async()=>{
  const proxy='0x'+call(CHILD,{kind:'DELEGATECALL'})+'50'+'00';
  const f=await fixture({code:proxy,accounts:{[CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');
  assert.equal(result.trace.calls[0].executionAddress,FACTORY);assert.equal(result.trace.calls[0].to,CHILD);
  assert.equal((await account(f,FACTORY)).balance,0n);assert.equal((await account(f,CHILD)).balance,17n);assert.equal((await account(f,BENEFICIARY)).balance,1000n);
  assert.equal(await code(f,FACTORY),proxy);assert.equal(await code(f,CHILD),'0x'+sd(BENEFICIARY));assert.equal(await storage(f,FACTORY),9n);noDeletion(f);
});

test('STATICCALL and insufficient opcode gas remain caught EVM failures without transfer',async()=>{
  for(const options of [{kind:'STATICCALL'},{gas:5000}]){
    const f=await fixture({code:'0x'+call(CHILD,options)+flag,accounts:{[CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
    const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success');assert.equal(result.execution.returnData,word(0));
    assert.equal(result.trace.calls[0].error,options.kind?'static state change':'out of gas');
    assert.equal((await account(f,CHILD)).balance,17n);assert.equal(await account(f,BENEFICIARY),undefined);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  }
});

test('root revert and caught ancestor revert undo successful SELFDESTRUCT transfers',async()=>{
  for(const nested of [false,true]){
    const middle='0x'+call(CHILD)+'50'+'60006000fd';
    const f=await fixture({code:nested?'0x'+call(MIDDLE)+flag:middle,accounts:{[CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)},[MIDDLE]:{nonce:1n,balance:0n,code:middle}}});
    const result=await executeEthereumCall(f);assert.equal(result.execution.status,nested?'success':'reverted');
    assert.equal((await account(f,CHILD)).balance,17n);assert.equal(await account(f,BENEFICIARY),undefined);assert.equal(await code(f,CHILD),'0x'+sd(BENEFICIARY));
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  }
});

test('Shanghai and legacy999 SELFDESTRUCT stay unsupported with complete rollback',async()=>{
  for(const chainId of [1,999]){
    const f=await fixture();
    const request={from:SENDER,to:FACTORY,data:'0x',value:'0',gasLimit:'100000'};
    const actual=await executeUnsignedCall({chainId,request,block:{...f.header,baseFeePerGas:'0',...(chainId===1?{timestamp:'1710338134'}:{})},stateManager:f.stateManager});
    assert.equal(actual.execution.status,'unsupported');assert.equal(actual.execution.error.code,'LOCAL_LIFECYCLE_UNSUPPORTED');
    if(chainId===999)assert.equal(actual.semantics.lifecycle,'CREATE_CREATE2_SELFDESTRUCT_unsupported');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f,SENDER)).nonce,1n);
  }
  const ordinary=await fixture({code:'0x00'});
  assert.equal((await executeEthereumCall(ordinary)).semantics.lifecycle,'no_lifecycle_operation_encountered');
});

test('constructor SELFDESTRUCT and later calls to freshly created runtime stay unsupported',async()=>{
  const direct=await lifecycleFixture();
  const root=await executeEthereumCall({...direct,request:{from:SENDER,to:null,data:'0x'+sd(BENEFICIARY),value:'5',gas:'5000000'}});
  assert.equal(root.execution.status,'unsupported');assert.deepEqual(direct.stateManager.snapshotChanges().accounts,[]);
  for(const kind of ['CREATE','CREATE2']){
    const init=initcode(sd(BENEFICIARY),'');
    // Save the created address and CALL its retained runtime in this same tx.
    const tail='6000526000600060006000600060005161fffff15000';
    const f=await lifecycleFixture({code:factoryCode(init,{kind,value:5,tail})});const result=await executeEthereumCall(f);
    assert.equal(result.execution.status,'unsupported');assert.equal(result.execution.error.code,'LOCAL_LIFECYCLE_UNSUPPORTED');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f,SENDER)).nonce,1n);
  }
});

test('an original-created contract is preexisting in a fresh after-query; self destruction preserves the original overlay',async()=>{
  const target=createdAddress(),runtime=sd(target),init=initcode(runtime,'');
  const f=await lifecycleFixture({code:factoryCode(init,{value:5}),accounts:{[GETTER]:{nonce:1n,balance:0n,code:'0x'+call(target)+'50'+'602a60005260206000f3'}}});
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}]});
  assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.original.output.execution.status,'success');
  assert.equal(result.measurements[0].status,'measured');assert.deepEqual(result.measurements[0].values.map(row=>[row.beforeRaw,row.afterRaw,row.deltaRaw]),[['42','42','0']]);
  assert.equal(result.measurements[0].after.output.trace.calls[0].error,null);
  assert.equal(result.original.changes.accounts.find(row=>row.address===target).code.after,'0x'+runtime);
  assert.deepEqual(result.original.changes.accounts.find(row=>row.address===target).balance,{before:'0x0',after:'0x5'});
});

test('fresh query SELFDESTRUCT transfer is rejected by net-mutation checks without changing original state',async()=>{
  const target=createdAddress(),runtime=sd(BENEFICIARY),init=initcode(runtime,'');
  const f=await lifecycleFixture({code:factoryCode(init,{value:5}),accounts:{[GETTER]:{nonce:1n,balance:0n,code:'0x'+call(target)+'50'+'602a60005260206000f3'}}});
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}]});
  assert.equal(result.status,'partial');assert.equal(result.measurements[0].before.status,'measured');assert.equal(result.measurements[0].after.status,'unavailable');
  assert.equal(result.measurements[0].after.output.execution.status,'success');assert.equal(result.measurements[0].values,null);
  assert.deepEqual(result.original.changes.accounts.find(row=>row.address===target).balance,{before:'0x0',after:'0x5'});
  assert.equal(result.original.changes.accounts.some(row=>row.address===BENEFICIARY),false);
});

test('proven existing empty account and all direct deletion operations remain refused',async()=>{
  const f=await fixture({accounts:{[BENEFICIARY]:{nonce:0n,balance:0n,code:'0x'}}}),result=await executeEthereumCall(f);
  assert.equal(result.execution.status,'unsupported');assert.equal(result.execution.error.code,'LOCAL_STATE_UNSUPPORTED');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
  await assert.rejects(f.stateManager.deleteAccount(createAddressFromString(FACTORY)),{code:'LOCAL_STATE_UNSUPPORTED'});
});

test('failed CREATE2 collision does not mark a preexisting SELFDESTRUCT target as newly created',async()=>{
  const init=initcode('00',''),target=createdAddress({kind:'CREATE2',init});
  const f=await lifecycleFixture({code:factoryCode(init,{kind:'CREATE2',value:0,tail:'50'+call(target)+flag}),accounts:{[target]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success',JSON.stringify(result.execution));
  assert.equal(result.trace.calls[0].error,'create collision');assert.equal(result.trace.calls[1].error,null);assert.equal(result.execution.returnData,word(1));
  assert.equal((await account(f,BENEFICIARY)).balance,17n);assert.equal((await account(f,target)).nonce,1n);assert.equal(await code(f,target),'0x'+sd(BENEFICIARY));
});

test('old execution account may delegate to fresh code; created code address does not authorize deletion',async()=>{
  const init=initcode(sd(BENEFICIARY),'');
  // CREATE leaves the implementation address on the stack. Save and delegate
  // using that runtime while the existing factory remains execution context.
  const tail='600052600060006000600060005161fffff4'+flag;
  const target=createdAddress({init});
  const f=await lifecycleFixture({code:factoryCode(init,{value:0,tail})});
  const result=await executeEthereumCall(f);assert.equal(result.execution.status,'success',JSON.stringify(result.execution));
  assert.equal(result.trace.calls[1].to,target);assert.equal(result.trace.calls[1].executionAddress,FACTORY);assert.equal(result.trace.calls[1].error,null);
  assert.equal((await account(f,BENEFICIARY)).balance,1000n);assert.equal((await account(f,FACTORY)).balance,0n);
  assert.equal((await account(f,target)).nonce,1n);assert.equal(await code(f,target),'0x'+sd(BENEFICIARY));
});
