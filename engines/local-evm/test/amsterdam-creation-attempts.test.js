// Actual raw + isolated proof-backed execution; signed full-VM comparisons use
// shared pinned EthereumJS opcodes and separately apply product deltas to MPT.
// These are development controls, not independent-client/population evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { creationAttemptFixture as fixture,TARGET,account,code,compareAmsterdamFullVM,
  initcode,factoryCode,createdAddress,word,HELPER,IMPLEMENTATION,qty,callBytes,terminalCreation,reentrantCreation } from './amsterdam-creation-attempts-fixture.js';
const EMPTY_CODE='0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const STOP_CODE_HASH='0x'+Buffer.from(keccak_256(Uint8Array.of(0))).toString('hex');
const EMPTY_STORAGE='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
async function run(f,{status='success',isolated=true}={}){
  const output=await executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,chainId:11155111});
  assert.equal(output.execution.status,status,JSON.stringify(output.execution));const changes=f.stateManager.snapshotChanges();
  await compareAmsterdamFullVM(f,output,changes);
  if(isolated){const r=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc,chainId:11155111});assert.equal(r.status,'completed',JSON.stringify(r.error));assert.deepEqual(r.changes,changes);assert.deepEqual(r.output.trace,output.trace);assert.deepEqual(r.output.execution,output.execution);assert.equal(r.isolation.processClosed,true);}
  return{output,changes};
}
function attempts(frame){assert(Array.isArray(frame.creationAttempts),'Amsterdam entered frame needs explicit creationAttempts');return frame.creationAttempts;}
function entry(row,{position,type='CREATE',nonce=7n,value=0,init,target,disposition='entered',result=target,exists=false,targetNonce=0n,codeHash=EMPTY_CODE,storageRoot=EMPTY_STORAGE}){
  assert.deepEqual(Object.keys(row).sort(),['position','type','pc','nonceBefore','nonceAfter','value','input','salt','target','targetBefore','disposition','result'].sort());
  assert(Number.isSafeInteger(row.pc)&&row.pc>=0&&row.pc<=32768);assert.equal(row.position,position);assert.equal(row.type,type);assert.equal(row.nonceBefore,qty(nonce));assert.equal(row.nonceAfter,qty(nonce+1n));assert.equal(row.value,qty(value));assert.equal(row.input,'0x'+init);assert.equal(row.salt,type==='CREATE2'?word(123):null);assert.equal(row.target,target);assert.equal(row.disposition,disposition);assert.equal(row.result,qty(BigInt(result)));
  assert.deepEqual(row.targetBefore,{exists,nonce:qty(targetNonce),codeHash,storageRoot});
}
function unchangedTarget(changes,address){assert.equal(changes.accounts.some(row=>row.address===address),false);}

test('repeated CREATE2 records two increments with one constructor and no second endowment',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TARGET,kind:'CREATE2',init});
  const f=await fixture({body:factoryCode(init,{kind:'CREATE2',value:5,repeat:2})}),{output,changes}=await run(f);
  assert.equal(output.trace.calls.length,1);const a=attempts(output.trace);assert.equal(a.length,2);
  entry(a[0],{position:0,type:'CREATE2',init,target,value:5});
  entry(a[1],{position:1,type:'CREATE2',nonce:8n,init,target,value:5,disposition:'collision',result:'0x0',exists:true,targetNonce:1n,codeHash:STOP_CODE_HASH});
  assert.deepEqual(changes.accounts.find(x=>x.address===TARGET).nonce,{before:'0x7',after:'0x9'});
  assert.equal((await account(f.stateManager,TARGET)).balance,995n);assert.equal((await account(f.stateManager,target)).balance,5n);assert.equal(output.execution.returnData,word(0));
});

test('initial nonce/code collisions for both creation opcodes retain nonce but never transfer endowment',async()=>{
  for(const kind of['CREATE','CREATE2'])for(const collision of['nonce','code']){
    const init=initcode('00',''),target=createdAddress({creator:TARGET,kind,init});
    const initial={nonce:collision==='nonce'?3n:0n,balance:17n,code:collision==='code'?'0x00':'0x'};
    const f=await fixture({body:factoryCode(init,{kind,value:5}),accounts:{[target]:initial}}),{output,changes}=await run(f);
    assert.equal(output.trace.calls.length,0);const a=attempts(output.trace);assert.equal(a.length,1);
    entry(a[0],{position:0,type:kind,init,target,value:5,disposition:'collision',result:'0x0',exists:true,targetNonce:initial.nonce,codeHash:collision==='code'?STOP_CODE_HASH:EMPTY_CODE});
    if(collision==='code')assert.notEqual(a[0].targetBefore.codeHash,EMPTY_CODE);
    assert.deepEqual(changes.accounts.find(x=>x.address===TARGET).nonce,{before:'0x7',after:'0x8'});assert.equal((await account(f.stateManager,TARGET)).balance,1000n);assert.equal((await account(f.stateManager,target)).balance,17n);unchangedTarget(changes,target);assert.equal(output.execution.returnData,word(0));
  }
});

test('constructor REVERT/INVALID retain creator nonce but roll back value/code/storage',async()=>{
  for(const init of['600160005560006000fd','fe']){
    const target=createdAddress({creator:TARGET,init}),f=await fixture({body:factoryCode(init,{value:5,tail:'5000'})}),{output,changes}=await run(f);
    assert.equal(output.trace.calls.length,1);assert.equal(output.trace.calls[0].error,init==='fe'?'invalid opcode':'revert');
    const a=attempts(output.trace);assert.equal(a.length,1);entry(a[0],{position:0,init,target,value:5,result:'0x0'});
    assert.equal((await account(f.stateManager,TARGET)).nonce,8n);assert.equal((await account(f.stateManager,TARGET)).balance,1000n);assert.equal(await account(f.stateManager,target),undefined);unchangedTarget(changes,target);assert.equal(await code(f.stateManager,target),'0x');
  }
});

test('root and caught enclosing rollback discard observed collision increments and deployments',async()=>{
  const init=initcode('00','');
  for(const nested of[false,true]){
    const creator=nested?HELPER:TARGET,target=createdAddress({creator,kind:'CREATE2',init}),body=factoryCode(init,{kind:'CREATE2',value:5,repeat:2,tail:'5060006000fd'});
    const f=await fixture({body:nested?'0x'+callBytes(HELPER)+'00':body,accounts:nested?{[HELPER]:{nonce:7n,balance:1000n,code:body}}:{}}),{output,changes}=await run(f,{status:nested?'success':'reverted'});
    const frame=nested?output.trace.calls[0]:output.trace;assert.equal(frame.error,'revert');assert.equal(attempts(frame).length,2);assert.equal(attempts(frame)[1].disposition,'collision');
    assert.equal((await account(f.stateManager,creator)).nonce,7n);assert.equal((await account(f.stateManager,creator)).balance,1000n);unchangedTarget(changes,creator);unchangedTarget(changes,target);assert.equal(await account(f.stateManager,target),undefined);
  }
});

test('constructor-created child has separate nonce-one baseline and distinct attempt ancestry',async()=>{
  const inner=initcode('00',''),outer=factoryCode(inner,{value:0,tail:'5060006000f3'}).slice(2),target=createdAddress({creator:TARGET,init:outer}),grandchild=createdAddress({creator:target,nonce:1n,init:inner});
  const f=await fixture({body:factoryCode(outer,{value:0,tail:'5000'})}),{output}=await run(f);
  entry(attempts(output.trace)[0],{position:0,init:outer,target});entry(attempts(output.trace.calls[0])[0],{position:0,nonce:1n,init:inner,target:grandchild});
  assert.equal((await account(f.stateManager,TARGET)).nonce,8n);assert.equal((await account(f.stateManager,target)).nonce,2n);assert.equal((await account(f.stateManager,grandchild)).nonce,1n);
});

test('DELEGATECALL creations increment execution address, never implementation address',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TARGET,init});
  const f=await fixture({body:'0x'+callBytes(IMPLEMENTATION,{opcode:'f4'})+'00',accounts:{[IMPLEMENTATION]:{nonce:11n,code:factoryCode(init,{value:5})}}}),{output,changes}=await run(f);
  assert.equal(attempts(output.trace).length,0);const frame=output.trace.calls[0];assert.equal(frame.type,'DELEGATECALL');assert.equal(frame.executionAddress,TARGET);assert.equal(frame.to,IMPLEMENTATION);
  entry(attempts(frame)[0],{position:0,init,target,value:5});assert.equal(frame.calls[0].from,TARGET);assert.equal((await account(f.stateManager,TARGET)).nonce,8n);assert.equal((await account(f.stateManager,IMPLEMENTATION)).nonce,11n);unchangedTarget(changes,IMPLEMENTATION);
});

test('reentrant creation observes chronological nonce changes and resumed-parent positions',async()=>{
  const init=initcode('00',''),{body,helper}=reentrantCreation(init,TARGET),f=await fixture({body,accounts:{[HELPER]:{nonce:1n,code:helper}}}),{output}=await run(f);
  const root=output.trace,inner=root.calls[1].calls[0];assert.equal(inner.executionAddress,TARGET);assert.deepEqual(attempts(root).map(x=>[x.position,x.nonceBefore]),[[0,'0x7'],[2,'0x9']]);assert.deepEqual(attempts(inner).map(x=>[x.position,x.nonceBefore]),[[0,'0x8']]);
  for(const nonce of[7n,8n,9n])assert.equal((await account(f.stateManager,createdAddress({creator:TARGET,nonce,init}))).nonce,1n);
  assert.equal((await account(f.stateManager,TARGET)).nonce,10n);
});

test('balance/nonce fail-fast and inherited static creation produce no nonce-write attempts',async()=>{
  const init=initcode('00','');
  for(const options of[{balance:4n},{nonce:(1n<<64n)-1n}]){
    const f=await fixture({...options,body:factoryCode(init,{value:5})}),{output,changes}=await run(f);
    assert.equal(attempts(output.trace).length,0);assert.equal(output.trace.calls.length,0);unchangedTarget(changes,TARGET);assert.equal(output.execution.returnData,word(0));
  }
  const f=await fixture({body:'0x'+callBytes(HELPER,{opcode:'fa'})+'00',accounts:{[HELPER]:{nonce:7n,balance:1000n,code:factoryCode(init,{value:0})}}}),{output,changes}=await run(f);
  assert.equal(output.trace.calls[0].error,'static state change');assert.equal(attempts(output.trace.calls[0]).length,0);assert.equal(output.trace.calls[0].calls.length,0);unchangedTarget(changes,HELPER);
});

test('pre-target and account-state-charge OOG cannot be counted as nonce writes',async()=>{
  const init=initcode('00','');
  for(const gas of['16000','30000']){
    const f=await fixture({body:factoryCode(init,{value:0}),gas}),{output,changes}=await run(f,{status:'failed'});
    assert.equal(output.execution.error,'out of gas');assert.equal(attempts(output.trace).length,0);assert.equal(output.trace.calls.length,0);unchangedTarget(changes,TARGET);assert.equal((await account(f.stateManager,TARGET)).nonce,7n);
  }
});

test('CREATE as final opcode resolves success and no-child collision from terminal stack',async()=>{
  for(const collision of[false,true]){
    const init=initcode('00',''),target=createdAddress({creator:TARGET,init}),f=await fixture({body:terminalCreation(init),accounts:collision?{[target]:{nonce:1n,balance:17n}}:{}}),{output}=await run(f);
    const a=attempts(output.trace);assert.equal(a.length,1);entry(a[0],{position:0,init,target,disposition:collision?'collision':'entered',result:collision?'0x0':target,exists:collision,targetNonce:collision?1n:0n});
    assert.equal(output.execution.returnData,'0x');assert.equal((await account(f.stateManager,TARGET)).nonce,8n);
  }
});
