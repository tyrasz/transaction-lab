import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { fixture, blockhashCode, A, B, word } from './ancestry-fixture.js';
const run = (f, options={}) => executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc,...options});
const ancestorEvidence = r => { const rows=r.inputEvidence.filter(e=>e.request.method==='eth_getBlockByHash');assert.equal(rows.length,1);return rows[0]; };

test('actual worker resolves repeated N-2 from one hash-selected ancestor and preserves proof-only facts',async()=>{
 const f=await fixture(blockhashCode(2)),r=await run(f);
 assert.equal(r.status,'completed');assert.equal(r.output.execution.status,'success');assert.equal(r.output.execution.returnData,f.blocks.at(-3).hash);
 assert.deepEqual(f.calls.filter(x=>x.method==='eth_getBlockByHash'),[{method:'eth_getBlockByHash',params:[f.header.parentHash,false]}]);
 const ancestor=ancestorEvidence(r);assert.equal(r.inputs.ancestry.headers[0].blockHash,f.header.parentHash);assert.equal(r.inputs.ancestry.headers[0].evidenceId,ancestor.id);
 assert.equal(ancestor.verification,'verified');assert.equal(r.broker.calls,4);assert.equal(r.broker.pendingAtReturn,0);
 assert.deepEqual(f.calls.filter(x=>x.method==='eth_getCode').map(x=>x.params[0]),[A],'Only the nonempty destination requires a code response');
});

test('actual before/after preview shares authenticated ancestry without using outputs as state',async()=>{
 const f=await fixture(blockhashCode(2)),query={to:A,data:'0x70a08231'+B.slice(2).padStart(64,'0')};
 const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[query]});
 assert.equal(r.status,'completed');assert.equal(r.preview.status,'complete');assert.equal(r.preview.measurements[0].status,'measured');
 const pair=r.preview.measurements[0].values[0],expected=BigInt(f.blocks.at(-3).hash).toString();
 assert.equal(pair.beforeRaw,expected);assert.equal(pair.afterRaw,expected);assert.equal(pair.deltaRaw,'0');
 assert.equal(f.calls.filter(x=>x.method==='eth_getBlockByHash').length,1);assert.equal(r.preview.inputs.ancestry.headers.length,1);
});

test('actual worker ancestor substitution is rejected by the parent before delivery and no output survives',async()=>{
 for(const change of [r=>({...r,stateRoot:word(1)}),r=>({...r,hash:word(1)}),()=>null]){
  const f=await fixture(blockhashCode(2),4,({method,result})=>method==='eth_getBlockByHash'?change(result):result),r=await run(f);
  assert.equal(r.status,'unavailable');assert.equal(r.error.code,'LOCAL_ISOLATED_ANCESTRY');assert.equal(r.output,null);assert.equal(r.inputs,null);assert.equal(r.broker.calls,4);
 }
});

test('actual worker cannot bypass parent ancestry evidence and hash-only RPC binding',async t=>{
 const original=childProcess.fork;
 for(const mutate of [r=>{delete r.inputs.ancestry;},r=>{r.inputs.ancestry.lookups[0].hash=word(1);},r=>{delete ancestorEvidence(r).result;},r=>{r.inputs.ancestry.headers[0].number='1';}]){
  let changed=false;const mock=t.mock.method(childProcess,'fork',(...args)=>{const child=original(...args),emit=child.emit;child.emit=function(event,...values){if(event==='message'&&typeof values[0]==='string'){const message=JSON.parse(values[0]);if(message.type==='result'){mutate(message.result);values[0]=JSON.stringify(message);changed=true;}}return emit.call(this,event,...values);};return child;});
  const r=await run(await fixture(blockhashCode(2)));mock.mock.restore();assert.equal(changed,true);assert.equal(r.status,'unavailable');assert.equal(r.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(r.output,null);
 }
 for(const params of [[word(42),false],['latest',false]]){
  const mock=t.mock.method(childProcess,'fork',(...args)=>{const child=original(...args),emit=child.emit;child.emit=function(event,...values){if(event==='message'&&typeof values[0]==='string'){const message=JSON.parse(values[0]);if(message.method==='eth_getBlockByHash'){message.params=params;values[0]=JSON.stringify(message);}}return emit.call(this,event,...values);};return child;});
  const f=await fixture(blockhashCode(2)),r=await run(f);mock.mock.restore();assert.equal(r.status,'unavailable');assert.equal(r.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(f.calls.length,3);assert(f.calls.every(x=>x.method!=='eth_getBlockByHash'));
 }
});

test('ancestor reads cannot exceed the shared proof call budget and missing ancestry rolls back the message',async()=>{
 const f=await fixture('0x602a600055'+blockhashCode(2).slice(2)),r=await run(f,{limits:{calls:4}});
 // Sender proof, destination proof/code and slot0 proof exhaust the common
 // pool. The authenticated-empty sender has no separate code request.
 assert.equal(r.status,'completed');assert.equal(r.output.execution.status,'unavailable');assert.equal(r.output.stateDisposition,'rolled_back');assert.deepEqual(r.changes.accounts,[]);
 assert.equal(r.inputUsage.failure.code,'RPC_STATE_INPUT_LIMIT');assert.equal(f.calls.length,4);assert.deepEqual(f.calls.map(x=>x.method),['eth_getProof','eth_getProof','eth_getCode','eth_getProof']);assert(f.calls.every(x=>x.method!=='eth_getBlockByHash'));
});

test('ancestor cancellation drains and late replies cannot restore results',async()=>{
 const controller=new AbortController();let release;
 const f=await fixture(blockhashCode(2),4,({method,result})=>method!=='eth_getBlockByHash'?result:new Promise(resolve=>{release=()=>resolve(result);setTimeout(()=>controller.abort(),5);}));
 const r=await run(f,{signal:controller.signal,limits:{drainMs:5}});
 assert.equal(r.status,'unavailable');assert.equal(r.error.code,'LOCAL_ISOLATED_CANCELLED');assert.equal(r.output,null);assert.equal(r.broker.pendingAtReturn,1);
 const saved=JSON.stringify(r);release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(JSON.stringify(r),saved);
});

test('public local adapter plus production proof transport executes authenticated ancestry and final source recheck',async()=>{
 const [{ProofRpcClient},{simulateLocal}]=await Promise.all([import('../../../src/proof-rpc.js'),import('../../../src/local-simulation.js')]);
 const f=await fixture(blockhashCode(2)),wire=[];
 const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(_url,options)=>{
   const request=JSON.parse(options.body);wire.push(request);let result;
   if(request.method==='eth_chainId')result='0x1';
   else if(request.method==='eth_getBlockByNumber'||(request.method==='eth_getBlockByHash'&&request.params[0]===f.header.hash))result=f.header;
   else result=await f.rpc.call(request.method,request.params);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 }});
 const result=await simulateLocal({chainId:1,from:B,to:A,data:'0x',value:'0',block:f.header.hash,queries:[{to:A,data:'0x70a08231'+B.slice(2).padStart(64,'0')}]},rpc);
 assert.equal(result.status,'complete');assert.equal(result.source.canonicalStatus,'verified');assert.equal(result.attempt.preview.measurements[0].values[0].afterRaw,BigInt(f.blocks.at(-3).hash).toString());
 assert.equal(wire.length,7);assert.deepEqual(wire.filter(row=>row.method==='eth_getBlockByHash').map(row=>row.params),[[f.header.hash,false],[f.header.parentHash,false]]);
 assert.equal(wire.at(-1).method,'eth_getBlockByNumber');assert.equal(rpc.usage().calls,7);assert.equal((await rpc.drain()).complete,true);
});
