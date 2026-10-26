// One bounded read-only input-state capture. No product imports or EVM outputs
// are used to construct prestate inputs. --check is offline; --capture needs
// the reviewed plan hash and exclusive creation of capture.json.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DIR = new URL('./', import.meta.url), ROOT = new URL('../../', import.meta.url);
const sha = b => createHash('sha256').update(b).digest('hex'), json = o => JSON.stringify(o, null, 2) + '\n';
const planBytes = await readFile(new URL('plan.json', DIR)), plan = JSON.parse(planBytes), planSha256 = sha(planBytes);
const scriptSha256 = sha(await readFile(new URL('capture.mjs', DIR)));
assert.equal(plan.scriptSha256, scriptSha256);
for (const source of plan.sources) assert.equal(sha(await readFile(new URL(source.path, ROOT))), source.sha256);
assert.deepEqual(plan.providers, [{ id: 'drpc', url: 'https://hyperliquid.drpc.org' }, { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' }]);
assert.deepEqual(plan.budgets, { maxRpcCalls: 204, maxRpcCallsPerProvider: 102, maxPrestateAccountsPerProvider: 32, maxResponseBytes: 8388608, maxTotalResponseBytes: 33554432, requestTimeoutMs: 25000, maxElapsedMs: 360000, retries: 0 });
assert.deepEqual(plan.completionFields, [{ field: 'nonce', method: 'eth_getTransactionCount' }, { field: 'balance', method: 'eth_getBalance' }, { field: 'code', method: 'eth_getCode' }]);
const old = JSON.parse(await readFile(new URL('reports/current-validated-decimal/capture.json', ROOT)));
const selected = old.cases.find(c => c.id === 'current-direct-transferfrom-a'); assert.ok(selected);
const oldCall = selected.runs[0].rpcCalls.find(c => c.request.method === 'debug_traceCall').request;
assert.deepEqual(plan.envelope, oldCall.params[0]); assert.deepEqual(plan.pinned, oldCall.params[1]);
assert.equal(plan.blockNumber, selected.request.block); assert.equal(plan.pinned.blockHash, selected.expectedBlockHash);
assert.equal(plan.envelope.value, '0x0'); assert.equal(plan.envelope.gas, '0x4c4b40');
for (const run of selected.runs) assert.deepEqual(run.rpcCalls.find(c => c.request.method === 'debug_traceCall').request.params.slice(0, 2), [plan.envelope, plan.pinned]);
const HEADER_FIELDS = ['hash','number','parentHash','timestamp','gasLimit','baseFeePerGas','mixHash','miner'];
const oldHeader = selected.runs[0].rpcCalls.find(c => c.request.method === 'eth_getBlockByNumber').response.result;
assert.deepEqual(plan.expectedHeader, Object.fromEntries(HEADER_FIELDS.map(k => [k, oldHeader[k]])));
const requests = [
  ['chain', 'eth_chainId', []],
  ['header-before', 'eth_getBlockByHash', [plan.pinned.blockHash, false]],
  ['full-prestate', 'debug_traceCall', [plan.envelope, plan.pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: false, disableCode: false, disableStorage: false, includeEmpty: true } }]],
  ['original-call-trace', 'debug_traceCall', [plan.envelope, plan.pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]],
  ['original-state-diff', 'debug_traceCall', [plan.envelope, plan.pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]],
  ['header-after', 'eth_getBlockByNumber', [plan.blockNumber, false]],
];
assert.deepEqual(plan.fixedRequests, requests.map(([label, method, params]) => ({ label, method, params })));
if (process.argv[2] === '--check') { console.log(json({ status: 'validated_offline', planSha256, scriptSha256, fixedRpcCalls: 12, conditionalMaximumRpcCalls: 204, networkCalls: 0 })); process.exit(0); }
assert.equal(process.argv[2], '--capture'); assert.equal(process.argv[3], planSha256);

const recording = { schemaVersion: '1.0', status: 'running', startedAt: new Date().toISOString(), planSha256, scriptSha256, budgets: plan.budgets, envelope: plan.envelope, pinned: plan.pinned, records: [], skipped: [], providers: [], summary: { rpcCalls: 0, successfulRpcCalls: 0, failedRpcCalls: 0, responseBytes: 0 } };
const output = new URL('capture.json', DIR); await writeFile(output, json(recording), { flag: 'wx' });
const save = () => writeFile(output, json(recording));
const began = performance.now(); let stopReason = null;
const object = x => x && typeof x === 'object' && !Array.isArray(x), address = /^0x[0-9a-f]{40}$/, word = /^0x[0-9a-f]{64}$/i;
const safeHeaders = h => Object.fromEntries(['content-type','date','server'].flatMap(k => h.has(k) ? [[k, h.get(k)]] : []));
const fail = code => Object.assign(new Error(code), { code });
const KNOWN = new Set(['TIME_LIMIT','RESPONSE_BYTE_LIMIT','TOTAL_BYTE_LIMIT','RPC_LIMIT','HTTP_ERROR','INVALID_JSON','RPC_ERROR','INVALID_ENVELOPE','CONNECTION_OR_REDIRECT']);
function exhausted() { if (stopReason) return stopReason; if (performance.now() - began >= plan.budgets.maxElapsedMs) return stopReason = 'TIME_LIMIT'; if (recording.summary.responseBytes >= plan.budgets.maxTotalResponseBytes) return stopReason = 'TOTAL_BYTE_LIMIT'; if (recording.summary.rpcCalls >= plan.budgets.maxRpcCalls) return stopReason = 'RPC_LIMIT'; return null; }
function headerMatches(h) { return object(h) && HEADER_FIELDS.every(k => h[k] === plan.expectedHeader[k]); }
function inputAccounts(raw) {
  assert.ok(object(raw)); const pairs = Object.entries(raw); assert.ok(pairs.length > 0 && pairs.length <= plan.budgets.maxPrestateAccountsPerProvider);
  const seen = new Set();
  for (const [key, value] of pairs) {
    const a = key.toLowerCase(); assert.match(a, address); assert.ok(!seen.has(a)); seen.add(a); assert.ok(object(value));
    assert.ok(Object.keys(value).every(k => ['balance','nonce','code','storage','codeHash'].includes(k)));
    if (Object.hasOwn(value, 'balance')) assert.ok(typeof value.balance === 'string' && /^0x[0-9a-f]+$/i.test(value.balance) && BigInt(value.balance) < 1n << 256n);
    if (Object.hasOwn(value, 'nonce')) assert.ok((Number.isSafeInteger(value.nonce) && value.nonce >= 0) || (typeof value.nonce === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.nonce) && BigInt(value.nonce) < 1n << 64n));
    if (Object.hasOwn(value, 'code')) assert.match(value.code, /^0x(?:[0-9a-f]{2})*$/i);
    if (Object.hasOwn(value, 'codeHash')) assert.match(value.codeHash, word);
    if (Object.hasOwn(value, 'storage')) { assert.ok(object(value.storage)); assert.ok(Object.keys(value.storage).length <= 2000); const slots = new Set(); for (const [s,v] of Object.entries(value.storage)) { assert.match(s,word); assert.match(v,word); assert.ok(!slots.has(s.toLowerCase())); slots.add(s.toLowerCase()); } }
  }
  return pairs.map(([a,v]) => [a.toLowerCase(),v]).sort(([a],[b]) => a.localeCompare(b));
}
async function rpc(provider, label, method, params) {
  const id = provider.rpcCalls + 1, guard = exhausted();
  if (guard || provider.rpcCalls >= plan.budgets.maxRpcCallsPerProvider) { recording.skipped.push({ provider: provider.id, label, method, params, reason: guard ?? 'RPC_LIMIT' }); return null; }
  const request = { jsonrpc:'2.0', id, method, params:structuredClone(params) }, requestText = JSON.stringify(request);
  const entry = { provider:provider.id, endpoint:provider.url, label, requestedAt:new Date().toISOString(), request, requestText, responseBytes:0 };
  recording.records.push(entry); provider.rpcCalls++; recording.summary.rpcCalls++;
  const abort = new AbortController(), start = performance.now(), hash = createHash('sha256'), chunks=[];
  let reader, sealed=false, complete=false, timer;
  const cancel = () => { try { void reader?.cancel().catch(()=>{}); } catch {} };
  const checkTime = () => { if (performance.now()-start >= plan.budgets.requestTimeoutMs || performance.now()-began >= plan.budgets.maxElapsedMs) throw fail('TIME_LIMIT'); };
  async function fetchBody() {
    const response = await fetch(provider.url, { method:'POST',headers:{'content-type':'application/json'},body:requestText,redirect:'error',signal:abort.signal });
    if (sealed) { try { void response.body?.cancel().catch(()=>{}); } catch {} throw fail('TIME_LIMIT'); }
    checkTime(); entry.httpStatus=response.status; entry.responseHeaders=safeHeaders(response.headers); if (!response.body?.getReader) throw fail('INVALID_ENVELOPE'); reader=response.body.getReader();
    for (;;) {
      const {done,value}=await reader.read(); if(sealed){cancel();throw fail('TIME_LIMIT');}
      if(done){checkTime();break;}
      const chunk=Buffer.from(value); hash.update(chunk);entry.responseBytes+=chunk.length;recording.summary.responseBytes+=chunk.length;
      checkTime(); if(recording.summary.responseBytes>plan.budgets.maxTotalResponseBytes){stopReason='TOTAL_BYTE_LIMIT';throw fail(stopReason);} if(entry.responseBytes>plan.budgets.maxResponseBytes)throw fail('RESPONSE_BYTE_LIMIT'); chunks.push(chunk);
    }
    complete=true;const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));checkTime();return {text,status:response.status};
  }
  try {
    const result=await Promise.race([fetchBody(),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(fail('TIME_LIMIT'));},Math.max(1,Math.min(plan.budgets.requestTimeoutMs,plan.budgets.maxElapsedMs-(performance.now()-began))));})]);
    if(result.status!==200)throw fail('HTTP_ERROR'); let payload;try{payload=JSON.parse(result.text);}catch{throw fail('INVALID_JSON');}
    if(!object(payload)||payload.jsonrpc!=='2.0'||payload.id!==id||!Object.hasOwn(payload,'result')||Object.hasOwn(payload,'error'))throw fail(Object.hasOwn(payload??{},'error')?'RPC_ERROR':'INVALID_ENVELOPE');
    entry.response=payload;entry.responseText=result.text;recording.summary.successfulRpcCalls++;return structuredClone(payload.result);
  } catch(error) {
    entry.error={code:KNOWN.has(error?.code)?error.code:'CONNECTION_OR_REDIRECT',message:'The fixed read-only request did not produce an admitted JSON-RPC result. Provider error text is withheld; no retry was made.'};entry.responseBodyWithheld=true;recording.summary.failedRpcCalls++;return null;
  } finally {
    sealed=true;clearTimeout(timer);if(!complete){abort.abort();cancel();}entry.bodyComplete=complete;entry.responseSha256=hash.digest('hex');entry.completedAt=new Date().toISOString();entry.elapsedMs=Math.round(performance.now()-start);await save();
  }
}

try {
  for (const endpoint of plan.providers) {
    const provider={...endpoint,rpcCalls:0,completionReads:[],status:'running'};recording.providers.push(provider);
    const chain=await rpc(provider,...requests[0]);
    if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain)!==999n){provider.status='chain_unavailable_or_mismatched';for(const [label,method,params]of requests.slice(1))recording.skipped.push({provider:provider.id,label,method,params,reason:provider.status});continue;}
    const before=await rpc(provider,...requests[1]);
    if(!headerMatches(before)){provider.status='header_unavailable_or_mismatched';for(const [label,method,params]of requests.slice(2))recording.skipped.push({provider:provider.id,label,method,params,reason:provider.status});continue;}
    const prestate=await rpc(provider,...requests[2]);
    let accounts;try{accounts=inputAccounts(prestate);provider.prestateShape='valid_sparse_touched_state';}catch{provider.prestateShape='unavailable_or_malformed_no_field_completion';}
    for (const [account,state] of accounts??[]) for(const {field,method}of plan.completionFields) {
      if(Object.hasOwn(state,field))continue;
      provider.completionReads.push({account,field,method});await rpc(provider,`missing-${field}:${account}`,method,[account,plan.pinned]);
    }
    await rpc(provider,...requests[3]);await rpc(provider,...requests[4]);const after=await rpc(provider,...requests[5]);
    provider.status=headerMatches(after)?'completed_header_bound_capture':'final_header_unavailable_or_mismatched';await save();
  }
  recording.status=recording.skipped.length?'completed_with_skips':'complete';
} catch { recording.status='stopped_without_retry';recording.error={code:'LOCAL_CAPTURE_ERROR',message:'Capture stopped; no new request, retry, replacement or repair was attempted.'}; }
finally {recording.completedAt=new Date().toISOString();recording.elapsedMs=Math.round(performance.now()-began);await save();}
const files=await Promise.all(['plan.json','capture.mjs','capture.json'].map(async file=>({file,sha256:sha(await readFile(new URL(file,DIR)))})));
await writeFile(new URL('manifest.json',DIR),json({schemaVersion:'1.0',planSha256,scriptSha256,status:recording.status,summary:recording.summary,files}),{flag:'wx'});
console.log(json({status:recording.status,captureSha256:sha(await readFile(output)),summary:recording.summary,providers:recording.providers}));
