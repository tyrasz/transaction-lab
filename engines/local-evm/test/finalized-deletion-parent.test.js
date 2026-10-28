// Synthetic authenticated MPT inputs, actual isolated child execution, and
// hostile IPC/output controls. These are not public-provider observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { validateExecutionLifecycle } from '../execution-changes.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const BENEFICIARY='0x4444444444444444444444444444444444444444';
const GETTER='0x6666666666666666666666666666666666666666';
const sd=address=>'73'+address.slice(2)+'ff';
const BASIS='same_invocation_created_contract_deletion';
const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const query={to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')};
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
const preview=f=>executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[query]});
async function fixture({kind='CREATE',prefunded=false,top=false,revert=false,queryCode='0x602a60005260206000f3'}={}){
  const init=sd(BENEFICIARY),target=createdAddress({creator:top?SENDER:FACTORY,nonce:top?1n:7n,kind,init});
  const code=factoryCode(init,{kind,value:5,...(revert?{tail:'5060006000fd'}:{})});
  const f=await lifecycleFixture({code,accounts:{[GETTER]:{nonce:1n,code:queryCode},...(prefunded?{[target]:{nonce:0n,balance:17n,code:'0x'}}:{})}});
  if(top)f.request={...f.request,to:null,data:'0x'+init,value:'5'};
  return {...f,target};
}
async function tamper(t,f,mutate,previewMode=false){
  const fork=childProcess.fork;let altered=false;
  const mock=t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args),emit=child.emit;
    child.emit=function(event,...values){
      if(event==='message'&&typeof values[0]==='string'){
        const message=JSON.parse(values[0]);
        if(message.type==='result'){
          const recount=mutate(message.result)!==false;
          if(recount&&!previewMode&&message.result.output?.lifecycle){const output=message.result.output;output.usage.retainedTraceBytes=Buffer.byteLength(JSON.stringify({trace:output.trace,logs:output.logs,lifecycle:output.lifecycle}));}
          altered=true;values[0]=JSON.stringify(message);
        }
      }
      return emit.call(this,event,...values);
    };
    return child;
  });
  try{const result=await(previewMode?preview(f):run(f));assert.equal(altered,true);assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(previewMode?result.preview:result.output,null);}
  finally{mock.mock.restore();}
}

for(const top of [false,true])for(const prefunded of [false,true])test(`parent binds ${top?'top-level':'internal'} constructor deletion with ${prefunded?'prefunded':'absent'} initial target`,async()=>{
  const f=await fixture({top,prefunded}),r=await run(f);
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');
  assert.deepEqual(r.output.lifecycle,{finalizedDeletions:[{address:f.target,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT}]});
  const frame=top?r.output.trace:r.output.trace.calls[0];assert.deepEqual(frame.selfdestruct,{beneficiary:BENEFICIARY});
  const targetRow=r.changes.accounts.find(row=>row.address===f.target);
  if(prefunded)assert.deepEqual(targetRow,{address:f.target,existence:{before:true,after:false,basis:BASIS},balance:{before:'0x11',after:'0x0'}});
  else assert.equal(targetRow,undefined);
  assert.equal(r.changes.accounts.find(row=>row.address===BENEFICIARY).balance.after,prefunded?'0x16':'0x5');
});

test('parent rejects omitted, duplicate, unbound and contradictory committed deletion evidence',async t=>{
  for(const mutate of [
    r=>{delete r.output.lifecycle;},
    r=>{r.output.lifecycle.finalizedDeletions=[];},
    r=>{r.output.usage.retainedTraceBytes--;return false;},
    r=>{r.output.lifecycle.finalizedDeletions.push({...r.output.lifecycle.finalizedDeletions[0]});},
    r=>{r.output.lifecycle.finalizedDeletions[0].address=FACTORY;},
    r=>{r.output.lifecycle.finalizedDeletions[0].initialStorageRoot=word(1);},
    r=>{delete r.output.trace.calls[0].selfdestruct;},
    r=>{r.output.trace.calls[0].selfdestruct.beneficiary='0x1';},
    r=>{r.output.trace.calls[0].error='revert';},
    r=>{r.changes.accounts.push({address:r.output.lifecycle.finalizedDeletions[0].address,existence:{before:false,after:true,basis:'internal_contract_creation'},nonce:{before:'0x0',after:'0x1'}});},
  ])await tamper(t,await fixture(),mutate);
});

test('prefunded deletion cannot hide its original balance or retain nonce, runtime or storage',async t=>{
  for(const mutate of [
    (r,target)=>{r.changes.accounts=r.changes.accounts.filter(row=>row.address!==target);},
    (r,target)=>{delete r.changes.accounts.find(row=>row.address===target).balance;},
    (r,target)=>{r.changes.accounts.find(row=>row.address===target).balance.before='0x10';},
    (r,target)=>{r.changes.accounts.find(row=>row.address===target).nonce={before:'0x0',after:'0x1'};},
    (r,target)=>{r.changes.accounts.find(row=>row.address===target).code={before:'0x',after:'0x00'};},
    (r,target)=>{r.changes.accounts.find(row=>row.address===target).storage=[{slot:word(0),before:word(0),after:word(1)}];},
  ]){const f=await fixture({prefunded:true});await tamper(t,f,r=>mutate(r,f.target));}
});

test('reverted ancestors retain own-frame observations without any committed finalization',async t=>{
  const f=await fixture({revert:true}),r=await run(f);assert.equal(r.status,'completed');assert.equal(r.output.execution.status,'reverted');
  assert.deepEqual(r.output.trace.calls[0].selfdestruct,{beneficiary:BENEFICIARY});assert.equal(r.output.lifecycle,undefined);
  assert.deepEqual(r.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  await tamper(t,await fixture({revert:true}),r=>{r.output.lifecycle={finalizedDeletions:[{address:f.target,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT}]};});
});

test('disposable getters carry original prefunded deletion unchanged and cannot restore the target',async t=>{
  const f=await fixture({prefunded:true}),r=await preview(f);assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'complete');
  const row=r.preview.measurements[0];assert.equal(row.status,'measured');assert.deepEqual(row.after.changesBefore,r.preview.original.changes);
  assert.equal(row.after.changesAfter.accounts.find(a=>a.address===f.target).existence.after,false);
  await tamper(t,await fixture({prefunded:true}),r=>{r.preview.measurements[0].after.changesAfter.accounts=r.preview.measurements[0].after.changesAfter.accounts.filter(a=>a.existence?.basis!==BASIS);},true);
});

test('canonical deletion rows reject hostile objects and permit only unchanged carried net state',()=>{
  const sender={address:SENDER,nonce:{before:'0x1',after:'0x2'}},deleted={address:BENEFICIARY,existence:{before:true,after:false,basis:BASIS},balance:{before:'0x11',after:'0x0'}};
  const before={scope:SCOPE,accounts:[sender,deleted]},after=structuredClone(before);after.accounts[0].nonce.after='0x3';
  assert.equal(validateQueryMutation({before,after,sender:SENDER,nonceBefore:'2',senderExistedBefore:true}).status,'verified');
  for(const mutate of [
    s=>{s.accounts[1].existence.basis='selfdestruct';},s=>{s.accounts[1].balance.after='0x1';},s=>{s.accounts[1].nonce={before:'0x0',after:'0x1'};},s=>{s.accounts.push(s.accounts[1]);},
  ]){const row=structuredClone(before);mutate(row);assert.throws(()=>canonicalStateChanges(row));}
  let touched=false;const hostile=structuredClone(before);Object.defineProperty(hostile.accounts[1].existence,'basis',{enumerable:true,get(){touched=true;return BASIS;}});assert.throws(()=>canonicalStateChanges(hostile));assert.equal(touched,false);
  const proxy=structuredClone(before);proxy.accounts[1].existence=new Proxy(proxy.accounts[1].existence,{get(){touched=true;throw Error('not called');}});assert.throws(()=>canonicalStateChanges(proxy));assert.equal(touched,false);
});

test('lifecycle metadata getters and proxies are rejected without evaluation',async()=>{
  const f=await fixture(),r=await run(f);assert.equal(r.status,'completed');let touched=false;
  const args=()=>({output:structuredClone(r.output),inputs:r.inputs,destination:f.request.to});
  const getter=args();Object.defineProperty(getter.output.lifecycle,'finalizedDeletions',{enumerable:true,get(){touched=true;return[];}});assert.throws(()=>validateExecutionLifecycle(getter));assert.equal(touched,false);
  const proxy=args();proxy.output.lifecycle=new Proxy(proxy.output.lifecycle,{get(){touched=true;throw Error('not called');}});assert.throws(()=>validateExecutionLifecycle(proxy));assert.equal(touched,false);
});


test('non-destructing ancestors cannot launder a delegate SELFDESTRUCT into a created target', async t => {
  const implementation='0x5555555555555555555555555555555555555555',middle='0x6666666666666666666666666666666666666666';
  const delegate='600060006000600073'+implementation.slice(2)+'61fffff45000';
  const call='6000600060006000600073'+middle.slice(2)+'62030d40f15000';
  const make=()=>lifecycleFixture({code:factoryCode(initcode('00',''),{value:0,tail:'50'+call}),accounts:{
    [middle]:{nonce:1n,balance:17n,code:'0x'+delegate},
    [implementation]:{nonce:1n,balance:17n,code:'0x73'+BENEFICIARY.slice(2)+'ff'},
  }});
  const genuine=await run(await make());assert.equal(genuine.status,'completed');assert.equal(genuine.output.lifecycle,undefined);
  assert.equal(genuine.output.trace.calls[1].type,'CALL');assert.equal(genuine.output.trace.calls[1].calls[0].type,'DELEGATECALL');
  for (const mutate of [
    r=>{const frame=r.output.trace.calls[1],target=r.output.trace.calls[0].to;frame.executionAddress=target;frame.calls[0].from=target;frame.calls[0].executionAddress=target;r.output.lifecycle={finalizedDeletions:[{address:target,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT}]};r.changes.accounts=r.changes.accounts.filter(row=>row.address!==target);},
    r=>{r.output.trace.calls[1].from=implementation;},
    r=>{r.output.trace.calls[1].calls[0].caller=implementation;},
  ])await tamper(t,await make(),mutate);
});

test('a query cannot hide its creator nonce change behind transient zero-value creation and deletion', async () => {
  const code=factoryCode(sd(BENEFICIARY),{value:0,tail:'50602a60005260206000f3'});
  const f=await lifecycleFixture({code:'0x00',accounts:{[GETTER]:{nonce:1n,code}}}),r=await preview(f);
  assert.equal(r.status,'completed');assert.equal(r.preview.status,'partial');
  const row=r.preview.measurements[0];assert.equal(row.status,'unavailable');assert.equal(row.values,null);
  assert.equal(row.before.output.execution.status,'success');assert.equal(row.before.output.lifecycle.finalizedDeletions.length,1);
  const target=row.before.output.lifecycle.finalizedDeletions[0].address;
  assert.equal(row.before.changesAfter.accounts.some(account=>account.address===target),false);
  assert.deepEqual(row.before.changesAfter.accounts.find(account=>account.address===GETTER).nonce,{before:'0x1',after:'0x2'});
  assert.equal(row.after,null);assert.equal(r.preview.original.output.lifecycle,undefined);
  assert.deepEqual(r.preview.original.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
});
