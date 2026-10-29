import fs from 'node:fs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {bytesToHex} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {executeIsolatedEthereumPreview} from '../../engines/local-evm/isolated-call.js';
import {feeFullVM,feeCommon,appliedRoot,balance,account} from '../../engines/local-evm/test/fee-fixture.js';
import {blobFeeFullVM} from '../../engines/local-evm/test/blob-fee-fixture.js';
import {fixtureAt,declaration} from './cases.mjs';
import {readSealedProduct} from './run.mjs';
const tagged=value=>typeof value==='bigint'?{$bigint:value.toString()}:value instanceof Uint8Array?{$bytes:bytesToHex(value)}:Array.isArray(value)?value.map(tagged):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,tagged(v)])):value;
try{
 const [mode,inputPath,productPath]=process.argv.slice(2),input=JSON.parse(fs.readFileSync(inputPath)),f=await fixtureAt(input.index);assert.deepEqual(declaration(f),input);assert(['product','reference'].includes(mode));
 if(mode==='product'){
  const records=[],rpc={async call(method,params,options){const row={id:records.length+1,method,params:structuredClone(params),status:'dispatched'},start=performance.now();records.push(row);try{const result=await f.rpc.call(method,params,options);row.result=structuredClone(result);row.status='completed';return result;}catch(error){row.error={name:error?.name??null,message:error?.message??String(error)};row.status='unavailable';throw error;}finally{row.durationMs=performance.now()-start;}}};
  const attempt=await executeIsolatedEthereumPreview({request:f.request,header:f.header,queries:f.queries,rpc,limits:{wallMs:10000,drainMs:1000,calls:64}});
  console.log(JSON.stringify({id:f.id,attempt,proofRecords:records,scope:{publicRpc:false,expectedOutputsUsed:false}}));
 }else{
  const ref=await(f.request.executionProfile==='unsigned_eip4844_block_end'?blobFeeFullVM:feeFullVM)(f),{tx,result}=await ref.run();assert.equal(bytesToHex(tx.serialize()),input.signedCounterpart);
  const error=result.execResult.exceptionError?.error??null,logs=(result.execResult.logs??[]).map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)}));
  const output={execution:{status:error==='revert'?'reverted':error?'failed':'success',error,returnData:bytesToHex(result.execResult.returnValue),executionGasUsed:result.execResult.executionGasUsed.toString(),gasRefundCounter:(result.execResult.gasRefund??0n).toString()},gasUsed:result.totalGasSpent.toString(),logs,stateRoot:bytesToHex(await ref.state.getStateRoot()),receipt:tagged(result.receipt),rawGasFields:tagged(Object.fromEntries(['totalGasSpent','gasRefund','blobGasUsed','amountSpent','minerValue'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]))),accounts:await Promise.all(f.queries.map(async q=>{const a=await account(ref.state,q.account);return{account:q.account,exists:a!==undefined,nonce:(a?.nonce??0n).toString(),balance:(await balance(ref.state,q.account)).toString()};}))};
  // The fullVM above receives only initial allocation/request/header. Only a
  // third fresh MPT below receives the already sealed product delta rows.
  const product=readSealedProduct(productPath),changes=product.attempt?.preview?.original?.changes;let productAppliedStateRoot=null,productApplicationError=null;
  if(changes)try{productAppliedStateRoot=await appliedRoot(f,changes,feeCommon(f));}catch(error){productApplicationError={name:error.name,message:error.message};}
  console.log(JSON.stringify({id:f.id,output,signedCounterpart:bytesToHex(tx.serialize()),productAppliedStateRoot,productApplicationError,scope:{sharedEthereumJS:true,independentClient:false,referenceInputProductOutputs:false,receiptEncoding:'BigInts and bytes tagged losslessly; internal VM runState is not serialized'}}));
 }
}catch(error){console.log(JSON.stringify({status:'unavailable',error:{name:error?.name??null,message:error?.message??String(error)}}));process.exitCode=1;}
