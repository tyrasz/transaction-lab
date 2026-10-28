import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { simulateUnsignedCall, simulateUnsignedSequence } from '../unsigned-call.js';
import { rpcEvmContext } from '../../evm-context.js';
// Execute the generated witness bytecode using the already pinned local EVM
// dependency. This synthetic RPC harness does not establish provider support.
import { createEVM } from '../../local-evm/node_modules/@ethereumjs/evm/dist/esm/index.js';
import { Common, Mainnet } from '../../local-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createAddressFromString } from '../../local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';

const a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),w=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),h=n=>'0x'+BigInt(n).toString(16);
const S=a(11),T=a(12),TOKEN=a(13),PROBE=a(0xba1a),BLOCK=w(99),PARENT=w(98);
const HASHES=['0x01'+'ab'.repeat(31),'0x01'+'cd'.repeat(31)];
const LIST=[{address:T,storageKeys:[w(2),w(2)]},{address:T,storageKeys:[]}];
const HEADER={hash:BLOCK,parentHash:PARENT,mixHash:w(91),miner:a(92),number:h(20000000),timestamp:h(1710338135),gasLimit:h(30000000),baseFeePerGas:h(100),excessBlobGas:h(131072),blobGasUsed:h(131072)};
const QUERY={to:TOKEN,data:'0x70a08231'+S.slice(2).padStart(64,'0')};
const REQUEST={from:S,to:T,data:'0x1234',value:'0x0',gas:'0x4c4b40'};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function witnessOutput(call,code,header,{dropHashes=false,blobFee=0n}={}){
  const common=new Common({chain:Mainnet,hardfork:'cancun'});
  const evm=await createEVM({common,blockchain:{async getBlock(number){assert.equal(BigInt(number),BigInt(header.number)-1n);return {hash:()=>Buffer.from(header.parentHash.slice(2),'hex')};}}});
  const intrinsic=21000n+(call.accessList??[]).reduce((sum,row)=>sum+2400n+1900n*BigInt(row.storageKeys.length),0n);
  assert(BigInt(call.gas)>=intrinsic,'Witness envelope cannot cover its actual access-list intrinsic cost.');
  const output=await evm.runCode({code:Buffer.from(code.slice(2),'hex'),gasLimit:BigInt(call.gas)-intrinsic,to:createAddressFromString(PROBE),caller:createAddressFromString(S),
    blobVersionedHashes:dropHashes?[]:call.blobVersionedHashes,
    block:{header:{number:BigInt(header.number),timestamp:BigInt(header.timestamp),gasLimit:BigInt(header.gasLimit),baseFeePerGas:0n,
      prevRandao:Buffer.from(header.mixHash.slice(2),'hex'),coinbase:createAddressFromString(header.miner),getBlobGasPrice:()=>blobFee}}});
  assert.equal(output.exceptionError,undefined);return '0x'+Buffer.from(output.returnValue).toString('hex');
}
function fixture({context={},reverted=false,mutate,witness={}}={}){
  const records=[],request={...REQUEST,...structuredClone(context)};
  const rpc={async call(method,params){
    const record={method,params:structuredClone(params)};records.push(record);let result,stage=method;
    if(method==='eth_chainId')result='0x1';
    else if(method==='eth_getBlockByHash'||method==='eth_getBlockByNumber')result=structuredClone(HEADER);
    else if(method==='eth_getTransactionCount')result='0x7';
    else if(method==='eth_getBalance')result='0x64';
    else if(method==='eth_getCode')result=[S,PROBE].includes(params[0])?'0x':'0x6000';
    else if(method==='debug_traceCall'){
      const [call,,options]=params,isDiff=options.tracer==='prestateTracer',nonce=BigInt(options.stateOverrides?.[S]?.nonce??'0x7');
      // Model the observed provider requirement instead of implicitly granting
      // the fee context merely because the request supplies a zero fee cap.
      if(call.blobVersionedHashes)assert.deepEqual(options.blockOverrides,{baseFeePerGas:'0x0',blobBaseFee:'0x0'});
      else assert.equal(options.blockOverrides,undefined);
      const diff={pre:{[S]:{nonce:h(nonce),balance:'0x64'}},post:{[S]:{nonce:h(nonce+1n)}}};
      const frame={type:'CALL',from:call.from,to:call.to,input:call.data,gas:call.gas,gasUsed:'0x55c8',value:call.value,output:'0x'};
      if(call.to===PROBE){stage=options.stateOverrides[S]?'witness_after':'witness_before';result=isDiff?diff:{...frame,output:await witnessOutput(call,options.stateOverrides[PROBE].code,HEADER,witness)};}
      else if(call.to===T){stage=isDiff?'original_diff':'original_trace';result=isDiff?diff:{...frame,...(reverted?{error:'execution reverted'}:{})};}
      else if(call.to===TOKEN){stage=isDiff?'query_diff':'query_trace';result=isDiff?diff:{...frame,output:w(123)};}
      else assert.fail('Unexpected target');
    }else assert.fail('Unexpected method');
    const changed=mutate?.({method,params,stage,result});if(changed!==undefined)result=changed;
    record.result=structuredClone(result);return result;
  }};
  return {rpc,records,request,queries:[QUERY],chainId:1,blockHash:BLOCK};
}

test('access-list order and duplicates reach only original calls and witnesses; legacy envelopes stay identical',async()=>{
  for(const context of [{},{accessList:[]},{accessList:LIST}]){
    const f=fixture({context}),r=await simulateUnsignedCall(f);assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.measurements[0].status,'measured');
    const rpcContext=rpcEvmContext(f.request);assert.deepEqual(r.request.transaction,{...REQUEST,...rpcContext});
    assert.equal(r.executionIdentity.originalEnvelopeSha256,sha(r.request.transaction));
    for(const record of f.records.filter(x=>x.method==='debug_traceCall')){
      const call=record.params[0];
      if(call.to===TOKEN){assert.equal(Object.hasOwn(call,'accessList'),false);assert.equal(Object.hasOwn(call,'blobVersionedHashes'),false);assert.equal(Object.hasOwn(call,'maxFeePerBlobGas'),false);}
      else for(const field of ['accessList','blobVersionedHashes','maxFeePerBlobGas'])assert.deepEqual(call[field],rpcContext[field]);
    }
    assert.equal(r.blobContextValidation,undefined);assert.equal(r.accounting.rpcCalls,17);
  }
});

test('actual generated bytecode proves all supplied blob hashes, out-of-range zero and zero blob fee before and after',async()=>{
  for(const hashes of [HASHES,Array.from({length:32},(_,i)=>'0x01'+BigInt(i+1).toString(16).padStart(62,'0'))]){
    const f=fixture({context:{accessList:LIST,blobVersionedHashes:hashes}}),r=await simulateUnsignedCall(f);
    assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.execution.status,'success');assert.equal(r.blobContextValidation.status,'verified');
    assert.equal(r.blobContextValidation.executionBlobBaseFee,'0');assert.equal(r.blobContextValidation.sourceExcessBlobGas,'131072');assert.equal(r.blobContextValidation.sidecarsVerified,false);
    assert.deepEqual(r.blobContextValidation.witnesses.map(x=>[x.state,x.hashCount,x.outOfRangeIndex]),[['before',hashes.length,hashes.length],['after',hashes.length,hashes.length]]);
    for(const record of f.records.filter(x=>x.method==='debug_traceCall')){
      const call=record.params[0];if(call.to===TOKEN){assert.equal(call.blobVersionedHashes,undefined);assert.equal(call.maxFeePerBlobGas,undefined);assert.equal(record.params[2].blockOverrides,undefined);continue;}
      assert.deepEqual(record.params[2].blockOverrides,{baseFeePerGas:'0x0',blobBaseFee:'0x0'});
      assert.deepEqual(call.blobVersionedHashes,hashes);assert.equal(call.maxFeePerBlobGas,'0x0');assert.deepEqual(call.accessList,LIST);
      if(call.to===PROBE)assert.equal(record.result.output.length,2+64*(8+hashes.length+2));
    }
  }
});

test('witness covers large access-list intrinsic costs while retaining its legacy execution budget',async()=>{
  const caseLike=Array.from({length:6},(_,i)=>({address:T,storageKeys:Array(i===0?140:0).fill(w(2))}));
  const maximum=Array.from({length:128},()=>({address:T,storageKeys:Array(8).fill(w(2))}));
  for(const accessList of [[],caseLike,maximum]){
    const accessGas=accessList.reduce((sum,row)=>sum+2400n+1900n*BigInt(row.storageKeys.length),0n);
    const f=fixture({context:{accessList,blobVersionedHashes:HASHES}}),r=await simulateUnsignedCall(f);
    assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.measurements[0].status,'measured');
    const witnesses=f.records.filter(x=>x.method==='debug_traceCall'&&x.params[0].to===PROBE);assert.equal(witnesses.length,2);
    for(const record of witnesses){assert.equal(BigInt(record.params[0].gas),300000n+accessGas);assert.deepEqual(record.params[0].accessList,accessList);assert(BigInt(record.params[0].gas)<5000000n);}
  }
  assert.equal(caseLike.reduce((sum,row)=>sum+2400n+1900n*BigInt(row.storageKeys.length),0n),280400n);
});

test('ignored blob hashes, nonzero blob fee, malformed witness or late canonical mismatch fail closed',async()=>{
  for(const options of [{witness:{dropHashes:true}},{witness:{blobFee:1n}},
    {mutate:x=>{if(x.stage==='witness_after')x.result.output=x.result.output.slice(0,-64);}},
    {mutate:x=>{if(x.method==='eth_getBlockByNumber')x.result.excessBlobGas='0x0';}},
  ]){
    const r=await simulateUnsignedCall(fixture({context:{blobVersionedHashes:HASHES},...options}));
    assert.equal(r.execution.status,'success');assert.equal(r.canonicalStatus,'unverified');assert.notEqual(r.blobContextValidation.status,'verified');
    assert.equal(r.measurements[0].status,'unavailable');assert.equal(r.measurements[0].beforeRaw,undefined);
  }
});

test('pre-Cancun, missing blob header fields and malformed optional context never reach original execution',async()=>{
  for(const mutate of [x=>{if(x.method==='eth_getBlockByHash')x.result.timestamp=h(1710338134);},x=>{if(x.method==='eth_getBlockByHash')delete x.result.excessBlobGas;},x=>{if(x.method==='eth_getBlockByHash')x.result.excessBlobGas=h(1n<<64n);}]){
    const f=fixture({context:{blobVersionedHashes:HASHES},mutate}),r=await simulateUnsignedCall(f);assert.equal(r.execution.status,'unavailable');assert.equal(f.records.some(x=>x.method==='debug_traceCall'),false);
  }
  for(const context of [{accessList:null},{accessList:[{address:T,storageKeys:['0x0']}]},{blobVersionedHashes:[]},{blobVersionedHashes:[w(1)]},{blobVersionedHashes:Array(33).fill(HASHES[0])},{maxFeePerBlobGas:'0x1'}]){
    const f=fixture({context}),r=await simulateUnsignedCall(f);assert.equal(r.execution.status,'unavailable');assert.equal(f.records.length,0);
  }
});

test('reverted blob call retains validated state and context while all queries remain not applicable',async()=>{
  const f=fixture({context:{blobVersionedHashes:HASHES},reverted:true}),r=await simulateUnsignedCall(f);
  assert.equal(r.execution.status,'reverted_or_failed');assert.equal(r.canonicalStatus,'verified',r.measurementFailure);
  assert.equal(r.revertStateValidation.status,'verified');assert.equal(r.blobContextValidation.status,'verified');assert.equal(r.measurements[0].status,'not_applicable');
  assert.equal(f.records.some(x=>x.method==='debug_traceCall'&&x.params[0].to===TOKEN),false);
});

test('sequence validates every optional context before RPC and keeps each step context separate',async()=>{
  const f=fixture(),calls=[{request:{...REQUEST,accessList:LIST},queries:[QUERY]},{request:{...REQUEST,blobVersionedHashes:HASHES},queries:[QUERY]}];
  const r=await simulateUnsignedSequence({...f,calls});assert.equal(r.sequence.status,'completed',r.sequence.reason);assert.equal(r.canonicalStatus,'verified');
  assert.equal(r.steps[0].result.blobContextValidation,undefined);assert.equal(r.steps[1].result.blobContextValidation.status,'verified');
  assert.equal(r.steps[1].result.request.transaction.accessList,undefined);assert.deepEqual(r.steps[1].result.request.transaction.blobVersionedHashes,HASHES);
  const invalid=fixture();calls[1].request.blobVersionedHashes=[];await assert.rejects(simulateUnsignedSequence({...invalid,calls}));assert.equal(invalid.records.length,0);
});
