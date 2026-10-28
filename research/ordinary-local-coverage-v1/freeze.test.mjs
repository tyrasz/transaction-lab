import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectCoverageSourcePaths, inspectCohortSources } from './freeze.mjs';
const folder='research/ordinary-local-coverage-v1';
function fixture(t){const root=fs.mkdtempSync('/tmp/coverage-source-docs-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'run.mjs'),'// unrelated control');fs.writeFileSync(path.join(dir,'PLAN.md'),'Plan');return{root,dir};}
test('coverage docs remain an exact optional allowlist with unchanged test exclusion',async t=>{
 const {root,dir}=fixture(t);fs.writeFileSync(path.join(dir,'run.test.mjs'),'// excluded control');assert.deepEqual(await inspectCoverageSourcePaths(root),[folder+'/PLAN.md',folder+'/run.mjs']);
 fs.writeFileSync(path.join(dir,'NOTES.md'),'Saved-result notes');assert.deepEqual(await inspectCoverageSourcePaths(root),[folder+'/NOTES.md',folder+'/PLAN.md',folder+'/run.mjs']);
 fs.unlinkSync(path.join(dir,'NOTES.md')); // Also exercises casing on macOS volumes.
 for(const name of ['README.md','notes.md','other.json','nested/NOTES.md','nested/PLAN.md']){const p=path.join(dir,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'unexpected');await assert.rejects(inspectCoverageSourcePaths(root),/Unexpected coverage source file/);fs.unlinkSync(p);}
 fs.writeFileSync(path.join(dir,'NOTES.md'),Buffer.alloc(1024*1024+1));await assert.rejects(inspectCoverageSourcePaths(root),/documentation exceeds/);
 fs.unlinkSync(path.join(dir,'NOTES.md'));fs.symlinkSync('PLAN.md',path.join(dir,'NOTES.md'));await assert.rejects(inspectCoverageSourcePaths(root));
});
test('read-only current coverage inventory hashes notes as source rather than allowing unlisted extras',async()=>{
 const repoRoot=fileURLToPath(new URL('../..',import.meta.url)),m=await inspectCohortSources({repoRoot}),p=folder+'/NOTES.md',raw=fs.readFileSync(path.join(repoRoot,p)),row=m.files.find(r=>r.path===p);
 assert.equal(row.kind,'file');assert.equal(row.bytes,raw.length);assert.equal(row.sha256,createHash('sha256').update(raw).digest('hex'));
});
