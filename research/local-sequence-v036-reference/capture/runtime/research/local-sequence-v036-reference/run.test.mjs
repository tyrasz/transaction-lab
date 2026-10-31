// Driver controls execute only inert temporary worker programs, never either VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PREFIX,LIMITS,invocation,validateRecordedProcess,validatePreparedDirectory,driverLocations,createWriteLedger,executeMatrix,processOnce,run,OWN,sourceRows} from './run.mjs';
import {DEPENDENCIES as OBSERVATION_DEPENDENCIES} from './observations.mjs';
import {DEPENDENCIES as TOOLCHAIN_DEPENDENCIES} from './toolchain.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:'/node'},
  toolchain:{root:'/pinned/eels',python:'/pinned/eels/venv/bin/python'},
  inputs:Array.from({length:4},(_,i)=>({path:`inputs/${String(i+1).padStart(3,'0')}.json`,id:'case_'+i,fork:i%2?'Amsterdam':'Osaka',sha256:'a'.repeat(64)}))};
function sample(kind='product',prepareOnly=true){
  const index=0,call=invocation(plan,index,kind,prepareOnly);
  const report={id:'case_0',inputSha256:'a'.repeat(64),status:prepareOnly?'prepared_no_execution':'completed'};
  if(kind==='product')Object.assign(report,{workerPid:123,scope:'frozen_four_case_unsigned_product_sequence',
    expectedPoststateConsumed:false,otherClientOutputsConsumed:false,executionInvoked:false,
    processClosureValid:true,attempt:{status:'completed',broker:{pendingAtReturn:0},
      isolation:{processClosed:true,childPid:124,exitCode:0,exitSignal:null}}});
  else Object.assign(report,{sourceModule:'/pinned/eels/source/src/ethereum/forks/osaka/fork.py',fork:'Osaka'});
  const stdout=Buffer.from(JSON.stringify(report)),stderr=Buffer.alloc(0),stem='001-'+kind;
  const record={...call,pid:123,timeoutMs:100,wallMs:1,monotonicMs:1,status:0,signal:null,error:null,
    limitFailure:null,processClosed:true,cleanupSignalAccepted:true,observedBytes:{stdout:stdout.length,stderr:0},
    stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(stderr)}};
  return{plan,index,kind,prepareOnly,record,stdout,stderr};
}
function changeReport(x,fn){const r=JSON.parse(x.stdout);fn(r);x.stdout=Buffer.from(JSON.stringify(r));
  x.record.observedBytes.stdout=x.stdout.length;x.record.stdout={...x.record.stdout,bytes:x.stdout.length,sha256:sha(x.stdout)};}
const temp=t=>{const dir=fs.mkdtempSync('/private/tmp/sequence-driver-control-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('fixed arguments use CPU wrapper, manifest and explicit preparation separation',()=>{
  assert.deepEqual(invocation(plan,0,'product',true),{executable:plan.toolchain.python,args:['-I','-B',
    '/frozen/runtime/'+PREFIX+'/exec-bounded.py','/node','--max-old-space-size=256',
    '/frozen/runtime/'+PREFIX+'/product-worker.mjs','/frozen/inputs/001.json','a'.repeat(64),'--prepare-only']});
  const args=invocation(plan,1,'eels').args;
  assert.deepEqual(args.slice(-3),['/frozen/inputs/002.json','/frozen/toolchain.json','a'.repeat(64)]);
  for(const i of[-1,4,0.5])assert.throws(()=>invocation(plan,i,'product'));
  assert.throws(()=>invocation(plan,0,'another-client'));
});
test('only archived driver can dispatch, with explicit flag and one capture location',async()=>{
  await assert.rejects(run('a'.repeat(64)),/explicit flag/);
  await assert.rejects(run('a'.repeat(64),'--execute-frozen-targets'),/archived driver/);
  const live=driverLocations('/work/'+PREFIX+'/run.mjs'),archive=driverLocations(live.capture+'/runtime/'+PREFIX+'/run.mjs');
  assert.equal(live.archived,false);assert.equal(archive.archived,true);assert.equal(archive.capture,live.capture);
  assert.equal(driverLocations('/work/runtime/'+PREFIX+'/run.mjs').archived,false);
});
test('record validation binds original output bytes and invocation identity',()=>{
  for(const kind of['product','eels'])for(const preparation of[true,false])assert.equal(validateRecordedProcess(sample(kind,preparation)).status,preparation?'prepared':'observed');
  for(const mutate of[x=>x.record.args.pop(),x=>{x.record.stdout.sha256='b'.repeat(64);},x=>{x.record.timeoutMs=0;}]){const x=sample();mutate(x);assert.throws(()=>validateRecordedProcess(x));}
  const x=sample();changeReport(x,r=>{r.executionInvoked=true;});assert.equal(validateRecordedProcess(x).status,'unavailable');
});
test('closed outer worker is insufficient without actual product child closure and broker drain',()=>{
  for(const mutate of[r=>{r.processClosureValid=false;},r=>{r.attempt.broker.pendingAtReturn=1;},
    r=>{r.attempt.isolation.processClosed=false;},r=>{r.attempt.isolation.childPid=123;},
    r=>{r.attempt.isolation.exitCode=1;},r=>{r.attempt.isolation.exitSignal='SIGKILL';},r=>{delete r.attempt;}]){
    const x=sample('product',false);changeReport(x,mutate);assert.deepEqual(validateRecordedProcess(x),{status:'unavailable',bounded:false,report:null});
  }
  const x=sample('product',false);changeReport(x,r=>{r.id='wrong';});assert.equal(validateRecordedProcess(x).bounded,false);
});
test('strict wall, CPU, output, group cleanup and direct closure failures withhold packet usability',()=>{
  for(const mutate of[x=>{x.record.wallMs=101;},x=>{x.record.monotonicMs=-1;},x=>{x.record.signal='SIGXCPU';},x=>{x.record.signal='SIGKILL';},
    x=>{x.record.limitFailure='output_bytes';},x=>{x.record.observedBytes.stdout++;},x=>{x.record.cleanupSignalAccepted=false;},x=>{x.record.processClosed=false;}]){
    const x=sample();mutate(x);const r=validateRecordedProcess(x);assert.equal(r.status,'unavailable');assert.equal(r.bounded,false);
  }
  const e=sample('eels',false);e.record.status=1;assert.equal(validateRecordedProcess(e).status,'unavailable');assert.equal(validateRecordedProcess(e).bounded,true);
});
test('ledger rejects coherent replacement and membership drift before sealing',t=>{
  for(const kind of['replace','extra','missing']){const dir=temp(t),writer=createWriteLedger(dir);writer.write('raw.stdout',Buffer.from('original'));writer.save('raw-seal.json',{sha256:sha(Buffer.from('original'))});
    if(kind==='replace'){fs.writeFileSync(path.join(dir,'raw.stdout'),'changed');fs.writeFileSync(path.join(dir,'raw-seal.json'),JSON.stringify({sha256:sha(Buffer.from('changed'))}));}
    else if(kind==='extra')fs.writeFileSync(path.join(dir,'extra'),'x');else fs.unlinkSync(path.join(dir,'raw.stdout'));
    assert.throws(()=>writer.verify());assert.throws(()=>writer.seal());assert(!fs.existsSync(path.join(dir,'manifest.json')));
  }
});
test('preparation gate rederives all eight processes and binds the original-write ledger',t=>{
  function prepared({badArgument=false,badReport=false}={}){
    const dir=temp(t),p={...plan,limits:LIMITS};fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify(p)+'\n');
    const w=createWriteLedger(dir),rows=[];let totalBytes=0;
    for(const kind of['product','eels'])for(let index=0;index<4;index++){
      const x=sample(kind,true),stem=String(index+1).padStart(3,'0')+'-'+kind;
      const report=JSON.parse(x.stdout);report.id=plan.inputs[index].id;
      if(kind==='eels'){report.fork=plan.inputs[index].fork;report.sourceModule='/pinned/eels/source/src/ethereum/forks/'+report.fork.toLowerCase()+'/fork.py';}
      const stdout=Buffer.from(JSON.stringify(report)),record={...x.record,...invocation(p,index,kind,true),observedBytes:{stdout:stdout.length,stderr:0},
        stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(Buffer.alloc(0))}};
      if(badArgument&&index===0&&kind==='product')record.args.pop();
      w.write(stem+'.stdout',stdout);w.write(stem+'.stderr',Buffer.alloc(0));
      const processSha256=w.save(stem+'-process.json',record);w.save(stem+'-seal.json',{processSha256,stdout:record.stdout,stderr:record.stderr});
      totalBytes+=stdout.length;rows.push({index,id:report.id,kind,status:'prepared',process:stem+'-process.json'});
    }
    w.save('report.json',{rows,executionInvoked:false,allPrepared:true,evidenceUsable:true,fatal:null,sourceUnchanged:true,
      elapsed:{wallMs:10,monotonicMs:10,reversed:false},totalBytes,totalObservedBytes:totalBytes});w.seal();
    if(badReport){
      const file=path.join(dir,'report.json'),changed=JSON.parse(fs.readFileSync(file));changed.rows.pop();fs.writeFileSync(file,JSON.stringify(changed)+'\n');
      const mf=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(mf)),r=m.files.find(x=>x.path==='report.json'),raw=fs.readFileSync(file);r.bytes=raw.length;r.sha256=sha(raw);fs.writeFileSync(mf,JSON.stringify(m)+'\n');
    }
    return dir;
  }
  assert.equal(validatePreparedDirectory(prepared()).report.rows.length,8);
  assert.throws(()=>validatePreparedDirectory(prepared({badArgument:true})));
  assert.throws(()=>validatePreparedDirectory(prepared({badReport:true})),/original-write ledger/);
});
test('all four product records are sealed before reference dispatch; fixed eight process rows survive',async t=>{
  const dir=temp(t),writer=createWriteLedger(dir),order=[];let checks=0;
  const r=await executeMatrix(plan,writer,false,{checkIdentity:async()=>{checks++;},processAttempt:async(_p,i,k,_prepare,w,timeout)=>{
    assert(timeout>0&&timeout<=LIMITS.processMs);assert.equal(_prepare,false);
    if(k==='eels')for(let j=0;j<4;j++){const stem=String(j+1).padStart(3,'0')+'-product';
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir,stem+'-seal.json'))).processSha256,sha(fs.readFileSync(path.join(dir,stem+'-process.json'))));}
    const stem=String(i+1).padStart(3,'0')+'-'+k;order.push([i,k]);
    w.write(stem+'.stdout',Buffer.from('synthetic'));const processSha256=w.save(stem+'-process.json',{synthetic:true});w.save(stem+'-seal.json',{processSha256});
    return{status:'observed',bounded:true,bytes:9,observedBytes:9,process:stem+'-process.json'};
  }});
  assert.deepEqual(order,['product','eels'].flatMap(k=>Array.from({length:4},(_,i)=>[i,k])));assert.equal(checks,17);
  assert.equal(r.rows.length,8);assert(r.evidenceUsable);assert.equal(LIMITS.positions,12);writer.verify();
});
test('first unbounded attempt stops later targets and retains undispatched rows',async t=>{
  const dir=temp(t),writer=createWriteLedger(dir);let count=0;
  const r=await executeMatrix(plan,writer,false,{checkIdentity:async()=>{},processAttempt:async()=>{
    count++;return{status:'unavailable',bounded:false,bytes:0,observedBytes:0,process:'001-product-process.json'};
  }});
  assert.equal(count,1);assert.equal(r.evidenceUsable,false);assert(r.fatal);assert.equal(r.rows[0].status,'unavailable');assert(r.rows.slice(1).every(x=>x.status==='not_attempted'));
});
test('dual-clock reversals and source or original-write drift stop dispatch',async t=>{
  for(const kind of['wall','monotonic','source','bytes']){
    const dir=temp(t),writer=createWriteLedger(dir);let elapsed=100,count=0,checks=0;
    const r=await executeMatrix(plan,writer,false,{now:()=>elapsed,monotonic:()=>kind==='monotonic'?elapsed:100,
      checkIdentity:async()=>{checks++;if(kind==='source'&&checks===2)throw Error('Source drift');},processAttempt:async()=>{
        count++;if(kind==='wall'||kind==='monotonic')elapsed=99;
        if(kind==='bytes'){writer.write('raw',Buffer.from('original'));fs.writeFileSync(path.join(dir,'raw'),'replaced');}
        return{status:'observed',bounded:true,bytes:0,observedBytes:0,process:'001-product-process.json'};
      }});
    assert.equal(count,1);assert.equal(r.evidenceUsable,false);assert(r.fatal);
  }
});
async function inertPlan(t,source){
  const dir=temp(t),runtime=path.join(dir,'runtime'),own=path.join(runtime,PREFIX);fs.mkdirSync(own,{recursive:true});
  fs.copyFileSync(new URL('./exec-bounded.py',import.meta.url),path.join(own,'exec-bounded.py'));
  fs.writeFileSync(path.join(own,'product-worker.mjs'),source);
  const tool=JSON.parse(fs.readFileSync(new URL('./toolchain.json',import.meta.url)));
  const output=path.join(dir,'output');fs.mkdirSync(output);
  return{p:{...plan,runtimePath:runtime,inputBase:dir,node:{executable:process.execPath},toolchain:{...plan.toolchain,python:tool.python}},writer:createWriteLedger(output),output};
}
test('actual inert prepared worker closes and its raw output is sealed',async t=>{
  const source=`console.log(JSON.stringify({id:'case_0',inputSha256:'${'a'.repeat(64)}',workerPid:process.pid,scope:'frozen_four_case_unsigned_product_sequence',expectedPoststateConsumed:false,otherClientOutputsConsumed:false,status:'prepared_no_execution',executionInvoked:false}));`;
  const {p,writer,output}=await inertPlan(t,source),r=await processOnce(p,0,'product',true,writer,3000);
  assert.equal(r.status,'prepared');assert(r.bounded);writer.verify();
  const rec=JSON.parse(fs.readFileSync(path.join(output,'001-product-process.json')));assert(rec.processClosed&&rec.cleanupSignalAccepted);assert.equal(rec.observedBytes.stdout,rec.stdout.bytes);
});
test('actual oversized inert output retains capped prefix and terminates the group',async t=>{
  const {p,writer,output}=await inertPlan(t,"const b=Buffer.alloc(65536,65);function push(){if(process.stdout.write(b))setImmediate(push);else process.stdout.once('drain',push);}push();setInterval(()=>{},1000);");
  const r=await processOnce(p,0,'product',true,writer,3000);assert.equal(r.status,'unavailable');assert.equal(r.bounded,false);
  const rec=JSON.parse(fs.readFileSync(path.join(output,'001-product-process.json')));assert.equal(rec.limitFailure,'output_bytes');assert.equal(rec.stdout.bytes,LIMITS.streamBytes);assert(rec.observedBytes.stdout>LIMITS.streamBytes);assert(rec.processClosed);writer.verify();
});
test('actual stalled inert worker expires and is closed without a later target',async t=>{
  const {p,writer,output}=await inertPlan(t,'setInterval(()=>{},1000);'),r=await processOnce(p,0,'product',true,writer,150);
  assert.equal(r.status,'unavailable');assert.equal(r.bounded,false);const rec=JSON.parse(fs.readFileSync(path.join(output,'001-product-process.json')));
  assert.equal(rec.limitFailure,'wall_timeout');assert(rec.processClosed&&rec.cleanupSignalAccepted);writer.verify();
});
test('preparation source returns before executor import, reference environment and apply_body',()=>{
  const read=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8'),p=read('product-worker.mjs'),e=read('eels-worker.py');
  assert(p.indexOf("if(process.argv[4]==='--prepare-only')")<p.indexOf("await import('../../engines/local-evm/isolated-call.js')"));
  const prepare=e.indexOf('if len(sys.argv) == 5:');assert(prepare>0&&prepare<e.indexOf('tracked = tracker.BlockState'));
  assert(prepare<e.indexOf('fork.apply_body('));assert(OWN.includes('exec-bounded.py'));assert(OWN.includes('toolchain-drift.json'));
});
test('frozen source inventory includes all declared adapters and comparison dependencies',()=>{
  const rows=sourceRows(),names=new Set(rows.map(r=>r.path));assert.equal(names.size,rows.length);
  for(const file of [...OWN.map(p=>PREFIX+'/'+p),...OBSERVATION_DEPENDENCIES,...TOOLCHAIN_DEPENDENCIES,
    'engines/local-evm/ethereum-sequence.js','engines/local-evm/execution-state.js','engines/local-evm/test/sequence-fixture.js'])assert(names.has(file),file);
});
