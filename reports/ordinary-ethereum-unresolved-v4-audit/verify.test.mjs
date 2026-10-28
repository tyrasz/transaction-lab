import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyWire,joinProduct,audit} from './verify.mjs';
const read=path=>JSON.parse(readFileSync(new URL('../ordinary-ethereum-unresolved-v4/'+path,import.meta.url)));
test('sealed packet binds all52 fresh wires and four saved account proofs without promoting unavailable cases',async()=>{
  const r=await audit();assert.equal(r.unjoinedRecords,0);assert.equal(r.proofAudit.freshVerifiedProofs,0);assert.equal(r.proofAudit.savedAccountProofsVerified,4);
  assert(r.cases.every(c=>c.outcome.comparison!=='match'));assert.deepEqual(r.cases.filter(c=>c.supplement).map(c=>c.id),['005','016']);
});
test('wire byte, parsed-envelope, request and hash mutations reject',()=>{
  const base=read('wire/000002.json');verifyWire(base);
  for(const change of [w=>{w.rawBase64=Buffer.from('{}').toString('base64');},w=>{w.parsed.id++;},w=>{w.request.params=['latest'];},w=>{w.transport.observedBytes++;},w=>{w.requestSha256='0'.repeat(64);}]){
    const altered=structuredClone(base);change(altered);assert.throws(()=>verifyWire(altered));
  }
});
test('product engine and transport must join the actual corresponding wire, including the failed blob diff',()=>{
  const p=read('cases/007/product.json'),index=p.transportWireIds.length-1,w=read('wire/'+String(p.transportWireIds[index]).padStart(6,'0')+'.json'),inner=p.report.transportEvidence[index],engine=p.report.evidence[index];
  joinProduct(w,inner,engine);
  for(const change of [e=>{e.params[0].maxFeePerBlobGas='0x1';},e=>{e.result={pre:{},post:{}};},e=>{e.id--;},e=>{e.params[1].requireCanonical=false;}]){const altered=structuredClone(engine);change(altered);assert.throws(()=>joinProduct(w,inner,altered));}
  const allegedSuccess=structuredClone(inner);allegedSuccess.responseText=JSON.stringify({jsonrpc:'2.0',id:inner.id,result:{}});assert.throws(()=>joinProduct(w,allegedSuccess,engine));
});
