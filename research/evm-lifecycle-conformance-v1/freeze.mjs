import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash}from'node:crypto';
import{fileURLToPath}from'node:url';
import{buildSelection}from'./select.mjs';
const base=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(base,'../..'),engine=path.join(root,'engines/fixture-evm'),archive=path.join(base,'source');
const hash=b=>createHash('sha256').update(b).digest('hex');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);assert(!e.isSymbolicLink());assert(e.isFile()||e.isDirectory());return e.isDirectory()?walk(p):[p];}).sort();
const selection=fs.readFileSync(path.join(base,'selection.json')),selected=JSON.parse(selection);
assert.deepEqual(selected,buildSelection());assert(!fs.existsSync(path.join(base,'STARTED.json')));assert(!fs.existsSync(archive));
// Keep the reviewed signed adapter/worker byte-identical to the earlier packet.
const priorPlan=JSON.parse(fs.readFileSync(path.join(root,'research/evm-conformance/frozen-plan.json')));
for(const file of ['engines/fixture-evm/state-test.js','engines/fixture-evm/worker.mjs'])assert.equal(hash(fs.readFileSync(path.join(root,file))),priorPlan.sourceFiles.find(r=>r.path===file).sha256);
fs.mkdirSync(archive);const sources=[],originals=new Map();
function copy(file,rel){const raw=fs.readFileSync(file),mode=fs.statSync(file).mode&0o777,dest=path.join(archive,rel);assert(!originals.has(rel));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,raw,{flag:'wx',mode});assert.equal(hash(fs.readFileSync(dest)),hash(raw));assert.equal(hash(fs.readFileSync(file)),hash(raw));sources.push({path:rel,bytes:raw.length,sha256:hash(raw),mode});originals.set(rel,file);}
for(const f of walk(engine))copy(f,'engines/fixture-evm/'+path.relative(engine,f));
for(const f of ['run.mjs','freeze.mjs','select.mjs','selection.json','proposal.json','prepare.py','PREPARATION_STARTED.json','preparation.json','harness.test.mjs','PLAN.md'])copy(path.join(base,f),'harness/'+f);
for(const f of [...new Set(selected.selected.map(r=>r.file))].sort())copy(path.join(base,f),'fixtures/'+f);
for(const r of sources)assert.equal(hash(fs.readFileSync(originals.get(r.path))),r.sha256,'Source changed during freeze');
sources.sort((a,b)=>a.path.localeCompare(b.path));
const plan={schemaVersion:1,createdAt:new Date().toISOString(),purpose:selected.purpose,release:selected.release,releaseCommit:selected.releaseCommit,assetSha256:selected.assetSha256,proposalSha256:selected.proposalSha256,selectionSha256:hash(selection),vectorCount:16,limits:selected.limits,node:{version:process.version,execPath:process.execPath,sha256:hash(fs.readFileSync(process.execPath))},sourceFiles:sources,sourceInventorySha256:hash(Buffer.from(JSON.stringify(sources)))};
fs.writeFileSync(path.join(base,'frozen-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({files:sources.length,bytes:sources.reduce((s,r)=>s+r.bytes,0),selectionSha256:plan.selectionSha256,planSha256:hash(fs.readFileSync(path.join(base,'frozen-plan.json')))}));
