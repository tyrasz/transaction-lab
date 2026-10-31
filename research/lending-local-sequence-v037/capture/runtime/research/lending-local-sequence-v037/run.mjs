// Fixed two-case preparation, archival freeze and one-shot current API capture.
// Importing this module performs no network or API execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,json,sha,walk,entry,checkRows,copyRows,nodeIdentity,createLedger,verifyPacket} from './archive.mjs';
export const PREFIX='research/lending-local-sequence-v037';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const OWN=['PLAN.md','declarations.mjs','declarations.test.mjs','NOTES-preparation.md','observations.mjs','observations.test.mjs','state-observations.mjs','state-observations.test.mjs','context-validation.mjs','context-validation.test.mjs',
 'adjudicate.mjs','adjudicate.test.mjs','run.mjs','run.test.mjs','archive.mjs','capture.mjs','capture.test.mjs','worker.mjs'];
export const LIMITS=Object.freeze({cases:2,processes:4,positions:6,totalMs:900000,localProcessMs:190000,providerProcessMs:300000,prepareProcessMs:30000,
 streamBytes:1048576,processBytes:2097152,networkCalls:1036,networkBytes:320*1024*1024,artifactBytes:2*1024*1024*1024,drainMs:25000,
 timingScope:'matrix_entry_through_final_identity_and_ledger_checks_excluding_prepare_freeze_final_seal_and_saved_comparison'});
export const ORDER=Object.freeze(['local','provider'].flatMap(kind=>[0,1].map(index=>Object.freeze({kind,index}))));
export const SCOPE=Object.freeze({endpoint:'https://eth.drpc.org',adapter:'current_guarded_local_and_current_standard_sequence_APIs',httpApi:false,ui:false,
 retries:0,providerFallback:false,broadcast:false,sharedProviderInfrastructure:true,independentConsensus:false,fullRealTransactionReplay:false,
 originalGas:5000000,originalPricing:'unsigned_unpriced_block_end',localQueryGas:1000000,providerQueryGas:300000,
 queryTiming:'local_all_originals_then_disposable_queries_provider_between_originals',queryGasEquivalent:false,
 denominator:'two_fixed_sequences_three_declared_positions_each_failures_and_unattempted_retained'});
const id=i=>String(i+1).padStart(3,'0');
export async function sourceRows(root=ROOT){
 const {SOURCE_FILES}=await import(pathToFileURL(path.join(root,PREFIX,'declarations.mjs')));
 const paths=['package.json',...OWN.map(n=>PREFIX+'/'+n),'research/standard-evm/cohort-http.mjs','reports/ethereum-lending-local-reference/compare.mjs','reports/ethereum-proof-capability/capture.json',...['sequence-fixture','fee-fixture','amsterdam-execution-fixture','authorization-fixture','lifecycle-fixture','proof-fixture'].map(n=>'engines/local-evm/test/'+n+'.js'),...SOURCE_FILES.map(r=>r.path)];
 for(const name of fs.readdirSync(path.join(root,'src')))if(/\.(js|json)$/.test(name))paths.push('src/'+name);
 for(const name of fs.readdirSync(path.join(root,'engines')))if(fs.lstatSync(path.join(root,'engines',name)).isFile())paths.push('engines/'+name);
 for(const engine of ['local-evm','standard-evm','fixture-evm']){const dir='engines/'+engine;for(const name of fs.readdirSync(path.join(root,dir)))if(/\.(js|json)$/.test(name))paths.push(dir+'/'+name);paths.push(...walk(root,dir+'/node_modules'));}
 const rows=[...new Set(paths)].sort().map(p=>entry(root,p));assert(rows.length<12000&&rows.reduce((s,r)=>s+(r.bytes??0),0)<128*1024*1024);return rows;
}
export function invocation(plan,index,kind,outDir,prepareOnly=false){assert([0,1].includes(index)&&['local','provider'].includes(kind));return{executable:plan.node.executable,args:['--max-old-space-size=768',path.join(plan.runtimePath,PREFIX,'worker.mjs'),path.join(plan.inputBase,'plan.json'),String(index),kind,outDir,...(prepareOnly?['--prepare-only']:[])]};}
export async function checkIdentity(plan){assert.deepEqual(nodeIdentity(),plan.node);assert.deepEqual(walk(plan.runtimePath),plan.files.map(r=>r.path));checkRows(plan.runtimePath,plan.files);checkRows(plan.inputBase,plan.inputs.map(({id,...r})=>r));}
export function validateReport(report,{plan,index,kind,prepareOnly=false,pid}){
 assert.equal(report.id,plan.inputs[index].id);assert.equal(report.inputSha256,plan.inputs[index].sha256);assert.equal(report.kind,kind);assert.equal(report.workerPid,pid);
 assert.equal(report.schemaVersion,1);assert(report.implementation?.sourceSha256);
 if(prepareOnly){assert.equal(report.status,'prepared_no_execution');assert.equal(report.executionInvoked,false);assert.equal(report.networkCalls,0);return{status:'prepared',bounded:true,calls:0,networkBytes:0};}
 assert(['returned','threw'].includes(report.status));assert.equal(report.sourceUnchanged,true);assert.equal(report.drain.rpc.complete,true);assert.equal(report.drain.capture.complete,true);assert.equal(report.drain.childClosure,true);
 const u=report.captureUsage;assert.equal(u.pending,0);assert.equal(u.unaccountedData,false);assert.equal(u.saveFailed,false);assert.equal(u.cancelFailed,false);assert.equal(u.closed,true);
 assert(Number.isSafeInteger(u.calls)&&u.calls>=0&&u.calls<=(kind==='local'?260:258));assert(Number.isSafeInteger(u.observedBytes)&&u.observedBytes>=0&&u.observedBytes<=(kind==='local'?32:128)*1024*1024);
 assert(Array.isArray(report.rpcEvidence)&&report.rpcEvidence.length>=u.calls&&report.rpcEvidence.length<=(kind==='local'?260:258));assert(report.elapsed.wallMs>=0&&report.elapsed.monotonicMs>=0);
 return{status:report.status==='returned'?'returned':'unavailable',bounded:true,calls:u.calls,networkBytes:u.observedBytes};
}
export function validateProcessRecord(record,{plan,index,kind,outDir,prepareOnly,stdout,stderr}){
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
export async function processOnce(plan,index,kind,prepareOnly,writer,timeoutMs){
 const relative=`${kind}/${id(index)}`,outDir=path.join(plan.inputBase,relative);fs.mkdirSync(outDir,{recursive:false});
 const call=invocation(plan,index,kind,outDir,prepareOnly),start=Date.now(),mono=performance.now(),buffers={stdout:[],stderr:[]},observed={stdout:0,stderr:0};
 let child,limitFailure=null,error=null,cleanupSignalAccepted=false;const kill=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');cleanupSignalAccepted=true;}catch(e){if(e.code==='ESRCH')cleanupSignalAccepted=true;else error??={name:e.name,message:e.message};}};
 let timer;const terminal=await new Promise(resolve=>{
  try{child=spawn(call.executable,call.args,{cwd:plan.runtimePath,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',LANG:'C',TZ:'UTC'}});}catch(e){error={name:e.name,message:e.message};return resolve({status:null,signal:null,closed:false});}
  timer=setTimeout(()=>{limitFailure='wall_timeout';kill();},timeoutMs);
  for(const k of ['stdout','stderr'])child[k].on('data',chunk=>{const old=observed[k];observed[k]+=chunk.length;const room=Math.max(0,LIMITS.streamBytes-old);if(room)buffers[k].push(chunk.subarray(0,room));if(observed[k]>LIMITS.streamBytes){limitFailure='output_bytes';kill();}});
  child.on('error',e=>{error={name:e.name,message:e.message,code:e.code??null};});child.on('close',(status,signal)=>resolve({status,signal,closed:true}));
 });clearTimeout(timer);kill();
 const stem=`processes/${kind}-${id(index)}`,stdout=Buffer.concat(buffers.stdout),stderr=Buffer.concat(buffers.stderr),record={...call,pid:child?.pid??null,timeoutMs,wallMs:Date.now()-start,monotonicMs:performance.now()-mono,...terminal,error,limitFailure,cleanupSignalAccepted,observedBytes:observed};
 let report=null,workerManifestSha256=null,workerSealed=false;
 try{const summary=JSON.parse(stdout);workerManifestSha256=summary.manifestSha256;const m=verifyPacket(outDir,workerManifestSha256);writer.adopt(relative,[...m.files,entry(outDir,'manifest.json')].sort((a,b)=>a.path.localeCompare(b.path)));workerSealed=true;report=json(path.join(outDir,'report.json'));}
 catch(e){try{writer.adopt(relative);}catch{}error??={name:e.name,message:e.message};record.error=error;}
 for(const[k,bytes]of[['stdout',stdout],['stderr',stderr]]){writer.write(stem+'.'+k,bytes);record[k]={path:stem+'.'+k,bytes:bytes.length,sha256:sha(bytes)};}
 const processSha256=writer.save(stem+'-process.json',record);writer.save(stem+'-seal.json',{processSha256,workerManifestSha256,workerSealed,stdout:record.stdout,stderr:record.stderr});
 let validation={status:'unavailable',bounded:false,calls:null,networkBytes:null};
 try{assert(workerSealed&&terminal.closed&&terminal.status===0&&terminal.signal===null&&error===null&&limitFailure===null&&cleanupSignalAccepted&&stderr.length===0);
  validateProcessRecord(record,{plan,index,kind,outDir,prepareOnly,stdout,stderr});if(!prepareOnly)validateWireDirectory(outDir,report);validation=validateReport(report,{plan,index,kind,prepareOnly,pid:record.pid});}catch{}
 return{...validation,process:stem+'-process.json',seal:stem+'-seal.json',workerManifestSha256};
}
export async function executeMatrix(plan,writer,prepareOnly,{identity=checkIdentity,attempt=processOnce,now=Date.now,monotonic=()=>performance.now()}={}){
 const began=now(),start=monotonic();let lastWall=began,lastMono=start,fatal=null,calls=0,networkBytes=0;const rows=[];
 const timing=()=>{const wall=now(),mono=monotonic(),reversed=wall<lastWall||mono<lastMono;lastWall=wall;lastMono=mono;const t={wallMs:wall-began,monotonicMs:mono-start,reversed};assert(!reversed&&Number.isFinite(t.wallMs)&&Number.isFinite(t.monotonicMs)&&t.wallMs>=0&&t.monotonicMs>=0&&t.wallMs<LIMITS.totalMs&&t.monotonicMs<LIMITS.totalMs,'Global clock/budget');return t;};
 for(const{kind,index}of ORDER){if(fatal){rows.push({kind,index,id:plan.inputs[index].id,status:'not_attempted',process:null,reason:'Prior integrity/budget/closure failure'});continue;}
  let result=null;try{timing();await identity(plan);writer.verify();const t=timing(),maximum=prepareOnly?LIMITS.prepareProcessMs:kind==='local'?LIMITS.localProcessMs:LIMITS.providerProcessMs;
   assert(LIMITS.totalMs-Math.max(t.wallMs,t.monotonicMs)>maximum,'Insufficient remaining full process budget');
   result=await attempt(plan,index,kind,prepareOnly,writer,maximum);rows.push({kind,index,id:plan.inputs[index].id,...result});assert(result.bounded,'Unproven bounds, drainage or child closure');
   calls+=result.calls;networkBytes+=result.networkBytes;assert(calls<=LIMITS.networkCalls&&networkBytes<=LIMITS.networkBytes);await identity(plan);writer.verify();timing();
  }catch(e){fatal={kind,index,message:String(e.message).slice(0,1024)};if(!result)rows.push({kind,index,id:plan.inputs[index].id,status:'unavailable',process:null,reason:fatal.message});}}
 let elapsed,sourceUnchanged=false;try{await identity(plan);writer.verify();elapsed=timing();sourceUnchanged=true;}catch(e){fatal??={kind:null,index:null,message:String(e.message).slice(0,1024)};const wall=now(),mono=monotonic();elapsed={wallMs:wall-began,monotonicMs:mono-start,reversed:wall<lastWall||mono<lastMono};}
 return{rows,fatal,sourceUnchanged,elapsed,networkCalls:fatal?null:calls,networkBytes:fatal?null:networkBytes,knownBoundedNetworkCalls:calls,knownBoundedNetworkBytes:networkBytes,evidenceUsable:fatal===null&&sourceUnchanged,scope:SCOPE,prepareOnly};
}
async function declarations(root=ROOT){const m=await import(pathToFileURL(path.join(root,PREFIX,'declarations.mjs')));const d=await m.loadLendingSequenceDeclarations({root});assert(d.cases.length===2);return d;}
export async function prepare(directory){
 directory=path.resolve(directory);fs.mkdirSync(directory);const d=await declarations(),files=await sourceRows(),writer=createLedger(directory);writer.save('declarations.json',d);
 const inputs=d.cases.map((c,i)=>{const p=`inputs/${id(i)}.json`;writer.save(p,c);return{...entry(directory,p),id:c.id};});
 const plan={schemaVersion:1,createdAt:new Date().toISOString(),runtimePath:ROOT,inputBase:directory,node:nodeIdentity(),limits:LIMITS,scope:SCOPE,files,inputs};writer.save('plan.json',plan);
 for(const kind of ['local','provider'])fs.mkdirSync(path.join(directory,kind));
 const identity=async p=>{assert.deepEqual(await sourceRows(),p.files);assert.deepEqual(nodeIdentity(),p.node);checkRows(directory,inputs.map(({id,...r})=>r));};
 const result=await executeMatrix(plan,writer,true,{identity});writer.save('results.json',result);const manifestSha256=writer.seal();return{directory,manifestSha256,allPrepared:result.evidenceUsable&&result.rows.every(r=>r.status==='prepared'),rows:result.rows};
}
export function validatePreparation(directory,pin){const m=verifyPacket(directory,pin),p=json(path.join(directory,'plan.json')),r=json(path.join(directory,'results.json'));assert.deepEqual(p.limits,LIMITS);assert.deepEqual(p.scope,SCOPE);assert.equal(r.prepareOnly,true);assert.equal(r.evidenceUsable,true);assert.equal(r.networkCalls,0);assert.equal(r.networkBytes,0);assert.deepEqual(r.rows.map(x=>({kind:x.kind,index:x.index})),ORDER);
 for(const row of r.rows){assert.equal(row.status,'prepared');const out=path.join(directory,row.kind,id(row.index)),seal=json(path.join(directory,row.seal)),rec=json(path.join(directory,row.process));assert.equal(sha(read(path.join(directory,row.process))),seal.processSha256);assert.equal(rec.status,0);assert.equal(rec.signal,null);assert.equal(rec.closed,true);assert.equal(rec.error,null);assert.equal(rec.limitFailure,null);assert.equal(rec.cleanupSignalAccepted,true);verifyPacket(out,seal.workerManifestSha256);
  assert.deepEqual({executable:rec.executable,args:rec.args},invocation(p,row.index,row.kind,path.join(p.inputBase,row.kind,id(row.index)),true));for(const k of ['stdout','stderr'])assert.equal(sha(read(path.join(directory,rec[k].path))),rec[k].sha256);assert.equal(rec.stderr.bytes,0);validateProcessRecord(rec,{plan:p,index:row.index,kind:row.kind,outDir:path.join(p.inputBase,row.kind,id(row.index)),prepareOnly:true,stdout:read(path.join(directory,rec.stdout.path)),stderr:read(path.join(directory,rec.stderr.path))});validateReport(json(path.join(out,'report.json')),{plan:p,index:row.index,kind:row.kind,prepareOnly:true,pid:rec.pid});}
 return{manifest:m,plan:p,result:r};}
export async function freeze(prepared,preparationPin,capture){prepared=path.resolve(prepared);capture=path.resolve(capture);const prep=validatePreparation(prepared,preparationPin);assert.deepEqual(await sourceRows(),prep.plan.files);assert.deepEqual(nodeIdentity(),prep.plan.node);
 fs.mkdirSync(capture);copyRows(ROOT,path.join(capture,'runtime'),prep.plan.files);const allPrep=[...prep.manifest.files,entry(prepared,'manifest.json')];copyRows(prepared,path.join(capture,'preparation'),allPrep);
 const writer=createLedger(capture);for(const r of prep.plan.inputs)writer.write(r.path,read(path.join(prepared,r.path)));writer.write('declarations.json',read(path.join(prepared,'declarations.json')));
 const plan={...prep.plan,createdAt:new Date().toISOString(),runtimePath:path.join(capture,'runtime'),inputBase:capture,sourceRoot:ROOT,preparationManifestSha256:preparationPin};writer.save('plan.json',plan);await checkIdentity(plan);writer.verify();
 return{capture,planSha256:sha(read(path.join(capture,'plan.json'))),sourceSha256:sha(Buffer.from(JSON.stringify(plan.files))),files:plan.files.length};}
export async function run(planPin,flag){assert.equal(flag,'--execute-frozen-readonly','Explicit execution flag required');const runtime=ROOT,capture=path.dirname(runtime);assert.equal(path.basename(runtime),'runtime');assert.equal(fileURLToPath(import.meta.url),path.join(capture,'runtime',PREFIX,'run.mjs'),'Archived driver required');assert.equal(sha(read(path.join(capture,'plan.json'))),planPin);const plan=json(path.join(capture,'plan.json'));assert.equal(plan.inputBase,capture);assert.equal(plan.runtimePath,runtime);assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.scope,SCOPE);
 await checkIdentity(plan);validatePreparation(path.join(capture,'preparation'),plan.preparationManifestSha256);
 const expected=[...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'declarations.json','plan.json',...walk(path.join(capture,'preparation')).map(p=>'preparation/'+p)].sort();assert.deepEqual(walk(capture),expected,'Capture already started or altered');
 const writer=createLedger(capture);writer.save('STARTED.json',{planSha256:planPin,at:new Date().toISOString(),pid:process.pid,flag});for(const kind of ['local','provider'])fs.mkdirSync(path.join(capture,kind));
 const result={planSha256:planPin,...await executeMatrix(plan,writer,false)};writer.save('results.json',result);const manifestSha256=writer.seal({planSha256:planPin});return{manifestSha256,...result};}
if(process.argv[1]===fileURLToPath(import.meta.url)){const[action,...args]=process.argv.slice(2);let out;if(action==='prepare'&&args.length===1)out=await prepare(args[0]);else if(action==='freeze'&&args.length===3)out=await freeze(...args);else if(action==='run'&&args.length===2)out=await run(...args);else throw Error('prepare DIR | freeze PREP_DIR PREP_MANIFEST_SHA CAPTURE_DIR | archived run PLAN_SHA --execute-frozen-readonly');console.log(JSON.stringify(out,null,2));}
