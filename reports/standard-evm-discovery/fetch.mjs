import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const DIR=new URL('./',import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
const plan=JSON.parse(await readFile(new URL('plan.json',DIR))),input=JSON.parse(process.argv[2]);
assert.equal(new URL(input.url).protocol,'https:');assert.ok(!new URL(input.url).username&&!new URL(input.url).password);
assert.ok(input.kind==='get'||input.kind==='rpc');if(input.kind==='rpc')assert.ok(plan.allowedRpcMethods.includes(input.method));
let ledger;try{ledger=JSON.parse(await readFile(new URL('ledger.json',DIR)));}catch(e){if(e.code!=='ENOENT')throw e;ledger={startedAt:new Date().toISOString(),records:[],responseBytes:0};}
assert.ok(ledger.records.length<plan.limits.requests&&ledger.responseBytes<plan.limits.totalBytes,'Discovery budget exhausted.');
const n=ledger.records.length+1,name=String(n).padStart(3,'0'),request=input.kind==='rpc'?{jsonrpc:'2.0',id:n,method:input.method,params:input.params??[]}:null;
const record={number:n,startedAt:new Date().toISOString(),label:input.label??input.method??input.url,request:{url:input.url,method:input.kind==='get'?'GET':'POST',body:request},status:'started'};
ledger.records.push(record);await writeFile(new URL('ledger.json',DIR),JSON.stringify(ledger,null,2)+'\n');await mkdir(new URL('raw/',DIR),{recursive:true});
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),plan.limits.requestTimeoutMs);let bytes=Buffer.alloc(0);
try{
  const response=await fetch(input.url,{method:record.request.method,headers:{accept:'application/json,text/plain,text/html','user-agent':'TransactionLab-read-only-discovery/1.0',...(request?{'content-type':'application/json'}:{})},...(request?{body:JSON.stringify(request)}:{}),redirect:'error',signal:controller.signal});
  record.http={status:response.status,headers:Object.fromEntries(response.headers)};
  const chunks=[];for await(const chunk of response.body){const part=Buffer.from(chunk);chunks.push(part);bytes=Buffer.concat(chunks);if(bytes.length>plan.limits.responseBytes||ledger.responseBytes+bytes.length>plan.limits.totalBytes){controller.abort();throw new Error('Response byte budget exceeded.');}}
  record.status=response.ok?'http_success':'http_error';
  try{record.response=JSON.parse(bytes.toString('utf8'));}catch{record.responseKind='non_json';}
}catch(error){record.status='transport_or_budget_error';record.error={name:error.name,message:String(error.message).slice(0,300)};}
finally{clearTimeout(timer);record.finishedAt=new Date().toISOString();record.raw={file:'raw/'+name+'.body',bytes:bytes.length,sha256:sha(bytes)};ledger.responseBytes+=bytes.length;await writeFile(new URL(record.raw.file,DIR),bytes,{flag:'wx'});await writeFile(new URL('raw/'+name+'.json',DIR),JSON.stringify(record,null,2)+'\n',{flag:'wx'});await writeFile(new URL('ledger.json',DIR),JSON.stringify(ledger,null,2)+'\n');}
console.log(JSON.stringify({number:n,label:record.label,status:record.status,http:record.http?.status,bytes:bytes.length,responseError:record.response?.error,result:typeof record.response?.result==='string'?record.response.result.slice(0,500):undefined,resultItems:Array.isArray(record.response?.result)?record.response.result.length:undefined,error:record.error},null,2));
