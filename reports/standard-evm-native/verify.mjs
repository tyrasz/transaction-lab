// Independent offline checks. Measurements are decoded from recorded query
// outputs and pinned anchors, never from the candidate CALL-value model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const keys = value => Object.keys(value).sort();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROBE = '0x000000000000000000000000000000000000ba1a';
const MAX = (1n << 256n)-1n, ZERO_WORD = '0x'+'0'.repeat(64);
const quantity = value => { assert.equal(typeof value,'string');assert.match(value,/^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i);const n=BigInt(value);assert.ok(n>=0n&&n<=MAX);return n; };
const hex = value => '0x'+quantity(String(value)).toString(16);
const own = (value, field) => Object.hasOwn(value,field);
function timestamp(value) { assert.equal(new Date(value).toISOString(),value);return Date.parse(value); }
const finiteTime = value => assert.ok(Number.isFinite(value)&&value>=0);
// Filled only from the independently released immutable packet, never by
// reading a mutable manifest and treating its own hash as expected evidence.
export const PLAN_SHA256 = 'ba57bd952efd6bef3ac50d09a7969241666506b57498f6566a178f13399bb908';
export const MANIFEST_SHA256 = '75ba63b9da1d90f31346e518908bff8c69aad76bcdf910669d371349758e5d70';
export const IMPLEMENTATION_SHA256 = '5e915486d876ad4bab26490ec807c599b5a5bb1df683481bebffa2adb71e9c60';
const noble='engines/standard-evm/node_modules/@noble/hashes';
export const IMPLEMENTATION_FILES=[
  'package.json','src/config.js','src/server.js','src/validate.js','src/standard-loader.js','src/standard-rpc.js','src/standard-simulation.js',
  'src/rpc.js','src/state.js','src/state-diff.js','src/query-validation.js','src/account-effects.js','src/affected-balances.js','src/allowances.js',
  'src/analyze.js','src/balances.js','src/current-state.js','src/historical-state.js','src/lending-balances.js','src/lending.js','src/permissions.js','src/revert.js',
  'engines/standard-evm/discovery.js','engines/standard-evm/native-effects.js','engines/standard-evm/package.json','engines/standard-evm/package-lock.json',
  'engines/standard-evm/unsigned-call.js','engines/standard-evm/provider-state-diff.js',...['package.json','sha3.js','_u64.js','utils.js'].map(name=>noble+'/'+name),
].sort();
export const ARCHIVE_FILES=[...IMPLEMENTATION_FILES,noble+'/LICENSE','public/app.js','public/index.html','public/style.css',
  'reports/standard-evm-native/run.mjs','reports/standard-evm-native/freeze.mjs'].sort();
export const INPUT_FILES=[
  {path:'inputs/native-index.json',originalPath:'reports/standard-evm-native-discovery/index.json',sha256:'f4026a6a4eab5a8d1896a7953dd8af853ac7d65994dc368e7da129ddd17880fa'},
  {path:'inputs/native-capture.json',originalPath:'reports/standard-evm-native-discovery/capture.json',sha256:'59cf2cc3d92100ca62f9b13e69386ce4386bf308ca40f595904e9aab013a6b5c'},
  {path:'inputs/native-manifest.json',originalPath:'reports/standard-evm-native-discovery/manifest.json',sha256:'13a4087b44b2455860136f06aed3dd2ee9a2d87be367edcf2e25949dd4fadeda'},
  {path:'inputs/swap-response.json',originalPath:'reports/standard-evm-auto/swap-response.json',sha256:'2c28a1db535d44c493d51e6a6c01b9bcbfab50af66b033f043c67b07c4df0ff2'},
  {path:'inputs/aave-response.json',originalPath:'reports/standard-evm-auto/aave-response.json',sha256:'2fea1f944225742955948d2d9e93142095f9a78f7b1edb5f26047613a222388c'},
];
export const CASE_IDS=['native-transfer','internal-eth-swap','aave-no-native'];
const LIMITS={cases:3,rpcCallsPerCase:65,totalRpcCalls:195,rpcResponseBytes:8388608,rpcTotalBytesPerCase:33554432,rpcTotalBytes:100663296,rpcRequestMs:25000,rpcWallMs:145000,httpRequestMs:160000,httpResponseBytes:134217728,closeGraceMs:5000,retries:0};

export function validatePlan(plan) {
  assert.equal(plan.schemaVersion,'1.0');assert.equal(plan.developmentOnly,true);assert.equal(plan.provider,'https://eth.drpc.org');assert.equal(plan.chainId,1);
  assert.equal(plan.route,'/api/evm/simulate');assert.equal(plan.method,'POST');assert.deepEqual(plan.limits,LIMITS);timestamp(plan.frozenAt);
  assert.deepEqual(plan.implementation,{name:'Transaction Lab Ethereum preview',version:'0.11.0',sourceSha256:IMPLEMENTATION_SHA256,sourceFiles:IMPLEMENTATION_FILES});
  assert.deepEqual(plan.sources.map(source=>source.path),ARCHIVE_FILES);assert.deepEqual(plan.inputs.map(({bytes,...rest})=>rest),INPUT_FILES);
  assert.deepEqual(plan.cases.map(item=>item.id),CASE_IDS);
  for(const item of plan.cases) {
    assert.equal(item.input.chainId,1);assert.equal(own(item.input,'queries'),false);assert.match(item.input.block,/^0x[0-9a-f]{64}$/);
    assert.equal(item.requestText,JSON.stringify(item.input));assert.equal(item.requestBytes,Buffer.byteLength(item.requestText));assert.equal(item.requestSha256,sha(item.requestText));
  }
}

export function validateManifest(manifest,plan) {
  assert.deepEqual(keys(manifest),['capturedRequests','files','implementationSha256','planSha256','plannedCases','schemaVersion','sealedAt','sourceFiles']);
  assert.equal(manifest.schemaVersion,'1.0');assert.equal(manifest.planSha256,PLAN_SHA256);assert.equal(manifest.implementationSha256,IMPLEMENTATION_SHA256);assert.equal(manifest.sourceFiles,38);
  assert.ok(Number.isInteger(manifest.capturedRequests)&&manifest.capturedRequests>=0&&manifest.capturedRequests<=3);timestamp(manifest.sealedAt);
  assert.deepEqual(manifest.plannedCases,plan.cases.map(({id,input,requestSha256})=>({id,input,requestSha256})));
  assert.deepEqual(manifest.files.map(file=>file.path),manifest.files.map(file=>file.path).toSorted());assert.equal(new Set(manifest.files.map(file=>file.path)).size,manifest.files.length);
  for(const file of manifest.files) {assert.deepEqual(keys(file),['bytes','path','sha256']);assert.ok(Number.isSafeInteger(file.bytes)&&file.bytes>=0);assert.match(file.sha256,/^[0-9a-f]{64}$/);}
  for(const source of plan.sources)assert.deepEqual(manifest.files.find(file=>file.path==='source/'+source.path),{...source,path:'source/'+source.path});
  for(const input of plan.inputs)assert.deepEqual(manifest.files.find(file=>file.path===input.path),{path:input.path,bytes:input.bytes,sha256:input.sha256});
  for(const name of ['run.mjs','freeze.mjs']){const source=plan.sources.find(file=>file.path==='reports/standard-evm-native/'+name);assert.deepEqual(manifest.files.find(file=>file.path===name),{...source,path:name});}
}

function at(report,id) {
  assert.ok(Number.isSafeInteger(id)&&id>=1&&id<=report.evidence.length);
  const record=report.evidence[id-1];assert.equal(record.id,id);assert.ok(own(record,'result'));assert.equal(record.error,undefined);return record;
}
function one(report,predicate,label) {
  const records=report.evidence.filter(predicate);assert.equal(records.length,1,label);return records[0];
}
function anchored(report,id,method,account) {
  const record=at(report,id);assert.equal(record.method,method);assert.deepEqual(record.params,[account,report.request.block]);return record.result;
}
function originalDiff(report) {
  const record=one(report,e=>e.method==='debug_traceCall'&&e.params[2]?.tracer==='prestateTracer'&&!own(e.params[2],'stateOverrides')&&
    e.params[0].from===report.request.transaction.from&&e.params[0].to===report.request.transaction.to&&e.params[0].data===report.request.transaction.data,'Exactly one original prestate diff is retained.');
  assert.deepEqual(record.params[0],report.request.transaction);assert.deepEqual(record.params[1],report.request.block);
  const raw=record.result,diff=report.stateDiff;assert.deepEqual(keys(raw),['post','pre']);assert.deepEqual(keys(diff),['post','pre']);
  for(const side of ['pre','post']) {
    assert.deepEqual(keys(raw[side]),keys(diff[side]));
    for(const [account,basic] of Object.entries(diff[side])) {
      for(const field of ['balance','nonce']) { assert.equal(own(basic,field),own(raw[side][account],field));if(own(basic,field))assert.equal(quantity(basic[field]),quantity(String(raw[side][account][field]))); }
    }
  }
  return diff;
}

// Reconstruct the complete override map independently, including cleared
// storage, explicit zero and independently proved newly funded empty accounts.
function completeOverrides(report,diff) {
  const normalized=structuredClone(diff),normalizations=report.nativeEffects.stateNormalization??[],ids=new Set();
  for(const item of normalizations) {
    assert.deepEqual(keys(item),['account','balanceEvidenceId','basis','codeEvidenceId','nonceEvidenceId']);
    assert.equal(item.basis,'pinned_zero_balance_zero_nonce_empty_code');assert.equal(ids.has(item.account),false);ids.add(item.account);
    assert.equal(own(diff.pre,item.account),false);assert.ok(own(diff.post,item.account));
    const post=diff.post[item.account];assert.ok(quantity(post.balance)>0n);
    if(own(post,'nonce'))assert.equal(quantity(post.nonce),0n);
    if(own(post,'code'))assert.equal(post.code,'0x');
    if(own(post,'storage'))assert.deepEqual(post.storage,{});
    assert.equal(quantity(anchored(report,item.balanceEvidenceId,'eth_getBalance',item.account)),0n);
    assert.equal(quantity(anchored(report,item.nonceEvidenceId,'eth_getTransactionCount',item.account)),0n);
    assert.equal(anchored(report,item.codeEvidenceId,'eth_getCode',item.account),'0x');
    normalized.pre[item.account]={balance:'0',...(own(post,'nonce')?{nonce:'0'}:{}),...(own(post,'code')?{code:'0x'}:{})};
  }
  assert.deepEqual([...ids].sort(),keys(diff.post).filter(account=>!own(diff.pre,account)));
  assert.deepEqual(keys(normalized.pre),keys(normalized.post));
  const overrides={};
  for(const account of keys(normalized.pre)) {
    const pre=normalized.pre[account],post=normalized.post[account],record={};
    if(own(post,'code'))assert.equal(post.code,pre.code,'Runtime-code changes remain unsupported.');
    for(const field of ['balance','nonce'])if(own(post,field))record[field]=hex(post[field]);
    const slots=[...new Set([...keys(pre.storage??{}),...keys(post.storage??{})])].sort();
    if(slots.length)record.stateDiff=Object.fromEntries(slots.map(slot=>[slot,post.storage?.[slot]??ZERO_WORD]));
    if(keys(record).length)overrides[account]=record;
  }
  return {diff:normalized,overrides};
}

function assertNonceOnly(diff,sender,nonce,balance) {
  assert.deepEqual(keys(diff),['post','pre']);assert.deepEqual(keys(diff.pre),[sender]);assert.deepEqual(keys(diff.post),[sender]);
  const before=diff.pre[sender],after=diff.post[sender];
  for(const side of [before,after])assert.ok(keys(side).every(key=>['balance','nonce'].includes(key)));
  const initial=(field,expected)=>own(before,field)?quantity(String(before[field])):(assert.equal(expected,0n),0n);
  assert.equal(initial('nonce',nonce),nonce);assert.equal(initial('balance',balance),balance);
  assert.equal(quantity(String(after.nonce)),nonce+1n);
  if(own(after,'balance'))assert.equal(quantity(String(after.balance)),balance);
}

export function validateNativeReport(report) {
  const native=report.nativeEffects;assert.ok(plain(native));assert.equal(native.feeScope,'excluded');assert.equal(native.maxAccounts,8);
  assert.ok(['measured','partial','none','unavailable','not_applicable'].includes(native.status));assert.ok(Array.isArray(native.measurements));
  assert.ok(native.measurements.length<=8);assert.equal(report.preview.nativeBalances.length,native.measurements.length);
  if(native.candidates) {
    assert.ok(native.candidates.length<=128);assert.equal(new Set(native.candidates.map(row=>row.account)).size,native.candidates.length);
    assert.deepEqual(native.candidates.filter(row=>row.selected).map(row=>row.account),native.selectedAccounts);
    assert.deepEqual(native.measurements.map(row=>row.account),native.selectedAccounts);
    assert.equal(native.counts.candidates,native.candidates.length);assert.equal(native.counts.selected,native.selectedAccounts.length);
    assert.equal(native.counts.omitted,native.candidates.length-native.selectedAccounts.length);
    assert.equal(native.counts.measured,native.measurements.filter(row=>row.status==='measured').length);
    assert.deepEqual(native.netValueByAccount,Object.fromEntries(native.candidates.map(row=>[row.account,row.netValueRaw])));
    for(const row of native.candidates)for(const field of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(row[field],undefined);
  }
  const measured=native.measurements.filter(row=>row.status==='measured');
  for(const [index,row]of native.measurements.entries()) {
    const display=report.preview.nativeBalances[index];assert.equal(display.account,row.account);assert.equal(display.status,row.status);
    assert.equal(display.accountIsSender,row.account===report.apiRequest.from);
    assert.deepEqual(display.metadata,{symbol:'ETH',name:'Ether',decimals:18,chainId:1,type:'native'});
    if(row.status!=='measured')for(const field of ['beforeRaw','afterRaw','deltaRaw','basis'])assert.equal(row[field],undefined);
  }
  if(!measured.length)return [];
  assert.equal(measured.length,native.measurements.length);assert.equal(report.canonicalStatus,'verified');assert.equal(report.execution.status,'success');
  const sender=report.request.transaction.from,rawHeader=one(report,e=>e.method==='eth_getBlockByHash','One initial header is retained.').result;
  const final=one(report,e=>e.method==='eth_getBlockByNumber','One final full canonical header is retained.');
  assert.deepEqual(final.params,[hex(rawHeader.number),false]);assert.deepEqual(final.result,rawHeader,'Full canonical header is stable, including state root and transaction list.');
  assert.equal(rawHeader.hash,report.request.block.blockHash);
  const diff=originalDiff(report),effective=completeOverrides(report,diff);
  const nonceRecord=one(report,e=>e.method==='eth_getTransactionCount'&&e.params[0]===sender,'One sender nonce anchor is retained.');
  assert.deepEqual(nonceRecord.params,[sender,report.request.block]);const nonce=quantity(nonceRecord.result);
  const senderAnchor=one(report,e=>e.method==='eth_getBalance'&&e.params[0]===sender,'One sender balance anchor is retained.');
  assert.deepEqual(senderAnchor.params,[sender,report.request.block]);const senderBefore=quantity(senderAnchor.result),senderAfter=own(diff.post[sender],'balance')?quantity(diff.post[sender].balance):senderBefore;
  const rows=native.measurements,accounts=rows.map(row=>row.account),expectedHeader=[rawHeader.number,rawHeader.timestamp,rawHeader.gasLimit,'0',rawHeader.mixHash,rawHeader.miner,'1',rawHeader.parentHash].map(quantity);
  let code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(quantity(rawHeader.number)-1n).toString(16).padStart(64,'0')+'4060e052';
  for(const [index,account]of accounts.entries()){assert.match(account,/^0x[0-9a-f]{40}$/);code+='73'+account.slice(2)+'3161'+(256+32*index).toString(16).padStart(4,'0')+'52';}
  code+='61'+(256+32*rows.length).toString(16).padStart(4,'0')+'6000f3';
  const decoded=[];
  for(const [index,row]of rows.entries()) {
    const anchor=quantity(anchored(report,row.anchorEvidenceId,'eth_getBalance',row.account));
    const pre=effective.diff.pre[row.account],post=effective.diff.post[row.account];assert.equal(Boolean(pre),Boolean(post));
    if(pre)assert.equal(own(pre,'balance')?quantity(pre.balance):0n,anchor,'A missing prebalance may only match an independently read zero.');
    const after=post&&own(post,'balance')?quantity(post.balance):anchor;
    assert.deepEqual(row.queryEvidence.map(query=>query.state),['before','after']);const values={};
    for(const query of row.queryEvidence) {
      const afterState=query.state==='after',trace=at(report,query.traceEvidenceId),mutation=at(report,query.mutationEvidenceId);
      assert.equal(query.wordIndex,8+index);assert.equal(trace.method,'debug_traceCall');assert.equal(mutation.method,'debug_traceCall');
      assert.deepEqual(trace.params[0],{from:sender,to:PROBE,data:'0x',value:'0x0',gas:'0x493e0'});assert.deepEqual(trace.params[1],report.request.block);
      const overrides={...(afterState?effective.overrides:{}),[PROBE]:{code}};
      assert.deepEqual(trace.params[2],{tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true},stateOverrides:overrides});
      assert.deepEqual(mutation.params,[trace.params[0],trace.params[1],{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true},stateOverrides:overrides}]);
      const raw=trace.result;assert.equal(raw.type,'CALL');assert.equal(raw.from,sender);assert.equal(raw.to,PROBE);assert.equal(raw.input,'0x');assert.equal(quantity(raw.value),0n);assert.equal(quantity(raw.gas),300000n);
      assert.ok(quantity(raw.gasUsed)>0n&&quantity(raw.gasUsed)<=300000n);assert.equal(raw.error,undefined);assert.equal(raw.revertReason,undefined);assert.deepEqual(raw.calls??[],[]);assert.deepEqual(raw.logs??[],[]);
      assert.match(raw.output,new RegExp('^0x[0-9a-f]{'+64*(8+rows.length)+'}$','i'));
      const words=Array.from({length:8+rows.length},(_,i)=>BigInt('0x'+raw.output.slice(2+i*64,66+i*64)));
      assert.deepEqual(words.slice(0,8),expectedHeader);assert.equal(words[8+index],afterState?after:anchor);
      assertNonceOnly(mutation.result,sender,nonce+(afterState?1n:0n),afterState?senderAfter:senderBefore);values[query.state]=words[8+index];
    }
    assert.equal(row.beforeRaw,values.before.toString());assert.equal(row.afterRaw,values.after.toString());assert.equal(row.deltaRaw,(values.after-values.before).toString());
    assert.equal(row.basis,'pinned_balance_reads_and_isolated_BALANCE_witnesses_with_nonce_only_effects');
    for(const field of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(report.preview.nativeBalances[index][field],row[field]);
    decoded.push({account:row.account,beforeRaw:values.before.toString(),afterRaw:values.after.toString(),deltaRaw:(values.after-values.before).toString(),anchorEvidenceId:row.anchorEvidenceId,wordIndex:8+index});
  }
  return decoded;
}
const METHODS = new Set(['eth_chainId','eth_getBlockByHash','eth_getBlockByNumber','eth_getTransactionCount','eth_getBalance','eth_getCode','debug_traceCall']);

export function validateTransport(records) {
  assert.ok(Array.isArray(records)); assert.ok(records.length <= 65);
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
  assert.ok(retainedBytes <= 32 * 1024 * 1024);
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

export async function replayExchange(exchange, plan, runtime) {
  const saved = JSON.parse(exchange.response.bodyText), records = saved.transportEvidence;
  let cursor = 0, factories = 0;
  const mismatches = [], consumed = [];
  const rpc = new runtime.StandardRpcClient({ url: plan.provider, fetchImpl: async (url, options) => {
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
  const server = runtime.createAppServer({ persist: false, standardRpcFactory() { factories++; return rpc; }, rpcFactory() {
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


export function validateAutomaticReport(report) {
  const discovery = report.discovery;
  assert.ok(plain(discovery)); assert.ok(['discovered','none','unavailable','not_applicable'].includes(discovery.status));
  assert.ok(Array.isArray(discovery.queries)); assert.ok(Array.isArray(discovery.candidates));
  assert.ok(discovery.queries.length <= 8); assert.ok(discovery.candidates.length <= 128);
  const selected = discovery.candidates.filter(item => item.selection === 'selected');
  assert.deepEqual(selected.map(item => item.query), discovery.queries, 'Selected candidate identities must equal the query list.');
  assert.equal(new Set(discovery.candidates.map(item => item.id)).size, discovery.candidates.length);
  if (discovery.counts) {
    assert.equal(typeof discovery.counts.complete, 'boolean'); assert.equal(typeof discovery.counts.truncated, 'boolean');
    assert.equal(discovery.counts.candidates, discovery.candidates.length); assert.equal(discovery.counts.selected, selected.length);
    assert.equal(discovery.counts.omitted, discovery.candidates.filter(item => item.selection === 'omitted_query_limit').length);
    assert.equal(discovery.counts.observations, discovery.observations.length);
    const ids = new Set(discovery.observations.map(item => item.id)); assert.equal(ids.size, discovery.observations.length);
    for (const item of discovery.candidates) {
      assert.ok(item.observationIds.length > 0); assert.ok(item.observationIds.every(id => ids.has(id)));
      assert.equal(item.id, item.query.to + ':' + item.query.data);
      for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(item[field], undefined, 'Candidate observations are not measurements.');
    }
  }
  if (report.request) {
    assert.equal(report.request.querySelection, 'bounded_observed_trace_candidates');
    assert.deepEqual(report.request.queries, discovery.queries);
  }
  assert.deepEqual(report.measurements.map(item => item.query), discovery.queries);
  assert.equal(report.preview.queries.length, report.measurements.length);
  for (const [index, measurement] of report.measurements.entries()) {
    const preview = report.preview.queries[index];
    assert.equal(preview.status, measurement.status);
    if (measurement.status !== 'measured') {
      for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(measurement[field], undefined);
      continue;
    }
    const observed = {};
    assert.deepEqual(measurement.queryEvidence.map(item => item.state), ['before', 'after']);
    for (const query of measurement.queryEvidence) {
      const evidence = report.evidence.find(item => item.id === query.traceEvidenceId);
      assert.equal(evidence.method, 'debug_traceCall');
      assert.equal(evidence.params[0].to, measurement.query.to); assert.equal(evidence.params[0].data, measurement.query.data);
      assert.deepEqual(evidence.params[1], report.request.block);
      assert.equal(evidence.params[2].tracer, 'callTracer');
      assert.equal(evidence.result.error, undefined); assert.equal(evidence.result.revertReason, undefined);
      assert.match(evidence.result.output, /^0x[0-9a-f]{64}$/i);
      observed[query.state] = BigInt(evidence.result.output);
      const mutation = report.evidence.find(item => item.id === query.mutationEvidenceId);
      assert.equal(mutation.method, 'debug_traceCall'); assert.equal(mutation.params[2].tracer, 'prestateTracer');
      assert.deepEqual(mutation.params.slice(0, 2), evidence.params.slice(0, 2));
      assert.deepEqual(mutation.params[2].stateOverrides, evidence.params[2].stateOverrides);
    }
    assert.equal(measurement.beforeRaw, observed.before.toString()); assert.equal(measurement.afterRaw, observed.after.toString());
    assert.equal(measurement.deltaRaw, (observed.after - observed.before).toString());
    for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(preview[field], measurement[field]);
  }
}

export function validateExchange(exchange,planned,index,implementation) {
  assert.equal(exchange.index,index+1);assert.equal(exchange.caseId,planned.id);assert.ok(timestamp(exchange.completedAt)>=timestamp(exchange.startedAt));
  assert.deepEqual(exchange.request,{method:'POST',path:'/api/evm/simulate',contentType:'application/json',bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});
  const response=exchange.response;assert.equal(response.bytes,Buffer.byteLength(response.bodyText));assert.equal(response.sha256,sha(response.bodyText));
  assert.ok(Number.isInteger(response.status)&&response.status>=100&&response.status<=599);assert.ok(response.observedBytes>=response.bytes);assert.equal(response.complete,response.observedBytes===response.bytes);
  if(!response.complete)return {report:null,accounting:null,playbackAvailable:false,reason:'Incomplete observed HTTP body is retained; no result is invented.'};
  const report=JSON.parse(response.bodyText);
  if(response.status!==200){assert.ok(plain(report.error));return {report,accounting:null,playbackAvailable:false,reason:'Observed non-200 API response is retained without claiming a completed simulation.'};}
  assert.deepEqual(report.implementation,implementation);validateGenerated(report);
  assert.ok(timestamp(report.createdAt)>=timestamp(exchange.startedAt)&&timestamp(report.createdAt)<=timestamp(exchange.completedAt));
  assert.deepEqual(report.apiRequest,planned.input);assert.deepEqual(report.security,{status:'not_assessed'});
  assert.deepEqual(report.source.blockSelection,{requested:planned.input.block,kind:'pinned_hash',resolvedHash:planned.input.block,resolvedNumber:null,evidence:null});
  assert.equal(report.source.kind,'standard_evm_unsigned_call');assert.equal(report.source.profile,'unsigned_unpriced_block_end');
  const accounting=validateTransport(report.transportEvidence);assert.equal(report.accounting.rpcCalls,accounting.rpcCalls);assert.equal(report.evidence.length,accounting.rpcCalls);
  for(const [i,record]of report.transportEvidence.entries()){const evidence=report.evidence[i];assert.equal(evidence.id,i+1);assert.equal(evidence.method,record.request.method);assert.deepEqual(evidence.params,record.request.params);if(!record.error)assert.deepEqual(evidence.result,JSON.parse(record.responseText).result);}
  validateAutomaticReport(report);const native=validateNativeReport(report);
  return {report,accounting,native,playbackAvailable:accounting.withheldErrorBodies===0,reason:accounting.withheldErrorBodies?'Rejected provider bodies retain hashes/counts only; exact wire playback remains incomplete.':null};
}

async function bound(directory,relative,expectedHash,expectedBytes) {
  assert.equal(typeof relative,'string');const absolute=path.resolve(directory,relative);assert.ok(absolute.startsWith(directory+path.sep));
  assert.equal(await fs.realpath(absolute),absolute,'No sealed file may resolve through a symlink.');const bytes=await fs.readFile(absolute);
  if(expectedHash!==undefined)assert.equal(sha(bytes),expectedHash,relative);if(expectedBytes!==undefined)assert.equal(bytes.length,expectedBytes,relative);return bytes;
}
async function inventory(directory,relative) {
  const found=[];
  async function walk(prefix){for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){assert.equal(entry.isSymbolicLink(),false);const name=prefix+'/'+entry.name;if(entry.isDirectory())await walk(name);else{assert.equal(entry.isFile(),true);found.push(name);}}}
  await walk(relative);return found.sort();
}
export async function verify({directory=here}={}) {
  for(const hash of [PLAN_SHA256,MANIFEST_SHA256,IMPLEMENTATION_SHA256])assert.match(hash,/^[0-9a-f]{64}$/,'Verifier requires separately released immutable hashes.');
  directory=await fs.realpath(directory);const json=async(file,hash)=>JSON.parse((await bound(directory,file,hash)).toString('utf8'));
  const plan=await json('plan.json',PLAN_SHA256);validatePlan(plan);const manifest=await json('manifest.json',MANIFEST_SHA256);validateManifest(manifest,plan);
  for(const file of manifest.files)await bound(directory,file.path,file.sha256,file.bytes);
  assert.deepEqual(await inventory(directory,'source'),ARCHIVE_FILES.map(file=>'source/'+file));assert.deepEqual(await inventory(directory,'inputs'),INPUT_FILES.map(file=>file.path).sort());
  const fingerprint=createHash('sha256');for(const file of IMPLEMENTATION_FILES)fingerprint.update(file+'\0').update(await bound(directory,'source/'+file)).update('\0');assert.equal(fingerprint.digest('hex'),IMPLEMENTATION_SHA256);
  const frozen=await json('FROZEN.json');assert.deepEqual(frozen,{schemaVersion:'1.0',frozenAt:plan.frozenAt,planSha256:PLAN_SHA256,implementationSha256:IMPLEMENTATION_SHA256,sourceFiles:38,cases:3});
  const started=await json('STARTED.json');assert.deepEqual(started,{schemaVersion:'1.0',startedAt:started.startedAt,planSha256:PLAN_SHA256,implementation:plan.implementation,sourceFiles:plan.sources,cases:plan.cases.map(item=>({id:item.id,requestSha256:item.requestSha256})),provider:plan.provider,limits:LIMITS});
  assert.ok(timestamp(started.startedAt)>=timestamp(plan.frozenAt));
  const inputNative=await json('inputs/native-index.json'),inputSwap=await json('inputs/swap-response.json'),inputAave=await json('inputs/aave-response.json');
  assert.deepEqual(plan.cases.map(item=>item.input),[
    {chainId:1,from:inputNative.selected.request.from,to:inputNative.selected.request.to,data:inputNative.selected.request.data,value:quantity(inputNative.selected.request.value).toString(),block:inputNative.selected.parentHash},inputSwap.apiRequest,inputAave.apiRequest,
  ]);
  assert.equal(inputNative.captureSha256,INPUT_FILES[1].sha256);assert.equal(inputNative.status,'candidate_found');
  const summary=await json('results.json'),rpc=await json('rpc-evidence.json');
  assert.equal(summary.schemaVersion,'1.0');assert.equal(summary.developmentOnly,true);assert.equal(summary.planSha256,PLAN_SHA256);assert.deepEqual(summary.implementation,plan.implementation);
  assert.equal(summary.planned,3);assert.equal(summary.retries,0);assert.equal(summary.replacements,0);assert.equal(summary.sourceUnchanged,true);assert.deepEqual(summary.cases.map(item=>item.id),CASE_IDS);
  assert.equal(summary.statusMeaning,'Capture process completion, not simulation success or an accuracy verdict.');
  assert.equal(summary.attempted,summary.cases.filter(item=>item.attempted).length);assert.ok(['completed','incomplete'].includes(summary.status));
  if(summary.status==='completed'){assert.equal(summary.fatal,null);assert.deepEqual(summary.violations,[]);assert.equal(summary.attempted,3);}
  assert.ok(timestamp(summary.completedAt)>=timestamp(started.startedAt));assert.ok(timestamp(manifest.sealedAt)>=timestamp(summary.completedAt));
  assert.equal(rpc.schemaVersion,'1.0');assert.equal(new Set(rpc.clients.map(item=>item.caseId)).size,rpc.clients.length);
  assert.ok(rpc.clients.every(item=>CASE_IDS.includes(item.caseId)&&summary.cases.find(c=>c.id===item.caseId).attempted));
  assert.deepEqual(rpc.clients.map(item=>item.caseId),CASE_IDS.filter(id=>rpc.clients.some(item=>item.caseId===id)));
  let totalCalls=0,totalBytes=0;for(const client of rpc.clients){assert.equal(client.provider,plan.provider);const accounting=validateTransport(client.records);assert.equal(client.observedBytes,accounting.observedBytes);totalCalls+=accounting.rpcCalls;totalBytes+=accounting.observedBytes;}
  assert.equal(rpc.rpcCalls,totalCalls);assert.equal(rpc.observedResponseBytes,totalBytes);assert.ok(totalCalls<=195&&totalBytes<=100663296);assert.ok(rpc.publicDispatches<=195);
  for(const field of ['rpcCalls','publicDispatches','observedResponseBytes'])assert.equal(summary[field],rpc[field]);
  if(summary.status==='completed')assert.equal(rpc.publicDispatches,totalCalls);
  const source=relative=>pathToFileURL(path.join(directory,'source',relative)).href;
  const runtime={...(await import(source('src/server.js'))),...(await import(source('src/standard-rpc.js')))};
  const api=await(await import(source('src/standard-loader.js'))).loadStandardApi();assert.ok(api);assert.deepEqual(api.implementation,plan.implementation);
  const cases=[],expectedFiles=[...ARCHIVE_FILES.map(file=>'source/'+file),...INPUT_FILES.map(file=>file.path),'run.mjs','freeze.mjs','plan.json','FROZEN.json','STARTED.json','rpc-evidence.json','results.json'];
  let previousCompleted=timestamp(started.startedAt),captured=0;
  for(const [index,planned]of plan.cases.entries()) {
    const item=summary.cases[index],stem=String(index+1).padStart(3,'0');
    if(!item.attempted){assert.deepEqual(item,{id:planned.id,attempted:false,reason:'CAPTURE_INTERRUPTED_NO_REPLACEMENT'});cases.push({...item,playback:{status:'incomplete',reason:item.reason}});continue;}
    const clientFile='client/'+stem+'.json',client=await json(clientFile);expectedFiles.push(clientFile);
    assert.equal(client.caseId,planned.id);assert.ok(timestamp(client.startedAt)>=previousCompleted);assert.ok(timestamp(client.completedAt)>=timestamp(client.startedAt));previousCompleted=timestamp(client.completedAt);finiteTime(client.durationMs);
    assert.deepEqual(client.request,{method:'POST',path:'/api/evm/simulate',bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});
    const body=Buffer.from(client.response.bodyText,'utf8');assert.equal(client.response.retainedBytes,body.length);assert.equal(client.response.retainedPrefixSha256,sha(body));assert.ok(client.response.observedBytes>=body.length);
    if(client.response.complete){assert.equal(client.response.observedBytes,body.length);assert.equal(client.response.observedPrefixSha256,sha(body));assert.equal(client.error,undefined);}
    assert.equal(item.httpStatus,client.response.status);assert.equal(item.complete,client.response.complete);
    const exchangeFile='http/'+stem+'.json',hasExchange=manifest.files.some(file=>file.path===exchangeFile);
    if(!hasExchange){assert.equal(client.response.complete,false);assert.equal(summary.status,'incomplete');cases.push({id:planned.id,httpStatus:client.response.status,playback:{status:'incomplete',reason:'HTTP handler did not complete; independent client/RPC snapshots remain retained.'}});continue;}
    const exchange=await json(exchangeFile);expectedFiles.push(exchangeFile);captured++;const checked=validateExchange(exchange,planned,index,plan.implementation);
    assert.ok(timestamp(exchange.startedAt)>=timestamp(client.startedAt));assert.ok(timestamp(exchange.completedAt)<=timestamp(manifest.sealedAt));
    if(client.response.complete){assert.equal(exchange.response.bodyText,client.response.bodyText);assert.equal(exchange.response.status,client.response.status);}
    const report=checked.report,recordedRpc=rpc.clients.find(row=>row.caseId===planned.id);
    if(report?.transportEvidence)assert.deepEqual(recordedRpc?.records,report.transportEvidence,'Independent RPC snapshots exactly match the API-retained records.');
    if(report&&client.response.complete){const responseFile=planned.id+'-response.json';expectedFiles.push(responseFile);assert.deepEqual(await json(responseFile),report);}
    assert.deepEqual(item,{id:planned.id,attempted:true,httpStatus:client.response.status,complete:client.response.complete,captureStatus:client.response.complete?'response_captured':'incomplete',execution:report?.execution??null,nativeEffects:report?.nativeEffects??null,tokenMeasurements:report?.measurements?.length??0,
      measuredTokenQueries:report?.measurements?.filter(row=>row.status==='measured').length??0,measuredNativeAccounts:report?.nativeEffects?.measurements?.filter(row=>row.status==='measured').length??0,error:client.error??report?.error??null,
      ...(recordedRpc?{rpcCalls:recordedRpc.records.length,observedResponseBytes:recordedRpc.observedBytes}:{})});
    const playback=checked.playbackAvailable?await replayExchange(exchange,plan,runtime):{status:'incomplete',reason:checked.reason};
    cases.push({id:planned.id,httpStatus:exchange.response.status,execution:report?.execution?.status??'unavailable',canonicalStatus:report?.canonicalStatus??'unavailable',
      nativeStatus:report?.nativeEffects?.status??'unavailable',nativeMeasurements:checked.native??[],tokenMeasurements:report?.measurements?.map(row=>({query:row.query,status:row.status,...(row.status==='measured'?{beforeRaw:row.beforeRaw,afterRaw:row.afterRaw,deltaRaw:row.deltaRaw}:{reason:row.reason})}))??[],accounting:checked.accounting,playback});
  }
  assert.equal(manifest.capturedRequests,captured);assert.deepEqual(manifest.files.map(file=>file.path),expectedFiles.sort(),'Exact declared case/source/input/evidence inventory is retained.');
  assert.deepEqual(await inventory(directory,'http'),expectedFiles.filter(file=>file.startsWith('http/')),'No hidden fourth HTTP attempt.');
  assert.deepEqual(await inventory(directory,'client'),expectedFiles.filter(file=>file.startsWith('client/')),'No hidden fourth HTTP client attempt.');
  return {status:summary.status==='completed'&&cases.every(item=>item.playback.status==='matched')?'passed':'incomplete',planSha256:PLAN_SHA256,manifestSha256:MANIFEST_SHA256,implementationSha256:IMPLEMENTATION_SHA256,
    sourceFiles:38,sealedFiles:manifest.files.length,publicNetworkRequests:0,socketsOpened:0,liveSourceImports:0,
    replayMode:'archived_createAppServer_handler_in_memory_with_archived_StandardRpcClient',totals:{rpcCalls:totalCalls,rpcResponseBytes:totalBytes},cases,
    limitations:['Three fixed development cases, not a prospective population, vendor comparison or security verdict.','Playback checks recorded provider evidence and complete API reproducibility; it is not an independent execution oracle.',
      'Native values are decoded from BALANCE witnesses and pinned reads; candidate flow values are never used as measured amounts.','Unsigned parent-state calls exclude original signed fee settlement and original transaction-position replay.',
      'Unattempted, failed, truncated or withheld-body cases remain explicit and are never replaced with synthetic provider responses.','No browser rendering or public network is replayed.']};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,2);const result=await verify();process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.status!=='passed')process.exitCode=1;
}
