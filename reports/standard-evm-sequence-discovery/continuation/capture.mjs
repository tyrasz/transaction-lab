// Supplemental continuation: exactly three previously unattempted observations.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const DIR = new URL('./',import.meta.url), sha=b=>createHash('sha256').update(b).digest('hex');
const planBytes=await fs.readFile(new URL('plan.json',DIR)),plan=JSON.parse(planBytes);
assert.equal(sha(await fs.readFile(new URL(import.meta.url))),plan.scriptSha256);
assert.equal(plan.endpoint,'https://eth.drpc.org');
assert.deepEqual(plan.limits,{requests:3,candidates:1,responseBytes:8388608,totalBytes:33554432,requestMs:25000,wallMs:360000,retries:0});
const manifestBytes=await fs.readFile(new URL('../manifest.json',DIR));assert.equal(sha(manifestBytes),plan.originalManifestSha256);
const manifest=JSON.parse(manifestBytes);
for(const f of manifest.files){const b=await fs.readFile(new URL('../'+f.path,DIR));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
const original=JSON.parse(await fs.readFile(new URL('../capture.json',DIR))),originalPlan=JSON.parse(await fs.readFile(new URL('../plan.json',DIR)));
assert.equal(sha(await fs.readFile(new URL('../capture.json',DIR))),plan.originalCaptureSha256);
assert.equal(original.status,'incomplete_or_failed_fixed_candidate');assert.equal(original.requests.length,12);
const {normalizeProviderStateDiff}=await import('../source/engines/standard-evm/provider-state-diff.js');
const {buildStateOverrides}=await import('../source/src/state.js');
const normalized=normalizeProviderStateDiff(original.candidate.approvalDiffRaw).diff;
const overrides=buildStateOverrides(normalized);assert.deepEqual(overrides,original.candidate.completeApprovalOverrides);
assert.deepEqual(plan.supply,originalPlan.supply);assert.equal(plan.blockHash,originalPlan.blockHash);
assert.equal(sha(JSON.stringify(overrides)),plan.completeApprovalOverridesSha256);
const q=normalizeProviderStateDiff(original.candidate.allowanceQueryDiffRaw).diff,sender=originalPlan.sender;
assert.deepEqual(Object.keys(q.pre),[sender]);assert.deepEqual(Object.keys(q.post),[sender]);
assert.deepEqual(Object.keys(q.pre[sender]).sort(),['balance','nonce']);assert.deepEqual(Object.keys(q.post[sender]),['nonce']);
assert.equal(BigInt(q.pre[sender].balance),BigInt(original.candidate.nativeBalanceBefore));
assert.equal(BigInt(q.pre[sender].nonce),BigInt(original.candidate.nonceBefore)+1n);assert.equal(BigInt(q.post[sender].nonce),BigInt(original.candidate.nonceBefore)+2n);
assert.equal(BigInt(original.candidate.allowanceAfterTrace.output).toString(),originalPlan.amountRaw);
if(process.argv.includes('--check')){console.log(JSON.stringify({status:'preflight_passed',planSha256:sha(planBytes),anchoredUnchangedBalance:true,queryNonceOnly:true,networkCalls:0}));process.exit(0);}assert.equal(process.argv.length,2);
const ledger={schemaVersion:'1.0',startedAt:new Date().toISOString(),planSha256:sha(planBytes),originalManifestSha256:plan.originalManifestSha256,originalCaptureSha256:plan.originalCaptureSha256,endpoint:plan.endpoint,supplementalContinuation:true,syntheticSequence:true,exactHistoricalReplay:false,requests:[],observedBytes:0,retainedBytes:0,results:{},status:'started'};
const started=performance.now();await fs.mkdir(new URL('raw/',DIR),{recursive:false});await fs.writeFile(new URL('STARTED',DIR),ledger.startedAt+'\n',{flag:'wx'});
const checkpoint=()=>fs.writeFile(new URL('progress.json',DIR),JSON.stringify(ledger,null,2)+'\n');
async function rpc(role, method, params) {
  assert(plan.methods.includes(method));
  assert(ledger.requests.length < plan.limits.requests && ledger.observedBytes < plan.limits.totalBytes && performance.now() - started < plan.limits.wallMs);
  const id = ledger.requests.length + 1, name = String(id).padStart(3, '0'), request = { jsonrpc: '2.0', id, method, params };
  const requestText = JSON.stringify(request), record = { id, role, request, requestText, requestSha256: sha(requestText), requestBytes: Buffer.byteLength(requestText), startedAt: new Date().toISOString() };
  ledger.requests.push(record); await checkpoint();
  const controller = new AbortController(), began = performance.now();
  const timeoutMs = Math.min(plan.limits.requestMs, plan.limits.wallMs - (began - started));
  let timer, reader, complete = false, status, bytes = 0, kept = 0, valid = false;
  const chunks = [], digest = createHash('sha256');
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); });
  const check = () => assert(performance.now() - began < timeoutMs && performance.now() - started < plan.limits.wallMs);
  let result;
  try {
    const fetching = fetch(plan.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText, redirect: 'error', signal: controller.signal });
    fetching.then(r => { if (controller.signal.aborted) Promise.resolve(r.body?.cancel()).catch(() => {}); }).catch(() => {});
    const response = await Promise.race([fetching, deadline]); check(); status = response.status;
    reader = response.body.getReader();
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); check();
      if (part.done) { complete = true; break; }
      const data = Buffer.from(part.value); bytes += data.length; ledger.observedBytes += data.length; digest.update(data);
      const room = Math.min(plan.limits.responseBytes - kept, plan.limits.totalBytes - ledger.retainedBytes), prefix = data.subarray(0, Math.max(0, room));
      chunks.push(prefix); kept += prefix.length; ledger.retainedBytes += prefix.length;
      assert.equal(prefix.length, data.length);
    }
    const body = Buffer.concat(chunks), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), parsed = JSON.parse(text);
    record.response = parsed; check();
    assert(response.ok); assert.equal(parsed.jsonrpc, '2.0'); assert.equal(parsed.id, id);
    assert.notEqual(Object.hasOwn(parsed, 'error'), Object.hasOwn(parsed, 'result'));
    if (Object.hasOwn(parsed, 'error')) record.status = 'rpc_error';
    else { result = parsed.result; record.status = 'success'; valid = true; }
  } catch { record.status = 'transport_validation_or_budget_failure'; }
  finally {
    clearTimeout(timer); if (!complete) { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }
    const body = Buffer.concat(chunks);
    Object.assign(record, { httpStatus: status ?? null, completedAt: new Date().toISOString(), durationMs: performance.now() - began,
      raw: { file: 'raw/' + name + '.body', complete, observedBytes: bytes, bytes: kept, observedPrefixSha256: digest.digest('hex'), sha256: sha(body) } });
    await fs.writeFile(new URL(record.raw.file, DIR), body, { flag: 'wx' });
    await fs.writeFile(new URL('raw/' + name + '.json', DIR), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await checkpoint();
  }
  assert(valid, 'RPC_OBSERVATION_UNAVAILABLE'); return result;
}
const traceOptions={tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true},stateOverrides:overrides};
const diffOptions={tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true},stateOverrides:overrides};
const calls=[['supply_after_approval','debug_traceCall',[plan.supply,plan.blockHash,traceOptions]],['supply_after_approval_diff','debug_traceCall',[plan.supply,plan.blockHash,diffOptions]],['final_full_header','eth_getBlockByNumber',[original.block.number,false]]];
for(const[role,method,params]of calls){try{ledger.results[role]=await rpc(role,method,params);}catch{ledger.results[role]=null;}}
try{
 const trace=ledger.results.supply_after_approval;assert(trace&&!trace.error&&!trace.revertReason);assert.equal(trace.type,'CALL');assert.equal(trace.from,plan.supply.from);assert.equal(trace.to,plan.supply.to);assert.equal(trace.input,plan.supply.data);assert.equal(BigInt(trace.value),0n);assert.equal(BigInt(trace.gas),5000000n);
 const diff=normalizeProviderStateDiff(ledger.results.supply_after_approval_diff).diff;
 assert.equal(BigInt(diff.pre[sender].nonce),BigInt(original.candidate.nonceBefore)+1n);assert.equal(BigInt(diff.post[sender].nonce),BigInt(original.candidate.nonceBefore)+2n);
 const logWalk=frame=>frame.error||frame.revertReason?[]:[...(frame.logs??[]),...(frame.calls??[]).flatMap(logWalk)];
 const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
 ledger.transferEvents=logWalk(trace).filter(log=>log.topics[0]===transfer);
 const ownerWord='0x'+sender.slice(2).padStart(64,'0'),reserveWord='0x'+originalPlan.aToken.slice(2).padStart(64,'0');
 const cash=ledger.transferEvents.filter(log=>log.address===originalPlan.usdc&&log.topics[1]===ownerWord);assert.equal(cash.length,1);assert.equal(cash[0].topics[2],reserveWord);assert.equal(BigInt(cash[0].data).toString(),originalPlan.amountRaw);
 for(const[slot,value]of Object.entries(overrides[originalPlan.usdc].stateDiff)){assert.equal(diff.pre[originalPlan.usdc].storage[slot],value);assert.equal(BigInt(diff.post[originalPlan.usdc].storage?.[slot]??'0x0'),0n);}
 assert.deepEqual(ledger.results.final_full_header,original.block);ledger.canonicalRecheck=true;ledger.status='usable_synthetic_sequence_with_preserved_initial_incomplete_packet';
}catch{ledger.status='continuation_incomplete_or_failed';ledger.canonicalRecheck=JSON.stringify(ledger.results.final_full_header)===JSON.stringify(original.block);}
ledger.completedAt=new Date().toISOString();ledger.durationMs=performance.now()-started;ledger.retries=0;
await fs.writeFile(new URL('capture.json',DIR),JSON.stringify(ledger,null,2)+'\n',{flag:'wx',mode:0o444});await checkpoint();
console.log(JSON.stringify({status:ledger.status,requests:ledger.requests.length,observedBytes:ledger.observedBytes,canonicalRecheck:ledger.canonicalRecheck,planSha256:ledger.planSha256},null,2));
