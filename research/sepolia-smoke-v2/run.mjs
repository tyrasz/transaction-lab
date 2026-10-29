// One read-only public Sepolia smoke test. No keys, signatures or broadcasts.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createPublicClient, custom } from '../../engines/arbitrum-evm/node_modules/viem/_esm/index.js';
import { sepolia } from '../../engines/arbitrum-evm/node_modules/viem/_esm/chains/index.js';
import { simulateCalls } from '../../engines/arbitrum-evm/node_modules/viem/_esm/actions/public/simulateCalls.js';

const dir=new URL('./capture/',import.meta.url),endpoint='https://ethereum-sepolia-rpc.publicnode.com';
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n';
const sha=v=>createHash('sha256').update(v).digest('hex');
fs.mkdirSync(dir);const save=(name,value)=>fs.writeFileSync(new URL(name,dir),json(value),{flag:'wx'});
const started=Date.now(),wire=[],local=[],allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_getBalance','eth_getCode','eth_simulateV1','eth_call']);
save('plan.json',{at:new Date(started).toISOString(),endpoint,chainId:11155111,selection:'Reuse v1 selected wallet and exact block; revalidate unchanged balance/code',correction:'Permit the read-only eth_call requests used by viem native/token balance probes; v1 remains unchanged',priorManifestSha256:sha(fs.readFileSync(new URL('../sepolia-smoke-v1/capture/manifest.json',import.meta.url))),maximumRpcCalls:24,totalMs:120000,requestMs:15000,responseBytes:6291456,amountWei:'1000000000000000',recipient:'0x000000000000000000000000000000000000dead',providerRetries:0,readOnly:true,productSepoliaSupport:false,viemVersion:'2.57.13',sourceSha256:sha(fs.readFileSync(new URL(import.meta.url)))});
async function bounded(url,options){
 const remaining=120000-(Date.now()-started);assert(remaining>0,'Whole-test deadline');
 const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(Math.min(15000,remaining))});
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>6291456)throw Error('Response bound exceeded');chunks.push(chunk);}return{httpStatus:response.status,text:Buffer.concat(chunks).toString('utf8')};
}
async function request({method,params=[]}){
 assert(allowed.has(method),'Unapproved RPC method');assert(wire.length<24,'RPC limit');
 const body=JSON.stringify({jsonrpc:'2.0',id:wire.length+1,method,params}),row={id:wire.length+1,endpoint,requestText:body,requestSha256:sha(body),at:new Date().toISOString()};wire.push(row);
 try{const r=await bounded(endpoint,{method:'POST',headers:{'content-type':'application/json'},body});Object.assign(row,r,{responseSha256:sha(r.text)});assert.equal(r.httpStatus,200);const reply=JSON.parse(r.text);assert.equal(reply.id,row.id);if(reply.error)throw Object.assign(Error(reply.error.message),{code:reply.error.code});assert(Object.hasOwn(reply,'result'));return reply.result;}
 catch(e){row.error={name:e.name,message:e.message,code:e.code??null};throw e;}
 finally{save('rpc-'+String(row.id).padStart(2,'0')+'.json',row);}
}
const report={status:'unavailable',readOnly:true,privateKeyCreated:false,transactionsBroadcast:0,selection:null,product:null,viem:null,error:null};
try{
 assert.equal(await request({method:'eth_chainId'}),'0xaa36a7');
 const prior=JSON.parse(fs.readFileSync(new URL('../sepolia-smoke-v1/capture/results.json',import.meta.url))),priorHeader=JSON.parse(fs.readFileSync(new URL('../sepolia-smoke-v1/capture/header.json',import.meta.url)));
 const header=await request({method:'eth_getBlockByNumber',params:[priorHeader.number,false]});assert.deepEqual(header,priorHeader);save('header.json',header);
 const address=prior.selection.address,balance=await request({method:'eth_getBalance',params:[address,header.number]}),code=await request({method:'eth_getCode',params:[address,header.number]});assert.equal(BigInt(balance).toString(),prior.selection.balanceWei);assert.equal(code,'0x');assert(BigInt(balance)>=1000000000000000n);
 report.selection=prior.selection;save('selection.json',{source:'unchanged_v1_selection',selected:report.selection,revalidated:{balance,code}});
 const input={chainId:11155111,from:report.selection.address,to:'0x000000000000000000000000000000000000dead',data:'0x',value:'1000000000000000',gas:'21000',block:header.hash,queries:[{kind:'native_balance',account:report.selection.address},{kind:'native_balance',account:'0x000000000000000000000000000000000000dead'}]};save('product-request.json',input);
 try{const body=JSON.stringify(input),raw=await bounded('http://127.0.0.1:5174/api/evm/local-preview',{method:'POST',headers:{'content-type':'application/json'},body});report.product={...raw,response:JSON.parse(raw.text)};local.push({url:'http://127.0.0.1:5174/api/evm/local-preview',requestText:body,...raw});}catch(e){report.product={error:{name:e.name,message:e.message}};}
 save('product-response.json',report.product);
 const client=createPublicClient({chain:sepolia,ccipRead:false,cacheTime:0,batch:{multicall:false},transport:custom({request},{retryCount:0})});
 save('viem-request.json',{account:input.from,blockNumber:BigInt(header.number).toString(),calls:[{to:input.to,data:input.data,value:input.value,gas:input.gas,gasPrice:'0'}],traceAssetChanges:true,traceTransfers:true,validation:false});
 try{const result=await simulateCalls(client,{account:input.from,blockNumber:BigInt(header.number),calls:[{to:input.to,data:'0x',value:1000000000000000n,gas:21000n,gasPrice:0n}],traceAssetChanges:true,traceTransfers:true,validation:false});report.viem={status:'returned',result};}catch(e){report.viem={status:'failed',error:{name:e.name,message:e.message,code:e.code??null}};}
 save('viem-response.json',report.viem);
 const final=await request({method:'eth_getBlockByNumber',params:[header.number,false]});assert.deepEqual(final,header);report.headerUnchanged=true;
 report.status='completed';
}catch(e){report.error={name:e.name,message:e.message,code:e.code??null};}
finally{
 report.rpcCalls=wire.length;report.elapsedMs=Date.now()-started;save('local-transport.json',local);save('results.json',report);
 const files=fs.readdirSync(dir).sort().map(path=>{const b=fs.readFileSync(new URL(path,dir));return{path,bytes:b.length,sha256:sha(b)};});save('manifest.json',{files});
 console.log(json({status:report.status,selection:report.selection,product:report.product,viem:report.viem,rpcCalls:report.rpcCalls,error:report.error}));
}
