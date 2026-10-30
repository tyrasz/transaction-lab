import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const TOOLCHAIN_FILE='research/storage-creation-v035/eels-comparison/capture/toolchain.json';
const TOOLCHAIN_SHA256='5e67873833811992160173737d5c6f229dad327281e7e915ecce206cac4cb005';

const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../..');
const PREFIX='research/storage-creation-forks-v035',OLD='research/amsterdam-storage-creation-v033';
const PREP=path.join(HERE,'prepared'),CAPTURE=path.join(HERE,'capture');
const OWN=['PLAN.md','cases.mjs','cases.test.mjs','delta.mjs','eels-worker.py','product-worker.mjs','toolchain.mjs','observations.mjs','observations.test.mjs','run.mjs','run.test.mjs','preparation.test.mjs'];
export const LIMITS=Object.freeze({cases:8,processMs:20000,totalMs:360000,processBytes:8388608,totalBytes:83886080});
const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p)),n=i=>String(i+1).padStart(3,'0');
const finite=(v,max)=>Number.isFinite(v)&&v>=0&&v<=max;
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});return sha(read(file));}
function walk(base,relative=''){return fs.readdirSync(path.join(base,relative)).sort().flatMap(name=>{const p=relative?relative+'/'+name:name,s=fs.lstatSync(path.join(base,p));return s.isDirectory()?walk(base,p):[p];}).sort();}
function entry(base,p){assert(p&&!path.isAbsolute(p)&&!p.split('/').includes('..'));const f=path.join(base,p),s=fs.lstatSync(f);
  if(s.isSymbolicLink()){const real=fs.realpathSync(f);assert(real.startsWith(base+path.sep));assert(fs.statSync(real).isFile());return{path:p,kind:'symlink',target:fs.readlinkSync(f),resolvedSha256:sha(read(real))};}
  assert(s.isFile()&&s.size<=67108864);return{path:p,kind:'file',mode:s.mode&511,bytes:s.size,sha256:sha(read(f))};}
function nodeIdentity(){return{executable:fs.realpathSync(process.execPath),version:process.version,sha256:sha(read(process.execPath))};}
function sourceRows(){const paths=['package.json','engines/evm-context.js','reports/ethereum-proof-capability/capture.json',OLD+'/observations.mjs',...OWN.map(p=>PREFIX+'/'+p)];
  for(const engine of['local-evm','fixture-evm']){const dir='engines/'+engine;for(const item of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true}))if(item.isFile()&&(item.name.endsWith('.js')||['package.json','package-lock.json'].includes(item.name)))paths.push(dir+'/'+item.name);paths.push(...walk(ROOT,dir+'/node_modules'));}
  for(const p of['proof-fixture.js','lifecycle-fixture.js','authorization-fixture.js','fee-fixture.js','amsterdam-execution-fixture.js','amsterdam-creation-attempts-fixture.js'])paths.push('engines/local-evm/test/'+p);
  const rows=[...new Set(paths)].sort().map(p=>entry(ROOT,p));assert(rows.length<6000&&rows.reduce((s,r)=>s+(r.bytes??0),0)<67108864);return rows;}
function checkRows(base,rows){for(const row of rows)assert.deepEqual(entry(base,row.path),row);}
function copyRows(from,to,rows){for(const row of rows.filter(r=>r.kind==='file')){const f=path.join(to,row.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,read(path.join(from,row.path)),{flag:'wx',mode:row.mode});fs.chmodSync(f,row.mode);}for(const row of rows.filter(r=>r.kind==='symlink')){const f=path.join(to,row.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.symlinkSync(row.target,f);}}
// Bind raw output to the bytes originally written, not a later rehash at seal.
// Runtime/input identities are also checked separately against the frozen plan.
export function createWriteLedger(directory){
  const rows=new Map(walk(directory).map(p=>[p,{...entry(directory,p),origin:'preexisting'}]));
  function identities(){return[...rows.values()].map(({origin,...row})=>row).sort((a,b)=>a.path.localeCompare(b.path));}
  const writer={
    verify(){assert.deepEqual(walk(directory),[...rows.keys()].sort(),'Capture inventory changed');checkRows(directory,identities());},
    write(p,raw){assert(typeof p==='string'&&p.length>0&&!path.isAbsolute(p)&&p.split('/').every(v=>v&&v!=='.'&&v!=='..')&&!rows.has(p));assert(Buffer.isBuffer(raw));
      const file=path.join(directory,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,raw,{flag:'wx'});
      const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink());rows.set(p,{path:p,kind:'file',mode:s.mode&511,bytes:raw.length,sha256:sha(raw),origin:'written'});
      checkRows(directory,[identities().find(row=>row.path===p)]);return sha(raw);},
    save(p,value){return writer.write(p,Buffer.from(JSON.stringify(value,null,2)+'\n'));},
    seal(extra={}){writer.verify();writer.save('write-ledger.json',{schemaVersion:1,files:[...rows.values()].sort((a,b)=>a.path.localeCompare(b.path))});writer.verify();
      const hash=writer.save('manifest.json',{...extra,files:identities()});writer.verify();return hash;},
  };return Object.freeze(writer);
}
export function invocation(plan,index,kind,prepareOnly=false){assert(Number.isSafeInteger(index)&&index>=0&&index<8);assert(['product','eels'].includes(kind));
  const input=plan.inputs[index],root=plan.runtimePath,file=path.join(plan.inputBase,input.path);
  const executable=kind==='product'?plan.node.executable:plan.toolchain.python;
  const args=kind==='product'?['--max-old-space-size=256',path.join(root,PREFIX,'product-worker.mjs'),file,input.sha256]:['-I','-B',path.join(root,PREFIX,'eels-worker.py'),file,plan.toolchain.root,input.sha256];
  if(prepareOnly)args.push('--prepare-only');return{executable,args};}
export function validateRecordedProcess({plan,index,kind,prepareOnly=false,record,stdout,stderr}){
  const expected=invocation(plan,index,kind,prepareOnly);assert.equal(record.executable,expected.executable);assert.deepEqual(record.args,expected.args);
  assert(Number.isSafeInteger(record.timeoutMs)&&record.timeoutMs>0&&record.timeoutMs<=LIMITS.processMs);
  const stem=n(index)+'-'+kind;
  for(const[k,b]of[['stdout',stdout],['stderr',stderr]])assert.deepEqual(record[k],{path:stem+'.'+k,bytes:b.length,sha256:sha(b)});
  assert(record.status===null||Number.isInteger(record.status));assert(record.signal===null||typeof record.signal==='string');
  assert(record.error===null||record.error&&typeof record.error.name==='string'&&typeof record.error.message==='string');
  let bounded=finite(record.wallMs,record.timeoutMs)&&finite(record.monotonicMs,record.timeoutMs)&&stdout.length+stderr.length<=LIMITS.processBytes&&
    !['ETIMEDOUT','ENOBUFS'].includes(record.error?.code)&&record.signal!=='SIGXFSZ'&&record.cleanupSignalAccepted===true;
  if(!bounded||record.status!==0||record.signal!==null||record.error!==null||stderr.length!==0||!record.cleanupSignalAccepted)return{status:'unavailable',bounded,report:null};
  try{const out=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stdout));assert.equal(out.id,plan.inputs[index].id);assert.equal(out.inputSha256,plan.inputs[index].sha256);assert.equal(out.status,prepareOnly?'prepared_no_execution':'completed');
    if(kind==='product'){assert.equal(out.workerPid,record.pid);assert(Number.isSafeInteger(record.pid)&&record.pid>0);assert.equal(out.scope,'frozen_eight_case_unsigned_product_call');assert.equal(out.expectedPoststateConsumed,false);assert.equal(out.otherClientOutputsConsumed,false);
      if(prepareOnly)assert.equal(out.executionInvoked,false);else{const a=out.attempt;
        bounded&&=out.processClosureValid===true&&a?.broker?.pendingAtReturn===0&&a?.isolation?.processClosed===true&&Number.isSafeInteger(a.isolation.childPid)&&a.isolation.childPid>0&&a.isolation.childPid!==record.pid;
        assert(bounded,'Product child closure is not established');assert.equal(a.status,'completed');assert(['success','reverted','failed'].includes(a.output.execution.status));}}
    else{assert.equal(out.sourceModule,path.join(plan.toolchain.root,'source/src/ethereum/forks',plan.inputs[index].fork.toLowerCase(),'fork.py'));assert.equal(out.fork,plan.inputs[index].fork);}
    return{status:prepareOnly?'prepared':'observed',bounded,report:out};
  }catch{return{status:'unavailable',bounded,report:null};}
}
function processOnce(plan,index,kind,prepareOnly,writer,timeoutMs){const {executable,args}=invocation(plan,index,kind,prepareOnly),start=Date.now(),mono=performance.now();
  const r=spawnSync(executable,args,{cwd:plan.runtimePath,encoding:null,detached:true,timeout:timeoutMs,maxBuffer:LIMITS.processBytes/2,killSignal:'SIGKILL',env:{PATH:process.env.PATH??'',LANG:'C',TZ:'UTC'}});
  // Every child inherits this fresh process group. Kill any orphan descendant
  // even when the direct worker exited; this does not certify its own cleanup.
  let cleanupSignalAccepted=false,cleanupError=null;
  try{if(Number.isSafeInteger(r.pid)&&r.pid>0){try{process.kill(-r.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}cleanupSignalAccepted=true;}}catch(e){cleanupError={name:e.name,message:e.message};}
  const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0),stem=n(index)+'-'+kind;
  const record={executable,args,pid:r.pid??null,timeoutMs,wallMs:Date.now()-start,monotonicMs:performance.now()-mono,status:r.status,signal:r.signal,
    error:r.error?{name:r.error.name,message:r.error.message,code:r.error.code??null}:cleanupError,cleanupSignalAccepted,
    stdout:{path:stem+'.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{path:stem+'.stderr',bytes:stderr.length,sha256:sha(stderr)}};
  for(const[k,b]of[['stdout',stdout],['stderr',stderr]])writer.write(record[k].path,b);
  const processSha256=writer.save(stem+'-process.json',record);writer.save(stem+'-seal.json',{processSha256,stdout:record.stdout,stderr:record.stderr});
  return{...validateRecordedProcess({plan,index,kind,prepareOnly,record,stdout,stderr}),bytes:stdout.length+stderr.length,process:stem+'-process.json'};
}
function descriptor(t){return{sha256:t.sha256,bytes:t.bytes,entries:t.entries,python:t.manifest.python,root:t.manifest.toolchain};}
async function toolchainVerification(manifestPath,runtime=ROOT){const module=await import(pathToFileURL(path.join(runtime,PREFIX,'toolchain.mjs')).href);return module.verifyToolchain(manifestPath);}
async function assertIdentity(plan,prepared=false){assert.deepEqual(nodeIdentity(),plan.node);assert.equal(plan.toolchain.sha256,TOOLCHAIN_SHA256);
  if(prepared)assert.deepEqual(sourceRows(),plan.files);else{assert.deepEqual(walk(plan.runtimePath),plan.files.map(r=>r.path));checkRows(plan.runtimePath,plan.files);assert.equal(sha(read(path.join(plan.runtimePath,PREFIX,'run.mjs'))),sha(read(fileURLToPath(import.meta.url))));}
  checkRows(plan.inputBase,plan.inputs.map(({id,fork,...r})=>r));
  if(!prepared){const base=path.join(plan.inputBase,'preparation'),file=path.join(base,'manifest.json');assert.equal(sha(read(file)),plan.preparationManifestSha256);const m=json(file);assert.deepEqual(walk(base),[...m.files.map(r=>r.path),'manifest.json'].sort());checkRows(base,m.files);}
  // Only import the toolchain verifier after its complete source tree is bound.
  assert.deepEqual(descriptor(await toolchainVerification(path.join(plan.inputBase,'toolchain.json'),plan.runtimePath)),plan.toolchain);}
async function declarations(){const {declaration}=await import('./cases.mjs');const inputs=[];
  fs.mkdirSync(path.join(PREP,'inputs'),{recursive:true});
  for(let i=0;i<8;i++){const d=await declaration(i),p='inputs/'+n(i)+'.json',raw=Buffer.from(JSON.stringify(d,null,2)+'\n'),f=path.join(PREP,p);if(fs.existsSync(f))assert.deepEqual(read(f),raw);else fs.writeFileSync(f,raw,{flag:'wx'});inputs.push({...entry(PREP,p),id:d.id,fork:d.fork});}
  const raw=read(path.join(ROOT,TOOLCHAIN_FILE)),p=path.join(PREP,'toolchain.json');assert.equal(sha(raw),TOOLCHAIN_SHA256);if(fs.existsSync(p))assert.deepEqual(read(p),raw);else fs.writeFileSync(p,raw,{flag:'wx'});return inputs;}
export async function executeMatrix(plan,writer,prepareOnly,{checkIdentity=assertIdentity,processAttempt=processOnce}={}){const wall0=Date.now(),mono0=performance.now();let lastWall=0,lastMono=0,reversed=false,totalBytes=0,fatal=null;
  const timing=()=>{const wallMs=Date.now()-wall0,monotonicMs=performance.now()-mono0;reversed||=wallMs<lastWall||monotonicMs<lastMono;lastWall=wallMs;lastMono=monotonicMs;return{wallMs,monotonicMs,reversed};};
  const rows=plan.inputs.flatMap((input,index)=>['product','eels'].map(kind=>({index,id:input.id,kind,status:'not_attempted',process:null})));
  try{for(const row of rows){writer.verify();await checkIdentity(plan,prepareOnly);const elapsed=timing();assert(!elapsed.reversed);const timeoutMs=Math.floor(Math.min(LIMITS.processMs,LIMITS.totalMs-Math.max(elapsed.wallMs,elapsed.monotonicMs)));assert(timeoutMs>0,'No bounded execution time remains');
      const result=processAttempt(plan,row.index,row.kind,prepareOnly,writer,timeoutMs);row.process=result.process;row.status=result.status;totalBytes+=result.bytes;
      assert(result.bounded&&totalBytes<=LIMITS.totalBytes,'Process output, time, or child-closure limit');writer.verify();await checkIdentity(plan,prepareOnly);
      console.log(JSON.stringify({index:row.index,id:row.id,kind:row.kind,status:row.status,prepareOnly}));}}
  catch(e){fatal={name:e.name,message:e.message};}
  let sourceUnchanged=false;try{await checkIdentity(plan,prepareOnly);sourceUnchanged=true;}catch(e){fatal??={name:e.name,message:e.message};}
  try{writer.verify();}catch(e){fatal??={name:e.name,message:e.message};}
  const elapsed=timing();if(elapsed.reversed||!finite(elapsed.wallMs,LIMITS.totalMs)||!finite(elapsed.monotonicMs,LIMITS.totalMs)||!finite(totalBytes,LIMITS.totalBytes))fatal??={name:'BoundsError',message:'Terminal bounds failed'};
  return{rows,fatal,sourceUnchanged,evidenceUsable:!fatal&&sourceUnchanged,elapsed,totalBytes};
}
export async function prepare(){assert(!fs.existsSync(CAPTURE),'Prepare must precede freeze');const inputs=await declarations(),toolchain=descriptor(await toolchainVerification(path.join(ROOT,TOOLCHAIN_FILE))),files=sourceRows();
  const base=path.join(PREP,'attempts');fs.mkdirSync(base,{recursive:true});const prior=fs.readdirSync(base).sort();assert(prior.every(s=>/^\d{3}$/.test(s)));const attempt=n(prior.length);const dir=path.join(base,attempt);fs.mkdirSync(dir);
  const plan={schemaVersion:1,createdAt:new Date().toISOString(),runtimePath:ROOT,inputBase:PREP,node:nodeIdentity(),toolchain,limits:LIMITS,files,inputs};save(path.join(dir,'plan.json'),plan);
  const writer=createWriteLedger(dir),result=await executeMatrix(plan,writer,true);result.executionInvoked=false;result.allPrepared=result.evidenceUsable&&result.rows.every(r=>r.status==='prepared');
  const reportSha256=writer.save('report.json',result);writer.seal();
  return{attempt,reportSha256,allPrepared:result.allPrepared,prepared:result.rows.filter(r=>r.status==='prepared').length,expected:16,fatal:result.fatal,executionInvoked:false,toolchain,inputs:inputs.map(({path,id,fork,sha256})=>({path,id,fork,sha256}))};}
export async function freeze(){assert(!fs.existsSync(CAPTURE),'Never reuse a partial capture');const attempts=fs.readdirSync(path.join(PREP,'attempts')).sort();assert(attempts.length);const dir=path.join(PREP,'attempts',attempts.at(-1)),prepPlan=json(path.join(dir,'plan.json')),report=json(path.join(dir,'report.json')),manifest=json(path.join(dir,'manifest.json'));
  assert.deepEqual(walk(dir),[...manifest.files.map(r=>r.path),'manifest.json'].sort());checkRows(dir,manifest.files);assert.equal(report.allPrepared,true);assert.equal(report.executionInvoked,false);await assertIdentity(prepPlan,true);
  const files=sourceRows();copyRows(ROOT,path.join(CAPTURE,'runtime'),files);
  copyRows(PREP,CAPTURE,[...prepPlan.inputs.map(({id,fork,...r})=>r),entry(PREP,'toolchain.json')]);copyRows(dir,path.join(CAPTURE,'preparation'),walk(dir).map(p=>entry(dir,p)));
  const plan={...prepPlan,createdAt:new Date().toISOString(),sourceRoot:ROOT,capturePath:CAPTURE,runtimePath:path.join(CAPTURE,'runtime'),inputBase:CAPTURE,preparationManifestSha256:sha(read(path.join(dir,'manifest.json')))};
  const planSha256=save(path.join(CAPTURE,'plan.json'),plan);await assertIdentity(plan);return{planSha256,inputs:8,files:files.length,executionInvoked:false};}
export async function run(pin,flag){assert.equal(flag,'--execute-frozen-targets','Execution requires the explicit flag');assert.match(pin,/^[0-9a-f]{64}$/);assert.equal(sha(read(path.join(CAPTURE,'plan.json'))),pin);const plan=json(path.join(CAPTURE,'plan.json'));
  assert.deepEqual(plan.limits,LIMITS);await assertIdentity(plan);assert(!fs.existsSync(path.join(CAPTURE,'STARTED.json')),'Never retry a capture');
  const initial=walk(CAPTURE);assert.deepEqual(initial,[...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'plan.json','toolchain.json',...walk(path.join(CAPTURE,'preparation')).map(p=>'preparation/'+p)].sort());
  const writer=createWriteLedger(CAPTURE);writer.save('STARTED.json',{planSha256:pin,at:new Date().toISOString(),executionFlag:flag});
  const result={planSha256:pin,...await executeMatrix(plan,writer,false)};writer.save('results.json',result);
  const manifestSha256=writer.seal({planSha256:pin});
  return{manifestSha256,evidenceUsable:result.evidenceUsable,fatal:result.fatal,counts:Object.fromEntries(['observed','unavailable','not_attempted'].map(s=>[s,result.rows.filter(r=>r.status===s).length]))};}
export async function compare(planPin,manifestPin){assert.match(planPin,/^[0-9a-f]{64}$/);assert.match(manifestPin,/^[0-9a-f]{64}$/);assert.equal(sha(read(path.join(CAPTURE,'plan.json'))),planPin);assert.equal(sha(read(path.join(CAPTURE,'manifest.json'))),manifestPin);
  const plan=json(path.join(CAPTURE,'plan.json')),manifest=json(path.join(CAPTURE,'manifest.json')),results=json(path.join(CAPTURE,'results.json'));
  assert.equal(manifest.planSha256,planPin);assert.equal(results.planSha256,planPin);assert.deepEqual(plan.limits,LIMITS);await assertIdentity(plan);assert.deepEqual(walk(CAPTURE),[...manifest.files.map(r=>r.path),'manifest.json'].sort());checkRows(CAPTURE,manifest.files);
  const preexisting=new Set([...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'plan.json','toolchain.json',...walk(path.join(CAPTURE,'preparation')).map(p=>'preparation/'+p)]);
  const ledger=json(path.join(CAPTURE,'write-ledger.json'));assert.equal(ledger.schemaVersion,1);
  assert.deepEqual(ledger.files,manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:preexisting.has(r.path)?'preexisting':'written'})),'Original-write ledger differs from final inventory');
  assert.deepEqual(results.rows.map(r=>[r.index,r.kind]),Array.from({length:8},(_,i)=>['product','eels'].map(k=>[i,k])).flat());
  assert.equal(results.evidenceUsable,results.fatal===null&&results.sourceUnchanged&&results.elapsed.reversed===false&&finite(results.elapsed.wallMs,LIMITS.totalMs)&&finite(results.elapsed.monotonicMs,LIMITS.totalMs)&&finite(results.totalBytes,LIMITS.totalBytes));
  const {productObservation,eelsObservation,comparePair,CHANNELS}=await import(pathToFileURL(path.join(plan.runtimePath,PREFIX,'observations.mjs')).href);const rows=[];let totalBytes=0;
  for(let i=0;i<8;i++){const input=json(path.join(CAPTURE,plan.inputs[i].path)),row={index:i,id:input.id,fork:input.fork,product:null,eels:null,errors:{}};
    for(const kind of['product','eels']){const result=results.rows[i*2+(kind==='eels'?1:0)];assert.equal(result.id,input.id);if(result.process===null){assert.equal(result.status,'not_attempted');continue;}
      const stem=n(i)+'-'+kind;assert.equal(result.process,stem+'-process.json');const p=json(path.join(CAPTURE,result.process)),seal=json(path.join(CAPTURE,stem+'-seal.json'));
      assert.equal(seal.processSha256,sha(read(path.join(CAPTURE,result.process))));assert.deepEqual(seal.stdout,p.stdout);assert.deepEqual(seal.stderr,p.stderr);
      const stdout=read(path.join(CAPTURE,stem+'.stdout')),stderr=read(path.join(CAPTURE,stem+'.stderr'));totalBytes+=stdout.length+stderr.length;
      const validated=validateRecordedProcess({plan,index:i,kind,record:p,stdout,stderr});assert.equal(validated.status,result.status);if(results.evidenceUsable)assert(validated.bounded,'Unbounded process cannot produce usable observations');
      if(validated.status==='observed'&&results.evidenceUsable)try{row[kind]=await(kind==='product'?productObservation:eelsObservation)(input,validated.report);}catch(e){row.errors[kind]={name:e.name,message:e.message};}
    }row.comparison=comparePair(row.product,row.eels);rows.push(row);}
  assert.equal(totalBytes,results.totalBytes);const all=rows.flatMap(r=>Object.values(r.comparison));
  return{kind:'saved_historical_creation_and_rollback_comparison',planSha256:planPin,manifestSha256:manifestPin,evidenceUsable:results.evidenceUsable,channels:CHANNELS,rows,
    counts:{matchedCases:rows.filter(r=>Object.values(r.comparison).every(v=>v===true)).length,mismatchedCases:rows.filter(r=>Object.values(r.comparison).includes(false)).length,unavailableCases:rows.filter(r=>Object.values(r.comparison).includes(null)&&!Object.values(r.comparison).includes(false)).length,partialCases:rows.filter(r=>Object.values(r.comparison).includes(null)&&Object.values(r.comparison).includes(true)&&!Object.values(r.comparison).includes(false)).length,matchedChannels:all.filter(v=>v===true).length,mismatchedChannels:all.filter(v=>v===false).length,unavailableChannels:all.filter(v=>v===null).length}};}
if(process.argv[1]===fileURLToPath(import.meta.url)){const action=process.argv[2];assert(['prepare','freeze','run','compare'].includes(action));assert.equal(process.argv.length,action==='run'||action==='compare'?5:3);
  const result=action==='prepare'?await prepare():action==='freeze'?await freeze():action==='run'?await run(process.argv[3],process.argv[4]):await compare(process.argv[3],process.argv[4]);console.log(JSON.stringify(result,null,2));if(action==='prepare'&&!result.allPrepared)process.exitCode=1;}
