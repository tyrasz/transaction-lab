// Synthetic authenticated MPT inputs and real isolated child execution.
// No public provider, expected execution trace or poststate enters the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { validateExecutionLifecycle } from '../execution-changes.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const TARGET='0x4444444444444444444444444444444444444444', GETTER='0x6666666666666666666666666666666666666666';
const RIPEMD='0x0000000000000000000000000000000000000003';
const BASIS='eip161_empty_account_cleanup';
const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const call=(target=TARGET,{kind='f1',gas=65535,value=0}={})=>'6000600060006000'+(kind==='f1'||kind==='f2'?'60'+value.toString(16).padStart(2,'0'):'')+'73'+target.slice(2)+'61'+gas.toString(16).padStart(4,'0')+kind;
const empty=(nonemptyStorage=false)=>({nonce:0n,balance:0n,code:'0x',...(nonemptyStorage?{storage:{[word(0)]:word(42)}}:{})});
const row=address=>({address,existence:{before:true,after:false,basis:BASIS}});
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
function shanghai(f) {
  // Rehash synthetic MPT state into the exact Shanghai header field layout.
  const header=f.header;header.number='0x112a880';header.timestamp='0x'+(1710338134).toString(16);
  for(const key of ['blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'])delete header[key];
  const order=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot'];
  const integers=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas']);
  header.hash='0x'+Buffer.from(keccak_256(RLP.encode(order.map(key=>{
    let value=header[key].slice(2);
    if(integers.has(key)){value=BigInt(header[key])===0n?'':BigInt(header[key]).toString(16);if(value.length%2)value='0'+value;}
    return Buffer.from(value,'hex');
  })))).toString('hex');
  return f;
}
async function fixture({target=TARGET,kind='f1',gas=65535,value=0,revert=false,nonemptyStorage=false,code}={}) {
  return lifecycleFixture({code:code??'0x'+call(target,{kind,gas,value})+'50'+(revert?'60006000fd':'00'),accounts:{[target]:empty(nonemptyStorage)}});
}
function recount(result) {
  const out=result.output;
  out.usage.retainedTraceBytes=Buffer.byteLength(JSON.stringify({trace:out.trace,logs:out.logs,...(out.lifecycle?{lifecycle:out.lifecycle}:{})}));
}
async function tamper(t,f,mutate) {
  const fork=childProcess.fork;let altered=false;
  const mock=t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args),emit=child.emit;
    child.emit=function(event,...values){
      if(event==='message'&&typeof values[0]==='string'){
        const message=JSON.parse(values[0]);
        if(message.type==='result'){mutate(message.result);recount(message.result);altered=true;values[0]=JSON.stringify(message);}
      }
      return emit.call(this,event,...values);
    };
    return child;
  });
  try {const result=await run(f);assert.equal(altered,true);assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(result.output,null);}
  finally {mock.mock.restore();}
}
function forgedCleanup(result,address=TARGET) {
  const proof=result.inputs.provenance.find(p=>p.account===address).accountProof;
  result.output.lifecycle={emptyAccountCleanup:{basis:'eip161_transaction_end',scope:'unsigned_message_touches_no_fee_settlement',touchedAccounts:[FACTORY,SENDER,address].sort(),deletions:[{address,scope:'entire_account_including_code_and_storage',initialStorageRoot:proof.storageRoot}]}};
  result.changes.accounts=result.changes.accounts.filter(a=>a.address!==address).concat(row(address));
}

test('parent accepts actual CALL and STATICCALL cleanup, including an entirely unknown nonempty storage trie',async()=>{
  for(const kind of ['f1','fa'])for(const nonemptyStorage of [false,true]){
    const f=await fixture({kind,nonemptyStorage}),r=await run(f);
    assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');
    assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),row(TARGET));
    const deletion=r.output.lifecycle.emptyAccountCleanup.deletions[0],proof=r.inputs.provenance.find(p=>p.account===TARGET);
    assert.equal(deletion.initialStorageRoot,proof.accountProof.storageRoot);assert.equal(deletion.initialStorageRoot===EMPTY_STORAGE_ROOT,!nonemptyStorage);
    assert.deepEqual(proof.storage,[]);assert.equal(f.calls.filter(c=>c.method==='eth_getProof').some(c=>c.params[1].length>0),false);
  }
});

test('ordinary reverted touches retain the empty account while RIPEMD160 OOG touches survive root revert',async()=>{
  for(const target of [TARGET,RIPEMD,'0x0000000000000000000000000000000000000002']){
    const r=await run(await fixture({target,gas:target===TARGET?65535:0,revert:true,nonemptyStorage:true}));
    assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'reverted');
    const sticky=target===RIPEMD;assert.equal(Boolean(r.output.lifecycle?.emptyAccountCleanup),sticky);
    assert.deepEqual(r.changes.accounts.filter(a=>a.address!==SENDER),sticky?[row(RIPEMD)]:[]);
    assert.deepEqual(r.changes.accounts.find(a=>a.address===SENDER).nonce,{before:'0x1',after:'0x2'});
  }
});

test('Shanghai parent admits EIP-161 cleanup including root-revert stickiness but retains the Cancun deletion gate',async t=>{
  for(const options of [{nonemptyStorage:true},{target:RIPEMD,gas:0,revert:true,nonemptyStorage:true}]){
    const f=shanghai(await fixture(options)),r=await run(f),target=options.target??TARGET;
    assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.environment.hardfork,'shanghai');
    assert.equal(r.output.execution.status,options.revert?'reverted':'success');assert.deepEqual(r.changes.accounts.find(a=>a.address===target),row(target));
    assert.equal(r.output.lifecycle.finalizedDeletions,undefined);assert.equal(r.output.lifecycle.emptyAccountCleanup.deletions[0].address,target);
  }
  const unsupported=await run(shanghai(await lifecycleFixture({code:'0x73'+TARGET.slice(2)+'ff'})));
  assert.equal(unsupported.status,'completed');assert.equal(unsupported.output.execution.status,'unsupported');assert.equal(unsupported.output.lifecycle,undefined);assert.deepEqual(unsupported.changes.accounts,[]);
  await tamper(t,shanghai(await fixture()),r=>{r.output.lifecycle.finalizedDeletions=[{address:FACTORY,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT}];});
});

test('BALANCE-only, delegated code targets and positive value transfers never become empty cleanup',async()=>{
  for(const code of ['0x73'+TARGET.slice(2)+'315000','0x'+call(TARGET,{kind:'f4'})+'5000']){
    const r=await run(await fixture({code,nonemptyStorage:true}));assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.lifecycle,undefined);assert.equal(r.changes.accounts.some(a=>a.address===TARGET),false);
  }
  const funded=await run(await fixture({value:1}));assert.equal(funded.status,'completed');assert.equal(funded.output.lifecycle,undefined);
  assert.deepEqual(funded.changes.accounts.find(a=>a.address===TARGET).balance,{before:'0x0',after:'0x1'});
});

test('zero-balance SELFDESTRUCT beneficiary cleanup retains its authenticated whole-account deletion',async()=>{
  const f=await lifecycleFixture({accounts:{[FACTORY]:{nonce:7n,balance:0n,code:'0x73'+TARGET.slice(2)+'ff'},[TARGET]:empty(true)}}),r=await run(f);
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),row(TARGET));
  assert.deepEqual(r.output.trace.selfdestruct,{beneficiary:TARGET});
});

test('existing zero-balance deployable targets can create and delete without an invented native delta',async()=>{
  const init='734444444444444444444444444444444444444444ff',target=createdAddress({init});
  const f=await lifecycleFixture({code:factoryCode(init,{value:0}),accounts:{[target]:empty(),[TARGET]:empty()}}),r=await run(f);
  assert.equal(r.status,'completed',JSON.stringify(r.error));
  assert.deepEqual(r.changes.accounts.find(a=>a.address===target),{address:target,existence:{before:true,after:false,basis:'same_invocation_created_contract_deletion'}});
  assert.equal(r.output.lifecycle.finalizedDeletions[0].address,target);assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET),row(TARGET));
});

test('parent rejects omitted cleanup, wrong roots, duplicate addresses and forged whole-account slot diffs',async t=>{
  for(const mutate of [
    r=>{delete r.output.lifecycle;r.changes.accounts=r.changes.accounts.filter(a=>a.address!==TARGET);},
    r=>{delete r.output.lifecycle;r.changes.accounts=r.changes.accounts.filter(a=>a.address!==TARGET).concat({address:TARGET,nonce:{before:'0x0',after:'0x1'}});},
    r=>{delete r.output.lifecycle;r.changes.accounts=r.changes.accounts.filter(a=>a.address!==TARGET).concat({address:TARGET,balance:{before:'0x0',after:'0x1'}});},
    r=>{r.output.lifecycle.emptyAccountCleanup.deletions[0].initialStorageRoot=word(123);},
    r=>{r.output.lifecycle.emptyAccountCleanup.deletions.push({...r.output.lifecycle.emptyAccountCleanup.deletions[0]});},
    r=>{r.output.lifecycle.emptyAccountCleanup.touchedAccounts.push(TARGET);},
    r=>{r.output.lifecycle.emptyAccountCleanup.touchedAccounts=r.output.lifecycle.emptyAccountCleanup.touchedAccounts.filter(a=>a!==TARGET);},
    r=>{r.changes.accounts.find(a=>a.address===TARGET).storage=[{slot:word(0),before:word(42),after:word(0)}];},
    r=>{r.changes.accounts.find(a=>a.address===SENDER).nonce.after='0x3';},
  ])await tamper(t,await fixture({nonemptyStorage:true}),mutate);
});

test('parent rejects fabricated cleanup for a read, delegated code address, funding and reverted ordinary touch',async t=>{
  for(const options of [{code:'0x73'+TARGET.slice(2)+'315000'},{kind:'f4'},{value:1},{revert:true}])await tamper(t,await fixture(options),r=>forgedCleanup(r));
});

test('parent never promotes ambiguous pre-touch failures into sticky RIPEMD160 cleanup',async t=>{
  for(const error of ['insufficient balance','value overflow','create collision'])await tamper(t,await fixture({target:RIPEMD,gas:0,revert:true}),r=>{r.output.trace.calls[0].error=error;});
});

test('retained SELFDESTRUCT value is reconstructed before allowing an empty account to survive',async t=>{
  const make=balance=>lifecycleFixture({accounts:{[FACTORY]:{nonce:7n,balance,code:'0x73'+TARGET.slice(2)+'ff'},[TARGET]:empty()}});
  const r=await run(await make(17n));assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.lifecycle,undefined);
  assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET).balance,{before:'0x0',after:'0x11'});
  await tamper(t,await make(17n),r=>{r.changes.accounts.find(a=>a.address===TARGET).balance.after='0x12';});
  await tamper(t,await make(0n),r=>{delete r.output.lifecycle;r.changes.accounts=r.changes.accounts.filter(a=>a.address!==TARGET).concat({address:TARGET,balance:{before:'0x0',after:'0x1'}});});
});

test('created self-beneficiary burn precedes later funding and a different SELFDESTRUCT beneficiary',async()=>{
  // Empty calldata selects ADDRESS/SELFDESTRUCT; nonempty selects TARGET.
  // Runtime remains callable until finalization, so the second call receives
  // seven and sends seven onward. The first five were already burned.
  const runtime='3615601b5773'+TARGET.slice(2)+'ff5b30ff',init=initcode(runtime,''),target=createdAddress({init});
  const second='6000600060016000600773'+target.slice(2)+'61fffff1';
  const code=factoryCode(init,{value:5,tail:'50'+call(target)+'50'+second+'5000'});
  const f=await lifecycleFixture({code,accounts:{[TARGET]:empty()}}),r=await run(f);
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.output.execution.status,'success');
  assert.deepEqual(r.output.trace.calls[1].selfdestruct,{beneficiary:target});assert.deepEqual(r.output.trace.calls[2].selfdestruct,{beneficiary:TARGET});
  assert.equal(r.output.trace.calls[2].value,'0x7');assert.deepEqual(r.changes.accounts.find(a=>a.address===TARGET).balance,{before:'0x0',after:'0x7'});
  assert.equal(r.output.lifecycle.finalizedDeletions[0].address,target);assert.equal(r.output.lifecycle.emptyAccountCleanup,undefined);
});

test('preview copies retain original cleanup but reject fresh query cleanup as a state mutation',async()=>{
  const query={to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')};
  for(const queryDeletes of [false,true]){
    const queryCode='0x'+(queryDeletes?call()+'50':'73'+TARGET.slice(2)+'3150')+'602a60005260206000f3';
    const f=await lifecycleFixture({code:queryDeletes?'0x00':'0x'+call()+'5000',accounts:{[TARGET]:empty(true),[GETTER]:{nonce:1n,code:queryCode}}});
    const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[query]});
    assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,queryDeletes?'partial':'complete');
    const m=r.preview.measurements[0];assert.equal(m.status,queryDeletes?'unavailable':'measured');
    if(queryDeletes){assert.equal(m.values,null);assert.equal(r.preview.original.output.lifecycle,undefined);assert.equal(m.before.output.lifecycle.emptyAccountCleanup.deletions[0].address,TARGET);}
    else{assert.deepEqual(m.after.changesBefore,r.preview.original.changes);assert.deepEqual(m.after.changesAfter.accounts.find(a=>a.address===TARGET),row(TARGET));assert.equal(m.after.output.lifecycle,undefined);}
  }
});

test('canonical whole-account cleanup is unchanged across queries and rejects any introduced/deleted/expanded row',()=>{
  const original={scope:SCOPE,accounts:[{address:SENDER,nonce:{before:'0x1',after:'0x2'}},row(TARGET)]};
  const after=structuredClone(original);after.accounts[0].nonce.after='0x3';
  const options={before:original,after,sender:SENDER,nonceBefore:'2',senderExistedBefore:true};
  assert.equal(validateQueryMutation(options).status,'verified');
  const removed=structuredClone(after);removed.accounts.pop();assert.throws(()=>validateQueryMutation({...options,after:removed}));
  for(const extra of [{nonce:{before:'0x0',after:'0x1'}},{balance:{before:'0x0',after:'0x1'}},{code:{before:'0x',after:'0x00'}},{storage:[{slot:word(0),before:word(42),after:word(0)}]}])assert.throws(()=>canonicalStateChanges({scope:SCOPE,accounts:[{...row(TARGET),...extra}]}));
});

test('cleanup metadata rejects getters and proxies before executing them',async()=>{
  const f=await fixture(),r=await run(f);assert.equal(r.status,'completed');let invoked=false;
  for(const hostile of ['getter','proxy']){
    const output=structuredClone(r.output);
    if(hostile==='getter')Object.defineProperty(output.lifecycle.emptyAccountCleanup,'deletions',{enumerable:true,get(){invoked=true;return[];}});
    else output.lifecycle.emptyAccountCleanup=new Proxy(output.lifecycle.emptyAccountCleanup,{get(){invoked=true;throw Error('not called');}});
    assert.throws(()=>validateExecutionLifecycle({output,inputs:r.inputs,destination:f.request.to,changes:r.changes}));assert.equal(invoked,false);
  }
});
