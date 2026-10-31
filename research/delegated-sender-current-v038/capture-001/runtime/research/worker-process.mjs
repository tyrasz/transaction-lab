// Bounded native worker capture shared by research coordinators. No dispatch on import.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {read,json,sha,entry,verifyPacket,safe} from './lending-local-sequence-current-v037/archive.mjs';

export function validateSealedProcess({record,stdout,stderr,invocation,timeoutMs,streamBytes=1048576}) {
 assert.deepEqual({executable:record.executable,args:record.args},invocation);
 assert(Number.isSafeInteger(record.pid)&&record.pid>0);
 assert.equal(record.timeoutMs,timeoutMs);assert.equal(record.status,0);assert.equal(record.signal,null);
 assert.equal(record.closed,true);assert.equal(record.error,null);assert.equal(record.limitFailure,null);assert.equal(record.cleanupSignalAccepted,true);
 assert(Number.isFinite(record.wallMs)&&record.wallMs>=0&&record.wallMs<=timeoutMs);
 assert(Number.isFinite(record.monotonicMs)&&record.monotonicMs>=0&&record.monotonicMs<=timeoutMs);
 for(const [name,bytes]of [['stdout',stdout],['stderr',stderr]]){
  assert(Buffer.isBuffer(bytes)&&bytes.length<=streamBytes);assert.equal(record.observedBytes[name],bytes.length);
  assert.equal(record[name].bytes,bytes.length);assert.equal(record[name].sha256,sha(bytes));
 }
 assert.equal(stderr.length,0);
}

export async function runSealedWorker({executable,args,cwd,outDir,relative,stem,writer,timeoutMs,streamBytes=1048576,beforeSpawn=()=>null}) {
 assert(typeof executable==='string'&&Array.isArray(args)&&args.every(a=>typeof a==='string'));
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&Number.isSafeInteger(streamBytes)&&streamBytes>0&&streamBytes<=1048576);
 safe(relative);safe(stem);fs.mkdirSync(outDir,{recursive:false});
 const call={executable,args},start=Date.now(),mono=performance.now(),buffers={stdout:[],stderr:[]},observed={stdout:0,stderr:0};
 let child,firstTarget=null,limitFailure=null,error=null,cleanupSignalAccepted=false;
 const kill=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');cleanupSignalAccepted=true;}catch(e){if(e.code==='ESRCH')cleanupSignalAccepted=true;else error??={name:e.name,message:e.message};}};
 let timer;const terminal=await new Promise(resolve=>{
  try{firstTarget=beforeSpawn();child=spawn(call.executable,call.args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',LANG:'C',TZ:'UTC'}});}catch(e){error={name:e.name,message:e.message};return resolve({status:null,signal:null,closed:false});}
  timer=setTimeout(()=>{limitFailure='wall_timeout';kill();},timeoutMs);
  for(const k of ['stdout','stderr'])child[k].on('data',chunk=>{const old=observed[k];observed[k]+=chunk.length;const room=Math.max(0,streamBytes-old);if(room)buffers[k].push(chunk.subarray(0,room));if(observed[k]>streamBytes){limitFailure='output_bytes';kill();}});
  child.on('error',e=>{error={name:e.name,message:e.message,code:e.code??null};});child.on('close',(status,signal)=>resolve({status,signal,closed:true}));
 });clearTimeout(timer);kill();
 const stdout=Buffer.concat(buffers.stdout),stderr=Buffer.concat(buffers.stderr),record={...call,pid:child?.pid??null,timeoutMs,wallMs:Date.now()-start,monotonicMs:performance.now()-mono,...terminal,error,limitFailure,cleanupSignalAccepted,observedBytes:observed};
 let report=null,workerManifest=null,workerManifestSha256=null,workerSealed=false;
 try{const summary=JSON.parse(stdout);workerManifestSha256=summary.manifestSha256;workerManifest=verifyPacket(outDir,workerManifestSha256);writer.adopt(relative,[...workerManifest.files,entry(outDir,'manifest.json')].sort((a,b)=>a.path.localeCompare(b.path)));workerSealed=true;report=json(path.join(outDir,'report.json'));}
 catch(e){try{writer.adopt(relative);}catch{}error??={name:e.name,message:e.message};record.error=error;}
 for(const[k,bytes]of[['stdout',stdout],['stderr',stderr]]){writer.write(stem+'.'+k,bytes);record[k]={path:stem+'.'+k,bytes:bytes.length,sha256:sha(bytes)};}
 if(firstTarget!==null)record.firstTarget=firstTarget;
 const processPath=stem+'-process.json',sealPath=stem+'-seal.json',processSha256=writer.save(processPath,record);
 writer.save(sealPath,{processSha256,workerManifestSha256,workerSealed,stdout:record.stdout,stderr:record.stderr});
 let boundedProcess=false;try{assert(workerSealed);validateSealedProcess({record,stdout,stderr,invocation:call,timeoutMs,streamBytes});boundedProcess=true;}catch{}
 return{record,stdout,stderr,report,workerManifest,workerManifestSha256,workerSealed,processPath,sealPath,boundedProcess};
}
