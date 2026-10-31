// Input-only preparation returns before importing or invoking an executor.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {declaration,fixture} from './cases.mjs';
import {normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';

assert([4,5].includes(process.argv.length));
assert(process.argv.length===4||process.argv[4]==='--prepare-only');
const encoded=fs.readFileSync(process.argv[2]);assert(encoded.length<=128*1024);
const input=JSON.parse(encoded),hash=createHash('sha256').update(encoded).digest('hex');
assert.equal(hash,process.argv[3]);assert.deepEqual(input,await declaration(input.index));
const f=await fixture(input.index);
assert.deepEqual(f.requests,input.steps.map(s=>s.request));assert.deepEqual(f.header,input.header);
assert.deepEqual(normalizeAllocation(f.allocation),input.allocation);
const report={id:input.id,inputSha256:hash,workerPid:process.pid,
  scope:'frozen_four_case_unsigned_product_sequence',expectedPoststateConsumed:false,otherClientOutputsConsumed:false};
if(process.argv[4]==='--prepare-only')console.log(JSON.stringify({...report,status:'prepared_no_execution',executionInvoked:false}));
else{
  const {executeIsolatedEthereumSequence}=await import('../../engines/local-evm/isolated-call.js');
  const proofRecords=[],rpc={async call(method,params,options){
    const row={method,params:structuredClone(params)};proofRecords.push(row);
    try{row.result=await f.rpc.call(method,params,options);return structuredClone(row.result);}
    catch(error){row.error={name:error.name,message:error.message};throw error;}
  }};
  const limits={wallMs:11000,requestMs:1000,drainMs:1000,killWaitMs:500,
    inputs:{wallMs:9500},execution:{wallMs:9500}};
  const attempt=await executeIsolatedEthereumSequence({requests:f.requests,header:input.header,
    chainId:input.chainId,rpc,queries:input.productQueries,limits});
  console.log(JSON.stringify({...report,status:'completed',attempt,proofRecords,
    processClosureValid:attempt.broker.pendingAtReturn===0&&attempt.isolation?.processClosed===true}));
}
