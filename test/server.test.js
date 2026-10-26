import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createAppServer, simulate, replay } from '../src/server.js';
import { EXAMPLES } from '../src/config.js';

const hash='0x'+'a'.repeat(64);
const block={number:'0x123',hash,timestamp:'0x456'};
test('simulation binds trace to the observed block hash and never switches to latest',async()=>{
  const calls=[];
  const rpc={provider:'fixture',rpcMs:0,async verifyChain(){},async call(method,params){
    calls.push({method,params});
    if(method==='eth_getBlockByNumber')return block;
    if(method==='debug_traceCall')return {type:'CALL',from:EXAMPLES[0].request.from,to:EXAMPLES[0].request.to,input:EXAMPLES[0].request.data,gasUsed:'0x5208',error:'execution reverted',logs:[]};
    throw new Error('Unexpected RPC method');
  }};
  const report=await simulate(EXAMPLES[0].request,rpc);
  assert.deepEqual(calls[1].params[1],{blockHash:hash,requireCanonical:true});
  assert.equal(calls[1].params[2].tracerConfig.withLog,true);
  assert.equal(report.source.blockHash,hash);
  assert.equal(report.execution.status,'reverted');
  assert.deepEqual(report.inAssets,[]);
  assert.equal(report.security.status,'not_assessed');
});

test('historical trace rejects a transaction and receipt from different blocks',async()=>{
  const rpc={async verifyChain(){},async call(method){
    return method==='eth_getTransactionByHash'?{hash:EXAMPLES[0].transactionHash,blockHash:hash,to:EXAMPLES[0].request.to}:{transactionHash:EXAMPLES[0].transactionHash,blockHash:'0x'+'b'.repeat(64)};
  }};
  await assert.rejects(replay({chainId:999,transactionHash:EXAMPLES[0].transactionHash},rpc),{code:'TRANSACTION_UNAVAILABLE'});
});

test('HTTP API rejects invalid and cross-origin requests before network activity',async t=>{
  let rpcCalls=0;
  const server=createAppServer({persist:false,rpcFactory(){rpcCalls++;throw new Error('Network must not be called');}});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const health=await fetch(base+'/api/health');
  assert.equal((await health.json()).readOnly,true);
  const invalid=await fetch(base+'/api/simulate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...EXAMPLES[0].request,chainId:1})});
  assert.equal(invalid.status,400);
  assert.equal((await invalid.json()).error.code,'UNSUPPORTED_CHAIN');
  const crossOrigin=await fetch(base+'/api/simulate',{method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.example'},body:JSON.stringify(EXAMPLES[0].request)});
  assert.equal(crossOrigin.status,403);
  const write=await fetch(base+'/api/send',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(write.status,404);
  assert.equal(rpcCalls,0);
});

const observedSupply=JSON.parse(await readFile(new URL('../fixtures/hyperlend-observed-supply.json',import.meta.url),'utf8'));
const observedReplay=JSON.parse(await readFile(new URL('../fixtures/corewriter-observed-history.json',import.meta.url),'utf8'));
function simulationRpc(trace=structuredClone(observedSupply.input.trace),returnedBlock=block) {
  return {provider:'fixture',rpcMs:0,async verifyChain(){},async call(method){
    if(method==='eth_getBlockByNumber')return returnedBlock;
    if(method==='debug_traceCall')return trace;
    throw new Error(`Unexpected RPC method ${method}`);
  }};
}
function historicalRpc(overrides={}) {
  const {request,trace,block:metadata}=observedReplay.input;
  const transactionHash=observedReplay.provenance.transactionHash;
  const returnedBlock={number:'0x'+BigInt(metadata.number).toString(16),hash:metadata.hash,timestamp:'0x'+BigInt(metadata.timestamp).toString(16)};
  const transaction={hash:transactionHash,from:request.from,to:request.to,input:request.data,value:'0x0',chainId:'0x3e7',blockHash:returnedBlock.hash,blockNumber:returnedBlock.number,transactionIndex:'0x1'};
  const receipt={transactionHash,from:request.from,to:request.to,blockHash:returnedBlock.hash,blockNumber:returnedBlock.number,transactionIndex:'0x1',gasUsed:trace.gasUsed,status:'0x1'};
  const records={transaction,receipt,block:returnedBlock,trace:structuredClone(trace),...overrides};
  let receiptReads=0;
  return {records,transactionHash,provider:'fixture',rpcMs:0,async verifyChain(){},async call(method){
    if(method==='eth_getTransactionByHash')return records.transaction;
    if(method==='eth_getTransactionReceipt')return ++receiptReads>1 && records.finalReceipt!==undefined?records.finalReceipt:records.receipt;
    if(method==='eth_getBlockByHash')return records.block;
    if(method==='debug_traceTransaction')return records.trace;
    throw new Error(`Unexpected RPC method ${method}`);
  }};
}

test('incomplete or unrelated root traces are rejected rather than shown as empty success',async()=>{
  await assert.rejects(simulate(EXAMPLES[0].request,simulationRpc({type:'CALL'})),{code:'TRACE_UNAVAILABLE'});
  const mutations=[
    {from:'0x'+'1'.repeat(40)},
    {to:'0x'+'2'.repeat(40)},
    {input:'0x'},
    {value:'0x1'},
  ];
  for(const change of mutations) {
    await assert.rejects(simulate(EXAMPLES[0].request,simulationRpc({...observedSupply.input.trace,...change})),{code:'TRACE_MISMATCH'});
  }
  await assert.rejects(simulate(EXAMPLES[0].request,simulationRpc({...observedSupply.input.trace,type:'DELEGATECALL'})),{code:'TRACE_UNAVAILABLE'});
  await assert.rejects(simulate(EXAMPLES[0].request,simulationRpc({...observedSupply.input.trace,gasUsed:undefined})),{code:'TRACE_UNAVAILABLE'});
});

test('real nested delegate calls and omitted zero root value remain valid',async()=>{
  const trace=structuredClone(observedSupply.input.trace);
  delete trace.value;
  const report=await simulate(EXAMPLES[0].request,simulationRpc(trace));
  assert.equal(report.execution.status,'success');
  assert.equal(report.coverage.status,'supported');
  assert.equal(report.outAssets[0].transferOut[0].value,'15.066115');
  assert.equal(report.balanceChanges.status,'unavailable');
  assert.deepEqual(report.balanceChanges.assets,[]);
  assert.equal(report.evidence.traceResponse,trace);
  await assert.rejects(simulate({...EXAMPLES[0].request,value:'1'},simulationRpc(trace)),{code:'TRACE_MISMATCH'});
});

test('simulation rejects a returned block that differs from the requested numeric block',async()=>{
  await assert.rejects(simulate({...EXAMPLES[0].request,block:'0x124'},simulationRpc()),{code:'BLOCK_MISMATCH'});
});

test('approval observations are exposed with partial coverage, without a general safety verdict',async()=>{
  const request=EXAMPLES.find(item=>item.id==='usdc-max-approval').request;
  const trace={type:'CALL',from:request.from,to:request.to,input:request.data,value:'0x0',gasUsed:'0x5208',output:'0x'+'0'.repeat(63)+'1'};
  const report=await simulate(request,simulationRpc(trace));
  assert.equal(report.coverage.status,'partial');
  assert.equal(report.permissions.observations[0].allowanceKind,'uint256_max');
  assert.equal(report.permissions.coverage.allowanceStateVerified,false);
  assert.equal(report.security.status,'not_assessed');
  assert.equal(report.balanceChanges.status,'not_applicable');
});

test('historical replay validates block hash, number, receipt index and gas',async()=>{
  for(const field of ['hash','number']) {
    const rpc=historicalRpc();
    rpc.records.block={...rpc.records.block,[field]:field==='hash'?'0x'+'b'.repeat(64):'0x1'};
    await assert.rejects(replay({chainId:999,transactionHash:rpc.transactionHash},rpc),{code:'BLOCK_MISMATCH'});
  }
  for(const field of ['blockNumber','transactionIndex']) {
    const rpc=historicalRpc();
    rpc.records.receipt={...rpc.records.receipt,[field]:'0xff'};
    await assert.rejects(replay({chainId:999,transactionHash:rpc.transactionHash},rpc),{code:'TRANSACTION_UNAVAILABLE'});
  }
  const rpc=historicalRpc();
  rpc.records.receipt={...rpc.records.receipt,gasUsed:'0x1'};
  await assert.rejects(replay({chainId:999,transactionHash:rpc.transactionHash},rpc),{code:'TRACE_RECEIPT_MISMATCH'});
});

test('replay rejects status inconsistency without modifying the raw trace',async()=>{
  const rpc=historicalRpc();
  rpc.records.receipt={...rpc.records.receipt,status:'0x0'};
  const original=JSON.stringify(rpc.records.trace);
  Object.freeze(rpc.records.trace);
  await assert.rejects(replay({chainId:999,transactionHash:rpc.transactionHash},rpc),{code:'TRACE_RECEIPT_MISMATCH'});
  assert.equal(JSON.stringify(rpc.records.trace),original);
  const reverse=historicalRpc();
  reverse.records.trace={...reverse.records.trace,error:'execution reverted'};
  await assert.rejects(replay({chainId:999,transactionHash:reverse.transactionHash},reverse),{code:'TRACE_RECEIPT_MISMATCH'});
});

test('replay preserves actual evidence and rechecks receipt identity after tracing',async()=>{
  const rpc=historicalRpc();
  const original=JSON.stringify(rpc.records.trace);
  Object.freeze(rpc.records.trace);
  const report=await replay({chainId:999,transactionHash:rpc.transactionHash},rpc);
  assert.equal(report.execution.status,'success');
  assert.equal(report.coverage.status,'partial');
  assert.equal(report.evidence.receiptRechecked,true);
  assert.equal(report.balanceChanges.status,'not_applicable');
  assert.equal(JSON.stringify(report.evidence.traceResponse),original);
  const reorg=historicalRpc();
  reorg.records.finalReceipt={...reorg.records.receipt,blockHash:'0x'+'b'.repeat(64)};
  await assert.rejects(replay({chainId:999,transactionHash:reorg.transactionHash},reorg),{code:'TRANSACTION_CHANGED'});
});
