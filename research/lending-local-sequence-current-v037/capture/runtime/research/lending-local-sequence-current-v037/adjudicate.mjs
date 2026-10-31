// Saved bytes only. No worker, execution API, EVM, RPC, or network is invoked.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,json,sha,walk,checkRows,nodeIdentity,verifyPacket,entry} from './archive.mjs';
import {PREFIX,LIMITS,AGGREGATE_LIMITS,SCOPE,ORDER,sourceRows,validateIntent,validateSelection,validateReport,validateProcessRecord,validateWireDirectory} from './run.mjs';
import {deriveCurrentDeclarations,CURRENT_DENOMINATOR} from './declarations.mjs';
import {assertFirstTargetFresh} from './selection.mjs';
import {compareLendingSequence,ORIGINAL_CHANNELS,QUERY_CHANNELS} from '../lending-local-sequence-v037/observations.mjs';
const n=i=>String(i+1).padStart(3,'0');
const reason=e=>String(e?.message??e).slice(0,1024);
const counts=values=>({matched:values.filter(v=>v===true).length,mismatched:values.filter(v=>v===false).length,unavailable:values.filter(v=>v===null).length});
export function comparisonCounts(rows){
 const original=[],queries=[];for(const row of rows){assert.equal(row.steps.length,3);for(const step of row.steps){assert.deepEqual(Object.keys(step.original.channels).sort(),[...ORIGINAL_CHANNELS].sort());original.push(...Object.values(step.original.channels));for(const q of step.queries){assert.deepEqual(Object.keys(q.channels).sort(),[...QUERY_CHANNELS].sort());queries.push(...Object.values(q.channels));}}}
 assert(original.every(v=>[true,false,null].includes(v)));assert(queries.every(v=>[true,false,null].includes(v)));
 return{originalChannels:counts(original),queryChannels:counts(queries)};
}
export async function compareFixedCases(cases,records,usable){
 assert.equal(cases.length,2);const rows=[];for(let index=0;index<2;index++){
  const row=await compareLendingSequence({declaration:cases[index],localRecord:usable?records[index]?.local:null,providerRecord:usable?records[index]?.provider:null});
  assert.equal(row.id,cases[index].id);assert.equal(row.declaredPositions,3);assert.equal(row.steps.length,3);
  for(const[position,step]of row.steps.entries()){assert.equal(step.index,position);assert.equal(step.queries.length,cases[index].queryRoles.length);}
  const rederived=comparisonCounts([row]);assert.deepEqual(row.counts,rederived);rows.push(row);
 }
 const totals=comparisonCounts(rows);assert.equal(Object.values(totals.originalChannels).reduce((a,b)=>a+b),30);assert.equal(Object.values(totals.queryChannels).reduce((a,b)=>a+b),117);
 if(!usable){assert.equal(totals.originalChannels.unavailable,30);assert.equal(totals.queryChannels.unavailable,117);}
 return{rows,counts:totals,metrics:usable?totals:null};
}
export function validateSavedAttempt({capture,plan,index,kind,saved,expectedImplementation,request,normalized}){
 const result={index,kind,id:plan.inputs[index].id,status:saved.status,bounded:null,calls:null,networkBytes:null,report:null,workerFiles:[],error:null};
 assert.equal(saved.index,index);assert.equal(saved.kind,kind);assert.equal(saved.id,result.id);
 const relative=kind+'/'+n(index),directory=path.join(capture,relative),stem='processes/'+kind+'-'+n(index);
 if(saved.process===null){assert(['unavailable','not_attempted'].includes(saved.status));assert(!fs.existsSync(path.join(capture,stem+'-process.json')));assert(!fs.existsSync(directory)||walk(directory).length===0);result.bounded=saved.status==='not_attempted'?null:false;return result;}
 assert.equal(saved.process,stem+'-process.json');assert.equal(saved.seal,stem+'-seal.json');
 const record=json(path.join(capture,saved.process)),seal=json(path.join(capture,saved.seal));assert.equal(sha(read(path.join(capture,saved.process))),seal.processSha256);
 assert.deepEqual(seal.stdout,record.stdout);assert.deepEqual(seal.stderr,record.stderr);
 for(const k of['stdout','stderr']){assert.equal(record[k].path,stem+'.'+k);const bytes=read(path.join(capture,record[k].path));assert.equal(bytes.length,record[k].bytes);assert.equal(sha(bytes),record[k].sha256);}
 const stdout=read(path.join(capture,record.stdout.path)),stderr=read(path.join(capture,record.stderr.path));
 if(seal.workerSealed){
  assert.match(seal.workerManifestSha256,/^[a-f0-9]{64}$/);assert.equal(seal.workerManifestSha256,saved.workerManifestSha256);const summary=JSON.parse(stdout);assert.equal(summary.status,'captured');assert.equal(summary.manifestSha256,seal.workerManifestSha256);
  const manifest=verifyPacket(directory,seal.workerManifestSha256),ledger=json(path.join(directory,'write-ledger.json'));
  assert(ledger.files.every(r=>r.origin==='written'),'Worker directory was not initially empty');
  result.workerFiles=[...manifest.files,entry(directory,'manifest.json')].map(r=>({...r,path:relative+'/'+r.path}));
  assert(result.workerFiles.every(r=>{const p=r.path.slice(relative.length+1);return['request.json','report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/\d{4}\.json$/.test(p);}),'Unexpected worker artifact');
  const report=json(path.join(directory,'report.json'));result.report=report;
  assert.deepEqual(json(path.join(directory,'request.json')),{id:result.id,kind,inputSha256:plan.inputs[index].sha256,request,normalized});
  assert.deepEqual(report.implementation,expectedImplementation,'Worker loader identity differs from frozen current implementation');
  if(kind==='local'&&report.report)assert.deepEqual(report.report.implementation,expectedImplementation,'Nested local API source identity differs');
  try{validateProcessRecord(record,{plan,index,kind,outDir:path.join(plan.inputBase,relative),prepareOnly:false,stdout,stderr});validateWireDirectory(directory,report);
   const v=validateReport(report,{plan,index,kind,prepareOnly:false,pid:record.pid});Object.assign(result,v);
  }catch(e){Object.assign(result,{status:'unavailable',bounded:false,calls:null,networkBytes:null,error:reason(e)});}
 }else{result.workerFiles=fs.existsSync(directory)?walk(directory).map(p=>entry(capture,relative+'/'+p)):[];result.status='unavailable';result.bounded=false;result.error='Worker evidence did not seal';}
 const projected={status:result.status,bounded:result.bounded,calls:result.calls,networkBytes:result.networkBytes};
 assert.deepEqual(Object.fromEntries(Object.keys(projected).map(k=>[k,saved[k]])),projected,'Saved attempt classification differs from raw evidence');
 return result;
}

const validClock=c=>c&&Number.isSafeInteger(c.wallMs)&&c.wallMs>=0&&Number.isFinite(c.monotonicMs)&&c.monotonicMs>=0;
const follows=(a,b)=>{assert(validClock(a)&&validClock(b),'Invalid coordinator clock');assert(b.wallMs>=a.wallMs&&b.monotonicMs>=a.monotonicMs,'Coordinator clock reversal');};
export function validateSavedTimeline({started,results,selection,processes}){
 assert.deepEqual(results.coordinatorStarted,started.clock);assert(validClock(started.clock));
 if(selection?.report.elapsed){const e=selection.report.elapsed;follows(started.clock,e.started);follows(e.started,e.finished);assert.equal(e.wallMs,e.finished.wallMs-e.started.wallMs);assert.equal(e.monotonicMs,e.finished.monotonicMs-e.started.monotonicMs);}
 if(results.phase!=='target_matrix'){assert(processes.every(p=>p===null));return{firstTarget:null,firstChild:false,timeValid:false};}
 assert(selection?.usable,'Target matrix lacks usable selection');const e=results.elapsed;
 follows(selection.report.elapsed.finished,results.targetPhaseStarted);
 let timeValid=e?.reversed===false&&[e.wallMs,e.monotonicMs].every(n=>Number.isFinite(n)&&n>=0&&n<LIMITS.totalMs);
 let firstTarget=null,firstChild=false;
 for(const [index,p]of processes.entries())if(p){
  if(index===0){
   firstChild=Number.isSafeInteger(p.pid)&&p.pid>0;
   if(firstChild)assert(p.firstTarget,'First native child dispatch has no sampled freshness');
   if(!p.firstTarget)continue;
   const sample=p.firstTarget.firstTarget;follows(results.targetPhaseStarted,sample);
   assert.deepEqual(p.firstTarget,assertFirstTargetFresh(selection.report.selection,sample));firstTarget=p.firstTarget;
   if(timeValid)follows(sample,{wallMs:results.targetPhaseStarted.wallMs+e.wallMs,monotonicMs:results.targetPhaseStarted.monotonicMs+e.monotonicMs});
  }else{assert.equal(p.firstTarget,undefined,'Only the first native child may record the freshness gate');if(p.pid)assert(firstChild,'Later native child lacks an earlier first dispatch');}
 }
 // processOnce is awaited sequentially. Its timer starts immediately before
 // the first-spawn freshness callback, so adding that entire first duration to
 // the callback offset would double count a small interval. Bound both the sum
 // of all process intervals and the callback offset plus all later intervals.
 for(const key of ['wallMs','monotonicMs']){
  const times=processes.map(p=>p===null?0:p[key]);
  if(!times.every(n=>Number.isFinite(n)&&n>=0)){timeValid=false;continue;}
  const total=times.reduce((a,b)=>a+b,0),offset=firstTarget?firstTarget.firstTarget[key]-results.targetPhaseStarted[key]:0;
  if(!(e?.[key]>=Math.max(total,offset+times.slice(1).reduce((a,b)=>a+b,0))))timeValid=false;
 }
 return{firstTarget,firstChild,timeValid};
}

export async function adjudicateSavedCapture(capture,intentPin,manifestPin){
 capture=path.resolve(capture);assert.match(intentPin,/^[a-f0-9]{64}$/);assert.match(manifestPin,/^[a-f0-9]{64}$/);
 const manifest=verifyPacket(capture,manifestPin);assert.equal(manifest.intentSha256,intentPin);
 const archived=path.join(capture,'runtime',PREFIX,'adjudicate.mjs');assert.equal(sha(read(archived)),sha(read(fileURLToPath(import.meta.url))),'Audit source differs from pinned archived checker');
 // Delegate to the exact frozen dependency closure. Recorded process paths
 // remain the original paths when a completed packet is later relocated.
 if(fileURLToPath(import.meta.url)!==archived)return(await import(pathToFileURL(archived))).adjudicateSavedCapture(capture,intentPin,manifestPin);
 const frozen=validateIntent(capture,intentPin),intent=frozen.intent,runtime=path.join(capture,'runtime');
 assert.deepEqual(await sourceRows(runtime),intent.files);
 const results=json(path.join(capture,'results.json')),ledger=json(path.join(capture,'write-ledger.json')),started=json(path.join(capture,'STARTED.json'));
 assert.equal(results.intentSha256,intentPin);assert.equal(manifest.planSha256,results.planSha256);assert.deepEqual(results.scope,SCOPE);assert.equal(results.prepareOnly,false);assert.deepEqual(results.denominator,CURRENT_DENOMINATOR);
 assert.equal(started.intentSha256,intentPin);assert.equal(started.flag,'--execute-frozen-readonly');assert(Number.isSafeInteger(started.pid)&&started.pid>0);
 assert(['target_matrix','selection_or_input_unavailable'].includes(results.phase));
 let selection=null;const selectionDir=path.join(capture,'selection'),selectionFiles=new Map();
 if(results.selectionManifestSha256!==null){
  selection=validateSelection(selectionDir,results.selectionManifestSha256,frozen.sourceBinding);
  for(const f of [...selection.manifest.files,entry(selectionDir,'manifest.json')])selectionFiles.set('selection/'+f.path,{...f,path:'selection/'+f.path,origin:'worker_original_write_ledger'});
  assert.deepEqual(results.selectionUsage,selection.report.usage);assert.deepEqual(results.selectionElapsed,selection.report.elapsed);
 }else if(fs.existsSync(selectionDir)){
  for(const p of walk(selectionDir)){assert(['report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/000[1-3]\.json$/.test(p),'Unexpected partial selection artifact');selectionFiles.set('selection/'+p,{...entry(selectionDir,p),path:'selection/'+p,origin:'retained_unsealed_failure'});}
 }
 let declarations=null,plan=null;const selectedFiles=[];
 if(selection?.usable){
  declarations=deriveCurrentDeclarations({templateBytes:frozen.templateBytes,selection:selection.report.selection});
  if(fs.existsSync(path.join(capture,'declarations.json'))){assert.deepEqual(json(path.join(capture,'declarations.json')),declarations);selectedFiles.push('declarations.json');}
  for(let i=0;i<2;i++){const p='inputs/'+n(i)+'.json';if(fs.existsSync(path.join(capture,p))){assert.deepEqual(json(path.join(capture,p)),declarations.cases[i]);selectedFiles.push(p);}}
 }
 if(results.planSha256!==null){
  assert(selection?.usable);assert.equal(sha(read(path.join(capture,'plan.json'))),results.planSha256);plan=json(path.join(capture,'plan.json'));selectedFiles.push('plan.json');
  const inputs=declarations.cases.map((c,i)=>({...entry(capture,'inputs/'+n(i)+'.json'),id:c.id}));
  assert.deepEqual(plan,{...intent,phase:'selected_inputs_frozen',createdAt:plan.createdAt,intentSha256:intentPin,selectionManifestSha256:results.selectionManifestSha256,selectionReportPath:'selection/report.json',inputs});
  assert.deepEqual(selectedFiles.sort(),['declarations.json','inputs/001.json','inputs/002.json','plan.json']);
 }
 assert.deepEqual(results.rows.map(r=>({kind:r.kind,index:r.index})),ORDER);
 const attempts=[],records=[{},{}],processes=[],workerFiles=new Map();let knownCalls=0,knownBytes=0,unbounded=false,stopped=false,loaderIdentities=false;
 if(results.phase==='target_matrix'){
  assert(plan&&selection?.usable);
  const localApi=await(await import(pathToFileURL(path.join(runtime,'src/local-loader.js')))).loadLocalApi(),providerApi=await(await import(pathToFileURL(path.join(runtime,'src/standard-loader.js')))).loadStandardApi();assert(localApi&&providerApi);loaderIdentities=true;
  for(const{kind,index}of ORDER){const saved=results.rows[attempts.length];if(stopped)assert.equal(saved.status,'not_attempted','Dispatch after unproven bounds');
   const declaration=declarations.cases[index],api=kind==='local'?localApi:providerApi,request=kind==='local'?declaration.localInput:declaration.providerInput;
   const normalized=api[kind==='local'?'validateLocalSequence':'validateStandardSequence'](request);
   const a=validateSavedAttempt({capture,plan,index,kind,saved,expectedImplementation:api.implementation,request,normalized});
   for(const f of a.workerFiles)workerFiles.set(f.path,{...f,origin:'retained_unsealed_failure'});
   if(saved.process!==null){const seal=json(path.join(capture,saved.seal));for(const f of a.workerFiles)workerFiles.get(f.path).origin=seal.workerSealed?'worker_original_write_ledger':'retained_unsealed_failure';}
   processes.push(saved.process===null?null:json(path.join(capture,saved.process)));
   if(a.bounded===true){knownCalls+=a.calls;knownBytes+=a.networkBytes;}else{unbounded=true;stopped=true;}
   records[index][kind]=a.report;attempts.push({...a,report:undefined,workerFiles:a.workerFiles.map(r=>r.path)});
  }
 }else{
  assert.equal(results.evidenceUsable,false);assert(results.fatal);assert.equal(results.networkCalls,null);assert.equal(results.networkBytes,null);
  for(const{kind,index}of ORDER){const r=results.rows[attempts.length];assert.equal(r.id,frozen.templates[index].id);assert.equal(r.status,'not_attempted');assert.equal(r.process,null);attempts.push({...r,bounded:null,calls:null,networkBytes:null,workerFiles:[]});processes.push(null);}
 }
 const timeline=validateSavedTimeline({started,results,selection,processes});
 const pre=new Set([...frozen.manifest.files.map(r=>r.path),'intent-manifest.json']);
 const processFiles=attempts.filter((_,i)=>results.rows[i].process!==null).flatMap(a=>{const s='processes/'+a.kind+'-'+n(a.index);return[s+'.stdout',s+'.stderr',s+'-process.json',s+'-seal.json'];});
 const allowed=new Set([...pre,...selectedFiles,...selectionFiles.keys(),...workerFiles.keys(),...processFiles,'STARTED.json','results.json','write-ledger.json','manifest.json']);
 assert.deepEqual(walk(capture),[...allowed].sort(),'Unexpected capture membership');
 const expectedLedger=manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:pre.has(r.path)?'preexisting':selectionFiles.get(r.path)?.origin??workerFiles.get(r.path)?.origin??'written'}));assert.deepEqual(ledger.files,expectedLedger);
 assert.equal(results.knownBoundedNetworkCalls,knownCalls);assert.equal(results.knownBoundedNetworkBytes,knownBytes);
 const usable=results.phase==='target_matrix'&&selection?.usable&&!unbounded&&results.fatal===null&&results.sourceUnchanged===true&&timeline.firstTarget!==null&&timeline.firstChild&&timeline.timeValid&&knownCalls<=LIMITS.networkCalls&&knownBytes<=LIMITS.networkBytes;
 assert.equal(results.evidenceUsable,usable,'Claimed packet usability differs from raw bounds');
 if(results.phase==='target_matrix'){assert.equal(results.networkCalls,results.fatal?null:knownCalls);assert.equal(results.networkBytes,results.fatal?null:knownBytes);}
 assert.equal(results.totalNetworkCalls,usable?knownCalls+selection.calls:null);assert.equal(results.totalNetworkBytes,usable?knownBytes+selection.networkBytes:null);
 if(usable){assert(results.totalNetworkCalls<=AGGREGATE_LIMITS.networkCalls);assert(results.totalNetworkBytes<=AGGREGATE_LIMITS.networkBytes);}
 const comparison=await compareFixedCases(declarations?.cases??frozen.templates,records,usable);
 checkRows(runtime,intent.files);verifyPacket(capture,manifestPin);assert.deepEqual(nodeIdentity(),intent.node);
 return{kind:'saved_current_lending_sequence_API_comparison',intentSha256:intentPin,planSha256:results.planSha256,manifestSha256:manifestPin,sourceManifestSha256:intent.sourceManifestSha256,
  evidenceUsable:usable,denominator:CURRENT_DENOMINATOR,selection:{status:selection?.report.selection?.status??'unavailable',usable:selection?.usable??false,blockHash:selection?.report.selection?.header?.hash??null,networkCalls:selection?.calls??null,networkBytes:selection?.networkBytes??null},
  firstTarget:timeline.firstTarget,retainedAttempts:attempts,networkCalls:results.networkCalls,networkBytes:results.networkBytes,totalNetworkCalls:results.totalNetworkCalls,totalNetworkBytes:results.totalNetworkBytes,
  elapsed:results.elapsed??null,rows:comparison.rows,counts:comparison.counts,metrics:comparison.metrics,
  integrity:{manifestFiles:manifest.files.length,runtimeFiles:intent.files.length,allRegisteredFileIdentitiesVerified:true,workerLoaderIdentitiesReconstructed:loaderIdentities,allLocalAttemptsBeforeProviderAttempts:results.phase==='target_matrix'},
  limitations:['Direct current API adapter evidence, not HTTP or UI execution.','Two predeclared non-atomic unsigned sequences at one freshly selected block-end state, not representative coverage or signed historical replay.','Later targets use the frozen hash; only first dispatch has the declared freshness gate.','Both sides use eth.drpc.org infrastructure; provider state/execution is not independently consensus authenticated.',
   'Local getters use 1M gas after all originals; provider getters use 300k gas between originals. Query comparison is observational only.','State comparison is observed cumulative net changes, not complete public-chain poststate roots.','Saved validators and query compiler are shared with the product; this checker does not execute another EVM.','Frozen control flow and sampled clocks are not independently trusted timestamps.','Direct-worker closure and cleanup signalling do not independently attest OS process-tree extinction.'],targetsExecuted:0};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,5);console.log(JSON.stringify(await adjudicateSavedCapture(...process.argv.slice(2)),null,2));}
