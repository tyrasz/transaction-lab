// Fabricated deltas and input-only declarations. No EVM/client is invoked.
// These controls test representation; their invented balances are not outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {declaration,BENEFICIARY,QUERY_HELPER} from './cases.mjs';
import {applyCandidateDelta} from './delta.mjs';
import {allocationRoot,word} from '../amsterdam-storage-creation-v033/observations.mjs';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const CREATION='contract_creation_storage_clear',CLEARING='same_invocation_created_contract_clearing_eip8246';
const SHANGHAI='shanghai_selfdestruct_deletion',DELETION='same_invocation_created_contract_deletion';
const ZERO=word(0),EMPTY='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const snapshot=(...accounts)=>({scope:SCOPE,accounts});
const qty=n=>'0x'+BigInt(n).toString(16);
let declarations;
const inputs=()=>declarations??=Promise.all(Array.from({length:8},(_,i)=>declaration(i)));
const rootFor=(input,target)=>target===input.target?input.initialTargetStorageRoot:input.queryCreation.initialStorageRoot;
function creation(input,target=input.target,{balance=22n,storage=true,code='0x60005400'}={}){
  const a=input.allocation[target];return{address:target,reset:{basis:CREATION,initialStorageRoot:rootFor(input,target)},nonce:{before:'0x0',after:'0x1'},
    ...(code==='0x'?{}:{code:{before:'0x',after:code}}),
    ...(balance===BigInt(a.balance)?{}:{balance:{before:a.balance,after:qty(balance)}}),
    ...(storage?{storage:[{slot:word(0),before:ZERO,after:word(999)},{slot:word(2),before:ZERO,after:word(42)}]}:{})};
}
function deletion(input,target=input.target){const a=input.allocation[target];return{address:target,
  existence:{before:true,after:false,basis:input.fork==='Shanghai'?SHANGHAI:input.fork==='Amsterdam'?CLEARING:DELETION},
  ...(BigInt(a.balance)>0n?{balance:{before:a.balance,after:'0x0'}}:{})};}
function clearing(input,target=input.target,balance=17n){return{address:target,reset:{basis:CLEARING,initialStorageRoot:rootFor(input,target)},
  ...(BigInt(input.allocation[target].balance)===balance?{}:{balance:{before:input.allocation[target].balance,after:qty(balance)}})};}
function sender(input,nonce=2n,debit=100n){const a=input.allocation[input.request.from];return{address:input.request.from,nonce:{before:a.nonce,after:qty(nonce)},
  ...(debit===0n?{}:{balance:{before:a.balance,after:qty(BigInt(a.balance)-debit)}})};}
async function rejects(input,changes,mutate){const i=structuredClone(input),d=structuredClone(changes);await mutate(i,d);await assert.rejects(applyCandidateDelta(i,d));}

test('all eight untouched allocations and authentic T/Q roots are bound independently',async()=>{
  for(const input of await inputs())assert.deepEqual(await applyCandidateDelta(input,snapshot()),input.allocation);
  const input=(await inputs())[7];
  for(const mutate of[
    i=>{i.initialStateRoot=word(3);i.header.stateRoot=word(3);},
    i=>{i.header.stateRoot=word(3);},
    i=>{i.initialTargetStorageRoot=EMPTY;},
    i=>{i.queryCreation.initialStorageRoot=EMPTY;},
    i=>{i.queryCreation.target=i.target;},
    i=>{i.allocation[i.target].storage[word(991)]=word(9);},
    async i=>{i.allocation[i.queryCreation.target].storage[word(991)]=word(9);i.initialStateRoot=await allocationRoot(i.allocation);i.header.stateRoot=i.initialStateRoot;},
  ])await rejects(input,snapshot(),mutate);
});

test('creation clearing keeps old-equal writes, removes hidden slots and preserves omitted prefunding',async()=>{
  const input=(await inputs())[7],saved=structuredClone(input);
  for(const target of [input.target,input.queryCreation.target]){
    const changes=snapshot(creation(input,target,{balance:17n})),copy=structuredClone(changes),out=await applyCandidateDelta(input,changes);
    assert.deepEqual(out[target],{nonce:'0x1',balance:'0x11',code:'0x60005400',storage:{[word(0)]:word(999),[word(2)]:word(42)}});
    assert.equal(Object.hasOwn(out[target].storage,word(991)),false);
    assert.deepEqual(input,saved);assert.deepEqual(changes,copy);
    for(const [a,before]of Object.entries(input.allocation))if(a!==target)assert.deepEqual(out[a],before);
    const empty=await applyCandidateDelta(input,snapshot(creation(input,target,{storage:false,code:'0x'})));
    assert.deepEqual(empty[target],{nonce:'0x1',balance:'0x16',code:'0x',storage:{}});
  }
});

test('Shanghai/Osaka whole deletion removes hidden storage and a target that aliases coinbase',async()=>{
  for(const input of (await inputs()).slice(0,2)){
    assert.equal(input.header.miner,input.target);
    const d=snapshot(sender(input),deletion(input)),out=await applyCandidateDelta(input,d);
    assert.equal(Object.hasOwn(out,input.target),false);
    assert.equal(out[input.request.from].nonce,'0x2');
    assert.equal(BigInt(out[input.request.from].balance),BigInt(input.allocation[input.request.from].balance)-100n);
    // There is no fee reapplication here: final deletion wins even when the
    // finalizer ran after a tip credited to this very account.
    assert.equal(Object.keys(out).length,Object.keys(input.allocation).length-1);
  }
});

test('Amsterdam final clearing preserves the supplied settled balance, including fee-recipient aliases',async()=>{
  const input=(await inputs())[2];assert.equal(input.header.miner,input.target);
  for(const balance of [17n,22n,123456789n]){
    const out=await applyCandidateDelta(input,snapshot(clearing(input,input.target,balance)));
    assert.deepEqual(out[input.target],{nonce:'0x0',balance:qty(balance),code:'0x',storage:{}});
  }
  const absent=await applyCandidateDelta(input,snapshot(deletion(input)));
  assert.equal(Object.hasOwn(absent,input.target),false,'zero preserved balance is whole-account absence');
});

test('absent beneficiary funding is explicit, while an alias remains one existing-account delta',async()=>{
  const input=(await inputs())[3];assert.equal(input.allocation[BENEFICIARY],undefined);
  const funding={address:BENEFICIARY,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:'0x16'}};
  const out=await applyCandidateDelta(input,snapshot(funding,clearing(input,input.target,31n)));
  assert.deepEqual(out[BENEFICIARY],{nonce:'0x0',balance:'0x16',code:'0x',storage:{}});
  assert.equal(out[input.target].balance,'0x1f');
  for(const mutate of[
    (_i,d)=>{delete d.accounts[0].existence;},
    (_i,d)=>{d.accounts[0].balance.after='0x0';},
    (_i,d)=>{d.accounts[0].nonce={before:'0x0',after:'0x1'};},
    (_i,d)=>{d.accounts[0].existence.basis='internal_contract_creation';},
  ])await rejects(input,snapshot(funding),mutate);
});

test('after-query deletion is cumulative from the old global target, not the prior deployed snapshot',async()=>{
  const input=(await inputs())[4];
  const original=snapshot(sender(input),creation(input));
  const deployed=await applyCandidateDelta(input,original);assert.equal(deployed[input.target].balance,'0x16');
  const query=snapshot(sender(input,3n),deletion(input));
  const after=await applyCandidateDelta(input,query);assert.equal(Object.hasOwn(after,input.target),false);assert.equal(after[input.request.from].nonce,'0x3');
  await rejects(input,query,(_i,d)=>{d.accounts[1].balance.before='0x16';});
  await rejects(input,query,(_i,d)=>{d.accounts[0].nonce.before='0x2';});
  await rejects(input,original,(_i,d)=>{d.accounts[1].storage[0].before=word(999);});
  assert.deepEqual(await applyCandidateDelta(input,original),deployed);
});

test('Q query clearing and helper nonce are cumulative; discarded queries cannot poison later reads',async()=>{
  const input=(await inputs())[7],q=input.queryCreation.target,base=structuredClone(input);
  const original=snapshot(sender(input),creation(input));
  const originalAllocation=await applyCandidateDelta(input,original);
  const helper={address:QUERY_HELPER,nonce:{before:input.allocation[QUERY_HELPER].nonce,after:'0x8'}};
  const retained=snapshot(sender(input,3n),creation(input),helper,clearing(input,q));
  const retainedAllocation=await applyCandidateDelta(input,retained);
  assert.deepEqual(retainedAllocation[q],{nonce:'0x0',balance:'0x11',code:'0x',storage:{}});
  assert.equal(retainedAllocation[QUERY_HELPER].nonce,'0x8');
  const neutral=snapshot(sender(input,3n),creation(input));
  const neutralAllocation=await applyCandidateDelta(input,neutral);
  assert.deepEqual(neutralAllocation[q],input.allocation[q]);assert.deepEqual(neutralAllocation[QUERY_HELPER],input.allocation[QUERY_HELPER]);
  // Each reconstruction is fresh: the next native read uses the original
  // settled overlay, not the retained or reverted disposable query overlay.
  assert.deepEqual(await applyCandidateDelta(input,original),originalAllocation);assert.deepEqual(input,base);
  const beforeHalf=await applyCandidateDelta(input,snapshot(sender(input,2n,0n)));
  assert.deepEqual(beforeHalf[input.target],input.allocation[input.target]);assert.deepEqual(beforeHalf[q],input.allocation[q]);
  await rejects(input,retained,(_i,d)=>{d.accounts[2].nonce.before='0x8';});
  await rejects(input,retained,(_i,d)=>{d.accounts[1].balance.before='0x16';});
});

test('case labels do not force the independent comparison outcome',async()=>{
  const all=await inputs();
  // These fabricated outcomes contradict the declared intended path but are
  // valid delta representations. The independent client decides agreement.
  for(const input of all.slice(0,4)){
    const out=await applyCandidateDelta(input,snapshot(creation(input)));
    assert.equal(out[input.target].nonce,'0x1');assert.equal(out[input.target].code,'0x60005400');
    assert.deepEqual(await applyCandidateDelta(input,snapshot()),input.allocation);
  }
  const input=all[7],q=input.queryCreation.target;
  assert.equal((await applyCandidateDelta(input,snapshot(creation(input,q))))[q].nonce,'0x1');
  assert.equal(Object.hasOwn(await applyCandidateDelta(input,snapshot(deletion(input,q))),q),false);
});

test('invented reset roots, omitted reset and contradictory lifecycle combinations are rejected',async()=>{
  const input=(await inputs())[7],valid=creation(input);
  for(const mutate of[
    (_i,d)=>{d.accounts[0].reset.initialStorageRoot=word(1);},
    (_i,d)=>{d.accounts[0].reset.initialStorageRoot=EMPTY;},
    (_i,d)=>{delete d.accounts[0].reset;},
    (_i,d)=>{delete d.accounts[0].nonce;},
    (_i,d)=>{d.accounts[0].reset.basis='shanghai_selfdestruct_deletion';},
    (_i,d)=>{d.accounts[0].reset.extra=true;},
    (_i,d)=>{d.accounts[0].address=QUERY_HELPER;},
    (_i,d)=>{d.accounts[0].existence={before:true,after:false,basis:CLEARING};},
  ])await rejects(input,snapshot(valid),mutate);
  for(const extra of [
    {nonce:{before:'0x0',after:'0x1'}},{code:{before:'0x',after:'0x00'}},
    {storage:[{slot:word(2),before:ZERO,after:word(42)}]},
    {balance:{before:'0x11',after:'0x0'}},
  ])await assert.rejects(applyCandidateDelta(input,snapshot({...clearing(input),...extra})));
  for(const extra of [
    {reset:{basis:CLEARING,initialStorageRoot:input.initialTargetStorageRoot}},
    {nonce:{before:'0x0',after:'0x1'}},{code:{before:'0x',after:'0x00'}},
    {storage:[{slot:word(0),before:word(999),after:ZERO}]},
  ])await assert.rejects(applyCandidateDelta(input,snapshot({...deletion(input),...extra})));
  await rejects(input,snapshot(deletion(input)),(_i,d)=>{delete d.accounts[0].balance;});
  for(const historical of (await inputs()).slice(0,2))await assert.rejects(applyCandidateDelta(historical,snapshot(clearing(historical))));
  await rejects(input,snapshot(deletion(input)),(_i,d)=>{d.accounts[0].existence.basis=DELETION;});
});

test('nonreset storage changes use global initial slots and cannot silently clear a namespace',async()=>{
  const input=(await inputs())[7],q=input.queryCreation.target;
  const sparse=snapshot({address:q,storage:[{slot:word(991),before:word(123456),after:word(8)}]});
  const out=await applyCandidateDelta(input,sparse);assert.equal(out[q].storage[word(0)],word(999));assert.equal(out[q].storage[word(991)],word(8));
  await rejects(input,sparse,(_i,d)=>{d.accounts[0].storage[0].before=ZERO;});
  await rejects(input,snapshot(creation(input)),(_i,d)=>{d.accounts[0].storage[1].after=ZERO;});
});

test('duplicate, empty, noncanonical and overflowing deltas fail before reconstruction',async()=>{
  const input=(await inputs())[7],valid=creation(input);
  for(const mutate of[
    (_i,d)=>{d.accounts.push(structuredClone(d.accounts[0]));},
    (_i,d)=>{d.accounts[0].storage.push(structuredClone(d.accounts[0].storage[0]));},
    (_i,d)=>{d.accounts[0]={address:input.target};},
    (_i,d)=>{d.accounts[0].balance.after='0x016';},
    (_i,d)=>{d.accounts[0].balance.after=qty(1n<<256n);},
    (_i,d)=>{d.accounts[0].nonce.after=qty(1n<<64n);},
    (_i,d)=>{d.accounts[0].storage[0].slot='0x0';},
    (_i,d)=>{d.accounts[0].storage[0].after=d.accounts[0].storage[0].before;},
    (_i,d)=>{d.accounts[0].storage=[];},
    (_i,d)=>{d.accounts[0].unknown=true;},
    (_i,d)=>{d.accounts[0].balance.before='0x12';},
  ])await rejects(input,snapshot(valid),mutate);
});

test('hostile getters and proxies are rejected without invoking accessors',async()=>{
  const input=(await inputs())[7];let invoked=false;
  const row=creation(input);Object.defineProperty(row,'reset',{enumerable:true,get(){invoked=true;return{};}});
  await assert.rejects(applyCandidateDelta(input,snapshot(row)));assert.equal(invoked,false);
  const poisoned=structuredClone(input);Object.defineProperty(poisoned.queryCreation,'initialStorageRoot',{enumerable:true,get(){invoked=true;return EMPTY;}});
  await assert.rejects(applyCandidateDelta(poisoned,snapshot()));assert.equal(invoked,false);
  await assert.rejects(applyCandidateDelta(input,snapshot(new Proxy(creation(input),{}))));
});
