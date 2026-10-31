// Pure input/evidence validation, fake HTTP and harmless child programs only.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {PREFIX,ROOT,LIMITS,AGGREGATE_LIMITS,ORDER,SCOPE,OWN,SHARED,invocation,validateProcessRecord,validateWorkerReport,validateWorkerEvidence,executeMatrix,processOnce,run,selectionFailureResult,validateSelection,validateTemplates,templateBytes} from './run.mjs';
import {createLedger,sha,entry,json} from '../lending-local-sequence-current-v037/archive.mjs';
import {deriveTemplates,CURRENT_DENOMINATOR} from './declarations.mjs';
import {captureOracle,boundedDrain} from './worker.mjs';
import {captureHeaderSelection} from '../lending-local-sequence-current-v037/select-current-header.mjs';
const temp=t=>{const p=fs.mkdtempSync('/private/tmp/delegated-current-control-');t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const cases=deriveTemplates({templateBytes:templateBytes()}).cases;
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:process.execPath},inputs:cases.map((c,i)=>({id:c.id,path:`inputs/00${i+1}.json`,sha256:'a'.repeat(64)}))};
const usage={calls:0,observedBytes:0,pending:0,unaccountedData:false,saveFailed:false,cancelFailed:false,closed:true};
function report(kind='local',prepareOnly=false){return{schemaVersion:1,kind,index:0,id:cases[0].id,inputSha256:'a'.repeat(64),workerPid:123,status:prepareOnly?'prepared_no_execution':'returned',implementation:kind==='oracle'&&!prepareOnly?null:{sourceSha256:'b'.repeat(64)},...(prepareOnly?{executionInvoked:false,networkCalls:0}:{error:null,sourceUnchanged:true,elapsed:{wallMs:1,monotonicMs:1},drain:{rpc:{complete:true},cohort:{complete:true},capture:{complete:true},childClosure:true},...(kind==='local'?{report:{synthetic:true},captureUsage:{...usage},rpcEvidence:[]}:{oracle:{dispatch:'unavailable',records:[],attempts:[]},nativeCaptureUsage:{...usage}})})};}
test('fixed two originals, raw oracle rather than Standard admission, unchanged budgets and archived-only dispatch',async()=>{
 assert.deepEqual(ORDER,[{kind:'local',index:0},{kind:'local',index:1},{kind:'oracle',index:0},{kind:'oracle',index:1}]);assert.equal(LIMITS.localProcessMs,190000);assert.equal(LIMITS.oracleProcessMs,120000);assert.equal(LIMITS.totalMs,700000);assert.equal(LIMITS.networkCalls,2*260+2*4);assert.equal(AGGREGATE_LIMITS.networkCalls,531);assert.equal(AGGREGATE_LIMITS.networkBytes,134*1024*1024);
 assert.equal(SCOPE.standardApiAdmissionUsed,false);assert.equal(SCOPE.queriesCompared,false);assert.deepEqual(CURRENT_DENOMINATOR,{cases:2,originalPositions:2,originalChannels:10,queriesCompared:0});
 assert(invocation(plan,0,'oracle','/frozen/oracle/001',true).args.includes('--prepare-only'));assert.throws(()=>invocation(plan,0,'provider','/frozen/001'));
 await assert.rejects(run('a'.repeat(64),'--execute-frozen-readonly'));await assert.rejects(run('a'.repeat(64),'wrong'));
});
test('source closure explicitly includes process guard, raw transports and all current family sources',()=>{
 assert(OWN.includes('declarations.mjs')&&OWN.includes('outcomes.mjs')&&OWN.includes('adjudicate.mjs'));
 for(const p of['research/worker-process.mjs','research/worker-process.test.mjs','research/standard-evm/cohort-wire.mjs','research/standard-evm/cohort-http.mjs','research/ordinary-local-coverage-v1/outcomes.mjs'])assert(SHARED.includes(p));
 assert(!SHARED.includes('research/lending-local-sequence-current-v037/run.mjs'));
});
test('complete worker reports bind PID/input/index and actual closure for both kinds',()=>{
 for(const kind of['local','oracle']){const r=report(kind);assert.equal(validateWorkerReport(r,{plan,index:0,kind,pid:123}).bounded,true);
  for(const mutate of[x=>x.workerPid=124,x=>x.index=1,x=>x.inputSha256='c'.repeat(64),x=>x.sourceUnchanged=false,x=>x.drain.capture.complete=false,x=>x.drain.childClosure=false,x=>x.elapsed.monotonicMs=-1,x=>x.elapsed.wallMs=190001,x=>{(x.captureUsage??x.nativeCaptureUsage).pending=1;},x=>{(x.captureUsage??x.nativeCaptureUsage).cancelFailed=true;},x=>{(x.captureUsage??x.nativeCaptureUsage).calls=kind==='local'?261:5;},x=>{(x.captureUsage??x.nativeCaptureUsage).observedBytes=32*1024*1024+1;}]){const bad=structuredClone(r);mutate(bad);assert.throws(()=>validateWorkerReport(bad,{plan,index:0,kind,pid:123}));}
  assert.equal(validateWorkerReport(report(kind,true),{plan,index:0,kind,pid:123,prepareOnly:true}).status,'prepared');
 }
});
test('returned and thrown local dispositions cannot mix actionable report and error',()=>{
 const r=report(),check=x=>validateWorkerReport(x,{plan,index:0,kind:'local',pid:123});check(r);
 const thrown={...r,status:'threw',report:null,error:{name:'Error',code:null,message:'Synthetic'}};assert.equal(check(thrown).status,'unavailable');
 for(const bad of[{...r,error:thrown.error},{...r,report:null},{...thrown,report:{}},{...thrown,error:null},{...thrown,error:{...thrown.error,extra:true}}])assert.throws(()=>check(bad));
});
test('nested API evidence must equal the actual client evidence joined to native bytes',t=>{
 const d=temp(t),writer=createLedger(d),requestText=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),responseText='{"jsonrpc":"2.0","id":1,"result":"0x1"}',raw=Buffer.from(responseText);
 writer.save('wire/0001.json',{id:1,url:SCOPE.endpoint,requestText,requestBytes:Buffer.byteLength(requestText),requestSha256:sha(requestText),rawBase64:raw.toString('base64'),transport:{retainedBytes:raw.length,retainedSha256:sha(raw),observedBytes:raw.length,complete:true}});
 const evidence=[{requestText,responseText,transport:{responseSha256:sha(raw)}}],r={...report(),captureUsage:{...usage,calls:1,observedBytes:raw.length},rpcEvidence:evidence,report:{transportEvidence:structuredClone(evidence)}};
 validateWorkerEvidence(d,r);for(const change of[x=>x.report.transportEvidence=[],x=>x.report.transportEvidence[0].responseText='{}',x=>delete x.report.transportEvidence]){const bad=structuredClone(r);change(bad);assert.throws(()=>validateWorkerEvidence(d,bad));}
});
test('all local seals precede either oracle and both fixed originals remain in every row',async t=>{
 const d=temp(t),w=createLedger(d),seen=[];let checks=0;const result=await executeMatrix(plan,w,false,{identity:async()=>{checks++;},attempt:async(p,i,k,prep,writer)=>{if(k==='oracle')for(const n of[0,1])assert(fs.existsSync(path.join(d,`local-${n}-seal.json`)));writer.save(`${k}-${i}-seal.json`,{saved:true});seen.push({kind:k,index:i});return{status:'returned',bounded:true,calls:1,networkBytes:10};}});
 assert.deepEqual(seen,ORDER);assert.equal(checks,9);assert.equal(result.evidenceUsable,true);assert.equal(result.networkCalls,4);w.verify();
});
test('unbounded process stops remaining dispatch and preserves all unavailable positions',async t=>{
 let dispatched=0;const r=await executeMatrix(plan,createLedger(temp(t)),false,{identity:async()=>{},attempt:async()=>{dispatched++;return{status:'unavailable',bounded:false,calls:null,networkBytes:null};}});assert.equal(dispatched,1);assert.equal(r.evidenceUsable,false);assert.equal(r.rows.length,4);assert(r.rows.slice(1).every(x=>x.status==='not_attempted'));
});
test('source/ledger/clock faults retain rows while withholding global metrics',async t=>{
 for(const mode of['source','ledger','clock','terminal']){const d=temp(t),w=createLedger(d);let checks=0,clock=100,mono=0;const result=await executeMatrix(plan,w,false,{now:()=>clock,monotonic:()=>mono,identity:async()=>{if(mode==='source'&&++checks===2)throw Error('drift');},attempt:async(p,i,k,prep,writer)=>{if(mode==='ledger')fs.writeFileSync(path.join(d,'unregistered'),'x');if(mode==='clock')clock=99;if(mode==='terminal'&&i===1&&k==='oracle')mono=LIMITS.totalMs+1;return{status:'returned',bounded:true,calls:0,networkBytes:0};}});assert.equal(result.evidenceUsable,false);assert.equal(result.rows.length,4);assert.equal(result.networkCalls,null);assert(result.fatal);}
});
async function inert(t,body){const d=temp(t),runtime=path.join(d,'runtime'),own=path.join(runtime,PREFIX);fs.mkdirSync(own,{recursive:true});fs.writeFileSync(path.join(own,'worker.mjs'),body);fs.mkdirSync(path.join(d,'local'));return{p:{...plan,inputBase:d,runtimePath:runtime},w:createLedger(d),d};}
test('shared helper bounds harmless timeout and stream overflow with unavailable evidence',async t=>{
 for(const mode of['timeout','overflow']){const body=mode==='timeout'?'setInterval(()=>{},1000);':"const b=Buffer.alloc(65536);function write(){if(process.stdout.write(b))setImmediate(write);else process.stdout.once('drain',write);}write();";
  const {p,w,d}=await inert(t,body),r=await processOnce(p,0,'local',true,w,mode==='timeout'?80:2000),saved=json(path.join(d,r.process));assert.equal(r.bounded,false);assert.equal(saved.limitFailure,mode==='timeout'?'wall_timeout':'output_bytes');assert(saved.closed&&saved.cleanupSignalAccepted);w.verify();}
});
test('expired first-spawn freshness gate executes no child and retains fixed failure',async t=>{
 const {p,w,d}=await inert(t,"require('node:fs').writeFileSync('SHOULD_NOT_RUN','bad');");const r=await processOnce(p,0,'local',true,w,100,{beforeSpawn:()=>{throw Error('expired');}}),rec=json(path.join(d,r.process));assert.equal(rec.pid,null);assert.equal(rec.closed,false);assert.equal(rec.error.message,'expired');assert(!fs.existsSync(path.join(p.runtimePath,'SHOULD_NOT_RUN')));w.verify();
});
test('process saved validator rejects signal, changed argv and clock or stream contradictions',()=>{
 const outDir='/frozen/oracle/001',stdout=Buffer.from('{}'),stderr=Buffer.alloc(0),record={...invocation(plan,0,'oracle',outDir),pid:123,timeoutMs:120000,wallMs:1,monotonicMs:1,closed:true,status:0,signal:null,error:null,limitFailure:null,cleanupSignalAccepted:true,observedBytes:{stdout:2,stderr:0},stdout:{bytes:2,sha256:sha(stdout)},stderr:{bytes:0,sha256:sha(stderr)}};
 const check=r=>validateProcessRecord(r,{plan,index:0,kind:'oracle',outDir,stdout,stderr});check(record);for(const change of[r=>r.signal='SIGKILL',r=>r.args.pop(),r=>r.monotonicMs=120001,r=>r.observedBytes.stdout=3,r=>r.pid=null]){const bad=structuredClone(record);change(bad);assert.throws(()=>check(bad));}
});
test('preparation never constructs clients or executes local/oracle operations',()=>{
 const s=fs.readFileSync(new URL('./worker.mjs',import.meta.url),'utf8'),guard=s.indexOf("if(prepareOnly){assert.deepEqual(nodeIdentity()");assert(guard>0);const terminal=s.indexOf("return{status:'prepared_no_execution',manifestSha256};}",guard);assert(terminal>guard);assert(terminal<s.indexOf('result=await captureOracle',terminal));assert(terminal<s.indexOf('new ProofRpcClient',terminal));assert(terminal<s.indexOf('await api.simulateLocal(',terminal));assert(!s.includes('loadStandardApi'));assert(!s.includes('simulateStandard'));
});
function templates(t){const directory=temp(t),bytes=templateBytes(),bundle=deriveTemplates({templateBytes:bytes});const originalTemplates=bytes.map((b,i)=>{const p=`original-templates/00${i+1}.json`;fs.mkdirSync(path.join(directory,'original-templates'),{recursive:true});fs.writeFileSync(path.join(directory,p),b);return entry(directory,p);}),templateRows=bundle.cases.map((c,i)=>{const p=`templates/00${i+1}.json`;fs.mkdirSync(path.join(directory,'templates'),{recursive:true});fs.writeFileSync(path.join(directory,p),JSON.stringify(c,null,2)+'\n');return{...entry(directory,p),id:c.id};});return{directory,record:{originalTemplates,templates:templateRows},bytes,bundle};}
test('immutable original bytes and prepared query inputs are independently rederived',t=>{
 const t0=templates(t),valid=validateTemplates(t0.directory,t0.record);assert.deepEqual(valid.templateBytes,t0.bytes);assert.deepEqual(valid.bundle,t0.bundle);
 for(const change of[r=>r.originalTemplates.reverse(),r=>r.templates[0].id='wrong',r=>r.templates[0].path='../escape',r=>r.templates.push(r.templates[0])]){const bad=structuredClone(t0.record);change(bad);assert.throws(()=>validateTemplates(t0.directory,bad));}
 for(const key of['originalTemplates','templates']){const p=templates(t),row=p.record[key][0],f=path.join(p.directory,row.path);fs.appendFileSync(f,' ');p.record[key][0]={...entry(p.directory,row.path),...(row.id?{id:row.id}:{})};assert.throws(()=>validateTemplates(p.directory,p.record));}
});
test('selection failure retains all four targets and ten unknown comparison channels',()=>{
 const r=selectionFailureResult({intentSha256:'a'.repeat(64),selectionManifestSha256:null,templates:cases,selection:null,coordinatorStarted:{wallMs:1,monotonicMs:1},error:Error('unavailable'),sourceUnchanged:true});assert.equal(r.rows.length,4);assert(r.rows.every(x=>x.status==='not_attempted'));assert.equal(r.denominator.originalChannels,10);assert.equal(r.planSha256,null);assert.equal(r.evidenceUsable,false);
});
async function mockOracle(t,{failAt=null,cancelReject=false}={}){
 const directory=temp(t),writer=createLedger(directory);let calls=0;
 const out=await captureOracle({input:cases[0],writer,fetchImpl:async(url,options)=>{calls++;const req=JSON.parse(options.body),value=JSON.stringify({jsonrpc:'2.0',id:req.id,...(calls===failAt?{error:{code:-32000,message:'Synthetic unavailable'}}:{result:req.method.startsWith('eth_getBlock')?cases[0].header:{}})});
  if(cancelReject){let sent=false;return{ok:true,status:200,headers:new Headers(),body:{getReader(){return{read:async()=>sent?{done:true}:(sent=true,{done:false,value:Buffer.from(value)}),cancel:async()=>{throw Error('synthetic cancel rejected');}};}}};}
  return new Response(value,{status:200});}});
 const r={...report('oracle'),...out,sourceUnchanged:true};return{directory,writer,r,calls};
}
test('raw reference makes exactly four fixed reads and both native/cohort representations join',async t=>{
 const p=await mockOracle(t);assert.equal(p.calls,4);assert.equal(p.r.oracle.dispatch,'completed');assert.equal(p.r.drain.cohort.complete,true);assert.equal(p.r.drain.capture.complete,true);assert.equal(validateWorkerReport(p.r,{plan,index:0,kind:'oracle',pid:123}).calls,4);assert.equal(validateWorkerEvidence(p.directory,p.r,{input:cases[0]}).calls,4);p.writer.verify();
});
test('RPC failure is retained, never retried, and leaves reference unavailable',async t=>{
 const p=await mockOracle(t,{failAt:2});assert.equal(p.calls,4);assert.equal(p.r.oracle.dispatch,'unavailable');assert.equal(p.r.oracle.records[1].status,'failed');assert.equal(p.r.oracle.records[1].error,'rpc_error');assert.equal(p.r.oracle.attempts[1].status,'failed');validateWorkerEvidence(p.directory,p.r,{input:cases[0]});
 const forged=structuredClone(p.r);forged.oracle.dispatch='completed';assert.throws(()=>validateWorkerEvidence(p.directory,forged,{input:cases[0]}));
});
test('native cancellation rejection cannot be classified as closed usable reference evidence',async t=>{
 const p=await mockOracle(t,{cancelReject:true});assert.equal(p.r.drain.capture.complete,false);assert.equal(p.r.nativeCaptureUsage.cancelFailed,true);assert.throws(()=>validateWorkerReport(p.r,{plan,index:0,kind:'oracle',pid:123}));
});
test('coherent reference wrapper edits cannot change raw request, bytes or complete attempt count',async t=>{
 const p=await mockOracle(t);for(const change of[r=>r.oracle.records[0].request.params[0]='0x'+'aa'.repeat(32),r=>r.oracle.attempts[1].label='state_diff',r=>r.oracle.transportWireIds.pop(),r=>r.oracle.records.pop(),r=>r.nativeCaptureUsage.observedBytes++]){const bad=structuredClone(p.r);change(bad);assert.throws(()=>validateWorkerEvidence(p.directory,bad,{input:cases[0]}));}
 const f=path.join(p.directory,'wire/0002.json'),w=json(f);fs.chmodSync(f,0o644);w.rawBase64=Buffer.from('{}').toString('base64');w.transport.retainedBytes=2;w.transport.retainedSha256=sha('{}');fs.writeFileSync(f,JSON.stringify(w));assert.throws(()=>validateWorkerEvidence(p.directory,p.r,{input:cases[0]}));
});
test('bounded drain rejects both rejection and a still-pending cleanup',async()=>{
 assert.equal((await boundedDrain(async()=>{},10)).complete,true);assert.equal((await boundedDrain(async()=>{throw Error('no');},10)).complete,false);assert.equal((await boundedDrain(()=>new Promise(()=>{}),10)).complete,false);
});
test('mock selection seals native reads and paired clocks before any declared input can be usable',async t=>{
 const d=temp(t),writer=createLedger(d),header=cases[0].header,sourceBinding={intentPlanSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),nodeSha256:'c'.repeat(64)},clock=()=>({wallMs:Number(BigInt(header.timestamp))*1000+1000,monotonicMs:1});let calls=0;
 const r=await captureHeaderSelection({sourceBinding,save:(p,v)=>writer.save(p,v),clock,fetchImpl:async(url,opts)=>{calls++;const req=JSON.parse(opts.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:req.id===1?'0x1':header}),{status:200});}});writer.save('report.json',r);const pin=writer.seal();assert.equal(calls,3);assert.equal(validateSelection(d,pin,sourceBinding).usable,true);
});
