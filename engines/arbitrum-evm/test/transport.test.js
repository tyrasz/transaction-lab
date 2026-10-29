import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy,originalCall,expectedMain,helperData,balanceData,STATIC_CODE } from '../policy.js';
import { createTransport } from '../transport.js';
import { validateArbitrumCall,simulateArbitrumCall } from '../index.js';
import { LIMITS,ZERO } from '../common.js';
import { scenario,header,syntheticFetch,response } from './fixture.js';
const input=validateArbitrumCall(scenario);
async function ready(){const policy=createPolicy(input),server=syntheticFetch(),transport=createTransport({policy,fetchImpl:server.fetch});await transport.request({method:'eth_chainId',params:[]});await transport.request({method:'eth_getBlockByNumber',params:['latest',false]});policy.pin(header);transport.setPhase('viem');return {policy,server,transport};}
test('method/envelope/helper gates reject signing, context overrides and substituted original identity before dispatch',async()=>{
 for(const item of [
  {method:'eth_sendTransaction',params:[]},
  {method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[{...originalCall(input),from:ZERO}]}]},header.number]},
  {method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[originalCall(input)],blockOverrides:{baseFeePerGas:'0x0'}}]},header.number]},
  {method:'eth_simulateV1',params:[{traceTransfers:true,validation:true,blockStateCalls:[{calls:[originalCall(input)]}]},header.number]},
  {method:'eth_getCode',params:[input.from,header.number]},
 ]){const {server,transport}=await ready();await assert.rejects(transport.request(item));assert.equal(server.calls.length,2);transport.finish();}
 const {policy,server,transport}=await ready();await transport.request({method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[originalCall(input)]}]},header.number]});
 const scratch=policy.state.scratch;await assert.rejects(transport.request({method:'eth_call',params:[{from:ZERO,to:scratch,gas:'0xf4240',data:helperData(policy.state.assets[0],balanceData(input.from))},header.number,{[scratch]:{code:STATIC_CODE,balance:'0x1'}}]}));assert.equal(server.calls.length,3);transport.finish();
});
test('exact helper scratch avoids participants and unknown candidate probes are denied',async()=>{
 const {policy,server,transport}=await ready();await transport.request({method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[originalCall(input)]}]},header.number]});
 const scratch=policy.state.scratch;await assert.rejects(transport.request({method:'eth_call',params:[{from:ZERO,to:scratch,gas:'0xf4240',data:helperData('0x'+'f'.repeat(40),balanceData(input.from))},header.number,{[scratch]:{code:STATIC_CODE}}]}));assert.equal(server.calls.length,3);transport.finish();
});
test('response cap retains only bounded prefix and cannot expose successful projections',async()=>{
 let calls=0;const out=await simulateArbitrumCall(input,{fetchImpl:async()=>{calls++;return new Response(new Uint8Array(LIMITS.responseBytes+1));}});assert.equal(out.status,'unavailable');assert.equal(calls,1);assert.equal(out.usage.retainedBytes,LIMITS.responseBytes);assert.equal(out.usage.observedBytes,LIMITS.responseBytes+1);assert.equal(out.rpcEvidence[0].responseComplete,false);assert.deepEqual(out.assetChanges,[]);
});
test('invalid JSON-RPC id, both result/error, and HTTP errors cannot become successful observations',async()=>{
 for(const build of [q=>new Response(JSON.stringify({jsonrpc:'2.0',id:q.id+1,result:'0xa4b1'})),q=>new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'0xa4b1',error:{code:3,message:'x'}})),q=>new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'0xa4b1'}),{status:500})]){const out=await simulateArbitrumCall(input,{fetchImpl:async(_u,init)=>build(JSON.parse(init.body))});assert.equal(out.status,'unavailable');assert.equal(out.execution.status,'unavailable');assert.deepEqual(out.assetChanges,[]);}
});
test('clock reversal/deadline gates stop dispatch, preserving final-reserve capability only inside global budget',async()=>{
 let clock=0,calls=0;const policy=createPolicy(input),transport=createTransport({policy,now:()=>clock,wall:()=>clock,fetchImpl:async(_u,init)=>{calls++;return response(JSON.parse(init.body),'0xa4b1');}});
 await transport.request({method:'eth_chainId',params:[]});clock=-1;await assert.rejects(transport.request({method:'eth_getBlockByNumber',params:['latest',false]}));assert.equal(calls,1);assert.equal(transport.snapshot().hardFailure,'ARBITRUM_BUDGET');transport.finish();
 let t=0;const p=createPolicy(input),server=syntheticFetch(),tr=createTransport({policy:p,now:()=>t,wall:()=>t,fetchImpl:server.fetch});await tr.request({method:'eth_chainId',params:[]});await tr.request({method:'eth_getBlockByNumber',params:['latest',false]});p.pin(header);tr.setPhase('viem');t=LIMITS.viemDispatchMs;await assert.rejects(tr.request({method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[originalCall(input)]}]},header.number]}));tr.setPhase('final');assert.deepEqual(await tr.request({method:'eth_getBlockByNumber',params:[header.number,false]}),header);assert.equal(server.calls.length,3);assert.equal(tr.snapshot().viemStopped,true);tr.finish();
});
test('nonzero value/selected gas and explicit block remain exact; caller inputs never create state overrides',async()=>{
 const request={...input,value:'7',gas:'123456',block:header.number},server=syntheticFetch();const out=await simulateArbitrumCall(request,{fetchImpl:server.fetch});assert.equal(out.execution.status,'success');const sims=server.calls.filter(q=>q.method==='eth_simulateV1');assert.equal(sims.length,2);for(const q of sims){assert.deepEqual(q.params[0].blockStateCalls[0].calls[0],originalCall(request));assert.equal(q.params[0].blockStateCalls[0].stateOverrides,undefined);assert.equal(q.params[1],header.number);}
});
test('transport shared call/request/total-byte budgets cannot be bypassed by valid envelopes',async()=>{
 const policy={validate(){},observe(){}};let calls=0;
 const tr=createTransport({policy,fetchImpl:async(_u,init)=>{calls++;return response(JSON.parse(init.body),'0x');}});
 for(let i=0;i<LIMITS.calls;i++)await tr.request({method:'fixture',params:[]});await assert.rejects(tr.request({method:'fixture',params:[]}));assert.equal(calls,LIMITS.calls);tr.finish();
 let bigCalls=0;const big=createTransport({policy,fetchImpl:async()=>{bigCalls++;throw Error('must not dispatch');}});await assert.rejects(big.request({method:'fixture',params:['x'.repeat(LIMITS.requestBytes)]}));assert.equal(bigCalls,0);big.finish();
 let bodyCalls=0;const body=createTransport({policy,fetchImpl:async(_u,init)=>{bodyCalls++;return response(JSON.parse(init.body),'a'.repeat(LIMITS.responseBytes-100));}});for(let i=0;i<4;i++)await body.request({method:'fixture',params:[]});await assert.rejects(body.request({method:'fixture',params:[]}));const snap=body.snapshot();assert.equal(bodyCalls,5);assert.equal(snap.retainedBytes,LIMITS.totalBytes);assert.ok(snap.observedBytes>LIMITS.totalBytes);assert.equal(snap.hardFailure,'ARBITRUM_BUDGET');body.finish();
});
test('discovery beyond bounded asset count fails closed before automatic follow-up probes',async()=>{
 const server=syntheticFetch({mutate:({q,value,simulations})=>{if(q.method==='eth_simulateV1'&&simulations===1){const template=value[0].calls[0].logs[0];value[0].calls[0].logs=Array.from({length:13},(_,i)=>({...template,address:'0x'+(0x1000+i).toString(16).padStart(40,'0')}));}return value;}});
 const out=await simulateArbitrumCall(input,{fetchImpl:server.fetch});assert.equal(out.status,'unavailable');assert.equal(out.execution.status,'unavailable');assert.equal(server.calls.filter(q=>q.method==='eth_call').length,0);
});
test('a completed body arriving past its per-request deadline latches phase failure',async()=>{
 let time=0;const server=syntheticFetch(),policy=createPolicy(input),transport=createTransport({policy,now:()=>time,wall:()=>time,fetchImpl:async(url,init)=>{const q=JSON.parse(init.body),result=await server.fetch(url,init);if(q.method==='eth_simulateV1')time+=LIMITS.requestMs+1;return result;}});
 await transport.request({method:'eth_chainId',params:[]});await transport.request({method:'eth_getBlockByNumber',params:['latest',false]});policy.pin(header);transport.setPhase('viem');await assert.rejects(transport.request({method:'eth_simulateV1',params:[{traceTransfers:true,validation:false,blockStateCalls:[{calls:[originalCall(input)]}]},header.number]}));assert.equal(transport.snapshot().viemStopped,true);assert.equal(policy.state.discovery,null);transport.finish();
});
