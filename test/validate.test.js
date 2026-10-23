import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSimulation, validateReplay } from '../src/validate.js';
import { EXAMPLES } from '../src/config.js';

const request=EXAMPLES[0].request;
test('preserves uint256 values without floating point conversion',()=>{
  const max=((1n<<256n)-1n).toString();
  assert.equal(validateSimulation({...request,value:max}).value,max);
  assert.throws(()=>validateSimulation({...request,value:(1n<<256n).toString()}),/uint256/);
  assert.throws(()=>validateSimulation({...request,value:1}),/string/);
});
test('rejects unsupported chains, malformed addresses and malformed calldata',()=>{
  for(const input of [{...request,chainId:1},{...request,from:'0x123'},{...request,data:'0x123'},{...request,data:'0xzz'},{...request,value:'-1'}]) assert.throws(()=>validateSimulation(input));
});
test('does not accept arbitrary provider or JSON RPC commands from callers',()=>{
  for(const key of ['rpcUrl','method','privateKey','stateOverrides']) assert.throws(()=>validateSimulation({...request,[key]:'anything'}),/Unsupported request field/);
});
test('supports explicit block numbers and rejects unbounded block values',()=>{
  assert.equal(validateSimulation({...request,block:'0x123'}).block,'0x123');
  for(const block of ['pending','0x','0x01','0x'+'f'.repeat(100),123]) assert.throws(()=>validateSimulation({...request,block}));
});
test('historical requests require a full transaction hash',()=>{
  assert.equal(validateReplay({chainId:999,transactionHash:EXAMPLES[0].transactionHash}).transactionHash,EXAMPLES[0].transactionHash);
  assert.throws(()=>validateReplay({chainId:999,transactionHash:'0x123'}));
});
