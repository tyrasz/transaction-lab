import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { feeFixture, TX_SENDER, TARGET, COINBASE, word } from './fee-fixture.js';
import { blobFeeFixture } from './blob-fee-fixture.js';
import { createdAddress, factoryCode, initcode } from './lifecycle-fixture.js';
import { native, UNUSED, ABSENT, BENEFICIARY, compareNativePreview, assertNativeMeasurement } from './native-balance-fixture.js';

test('real child native fee-transfer balances match signed fullVM and independent third-MPT deltas',async()=>{
  const f=await feeFixture({value:'123',target:{nonce:1n,balance:9n,code:'0x'},accounts:{[UNUSED]:{nonce:3n,balance:77n,code:'0xfe',storage:{[word(991)]:19n}}}});
  const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET,COINBASE,UNUSED,ABSENT]);
  assertNativeMeasurement(p.measurements[1],TARGET,9n,132n,p.original.changes);
  assertNativeMeasurement(p.measurements[3],UNUSED,77n,77n,p.original.changes);
  assertNativeMeasurement(p.measurements[4],ABSENT,0n,0n,p.original.changes);
  assert.equal(p.original.inputEvidence.some(e=>[UNUSED,ABSENT].includes(e.params?.[0])),false,'Unused query facts must not be invented as original reads');
  for(const address of [UNUSED,ABSENT]){
    const calls=f.calls.filter(c=>c.params[0]===address);assert.deepEqual(calls.map(c=>c.method),['eth_getProof','eth_getCode']);assert.deepEqual(calls[0].params[1],[]);
    const row=p.measurements.find(r=>r.identity.account===address);assert.equal(row.before.inputEvidenceIds.length,2);assert.deepEqual(row.after.inputEvidenceIds,[],'After-state reads reuse the same proven initial facts');
  }
  assert.equal(p.original.changes.accounts.some(r=>[UNUSED,ABSENT].includes(r.address)),false);
});

test('sender equal to coinbase reports net base-fee debit once, without double-counting the tip',async()=>{
  const f=await feeFixture({coinbase:TX_SENDER,value:'7',target:{nonce:1n,balance:0n,code:'0x'}});
  const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET]);
  const fees=p.original.output.feeAccounting;assert.equal(p.measurements[0].values[0].deltaRaw,String(-BigInt(fees.baseFeeBurn)-7n));assert.equal(p.measurements[1].values[0].deltaRaw,'7');
});

test('native measurements remain available after completed REVERT and OOG and include only retained fees',async()=>{
  for(const [code,status]of [['0x60006000fd','reverted'],['0x5b600056','failed']]){
    const f=await feeFixture({value:'17',gas:'30000',target:{nonce:1n,balance:9n,code}});
    const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET,COINBASE],{status});
    assert.equal(p.measurements[1].values[0].deltaRaw,'0');
    assert.equal(p.measurements[0].values[0].deltaRaw,'-'+p.original.output.feeAccounting.gasCharge);
    assert.equal(p.measurements[2].values[0].deltaRaw,p.original.output.feeAccounting.coinbaseTip);
  }
});

test('priced blob calls retain blob burn in native deltas on both success and REVERT',async()=>{
  for(const reverted of [false,true]){
    const f=await blobFeeFixture({blobCount:2,excessBlobGas:10000000n,value:'23',gas:'100000',target:{nonce:1n,balance:5n,code:reverted?'0x60006000fd':'0x'}});
    const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET,COINBASE],{status:reverted?'reverted':'success',blob:true});
    const fees=p.original.output.feeAccounting;assert(BigInt(fees.blobFeeBurn)>0n);
    assert.equal(p.measurements[0].values[0].deltaRaw,String(-BigInt(fees.totalFeeCharge)-(reverted?0n:23n)));
    assert.equal(p.measurements[1].values[0].deltaRaw,reverted?'0':'23');assert.equal(p.measurements[2].values[0].deltaRaw,fees.coinbaseTip);
  }
});

test('native poststate reads follow Shanghai deletion and Cancun retention after miner settlement',async()=>{
  for(const fork of ['shanghai','cancun']){
    const f=await feeFixture({fork,coinbase:TARGET,gas:'100000',target:{nonce:1n,balance:19n,code:'0x73'+BENEFICIARY.slice(2)+'ff'}});
    const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET,BENEFICIARY]);
    assert.equal(p.measurements[1].values[0].afterRaw,fork==='shanghai'?'0':p.original.output.feeAccounting.coinbaseTip);
    assert.equal(p.measurements[2].values[0].deltaRaw,'19');
    if(fork==='shanghai')assert(p.original.output.lifecycle.finalizedDeletions.some(r=>r.address===TARGET));
  }
});

test('native reads distinguish surviving creation funding from same-invocation creation/deletion',async()=>{
  const child=createdAddress({creator:TARGET,nonce:1n});
  for(const deleted of [false,true]){
    const init=deleted?'73'+BENEFICIARY.slice(2)+'ff':initcode('00','');
    const f=await feeFixture({fork:'cancun',target:{nonce:1n,balance:100n,code:factoryCode(init,{value:5,tail:'5000'})}});
    const {preview:p}=await compareNativePreview(f,[TX_SENDER,TARGET,child,BENEFICIARY]);
    assert.equal(p.measurements[2].values[0].beforeRaw,'0');assert.equal(p.measurements[2].values[0].afterRaw,deleted?'0':'5');
    assert.equal(p.measurements[3].values[0].deltaRaw,deleted?'5':'0');
  }
});

test('missing newly requested native proof preserves earlier measured pairs and withholds later queries',async()=>{
  const f=await feeFixture({value:'5'}),calls=[];
  const rpc={async call(method,params,options){calls.push({method,params:structuredClone(params)});if(method==='eth_getProof'&&params[0]===UNUSED)throw Error('Synthetic missing native proof');return f.rpc.call(method,params,options);}};
  const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc,queries:[native(TX_SENDER),native(UNUSED),native(TARGET)]});
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'partial');assert.equal(r.preview.original.output.execution.status,'success');
  assert.deepEqual(r.preview.measurements.map(m=>m.status),['measured','unavailable','not_attempted']);
  assert(r.preview.measurements[0].values);assert.equal(r.preview.measurements[1].values,null);assert.equal(r.preview.measurements[2].values,null);
  assert.equal(r.preview.inputUsage.status,'unavailable');assert.equal(r.preview.usage.executions,1);assert.equal(r.preview.scope.nativeEffectsMeasured,true);
  assert.equal(calls.filter(c=>c.params[0]===UNUSED).length,1);assert.equal(r.broker.pendingAtReturn,0);assert.equal(r.isolation.processClosed,true);
});

test('native reads remain available when the completed original exhausts the shared VM-step allowance',async()=>{
  const f=await feeFixture({target:{nonce:1n,balance:9n,code:'0x00'}});
  const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[native(TARGET),native(UNUSED)],limits:{execution:{steps:1}}});
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'complete');assert.equal(r.preview.original.output.execution.status,'success');
  assert.equal(r.preview.usage.steps,1);assert.equal(r.preview.usage.executions,1);
  assertNativeMeasurement(r.preview.measurements[0],TARGET,9n,9n,r.preview.original.changes);
  assertNativeMeasurement(r.preview.measurements[1],UNUSED,0n,0n,r.preview.original.changes);
});

test('cancellation during an extra native proof withholds the entire child preview and drains the read',async()=>{
  const f=await feeFixture(),controller=new AbortController();let reached=false;
  const rpc={async call(method,params,{signal}={}){
    if(method==='eth_getProof'&&params[0]===UNUSED){reached=true;return new Promise((resolve,reject)=>{const abort=()=>reject(Error('Synthetic cancelled proof'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});queueMicrotask(()=>controller.abort());});}
    return f.rpc.call(method,params);
  }};
  const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc,queries:[native(TX_SENDER),native(UNUSED)],signal:controller.signal});
  assert.equal(reached,true);assert.equal(r.status,'unavailable');assert.equal(r.preview,null);assert.equal(r.error.code,'LOCAL_ISOLATED_CANCELLED');assert.equal(r.broker.pendingAtReturn,0);assert.equal(r.isolation.processClosed,true);
});
