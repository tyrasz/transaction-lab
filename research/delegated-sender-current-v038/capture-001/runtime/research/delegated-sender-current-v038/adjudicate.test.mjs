// Fabricated records and real saved header bytes, never public execution evidence.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createLedger,sha} from '../lending-local-sequence-current-v037/archive.mjs';
import {createHeaderSelection,assertFirstTargetFresh} from '../lending-local-sequence-current-v037/selection.mjs';
import {originalTemplateBytes,deriveTemplates,CHANNELS} from './declarations.mjs';
import {invocation,ROOT} from './run.mjs';
import {validateSavedAttempt,compareFixedCases,comparisonCounts,unavailableCase,validateSavedTimeline} from './adjudicate.mjs';
const cases=()=>deriveTemplates({templateBytes:originalTemplateBytes(ROOT)}).cases;
function specimen(t,{changeReport=()=>{},changeProcess=()=>{},changeRequest=()=>{},changeSeal=()=>{},unsealed=false}={}){
 const capture=fs.mkdtempSync('/private/tmp/delegated-audit-');t.after(()=>fs.rmSync(capture,{recursive:true,force:true}));const outDir=path.join(capture,'local/001');fs.mkdirSync(outDir,{recursive:true});
 const plan={runtimePath:path.join(capture,'runtime'),inputBase:capture,node:{executable:process.execPath},inputs:[{id:'control',sha256:'a'.repeat(64)}]};
 const api={implementation:{name:'fabricated_control',sourceSha256:'b'.repeat(64)},validateLocalSimulation:x=>structuredClone(x)},input={id:'control',localInput:{value:'0'}};
 const report={schemaVersion:1,index:0,id:'control',kind:'local',inputSha256:'a'.repeat(64),workerPid:123,status:'threw',report:null,error:{name:'Error',code:'CONTROL',message:'Fabricated unavailable control'},implementation:api.implementation,sourceUnchanged:true,
  drain:{rpc:{complete:true},capture:{complete:true},childClosure:true},captureUsage:{pending:0,unaccountedData:false,saveFailed:false,cancelFailed:false,closed:true,calls:0,observedBytes:0},rpcEvidence:[],elapsed:{wallMs:1,monotonicMs:1}};
 changeReport(report);const w=createLedger(outDir);w.save('report.json',report);const request={id:input.id,index:0,kind:'local',inputSha256:'a'.repeat(64),request:structuredClone(input.localInput),normalized:structuredClone(input.localInput)};changeRequest(request);w.save('request.json',request);
 const workerManifestSha256=unsealed?null:w.seal(),stdout=Buffer.from(JSON.stringify({status:'captured',manifestSha256:workerManifestSha256})+'\n'),stderr=Buffer.alloc(0),stem='processes/local-001',writer=createLedger(capture);
 const record={...invocation(plan,0,'local',outDir),pid:123,timeoutMs:100,wallMs:1,monotonicMs:1,status:0,signal:null,closed:true,error:null,limitFailure:null,cleanupSignalAccepted:true,observedBytes:{stdout:stdout.length,stderr:0},stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(stderr)}};
 changeProcess(record);writer.write(stem+'.stdout',stdout);writer.write(stem+'.stderr',stderr);const processSha256=writer.save(stem+'-process.json',record),seal={processSha256,workerManifestSha256,workerSealed:!unsealed,stdout:record.stdout,stderr:record.stderr};changeSeal(seal);writer.save(stem+'-seal.json',seal);
 const saved={index:0,kind:'local',id:'control',status:'unavailable',bounded:!unsealed,calls:unsealed?null:0,networkBytes:unsealed?null:0,process:stem+'-process.json',seal:stem+'-seal.json',workerManifestSha256};
 return{capture,plan,index:0,kind:'local',saved,input,api};
}
test('bounded unavailable and unsealed attempts retain their different evidence status',t=>{
 const a=validateSavedAttempt(specimen(t));assert.equal(a.bounded,true);assert.equal(a.status,'unavailable');assert.equal(a.report.report,null);
 const b=validateSavedAttempt(specimen(t,{unsealed:true}));assert.equal(b.bounded,false);assert.equal(b.calls,null);assert.equal(b.workerFiles.length,2);
});
test('coherently resealed input, implementation, PID and process alterations fail binding',t=>{
 for(const options of[
  {changeReport:r=>r.index=1},{changeReport:r=>r.workerPid=999},{changeReport:r=>r.inputSha256='c'.repeat(64)},
  {changeReport:r=>r.implementation={sourceSha256:'c'.repeat(64)}},{changeRequest:r=>r.request.value='1'},
  {changeProcess:r=>r.monotonicMs=101},{changeProcess:r=>r.args.pop()},{changeProcess:r=>r.closed=false},{changeProcess:r=>r.observedBytes.stdout++},
  {changeSeal:r=>r.workerManifestSha256='c'.repeat(64)},{changeSeal:r=>r.processSha256='c'.repeat(64)},
 ])assert.throws(()=>validateSavedAttempt(specimen(t,options)));
});
test('unusable captures keep both positions and ten unknown channels without calling comparison',async()=>{
 const r=await compareFixedCases({cases:cases(),records:[],usable:false,compare(){throw Error('must not compare');}});
 assert.deepEqual(r.counts,{matched:0,mismatched:0,unavailable:10});assert.equal(r.metrics,null);assert.deepEqual(r.rows.map(r=>r.id),['delegated-usdt-002','delegated-usdt-015']);
});
test('counting preserves mixed channels and rejects omitted or fabricated channel states',()=>{
 const rows=cases().map(c=>unavailableCase(c,'control'));rows[0].channels[CHANNELS[0]].status='match';rows[1].channels[CHANNELS[1]].status='mismatch';assert.deepEqual(comparisonCounts(rows),{matched:1,mismatched:1,unavailable:8});
 const missing=structuredClone(rows);delete missing[0].channels[CHANNELS[2]];assert.throws(()=>comparisonCounts(missing));rows[0].channels[CHANNELS[0]].status=true;assert.throws(()=>comparisonCounts(rows));
});
function timeline(){
 const header=cases()[0].header,base=Number(BigInt(header.timestamp))*1000+1000,at=n=>({wallMs:base+n,monotonicMs:100+n});
 const state=createHeaderSelection({sourceBinding:{intentPlanSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64),nodeSha256:'c'.repeat(64)},started:at(1)});
 for(let i=0;i<3;i++){const request=state.request(at(2+i*2)),raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:i+1,result:i===0?'0x1':header}));state.accept({...request,httpStatus:200,responseBase64:raw.toString('base64'),responseBytesObserved:raw.length,complete:true,error:null},at(3+i*2));}
 const selected=state.finish(at(8));return{started:{clock:at(0)},results:{phase:'target_matrix',coordinatorStarted:at(0),targetPhaseStarted:at(9),elapsed:{wallMs:100,monotonicMs:100,reversed:false}},selection:{usable:true,report:{selection:selected,elapsed:{started:at(1),finished:at(8),wallMs:7,monotonicMs:7}}},processes:[{pid:123,firstTarget:assertFirstTargetFresh(selected,at(10))},{pid:124},{pid:125},{pid:126}].map(p=>({...p,wallMs:10,monotonicMs:10}))};
}
test('saved chronology needs actual first child, fresh shared clock and full sequential duration',()=>{
 assert.equal(validateSavedTimeline(timeline()).timeValid,true);
 for(const change of[s=>delete s.processes[0].firstTarget,s=>s.processes[1].firstTarget=s.processes[0].firstTarget,s=>s.results.coordinatorStarted.monotonicMs=0,s=>s.selection.report.elapsed.wallMs++]){const r=timeline();change(r);assert.throws(()=>validateSavedTimeline(r));}
 for(const duration of[39,700000]){const r=timeline();r.results.elapsed={wallMs:duration,monotonicMs:duration,reversed:false};assert.equal(validateSavedTimeline(r).timeValid,false);}
 const r=timeline();for(const p of r.processes)p.pid=null;assert.equal(validateSavedTimeline(r).firstChild,false);
});
