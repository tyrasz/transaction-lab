import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verify,validatePlan,validateManifest,validateTransport,validateExchange,validateNativeReport,validateAutomaticReport,replayExchange,semanticReport,
  PLAN_SHA256,MANIFEST_SHA256,IMPLEMENTATION_SHA256,IMPLEMENTATION_FILES,ARCHIVE_FILES,CASE_IDS} from './verify.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),sha=value=>createHash('sha256').update(value).digest('hex');
const read=async name=>JSON.parse(await fs.readFile(path.join(here,name),'utf8'));
let directory,plan,manifest,exchanges,reports,result,runtime,network=0;
before(async()=>{
  plan=await read('plan.json');manifest=await read('manifest.json');exchanges=await Promise.all(['001','002','003'].map(id=>read('http/'+id+'.json')));reports=exchanges.map(exchange=>JSON.parse(exchange.response.bodyText));
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'standard-native-offline-'));
  // Only packet bytes are copied. No current repository, sibling evidence,
  // executable product files or live-installed dependency is available here.
  for(const file of ['manifest.json',...manifest.files.map(row=>row.path)]){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(path.join(here,file),path.join(directory,file));await fs.chmod(path.join(directory,file),0o600);}
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{network++;throw new Error('No public network is allowed.');};
  try{result=await verify({directory});}finally{globalThis.fetch=originalFetch;}
  runtime={...(await import(pathToFileURL(path.join(directory,'source/src/server.js')).href)),...(await import(pathToFileURL(path.join(directory,'source/src/standard-rpc.js')).href))};
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});

test('all three sealed native/API outcomes reproduce from isolated complete archived wire evidence',()=>{
  assert.equal(result.status,'passed');assert.equal(result.planSha256,PLAN_SHA256);assert.equal(result.manifestSha256,MANIFEST_SHA256);assert.equal(result.implementationSha256,IMPLEMENTATION_SHA256);
  assert.equal(result.sourceFiles,38);assert.equal(result.sealedFiles,59);assert.equal(IMPLEMENTATION_FILES.length,32);assert.equal(ARCHIVE_FILES.length,38);
  assert.equal(network,0);assert.equal(result.publicNetworkRequests,0);assert.equal(result.socketsOpened,0);assert.equal(result.liveSourceImports,0);assert.deepEqual(result.cases.map(row=>row.id),CASE_IDS);
  assert.deepEqual(result.cases.map(row=>row.nativeMeasurements.length),[2,2,0]);assert.deepEqual(result.cases.map(row=>row.tokenMeasurements.length),[0,4,4]);
  for(const row of result.cases){assert.equal(row.httpStatus,200);assert.equal(row.playback.status,'matched');assert.deepEqual(row.playback.consumedRpcIds,Array.from({length:row.accounting.rpcCalls},(_,i)=>i+1));}
  assert.deepEqual(result.cases[0].nativeMeasurements.map(({beforeRaw,afterRaw,deltaRaw})=>({beforeRaw,afterRaw,deltaRaw})),[
    {beforeRaw:'82911000000000000',afterRaw:'63000000000000',deltaRaw:'-82848000000000000'},
    {beforeRaw:'42883012001732692514',afterRaw:'42965860001732692514',deltaRaw:'82848000000000000'},
  ]);
  assert.deepEqual(result.cases[1].tokenMeasurements.map(row=>row.deltaRaw),['-13542516010','13542516010','5801876231282977354','-5801876231282977354']);
  assert.deepEqual(result.cases[1].nativeMeasurements.map(({account,beforeRaw,afterRaw,deltaRaw})=>({account,beforeRaw,afterRaw,deltaRaw})),[
    {account:'0x51c72848c68a965f66fa7a88855f9f7784502a7f',beforeRaw:'148806357832870076845',afterRaw:'148805524511632584503',deltaRaw:'-833321237492342'},
    {account:'0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97',beforeRaw:'7155873616174246236',afterRaw:'7156706937411738578',deltaRaw:'833321237492342'},
  ]);
  assert.deepEqual(result.totals,{rpcCalls:79,rpcResponseBytes:368652});
  assert.deepEqual(result.cases[2].tokenMeasurements.map(row=>row.deltaRaw),['3962903484','-3962903485','0','3962903485']);
});

test('native words and pinned anchors remain authoritative even when candidate flow diagnostics are altered',async()=>{
  const changed=structuredClone(reports[0]),row=changed.nativeEffects.candidates[0];row.netValueRaw='123';changed.nativeEffects.netValueByAccount[row.account]='123';
  assert.deepEqual(validateNativeReport(changed),validateNativeReport(reports[0]),'Candidate CALL values never populate the independently decoded measurement.');
  const exchange=structuredClone(exchanges[0]);exchange.response.bodyText=JSON.stringify(changed);
  await assert.rejects(replayExchange(exchange,plan,runtime),/Every nongenerated API\/result\/wire field/);
});

test('independent native checks reject mutated witness values, anchor reads, mutation proof and word order',()=>{
  for(const mutate of [
    report=>{const row=report.nativeEffects.measurements[0],entry=report.evidence[row.queryEvidence[1].traceEvidenceId-1];const offset=2+row.queryEvidence[1].wordIndex*64;entry.result.output=entry.result.output.slice(0,offset)+'f'.repeat(64)+entry.result.output.slice(offset+64);},
    report=>{const row=report.nativeEffects.measurements[0];report.evidence[row.anchorEvidenceId-1].result='0x1';},
    report=>{const row=report.nativeEffects.measurements[0],proof=row.queryEvidence[1];report.evidence[proof.mutationEvidenceId-1].result.post[report.apiRequest.from].balance='0x1';},
    report=>{report.nativeEffects.measurements[0].queryEvidence[0].wordIndex++;},
    report=>{report.nativeEffects.measurements[0].queryEvidence.reverse();},
    report=>{report.nativeEffects.measurements[0].afterRaw='123';report.preview.nativeBalances[0].afterRaw='123';},
  ]){const changed=structuredClone(reports[0]);mutate(changed);assert.throws(()=>validateNativeReport(changed));}
});

test('native witnesses must use the complete original after-state and an unchanged full canonical header',()=>{
  for(const mutate of [
    report=>{const row=report.nativeEffects.measurements[0],proof=row.queryEvidence[1];delete report.evidence[proof.traceEvidenceId-1].params[2].stateOverrides[report.apiRequest.from];},
    report=>{const row=report.nativeEffects.measurements[0],proof=row.queryEvidence[1];report.evidence[proof.mutationEvidenceId-1].params[2].stateOverrides[report.apiRequest.from].balance='0x1';},
    report=>{const row=report.nativeEffects.measurements[0],proof=row.queryEvidence[0],entry=report.evidence[proof.traceEvidenceId-1];entry.params[2].stateOverrides['0x000000000000000000000000000000000000ba1a'].code+='00';},
    report=>{report.evidence.find(entry=>entry.method==='eth_getBlockByNumber').result.stateRoot='0x'+'1'.repeat(64);},
    report=>{report.evidence.find(entry=>entry.method==='eth_getBlockByNumber').result.transactions=['0x'+'1'.repeat(64)];},
    report=>{const diff=report.evidence.find(entry=>entry.method==='debug_traceCall'&&entry.params[2].tracer==='prestateTracer'&&!entry.params[2].stateOverrides);diff.result.post[report.apiRequest.to].balance='0x1';},
  ]){const changed=structuredClone(reports[0]);mutate(changed);assert.throws(()=>validateNativeReport(changed));}
});

test('wire requests, ID order, UTF-8 bytes and outer assertion latch reject injected or missing RPCs',async()=>{
  for(const mutate of [
    value=>{value.transportEvidence[0].requestText+=' ';},
    value=>{[value.transportEvidence[0],value.transportEvidence[1]]=[value.transportEvidence[1],value.transportEvidence[0]];},
    value=>{value.transportEvidence.pop();},
  ]){const changed=structuredClone(exchanges[0]),report=structuredClone(reports[0]);mutate(report);changed.response.bodyText=JSON.stringify(report);await assert.rejects(replayExchange(changed,plan,runtime),/RPC mismatches were latched outside/);}
  const records=structuredClone(reports[0].transportEvidence);records[0].responseText+=' ';assert.throws(()=>validateTransport(records));
  const altered=structuredClone(reports[0].transportEvidence);altered[0].id=2;assert.throws(()=>validateTransport(altered));
  const duplicate=structuredClone(exchanges[0]),body=structuredClone(reports[0]);body.transportEvidence.push(structuredClone(body.transportEvidence.at(-1)));duplicate.response.bodyText=JSON.stringify(body);await assert.rejects(replayExchange(duplicate,plan,runtime));
});

test('only generated IDs/times are excluded; ownership, fee scope, native status and all raw values remain semantic',()=>{
  const generated=structuredClone(reports[0]);generated.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';generated.createdAt='2030-01-01T00:00:00.000Z';generated.timing={rpcMs:1,totalMs:2};for(const row of generated.transportEvidence)row.transport.durationMs=0;
  assert.deepEqual(semanticReport(generated),semanticReport(reports[0]));
  for(const mutate of [value=>{value.nativeEffects.feeScope='included';},value=>{value.preview.nativeBalances[1].accountIsSender=true;},value=>{value.nativeEffects.status='unavailable';},value=>{value.evidence[0].result='0x2';}]){const changed=structuredClone(reports[0]);mutate(changed);assert.notDeepEqual(semanticReport(changed),semanticReport(reports[0]));}
});

test('source closure, missing case and hidden retry cannot be accepted by changing summary-only counts',async()=>{
  for(const mutate of [value=>value.sources.pop(),value=>value.cases.pop(),value=>value.cases.reverse(),value=>{value.provider='https://example.invalid';}]){const changed=structuredClone(plan);mutate(changed);assert.throws(()=>validatePlan(changed));}
  const changed=structuredClone(manifest);changed.files.find(row=>row.path==='source/src/server.js').sha256='0'.repeat(64);assert.throws(()=>validateManifest(changed,plan));
  for(const file of ['source/src/server.js','http/001.json']){const target=path.join(directory,file),original=await fs.readFile(target);await fs.writeFile(target,Buffer.concat([original,Buffer.from('\n')]));try{await assert.rejects(verify({directory}),error=>error.message.includes(file));}finally{await fs.writeFile(target,original);}}
  const missing=path.join(directory,'http/003.json'),original=await fs.readFile(missing);await fs.unlink(missing);try{await assert.rejects(verify({directory}),error=>error.code==='ENOENT');}finally{await fs.writeFile(missing,original);}
  const fourth=path.join(directory,'http/004.json');await fs.copyFile(path.join(directory,'http/001.json'),fourth);try{await assert.rejects(verify({directory}),/hidden fourth HTTP attempt/);}finally{await fs.unlink(fourth);}
});

test('withheld provider errors and HTTP failures remain explicit incomplete outcomes without synthetic replay data',()=>{
  const records=structuredClone(reports[0].transportEvidence);records[0].error={code:'RPC_EXECUTION_ERROR',message:'Provider rejected request.'};delete records[0].responseText;records[0].transport.bodyRetained=false;assert.equal(validateTransport(records).withheldErrorBodies,1);
  const failed=structuredClone(exchanges[0]);failed.response.status=503;failed.response.bodyText=JSON.stringify({error:{code:'UNAVAILABLE',message:'Unavailable.'}});failed.response.bytes=failed.response.observedBytes=Buffer.byteLength(failed.response.bodyText);failed.response.sha256=sha(failed.response.bodyText);
  const result=validateExchange(failed,plan.cases[0],0,plan.implementation);assert.equal(result.playbackAvailable,false);assert.equal(result.report.error.code,'UNAVAILABLE');
});

test('swap account labels and Aave token control remain separate from native state and submitter ownership',()=>{
  const swap=reports[1];validateAutomaticReport(swap);assert.ok(swap.preview.queries.every(row=>row.accountIsSender===false));
  const weth=swap.preview.queries.filter(row=>row.token==='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');assert.equal(weth.length,2);assert.ok(weth.every(row=>row.metadata===null));
  assert.equal(reports[2].nativeEffects.status,'none');assert.deepEqual(validateNativeReport(reports[2]),[]);assert.equal(reports[2].measurements.length,4);
});
