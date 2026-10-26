// Reproduce the immutable v1 report without replacing the current engine.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const DIR=new URL('./',import.meta.url),ROOT=new URL('../../',DIR);
const sha=b=>createHash('sha256').update(b).digest('hex');
const report=JSON.parse(await readFile(new URL('reports/local-execution-comparison/results.json',ROOT)));
assert.equal(sha(await readFile(new URL('reports/local-execution-comparison/results.json',ROOT))),'bfc85b6ed1875d028b70e8d59968e645d0c1a2d8025f603cc837513ad2c916fb');
const inventory=JSON.parse(await readFile(new URL('source-inventory.json',DIR)));
assert.deepEqual(inventory,report.provenance.engine);
for(const entry of inventory.files)assert.equal(sha(await readFile(new URL('engine/'+entry.file,DIR))),entry.sha256);
const temp=await mkdtemp(join(tmpdir(),'transaction-lab-v1-reproduction-'));
try{
  await mkdir(join(temp,'engines'),{recursive:true});await cp(new URL('engine/',DIR),join(temp,'engines/local-evm'),{recursive:true});
  await symlink(fileURLToPath(new URL('engines/local-evm/node_modules',ROOT)),join(temp,'engines/local-evm/node_modules'),'dir');
  await mkdir(join(temp,'reports'),{recursive:true});
  for(const name of ['local-execution-state','local-execution-comparison'])await cp(new URL('reports/'+name,ROOT),join(temp,'reports',name),{recursive:true});
  const result=spawnSync(process.execPath,[join(temp,'reports/local-execution-comparison/run.mjs'),'--verify'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||result.error?.message);process.stdout.write(result.stdout);
}finally{await rm(temp,{recursive:true,force:true});}
