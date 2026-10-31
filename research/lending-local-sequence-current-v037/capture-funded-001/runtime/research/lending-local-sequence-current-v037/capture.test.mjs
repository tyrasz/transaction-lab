// Fake fetch/read/cancel promises only. No network, API or EVM execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCapture,ENDPOINT} from './capture.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const options=signal=>({method:'POST',redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal});
const text=' {"jsonrpc":"2.0","id":1,"result":"0x1"}\n';
function response({headers=new Headers(),getReader,cancel=async()=>{}}={}){
 let sent=false;
 return{ok:true,status:200,headers,body:{cancel,getReader:getReader??(()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:Buffer.from(text)}),cancel}))}};
}
function capture(fetchImpl){const saved=[];return{saved,c:createCapture({kind:'local',wallMs:1000,save:(p,v)=>saved.push({p,v:structuredClone(v)}),fetchImpl})};}

test('normal body remains byte-exact and is cancelled once with tracked complete drainage',async()=>{
 let cancelled=0;const{c,saved}=capture(async()=>response({cancel:async()=>{cancelled++;}}));
 assert.equal(await(await c.fetch(ENDPOINT,options())).text(),text);
 const d=await c.drain(100);assert.equal(d.complete,true);assert.equal(d.pending,0);assert.equal(cancelled,1);
 assert.equal(saved[0].p,'wire/0001.json');assert.equal(saved[0].v.requestText,options().body);
 assert.equal(Buffer.from(saved[0].v.rawBase64,'base64').toString(),text);
 assert.equal(saved[0].v.transport.retainedSha256,sha(Buffer.from(text)));assert.equal(saved[0].v.transport.complete,true);
 assert.deepEqual(c.usage().limits,{calls:260,bytes:32*1024*1024,responseBytes:8*1024*1024,requestMs:25000});
});

test('malformed HTTP headers close acquired unread body while retaining the exact empty failure record',async()=>{
 let cancelled=0;const{c,saved}=capture(async()=>response({headers:null,cancel:async()=>{cancelled++;}}));
 await assert.rejects(c.fetch(ENDPOINT,options()),/incomplete/);
 assert.equal((await c.drain(100)).complete,true);assert.equal(cancelled,1);assert.equal(saved.length,1);
 assert.equal(saved[0].v.httpStatus,200);assert.equal(saved[0].v.status,'failed');assert.equal(saved[0].v.error,'transport_or_encoding_error');
 assert.equal(saved[0].v.rawBase64,'');assert.equal(saved[0].v.transport.observedBytes,0);assert.equal(saved[0].v.transport.retainedSha256,sha(Buffer.alloc(0)));
 const bytes=JSON.stringify(saved);await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(saved),bytes);
});

test('getReader failure closes acquired unread body and does not fabricate response bytes',async()=>{
 let cancelled=0;const{c,saved}=capture(async()=>response({getReader:()=>{throw Error('reader refused');},cancel:async()=>{cancelled++;}}));
 await assert.rejects(c.fetch(ENDPOINT,options()),/incomplete/);
 const d=await c.drain(100);assert.equal(d.complete,true);assert.equal(d.pending,0);assert.equal(cancelled,1);
 assert.equal(saved[0].v.rawBase64,'');assert.equal(saved[0].v.transport.complete,false);assert.equal(saved[0].v.transport.observedBytes,0);
});

test('orphan cancellation rejection latches unavailable closure and prevents later requests',async()=>{
 let calls=0,cancelled=0;const{c,saved}=capture(async()=>{calls++;return response({headers:null,cancel:async()=>{cancelled++;throw Error('cancel rejected');}});});
 await assert.rejects(c.fetch(ENDPOINT,options()));
 const d=await c.drain(100);assert.equal(d.complete,false);assert.equal(d.cancelFailed,true);assert.equal(d.pending,0);assert.equal(cancelled,1);
 await assert.rejects(c.fetch(ENDPOINT,options()),/closed or exhausted/);assert.equal(calls,1);assert.equal(saved.length,1);assert.equal(saved[0].v.rawBase64,'');
});

test('pending cancellation cannot be reported drained even after managed fetch returned',async()=>{
 let resolveCancel,cancelled=0;const pending=new Promise(resolve=>{resolveCancel=resolve;});
 const{c,saved}=capture(async()=>response({cancel:()=>{cancelled++;return pending;}}));
 await c.fetch(ENDPOINT,options());const bytes=JSON.stringify(saved),first=await c.drain(5);
 assert.equal(first.complete,false);assert(first.pending>0);assert.equal(cancelled,1);
 resolveCancel();const second=await c.drain(100);assert.equal(second.complete,true);assert.equal(second.pending,0);assert.equal(cancelled,1);assert.equal(JSON.stringify(saved),bytes);
});

test('late fetch with throwing header access still cancels its acquired body after timeout',async()=>{
 let resolveFetch,cancelled=0;const pending=new Promise(resolve=>{resolveFetch=resolve;}),controller=new AbortController();
 const{c,saved}=capture(()=>pending),running=c.fetch(ENDPOINT,options(controller.signal));
 setTimeout(()=>controller.abort(),5);await assert.rejects(running);const bytes=JSON.stringify(saved);
 assert.equal((await c.drain(5)).complete,false);
 const late=response({cancel:async()=>{cancelled++;}});Object.defineProperty(late,'headers',{get(){throw Error('late malformed headers');}});
 resolveFetch(late);const d=await c.drain(100);assert.equal(d.complete,true);assert.equal(d.pending,0);assert.equal(cancelled,1);
 assert.equal(JSON.stringify(saved),bytes);assert.equal(saved[0].v.transport.observedBytes,0);
});
