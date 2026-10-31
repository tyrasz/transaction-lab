import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createLedger,verifyPacket,json,read} from './lending-local-sequence-current-v037/archive.mjs';
import {runSealedWorker,validateSealedProcess} from './worker-process.mjs';

const archiveUrl=pathToFileURL(fileURLToPath(new URL('./lending-local-sequence-current-v037/archive.mjs',import.meta.url))).href;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'sealed-worker-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,writer:createLedger(root),outDir:path.join(root,'worker')};}
const argsFor=code=>['--input-type=module','-e',code];
function options(f,args,extra={}){return{...f,executable:process.execPath,args,cwd:f.root,relative:'worker',stem:'processes/one',timeoutMs:2000,...extra};}

test('a sealed inert child binds invocation, native PID, sampled dispatch and exact artifacts',async t=>{
 const f=fixture(t),args=argsFor(`import {createLedger} from ${JSON.stringify(archiveUrl)};const w=createLedger(${JSON.stringify(f.outDir)});w.save('report.json',{status:'inert'});console.log(JSON.stringify({manifestSha256:w.seal()}));`);
 let sampled=0;const mark={wallMs:17,monotonicMs:9};
 const r=await runSealedWorker(options(f,args,{beforeSpawn:()=>{sampled++;return mark;}}));
 assert.equal(sampled,1);assert.equal(r.boundedProcess,true);assert.deepEqual(r.report,{status:'inert'});assert.deepEqual(r.record.firstTarget,mark);
 assert.equal(r.record.pid>0,true);verifyPacket(f.outDir,r.workerManifestSha256);f.writer.verify();
 assert.deepEqual(json(path.join(f.root,r.processPath)),r.record);
 const validate=record=>validateSealedProcess({record,stdout:r.stdout,stderr:r.stderr,invocation:{executable:process.execPath,args},timeoutMs:2000});
 validate(r.record);
 for(const mutate of [x=>x.pid=null,x=>x.closed=false,x=>x.args.push('foreign'),x=>x.monotonicMs=2001,x=>x.observedBytes.stdout++,x=>x.cleanupSignalAccepted=false]){
  const copy=structuredClone(r.record);mutate(copy);assert.throws(()=>validate(copy));
 }
 assert.equal(read(path.join(f.root,r.record.stdout.path)).equals(r.stdout),true);
});

test('timeout and overflow retain bounded prefixes and cannot pass as a sealed result',async t=>{
 for(const [code,extra,reason]of [
  ['setInterval(()=>{},1000)',{timeoutMs:80},'wall_timeout'],
  ["process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)",{streamBytes:128},'output_bytes'],
 ]){
  const f=fixture(t),r=await runSealedWorker(options(f,argsFor(code),extra));
  assert.equal(r.boundedProcess,false);assert.equal(r.workerSealed,false);assert.equal(r.record.limitFailure,reason);
  assert.equal(r.record.closed,true);assert.equal(r.record.cleanupSignalAccepted,true);assert(r.stdout.length<=(extra.streamBytes??1048576));f.writer.verify();
 }
});

test('failed pre-dispatch freshness check records no invented child',async t=>{
 const f=fixture(t),r=await runSealedWorker(options(f,argsFor('throw Error("must not execute")'),{beforeSpawn(){throw Error('expired header');}}));
 assert.equal(r.boundedProcess,false);assert.equal(r.record.pid,null);assert.equal(r.record.closed,false);assert.equal(r.record.error.message,'expired header');
 assert.equal(r.record.firstTarget,undefined);assert.equal(r.stdout.length,0);assert.equal(r.stderr.length,0);f.writer.verify();
});
