import fs from 'node:fs';
import assert from 'node:assert/strict';
import {declaration,fixture,PRODUCT_LIMITS} from '../amsterdam-storage-creation-v033/capture/runtime/research/amsterdam-storage-creation-v033/cases.mjs';
import {allocationRoot,applyDelta,targetObservation,behavior,normalizeAllocation,bytes,hex,word,q} from '../amsterdam-storage-creation-v033/capture/runtime/research/amsterdam-storage-creation-v033/observations.mjs';
import {executeIsolatedEthereumCall} from '../amsterdam-storage-creation-v033/capture/runtime/engines/local-evm/isolated-call.js';
import {createTxFromRLP} from '../amsterdam-storage-creation-v033/capture/runtime/engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {createVM,runTx} from '../amsterdam-storage-creation-v033/capture/runtime/engines/fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import {createAddressFromString} from '../amsterdam-storage-creation-v033/capture/runtime/engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {loadState} from '../amsterdam-storage-creation-v033/capture/runtime/engines/fixture-evm/state-test.js';
const input=JSON.parse(fs.readFileSync(process.argv[3])),mode=process.argv[2];assert(['product','ethereumjs'].includes(mode));
assert.deepEqual(input,JSON.parse(JSON.stringify(await declaration(input.index))));const f=await fixture(input.index);
assert.deepEqual(f.request,input.request);assert.deepEqual(f.header,input.header);assert.deepEqual(normalizeAllocation(f.allocation),input.allocation);
const report={id:input.id,mode,observation:null,withheldState:null,error:null,attempt:null,proofRecords:[],rawResult:null,
 scope:{expectedPoststateConsumed:false,otherClientOutputsConsumed:false,sharedEthereumJsRuntime:mode==='ethereumjs'}};
function observation(allocation,execution){const target=targetObservation(input,allocation);return{completedExecution:true,...execution,allocation,target,targetBehavior:behavior(input,target)};}
try{
 if(mode==='product'){
  const rpc={async call(method,params,options){const row={method,params:structuredClone(params)};report.proofRecords.push(row);try{row.result=await f.rpc.call(method,params,options);return structuredClone(row.result);}catch(error){row.error={name:error?.name??null,message:error?.message??String(error)};throw error;}}};
  const a=report.attempt=await executeIsolatedEthereumCall({request:input.request,header:input.header,chainId:11155111,rpc,limits:PRODUCT_LIMITS});
  report.processClosureValid=a.broker.pendingAtReturn===0&&(a.isolation===null?a.broker.calls===0:a.isolation.processClosed===true);
  if(a.status==='completed'&&report.processClosureValid){const allocation=applyDelta(input.allocation,a.changes),o=a.output;
   if(['success','reverted','failed'].includes(o.execution.status)){
    assert(o.gasAccounting);report.observation=observation(allocation,{stateRoot:await allocationRoot(allocation),executionStatus:o.execution.status,executionError:o.execution.error,returnData:o.execution.returnData,
     gasUsed:o.gasAccounting.gasUsed,executionGasUsed:o.execution.executionGasUsed,preRefundGasWithFloor:o.gasAccounting.preRefundGasWithFloor,
     singleTransactionBlockGasUsed:o.gasAccounting.singleTransactionBlockGasUsed,regularGasUsed:o.gasAccounting.regularGasUsed,stateGasUsed:o.gasAccounting.stateGasUsed,logs:o.logs});
   }else report.withheldState={scope:'rolled_back_product_attempt_not_execution_prediction',executionStatus:o.execution.status,stateDisposition:o.stateDisposition,
    rollbackStateRoot:await allocationRoot(allocation),target:targetObservation(input,allocation),gasAccounting:o.gasAccounting??null};
  }
 }else{
  const state=await loadState(input.allocation,f.common);assert.equal(hex(await state.getStateRoot()),input.initialStateRoot);
  const tx=createTxFromRLP(bytes(input.signedBytes),{common:f.common});assert(tx.verifySignature());assert.equal(hex(tx.hash()),input.transactionHash);
  const vm=await createVM({common:f.common,stateManager:state,blockchain:{async getBlock(){throw Error('No diagnostic ancestry supplied');},shallowCopy(){return this;}}});
  const result=await runTx(vm,{tx,block:f.block}),error=result.execResult.exceptionError?.error??null;
  // Serialize actual result fields, never invoke another transaction/getter.
  report.rawResult={transactionHash:hex(tx.hash()),execResult:{returnValue:hex(result.execResult.returnValue),executionGasUsed:result.execResult.executionGasUsed.toString(),
    exceptionError:error,gasRefund:(result.execResult.gasRefund??0n).toString(),logs:(result.execResult.logs??[]).map(([a,t,d])=>({address:hex(a),topics:t.map(hex),data:hex(d)}))},
    totalGasSpent:result.totalGasSpent.toString(),blockGasSpent:result.blockGasSpent.toString(),txRegularGas:result.txRegularGas.toString(),txStateGas:result.txStateGas.toString(),
    receipt:{status:result.receipt.status,cumulativeBlockGasUsed:result.receipt.cumulativeBlockGasUsed.toString(),bitvector:hex(result.receipt.bitvector)},amountSpent:result.amountSpent.toString()};
  // This fixed bytecode can touch only the declared addresses and slots. A
  // reconstructed-root mismatch withholds projection rather than hiding writes.
  const read=state.shallowCopy(),allocation={};
  for(const key of new Set([...Object.keys(input.allocation),input.target,input.header.miner])){
   const address=createAddressFromString(key),a=await read.getAccount(address);if(!a)continue;const storage={};
   for(const slot of new Set([...Object.keys(input.allocation[key]?.storage??{}),...input.sentinel.slots.map(word)])){
    const value=await read.getStorage(address,bytes(word(slot)));if(value.length&&BigInt(hex(value))!==0n)storage[word(slot)]=word(BigInt(hex(value)));
   }
   allocation[key]={nonce:q(a.nonce),balance:q(a.balance),code:hex(await read.getCode(address)),storage};
  }
  const root=hex(await state.getStateRoot());assert.equal(await allocationRoot(allocation),root);
  report.observation=observation(allocation,{stateRoot:root,executionStatus:error==='revert'?'reverted':error?'failed':'success',executionError:error,returnData:report.rawResult.execResult.returnValue,
   gasUsed:result.totalGasSpent.toString(),executionGasUsed:result.execResult.executionGasUsed.toString(),preRefundGasWithFloor:result.blockGasSpent.toString(),
   singleTransactionBlockGasUsed:(result.txRegularGas>result.txStateGas?result.txRegularGas:result.txStateGas).toString(),regularGasUsed:result.txRegularGas.toString(),stateGasUsed:result.txStateGas.toString(),logs:report.rawResult.execResult.logs});
 }
}catch(error){report.error={name:error?.name??null,message:error?.message??String(error)};}
console.log(JSON.stringify(report));
