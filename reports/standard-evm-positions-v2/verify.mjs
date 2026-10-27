// Frozen offline replay: no live product imports, no response synthesis.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyPacket, LIMITS } from './run.mjs';
import { validateReport } from './checks.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex'),jsonSha=x=>sha(JSON.stringify(x));
const keys=x=>Object.keys(x).sort(),plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finiteTime=x=>assert.ok(Number.isFinite(x)&&x>=0);
const timestamp=x=>{assert.equal(new Date(x).toISOString(),x);return Date.parse(x);};
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

export async function invokeHandler(server, request) {
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


export function checkEngineEvidence(report,records){
  const parts=report.steps?report.steps.filter(s=>s.result).map(s=>s.result):[report];let cursor=0;
  for(const [stepIndex,part]of parts.entries()){
    assert.equal(part.accounting.rpcCalls,part.evidence.length);let bytes=0;
    for(const [index,e]of part.evidence.entries()){
      const wire=records[cursor],body=JSON.parse(wire.responseText);assert.equal(e.id,index+1);assert.equal(e.method,wire.request.method);assert.deepEqual(e.params,wire.request.params);assert.deepEqual(e.result,body.result);assert.equal(e.error,undefined);bytes+=Buffer.byteLength(JSON.stringify(body.result));
      if(report.steps)assert.deepEqual(report.sequenceEvidence[cursor],{id:cursor+1,stepIndex,method:e.method,paramsSha256:jsonSha(e.params),resultBytes:Buffer.byteLength(JSON.stringify(e.result)),resultSha256:jsonSha(e.result)});cursor++;
    }
    assert.equal(part.accounting.retainedResultBytes,bytes);
  }
  if(report.steps){if(report.finalVerification){const wire=records[cursor],final=report.finalVerification,body=JSON.parse(wire.responseText);assert.deepEqual(final,{sequenceEvidenceId:cursor+1,method:wire.request.method,params:wire.request.params,result:body.result});assert.deepEqual(report.sequenceEvidence[cursor],{id:cursor+1,kind:'final_canonical_check',method:wire.request.method,paramsSha256:jsonSha(wire.request.params),resultBytes:Buffer.byteLength(JSON.stringify(body.result)),resultSha256:jsonSha(body.result)});cursor++;}assert.equal(report.sequenceEvidence.length,cursor);}
  assert.equal(cursor,records.length);assert.equal(report.accounting.rpcCalls,cursor);assert.equal(report.accounting.retainedResultBytes,records.reduce((s,r)=>s+Buffer.byteLength(JSON.stringify(JSON.parse(r.responseText).result)),0));
}


export async function verify({directory=here,manifestSha256}={}){
  assert.match(manifestSha256,/^[0-9a-f]{64}$/);
  const read=async p=>{const entry=manifest.files.find(x=>x.path===p);assert.ok(entry,'Unsealed read forbidden: '+p);const bytes=await fs.readFile(path.join(directory,p));assert.equal(bytes.length,entry.bytes,p);assert.equal(sha(bytes),entry.sha256,p);return JSON.parse(bytes);};
  const manifestBytes=await fs.readFile(path.join(directory,'manifest.json'));assert.equal(sha(manifestBytes),manifestSha256);
  const manifest=JSON.parse(manifestBytes);assert.equal(new Set(manifest.files.map(x=>x.path)).size,manifest.files.length);
  for(const item of manifest.files){
    assert.deepEqual(keys(item),['bytes','path','sha256']);
    const p=path.resolve(directory,item.path);assert.ok(p.startsWith(path.resolve(directory)+path.sep));assert.equal(await fs.realpath(p),p);
    const bytes=await fs.readFile(p);assert.equal(bytes.length,item.bytes,item.path);assert.equal(sha(bytes),item.sha256,item.path);
  }
  // Every source/dependency and input byte is verified before application imports.
  const {plan,planSha256,archive}=await verifyPacket(directory);
  assert.equal(manifest.planSha256,planSha256);assert.equal(manifest.implementationSha256,plan.implementation.sourceSha256);
  const expectedBase=[...plan.sources.map(x=>'source/'+x.path),...plan.inputs.map(x=>x.path),...['run.mjs','freeze.mjs','selection.mjs','verify.mjs','checks.mjs','verify.test.mjs','plan.json','FROZEN.json','STARTED.json','results.json','rpc-evidence.json']];
  for(const item of expectedBase)assert.ok(manifest.files.some(x=>x.path===item),'Missing manifest entry '+item);
  const optional=plan.cases.flatMap((item,index)=>[item.id+'-response.json',...['http','client'].map(dir=>dir+'/'+String(index+1).padStart(3,'0')+'.json')]);
  for(const item of manifest.files)assert.ok([...expectedBase,...optional].includes(item.path),'Unexpected sealed artifact '+item.path);
  assert.deepEqual(manifest.plannedCases,plan.cases.map(({id,route,profile,input,requestSha256})=>({id,route,profile,input,requestSha256})));
  assert.equal(manifest.capturedRequests,manifest.files.filter(x=>/^http\/[0-9]{3}\.json$/.test(x.path)).length);assert.equal(manifest.sourceFiles,plan.sources.length);
  const src=p=>pathToFileURL(path.join(archive,p)).href;
  const runtime={...await import(src('src/server.js')),...await import(src('src/standard-rpc.js'))};
  const {keccak_256:keccak}=await import(src('engines/standard-evm/node_modules/@noble/hashes/sha3.js'));
  const results=await read('results.json'),rpc=await read('rpc-evidence.json'),started=await read('STARTED.json');
  assert.equal(results.planSha256,planSha256);assert.deepEqual(results.implementation,plan.implementation);assert.equal(results.planned,3);assert.equal(results.retries,0);assert.equal(results.replacements,0);assert.equal(results.sourceUnchanged,true);
  assert.deepEqual(results.cases.map(x=>x.id),plan.cases.map(x=>x.id));
  assert.deepEqual(started,{schemaVersion:'1.0',startedAt:started.startedAt,planSha256,implementation:plan.implementation,sourceFiles:plan.sources,cases:plan.cases.map(x=>({id:x.id,requestSha256:x.requestSha256})),provider:plan.provider,limits:LIMITS});
  assert.ok(Array.isArray(results.violations));assert.equal(results.attempted,results.cases.filter(x=>x.attempted).length);
  const processComplete=results.status==='completed'&&results.fatal===null&&results.violations.length===0;
  assert.ok(timestamp(results.completedAt)>=timestamp(started.startedAt));assert.ok(timestamp(manifest.sealedAt)>=timestamp(results.completedAt));finiteTime(results.durationMs);
  const cases=[];let totalBytes=0,totalCalls=0;
  assert.equal(new Set(rpc.clients.map(x=>x.caseId)).size,rpc.clients.length);
  for(const entry of rpc.clients){assert.ok(plan.cases.some(x=>x.id===entry.caseId&&x.profile===entry.profile));assert.equal(entry.provider,plan.provider);}
  for(const [index,planned]of plan.cases.entries()){
    const summary=results.cases[index],saved=rpc.clients.find(x=>x.caseId===planned.id);
    const accounting=saved?validateTransport(saved.records,planned.profile):{rpcCalls:0,observedBytes:0,withheldErrorBodies:0};totalCalls+=accounting.rpcCalls;totalBytes+=accounting.observedBytes;
    if(saved){assert.equal(saved.observedBytes,accounting.observedBytes);assert.equal(summary.rpcCalls,accounting.rpcCalls);assert.equal(summary.observedResponseBytes,accounting.observedBytes);}
    const stem=String(index+1).padStart(3,'0');assert.equal(typeof summary.attempted,'boolean');
    assert.equal(summary.attempted,manifest.files.some(x=>x.path==='client/'+stem+'.json'));
    if(!summary.attempted){assert.equal(saved,undefined);assert.ok(!manifest.files.some(x=>x.path==='http/'+stem+'.json'||x.path===planned.id+'-response.json'));cases.push({id:planned.id,status:'not_attempted',reason:summary.reason});continue;}
    const client=await read('client/'+stem+'.json');
    assert.equal(summary.httpStatus,client.response.status);assert.equal(summary.complete,client.response.complete);assert.equal(summary.profile,planned.profile);assert.equal(summary.route,planned.route);
    assert.equal(client.caseId,planned.id);assert.deepEqual(client.request,{method:'POST',path:planned.route,bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});
    const body=client.response.bodyText;assert.equal(Buffer.byteLength(body),client.response.retainedBytes);assert.equal(sha(body),client.response.retainedPrefixSha256);
    if(!client.response.complete){cases.push({id:planned.id,status:'unavailable',reason:'Original HTTP exchange incomplete; no replay response invented.',error:client.error??null,accounting});continue;}
    const exchange=await read('http/'+stem+'.json');
    assert.equal(exchange.caseId,planned.id);assert.deepEqual(exchange.request,{method:'POST',path:planned.route,contentType:'application/json',bodyText:planned.requestText,bytes:planned.requestBytes,sha256:planned.requestSha256});
    assert.equal(exchange.response.complete,true);assert.equal(exchange.response.bodyText,body);assert.equal(exchange.response.status,client.response.status);
    assert.equal(exchange.response.bytes,Buffer.byteLength(body));assert.equal(exchange.response.observedBytes,exchange.response.bytes);assert.equal(exchange.response.sha256,sha(body));
    assert.equal(client.response.observedBytes,exchange.response.bytes);assert.equal(client.response.observedPrefixSha256,exchange.response.sha256);
    const report=await read(planned.id+'-response.json');assert.deepEqual(report,JSON.parse(body));
    if(exchange.response.status!==200||!report.transportEvidence){cases.push({id:planned.id,status:'unavailable',reason:'Original HTTP result is not a complete simulation report.',httpStatus:exchange.response.status,error:report.error??null,accounting});continue;}
    assert.deepEqual(report.implementation,plan.implementation);assert.deepEqual(report.transportEvidence,saved.records);validateGenerated(report);
    assert.deepEqual(report.source.blockSelection,{requested:planned.input.block,kind:'pinned_hash',resolvedHash:planned.input.block,resolvedNumber:null,evidence:null});
    if(accounting.withheldErrorBodies){cases.push({id:planned.id,status:'unavailable',reason:'Rejected or incomplete provider body was withheld by the transport. Exact replay is unavailable; no substitute body is generated.',accounting,execution:report.execution?.status??null,sequence:report.sequence??null});continue;}
    const internalErrors=(report.steps?.map(x=>x.result).filter(Boolean)??[report]).flatMap(x=>x.evidence).filter(x=>x.error);
    if(!internalErrors.length)checkEngineEvidence(report,saved.records);
    const decoded=validateReport(report,planned,keccak);
    const playback=await replayExchange(exchange,plan,runtime,planned.profile);
    cases.push({id:planned.id,status:'reproduced',canonicalStatus:report.canonicalStatus,execution:report.execution?.status??null,sequence:report.sequence??null,accounting,engineEvidenceCheck:internalErrors.length?'unavailable_error_entries_retained_and_replayed':'bound_to_wire',
      steps:decoded.map(({header,overrides,...rest})=>rest),playback});
  }
  for(const k of ['rpcCalls','publicDispatches','observedResponseBytes'])assert.equal(results[k],rpc[k]);
  assert.equal(rpc.rpcCalls,totalCalls);assert.equal(rpc.publicDispatches,totalCalls);assert.equal(rpc.observedResponseBytes,totalBytes);
  assert.ok(totalCalls<=LIMITS.totalRpcCalls&&totalBytes<=LIMITS.rpcTotalBytes);
  return{status:!processComplete?'capture_incomplete':cases.every(x=>x.status==='reproduced')?'reproduced':'retained_with_unavailable_outcomes',captureStatus:results.status,captureFatal:results.fatal,captureViolations:results.violations,planSha256,manifestSha256,implementationSha256:plan.implementation.sourceSha256,
    sourceFiles:plan.sources.length,sealedFiles:manifest.files.length,publicNetworkRequests:0,socketsOpened:0,liveSourceImports:0,
    replayMode:'archived_createAppServer_handler_with_archived_StandardRpcClient_and_exact_saved_wire_responses',
    totals:{rpcCalls:totalCalls,responseBytes:totalBytes},cases,
    limitations:['Three fixed development cases, not representative accuracy or a security score.','Exact replay of the same archived implementation is reproducibility, not an independent execution engine.','Before/after consistency uses provider traces and state diffs; the declared protocol ABI does not authenticate the deployment.','Aave base values retain unknown oracle currency/scale; health-factor maximum is raw uint256. Morpho shares are not assets, and the queried position belongs to the inner vault.','Only validated isolated query return data yields measured tuples or token amounts.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,3);const savedFetch=globalThis.fetch;let publicCalls=0;globalThis.fetch=()=>{publicCalls++;throw new Error('Public network forbidden in offline verifier.');};
  try{const result=await verify({manifestSha256:process.argv[2]});assert.equal(publicCalls,0);process.stdout.write(JSON.stringify(result,null,2)+'\n');}finally{globalThis.fetch=savedFetch;}
}

