// Fabricated parent-consistency records only. These controls execute no EVM,
// target, RPC or subprocess and do not establish execution or proof accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { bytesToHex, hexToBytes, privateToAddress, createAddressFromString, createContractAddress,
  eoaCode7702SignAuthorization, eoaCode7702AuthorizationListBytesItemToJSON } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createExecutionState, updateExecutionAccounts } from '../execution-state.js';
import { canonicalStateChanges } from '../preview-mutations.js';
import { validateExecutionChanges } from '../execution-changes.js';
import { deriveAuthorizationPreparation } from '../authorization-validation.js';
import { deriveAmsterdamAuthorizationPreparation, deriveAmsterdamAuthorizationEntryGas } from '../amsterdam-authorization-validation.js';
import { ethereumCommon, ethereumCallGas } from '../ethereum-profile.js';
import { revertedFeeRows } from '../fee-validation.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const key=n=>'0x'+n.toString(16).padStart(2,'0').repeat(32),signer=n=>bytesToHex(privateToAddress(hexToBytes(key(n))));
const S=signer(1),A=signer(2),B=signer(3),T='0x'+'44'.repeat(20),C='0x'+'55'.repeat(20),D='0x'+'66'.repeat(20),D2='0x'+'77'.repeat(20),X='0x'+'88'.repeat(20),N='0x'+'99'.repeat(20),ZERO='0x'+'00'.repeat(20);
const common=new Common({chain:Mainnet,hardfork:Hardfork.Prague});
const shanghaiCommon=new Common({chain:Mainnet,hardfork:Hardfork.Shanghai});
const header=JSON.parse(readFileSync(new URL('./fixtures/sepolia-network/header-12018196.json',import.meta.url)));
const amsterdamCommon=ethereumCommon(header,11155111);
const fact=(extra={})=>({exists:true,nonce:'0',balance:'7',code:'0x',storage:{},...extra});
const snapshot=accounts=>canonicalStateChanges({scope:SCOPE,accounts});
const row=(value,address)=>(value.snapshot??value).accounts.find(item=>item.address===address);
const copy=value=>structuredClone(value);

// Proof-shaped labels are synthetic context for these consistency checks.
// No test presents them as authenticated or invokes proof verification.
function addFact(inputs,address,value,storageRoot=EMPTY_STORAGE_ROOT){
  inputs.accounts[address]=value;
  inputs.provenance.push({account:address,accountProof:{exists:value.exists,
    nonceRaw:value.exists?value.nonce:'0',balanceRaw:value.exists?value.balance:'0',storageRoot,
    codeHash:bytesToHex(keccak_256(hexToBytes(value.exists?value.code:'0x')))}});
}
function inputsFixture(){
  const inputs={accounts:{},provenance:[]};
  addFact(inputs,S,fact({nonce:'1',balance:'1000000000000000000000000'}));
  addFact(inputs,T,fact({nonce:'1',balance:'10',code:'0x00',storage:{[word(0)]:word(0)}}));
  addFact(inputs,C,fact({nonce:'1'}));addFact(inputs,A,{exists:false});addFact(inputs,B,{exists:false});addFact(inputs,N,{exists:false});
  addFact(inputs,X,fact({balance:'9',storage:{[word(0)]:word(999),[word(991)]:word(123456)}}),word(1234));
  return inputs;
}
function prefix(){return snapshot([
  {address:S,nonce:{before:'0x1',after:'0x2'}},
  {address:T,storage:[{slot:word(0),before:word(0),after:word(7)}]},
  {address:N,existence:{before:false,after:true,basis:'internal_contract_creation'},nonce:{before:'0x0',after:'0x1'},code:{before:'0x',after:'0x00'},storage:[{slot:word(0),before:word(0),after:word(42)}]},
]);}
function frame({to=T,type='CALL',value='0x0',error=null,output='0x'}={}){
  return{type,depth:0,from:S,caller:S,to,executionAddress:to,input:'0x',output,value,error,calls:[]};
}
function result(options={}){const trace=frame(options);return{execution:{status:options.status??(trace.error?'reverted':'success'),error:trace.error,executionGasUsed:'0',gasRefundCounter:'0',returnData:trace.output},trace,logs:[]};}
function validate(inputs,startingChanges,changes,output=result(),destination=T){
  return validateExecutionChanges({inputs,startingChanges,changes,output,sender:S,destination,common,selfdestructOnlyCreated:true});
}
function validateShanghai(inputs,startingChanges,changes,output=result(),destination=T){
  return validateExecutionChanges({inputs,startingChanges,changes,output,sender:S,destination,common:shanghaiCommon,selfdestructOnlyCreated:false});
}
const auth=(chain,nonce=0n,address=D,who=2)=>Object.fromEntries(Object.entries(eoaCode7702AuthorizationListBytesItemToJSON(
  eoaCode7702SignAuthorization({chainId:hex(chain),address,nonce:hex(nonce)},hexToBytes(key(who)))))
  .map(([name,value])=>[name,name==='address'?value:hex(value==='0x'?0n:BigInt(value))]));
const request=list=>({from:S,to:T,data:'0x',value:'0',gas:'1000000',authorizationList:list});
const derive=(inputs,list,startingChanges)=>deriveAuthorizationPreparation({request:request(list),header:{},inputs,common,startingChanges});
const deriveAmsterdam=(inputs,list,startingChanges,extra={})=>deriveAmsterdamAuthorizationPreparation({request:{...request(list),...extra},header,inputs,common:amsterdamCommon,startingChanges});

test('fabricated starting view preserves immutable facts, overlays fields and refuses false before labels',()=>{
  const inputs=inputsFixture(),start=prefix(),saved=copy({inputs,start}),state=createExecutionState(inputs,start);
  assert.equal(state.initial(S).nonce,'1');assert.equal(state.account(S).nonce,'2');
  assert.deepEqual(state.account(N),{exists:true,nonce:'1',balance:'0',code:'0x00'});
  assert.equal(state.storage(T,word(0)),word(7));assert.equal(state.storage(N,word(991)),word(0));
  for(const change of[s=>{row(s,S).nonce.before='0x0';},s=>{row(s,T).storage[0].before=word(1);},s=>{row(s,N).existence.before=true;}]){
    const bad=copy(start);change(bad);assert.throws(()=>createExecutionState(inputs,bad));
  }
  const composed=updateExecutionAccounts(inputs,start,[[S,{exists:true,nonce:3n,code:'0x'}]]);
  assert.deepEqual(row(composed,S).nonce,{before:'0x1',after:'0x3'});assert.deepEqual(row(composed,T),row(start,T));assert.deepEqual(row(composed,N),row(start,N));
  assert.deepEqual({inputs,start},saved);
});

test('fabricated deletion rematerialization carries the original namespace root and clears hidden storage',()=>{
  const inputs=inputsFixture();addFact(inputs,D,fact({nonce:'4',balance:'9',code:'0x00',storage:{[word(991)]:word(999)}}),word(2345));
  const start=snapshot([{address:D,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'},balance:{before:'0x9',after:'0x0'}}]);
  assert.deepEqual(createExecutionState(inputs,start).account(D),{exists:false,nonce:'0',balance:'0',code:'0x'});
  const next=updateExecutionAccounts(inputs,start,[[D,{exists:true,nonce:1n,code:'0xef0100'+D2.slice(2)}]]);
  assert.deepEqual(row(next,D).reset,{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:word(2345)});
  assert.equal(createExecutionState(inputs,next).storage(D,word(991)),word(0));
  const bad=copy(next);row(bad,D).reset.initialStorageRoot=word(7);assert.throws(()=>createExecutionState(inputs,bad));
  assert.throws(()=>updateExecutionAccounts(inputs,start,[[D,{exists:false}]]));
});

test('fabricated second CALL keeps cumulative nonce and preceding storage/code provenance',()=>{
  const inputs=inputsFixture(),start=prefix(),saved=copy({inputs,start});
  const next=updateExecutionAccounts(inputs,start,[[S,{exists:true,nonce:3n,code:'0x'}]]);
  assert.doesNotThrow(()=>validate(inputs,start,next));
  const dropped=copy(next);dropped.accounts=dropped.accounts.filter(r=>r.address!==N);assert.throws(()=>validate(inputs,start,dropped));
  const stale=copy(next);row(stale,S).nonce.after='0x2';assert.throws(()=>validate(inputs,start,stale));
  assert.deepEqual({inputs,start},saved);
});

test('fabricated failed CALL retains its prefix and only this transaction nonce',()=>{
  const inputs=inputsFixture(),start=prefix(),next=updateExecutionAccounts(inputs,start,[[S,{exists:true,nonce:3n,code:'0x'}]]);
  for(const output of[result({error:'revert'}),result({status:'failed',error:'out of gas'})]){
    assert.doesNotThrow(()=>validate(inputs,start,next,output));
    const mutated=copy(next);row(mutated,T).storage[0].after=word(8);assert.throws(()=>validate(inputs,start,mutated,output));
    assert.throws(()=>validate(inputs,start,snapshot([row(next,S)]),output));
  }
});

test('fabricated incomplete transaction must leave the accepted prefix unchanged',()=>{
  const inputs=inputsFixture(),start=prefix(),output={execution:{status:'unavailable'},trace:null};
  assert.doesNotThrow(()=>validate(inputs,start,copy(start),output));
  assert.throws(()=>validate(inputs,start,snapshot([]),output));
  const mutated=copy(start);row(mutated,S).nonce.after='0x3';assert.throws(()=>validate(inputs,start,mutated,output));
});

test('fabricated inherited storage reset remains valid when a later CALL changes storage and balance',()=>{
  const inputs=inputsFixture(),start=prefix();start.accounts.push({address:X,reset:{basis:'contract_creation_storage_clear',initialStorageRoot:word(1234)},nonce:{before:'0x0',after:'0x1'},code:{before:'0x',after:'0x00'},storage:[{slot:word(0),before:word(0),after:word(42)}]});
  const canonical=canonicalStateChanges(start),balance=BigInt(inputs.accounts[S].balance);
  const next=updateExecutionAccounts(inputs,canonical,[[S,{exists:true,nonce:3n,balance:balance-3n}],[X,{exists:true,balance:12n}]]);
  row(next,X).storage[0].after=word(43);
  assert.doesNotThrow(()=>validate(inputs,canonical,next,result({to:X,value:'0x3'}),X));
  assert.equal(createExecutionState(inputs,next).storage(X,word(991)),word(0));
  const changedRoot=copy(next);row(changedRoot,X).reset.initialStorageRoot=word(88);assert.throws(()=>validate(inputs,canonical,changedRoot,result({to:X,value:'0x3'}),X));
});

test('fabricated root CREATE derives its address from the current sender nonce',()=>{
  const inputs=inputsFixture(),start=prefix(),target=createContractAddress(createAddressFromString(S),2n).toString();
  addFact(inputs,target,{exists:false});
  const next=updateExecutionAccounts(inputs,start,[[S,{exists:true,nonce:3n}],[target,{exists:true,nonce:1n,code:'0x',existenceBasis:'top_level_contract_creation'}]]);
  assert.doesNotThrow(()=>validate(inputs,start,next,result({to:target,type:'CREATE'}),null));
  const stale=createContractAddress(createAddressFromString(S),1n).toString();
  assert.throws(()=>validate(inputs,start,next,result({to:stale,type:'CREATE'}),null));
});

test('fabricated rematerialized sender may increment back to its immutable nonce without a cumulative nonce row',()=>{
  const inputs=inputsFixture(),storageRoot=word(3456);
  inputs.provenance=inputs.provenance.filter(item=>item.account!==S);
  addFact(inputs,S,fact({nonce:'1',balance:'0',code:'0x00',storage:{[word(991)]:word(999)}}),storageRoot);
  // A preceding deletion and native funding leave a live sender at nonce zero.
  const start=snapshot([{address:S,reset:{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:storageRoot},
    nonce:{before:'0x1',after:'0x0'},code:{before:'0x00',after:'0x'},balance:{before:'0x0',after:'0x9'}}]);
  const next=updateExecutionAccounts(inputs,start,[[S,{exists:true,nonce:1n,code:'0x'}]]);
  assert.equal(row(next,S).nonce,undefined);assert.deepEqual(row(next,S).reset,row(start,S).reset);
  assert.equal(createExecutionState(inputs,next).storage(S,word(991)),word(0));
  assert.doesNotThrow(()=>validateShanghai(inputs,start,next));
  const falsePrefix=copy(start);row(falsePrefix,S).nonce.before='0x0';
  assert.throws(()=>validateShanghai(inputs,falsePrefix,next));
  const localBefore=copy(next);row(localBefore,S).nonce={before:'0x0',after:'0x1'};
  assert.throws(()=>validateShanghai(inputs,start,localBefore));
});

test('fabricated recreation may restore immutable nonce one while retaining its deletion reset',()=>{
  const inputs=inputsFixture(),target=createContractAddress(createAddressFromString(S),2n).toString(),storageRoot=word(4567);
  addFact(inputs,target,fact({nonce:'1',balance:'0',code:'0x00',storage:{[word(991)]:word(999)}}),storageRoot);
  const start=prefix();start.accounts.push({address:target,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'}});
  const canonical=canonicalStateChanges(start),next=updateExecutionAccounts(inputs,canonical,
    [[S,{exists:true,nonce:3n}],[target,{exists:true,nonce:1n,code:'0x6000'}]]);
  const output=result({to:target,type:'CREATE',output:'0x6000'});
  assert.equal(row(next,target).nonce,undefined);
  assert.deepEqual(row(next,target).reset,{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:storageRoot});
  assert.equal(createExecutionState(inputs,next).storage(target,word(991)),word(0));
  assert.doesNotThrow(()=>validateShanghai(inputs,canonical,next,output,null));
  const localBefore=copy(next);row(localBefore,target).code.before='0x';
  assert.throws(()=>validateShanghai(inputs,canonical,localBefore,output,null));
  const falseRoot=copy(next);row(falseRoot,target).reset.initialStorageRoot=word(4568);
  assert.throws(()=>validateShanghai(inputs,canonical,falseRoot,output,null));
});

test('fabricated unrelated CALL cannot omit a carried deletion of a storage-only account',()=>{
  const inputs=inputsFixture();addFact(inputs,D,fact({balance:'0',storage:{}}),word(5678));
  const start=prefix();start.accounts.push({address:D,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'}});
  const canonical=canonicalStateChanges(start),next=updateExecutionAccounts(inputs,canonical,[[S,{exists:true,nonce:3n}]]);
  assert.doesNotThrow(()=>validateShanghai(inputs,canonical,next));
  assert.equal(createExecutionState(inputs,next).storage(D,word(991)),word(0));
  const omitted=copy(next);omitted.accounts=omitted.accounts.filter(item=>item.address!==D);
  // Nonce, code and balance are all zero in the immutable account, so their
  // equality alone cannot distinguish deletion from resurrecting its old trie.
  assert.equal(createExecutionState(inputs,omitted).account(D).exists,true);
  assert.throws(()=>validateShanghai(inputs,canonical,omitted));
});

test('fabricated recreation into a previously reset namespace cannot omit the retained reset',()=>{
  const inputs=inputsFixture(),target=createContractAddress(createAddressFromString(S),2n).toString(),storageRoot=word(6789);
  // No original slots are demanded: the namespace marker must also protect
  // original storage which is unknown to this fabricated input collection.
  addFact(inputs,target,fact({balance:'0',storage:{}}),storageRoot);
  const start=prefix();start.accounts.push({address:target,reset:{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:storageRoot},balance:{before:'0x0',after:'0x9'}});
  const canonical=canonicalStateChanges(start),next=updateExecutionAccounts(inputs,canonical,
    [[S,{exists:true,nonce:3n}],[target,{exists:true,nonce:1n,code:'0x00'}]]);
  const output=result({to:target,type:'CREATE',output:'0x00'});
  assert.doesNotThrow(()=>validateShanghai(inputs,canonical,next,output,null));
  assert.equal(createExecutionState(inputs,next).storage(target,word(991)),word(0));
  const omitted=copy(next);delete row(omitted,target).reset;
  assert.throws(()=>validateShanghai(inputs,canonical,omitted,output,null));
});

test('pure authorization prefixes use current nonce/existence and retain cumulative provenance',()=>{
  const inputs=inputsFixture(),start=prefix(),saved=copy({inputs,start}),first=derive(inputs,[auth(1n)],start),second=derive(inputs,[auth(1n,1n,ZERO)],first.snapshot);
  assert.equal(first.processing.gasRefundCounter,'0');assert.equal(second.processing.gasRefundCounter,'12500');
  assert.equal(second.accounts.get(A).initial.exists,false);assert.equal(second.accounts.get(A).starting.nonce,1n);assert.equal(second.accounts.get(A).current.nonce,2n);
  assert.deepEqual(row(second,A).nonce,{before:'0x0',after:'0x2'});assert.equal(row(second,A).code,undefined);assert.equal(row(second,A).existence.basis,'eip7702_authorization_materialization');
  assert.deepEqual(row(second,S).nonce,{before:'0x1',after:'0x4'});assert.deepEqual(row(second,T),row(start,T));assert.deepEqual(row(second,N),row(start,N));
  assert.equal(derive(inputs,[auth(1n)],first.snapshot).processing.entries[0].reason,'nonce_mismatch');
  const funded=copy(start);funded.accounts.push({address:A,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:'0x9'}});
  const upgraded=derive(inputs,[auth(1n)],funded);assert.equal(row(upgraded,A).existence.basis,'eip7702_authorization_materialization');assert.equal(upgraded.processing.gasRefundCounter,'12500');
  assert.deepEqual({inputs,start},saved);
});

test('pure Amsterdam prefixes reset paid-write costs while retaining designation state',()=>{
  const inputs=inputsFixture(),start=prefix(),first=deriveAmsterdam(inputs,[auth(11155111n)],start);
  const second=deriveAmsterdam(inputs,[auth(11155111n,1n,D2)],first.snapshot);
  assert.equal(first.attempt.authorizationGasUsed,227790n);assert.equal(second.attempt.authorizationGasUsed,9000n);assert.equal(second.attempt.executionStateGasUsed,0n);
  const cleared=deriveAmsterdam(inputs,[auth(11155111n,1n,ZERO)],first.snapshot),third=deriveAmsterdam(inputs,[auth(11155111n,2n,D2)],cleared.snapshot);
  assert.equal(third.attempt.authorizationGasUsed,44190n);assert.equal(third.attempt.executionStateGasUsed,35190n);
  const incomplete=copy(inputs);delete incomplete.accounts[T];const r=request([auth(11155111n,1n,D2)]);
  // T's preceding storage row requires its verified fact; use a prefix without
  // that unrelated row when modeling a recipient whose fact is still missing.
  const partial=copy(first.snapshot);partial.accounts=partial.accounts.filter(x=>x.address!==T);
  assert.equal(deriveAmsterdamAuthorizationEntryGas({request:r,header,inputs:incomplete,common:amsterdamCommon,startingChanges:partial}),1000000n-ethereumCallGas('0x',amsterdamCommon,r).intrinsic-9000n);
});

test('pure Amsterdam authorization OOG restores the preceding authority state and keeps this outer nonce',()=>{
  const inputs=inputsFixture(),first=deriveAmsterdam(inputs,[auth(11155111n)],prefix()),saved=copy(first.snapshot);
  const r=request([auth(11155111n,1n,ZERO),auth(11155111n,0n,D,3)]);r.gas=(ethereumCallGas('0x',amsterdamCommon,r).intrinsic+10000n).toString();
  const failed=deriveAmsterdamAuthorizationPreparation({request:r,header,inputs,common:amsterdamCommon,startingChanges:first.snapshot});
  assert.deepEqual(failed.processing.entries.map(e=>e.status),['applied','out_of_gas']);assert.equal(failed.processing.preparation.phase,'authorization_out_of_gas');
  assert.equal(failed.attempt.accounts.get(A).current.nonce,2n);assert.equal(failed.accounts.get(A).current.nonce,1n);assert.equal(failed.accounts.get(A).current.code,'0xef0100'+D.slice(2));assert.equal(failed.applied.size,0);
  assert.deepEqual(row(failed,A),row(first,A));assert.deepEqual(row(failed,S).nonce,{before:'0x1',after:'0x4'});assert.deepEqual(first.snapshot,saved);
});

test('pure fee composition settles from preceding balances and preserves unrelated rows',()=>{
  const inputs=inputsFixture(),start=prefix(),initial=BigInt(inputs.accounts[S].balance);
  row(start,S).balance={before:hex(initial),after:hex(initial-100n)};start.accounts.push({address:C,balance:{before:'0x7',after:'0x11'}});
  const canonical=canonicalStateChanges(start),base=updateExecutionAccounts(inputs,canonical,[[S,{exists:true,nonce:3n}]]);
  const fees={sender:S,plan:{coinbase:C},accounting:{gasCharge:'30',coinbaseTip:'10'}};
  const settled={accounts:revertedFeeRows({baseRows:base.accounts,fees,inputs,startingChanges:canonical})};
  assert.equal(row(settled,S).balance.after,hex(initial-130n));assert.equal(row(settled,C).balance.after,'0x1b');assert.deepEqual(row(settled,T),row(start,T));assert.deepEqual(row(settled,N),row(start,N));
  const alias={accounts:revertedFeeRows({baseRows:base.accounts,fees:{...fees,plan:{coinbase:S}},inputs,startingChanges:canonical})};
  assert.equal(row(alias,S).balance.after,hex(initial-120n));assert.deepEqual(row(alias,C),row(start,C));
  const priced=deriveAmsterdam(inputs,[auth(11155111n)],canonical,{executionProfile:'unsigned_eip1559_block_end',fees:{maxFeePerGas:'100000000000',maxPriorityFeePerGas:'1'}});
  assert.equal(priced.accounts.get(S).starting.balance,initial-100n);assert.equal(priced.accounts.get(S).current.balance,initial-100n-priced.prepaidGasDebit);assert.deepEqual(row(priced,S).balance,row(start,S).balance);
});
