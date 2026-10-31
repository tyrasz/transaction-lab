// Fake fetch/read streams only. No network or execution clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapture,ENDPOINT} from './capture.mjs';
const options=(signal)=>({method:'POST',redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal});
test('captures exact request and complete response bytes before returning to current client',async()=>{
 const records=[],body=' {"jsonrpc":"2.0","id":1,"result":"0x1"}\n';
 const c=createCapture({kind:'local',wallMs:1000,save:(p,v)=>records.push({p,v}),fetchImpl:async()=>new Response(body)});
 const r=await c.fetch(ENDPOINT,options());assert.equal(await r.text(),body);assert.equal(records.length,1);assert.equal(records[0].v.requestText,options().body);
 assert.equal(Buffer.from(records[0].v.rawBase64,'base64').toString(),body);assert.equal(records[0].v.transport.complete,true);assert.equal((await c.drain()).complete,true);assert.equal(c.usage().pending,0);
});
test('error HTTP body remains raw evidence and client sees original HTTP status',async()=>{
 let saved;const c=createCapture({kind:'provider',wallMs:1000,save:(p,v)=>saved=v,fetchImpl:async()=>new Response('not json',{status:503})});
 const r=await c.fetch(ENDPOINT,options());assert.equal(r.status,503);assert.equal(await r.text(),'not json');assert.equal(saved.status,'failed');assert.equal(saved.httpStatus,503);assert.equal((await c.drain()).complete,true);
});
test('an ignored abort remains pending until actual fetch and body cancellation settle',async()=>{
 let finish;const pending=new Promise(r=>finish=r),records=[],controller=new AbortController();
 const c=createCapture({kind:'local',wallMs:1000,save:(p,v)=>records.push(v),fetchImpl:()=>pending});
 const response=c.fetch(ENDPOINT,options(controller.signal));setTimeout(()=>controller.abort(),5);await assert.rejects(response);assert.equal(records.length,1);
 assert.equal((await c.drain(5)).complete,false);finish(new Response('late body'));assert.equal((await c.drain(100)).complete,true);assert.equal(records[0].transport.retainedBytes,0);
});
test('late read bytes invalidate drainage without mutating already saved wire evidence',async()=>{
 let finishRead;const pendingRead=new Promise(r=>finishRead=r),controller=new AbortController();let saved;
 const c=createCapture({kind:'provider',wallMs:1000,save:(p,v)=>saved=structuredClone(v),fetchImpl:async()=>({ok:true,status:200,headers:new Headers(),body:{getReader:()=>({read:()=>pendingRead,cancel:async()=>{}})}})});
 const response=c.fetch(ENDPOINT,options(controller.signal));setTimeout(()=>controller.abort(),5);await assert.rejects(response);const before=JSON.stringify(saved);
 finishRead({done:false,value:Buffer.from('late')});await new Promise(r=>setImmediate(r));assert.equal((await c.drain(100)).complete,false);assert.equal(c.usage().unaccountedData,true);assert.equal(JSON.stringify(saved),before);await assert.rejects(c.fetch(ENDPOINT,options()));
});
test('only declared endpoint/read methods dispatch; failed persistence latches closure',async()=>{
 let calls=0;const c=createCapture({kind:'local',wallMs:1000,save:()=>{throw Error('disk failure');},fetchImpl:async()=>{calls++;return new Response('{}');}});
 await assert.rejects(c.fetch('https://example.org',options()));await assert.rejects(c.fetch(ENDPOINT,{...options(),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[]})}));assert.equal(calls,0);
 await assert.rejects(c.fetch(ENDPOINT,options()),/disk failure/);assert.equal((await c.drain()).complete,false);assert.equal(c.usage().saveFailed,true);await assert.rejects(c.fetch(ENDPOINT,options()));assert.equal(calls,1);
});

test('rejected body cancellation is not proof of drained network activity',async()=>{
 const c=createCapture({kind:'local',wallMs:1000,save:()=>{},fetchImpl:async()=>({ok:true,status:200,headers:new Headers(),body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{throw Error('cancel failed');}})}})});
 await c.fetch(ENDPOINT,options());const d=await c.drain(100);assert.equal(d.complete,false);assert.equal(d.cancelFailed,true);await assert.rejects(c.fetch(ENDPOINT,options()));
});
