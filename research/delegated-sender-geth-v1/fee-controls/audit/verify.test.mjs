import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sha, REL, PINS, parseRaw, classifyGeth, recordedPaths, checkTiming, bindProcess, storageWords } from './checks.mjs';
import { verifyEvidence, verifyInventory } from './verify.mjs';
const capture=path.resolve(import.meta.dirname,'../capture');
const stream=b=>{b=Buffer.from(b);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const expected={name:'fixed',fork:'Osaka',stateRoot:'0x'+'12'.repeat(32)};
const raw=(pass=true)=>({binary:'/old/bin/evm',args:[],processCompletion:'spawnSync_returned_after_child_and_pipes_closed',exitCode:0,signal:null,error:null,timeoutMs:5000,elapsedMs:1,
  stdout:stream(JSON.stringify([{...expected,pass,...(pass?{}:{error:'post state root mismatch: got '+ '0'.repeat(64)})}])),stderr:stream('')});
test('matching displayed root with pass false remains mismatched; exit zero is not a pass',()=>{
  assert.equal(classifyGeth(raw(),expected).status,'matched'); const result=classifyGeth(raw(false),expected);
  assert.equal(result.status,'mismatched'); assert.equal(result.checks.stateRoot,true); assert.equal(result.checks.internalLogHash,false);
  for(const patch of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:5001}])assert.equal(classifyGeth({...raw(),...patch},expected).status,'unavailable');
});
test('raw byte counts, hashes, base64, strict UTF8, closure and exact result identity are checked',()=>{
  for(const mutate of [r=>r.stdout.bytes++,r=>r.stdout.sha256='0'.repeat(64),r=>r.stdout.base64+='!',r=>r.stdout=stream([255]),r=>r.stderr=stream([255]),r=>r.processCompletion='open',r=>r.elapsedMs=NaN,r=>r.timeoutMs=5001,
    r=>r.stdout=stream(JSON.stringify([{...expected,name:'foreign',pass:true}])),r=>r.stdout=stream(JSON.stringify([{...expected,pass:'true'}])),r=>r.stdout=stream(JSON.stringify([{...expected,pass:true,error:'failure'}])),r=>r.stdout=stream(JSON.stringify([{...expected,pass:true,extra:1}]))]){
    const r=raw();mutate(r);assert.throws(()=>classifyGeth(r,expected));
  }
  assert.throws(()=>parseRaw(raw(),{timeout:5000,bytes:1}));
});
test('recorded process paths bind the old capture independently of the present checkout',()=>{
  const plan={sourceRoot:'/old/checkout',captureDirectory:'/old/checkout/'+REL+'/capture'},recorded=recordedPaths(plan);
  assert.equal(recorded.worker,'/old/checkout/'+REL+'/capture/runtime/'+REL+'/worker.mjs');
  const r=raw();r.args=['statetest',recorded.capture+'/input.json'];bindProcess(r,{binary:r.binary,args:r.args});
  assert.throws(()=>bindProcess(r,{binary:r.binary,args:['statetest','/new/checkout/'+REL+'/capture/input.json']}));
  assert.throws(()=>recordedPaths({...plan,captureDirectory:'/new/checkout/'+REL+'/capture'}));assert.throws(()=>recordedPaths({...plan,sourceRoot:'/old/../checkout'}));
});
test('both phase clocks, aggregate terminal time and withheld completion flags are enforced',()=>{
  const base={status:'complete',comparisonsUsable:true,sourceUnchanged:true,fatal:null,elapsedMs:3,phaseTimings:{preparation:{status:'within_budget',clockValid:true,limitMs:360000,wallElapsedMs:1,monotonicElapsedMs:1},geth:{status:'within_budget',clockValid:true,limitMs:120000,wallElapsedMs:1,monotonicElapsedMs:1}}};
  checkTiming(base);for(const mutate of [r=>r.phaseTimings.geth.wallElapsedMs=120001,r=>r.phaseTimings.preparation.monotonicElapsedMs=-1,r=>r.phaseTimings.geth.clockValid=false,r=>r.elapsedMs=Infinity,r=>r.elapsedMs=0,r=>r.comparisonsUsable=false,r=>r.fatal={message:'drift'}]){const r=structuredClone(base);mutate(r);assert.throws(()=>checkTiming(r));}
});
test('initial storage representation requires full 32-byte keys and values',()=>{
  const good={a:{storage:{['0x'+'00'.repeat(32)]:'0x'+'00'.repeat(31)+'07'}}};storageWords(good);
  assert.throws(()=>storageWords({a:{storage:{'0x0':'0x7'}}}));assert.throws(()=>storageWords({a:{storage:{['0x'+'00'.repeat(32)]:'0x7'}}}));
});
test('source inventory rejects changed bytes, missing files and escaping symlinks',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-inventory-'));
  try{fs.mkdirSync(path.join(dir,'runtime'));fs.writeFileSync(path.join(dir,'runtime','one.js'),'x');const mode=fs.statSync(path.join(dir,'runtime','one.js')).mode&0o777,source={files:[{path:'one.js',kind:'file',bytes:1,sha256:sha('x'),mode}]};
    verifyInventory(dir,{files:[]},source);fs.writeFileSync(path.join(dir,'runtime','one.js'),'y');assert.throws(()=>verifyInventory(dir,{files:[]},source));
    fs.unlinkSync(path.join(dir,'runtime','one.js'));assert.throws(()=>verifyInventory(dir,{files:[]},source));fs.symlinkSync('/etc/hosts',path.join(dir,'runtime','one.js'));assert.throws(()=>verifyInventory(dir,{files:[]},source));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('complete sealed packet independently audits to 14/2 without target execution',async()=>{
  const report=await verifyEvidence();assert.deepEqual(report.counts,{matched:14,mismatched:2,unavailable:0,unattempted:0});
  assert.equal(report.rows.length,16);assert.equal(report.rows[6].logAssertionEstablished,false);assert.equal(report.rows[7].logAssertionEstablished,false);
  assert.equal(report.limitations.targetReexecutions,0);assert.equal(report.limitations.gethGasReturnReceiptsCompared,false);
  await assert.rejects(verifyEvidence({expectedManifestSha256:'0'.repeat(64)}));
});
// Copies only immutable captured bytes to a disposable folder. These mutations
// deliberately recompute the outer manifest, testing semantic joins, not just hashes.
test('portable copy rejects resealed counts, process path, expected-root and initial-fact tampering',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-audit-copy-')),copy=path.join(dir,'capture');fs.cpSync(capture,copy,{recursive:true,dereference:false,verbatimSymlinks:true});
  const manifestPath=path.join(copy,'manifest.json'),originalManifest=fs.readFileSync(manifestPath),read=p=>JSON.parse(fs.readFileSync(path.join(copy,p))),write=(p,v)=>fs.writeFileSync(path.join(copy,p),JSON.stringify(v,null,2)+'\n');
  const reseal=()=>{const m=JSON.parse(originalManifest);for(const f of m.files){const b=fs.readFileSync(path.join(copy,f.path));f.bytes=b.length;f.sha256=sha(b);}write('manifest.json',m);return sha(fs.readFileSync(manifestPath));};
  try{
    assert.deepEqual((await verifyEvidence({captureDirectory:copy})).counts,{matched:14,mismatched:2,unavailable:0,unattempted:0});
    for(const [name,mutate] of [
      ['results.json',r=>{r.counts.matched=16;r.counts.mismatched=0;}],
      ['raw/001.json',r=>{r.args[3]='/new/location/input.json';}],
      ['geth-inputs/001.json',r=>{r.effective_prepayment.post.Osaka[0].hash='0x'+'77'.repeat(32);}],
    ]){const p=path.join(copy,name),old=fs.readFileSync(p),r=read(name);mutate(r);write(name,r);await assert.rejects(verifyEvidence({captureDirectory:copy,expectedManifestSha256:reseal()}));fs.writeFileSync(p,old);fs.writeFileSync(manifestPath,originalManifest);}
    const name='results/001-product.json',sealName='results/001-PRODUCT_SEALED.json',r=read(name),address=Object.keys(r.result.attempt.inputs.accounts)[0];
    r.result.attempt.inputs.accounts[address].balance='1';r.raw.stdout=stream(JSON.stringify(r.result)+'\n');write(name,r);
    const seal=read(sealName),b=fs.readFileSync(path.join(copy,name));seal.bytes=b.length;seal.sha256=sha(b);write(sealName,seal);
    await assert.rejects(verifyEvidence({captureDirectory:copy,expectedManifestSha256:reseal()}));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
