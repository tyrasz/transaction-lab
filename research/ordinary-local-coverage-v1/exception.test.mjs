// Pure classifier controls. No VM, transport, capture or saved-packet edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorClass } from './outcomes.mjs';

test('exception classifier accepts only the exact added Geth INVALID spelling',()=>{
  const expected={status:'failed',exception:'invalid_opcode'};
  for(const local of[false,true]){
    assert.deepEqual(errorClass('invalid opcode: INVALID',local),expected);
    assert.deepEqual(errorClass('invalid opcode',local),expected);
    assert.deepEqual(errorClass('invalid opcode: opcode 0xab not defined',local),expected);
  }
});

test('exception classifier leaves unknown, malformed and near-match spellings unavailable',()=>{
  for(const error of['invalid opcode: invalid','Invalid opcode: INVALID','INVALID OPCODE: INVALID',
    'invalid opcode:  INVALID','invalid opcode:INVALID','invalid opcode: INVALID ',
    ' invalid opcode: INVALID','invalid opcode: INVALID\n','invalid opcode: INVALID\r\n',
    'invalid opcode: INVALID extra','invalid opcode: INVALID (operand: 0x00)',
    'invalid opcode: ADD','invalid opcode: 0xfe','invalid opcode: opcode 0xFE not defined',
    'invalid opcode:','invalid opcode: INVALID\0','',undefined,0,false,{},[]]){
    assert.throws(()=>errorClass(error),/Unrecognized actual EVM exception/);
  }
});

test('existing success, revert and unrelated failure classifications are preserved',()=>{
  assert.deepEqual(errorClass(null),{status:'success',exception:null});
  assert.deepEqual(errorClass('revert',true),{status:'reverted',exception:'revert'});
  assert.deepEqual(errorClass('execution reverted'),{status:'reverted',exception:'revert'});
  assert.throws(()=>errorClass('revert'));assert.throws(()=>errorClass('execution reverted',true));
  assert.deepEqual(errorClass('out of gas'),{status:'failed',exception:'out_of_gas'});
  assert.deepEqual(errorClass('stack underflow (0 <=> 1)'),{status:'failed',exception:'stack_underflow'});
});
