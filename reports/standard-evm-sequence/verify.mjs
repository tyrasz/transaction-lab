// Supplementary offline verifier. No frozen packet file is modified, no socket
// is opened, and all provider responses come from their exact saved wire text.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
const here=path.dirname(fileURLToPath(import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex'), jsonSha=x=>sha(JSON.stringify(x));
const keys=x=>Object.keys(x).sort(), own=(x,k)=>Object.hasOwn(x,k), plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const MAX=(1n<<256n)-1n, ZERO='0x'+'0'.repeat(64), PROBE='0x000000000000000000000000000000000000ba1a';
const q=x=>{assert.ok(typeof x==='string'||Number.isSafeInteger(x));assert.match(String(x),/^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i);const n=BigInt(x);assert.ok(n>=0n&&n<=MAX);return n;};
const hex=x=>'0x'+q(x).toString(16), finiteTime=x=>assert.ok(Number.isFinite(x)&&x>=0);
const timestamp=x=>{assert.equal(new Date(x).toISOString(),x);return Date.parse(x);};
export const PLAN_SHA256='14ad30f7f7031395ab2c4636ac649d0029a2ba3a9669ba1f61efa53afd4ae107';
export const MANIFEST_SHA256='6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c';
export const IMPLEMENTATION_SHA256='3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60';
const noble='engines/standard-evm/node_modules/@noble/hashes';
const IMPLEMENTATION_FILES=[
  'package.json','src/config.js','src/server.js','src/validate.js','src/standard-loader.js','src/standard-rpc.js','src/standard-simulation.js',
  'src/rpc.js','src/state.js','src/state-diff.js','src/query-validation.js','src/account-effects.js','src/affected-balances.js','src/allowances.js',
  'src/analyze.js','src/balances.js','src/current-state.js','src/historical-state.js','src/lending-balances.js','src/lending.js','src/permissions.js','src/revert.js',
  'engines/standard-evm/discovery.js','engines/standard-evm/native-effects.js','engines/standard-evm/sequence-state.js','engines/standard-evm/package.json','engines/standard-evm/package-lock.json',
  'engines/standard-evm/unsigned-call.js','engines/standard-evm/provider-state-diff.js',...['package.json','sha3.js','_u64.js','utils.js'].map(n=>noble+'/'+n),
].sort();
const ARCHIVE_FILES=[...IMPLEMENTATION_FILES,noble+'/LICENSE','public/app.js','public/index.html','public/style.css',
  ...['standard-auto-saved','standard-loader','standard-rpc','standard-server','standard-simulation','standard-sequence'].map(n=>'test/'+n+'.test.js'),
  ...['discovery','native-effects','native-execution','provider-state-diff','sequence-state','sequence','unsigned-call'].map(n=>'engines/standard-evm/test/'+n+'.test.js'),
  'reports/standard-evm-sequence/run.mjs','reports/standard-evm-sequence/freeze.mjs'].sort();
const INPUT_FILES=['inputs/discovery-plan.json','inputs/discovery-capture.json','inputs/discovery-manifest.json','inputs/continuation-capture.json','inputs/continuation-manifest.json'];
export const CASE_IDS=['supply-without-approval','approve-then-supply','approve-supply-repeat'];

const METHODS = new Set(['eth_chainId','eth_getBlockByHash','eth_getBlockByNumber','eth_getTransactionCount','eth_getBalance','eth_getCode','debug_traceCall']);

export function validateTransport(records, profile = 'single') {
  assert.ok(Array.isArray(records)); assert.ok(records.length <= (profile === 'sequence' ? 258 : 65));
  let observedBytes = 0, retainedBytes = 0, durationMs = 0, withheld = 0;
  for (const [index, record] of records.entries()) {
    assert.equal(record.id, index + 1); assert.equal(record.provider, 'eth.drpc.org');
    assert.deepEqual(keys(record.request), ['id', 'jsonrpc', 'method', 'params']);
    assert.equal(record.request.id, index + 1); assert.equal(record.request.jsonrpc, '2.0');
    assert.ok(METHODS.has(record.request.method)); assert.ok(Array.isArray(record.request.params));
    assert.equal(record.requestText, JSON.stringify(record.request));
    assert.equal(record.requestBytes, Buffer.byteLength(record.requestText)); assert.equal(record.requestSha256, sha(record.requestText));
    const transport = record.transport;
    assert.ok(plain(transport)); assert.equal(typeof transport.complete, 'boolean'); assert.equal(typeof transport.bodyRetained, 'boolean');
    for (const key of ['observedBytes', 'retainedPrefixBytes']) assert.ok(Number.isSafeInteger(transport[key]) && transport[key] >= 0);
    assert.ok(transport.observedBytes >= transport.retainedPrefixBytes);
    assert.ok(transport.retainedPrefixBytes <= 8 * 1024 * 1024);
    assert.ok(transport.timeoutMs > 0 && transport.timeoutMs <= 25000); finiteTime(transport.durationMs);
    for (const key of ['observedPrefixSha256', 'retainedPrefixSha256']) assert.match(transport[key], /^[0-9a-f]{64}$/);
    observedBytes += transport.observedBytes; retainedBytes += transport.retainedPrefixBytes; durationMs += transport.durationMs;
    if (record.error !== undefined) {
      assert.ok(plain(record.error)); assert.equal(typeof record.error.code, 'string'); assert.equal(typeof record.error.message, 'string');
      assert.equal(record.responseText, undefined); assert.equal(transport.bodyRetained, false); withheld++;
      if (transport.complete && transport.observedBytes === transport.retainedPrefixBytes) assert.match(transport.responseSha256, /^[0-9a-f]{64}$/);
      else assert.equal(transport.responseSha256, undefined);
      continue;
    }
    assert.ok(record.httpStatus >= 200 && record.httpStatus < 300);
    assert.equal(typeof record.responseText, 'string');
    assert.equal(transport.complete, true); assert.equal(transport.bodyRetained, true);
    const bytes = Buffer.from(record.responseText, 'utf8');
    assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), record.responseText);
    assert.equal(bytes.length, transport.observedBytes); assert.equal(bytes.length, transport.retainedPrefixBytes);
    for (const key of ['observedPrefixSha256', 'retainedPrefixSha256', 'responseSha256']) assert.equal(transport[key], sha(bytes));
    const response = JSON.parse(record.responseText);
    assert.deepEqual(keys(response), ['id', 'jsonrpc', 'result']); assert.equal(response.id, record.id); assert.equal(response.jsonrpc, '2.0');
  }
  assert.ok(retainedBytes <= (profile === 'sequence' ? 128 : 32) * 1024 * 1024);
  return { rpcCalls: records.length, observedBytes, retainedBytes, durationMs, withheldErrorBodies: withheld };
}


function validateGenerated(report) {
  assert.match(report.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  timestamp(report.createdAt); assert.deepEqual(keys(report.timing), ['rpcMs', 'totalMs']);
  finiteTime(report.timing.totalMs); finiteTime(report.timing.rpcMs);
  for (const record of report.transportEvidence) finiteTime(record.transport.durationMs);
}
export function semanticReport(report) {
  validateGenerated(report);
  const result = structuredClone(report);
  delete result.id; delete result.createdAt; delete result.timing;
  for (const record of result.transportEvidence) delete record.transport.durationMs;
  return result;
}

async function invokeHandler(server, request) {
  const req = Readable.from([Buffer.from(request.bodyText)]);
  Object.assign(req, { method: request.method, url: request.path, headers: { host: '127.0.0.1:5174', 'content-type': request.contentType } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Archived in-memory API did not complete within the offline bound.')), 10000);
      const res = { statusCode: 200, writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
        end(body) { resolve({ status: this.statusCode, bodyText: Buffer.from(body ?? '').toString('utf8') }); return this; } };
      server.emit('request', req, res);
    });
  } finally { clearTimeout(timer); }
}

export async function replayExchange(exchange, plan, runtime, profile) {
  const saved = JSON.parse(exchange.response.bodyText), records = saved.transportEvidence;
  let cursor = 0, factories = 0;
  const mismatches = [], consumed = [];
  const rpc = new runtime.StandardRpcClient({ url: plan.provider, profile, fetchImpl: async (url, options) => {
    const index = cursor++, record = records[index];
    try {
      assert.ok(record, 'No extra request may use an invented response.');
      assert.equal(url.href, plan.provider + '/'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { 'content-type': 'application/json' });
      assert.equal(options.body, record.requestText, 'Exact original wire request/order is required.');
      assert.deepEqual(JSON.parse(options.body), record.request);
      assert.equal(record.error, undefined); assert.equal(record.transport.bodyRetained, true);
      assert.equal(sha(record.responseText), record.transport.responseSha256);
      consumed.push(record.id);
      return new Response(record.responseText, { status: record.httpStatus });
    } catch {
      // API/engine code can catch transport assertions. Retain an independent
      // latch and inspect it outside the complete handler before any pass.
      mismatches.push(index + 1); throw new Error('Recorded RPC wire mismatch.');
    }
  } });
  const server = runtime.createAppServer({ persist: false, standardRpcFactory(options) { factories++; if (options?.profile !== profile) mismatches.push('wrong_profile'); return rpc; }, rpcFactory() {
    mismatches.push('unexpected_legacy_provider'); throw new Error('A legacy provider is outside this playback.');
  } });
  const replayed = await invokeHandler(server, exchange.request);
  assert.deepEqual(mismatches, [], 'RPC mismatches were latched outside the API and engine.');
  assert.equal(factories, 1); assert.equal(cursor, records.length); assert.deepEqual(consumed, records.map(record => record.id));
  assert.equal(new Set(consumed).size, consumed.length);
  assert.equal(replayed.status, exchange.response.status);
  assert.deepEqual(semanticReport(JSON.parse(replayed.bodyText)), semanticReport(saved), 'Every nongenerated API/result/wire field must reproduce exactly.');
  return { status: 'matched', consumedRpcIds: consumed, excludedGeneratedFields: ['id', 'createdAt', 'timing', 'transportEvidence[].transport.durationMs'] };
}


function recordAt(report,id){assert.ok(Number.isInteger(id)&&id>=1);const e=report.evidence[id-1];assert.equal(e?.id,id);assert.equal(e.error,undefined);assert.ok(own(e,'result'));return e;}
function unique(report,predicate){const rows=report.evidence.filter(predicate);assert.equal(rows.length,1);return rows[0];}
function options(diff,state){return{tracer:diff?'prestateTracer':'callTracer',timeout:'15s',tracerConfig:diff?{diffMode:true}:{withLog:true},...(state===null?{}:{stateOverrides:state})};}
function engineOnly(report){const copy=structuredClone(report);for(const k of ['apiRequest','source','preview'])delete copy[k];return copy;}

// This canonicalizer and composer do not import the engine's state helpers.
// Raw codeHash claims are checked with only the archived Keccak primitive.
export function normalizeDiff(raw,keccak){
  assert.deepEqual(keys(raw),['post','pre']);const out={pre:{},post:{}};let accounts=0,slots=0;
  for(const phase of ['pre','post']){assert.ok(plain(raw[phase]));for(const [address,item]of Object.entries(raw[phase])){
    assert.match(address,/^0x[0-9a-f]{40}$/i);const a=address.toLowerCase();assert.equal(own(out[phase],a),false);assert.ok(++accounts<=200&&plain(item));
    assert.ok(keys(item).every(k=>['balance','nonce','code','storage','codeHash'].includes(k)));
    const value={};for(const k of ['balance','nonce'])if(own(item,k)){value[k]=q(item[k]).toString();if(k==='nonce')assert.ok(q(item[k])<(1n<<64n));}
    if(own(item,'code')){assert.equal(typeof item.code,'string');assert.match(item.code,/^0x(?:[0-9a-f]{2})*$/i);assert.ok(item.code.length<=262146);value.code=item.code.toLowerCase();}
    if(own(item,'codeHash')){assert.match(item.codeHash,/^0x[0-9a-f]{64}$/i);assert.equal(typeof value.code,'string');assert.equal('0x'+Buffer.from(keccak(Buffer.from(value.code.slice(2),'hex'))).toString('hex'),item.codeHash.toLowerCase());}
    if(own(item,'storage')){assert.ok(plain(item.storage));value.storage={};for(const [key,word]of Object.entries(item.storage)){assert.match(key,/^0x[0-9a-f]{64}$/i);assert.equal(typeof word,'string');assert.match(word,/^0x[0-9a-f]{64}$/i);assert.equal(own(value.storage,key.toLowerCase()),false);assert.ok(++slots<=4000);value.storage[key.toLowerCase()]=word.toLowerCase();}}
    out[phase][a]=value;
  }}return out;
}
export function composeState(previous,diff){
  assert.deepEqual(keys(diff.pre),keys(diff.post),'This fixed packet has no account lifecycle transition.');
  const out=structuredClone(previous??{});
  for(const account of keys(diff.pre)){
    const pre=diff.pre[account],post=diff.post[account],old=out[account]??{},next={...old};
    if(own(post,'code'))assert.equal(post.code,pre.code,'Runtime code cannot change.');
    for(const field of ['nonce','balance'])if(own(old,field)&&own(pre,field))assert.equal(q(old[field]),q(pre[field]),'Carried basic state must match the next full original prestate.');
    for(const field of ['nonce','balance'])if(own(post,field))next[field]=hex(post[field]);
    const touched=[...new Set([...keys(pre.storage??{}),...keys(post.storage??{})])].sort();
    if(touched.length){next.stateDiff={...(old.stateDiff??{})};for(const slot of touched){if(own(old.stateDiff??{},slot))assert.equal(old.stateDiff[slot],pre.storage?.[slot]??ZERO,'Carried storage must match the next original prestate.');next.stateDiff[slot]=post.storage?.[slot]??ZERO;}}
    if(keys(next).length)out[account]=next;
  }
  const sorted={};for(const a of keys(out)){sorted[a]={};for(const k of ['balance','nonce'])if(own(out[a],k))sorted[a][k]=out[a][k];if(out[a].stateDiff)sorted[a].stateDiff=Object.fromEntries(keys(out[a].stateDiff).map(s=>[s,out[a].stateDiff[s]]));}return sorted;
}
function nonceOnly(raw,sender,nonce,balance){
  assert.deepEqual(keys(raw),['post','pre']);assert.deepEqual(keys(raw.pre),[sender]);assert.deepEqual(keys(raw.post),[sender]);
  const a=raw.pre[sender],b=raw.post[sender];for(const row of[a,b])assert.ok(keys(row).every(k=>['balance','nonce'].includes(k)));
  const pre=(k,n)=>own(a,k)?q(a[k]):(assert.equal(n,0n),0n);
  assert.equal(pre('nonce',nonce),nonce);assert.equal(pre('balance',balance),balance);assert.equal(q(b.nonce),nonce+1n);if(own(b,'balance'))assert.equal(q(b.balance),balance);
}
function rootTrace(raw,call){
  assert.equal(raw.type,'CALL');assert.equal(raw.from,call.from);assert.equal(raw.to,call.to);assert.equal(raw.input,call.data);assert.equal(q(raw.value??'0'),q(call.value));assert.equal(q(raw.gas),q(call.gas));assert.ok(q(raw.gasUsed)>0n&&q(raw.gasUsed)<=q(call.gas));
}
function queryWord(raw,call){
  rootTrace(raw,call);assert.match(raw.output,/^0x[0-9a-f]{64}$/i);let frames=0;
  function walk(frame,context,depth){assert.ok(++frames<=1000&&depth<=32);assert.equal(frame.error,undefined);assert.equal(frame.revertReason,undefined);assert.equal(q(frame.value??'0'),0n);assert.deepEqual(frame.logs??[],[]);assert.ok(q(frame.gasUsed)<=q(frame.gas)&&q(frame.gas)<=q(call.gas));assert.match(frame.input,/^0x(?:[0-9a-f]{2})*$/i);assert.match(frame.output,/^0x(?:[0-9a-f]{2})*$/i);assert.match(frame.from,/^0x[0-9a-f]{40}$/);assert.match(frame.to,/^0x[0-9a-f]{40}$/);assert.ok(Array.isArray(frame.calls??[]));
    for(const child of frame.calls??[]){assert.ok(['STATICCALL','DELEGATECALL'].includes(child.type));assert.equal(child.from,context);if(child.type==='DELEGATECALL'){assert.equal(child.input,frame.input);assert.equal(child.output,frame.output);}walk(child,child.type==='DELEGATECALL'?context:child.to,depth+1);}}
  walk(raw,raw.to,0);return q(raw.output);
}
function contextHeader(report,previousHeader){
  const start=unique(report,e=>e.method==='eth_getBlockByHash');assert.deepEqual(start.params,[report.request.block.blockHash,false]);assert.equal(start.result.hash,report.request.block.blockHash);
  if(previousHeader)assert.deepEqual(start.result,previousHeader,'Every step has the same complete source header.');
  const end=unique(report,e=>e.method==='eth_getBlockByNumber');assert.deepEqual(end.params,[hex(start.result.number),false]);assert.deepEqual(end.result,start.result,'Full final header must be unchanged.');
  return start.result;
}
function anchor(report,method,account){const e=unique(report,e=>e.method===method&&e.params[0]===account);assert.deepEqual(e.params,[account,report.request.block]);return q(e.result);}

export function validateStep(report,{input,shared,previous=null,previousReport=null,previousHeader=null,stepIndex=0,keccak}){
  assert.equal(report.canonicalStatus,'verified');assert.deepEqual(report.security,{status:'not_assessed'});assert.equal(report.scope.allEffectsCoverage,'inconclusive');
  const call={from:shared.from,to:input.to,data:input.data,gas:'0x4c4b40',value:'0x0'};
  const pinned={blockHash:shared.block,requireCanonical:true};assert.deepEqual(report.request.transaction,call);assert.deepEqual(report.request.block,pinned);
  assert.deepEqual(report.apiRequest,{chainId:1,from:shared.from,...input,block:shared.block});
  const header=contextHeader(report,previousHeader),sender=call.from;
  const pinnedNonce=anchor(report,'eth_getTransactionCount',sender),balance=anchor(report,'eth_getBalance',sender);
  const nonce=previous?.[sender]?.nonce===undefined?pinnedNonce:q(previous[sender].nonce);
  assert.equal(nonce,pinnedNonce+BigInt(stepIndex));assert.equal(previous?.[sender]?.balance,undefined,'These cases do not transfer native value.');
  if(previous){assert.equal(report.startingState.priorCalls,stepIndex);assert.equal(report.startingState.kind,'after_previous_simulation');assert.deepEqual(report.startingState.overrides,previous);assert.equal(report.startingState.completeOverridesSha256,jsonSha(previous));assert.equal(report.startingState.previousResultSha256,jsonSha(engineOnly(previousReport)));}
  else assert.equal(report.startingState,undefined);
  const original=unique(report,e=>e.method==='debug_traceCall'&&e.params[2]?.tracer==='callTracer'&&e.params[0]?.gas==='0x4c4b40');
  assert.deepEqual(original.params,[call,pinned,options(false,previous)]);assert.deepEqual(original.result,report.execution.trace);rootTrace(original.result,call);
  assert.equal(report.preview.nativeBalances.length,0);
  if(report.execution.status==='reverted_or_failed'){
    assert.equal(typeof original.result.error,'string');assert.ok(original.result.error.length>0);assert.equal(report.measurements.length,0);assert.equal(report.stateDiff,undefined);assert.equal(report.nativeEffects.status,'not_applicable');
    return{status:'reverted_or_failed',header,overrides:previous,measurements:[],originalTraceEvidenceId:original.id,revertReason:report.execution.revertReason};
  }
  assert.equal(report.execution.status,'success');assert.equal(original.result.error,undefined);assert.equal(original.result.revertReason,undefined);
  assert.deepEqual(report.nativeEffects,{status:'none',feeScope:'excluded',maxAccounts:8,candidates:[],selectedAccounts:[],netValueByAccount:{},counts:{candidates:0,selected:0,omitted:0,measured:0},measurements:[]});
  const rawDiff=unique(report,e=>e.method==='debug_traceCall'&&e.params[2]?.tracer==='prestateTracer'&&e.params[0]?.gas==='0x4c4b40');assert.deepEqual(rawDiff.params,[call,pinned,options(true,previous)]);
  const diff=normalizeDiff(rawDiff.result,keccak);assert.deepEqual(diff,report.stateDiff);const after=composeState(previous,diff);
  assert.equal(q(diff.pre[sender].nonce),nonce);assert.equal(q(diff.post[sender].nonce),nonce+1n);assert.equal(q(diff.pre[sender].balance),balance);if(own(diff.post[sender],'balance'))assert.equal(q(diff.post[sender].balance),balance);
  assert.deepEqual(keys(diff.pre[sender]),['balance','nonce']);assert.deepEqual(keys(diff.post[sender]),['nonce']);
  assert.equal(report.executionIdentity.completeOverridesSha256,jsonSha(after));assert.equal(report.executionIdentity.originalEnvelopeSha256,jsonSha(call));assert.equal(report.executionIdentity.stateBlockHash,shared.block);assert.equal(report.executionIdentity.executionBaseFee,'0');
  // Check both synthetic header witness contexts independently, including the
  // complete carried state and the exact eight returned environmental words.
  const witnesses=report.evidence.filter(e=>e.method==='debug_traceCall'&&e.params[0]?.to===PROBE);assert.equal(witnesses.length,2);
  const code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(q(header.number)-1n).toString(16).padStart(64,'0')+'4060e0526101006000f3';
  const probe={from:sender,to:PROBE,data:'0x',value:'0x0',gas:'0x493e0'};
  for(const [i,w]of witnesses.entries()){assert.deepEqual(w.params,[probe,pinned,options(false,{...(i?after:previous??{}),[PROBE]:{code}})]);rootTrace(w.result,probe);assert.equal(w.result.error,undefined);assert.deepEqual(w.result.calls??[],[]);assert.deepEqual(w.result.logs??[],[]);assert.match(w.result.output,/^0x[0-9a-f]{512}$/);const words=Array.from({length:8},(_,j)=>q('0x'+w.result.output.slice(2+64*j,66+64*j)));assert.deepEqual(words,[header.number,header.timestamp,header.gasLimit,'0',header.mixHash,header.miner,'1',header.parentHash].map(q));}
  assert.deepEqual(report.request.queries,report.discovery.queries);assert.deepEqual(report.measurements.map(m=>m.query),report.discovery.queries);assert.deepEqual(report.discovery.candidates.filter(c=>c.selection==='selected').map(c=>c.query),report.discovery.queries);
  const decoded=[];for(const[index,row]of report.measurements.entries()){
    assert.equal(row.status,'measured');assert.deepEqual(row.queryEvidence.map(x=>x.state),['before','after']);const values=[];
    for(const proof of row.queryEvidence){const isAfter=proof.state==='after',trace=recordAt(report,proof.traceEvidenceId),mutation=recordAt(report,proof.mutationEvidenceId),query={from:sender,...row.query,value:'0x0',gas:'0x493e0'},state=isAfter?after:previous;
      assert.equal(trace.method,'debug_traceCall');assert.deepEqual(trace.params,[query,pinned,options(false,state)]);assert.equal(mutation.method,'debug_traceCall');assert.deepEqual(mutation.params,[query,pinned,options(true,state)]);
      values.push(queryWord(trace.result,query));nonceOnly(mutation.result,sender,nonce+(isAfter?1n:0n),balance);
    }
    assert.equal(row.beforeRaw,values[0].toString());assert.equal(row.afterRaw,values[1].toString());assert.equal(row.deltaRaw,(values[1]-values[0]).toString());for(const field of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(report.preview.queries[index][field],row[field]);
    decoded.push({query:row.query,beforeRaw:row.beforeRaw,afterRaw:row.afterRaw,deltaRaw:row.deltaRaw,queryEvidence:row.queryEvidence});
  }
  return{status:'success',header,overrides:after,measurements:decoded,originalTraceEvidenceId:original.id,originalDiffEvidenceId:rawDiff.id,completeOverridesSha256:jsonSha(after)};
}

export function validateReport(report,planned,keccak){
  assert.deepEqual(report.apiRequest,planned.input);assert.equal(report.canonicalStatus,'verified');assert.deepEqual(report.security,{status:'not_assessed'});
  const shared={chainId:1,from:planned.input.from,block:planned.input.block};
  if(planned.profile==='single'){
    const {to,data,value}=planned.input;const check=validateStep(report,{input:{to,data,value},shared,keccak});assert.equal(check.status,'reverted_or_failed');assert.equal(check.revertReason,'ERC20: transfer amount exceeds allowance');return[check];
  }
  assert.equal(report.scope.atomic,false);assert.equal(report.scope.queryMutationsCarried,false);assert.equal(report.scope.fees,'excluded');assert.equal(report.scope.allEffectsCoverage,'inconclusive');assert.equal(report.steps.length,planned.input.calls.length);
  const decoded=[];let previous=null,previousReport=null,header=null;
  for(const [index,step]of report.steps.entries()){
    assert.equal(step.index,index);assert.deepEqual(step.input,planned.input.calls[index]);assert.deepEqual(step.stateSource,index?{kind:'after_step',stepIndex:index-1}:{kind:'initial_block'});
    assert.equal(step.status,index<2?'completed':'reverted_or_failed');
    const check=validateStep(step.result,{input:step.input,shared,previous,previousReport,previousHeader:header,stepIndex:index,keccak});decoded.push(check);header=check.header;
    if(check.status==='success'){previous=check.overrides;previousReport=step.result;}
  }
  assert.deepEqual(report.sequence,report.steps.length===2?{status:'completed',completedSteps:2,attemptedSteps:2}:{status:'stopped',completedSteps:2,attemptedSteps:3,stoppedAtIndex:2,reason:'Original execution did not succeed.'});
  assert.equal(report.finalVerification.method,'eth_getBlockByNumber');assert.deepEqual(report.finalVerification.params,[hex(header.number),false]);assert.deepEqual(report.finalVerification.result,header);
  assert.deepEqual(decoded.map(x=>x.measurements.length),report.steps.length===2?[1,4]:[1,4,0]);
  return decoded;
}

async function bound(root,relative,expectedSha,expectedBytes){
  const absolute=path.resolve(root,relative);assert.ok(absolute.startsWith(root+path.sep));assert.equal(await fs.realpath(absolute),absolute);const b=await fs.readFile(absolute);if(expectedSha!==undefined)assert.equal(sha(b),expectedSha,relative);if(expectedBytes!==undefined)assert.equal(b.length,expectedBytes,relative);return b;
}
async function inventory(root,relative){const rows=[];async function walk(p){for(const e of await fs.readdir(path.join(root,p),{withFileTypes:true})){assert.equal(e.isSymbolicLink(),false);const n=p+'/'+e.name;if(e.isDirectory())await walk(n);else{assert.ok(e.isFile());rows.push(n);}}}await walk(relative);return rows.sort();}
export async function loadPacket(directory=here){
  directory=await fs.realpath(directory);const read=async(p,hash)=>JSON.parse((await bound(directory,p,hash)).toString('utf8'));
  const plan=await read('plan.json',PLAN_SHA256),manifest=await read('manifest.json',MANIFEST_SHA256);
  assert.equal(plan.schemaVersion,'1.0');assert.equal(plan.developmentOnly,true);assert.equal(plan.chainId,1);assert.equal(plan.provider,'https://eth.drpc.org');assert.deepEqual(plan.cases.map(x=>x.id),CASE_IDS);assert.deepEqual(plan.cases.map(x=>x.profile),['single','sequence','sequence']);assert.deepEqual(plan.cases.map(x=>x.route),['/api/evm/simulate','/api/evm/simulate-sequence','/api/evm/simulate-sequence']);
  assert.deepEqual(plan.implementation,{name:'Transaction Lab Ethereum preview',version:'0.12.0',sourceSha256:IMPLEMENTATION_SHA256,sourceFiles:IMPLEMENTATION_FILES});
  assert.deepEqual(plan.sources.map(x=>x.path),ARCHIVE_FILES);assert.deepEqual(plan.inputs.map(x=>x.path),INPUT_FILES);
  assert.equal(manifest.planSha256,PLAN_SHA256);assert.equal(manifest.implementationSha256,IMPLEMENTATION_SHA256);assert.equal(manifest.sourceFiles,52);assert.equal(manifest.capturedRequests,3);assert.equal(manifest.files.length,73);
  assert.deepEqual(manifest.plannedCases,plan.cases.map(({id,route,profile,input,requestSha256})=>({id,route,profile,input,requestSha256})));
  const expected=[...ARCHIVE_FILES.map(x=>'source/'+x),...INPUT_FILES,'run.mjs','freeze.mjs','plan.json','FROZEN.json','STARTED.json','results.json','rpc-evidence.json',...CASE_IDS.map(id=>id+'-response.json'),...[1,2,3].flatMap(i=>['http/','client/'].map(s=>s+String(i).padStart(3,'0')+'.json'))].sort();
  assert.deepEqual(manifest.files.map(x=>x.path),expected);assert.equal(new Set(expected).size,73);
  for(const f of manifest.files){assert.deepEqual(keys(f),['bytes','path','sha256']);await bound(directory,f.path,f.sha256,f.bytes);}
  for(const source of plan.sources)assert.deepEqual(manifest.files.find(x=>x.path==='source/'+source.path),{...source,path:'source/'+source.path});
  for(const input of plan.inputs)assert.deepEqual(manifest.files.find(x=>x.path===input.path),{path:input.path,bytes:input.bytes,sha256:input.sha256});
  for(const name of ['run.mjs','freeze.mjs']){const src=plan.sources.find(x=>x.path==='reports/standard-evm-sequence/'+name);assert.deepEqual(manifest.files.find(x=>x.path===name),{...src,path:name});}
  assert.deepEqual(await inventory(directory,'source'),ARCHIVE_FILES.map(x=>'source/'+x));assert.deepEqual(await inventory(directory,'inputs'),[...INPUT_FILES].sort());
  for(const prefix of ['http','client'])assert.deepEqual(await inventory(directory,prefix),[1,2,3].map(i=>prefix+'/'+String(i).padStart(3,'0')+'.json'));
  const digest=createHash('sha256');for(const p of IMPLEMENTATION_FILES)digest.update(p+'\0').update(await bound(directory,'source/'+p)).update('\0');assert.equal(digest.digest('hex'),IMPLEMENTATION_SHA256);
  const frozen=await read('FROZEN.json');assert.deepEqual(frozen,{schemaVersion:'1.0',frozenAt:plan.frozenAt,planSha256:PLAN_SHA256,implementationSha256:IMPLEMENTATION_SHA256,sourceFiles:52,cases:3});
  const started=await read('STARTED.json');assert.deepEqual(started,{schemaVersion:'1.0',startedAt:started.startedAt,planSha256:PLAN_SHA256,implementation:plan.implementation,sourceFiles:plan.sources,cases:plan.cases.map(x=>({id:x.id,requestSha256:x.requestSha256})),provider:plan.provider,limits:plan.limits});assert.ok(timestamp(started.startedAt)>=timestamp(plan.frozenAt));
  const discovery=await read(INPUT_FILES[0]),original=await read(INPUT_FILES[1]),supplement=await read(INPUT_FILES[3]);assert.equal(original.status,'incomplete_or_failed_fixed_candidate');assert.equal(supplement.status,'usable_synthetic_sequence_with_preserved_initial_incomplete_packet');
  const step=x=>{assert.equal(x.value,'0x0');assert.equal(x.gas,'0x4c4b40');return{to:x.to,data:x.data,value:'0'};},approval=step(discovery.approval),supply=step(discovery.supply),shared={chainId:1,from:discovery.sender,block:discovery.blockHash};
  assert.deepEqual(plan.cases.map(x=>x.input),[{...shared,...supply},{...shared,calls:[approval,supply]},{...shared,calls:[approval,supply,supply]}]);
  for(const c of plan.cases){assert.equal(c.requestText,JSON.stringify(c.input));assert.equal(c.requestBytes,Buffer.byteLength(c.requestText));assert.equal(c.requestSha256,sha(c.requestText));assert.equal(c.provenance.syntheticUnsignedSequence,true);assert.equal(c.provenance.exactHistoricalReplay,false);}
  // Only after every archived byte and the complete dependency inventory are
  // verified may the old application and the primitive hash library be loaded.
  const src=p=>pathToFileURL(path.join(directory,'source',p)).href;
  const runtime={...await import(src('src/server.js')),...await import(src('src/standard-rpc.js'))};
  const api=await(await import(src('src/standard-loader.js'))).loadStandardApi();assert.ok(api);assert.deepEqual(api.implementation,plan.implementation);
  const {keccak_256:keccak}=await import(src(noble+'/sha3.js'));
  return{directory,read,plan,manifest,started,runtime,keccak};
}

function checkEngineEvidence(report,records){
  const parts=report.steps?report.steps.map(s=>s.result):[report];let cursor=0;
  for(const [stepIndex,part]of parts.entries()){
    assert.equal(part.accounting.rpcCalls,part.evidence.length);let bytes=0;
    for(const [index,e]of part.evidence.entries()){
      const wire=records[cursor],body=JSON.parse(wire.responseText);assert.equal(e.id,index+1);assert.equal(e.method,wire.request.method);assert.deepEqual(e.params,wire.request.params);assert.deepEqual(e.result,body.result);assert.equal(e.error,undefined);bytes+=Buffer.byteLength(JSON.stringify(body.result));
      if(report.steps)assert.deepEqual(report.sequenceEvidence[cursor],{id:cursor+1,stepIndex,method:e.method,paramsSha256:jsonSha(e.params),resultBytes:Buffer.byteLength(JSON.stringify(e.result)),resultSha256:jsonSha(e.result)});cursor++;
    }
    assert.equal(part.accounting.retainedResultBytes,bytes);
  }
  if(report.steps){const wire=records[cursor],final=report.finalVerification,body=JSON.parse(wire.responseText);assert.deepEqual(final,{sequenceEvidenceId:cursor+1,method:wire.request.method,params:wire.request.params,result:body.result});assert.deepEqual(report.sequenceEvidence[cursor],{id:cursor+1,kind:'final_canonical_check',method:wire.request.method,paramsSha256:jsonSha(wire.request.params),resultBytes:Buffer.byteLength(JSON.stringify(body.result)),resultSha256:jsonSha(body.result)});cursor++;assert.equal(report.sequenceEvidence.length,cursor);}
  assert.equal(cursor,records.length);assert.equal(report.accounting.rpcCalls,cursor);assert.equal(report.accounting.retainedResultBytes,records.reduce((s,r)=>s+Buffer.byteLength(JSON.stringify(JSON.parse(r.responseText).result)),0));
}

export async function verify({directory=here}={}){
  const packet=await loadPacket(directory),{read,plan,manifest,started,runtime,keccak}=packet;
  const results=await read('results.json'),rpc=await read('rpc-evidence.json');
  assert.equal(results.planSha256,PLAN_SHA256);assert.deepEqual(results.implementation,plan.implementation);assert.equal(results.developmentOnly,true);assert.equal(results.planned,3);assert.equal(results.attempted,3);assert.equal(results.retries,0);assert.equal(results.replacements,0);assert.equal(results.sourceUnchanged,true);assert.equal(results.status,'completed');assert.equal(results.fatal,null);assert.deepEqual(results.violations,[]);finiteTime(results.durationMs);assert.ok(results.durationMs<=720000+10000);assert.ok(timestamp(results.completedAt)>=timestamp(started.startedAt));assert.ok(timestamp(manifest.sealedAt)>=timestamp(results.completedAt));
  assert.deepEqual(results.cases.map(x=>x.id),CASE_IDS);assert.deepEqual(rpc.clients.map(x=>x.caseId),CASE_IDS);const cases=[];let totalBytes=0,totalCalls=0,last=timestamp(started.startedAt);
  for(const [index,planned]of plan.cases.entries()){
    const stem=String(index+1).padStart(3,'0'),exchange=await read('http/'+stem+'.json'),client=await read('client/'+stem+'.json'),report=await read(planned.id+'-response.json');
    assert.equal(exchange.index,index+1);assert.equal(exchange.caseId,planned.id);assert.deepEqual(exchange.request,{method:'POST',path:planned.route,contentType:'application/json',bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});assert.equal(client.caseId,planned.id);assert.deepEqual(client.request,{method:'POST',path:planned.route,bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});
    assert.ok(timestamp(client.startedAt)>=last);assert.ok(timestamp(exchange.startedAt)>=timestamp(client.startedAt));assert.ok(timestamp(exchange.completedAt)<=timestamp(client.completedAt));last=timestamp(client.completedAt);finiteTime(client.durationMs);
    assert.equal(exchange.response.status,200);assert.equal(exchange.response.complete,true);assert.equal(exchange.response.bytes,Buffer.byteLength(exchange.response.bodyText));assert.equal(exchange.response.observedBytes,exchange.response.bytes);assert.equal(exchange.response.sha256,sha(exchange.response.bodyText));assert.deepEqual(JSON.parse(exchange.response.bodyText),report);
    assert.equal(client.error,undefined);assert.deepEqual(client.response,{status:200,complete:true,bodyText:exchange.response.bodyText,observedBytes:exchange.response.bytes,retainedBytes:exchange.response.bytes,observedPrefixSha256:exchange.response.sha256,retainedPrefixSha256:exchange.response.sha256});
    assert.deepEqual(report.implementation,plan.implementation);validateGenerated(report);assert.ok(timestamp(report.createdAt)>=timestamp(exchange.startedAt)&&timestamp(report.createdAt)<=timestamp(exchange.completedAt));
    assert.deepEqual(report.source.blockSelection,{requested:planned.input.block,kind:'pinned_hash',resolvedHash:planned.input.block,resolvedNumber:null,evidence:null});
    const saved=rpc.clients[index];assert.equal(saved.profile,planned.profile);assert.equal(saved.provider,plan.provider);assert.deepEqual(saved.records,report.transportEvidence);
    const accounting=validateTransport(saved.records,planned.profile);assert.equal(accounting.withheldErrorBodies,0);assert.equal(saved.observedBytes,accounting.observedBytes);totalBytes+=accounting.observedBytes;totalCalls+=accounting.rpcCalls;checkEngineEvidence(report,saved.records);
    const decoded=validateReport(report,planned,keccak);
    const summary=results.cases[index];assert.equal(summary.sequenceStatus,report.sequence?.status??null);assert.deepEqual(summary.sequence,report.sequence??null);assert.equal(summary.canonicalStatus,report.canonicalStatus);assert.equal(summary.rpcCalls,accounting.rpcCalls);assert.equal(summary.observedResponseBytes,accounting.observedBytes);assert.equal(summary.attempted,true);assert.equal(summary.httpStatus,200);assert.equal(summary.complete,true);assert.equal(summary.profile,planned.profile);assert.equal(summary.route,planned.route);
    const playback=await replayExchange(exchange,plan,runtime,planned.profile);
    cases.push({id:planned.id,profile:planned.profile,httpStatus:200,canonicalStatus:report.canonicalStatus,sequence:report.sequence??null,accounting,steps:decoded.map(({header,overrides,...rest})=>rest),playback});
  }
  assert.equal(rpc.rpcCalls,totalCalls);assert.equal(rpc.publicDispatches,totalCalls);assert.equal(rpc.observedResponseBytes,totalBytes);assert.equal(totalCalls,112);assert.equal(totalBytes,457073);assert.ok(totalCalls<=600&&totalBytes<=288*1024*1024);for(const k of ['rpcCalls','publicDispatches','observedResponseBytes'])assert.equal(results[k],rpc[k]);
  return{status:'passed',planSha256:PLAN_SHA256,manifestSha256:MANIFEST_SHA256,implementationSha256:IMPLEMENTATION_SHA256,sourceFiles:52,sealedFiles:73,publicNetworkRequests:0,socketsOpened:0,liveSourceImports:0,replayMode:'archived_createAppServer_handler_with_archived_StandardRpcClient_and_exact_saved_wire_responses',totals:{rpcCalls:totalCalls,responseBytes:totalBytes,independentlyDecodedMeasurements:cases.flatMap(x=>x.steps).reduce((n,s)=>n+s.measurements.length,0)},cases,
    limitations:['Three fixed constructed development examples at one historical block end; no coverage denominator or vendor/security score.','Read-only unsigned provider simulations exclude fee settlement, signatures and original historical transaction-position replay.','Independent consistency checks use provider-supplied traces/diffs; archived handler playback is reproducibility, not an independent execution oracle.','Token labels/decimals remain historical references, not current-state metadata attestations.','Only returned measurement words determine amounts; events and discovery candidates are not measurements.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,2);process.stdout.write(JSON.stringify(await verify(),null,2)+'\n');}
