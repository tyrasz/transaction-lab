// Preparation and frozen-only dispatch. Importing this file never runs a VM.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createWriteLedger} from '../storage-creation-lifecycle-v035/run.mjs';
export {createWriteLedger};
export const PREFIX='research/local-sequence-v036-reference';
export const LIMITS=Object.freeze({cases:4,positions:12,processMs:15000,cpuSeconds:15,
  totalMs:180000,streamBytes:2097152,processBytes:4194304,totalBytes:33554432,
  timeScope:'executeMatrix_entry_through_terminal_source_and_ledger_verification_excludes_final_artifact_sealing_and_delivery'});
export const OWN=Object.freeze(['PLAN.md','cases.mjs','cases.test.mjs','eels-worker.py',
  'product-worker.mjs','exec-bounded.py','toolchain.mjs','observations.mjs','observations.test.mjs',
  'run.mjs','run.test.mjs','toolchain-drift.json','source-notes.json']);
const sha=raw=>createHash('sha256').update(raw).digest('hex'),read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const n=i=>String(i+1).padStart(3,'0'),finite=(v,max)=>Number.isFinite(v)&&v>=0&&v<=max;
export function driverLocations(filename){
  const here=path.dirname(path.resolve(filename)),root=path.resolve(here,'../..'),candidate=path.dirname(root);
  const archived=path.basename(root)==='runtime'&&path.basename(candidate)==='capture'&&
    path.resolve(filename)===path.join(candidate,'runtime',PREFIX,'run.mjs');
  return{here,root,archived,prepared:path.join(here,'prepared'),capture:archived?candidate:path.join(here,'capture')};
}
const LOCATION=driverLocations(fileURLToPath(import.meta.url)),ROOT=LOCATION.root,PREP=LOCATION.prepared,CAPTURE=LOCATION.capture;
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});return sha(read(file));}
function walk(base,relative=''){return fs.readdirSync(path.join(base,relative)).sort().flatMap(name=>{
  const p=relative?relative+'/'+name:name,s=fs.lstatSync(path.join(base,p));return s.isDirectory()?walk(base,p):[p];}).sort();}
function entry(base,p){assert(p&&!path.isAbsolute(p)&&!p.split('/').includes('..'));const f=path.join(base,p),s=fs.lstatSync(f);
  if(s.isSymbolicLink()){const real=fs.realpathSync(f);assert(real.startsWith(base+path.sep)&&fs.statSync(real).isFile());return{path:p,kind:'symlink',target:fs.readlinkSync(f),resolvedSha256:sha(read(real))};}
  assert(s.isFile()&&s.size<=67108864);return{path:p,kind:'file',mode:s.mode&511,bytes:s.size,sha256:sha(read(f))};}
function checkRows(base,rows){for(const row of rows)assert.deepEqual(entry(base,row.path),row);}
function copyRows(from,to,rows){for(const row of rows.filter(r=>r.kind==='file')){const f=path.join(to,row.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,read(path.join(from,row.path)),{flag:'wx',mode:row.mode});fs.chmodSync(f,row.mode);}
  for(const row of rows.filter(r=>r.kind==='symlink')){const f=path.join(to,row.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.symlinkSync(row.target,f);}}
function nodeIdentity(){return{executable:fs.realpathSync(process.execPath),version:process.version,sha256:sha(read(process.execPath))};}
export function sourceRows(){
  const paths=['package.json','engines/evm-context.js','reports/ethereum-proof-capability/capture.json',
    'research/amsterdam-storage-creation-v033/observations.mjs',
    'research/storage-creation-lifecycle-v035/run.mjs',
    'research/storage-creation-lifecycle-v035/toolchain.mjs',...OWN.map(p=>PREFIX+'/'+p)];
  for(const engine of['local-evm','fixture-evm']){const dir='engines/'+engine;
    for(const item of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true}))
      if(item.isFile()&&(item.name.endsWith('.js')||['package.json','package-lock.json'].includes(item.name)))paths.push(dir+'/'+item.name);
    paths.push(...walk(ROOT,dir+'/node_modules'));
  }
  for(const p of['proof-fixture.js','lifecycle-fixture.js','authorization-fixture.js','fee-fixture.js',
    'amsterdam-execution-fixture.js','sequence-fixture.js'])paths.push('engines/local-evm/test/'+p);
  const rows=[...new Set(paths)].sort().map(p=>entry(ROOT,p));
  assert(rows.length<6000&&rows.reduce((s,r)=>s+(r.bytes??0),0)<67108864);return rows;
}
export function invocation(plan,index,kind,prepareOnly=false){
  assert(Number.isSafeInteger(index)&&index>=0&&index<LIMITS.cases);assert(['product','eels'].includes(kind));
  const input=plan.inputs[index],file=path.join(plan.inputBase,input.path),root=plan.runtimePath;
  const target=kind==='product'?plan.node.executable:plan.toolchain.python;
  const args=kind==='product'?['--max-old-space-size=256',path.join(root,PREFIX,'product-worker.mjs'),file,input.sha256]
    :['-I','-B',path.join(root,PREFIX,'eels-worker.py'),file,path.join(plan.inputBase,'toolchain.json'),input.sha256];
  if(prepareOnly)args.push('--prepare-only');
  return{executable:plan.toolchain.python,args:['-I','-B',path.join(root,PREFIX,'exec-bounded.py'),target,...args]};
}
export function validateRecordedProcess({plan,index,kind,prepareOnly=false,record,stdout,stderr}){
  const expected=invocation(plan,index,kind,prepareOnly);assert.equal(record.executable,expected.executable);assert.deepEqual(record.args,expected.args);
  assert(Number.isSafeInteger(record.timeoutMs)&&record.timeoutMs>0&&record.timeoutMs<=LIMITS.processMs);
  const stem=n(index)+'-'+kind;
  for(const[k,b]of[['stdout',stdout],['stderr',stderr]]){
    assert.deepEqual(record[k],{path:stem+'.'+k,bytes:b.length,sha256:sha(b)});
    assert(Number.isSafeInteger(record.observedBytes[k])&&record.observedBytes[k]>=b.length);
  }
  assert(record.status===null||Number.isInteger(record.status));assert(record.signal===null||typeof record.signal==='string');
  assert(record.error===null||typeof record.error.name==='string'&&typeof record.error.message==='string');
  let bounded=finite(record.wallMs,record.timeoutMs)&&finite(record.monotonicMs,record.timeoutMs)&&
    record.processClosed===true&&record.cleanupSignalAccepted===true&&record.limitFailure===null&&
    ['stdout','stderr'].every(k=>record.observedBytes[k]<=LIMITS.streamBytes&&record.observedBytes[k]===record[k].bytes)&&
    stdout.length+stderr.length<=LIMITS.processBytes&&record.signal===null;
  let report=null,productClosure=kind!=='product'||prepareOnly;
  try{
    report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stdout));
    assert.equal(report.id,plan.inputs[index].id);assert.equal(report.inputSha256,plan.inputs[index].sha256);
    if(kind==='product'){
      assert.equal(report.workerPid,record.pid);assert(Number.isSafeInteger(record.pid)&&record.pid>0);
      assert.equal(report.scope,'frozen_four_case_unsigned_product_sequence');
      assert.equal(report.expectedPoststateConsumed,false);assert.equal(report.otherClientOutputsConsumed,false);
      if(prepareOnly)assert.equal(report.executionInvoked,false);
      else{const a=report.attempt;
        productClosure=report.processClosureValid===true&&a?.broker?.pendingAtReturn===0&&
          a?.isolation?.processClosed===true&&a.isolation.exitCode===0&&a.isolation.exitSignal===null&&
          Number.isSafeInteger(a.isolation.childPid)&&a.isolation.childPid>0&&a.isolation.childPid!==record.pid;
      }
    }else{
      assert.equal(report.sourceModule,path.join(plan.toolchain.root,'source/src/ethereum/forks',plan.inputs[index].fork.toLowerCase(),'fork.py'));
      assert.equal(report.fork,plan.inputs[index].fork);
    }
    assert.equal(report.status,prepareOnly?'prepared_no_execution':'completed');
  }catch{report=null;}
  bounded&&=productClosure;
  if(!bounded||record.status!==0||record.signal!==null||record.error!==null||stderr.length||!report)
    return{status:'unavailable',bounded,report:null};
  return{status:prepareOnly?'prepared':'observed',bounded,report};
}
// Stream caps are checked on each chunk. Preserve the exact bounded prefix and
// observed length on overflow, kill the whole group, and stop later dispatch.
export async function processOnce(plan,index,kind,prepareOnly,writer,timeoutMs){
  const {executable,args}=invocation(plan,index,kind,prepareOnly),start=Date.now(),mono=performance.now();
  const chunks={stdout:[],stderr:[]},observedBytes={stdout:0,stderr:0},retained={stdout:0,stderr:0};
  let child,status=null,signal=null,error=null,limitFailure=null,closed=false,cleanupSignalAccepted=false,timer,killTimer;
  function cleanup(){if(!Number.isSafeInteger(child?.pid)||child.pid<=0)return false;
    try{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}return true;}
    catch(e){error??={name:e.name,message:e.message,code:e.code??null};return false;}}
  await new Promise(resolve=>{
    const fail=reason=>{limitFailure??=reason;cleanup();killTimer??=setTimeout(resolve,1000);};
    try{child=spawn(executable,args,{cwd:plan.runtimePath,detached:true,stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH??'',LANG:'C',TZ:'UTC'}});}
    catch(e){error={name:e.name,message:e.message,code:e.code??null};resolve();return;}
    for(const key of['stdout','stderr'])child[key].on('data',chunk=>{
      observedBytes[key]+=chunk.length;const keep=chunk.subarray(0,Math.max(0,LIMITS.streamBytes-retained[key]));
      if(keep.length){chunks[key].push(keep);retained[key]+=keep.length;}
      if(observedBytes[key]>LIMITS.streamBytes||observedBytes.stdout+observedBytes.stderr>LIMITS.processBytes)fail('output_bytes');
    });
    child.on('error',e=>{error={name:e.name,message:e.message,code:e.code??null};});
    child.on('close',(code,sig)=>{closed=true;status=code;signal=sig;resolve();});
    timer=setTimeout(()=>fail('wall_timeout'),timeoutMs);
  });
  clearTimeout(timer);clearTimeout(killTimer);cleanupSignalAccepted=cleanup();
  const stdout=Buffer.concat(chunks.stdout),stderr=Buffer.concat(chunks.stderr),stem=n(index)+'-'+kind;
  const record={executable,args,pid:child?.pid??null,timeoutMs,wallMs:Date.now()-start,monotonicMs:performance.now()-mono,
    status,signal,error,limitFailure,processClosed:closed,cleanupSignalAccepted,observedBytes,
    stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:stderr.length,sha256:sha(stderr)}};
  writer.write(record.stdout.path,stdout);writer.write(record.stderr.path,stderr);
  const processSha256=writer.save(stem+'-process.json',record);writer.save(stem+'-seal.json',{processSha256,stdout:record.stdout,stderr:record.stderr});
  return{...validateRecordedProcess({plan,index,kind,prepareOnly,record,stdout,stderr}),
    bytes:stdout.length+stderr.length,observedBytes:observedBytes.stdout+observedBytes.stderr,process:stem+'-process.json'};
}
const descriptor=t=>({sha256:t.sha256,bytes:t.bytes,entries:t.entries,python:t.manifest.python,root:t.manifest.toolchain});
async function toolchainModule(runtime=ROOT){return import(pathToFileURL(path.join(runtime,PREFIX,'toolchain.mjs')).href);}
async function assertIdentity(plan,prepared=false){
  assert.deepEqual(nodeIdentity(),plan.node);
  if(prepared)assert.deepEqual(sourceRows(),plan.files);
  else{assert.deepEqual(walk(plan.runtimePath),plan.files.map(r=>r.path));checkRows(plan.runtimePath,plan.files);
    assert.equal(sha(read(path.join(plan.runtimePath,PREFIX,'run.mjs'))),sha(read(fileURLToPath(import.meta.url))));}
  checkRows(plan.inputBase,plan.inputs.map(({id,fork,...r})=>r));
  if(!prepared){const base=path.join(plan.inputBase,'preparation'),file=path.join(base,'manifest.json');
    assert.equal(sha(read(file)),plan.preparationManifestSha256);const m=json(file);
    assert.deepEqual(walk(base),[...m.files.map(r=>r.path),'manifest.json'].sort());checkRows(base,m.files);}
  const module=await toolchainModule(plan.runtimePath);
  assert.equal(plan.toolchain.sha256,module.TOOLCHAIN_SHA256);
  assert.deepEqual(descriptor(module.verifyToolchain(path.join(plan.inputBase,'toolchain.json'))),plan.toolchain);
}
export async function executeMatrix(plan,writer,prepareOnly,{checkIdentity=assertIdentity,processAttempt=processOnce,now=Date.now,monotonic=()=>performance.now()}={}){
  assert.equal(plan.inputs.length,LIMITS.cases);assert.equal(new Set(plan.inputs.map(i=>i.id)).size,LIMITS.cases);
  const wall0=now(),mono0=monotonic();let lastWall=0,lastMono=0,reversed=false,totalBytes=0,totalObservedBytes=0,fatal=null;
  const timing=()=>{const wallMs=now()-wall0,monotonicMs=monotonic()-mono0;
    reversed||=wallMs<lastWall||monotonicMs<lastMono;lastWall=wallMs;lastMono=monotonicMs;return{wallMs,monotonicMs,reversed};};
  const rows=['product','eels'].flatMap(kind=>plan.inputs.map((input,index)=>({index,id:input.id,kind,status:'not_attempted',process:null})));
  try{for(const row of rows){
    writer.verify();await checkIdentity(plan,prepareOnly);const elapsed=timing();assert(!elapsed.reversed,'Clock moved backwards');
    const timeoutMs=Math.floor(Math.min(LIMITS.processMs,LIMITS.totalMs-Math.max(elapsed.wallMs,elapsed.monotonicMs)));assert(timeoutMs>0,'Run deadline');
    const result=await processAttempt(plan,row.index,row.kind,prepareOnly,writer,timeoutMs);
    row.process=result.process;row.status=result.status;totalBytes+=result.bytes;totalObservedBytes+=result.observedBytes;
    assert(result.bounded&&finite(totalBytes,LIMITS.totalBytes)&&finite(totalObservedBytes,LIMITS.totalBytes),'Process budget or child closure failed');
    writer.verify();await checkIdentity(plan,prepareOnly);
    console.log(JSON.stringify({index:row.index,id:row.id,kind:row.kind,status:row.status,prepareOnly}));
  }}catch(e){fatal={name:e.name,message:e.message};}
  let sourceUnchanged=false;try{await checkIdentity(plan,prepareOnly);sourceUnchanged=true;}catch(e){fatal??={name:e.name,message:e.message};}
  try{writer.verify();}catch(e){fatal??={name:e.name,message:e.message};}
  const elapsed=timing();if(elapsed.reversed||!finite(elapsed.wallMs,LIMITS.totalMs)||!finite(elapsed.monotonicMs,LIMITS.totalMs)||!finite(totalObservedBytes,LIMITS.totalBytes))fatal??={name:'BoundsError',message:'Terminal bounds failed'};
  return{rows,fatal,sourceUnchanged,evidenceUsable:!fatal&&sourceUnchanged,elapsed,totalBytes,totalObservedBytes};
}
export async function prepare(){
  assert(!LOCATION.archived&&!fs.existsSync(CAPTURE),'Preparation must precede freeze');
  const {declaration}=await import('./cases.mjs'),module=await toolchainModule(),inputs=[];
  fs.mkdirSync(path.join(PREP,'inputs'),{recursive:true});
  for(let i=0;i<LIMITS.cases;i++){const d=await declaration(i),p='inputs/'+n(i)+'.json',raw=Buffer.from(JSON.stringify(d,null,2)+'\n'),file=path.join(PREP,p);
    if(fs.existsSync(file))assert.deepEqual(read(file),raw);else fs.writeFileSync(file,raw,{flag:'wx'});
    inputs.push({...entry(PREP,p),id:d.id,fork:d.fork});}
  const raw=read(path.join(ROOT,module.TOOLCHAIN_FILE)),destination=path.join(PREP,'toolchain.json');assert.equal(sha(raw),module.TOOLCHAIN_SHA256);
  if(fs.existsSync(destination))assert.deepEqual(read(destination),raw);else fs.writeFileSync(destination,raw,{flag:'wx'});
  const toolchain=descriptor(module.verifyToolchain(destination)),files=sourceRows();
  const base=path.join(PREP,'attempts');fs.mkdirSync(base,{recursive:true});const prior=fs.readdirSync(base).sort();assert(prior.every(s=>/^\d{3}$/.test(s)));
  const attempt=n(prior.length),dir=path.join(base,attempt);fs.mkdirSync(dir);
  const plan={schemaVersion:1,createdAt:new Date().toISOString(),runtimePath:ROOT,inputBase:PREP,node:nodeIdentity(),toolchain,limits:LIMITS,files,inputs};
  save(path.join(dir,'plan.json'),plan);const writer=createWriteLedger(dir),result=await executeMatrix(plan,writer,true);
  result.executionInvoked=false;result.allPrepared=result.evidenceUsable&&result.rows.every(r=>r.status==='prepared');
  const reportSha256=writer.save('report.json',result);writer.seal();
  return{attempt,reportSha256,allPrepared:result.allPrepared,prepared:result.rows.filter(r=>r.status==='prepared').length,expected:8,fatal:result.fatal,executionInvoked:false};
}
export function validatePreparedDirectory(dir){
  const plan=json(path.join(dir,'plan.json')),report=json(path.join(dir,'report.json')),
    manifest=json(path.join(dir,'manifest.json')),ledger=json(path.join(dir,'write-ledger.json'));
  assert.deepEqual(walk(dir),[...manifest.files.map(r=>r.path),'manifest.json'].sort());checkRows(dir,manifest.files);
  assert.equal(ledger.schemaVersion,1);
  assert.deepEqual(ledger.files,manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:r.path==='plan.json'?'preexisting':'written'})),
    'Preparation original-write ledger differs from final inventory');
  assert.deepEqual(plan.limits,LIMITS);assert.equal(plan.inputs.length,4);
  assert.equal(new Set(plan.inputs.map(r=>r.id)).size,4);
  assert.equal(report.executionInvoked,false);assert.equal(report.allPrepared,true);
  assert.equal(report.evidenceUsable,true);assert.equal(report.fatal,null);assert.equal(report.sourceUnchanged,true);
  assert.equal(report.elapsed.reversed,false);assert(finite(report.elapsed.wallMs,LIMITS.totalMs)&&finite(report.elapsed.monotonicMs,LIMITS.totalMs));
  assert.deepEqual(report.rows.map(r=>[r.index,r.kind]),['product','eels'].flatMap(k=>Array.from({length:4},(_,i)=>[i,k])));
  let totalBytes=0,totalObservedBytes=0;
  for(const row of report.rows){
    assert.equal(row.id,plan.inputs[row.index].id);assert.equal(row.status,'prepared');
    const stem=n(row.index)+'-'+row.kind;assert.equal(row.process,stem+'-process.json');
    const record=json(path.join(dir,row.process)),seal=json(path.join(dir,stem+'-seal.json')),
      stdout=read(path.join(dir,stem+'.stdout')),stderr=read(path.join(dir,stem+'.stderr'));
    assert.equal(seal.processSha256,sha(read(path.join(dir,row.process))));assert.deepEqual(seal.stdout,record.stdout);assert.deepEqual(seal.stderr,record.stderr);
    const validated=validateRecordedProcess({plan,index:row.index,kind:row.kind,prepareOnly:true,record,stdout,stderr});
    assert.equal(validated.status,'prepared');assert.equal(validated.bounded,true);
    totalBytes+=stdout.length+stderr.length;totalObservedBytes+=record.observedBytes.stdout+record.observedBytes.stderr;
  }
  assert.equal(totalBytes,report.totalBytes);assert.equal(totalObservedBytes,report.totalObservedBytes);
  assert(finite(totalBytes,LIMITS.totalBytes)&&finite(totalObservedBytes,LIMITS.totalBytes));return{plan,report,manifest};
}
export async function freeze(){
  assert(!LOCATION.archived&&!fs.existsSync(CAPTURE),'Never reuse a capture');
  const attempts=fs.readdirSync(path.join(PREP,'attempts')).sort();assert(attempts.length);
  const dir=path.join(PREP,'attempts',attempts.at(-1)),{plan:prepPlan}=validatePreparedDirectory(dir);
  await assertIdentity(prepPlan,true);
  copyRows(ROOT,path.join(CAPTURE,'runtime'),prepPlan.files);
  copyRows(PREP,CAPTURE,[...prepPlan.inputs.map(({id,fork,...r})=>r),entry(PREP,'toolchain.json')]);
  copyRows(dir,path.join(CAPTURE,'preparation'),walk(dir).map(p=>entry(dir,p)));
  const plan={...prepPlan,createdAt:new Date().toISOString(),sourceRoot:ROOT,capturePath:CAPTURE,
    runtimePath:path.join(CAPTURE,'runtime'),inputBase:CAPTURE,preparationManifestSha256:sha(read(path.join(dir,'manifest.json')))};
  const planSha256=save(path.join(CAPTURE,'plan.json'),plan);await assertIdentity(plan);
  return{planSha256,inputs:4,positions:12,files:plan.files.length,executionInvoked:false};
}
export async function run(pin,flag){
  assert.equal(flag,'--execute-frozen-targets','Execution requires the explicit flag');assert(LOCATION.archived,'Target dispatch requires the archived driver');
  assert.match(pin,/^[0-9a-f]{64}$/);assert.equal(sha(read(path.join(CAPTURE,'plan.json'))),pin);const plan=json(path.join(CAPTURE,'plan.json'));
  assert.deepEqual(plan.limits,LIMITS);await assertIdentity(plan);assert(!fs.existsSync(path.join(CAPTURE,'STARTED.json')),'Never retry a capture');
  assert.deepEqual(walk(CAPTURE),[...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'plan.json','toolchain.json',...walk(path.join(CAPTURE,'preparation')).map(p=>'preparation/'+p)].sort());
  const writer=createWriteLedger(CAPTURE);writer.save('STARTED.json',{planSha256:pin,at:new Date().toISOString(),executionFlag:flag});
  const result={planSha256:pin,...await executeMatrix(plan,writer,false)};writer.save('results.json',result);
  const manifestSha256=writer.seal({planSha256:pin});
  return{manifestSha256,evidenceUsable:result.evidenceUsable,fatal:result.fatal,counts:Object.fromEntries(['observed','unavailable','not_attempted'].map(s=>[s,result.rows.filter(r=>r.status===s).length]))};
}
export async function compare(planPin,manifestPin){
  assert.match(planPin,/^[0-9a-f]{64}$/);assert.match(manifestPin,/^[0-9a-f]{64}$/);
  assert.equal(sha(read(path.join(CAPTURE,'plan.json'))),planPin);assert.equal(sha(read(path.join(CAPTURE,'manifest.json'))),manifestPin);
  const plan=json(path.join(CAPTURE,'plan.json')),manifest=json(path.join(CAPTURE,'manifest.json')),results=json(path.join(CAPTURE,'results.json'));
  assert.equal(manifest.planSha256,planPin);assert.equal(results.planSha256,planPin);assert.deepEqual(plan.limits,LIMITS);await assertIdentity(plan);
  assert.deepEqual(walk(CAPTURE),[...manifest.files.map(r=>r.path),'manifest.json'].sort());checkRows(CAPTURE,manifest.files);
  const preexisting=new Set([...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'plan.json','toolchain.json',...walk(path.join(CAPTURE,'preparation')).map(p=>'preparation/'+p)]);
  const ledger=json(path.join(CAPTURE,'write-ledger.json'));assert.equal(ledger.schemaVersion,1);
  assert.deepEqual(ledger.files,manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:preexisting.has(r.path)?'preexisting':'written'})));
  assert.deepEqual(results.rows.map(r=>[r.index,r.kind]),['product','eels'].flatMap(k=>Array.from({length:4},(_,i)=>[i,k])));
  assert.equal(results.evidenceUsable,results.fatal===null&&results.sourceUnchanged&&results.elapsed.reversed===false&&
    finite(results.elapsed.wallMs,LIMITS.totalMs)&&finite(results.elapsed.monotonicMs,LIMITS.totalMs)&&finite(results.totalObservedBytes,LIMITS.totalBytes));
  const {productObservation,eelsObservation,compareSequence,CHANNELS}=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'observations.mjs')).href);
  const rows=[];let totalBytes=0,totalObservedBytes=0;
  for(let i=0;i<4;i++){
    const input=json(path.join(CAPTURE,plan.inputs[i].path)),row={index:i,id:input.id,fork:input.fork,product:null,eels:null,errors:{}};
    for(const kind of['product','eels']){
      const result=results.rows[(kind==='eels'?4:0)+i];assert.equal(result.id,input.id);
      if(result.process===null){assert.equal(result.status,'not_attempted');continue;}
      const stem=n(i)+'-'+kind;assert.equal(result.process,stem+'-process.json');const p=json(path.join(CAPTURE,result.process)),seal=json(path.join(CAPTURE,stem+'-seal.json'));
      assert.equal(seal.processSha256,sha(read(path.join(CAPTURE,result.process))));assert.deepEqual(seal.stdout,p.stdout);assert.deepEqual(seal.stderr,p.stderr);
      const stdout=read(path.join(CAPTURE,stem+'.stdout')),stderr=read(path.join(CAPTURE,stem+'.stderr'));
      totalBytes+=stdout.length+stderr.length;totalObservedBytes+=p.observedBytes.stdout+p.observedBytes.stderr;
      const validated=validateRecordedProcess({plan,index:i,kind,record:p,stdout,stderr});assert.equal(validated.status,result.status);
      if(results.evidenceUsable)assert(validated.bounded);
      if(validated.status==='observed'&&results.evidenceUsable)try{row[kind]=await(kind==='product'?productObservation:eelsObservation)(input,validated.report,{inputSha256:plan.inputs[i].sha256});}
      catch(e){row.errors[kind]={name:e.name,message:e.message};}
    }
    row.comparison=compareSequence(input,row.product,row.eels);rows.push(row);
  }
  assert.equal(totalBytes,results.totalBytes);assert.equal(totalObservedBytes,results.totalObservedBytes);
  const positions=rows.flatMap(row=>row.comparison.rows),channelValues=positions.flatMap(row=>Object.values(row.channels));
  return{kind:'saved_synthetic_ordered_sequence_comparison',planSha256:planPin,manifestSha256:manifestPin,
    evidenceUsable:results.evidenceUsable,channels:CHANNELS,declaredSequences:4,declaredPositions:12,rows,
    counts:{productCompleted:positions.filter(r=>r.productDisposition==='completed').length,
      referenceCompleted:positions.filter(r=>r.referenceDisposition==='completed').length,
      mutuallyCompleted:positions.filter(r=>r.productDisposition==='completed'&&r.referenceDisposition==='completed').length,
      matchedExecutedPositions:positions.filter(r=>Object.values(r.channels).every(v=>v===true)).length,
      mismatchedExecutedPositions:positions.filter(r=>Object.values(r.channels).includes(false)).length,
      dispositionMismatches:positions.filter(r=>r.dispositionMatches===false).length,
      productNotAttempted:positions.filter(r=>r.productDisposition==='not_attempted').length,
      referenceNotAttempted:positions.filter(r=>r.referenceDisposition==='not_attempted').length,
      productNonSuccess:rows.flatMap(r=>r.product?.steps??[]).filter(r=>r.observation?.completedExecution&&r.observation.executionStatus!=='success').length,
      referenceNonSuccess:rows.flatMap(r=>r.eels?.steps??[]).filter(r=>r.observation?.completedExecution&&r.observation.receiptSuccess===false).length,
      matchedChannels:channelValues.filter(v=>v===true).length,mismatchedChannels:channelValues.filter(v=>v===false).length,
      unavailableChannels:channelValues.filter(v=>v===null).length}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const action=process.argv[2];assert(['prepare','freeze','run','compare'].includes(action));assert.equal(process.argv.length,['run','compare'].includes(action)?5:3);
  const result=action==='prepare'?await prepare():action==='freeze'?await freeze():action==='run'?await run(process.argv[3],process.argv[4]):await compare(process.argv[3],process.argv[4]);
  console.log(JSON.stringify(result,null,2));if(action==='prepare'&&!result.allPrepared)process.exitCode=1;
}
