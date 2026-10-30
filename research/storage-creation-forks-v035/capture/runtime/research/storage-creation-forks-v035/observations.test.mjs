// Pure saved-output adapter controls. Hypothetical reports are not executions
// or predictions; these tests do not invoke any declared EVM target.
import test from 'node:test';
import assert from 'node:assert/strict';
import {declaration} from './cases.mjs';
import {productObservation} from './observations.mjs';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
let prepared;
const inputs=()=>prepared??=Promise.all(Array.from({length:8},(_,i)=>declaration(i)));
function report(input,gasAccounting){return{id:input.id,status:'completed',attempt:{status:'completed',changes:{scope:SCOPE,accounts:[]},output:{
  execution:{status:'success',returnData:'0x'},gasAccounting,logs:[],
}}};}
const historicalGas=()=>({beforeRefund:'30000',appliedRefund:'6000',floorAdjustment:'1000',gasUsed:'25000'});

test('all six historical declarations use charged gas as the single-transaction block contribution',async()=>{
  for(const input of(await inputs()).slice(0,6)){
    assert.notEqual(input.fork,'Amsterdam');const raw=report(input,historicalGas()),saved=structuredClone(raw);
    const out=await productObservation(input,raw);
    assert.equal(out.chargedGas,'25000');assert.equal(out.singleTransactionBlockGasUsed,'25000');
    assert.equal(out.stateRoot,input.initialStateRoot);assert.deepEqual(raw,saved);
  }
});

test('historical block contribution never uses a supplied Amsterdam-only property',async()=>{
  const input=(await inputs())[0],out=await productObservation(input,report(input,{...historicalGas(),singleTransactionBlockGasUsed:'40000'}));
  assert.equal(out.chargedGas,'25000');assert.equal(out.singleTransactionBlockGasUsed,'25000');
});

test('both Amsterdam declarations retain the dedicated block contribution independently of charged gas',async()=>{
  for(const input of(await inputs()).slice(6)){
    assert.equal(input.fork,'Amsterdam');const raw=report(input,{gasUsed:'25000',singleTransactionBlockGasUsed:'40000'}),saved=structuredClone(raw);
    const out=await productObservation(input,raw);
    assert.equal(out.chargedGas,'25000');assert.equal(out.singleTransactionBlockGasUsed,'40000');
    assert.notEqual(out.chargedGas,out.singleTransactionBlockGasUsed);assert.deepEqual(raw,saved);
  }
});

test('Amsterdam refuses missing dedicated block gas instead of falling back to charged gas',async()=>{
  const input=(await inputs())[6];await assert.rejects(productObservation(input,report(input,{gasUsed:'25000'})));
});

test('all forks reject noncanonical, non-string and out-of-range charged gas',async()=>{
  const declarations=await inputs();
  for(const input of[declarations[0],declarations[6]])for(const bad of[undefined,null,25000,NaN,Infinity,'','-1','+1','01','1.0','1e3','0x1',' 1','1 ',String(BigInt(input.request.gas)+1n)]){
    await assert.rejects(productObservation(input,report(input,{gasUsed:bad,...(input.fork==='Amsterdam'?{singleTransactionBlockGasUsed:'40000'}:{})})));
  }
});

test('Amsterdam rejects malformed or out-of-range dedicated block gas independently',async()=>{
  const input=(await inputs())[7];for(const bad of[undefined,null,40000,NaN,Infinity,'','-1','+1','01','1.0','1e3','0x1',' 1','1 ',String(BigInt(input.request.gas)+1n)]){
    await assert.rejects(productObservation(input,report(input,{gasUsed:'25000',singleTransactionBlockGasUsed:bad})));
  }
});

test('canonical zero and exact gas-limit values remain valid in both projected channels',async()=>{
  const declarations=await inputs();for(const input of[declarations[0],declarations[6]])for(const value of['0',input.request.gas]){
    const out=await productObservation(input,report(input,{gasUsed:value,...(input.fork==='Amsterdam'?{singleTransactionBlockGasUsed:value}:{})}));
    assert.equal(out.chargedGas,value);assert.equal(out.singleTransactionBlockGasUsed,value);
  }
});
