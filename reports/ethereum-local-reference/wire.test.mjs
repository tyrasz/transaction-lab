import test from 'node:test';import assert from 'node:assert/strict';import {performance} from 'node:perf_hooks';
import {captureHttp,proofTransport,sha} from './wire.mjs';
import {createRpcStateInputs} from './runtime/engines/local-evm/rpc-state-inputs.js';
const response=body=>new Response(body,{status:200,headers:{'content-type':'application/json'}});
const run=(fetchImpl,extra={})=>captureHttp({url:'https://example.invalid',body:{x:1},deadline:performance.now()+1000,requestMs:100,responseBytes:1024,shared:{bytes:0,maxBytes:2048},fetchImpl,...extra});
test('exact bytes, invalidUTF8 and oversized observed prefixes remain distinguishable',async()=>{
  const ok=await run(async()=>response('{"x":2}'));assert.equal(ok.status,'completed');assert.equal(ok.transport.observedSha256,sha('{"x":2}'));
  const large=await run(async()=>response('123456'),{responseBytes:4});assert.equal(large.error,'response_byte_budget');assert.equal(large.transport.observedBytes,6);assert.equal(Buffer.from(large.rawBase64,'base64').length,4);
  const bad=await run(async()=>response(Uint8Array.from([0xff])));assert.equal(bad.status,'failed');assert.equal(bad.transport.observedSha256,sha(Buffer.from([0xff])));
});
test('ignored AbortSignal late fetch cannot mutate the sealed result',async()=>{let resolve;const late=await run(()=>new Promise(r=>resolve=r),{requestMs:5});const sealed=JSON.stringify(late);resolve(response('{"late":true}'));await new Promise(r=>setTimeout(r,15));assert.equal(JSON.stringify(late),sealed);assert.equal(late.error,'deadline');});
test('collector timeout drains a terminal transport save before snapshots and later attempts',async()=>{
  const header={hash:'0x'+'11'.repeat(32),stateRoot:'0x'+'22'.repeat(32)},shared={bytes:0,maxBytes:1024};let finishSave,lateFetch;
  const rpc=proofTransport({provider:{url:'https://example.invalid'},header,shared,deadline:performance.now()+1000,fetchImpl:()=>new Promise(r=>lateFetch=r),save:()=>new Promise(r=>finishSave=r)});
  const inputs=createRpcStateInputs({chainId:1,blockHash:header.hash,header,rpc,limits:{requestMs:5}});
  await assert.rejects(inputs.getAccount('0x'+'33'.repeat(20)));let drained=false;const draining=rpc.drain().then(()=>drained=true);
  await new Promise(r=>setTimeout(r,5));assert.equal(drained,false);assert.equal(rpc.records.length,1);assert.equal(rpc.records[0].error,'deadline');finishSave();await draining;
  const sealed=JSON.stringify({records:rpc.records,shared,inputs:inputs.snapshotInputs()});lateFetch(response('{"late":true}'));await new Promise(r=>setTimeout(r,10));assert.equal(JSON.stringify({records:rpc.records,shared,inputs:inputs.snapshotInputs()}),sealed);
});
