import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,unlinkSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactWriter,sealEvidence } from './artifacts.mjs';
const temp=t=>{const dir=mkdtempSync('/tmp/cohort-ledger-');t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('ledger binds initial plan and every durable write before the final evidence seal',t=>{
  const dir=temp(t);writeFileSync(join(dir,'plan.json'),'{}\n');const writer=createArtifactWriter(dir);
  writer.write('cases/001/local.json',{answer:42});const before=writer.verify('cases/001/local.json');writer.write('results.json',{status:'complete'});writer.sealLedger();
  const ledger=JSON.parse(readFileSync(join(dir,'write-ledger.json')));assert.equal(ledger.files.find(r=>r.path==='plan.json').origin,'preexisting');assert.deepEqual(ledger.files.find(r=>r.path===before.path),{...before,origin:'written'});
  sealEvidence(dir,'a'.repeat(64),'b'.repeat(64),{writer});assert.equal(writer.verifyAll(),true);
  const manifest=JSON.parse(readFileSync(join(dir,'evidence-manifest.json')));assert.deepEqual(ledger.files.map(({origin,...entry})=>entry),manifest.files.filter(r=>r.path!=='write-ledger.json'));
});
test('post-write replacement, deletion, addition and symlink substitution prevent a valid seal',t=>{
  for(const change of ['replace','delete','extra','symlink','initial']){
    const dir=temp(t);writeFileSync(join(dir,'plan.json'),'{}\n');const writer=createArtifactWriter(dir);writer.write('local.json',{answer:42});
    const path=join(dir,change==='initial'?'plan.json':'local.json');chmodSync(path,0o644);
    if(change==='replace'||change==='initial')writeFileSync(path,'[]\n');
    else if(change==='delete')unlinkSync(path);
    else if(change==='extra')writeFileSync(join(dir,'unexpected.json'),'{}\n');
    else{unlinkSync(path);symlinkSync('plan.json',path);}
    assert.throws(()=>sealEvidence(dir,'a'.repeat(64),'b'.repeat(64),{writer}),{code:'artifact_save_failed'});assert.equal(writer.failed,true);
  }
});
