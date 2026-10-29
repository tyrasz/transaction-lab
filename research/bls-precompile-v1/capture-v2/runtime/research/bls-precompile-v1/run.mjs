import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {PREFIX,FILES,FORKS,LIMITS,sha,compareRow} from './cases.mjs';
import {freeze,check,save,entry,walk} from './archive.mjs';

export function processResult(raw,rows){
 if(raw.error||raw.status!==0||raw.signal!==null)return rows.map(r=>({id:r.id,status:'unavailable',reason:'worker_not_cleanly_completed',channels:null}));
 const text=new TextDecoder('utf-8',{fatal:true}).decode(raw.stdout);assert(text.endsWith('\n'));const records=text.slice(0,-1).split('\n').map(x=>JSON.parse(x));assert.equal(records.length,rows.length);
 return records.map((r,i)=>{assert.equal(r.id,rows[i].id);assert(Number.isFinite(r.elapsedMs)&&r.elapsedMs>=0&&r.elapsedMs<=LIMITS.batchWallMs);return{id:r.id,...compareRow(rows[i],r)};});
}
export function terminalTiming(startWall,startMono,endWall,endMono){const wallMs=endWall-startWall,monotonicMs=endMono-startMono;return{wallMs,monotonicMs,valid:Number.isFinite(wallMs)&&Number.isFinite(monotonicMs)&&wallMs>=0&&monotonicMs>=0&&wallMs<=LIMITS.totalWallMs&&monotonicMs<=LIMITS.totalWallMs};}
export function run(capture,planSha){
 const verified=check(capture,planSha),{rows,runtime,source}=verified;
 assert.equal(fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))),fs.realpathSync(path.join(runtime,PREFIX)),'Execute the exact archived driver');
 assert(!fs.existsSync(path.join(capture,'STARTED.json')),'No target retries or resumed dispatch');
 const ledger=new Map(),record=(rel,value)=>{const identity=save(path.join(capture,rel),value);ledger.set(rel,identity);return identity;};
 const checkLedger=()=>{for(const[rel,id]of ledger){const b=fs.readFileSync(path.join(capture,rel));assert.equal(b.length,id.bytes);assert.equal(sha(b),id.sha256);}};
 const wall=Date.now(),mono=performance.now();record('STARTED.json',{at:new Date(wall).toISOString(),planSha256:planSha,node:source.node});
 const outcomes=new Map(rows.map(r=>[r.id,{id:r.id,status:r.status==='unsupported'?'unsupported':'not_attempted',reason:r.status==='unsupported'?r.reasons:'not_dispatched',channels:null}]));
 let fatal=null,outputBytes=0,batchIndex=0;const batches=[];
 try{
  for(const fork of Object.keys(FORKS))for(const file of FILES){
   const selected=rows.filter(r=>r.fork===fork&&r.file===file&&r.status==='admitted');assert(selected.length>0);
   const elapsed=terminalTiming(wall,mono,Date.now(),performance.now());assert(elapsed.valid,'Global deadline or clock reversal');const remaining=LIMITS.totalWallMs-Math.max(elapsed.wallMs,elapsed.monotonicMs);assert(remaining>1000,'No remaining dispatch budget');
   checkLedger();assert.equal(sha(fs.readFileSync(source.node.executable)),source.node.sha256);
   const worker=PREFIX+'/worker.mjs',bound=source.files.find(f=>f.path===worker);assert.deepEqual(entry(runtime,worker),bound);
   const args=[path.join(runtime,worker),fork,file],timeout=Math.floor(Math.min(LIMITS.batchWallMs,remaining));const started=performance.now();
   for(const r of selected)outcomes.set(r.id,{id:r.id,status:'unavailable',reason:'dispatched_worker_result_not_adjudicated',channels:null});
   const raw=spawnSync(source.node.executable,args,{cwd:runtime,encoding:null,timeout,killSignal:'SIGKILL',maxBuffer:LIMITS.stdoutBytes,env:{PATH:process.env.PATH??'',LANG:'C',TZ:'UTC'}});
   const stdout=raw.stdout??Buffer.alloc(0),stderr=raw.stderr??Buffer.alloc(0);outputBytes+=stdout.length+stderr.length;
   const prefix='batches/'+String(++batchIndex).padStart(3,'0');const outId=record(prefix+'.stdout',stdout),errId=record(prefix+'.stderr',stderr);
   const metadata={fork,file,args,timeoutMs:timeout,elapsedMs:performance.now()-started,status:raw.status,signal:raw.signal,error:raw.error?{code:raw.error.code??null,message:raw.error.message}:null,stdout:outId,stderr:errId};record(prefix+'.process.json',metadata);checkLedger();
   assert(stdout.length<=LIMITS.stdoutBytes&&stderr.length<=LIMITS.stderrBytes&&outputBytes<=LIMITS.totalOutputBytes,'Output budget exceeded; captured bounded terminal buffers retained');
   const decoded=processResult({...raw,stdout:fs.readFileSync(path.join(capture,prefix+'.stdout'))},selected);for(const r of decoded)outcomes.set(r.id,r);batches.push({prefix,...metadata});
   const timing=terminalTiming(wall,mono,Date.now(),performance.now());assert(timing.valid,'Terminal deadline or clock reversal');
   const counts=Object.fromEntries(['matched','mismatched','unavailable'].map(s=>[s,decoded.filter(r=>r.status===s).length]));console.log(JSON.stringify({batch:batchIndex,fork,file,...counts}));
  }
 }catch(error){fatal={name:error?.name??null,message:error?.message??String(error)};}
 let sourceUnchanged=false,artifactsUnchanged=false;try{check(capture,planSha);sourceUnchanged=true;checkLedger();artifactsUnchanged=true;}catch(error){fatal??={name:error?.name??null,message:error?.message??String(error)};}
 const timing=terminalTiming(wall,mono,Date.now(),performance.now());if(!timing.valid)fatal??={name:'TimingError',message:'Terminal deadline or clock reversal'};
 const all=rows.map(r=>outcomes.get(r.id));assert.equal(all.length,1856);const counts=Object.fromEntries(['matched','mismatched','unavailable','unsupported','not_attempted'].map(s=>[s,all.filter(r=>r.status===s).length]));
 const result={schemaVersion:1,planSha256:planSha,inputPlanSha256:verified.plan.inputPlanSha256,sourceManifestSha256:verified.plan.sourceManifestSha256,status:fatal?'interrupted':'complete',comparisonsUsable:fatal===null&&sourceUnchanged&&artifactsUnchanged,sourceUnchanged,artifactsUnchanged,fatal,timing,counts,rows:all,batches,outputBytes,scope:verified.plan.scope};
 record('results.json',result);checkLedger();const files=walk(capture).filter(p=>!p.startsWith('runtime/')&&p!=='manifest.json').map(p=>entry(capture,p));const identity=save(path.join(capture,'manifest.json'),{schemaVersion:1,planSha256:planSha,files});return{...counts,status:result.status,comparisonsUsable:result.comparisonsUsable,manifestSha256:identity.sha256};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),[command,captureArg,pin]=process.argv.slice(2),capture=captureArg?path.resolve(captureArg):path.join(root,PREFIX,'capture');
 if(command==='freeze')console.log(JSON.stringify(freeze(root,capture),null,2));
 else if(command==='check')console.log(JSON.stringify({rows:check(capture,pin).rows.length,verified:true}));
 else if(command==='run')console.log(JSON.stringify(run(capture,pin),null,2));
 else throw Error('Use freeze, check CAPTURE PLAN_SHA, or archived run CAPTURE PLAN_SHA');
}
