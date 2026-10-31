// Fabricated process/worker records and immutable input declarations only.
// These are checker controls, not execution/reference accuracy evidence.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createLedger,sha} from './archive.mjs';import {invocation} from './run.mjs';
import {validateSavedAttempt,compareFixedCases,comparisonCounts,validateSavedTimeline} from './adjudicate.mjs';
import {readPinnedTemplates,deriveTemplateProfile,HISTORICAL_TEMPLATES} from './declarations.mjs';
import {FUNDED_PROFILE} from './funded-profile.mjs';
import {createHeaderSelection,assertFirstTargetFresh} from './selection.mjs';
const fixedTemplates=()=>readPinnedTemplates(HISTORICAL_TEMPLATES.files.map(r=>fs.readFileSync(new URL('../../'+r.path,import.meta.url))));
const temp=t=>{const p=fs.mkdtempSync('/private/tmp/lending-adjudicator-control-');t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
function specimen(t,{reportChange=()=>{},processChange=()=>{},requestChange=()=>{},sealChange=()=>{},unsealed=false,wire=false}={}){
 const capture=temp(t),outDir=path.join(capture,'local/001');fs.mkdirSync(outDir,{recursive:true});
 const plan={runtimePath:path.join(capture,'runtime'),inputBase:capture,node:{executable:process.execPath},inputs:[{id:'fixed_case',sha256:'a'.repeat(64)}]};
 const expectedImplementation={sourceSha256:'b'.repeat(64),name:'synthetic_control_only'},request={from:'0x'+'11'.repeat(20),value:'0'},normalized=structuredClone(request);
 const report={schemaVersion:1,id:'fixed_case',kind:'local',inputSha256:'a'.repeat(64),workerPid:123,status:'threw',report:null,error:{name:'Error',code:'SYNTHETIC_CONTROL',message:'Fabricated failure control'},implementation:expectedImplementation,sourceUnchanged:true,
 drain:{rpc:{complete:true},capture:{complete:true},childClosure:true},captureUsage:{pending:0,unaccountedData:false,saveFailed:false,cancelFailed:false,closed:true,calls:0,observedBytes:0},rpcEvidence:[],elapsed:{wallMs:1,monotonicMs:1}};
 const w=createLedger(outDir);if(wire){const requestText=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),responseText='{"jsonrpc":"2.0","id":1,"result":"0x1"}',bytes=Buffer.from(responseText);
  report.captureUsage.calls=1;report.captureUsage.observedBytes=bytes.length;report.rpcEvidence=[{requestText,responseText,transport:{responseSha256:sha(bytes)}}];
  w.save('wire/0001.json',{id:1,url:'https://eth.drpc.org',requestText,requestBytes:Buffer.byteLength(requestText),requestSha256:sha(requestText),rawBase64:bytes.toString('base64'),transport:{complete:true,observedBytes:bytes.length,retainedBytes:bytes.length,retainedSha256:sha(bytes)}});
 }
 reportChange(report);w.save('report.json',report);const req={id:'fixed_case',kind:'local',inputSha256:'a'.repeat(64),request:structuredClone(request),normalized:structuredClone(normalized)};requestChange(req);w.save('request.json',req);
 const workerManifestSha256=unsealed?null:w.seal();const stdout=Buffer.from(JSON.stringify({status:'captured',manifestSha256:workerManifestSha256})+'\n'),stderr=Buffer.alloc(0),stem='processes/local-001';
 const p=createLedger(capture),record={...invocation(plan,0,'local',outDir,false),pid:123,timeoutMs:100,wallMs:1,monotonicMs:1,status:0,signal:null,closed:true,error:null,limitFailure:null,cleanupSignalAccepted:true,observedBytes:{stdout:stdout.length,stderr:0},
  stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(stderr)}};
 processChange(record);p.write(stem+'.stdout',stdout);p.write(stem+'.stderr',stderr);const processSha256=p.save(stem+'-process.json',record);
 const seal={processSha256,workerManifestSha256,workerSealed:!unsealed,stdout:record.stdout,stderr:record.stderr};sealChange(seal);p.save(stem+'-seal.json',seal);
 const saved={index:0,kind:'local',id:'fixed_case',status:'unavailable',bounded:!unsealed,calls:unsealed?null:report.captureUsage.calls,networkBytes:unsealed?null:report.captureUsage.observedBytes,process:stem+'-process.json',seal:stem+'-seal.json',workerManifestSha256};
 return{capture,plan,index:0,kind:'local',saved,expectedImplementation,request,normalized};
}
test('bounded unavailable API result stays unavailable and retains its original evidence',t=>{
 const r=validateSavedAttempt(specimen(t));assert.equal(r.status,'unavailable');assert.equal(r.bounded,true);assert.equal(r.report.status,'threw');assert.equal(r.workerFiles.length,4);
});
test('changed case, request, input hash or loader identity cannot join a fixed declaration',t=>{
 for(const options of[
  {reportChange:r=>r.id='substituted'}, {reportChange:r=>r.inputSha256='c'.repeat(64)},
  {reportChange:r=>r.implementation={sourceSha256:'c'.repeat(64)}},
  {requestChange:r=>r.request.value='1'}, {reportChange:r=>r.workerPid=999},
 ])assert.throws(()=>validateSavedAttempt(specimen(t,options)));
});
test('coherent process mutation still fails semantic time, argument and closure checks',t=>{
 for(const processChange of[r=>r.monotonicMs=101,r=>r.wallMs=101,r=>r.args.pop(),r=>r.closed=false,r=>r.observedBytes.stdout++,r=>r.limitFailure='output_bytes'])assert.throws(()=>validateSavedAttempt(specimen(t,{processChange})));
});
test('process and worker seals bind exact saved bytes',t=>{
 for(const sealChange of[s=>s.processSha256='c'.repeat(64),s=>s.workerManifestSha256='c'.repeat(64),s=>s.stdout={...s.stdout,sha256:'c'.repeat(64)}])assert.throws(()=>validateSavedAttempt(specimen(t,{sealChange})));
});
test('complete raw wire must equal the client-returned payload, not just its claimed hash',t=>{
 assert.equal(validateSavedAttempt(specimen(t,{wire:true})).calls,1);
 assert.throws(()=>validateSavedAttempt(specimen(t,{wire:true,reportChange:r=>{r.rpcEvidence[0].responseText='{}';r.rpcEvidence[0].transport.responseSha256=sha(Buffer.from('{}'));}})));
});
test('unsealed worker failures preserve raw files and cannot be bounded observations',t=>{
 const r=validateSavedAttempt(specimen(t,{unsealed:true}));assert.equal(r.status,'unavailable');assert.equal(r.bounded,false);assert.equal(r.calls,null);assert.equal(r.workerFiles.length,2);
});
test('unknown packet bounds preserve all fixed 30 original and 117 query channels as null',async()=>{
 const cases=fixedTemplates();const r=await compareFixedCases(cases,[{},{}],false);
 assert.equal(r.rows.length,2);assert.deepEqual(r.counts,{originalChannels:{matched:0,mismatched:0,unavailable:30},queryChannels:{matched:0,mismatched:0,unavailable:117}});assert.equal(r.metrics,null);
 assert.deepEqual(comparisonCounts(r.rows),r.counts);assert.deepEqual(r.rows.map(x=>x.steps.length),[3,3]);assert.deepEqual(r.rows.map(x=>x.steps[0].queries.length),[5,8]);
});

test('new selected funded cases retain their own IDs and full unknown denominator on unavailable evidence',async()=>{
 const bytes=HISTORICAL_TEMPLATES.files.map(r=>fs.readFileSync(new URL('../../'+r.path,import.meta.url)));
 const cases=deriveTemplateProfile({templateBytes:bytes,profile:FUNDED_PROFILE}).templates;
 const r=await compareFixedCases(cases,[{},{}],false);
 assert.deepEqual(r.rows.map(x=>x.id),['aave-usdc-selected-100-supply-50-withdraw','kiln-usdc-selected-100-deposit-50-withdraw']);
 assert.deepEqual(r.counts,{originalChannels:{matched:0,mismatched:0,unavailable:30},queryChannels:{matched:0,mismatched:0,unavailable:117}});
 assert.equal(r.metrics,null);
});

test('extra successful client row without a saved wire cannot remain a bounded attempt',t=>{
 assert.throws(()=>validateSavedAttempt(specimen(t,{wire:true,reportChange:r=>{
  const extra=structuredClone(r.rpcEvidence[0]);extra.requestText=JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_chainId',params:[]});r.rpcEvidence.push(extra);
 }})));
});

function timelineSpecimen(){
 const header=fixedTemplates()[0].header,base=Number(BigInt(header.timestamp))*1000+1000,at=n=>({wallMs:base+n,monotonicMs:100+n});
 const s=createHeaderSelection({sourceBinding:{intentPlanSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),nodeSha256:'c'.repeat(64)},started:at(1)});
 for(let i=0;i<3;i++){const r=s.request(at(2+i*2)),raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:i+1,result:i===0?'0x1':header}));s.accept({...r,httpStatus:200,responseBase64:raw.toString('base64'),responseBytesObserved:raw.length,complete:true,error:null},at(3+i*2));}
 const selected=s.finish(at(8)),elapsed={started:at(1),finished:at(8),wallMs:7,monotonicMs:7};
 return{started:{clock:at(0)},results:{phase:'target_matrix',coordinatorStarted:at(0),targetPhaseStarted:at(9),elapsed:{wallMs:100,monotonicMs:100,reversed:false}},
  selection:{usable:true,report:{selection:selected,elapsed}},processes:[{pid:123,firstTarget:assertFirstTargetFresh(selected,at(10))},{pid:124},{pid:125},{pid:126}].map(p=>({...p,wallMs:10,monotonicMs:10}))};
}
test('saved timeline binds one clock origin and first native dispatch to replayed freshness',()=>{
 const r=validateSavedTimeline(timelineSpecimen());assert.equal(r.timeValid,true);assert.equal(r.firstTarget.elapsedSinceLatestMs,5);
 for(const change of[
  s=>s.results.coordinatorStarted.monotonicMs=0,
  s=>s.results.targetPhaseStarted.monotonicMs=0,
  s=>s.selection.report.elapsed.wallMs++,
  s=>delete s.processes[0].firstTarget,
  s=>s.processes[0].firstTarget.elapsedSinceLatestMs++,
  s=>s.processes[0].firstTarget.blockHash='0x'+'00'.repeat(32),
  s=>s.processes[0].firstTarget.firstTarget.monotonicMs+=180001,
  s=>s.processes[1].firstTarget=structuredClone(s.processes[0].firstTarget),
 ]){const s=timelineSpecimen();change(s);assert.throws(()=>validateSavedTimeline(s));}
});
test('terminal budget overrun withholds usability; a passed gate before spawn failure stays retained',()=>{
 const over=timelineSpecimen();over.results.elapsed.monotonicMs=900000;assert.equal(validateSavedTimeline(over).timeValid,false);
 const failed=timelineSpecimen();failed.processes[0].pid=null;failed.processes.splice(1,3,null,null,null);assert(validateSavedTimeline(failed).firstTarget);
 failed.processes[1]={pid:124};assert.throws(()=>validateSavedTimeline(failed));
});
test('sequential process durations cannot fit inside a shorter claimed matrix interval',()=>{
 for(const key of ['wallMs','monotonicMs']){const s=timelineSpecimen();s.processes.forEach(p=>p[key]=100000);assert.equal(validateSavedTimeline(s).timeValid,false);}
 const offset=timelineSpecimen();offset.results.elapsed.wallMs=31;offset.processes[0].wallMs=0;offset.processes[0].firstTarget=assertFirstTargetFresh(offset.selection.report.selection,{wallMs:offset.results.targetPhaseStarted.wallMs+2,monotonicMs:offset.results.targetPhaseStarted.monotonicMs+2});assert.equal(validateSavedTimeline(offset).timeValid,false);
});
test('failed selection cannot claim any attempted process and keeps all fixed comparisons unknown',()=>{
 const s={started:{clock:{wallMs:1,monotonicMs:1}},results:{phase:'selection_or_input_unavailable',coordinatorStarted:{wallMs:1,monotonicMs:1}},selection:null,processes:[null,null,null,null]};
 assert.deepEqual(validateSavedTimeline(s),{firstTarget:null,firstChild:false,timeValid:false});s.processes[0]={pid:123};assert.throws(()=>validateSavedTimeline(s));
});
