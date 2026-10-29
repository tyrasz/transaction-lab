import fs from 'node:fs';
import assert from 'node:assert/strict';
import { declaration, fixture, PRODUCT_LIMITS } from './cases.mjs';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { appliedRoot } from '../../engines/local-evm/test/authorization-fixture.js';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
const input=JSON.parse(fs.readFileSync(process.argv[2]));
assert.deepEqual(input,await declaration(input.index));
const f=await fixture(input.index),proofRecords=[],rpc={async call(method,params,options){
  const record={method,params:structuredClone(params)};proofRecords.push(record);
  try{record.result=await f.rpc.call(method,params,options);return structuredClone(record.result);}
  catch(error){record.error={name:error.name,message:error.message};throw error;}
}};
assert.deepEqual(f.request,input.request);assert.deepEqual(f.header,input.header);assert.deepEqual(f.allocation,input.allocation);
const attempt=await executeIsolatedEthereumCall({request:input.request,header:input.header,rpc,chainId:input.chainId,limits:PRODUCT_LIMITS});
let comparisonInput=null,projectionError=null;
const processClosureValid=attempt.broker.pendingAtReturn===0&&(attempt.isolation===null?attempt.broker.calls===0:attempt.isolation.processClosed===true);
try { if(attempt.status==='completed'&&processClosureValid){
  const output=attempt.output,logs=output.logs.map(({address,topics,data})=>[hexToBytes(address),topics.map(hexToBytes),hexToBytes(data)]);
  assert(['success','reverted','failed'].includes(output.execution.status));
  const stateRoot=await appliedRoot(f,attempt.changes,f.common);
  comparisonInput={id:input.id,transactionHash:input.transactionHash,initialStateRoot:input.initialStateRoot,stateRoot,
    logs:output.logs,execution:{...output.execution,logsHash:bytesToHex(keccak_256(RLP.encode(logs)))},receipt:{status:output.execution.status==='success'?1:0},
    gas:{totalGasSpent:output.gasAccounting.gasUsed,txRegularGas:output.stateGasAccounting.settled.regularGasUsed,txStateGas:output.stateGasAccounting.settled.stateGasUsed}};
}} catch(error){projectionError={name:error.name,message:error.message};}
console.log(JSON.stringify({id:input.id,attempt,proofRecords,comparisonInput,projectionError,processClosureValid,scope:{isolatedParentValidated:true,fullVmExecuted:false,expectedPoststateConsumed:false,gethResultsConsumed:false}}));
