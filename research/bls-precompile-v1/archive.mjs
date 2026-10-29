import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {PREFIX,FILES,LIMITS,sha,jsonBytes,declaredRows} from './cases.mjs';

export const INPUT_PLAN_SHA='b1f6b97fad0c2ed14b182d440d7283fd3efaadc70dcfb553c1491e9d24255095';
export const readJson=p=>JSON.parse(fs.readFileSync(p));
export function save(p,value){const b=Buffer.isBuffer(value)?value:jsonBytes(value);fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{bytes:b.length,sha256:sha(b)};}
export function walk(root,sub=''){const out=[];for(const e of fs.readdirSync(path.join(root,sub),{withFileTypes:true})){const p=sub?sub+'/'+e.name:e.name;if(e.isDirectory())out.push(...walk(root,p));else{assert(e.isFile()||e.isSymbolicLink());out.push(p);}assert(out.length<=10000);}return out.sort();}
export function entry(root,p){assert(p&&!path.isAbsolute(p)&&!p.split('/').includes('..')&&!p.includes('\\'));const f=path.join(root,p),s=fs.lstatSync(f);
 if(s.isSymbolicLink()){const target=fs.readlinkSync(f),resolved=path.posix.normalize(path.posix.join(path.posix.dirname(p),target));assert(!path.isAbsolute(target)&&resolved.startsWith('engines/local-evm/node_modules/')&&fs.lstatSync(path.join(root,resolved)).isFile());return{path:p,kind:'symlink',target};}
 assert(s.isFile()&&s.size<=16*1024*1024);const b=fs.readFileSync(f);return{path:p,kind:'file',bytes:b.length,sha256:sha(b),mode:s.mode&0o777};}
export function nodeIdentity(){const executable=fs.realpathSync(process.execPath);return{executable,version:process.version,platform:process.platform,arch:process.arch,sha256:sha(fs.readFileSync(executable))};}
export function loadRows(root){const base=path.join(root,PREFIX,'inputs'),b=fs.readFileSync(path.join(base,'plan.json'));assert.equal(sha(b),INPUT_PLAN_SHA);const plan=JSON.parse(b),provBytes=fs.readFileSync(path.join(base,'provenance.json')),prov=JSON.parse(provBytes);assert.equal(sha(provBytes),plan.provenanceSha256);
 for(const f of prov.files){const b=fs.readFileSync(path.join(base,'upstream',f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
 const rows=declaredRows(Object.fromEntries(FILES.map(f=>[f,fs.readFileSync(path.join(base,'upstream/core/vm/testdata/precompiles',f))])));assert.deepEqual(rows.map(({data,...r})=>r),plan.rows);assert.deepEqual(plan.limits,LIMITS);return rows;}
export function sourcePaths(root){const out=['package.json','engines/evm-context.js'];
 for(const e of fs.readdirSync(path.join(root,'engines/local-evm'),{withFileTypes:true}))if(e.isFile()&&(e.name.endsWith('.js')||['package.json','package-lock.json'].includes(e.name)))out.push('engines/local-evm/'+e.name);
 out.push(...walk(root,'engines/local-evm/node_modules'),...walk(root,'engines/local-evm/test/fixtures/kzg-point-evaluation'));
 for(const n of ['cases.mjs','prepare.mjs','archive.mjs','worker.mjs','run.mjs','run.test.mjs','PLAN.md'])out.push(PREFIX+'/'+n);
 out.push(...walk(root,PREFIX+'/inputs'));if(fs.existsSync(path.join(root,PREFIX,'history')))out.push(...walk(root,PREFIX+'/history'));return [...new Set(out)].sort();}
export function freeze(root,capture){assert(!fs.existsSync(capture),'No reuse or overwrite of a partial capture');loadRows(root);const paths=sourcePaths(root),files=paths.map(p=>entry(root,p));assert(files.reduce((s,f)=>s+(f.bytes??0),0)<=64*1024*1024);const node=nodeIdentity();
 const git={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),status:execFileSync('git',['status','--porcelain','--','engines/local-evm','engines/evm-context.js','package.json'],{cwd:root,encoding:'utf8'})};
 const runtime=path.join(capture,'runtime');fs.mkdirSync(runtime,{recursive:true});for(const f of files){const dest=path.join(runtime,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});if(f.kind==='symlink')fs.symlinkSync(f.target,dest);else{fs.writeFileSync(dest,fs.readFileSync(path.join(root,f.path)),{flag:'wx',mode:f.mode});fs.chmodSync(dest,f.mode);}}
 assert.deepEqual(paths.map(p=>entry(runtime,p)),files);assert.deepEqual(sourcePaths(root),paths);assert.deepEqual(paths.map(p=>entry(root,p)),files);assert.deepEqual(nodeIdentity(),node);
 const source=save(path.join(capture,'source-manifest.json'),{schemaVersion:1,sourceRoot:root,git,node,files});
 const priorPath=path.join(runtime,PREFIX,'history/prior-attempt.json');
 const plan={schemaVersion:1,createdAt:new Date().toISOString(),inputPlanSha256:INPUT_PLAN_SHA,sourceManifestSha256:source.sha256,...(fs.existsSync(priorPath)?{priorAttempt:readJson(priorPath)}:{}),limits:LIMITS,rows:loadRows(runtime).map(r=>({id:r.id,status:r.status,reasons:r.reasons})),scope:readJson(path.join(runtime,PREFIX,'inputs/plan.json')).scope};
 const identity=save(path.join(capture,'plan.json'),plan);return{planSha256:identity.sha256,sourceSha256:source.sha256,files:files.length,bytes:files.reduce((s,f)=>s+(f.bytes??0),0)};}
export function check(capture,expected){assert.match(expected,/^[a-f0-9]{64}$/);const b=fs.readFileSync(path.join(capture,'plan.json'));assert.equal(sha(b),expected);const plan=JSON.parse(b);assert.equal(plan.inputPlanSha256,INPUT_PLAN_SHA);assert.deepEqual(plan.limits,LIMITS);const sb=fs.readFileSync(path.join(capture,'source-manifest.json'));assert.equal(sha(sb),plan.sourceManifestSha256);const source=JSON.parse(sb),runtime=path.join(capture,'runtime');assert.deepEqual(walk(runtime),source.files.map(f=>f.path));assert.deepEqual(source.files.map(f=>entry(runtime,f.path)),source.files);assert.deepEqual(nodeIdentity(),source.node);const rows=loadRows(runtime);assert.deepEqual(rows.map(r=>({id:r.id,status:r.status,reasons:r.reasons})),plan.rows);return{plan,source,rows,runtime};}
