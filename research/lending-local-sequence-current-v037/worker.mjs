// Single current API adapter invocation. --prepare-only never creates a client,
// calls an execution API, or performs network I/O.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {read,json,sha,checkRows,nodeIdentity,createLedger} from './archive.mjs';
import {createCapture,ENDPOINT} from './capture.mjs';
const PREFIX='research/lending-local-sequence-current-v037';
const [planPath,indexText,kind,outDir,flag]=process.argv.slice(2),prepareOnly=flag==='--prepare-only';
assert(process.argv.length===6||process.argv.length===7&&prepareOnly);assert(['local','provider'].includes(kind));
const plan=json(planPath),index=Number(indexText);assert(Number.isSafeInteger(index)&&index>=0&&index<2);
if(!prepareOnly)assert.equal(fileURLToPath(import.meta.url),path.join(plan.runtimePath,PREFIX,'worker.mjs'),'Archived worker required');
assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);
const inputPath=path.join(plan.inputBase,plan.inputs[index].path),inputBytes=read(inputPath);assert.equal(sha(inputBytes),plan.inputs[index].sha256);const input=JSON.parse(inputBytes);
const {readPinnedTemplates,deriveCurrentDeclarations,HISTORICAL_TEMPLATES}=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'declarations.mjs')));
const templates=HISTORICAL_TEMPLATES.files.map(r=>read(path.join(plan.runtimePath,r.path)));readPinnedTemplates(templates);
if(prepareOnly){assert.equal(plan.phase,'offline_preparation');assert.deepEqual(input,readPinnedTemplates(templates)[index]);}
else{
 const {validateIntent,validateSelection}=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'run.mjs')));
 const frozen=validateIntent(plan.inputBase,plan.intentSha256),selected=validateSelection(path.join(plan.inputBase,'selection'),plan.selectionManifestSha256,frozen.sourceBinding);assert(selected.usable);assert.equal(plan.phase,'selected_inputs_frozen');assert.deepEqual(plan.files,frozen.intent.files);assert.deepEqual(plan.node,frozen.intent.node);
 assert.deepEqual(frozen.templateBytes,templates);const bundle=deriveCurrentDeclarations({templateBytes:templates,selection:selected.report.selection});assert.deepEqual(json(path.join(plan.inputBase,'declarations.json')),bundle);assert.deepEqual(input,bundle.cases[index]);
}
assert.equal(input.id,plan.inputs[index].id);
const api=kind==='local'?await (await import(pathToFileURL(path.join(plan.runtimePath,'src/local-loader.js')))).loadLocalApi():await (await import(pathToFileURL(path.join(plan.runtimePath,'src/standard-loader.js')))).loadStandardApi();assert(api,'Current API unavailable');
const request=kind==='local'?input.localInput:input.providerInput,normalized=api[kind==='local'?'validateLocalSequence':'validateStandardSequence'](request);
const writer=createLedger(outDir);writer.save('request.json',{id:input.id,kind,inputSha256:plan.inputs[index].sha256,request,normalized});
if(prepareOnly){
 assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);
 writer.save('report.json',{schemaVersion:1,id:input.id,kind,inputSha256:plan.inputs[index].sha256,workerPid:process.pid,status:'prepared_no_execution',executionInvoked:false,networkCalls:0,implementation:api.implementation});
 const manifestSha256=writer.seal();console.log(JSON.stringify({status:'prepared_no_execution',manifestSha256}));
}else{
 const began=performance.now(),wallStart=Date.now(),controller=new AbortController(),apiWallMs=kind==='local'?145000:265000;
 const capture=createCapture({kind,save:(p,v)=>writer.save(p,v),wallMs:apiWallMs});
 const {ProofRpcClient}=await import(pathToFileURL(path.join(plan.runtimePath,'src/proof-rpc.js')));
 const {StandardRpcClient}=await import(pathToFileURL(path.join(plan.runtimePath,'src/standard-rpc.js')));
 const rpc=kind==='local'?new ProofRpcClient({url:ENDPOINT,chainId:input.chainId,fetchImpl:capture.fetch}):new StandardRpcClient({url:ENDPOINT,profile:'sequence',fetchImpl:capture.fetch});
 let report=null,error=null,sourceUnchanged=false,rpcDrain=null,captureDrain=null;
 const timer=setTimeout(()=>{controller.abort();capture.cancel();try{rpc.cancel?.();}catch{}},apiWallMs);
 try{report=await api[kind==='local'?'simulateLocalSequence':'simulateStandardSequence'](request,rpc,{signal:controller.signal});}
 catch(e){error={name:String(e?.name??'Error').slice(0,128),code:typeof e?.code==='string'?e.code:null,message:String(e?.message??e).slice(0,2048)};}
 finally{clearTimeout(timer);controller.abort();capture.cancel();try{rpc.cancel?.();}catch{}
  [rpcDrain,captureDrain]=await Promise.all([kind==='local'?rpc.drain({timeoutMs:25000}).catch(e=>({complete:false,error:String(e)})):Promise.resolve({complete:true,kind:'actual_IO_tracked_by_capture'}),capture.drain(25000)]);}
 try{assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);if(kind==='local')await api.assertSourcesUnchanged();sourceUnchanged=true;}catch{}
 const attempt=report?.attempt,childClosure=kind!=='local'||!attempt?true:attempt.broker?.pendingAtReturn===0&&(!attempt.isolation?.childPid||attempt.isolation.processClosed===true);
 const elapsed={wallMs:Date.now()-wallStart,monotonicMs:performance.now()-began};
 writer.save('report.json',{schemaVersion:1,id:input.id,kind,inputSha256:plan.inputs[index].sha256,workerPid:process.pid,status:error?'threw':'returned',report,error,
  implementation:api.implementation,rpcEvidence:rpc.snapshotEvidence(),rpcUsage:typeof rpc.usage==='function'?rpc.usage():{calls:rpc.evidence.length,observedBytes:rpc.observedBytes,retainedBytes:rpc.retainedBytes,limits:rpc.limits},
  captureUsage:capture.usage(),drain:{rpc:rpcDrain,capture:captureDrain,childClosure},sourceUnchanged,elapsed,
  scope:{currentGuardedApi:true,httpApi:false,ui:false,endpoint:ENDPOINT,originalGas:5000000,localQueryGas:1000000,providerQueryGas:300000,expectedPoststateConsumed:false,otherClientOutputsConsumed:false}});
 const manifestSha256=writer.seal();console.log(JSON.stringify({status:'captured',manifestSha256}));
}
