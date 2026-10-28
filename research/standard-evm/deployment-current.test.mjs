import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStandardApi } from '../../src/standard-loader.js';
import { lifecycleFixture, createdAddress, word } from '../../engines/local-evm/test/lifecycle-fixture.js';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { DEPLOYMENT_CASE as C, DEPLOYMENT_POLICY, compareDeployment, deploymentProviderRequests, freezeDeployment, checkDeployment, deriveDeploymentTarget } from './deployment-current.mjs';

// Synthetic cryptographically proved prestate and actual isolated execution.
// Synthetic provider outputs are built only AFTER local execution; these are
// binding/mismatch controls, never a new observation of a public provider.
const hex=n=>'0x'+BigInt(n).toString(16);
let basePromise;
async function fixture({prefunded=false,nonce=1n}={}) {
  const target=createdAddress({creator:C.sender,nonce});
  const f=await lifecycleFixture({accounts:{
    [C.sender]:{nonce,balance:1000000n,code:'0x'},
    ...(prefunded?{[target]:{nonce:0n,balance:17n,code:'0x'}}:{}),
  }});
  const local=await executeIsolatedEthereumCall({request:C.request,header:f.header,rpc:f.rpc});
  assert.equal(local.status,'completed',JSON.stringify(local.error));
  assert.equal(local.output.execution.status,'success',JSON.stringify(local.output.execution));
  assert.equal(local.output.trace.output,C.runtime);
  assert.equal(local.output.execution.returnData,C.runtime);
  const state=local.changes.accounts.find(row=>row.address===target);
  assert.equal(state.code.after,C.runtime);assert.equal(state.storage[0].after,word(42));
  const root=local.output.trace;
  const frame=value=>({type:value.type,from:value.from,to:value.to,input:value.input,output:value.output,value:hex(value.value),gas:hex(value.gas),gasUsed:hex(value.gasUsed)});
  const trace={...frame(root),gas:'0x4c4b40',gasUsed:hex(local.output.gasAccounting.gasUsed),calls:[]};
  const diff={pre:{},post:{}};
  for(const row of local.changes.accounts){
    const initial=local.inputs.accounts[row.address],pre={},post={};
    if(initial.exists)diff.pre[row.address]=pre;
    diff.post[row.address]=post;
    for(const field of ['nonce','balance'])if(row[field]){if(initial.exists)pre[field]=row[field].before;post[field]=row[field].after;}
    if(row.code)post.code=row.code.after;
    if(row.storage){post.storage={};for(const slot of row.storage){if(BigInt(slot.before)!==0n)(pre.storage??={})[slot.slot]=slot.before;post.storage[slot.slot]=slot.after;}}
  }
  const values=[trace,diff,f.header];
  const provider=deploymentProviderRequests(f.header).map((request,i)=>({status:'completed',request:{jsonrpc:'2.0',id:i+1,...request},parsed:{jsonrpc:'2.0',id:i+1,result:values[i]}}));
  return{header:f.header,local,provider,rpc:f.rpc,target};
}
async function base(){basePromise??=fixture();const {header,local,provider,target}=await basePromise;return structuredClone({header,local,provider,target});}
async function mutate(fn){const data=await base();fn(data);return compareDeployment(data);}

test('fixed initcode runs root CREATE and its address comes from the proved sender nonce',async()=>{
  const data=await base(),result=await compareDeployment(data),derived=await deriveDeploymentTarget(data);
  assert.equal((C.runtime.length-2)/2,11);assert.equal(C.initcode.slice(12,18),'61000b');
  assert.equal(C.request.to,null);assert.equal(C.request.data,C.initcode);
  assert.equal(derived.address,data.target);assert.equal(derived.senderNonceRaw,'1');
  assert.equal(result.status,'match',JSON.stringify(result));assert.equal(result.allChannelsComplete,true);
  assert.deepEqual(result.channels,{execution:true,returnData:true,gas:true,logs:true,state:true});
  assert.equal(result.gas.creationIntrinsic,'32000');assert.equal(result.gas.initcodeWordGas,'2');
  assert.equal(result.gas.message,'24330');
  assert.equal(DEPLOYMENT_POLICY.calls,2+DEPLOYMENT_POLICY.localCalls+DEPLOYMENT_POLICY.providerCalls);
  assert.ok(DEPLOYMENT_POLICY.wallMs+DEPLOYMENT_POLICY.drainMs<=DEPLOYMENT_POLICY.liveAndDrainCeilingMs);
  assert.ok(data.local.inputEvidence.every(row=>['eth_getProof','eth_getCode'].includes(row.request.method)));
});

test('nonce zero and multibyte sender nonce independently derive the actual root address',async()=>{
  for(const nonce of [0n,128n]){
    const data=await fixture({nonce}),derived=await deriveDeploymentTarget(data),result=await compareDeployment(data);
    assert.equal(derived.address,data.target);assert.equal(derived.senderNonceRaw,nonce.toString());
    assert.equal(result.status,'match',JSON.stringify(result));
  }
});

test('proven prefunded target preserves balance without an invented existence change',async()=>{
  const data=await fixture({prefunded:true}),result=await compareDeployment(data);
  assert.equal(result.status,'match',JSON.stringify(result));
  const target=result.providerChanges.accounts.find(row=>row.address===data.target);
  assert.equal(Object.hasOwn(target,'existence'),false);assert.equal(Object.hasOwn(target,'balance'),false);
  assert.equal(data.local.inputs.provenance.find(row=>row.account===data.target).accountProof.balanceRaw,'17');
});

test('complete code, storage, native balance and target nonce differences never pass',async()=>{
  for(const edit of [
    x=>{x.provider[1].parsed.result.post[x.target].storage[word(0)]=word(43);},
    x=>{delete x.provider[1].parsed.result.post[x.target].storage;},
    x=>{x.provider[1].parsed.result.post[x.target].nonce='0x2';},
    x=>{x.provider[1].parsed.result.post[x.target].balance='0x1';},
    x=>{x.provider[1].parsed.result.post[x.target].code='0x00';x.provider[0].parsed.result.output='0x00';},
  ]) {const result=await mutate(edit);assert.equal(result.status,'mismatch',JSON.stringify(result));assert.equal(result.channels.state,false);}
});

test('unproved initial facts, wrong sender nonce, account deletion and incomplete diff fail closed',async()=>{
  for(const edit of [
    x=>{x.local.inputs.provenance=x.local.inputs.provenance.filter(row=>row.account!==x.target);},
    x=>{x.local.inputs.accounts[C.sender].nonce='2';},
    x=>{x.local.inputs.provenance.find(row=>row.account===x.target).accountProof.storageRoot='0x'+'12'.repeat(32);},
    x=>{delete x.provider[1].parsed.result.post[C.sender];},
    x=>{x.provider[1].parsed.result={pre:{},post:{}};},
    x=>{delete x.provider[1].parsed.result.pre[C.sender].nonce;},
    x=>{delete x.provider[1].parsed.result.pre[C.sender];},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));assert.equal(result.allChannelsComplete,false);}
});

test('provider envelope, explicit null, full header and unpriced state context must bind exactly',async()=>{
  for(const edit of [
    x=>{x.provider[2].parsed.result={...x.header,size:'0x1234'};},
    x=>{x.provider[0].request.params[0].to=x.target;},
    x=>{delete x.provider[0].request.params[0].to;},
    x=>{x.provider[0].request.params[0].gas='0x4c4b3f';},
    x=>{x.provider[0].request.params[1].blockHash='0x'+'12'.repeat(32);},
    x=>{delete x.provider[1].request.params[2].blockOverrides;},
    x=>{x.provider[1].request.params[2].stateOverrides={};},
    x=>{x.provider[0].parsed.id++;},
    x=>{x.provider[0].parsed.error=null;},
    x=>{x.provider[0].parsed.result.input='0x';},
    x=>{x.provider[0].parsed.result.to=C.sender;},
    x=>{x.provider[0].parsed.result.value='0x1';},
    x=>{x.provider[0].parsed.result.error=null;},
    x=>{x.provider[0].parsed.result.error='';},
    x=>{x.provider[0].parsed.result.revertReason='hidden failure';},
    x=>{x.provider[0].parsed.result.output=null;},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));}
});

test('known status and gas mismatches survive a later incomplete state channel',async()=>{
  const failed=await mutate(x=>{x.provider[0].parsed.result.error='execution reverted';x.provider[0].parsed.result.output='0x';x.provider[1].parsed.result={pre:{},post:{}};});
  assert.equal(failed.status,'mismatch');assert.equal(failed.channels.execution,false);assert.equal(failed.allChannelsComplete,false);
  const gas=await mutate(x=>{x.provider[0].parsed.result.gasUsed=hex(BigInt(x.provider[0].parsed.result.gasUsed)+1n);x.provider[1].parsed.result={pre:{},post:{}};});
  assert.equal(gas.status,'mismatch');assert.equal(gas.channels.gas,false);assert.equal(gas.allChannelsComplete,false);
});

test('valid unexpected root logs are mismatches and root gas disagreement survives unexpected valid children',async()=>{
  const logs=await mutate(x=>{x.provider[0].parsed.result.logs=[{address:x.target,topics:[word(1)],data:'0x',position:'0x0',index:'0x0'}];});
  assert.equal(logs.status,'mismatch');assert.equal(logs.channels.logs,false);assert.equal(logs.allChannelsComplete,true);
  const gas=await mutate(x=>{
    const root=x.provider[0].parsed.result;root.gasUsed=hex(BigInt(root.gasUsed)+1n);
    root.calls=[{type:'CALL',from:x.target,to:C.sender,input:'0x',output:'0x',value:'0x0',gas:'0x100',gasUsed:'0x0'}];
  });
  assert.equal(gas.status,'mismatch');assert.equal(gas.channels.gas,false);assert.equal(gas.allChannelsComplete,false);
  assert.equal(gas.reason,'provider_calls_outside_fixed_scope');
  for(const edit of [
    x=>{x.provider[0].parsed.result.calls=[{}];},
    x=>{x.provider[0].parsed.result.logs=[{address:x.target,topics:['0x1'],data:'0x'}];},
    x=>{x.provider[0].parsed.result.logs=[{address:x.target,topics:[],data:'0x',position:'0x00'}];},
  ])assert.equal((await mutate(edit)).status,'unavailable');
});

test('wrong root operation, unexpected descendants/logs and forged local context remain unavailable',async()=>{
  for(const edit of [
    x=>{x.provider[0].parsed.result.type='CALL';},
    x=>{x.provider[0].parsed.result.calls=[structuredClone(x.provider[0].parsed.result)];},
    x=>{x.provider[0].parsed.result.logs=[{}];},
    x=>{x.local.output.environment.baseFeePerGas='1';},
    x=>{x.local.output.profile.creationIntrinsicGas='0';},
    x=>{x.local.output.profile.initcodeWordGas='0';},
    x=>{x.local.output.profile.operation='call';},
    x=>{x.local.output.gasAccounting.gasUsed='1';},
    x=>{x.local.output.trace.to=C.sender;},
    x=>{x.local.output.trace.error='revert';},
    x=>{x.local.status='unavailable';},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));}
});

test('omitted output means empty and cannot match deployed runtime even if other channels are incomplete',async()=>{
  const result=await mutate(x=>{delete x.provider[0].parsed.result.output;});
  assert.equal(result.status,'mismatch');assert.equal(result.channels.returnData,false);assert.equal(result.allChannelsComplete,false);
});

// A complete disposable archive and run, with the global fetch implementation
// replaced before transport creation. No sockets or public RPCs are used.
test('archived runner captures exact proof-first wire order, seals once, and rejects source drift',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'deployment-current-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const directory=join(temp,'capture'),fixtureData=await fixture();
  const implementation=(await loadStandardApi()).implementation;
  const frozen=await freezeDeployment({outputDirectory:directory,expectedProductSha256:implementation.sourceSha256});
  await checkDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
  const archived=await import(pathToFileURL(join(directory,'runtime/research/standard-evm/deployment-current.mjs')));
  const seen=[],originalFetch=globalThis.fetch;let providerStarted=false,unexpected=null;
  globalThis.fetch=async(url,options)=>{
    try{
      assert.equal(String(url),'https://eth.drpc.org/');
      const request=JSON.parse(options.body);seen.push(request);
      let result;
      if(request.method==='eth_chainId')result='0x1';
      else if(request.method==='eth_getBlockByNumber'){
        assert.deepEqual(request.params,[providerStarted?fixtureData.header.number:'latest',false]);
        result=fixtureData.header;
      }else if(['eth_getProof','eth_getCode'].includes(request.method)){
        assert.equal(providerStarted,false);result=await fixtureData.rpc.call(request.method,request.params);
      }else{
        providerStarted=true;
        // The persisted local attempt exists before any provider execution.
        const saved=JSON.parse(await readFile(join(directory,'local.json'),'utf8'));
        assert.equal(saved.attempt.output.execution.status,'success');
        const index=request.params[2].tracer==='callTracer'?0:1;
        assert.deepEqual({method:request.method,params:request.params},deploymentProviderRequests(fixtureData.header)[index]);
        result=fixtureData.provider[index].parsed.result;
      }
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200});
    }catch(error){unexpected=error;throw error;}
  };
  try{
    const result=await archived.runDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
    assert.equal(unexpected,null);assert.equal(result.status,'complete',JSON.stringify(result));
    assert.equal(result.comparison.status,'match',JSON.stringify(result.comparison));
    assert.equal(result.sourceUnchanged,true);assert.equal(result.runtimeUnchanged,true);
    assert.equal(result.budget.calls,seen.length);assert.equal(result.budget.dispatches,seen.length);
    let retained=0;
    for(let i=1;i<=seen.length;i++){
      const wire=JSON.parse(await readFile(join(directory,`wire/${String(i).padStart(6,'0')}.json`),'utf8'));
      const raw=Buffer.from(wire.rawBase64,'base64'),sha=value=>createHash('sha256').update(value).digest('hex');
      assert.equal(wire.requestSha256,sha(JSON.stringify(seen[i-1])));assert.equal(wire.responseSha256,sha(raw));
      assert.equal(wire.transport.observedBytes,raw.length);assert.equal(wire.transport.retainedBytes,raw.length);
      assert.deepEqual(wire.parsed,JSON.parse(raw));retained+=raw.length;
    }
    assert.equal(result.budget.observedBytes,retained);
    assert.deepEqual(JSON.parse(await readFile(join(directory,'target.json'),'utf8')),result.comparison.target);
    assert.deepEqual(seen.slice(0,2).map(x=>x.method),['eth_chainId','eth_getBlockByNumber']);
    assert.deepEqual(seen.slice(-3).map(x=>x.method),['debug_traceCall','debug_traceCall','eth_getBlockByNumber']);
    const before=seen.length;
    await assert.rejects(archived.runDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}),{code:'artifact_save_failed'});
    assert.equal(seen.length,before);
  }finally{globalThis.fetch=originalFetch;}
  await appendFile(join(directory,'runtime/research/standard-evm/deployment-current.mjs'),'\n// drift control\n');
  await assert.rejects(checkDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}));
});

for(const failurePhase of ['local','provider'])test(`archived ${failurePhase} failure is sealed without retries or fabricated comparison`,async t=>{
  const temp=await mkdtemp(join(tmpdir(),'deployment-failure-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const directory=join(temp,'capture'),data=await fixture(),implementation=(await loadStandardApi()).implementation;
  const frozen=await freezeDeployment({outputDirectory:directory,expectedProductSha256:implementation.sourceSha256});
  const archived=await import(pathToFileURL(join(directory,'runtime/research/standard-evm/deployment-current.mjs')));
  const originalFetch=globalThis.fetch,seen=[];let providerStarted=false,unexpected=null;
  globalThis.fetch=async(url,options)=>{
    try{
      assert.equal(String(url),'https://eth.drpc.org/');const request=JSON.parse(options.body);seen.push(request);
      let result,error;
      if(request.method==='eth_chainId')result='0x1';
      else if(request.method==='eth_getBlockByNumber'){
        assert.deepEqual(request.params,[providerStarted?data.header.number:'latest',false]);result=data.header;
      }else if(['eth_getProof','eth_getCode'].includes(request.method)){
        assert.equal(providerStarted,false);
        if(failurePhase==='local'){
          assert.equal(request.method,'eth_getProof');assert.deepEqual(request.params,[C.sender,[],{blockHash:data.header.hash,requireCanonical:true}]);
          error={code:-32000,message:'Synthetic historical proof unavailable'};
        }else result=await data.rpc.call(request.method,request.params);
      }else{
        providerStarted=true;assert.equal(request.method,'debug_traceCall');
        const local=JSON.parse(await readFile(join(directory,'local.json'),'utf8'));
        assert.equal(local.attempt.output.execution.status,failurePhase==='local'?'unavailable':'success');
        const target=JSON.parse(await readFile(join(directory,'target.json'),'utf8'));
        assert.equal(target.status,failurePhase==='local'?'unavailable':'verified');
        const index=request.params[2].tracer==='callTracer'?0:1;
        assert.deepEqual({method:request.method,params:request.params},deploymentProviderRequests(data.header)[index]);
        if(failurePhase==='provider')error={code:-32602,message:'Synthetic creation trace unsupported'};
        else result=data.provider[index].parsed.result;
      }
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})}),{status:200});
    }catch(error){unexpected=error;throw error;}
  };
  try{
    const result=await archived.runDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
    assert.equal(unexpected,null);assert.equal(result.comparison.status,'unavailable');assert.equal(result.comparison.allChannelsComplete,false);
    assert.equal(result.sourceUnchanged,true);assert.equal(result.runtimeUnchanged,true);
    assert.equal(result.budget.calls,seen.length);assert.equal(result.budget.dispatches,seen.length);
    const failed=[];
    for(let i=1;i<=seen.length;i++){
      const wire=JSON.parse(await readFile(join(directory,`wire/${String(i).padStart(6,'0')}.json`),'utf8'));
      if(wire.status==='failed')failed.push(wire);
    }
    assert.equal(failed.length,1);assert.equal(failed[0].parsed.error.code,failurePhase==='local'?-32000:-32602);
    if(failurePhase==='local'){
      assert.equal(result.localStatus,'unavailable');assert.equal(result.targetStatus,'unavailable');assert.equal(result.providerRequests,3);
      assert.equal(seen.filter(row=>row.method==='eth_getProof').length,1);
    }else{
      assert.equal(result.status,'incomplete');assert.equal(result.localStatus,'success');assert.equal(result.providerRequests,1);
      assert.equal(seen.filter(row=>row.method==='debug_traceCall').length,1);
      assert.equal(seen.filter(row=>row.method==='eth_getBlockByNumber').length,1);
      assert(result.failures.some(row=>row.phase==='provider'&&row.code==='rpc_error'));
    }
    const before=seen.length;await assert.rejects(archived.runDeployment({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}),{code:'artifact_save_failed'});assert.equal(seen.length,before);
  }finally{globalThis.fetch=originalFetch;}
});
