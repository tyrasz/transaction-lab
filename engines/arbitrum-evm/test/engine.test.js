import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { simulateArbitrumCall,validateArbitrumCall } from '../index.js';
import { scenario,header,TOKEN,word,recordedFetch,syntheticFetch } from './fixture.js';
const request={...scenario};
const run=server=>simulateArbitrumCall(request,{fetchImpl:server.fetch});
test('input admits only the declared bounded single-call schema before I/O',async()=>{
 const normalized=validateArbitrumCall(request);assert.equal(normalized.gas,'2000000');assert.equal(normalized.block,'latest');
 for(const change of [{chainId:1},{to:null},{from:'0x'+'0'.repeat(40)},{gas:'02000000'},{gas:'5000001'},{gas:'20999'},{value:'-1'},{value:1},{block:'0x01'},{block:'0x'+'1'.repeat(64)},{data:'0x1'},{fees:{}},{accessList:[]},{authorizationList:[]},{queries:[]},{stateOverrides:[]}]){let calls=0;await assert.rejects(simulateArbitrumCall({...request,...change},{fetchImpl:()=>{calls++;throw Error();}}),{code:'ARBITRUM_INPUT'});assert.equal(calls,0);}
 const getter={...request};Object.defineProperty(getter,'gas',{enumerable:true,get(){throw Error('must not run');}});assert.throws(()=>validateArbitrumCall(getter),{code:'ARBITRUM_INPUT'});
});
test('pinned library and retained reply bytes retain their declared identities',()=>{
 const sha=b=>createHash('sha256').update(b).digest('hex');
 for(const f of JSON.parse(fs.readFileSync(new URL('../pinned-library.json',import.meta.url))).files){const b=fs.readFileSync(new URL('../'+f.path,import.meta.url));assert.equal(sha(b),f.sha256);assert.equal(b.length,f.bytes);}
 for(const f of JSON.parse(fs.readFileSync(new URL('fixtures/retained-revert/provenance.json',import.meta.url))).files){const b=fs.readFileSync(new URL('fixtures/retained-revert/'+f.path,import.meta.url));assert.equal(sha(b),f.sha256);}
});
test('actual retained Arbitrum revert replays through unmodified viem with preserved sender code and unknown messenger balance',async()=>{
 const server=recordedFetch(),out=await run(server);assert.equal(out.source.headerConfirmed,true);assert.equal(out.source.twoPassConsistent,true);assert.equal(out.status,'partial');assert.equal(out.execution.status,'reverted');assert.equal(out.execution.gasUsed,'58256');assert.match(out.execution.error.message,/exceeds balance/);assert.equal(out.assetChanges.find(a=>a.token.address===scenario.to).status,'unverified');assert.equal(out.assetChanges.some(a=>a.token.address===TOKEN),false);assert.equal(out.coverage.inventoryComplete,false);assert.equal(server.calls.length,9);assert.match(out.prechecks.find(r=>r.method==='eth_getCode').value,/^0xef0100/);
});
test('synthetic success exposes only exact32-byte measured balances and marks token metadata untrusted',async()=>{
 const server=syntheticFetch(),out=await run(server);assert.equal(out.status,'partial');assert.equal(out.execution.status,'success');assert.equal(out.source.blockHash,header.hash);const row=out.assetChanges.find(a=>a.token.address===TOKEN);assert.equal(row.status,'measured');assert.equal(row.beforeRaw,'100000000');assert.equal(row.afterRaw,'0');assert.equal(row.deltaRaw,'-100000000');assert.equal(row.token.metadataTrust,'untrusted_provider');assert.match(row.token.symbol,/<img/);assert.equal(out.assetChanges.length,3);assert.equal(out.coverage.measuredAssets,2);assert.equal(out.coverage.unverifiedAssets,1);assert.equal(out.coverage.destinationCreditVerified,false);
});
test('empty prebalance inference stays raw library output but never becomes a measured zero',async()=>{
 const out=await run(syntheticFetch({pre:null,post:'5'}));assert.equal(out.execution.status,'success');const row=out.assetChanges.find(a=>a.token.address===TOKEN);assert.equal(row.status,'unverified');assert.equal(row.beforeRaw,null);assert.equal(row.afterRaw,null);assert.equal(row.deltaRaw,null);assert.equal(row.reason,'empty_pre_balance_is_not_observed_zero');assert.equal(out.rawViem.result.assetChanges.find(a=>a.token.address===TOKEN).value.pre,'0');
});
test('failed metadata does not erase valid balance observations',async()=>{
 const out=await run(syntheticFetch({metadataFails:true}));const row=out.assetChanges.find(a=>a.token.address===TOKEN);assert.equal(row.status,'measured');assert.equal(row.token.symbol,null);assert.equal(row.token.decimals,null);
});
test('two-pass status/data/gas/ordered log and block ancestry inconsistencies withhold projections',async()=>{
 const mutations=[v=>v[0].calls[0].gasUsed='0x5209',v=>v[0].calls[0].returnData='0x01',v=>v[0].calls[0].logs[0].data=word(1),v=>v[0].calls[0].logs=[],v=>v[0].parentHash='0x'+'0'.repeat(64),v=>v[1].number=v[0].number,v=>v[2].parentHash=header.hash,v=>v[2].calls.pop(),v=>v.pop()];
 for(const mutate of mutations){const out=await run(syntheticFetch({mutate:({q,value,simulations})=>{if(q.method==='eth_simulateV1'&&simulations===2)mutate(value);return value;}}));assert.equal(out.status,'unavailable');assert.equal(out.execution.status,'unavailable');assert.deepEqual(out.assetChanges,[]);}
});
test('missing/failed/wrong-length balance post-read remains unverified without suppressing execution',async()=>{
 for(const replacement of [{status:'0x0',returnData:'0x',logs:[],gasUsed:'0x1',error:{code:3,message:'revert',data:'0x'}},{status:'0x1',returnData:'0x',logs:[],gasUsed:'0x1'},{status:'0x1',returnData:'0x01',logs:[],gasUsed:'0x1'}]){
  const out=await run(syntheticFetch({mutate:({q,value,simulations})=>{if(q.method==='eth_simulateV1'&&simulations===2)value[2].calls[0]=replacement;return value;}}));assert.equal(out.execution.status,'success');assert.equal(out.assetChanges.find(a=>a.token.address===TOKEN).status,'unverified');
 }
});
test('changed complete final header withholds every projected execution and amount',async()=>{
 const out=await run(syntheticFetch({mutate:({q,value,headerReads})=>{if(q.method==='eth_getBlockByNumber'&&headerReads===2)value.extraData='0x01';return value;}}));assert.equal(out.status,'unavailable');assert.equal(out.source.headerConfirmed,false);assert.equal(out.execution.status,'unavailable');assert.deepEqual(out.assetChanges,[]);assert.equal(out.rawViem.status,'returned');
});
test('pre-cancel and ignored-signal fetch cancellation leave no usable projections and truthful pending count',async()=>{
 let calls=0;const cancelled=await simulateArbitrumCall(request,{signal:AbortSignal.abort(),fetchImpl:()=>{calls++;}});assert.equal(calls,0);assert.equal(cancelled.error.code,'ARBITRUM_CANCELLED');
 const controller=new AbortController();let resolve;const pending=new Promise(r=>resolve=r);const outPromise=simulateArbitrumCall(request,{signal:controller.signal,fetchImpl:()=>{queueMicrotask(()=>controller.abort());return pending;}});const out=await outPromise;assert.equal(out.status,'unavailable');assert.equal(out.usage.drain.complete,false);assert.equal(out.usage.pendingAdapterOperations,1);const snapshot=JSON.stringify(out);resolve(new Response('{}'));await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(out),snapshot);
});
