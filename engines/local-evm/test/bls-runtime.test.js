import test from 'node:test';
import assert from 'node:assert/strict';
import { EVMError } from '@ethereumjs/evm';
import { BlsInputError, createGuardedBls, guardBlsOperations } from '../bls-runtime.js';

test('BLS invalid public data stays an EVM error and still checks both budget boundaries', () => {
  for (const [method, input] of [['addG1',new Uint8Array(255)], ['msmG1',new Uint8Array()],
    ['mapFPtoG1',new Uint8Array(64).fill(255)], ['addG1',Uint8Array.from([...new Uint8Array(127),1,...new Uint8Array(128)])]]) {
    const failures=[]; let checks=0;
    const runtime=createGuardedBls(()=>checks++,error=>failures.push(error));
    assert.throws(()=>runtime[method](input),error=>error instanceof BlsInputError&&error instanceof EVMError,method);
    assert.equal(checks,2);assert.deepEqual(failures,[]);
  }
});

test('BLS subgroup rule applies to MSM with zero scalar but not addition', () => {
  // (0,2) satisfies y²=x³+4 and has order3, outside the prime-order subgroup.
  const point=new Uint8Array(128);point[127]=2;
  const runtime=createGuardedBls(()=>{},()=>assert.fail('Unexpected host failure'));
  assert.deepEqual(runtime.addG1(Uint8Array.from([...point,...new Uint8Array(128)])),point);
  assert.throws(()=>runtime.msmG1(Uint8Array.from([...point,...new Uint8Array(32)])),BlsInputError);
  assert.throws(()=>runtime.pairingCheck(Uint8Array.from([...point,...new Uint8Array(256)])),BlsInputError);
});

test('BLS zero operands preserve infinity and the neutral pairing result', () => {
  const runtime=createGuardedBls(()=>{},()=>assert.fail('Unexpected host failure'));
  for(const [method,length,width] of [['addG1',256,128],['addG2',512,256],['msmG1',160,128],['msmG2',288,256]])
    assert.deepEqual(runtime[method](new Uint8Array(length)),new Uint8Array(width));
  const one=new Uint8Array(32);one[31]=1;
  assert.deepEqual(runtime.pairingCheck(new Uint8Array(384)),one);
});

test('BLS never treats unexpected thrown values or malformed results as EVM rejection', () => {
  for(const thrown of [new Error('private host marker'),new EVMError(EVMError.errorMessages.REVERT),null,undefined,'host']) {
    const failures=[],runtime=guardBlsOperations({addG1(){throw thrown;}},()=>{},error=>failures.push(error));
    let caught=false;try{runtime.addG1(new Uint8Array(256));}catch(error){caught=true;assert.equal(error,thrown);}
    assert(caught);assert.deepEqual(failures,[thrown]);
  }
  for(const result of [undefined,null,new Uint8Array(127),Promise.resolve(new Uint8Array(128))]) {
    const failures=[],runtime=guardBlsOperations({addG1:()=>result},()=>{},error=>failures.push(error));
    assert.throws(()=>runtime.addG1(new Uint8Array(256)),/invalid byte result/);assert.equal(failures.length,1);
  }
});

test('BLS deadline failures latch before/after success and after malformed input', () => {
  for(const phase of [1,2])for(const invalid of [false,true]) {
    let checks=0,calls=0;const failures=[],failure=new Error('deadline');
    const runtime=guardBlsOperations({addG1(){calls++;if(invalid)throw new BlsInputError(EVMError.errorMessages.BLS_12_381_POINT_NOT_ON_CURVE);return new Uint8Array(128);}},
      ()=>{if(++checks===phase)throw failure;},error=>failures.push(error));
    assert.throws(()=>runtime.addG1(new Uint8Array(256)),error=>error===failure);
    assert.equal(calls,phase-1);assert.deepEqual(failures,[failure]);
  }
});
