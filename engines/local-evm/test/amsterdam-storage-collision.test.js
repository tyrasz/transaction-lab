// Nonce-zero, code-empty targets may be created over after clearing their old
// storage. These are authenticated synthetic bytecode controls. The unpatched
// fixture VM is used only for contrasts that do not create over old storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bytesToHex} from '@ethereumjs/util';
import {executeEthereumCall} from '../ethereum-call.js';
import {feeFixture,feeCommon} from './fee-fixture.js';
import {program,createParts} from './amsterdam-creation-attempts-fixture.js';
import {AUTHORITY,signAuthorization} from './authorization-fixture.js';
import {executeIsolatedEthereumCall,executeIsolatedEthereumPreview} from '../isolated-call.js';
import {amsterdamStorageCollisionFixture as fixture,amsterdamExecutionFixture,compareStorageCollisionFullVM,initialStorageRoot,storageCollisionDiagnosticFixture,
 TX_SENDER,TARGET,HELPER,DELEGATE,GETTER,EMPTY_STORAGE_ROOT,HIDDEN_STORAGE,RETURN42,REVERT,STORAGE_SENTINEL_RUNTIME,
 account,code,slot,word,designation,initcode,factoryCode,createdAddress,callBytes,storageOnlyAccount,selfAuthorization,native,scalar} from './amsterdam-storage-collision-fixture.js';
const raw=f=>executeEthereumCall({request:f.request,header:f.header,chainId:f.chainId??1,stateManager:f.stateManager,blockchain:f.inputs.blockchain});
function noHiddenDemand(f,address){
 const proofs=f.calls.filter(c=>c.method==='eth_getProof'&&c.params[0]===address);assert(proofs.length>0);
 assert(proofs.every(c=>c.params[1].length===0),'Creation clearing must not enumerate or demand old storage slots');
}
async function executed(f,status='success'){
 const output=await raw(f);assert.equal(output.execution.status,status,JSON.stringify(output.execution));
 const changes=f.stateManager.snapshotChanges();
 const r=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:f.chainId??1,rpc:f.rpc});
 assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,status);assert.deepEqual(r.changes,changes);
 for(const key of['execution','trace','logs','gasAccounting','stateGasAccounting','authorizationProcessing','lifecycle'])assert.deepEqual(r.output[key],output[key]);
 assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
 return{output,isolated:r};
}
async function cleared(f,address,{balance=22n,runtime='00',storage=[]}={}){
 noHiddenDemand(f,address);
 const a=await account(f.stateManager,address),row=f.stateManager.snapshotChanges().accounts.find(r=>r.address===address);
 assert.equal(a.nonce,1n);assert.equal(a.balance,balance);assert.equal(await code(f.stateManager,address),'0x'+runtime);
 assert.deepEqual(row.reset,{basis:'contract_creation_storage_clear',initialStorageRoot:await initialStorageRoot(f,address)});
 assert.equal(row.existence,undefined);assert.deepEqual(row.storage??[],storage);
 assert.equal(await slot(f.stateManager,address,0),0n);assert.equal(await slot(f.stateManager,address,991),0n);
 noHiddenDemand(f,address);
}
async function hiddenUnchanged(f,address,balance=17n){
 noHiddenDemand(f,address);const a=await account(f.stateManager,address);
 assert.equal(a.nonce,0n);assert.equal(a.balance,balance);assert.equal(await code(f.stateManager,address),'0x');
 assert.equal(bytesToHex(a.storageRoot),await initialStorageRoot(f,address));assert.notEqual(bytesToHex(a.storageRoot),EMPTY_STORAGE_ROOT);
 // These explicit post-test reads occur only after checking execution never
 // demanded hidden slots; they are not inputs to the attempted creation.
 for(const[key,value]of Object.entries(HIDDEN_STORAGE))assert.equal(await slot(f.stateManager,address,BigInt(key)),value);
}

test('priced/unpriced internal CREATE and CREATE2 clear storage-only targets and retain new creation effects',async()=>{
 for(const priced of[false,true])for(const kind of['CREATE','CREATE2']){
  const f=await fixture({priced,kind}),{output}=await executed(f);
  assert.equal((await account(f.stateManager,TARGET)).nonce,8n);assert.equal((await account(f.stateManager,TARGET)).balance,995n);assert.equal(await slot(f.stateManager,TARGET,1),42n);
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
  assert.equal(output.trace.calls[0].error,null);assert.equal(output.trace.creationAttempts[0].disposition,'entered');
  await cleared(f,f.collisionAddress);
 }
});

test('zero-balance hidden-storage targets deploy with a complete cleared namespace',async()=>{
 for(const kind of['CREATE','CREATE2']){
  const f=await fixture({kind,collisionBalance:0n,tail:'60005260206000f3'});await executed(f);await cleared(f,f.collisionAddress,{balance:5n});
  assert.equal((await account(f.stateManager,TARGET)).nonce,8n);
 }
});

test('ancestor REVERT restores cleared storage while a caught successful child retains its deployment',async()=>{
 for(const mode of['root_revert','caught_child','caught_reverted_child']){
  const nested=mode!=='root_revert',creator=nested?HELPER:TARGET,init=initcode('00','');
  // Writes before CREATE distinguish child rollback from a committed child,
  // and the outer write distinguishes a caught revert from a root revert.
  const {copy,op}=createParts(init,{kind:'CREATE2',value:5});
  const corrected=program(['602a600155',...copy,op+'50'+(mode==='caught_child'?'00':REVERT),{label:'init'},init]);
  const f=await fixture({creator,body:corrected,...(nested?{accounts:{[TARGET]:{nonce:7n,balance:1000n,code:'0x602b600155'+callBytes(HELPER)+RETURN42,storage:{[word(1)]:5n}}}}:{})});
  await executed(f,mode==='root_revert'?'reverted':'success');
  const retained=mode==='caught_child';
  assert.equal((await account(f.stateManager,creator)).nonce,retained?8n:7n);
  assert.equal((await account(f.stateManager,creator)).balance,retained?995n:1000n);
  assert.equal(await slot(f.stateManager,creator,1),retained?42n:5n);
  assert.equal(await slot(f.stateManager,TARGET,1),nested?43n:5n);
  if(retained)await cleared(f,f.collisionAddress);else{
   assert.equal(f.stateManager.snapshotChanges().accounts.some(row=>row.address===f.collisionAddress),false);
   await hiddenUnchanged(f,f.collisionAddress);
  }
 }
});

test('root CREATE clears hidden storage before constructor reads and writes',async()=>{
 for(const priced of[false,true]){
  const f=await storageCollisionDiagnosticFixture({rootCreate:true,priced});await executed(f);
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
  await cleared(f,f.collisionAddress,{runtime:STORAGE_SENTINEL_RUNTIME,storage:[{slot:word(2),before:word(0),after:word(42)}]});
  assert.equal(await slot(f.stateManager,f.collisionAddress,1),0n);assert.equal(await slot(f.stateManager,f.collisionAddress,2),42n);
 }
});

test('Shanghai through Osaka root CREATE and internal CREATE/CREATE2 clear storage-only targets',async()=>{
 for(const fork of['shanghai','cancun','prague','osaka'])for(const mode of['root','CREATE','CREATE2']){
  const init=initcode('00','602a600255'),creator=mode==='root'?TX_SENDER:TARGET,nonce=mode==='root'?1n:7n,kind=mode==='CREATE2'?'CREATE2':'CREATE';
  const target=createdAddress({creator,nonce,kind,init}),base=await feeFixture({fork,...(mode==='root'?{to:null,data:'0x'+init,value:'5'}:{target:{nonce:7n,balance:1000n,code:factoryCode(init,{kind,value:5})}}),accounts:{[target]:storageOnlyAccount()}});
  const f={...base,chainId:1,common:feeCommon(base)};await executed(f);await cleared(f,target,{storage:[{slot:word(2),before:word(0),after:word(42)}]});
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal(await slot(f.stateManager,target,2),42n);
  if(mode!=='root'){assert.equal((await account(f.stateManager,TARGET)).nonce,8n);assert.equal((await account(f.stateManager,TARGET)).balance,995n);}
 }
});

test('delegated sender and self-authorization retain preparation through successful clearing and a subsequent real collision',async()=>{
 const init=initcode('00',''),target=createdAddress({creator:TX_SENDER,kind:'CREATE2',init});
 for(const authorized of[false,true]){
  const beforeCode=authorized?'0x':designation(DELEGATE),f=await amsterdamExecutionFixture({to:TX_SENDER,sender:{code:beforeCode},...(authorized?{authorizationList:[selfAuthorization()]}:{}),accounts:{
   [DELEGATE]:{nonce:1n,balance:9n,code:factoryCode(init,{kind:'CREATE2',value:5,repeat:2})},[target]:storageOnlyAccount(),
  }}),{output}=await executed(f);
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,authorized?5n:4n);assert.equal(await code(f.stateManager,TX_SENDER),designation(DELEGATE));
  assert.equal(output.trace.calls.length,1);assert.equal(output.trace.calls[0].error,null);
  assert.deepEqual(output.trace.creationAttempts.map(a=>a.disposition),['entered','collision']);
  assert.equal(output.trace.creationAttempts[1].result,'0x0');
  if(authorized)assert.equal(output.authorizationProcessing.preparation.retained,true);
  await cleared(f,target);
 }
});

test('absent and empty-storage targets still deploy through root CREATE and internal CREATE2 with signed/full-MPT agreement',async()=>{
 for(const rootCreate of[false,true])for(const collision of['absent','empty']){
  const f=await storageCollisionDiagnosticFixture({rootCreate,collision}),output=await raw(f),changes=f.stateManager.snapshotChanges();
  assert.equal(output.execution.status,'success',JSON.stringify(output.execution));await compareStorageCollisionFullVM(f,output,changes);
  const r=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:f.chainId??1,rpc:f.rpc});assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');assert.deepEqual(r.changes,changes);
  for(const key of['execution','trace','logs','gasAccounting','stateGasAccounting'])assert.deepEqual(r.output[key],output[key]);
  assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  const target=f.collisionAddress;assert.equal((await account(f.stateManager,target)).nonce,1n);assert.equal((await account(f.stateManager,target)).balance,collision==='empty'?22n:5n);
  assert.equal(await code(f.stateManager,target),'0x'+STORAGE_SENTINEL_RUNTIME);assert.equal(await slot(f.stateManager,target,0),0n);assert.equal(await slot(f.stateManager,target,1),0n);assert.equal(await slot(f.stateManager,target,2),42n);assert.equal(await slot(f.stateManager,target,991),0n);assert.equal(output.logs.length,1);
 }
});

test('creation queries are measured when reverted and withheld when they retain cleared storage, without poisoning later overlays',async()=>{
 const init=initcode('00',''),target=createdAddress({creator:HELPER,kind:'CREATE2',init});
 for(const reverted of[false,true]){
  const f=await amsterdamExecutionFixture({value:'7',target:{nonce:1n,balance:13n,code:'0x00'},accounts:{
   [HELPER]:{nonce:7n,balance:1000n,code:factoryCode(init,{kind:'CREATE2',value:5,tail:'50'+(reverted?REVERT:'00')})},[GETTER]:{nonce:1n,code:'0x'+callBytes(HELPER)+RETURN42},[target]:storageOnlyAccount(),
  }}),query=scalar(GETTER),r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:f.chainId??1,rpc:f.rpc,queries:[query,native(target),native(TARGET),native(TX_SENDER)]});
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  const p=r.preview,original=await compareStorageCollisionFullVM(f,p.original.output,p.original.changes),m=p.measurements[0];
  assert.equal(p.status,reverted?'complete':'partial');assert.equal(m.status,reverted?'measured':'unavailable');
  assert.equal(m.before.output.execution.status,'success');assert.equal(m.before.output.execution.returnData,word(42));
  assert.equal(m.before.output.trace.calls[0].calls[0].error,null);
  if(reverted){
   assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['42','42','0']]);
   for(const side of[m.before,m.after]){
    assert.equal(side.mutationValidation.status,'verified');assert.equal(side.output.trace.calls[0].error,'revert');
    assert.equal(side.changesAfter.accounts.some(a=>a.address===target),false);
   }
  }else{
   assert.equal(m.values,null);assert.equal(m.after,null);assert.equal(m.before.status,'unavailable');
   assert.equal(m.before.changesAfter.accounts.find(a=>a.address===target).reset.basis,'contract_creation_storage_clear');
   assert.equal(m.before.changesAfter.accounts.find(a=>a.address===HELPER).nonce.after,'0x8');
  }
  assert.deepEqual(p.measurements.slice(1).map(x=>x.status),['measured','measured','measured']);
  assert.deepEqual(p.measurements[1].values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['17','17','0']]);
  assert.deepEqual(p.measurements[2].values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['13','20','7']]);
  assert.equal(p.measurements[3].values[0].afterRaw,(await account(original.state,TX_SENDER)).balance.toString());
  for(const measurement of p.measurements.slice(1))assert.deepEqual(measurement.after.changesBefore,p.original.changes);
  noHiddenDemand(f,target);for(const[key,value]of Object.entries(HIDDEN_STORAGE))assert.equal(await slot(original.state,target,BigInt(key)),value);
 }
});

test('a reverted deployment into empty storage remains a neutral measured query contrast',async()=>{
 const init=initcode('00',''),target=createdAddress({creator:HELPER,kind:'CREATE2',init});
 const f=await amsterdamExecutionFixture({value:'7',target:{nonce:1n,balance:13n,code:'0x00'},accounts:{
  [HELPER]:{nonce:7n,balance:1000n,code:factoryCode(init,{kind:'CREATE2',value:5,tail:'50'+REVERT})},[GETTER]:{nonce:1n,code:'0x'+callBytes(HELPER)+RETURN42},[target]:{nonce:0n,balance:17n,code:'0x'},
 }}),query=scalar(GETTER),r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:f.chainId??1,rpc:f.rpc,queries:[query,native(target)]});
 assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'complete');const p=r.preview,original=await compareStorageCollisionFullVM(f,p.original.output,p.original.changes),m=p.measurements[0];
 assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['42','42','0']]);
 for(const[side,state]of[[m.before,undefined],[m.after,original.state]]){
  assert.equal(side.mutationValidation.status,'verified');assert.equal(side.output.trace.calls[0].error,'revert');assert.equal(side.output.trace.calls[0].creationAttempts[0].disposition,'entered');
  const request={from:TX_SENDER,to:query.to,data:query.data,value:'0',gas:'1000000'};await compareStorageCollisionFullVM(f,side.output,side.changesAfter,{request,state,queryContext:true});
 }
 assert.deepEqual(p.measurements[1].values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['17','17','0']]);assert.deepEqual(p.measurements[1].after.changesBefore,p.original.changes);
});

test('ordinary CALL and creation fail-fast leave a storage-only target unchanged after state-gas precharge',async()=>{
 const init=initcode('00',''),callTarget=createdAddress({creator:TARGET,kind:'CREATE2',init});
 const cases=[await amsterdamExecutionFixture({to:callTarget,accounts:{[callTarget]:storageOnlyAccount()}})];
 for(const nonce of[7n,(1n<<64n)-1n]){
  const target=createdAddress({creator:TARGET,nonce,kind:'CREATE',init}),body=factoryCode(init,{kind:'CREATE',value:5});
  const f=await amsterdamExecutionFixture({target:{nonce,balance:nonce===7n?4n:1000n,code:body},accounts:{[target]:storageOnlyAccount()}});
  cases.push({...f,failFastTarget:target});
 }
 for(const f of cases){
  const output=await raw(f),changes=f.stateManager.snapshotChanges();assert.equal(output.execution.status,'success',JSON.stringify(output.execution));
  await compareStorageCollisionFullVM(f,output,changes);
  const r=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc});assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');assert.deepEqual(r.changes,changes);
  assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  if(f.failFastTarget){assert.equal(output.trace.creationAttempts.length,0);assert.equal(changes.accounts.some(row=>row.address===f.failFastTarget),false);assert(f.calls.filter(c=>c.params[0]===f.failFastTarget).every(c=>c.method==='eth_getProof'&&c.params[1].length===0));assert.equal(output.execution.returnData,word(0));}
  else{assert.equal(output.trace.calls.length,0);assert.equal(output.execution.returnData,'0x');assert.equal(changes.accounts.some(a=>a.address===callTarget),false);noHiddenDemand(f,callTarget);}
 }
});

test('after-state query newly routed through authorization withholds retained creation mutations without erasing preparation',async()=>{
 const init=initcode('00',''),target=createdAddress({creator:AUTHORITY,kind:'CREATE2',init});
 const f=await amsterdamExecutionFixture({authorizationList:[signAuthorization({chainId:11155111n,address:DELEGATE})],accounts:{
  [AUTHORITY]:{nonce:0n,balance:7n,code:'0x'},[DELEGATE]:{nonce:1n,code:factoryCode(init,{kind:'CREATE2',value:5})},
  [GETTER]:{nonce:1n,code:'0x'+callBytes(AUTHORITY)+RETURN42},[target]:storageOnlyAccount(),
 }}),query=scalar(GETTER),r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc,queries:[query,native(AUTHORITY),native(target),native(TX_SENDER)]});
 assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
 const p=r.preview,ref=await compareStorageCollisionFullVM(f,p.original.output,p.original.changes),m=p.measurements[0];
 assert.equal(p.status,'partial');assert.equal(m.status,'unavailable');assert.equal(m.values,null);assert.equal(m.before.status,'measured');assert.equal(m.before.output.execution.returnData,word(42));
 assert.equal(m.after.output.execution.status,'success');assert.equal(m.after.output.execution.returnData,word(42));
 assert.equal(m.after.status,'unavailable');assert.equal(m.after.values,null);assert.equal(m.after.output.authorizationProcessing,undefined);
 assert.equal(m.after.changesAfter.accounts.find(a=>a.address===target).reset.basis,'contract_creation_storage_clear');
 assert.equal(m.after.changesAfter.accounts.find(a=>a.address===AUTHORITY).nonce.after,'0x2');
 assert.equal(p.original.output.authorizationProcessing.preparation.retained,true);assert.equal(p.original.changes.accounts.find(a=>a.address===AUTHORITY).nonce.after,'0x1');
 assert.deepEqual(p.measurements.slice(1).map(x=>x.status),['measured','measured','measured']);assert.equal(p.measurements[1].values[0].deltaRaw,'0');assert.equal(p.measurements[2].values[0].deltaRaw,'0');
 assert.equal(p.measurements[3].values[0].afterRaw,(await account(ref.state,TX_SENDER)).balance.toString());
 for(const measurement of p.measurements.slice(1))assert.deepEqual(measurement.after.changesBefore,p.original.changes);
 noHiddenDemand(f,target);assert.equal((await account(ref.state,AUTHORITY)).nonce,1n);assert.equal(await code(ref.state,AUTHORITY),designation(DELEGATE));
});

test('a wrapper getter measures zero before creation and the fresh value after clearing while preserving the original overlay',async()=>{
 const runtime='60025460005260206000f3',init=initcode(runtime,'602a600255');
 const target=createdAddress({creator:TARGET,kind:'CREATE2',init});
 // Initialize the return word before calling the initially code-empty target.
 // The strict ABI query decoder still receives exactly one word in both phases.
 const getter='60006000526020600060006000600073'+target.slice(2)+'622dc6c0f15060206000f3';
 const f=await fixture({init,tail:'60005260206000f3',accounts:{[GETTER]:{nonce:1n,code:'0x'+getter}}});
 const result=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc,queries:[scalar(GETTER),native(target)]});
 assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.preview.status,'complete');
 const p=result.preview,m=p.measurements[0],original=p.original.changes.accounts.find(a=>a.address===target);
 assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['0','42','42']]);
 assert.equal(m.before.output.trace.calls[0].output,'0x');assert.equal(m.after.output.trace.calls[0].output,word(42));
 assert.equal(original.reset.basis,'contract_creation_storage_clear');assert.deepEqual(original.storage,[{slot:word(2),before:word(0),after:word(42)}]);
 assert.deepEqual(m.after.changesBefore,p.original.changes);assert.equal(m.before.mutationValidation.status,'verified');assert.equal(m.after.mutationValidation.status,'verified');
 assert.deepEqual(p.measurements[1].values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['17','22','5']]);
 assert.deepEqual(p.measurements[1].after.changesBefore,p.original.changes);noHiddenDemand(f,target);
 assert.equal(result.isolation.processClosed,true);assert.equal(result.broker.pendingAtReturn,0);
});

test('a creation-target proof host failure cannot be caught by an ancestor or retain earlier writes',async()=>{
 for(const reverts of[false,true]){
  const init=initcode('00',''),creator=HELPER,{copy,op}=createParts(init,{kind:'CREATE2',value:5});
  const body=program(['602a600155',...copy,op+'50'+(reverts?REVERT:'00'),{label:'init'},init]);
  const f=await fixture({creator,body,accounts:{[TARGET]:{nonce:7n,balance:1000n,code:'0x602b600155'+callBytes(HELPER)+RETURN42,storage:{[word(1)]:5n}}}});
  const originalCall=f.rpc.call.bind(f.rpc),failed=[];
  f.rpc.call=async(method,params)=>{
   if(method==='eth_getProof'&&params[0]===f.collisionAddress){failed.push(structuredClone(params));throw Error('Synthetic creation target proof unavailable');}
   return originalCall(method,params);
  };
  const output=await raw(f),r=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc});
  assert.equal(r.status,'completed',JSON.stringify(r.error));
  for(const value of[output,r.output]){
   assert.equal(value.execution.status,'unavailable');assert.equal(value.execution.error.code,'LOCAL_EXECUTION_FAILED');assert.equal(value.stateDisposition,'rolled_back');
   assert.equal(value.execution.returnData,null);assert.equal(value.execution.executionGasUsed,null);assert.deepEqual(value.logs,[]);
   assert.equal(value.authorizationProcessing,undefined);assert.equal(value.feeAccounting,undefined);assert.equal(value.semantics.feeSettlement,false);
  }
  assert.equal(failed.length,2);assert.equal(r.inputs.failure.code,'RPC_STATE_INPUT_UNAVAILABLE');
  assert.deepEqual(r.changes.accounts,[]);assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
  for(const creator of[TARGET,HELPER]){
   assert.equal(r.inputs.accounts[creator].nonce,'7');assert.equal(r.inputs.accounts[creator].storage[word(1)],word(5));
  }
  assert.equal(r.inputs.accounts[TX_SENDER].nonce,'1');
  await assert.rejects(account(f.stateManager,TARGET),{code:'LOCAL_STATE_MISSING'},'Failed collectors cannot resume reads from partial facts');
  assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
 }
});
