// Pure ledger/matrix controls and harmless child programs only, no network/API execution.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {PREFIX,ROOT,ORDER,LIMITS,SCOPE,invocation,validateReport,executeMatrix,processOnce,run,OWN,validateProcessRecord,validateWireDirectory,selectionFailureResult,AGGREGATE_LIMITS,validateSelection,validateProfileTemplates,templateBytes,prepare,sourceRows,TEMPLATE_PROFILES} from './run.mjs';
import {sha,entry,createLedger,verifyPacket} from './archive.mjs';
import {captureHeaderSelection} from './select-current-header.mjs';
import {deriveTemplateProfile} from './declarations.mjs';
import {FUNDED_PROVENANCE_FILES} from './funded-profile.mjs';
const temp=t=>{const p=fs.mkdtempSync('/private/tmp/lending-sequence-control-');t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:process.execPath},inputs:[0,1].map(i=>({id:'case'+i,path:`inputs/00${i+1}.json`,sha256:'a'.repeat(64)}))};
function report(kind='local',prepareOnly=false){return{schemaVersion:1,id:'case0',kind,inputSha256:'a'.repeat(64),workerPid:123,implementation:{sourceSha256:'b'.repeat(64)},status:prepareOnly?'prepared_no_execution':'returned',...(!prepareOnly?{report:{synthetic:true},error:null}:{}),executionInvoked:false,networkCalls:0,sourceUnchanged:true,
 drain:{rpc:{complete:true},capture:{complete:true},childClosure:true},captureUsage:{pending:0,unaccountedData:false,saveFailed:false,cancelFailed:false,closed:true,calls:1,observedBytes:10},rpcEvidence:[{}],elapsed:{wallMs:10,monotonicMs:10}};}
test('fixed denominator, budgets, API/query asymmetry and archived-only dispatch',async()=>{
 assert.deepEqual(ORDER,[{kind:'local',index:0},{kind:'local',index:1},{kind:'provider',index:0},{kind:'provider',index:1}]);assert.equal(LIMITS.networkCalls,2*260+2*258);assert.equal(LIMITS.positions,6);assert.equal(SCOPE.queryGasEquivalent,false);assert.equal(SCOPE.httpApi,false);
 assert(invocation(plan,0,'local','/frozen/local/001',true).args.includes('--prepare-only'));assert(!invocation(plan,0,'local','/frozen/local/001').args.includes('--prepare-only'));
 await assert.rejects(run('a'.repeat(64),'--execute-frozen-readonly'));await assert.rejects(run('a'.repeat(64),'wrong'));
});
test('actual pending activity, child closure, source drift and byte/call overflow withhold bounds',()=>{
 for(const kind of ['local','provider'])assert.equal(validateReport(report(kind),{plan,index:0,kind,pid:123}).bounded,true);
 for(const change of[r=>r.drain.capture.complete=false,r=>r.drain.rpc.complete=false,r=>r.drain.childClosure=false,r=>r.captureUsage.pending=1,r=>r.captureUsage.unaccountedData=true,r=>r.captureUsage.cancelFailed=true,r=>r.sourceUnchanged=false,r=>r.captureUsage.calls=261,r=>r.captureUsage.observedBytes=33*1024*1024,r=>r.workerPid=124]){const r=report();change(r);assert.throws(()=>validateReport(r,{plan,index:0,kind:'local',pid:123}));}
 for(const pid of[null,0,-1,1.5]){const r=report();r.workerPid=pid;assert.throws(()=>validateReport(r,{plan,index:0,kind:'local',pid}));}
 const p=report('local',true);assert.equal(validateReport(p,{plan,index:0,kind:'local',pid:123,prepareOnly:true}).status,'prepared');p.executionInvoked=true;assert.throws(()=>validateReport(p,{plan,index:0,kind:'local',pid:123,prepareOnly:true}));
});
test('returned reports and thrown errors are mutually exclusive and retain their dispositions',()=>{
 const check=r=>validateReport(r,{plan,index:0,kind:'local',pid:123}),returned=report(),threw={...report(),status:'threw',report:null,error:{name:'Error',code:'SYNTHETIC_CONTROL',message:'Fabricated failure control'}};
 assert.equal(check(returned).status,'returned');assert.equal(check(threw).status,'unavailable');assert.equal(check(threw).bounded,true);assert.equal(threw.status,'threw');
 assert.equal(check({...threw,error:{...threw.error,code:null}}).status,'unavailable');
 for(const mutate of[r=>r.error={name:'Error',code:null,message:'Contradictory error'},r=>r.report=null,r=>r.report=[],r=>r.report='report',r=>r.report=new Date()]){
  const r=structuredClone(returned);mutate(r);assert.throws(()=>check(r));
 }
 for(const mutate of[r=>r.report={synthetic:true},r=>r.error=null,r=>r.error=[],r=>delete r.error.name,r=>r.error.name=1,r=>r.error.name='x'.repeat(129),r=>delete r.error.message,r=>r.error.message=null,r=>r.error.message='x'.repeat(2049),r=>delete r.error.code,r=>r.error.code=1,r=>r.error.code='x'.repeat(LIMITS.streamBytes+1),r=>r.error.extra=true]){
  const r=structuredClone(threw);mutate(r);assert.throws(()=>check(r));
 }
});
test('original-write ledger refuses coherent replacement and unknown membership',t=>{
 for(const mutation of['replace','extra','missing']){const d=temp(t),w=createLedger(d);w.save('raw.json',{value:1});w.save('seal.json',{sha256:sha(fs.readFileSync(path.join(d,'raw.json')))});
 if(mutation==='replace'){fs.chmodSync(path.join(d,'raw.json'),0o644);fs.writeFileSync(path.join(d,'raw.json'),'changed');}else if(mutation==='extra')fs.writeFileSync(path.join(d,'extra'),'x');else fs.unlinkSync(path.join(d,'raw.json'));
 assert.throws(()=>w.verify());assert.throws(()=>w.seal());}
});
test('worker original-write seal is validated before parent adoption, then cannot drift',t=>{
 const d=temp(t),parent=createLedger(d),sub=path.join(d,'local','001');fs.mkdirSync(sub,{recursive:true});const w=createLedger(sub);w.save('report.json',{data:1});const pin=w.seal(),m=verifyPacket(sub,pin);
 parent.adopt('local/001',[...m.files,entry(sub,'manifest.json')].sort((a,b)=>a.path.localeCompare(b.path)));parent.verify();
 fs.chmodSync(path.join(sub,'report.json'),0o644);fs.writeFileSync(path.join(sub,'report.json'),'changed');assert.throws(()=>parent.verify());
});
test('all local seals precede either provider and all four attempts remain in order',async t=>{
 const d=temp(t),w=createLedger(d),seen=[];let checks=0;
 const r=await executeMatrix(plan,w,false,{identity:async()=>{checks++;},attempt:async(p,i,k,prep,writer)=>{assert.equal(prep,false);if(k==='provider')for(const n of[0,1])assert(fs.existsSync(path.join(d,`local-${n}-seal.json`)));writer.save(`${k}-${i}-seal.json`,{saved:true});seen.push({kind:k,index:i});return{status:'returned',bounded:true,calls:2,networkBytes:10};}});
 assert.deepEqual(seen,ORDER);assert.equal(checks,9);assert.equal(r.rows.length,4);assert.equal(r.networkCalls,8);assert.equal(r.evidenceUsable,true);w.verify();
});
test('first unbounded return stops dispatch but preserves every remaining position',async t=>{
 const d=temp(t);let calls=0;const r=await executeMatrix(plan,createLedger(d),false,{identity:async()=>{},attempt:async()=>{calls++;return{status:'unavailable',bounded:false,calls:null,networkBytes:null};}});
 assert.equal(calls,1);assert.equal(r.evidenceUsable,false);assert.equal(r.rows.length,4);assert(r.rows.slice(1).every(r=>r.status==='not_attempted'));
});
test('source/ledger/clock failures cannot produce usable completed metrics',async t=>{
 for(const mode of['source','ledger','clock']){const d=temp(t),w=createLedger(d);let checks=0,clock=100;
 const r=await executeMatrix(plan,w,false,{now:()=>clock,monotonic:()=>100,identity:async()=>{if(mode==='source'&&++checks===2)throw Error('drift');},attempt:async(p,i,k,prep,writer)=>{if(mode==='clock')clock=99;if(mode==='ledger')fs.writeFileSync(path.join(d,'unexpected'),'x');return{status:'returned',bounded:true,calls:0,networkBytes:0};}});assert.equal(r.evidenceUsable,false);assert(r.fatal);assert.equal(r.rows.length,4);}
});
async function inert(t,body){const d=temp(t),runtime=path.join(d,'runtime'),own=path.join(runtime,PREFIX);fs.mkdirSync(own,{recursive:true});fs.writeFileSync(path.join(own,'worker.mjs'),body);fs.mkdirSync(path.join(d,'local'));return{p:{...plan,inputBase:d,runtimePath:runtime},w:createLedger(d),d};}
test('harmless timeout and stdout overflow kill actual worker group, retaining unavailable evidence',async t=>{
 for(const mode of['timeout','overflow']){const body=mode==='timeout'?'setInterval(()=>{},1000);':"const b=Buffer.alloc(65536);function write(){if(process.stdout.write(b))setImmediate(write);else process.stdout.once('drain',write);}write();";
 const {p,w,d}=await inert(t,body),r=await processOnce(p,0,'local',true,w,mode==='timeout'?100:2000);assert.equal(r.bounded,false);assert.equal(r.status,'unavailable');const record=JSON.parse(fs.readFileSync(path.join(d,r.process)));assert.equal(record.limitFailure,mode==='timeout'?'wall_timeout':'output_bytes');assert(record.closed&&record.cleanupSignalAccepted);w.verify();}
});
test('preparation branch precedes client construction and either API execution call',()=>{
 const s=fs.readFileSync(new URL('./worker.mjs',import.meta.url),'utf8'),branch=s.indexOf('if(prepareOnly){');assert(branch>0);assert(branch<s.indexOf('new ProofRpcClient'));assert(branch<s.indexOf("report=await api["));assert(s.slice(branch,s.indexOf('}else{',branch)).includes('executionInvoked:false'));
 for(const p of['selection.mjs','declarations.mjs','select-current-header.mjs'])assert(OWN.includes(p));
});

test('terminal monotonic overrun with small wall elapsed withholds all metrics',async t=>{
 const d=temp(t);let mono=0;const r=await executeMatrix(plan,createLedger(d),false,{now:()=>0,monotonic:()=>mono,identity:async()=>{},attempt:async(p,i,k)=>{if(i===1&&k==='provider')mono=LIMITS.totalMs+1;return{status:'returned',bounded:true,calls:0,networkBytes:0};}});assert.equal(r.rows.length,4);assert.equal(r.evidenceUsable,false);assert(r.fatal);
});

test('process semantic checks bind both clocks, actual stream sizes and original invocation',()=>{
 const outDir='/frozen/local/001',stdout=Buffer.from('{}'),stderr=Buffer.alloc(0),record={...invocation(plan,0,'local',outDir,true),pid:123,timeoutMs:100,wallMs:1,monotonicMs:1,closed:true,status:0,signal:null,error:null,limitFailure:null,cleanupSignalAccepted:true,observedBytes:{stdout:2,stderr:0},stdout:{bytes:2,sha256:sha(stdout)},stderr:{bytes:0,sha256:sha(stderr)}};
 const check=r=>validateProcessRecord(r,{plan,index:0,kind:'local',outDir,prepareOnly:true,stdout,stderr});check(record);
 for(const mutate of[r=>r.monotonicMs=101,r=>r.observedBytes.stdout=3,r=>r.args.pop(),r=>r.cleanupSignalAccepted=false,r=>r.pid=null,r=>r.pid=0,r=>r.pid=-1,r=>r.pid=1.5]){const r=structuredClone(record);mutate(r);assert.throws(()=>check(r));}
});
test('separate raw wire bytes must join exact client request and returned payload',t=>{
 const d=temp(t),w=createLedger(d),requestText=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),responseText='{"jsonrpc":"2.0","id":1,"result":"0x1"}',raw=Buffer.from(responseText);
 w.save('wire/0001.json',{id:1,url:SCOPE.endpoint,requestText,requestBytes:Buffer.byteLength(requestText),requestSha256:sha(requestText),rawBase64:raw.toString('base64'),transport:{retainedBytes:raw.length,retainedSha256:sha(raw),observedBytes:raw.length,complete:true}});
 const r={captureUsage:{calls:1,observedBytes:raw.length},rpcEvidence:[{requestText,responseText,transport:{responseSha256:sha(raw)}}]};validateWireDirectory(d,r);r.rpcEvidence[0].responseText='{}';assert.throws(()=>validateWireDirectory(d,r));
});

test('reverse wire join rejects unbacked successful evidence but retains explicit pre-dispatch denial',t=>{
 const d=temp(t),requestText=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});
 const denied={requestText,status:'failed',dispatched:false,error:{code:'RPC_CANCELLED',message:'Cancelled before actual dispatch'},transport:{complete:false,bodyRetained:false,observedBytes:0,retainedPrefixBytes:0}};
 const r={captureUsage:{calls:0,observedBytes:0},rpcEvidence:[denied]};validateWireDirectory(d,r);
 // Calling capture.fetch is a client dispatch; the capture may still deny it
 // before native network dispatch. Both forms remain explicit zero-byte errors.
 r.rpcEvidence[0]={...denied,dispatched:true};validateWireDirectory(d,r);
 for(const mutate of[c=>{c.responseText='{}';},c=>{c.status='completed';},c=>{delete c.error;},c=>{c.transport.observedBytes=1;},c=>{c.transport.complete=true;},c=>{c.transport.bodyRetained=true;}]){
  const changed=structuredClone(r);mutate(changed.rpcEvidence[0]);assert.throws(()=>validateWireDirectory(d,changed));
 }
});

test('offline intent seal is distinct from the later original-write capture seal',t=>{
 const d=temp(t),w=createLedger(d);w.save('source-manifest.json',{files:[],node:'control'});const intentSha256=w.save('intent.json',{control:true});
 const pin=w.seal({intentSha256},{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json'});
 verifyPacket(d,pin,{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json'});
 const actual=createLedger(d);actual.save('STARTED.json',{intentSha256});const terminal=actual.seal({intentSha256});verifyPacket(d,terminal);
 verifyPacket(d,pin,{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json',exact:false});
 fs.chmodSync(path.join(d,'source-manifest.json'),0o644);fs.writeFileSync(path.join(d,'source-manifest.json'),'changed');
 assert.throws(()=>verifyPacket(d,pin,{ledgerName:'intent-write-ledger.json',manifestName:'intent-manifest.json',exact:false}));
});
test('failed selection preserves two sequences, six positions and all four unattempted targets',()=>{
 const r=selectionFailureResult({intentSha256:'a'.repeat(64),selectionManifestSha256:null,templates:plan.inputs,selection:null,coordinatorStarted:{wallMs:1,monotonicMs:1},error:Error('Selection unavailable'),sourceUnchanged:true});
 assert.equal(r.planSha256,null);assert.equal(r.evidenceUsable,false);assert.equal(r.networkCalls,null);assert.equal(r.networkBytes,null);assert.equal(r.rows.length,4);assert(r.rows.every(row=>row.status==='not_attempted'&&row.process===null));
 assert.deepEqual(r.denominator,{sequences:2,originalPositions:6,originalChannels:30,queryPositions:39,queryChannels:117});assert.equal(AGGREGATE_LIMITS.networkCalls,1039);assert.equal(AGGREGATE_LIMITS.networkBytes,326*1024*1024);
});
test('freshness failure immediately before spawn retains failure and never starts the inert worker',async t=>{
 const {p,w,d}=await inert(t,"require('node:fs').writeFileSync('SHOULD_NOT_RUN','bad');");let checks=0;
 const r=await processOnce(p,0,'local',true,w,100,{beforeSpawn:()=>{checks++;throw Error('Expired first-target window');}});
 const record=JSON.parse(fs.readFileSync(path.join(d,r.process)));assert.equal(checks,1);assert.equal(record.pid,null);assert.equal(record.closed,false);assert.equal(record.error.message,'Expired first-target window');assert.equal(r.bounded,false);assert(!fs.existsSync(path.join(p.runtimePath,'SHOULD_NOT_RUN')));w.verify();
});
test('first-target callback is handed only to local001 in the fixed matrix',async t=>{
 let fresh=0;const r=await executeMatrix(plan,createLedger(temp(t)),false,{identity:async()=>{},beforeFirstSpawn:()=>({sample:++fresh}),attempt:async(p,index,kind,prepare,writer,timeout,options)=>{
  const sample=options.beforeSpawn();assert.deepEqual(sample,kind==='local'&&index===0?{sample:1}:null);return{status:'returned',bounded:true,calls:0,networkBytes:0};
 }});assert.equal(fresh,1);assert.equal(r.rows.length,4);assert.equal(r.evidenceUsable,true);assert(Number.isFinite(r.targetPhaseStarted.monotonicMs));
});

async function mockedSelection(t,mutate=()=>{}){
 const d=temp(t),rows=new Map(),header=JSON.parse(fs.readFileSync(new URL('../lending-local-sequence-v037/capture/inputs/001.json',import.meta.url))).header;
 const sourceBinding={intentPlanSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),nodeSha256:'c'.repeat(64)},stamp={wallMs:Number(BigInt(header.timestamp))*1000+1000,monotonicMs:1};
 const report=await captureHeaderSelection({sourceBinding,save:(p,value)=>rows.set(p,value),clock:()=>stamp,fetchImpl:async(url,options)=>{
  const request=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.id===1?'0x1':header}),{status:200});
 }});assert.equal(report.selection.status,'selected');mutate(report,rows);const w=createLedger(d);for(const[p,row]of rows)w.save(p,row);w.save('report.json',report);return{directory:d,pin:w.seal(),sourceBinding};
}
test('mocked selection joins original raw bytes, native dispatch, paired clocks and sealed wrapper',async t=>{
 const s=await mockedSelection(t);const out=validateSelection(s.directory,s.pin,s.sourceBinding);assert.equal(out.usable,true);assert.equal(out.calls,3);assert(out.networkBytes>0);
 for(const mutate of[(r,w)=>{w.get('wire/0001.json').dispatched=false;},r=>{r.usage.wireJoins[0].dispatched=false;},r=>{r.elapsed.started.wallMs--;},r=>{r.drain.budgetUsedMs=10001;},r=>{r.usage.limits.requests=4;}]){
  const bad=await mockedSelection(t,mutate);assert.throws(()=>validateSelection(bad.directory,bad.pin,bad.sourceBinding));
 }
 const late=await mockedSelection(t,r=>{r.elapsed.nativeMs=60001;});assert.equal(validateSelection(late.directory,late.pin,late.sourceBinding).usable,false);
});

// Template controls exercise exact saved byte representations without invoking
// prepare, a guarded API, a VM, a selector or any transport.
function profilePacket(t,profile){
 const directory=temp(t),base=templateBytes(),derived=deriveTemplateProfile({templateBytes:base,profile});
 const save=(prefix,bytes,cases)=>bytes.map((value,index)=>{const p=`${prefix}/00${index+1}.json`,f=path.join(directory,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,value);return{...entry(directory,p),id:cases[index].id};});
 const record={profile,amendment:derived.amendment,baseTemplates:save('base-templates',base,derived.baseTemplates),templates:save('templates',derived.bytes,derived.templates)};
 return{directory,record,base,derived};
}
test('both fixed profiles retain exact historical base bytes and independently derived profile bytes',t=>{
 assert.deepEqual(TEMPLATE_PROFILES,['original_fixed','selected_100_usdc_v1']);
 for(const profile of TEMPLATE_PROFILES){const p=profilePacket(t,profile),out=validateProfileTemplates(p.directory,p.record);
  assert.deepEqual(out.templateBytes,p.base);assert.deepEqual(out.profileTemplateBytes,p.derived.bytes);assert.deepEqual(out.templates,p.derived.templates);assert.deepEqual(out.amendment,p.derived.amendment);
  if(profile==='original_fixed'){assert.deepEqual(out.profileTemplateBytes,out.templateBytes);assert.equal(out.amendment,null);}
  else{assert.notDeepEqual(out.profileTemplateBytes,out.templateBytes);assert(out.amendment);assert(out.templates.every(c=>c.amounts.depositRaw==='100000000'&&c.amounts.withdrawRaw==='50000000'));}
 }
});
test('profile metadata cannot substitute supplied amendments, reordered rows, duplicate paths or extra metadata',t=>{
 const p=profilePacket(t,'selected_100_usdc_v1');
 for(const mutate of[
  r=>{r.profile='original_fixed';},r=>{r.profile='arbitrary';},r=>{r.amendment=null;},r=>{r.amendment.extra='not derived';},
  r=>{r.baseTemplates.reverse();},r=>{r.templates.reverse();},r=>{r.baseTemplates.pop();},r=>{r.templates.push(r.templates[0]);},
  r=>{r.baseTemplates[0].id='changed';},r=>{r.templates[1].id=r.templates[0].id;},r=>{r.templates[1].path=r.templates[0].path;},
  r=>{r.templates[0].path='../escape.json';},r=>{r.templates[0].extra=true;}
 ]){const record=structuredClone(p.record);mutate(record);assert.throws(()=>validateProfileTemplates(p.directory,record));}
});
test('resealed byte changes cannot replace original base inputs or the fixed profile serialization',t=>{
 for(const profile of TEMPLATE_PROFILES)for(const kind of['baseTemplates','templates']){
  const p=profilePacket(t,profile),row=p.record[kind][0],f=path.join(p.directory,row.path),raw=fs.readFileSync(f);
  // Even semantically identical JSON is not an allowed replacement byte form.
  fs.writeFileSync(f,Buffer.concat([raw,Buffer.from(' ')]));p.record[kind][0]={...entry(p.directory,row.path),id:row.id};
  assert.throws(()=>validateProfileTemplates(p.directory,p.record));
 }
 const p=profilePacket(t,'selected_100_usdc_v1'),row=p.record.templates[0],f=path.join(p.directory,row.path),changed=JSON.parse(fs.readFileSync(f));
 changed.localInput.calls[0].gas='4999999';fs.writeFileSync(f,JSON.stringify(changed,null,2)+'\n');p.record.templates[0]={...entry(p.directory,row.path),id:row.id};
 assert.throws(()=>validateProfileTemplates(p.directory,p.record));
});
test('unknown or caller-shaped profile refuses before directory creation or worker dispatch',async t=>{
 for(const profile of['unknown','selected_100_usdc_v2','',null,{},['original_fixed']]){
  const directory=path.join(temp(t),'must-not-exist');await assert.rejects(prepare(directory,profile),/Unknown fixed template profile/);assert.equal(fs.existsSync(directory),false);
 }
});
test('source closure pins profile sources and exact rationale bytes without using them as input state',async t=>{
 const rows=await sourceRows();for(const name of['funded-profile.mjs','funded-profile.test.mjs'])assert(rows.some(r=>r.path===`${PREFIX}/${name}`));
 for(const pin of FUNDED_PROVENANCE_FILES){const row=rows.find(r=>r.path===pin.path);assert(row);assert.equal(row.kind,'file');assert.equal(row.bytes,pin.bytes);assert.equal(row.sha256,pin.sha256);}
 assert(rows.reduce((sum,r)=>sum+(r.bytes??0),0)<128*1024*1024);
 // Same-size provenance drift is rejected before any inventory/archive action.
 const directory=temp(t),pin=FUNDED_PROVENANCE_FILES[0],f=path.join(directory,pin.path),raw=Buffer.from(fs.readFileSync(path.join(ROOT,pin.path)));raw[0]^=1;
 fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,raw);await assert.rejects(sourceRows(directory));
});
