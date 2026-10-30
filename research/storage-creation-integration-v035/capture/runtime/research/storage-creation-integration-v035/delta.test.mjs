// Pure allocation/delta controls only: no EVM, client, subprocess or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyCandidateDelta} from './delta.mjs';
import {allocationRoot,normalizeAllocation,word} from '../amsterdam-storage-creation-v033/observations.mjs';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const BASIS='contract_creation_storage_clear',ZERO=word(0),EMPTY='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const inputs=Array.from({length:6},(_,i)=>JSON.parse(fs.readFileSync(new URL('../amsterdam-storage-creation-v033/capture/inputs/'+String(i+1).padStart(3,'0')+'.json',import.meta.url))));
const snapshot=(...accounts)=>({scope:SCOPE,accounts});
function creation(input,{storage=[{slot:word(2),before:ZERO,after:word(42)}],balance=true}={}){
  const row={address:input.target,nonce:{before:'0x0',after:'0x1'},code:{before:'0x',after:'0x00'},...(storage===null?{}:{storage})};
  if(balance)row.balance={before:input.collision==='absent'?'0x0':'0x11',after:input.collision==='absent'?'0x5':'0x16'};
  if(input.collision==='storage')row.reset={basis:BASIS,initialStorageRoot:input.initialTargetStorageRoot};
  if(input.collision==='absent')row.existence={before:false,after:true,basis:input.rootCreate?'top_level_contract_creation':'internal_contract_creation'};
  return row;
}
async function reject(input,changes,mutate){const i=structuredClone(input),c=structuredClone(changes);mutate(i,c);await assert.rejects(applyCandidateDelta(i,c));}

test('all six frozen inputs reconstruct ordinary creation while only storage cases clear hidden slots',async()=>{
  for(const input of inputs){
    const prior=structuredClone(input),changes=snapshot(creation(input)),saved=structuredClone(changes),out=await applyCandidateDelta(input,changes);
    assert.deepEqual(out[input.target],{nonce:'0x1',balance:input.collision==='absent'?'0x5':'0x16',code:'0x00',storage:{[word(2)]:word(42)}});
    for(const[a,row]of Object.entries(normalizeAllocation(input.allocation)))if(a!==input.target)assert.deepEqual(out[a],row);
    assert.deepEqual(input,prior);assert.deepEqual(changes,saved);
    assert.deepEqual(await applyCandidateDelta(input,snapshot()),normalizeAllocation(input.allocation));
  }
});

test('reset retains old-equal writes, removes unmentioned slots and preserves prefunding when balance has no delta',async()=>{
  const input=inputs[0],row=creation(input,{balance:false,storage:[{slot:word(0),before:ZERO,after:word(999)},{slot:word(991),before:ZERO,after:word(123456)}]});
  const out=await applyCandidateDelta(input,snapshot(row));
  assert.equal(out[input.target].balance,'0x11');assert.deepEqual(out[input.target].storage,{[word(0)]:word(999),[word(991)]:word(123456)});
  const empty=await applyCandidateDelta(input,snapshot(creation(input,{storage:null})));
  assert.deepEqual(empty[input.target].storage,{});
});

test('independently reconstructed initial and target roots reject swapped roots and modified hidden storage',async()=>{
  const input=inputs[0],changes=snapshot(creation(input));
  for(const mutate of[
    i=>{i.initialStateRoot=word(1);i.header.stateRoot=word(1);},
    i=>{i.header.stateRoot=word(1);},
    i=>{i.initialTargetStorageRoot=EMPTY;},
    i=>{i.allocation[i.target].storage[word(991)]=word(55);},
    (_i,c)=>{c.accounts[0].reset.initialStorageRoot=EMPTY;},
    (_i,c)=>{c.accounts[0].reset.initialStorageRoot=word(9);},
  ])await reject(input,changes,mutate);
  const changed=structuredClone(input);changed.allocation[changed.target].storage[word(991)]=word(55);
  changed.initialStateRoot=await allocationRoot(changed.allocation);changed.header.stateRoot=changed.initialStateRoot;
  await assert.rejects(applyCandidateDelta(changed,changes),'Target root binding remains required even when the full prestate root is updated');
});

test('reset authorization is limited to the two declared storage-only targets and the creation-clear basis',async()=>{
  const input=inputs[0],changes=snapshot(creation(input));
  for(const mutate of[
    (_i,c)=>{delete c.accounts[0].reset;},
    (_i,c)=>{c.accounts[0].reset.basis='same_invocation_created_contract_clearing_eip8246';},
    (_i,c)=>{c.accounts[0].reset.basis='shanghai_selfdestruct_deletion';},
    (_i,c)=>{c.accounts[0].reset.extra=true;},
    (_i,c)=>{c.accounts[0].address=input.request.from;},
    (_i,c)=>{delete c.accounts[0].nonce;},
    (_i,c)=>{c.accounts[0].nonce.after='0x0';},
    (_i,c)=>{c.accounts[0].existence={before:false,after:true,basis:'top_level_contract_creation'};},
    i=>{i.id='unrecognized_case';},
    i=>{i.chainId=1;},
  ])await reject(input,changes,mutate);
  for(const input of inputs.slice(2)){
    const row=creation(input);row.reset={basis:BASIS,initialStorageRoot:input.initialTargetStorageRoot};
    await assert.rejects(applyCandidateDelta(input,snapshot(row)));
  }
});

test('reset before-values remain original for nonce balance code but zero for new storage',async()=>{
  const input=inputs[0],changes=snapshot(creation(input));
  for(const mutate of[
    (_i,c)=>{c.accounts[0].nonce.before='0x1';},
    (_i,c)=>{c.accounts[0].balance.before='0x0';},
    (_i,c)=>{c.accounts[0].code.before='0x00';},
    (_i,c)=>{c.accounts[0].storage[0]={slot:word(0),before:word(999),after:word(42)};},
    (_i,c)=>{c.accounts[0].storage[0].after=ZERO;},
    (_i,c)=>{c.accounts[0].storage.push(structuredClone(c.accounts[0].storage[0]));},
    (_i,c)=>{c.accounts.push(structuredClone(c.accounts[0]));},
    (_i,c)=>{c.accounts[0].nonce.after='0x01';},
    (_i,c)=>{c.accounts[0].nonce.after='0x10000000000000000';},
    (_i,c)=>{c.accounts[0].storage[0].slot='0x2';},
    (_i,c)=>{c.accounts[0].storage=[];},
    (_i,c)=>{c.accounts[0].bogus=true;},
    (_i,c)=>{c.accounts[0].existence=null;},
  ])await reject(input,changes,mutate);
});

test('ordinary storage deltas use original values and may delete individual slots without clearing the account',async()=>{
  const input=inputs[0],row={address:input.target,storage:[{slot:word(0),before:word(999),after:word(42)},{slot:word(991),before:word(123456),after:ZERO}]};
  const out=await applyCandidateDelta(input,snapshot(row));assert.deepEqual(out[input.target].storage,{[word(0)]:word(42)});assert.equal(out[input.target].nonce,'0x0');
  await reject(input,snapshot(row),(_i,c)=>{c.accounts[0].storage[0].before=ZERO;});
});

test('ordinary absent-account creation and fee recipient funding require precise existence provenance',async()=>{
  const input=inputs[2],row=creation(input),recipient=input.header.miner;
  const funding={address:recipient,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:'0x5'}};
  const out=await applyCandidateDelta(input,snapshot(row,funding));assert.deepEqual(out[recipient],{nonce:'0x0',balance:'0x5',code:'0x',storage:{}});
  for(const mutate of[
    (_i,c)=>{delete c.accounts[0].existence;},
    (_i,c)=>{delete c.accounts[0].nonce;},
    (_i,c)=>{c.accounts[0].existence.basis='internal_contract_creation';},
    (_i,c)=>{c.accounts[1].existence.basis='unsigned_sender_nonce_materialization';},
    (_i,c)=>{c.accounts[1].code={before:'0x',after:'0x00'};},
  ])await reject(input,snapshot(row,funding),mutate);
});

test('whole-account deletion and all SELFDESTRUCT reset families are outside this six-case helper',async()=>{
  for(const input of inputs)for(const basis of['same_invocation_created_contract_deletion','shanghai_selfdestruct_deletion','same_invocation_created_contract_clearing_eip8246','eip161_empty_account_cleanup']){
    await assert.rejects(applyCandidateDelta(input,snapshot({address:input.target,existence:{before:true,after:false,basis}})));
    const row=creation(input);delete row.existence;row.reset={basis,initialStorageRoot:input.initialTargetStorageRoot};
    await assert.rejects(applyCandidateDelta(input,snapshot(row)));
  }
});
