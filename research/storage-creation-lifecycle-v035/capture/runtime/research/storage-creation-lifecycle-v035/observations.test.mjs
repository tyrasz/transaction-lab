// Pure projection controls. No EVM, reference process or network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {neutralExceptSenderNonce,comparePreview} from './observations.mjs';
const S='0x'+'11'.repeat(20),T='0x'+'22'.repeat(20),slot='0x'+'00'.repeat(32),value='0x'+'00'.repeat(31)+'01';
const account=(nonce=0)=>({nonce:'0x'+nonce.toString(16),balance:'0x11',code:'0x',storage:{}});
const initial=()=>({[S]:account(1),[T]:{...account(),storage:{[slot]:value}}});
test('neutral reference classification permits only the fresh outer sender nonce increment',()=>{
  const a=initial(),b=structuredClone(a);b[S].nonce='0x2';assert(neutralExceptSenderNonce(a,b,S,[]));
  assert.equal(a[S].nonce,'0x1');assert.equal(b[S].nonce,'0x2');
  b[S].nonce='0x3';assert.equal(neutralExceptSenderNonce(a,b,S,[]),false);
});
test('clear, delete, transfer, code change, and committed logs cannot pass reference neutrality',()=>{
  for(const change of[b=>{b[T].storage={};},b=>{delete b[T];},b=>{b[T].balance='0x12';},b=>{b[T].code='0x00';}]){
    const a=initial(),b=structuredClone(a);b[S].nonce='0x2';change(b);assert.equal(neutralExceptSenderNonce(a,b,S,[]),false);
  }
  const a=initial(),b=structuredClone(a);b[S].nonce='0x2';assert.equal(neutralExceptSenderNonce(a,b,S,[{address:T,topics:[],data:'0x'}]),false);
});
const observation=(kind='contract_call')=>({queries:[{index:0,kind,measurementStatus:'unavailable',values:null,before:{executionStatus:'success',returnData:'0x'+'00'.repeat(32),chargedGas:'21000',singleTransactionBlockGasUsed:'21000',logs:[],inputStateRoot:'a',stateRoot:'b',neutralExceptSenderNonce:false,targetSelfdestructObserved:false},after:null}]});
test('correct refusal matches admission while missing query values and skipped halves remain null',()=>{
  const a=observation(),b=structuredClone(a);b.queries[0].after=structuredClone(b.queries[0].before);
  const c=comparePreview(a,b)[0].channels;assert.equal(c.admission,true);assert.equal(c.values,null);assert.equal(c['before.executionStatus'],true);assert.equal(c['after.executionStatus'],null);
});
test('false success and different observed query state retain explicit mismatches',()=>{
  const a=observation(),b=structuredClone(a);a.queries[0].measurementStatus='measured';a.queries[0].before.stateRoot='wrong';
  const c=comparePreview(a,b)[0].channels;assert.equal(c.admission,false);assert.equal(c['before.stateRoot'],false);
});
test('native balances compare independently of getter availability',()=>{
  const a={queries:[{index:0,kind:'native_balance',measurementStatus:'measured',values:{beforeRaw:'17',afterRaw:'22',deltaRaw:'5'},before:{balance:'17',inputStateRoot:'a'},after:{balance:'22',inputStateRoot:'b'}}]},b=structuredClone(a);
  assert(Object.values(comparePreview(a,b)[0].channels).every(v=>v===true));b.queries[0].after.balance='21';assert.equal(comparePreview(a,b)[0].channels['after.balance'],false);
});
