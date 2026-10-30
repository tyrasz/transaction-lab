import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { POLICY, REQUEST, STEPS, sha, json } from './contract.mjs';
import { prepare, run, sourceIdentity, writer, httpExchange, clock } from './run.mjs';
import { verifyApiReport, verifyEvidence } from './verify.mjs';
import { loadLocalApi } from '../../src/local-loader.js';
import { amsterdamExecutionFixture } from '../../engines/local-evm/test/amsterdam-execution-fixture.js';
import { sepoliaApiTransport } from '../../test/local-sepolia-fixture.js';

function wire(index,value,now,status=200) {
  const requestText=index===2?JSON.stringify(REQUEST):'',body=Buffer.from(JSON.stringify(value));
  return {index,method:STEPS[index].method,url:POLICY.origin+STEPS[index].path,requestText,requestBytes:Buffer.byteLength(requestText),requestSha256:sha(requestText),
    started:now(),finished:now(),timeoutMs:index<2?10000:169000,httpStatus:status,responseHeaders:['content-type','application/json'],responseBase64:body.toString('base64'),responseBytes:body.length,responseSha256:sha(body),observedBytes:body.length,
    completeBody:true,requestClosed:true,responseClosed:true,dispatched:true,error:null};
}
let fixtureResult;
async function genuine() {
  return fixtureResult??= (async()=>{
    const f=await amsterdamExecutionFixture({priced:false,accounts:{[REQUEST.from]:{nonce:1n,balance:10n**18n,code:'0x'},[REQUEST.to]:{nonce:1n,balance:9n,code:'0x'}}});
    const api=await loadLocalApi(),p=sepoliaApiTransport(f),report=await api.simulateLocal(REQUEST,p.rpc); p.check(report);
    assert.equal(report.status,'complete',JSON.stringify(report.error)); return {api,report};
  })();
}
test('native HTTP recorder preserves bytes/closure and rejects oversize or late bodies without retry',async()=>{
  for(const mode of['ok','oversize','late']) {
    let time=0,dispatches=0;const now=clock({wall:()=>time,mono:()=>time});
    const requestImpl=(_url,_options,callback)=>{
      dispatches++;const req=new EventEmitter(),res=new EventEmitter();res.statusCode=200;res.rawHeaders=[];
      let closed=false;const close=()=>{if(closed)return;closed=true;res.emit('close');req.emit('close');};req.destroy=close;res.destroy=close;
      req.end=()=>queueMicrotask(()=>{callback(res);if(mode==='late')time=POLICY.totalMs+1;res.emit('data',Buffer.alloc(mode==='oversize'?POLICY.setupBytes+1:2,0x20));if(!closed){res.emit('end');close();}});
      return req;
    };
    const row=await httpExchange({index:0,step:STEPS[0],now,requestImpl});assert.equal(dispatches,1);assert.equal(row.requestClosed,true);assert.equal(row.responseClosed,true);
    assert.equal(row.responseSha256,sha(Buffer.from(row.responseBase64,'base64')));
    if(mode==='ok')assert.equal(row.error,null);else assert(row.error);
  }
});
test('actual API/isolated synthetic native report verifies, while coordinated balance and context forgeries fail',async()=>{
  const {api,report}=await genuine(),good=await verifyApiReport(report,api.implementation);
  assert.equal(good.usable,true);assert.deepEqual(good.native.map(r=>r.deltaRaw),['-'+REQUEST.value,REQUEST.value]);
  for(const mutate of[
    r=>{for(const m of[r.measurements[0],r.attempt.preview.measurements[0]]){m.values[0].beforeRaw=String(BigInt(m.values[0].beforeRaw)+1n);m.values[0].afterRaw=String(BigInt(m.values[0].afterRaw)+1n);}},
    r=>r.measurements[0].identity.chainId='1',r=>r.attempt.isolation.processClosed=false,r=>r.source.blockSelection.header.slotNumber='0x1',
    r=>r.attempt.preview.original.output.feeAccounting={},r=>r.transportEvidence.at(-1).request.params[0]='latest',
  ]){const bad=structuredClone(report);mutate(bad);await assert.rejects(verifyApiReport(bad,api.implementation));}
});
test('one mocked HTTP sequence seals genuine proof data, rejects saved-byte mutation and refuses a second dispatch',async()=>{
  const {api,report}=await genuine(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'sepolia-api-live-')),directory=path.join(temp,'capture');
  try {
    const prepared=await prepare(directory),seen=[];
    const result=await run({directory,planSha256:prepared.planSha256,exchange:async({index,step,now})=>{
      seen.push(step.path);return wire(index,index===0?{status:'ok',readOnly:true,version:api.implementation.version}:index===1?{localEvm:{available:true,capabilities:api.LOCAL_CAPABILITIES,examples:api.LOCAL_EXAMPLES}}:report,now);
    }});
    assert.deepEqual(seen,STEPS.map(s=>s.path));assert.equal(result.usable,true);
    assert.equal((await verifyEvidence({directory,manifestSha256:result.manifestSha256,planSha256:prepared.planSha256})).usable,true);
    await assert.rejects(run({directory,planSha256:prepared.planSha256,exchange:()=>{assert.fail('Second target dispatch');}}));
    fs.appendFileSync(path.join(directory,'api-response.json'),' ');
    await assert.rejects(verifyEvidence({directory,manifestSha256:result.manifestSha256,planSha256:prepared.planSha256}));
  }finally{fs.rmSync(temp,{recursive:true});}
});
test('HTTP/API rejection and a terminal deadline overrun remain retained unusable single attempts',async()=>{
  const {api,report}=await genuine();
  for(const mode of['http-error','late']){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sepolia-api-failure-')),directory=path.join(temp,'capture');let time=0;
    try {
      const prepared=await prepare(directory);const identity=async()=>{const value=await sourceIdentity();if(fs.existsSync(path.join(directory,'http-3.json'))&&mode==='late')time=POLICY.totalMs+1;return value;};
      const result=await run({directory,planSha256:prepared.planSha256,identity,clockOptions:{wall:()=>time,mono:()=>time},exchange:async({index,now})=>wire(index,index===0?{status:'ok',readOnly:true,version:api.implementation.version}:index===1?{localEvm:{available:true,capabilities:api.LOCAL_CAPABILITIES,examples:api.LOCAL_EXAMPLES}}:mode==='http-error'?{error:{code:'UNSUPPORTED_CHAIN'}}:report,now,index===2&&mode==='http-error'?400:200)});
      assert.equal(result.usable,false);assert.equal(result.postDispatched,true);assert.equal(result.httpRequests,3);
      assert.equal((await verifyEvidence({directory,manifestSha256:result.manifestSha256,planSha256:prepared.planSha256})).usable,false);
    }finally{fs.rmSync(temp,{recursive:true});}
  }
});
test('write ledger refuses substituted saved artifacts before sealing',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sepolia-api-writer-'));
  try{const directory=path.join(temp,'capture'),w=writer(directory);w.save('fixed.json',{fixed:true});fs.writeFileSync(path.join(directory,'fixed.json'),json({fixed:false}));assert.throws(()=>w.seal());}
  finally{fs.rmSync(temp,{recursive:true});}
});
