import fs from 'node:fs';import assert from 'node:assert/strict';import{performance}from'node:perf_hooks';
import {RLP}from'../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import{keccak_256}from'../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import{bytesToHex}from'../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import{executeEthereumCall}from'../../engines/local-evm/ethereum-call.js';
import{appliedResetRoot,bytes}from'../../engines/local-evm/test/sequential-reset-fixture.js';
import{createRpcStateInputs}from'../../engines/local-evm/rpc-state-inputs.js';import{createProofStateManager}from'../../engines/local-evm/proof-state.js';
import{fixtureAt,declaration}from'./cases.mjs';import{sha,json}from'./archive.mjs';
try{const[mode,inputPath,productPath]=process.argv.slice(2),input=json(inputPath),f=await fixtureAt(input.index);assert.deepEqual(declaration(f),input);
 if(mode==='product'){
  const records=[],rpc={async call(method,params,options){const row={id:records.length+1,method,params:structuredClone(params),status:'dispatched'},t=performance.now();records.push(row);try{row.result=structuredClone(await f.rpc.call(method,params,options));row.status='completed';return row.result;}catch(error){row.status='unavailable';row.error={name:error?.name??null,message:error?.message??String(error)};throw error;}finally{row.durationMs=performance.now()-t;}}};
  const inputs=createRpcStateInputs({chainId:1,blockHash:f.header.hash,header:f.header,rpc,limits:{calls:128,wallMs:15000}}),stateManager=createProofStateManager({inputs}),steps=[];let stopped=false;
  for(const request of f.requests){if(stopped){steps.push({status:'not_attempted',output:null,changes:null});continue;}const output=await executeEthereumCall({request,header:f.header,stateManager,limits:{wallMs:5000}});const completed=['success','reverted','failed'].includes(output.execution.status);steps.push({status:completed?'completed':'unavailable',output,changes:completed?stateManager.snapshotChanges():null});stopped=!completed;}
  console.log(JSON.stringify({id:f.id,steps,proofRecords:records,inputs:inputs.snapshotInputs(),inputEvidence:inputs.snapshotEvidence(),inputUsage:inputs.snapshotUsage(),scope:{execution:'actual_proof_backed_core_retained_manager',publicApiSequenceEndpoint:false,publicRpc:false,expectedPoststateUsed:false}}));
 }else if(mode==='expectation'){
  const raw=fs.readFileSync(productPath),seal=json(productPath+'.seal.json');assert.equal(raw.length,seal.bytes);assert.equal(sha(raw),seal.sha256);const phase=JSON.parse(raw),product=phase.result;assert.equal(phase.process.status,0);assert.equal(phase.process.signal,null);assert.equal(phase.process.error,null);assert.equal(product.id,input.id);assert.equal(product.steps.length,input.requests.length);const logs=[];let gas=0n;
  const steps=[];for(const step of product.steps){if(step.status!=='completed'){steps.push({status:'unavailable'});continue;}logs.push(...step.output.logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]));gas+=BigInt(step.output.gasAccounting.gasUsed);steps.push({status:'derived',stateRoot:await appliedResetRoot(f,step.changes),logsHash:bytesToHex(keccak_256(RLP.encode(logs))),gasUsed:step.output.gasAccounting.gasUsed,cumulativeGasUsed:gas.toString(),execution:step.output.execution,request:input.requests[steps.length]});}
  console.log(JSON.stringify({id:f.id,productSha256:seal.sha256,steps,scope:{thirdMptOnly:true,fullVMExecuted:false,expectedFromProductDeltas:true}}));
 }else throw Error('Unknown worker mode');
}catch(error){console.log(JSON.stringify({status:'unavailable',error:{name:error?.name??null,message:error?.message??String(error)}}));process.exitCode=1;}
