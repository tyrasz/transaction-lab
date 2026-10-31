// Pure ledger/matrix controls and harmless child programs only, no network/API execution.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {PREFIX,ORDER,LIMITS,SCOPE,invocation,validateReport,executeMatrix,processOnce,run,OWN,validateProcessRecord,validateWireDirectory} from './run.mjs';
import {sha,entry,createLedger,verifyPacket} from './archive.mjs';
const temp=t=>{const p=fs.mkdtempSync('/private/tmp/lending-sequence-control-');t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:process.execPath},inputs:[0,1].map(i=>({id:'case'+i,path:`inputs/00${i+1}.json`,sha256:'a'.repeat(64)}))};
function report(kind='local',prepareOnly=false){return{schemaVersion:1,id:'case0',kind,inputSha256:'a'.repeat(64),workerPid:123,implementation:{sourceSha256:'b'.repeat(64)},status:prepareOnly?'prepared_no_execution':'returned',executionInvoked:false,networkCalls:0,sourceUnchanged:true,
 drain:{rpc:{complete:true},capture:{complete:true},childClosure:true},captureUsage:{pending:0,unaccountedData:false,saveFailed:false,cancelFailed:false,closed:true,calls:1,observedBytes:10},rpcEvidence:[{}],elapsed:{wallMs:10,monotonicMs:10}};}
test('fixed denominator, budgets, API/query asymmetry and archived-only dispatch',async()=>{
 assert.deepEqual(ORDER,[{kind:'local',index:0},{kind:'local',index:1},{kind:'provider',index:0},{kind:'provider',index:1}]);assert.equal(LIMITS.networkCalls,2*260+2*258);assert.equal(LIMITS.positions,6);assert.equal(SCOPE.queryGasEquivalent,false);assert.equal(SCOPE.httpApi,false);
 assert(invocation(plan,0,'local','/frozen/local/001',true).args.includes('--prepare-only'));assert(!invocation(plan,0,'local','/frozen/local/001').args.includes('--prepare-only'));
 await assert.rejects(run('a'.repeat(64),'--execute-frozen-readonly'));await assert.rejects(run('a'.repeat(64),'wrong'));
});
test('actual pending activity, child closure, source drift and byte/call overflow withhold bounds',()=>{
 for(const kind of ['local','provider'])assert.equal(validateReport(report(kind),{plan,index:0,kind,pid:123}).bounded,true);
 for(const change of[r=>r.drain.capture.complete=false,r=>r.drain.rpc.complete=false,r=>r.drain.childClosure=false,r=>r.captureUsage.pending=1,r=>r.captureUsage.unaccountedData=true,r=>r.captureUsage.cancelFailed=true,r=>r.sourceUnchanged=false,r=>r.captureUsage.calls=261,r=>r.captureUsage.observedBytes=33*1024*1024,r=>r.workerPid=124]){const r=report();change(r);assert.throws(()=>validateReport(r,{plan,index:0,kind:'local',pid:123}));}
 const p=report('local',true);assert.equal(validateReport(p,{plan,index:0,kind:'local',pid:123,prepareOnly:true}).status,'prepared');p.executionInvoked=true;assert.throws(()=>validateReport(p,{plan,index:0,kind:'local',pid:123,prepareOnly:true}));
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
 for(const p of['state-observations.mjs','declarations.mjs','capture.test.mjs'])assert(OWN.includes(p));
});

test('terminal monotonic overrun with small wall elapsed withholds all metrics',async t=>{
 const d=temp(t);let mono=0;const r=await executeMatrix(plan,createLedger(d),false,{now:()=>0,monotonic:()=>mono,identity:async()=>{},attempt:async(p,i,k)=>{if(i===1&&k==='provider')mono=LIMITS.totalMs+1;return{status:'returned',bounded:true,calls:0,networkBytes:0};}});assert.equal(r.rows.length,4);assert.equal(r.evidenceUsable,false);assert(r.fatal);
});

test('process semantic checks bind both clocks, actual stream sizes and original invocation',()=>{
 const outDir='/frozen/local/001',stdout=Buffer.from('{}'),stderr=Buffer.alloc(0),record={...invocation(plan,0,'local',outDir,true),timeoutMs:100,wallMs:1,monotonicMs:1,closed:true,status:0,signal:null,error:null,limitFailure:null,cleanupSignalAccepted:true,observedBytes:{stdout:2,stderr:0},stdout:{bytes:2,sha256:sha(stdout)},stderr:{bytes:0,sha256:sha(stderr)}};
 const check=r=>validateProcessRecord(r,{plan,index:0,kind:'local',outDir,prepareOnly:true,stdout,stderr});check(record);
 for(const mutate of[r=>r.monotonicMs=101,r=>r.observedBytes.stdout=3,r=>r.args.pop(),r=>r.cleanupSignalAccepted=false]){const r=structuredClone(record);mutate(r);assert.throws(()=>check(r));}
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
