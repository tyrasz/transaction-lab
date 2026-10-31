// A fixed current local API call or its four raw reference requests. Import is inert.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {read,json,sha,checkRows,nodeIdentity,createLedger} from '../lending-local-sequence-current-v037/archive.mjs';
import {createCapture,ENDPOINT} from '../lending-local-sequence-current-v037/capture.mjs';
import {createCohortTransport,createCohortWireBudget} from '../standard-evm/cohort-wire.mjs';
import {oracleRequests} from '../ordinary-local-coverage-v1/outcomes.mjs';
const PREFIX='research/delegated-sender-current-v038';
const errorRecord=e=>({name:String(e?.name??'Error').slice(0,128),code:typeof e?.code==='string'?e.code.slice(0,256):null,message:String(e?.message??e).slice(0,2048)});
export async function boundedDrain(action,timeoutMs=25000){
 let timer;try{return await Promise.race([Promise.resolve().then(action).then(()=>({complete:true}),e=>({complete:false,error:errorRecord(e)})),new Promise(resolve=>{timer=setTimeout(()=>resolve({complete:false,error:{name:'Error',code:'DRAIN_TIMEOUT',message:'Actual I/O drain timed out'}}),timeoutMs);})]);}finally{clearTimeout(timer);}
}
export async function captureOracle({input,writer,fetchImpl=fetch}){
 const began=performance.now(),wallStart=Date.now(),controller=new AbortController(),capture=createCapture({kind:'provider',save:(p,v)=>{writer.save(p,v);},fetchImpl,wallMs:90000});
 const budget=createCohortWireBudget({limits:{calls:4,totalBytes:32*1024*1024,wallMs:90000}}),wire=createCohortTransport({budget,provider:'drpc',profile:'product',blockHash:input.header.hash,
  limits:{calls:4,totalBytes:32*1024*1024,wallMs:90000},save:r=>{writer.save(`cohort/${String(r.globalId).padStart(4,'0')}.json`,r);},fetchImpl:capture.fetch});
 const attempts=[];let error=null,cohortDrain,captureDrain;const timer=setTimeout(()=>{controller.abort();capture.cancel();},90000);
 try{for(const item of oracleRequests({request:input.request,header:input.header})){
  try{await wire.call(item.method,item.params,{signal:controller.signal});attempts.push({label:item.label,status:'returned'});}
  catch(e){attempts.push({label:item.label,status:'failed',code:String(e?.code??'oracle_unavailable').slice(0,256)});}
 }}catch(e){error=errorRecord(e);}
 finally{clearTimeout(timer);controller.abort();capture.cancel();[cohortDrain,captureDrain]=await Promise.all([boundedDrain(()=>wire.drain()),capture.drain(25000)]);}
 const records=wire.records();return{status:error?'threw':'returned',error,implementation:null,
  oracle:{dispatch:error===null&&attempts.length===4&&records.length===4&&attempts.every(a=>a.status==='returned')&&records.every(r=>r.status==='completed')?'completed':'unavailable',records,attempts,transportWireIds:records.map(r=>r.globalId),transportUsage:wire.usage(),transportDenied:wire.denied()},
  nativeCaptureUsage:capture.usage(),drain:{cohort:cohortDrain,capture:captureDrain,childClosure:true},elapsed:{wallMs:Date.now()-wallStart,monotonicMs:performance.now()-began}};
}
export async function workerMain(args=process.argv.slice(2)){
 const [planPath,indexText,kind,outDir,flag]=args,prepareOnly=flag==='--prepare-only';assert(args.length===4||args.length===5&&prepareOnly);assert(['local','oracle'].includes(kind));
 const plan=json(planPath),index=Number(indexText);assert(Number.isSafeInteger(index)&&index>=0&&index<2);if(!prepareOnly)assert.equal(fileURLToPath(import.meta.url),path.join(plan.runtimePath,PREFIX,'worker.mjs'),'Archived worker required');
 assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);const inputBytes=read(path.join(plan.inputBase,plan.inputs[index].path));assert.equal(sha(inputBytes),plan.inputs[index].sha256);const input=JSON.parse(inputBytes);
 const declarations=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'declarations.mjs'))),{validateTemplates,validateIntent,validateSelection}=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'run.mjs')));
 const original=declarations.originalTemplateBytes(plan.runtimePath),stored=validateTemplates(plan.inputBase,plan);assert.deepEqual(stored.templateBytes,original);
 if(prepareOnly){assert.equal(plan.phase,'offline_preparation');assert.deepEqual(plan.inputs,plan.templates);assert.deepEqual(input,stored.templates[index]);}
 else{const frozen=validateIntent(plan.inputBase,plan.intentSha256),selected=validateSelection(path.join(plan.inputBase,'selection'),plan.selectionManifestSha256,frozen.sourceBinding);assert(selected.usable);assert.equal(plan.phase,'selected_inputs_frozen');
  for(const k of['files','node','originalTemplates','templates'])assert.deepEqual(plan[k],frozen.intent[k]);assert.deepEqual(frozen.templateBytes,original);
  const bundle=declarations.deriveDeclarations({templateBytes:original,header:selected.report.selection.header});assert.deepEqual(json(path.join(plan.inputBase,'declarations.json')),bundle);assert.deepEqual(input,bundle.cases[index]);}
 assert.equal(input.id,plan.inputs[index].id);
 // Both preparation kinds validate only inputs and import the guarded local
 // loader. The oracle has no Standard API admission filter or execution call.
 const api=await(await import(pathToFileURL(path.join(plan.runtimePath,'src/local-loader.js')))).loadLocalApi();assert(api,'Current local API unavailable');
 const request=kind==='local'?input.localInput:oracleRequests({request:input.request,header:input.header}),normalized=kind==='local'?api.validateLocalSimulation(request):structuredClone(request);
 const writer=createLedger(outDir);writer.save('request.json',{id:input.id,index,kind,inputSha256:plan.inputs[index].sha256,request,normalized});
 const common={schemaVersion:1,id:input.id,index,kind,inputSha256:plan.inputs[index].sha256,workerPid:process.pid};
 if(prepareOnly){assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);await api.assertSourcesUnchanged();writer.save('report.json',{...common,status:'prepared_no_execution',executionInvoked:false,networkCalls:0,implementation:api.implementation});const manifestSha256=writer.seal();return{status:'prepared_no_execution',manifestSha256};}
 let result;
 if(kind==='oracle')result=await captureOracle({input,writer});
 else{
  const began=performance.now(),wallStart=Date.now(),controller=new AbortController(),capture=createCapture({kind:'local',save:(p,v)=>{writer.save(p,v);},wallMs:145000});
  const {ProofRpcClient}=await import(pathToFileURL(path.join(plan.runtimePath,'src/proof-rpc.js'))),rpc=new ProofRpcClient({url:ENDPOINT,chainId:1,fetchImpl:capture.fetch});let report=null,error=null,rpcDrain,captureDrain;
  const timer=setTimeout(()=>{controller.abort();capture.cancel();try{rpc.cancel?.();}catch{}},145000);
  try{report=await api.simulateLocal(request,rpc,{signal:controller.signal});}catch(e){error=errorRecord(e);}
  finally{clearTimeout(timer);controller.abort();capture.cancel();try{rpc.cancel?.();}catch{}[rpcDrain,captureDrain]=await Promise.all([rpc.drain({timeoutMs:25000}).catch(e=>({complete:false,error:errorRecord(e)})),capture.drain(25000)]);}
  const attempt=report?.attempt,childClosure=!attempt||attempt.broker?.pendingAtReturn===0&&(!attempt.isolation?.childPid||attempt.isolation.processClosed===true);
  result={status:error?'threw':'returned',report,error,implementation:api.implementation,rpcEvidence:rpc.snapshotEvidence(),rpcUsage:rpc.usage(),captureUsage:capture.usage(),drain:{rpc:rpcDrain,capture:captureDrain,childClosure},elapsed:{wallMs:Date.now()-wallStart,monotonicMs:performance.now()-began}};
 }
 let sourceUnchanged=false;try{assert.deepEqual(nodeIdentity(),plan.node);checkRows(plan.runtimePath,plan.files);await api.assertSourcesUnchanged();sourceUnchanged=true;}catch{}
 writer.save('report.json',{...common,...result,sourceUnchanged,scope:{currentGuardedLocalApi:kind==='local',rawFourRequestOracle:kind==='oracle',httpApi:false,ui:false,endpoint:ENDPOINT,originalGas:5000000,localQueriesCompared:false,expectedPoststateConsumed:false,otherClientOutputsConsumed:false}});
 const manifestSha256=writer.seal();return{status:'captured',manifestSha256};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await workerMain()));
