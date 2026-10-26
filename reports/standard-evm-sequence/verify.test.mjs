import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, loadPacket, validateReport, validateStep, composeState, normalizeDiff, replayExchange, semanticReport } from './verify.mjs';
const packet=await loadPacket();
const two=await packet.read('approve-then-supply-response.json');
const three=await packet.read('approve-supply-repeat-response.json');
const exchange=await packet.read('http/002.json');
const plan=packet.plan.cases[1];
const clone=x=>structuredClone(x);
function rejectsMutation(fn,source=two,planned=plan){const copy=clone(source);fn(copy);assert.throws(()=>validateReport(copy,planned,packet.keccak));}
const evidence=(r,id)=>r.evidence.find(x=>x.id===id);

test('all 73 sealed files and 112 exact saved RPC bodies reproduce through the archived API with no network',async()=>{
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('Public network forbidden in verifier tests.');};
  try{const r=await verify();assert.equal(r.status,'passed');assert.equal(r.publicNetworkRequests,0);assert.equal(r.socketsOpened,0);assert.deepEqual(r.totals,{rpcCalls:112,responseBytes:457073,independentlyDecodedMeasurements:10});assert.deepEqual(r.cases.map(x=>x.playback.consumedRpcIds.length),[9,47,56]);
    assert.deepEqual(r.cases[1].steps.map(x=>x.measurements.length),[1,4]);assert.equal(r.cases[1].steps[1].measurements[0].afterRaw,'3962903484');assert.equal(r.cases[1].steps[1].measurements[1].deltaRaw,'-3962903485');assert.equal(r.cases[2].steps[2].status,'reverted_or_failed');
  }finally{globalThis.fetch=original;}
});
test('a changed raw query word cannot be admitted as the captured measurement',()=>rejectsMutation(r=>{const s=r.steps[1].result,m=s.measurements[0];evidence(s,m.queryEvidence[1].traceEvidenceId).result.output='0x'+'0'.repeat(64);}));
test('receipt amount cannot be rounded to the USDC transfer/event amount',()=>rejectsMutation(r=>{const s=r.steps[1].result;s.measurements[0].afterRaw='3962903485';s.measurements[0].deltaRaw='3962903485';s.preview.queries[0].afterRaw='3962903485';s.preview.queries[0].deltaRaw='3962903485';}));
test('step two original call must use the complete actual approval overrides',()=>rejectsMutation(r=>{delete evidence(r.steps[1].result,8).params[2].stateOverrides;}));
test('step two original diff must use exactly the same starting overrides',()=>rejectsMutation(r=>{evidence(r.steps[1].result,11).params[2].stateOverrides={};}));
test('before measurement queries cannot silently read the original block instead of approval state',()=>rejectsMutation(r=>{const s=r.steps[1].result;delete evidence(s,s.measurements[0].queryEvidence[0].traceEvidenceId).params[2].stateOverrides;}));
test('after measurement queries must preserve cleared allowance and balance slots',()=>rejectsMutation(r=>{const s=r.steps[1].result,p=s.measurements[0].queryEvidence[1];const slots=evidence(s,p.traceEvidenceId).params[2].stateOverrides['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'].stateDiff;const zero=Object.keys(slots).find(k=>/^0x0+$/.test(slots[k]));assert.ok(zero);delete slots[zero];}));
test('query-only nonce cannot be carried into the next execution',()=>rejectsMutation(r=>{const s=r.steps[1].result;s.startingState.overrides[r.apiRequest.from].nonce='0x36';}));
test('query state mutation must remain exactly a sender nonce increment',()=>rejectsMutation(r=>{const s=r.steps[0].result,p=s.measurements[0].queryEvidence[0];evidence(s,p.mutationEvidenceId).result.post[r.apiRequest.from].balance='0x1';}));
test('read-only queries reject nested CALL and event effects',()=>{
  rejectsMutation(r=>{const s=r.steps[1].result;evidence(s,s.measurements[0].queryEvidence[0].traceEvidenceId).result.calls[0].type='CALL';});
  rejectsMutation(r=>{const s=r.steps[0].result;evidence(s,s.measurements[0].queryEvidence[0].traceEvidenceId).result.logs=[{address:r.apiRequest.from,data:'0x',topics:[]}];});
});
test('final complete header changes are not normalized away',()=>rejectsMutation(r=>{r.finalVerification.result.newField='changed';}));
test('third executed revert cannot be relabeled skipped',()=>rejectsMutation(r=>{r.steps[2].status='skipped';},three,packet.plan.cases[2]));
test('a later revert cannot erase the verified prefix',()=>rejectsMutation(r=>{r.steps[0].result.measurements=[];},three,packet.plan.cases[2]));
test('full state composition checks overwritten slots and basic state against the next prestate',()=>{
  const checks=validateReport(two,plan,packet.keccak),previous=checks[0].overrides,diff=clone(two.steps[1].result.stateDiff);diff.pre[two.apiRequest.from].nonce='54';assert.throws(()=>composeState(previous,diff));
  const changed=clone(two.steps[1].result.stateDiff),token='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',slot=Object.keys(previous[token].stateDiff)[0];changed.pre[token].storage[slot]='0x'+'0'.repeat(64);assert.throws(()=>composeState(previous,changed));
});
test('explicit provider codeHash is checked against complete runtime code',()=>{
  const raw=clone(evidence(two.steps[0].result,9).result),a=Object.keys(raw.pre).find(a=>raw.pre[a].codeHash);assert.ok(a);raw.pre[a].codeHash='0x'+'0'.repeat(64);assert.throws(()=>normalizeDiff(raw,packet.keccak));
});
test('wire/order mismatch remains latched when engine catches a transport failure',async()=>{
  const bad=clone(exchange),saved=JSON.parse(bad.response.bodyText);saved.transportEvidence[1].requestText=saved.transportEvidence[0].requestText;bad.response.bodyText=JSON.stringify(saved);
  await assert.rejects(replayExchange(bad,packet.plan,packet.runtime,'sequence'),/RPC mismatches were latched/);
});
test('unused responses and changed non-generated result fields cannot pass playback',async()=>{
  const extra=clone(exchange),r=JSON.parse(extra.response.bodyText);r.transportEvidence.push(clone(r.transportEvidence.at(-1)));extra.response.bodyText=JSON.stringify(r);await assert.rejects(replayExchange(extra,packet.plan,packet.runtime,'sequence'));
  const bad=clone(exchange),s=JSON.parse(bad.response.bodyText);s.scope.atomic=true;bad.response.bodyText=JSON.stringify(s);await assert.rejects(replayExchange(bad,packet.plan,packet.runtime,'sequence'),/Every nongenerated/);
});
test('generated metadata exclusions are narrow and preserve every state/evidence field',()=>{
  const copy=clone(two);copy.id='00000000-0000-4000-8000-000000000000';copy.createdAt='2026-10-26T15:00:00.000Z';copy.timing={rpcMs:0,totalMs:0};for(const e of copy.transportEvidence)e.transport.durationMs=0;assert.deepEqual(semanticReport(copy),semanticReport(two));copy.steps[1].result.startingState.priorCalls=2;assert.notDeepEqual(semanticReport(copy),semanticReport(two));
});
