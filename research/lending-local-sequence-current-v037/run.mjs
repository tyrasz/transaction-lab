// Fixed two-case preparation, archival freeze and one-shot current API capture.
// Importing this module performs no network or API execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,json,sha,walk,entry,checkRows,copyRows,nodeIdentity,createLedger,verifyPacket} from './archive.mjs';
import {runSealedWorker} from '../worker-process.mjs';
export const PREFIX='research/lending-local-sequence-current-v037';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
import {readPinnedTemplates,deriveTemplateProfile,validateTemplateProfile,TEMPLATE_PROFILES,deriveCurrentDeclarations,validateCurrentDeclarations,HISTORICAL_TEMPLATES,CURRENT_DENOMINATOR} from './declarations.mjs';
import {FUNDED_PROVENANCE_FILES} from './funded-profile.mjs';
import {replayHeaderSelection,assertFirstTargetFresh,HEADER_SELECTION_POLICY} from './selection.mjs';
export {TEMPLATE_PROFILES,validateTemplateProfile};
export const OWN=['PLAN.md','declarations.mjs','declarations.test.mjs','funded-profile.mjs','funded-profile.test.mjs','selection.mjs','selection.test.mjs','strict-json.mjs','strict-json.test.mjs','select-current-header.mjs','select-current-header.test.mjs',
 'adjudicate.mjs','adjudicate.test.mjs','run.mjs','run.test.mjs','archive.mjs','capture.mjs','capture.test.mjs','worker.mjs'];
export const SHARED=['research/worker-process.mjs','research/standard-evm/cohort-http.mjs','reports/ethereum-lending-local-reference/compare.mjs',
 ...['observations.mjs','state-observations.mjs','context-validation.mjs'].map(n=>'research/lending-local-sequence-v037/'+n)];
export const AGGREGATE_LIMITS=Object.freeze({networkCalls:1039,networkBytes:326*1024*1024,selectionPhaseMs:60000,targetPhaseMs:900000});
export const LIMITS=Object.freeze({cases:2,processes:4,positions:6,totalMs:900000,localProcessMs:190000,providerProcessMs:300000,prepareProcessMs:30000,
 streamBytes:1048576,processBytes:2097152,networkCalls:1036,networkBytes:320*1024*1024,artifactBytes:2*1024*1024*1024,drainMs:25000,
 timingScope:'matrix_entry_through_final_identity_and_ledger_checks_excluding_prepare_freeze_final_seal_and_saved_comparison'});
export const ORDER=Object.freeze(['local','provider'].flatMap(kind=>[0,1].map(index=>Object.freeze({kind,index}))));
export const SCOPE=Object.freeze({endpoint:'https://eth.drpc.org',adapter:'current_guarded_local_and_current_standard_sequence_APIs',httpApi:false,ui:false,
 retries:0,providerFallback:false,broadcast:false,sharedProviderInfrastructure:true,independentConsensus:false,fullRealTransactionReplay:false,
 originalGas:5000000,originalPricing:'unsigned_unpriced_block_end',localQueryGas:1000000,providerQueryGas:300000,
 queryTiming:'local_all_originals_then_disposable_queries_provider_between_originals',queryGasEquivalent:false,
 selection:'one_fresh_header_then_fixed_hash_no_reselection',freshAtSelectionOnly:true,denominator:'two_fixed_sequences_three_declared_positions_each_failures_and_unattempted_retained'});
const id=i=>String(i+1).padStart(3,'0');
export async function sourceRows(root=ROOT){
 // These archived observations bind why the fixed profile was chosen. They
 // never supply execution state or participate in template derivation.
 for(const pin of FUNDED_PROVENANCE_FILES){const actual=entry(root,pin.path);assert.equal(actual.kind,'file');assert.equal(actual.bytes,pin.bytes);assert.equal(actual.sha256,pin.sha256);}
 const paths=['package.json',...OWN.map(n=>PREFIX+'/'+n),...SHARED,...HISTORICAL_TEMPLATES.files.map(r=>r.path),...FUNDED_PROVENANCE_FILES.map(r=>r.path)];
 for(const name of fs.readdirSync(path.join(root,'src')))if(/\.(js|json)$/.test(name))paths.push('src/'+name);
 for(const name of fs.readdirSync(path.join(root,'engines')))if(fs.lstatSync(path.join(root,'engines',name)).isFile())paths.push('engines/'+name);
 for(const engine of ['local-evm','standard-evm','fixture-evm']){const dir='engines/'+engine;for(const name of fs.readdirSync(path.join(root,dir)))if(/\.(js|json)$/.test(name))paths.push(dir+'/'+name);paths.push(...walk(root,dir+'/node_modules'));}
 const rows=[...new Set(paths)].sort().map(p=>entry(root,p));assert(rows.length<12000&&rows.reduce((s,r)=>s+(r.bytes??0),0)<128*1024*1024);return rows;
}
export function invocation(plan,index,kind,outDir,prepareOnly=false){assert([0,1].includes(index)&&['local','provider'].includes(kind));return{executable:plan.node.executable,args:['--max-old-space-size=768',path.join(plan.runtimePath,PREFIX,'worker.mjs'),path.join(plan.inputBase,'plan.json'),String(index),kind,outDir,...(prepareOnly?['--prepare-only']:[])]};}
export async function checkIdentity(plan){assert.deepEqual(nodeIdentity(),plan.node);assert.deepEqual(walk(plan.runtimePath),plan.files.map(r=>r.path));checkRows(plan.runtimePath,plan.files);checkRows(plan.inputBase,plan.inputs.map(({id,...r})=>r));
 if(plan.intentSha256){const frozen=validateIntent(plan.inputBase,plan.intentSha256);assert.deepEqual(frozen.intent.files,plan.files);assert.deepEqual(frozen.intent.node,plan.node);assert.equal(plan.profile,frozen.intent.profile);assert.deepEqual(plan.amendment,frozen.intent.amendment);assert.deepEqual(plan.baseTemplates,frozen.intent.baseTemplates);assert.deepEqual(plan.templates,frozen.intent.templates);
  const selected=validateSelection(path.join(plan.inputBase,'selection'),plan.selectionManifestSha256,frozen.sourceBinding);assert(selected.usable,'Selection unavailable');
  const declared=deriveCurrentDeclarations({templateBytes:frozen.templateBytes,selection:selected.report.selection,profile:plan.profile});assert.deepEqual(json(path.join(plan.inputBase,'declarations.json')),declared);
  for(let i=0;i<2;i++)assert.deepEqual(json(path.join(plan.inputBase,plan.inputs[i].path)),declared.cases[i]);
 }}
export function validateReport(report,{plan,index,kind,prepareOnly=false,pid}){
 assert(Number.isSafeInteger(pid)&&pid>0,'Positive worker PID required');
 assert.equal(report.id,plan.inputs[index].id);assert.equal(report.inputSha256,plan.inputs[index].sha256);assert.equal(report.kind,kind);assert.equal(report.workerPid,pid);
 assert.equal(report.schemaVersion,1);assert(report.implementation?.sourceSha256);
 if(prepareOnly){assert.equal(report.status,'prepared_no_execution');assert.equal(report.executionInvoked,false);assert.equal(report.networkCalls,0);return{status:'prepared',bounded:true,calls:0,networkBytes:0};}
 assert(['returned','threw'].includes(report.status));
 const plain=value=>value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
 if(report.status==='returned'){assert.equal(report.error,null);assert(plain(report.report),'Returned API report must be a plain object');}
 else{assert.equal(report.report,null);assert(plain(report.error),'Thrown API error must be a plain object');assert.deepEqual(Object.keys(report.error).sort(),['code','message','name']);
  assert(typeof report.error.name==='string'&&report.error.name.length<=128);assert(typeof report.error.message==='string'&&report.error.message.length<=2048);
  assert(report.error.code===null||(typeof report.error.code==='string'&&Buffer.byteLength(report.error.code)<=LIMITS.streamBytes));}
 assert.equal(report.sourceUnchanged,true);assert.equal(report.drain.rpc.complete,true);assert.equal(report.drain.capture.complete,true);assert.equal(report.drain.childClosure,true);
 const u=report.captureUsage;assert.equal(u.pending,0);assert.equal(u.unaccountedData,false);assert.equal(u.saveFailed,false);assert.equal(u.cancelFailed,false);assert.equal(u.closed,true);
 assert(Number.isSafeInteger(u.calls)&&u.calls>=0&&u.calls<=(kind==='local'?260:258));assert(Number.isSafeInteger(u.observedBytes)&&u.observedBytes>=0&&u.observedBytes<=(kind==='local'?32:128)*1024*1024);
 assert(Array.isArray(report.rpcEvidence)&&report.rpcEvidence.length>=u.calls&&report.rpcEvidence.length<=(kind==='local'?260:258));assert(report.elapsed.wallMs>=0&&report.elapsed.monotonicMs>=0);
 return{status:report.status==='returned'?'returned':'unavailable',bounded:true,calls:u.calls,networkBytes:u.observedBytes};
}
export function validateProcessRecord(record,{plan,index,kind,outDir,prepareOnly,stdout,stderr}){
 assert(Number.isSafeInteger(record.pid)&&record.pid>0,'Positive worker PID required');
 assert.deepEqual({executable:record.executable,args:record.args},invocation(plan,index,kind,outDir,prepareOnly));
 const maximum=prepareOnly?LIMITS.prepareProcessMs:kind==='local'?LIMITS.localProcessMs:LIMITS.providerProcessMs;
 assert(Number.isSafeInteger(record.timeoutMs)&&record.timeoutMs>0&&record.timeoutMs<=maximum);
 assert(record.closed&&record.status===0&&record.signal===null&&record.error===null&&record.limitFailure===null&&record.cleanupSignalAccepted);
 for(const time of [record.wallMs,record.monotonicMs])assert(Number.isFinite(time)&&time>=0&&time<=record.timeoutMs);
 for(const[k,raw]of [['stdout',stdout],['stderr',stderr]]){assert(raw.length<=LIMITS.streamBytes);assert.equal(record[k].bytes,raw.length);assert.equal(record[k].sha256,sha(raw));assert.equal(record.observedBytes[k],raw.length);}
 assert.equal(stderr.length,0);
}
export function validateWireDirectory(directory,report){
 const dir=path.join(directory,'wire'),paths=fs.existsSync(dir)?walk(dir):[];assert.equal(paths.length,report.captureUsage.calls);let observedBytes=0;const joined=new Set();
 for(const[index,p]of paths.entries()){assert.equal(p,String(index+1).padStart(4,'0')+'.json');const wire=json(path.join(dir,p)),raw=Buffer.from(wire.rawBase64,'base64');
  assert.equal(wire.id,index+1);assert.equal(wire.url,SCOPE.endpoint);assert.equal(wire.requestBytes,Buffer.byteLength(wire.requestText));assert.equal(wire.requestSha256,sha(wire.requestText));
  assert.equal(raw.toString('base64'),wire.rawBase64);assert.equal(raw.length,wire.transport.retainedBytes);assert.equal(sha(raw),wire.transport.retainedSha256);assert(wire.transport.observedBytes>=raw.length);observedBytes+=wire.transport.observedBytes;
  const client=report.rpcEvidence.filter(r=>r.requestText===wire.requestText);assert.equal(client.length,1,'Raw request does not join client evidence');assert(!joined.has(client[0]),'Client evidence joins multiple raw records');joined.add(client[0]);
  if(client[0].responseText!==undefined){assert.equal(wire.transport.complete,true);assert.equal(client[0].responseText,new TextDecoder('utf-8',{fatal:true}).decode(raw));assert.equal(client[0].transport.responseSha256,sha(raw));}
 }
 // A client can fail before the capture dispatches anything (including when
 // the client marks its own fetch call dispatched). Such rows have no response
 // or received bytes. Every successful/received response needs a raw record.
 for(const client of report.rpcEvidence)if(!joined.has(client)){
  assert.equal(client.responseText,undefined,'Successful client response has no raw wire');assert.notEqual(client.status,'completed');
  assert(client.status===undefined||client.status==='failed');assert(typeof client.error?.code==='string'&&typeof client.error?.message==='string','Unjoined client evidence is not an explicit failure');
  assert.equal(client.httpStatus,undefined);assert.equal(client.transport?.complete,false);assert.equal(client.transport?.bodyRetained,false);
  assert.equal(client.transport?.observedBytes,0);assert.equal(client.transport?.retainedPrefixBytes,0);assert.equal(client.transport?.responseSha256,undefined);
 }
 assert.equal(observedBytes,report.captureUsage.observedBytes);return{calls:paths.length,observedBytes};
}
export async function processOnce(plan,index,kind,prepareOnly,writer,timeoutMs,{beforeSpawn=()=>null}={}){
 const relative=`${kind}/${id(index)}`,outDir=path.join(plan.inputBase,relative),call=invocation(plan,index,kind,outDir,prepareOnly),stem=`processes/${kind}-${id(index)}`;
 const worker=await runSealedWorker({...call,cwd:plan.runtimePath,outDir,relative,stem,writer,timeoutMs,streamBytes:LIMITS.streamBytes,beforeSpawn});
 const {record,stdout,stderr,report,workerManifestSha256}=worker;
 let validation={status:'unavailable',bounded:false,calls:null,networkBytes:null};
 try{assert(worker.boundedProcess);
  validateProcessRecord(record,{plan,index,kind,outDir,prepareOnly,stdout,stderr});if(!prepareOnly)validateWireDirectory(outDir,report);validation=validateReport(report,{plan,index,kind,prepareOnly,pid:record.pid});}catch{}
 return{...validation,process:stem+'-process.json',seal:stem+'-seal.json',workerManifestSha256};
}
export async function executeMatrix(plan,writer,prepareOnly,{identity=checkIdentity,attempt=processOnce,now=Date.now,monotonic=()=>performance.now(),beforeFirstSpawn=()=>null}={}){
 const began=now(),start=monotonic();let lastWall=began,lastMono=start,fatal=null,calls=0,networkBytes=0;const rows=[];
 const timing=()=>{const wall=now(),mono=monotonic(),reversed=wall<lastWall||mono<lastMono;lastWall=wall;lastMono=mono;const t={wallMs:wall-began,monotonicMs:mono-start,reversed};assert(!reversed&&Number.isFinite(t.wallMs)&&Number.isFinite(t.monotonicMs)&&t.wallMs>=0&&t.monotonicMs>=0&&t.wallMs<LIMITS.totalMs&&t.monotonicMs<LIMITS.totalMs,'Global clock/budget');return t;};
 for(const{kind,index}of ORDER){if(fatal){rows.push({kind,index,id:plan.inputs[index].id,status:'not_attempted',process:null,reason:'Prior integrity/budget/closure failure'});continue;}
  let result=null;try{timing();await identity(plan);writer.verify();const t=timing(),maximum=prepareOnly?LIMITS.prepareProcessMs:kind==='local'?LIMITS.localProcessMs:LIMITS.providerProcessMs;
   assert(LIMITS.totalMs-Math.max(t.wallMs,t.monotonicMs)>maximum,'Insufficient remaining full process budget');
   result=await attempt(plan,index,kind,prepareOnly,writer,maximum,{beforeSpawn:kind==='local'&&index===0?beforeFirstSpawn:()=>null});rows.push({kind,index,id:plan.inputs[index].id,...result});assert(result.bounded,'Unproven bounds, drainage or child closure');
   calls+=result.calls;networkBytes+=result.networkBytes;assert(calls<=LIMITS.networkCalls&&networkBytes<=LIMITS.networkBytes);await identity(plan);writer.verify();timing();
  }catch(e){fatal={kind,index,message:String(e.message).slice(0,1024)};if(!result)rows.push({kind,index,id:plan.inputs[index].id,status:'unavailable',process:null,reason:fatal.message});}}
 let elapsed,sourceUnchanged=false;try{await identity(plan);writer.verify();elapsed=timing();sourceUnchanged=true;}catch(e){fatal??={kind:null,index:null,message:String(e.message).slice(0,1024)};const wall=now(),mono=monotonic();elapsed={wallMs:wall-began,monotonicMs:mono-start,reversed:wall<lastWall||mono<lastMono};}
 return{rows,fatal,sourceUnchanged,elapsed,targetPhaseStarted:{wallMs:began,monotonicMs:start},networkCalls:fatal?null:calls,networkBytes:fatal?null:networkBytes,knownBoundedNetworkCalls:calls,knownBoundedNetworkBytes:networkBytes,evidenceUsable:fatal===null&&sourceUnchanged,scope:SCOPE,prepareOnly};
}
export function templateBytes(root=ROOT){const bytes=HISTORICAL_TEMPLATES.files.map(r=>read(path.join(root,r.path)));readPinnedTemplates(bytes);return bytes;}
// Read-only validation of both byte representations. Derivation starts only
// from immutable base bytes, never from a supplied amendment or target output.
export function validateProfileTemplates(directory,record){
 validateTemplateProfile(record.profile);assert(Array.isArray(record.baseTemplates)&&record.baseTemplates.length===2);assert(Array.isArray(record.templates)&&record.templates.length===2);
 const load=(rows,prefix)=>rows.map((r,i)=>{assert.equal(r.path,`${prefix}/${id(i)}.json`);checkRows(directory,[Object.fromEntries(Object.entries(r).filter(([k])=>k!=='id'))]);return read(path.join(directory,r.path));});
 const baseBytes=load(record.baseTemplates,'base-templates'),profileBytes=load(record.templates,'templates');
 const derived=deriveTemplateProfile({templateBytes:baseBytes,profile:record.profile});assert.equal(derived.profile,record.profile);assert.deepEqual(record.amendment,derived.amendment);
 assert.deepEqual(profileBytes,derived.bytes.map(b=>Buffer.from(b)));assert.deepEqual(record.baseTemplates.map(r=>r.id),derived.baseTemplates.map(c=>c.id));assert.deepEqual(record.templates.map(r=>r.id),derived.templates.map(c=>c.id));
 return{templateBytes:baseBytes,profileTemplateBytes:profileBytes,templates:derived.templates,baseTemplates:derived.baseTemplates,amendment:derived.amendment};
}
export async function prepare(directory,profile='original_fixed'){
 validateTemplateProfile(profile);const baseBytes=templateBytes(),derived=deriveTemplateProfile({templateBytes:baseBytes,profile}),files=await sourceRows();
 directory=path.resolve(directory);fs.mkdirSync(directory);const writer=createLedger(directory);
 const baseTemplates=derived.baseTemplates.map((c,i)=>{const p=`base-templates/${id(i)}.json`;writer.write(p,baseBytes[i]);return{...entry(directory,p),id:c.id};});
 const templates=derived.templates.map((c,i)=>{const p=`templates/${id(i)}.json`;writer.write(p,Buffer.from(derived.bytes[i]));return{...entry(directory,p),id:c.id};});const inputs=templates;writer.save('templates.json',derived.templates);
 const plan={schemaVersion:1,phase:'offline_preparation',createdAt:new Date().toISOString(),runtimePath:ROOT,inputBase:directory,node:nodeIdentity(),limits:LIMITS,scope:SCOPE,files,profile,amendment:derived.amendment,baseTemplates,templates,inputs};writer.save('plan.json',plan);
 for(const kind of ['local','provider'])fs.mkdirSync(path.join(directory,kind));
 const identity=async p=>{assert.deepEqual(await sourceRows(),p.files);assert.deepEqual(nodeIdentity(),p.node);assert.deepEqual(p.inputs,p.templates);validateProfileTemplates(directory,p);};
 const result=await executeMatrix(plan,writer,true,{identity});writer.save('results.json',result);const manifestSha256=writer.seal();return{directory,manifestSha256,allPrepared:result.evidenceUsable&&result.rows.every(r=>r.status==='prepared'),rows:result.rows};
}
export function validatePreparation(directory,pin){const m=verifyPacket(directory,pin),p=json(path.join(directory,'plan.json')),r=json(path.join(directory,'results.json'));assert.deepEqual(p.limits,LIMITS);assert.deepEqual(p.scope,SCOPE);assert.equal(r.prepareOnly,true);assert.equal(r.evidenceUsable,true);assert.equal(r.networkCalls,0);assert.equal(r.networkBytes,0);assert.deepEqual(r.rows.map(x=>({kind:x.kind,index:x.index})),ORDER);
 const derived=validateProfileTemplates(directory,p);assert.deepEqual(p.inputs,p.templates);assert.deepEqual(json(path.join(directory,'templates.json')),derived.templates);
 for(const row of r.rows){assert.equal(row.status,'prepared');const out=path.join(directory,row.kind,id(row.index)),seal=json(path.join(directory,row.seal)),rec=json(path.join(directory,row.process));assert.equal(sha(read(path.join(directory,row.process))),seal.processSha256);assert.equal(rec.status,0);assert.equal(rec.signal,null);assert.equal(rec.closed,true);assert.equal(rec.error,null);assert.equal(rec.limitFailure,null);assert.equal(rec.cleanupSignalAccepted,true);verifyPacket(out,seal.workerManifestSha256);
  assert.deepEqual({executable:rec.executable,args:rec.args},invocation(p,row.index,row.kind,path.join(p.inputBase,row.kind,id(row.index)),true));for(const k of ['stdout','stderr'])assert.equal(sha(read(path.join(directory,rec[k].path))),rec[k].sha256);assert.equal(rec.stderr.bytes,0);validateProcessRecord(rec,{plan:p,index:row.index,kind:row.kind,outDir:path.join(p.inputBase,row.kind,id(row.index)),prepareOnly:true,stdout:read(path.join(directory,rec.stdout.path)),stderr:read(path.join(directory,rec.stderr.path))});validateReport(json(path.join(out,'report.json')),{plan:p,index:row.index,kind:row.kind,prepareOnly:true,pid:rec.pid});}
 return{manifest:m,plan:p,result:r};}
export function validateIntent(capture,intentPin,{exact=false}={}){
 capture=path.resolve(capture);assert.match(intentPin,/^[a-f0-9]{64}$/);assert.equal(sha(read(path.join(capture,'intent.json'))),intentPin);
 const intent=json(path.join(capture,'intent.json'));assert.equal(intent.phase,'frozen_before_selection');assert.deepEqual(intent.limits,LIMITS);assert.deepEqual(intent.scope,SCOPE);assert.deepEqual(intent.selectionPolicy,HEADER_SELECTION_POLICY);assert.deepEqual(intent.aggregateLimits,AGGREGATE_LIMITS);
 assert.deepEqual(nodeIdentity(),intent.node);assert.equal(sha(read(path.join(capture,'source-manifest.json'))),intent.sourceManifestSha256);assert.deepEqual(json(path.join(capture,'source-manifest.json')),{schemaVersion:1,files:intent.files,node:intent.node});
 const runtime=path.join(capture,'runtime');assert.deepEqual(walk(runtime),intent.files.map(r=>r.path));checkRows(runtime,intent.files);
 const prep=validatePreparation(path.join(capture,'preparation'),intent.preparationManifestSha256);assert.deepEqual(prep.plan.files,intent.files);assert.deepEqual(prep.plan.node,intent.node);assert.deepEqual(prep.plan.inputs,intent.templates);assert.deepEqual(prep.plan.templates,intent.templates);assert.deepEqual(prep.plan.baseTemplates,intent.baseTemplates);assert.equal(prep.plan.profile,intent.profile);assert.deepEqual(prep.plan.amendment,intent.amendment);
 const derived=validateProfileTemplates(capture,intent),bytes=derived.templateBytes,templates=derived.templates;
 for(let i=0;i<2;i++)assert.deepEqual(read(path.join(runtime,HISTORICAL_TEMPLATES.files[i].path)),bytes[i]);assert.deepEqual(json(path.join(capture,'preparation/templates.json')),templates);
 const manifestPin=sha(read(path.join(capture,'intent-manifest.json'))),manifest=verifyPacket(capture,manifestPin,{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json',exact});
 assert.equal(manifest.intentSha256,intentPin);assert.equal(manifest.sourceManifestSha256,intent.sourceManifestSha256);
 const pre=[...intent.files.map(r=>'runtime/'+r.path),...walk(path.join(capture,'preparation')).map(p=>'preparation/'+p)];
 const expected=[...pre,...intent.baseTemplates.map(r=>r.path),...intent.templates.map(r=>r.path),'source-manifest.json','intent.json','intent-write-ledger.json'].sort();assert.deepEqual(manifest.files.map(r=>r.path).sort(),expected);
 const l=json(path.join(capture,'intent-write-ledger.json'));assert.deepEqual(l.files,manifest.files.filter(r=>r.path!=='intent-write-ledger.json').map(r=>({...r,origin:pre.includes(r.path)?'preexisting':'written'})));
 return{intent,manifest,intentManifestSha256:manifestPin,templateBytes:bytes,profileTemplateBytes:derived.profileTemplateBytes,templates,sourceBinding:{intentPlanSha256:intentPin,sourceManifestSha256:intent.sourceManifestSha256,nodeSha256:intent.node.sha256}};
}
export function validateSelection(directory,pin,sourceBinding){
 const manifest=verifyPacket(directory,pin),report=json(path.join(directory,'report.json')),ledger=json(path.join(directory,'write-ledger.json'));
 assert(ledger.files.every(r=>r.origin==='written'));const wirePaths=manifest.files.map(r=>r.path).filter(p=>p.startsWith('wire/'));
 assert.deepEqual(manifest.files.map(r=>r.path).sort(),['report.json','write-ledger.json',...wirePaths].sort());
 assert(wirePaths.length<=3);const native=wirePaths.map((p,i)=>{assert.equal(p,`wire/${String(i+1).padStart(4,'0')}.json`);const w=json(path.join(directory,p)),raw=Buffer.from(w.rawBase64,'base64');assert.equal(w.id,i+1);assert.equal(w.url,SCOPE.endpoint);assert.equal(raw.toString('base64'),w.rawBase64);assert.equal(raw.length,w.transport.retainedBytes);assert.equal(sha(raw),w.transport.retainedSha256);assert.equal(Buffer.byteLength(w.requestText),w.requestBytes);assert.equal(sha(w.requestText),w.requestSha256);return{path:p,wire:w,raw};});
 if(report.selection){assert.deepEqual(report.selection.sourceBinding,sourceBinding);replayHeaderSelection(report.selection);}
 const u=report.usage,d=report.drain,t=report.elapsed;assert(u&&d);assert.deepEqual(u.limits,HEADER_SELECTION_POLICY);assert(Number.isSafeInteger(u.calls)&&u.calls>=0&&u.calls<=3);assert(Number.isSafeInteger(u.observedBytes)&&u.observedBytes>=0);assert(Number.isSafeInteger(u.retainedBytes)&&u.retainedBytes>=0);assert.equal(u.savedWires,native.length);
 assert(u.retainedBytes>=native.reduce((sum,r)=>sum+r.raw.length,0));assert(u.observedBytes>=native.reduce((sum,r)=>sum+r.wire.transport.observedBytes,0));
 let usable=report.error===null&&report.selection?.status==='selected'&&d.complete===true&&d.pendingIo===0&&d.pendingSaves===0&&['unaccountedData','cancelFailed','saveFailed','clockInvalid','timedOut'].every(k=>d[k]===false)
  &&u.calls===3&&native.length===3&&u.observedBytes<=HEADER_SELECTION_POLICY.totalBytes&&t!==null&&t!==undefined&&[t.wallMs,t.monotonicMs,t.nativeMs].every(v=>Number.isFinite(v)&&v>=0&&v<=HEADER_SELECTION_POLICY.phaseMs); 
 if(usable){
  assert.deepEqual(t.started,report.selection.started);assert.deepEqual(t.finished,report.selection.finished);assert.equal(t.wallMs,t.finished.wallMs-t.started.wallMs);assert.equal(t.monotonicMs,t.finished.monotonicMs-t.started.monotonicMs);
  assert.equal(d.timeoutMs,HEADER_SELECTION_POLICY.drainMs);assert(Number.isFinite(d.budgetUsedMs)&&d.budgetUsedMs>=0&&d.budgetUsedMs<=HEADER_SELECTION_POLICY.drainMs);assert(Number.isFinite(d.durationMs)&&d.durationMs>=0&&d.durationMs<=d.budgetUsedMs);assert.equal(u.retainedBytes,native.reduce((sum,r)=>sum+r.raw.length,0));
  const requests=report.selection.events.filter(e=>e.kind==='request'),responses=report.selection.events.filter(e=>e.kind==='response');assert.equal(requests.length,3);assert.equal(responses.length,3);assert.equal(u.wireJoins.length,3);
  for(const [i,{path:p,wire:w,raw}]of native.entries()){
   assert.equal(w.dispatched,true);assert.equal(w.transport.complete,true);assert.equal(w.transport.observedBytes,raw.length);assert(raw.length<=HEADER_SELECTION_POLICY.responseBytes);
   assert.deepEqual(requests[i].request,{endpoint:w.url,requestText:w.requestText});assert.deepEqual(requests[i].clock,w.requestClock);assert.deepEqual(responses[i].clock,w.responseClock);
   assert.deepEqual(responses[i].record,{endpoint:w.url,requestText:w.requestText,httpStatus:w.httpStatus??null,responseBase64:w.rawBase64,responseBytesObserved:w.transport.observedBytes,complete:w.transport.complete,error:w.error??null});
   assert.deepEqual(u.wireJoins[i],{id:i+1,path:p,dispatched:true,requestSha256:w.requestSha256,responseSha256:sha(raw),retainedBytes:raw.length,observedBytes:w.transport.observedBytes,saved:true});
  }
  assert.equal(u.observedBytes,native.reduce((sum,r)=>sum+r.wire.transport.observedBytes,0));assert.equal(report.selection.responseBytesObserved,u.observedBytes);
 }
 return{manifest,report,usable,calls:u.calls,networkBytes:u.observedBytes};
}
export async function freeze(prepared,preparationPin,capture){
 prepared=path.resolve(prepared);capture=path.resolve(capture);const prep=validatePreparation(prepared,preparationPin);assert.deepEqual(await sourceRows(),prep.plan.files);assert.deepEqual(nodeIdentity(),prep.plan.node);
 fs.mkdirSync(capture);copyRows(ROOT,path.join(capture,'runtime'),prep.plan.files);copyRows(prepared,path.join(capture,'preparation'),[...prep.manifest.files,entry(prepared,'manifest.json')]);
 const writer=createLedger(capture);for(const r of [...prep.plan.baseTemplates,...prep.plan.templates])writer.write(r.path,read(path.join(prepared,r.path)));
 const sourceManifestSha256=writer.save('source-manifest.json',{schemaVersion:1,files:prep.plan.files,node:prep.plan.node});
 const intent={schemaVersion:1,phase:'frozen_before_selection',createdAt:new Date().toISOString(),runtimePath:path.join(capture,'runtime'),inputBase:capture,sourceRoot:ROOT,node:prep.plan.node,
  limits:LIMITS,selectionPolicy:HEADER_SELECTION_POLICY,aggregateLimits:AGGREGATE_LIMITS,scope:SCOPE,files:prep.plan.files,profile:prep.plan.profile,amendment:prep.plan.amendment,baseTemplates:prep.plan.baseTemplates,templates:prep.plan.templates,sourceManifestSha256,preparationManifestSha256:preparationPin};
 const intentSha256=writer.save('intent.json',intent),intentManifestSha256=writer.seal({intentSha256,sourceManifestSha256},{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json'});validateIntent(capture,intentSha256,{exact:true});
 return{capture,intentSha256,intentManifestSha256,sourceManifestSha256,files:intent.files.length};
}
export function unattemptedRows(templates,reason){return ORDER.map(({kind,index})=>({kind,index,id:templates[index].id,status:'not_attempted',process:null,reason}));}
export function selectionFailureResult({intentSha256,selectionManifestSha256,templates,selection,coordinatorStarted,error,sourceUnchanged}){
 return{intentSha256,planSha256:null,selectionManifestSha256,phase:'selection_or_input_unavailable',coordinatorStarted,selectionUsage:selection?.report?.usage??null,selectionElapsed:selection?.report?.elapsed??null,
 rows:unattemptedRows(templates,'No usable frozen selected-header input'),fatal:{kind:null,index:null,message:String(error?.message??error??'Selection unavailable').slice(0,1024)},sourceUnchanged,evidenceUsable:false,
 networkCalls:null,networkBytes:null,knownBoundedNetworkCalls:0,knownBoundedNetworkBytes:0,scope:SCOPE,denominator:CURRENT_DENOMINATOR,prepareOnly:false};
}
export async function run(intentPin,flag){
 assert.equal(flag,'--execute-frozen-readonly','Explicit execution flag required');const runtime=ROOT,capture=path.dirname(runtime);assert.equal(path.basename(runtime),'runtime');assert.equal(fileURLToPath(import.meta.url),path.join(capture,'runtime',PREFIX,'run.mjs'),'Archived coordinator required');
 const frozen=validateIntent(capture,intentPin,{exact:true}),intent=frozen.intent;assert.equal(intent.inputBase,capture);assert.equal(intent.runtimePath,runtime);assert.deepEqual(await sourceRows(runtime),intent.files);
 const clock=()=>({wallMs:Date.now(),monotonicMs:performance.now()}),coordinatorStarted=clock(),writer=createLedger(capture);writer.save('STARTED.json',{intentSha256:intentPin,at:new Date().toISOString(),clock:coordinatorStarted,pid:process.pid,flag});
 let selectionManifestSha256=null,selection=null,planPin=null,result=null;let sourceUnchanged=false;
 try{
  const directory=path.join(capture,'selection');fs.mkdirSync(directory);const selectionWriter=createLedger(directory);
  const {captureHeaderSelection}=await import('./select-current-header.mjs');
  const report=await captureHeaderSelection({sourceBinding:frozen.sourceBinding,save:(p,v)=>selectionWriter.save(p,v),clock});selectionWriter.save('report.json',report);
  selectionManifestSha256=selectionWriter.seal();const sm=verifyPacket(directory,selectionManifestSha256);writer.adopt('selection',[...sm.files,entry(directory,'manifest.json')].sort((a,b)=>a.path.localeCompare(b.path)));
  selection=validateSelection(directory,selectionManifestSha256,frozen.sourceBinding);validateIntent(capture,intentPin);writer.verify();sourceUnchanged=true;assert(selection.usable,'Header selection, actual I/O drainage or byte/clock bounds unavailable');
  const declarations=deriveCurrentDeclarations({templateBytes:frozen.templateBytes,selection:selection.report.selection,profile:intent.profile});writer.save('declarations.json',declarations);
  const inputs=declarations.cases.map((c,i)=>{const p=`inputs/${id(i)}.json`;writer.save(p,c);return{...entry(capture,p),id:c.id};});
  const plan={...intent,phase:'selected_inputs_frozen',createdAt:new Date().toISOString(),intentSha256:intentPin,selectionManifestSha256,selectionReportPath:'selection/report.json',inputs};planPin=writer.save('plan.json',plan);
  await checkIdentity(plan);writer.verify();for(const kind of ['local','provider'])fs.mkdirSync(path.join(capture,kind));
  const matrix=await executeMatrix(plan,writer,false,{beforeFirstSpawn:()=>assertFirstTargetFresh(selection.report.selection,clock())});
  result={intentSha256:intentPin,planSha256:planPin,selectionManifestSha256,phase:'target_matrix',coordinatorStarted,selectionUsage:selection.report.usage,selectionElapsed:selection.report.elapsed,denominator:CURRENT_DENOMINATOR,...matrix};
 }catch(error){
  // Selection persistence/semantic failures never trigger replacement selection.
  // Adopt any unsealed original partial subtree for failure evidence only.
  if(fs.existsSync(path.join(capture,'selection'))&&selectionManifestSha256===null){try{writer.adopt('selection');}catch{}}
  result=selectionFailureResult({intentSha256:intentPin,selectionManifestSha256,templates:frozen.templates,selection,coordinatorStarted,error,sourceUnchanged});if(planPin!==null)result.planSha256=planPin;
 }
 try{validateIntent(capture,intentPin);writer.verify();if(result.phase==='target_matrix'){const end=clock(),previous=result.elapsed;const elapsed={wallMs:end.wallMs-result.targetPhaseStarted.wallMs,monotonicMs:end.monotonicMs-result.targetPhaseStarted.monotonicMs,reversed:end.wallMs<result.targetPhaseStarted.wallMs+previous.wallMs||end.monotonicMs<result.targetPhaseStarted.monotonicMs+previous.monotonicMs};result.elapsed=elapsed;assert(!elapsed.reversed&&elapsed.wallMs<LIMITS.totalMs&&elapsed.monotonicMs<LIMITS.totalMs,'Terminal target verification budget');}}catch(error){result.evidenceUsable=false;result.sourceUnchanged=false;result.fatal??={kind:null,index:null,message:String(error.message).slice(0,1024)};result.networkCalls=null;result.networkBytes=null;}
 result.totalNetworkCalls=result.evidenceUsable?result.networkCalls+selection.calls:null;result.totalNetworkBytes=result.evidenceUsable?result.networkBytes+selection.networkBytes:null;
 if(result.evidenceUsable){assert(result.totalNetworkCalls<=AGGREGATE_LIMITS.networkCalls);assert(result.totalNetworkBytes<=AGGREGATE_LIMITS.networkBytes);}
 writer.save('results.json',result);const manifestSha256=writer.seal({intentSha256:intentPin,planSha256:result.planSha256});return{manifestSha256,...result};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const[action,...args]=process.argv.slice(2);let out;if(action==='prepare'&&(args.length===1||args.length===2))out=await prepare(args[0],args[1]);else if(action==='freeze'&&args.length===3)out=await freeze(...args);else if(action==='run'&&args.length===2)out=await run(...args);else throw Error('prepare DIR [original_fixed|selected_100_usdc_v1] | freeze PREP_DIR PREP_MANIFEST_SHA CAPTURE_DIR | archived run INTENT_SHA --execute-frozen-readonly');console.log(JSON.stringify(out,null,2));}
