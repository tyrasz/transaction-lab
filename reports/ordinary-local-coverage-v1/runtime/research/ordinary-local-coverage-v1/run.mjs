import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './freeze.mjs';
import { createArtifactWriter, sealEvidence } from './artifacts.mjs';
import { createCohortTransport, createCohortWireBudget, COHORT_PROVIDERS } from '../standard-evm/cohort-wire.mjs';
import { collectProspectiveCensus, COLLECTOR_LIMITS } from '../standard-evm/cohort-collector.mjs';
import { classifyCohortIntents } from '../standard-evm/cohort-classification.mjs';
import { accountCohortOutcomes } from '../standard-evm/cohort-accounting.mjs';
import { projectSelectedCase, oracleRequests, adjudicateLocalOutcome } from './case.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const PREFIX='research/ordinary-local-coverage-v1';
const sha=v=>createHash('sha256').update(v).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
export const POLICY=Object.freeze({chainId:1,sampleSize:16,targetOffsets:[1,2],finalityWaitMs:1200000,ancestryHeadersPerProvider:256,
  totalCalls:6144,totalResponseBytes:512*1024*1024,responseBytes:8*1024*1024,requestMs:25000,
  collectionAndExecutionMs:3600000,terminalDrainMs:25000,maxWaitOverrunMs:60000,
  localCalls:256,oracleCalls:65,slotCalls:384,localResponseBytes:32*1024*1024,oracleResponseBytes:32*1024*1024,
  localWallMs:145000,oracleWallMs:145000,retries:0,replacements:0,providerFallback:false});
export const SCOPE=Object.freeze({execution:'current_isolated_local_product_engine_unsigned_unpriced_parent_block_end',
  evaluatedProduct:'archived_isolated_local_engine_not_HTTP_API',oracle:'separate_raw_provider_trace_and_diff',
  providerContextExecutionAttested:false,feesSettled:false,originalTransactionReplay:false,assetInventoryEvaluated:false,
  apiAvailabilityEvaluated:false,securityAccuracyEvaluated:false,consensusVerified:false,
  populationInference:'descriptive_two_future_blocks_only',timing:'60min_absolute_and_monotonic_window_plus25s_drain_offline_seal_excluded',
  awakeWrapper:'/usr/bin/caffeinate -i may wrap the parent; no immunity to manual suspension and no deadline extension'});
const REQUIRED=['run.mjs','freeze.mjs','verify.mjs','artifacts.mjs','case.mjs','projection.mjs','outcomes.mjs','PLAN.md'].map(n=>PREFIX+'/'+n);
function json(path,max=8*1024*1024){const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=max,'artifact_invalid');const bytes=readFileSync(path);return{bytes,value:JSON.parse(bytes)};}
export function classificationInput(census){return{chainId:1,census:census.census,envelopes:census.envelopes.map(r=>({transactionHash:r.transactionHash,blockHash:r.blockHash,blockNumber:r.blockNumber,transactionIndex:r.transactionIndex,from:r.normalizedEnvelope.from,to:r.normalizedEnvelope.to,input:r.normalizedEnvelope.input,value:r.normalizedEnvelope.value}))};}
export async function freezeRun({repoRoot=ROOT,outputDirectory}){
  for(const p of REQUIRED)need(lstatSync(join(repoRoot,p)).isFile(),'source_missing');
  const frozen=await freezeCohortSources({repoRoot,outputDirectory}),write=createArtifactWriter(frozen.outputDirectory).write;
  const plan={schemaVersion:'1.0',title:'Current local Ethereum engine prospective 16-slot coverage pilot',frozenAt:new Date().toISOString(),seed:'0x'+randomBytes(32).toString('hex'),
    policy:POLICY,scope:SCOPE,providers:COHORT_PROVIDERS,collectorLimits:COLLECTOR_LIMITS,sourceManifestSha256:frozen.manifestSha256,localImplementation:frozen.manifest.localImplementation,runtime:frozen.manifest.runtime};
  write('plan.json',plan);const planSha256=sha(readFileSync(join(frozen.outputDirectory,'plan.json')));
  write('FROZEN.json',{schemaVersion:'1.0',frozenAt:plan.frozenAt,planSha256,sourceManifestSha256:frozen.manifestSha256,publicDispatches:0});
  await loadPlan({outputDirectory:frozen.outputDirectory,expectedPlanSha256:planSha256});
  return{outputDirectory:frozen.outputDirectory,planSha256,sourceManifestSha256:frozen.manifestSha256,publicDispatches:0};
}
export async function loadPlan({outputDirectory,expectedPlanSha256}){
  need(typeof expectedPlanSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedPlanSha256),'explicit_plan_hash_required');
  const directory=realpathSync(resolve(outputDirectory)),p=json(join(directory,'plan.json')),plan=p.value;
  need(sha(p.bytes)===expectedPlanSha256&&plan.schemaVersion==='1.0'&&/^0x[a-f0-9]{64}$/.test(plan.seed),'plan_differs');
  need(equal(plan.policy,POLICY)&&equal(plan.scope,SCOPE)&&equal(plan.providers,COHORT_PROVIDERS)&&equal(plan.collectorLimits,COLLECTOR_LIMITS),'policy_differs');
  const source=await verifyFrozenSources({outputDirectory:directory,expectedManifestSha256:plan.sourceManifestSha256});
  need(REQUIRED.every(p=>source.manifest.files.some(f=>f.path===p&&f.kind==='file')),'source_missing');
  need(equal(plan.localImplementation,source.manifest.localImplementation)&&equal(plan.runtime,source.manifest.runtime),'implementation_differs');
  need(equal(json(join(directory,'FROZEN.json')).value,{schemaVersion:'1.0',frozenAt:plan.frozenAt,planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0}),'frozen_differs');
  return{directory,plan,source};
}
export function createTimingGate({wallStart=Date.now(),monotonicStart=performance.now(),now=Date.now,monotonic=()=>performance.now()}={}){
  let last=wallStart,violation=null;
  function remaining(){const at=now(),mono=monotonic();if(!Number.isSafeInteger(at)||at<last||!Number.isFinite(mono)||mono<monotonicStart)violation??={code:'clock_invalid',at};last=at;return violation?0:Math.max(0,Math.floor(Math.min(POLICY.collectionAndExecutionMs-(at-wallStart),POLICY.collectionAndExecutionMs-(mono-monotonicStart))));}
  return Object.freeze({remaining,violation:()=>structuredClone(violation),checkWait(deadline){const at=now();remaining();if(at-deadline>POLICY.maxWaitOverrunMs)violation??={code:'wait_overrun',at,deadline,overrunMs:at-deadline};need(!violation&&remaining()>0,violation?.code??'absolute_deadline');}});
}
export function unsupportedOutcome(transactionHash,reasons){return{outcome:{transactionHash,execution:'unsupported',comparison:'not_comparable'},channels:{},reasons:[...reasons],allChannelsComplete:false};}
const compact=value=>({...value,channels:Object.fromEntries(Object.entries(value.channels).map(([k,v])=>[k,{status:v.status,...(v.reason?{reason:v.reason}:{})}]))});
export async function executeCases({census,implementation,executeLocal,executeOracle,save,hashArtifact,canAttempt,assertHealthy}){
  const rows=[];let fatal=null;
  for(let i=0;i<census.selected.length;i++){
    const row=census.selected[i],id=String(i+1).padStart(3,'0');let projection=null;
    if(fatal){rows.push({id,transactionHash:row.transactionHash,projection,adjudication:{outcome:{transactionHash:row.transactionHash,execution:'budget_unattempted',comparison:'budget_unattempted'},channels:{},reasons:['Prior integrity failure stopped dispatch; no replacement'],allChannelsComplete:false}});continue;}
    try{
    projection=projectSelectedCase({row,census});
    const request={transactionHash:row.transactionHash,parentHeader:row.parentHeader,projection};save(`cases/${id}/request.json`,request);
    let local,oracle,outcome;
    if(projection.status==='unsupported'){
      local={dispatch:'unsupported',implementation,attempt:null,transportWireIds:[],reason:projection.reasons.join(', ')};
    }else{
      assertHealthy();local=canAttempt()?await executeLocal({id,request:projection.request,header:row.parentHeader}):{dispatch:'budget_unattempted',implementation,attempt:null,transportWireIds:[],reason:'Run budget prevented local execution'};
    }
    save(`cases/${id}/local.json`,local);
    const identity=hashArtifact(`cases/${id}/local.json`);
    save(`cases/${id}/LOCAL_SEALED.json`,{schemaVersion:'1.0',...identity,wireIds:local.transportWireIds,lastWireId:local.transportWireIds.at(-1)??null,at:new Date().toISOString()});
    if(projection.status==='unsupported'){
      oracle={dispatch:'unsupported',records:[],transportWireIds:[],reason:'Unsupported local projection; no oracle attempted'};outcome=unsupportedOutcome(row.transactionHash,projection.reasons);
    }else{
      assertHealthy();oracle=canAttempt()?await executeOracle({id,request:projection.request,header:row.parentHeader}):{dispatch:'budget_unattempted',records:[],transportWireIds:[],reason:'Run budget prevented oracle collection'};
      outcome=await adjudicateLocalOutcome({transactionHash:row.transactionHash,request:projection.request,header:row.parentHeader,expectedLocalImplementation:implementation,local,oracle});
    }
    save(`cases/${id}/oracle.json`,oracle);save(`cases/${id}/outcome.json`,outcome);
    rows.push({id,transactionHash:row.transactionHash,projection,localArtifact:`cases/${id}/local.json`,oracleArtifact:`cases/${id}/oracle.json`,adjudication:compact(outcome)});
    }catch(error){fatal={caseId:id,code:['artifact_save_failed','transport_drain_incomplete','local_drain_incomplete'].includes(error?.code)?error.code:'case_integrity_failure'};rows.push({id,transactionHash:row.transactionHash,projection,adjudication:{outcome:{transactionHash:row.transactionHash,execution:'provider_unavailable',comparison:'not_comparable'},channels:{},reasons:['Case could not retain a complete verified result'],allChannelsComplete:false}});}
  }
  try{assertHealthy();}catch{fatal??={caseId:null,code:'final_health_failure'};}
  const accounting=accountCohortOutcomes(census.selection,rows.map(r=>r.adjudication.outcome));
  return{status:fatal?'interrupted':'complete',fatal,rows,accounting:fatal?null:accounting,interruptedLedger:fatal?accounting.ledger:null};
}
export function withholdCaseMetrics(caseRun){return caseRun?{...caseRun,status:'interrupted',accounting:null,interruptedLedger:caseRun.accounting?.ledger??caseRun.interruptedLedger}:null;}
async function finiteDrain(transports,ms){let timer;try{return await Promise.race([Promise.allSettled([...transports].map(t=>t.drain())).then(results=>results.every(r=>r.status==='fulfilled')),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}}
export async function runFrozen({outputDirectory,expectedPlanSha256}){
  const{directory,plan}=await loadPlan({outputDirectory,expectedPlanSha256});
  need(resolve(fileURLToPath(import.meta.url))===join(directory,'runtime',PREFIX,'run.mjs'),'archived_entrypoint_required');await verifyNodeRuntime(plan.runtime);
  const{executeIsolatedEthereumCall}=await import('../../engines/local-evm/isolated-call.js');
  const writer=createArtifactWriter(directory),startedAt=new Date().toISOString(),gate=createTimingGate(),budget=createCohortWireBudget(),controller=new AbortController();
  const began=performance.now(),transports=new Set();
  let captureClosed=false,eventId=0,selection=null,caseRun=null,sourceUnchanged=false,runtimeUnchanged=false;const failures=[];
  const save=(path,value)=>{need(!captureClosed,'capture_closed');writer.write(path,value);};
  save('STARTED.json',{schemaVersion:'1.0',planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,startedAt,pid:process.pid,runtime:plan.runtime});
  const timer=setTimeout(()=>controller.abort(),POLICY.collectionAndExecutionMs);
  const health=()=>need(!writer.failed&&!budget.snapshot().saveFailure,'artifact_save_failed');
  const canAttempt=()=>{health();const b=budget.snapshot();return!controller.signal.aborted&&gate.remaining()>1000&&b.calls<POLICY.totalCalls&&b.observedBytes<POLICY.totalResponseBytes;};
  const sourceCheck=()=>loadPlan({outputDirectory:directory,expectedPlanSha256});
  function transport(profile,hash,header,provider='drpc'){
    const wire=createCohortTransport({budget,profile,provider,...(hash?{blockHash:hash}:{}),...(header?{header}:{}),save:r=>save(`wire/${String(r.globalId).padStart(6,'0')}.json`,r)});
    transports.add(wire);return wire;
  }
  async function finish(wire,phaseController){phaseController.abort();const drained=await finiteDrain([wire],POLICY.terminalDrainMs);need(drained,'transport_drain_incomplete');health();transports.delete(wire);}
  try{
    const censusTransports={drpc:transport('census'),publicnode:transport('census',undefined,undefined,'publicnode')};
    const gated=Object.fromEntries(Object.entries(censusTransports).map(([name,t])=>[name,{call:async(method,params,options)=>{need(canAttempt(),'absolute_deadline');const r=await t.call(method,params,options);need(gate.remaining()>0,'absolute_deadline');return r;}}]));
    selection=await collectProspectiveCensus({transports:gated,seed:plan.seed,sampleSize:16,signal:controller.signal,
      waitUntil:async(deadline,{signal})=>{await delay(Math.max(1,deadline-Date.now()),undefined,{signal});gate.checkWait(deadline);},
      save:e=>save(`events/${String(++eventId).padStart(5,'0')}.json`,e)});
    need(await finiteDrain(Object.values(censusTransports),POLICY.terminalDrainMs),'transport_drain_incomplete');health();Object.values(censusTransports).forEach(t=>transports.delete(t));save('selection.json',selection);
    if(selection.status==='complete'){
      save('classification.json',classifyCohortIntents(classificationInput(selection.census)));
      caseRun=await executeCases({census:selection.census,implementation:plan.localImplementation,save,canAttempt,assertHealthy:health,
        hashArtifact:path=>{const{bytes}=json(join(directory,path),256*1024*1024);return{path,bytes:bytes.length,sha256:sha(bytes)};},
        executeLocal:async({request,header})=>{
          await sourceCheck();health();const wire=transport('local',header.hash,header),phaseController=new AbortController(),signal=AbortSignal.any([controller.signal,phaseController.signal]);
          let attempt=null,reason;
          try{attempt=await executeIsolatedEthereumCall({request,header,rpc:{call:(m,p,o)=>{need(canAttempt(),'absolute_deadline');return wire.call(m,p,{...o,signal:AbortSignal.any([signal,...(o?.signal?[o.signal]:[])])});}},signal,limits:{wallMs:Math.max(1,Math.min(POLICY.localWallMs,gate.remaining())),drainMs:POLICY.terminalDrainMs}});}
          catch{reason='Local engine invocation failed without a complete retained attempt';}
          await finish(wire,phaseController);
          if(attempt)need(attempt.broker?.pendingAtReturn===0&&(!attempt.isolation?.childPid||attempt.isolation.processClosed),'local_drain_incomplete');
          need(attempt||wire.records().length===0,'local_invocation_incomplete');
          await sourceCheck();return{dispatch:attempt?.status==='completed'?'completed':'unavailable',implementation:plan.localImplementation,attempt,...(reason?{reason}:{}),transportWireIds:wire.records().map(r=>r.globalId),transportUsage:wire.usage(),transportDenied:wire.denied()};
        },
        executeOracle:async({request,header})=>{
          await sourceCheck();health();const wire=transport('product',header.hash),phaseController=new AbortController(),signal=AbortSignal.any([controller.signal,phaseController.signal]);
          const attempts=[];for(const item of oracleRequests({request,header})){
            if(!canAttempt())break;
            try{await wire.call(item.method,item.params,{signal});attempts.push({label:item.label,status:'returned'});}catch(error){attempts.push({label:item.label,status:'failed',code:error?.code??'oracle_unavailable'});health();}
          }
          await finish(wire,phaseController);await sourceCheck();const records=wire.records();
          return{dispatch:attempts.length===oracleRequests({request,header}).length&&records.every(r=>r.status==='completed')?'completed':'unavailable',records,attempts,transportWireIds:records.map(r=>r.globalId),transportUsage:wire.usage(),transportDenied:wire.denied()};
        }});
    }
  }catch(error){failures.push({code:['artifact_save_failed','transport_drain_incomplete','local_drain_incomplete'].includes(error?.code)?error.code:'capture_interrupted'});}
  finally{clearTimeout(timer);controller.abort();if(!await finiteDrain(transports,POLICY.terminalDrainMs))failures.push({code:'transport_drain_incomplete'});}
  const executionWindowMs=performance.now()-began;captureClosed=true;
  try{await sourceCheck();sourceUnchanged=true;}catch{failures.push({code:'source_drift'});}try{await verifyNodeRuntime(plan.runtime);runtimeUnchanged=true;}catch{failures.push({code:'runtime_drift'});}
  if(writer.failed||budget.snapshot().saveFailure)failures.push({code:'artifact_save_failed'});
  const status=failures.length||caseRun?.status==='interrupted'?'interrupted':selection?.status==='complete'&&caseRun?'complete':'selection_failed';
  const results={schemaVersion:'1.0',status,planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,sourceUnchanged,runtimeUnchanged,selectionStatus:selection?.status??null,
    caseRun:failures.length?withholdCaseMetrics(caseRun):caseRun,budget:budget.snapshot(),timingViolation:gate.violation(),startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-began,executionWindowMs,failures,scope:plan.scope};
  writer.write('results.json',results);const evidence=sealEvidence(directory,expectedPlanSha256,plan.sourceManifestSha256);return{...results,evidence};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const[command,directory,expected]=process.argv.slice(2);
  if(command==='freeze'&&directory&&!expected)console.log(JSON.stringify(await freezeRun({outputDirectory:directory}),null,2));
  else if(command==='check'&&directory&&expected){const p=await loadPlan({outputDirectory:directory,expectedPlanSha256:expected});console.log(JSON.stringify({status:'verified',planSha256:expected,sourceManifestSha256:p.plan.sourceManifestSha256}));}
  else if(command==='run'&&directory&&expected){const p=await loadPlan({outputDirectory:directory,expectedPlanSha256:expected});const archived=await import(pathToFileURL(join(p.directory,'runtime',PREFIX,'run.mjs')));console.log(JSON.stringify(await archived.runFrozen({outputDirectory:p.directory,expectedPlanSha256:expected}),null,2));}
  else throw Error('Use freeze DIR, check DIR PLAN_SHA, or run DIR PLAN_SHA; no public dispatch without reviewed explicit plan.');
}
