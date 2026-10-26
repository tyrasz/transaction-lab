import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildPrestateInputs } from '../prestate-inputs.js';
import { createRecordedStateManager } from '../recorded-state.js';
import { executeUnsignedCall } from '../execute.js';
import { compareRecordedExecution } from '../compare-recorded.js';

const captureBytes=await readFile(new URL('../../../reports/local-execution-state/capture.json',import.meta.url));
assert.equal(createHash('sha256').update(captureBytes).digest('hex'),'8e7ca6979a894a6a4340379ef2ff875e7b398e2b48f157324d081dd319c40876');
const capture=JSON.parse(captureBytes),USDC='0xb88339cb7199b77e23db6e890353e22632ba630f',IMPL='0x003f73f58ca78880da3642c5cb71d7459b3fe4f8';
function inputPacket(provider='drpc'){
  const rows=capture.records.filter(r=>r.provider===provider),pre=rows.find(r=>r.label==='full-prestate');
  return {prestate:structuredClone(pre.response.result),prestateRequest:structuredClone(pre.request),envelope:structuredClone(capture.envelope),pinned:structuredClone(capture.pinned),header:structuredClone(rows.find(r=>r.label==='header-before').response.result),completionReads:rows.filter(r=>r.label.startsWith('missing-')).map(r=>({address:r.request.params[0],field:r.label.slice(8).split(':')[0],request:structuredClone(r.request),result:structuredClone(r.response.result)}))};
}
async function execute(provider='drpc',mutate){
  const inputs=buildPrestateInputs(inputPacket(provider));mutate?.(inputs);
  const state=await createRecordedStateManager({accounts:inputs.accounts});
  const localExecution=await executeUnsignedCall({request:inputs.request,block:inputs.block,stateManager:state});
  const localChanges=state.snapshotChanges();
  // Expected channels are deliberately accessed only after actual execution.
  const rows=capture.records.filter(r=>r.provider===provider);
  const args={inputs,envelope:capture.envelope,localExecution,localChanges,providerTrace:structuredClone(rows.find(r=>r.label==='original-call-trace').response.result),providerDiff:structuredClone(rows.find(r=>r.label==='original-state-diff').response.result)};
  return {args,comparison:compareRecordedExecution(args),state};
}

for(const provider of ['drpc','hyperlend-archive'])test(`real sparse ${provider} inputs execute before exact call/log/state comparison`,async()=>{
  const {args,comparison}=await execute(provider);
  assert.equal(comparison.status,'matched');for(const key of ['execution','callTree','logs','state'])assert.equal(comparison[key].status,'matched');
  assert.equal(comparison.execution.intrinsicGas,'21940');assert.equal(args.localExecution.execution.executionGasUsed,'29328');assert.equal(args.localExecution.execution.gasRefundCounter,'0');
  assert.equal(comparison.callTree.localFrames,2);assert.equal(comparison.logs.localCount,1);assert.equal(comparison.state.localChangedAccounts,2);
});

test('missing required storage is unavailable and rolls back the sender nonce and all effects',async()=>{
  const {args,comparison}=await execute('drpc',inputs=>delete inputs.accounts[USDC].storage[Object.keys(inputs.accounts[USDC].storage).sort()[0]]);
  assert.equal(args.localExecution.execution.status,'unavailable');assert.equal(args.localExecution.execution.error.code,'LOCAL_STATE_MISSING');assert.equal(args.localExecution.stateDisposition,'rolled_back');assert.deepEqual(args.localChanges.accounts,[]);assert.equal(comparison.status,'unavailable');
});

test('missing implementation account is unavailable with complete rollback, not an empty-code success',async()=>{
  const {args,comparison}=await execute('drpc',inputs=>delete inputs.accounts[IMPL]);
  assert.equal(args.localExecution.execution.status,'unavailable');assert.equal(args.localExecution.execution.error.code,'LOCAL_STATE_MISSING');assert.equal(args.localExecution.stateDisposition,'rolled_back');assert.deepEqual(args.localChanges.accounts,[]);assert.equal(comparison.status,'unavailable');
});

test('missing basic-code completion rejects at input conversion before any manager is created',()=>{
  const packet=inputPacket();packet.completionReads=packet.completionReads.filter(r=>r.address!==capture.envelope.from);const before=structuredClone(packet);
  assert.throws(()=>buildPrestateInputs(packet),e=>e.code==='LOCAL_INPUT_PACKET_INVALID');assert.deepEqual(packet,before);
});

test('explicit empty implementation code is changed supplied state and causes observable divergence',async()=>{
  const {args,comparison}=await execute('drpc',inputs=>inputs.accounts[IMPL].code='0x');
  assert.equal(args.localExecution.execution.status,'success');assert.equal(comparison.status,'diverged');assert.equal(comparison.execution.status,'diverged');assert.equal(comparison.logs.status,'diverged');assert.equal(comparison.state.status,'diverged');
});

test('explicit changed storage remains changed rather than repaired from expected state',async()=>{
  const slot=Object.keys(inputPacket().prestate[USDC].storage).find(k=>BigInt(inputPacket().prestate[USDC].storage[k])===1541542n);assert.ok(slot);
  const {args,comparison}=await execute('drpc',inputs=>inputs.accounts[USDC].storage[slot]='0x'+(1541543n).toString(16).padStart(64,'0'));
  assert.equal(args.localExecution.execution.status,'success');assert.equal(args.inputs.accounts[USDC].storage[slot],'0x'+(1541543n).toString(16).padStart(64,'0'));assert.equal(comparison.state.status,'diverged');assert.ok(comparison.state.baselineDifferences.some(d=>d.slot===slot));
});

test('descendant gas and return-data differences cannot pass a root-only comparison',async()=>{
  const {args}=await execute();for(const field of ['gas','output']){const changed=structuredClone(args);changed.providerTrace.calls[0][field]=field==='gas'?'0x'+(BigInt(changed.providerTrace.calls[0].gas)+1n).toString(16):'0x00';const c=compareRecordedExecution(changed);assert.equal(c.execution.status,'matched');assert.equal(c.callTree.status,'diverged');}
});

test('missing entered calls are not discarded and duplicate log indices are unavailable',async()=>{
  const {args}=await execute();const noChild=structuredClone(args);noChild.providerTrace.calls=[];assert.equal(compareRecordedExecution(noChild).callTree.status,'diverged');
  const duplicate=structuredClone(args);duplicate.providerTrace.calls[0].logs.push(structuredClone(duplicate.providerTrace.calls[0].logs[0]));assert.equal(compareRecordedExecution(duplicate).logs.status,'unavailable');
});

test('committed log ordering uses provider indices rather than incidental array order',async()=>{
  const {args}=await execute(),synthetic=structuredClone(args),first=synthetic.providerTrace.calls[0].logs[0],second={...structuredClone(first),data:'0x01',index:'0x1'};
  synthetic.providerTrace.calls[0].logs=[second,first];synthetic.localExecution.logs.push({address:second.address,topics:second.topics,data:second.data});assert.equal(compareRecordedExecution(synthetic).logs.status,'matched');
  synthetic.providerTrace.calls[0].logs[0].index='0x0';synthetic.providerTrace.calls[0].logs[1].index='0x1';assert.equal(compareRecordedExecution(synthetic).logs.status,'diverged');
});

test('missing changed-basic pre-value, account lifecycle and runtime code changes remain unavailable',async()=>{
  const {args}=await execute();for(const mutate of [
    x=>delete x.providerDiff.pre[capture.envelope.from].nonce,
    x=>delete x.providerDiff.pre[USDC],
    x=>x.providerDiff.post[USDC].code='0x00',
  ]){const changed=structuredClone(args);mutate(changed);assert.equal(compareRecordedExecution(changed).state.status,'unavailable');}
});

test('provider prefields and the entire local changed-state snapshot are compared',async()=>{
  const {args}=await execute();const changed=structuredClone(args);changed.providerDiff.pre[USDC].balance='0x1';assert.equal(compareRecordedExecution(changed).state.status,'diverged');
  const omitted=structuredClone(args);delete omitted.providerDiff.pre[USDC];delete omitted.providerDiff.post[USDC];assert.equal(compareRecordedExecution(omitted).state.status,'diverged');
  const extra=structuredClone(args);extra.localChanges.accounts.push({address:IMPL,nonce:{before:'0x1',after:'0x2'}});assert.equal(compareRecordedExecution(extra).state.status,'diverged');
});

test('nonzero refund and changed context cannot masquerade as exact gas/envelope agreement',async()=>{
  const {args}=await execute();const refund=structuredClone(args);refund.localExecution.execution.gasRefundCounter='1';const c=compareRecordedExecution(refund);assert.equal(c.execution.status,'unavailable');assert.equal(c.callTree.status,'unavailable');assert.equal(c.state.status,'matched');
  const context=structuredClone(args);context.localExecution.environment.baseFeePerGas='1';assert.equal(compareRecordedExecution(context).status,'unavailable');
});

test('contradictory revert reasons and explicit empty error fields cannot match success',async()=>{
  const {args}=await execute();
  for(const child of [false,true])for(const field of ['revertReason','error']){
    const changed=structuredClone(args),frame=child?changed.providerTrace.calls[0]:changed.providerTrace;
    frame[field]=field==='revertReason'?'contract-reported contradiction':'';
    const comparison=compareRecordedExecution(changed);assert.equal(comparison.status,'unavailable');assert.equal(comparison.callTree.status,'unavailable');assert.equal(comparison.logs.status,'unavailable');if(!child)assert.equal(comparison.execution.status,'unavailable');
  }
});
