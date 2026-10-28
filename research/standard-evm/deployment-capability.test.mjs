import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, appendFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadStandardApi } from '../../src/standard-loader.js';
import { capabilityRows, collectCapabilityRows, verifyCapabilityReference, freezeDeploymentCapability, checkDeploymentCapability, CAPABILITY_REFERENCE, CAPABILITY_POLICY, CAPABILITY_PROVIDERS } from './deployment-capability.mjs';
const ROOT=fileURLToPath(new URL('../..',import.meta.url)),referenceDirectory=join(ROOT,CAPABILITY_REFERENCE.directory);
const header=JSON.parse(await readFile(join(referenceDirectory,'selection.json'),'utf8')).header;
const rows=capabilityRows(header),sha=x=>createHash('sha256').update(x).digest('hex');
function response(request,result){return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200});}
function valueFor(row){return row.kind==='chain'?'0x1':row.kind.startsWith('header-')?header:row.kind==='callTracer'?{type:'CREATE',output:'0x',gasUsed:'0x1'}:row.kind==='prestateTracer'?{pre:{},post:{}}:{output:'0x',trace:[],stateDiff:{},vmTrace:null};}

test('matrix fixes all12 exact rows and distinguishes null, omitted and numeric state selectors',()=>{
 assert.equal(rows.length,12);assert.deepEqual(rows.map(x=>x.id),Array.from({length:12},(_,i)=>i+1));
 assert.deepEqual(rows.filter(x=>x.request.method==='debug_traceCall').map(x=>x.label),['debug-null-callTracer','debug-null-prestateTracer','debug-omitted-callTracer','debug-omitted-prestateTracer']);
 assert.equal(rows.filter(x=>x.request.method==='trace_call').length,2);
 assert.equal(rows.filter(x=>x.provider==='drpc').length,4);assert.equal(rows.filter(x=>x.provider==='publicnode').length,8);
 for(const row of rows){
  assert.equal(row.url,CAPABILITY_PROVIDERS[row.provider]);assert(!row.request.method.startsWith('eth_send'));
  if(row.kind==='parity'){assert.equal(row.request.params[0].to,null);assert.deepEqual(row.request.params.slice(1),[['trace','stateDiff'],header.number]);assert.equal(row.request.params.length,3);}
  if(row.request.method==='debug_traceCall'){
   assert.equal(Object.hasOwn(row.request.params[0],'to'),row.label.includes('-null-'));
   assert.deepEqual(row.request.params[1],{blockHash:header.hash,requireCanonical:true});
   assert.deepEqual(row.request.params[2].blockOverrides,{baseFeePerGas:'0x0'});assert.equal(Object.hasOwn(row.request.params[2],'stateOverrides'),false);
  }
 }
 assert.throws(()=>capabilityRows({...header,hash:'0x'+'00'.repeat(32)}),{code:'fixed_header_required'});
 assert(CAPABILITY_POLICY.wallMs+CAPABILITY_POLICY.terminalDrainMs<=CAPABILITY_POLICY.liveAndDrainCeilingMs);
});

test('sealed local success and all source-capture references verify without executing or querying providers',async()=>{
 const reference=await verifyCapabilityReference(referenceDirectory);
 assert.equal(reference.header.hash,header.hash);assert.equal(reference.target.senderNonceRaw,'1');
 assert.equal(reference.target.address,'0x3be7f950380997a5fbbd6ace42b422c7ef437f1b');
 assert.equal(reference.files.length,17);assert.equal(sha(reference.manifestBytes),CAPABILITY_REFERENCE.evidenceManifestSha256);
});

test('HTTP/RPC/malformed failures retain raw bytes and never prevent independent later rows',async()=>{
 const seen=[],saved=[];let unexpected=null;
 const result=await collectCapabilityRows({header,save:wire=>{saved.push(wire);},fetchImpl:async(url,options)=>{
  try{
   const request=JSON.parse(options.body),row=rows[seen.length];seen.push(request);
   assert.equal(url,row.url);assert.deepEqual(request,row.request);assert.equal(options.redirect,'error');
   if(row.id===3)return new Response('Required \'to\' is empty',{status:400});
   if(row.id===7)return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Synthetic method unavailable'}}));
   if(row.id===8)return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{},error:null}));
   return response(request,valueFor(row));
  }catch(error){unexpected=error;throw error;}
 }});
 assert.equal(unexpected,null);assert.equal(seen.length,12);assert.equal(saved.length,12);
 assert.equal(result.ledger.length,12);assert.equal(result.ledger.filter(x=>x.status==='failed').length,3);
 assert.deepEqual(result.ledger.filter(x=>x.status==='failed').map(x=>x.error),['http_error','rpc_error','jsonrpc_envelope']);
 assert.equal(Buffer.from(saved[2].rawBase64,'base64').toString(),'Required \'to\' is empty');
 let bytes=0;for(const wire of saved){const body=Buffer.from(wire.rawBase64,'base64');bytes+=body.length;assert.equal(wire.requestSha256,sha(wire.requestText));assert.equal(wire.responseSha256,sha(body));assert.equal(wire.transport.observedBytes,body.length);assert.equal(wire.transport.retainedSha256,sha(body));}
 assert.equal(result.usage.observedBytes,bytes);assert.equal(result.usage.dispatches,12);
 assert.equal(result.scope.accuracyEvaluated,false);assert.equal(result.scope.fiveChannelAgreement,false);assert.equal(result.scope.committedLogsVerified,false);
 assert(Object.values(result.binding).every(x=>x.completeHeaderEquality&&x.numericSelectorAtomicHashBinding===false));
});

test('complete header or chain disagreements cannot imply context binding even when tracing returns a result',async()=>{
 const result=await collectCapabilityRows({header,fetchImpl:async(url,options)=>{
  const request=JSON.parse(options.body),row=rows[request.id-1];
  return response(request,row.provider==='drpc'&&row.kind==='chain'?'0x2':row.provider==='publicnode'&&row.kind==='header-after'?{...header,unrecognizedField:'different'}:valueFor(row));
 }});
 assert.equal(result.usage.calls,12);assert.equal(result.binding.drpc.chain,'mismatched');assert.equal(result.binding.publicnode.afterHeader,'mismatched');
 assert(Object.values(result.binding).every(x=>!x.completeHeaderEquality));
 assert.equal(result.ledger.find(x=>x.label==='parity-null-trace-stateDiff').status,'returned');
});

test('shared and per-body bounds retain only the prefix, count observed bytes and prevent further dispatch',async()=>{
 let calls=0;const result=await collectCapabilityRows({header,limits:{responseBytes:32,totalBytes:128},fetchImpl:async()=>{calls++;return new Response('x'.repeat(256));}});
 assert.equal(calls,1);assert.equal(result.usage.observedBytes,256);assert.equal(result.records[0].transport.retainedBytes,32);
 assert.equal(result.records[0].transport.complete,false);assert.equal(result.ledger[0].error,'response_byte_budget');
 assert(result.ledger.slice(1).every(x=>x.status==='not_attempted'&&x.reason==='byte_budget'));
 await assert.rejects(collectCapabilityRows({header,limits:{calls:13},fetchImpl:async()=>{throw Error('must not dispatch');}}),{code:'invalid_limits'});
});

test('short timeout seals ignored cancellation and late completion cannot mutate saved evidence',async()=>{
 let finish,cancelled=0;const saved=[];
 const promise=collectCapabilityRows({header,limits:{calls:1,requestMs:5},save:row=>{saved.push(row);},fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
 const result=await promise,before=JSON.stringify(result),savedBefore=JSON.stringify(saved);
 assert.equal(result.records[0].error,'deadline');assert.equal(result.usage.calls,1);
 finish({body:{cancel(){cancelled++;return new Promise(()=>{});}}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancelled,1);assert.equal(JSON.stringify(result),before);assert.equal(JSON.stringify(saved),savedBefore);
 assert(result.ledger.slice(1).every(x=>x.status==='not_attempted'));
});

test('persistence failure and pre-abort preserve every denominator row with no later fetch',async()=>{
 let calls=0;const failed=await collectCapabilityRows({header,save:()=>{throw Error('disk failed');},fetchImpl:async(url,options)=>{calls++;return response(JSON.parse(options.body),'0x1');}});
 assert.equal(calls,1);assert.equal(failed.usage.saveFailure,true);assert.equal(failed.ledger[0].status,'persistence_failed');
 assert.equal(failed.ledger.length,12);assert(failed.ledger.slice(1).every(row=>row.reason==='artifact_save_failed'));
 const controller=new AbortController();controller.abort();const cancelled=await collectCapabilityRows({header,signal:controller.signal,fetchImpl:async()=>{throw Error('must not dispatch');}});
 assert.equal(cancelled.usage.dispatches,0);assert(cancelled.ledger.every(row=>row.status==='not_attempted'&&row.reason==='cancelled'));
});

test('disposable frozen packet runs its exact archived matrix once and binds copied reference bytes',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'deployment-capability-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const directory=join(temp,'packet'),implementation=(await loadStandardApi()).implementation;
 const frozen=await freezeDeploymentCapability({outputDirectory:directory,expectedProductSha256:implementation.sourceSha256});
 await checkDeploymentCapability({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
 const archived=await import(pathToFileURL(join(directory,'runtime/research/standard-evm/deployment-capability.mjs')));
 const originalFetch=globalThis.fetch,seen=[];let unexpected=null;
 globalThis.fetch=async(url,options)=>{
  try{
   const request=JSON.parse(options.body),row=rows[seen.length];seen.push(request);assert.equal(url,row.url);assert.deepEqual(request,row.request);
   const started=JSON.parse(await readFile(join(directory,'STARTED.json'),'utf8'));assert.equal(started.referenceEvidenceManifestSha256,CAPABILITY_REFERENCE.evidenceManifestSha256);
   const oldLocal=JSON.parse(await readFile(join(directory,'reference/local.json'),'utf8'));assert.equal(oldLocal.attempt.output.execution.status,'success');
   return response(request,valueFor(row));
  }catch(error){unexpected=error;throw error;}
 };
 try{
  const result=await archived.runDeploymentCapability({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
  assert.equal(unexpected,null);assert.equal(result.status,'sealed');assert.equal(result.usage.calls,12);assert.equal(result.sourceUnchanged,true);assert.equal(result.runtimeUnchanged,true);
  assert(result.ledger.every(row=>row.status==='returned'));assert.equal(result.scope.accuracyEvaluated,false);
  const before=seen.length;await assert.rejects(archived.runDeploymentCapability({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}),{code:'artifact_save_failed'});assert.equal(seen.length,before);
 }finally{globalThis.fetch=originalFetch;}
 const copied=join(directory,'reference/target.json');await chmod(copied,0o644);await appendFile(copied,'\n');
 await assert.rejects(checkDeploymentCapability({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}),{code:'reference_bytes_changed'});
});
