// Exactly two delegated-sender inputs. No network, API or worker dispatch on import.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {read,json,sha,walk,entry,checkRows,copyRows,nodeIdentity,createLedger,verifyPacket} from '../lending-local-sequence-current-v037/archive.mjs';
import {runSealedWorker,validateSealedProcess} from '../worker-process.mjs';
import {TEMPLATE_FILES,PROVENANCE_FILES,originalTemplateBytes,deriveTemplates,deriveDeclarations,CURRENT_DENOMINATOR} from './declarations.mjs';
import {oracleRequests} from '../ordinary-local-coverage-v1/outcomes.mjs';
import {verifyCohortWireRecord} from '../standard-evm/cohort-verify.mjs';
import {replayHeaderSelection,assertFirstTargetFresh,HEADER_SELECTION_POLICY} from '../lending-local-sequence-current-v037/selection.mjs';
export const PREFIX='research/delegated-sender-current-v038';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const OWN=['PLAN.md','run.mjs','run.test.mjs','worker.mjs','declarations.mjs','declarations.test.mjs','outcomes.mjs','outcomes.test.mjs','adjudicate.mjs','adjudicate.test.mjs'];
export const SHARED=['research/worker-process.mjs','research/worker-process.test.mjs',
 ...['archive.mjs','capture.mjs','capture.test.mjs','selection.mjs','selection.test.mjs','strict-json.mjs','strict-json.test.mjs','select-current-header.mjs','select-current-header.test.mjs'].map(n=>'research/lending-local-sequence-current-v037/'+n),
 ...['cohort-http.mjs','cohort-wire.mjs','cohort-wire.test.mjs','cohort-verify.mjs','cohort-freeze.mjs'].map(n=>'research/standard-evm/'+n),
 'research/ordinary-local-coverage-v1/outcomes.mjs',
 // Input-only header fixture used by the retained selector controls.
 'research/lending-local-sequence-v037/capture/inputs/001.json'];
export const LIMITS=Object.freeze({cases:2,processes:4,positions:2,totalMs:700000,localProcessMs:190000,oracleProcessMs:120000,prepareProcessMs:30000,
 streamBytes:1048576,processBytes:2097152,networkCalls:528,networkBytes:128*1024*1024,artifactBytes:2*1024*1024*1024,drainMs:25000,
 timingScope:'matrix_entry_through_final_identity_and_ledger_checks_excluding_prepare_freeze_final_seal_and_saved_comparison'});
export const AGGREGATE_LIMITS=Object.freeze({networkCalls:531,networkBytes:134*1024*1024,selectionPhaseMs:60000,targetPhaseMs:700000});
export const ORDER=Object.freeze(['local','oracle'].flatMap(kind=>[0,1].map(index=>Object.freeze({kind,index}))));
export const SCOPE=Object.freeze({endpoint:'https://eth.drpc.org',adapter:'current_guarded_simulateLocal_and_raw_fixed_four_request_oracle',httpApi:false,ui:false,
 retries:0,providerFallback:false,broadcast:false,sharedProviderInfrastructure:true,independentConsensus:false,fullRealTransactionReplay:false,
 originalGas:5000000,originalPricing:'unsigned_unpriced_block_end',localQueryGas:1000000,localQueries:2,queriesCompared:false,
 selection:'one_fresh_header_then_fixed_hash_no_reselection',freshAtSelectionOnly:true,standardApiAdmissionUsed:false,
 denominator:'two_fixed_original_calls_ten_channels_all_failures_and_unattempted_retained'});
const id=i=>String(i+1).padStart(3,'0');
export async function sourceRows(root=ROOT){
 const pins=[...TEMPLATE_FILES,...PROVENANCE_FILES];for(const pin of pins){const actual=entry(root,pin.path);assert.equal(actual.kind,'file');assert.equal(actual.bytes,pin.bytes);assert.equal(actual.sha256,pin.sha256);}
 const paths=['package.json',...OWN.map(n=>PREFIX+'/'+n),...SHARED,...pins.map(r=>r.path)];
 for(const name of fs.readdirSync(path.join(root,'src')))if(/\.(js|json)$/.test(name))paths.push('src/'+name);
 for(const name of fs.readdirSync(path.join(root,'engines')))if(fs.lstatSync(path.join(root,'engines',name)).isFile())paths.push('engines/'+name);
 for(const engine of ['local-evm','standard-evm','fixture-evm']){const dir='engines/'+engine;for(const name of fs.readdirSync(path.join(root,dir)))if(/\.(js|json)$/.test(name))paths.push(dir+'/'+name);paths.push(...walk(root,dir+'/node_modules'));}
 const rows=[...new Set(paths)].sort().map(p=>entry(root,p));assert(rows.length<12000&&rows.reduce((s,r)=>s+(r.bytes??0),0)<128*1024*1024);return rows;
}
export function invocation(plan,index,kind,outDir,prepareOnly=false){assert([0,1].includes(index)&&['local','oracle'].includes(kind));return{executable:plan.node.executable,args:['--max-old-space-size=768',path.join(plan.runtimePath,PREFIX,'worker.mjs'),path.join(plan.inputBase,'plan.json'),String(index),kind,outDir,...(prepareOnly?['--prepare-only']:[])]};}
export function validateProcessRecord(record,{plan,index,kind,outDir,prepareOnly=false,stdout,stderr}){
 const maximum=prepareOnly?LIMITS.prepareProcessMs:kind==='local'?LIMITS.localProcessMs:LIMITS.oracleProcessMs;assert(Number.isSafeInteger(record.timeoutMs)&&record.timeoutMs>0&&record.timeoutMs<=maximum);
 validateSealedProcess({record,stdout,stderr,invocation:invocation(plan,index,kind,outDir,prepareOnly),timeoutMs:record.timeoutMs,streamBytes:LIMITS.streamBytes});
}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function errorShape(e){assert(plain(e));assert.deepEqual(Object.keys(e).sort(),['code','message','name']);assert(typeof e.name==='string'&&e.name.length<=128);assert(typeof e.message==='string'&&e.message.length<=2048);assert(e.code===null||typeof e.code==='string'&&e.code.length<=256);}
function nativeUsage(u,kind){assert(plain(u));assert.equal(u.pending,0);for(const k of['unaccountedData','saveFailed','cancelFailed'])assert.equal(u[k],false);assert.equal(u.closed,true);assert(Number.isSafeInteger(u.calls)&&u.calls>=0&&u.calls<=(kind==='local'?260:4));assert(Number.isSafeInteger(u.observedBytes)&&u.observedBytes>=0&&u.observedBytes<=32*1024*1024);}
export function validateWorkerReport(r,{plan,index,kind,prepareOnly=false,pid}){
 assert(Number.isSafeInteger(pid)&&pid>0);assert.equal(r.schemaVersion,1);assert.equal(r.index,index);assert.equal(r.id,plan.inputs[index].id);assert.equal(r.kind,kind);assert.equal(r.inputSha256,plan.inputs[index].sha256);assert.equal(r.workerPid,pid);
 if(prepareOnly){assert.equal(r.status,'prepared_no_execution');assert.equal(r.executionInvoked,false);assert.equal(r.networkCalls,0);assert.match(r.implementation?.sourceSha256,/^[0-9a-f]{64}$/);return{status:'prepared',bounded:true,calls:0,networkBytes:0};}
 assert(['returned','threw'].includes(r.status));if(r.status==='threw')errorShape(r.error);else assert.equal(r.error,null);
 assert.equal(r.sourceUnchanged,true);assert.equal(r.drain.capture.complete,true);assert.equal(r.drain.childClosure,true);
 for(const n of[r.elapsed.wallMs,r.elapsed.monotonicMs])assert(Number.isFinite(n)&&n>=0&&n<=(kind==='local'?LIMITS.localProcessMs:LIMITS.oracleProcessMs));
 const usage=kind==='local'?r.captureUsage:r.nativeCaptureUsage;nativeUsage(usage,kind);
 if(kind==='local'){assert.match(r.implementation?.sourceSha256,/^[0-9a-f]{64}$/);assert.equal(r.drain.rpc.complete,true);assert(Array.isArray(r.rpcEvidence)&&r.rpcEvidence.length>=usage.calls&&r.rpcEvidence.length<=260);if(r.status==='returned')assert(plain(r.report));else assert.equal(r.report,null);}
 else{assert.equal(r.implementation,null);assert.equal(r.drain.cohort.complete,true);assert(plain(r.oracle));assert(['completed','unavailable'].includes(r.oracle.dispatch));assert(Array.isArray(r.oracle.records)&&r.oracle.records.length<=4);assert(Array.isArray(r.oracle.attempts)&&r.oracle.attempts.length<=4);if(r.status==='threw')assert.equal(r.oracle.dispatch,'unavailable');}
 return{status:r.status==='returned'?'returned':'unavailable',bounded:true,calls:usage.calls,networkBytes:usage.observedBytes};
}
export const validateReport=validateWorkerReport;

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

export async function executeMatrix(plan,writer,prepareOnly,{identity=checkIdentity,attempt=processOnce,now=Date.now,monotonic=()=>performance.now(),beforeFirstSpawn=()=>null}={}){
 const began=now(),start=monotonic();let lastWall=began,lastMono=start,fatal=null,calls=0,networkBytes=0;const rows=[];
 const timing=()=>{const wall=now(),mono=monotonic(),reversed=wall<lastWall||mono<lastMono;lastWall=wall;lastMono=mono;const t={wallMs:wall-began,monotonicMs:mono-start,reversed};assert(!reversed&&Number.isFinite(t.wallMs)&&Number.isFinite(t.monotonicMs)&&t.wallMs>=0&&t.monotonicMs>=0&&t.wallMs<LIMITS.totalMs&&t.monotonicMs<LIMITS.totalMs,'Global clock/budget');return t;};
 for(const{kind,index}of ORDER){if(fatal){rows.push({kind,index,id:plan.inputs[index].id,status:'not_attempted',process:null,reason:'Prior integrity/budget/closure failure'});continue;}
  let result=null;try{timing();await identity(plan);writer.verify();const t=timing(),maximum=prepareOnly?LIMITS.prepareProcessMs:kind==='local'?LIMITS.localProcessMs:LIMITS.oracleProcessMs;
   assert(LIMITS.totalMs-Math.max(t.wallMs,t.monotonicMs)>maximum,'Insufficient remaining full process budget');
   result=await attempt(plan,index,kind,prepareOnly,writer,maximum,{beforeSpawn:kind==='local'&&index===0?beforeFirstSpawn:()=>null});rows.push({kind,index,id:plan.inputs[index].id,...result});assert(result.bounded,'Unproven bounds, drainage or child closure');
   calls+=result.calls;networkBytes+=result.networkBytes;assert(calls<=LIMITS.networkCalls&&networkBytes<=LIMITS.networkBytes);await identity(plan);writer.verify();timing();
  }catch(e){fatal={kind,index,message:String(e.message).slice(0,1024)};if(!result)rows.push({kind,index,id:plan.inputs[index].id,status:'unavailable',process:null,reason:fatal.message});}}
 let elapsed,sourceUnchanged=false;try{await identity(plan);writer.verify();elapsed=timing();sourceUnchanged=true;}catch(e){fatal??={kind:null,index:null,message:String(e.message).slice(0,1024)};const wall=now(),mono=monotonic();elapsed={wallMs:wall-began,monotonicMs:mono-start,reversed:wall<lastWall||mono<lastMono};}
 return{rows,fatal,sourceUnchanged,elapsed,targetPhaseStarted:{wallMs:began,monotonicMs:start},networkCalls:fatal?null:calls,networkBytes:fatal?null:networkBytes,knownBoundedNetworkCalls:calls,knownBoundedNetworkBytes:networkBytes,evidenceUsable:fatal===null&&sourceUnchanged,scope:SCOPE,prepareOnly};
}

export function validateWorkerEvidence(directory,report,{input}={}){
 const allowed=p=>['request.json','report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/\d{4}\.json$/.test(p)||(report.kind==='oracle'&&/^cohort\/\d{4}\.json$/.test(p));
 assert(walk(directory).every(allowed),'Unexpected worker artifact');
 if(report.kind==='local'){
  if(report.status==='returned')assert.deepEqual(report.report?.transportEvidence,report.rpcEvidence,'API evidence differs from the actual captured client evidence');
  return validateWireDirectory(directory,report);
 }
 assert(input);const expected=oracleRequests({request:input.request,header:input.header}),o=report.oracle,u=report.nativeCaptureUsage;
 const nativeDir=path.join(directory,'wire'),paths=fs.existsSync(nativeDir)?walk(nativeDir):[],cohortDir=path.join(directory,'cohort'),saved=fs.existsSync(cohortDir)?walk(cohortDir):[];
 assert.equal(paths.length,u.calls);assert.equal(saved.length,o.records.length);assert(o.records.length<=o.attempts.length&&o.attempts.length<=4);
 const byRequest=new Map();let observed=0;
 for(const [i,p]of paths.entries()){
  assert.equal(p,String(i+1).padStart(4,'0')+'.json');const w=json(path.join(nativeDir,p)),raw=Buffer.from(w.rawBase64,'base64');assert.equal(w.id,i+1);assert.equal(new URL(w.url).href,new URL(SCOPE.endpoint).href);
  assert.equal(w.requestBytes,Buffer.byteLength(w.requestText));assert.equal(w.requestSha256,sha(w.requestText));assert.equal(raw.toString('base64'),w.rawBase64);assert.equal(raw.length,w.transport.retainedBytes);assert.equal(sha(raw),w.transport.retainedSha256);assert(w.transport.observedBytes>=raw.length);observed+=w.transport.observedBytes;
  assert(!byRequest.has(w.requestText));byRequest.set(w.requestText,w);
 }
 const joined=new Set();let completed=true;
 for(const [i,r]of o.records.entries()){
  assert.equal(saved[i],String(i+1).padStart(4,'0')+'.json');assert.deepEqual(json(path.join(cohortDir,saved[i])),r);verifyCohortWireRecord(r);assert.equal(r.provider,'drpc');assert.equal(r.profile,'product');assert.equal(r.globalId,i+1);assert.equal(r.id,i+1);
  assert.deepEqual(r.request,{jsonrpc:'2.0',id:i+1,method:expected[i].method,params:expected[i].params});
  const native=byRequest.get(r.requestText);if(native){assert(!joined.has(r.requestText));joined.add(r.requestText);if(r.transport.complete){assert.equal(native.transport.complete,true);assert.equal(native.httpStatus,r.httpStatus);assert.equal(native.rawBase64,r.rawBase64);}else assert.equal(r.status,'failed');}
  else{assert.equal(r.status,'failed');assert.equal(r.transport.complete,false);assert.equal(r.transport.observedBytes,0);assert.equal(r.transport.retainedBytes,0);assert.equal(r.httpStatus,undefined);}
  completed&&=r.status==='completed';
 }
 assert.equal(joined.size,byRequest.size,'Native wire has no corresponding cohort record');
 for(const [i,a]of o.attempts.entries()){
  assert.equal(a.label,expected[i].label);assert(['returned','failed'].includes(a.status));if(a.status==='returned'){assert.equal(o.records[i]?.status,'completed');assert.equal(a.code,undefined);}else{assert(typeof a.code==='string'&&a.code.length<=256);completed=false;}
 }
 assert.deepEqual(o.transportWireIds,o.records.map(r=>r.globalId));assert.equal(o.transportUsage.attempts,o.records.length);assert.equal(o.transportUsage.dispatches,u.calls);assert.equal(observed,u.observedBytes);
 assert.deepEqual(o.transportUsage.limits,{calls:4,totalBytes:32*1024*1024,requestMs:25000,responseBytes:8*1024*1024,wallMs:90000});
 assert.equal(o.dispatch,o.attempts.length===4&&o.records.length===4&&completed?'completed':'unavailable');
 return{calls:paths.length,observedBytes:observed};
}
export async function processOnce(plan,index,kind,prepareOnly,writer,timeoutMs,{beforeSpawn=()=>null}={}){
 const relative=`${kind}/${id(index)}`,outDir=path.join(plan.inputBase,relative),call=invocation(plan,index,kind,outDir,prepareOnly);
 const result=await runSealedWorker({...call,cwd:plan.runtimePath,outDir,relative,stem:`processes/${kind}-${id(index)}`,writer,timeoutMs,streamBytes:LIMITS.streamBytes,beforeSpawn});
 let validation={status:'unavailable',bounded:false,calls:null,networkBytes:null};
 try{assert(result.boundedProcess&&result.workerSealed);validateProcessRecord(result.record,{plan,index,kind,outDir,prepareOnly,stdout:result.stdout,stderr:result.stderr});
  if(!prepareOnly)validateWorkerEvidence(outDir,result.report,{input:json(path.join(plan.inputBase,plan.inputs[index].path))});
  validation=validateWorkerReport(result.report,{plan,index,kind,prepareOnly,pid:result.record.pid});
 }catch{}
 return{...validation,process:result.processPath,seal:result.sealPath,workerManifestSha256:result.workerManifestSha256};
}
export function templateBytes(root=ROOT){return originalTemplateBytes(root);}
export function validateTemplates(directory,record){
 assert.equal(record.originalTemplates.length,2);assert.equal(record.templates.length,2);
 const bytes=record.originalTemplates.map((r,i)=>{assert.equal(r.path,`original-templates/${id(i)}.json`);checkRows(directory,[r]);assert.equal(r.bytes,TEMPLATE_FILES[i].bytes);assert.equal(r.sha256,TEMPLATE_FILES[i].sha256);return read(path.join(directory,r.path));});
 const bundle=deriveTemplates({templateBytes:bytes});
 for(const [i,r]of record.templates.entries()){assert.equal(r.path,`templates/${id(i)}.json`);checkRows(directory,[Object.fromEntries(Object.entries(r).filter(([k])=>k!=='id'))]);assert.equal(r.id,bundle.cases[i].id);assert.deepEqual(read(path.join(directory,r.path)),Buffer.from(JSON.stringify(bundle.cases[i],null,2)+'\n'));}
 return{templateBytes:bytes,templates:bundle.cases,bundle};
}
export async function checkIdentity(plan){
 assert.deepEqual(nodeIdentity(),plan.node);assert.deepEqual(walk(plan.runtimePath),plan.files.map(r=>r.path));checkRows(plan.runtimePath,plan.files);checkRows(plan.inputBase,plan.inputs.map(({id,...r})=>r));
 const frozen=validateIntent(plan.inputBase,plan.intentSha256);assert.deepEqual(plan.files,frozen.intent.files);assert.deepEqual(plan.node,frozen.intent.node);assert.deepEqual(plan.templates,frozen.intent.templates);assert.deepEqual(plan.originalTemplates,frozen.intent.originalTemplates);
 const selection=validateSelection(path.join(plan.inputBase,'selection'),plan.selectionManifestSha256,frozen.sourceBinding);assert(selection.usable);
 const declarations=deriveDeclarations({templateBytes:frozen.templateBytes,header:selection.report.selection.header});assert.deepEqual(json(path.join(plan.inputBase,'declarations.json')),declarations);assert.equal(plan.phase,'selected_inputs_frozen');
 for(let i=0;i<2;i++)assert.deepEqual(json(path.join(plan.inputBase,plan.inputs[i].path)),declarations.cases[i]);
}
export async function prepare(directory){
 const bytes=templateBytes(),bundle=deriveTemplates({templateBytes:bytes}),files=await sourceRows();directory=path.resolve(directory);fs.mkdirSync(directory);const writer=createLedger(directory);
 const originalTemplates=bytes.map((b,i)=>{const p=`original-templates/${id(i)}.json`;writer.write(p,b);return entry(directory,p);});
 const templates=bundle.cases.map((c,i)=>{const p=`templates/${id(i)}.json`;writer.save(p,c);return{...entry(directory,p),id:c.id};});writer.save('templates.json',bundle);
 const plan={schemaVersion:1,phase:'offline_preparation',createdAt:new Date().toISOString(),runtimePath:ROOT,inputBase:directory,node:nodeIdentity(),limits:LIMITS,scope:SCOPE,denominator:CURRENT_DENOMINATOR,files,originalTemplates,templates,inputs:templates};writer.save('plan.json',plan);
 for(const kind of['local','oracle'])fs.mkdirSync(path.join(directory,kind));
 const identity=async p=>{assert.deepEqual(await sourceRows(),p.files);assert.deepEqual(nodeIdentity(),p.node);assert.deepEqual(p.inputs,p.templates);validateTemplates(directory,p);};
 const result=await executeMatrix(plan,writer,true,{identity});writer.save('results.json',result);const manifestSha256=writer.seal();return{directory,manifestSha256,allPrepared:result.evidenceUsable&&result.rows.every(r=>r.status==='prepared'),rows:result.rows};
}
export function validatePreparation(directory,pin){
 const manifest=verifyPacket(directory,pin),plan=json(path.join(directory,'plan.json')),result=json(path.join(directory,'results.json'));
 assert.equal(plan.phase,'offline_preparation');assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.scope,SCOPE);assert.deepEqual(plan.denominator,CURRENT_DENOMINATOR);assert.deepEqual(plan.inputs,plan.templates);
 const derived=validateTemplates(directory,plan);assert.deepEqual(json(path.join(directory,'templates.json')),derived.bundle);
 assert.equal(result.prepareOnly,true);assert.equal(result.evidenceUsable,true);assert.equal(result.fatal,null);assert.equal(result.sourceUnchanged,true);assert.equal(result.networkCalls,0);assert.equal(result.networkBytes,0);assert.deepEqual(result.rows.map(({kind,index})=>({kind,index})),ORDER);
 for(const row of result.rows){const {kind,index}=row,relative=`${kind}/${id(index)}`,stem=`processes/${kind}-${id(index)}`;assert.equal(row.status,'prepared');assert.equal(row.bounded,true);assert.equal(row.calls,0);assert.equal(row.networkBytes,0);assert.equal(row.process,stem+'-process.json');assert.equal(row.seal,stem+'-seal.json');assert.equal(row.id,plan.inputs[index].id);
  const record=json(path.join(directory,row.process)),seal=json(path.join(directory,row.seal)),outDir=path.join(directory,relative);assert.equal(sha(read(path.join(directory,row.process))),seal.processSha256);assert.equal(seal.workerSealed,true);assert.equal(row.workerManifestSha256,seal.workerManifestSha256);verifyPacket(outDir,seal.workerManifestSha256);
  assert.deepEqual(seal.stdout,record.stdout);assert.deepEqual(seal.stderr,record.stderr);for(const k of['stdout','stderr'])assert.equal(record[k].path,stem+'.'+k);
  const stdout=read(path.join(directory,record.stdout.path)),stderr=read(path.join(directory,record.stderr.path));assert.deepEqual(JSON.parse(stdout),{status:'prepared_no_execution',manifestSha256:seal.workerManifestSha256});
  validateProcessRecord(record,{plan,index,kind,outDir:path.join(plan.inputBase,relative),prepareOnly:true,stdout,stderr});assert.deepEqual(validateWorkerReport(json(path.join(outDir,'report.json')),{plan,index,kind,prepareOnly:true,pid:record.pid}),{status:'prepared',bounded:true,calls:0,networkBytes:0});
 }
 return{manifest,plan,result};
}
export function validateIntent(capture,intentPin,{exact=false}={}){
 capture=path.resolve(capture);assert.match(intentPin,/^[a-f0-9]{64}$/);assert.equal(sha(read(path.join(capture,'intent.json'))),intentPin);const intent=json(path.join(capture,'intent.json'));
 assert.equal(intent.phase,'frozen_before_selection');assert.deepEqual(intent.limits,LIMITS);assert.deepEqual(intent.scope,SCOPE);assert.deepEqual(intent.denominator,CURRENT_DENOMINATOR);assert.deepEqual(intent.selectionPolicy,HEADER_SELECTION_POLICY);assert.deepEqual(intent.aggregateLimits,AGGREGATE_LIMITS);assert.deepEqual(nodeIdentity(),intent.node);
 assert.equal(sha(read(path.join(capture,'source-manifest.json'))),intent.sourceManifestSha256);assert.deepEqual(json(path.join(capture,'source-manifest.json')),{schemaVersion:1,files:intent.files,node:intent.node});
 const runtime=path.join(capture,'runtime');assert.deepEqual(walk(runtime),intent.files.map(r=>r.path));checkRows(runtime,intent.files);
 const prep=validatePreparation(path.join(capture,'preparation'),intent.preparationManifestSha256);for(const k of['files','node','templates','originalTemplates'])assert.deepEqual(prep.plan[k],intent[k]);
 const derived=validateTemplates(capture,intent);for(let i=0;i<2;i++)assert.deepEqual(read(path.join(runtime,TEMPLATE_FILES[i].path)),derived.templateBytes[i]);
 const intentManifestSha256=sha(read(path.join(capture,'intent-manifest.json'))),manifest=verifyPacket(capture,intentManifestSha256,{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json',exact});assert.equal(manifest.intentSha256,intentPin);assert.equal(manifest.sourceManifestSha256,intent.sourceManifestSha256);
 const pre=[...intent.files.map(r=>'runtime/'+r.path),...walk(path.join(capture,'preparation')).map(p=>'preparation/'+p)],expected=[...pre,...intent.originalTemplates.map(r=>r.path),...intent.templates.map(r=>r.path),'source-manifest.json','intent.json','intent-write-ledger.json'].sort();assert.deepEqual(manifest.files.map(r=>r.path).sort(),expected);
 const ledger=json(path.join(capture,'intent-write-ledger.json'));assert.deepEqual(ledger.files,manifest.files.filter(r=>r.path!=='intent-write-ledger.json').map(r=>({...r,origin:pre.includes(r.path)?'preexisting':'written'})));
 return{intent,manifest,intentManifestSha256,...derived,sourceBinding:{intentPlanSha256:intentPin,sourceManifestSha256:intent.sourceManifestSha256,nodeSha256:intent.node.sha256}};
}
export async function freeze(prepared,preparationPin,capture){
 prepared=path.resolve(prepared);capture=path.resolve(capture);const prep=validatePreparation(prepared,preparationPin);assert.deepEqual(await sourceRows(),prep.plan.files);assert.deepEqual(nodeIdentity(),prep.plan.node);
 fs.mkdirSync(capture);copyRows(ROOT,path.join(capture,'runtime'),prep.plan.files);copyRows(prepared,path.join(capture,'preparation'),[...prep.manifest.files,entry(prepared,'manifest.json')]);const writer=createLedger(capture);
 for(const r of[...prep.plan.originalTemplates,...prep.plan.templates])writer.write(r.path,read(path.join(prepared,r.path)));
 const sourceManifestSha256=writer.save('source-manifest.json',{schemaVersion:1,files:prep.plan.files,node:prep.plan.node});
 const intent={schemaVersion:1,phase:'frozen_before_selection',createdAt:new Date().toISOString(),runtimePath:path.join(capture,'runtime'),inputBase:capture,sourceRoot:ROOT,node:prep.plan.node,limits:LIMITS,selectionPolicy:HEADER_SELECTION_POLICY,aggregateLimits:AGGREGATE_LIMITS,scope:SCOPE,denominator:CURRENT_DENOMINATOR,files:prep.plan.files,templates:prep.plan.templates,originalTemplates:prep.plan.originalTemplates,sourceManifestSha256,preparationManifestSha256:preparationPin};
 const intentSha256=writer.save('intent.json',intent),intentManifestSha256=writer.seal({intentSha256,sourceManifestSha256},{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json'});validateIntent(capture,intentSha256,{exact:true});return{capture,intentSha256,intentManifestSha256,sourceManifestSha256,files:intent.files.length};
}
export function unattemptedRows(templates,reason){return ORDER.map(({kind,index})=>({kind,index,id:templates[index].id,status:'not_attempted',process:null,reason}));}
export function selectionFailureResult({intentSha256,selectionManifestSha256,templates,selection,coordinatorStarted,error,sourceUnchanged}){
 return{intentSha256,planSha256:null,selectionManifestSha256,phase:'selection_or_input_unavailable',coordinatorStarted,selectionUsage:selection?.report?.usage??null,selectionElapsed:selection?.report?.elapsed??null,rows:unattemptedRows(templates,'No usable frozen selected-header input'),fatal:{kind:null,index:null,message:String(error?.message??error??'Selection unavailable').slice(0,1024)},sourceUnchanged,evidenceUsable:false,networkCalls:null,networkBytes:null,knownBoundedNetworkCalls:0,knownBoundedNetworkBytes:0,scope:SCOPE,denominator:CURRENT_DENOMINATOR,prepareOnly:false};
}
export async function run(intentPin,flag){
 assert.equal(flag,'--execute-frozen-readonly');const runtime=ROOT,capture=path.dirname(runtime);assert.equal(path.basename(runtime),'runtime');assert.equal(fileURLToPath(import.meta.url),path.join(capture,'runtime',PREFIX,'run.mjs'));
 const frozen=validateIntent(capture,intentPin,{exact:true}),intent=frozen.intent;assert.equal(intent.inputBase,capture);assert.equal(intent.runtimePath,runtime);assert.deepEqual(await sourceRows(runtime),intent.files);
 const clock=()=>({wallMs:Date.now(),monotonicMs:performance.now()}),coordinatorStarted=clock(),writer=createLedger(capture);writer.save('STARTED.json',{intentSha256:intentPin,at:new Date().toISOString(),clock:coordinatorStarted,pid:process.pid,flag});
 let selectionManifestSha256=null,selection=null,planPin=null,result=null,sourceUnchanged=false;
 try{
  const directory=path.join(capture,'selection');fs.mkdirSync(directory);const selectionWriter=createLedger(directory),{captureHeaderSelection}=await import('../lending-local-sequence-current-v037/select-current-header.mjs');
  const report=await captureHeaderSelection({sourceBinding:frozen.sourceBinding,save:(p,v)=>selectionWriter.save(p,v),clock});selectionWriter.save('report.json',report);selectionManifestSha256=selectionWriter.seal();const sm=verifyPacket(directory,selectionManifestSha256);writer.adopt('selection',[...sm.files,entry(directory,'manifest.json')].sort((a,b)=>a.path.localeCompare(b.path)));
  selection=validateSelection(directory,selectionManifestSha256,frozen.sourceBinding);validateIntent(capture,intentPin);writer.verify();sourceUnchanged=true;assert(selection.usable,'Selection or native I/O closure unavailable');
  const declarations=deriveDeclarations({templateBytes:frozen.templateBytes,header:selection.report.selection.header});writer.save('declarations.json',declarations);const inputs=declarations.cases.map((c,i)=>{const p=`inputs/${id(i)}.json`;writer.save(p,c);return{...entry(capture,p),id:c.id};});
  const plan={...intent,phase:'selected_inputs_frozen',createdAt:new Date().toISOString(),intentSha256:intentPin,selectionManifestSha256,selectionReportPath:'selection/report.json',inputs};planPin=writer.save('plan.json',plan);await checkIdentity(plan);writer.verify();for(const kind of['local','oracle'])fs.mkdirSync(path.join(capture,kind));
  const matrix=await executeMatrix(plan,writer,false,{beforeFirstSpawn:()=>assertFirstTargetFresh(selection.report.selection,clock())});result={intentSha256:intentPin,planSha256:planPin,selectionManifestSha256,phase:'target_matrix',coordinatorStarted,selectionUsage:selection.report.usage,selectionElapsed:selection.report.elapsed,denominator:CURRENT_DENOMINATOR,...matrix};
 }catch(error){if(fs.existsSync(path.join(capture,'selection'))&&selectionManifestSha256===null){try{writer.adopt('selection');}catch{}}result=selectionFailureResult({intentSha256:intentPin,selectionManifestSha256,templates:frozen.templates,selection,coordinatorStarted,error,sourceUnchanged});if(planPin!==null)result.planSha256=planPin;}
 try{validateIntent(capture,intentPin);writer.verify();if(result.phase==='target_matrix'){const end=clock(),previous=result.elapsed,elapsed={wallMs:end.wallMs-result.targetPhaseStarted.wallMs,monotonicMs:end.monotonicMs-result.targetPhaseStarted.monotonicMs,reversed:end.wallMs<result.targetPhaseStarted.wallMs+previous.wallMs||end.monotonicMs<result.targetPhaseStarted.monotonicMs+previous.monotonicMs};result.elapsed=elapsed;assert(!elapsed.reversed&&elapsed.wallMs<LIMITS.totalMs&&elapsed.monotonicMs<LIMITS.totalMs,'Terminal target verification budget');}}
 catch(error){result.evidenceUsable=false;result.sourceUnchanged=false;result.fatal??={kind:null,index:null,message:String(error.message).slice(0,1024)};result.networkCalls=null;result.networkBytes=null;}
 result.totalNetworkCalls=result.evidenceUsable?result.networkCalls+selection.calls:null;result.totalNetworkBytes=result.evidenceUsable?result.networkBytes+selection.networkBytes:null;
 if(result.evidenceUsable){assert(result.totalNetworkCalls<=AGGREGATE_LIMITS.networkCalls);assert(result.totalNetworkBytes<=AGGREGATE_LIMITS.networkBytes);}
 writer.save('results.json',result);const manifestSha256=writer.seal({intentSha256:intentPin,planSha256:result.planSha256});return{manifestSha256,...result};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const[action,...args]=process.argv.slice(2);let out;if(action==='prepare'&&args.length===1)out=await prepare(args[0]);else if(action==='freeze'&&args.length===3)out=await freeze(...args);else if(action==='run'&&args.length===2)out=await run(...args);else throw Error('prepare DIR | freeze PREP_DIR PREP_MANIFEST_SHA CAPTURE_DIR | archived run INTENT_SHA --execute-frozen-readonly');console.log(JSON.stringify(out,null,2));}
