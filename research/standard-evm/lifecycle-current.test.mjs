import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStandardApi } from '../../src/standard-loader.js';
import { lifecycleFixture, word } from '../../engines/local-evm/test/lifecycle-fixture.js';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { LIFECYCLE_CASE as C, LIFECYCLE_POLICY, compareLifecycle, lifecycleProviderRequests, freezeLifecycle, checkLifecycle } from './lifecycle-current.mjs';

// Public-domain deployed runtime extracted from the deployment transaction in
// https://eips.ethereum.org/EIPS/eip-2470 . Starting state is synthetic, proved by
// generated MPT proofs. All provider outputs below are explicitly synthetic
// comparison controls, constructed only AFTER the real child has executed.
const FACTORY_RUNTIME='0x6080604052348015600f57600080fd5b506004361060285760003560e01c80634af63f0214602d575b600080fd5b60cf60048036036040811015604157600080fd5b810190602081018135640100000000811115605b57600080fd5b820183602082011115606c57600080fd5b80359060200191846001830284011164010000000083111715608d57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550509135925060eb915050565b604080516001600160a01b039092168252519081900360200190f35b6000818351602085016000f5939250505056fea26469706673582212206b44f8a82cb6b156bfcc3dc6aadd6df4eefd204bc928a4397fd15dacf6d5320564736f6c63430006020033';
const hex=n=>'0x'+BigInt(n).toString(16);
let basePromise;
async function fixture({prefunded=false}={}) {
  const f=await lifecycleFixture({accounts:{
    [C.factory]:{nonce:1n,balance:0n,code:FACTORY_RUNTIME},
    [C.sender]:{nonce:1n,balance:1000000n,code:'0x'},
    ...(prefunded?{[C.target]:{nonce:0n,balance:17n,code:'0x'}}:{}),
  }});
  const local=await executeIsolatedEthereumCall({request:C.request,header:f.header,rpc:f.rpc});
  assert.equal(local.status,'completed',JSON.stringify(local.error));
  assert.equal(local.output.execution.status,'success',JSON.stringify(local.output.execution));
  assert.equal(local.output.trace.calls[0].output,C.runtime);
  assert.equal(local.output.execution.returnData,word(BigInt(C.target)));
  const state=local.changes.accounts.find(row=>row.address===C.target);
  assert.equal(state.code.after,C.runtime);assert.equal(state.storage[0].after,word(42));
  const root=local.output.trace,child=root.calls[0];
  const frame=value=>({type:value.type,from:value.from,to:value.to,input:value.input,output:value.output,value:hex(value.value),gas:hex(value.gas),gasUsed:hex(value.gasUsed)});
  const trace={...frame(root),gas:'0x4c4b40',gasUsed:hex(local.output.gasAccounting.gasUsed),calls:[frame(child)]};
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
  const provider=lifecycleProviderRequests(f.header).map((request,i)=>({status:'completed',request:{jsonrpc:'2.0',id:i+1,...request},parsed:{jsonrpc:'2.0',id:i+1,result:values[i]}}));
  return{header:f.header,local,provider,rpc:f.rpc};
}
async function base(){basePromise??=fixture();const {header,local,provider}=await basePromise;return structuredClone({header,local,provider});}
async function mutate(fn){const data=await base();fn(data);return compareLifecycle(data);}

test('fixed ABI initcode deploys the entire 11-byte SLOAD runtime in an actual child',async()=>{
  const data=await base(),result=await compareLifecycle(data);
  assert.equal((C.runtime.length-2)/2,11);assert.equal(C.initcode.slice(12,18),'61000b');
  assert.equal(C.request.data.slice(0,10),'0x4af63f02');
  assert.equal(result.status,'match',JSON.stringify(result));assert.equal(result.allChannelsComplete,true);
  assert.deepEqual(result.channels,{execution:true,returnData:true,gas:true,logs:true,state:true});
  assert.equal(LIFECYCLE_POLICY.calls,2+LIFECYCLE_POLICY.localCalls+LIFECYCLE_POLICY.providerCalls);
  assert.ok(LIFECYCLE_POLICY.wallMs+LIFECYCLE_POLICY.drainMs<=LIFECYCLE_POLICY.liveAndDrainCeilingMs);
  assert.ok(data.local.inputEvidence.every(row=>['eth_getProof','eth_getCode'].includes(row.request.method)));
});

test('proven prefunded empty target preserves native balance and has no invented existence change',async()=>{
  const data=await fixture({prefunded:true}),result=await compareLifecycle(data);
  assert.equal(result.status,'match',JSON.stringify(result));
  const target=result.providerChanges.accounts.find(row=>row.address===C.target);
  assert.equal(Object.hasOwn(target,'existence'),false);assert.equal(Object.hasOwn(target,'balance'),false);
  assert.equal(data.local.inputs.provenance.find(row=>row.account===C.target).accountProof.balanceRaw,'17');
});

test('complete code, storage, native balance and creator nonce differences never pass',async()=>{
  for(const edit of [
    x=>{x.provider[1].parsed.result.post[C.target].storage[word(0)]=word(43);},
    x=>{delete x.provider[1].parsed.result.post[C.target].storage;},
    x=>{x.provider[1].parsed.result.post[C.factory].nonce='0x3';},
    x=>{x.provider[1].parsed.result.post[C.target].balance='0x1';},
    x=>{x.provider[1].parsed.result.post[C.target].code='0x00';x.provider[0].parsed.result.calls[0].output='0x00';},
  ]) {const result=await mutate(edit);assert.equal(result.status,'mismatch',JSON.stringify(result));assert.equal(result.channels.state,false);}
});

test('unproved initial facts, account deletion, missing diff and omitted nonzero nonce fail closed',async()=>{
  for(const edit of [
    x=>{x.local.inputs.provenance=x.local.inputs.provenance.filter(row=>row.account!==C.target);},
    x=>{x.local.inputs.provenance.find(row=>row.account===C.target).accountProof.storageRoot='0x'+'12'.repeat(32);},
    x=>{delete x.provider[1].parsed.result.post[C.factory];},
    x=>{x.provider[1].parsed.result={pre:{},post:{}};},
    x=>{delete x.provider[1].parsed.result.pre[C.sender].nonce;},
    x=>{delete x.provider[1].parsed.result.pre[C.factory];},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));assert.equal(result.allChannelsComplete,false);}
});

test('final full header, original request, selector and zero-fee override are exact bindings',async()=>{
  for(const edit of [
    x=>{x.provider[2].parsed.result={...x.header,size:'0x1234'};},
    x=>{x.provider[0].request.params[0].gas='0x4c4b3f';},
    x=>{x.provider[0].request.params[1].blockHash='0x'+'12'.repeat(32);},
    x=>{delete x.provider[1].request.params[2].blockOverrides;},
    x=>{x.provider[0].parsed.result.input='0x';},
    x=>{x.provider[0].parsed.result.value='0x1';},
    x=>{x.provider[0].parsed.result.error=null;},
    x=>{x.provider[0].parsed.result.output=null;},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));}
});

test('known provider status or gas mismatches survive a later incomplete state channel',async()=>{
  const failed=await mutate(x=>{x.provider[0].parsed.result.error='execution reverted';x.provider[0].parsed.result.output='0x';x.provider[1].parsed.result={pre:{},post:{}};});
  assert.equal(failed.status,'mismatch');assert.equal(failed.channels.execution,false);assert.equal(failed.allChannelsComplete,false);
  const gas=await mutate(x=>{x.provider[0].parsed.result.gasUsed=hex(BigInt(x.provider[0].parsed.result.gasUsed)+1n);x.provider[1].parsed.result={pre:{},post:{}};});
  assert.equal(gas.status,'mismatch');assert.equal(gas.channels.gas,false);assert.equal(gas.allChannelsComplete,false);
});

test('malformed child, logs, runtime disagreement and local gas inconsistency are unavailable',async()=>{
  for(const edit of [
    x=>{x.provider[0].parsed.result.calls[0].from=C.sender;},
    x=>{x.provider[0].parsed.result.calls[0].type='CREATE';},
    x=>{x.provider[0].parsed.result.calls[0].logs=[{}];},
    x=>{x.provider[0].parsed.result.calls[0].output='0x';},
    x=>{x.local.output.gasAccounting.gasUsed='1';},
  ]) {const result=await mutate(edit);assert.equal(result.status,'unavailable',JSON.stringify(result));}
});

test('omitted root output is explicit empty convention and cannot match returned target',async()=>{
  const result=await mutate(x=>{delete x.provider[0].parsed.result.output;});
  assert.equal(result.status,'mismatch');assert.equal(result.channels.returnData,false);assert.equal(result.allChannelsComplete,true);
});

// A complete disposable archive and run, with the global fetch implementation
// replaced before transport creation. No sockets or public RPCs are used.
test('archived runner captures exact proof-first wire order, seals once, and rejects source drift',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'lifecycle-current-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const directory=join(temp,'capture'),fixtureData=await fixture();
  const implementation=(await loadStandardApi()).implementation;
  const frozen=await freezeLifecycle({outputDirectory:directory,expectedProductSha256:implementation.sourceSha256});
  await checkLifecycle({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
  const archived=await import(pathToFileURL(join(directory,'runtime/research/standard-evm/lifecycle-current.mjs')));
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
        assert.deepEqual({method:request.method,params:request.params},lifecycleProviderRequests(fixtureData.header)[index]);
        result=fixtureData.provider[index].parsed.result;
      }
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200});
    }catch(error){unexpected=error;throw error;}
  };
  try{
    const result=await archived.runLifecycle({outputDirectory:directory,expectedPlanSha256:frozen.planSha256});
    assert.equal(unexpected,null);assert.equal(result.status,'complete',JSON.stringify(result));
    assert.equal(result.comparison.status,'match',JSON.stringify(result.comparison));
    assert.equal(result.sourceUnchanged,true);assert.equal(result.runtimeUnchanged,true);
    assert.equal(result.budget.calls,seen.length);assert.equal(result.budget.dispatches,seen.length);
    assert.deepEqual(seen.slice(0,2).map(x=>x.method),['eth_chainId','eth_getBlockByNumber']);
    assert.deepEqual(seen.slice(-3).map(x=>x.method),['debug_traceCall','debug_traceCall','eth_getBlockByNumber']);
    const before=seen.length;
    await assert.rejects(archived.runLifecycle({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}),{code:'artifact_save_failed'});
    assert.equal(seen.length,before);
  }finally{globalThis.fetch=originalFetch;}
  await appendFile(join(directory,'runtime/research/standard-evm/lifecycle-current.mjs'),'\n// drift control\n');
  await assert.rejects(checkLifecycle({outputDirectory:directory,expectedPlanSha256:frozen.planSha256}));
});
