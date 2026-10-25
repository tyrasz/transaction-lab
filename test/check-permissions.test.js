import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTrace } from '../src/analyze.js';
import { analyzePermissions } from '../src/permissions.js';
import { METADATA } from '../src/config.js';
import { RpcError } from '../src/rpc.js';
import { validateReplay } from '../src/validate.js';
import { comparePermissionReports, loadPermissionCases, runPermissionChecks, validatePermissionReport } from '../src/check-permissions.js';

const cases=await loadPermissionCases();
const captured=JSON.parse(await readFile(new URL('../reports/historical-permissions/permit-module-validation.json',import.meta.url)));
// Reconstructed API envelopes combine original captured transaction traces with
// independently captured historical allowance queries. They are offline inputs,
// not new live API responses. Direct approval uses its separately verified pair.
function responseFor(item) {
  const e=item.expected,b=e.block;
  const analysis=analyzeTrace({request:item.originalRequest,trace:item.evidence.trace,block:b,metadata:METADATA,mode:'historical_trace'});
  const permissions=analyzePermissions({request:item.originalRequest,trace:item.evidence.trace,block:b,metadata:METADATA});
  permissions.coverage.allowanceStateVerified=true;
  const source=captured.runs.find(r=>r.executionIdentity?.transactionHash===e.transactionHash&&r.endpoint.includes('archive'));
  const allowances=e.pairs.map(pair=>{
    const real=source?.allowances.find(p=>p.token===pair.token&&p.owner===pair.owner&&p.spender===pair.spender);
    const beforeRaw=real?.before??pair.beforeRaw,afterRaw=real?.after??pair.afterRaw;
    return {asset:METADATA[pair.token],owner:pair.owner,spender:pair.spender,beforeRaw,afterRaw,deltaRaw:(BigInt(afterRaw)-BigInt(beforeRaw)).toString(),consistency:{eventComparison:pair.eventComparison,lastEventAmountRaw:pair.eventAmountRaw,requestComparison:pair.requestComparison}};
  });
  return {id:'offline-reconstructed-envelope',timing:{totalMs:1},request:item.originalRequest,
    source:{provider:'offline',chainId:999,transactionHash:e.transactionHash,transactionIndex:b.transactionIndex,blockNumber:b.number,blockHash:b.hash,timestamp:b.timestamp,mode:'historical_trace',blockBinding:'transaction_hash'},
    ...analysis,coverage:{status:'partial',reasons:['Permission observations do not establish whole-protocol coverage.']},permissions,
    allowanceChanges:{status:'measured',basis:'historical_transaction_position_allowance',allowances,executionIdentity:{transactionHash:e.transactionHash,transactionIndex:b.transactionIndex,postTransactionIndex:(BigInt(b.transactionIndex)+1n).toString(),stateBlockHash:b.hash,blockNumber:b.number,timestamp:b.timestamp,stateBinding:'block_hash_and_transaction_index',headerContext:'original_block',method:'debug_traceCallMany'}},
    evidence:{receipt:structuredClone(item.evidence.receipt),traceResponse:structuredClone(item.evidence.trace)},
  };
}

test('fixed observed inputs have verified original identity, hashes and independent expected amounts',()=>{
  assert.equal(cases.length,3);
  assert.deepEqual(cases.map(c=>c.expected.block.transactionIndex),['1','6','0']);
  assert.equal(cases[0].expected.pairs[0].afterRaw,'1660000000');
  assert.equal(cases[2].expected.pairs[0].afterRaw,'115792089237316195423570985008687907853269984665640564039457584007913104639935');
  assert.equal(cases[2].expected.pairs[1].afterRaw,'0');
  for(const item of cases){assert.deepEqual(validateReplay(item.request),item.request);assert.match(item.evidence.sourceSha256,/^[a-f0-9]{64}$/);assert.equal(item.expected.transactionHash,item.evidence.receipt.transactionHash);}
});

test('all three original envelopes compare while ignoring timings, IDs and provider names',()=>{
  for(const item of cases){
    const a=responseFor(item),b=structuredClone(a);b.id='different';b.source.provider='other';b.timing.totalMs=999;b.allowanceChanges.allowances.reverse();b.allowanceChanges.executionIdentity.extraVerification='extra';
    const result=comparePermissionReports(a,b,item);
    assert.equal(result.status,'matched',JSON.stringify(result.validations.flatMap(v=>v.checks.filter(c=>!c.equal))));
  }
});

test('same wrong amounts, event-as-final substitution and party conflation fail independent expectations',()=>{
  const direct=cases[1],router=cases[2];
  const checks=[
    [router,r=>{const a=r.allowanceChanges.allowances[0];a.afterRaw=a.consistency.lastEventAmountRaw;a.deltaRaw=a.afterRaw;}],
    [router,r=>{const a=r.allowanceChanges.allowances[1];a.afterRaw='24812500';a.deltaRaw='24812500';}],
    [router,r=>{r.allowanceChanges.allowances[0].consistency.eventComparison='matches_last_observed_event';}],
    [direct,r=>{r.permissions.observations.find(o=>o.kind==='permit_request').owner=r.request.from;}],
    [direct,r=>{r.permissions.observations.find(o=>o.kind==='permit_request').submitter=r.expectedOwner;}],
    [router,r=>{r.permissions.observations.find(o=>o.kind==='permit_request').permitCaller=r.request.from;}],
    [direct,r=>{r.permissions.observations.find(o=>o.kind==='permit_request').signatureVerification='cryptographically_verified';}],
    [router,r=>{r.coverage.status='supported';}],
  ];
  for(const [item,mutate] of checks){const r=responseFor(item);mutate(r);assert.equal(comparePermissionReports(r,structuredClone(r),item).status,'mismatched');}
});

test('original trace, receipt, execution identity, and allowance before-values are checked',()=>{
  const item=cases[1];
  for(const mutate of [
    r=>{r.evidence.traceResponse.gasUsed='0x1';},
    r=>{r.evidence.receipt.gasUsed='0x1';},
    r=>{r.allowanceChanges.executionIdentity.transactionIndex='0';},
    r=>{r.allowanceChanges.executionIdentity.headerContext='end_of_block';},
    r=>{const a=r.allowanceChanges.allowances[0];a.beforeRaw='1';a.deltaRaw=(BigInt(a.afterRaw)-1n).toString();},
    r=>{r.permissions.coverage.allowanceStateVerified=false;},
  ]){const first=responseFor(item),second=structuredClone(first);mutate(second);assert.equal(comparePermissionReports(first,second,item).status,'mismatched');}
});

test('unavailable results stay incomplete while malformed claimed measurements fail',()=>{
  const item=cases[0];
  const unavailable=responseFor(item);
  unavailable.allowanceChanges={status:'unavailable',allowances:[]};
  unavailable.permissions.coverage.allowanceStateVerified=false;
  assert.equal(comparePermissionReports(unavailable,responseFor(item),item).status,'incomplete');
  for(const mutate of [
    r=>{r.allowanceChanges.allowances=[];},
    r=>{r.allowanceChanges.allowances.push(r.allowanceChanges.allowances[0]);},
    r=>{r.allowanceChanges.allowances[0].deltaRaw='1.1';},
    r=>{r.allowanceChanges.allowances[0].deltaRaw='0';},
  ]){const r=responseFor(item);mutate(r);assert.equal(comparePermissionReports(r,responseFor(item),item).status,'mismatched');}
  assert.equal(validatePermissionReport(null,item).status,'unavailable');
  const wrong=responseFor(item);wrong.execution.gasUsed='1';
  assert.equal(comparePermissionReports(null,wrong,item).status,'mismatched','one correct availability failure must not hide the other provider\'s mismatch');
});

test('security verdicts or findings fail even when providers agree',()=>{
  const item=cases[1];
  for(const mutate of [
    r=>{r.security.status='safe';},
    r=>{r.security.findings=[{kind:'malicious_spender'}];},
    r=>{delete r.security;},
  ]){
    const report=responseFor(item);mutate(report);
    const result=comparePermissionReports(report,structuredClone(report),item);
    assert.equal(result.status,'mismatched');
    assert.ok(result.validations[0].checks.some(check=>check.name.includes('security')&&!check.equal));
  }
});

test('later malformed evidence cannot mask an earlier independent mismatch',()=>{
  const item=cases[1];
  const report=responseFor(item);
  report.execution.gasUsed='1';
  report.evidence.receipt=null;
  report.allowanceChanges={status:'unavailable',allowances:[]};
  const result=validatePermissionReport(report,item);
  assert.equal(result.status,'mismatched');
  assert.ok(result.checks.some(check=>check.name==='original transaction gas used'&&!check.equal));
  assert.equal(comparePermissionReports(report,null,item).status,'mismatched');
});

test('runner performs exactly six attempts, validates replay inputs and retains successful public RPC data',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'permissions-check-'));let attempts=0;const urls=[];
  try {
    const r=await runPermissionChecks({outputDirectory:directory,rpcFactory:({url})=>{urls.push(url);return {nextId:1,async call(){this.nextId++;return '0x3e7';}};},replayImpl:async(request,rpc)=>{attempts++;assert.deepEqual(validateReplay(request),request);await rpc.call('eth_chainId',[]);return responseFor(cases.find(c=>c.request.transactionHash===request.transactionHash));}});
    assert.equal(r.status,'passed');assert.equal(attempts,6);assert.equal(new Set(urls).size,2);
    assert.deepEqual(r.summary,{matched:3,mismatched:0,incomplete:0,total:3,runs:{planned:6,attempted:6,completed:6,measured:6,unavailable:0,failed:0}});
    assert.equal(r.cases[0].runs[0].rpcCalls[0].response.result,'0x3e7');
    assert.deepEqual(JSON.parse(await readFile(r.outputPath)),r);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('known unavailable provider remains visible and is not counted as a matched comparison',async()=>{
  const r=await runPermissionChecks({writeReport:false,rpcFactory:({url})=>({url,call:async()=>null}),replayImpl:async(request,rpc)=>{
    const item=cases.find(c=>c.request.transactionHash===request.transactionHash),response=responseFor(item);
    if(item===cases[0]&&rpc.url.includes('drpc')){response.allowanceChanges={status:'unavailable',allowances:[]};response.permissions.coverage.allowanceStateVerified=false;}
    return response;
  }});
  assert.equal(r.status,'incomplete');assert.equal(r.summary.matched,2);assert.equal(r.summary.incomplete,1);assert.equal(r.summary.runs.unavailable,1);assert.equal(r.summary.runs.attempted,6);
  assert.equal(r.cases[0].runs[1].validation.status,'matched');
});

test('arbitrary exceptions and nested provider metadata are scrubbed, never retried or saved as success',async()=>{
  const secret='https://private:secret@example.invalid/api-token';
  for(const nested of [false,true]){
    let count=0;
    const r=await runPermissionChecks({writeReport:false,rpcFactory:()=>({nextId:1,async call(){count++;if(nested)return [[{error:{code:-1,message:secret,data:secret}}]];throw new RpcError(secret,'RPC_EXECUTION_ERROR',{rpcCode:-32602,url:secret});}}),replayImpl:async(_request,rpc)=>{await rpc.call('debug_traceCallMany',[]);throw new Error('Unexpected successful unsafe result.');}});
    assert.equal(count,6);assert.equal(r.summary.runs.failed,6);assert.equal(r.summary.incomplete,3);assert.equal(JSON.stringify(r).includes(secret),false);
    for(const item of r.cases)for(const run of item.runs){assert.ok(run.error);assert.equal(run.rpcCalls[0].response,undefined);assert.ok(run.rpcCalls[0].error);}
  }
});
