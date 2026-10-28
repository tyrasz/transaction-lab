// Actual isolated workers over synthetic authenticated MPT inputs. Provider
// traces or predicted poststate are never used as worker input.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, factoryCode, createdAddress, initcode, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const TARGET='0x4444444444444444444444444444444444444444', BENEFICIARY='0x5555555555555555555555555555555555555555';
const GETTER='0x6666666666666666666666666666666666666666', IMPL='0x7777777777777777777777777777777777777777';
const BASIS='shanghai_selfdestruct_deletion';
const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const sd=address=>'73'+address.slice(2)+'ff';
const call=(target=TARGET,{value=0,inputBytes=0}={})=>'6000600060'+inputBytes.toString(16).padStart(2,'0')+'600060'+value.toString(16).padStart(2,'0')+'73'+target.slice(2)+'62030d40f1';
const deletion=(address,balance=0n)=>({address,existence:{before:true,after:false,basis:BASIS},...(balance?{balance:{before:'0x'+balance.toString(16),after:'0x0'}}:{})});
const query={to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')};
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
const preview=f=>executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[query]});
function shanghai(f){
  const h=f.header;h.number='0x112a880';h.timestamp='0x'+(1710338134).toString(16);
  for(const k of ['blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'])delete h[k];
  const order=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot'];
  const integers=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas']);
  h.hash='0x'+Buffer.from(keccak_256(RLP.encode(order.map(k=>{
    let v=h[k].slice(2);if(integers.has(k)){v=BigInt(h[k])===0n?'':BigInt(h[k]).toString(16);if(v.length%2)v='0'+v;}return Buffer.from(v,'hex');
  })))).toString('hex');return f;
}
async function fixture({balance=17n,storage=true,revert=false,getterCode='0x602a60005260206000f3',targetCode='0x'+sd(BENEFICIARY),factory}={}){
  return shanghai(await lifecycleFixture({code:factory??'0x'+call()+'50'+(revert?'60006000fd':'00'),accounts:{
    [TARGET]:{nonce:3n,balance,code:targetCode,...(storage?{storage:{[word(0)]:word(42)}}:{})},
    [GETTER]:{nonce:1n,code:getterCode},
  }}));
}
function recount(output){output.usage.retainedTraceBytes=Buffer.byteLength(JSON.stringify({trace:output.trace,logs:output.logs,...(output.lifecycle?{lifecycle:output.lifecycle}:{})}));}
async function tamper(t,f,mutate,{previewMode=false}={}){
  const fork=childProcess.fork;let changed=false;
  const mock=t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args),emit=child.emit;
    child.emit=function(event,...values){
      if(event==='message'&&typeof values[0]==='string'){
        const m=JSON.parse(values[0]);if(m.type==='result'){mutate(m.result);if(!previewMode)recount(m.result.output);changed=true;values[0]=JSON.stringify(m);}
      }return emit.call(this,event,...values);
    };return child;
  });
  try{const r=await(previewMode?preview(f):run(f));assert.equal(changed,true);assert.equal(r.status,'unavailable');assert.equal(r.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(previewMode?r.preview:r.output,null);}
  finally{mock.mock.restore();}
}

test('Shanghai parent binds preexisting code/nonce and an entirely unrequested storage trie deletion',async()=>{
  for(const balance of [0n,17n]){
    const f=await fixture({balance}),r=await run(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');
    assert.equal(r.output.environment.hardfork,'shanghai');assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),deletion(TARGET,balance));
    const proof=r.inputs.provenance.find(p=>p.account===TARGET);assert.notEqual(proof.accountProof.storageRoot,EMPTY_STORAGE_ROOT);assert.deepEqual(proof.storage,[]);
    assert.deepEqual(r.output.lifecycle.finalizedDeletions,[{address:TARGET,scope:'entire_account_including_code_and_storage',initialStorageRoot:proof.accountProof.storageRoot}]);
    assert.equal(f.calls.some(c=>c.method==='eth_getProof'&&c.params[1].length>0),false);
  }
});

test('Shanghai self-beneficiary burns before a refill and later transfer, including an initially empty recipient',async()=>{
  const targetCode='0x3615601b5773'+BENEFICIARY.slice(2)+'ff5b30ff';
  const factory='0x'+call()+'50'+call(TARGET,{value:7,inputBytes:1})+'5000';
  const f=shanghai(await lifecycleFixture({code:factory,accounts:{[TARGET]:{nonce:3n,balance:17n,code:targetCode},[BENEFICIARY]:{nonce:0n,balance:0n,code:'0x'}}}));
  const r=await run(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');
  assert.deepEqual(r.output.trace.calls[0].selfdestruct,{beneficiary:TARGET});assert.deepEqual(r.output.trace.calls[1].selfdestruct,{beneficiary:BENEFICIARY});
  assert.deepEqual(r.changes.accounts.find(a=>a.address===BENEFICIARY).balance,{before:'0x0',after:'0x7'});
  assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),deletion(TARGET,17n));
});

test('delegate SELFDESTRUCT deletes the execution account, never its code address',async t=>{
  const make=async()=>shanghai(await lifecycleFixture({code:'0x'+call()+'5000',accounts:{
    [TARGET]:{nonce:3n,balance:17n,code:'0x600060006000600073'+IMPL.slice(2)+'62030d40f45000'},
    [IMPL]:{nonce:1n,balance:9n,code:'0x'+sd(BENEFICIARY)},
  }}));
  const r=await run(await make());assert.equal(r.status,'completed',JSON.stringify(r.error));assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),deletion(TARGET,17n));
  assert.equal(r.changes.accounts.some(a=>a.address===IMPL),false);assert.equal(r.output.trace.calls[0].calls[0].executionAddress,TARGET);
  await tamper(t,await make(),r=>{const frame=r.output.trace.calls[0];frame.executionAddress=IMPL;frame.calls[0].from=IMPL;frame.calls[0].executionAddress=IMPL;});
});

test('reverted ancestors preserve observations but never finalize Shanghai deletions',async t=>{
  const f=await fixture({revert:true}),r=await run(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'reverted');
  assert.deepEqual(r.output.trace.calls[0].selfdestruct,{beneficiary:BENEFICIARY});assert.equal(r.output.lifecycle,undefined);
  assert.deepEqual(r.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  await tamper(t,await fixture({revert:true}),r=>{r.output.lifecycle={finalizedDeletions:[{address:TARGET,scope:'entire_account_including_code_and_storage',initialStorageRoot:r.inputs.provenance.find(p=>p.account===TARGET).accountProof.storageRoot}]};});
});

test('Shanghai constructor deletion keeps absence and uses its own basis for prefunded targets',async()=>{
  for(const prefunded of [false,true]){
    const init=sd(BENEFICIARY),target=createdAddress({init}),f=shanghai(await lifecycleFixture({code:factoryCode(init),accounts:prefunded?{[target]:{nonce:0n,balance:17n,code:'0x'}}:{}}));
    const r=await run(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.lifecycle.finalizedDeletions[0].address,target);
    assert.deepEqual(r.changes.accounts.find(a=>a.address===target),prefunded?deletion(target,17n):undefined);
  }
});

test('parent rejects missing/wrong-root/duplicate/basis-forged deletions and partial whole-account deltas',async t=>{
  for(const mutate of [
    r=>{delete r.output.lifecycle;},
    r=>{r.output.lifecycle.finalizedDeletions[0].initialStorageRoot=EMPTY_STORAGE_ROOT;},
    r=>{r.output.lifecycle.finalizedDeletions.push({...r.output.lifecycle.finalizedDeletions[0]});},
    r=>{r.output.lifecycle.finalizedDeletions[0].address=IMPL;},
    r=>{delete r.output.trace.calls[0].selfdestruct;},
    r=>{r.output.trace.calls[0].error='revert';},
    r=>{r.changes.accounts.find(a=>a.address===TARGET).existence.basis='same_invocation_created_contract_deletion';},
    r=>{delete r.changes.accounts.find(a=>a.address===TARGET).balance;},
    r=>{r.changes.accounts.find(a=>a.address===TARGET).nonce={before:'0x3',after:'0x0'};},
    r=>{r.changes.accounts.find(a=>a.address===TARGET).storage=[{slot:word(0),before:word(42),after:word(0)}];},
  ])await tamper(t,await fixture(),mutate);
});

test('direct callers retain Cancun defaults while the isolated parent uses the trusted Shanghai header',async()=>{
  const f=await fixture(),r=await run(f);assert.equal(r.status,'completed');
  const args={changes:r.changes,inputs:r.inputs,output:r.output,sender:SENDER,destination:FACTORY};
  assert.throws(()=>validateExecutionChanges(args));assert.doesNotThrow(()=>validateExecutionChanges({...args,selfdestructOnlyCreated:false}));
  assert.throws(()=>validateExecutionChanges({...args,selfdestructOnlyCreated:0}));
});

test('disposable getters preserve original Shanghai deletion and see no resurrected code',async t=>{
  const make=()=>fixture({getterCode:'0x73'+TARGET.slice(2)+'3b60005260206000f3'});
  const r=await preview(await make());assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'complete');
  const m=r.preview.measurements[0];assert.equal(m.status,'measured');assert.equal(m.values[0].beforeRaw,'22');assert.equal(m.values[0].afterRaw,'0');
  assert.deepEqual(m.after.changesAfter.accounts.find(a=>a.address===TARGET),deletion(TARGET,17n));assert.equal(m.after.output.lifecycle,undefined);
  await tamper(t,await make(),r=>{r.preview.measurements[0].after.changesAfter.accounts=r.preview.measurements[0].after.changesAfter.accounts.filter(a=>a.address!==TARGET);},{previewMode:true});
});

test('query destruction of an original creation is valid lifecycle evidence but never a measured getter',async()=>{
  for(const prefunded of [false,true]){
    const init=initcode(sd(BENEFICIARY),''),target=createdAddress({init});
    const f=shanghai(await lifecycleFixture({code:factoryCode(init,{value:5}),accounts:{
      [GETTER]:{nonce:1n,code:'0x'+call(target)+'50602a60005260206000f3'},
      ...(prefunded?{[target]:{nonce:0n,balance:17n,code:'0x'}}:{}),
    }}));
    const r=await preview(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'partial');
    const m=r.preview.measurements[0];assert.equal(m.before.status,'measured');assert.equal(m.after.status,'unavailable');assert.equal(m.status,'unavailable');assert.equal(m.values,null);
    const side=m.after;assert.equal(side.output.execution.status,'success');assert.equal(side.output.lifecycle.finalizedDeletions[0].address,target);
    assert.deepEqual(side.changesAfter.accounts.find(a=>a.address===target),prefunded?deletion(target,17n):undefined);
    assert.doesNotThrow(()=>validateExecutionLifecycle({output:side.output,inputs:r.preview.inputs,destination:GETTER,changes:side.changesAfter,startingChanges:side.changesBefore,selfdestructOnlyCreated:false}));
    assert.throws(()=>validateQueryMutation({before:side.changesBefore,after:side.changesAfter,sender:SENDER,nonceBefore:'2',senderExistedBefore:true}));
    assert.equal(r.preview.original.output.lifecycle,undefined);assert.equal(r.preview.original.changes.accounts.find(a=>a.address===target).code.after,'0x'+sd(BENEFICIARY));
  }
});

test('Shanghai whole-account rows carry unchanged and reject unsafe extra fields or hostile objects',()=>{
  const before={scope:SCOPE,accounts:[{address:SENDER,nonce:{before:'0x1',after:'0x2'}},deletion(TARGET,17n)]},after=structuredClone(before);after.accounts[0].nonce.after='0x3';
  assert.equal(validateQueryMutation({before,after,sender:SENDER,nonceBefore:'2',senderExistedBefore:true}).status,'verified');
  for(const change of [r=>{r.nonce={before:'0x3',after:'0x0'};},r=>{r.code={before:'0x',after:'0x00'};},r=>{r.storage=[{slot:word(0),before:word(42),after:word(0)}];},r=>{r.balance.after='0x1';}]){
    const snapshot=structuredClone(before);change(snapshot.accounts[1]);assert.throws(()=>canonicalStateChanges(snapshot));
  }
  let touched=false;const hostile=structuredClone(before);Object.defineProperty(hostile.accounts[1].existence,'basis',{enumerable:true,get(){touched=true;return BASIS;}});assert.throws(()=>canonicalStateChanges(hostile));assert.equal(touched,false);
  const proxy=structuredClone(before);proxy.accounts[1]=new Proxy(proxy.accounts[1],{get(){touched=true;throw Error('not evaluated');}});assert.throws(()=>canonicalStateChanges(proxy));assert.equal(touched,false);
});
