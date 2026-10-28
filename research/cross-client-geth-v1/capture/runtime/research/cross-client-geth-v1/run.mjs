import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectNodeRuntime, verifyNodeRuntime } from '../standard-evm/cohort-freeze.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const relative = 'research/cross-client-geth-v1';
export const LIMITS = Object.freeze({ cases:48, perCaseMs:5000, closeGraceMs:1000, totalMs:360000, outputBytes:1048576 });
export const COMMIT = '1df30b18d9ed35ee9d28ffd4648442c2204554ad';
const TREE = 'cc329acc8f69375efe7e3cbba00e1acb1e2d373f';
const GO_SHA = 'dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2';
const TOOLCHAIN_SHA = '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333';
const SEMANTICS = ['cmd/evm/staterunner.go','cmd/evm/reporter.go','tests/state_test_util.go'];
const SCOPE = Object.freeze({officialRootAndInternalLogHash:true,receiptGasReturnComparison:false,productAccuracy:false,publicRequests:0,retries:0,replacements:0,independentOpcodeImplementation:true,portableToolchainArchive:false});
const SETS = [
  { directory:'evm-conformance', count:32, sha256:'57b378c58049f1c91e4ec57c1f5f11e9d5856bbf5f31c93ceedb988784eefe82' },
  { directory:'evm-lifecycle-conformance-v1', count:16, sha256:'c801066845304423c82b15ea8de07f991f40b5a1749b3f9b82aa8a337dcd7de5' },
];
const HASH = /^0x[0-9a-f]{64}$/;
export const sha = value => createHash('sha256').update(value).digest('hex');
const json = p => JSON.parse(fs.readFileSync(p));
export function inside(base, relativePath) {
  assert(typeof relativePath==='string' && relativePath.length>0 && !path.isAbsolute(relativePath));
  assert.equal(path.posix.normalize(relativePath),relativePath);assert(!relativePath.split('/').some(p=>p==='..'||p==='.'||p===''));
  const resolved=path.resolve(base,relativePath);assert(resolved.startsWith(path.resolve(base)+path.sep));return resolved;
}
export function fixturePost(fixture,item) {
  assert.equal(item.fork,'Osaka');assert.equal(item.postIndex,0);
  assert.equal(fixture._info.hash,item.fixtureHash);assert.equal(fixture.config.chainid,'0x01');
  assert.deepEqual(Object.keys(fixture.post),['Osaka']);assert.equal(fixture.post.Osaka.length,1);
  const post=fixture.post.Osaka[0];assert(!Object.hasOwn(post,'expectException'));assert.match(post.hash,HASH);assert.match(post.logs,HASH);return post;
}
function verifyTool(toolBytes) {
  assert.equal(sha(toolBytes),TOOLCHAIN_SHA);const tool=JSON.parse(toolBytes);
  assert.equal(tool.source.commit,COMMIT);assert.equal(tool.source.tree,TREE);assert.equal(tool.go.archiveSha256,GO_SHA);assert.equal(tool.go.archiveBytes,68196737);
  assert.deepEqual(file(tool.binary.path),{sha256:tool.binary.sha256,bytes:tool.binary.bytes});return tool;
}
function file(p) { const s=fs.lstatSync(p); assert(s.isFile() && !s.isSymbolicLink() && s.size <= 256*1024*1024); const b=fs.readFileSync(p); return {bytes:b.length,sha256:sha(b)}; }
function write(p,value) {
  const b=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  assert(b.length<=16*1024*1024); fs.mkdirSync(path.dirname(p),{recursive:true});
  const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const d=fs.openSync(path.dirname(p),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  return {bytes:b.length,sha256:sha(b)};
}
function walk(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert(e.isDirectory()||e.isFile());const p=path.join(dir,e.name);return e.isDirectory()?walk(p):[p];}).sort(); }
export function exactPattern(id) { assert(typeof id==='string'&&id.length>0&&id.length<4096); return '^'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'; }
export function adjudicate(raw, expected) {
  if(raw.reason || raw.exitCode!==0 || raw.signal!==null || raw.processClosed===false) return {status:'unavailable',reason:raw.reason??'process_failure'};
  try {
    const rows=JSON.parse(raw.stdout); assert(Array.isArray(rows)&&rows.length===1);
    const r=rows[0]; assert(r&&typeof r==='object'&&!Array.isArray(r));
    assert(Object.keys(r).every(k=>['name','fork','pass','stateRoot','error'].includes(k)));
    assert.equal(r.name,expected.id);assert.equal(r.fork,'Osaka');assert.equal(typeof r.pass,'boolean');
    if(r.error!==undefined)assert(typeof r.error==='string'&&r.error.length>0&&r.pass===false);
    if(r.stateRoot!==undefined)assert.match(r.stateRoot,HASH);
    if(r.pass) { assert.equal(r.error,undefined);assert.match(r.stateRoot,HASH); }
    if(!r.stateRoot)return {status:'unavailable',reason:'fixture_execution_did_not_produce_state',result:r};
    return {status:r.pass&&r.stateRoot===expected.stateRoot?'matched':'mismatched',result:r,
      checks:{reportedPass:r.pass,stateRoot:r.stateRoot===expected.stateRoot,logHashCheckedByGeth:r.pass},
      scope:'Official full state root plus pinned Geth internal log-hash assertion; receipt/gas/return not checked.'};
  } catch { return {status:'unavailable',reason:'invalid_or_foreign_result'}; }
}
export async function dispatch({binary,input,id,timeoutMs=LIMITS.perCaseMs,closeGraceMs=LIMITS.closeGraceMs,spawnImpl=spawn}) {
  assert(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=LIMITS.perCaseMs);
  assert(Number.isFinite(closeGraceMs)&&closeGraceMs>0&&closeGraceMs<=LIMITS.closeGraceMs);
  const args=['statetest','--statetest.fork=Osaka','--run='+exactPattern(id),input];
  return await new Promise(resolve=>{
    let child,reason=null,bytes=0,done=false,timer,grace;const stdout=[],stderr=[],started=performance.now();
    const finish=(exitCode,signal,processClosed)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);
      const durationMs=performance.now()-started;if(durationMs>timeoutMs)reason??='case_deadline';
      const streams={};for(const [name,chunks]of [['stdout',stdout],['stderr',stderr]]){const buffer=Buffer.concat(chunks);streams[name+'Raw']={base64:buffer.toString('base64'),bytes:buffer.length,sha256:sha(buffer)};try{streams[name]=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{streams[name]=null;reason??='invalid_utf8';}}
      resolve({args,reason,exitCode,signal,processClosed,...streams,observedBytes:bytes,durationMs});
    };
    try{child=spawnImpl(binary,args,{cwd:path.dirname(input),env:{PATH:'/usr/bin:/bin',GOMAXPROCS:'2',GOMEMLIMIT:'256MiB'},stdio:['ignore','pipe','pipe']});}
    catch{reason='spawn_failure';finish(null,null,true);return;}
    const stop=why=>{if(done)return;reason??=why;try{child.kill('SIGKILL');}catch{reason='kill_failure';}if(done)return;grace??=setTimeout(()=>{child.stdout.destroy?.();child.stderr.destroy?.();child.unref?.();finish(null,null,false);},closeGraceMs);};
    timer=setTimeout(()=>stop('case_deadline'),timeoutMs);
    for(const [name,chunks] of [['stdout',stdout],['stderr',stderr]])child[name].on('data',chunk=>{
      if(done)return;bytes+=chunk.length;if(bytes>LIMITS.outputBytes){stop('output_limit');return;}chunks.push(Buffer.from(chunk));
    });
    child.once('error',()=>stop('spawn_failure'));
    child.once('close',(exitCode,signal)=>finish(exitCode,signal,true));
  });
}
export async function freeze(capture,toolchainManifest) {
  assert(!fs.existsSync(capture));const toolBytes=fs.readFileSync(toolchainManifest),tool=verifyTool(toolBytes);
  fs.mkdirSync(capture);const inputs=[],sources=[],cases=[];
  const save=(p,b,rows)=>{const r=write(path.join(capture,p),b);rows.push({path:p,...r});return r;};
  save('toolchain-manifest.json',toolBytes,inputs);
  for(const p of [relative+'/PLAN.md',relative+'/run.mjs',relative+'/run.test.mjs','research/standard-evm/cohort-freeze.mjs'])save('runtime/'+p,fs.readFileSync(path.join(root,p)),sources);
  for(const p of SEMANTICS) {
    const checkout=path.join(path.dirname(toolchainManifest),'source',p);
    const bound=tool.source.interpretationSources.find(r=>r.path==='source/'+p);assert(bound);assert.deepEqual(file(checkout),{bytes:bound.bytes,sha256:bound.sha256});
    save('geth-semantics/'+p,fs.readFileSync(checkout),inputs);
  }
  for(const set of SETS){
    const base=path.join(root,'research',set.directory),selectionBytes=fs.readFileSync(path.join(base,'selection.json'));assert.equal(sha(selectionBytes),set.sha256);
    const selection=JSON.parse(selectionBytes);assert.equal(selection.selected.length,set.count);save('inputs/'+set.directory+'/selection.json',selectionBytes,inputs);
    const copied=new Set();
    for(const item of selection.selected){
      const bytes=fs.readFileSync(inside(base,item.file));assert.equal(sha(bytes),item.fileSha256);
      if(!copied.has(item.file)){save('inputs/'+set.directory+'/'+item.file,bytes,inputs);copied.add(item.file);}
      const fixture=JSON.parse(bytes)[item.id],post=fixturePost(fixture,item);
      const index=cases.length+1,p='cases/'+String(index).padStart(3,'0')+'.json',saved=save(p,{[item.id]:fixture},inputs);
      cases.push({index,id:item.id,source:set.directory,sourcePath:item.file,sourceSha256:item.fileSha256,fixtureHash:item.fixtureHash,path:p,...saved,stateRoot:post.hash,logsHash:post.logs});
    }
  }
  assert.equal(cases.length,48);assert.equal(new Set(cases.map(c=>c.id)).size,48);
  const plan={schemaVersion:1,createdAt:new Date().toISOString(),limits:LIMITS,node:await inspectNodeRuntime(),binary:tool.binary,toolchainManifestSha256:sha(toolBytes),sourceCommit:COMMIT,sources,inputs,cases,
    scope:SCOPE};
  const saved=write(path.join(capture,'plan.json'),plan);write(path.join(capture,'FROZEN.json'),{planSha256:saved.sha256});await verify(capture,saved.sha256);return {planSha256:saved.sha256,cases:48};
}
export async function verify(capture,expectedPlanSha256) {
  assert(typeof expectedPlanSha256==='string'&&/^[0-9a-f]{64}$/.test(expectedPlanSha256),'Explicit external plan hash required');
  const raw=fs.readFileSync(path.join(capture,'plan.json')),plan=JSON.parse(raw),planSha256=sha(raw);assert.equal(planSha256,expectedPlanSha256);assert.equal(json(path.join(capture,'FROZEN.json')).planSha256,planSha256);
  assert.equal(plan.sourceCommit,COMMIT);assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.scope,SCOPE);assert.equal(plan.cases.length,48);assert.deepEqual(plan.cases.map(c=>c.index),Array.from({length:48},(_,i)=>i+1));assert.equal(new Set(plan.cases.map(c=>c.id)).size,48);
  assert.equal(new Set([...plan.sources,...plan.inputs].map(r=>r.path)).size,plan.sources.length+plan.inputs.length);
  for(const r of [...plan.sources,...plan.inputs])assert.deepEqual(file(inside(capture,r.path)),{bytes:r.bytes,sha256:r.sha256});
  assert.deepEqual(walk(path.join(capture,'runtime')).map(p=>path.relative(capture,p)),plan.sources.map(s=>s.path).sort());
  const toolBytes=fs.readFileSync(path.join(capture,'toolchain-manifest.json')),tool=verifyTool(toolBytes);assert.equal(sha(toolBytes),plan.toolchainManifestSha256);assert.deepEqual(plan.binary,tool.binary);
  for(const p of SEMANTICS){const bound=tool.source.interpretationSources.find(r=>r.path==='source/'+p);assert.deepEqual(file(path.join(capture,'geth-semantics',p)),{bytes:bound.bytes,sha256:bound.sha256});}
  await verifyNodeRuntime(plan.node);
  const expected=[];
  for(const set of SETS){const bytes=fs.readFileSync(path.join(capture,'inputs',set.directory,'selection.json'));assert.equal(sha(bytes),set.sha256);const selection=JSON.parse(bytes);assert.equal(selection.selected.length,set.count);for(const item of selection.selected)expected.push({set,item});}
  for(const [i,c] of plan.cases.entries()){
    const {set,item}=expected[i];assert.equal(c.id,item.id);assert.equal(c.source,set.directory);assert.equal(c.sourcePath,item.file);assert.equal(c.sourceSha256,item.fileSha256);assert.equal(c.fixtureHash,item.fixtureHash);assert.equal(c.path,'cases/'+String(i+1).padStart(3,'0')+'.json');
    assert.deepEqual(file(path.join(capture,c.path)),{bytes:c.bytes,sha256:c.sha256});const wrapper=json(path.join(capture,c.path));assert.deepEqual(Object.keys(wrapper),[c.id]);
    const sourceFile=inside(path.join(capture,'inputs',c.source),c.sourcePath),source=json(sourceFile);assert.deepEqual(wrapper[c.id],source[c.id]);assert.equal(file(sourceFile).sha256,c.sourceSha256);
    const post=fixturePost(wrapper[c.id],item);assert.equal(post.hash,c.stateRoot);assert.equal(post.logs,c.logsHash);
  }
  return {plan,planSha256};
}
export async function run(capture,expectedPlanSha256) {
  assert.equal(fs.realpathSync(here),fs.realpathSync(path.join(capture,'runtime',relative)),'Use the frozen entrypoint');
  const {plan,planSha256}=await verify(capture,expectedPlanSha256);write(path.join(capture,'STARTED.json'),{planSha256,startedAt:new Date().toISOString()});
  const started=performance.now(),rows=[];let fatal=null;
  for(const c of plan.cases){
    const remaining=LIMITS.totalMs-(performance.now()-started);
    if(fatal||remaining<=0){rows.push({index:c.index,id:c.id,status:'not_attempted',reason:fatal??'overall_deadline'});continue;}
    try {
      assert.deepEqual(file(plan.binary.path),{bytes:plan.binary.bytes,sha256:plan.binary.sha256});
      assert.deepEqual(file(path.join(capture,c.path)),{bytes:c.bytes,sha256:c.sha256});
      const dispatchRemaining=LIMITS.totalMs-(performance.now()-started);if(dispatchRemaining<=0){rows.push({index:c.index,id:c.id,status:'not_attempted',reason:'overall_deadline'});continue;}
      const raw=await dispatch({binary:plan.binary.path,input:path.join(capture,c.path),id:c.id,timeoutMs:Math.min(dispatchRemaining,LIMITS.perCaseMs)});
      const observed=adjudicate(raw,c),evidence=write(path.join(capture,'results',String(c.index).padStart(3,'0')+'.json'),{case:c,raw,observed});
      rows.push({index:c.index,id:c.id,...observed,evidenceSha256:evidence.sha256});
      if(!raw.processClosed)fatal='child_close_unconfirmed';
    }catch(error){fatal='integrity_or_artifact_failure';rows.push({index:c.index,id:c.id,status:'unavailable',reason:fatal});write(path.join(capture,'FAILURE.json'),{index:c.index,name:error.name,message:error.message});}
  }
  let unchanged=false;try{await verify(capture,expectedPlanSha256);unchanged=true;}catch(error){fatal??='final_integrity_failure';write(path.join(capture,'INTEGRITY-FAILURE.json'),{name:error.name,message:error.message});}
  const counts={selected:48,matched:0,mismatched:0,unavailable:0,not_attempted:0};for(const row of rows)counts[row.status]++;
  write(path.join(capture,'results.json'),{planSha256,finishedAt:new Date().toISOString(),durationMs:performance.now()-started,counts,rows,unchanged,fatal,valid:unchanged&&fatal===null,scope:plan.scope});
  const files=walk(capture).map(p=>({path:path.relative(capture,p),...file(p)}));const manifest=write(path.join(capture,'manifest.json'),{planSha256,files});return {counts,unchanged,fatal,manifestSha256:manifest.sha256};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const capture=path.join(here,'capture');
  if(process.argv[2]==='--freeze')console.log(JSON.stringify(await freeze(capture,path.resolve(process.argv[3]))));
  else if(process.argv[2]==='--check'){const r=await verify(capture,process.argv[3]);console.log(JSON.stringify({valid:true,planSha256:r.planSha256,cases:r.plan.cases.length}));}
  else if(process.argv[2]==='--run'){await verify(capture,process.argv[3]);const module=await import(pathToFileURL(path.join(capture,'runtime',relative,'run.mjs')));console.log(JSON.stringify(await module.run(capture,process.argv[3])));}
  else throw Error('Use --freeze <toolchain-manifest>, --check <plan-sha> or --run <plan-sha>');
}
