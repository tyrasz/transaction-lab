import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeRevert} from '../src/revert.js';
const word = value => BigInt(value).toString(16).padStart(64,'0');
function errorString(value) {
  const bytes=Buffer.from(value);
  return '0x08c379a0'+word(32)+word(bytes.length)+bytes.toString('hex').padEnd(Math.ceil(bytes.length/32)*64,'0');
}
test('decodes the live insufficient-balance revert and preserves attribution',()=>{
  assert.deepEqual(decodeRevert(errorString('ERC20: transfer amount exceeds balance')),{selector:'0x08c379a0',source:'contract_return_data',kind:'error_string',message:'ERC20: transfer amount exceeds balance'});
});
test('decodes UTF-8 strings and empty Error strings without guessing a diagnosis',()=>{
  assert.equal(decodeRevert(errorString('拒否')).message,'拒否');
  assert.equal(decodeRevert(errorString('')).message,'');
});
test('rejects truncated, oversized, misaligned and invalid UTF-8 standard errors',()=>{
  for(const data of [errorString('balance').slice(0,-2),'0x08c379a0'+word(64)+word(0),'0x08c379a0'+word(32)+word(2**30),'0x08c379a0'+word(32)+word(1)+'ff'.padEnd(64,'0'),errorString('A').slice(0,-2)+'01']) assert.equal(decodeRevert(data).kind,'malformed');
});
test('interprets known panic codes, preserving unknown codes exactly',()=>{
  assert.equal(decodeRevert('0x4e487b71'+word(0x11)).message,'Arithmetic overflow or underflow.');
  assert.equal(decodeRevert('0x4e487b71'+word(0x999)).code,'0x999');
  assert.equal(decodeRevert('0x4e487b71').kind,'malformed');
});
test('does not invent custom error names or decode invalid hex',()=>{
  assert.equal(decodeRevert('0xdeadbeef'+word(100)).kind,'custom_error');
  for(const data of ['0x','0x123','0xnotreally',null]) assert.equal(decodeRevert(data),null);
});
test('removes display control characters while raw bytes remain with the trace',()=>{
  assert.equal(decodeRevert(errorString('not\u202esafe\u0000')).message,'notsafe');
});
