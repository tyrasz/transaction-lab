// Saved records only: no execution API, worker or public RPC is invoked.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,json,sha,walk,entry,checkRows,nodeIdentity,verifyPacket} from '../lending-local-sequence-current-v037/archive.mjs';
import {PREFIX,LIMITS,AGGREGATE_LIMITS,SCOPE,ORDER,sourceRows,validateIntent,validateSelection,validateProcessRecord,validateWorkerReport,validateWorkerEvidence} from './run.mjs';
import {deriveDeclarations,CURRENT_DENOMINATOR,CHANNELS} from './declarations.mjs';
import {compareCase} from './outcomes.mjs';
import {oracleRequests} from '../ordinary-local-coverage-v1/outcomes.mjs';
import {assertFirstTargetFresh} from '../lending-local-sequence-current-v037/selection.mjs';
const n=i=>String(i+1).padStart(3,'0');
const message=e=>String(e?.message??e).slice(0,1024);

export function unavailableCase(declaration,reason){return{id:declaration.id,delegation:{status:'unavailable',reason},outcome:{transactionHash:declaration.transactionHash,execution:'unavailable',comparison:'not_comparable'},channels:Object.fromEntries(CHANNELS.map(k=>[k,{status:'unavailable',reason}])),allChannelsComplete:false,reasons:[reason]};}
export function comparisonCounts(rows){
 assert.equal(rows.length,2);const statuses=[];
 for(const row of rows){assert.deepEqual(Object.keys(row.channels).sort(),[...CHANNELS].sort());for(const v of Object.values(row.channels)){assert(['match','mismatch','unavailable'].includes(v.status));statuses.push(v.status);}}
 assert.equal(statuses.length,10);return{matched:statuses.filter(x=>x==='match').length,mismatched:statuses.filter(x=>x==='mismatch').length,unavailable:statuses.filter(x=>x==='unavailable').length};
}
export async function compareFixedCases({cases,records,usable,expectedImplementation,compare=compareCase}){
 assert.equal(cases.length,2);const rows=[];
 for(let index=0;index<2;index++){
  const declaration=cases[index];
  rows.push(usable?{id:declaration.id,...await compare({declaration,localReport:records[index]?.local?.report??null,oracle:records[index]?.oracle?.oracle??null,expectedImplementation})}:unavailableCase(declaration,'Capture source, timing, input or process evidence is unavailable'));
 }
 const counts=comparisonCounts(rows);if(!usable)assert.deepEqual(counts,{matched:0,mismatched:0,unavailable:10});
 return{rows,counts,metrics:usable?counts:null};
}

export function validateSavedAttempt({capture,plan,index,kind,saved,input,api}){
 const result={index,kind,id:plan.inputs[index].id,status:saved.status,bounded:null,calls:null,networkBytes:null,report:null,workerFiles:[],error:null};
 assert.equal(saved.index,index);assert.equal(saved.kind,kind);assert.equal(saved.id,result.id);
 const relative=kind+'/'+n(index),directory=path.join(capture,relative),stem='processes/'+kind+'-'+n(index);
 if(saved.process===null){assert(['unavailable','not_attempted'].includes(saved.status));assert(!fs.existsSync(path.join(capture,stem+'-process.json')));assert(!fs.existsSync(directory)||walk(directory).length===0);result.bounded=saved.status==='not_attempted'?null:false;return result;}
 assert.equal(saved.process,stem+'-process.json');assert.equal(saved.seal,stem+'-seal.json');
 const record=json(path.join(capture,saved.process)),seal=json(path.join(capture,saved.seal));assert.equal(sha(read(path.join(capture,saved.process))),seal.processSha256);
 assert.deepEqual(seal.stdout,record.stdout);assert.deepEqual(seal.stderr,record.stderr);
 for(const k of['stdout','stderr']){assert.equal(record[k].path,stem+'.'+k);const b=read(path.join(capture,record[k].path));assert.equal(b.length,record[k].bytes);assert.equal(sha(b),record[k].sha256);}
 const stdout=read(path.join(capture,record.stdout.path)),stderr=read(path.join(capture,record.stderr.path));
 if(seal.workerSealed){
  assert.match(seal.workerManifestSha256,/^[a-f0-9]{64}$/);assert.equal(seal.workerManifestSha256,saved.workerManifestSha256);assert.deepEqual(JSON.parse(stdout),{status:'captured',manifestSha256:seal.workerManifestSha256});
  const manifest=verifyPacket(directory,seal.workerManifestSha256),ledger=json(path.join(directory,'write-ledger.json'));assert(ledger.files.every(r=>r.origin==='written'));
  result.workerFiles=[...manifest.files,entry(directory,'manifest.json')].map(r=>({...r,path:relative+'/'+r.path}));
  assert(result.workerFiles.every(r=>{const p=r.path.slice(relative.length+1);return['request.json','report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/\d{4}\.json$/.test(p)||(kind==='oracle'&&/^cohort\/\d{4}\.json$/.test(p));}));
  const r=json(path.join(directory,'report.json'));result.report=r;
  const request=kind==='local'?input.localInput:oracleRequests({request:input.request,header:input.header});
  const normalized=kind==='local'?api.validateLocalSimulation(request):request;
  assert.deepEqual(json(path.join(directory,'request.json')),{id:input.id,index,kind,inputSha256:plan.inputs[index].sha256,request,normalized});
  assert.deepEqual(r.implementation,kind==='local'?api.implementation:null);
  if(kind==='local'&&r.report)assert.deepEqual(r.report.implementation,api.implementation);
  try{validateProcessRecord(record,{plan,index,kind,outDir:path.join(plan.inputBase,relative),stdout,stderr});validateWorkerEvidence(directory,r,{input});Object.assign(result,validateWorkerReport(r,{plan,index,kind,pid:record.pid}));}
  catch(e){Object.assign(result,{status:'unavailable',bounded:false,calls:null,networkBytes:null,error:message(e)});}
 }else{result.workerFiles=fs.existsSync(directory)?walk(directory).map(p=>entry(capture,relative+'/'+p)):[];result.status='unavailable';result.bounded=false;result.error='Worker evidence did not seal';}
 const projection={status:result.status,bounded:result.bounded,calls:result.calls,networkBytes:result.networkBytes};assert.deepEqual(Object.fromEntries(Object.keys(projection).map(k=>[k,saved[k]])),projection);
 return result;
}

const validClock=c=>c&&Number.isSafeInteger(c.wallMs)&&c.wallMs>=0&&Number.isFinite(c.monotonicMs)&&c.monotonicMs>=0;
const follows=(a,b)=>{assert(validClock(a)&&validClock(b));assert(b.wallMs>=a.wallMs&&b.monotonicMs>=a.monotonicMs,'Coordinator clock reversal');};
export function validateSavedTimeline({started,results,selection,processes}){
 assert.equal(processes.length,4);assert.deepEqual(results.coordinatorStarted,started.clock);assert(validClock(started.clock));
 if(selection?.report.elapsed){const e=selection.report.elapsed;follows(started.clock,e.started);follows(e.started,e.finished);assert.equal(e.wallMs,e.finished.wallMs-e.started.wallMs);assert.equal(e.monotonicMs,e.finished.monotonicMs-e.started.monotonicMs);}
 if(results.phase!=='target_matrix'){assert(processes.every(p=>p===null));return{firstTarget:null,firstChild:false,timeValid:false};}
 assert(selection?.usable);follows(selection.report.elapsed.finished,results.targetPhaseStarted);const e=results.elapsed;
 let timeValid=e?.reversed===false&&[e.wallMs,e.monotonicMs].every(v=>Number.isFinite(v)&&v>=0&&v<LIMITS.totalMs),firstTarget=null,firstChild=false;
 for(const[index,p]of processes.entries())if(p){if(index===0){firstChild=Number.isSafeInteger(p.pid)&&p.pid>0;if(firstChild)assert(p.firstTarget);if(!p.firstTarget)continue;
  const sample=p.firstTarget.firstTarget;follows(results.targetPhaseStarted,sample);assert.deepEqual(p.firstTarget,assertFirstTargetFresh(selection.report.selection,sample));firstTarget=p.firstTarget;
  if(timeValid)follows(sample,{wallMs:results.targetPhaseStarted.wallMs+e.wallMs,monotonicMs:results.targetPhaseStarted.monotonicMs+e.monotonicMs});
 }else{assert.equal(p.firstTarget,undefined);if(p.pid)assert(firstChild);}}
 for(const key of['wallMs','monotonicMs']){const times=processes.map(p=>p===null?0:p[key]);if(!times.every(v=>Number.isFinite(v)&&v>=0)){timeValid=false;continue;}
  const sum=times.reduce((a,b)=>a+b,0),offset=firstTarget?firstTarget.firstTarget[key]-results.targetPhaseStarted[key]:0;
  if(!(e?.[key]>=Math.max(sum,offset+times.slice(1).reduce((a,b)=>a+b,0))))timeValid=false;
 }
 return{firstTarget,firstChild,timeValid};
}

export async function adjudicateSavedCapture(capture,intentPin,manifestPin){
 capture=path.resolve(capture);assert.match(intentPin,/^[a-f0-9]{64}$/);assert.match(manifestPin,/^[a-f0-9]{64}$/);
 const manifest=verifyPacket(capture,manifestPin);assert.equal(manifest.intentSha256,intentPin);
 const archived=path.join(capture,'runtime',PREFIX,'adjudicate.mjs');assert.equal(sha(read(archived)),sha(read(fileURLToPath(import.meta.url))));
 if(fileURLToPath(import.meta.url)!==archived)return(await import(pathToFileURL(archived))).adjudicateSavedCapture(capture,intentPin,manifestPin);
 const frozen=validateIntent(capture,intentPin),intent=frozen.intent,runtime=path.join(capture,'runtime');assert.deepEqual(await sourceRows(runtime),intent.files);
 const results=json(path.join(capture,'results.json')),ledger=json(path.join(capture,'write-ledger.json')),started=json(path.join(capture,'STARTED.json'));
 assert.equal(results.intentSha256,intentPin);assert.equal(manifest.planSha256,results.planSha256);assert.deepEqual(results.scope,SCOPE);assert.deepEqual(results.denominator,CURRENT_DENOMINATOR);assert.equal(results.prepareOnly,false);
 assert.equal(started.intentSha256,intentPin);assert.equal(started.flag,'--execute-frozen-readonly');assert(Number.isSafeInteger(started.pid)&&started.pid>0);assert(['target_matrix','selection_or_input_unavailable'].includes(results.phase));
 let selection=null;const selectionDir=path.join(capture,'selection'),selectionFiles=new Map();
 if(results.selectionManifestSha256!==null){selection=validateSelection(selectionDir,results.selectionManifestSha256,frozen.sourceBinding);
  for(const f of[...selection.manifest.files,entry(selectionDir,'manifest.json')])selectionFiles.set('selection/'+f.path,{...f,path:'selection/'+f.path,origin:'worker_original_write_ledger'});
  assert.deepEqual(results.selectionUsage,selection.report.usage);assert.deepEqual(results.selectionElapsed,selection.report.elapsed);
 }else if(fs.existsSync(selectionDir)){for(const p of walk(selectionDir)){assert(['report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/000[1-3]\.json$/.test(p));selectionFiles.set('selection/'+p,{...entry(selectionDir,p),path:'selection/'+p,origin:'retained_unsealed_failure'});}}
 let declarations=null,plan=null;const selectedFiles=[];
 if(selection?.usable){declarations=deriveDeclarations({templateBytes:frozen.templateBytes,header:selection.report.selection.header});
  if(fs.existsSync(path.join(capture,'declarations.json'))){assert.deepEqual(json(path.join(capture,'declarations.json')),declarations);selectedFiles.push('declarations.json');}
  for(let i=0;i<2;i++){const p='inputs/'+n(i)+'.json';if(fs.existsSync(path.join(capture,p))){assert.deepEqual(json(path.join(capture,p)),declarations.cases[i]);selectedFiles.push(p);}}
 }
 if(results.planSha256!==null){assert(selection?.usable);assert.equal(sha(read(path.join(capture,'plan.json'))),results.planSha256);plan=json(path.join(capture,'plan.json'));selectedFiles.push('plan.json');
  const inputs=declarations.cases.map((c,i)=>({...entry(capture,'inputs/'+n(i)+'.json'),id:c.id}));assert.deepEqual(plan,{...intent,phase:'selected_inputs_frozen',createdAt:plan.createdAt,intentSha256:intentPin,selectionManifestSha256:results.selectionManifestSha256,selectionReportPath:'selection/report.json',inputs});assert.deepEqual(selectedFiles.sort(),['declarations.json','inputs/001.json','inputs/002.json','plan.json']);
 }
 assert.deepEqual(results.rows.map(r=>({kind:r.kind,index:r.index})),ORDER);
 const attempts=[],records=[{},{}],processes=[],workerFiles=new Map();let knownCalls=0,knownBytes=0,unbounded=false,stopped=false,api=null;
 if(results.phase==='target_matrix'){
  assert(plan&&selection?.usable);api=await(await import(pathToFileURL(path.join(runtime,'src/local-loader.js')))).loadLocalApi();assert(api);
  for(const{kind,index}of ORDER){const saved=results.rows[attempts.length];if(stopped)assert.equal(saved.status,'not_attempted');
   const a=validateSavedAttempt({capture,plan,index,kind,saved,input:declarations.cases[index],api});
   for(const f of a.workerFiles)workerFiles.set(f.path,{...f,origin:saved.process!==null&&json(path.join(capture,saved.seal)).workerSealed?'worker_original_write_ledger':'retained_unsealed_failure'});
   processes.push(saved.process===null?null:json(path.join(capture,saved.process)));if(a.bounded===true){knownCalls+=a.calls;knownBytes+=a.networkBytes;}else{unbounded=true;stopped=true;}
   records[index][kind]=a.report;attempts.push({...a,report:undefined,workerFiles:a.workerFiles.map(r=>r.path)});
  }
 }else{assert.equal(results.evidenceUsable,false);assert(results.fatal);assert.equal(results.networkCalls,null);assert.equal(results.networkBytes,null);
  for(const{kind,index}of ORDER){const r=results.rows[attempts.length];assert.equal(r.id,frozen.templates[index].id);assert.equal(r.status,'not_attempted');assert.equal(r.process,null);attempts.push({...r,bounded:null,calls:null,networkBytes:null,workerFiles:[]});processes.push(null);}
 }
 const timeline=validateSavedTimeline({started,results,selection,processes}),pre=new Set([...frozen.manifest.files.map(r=>r.path),'intent-manifest.json']);
 const processFiles=attempts.filter((_,i)=>results.rows[i].process!==null).flatMap(a=>{const s='processes/'+a.kind+'-'+n(a.index);return[s+'.stdout',s+'.stderr',s+'-process.json',s+'-seal.json'];});
 const allowed=new Set([...pre,...selectedFiles,...selectionFiles.keys(),...workerFiles.keys(),...processFiles,'STARTED.json','results.json','write-ledger.json','manifest.json']);assert.deepEqual(walk(capture),[...allowed].sort());
 assert.deepEqual(ledger.files,manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:pre.has(r.path)?'preexisting':selectionFiles.get(r.path)?.origin??workerFiles.get(r.path)?.origin??'written'})));
 assert.equal(results.knownBoundedNetworkCalls,knownCalls);assert.equal(results.knownBoundedNetworkBytes,knownBytes);
 const usable=results.phase==='target_matrix'&&selection?.usable&&!unbounded&&results.fatal===null&&results.sourceUnchanged===true&&timeline.firstTarget!==null&&timeline.firstChild&&timeline.timeValid&&knownCalls<=LIMITS.networkCalls&&knownBytes<=LIMITS.networkBytes;
 assert.equal(results.evidenceUsable,usable);if(results.phase==='target_matrix'){assert.equal(results.networkCalls,results.fatal?null:knownCalls);assert.equal(results.networkBytes,results.fatal?null:knownBytes);}
 assert.equal(results.totalNetworkCalls,usable?knownCalls+selection.calls:null);assert.equal(results.totalNetworkBytes,usable?knownBytes+selection.networkBytes:null);
 if(usable){assert(results.totalNetworkCalls<=AGGREGATE_LIMITS.networkCalls);assert(results.totalNetworkBytes<=AGGREGATE_LIMITS.networkBytes);}
 const comparison=await compareFixedCases({cases:declarations?.cases??frozen.templates,records,usable,expectedImplementation:api?.implementation});
 checkRows(runtime,intent.files);verifyPacket(capture,manifestPin);assert.deepEqual(nodeIdentity(),intent.node);
 return{kind:'saved_current_delegated_sender_API_comparison',intentSha256:intentPin,planSha256:results.planSha256,manifestSha256:manifestPin,sourceManifestSha256:intent.sourceManifestSha256,evidenceUsable:usable,denominator:CURRENT_DENOMINATOR,
  selection:{status:selection?.report.selection?.status??'unavailable',usable:selection?.usable??false,blockHash:selection?.report.selection?.header?.hash??null},firstTarget:timeline.firstTarget,retainedAttempts:attempts,totalNetworkCalls:results.totalNetworkCalls,totalNetworkBytes:results.totalNetworkBytes,elapsed:results.elapsed??null,...comparison,
  integrity:{manifestFiles:manifest.files.length,runtimeFiles:intent.files.length,allRegisteredFileIdentitiesVerified:true,localLoaderIdentityReconstructed:api!==null},
  limitations:['Two fixed previously observed calls at a new block, not a repaired historical result or population accuracy estimate.','Both paths use the same public provider infrastructure; no independent consensus or finality claim.','Raw reference traces use the exact unsigned unpriced context; signed admission, fees and complete economic effects are excluded.','The two local balance queries per call are not independently compared.','Observed state changes are not full public-chain poststate roots.','This saved check does not execute a VM; proof and semantic helpers are shared with the product.'],targetsExecuted:0};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,5);console.log(JSON.stringify(await adjudicateSavedCapture(...process.argv.slice(2)),null,2));}
