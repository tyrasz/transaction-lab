// Saved artifacts only. No VM, worker, Geth, transport or freeze is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verify,applyDelta,verifyInputs} from './review.mjs';
import {compareEvidence} from './capture/runtime/research/amsterdam-authorization-geth-v032/compare.mjs';
const root=path.resolve(import.meta.dirname,'../..'),cap=path.join(import.meta.dirname,'capture');
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(path.join(cap,p)));
const product=n=>JSON.parse(Buffer.from(json('product/'+n+'.json').stdout.base64,'base64'));

test('complete pinned saved packet reproduces five matched and one unavailable without targets',async()=>{
 const report=await verify(root);assert.deepEqual(report.checks.counts,{matched:5,mismatched:0,unavailable:1,not_attempted:0});
 assert.equal(report.checks.reconstructedMptRoots,24);assert.equal(report.checks.parsedInputReplies,30);
 assert.equal(report.rows.flatMap(r=>Object.values(r.channels)).filter(v=>v===true).length,52);
 assert.equal(report.rows.flatMap(r=>Object.values(r.channels)).filter(v=>v===null).length,2);
});

test('independent delta application rejects wrong starting balances, duplicate rows and unsupported reset namespaces',()=>{
 const input=json('inputs/001.json'),changes=product('001').attempt.changes;
 assert.notDeepEqual(applyDelta(input.allocation,changes),input.allocation);
 for(const mutate of [x=>x.accounts[0].balance.before='0x0',x=>x.accounts.push(structuredClone(x.accounts[0])),
  x=>x.accounts[0].reset={basis:'forged'},x=>x.accounts[0].storage=[]]){
  const bad=structuredClone(changes);mutate(bad);assert.throws(()=>applyDelta(input.allocation,bad));
 }
});

test('parsed proof/code reply joins reject count, hash, result and selector substitutions',()=>{
 const input=json('inputs/001.json'),saved=product('001');verifyInputs(input,saved,sha);
 for(const mutate of [p=>p.proofRecords.pop(),p=>p.attempt.broker.calls++,p=>p.attempt.inputEvidence[0].resultSha256='0'.repeat(64),
  p=>p.proofRecords[0].result.balance='0x0',p=>p.proofRecords[0].params.at(-1).blockHash='0x'+'00'.repeat(32)]){
  const bad=structuredClone(saved);mutate(bad);assert.throws(()=>verifyInputs(input,bad,sha));
 }
});

test('actual no-message artifact keeps two null channels and never hides an available mismatch',()=>{
 const input=json('inputs/003.json'),e=product('003').comparisonInput;
 const outputs={result:json('geth/003/result.json'),body:json('geth/003/body.rlp'),allocation:json('geth/003/alloc.json'),
  trace:fs.readFileSync(path.join(cap,'geth/003/trace-0-'+input.transactionHash+'.jsonl'))};
 const good=compareEvidence(input,e,outputs);assert.equal(good.status,'unavailable');assert.equal(good.channels.messageGas,null);
 const bad={...outputs,result:{...outputs.result,stateRoot:'0x'+'11'.repeat(32)}};
 assert.equal(compareEvidence(input,e,bad).status,'mismatched');
 const fake=structuredClone(e);fake.productMessage.entered=true;assert.throws(()=>compareEvidence(input,fake,outputs));
 assert.throws(()=>compareEvidence(input,e,{...outputs,trace:outputs.trace.subarray(0,outputs.trace.length-1)}));
});

test('external manifest pin rejects a resealed inventory before importing captured code',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'authorization-review-tamper-'));
 try{const target=path.join(dir,'research/amsterdam-authorization-geth-v032/capture');fs.mkdirSync(target,{recursive:true});
  const m=json('manifest.json');m.files.pop();fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(m));
  await assert.rejects(verify(dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
