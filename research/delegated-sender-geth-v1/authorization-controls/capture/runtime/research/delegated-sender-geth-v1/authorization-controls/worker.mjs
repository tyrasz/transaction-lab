import fs from 'node:fs';
import assert from 'node:assert/strict';
import { bytesToHex } from '../../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { executeIsolatedEthereumCall } from '../../../engines/local-evm/isolated-call.js';
import { fullVMReference, appliedRoot } from '../../../engines/local-evm/test/authorization-fixture.js';
import { fixtureAt, initial } from './cases.mjs';
import { signedBytes } from './run.mjs';
const [mode,inputPath,productPath]=process.argv.slice(2);
try {
  assert(['product','reference'].includes(mode));const input=JSON.parse(fs.readFileSync(inputPath)),f=await fixtureAt(input.index);assert.deepEqual({...initial(f,input.index),signedTransaction:signedBytes(f)},input);
  if(mode==='product'){
    const attempt=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc,limits:{wallMs:10000,drainMs:1000}});
    console.log(JSON.stringify({status:'completed',attempt,requests:f.calls}));
  }else{
    // Reference execution consumes only the initial allocation/request/header.
    const ref=await fullVMReference(f),result=await ref.run(),stateRoot=bytesToHex(await ref.state.getStateRoot());
    const logs=result.execResult.logs??[],output={stateRoot,logsHash:bytesToHex(keccak_256(RLP.encode(logs))),logs:logs.map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})),execution:result.execResult.exceptionError?.error??'success',returnData:bytesToHex(result.execResult.returnValue),executionGasUsed:result.execResult.executionGasUsed.toString(),gasUsed:result.totalGasSpent.toString(),gasRefundCounter:(result.gasRefund??0n).toString()};
    // Only a third, fresh MPT receives product deltas, after reference execution.
    const product=JSON.parse(fs.readFileSync(productPath)).result?.attempt;let productAppliedStateRoot=null,productApplicationError=null;
    if(product?.status==='completed'&&product.changes)try{productAppliedStateRoot=await appliedRoot(f,product.changes);}catch(e){productApplicationError=String(e.message);}
    console.log(JSON.stringify({status:'completed',fullVM:output,productAppliedStateRoot,productApplicationError}));
  }
}catch(error){console.log(JSON.stringify({status:'unavailable',error:{name:error.name,message:String(error.message)}}));process.exitCode=1;}
