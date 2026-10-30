// Offline driver/observation protocol tests. No subprocess or EVM is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {invocation,validateRecordedProcess,run,LIMITS,createWriteLedger,executeMatrix,driverLocations,retainPreviewPositions,OWN,sourceRows} from './run.mjs';
import {comparePair,CHANNELS} from './observations.mjs';
import {sha} from './toolchain.mjs';
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:'/node'},toolchain:{root:'/pinned/eels',python:'/pinned/eels/venv/bin/python'},inputs:Array.from({length:8},(_,i)=>({path:'inputs/'+String(i+1).padStart(3,'0')+'.json',id:'case_'+i,fork:i===0?'Shanghai':'Amsterdam',sha256:'a'.repeat(64)}))};
function sample(kind='product',prepareOnly=true){const index=0,call=invocation(plan,index,kind,prepareOnly),out={id:'case_0',inputSha256:'a'.repeat(64),status:prepareOnly?'prepared_no_execution':'completed'};
  if(kind==='product')Object.assign(out,{workerPid:123,scope:'frozen_eight_case_unsigned_product_preview',expectedPoststateConsumed:false,otherClientOutputsConsumed:false,executionInvoked:false});
  else Object.assign(out,{sourceModule:'/pinned/eels/source/src/ethereum/forks/shanghai/fork.py',fork:'Shanghai'});
  const stdout=Buffer.from(JSON.stringify(out)),stderr=Buffer.alloc(0),stem='001-'+kind;
  const record={...call,pid:123,timeoutMs:20,wallMs:1,monotonicMs:1,status:0,signal:null,error:null,cleanupSignalAccepted:true,stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(stderr)}};
  return{plan,index,kind,prepareOnly,record,stdout,stderr};}
test('eight-case fixed process arguments distinguish preparation from execution',()=>{
  assert.deepEqual(invocation(plan,0,'product',true).args,['--max-old-space-size=256','/frozen/runtime/research/storage-creation-lifecycle-v035/product-worker.mjs','/frozen/inputs/001.json','a'.repeat(64),'--prepare-only']);
  assert.deepEqual(invocation(plan,0,'eels',false).args,['-I','-B','/frozen/runtime/research/storage-creation-lifecycle-v035/eels-worker.py','/frozen/inputs/001.json','/pinned/eels','a'.repeat(64)]);
  for(const index of[-1,8,0.5])assert.throws(()=>invocation(plan,index,'product'));
  assert.throws(()=>invocation(plan,0,'geth'));
});
test('execution gate rejects missing or altered flag before opening a capture',async()=>{
  await assert.rejects(run('a'.repeat(64)),/explicit flag/);
  await assert.rejects(run('a'.repeat(64),'--prepare-only'),/explicit flag/);
  await assert.rejects(run('a'.repeat(64),'--execute-frozen-targets'),/archived driver/);
});
test('archived driver resolves the sole capture while the working driver remains preparation-only',()=>{
  const live=driverLocations('/work/research/storage-creation-lifecycle-v035/run.mjs');
  assert.equal(live.root,'/work');assert.equal(live.archived,false);assert.equal(live.capture,'/work/research/storage-creation-lifecycle-v035/capture');
  const frozen=driverLocations(live.capture+'/runtime/research/storage-creation-lifecycle-v035/run.mjs');
  assert.equal(frozen.archived,true);assert.equal(frozen.capture,live.capture);assert.equal(frozen.root,live.capture+'/runtime');
  assert.equal(driverLocations('/work/runtime/research/storage-creation-lifecycle-v035/run.mjs').archived,false);
});
test('prepared reports bind arguments, byte hashes, identity and no-execution status',()=>{
  for(const kind of['product','eels'])assert.equal(validateRecordedProcess(sample(kind)).status,'prepared');
  const x=sample();x.record.args=x.record.args.slice(0,-1);assert.throws(()=>validateRecordedProcess(x));
  const y=sample();y.record.stdout.sha256='b'.repeat(64);assert.throws(()=>validateRecordedProcess(y));
  const z=sample();z.prepareOnly=false;assert.throws(()=>validateRecordedProcess(z));
});
test('timeouts, stderr, process failures, failed closure and malformed report stay unavailable',()=>{
  for(const mutation of[x=>{x.record.wallMs=1021;},x=>{x.record.monotonicMs=-1;},x=>{x.record.status=1;},x=>{x.record.signal='SIGKILL';},x=>{x.record.error={name:'Error',message:'test'};},x=>{x.record.cleanupSignalAccepted=false;}]){const x=sample();mutation(x);assert.equal(validateRecordedProcess(x).status,'unavailable');}
  const x=sample();x.stderr=Buffer.from('error');x.record.stderr={path:'001-product.stderr',bytes:x.stderr.length,sha256:sha(x.stderr)};assert.equal(validateRecordedProcess(x).status,'unavailable');
  const y=sample();y.stdout=Buffer.from('{');y.record.stdout={path:'001-product.stdout',bytes:1,sha256:sha(y.stdout)};assert.equal(validateRecordedProcess(y).status,'unavailable');
  const z=sample();z.record.timeoutMs=0;assert.throws(()=>validateRecordedProcess(z));assert.equal(LIMITS.cases,8);
});
test('completed product must include successful isolation and distinct closed child',()=>{
  const x=sample('product',false),out=JSON.parse(x.stdout);Object.assign(out,{processClosureValid:true,attempt:{status:'completed',broker:{pendingAtReturn:0},isolation:{processClosed:true,childPid:124,exitCode:0,exitSignal:null},preview:{original:{output:{execution:{status:'reverted'}}}}}});
  const update=()=>{x.stdout=Buffer.from(JSON.stringify(out));x.record.stdout={path:'001-product.stdout',bytes:x.stdout.length,sha256:sha(x.stdout)};};update();assert.equal(validateRecordedProcess(x).status,'observed');
  out.attempt.isolation.childPid=123;update();assert.equal(validateRecordedProcess(x).status,'unavailable');assert.equal(validateRecordedProcess(x).bounded,false);
});
test('timeout, maxBuffer overflow, failed group cleanup and strict elapsed caps invalidate the packet',()=>{
  for(const mutate of[
    x=>{x.record.error={name:'Error',message:'timeout',code:'ETIMEDOUT'};},
    x=>{x.record.error={name:'Error',message:'overflow',code:'ENOBUFS'};},
    x=>{x.record.signal='SIGXFSZ';},
    x=>{x.record.cleanupSignalAccepted=false;},
    x=>{x.record.wallMs=x.record.timeoutMs+0.01;},
    x=>{x.record.monotonicMs=x.record.timeoutMs+0.01;},
  ]){const x=sample();mutate(x);const got=validateRecordedProcess(x);assert.equal(got.status,'unavailable');assert.equal(got.bounded,false);}
});
test('actual product child closure failures invalidate even a clean outer process',()=>{
  for(const mutate of[
    o=>{o.processClosureValid=false;},o=>{o.attempt.broker.pendingAtReturn=1;},
    o=>{o.attempt.isolation.processClosed=false;},o=>{o.attempt.isolation.childPid=123;},o=>{o.attempt.isolation.exitCode=1;},o=>{o.attempt.isolation.exitSignal='SIGKILL';},
  ]){
    const x=sample('product',false),out=JSON.parse(x.stdout);Object.assign(out,{processClosureValid:true,attempt:{status:'completed',broker:{pendingAtReturn:0},isolation:{processClosed:true,childPid:124,exitCode:0,exitSignal:null},preview:{original:{output:{execution:{status:'success'}}}}}});mutate(out);
    x.stdout=Buffer.from(JSON.stringify(out));x.record.stdout={path:'001-product.stdout',bytes:x.stdout.length,sha256:sha(x.stdout)};
    const got=validateRecordedProcess(x);assert.equal(got.status,'unavailable');assert.equal(got.bounded,false);
  }
});
test('unreadable actual product reports cannot establish child closure from outer exit alone',()=>{
  for(const mutate of[
    x=>{x.record.status=1;},x=>{x.record.error={name:'Error',message:'worker failed'};},
    x=>{x.stdout=Buffer.from('{');},x=>{const o=JSON.parse(x.stdout);delete o.attempt;x.stdout=Buffer.from(JSON.stringify(o));},
    x=>{const o=JSON.parse(x.stdout);o.id='wrong';x.stdout=Buffer.from(JSON.stringify(o));},
  ]){const x=sample('product',false);mutate(x);x.record.stdout={path:'001-product.stdout',bytes:x.stdout.length,sha256:sha(x.stdout)};const got=validateRecordedProcess(x);assert.equal(got.status,'unavailable');assert.equal(got.bounded,false);}
  const e=sample('eels',false);e.record.status=1;assert.equal(validateRecordedProcess(e).bounded,true);
});
const temp=t=>{const dir=fs.mkdtempSync('/tmp/lifecycle-driver-control-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('original-write ledger rejects coherent old-output resealing and exact membership changes',t=>{
  for(const mutation of['coherent','extra','missing']){
    const dir=temp(t),w=createWriteLedger(dir),raw=Buffer.from('original');w.write('001-product.stdout',raw);
    w.save('001-product-seal.json',{sha256:sha(raw)});w.verify();
    if(mutation==='coherent'){
      const changed=Buffer.from('replaced');fs.writeFileSync(path.join(dir,'001-product.stdout'),changed);
      fs.writeFileSync(path.join(dir,'001-product-seal.json'),JSON.stringify({sha256:sha(changed)})+'\n');
    }else if(mutation==='extra')fs.writeFileSync(path.join(dir,'unexpected.txt'),'extra');
    else fs.unlinkSync(path.join(dir,'001-product.stdout'));
    assert.throws(()=>w.verify());assert.throws(()=>w.seal());assert.equal(fs.existsSync(path.join(dir,'manifest.json')),false);
  }
});
test('ledger seals retain original written identities and preexisting freeze identities',t=>{
  const dir=temp(t);fs.writeFileSync(path.join(dir,'plan.json'),'{}\n');const w=createWriteLedger(dir);
  w.write('001-product.stdout',Buffer.from('raw output'));w.save('results.json',{evidenceUsable:false});
  const pin=w.seal({planSha256:'a'.repeat(64)}),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))),ledger=JSON.parse(fs.readFileSync(path.join(dir,'write-ledger.json')));
  assert.equal(pin,sha(fs.readFileSync(path.join(dir,'manifest.json'))));w.verify();
  assert.equal(ledger.files.find(r=>r.path==='plan.json').origin,'preexisting');assert.equal(ledger.files.find(r=>r.path==='001-product.stdout').origin,'written');
  assert.deepEqual(manifest.files.filter(r=>r.path!=='write-ledger.json'),ledger.files.map(({origin,...row})=>row));
});
test('pure driver controls stop after an unbounded first attempt and retain all sixteen positions',async t=>{
  for(const code of['ETIMEDOUT','ENOBUFS','child_closure']){
    const dir=temp(t),writer=createWriteLedger(dir);let dispatched=0;
    const result=await executeMatrix(plan,writer,false,{checkIdentity:async()=>{},processAttempt:()=>{
      dispatched++;writer.save('001-product-process.json',{synthetic:true,code});
      return{status:'unavailable',bounded:false,bytes:0,process:'001-product-process.json'};
    }});
    assert.equal(dispatched,1);assert.equal(result.rows.length,16);assert.equal(result.rows[0].status,'unavailable');
    assert(result.rows.slice(1).every(r=>r.status==='not_attempted'&&r.process===null));assert.equal(result.evidenceUsable,false);assert(result.fatal);
    writer.save('results.json',result);writer.seal();
  }
});
test('pure driver checks the original-write ledger before another dispatch and at termination',async t=>{
  const dir=temp(t),writer=createWriteLedger(dir);let dispatched=0;
  const result=await executeMatrix(plan,writer,false,{checkIdentity:async()=>{},processAttempt:()=>{
    dispatched++;writer.write('001-product.stdout',Buffer.from('original'));
    fs.writeFileSync(path.join(dir,'001-product.stdout'),'poisoned');
    return{status:'observed',bounded:true,bytes:8,process:'001-product-process.json'};
  }});
  assert.equal(dispatched,1);assert.equal(result.evidenceUsable,false);assert(result.fatal);assert(result.rows.slice(1).every(r=>r.status==='not_attempted'));
  assert.throws(()=>writer.seal());
});
test('all eight product raw records and seals precede the first EELS dispatch',async t=>{
  const dir=temp(t),writer=createWriteLedger(dir),order=[];let identityChecks=0;
  const result=await executeMatrix(plan,writer,false,{checkIdentity:async()=>{identityChecks++;},processAttempt:(_plan,index,kind,_prepare,_writer,timeout)=>{
    assert(timeout>0&&timeout<=LIMITS.processMs);assert.equal(_prepare,false);writer.verify();
    if(kind==='eels')for(let i=0;i<8;i++){const stem=String(i+1).padStart(3,'0')+'-product';const record=fs.readFileSync(path.join(dir,stem+'-process.json'));const seal=JSON.parse(fs.readFileSync(path.join(dir,stem+'-seal.json')));assert.equal(seal.processSha256,sha(record));assert.equal(seal.stdoutSha256,sha(fs.readFileSync(path.join(dir,stem+'.stdout'))));}
    order.push([index,kind]);const stem=String(index+1).padStart(3,'0')+'-'+kind,raw=Buffer.from('synthetic observed '+stem);writer.write(stem+'.stdout',raw);const processSha256=writer.save(stem+'-process.json',{synthetic:true,index,kind});writer.save(stem+'-seal.json',{processSha256,stdoutSha256:sha(raw)});
    return{status:'observed',bounded:true,bytes:raw.length,process:stem+'-process.json'};
  }});
  assert.deepEqual(order,['product','eels'].flatMap(kind=>Array.from({length:8},(_,index)=>[index,kind])));assert.equal(identityChecks,33);assert.equal(result.evidenceUsable,true);assert.equal(result.rows.length,16);assert(result.rows.every(r=>r.status==='observed'));writer.verify();
});
test('missing original observation retains every declared query channel as unavailable',()=>{
  const input={queries:[{kind:'native_balance',account:'x'},{to:'y',data:'0x'},{kind:'native_balance',account:'z'}]},rows=retainPreviewPositions(input,null);
  assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>[r.index,r.kind]),[[0,'native_balance'],[1,'contract_call'],[2,'native_balance']]);
  assert.deepEqual(rows.map(r=>Object.keys(r.channels).length),[6,20,6]);assert(rows.every(r=>Object.values(r.channels).every(v=>v===null)));
  assert.deepEqual(retainPreviewPositions(input,rows),rows);assert.throws(()=>retainPreviewPositions(input,rows.slice(0,2)));
  const changed=structuredClone(rows);changed[1].channels.values=true;changed[1].index=2;assert.throws(()=>retainPreviewPositions(input,changed));
});
test('comparison distinguishes missing dimensions and disagreements',()=>{
  assert.deepEqual(comparePair(null,null),Object.fromEntries(CHANNELS.map(k=>[k,null])));
  const a={completedExecution:true,...Object.fromEntries(CHANNELS.map(k=>[k,'same']))},b=structuredClone(a);b.returnData=null;b.chargedGas='different';
  const out=comparePair(a,b);assert.equal(out.returnData,null);assert.equal(out.chargedGas,false);assert.equal(out.stateRoot,true);
});
test('prepare-only forces original input validation and query signing then returns before targets',()=>{
  const read=name=>fs.readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8'),p=read('product-worker.mjs'),e=read('eels-worker.py'),old=read('../storage-creation-forks-v035/eels-worker.py');
  const productBoundary=p.indexOf("if(process.argv[4]==='--prepare-only')"),productImport=p.indexOf("await import('../../engines/local-evm/isolated-call.js')");assert(productBoundary>0&&productBoundary<productImport);assert(p.slice(productBoundary,productImport).includes('executionInvoked:false'));
  const main=e.slice(e.indexOf('\ndef main():')),force=main.indexOf('sys.argv = saved_argv[:4] + ["--prepare-only"]'),prepared=main.indexOf('prepared = original.main()'),restore=main.indexOf('sys.argv = saved_argv',prepared),sign=main.indexOf('api.signed_query(template["request"], d["allocation"])'),boundary=main.indexOf('if len(saved_argv) == 5:'),target=main.indexOf('report = original.main()'),query=main.indexOf('api.query(template["request"], allocation, state_root)');
  assert(force>0&&prepared>force&&restore>prepared&&sign>restore&&boundary>sign&&target>boundary&&query>target);
  assert(main.slice(boundary,target).includes('return {**prepared'));assert(main.slice(boundary,target).includes('"queryPreparation": query_preparation'));
  assert.equal(main.match(/original\.main\(/g).length,2);assert.equal(main.match(/api\.query\(/g).length,1);assert(!main.slice(0,boundary).includes('api.query('));assert(!main.slice(0,boundary).includes('apply_body('));
  const priorBoundary=old.indexOf('if len(sys.argv) == 5:'),priorTarget=old.indexOf('output = fork.apply_body');assert(priorBoundary>0&&priorTarget>priorBoundary);assert(old.slice(priorBoundary,old.indexOf('tracked = state_tracker.BlockState')).includes('return report'));
});
test('fixed source closure includes query interpretation and unchanged original adapter dependencies',()=>{
  for(const name of['query-reference-notes.md','query-observations.mjs','query-observations.test.mjs','preparation.test.mjs'])assert(OWN.includes(name));
  const rows=sourceRows(),byPath=new Set(rows.map(r=>r.path));assert.equal(byPath.size,rows.length);
  for(const name of['eels-worker.py','observations.mjs','delta.mjs'])assert(byPath.has('research/storage-creation-forks-v035/'+name));
  for(const name of OWN)assert(byPath.has('research/storage-creation-lifecycle-v035/'+name));
});
