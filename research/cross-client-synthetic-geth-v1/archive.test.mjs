import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectHarnessSourcePaths, inspectSources, sha } from './archive.mjs';
const folder='research/cross-client-synthetic-geth-v1';
function fixture(t){const root=fs.mkdtempSync('/tmp/synthetic-source-docs-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'run.mjs'),'// unrelated control');fs.writeFileSync(path.join(dir,'PLAN.md'),'Plan');return{root,dir};}
test('only optional named bounded documentation joins the harness source list',t=>{
 const {root,dir}=fixture(t);assert.deepEqual(inspectHarnessSourcePaths(root),[folder+'/PLAN.md',folder+'/run.mjs']);
 fs.writeFileSync(path.join(dir,'NOTES.md'),'Saved-result notes');assert.deepEqual(inspectHarnessSourcePaths(root),[folder+'/NOTES.md',folder+'/PLAN.md',folder+'/run.mjs']);
 fs.unlinkSync(path.join(dir,'NOTES.md')); // Also exercises casing on macOS volumes.
 for(const name of ['README.md','notes.md','other.json']){fs.writeFileSync(path.join(dir,name),'unexpected');assert.throws(()=>inspectHarnessSourcePaths(root),/Unexpected harness source/);fs.unlinkSync(path.join(dir,name));}
 fs.writeFileSync(path.join(dir,'NOTES.md'),Buffer.alloc(1024*1024+1));assert.throws(()=>inspectHarnessSourcePaths(root),/documentation exceeds/);
 fs.unlinkSync(path.join(dir,'NOTES.md'));fs.symlinkSync('PLAN.md',path.join(dir,'NOTES.md'));assert.throws(()=>inspectHarnessSourcePaths(root),/Linked artifact/);
});
test('read-only current inventory binds exact notes bytes without changing historical capture contents',async()=>{
 const root=fileURLToPath(new URL('../..',import.meta.url)),m=await inspectSources(root),p=folder+'/NOTES.md',raw=fs.readFileSync(path.join(root,p)),row=m.files.find(r=>r.path===p);
 assert.equal(row.kind,'file');assert.equal(row.bytes,raw.length);assert.equal(row.sha256,sha(raw));
});
