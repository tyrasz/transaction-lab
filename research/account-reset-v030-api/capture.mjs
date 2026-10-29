// Fixed synthetic development capture. No sockets, public RPC or VM reference.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createAppServer } from '../../src/server.js';
import { loadLocalApi } from '../../src/local-loader.js';
import { ProofRpcClient } from '../../src/proof-rpc.js';
import { RESET_TARGET, resetPreviewFixture } from '../../engines/local-evm/test/reset-preview-fixture.js';

const dir=new URL('./capture/',import.meta.url),sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=name=>readFile(new URL(name,dir));
const saved=new Map();
async function save(name,value){const body=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';await writeFile(new URL(name,dir),body,{flag:'wx'});saved.set(name,{path:name,bytes:Buffer.byteLength(body),sha256:sha(body)});}
const api=await loadLocalApi();assert(api);await api.assertSourcesUnchanged();
const sourcePaths=['research/account-reset-v030-api/capture.mjs','research/account-reset-v030-api/verify.mjs','engines/local-evm/test/reset-preview-fixture.js','engines/local-evm/test/shanghai-fixture.js','engines/local-evm/test/lifecycle-fixture.js','engines/local-evm/test/proof-fixture.js','reports/ethereum-proof-capability/capture.json','test/local-reset-preview.test.js'];
const sources=await Promise.all(sourcePaths.map(async path=>{const b=await readFile(new URL('../../'+path,import.meta.url));return{path,bytes:b.length,sha256:sha(b)};}));
async function stable(){await api.assertSourcesUnchanged();for(const row of sources){const b=await readFile(new URL('../../'+row.path,import.meta.url));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}}
await mkdir(dir);await save('declaration.json',{kind:'synthetic_api_development_check',createdAt:new Date().toISOString(),scope:'Two fixed already-tested reset fixtures through production handler/loader/child. No public RPC, signed transaction validation, independent client, accuracy rate or browser claim.',cases:[{id:'neutral',helperReverts:true},{id:'retaining',helperReverts:false}],implementation:api.implementation,sources,limits:{caseCount:2,rpcCallsPerCase:260,responseBytesPerRpc:8388608,wireBytesPerCase:33554432,wallMsPerCase:145000,drainMsPerCase:25000},handlerInvocation:'in_process_real_request_listener_no_socket'});
await save('STARTED.json',{startedAt:new Date().toISOString(),pid:process.pid,node:process.version});
const results=[];
try{
  for(const [id,helperReverts]of [['neutral',true],['retaining',false]]){
    await stable();await mkdir(new URL(id+'/',dir));
    const f=await resetPreviewFixture({helperReverts});
    const request={chainId:1,...f.request,block:f.header.hash,queries:[f.query,{kind:'native_balance',account:RESET_TARGET}]};
    await save(id+'/request.json',JSON.stringify(request));await save(id+'/fixture.json',{header:f.header,initialAllocation:f.allocation});
    const wire=[],errors=[];let finalHeaders=0,factories=0,status,responseText;
    const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(url,options)=>{
      try{
        assert.equal(String(url),'https://fixture.invalid/');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
        const requestText=String(options.body),q=JSON.parse(requestText);assert.equal(q.id,wire.length+1);let result;
        if(q.method==='eth_chainId'){assert.equal(q.id,1);assert.deepEqual(q.params,[]);result='0x1';}
        else if(q.method==='eth_getBlockByHash'){assert.equal(q.id,2);assert.deepEqual(q.params,[f.header.hash,false]);result=f.header;}
        else if(q.method==='eth_getBlockByNumber'){assert.equal(++finalHeaders,1);assert.deepEqual(q.params,[f.header.number,false]);result=f.header;}
        else{assert(['eth_getProof','eth_getCode'].includes(q.method));assert.deepEqual(q.params.at(-1),{blockHash:f.header.hash,requireCanonical:true});result=await f.rpc.call(q.method,q.params);}
        const responseText=JSON.stringify({jsonrpc:'2.0',id:q.id,result});wire.push({requestText,responseText});return new Response(responseText);
      }catch(error){errors.push(error.message);throw error;}
    }});
    const server=createAppServer({persist:false,localLoader:async()=>api,proofRpcFactory(){assert.equal(++factories,1);return rpc;},rpcFactory(){throw Error('Legacy RPC forbidden');},standardRpcFactory(){throw Error('Provider execution forbidden');}});
    const req=Readable.from([Buffer.from(JSON.stringify(request))]);Object.assign(req,{method:'POST',url:'/api/evm/local-preview',headers:{host:'127.0.0.1','content-type':'application/json'},aborted:false});
    const res=new EventEmitter();Object.assign(res,{statusCode:200,writableEnded:false,destroyed:false,writeHead(code){this.statusCode=code;return this;},end(value){status=this.statusCode;responseText=String(value);this.writableEnded=true;return this;}});
    const startedAt=new Date().toISOString();
    try{await server.listeners('request')[0](req,res);}finally{req.destroy();server.close();}
    await save(id+'/response.json',responseText);await save(id+'/proof-replies.json',wire);await save(id+'/handler.json',{method:'POST',path:req.url,status,startedAt,finishedAt:new Date().toISOString(),factories,finalHeaders,errors});
    const report=JSON.parse(responseText);results.push({id,httpStatus:status,status:report.status??null,execution:report.execution?.status??null,measurements:report.measurements??null,error:report.error??null,rpcCalls:wire.length,transportErrors:errors});
    await stable();
  }
}catch(error){results.push({id:'capture_error',message:error.message});}
let sourceUnchanged=true;try{await stable();}catch{sourceUnchanged=false;}
await save('results.json',{scope:'Fixed synthetic API checks only',sourceUnchanged,results});
for(const row of saved.values()){const b=await bytes(row.path);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
await writeFile(new URL('evidence-manifest.json',dir),JSON.stringify({schemaVersion:1,files:[...saved.values()].sort((a,b)=>a.path.localeCompare(b.path))},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceUnchanged,results:results.map(r=>({id:r.id,status:r.status,execution:r.execution,rpcCalls:r.rpcCalls})),manifestSha256:sha(await bytes('evidence-manifest.json'))},null,2));
