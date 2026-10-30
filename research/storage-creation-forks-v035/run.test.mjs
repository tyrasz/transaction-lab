// Offline driver/observation protocol tests. No subprocess or EVM is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {invocation,validateRecordedProcess,run,LIMITS,createWriteLedger,executeMatrix} from './run.mjs';
import {comparePair,CHANNELS} from './observations.mjs';
import {sha} from './toolchain.mjs';
const plan={runtimePath:'/frozen/runtime',inputBase:'/frozen',node:{executable:'/node'},toolchain:{root:'/pinned/eels',python:'/pinned/eels/venv/bin/python'},inputs:Array.from({length:8},(_,i)=>({path:'inputs/'+String(i+1).padStart(3,'0')+'.json',id:'case_'+i,fork:i===0?'Shanghai':'Amsterdam',sha256:'a'.repeat(64)}))};
function sample(kind='product',prepareOnly=true){const index=0,call=invocation(plan,index,kind,prepareOnly),out={id:'case_0',inputSha256:'a'.repeat(64),status:prepareOnly?'prepared_no_execution':'completed'};
  if(kind==='product')Object.assign(out,{workerPid:123,scope:'frozen_eight_case_unsigned_product_call',expectedPoststateConsumed:false,otherClientOutputsConsumed:false,executionInvoked:false});
  else Object.assign(out,{sourceModule:'/pinned/eels/source/src/ethereum/forks/shanghai/fork.py',fork:'Shanghai'});
  const stdout=Buffer.from(JSON.stringify(out)),stderr=Buffer.alloc(0),stem='001-'+kind;
  const record={...call,pid:123,timeoutMs:20,wallMs:1,monotonicMs:1,status:0,signal:null,error:null,cleanupSignalAccepted:true,stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:0,sha256:sha(stderr)}};
  return{plan,index,kind,prepareOnly,record,stdout,stderr};}
test('eight-case fixed process arguments distinguish preparation from execution',()=>{
  assert.deepEqual(invocation(plan,0,'product',true).args,['--max-old-space-size=256','/frozen/runtime/research/storage-creation-forks-v035/product-worker.mjs','/frozen/inputs/001.json','a'.repeat(64),'--prepare-only']);
  assert.deepEqual(invocation(plan,0,'eels',false).args,['-I','-B','/frozen/runtime/research/storage-creation-forks-v035/eels-worker.py','/frozen/inputs/001.json','/pinned/eels','a'.repeat(64)]);
  for(const index of[-1,8,0.5])assert.throws(()=>invocation(plan,index,'product'));
  assert.throws(()=>invocation(plan,0,'geth'));
});
test('execution gate rejects missing or altered flag before opening a capture',async()=>{
  await assert.rejects(run('a'.repeat(64)),/explicit flag/);
  await assert.rejects(run('a'.repeat(64),'--prepare-only'),/explicit flag/);
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
  const x=sample('product',false),out=JSON.parse(x.stdout);Object.assign(out,{processClosureValid:true,attempt:{status:'completed',broker:{pendingAtReturn:0},isolation:{processClosed:true,childPid:124},output:{execution:{status:'reverted'}}}});
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
    o=>{o.attempt.isolation.processClosed=false;},o=>{o.attempt.isolation.childPid=123;},
  ]){
    const x=sample('product',false),out=JSON.parse(x.stdout);Object.assign(out,{processClosureValid:true,attempt:{status:'completed',broker:{pendingAtReturn:0},isolation:{processClosed:true,childPid:124},output:{execution:{status:'success'}}}});mutate(out);
    x.stdout=Buffer.from(JSON.stringify(out));x.record.stdout={path:'001-product.stdout',bytes:x.stdout.length,sha256:sha(x.stdout)};
    const got=validateRecordedProcess(x);assert.equal(got.status,'unavailable');assert.equal(got.bounded,false);
  }
});
const temp=t=>{const dir=fs.mkdtempSync('/tmp/forks-driver-control-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
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
test('comparison distinguishes missing dimensions and disagreements',()=>{
  assert.deepEqual(comparePair(null,null),Object.fromEntries(CHANNELS.map(k=>[k,null])));
  const a={completedExecution:true,...Object.fromEntries(CHANNELS.map(k=>[k,'same']))},b=structuredClone(a);b.returnData=null;b.chargedGas='different';
  const out=comparePair(a,b);assert.equal(out.returnData,null);assert.equal(out.chargedGas,false);assert.equal(out.stateRoot,true);
});
test('prepare-only returns precede execution imports and official execution entrypoint',()=>{
  const read=name=>fs.readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8'),p=read('product-worker.mjs'),e=read('eels-worker.py');
  assert(p.indexOf("if(process.argv[4]==='--prepare-only')")<p.indexOf("await import('../../engines/local-evm/isolated-call.js')"));
  const boundary=e.indexOf('if len(sys.argv) == 5:');assert(boundary>0);for(const target of['tracked = state_tracker.BlockState','block_env = BlockEnvironment','prior_trace = set_evm_trace','output = fork.apply_body'])assert(boundary<e.indexOf(target));
  assert.equal(e.match(/fork\.apply_body\(/g).length,1);assert(e.slice(boundary,e.indexOf('tracked = state_tracker.BlockState')).includes('return report'));
});
