import test from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex } from '@ethereumjs/util';
import { createP256Precompile, _createP256Precompile, P256_ADDRESS, P256_GAS } from '../p256-runtime.js';
const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P=0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const word=n=>Uint8Array.from(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));
const hash=word(42n),key=word(7n),publicKey=p256.getPublicKey(key,false),signature=p256.sign(hash,key,{lowS:false,prehash:false});
const valid=Uint8Array.from([...hash,...signature,...publicKey.subarray(1)]),success='0x'+'00'.repeat(31)+'01';
const replace=(data,i,v)=>{const copy=new Uint8Array(data);copy.set(word(v),i*32);return copy;};
const bigint=b=>BigInt('0x'+Buffer.from(b).toString('hex'));
const factory=()=>{let checks=0;const failures=[];return {failures,precompile:createP256Precompile(()=>checks++,e=>failures.push(e)),checks:()=>checks};};

test('P256 fixed verifier accepts low/high-S signatures, zero/max message hash, and returns detached results',()=>{
  assert.equal(P256_ADDRESS,'0x0000000000000000000000000000000000000100');assert.equal(P256_GAS,6900n);
  for(const h of [0n,42n,(1n<<256n)-1n]){
    const msg=word(h),sig=p256.sign(msg,key,{lowS:false,prehash:false}),input=Uint8Array.from([...msg,...sig,...publicKey.subarray(1)]);
    for(const data of [input,replace(input,2,N-bigint(sig.subarray(32)))]){
      const f=factory(),result=f.precompile({data,gasLimit:6900n});assert.equal(bytesToHex(result.returnValue),success);assert.equal(result.executionGasUsed,6900n);assert.equal(result.exceptionError,undefined);assert.equal(f.checks(),2);assert.deepEqual(f.failures,[]);
      result.returnValue[31]=0;assert.equal(bytesToHex(f.precompile({data,gasLimit:6900n}).returnValue),success);
    }
  }
});

test('P256 invalid encodings and incorrect signatures return empty at6900 without host failure',()=>{
  const offCurve=replace(valid,4,bigint(valid.subarray(128))+1n);
  const cases=[new Uint8Array(),valid.subarray(0,159),Uint8Array.from([...valid,0]),replace(valid,1,0n),replace(valid,2,0n),replace(valid,1,N),replace(valid,2,N),replace(valid,3,P),replace(valid,4,P),replace(replace(valid,3,0n),4,0n),offCurve,replace(valid,0,43n)];
  for(const data of cases){const f=factory(),o=f.precompile({data,gasLimit:10000n});assert.equal(o.executionGasUsed,6900n);assert.equal(bytesToHex(o.returnValue),'0x');assert.equal(o.exceptionError,undefined);assert.deepEqual(f.failures,[]);}
});

test('P256 OOG precedes input decoding and cryptography',()=>{
  for(const data of [valid,new Uint8Array()])for(const gasLimit of [0n,6899n]){
    let called=false;const errors=[];const p=_createP256Precompile({verify(){called=true;return true;},checkBudget(){},onHostFailure:e=>errors.push(e)}),o=p({data,gasLimit});
    assert.equal(o.executionGasUsed,gasLimit);assert.equal(o.exceptionError.error,'out of gas');assert.equal(o.returnValue.length,0);assert.equal(called,false);assert.deepEqual(errors,[]);
  }
});

test('P256 internal hook latches all crypto throws and invalid return types instead of calling them invalid signatures',()=>{
  for(const error of [Error('host'),null,undefined,'host']){
    const failures=[],p=_createP256Precompile({verify(){throw error;},checkBudget(){},onHostFailure:e=>failures.push(e)});let threw=false;
    try{p({data:valid,gasLimit:6900n});}catch(e){threw=true;assert.equal(e,error);}assert(threw);assert.equal(failures.length,1);assert.equal(failures[0],error);
  }
  for(const value of [undefined,null,0,1,'true',Promise.resolve(true)]){
    const failures=[],p=_createP256Precompile({verify:()=>value,checkBudget(){},onHostFailure:e=>failures.push(e)});
    assert.throws(()=>p({data:valid,gasLimit:6900n}),/non-boolean/);assert.equal(failures.length,1);
  }
});

test('P256 budget failure before/after crypto is latched, including thrown undefined/null',()=>{
  for(const at of [1,2])for(const error of [Error('deadline'),null,undefined]){
    let calls=0,checks=0;const failures=[],p=_createP256Precompile({verify(){calls++;return true;},checkBudget(){if(++checks===at)throw error;},onHostFailure:e=>failures.push(e)});let threw=false;
    try{p({data:valid,gasLimit:6900n});}catch(e){threw=true;assert.equal(e,error);}assert(threw);assert.equal(checks,at);assert.equal(calls,at-1);assert.equal(failures.length,1);assert.equal(failures[0],error);
  }
});
