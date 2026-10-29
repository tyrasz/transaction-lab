import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.js';
import { loadLocalApi } from '../src/local-loader.js';
import { simulateLocal, validateLocalSimulation, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { InputError } from '../src/validate.js';
import { feeFixture, TX_SENDER, TARGET, COINBASE } from '../engines/local-evm/test/fee-fixture.js';
import { native, UNUSED, ABSENT, assertNativeMeasurement } from '../engines/local-evm/test/native-balance-fixture.js';

const inputFor=(f,queries)=>({chainId:1,...f.request,block:f.header.hash,queries});
const tokenQuery=()=>({to:TARGET,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});

// Real ProofRpcClient and child process, but only synthetic initial proof/code
// data behind a strict fake fetch. No network, trace-derived state or expected
// poststate is available to the executor.
function transport(f,{missing=false,corrupt=false,changedFinal=false,cancelFinal}={}){
  const wires=[],errors=[];let finalHeaders=0;
  const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(url,options)=>{
    try{
      assert.equal(String(url),'https://fixture.invalid/');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
      const request=JSON.parse(options.body);wires.push(request);assert.equal(request.id,wires.length);assert.equal(request.jsonrpc,'2.0');
      let result,error;
      if(request.method==='eth_chainId'){assert.equal(wires.length,1);assert.deepEqual(request.params,[]);result='0x1';}
      else if(request.method==='eth_getBlockByHash'){assert.equal(wires.length,2);assert.deepEqual(request.params,[f.header.hash,false]);result=f.header;}
      else if(request.method==='eth_getBlockByNumber'){
        finalHeaders++;assert.equal(finalHeaders,1);assert.deepEqual(request.params,[f.header.number,false]);
        if(cancelFinal)cancelFinal.abort();result=changedFinal?{...f.header,syntheticUnboundMetadata:true}:f.header;
      }else{
        assert(['eth_getProof','eth_getCode'].includes(request.method),'No provider execution, unpinned account read or extra method is permitted');
        assert.deepEqual(request.params.at(-1),{blockHash:f.header.hash,requireCanonical:true});
        if(request.method==='eth_getProof'&&request.params[0]===UNUSED&&missing)error={code:-32000,message:'Synthetic missing account proof'};
        else{result=await f.rpc.call(request.method,request.params);if(request.method==='eth_getProof'&&request.params[0]===UNUSED&&corrupt)result={...result,balance:'0x0'};}
      }
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})}),{headers:{'content-type':'application/json'}});
    }catch(error){errors.push(error.message);throw error;}
  }});
  return{rpc,wires,assertClean(report,{final=true}={}){assert.deepEqual(errors,[],'Fake transport assertions must survive engine catches');assert.equal(finalHeaders,final?1:0);assert.equal(report.transportEvidence.length,wires.length);for(let i=0;i<wires.length;i++)assert.deepEqual(JSON.parse(report.transportEvidence[i].requestText),wires[i]);assert.equal(report.drain.complete,true);}};
}

async function throughHandler(t,input,rpc){
  const api=await loadLocalApi();assert(api);const reportDir=await mkdtemp(path.join(os.tmpdir(),'native-api-'));t.after(()=>rm(reportDir,{recursive:true,force:true}));
  let body,status,factories=0;const server=createAppServer({reportDir,persist:true,localLoader:async()=>api,proofRpcFactory(){factories++;return rpc;},standardRpcFactory(){assert.fail('Provider simulation attempted');},rpcFactory(){assert.fail('Legacy simulation attempted');}});
  const req=Readable.from([Buffer.from(JSON.stringify(input))]);Object.assign(req,{method:'POST',url:'/api/evm/local-preview',headers:{host:'127.0.0.1','content-type':'application/json'},aborted:false});
  const res=new EventEmitter();Object.assign(res,{statusCode:200,writableEnded:false,destroyed:false,writeHead(code){this.statusCode=code;return this;},end(value){status=this.statusCode;body=String(value);this.writableEnded=true;return this;}});
  try{await server.listeners('request')[0](req,res);}finally{req.destroy();server.close();}
  assert.equal(status,200,body);assert.equal(factories,1);const report=JSON.parse(body);assert.deepEqual(report.implementation,api.implementation);
  assert.deepEqual(JSON.parse(await readFile(path.join(reportDir,'simulations',report.id+'.json'),'utf8')),report,'Persisted report must preserve null query/output and exact native units');return report;
}

test('native descriptors are detached, normalized and share the combined eight-query limit',async()=>{
  const f=await feeFixture(),mixed=[native(TX_SENDER),tokenQuery()],request=inputFor(f,mixed),normalized=validateLocalSimulation(request);
  assert.deepEqual(normalized.queries,mixed);assert.notEqual(normalized.queries,request.queries);request.queries[0].account=UNUSED;assert.equal(normalized.queries[0].account,TX_SENDER);
  assert(LOCAL_CAPABILITIES.queryTypes.includes('native_balance'));
  const addresses=Array.from({length:7},(_,i)=>'0x'+BigInt(i+1000).toString(16).padStart(40,'0'));
  assert.equal(validateLocalSimulation(inputFor(f,[...addresses.map(native),tokenQuery()])).queries.length,8);
  assert.throws(()=>validateLocalSimulation(inputFor(f,[...addresses.map(native),native(TX_SENDER),tokenQuery()])),InputError);
  for(const queries of [[native(TX_SENDER),native(TX_SENDER)], [native('0x1234')], [{...native(TX_SENDER),expected:'1'}], [{...native(TX_SENDER),token:TARGET}], [{kind:'native_balance'}], [{kind:'native_balance',account:TX_SENDER,query:null}]]){
    await assert.rejects(simulateLocal(inputFor(f,queries),{call(){assert.fail('Malformed query dispatched');}}),InputError);
  }
});

test('real HTTP handler/core/child serialize native fee transfer and cached unused-account proofs',async t=>{
  const f=await feeFixture({value:'123',target:{nonce:1n,balance:9n,code:'0x'},accounts:{[UNUSED]:{nonce:3n,balance:77n,code:'0xfe'}}}),p=transport(f);
  const request=inputFor(f,[TX_SENDER,TARGET,COINBASE,UNUSED,ABSENT].map(native)),report=await throughHandler(t,request,p.rpc);p.assertClean(report);
  assert.equal(report.status,'complete',JSON.stringify(report.error));assert.equal(report.source.canonicalStatus,'verified');assert.equal(report.execution.status,'success');assert.deepEqual(report.apiRequest,request);
  assert.equal(report.attempt.isolation.processSeparated,true);assert.notEqual(report.attempt.isolation.childPid,process.pid);assert.equal(report.attempt.isolation.processClosed,true);assert.equal(report.attempt.broker.pendingAtReturn,0);
  const core=report.attempt.preview,fees=core.original.output.feeAccounting;
  const expected=[[TX_SENDER,1000000000000n,1000000000000n-123n-BigInt(fees.gasCharge)],[TARGET,9n,132n],[COINBASE,0n,BigInt(fees.coinbaseTip)],[UNUSED,77n,77n],[ABSENT,0n,0n]];
  expected.forEach(([address,before,after],i)=>{assertNativeMeasurement(report.measurements[i],address,before,after);assertNativeMeasurement(core.measurements[i],address,before,after,core.original.changes);});
  assert.equal(core.usage.executions,1);assert.equal(core.scope.nativeBalanceCoverage,'explicit_accounts_only');
  for(const address of [UNUSED,ABSENT])assert.deepEqual(p.wires.filter(r=>r.params[0]===address).map(r=>r.method),['eth_getProof','eth_getCode']);
});

test('mixed native and declared scalar queries stay distinct and only CALL queries use VM executions',async()=>{
  const f=await feeFixture({value:'7',target:{nonce:1n,balance:9n,code:'0x4760005260206000f3'}}),p=transport(f),report=await simulateLocal(inputFor(f,[native(TARGET),tokenQuery(),native(TX_SENDER)]),p.rpc);p.assertClean(report);
  assert.equal(report.status,'complete',JSON.stringify(report.error));const core=report.attempt.preview;assert.equal(core.usage.executions,3);
  assertNativeMeasurement(report.measurements[0],TARGET,9n,16n);assert.equal(report.measurements[1].identity.kind,'balanceOf');assert.deepEqual(report.measurements[1].query,tokenQuery());
  assert.equal(report.measurements[1].values[0].unit.kind,'token_raw_units');assert.equal(report.measurements[1].values[0].beforeRaw,'9');assert.equal(report.measurements[1].values[0].afterRaw,'16');
  assert.equal(core.measurements[0].before.output,null);assert.equal(core.measurements[0].after.output,null);
  assert.equal(core.measurements[1].before.output.profile.declaredGasLimit,'1000000');assert.equal(core.measurements[1].after.output.profile.feesSettled,false);
});

test('native API reports completed revert and fee debit without inventing a transferred value',async()=>{
  const f=await feeFixture({value:'17',target:{nonce:1n,balance:9n,code:'0x60006000fd'}}),p=transport(f),report=await simulateLocal(inputFor(f,[native(TX_SENDER),native(TARGET),native(COINBASE)]),p.rpc);p.assertClean(report);
  assert.equal(report.status,'complete',JSON.stringify(report.error));assert.equal(report.execution.status,'reverted');const fees=report.attempt.preview.original.output.feeAccounting;
  assertNativeMeasurement(report.measurements[0],TX_SENDER,1000000000000n,1000000000000n-BigInt(fees.gasCharge));assertNativeMeasurement(report.measurements[1],TARGET,9n,9n);assertNativeMeasurement(report.measurements[2],COINBASE,0n,BigInt(fees.coinbaseTip));
});

test('missing or cryptographically inconsistent extra native proof cannot become a zero balance',async()=>{
  for(const options of [{missing:true},{corrupt:true}]){
    const f=await feeFixture({accounts:{[UNUSED]:{nonce:2n,balance:77n,code:'0x'}}}),p=transport(f,options),report=await simulateLocal(inputFor(f,[native(TX_SENDER),native(UNUSED),native(TARGET)]),p.rpc);p.assertClean(report);
    assert.equal(report.status,'partial',JSON.stringify(report.error));assert.equal(report.execution.status,'success');assert.equal(report.source.canonicalStatus,'verified');
    assert.deepEqual(report.measurements.map(m=>m.status),['measured','unavailable','not_attempted']);assert(report.measurements[0].values);assert.equal(report.measurements[1].values,null);assert.equal(report.measurements[2].values,null);
    assert.equal(report.attempt.preview.inputUsage.status,'unavailable');assert.equal(report.attempt.preview.usage.executions,1);assert.equal(p.wires.filter(r=>r.params[0]===UNUSED).length,1);
  }
});

test('final full-header disagreement withholds every native amount while retaining non-measurement audit',async()=>{
  const f=await feeFixture({value:'5'}),p=transport(f,{changedFinal:true}),report=await simulateLocal(inputFor(f,[native(TX_SENDER),native(TARGET)]),p.rpc);p.assertClean(report);
  assert.equal(report.status,'unavailable');assert.equal(report.error.code,'LOCAL_PREVIEW_CANONICAL');assert.equal(report.source.canonicalStatus,'unverified');assert.deepEqual(report.measurements,[]);assert.equal(report.attempt.preview,null);
  assert.equal(report.audit.status,'unverified_not_a_measurement');assert.equal(report.audit.original.output.execution.status,'success');
});

test('cancellation after completed native reads withholds their values before API return',async()=>{
  const f=await feeFixture(),controller=new AbortController(),p=transport(f,{cancelFinal:controller}),report=await simulateLocal(inputFor(f,[native(TX_SENDER),native(TARGET)]),p.rpc,{signal:controller.signal});p.assertClean(report);
  assert.equal(controller.signal.aborted,true);assert.equal(report.status,'unavailable');assert.equal(report.error.code,'LOCAL_PREVIEW_CANCELLED');assert.deepEqual(report.measurements,[]);assert.equal(report.attempt.preview,null);assert.equal(report.source.canonicalStatus,'unverified');
  assert.equal(report.attempt.isolation.processClosed,true);assert.equal(report.attempt.broker.pendingAtReturn,0);
});
