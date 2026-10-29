// Actual bytecode over independently authenticated synthetic initial state.
// Full-VM counterparts share the pinned opcode library, but use full MPT
// finalization and signed zero-price transactions. No public RPC is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { Common, Mainnet, Hardfork } from '../../fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { shanghaiFixture, SHANGHAI_SENDER, SHANGHAI_TEST_KEY } from './shanghai-fixture.js';
import { bytes, word } from './lifecycle-fixture.js';

const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const VICTIM=address(0x4444),BENEFICIARY=address(0x5555),HELPER=address(0x8888),GETTER=address(0x9999);
const call=(target,value=0)=>'600060006000600060'+value.toString(16).padStart(2,'0')+'73'+target.slice(2)+'61fffff1';
const RETURN42='602a60005260206000f3',REVERT='60006000fd';
const account=(manager,a)=>manager.getAccount(createAddressFromString(a));
const nonce=manager=>account(manager,SHANGHAI_SENDER).then(a=>a.nonce);
const code=(manager,a)=>manager.getCode(createAddressFromString(a)).then(bytesToHex);
const storage=(manager,a,key)=>manager.getStorage(createAddressFromString(a),bytes(word(key))).then(v=>v.length?BigInt(bytesToHex(v)):0n);
const unsupported=error=>error?.code==='LOCAL_STATE_UNSUPPORTED';

async function fixture({helperReverts=true,getterReverts=false}={}){
  return shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{
    [VICTIM]:{nonce:3n,balance:17n,code:'0x73'+BENEFICIARY.slice(2)+'ff',storage:{[word(991)]:99n}},
    [HELPER]:{nonce:1n,balance:2n,code:'0x'+call(VICTIM,1)+'50'+(helperReverts?REVERT:'00')},
    [GETTER]:{nonce:1n,code:'0x'+call(HELPER)+'50'+(getterReverts?REVERT:RETURN42)},
  }});
}
const query=f=>({from:f.request.from,to:GETTER,data:'0x70a08231'+f.request.from.slice(2).padStart(64,'0'),value:'0',gas:'1000000'});
async function deleteOriginal(f){const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');assert.equal(await account(f.stateManager,VICTIM),undefined);return output;}
async function assertMasked(manager){assert.equal(await account(manager,VICTIM),undefined);assert.equal(await code(manager,VICTIM),'0x');for(const slot of [991,992])assert.equal(await storage(manager,VICTIM,slot),0n);}
function block(h,common){return createBlock({header:{parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,difficulty:BigInt(h.difficulty),number:BigInt(h.number),gasLimit:BigInt(h.gasLimit),gasUsed:BigInt(h.gasUsed),timestamp:BigInt(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,baseFeePerGas:BigInt(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot},withdrawals:[]},{common});}
async function reference(f){
  const common=new Common({chain:Mainnet,hardfork:Hardfork.Shanghai}),state=await loadState(f.allocation,common),b=block(f.header,common);assert.equal(bytesToHex(b.hash()),f.header.hash);assert.equal(bytesToHex(await state.getStateRoot()),f.header.stateRoot);
  const vm=await createVM({common,stateManager:state,blockchain:{async getBlock(){throw Error('No synthetic history supplied');},shallowCopy(){return this;}}});
  return{state,async run(request,expected){
    const sender=await account(state,request.from),tx=createTx({type:0,nonce:sender.nonce,gasPrice:0n,gasLimit:BigInt(request.gas),to:request.to,value:BigInt(request.value),data:request.data},{common}).sign(bytes(SHANGHAI_TEST_KEY));assert.equal(tx.getSenderAddress().toString(),request.from);
    const result=await runTx(vm,{tx,block:b}),error=result.execResult.exceptionError?.error;
    assert.equal(expected.execution.status,error==='revert'?'reverted':error?'failed':'success');assert.equal(expected.execution.returnData,bytesToHex(result.execResult.returnValue));assert.equal(expected.execution.executionGasUsed,result.execResult.executionGasUsed.toString());assert.equal(expected.gasAccounting.gasUsed,result.totalGasSpent.toString());
    assert.deepEqual(expected.logs.map(({address,topics,data})=>({address,topics,data})),(result.execResult.logs??[]).map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})));return result;
  }};
}
async function expectedNonceOnlyRoot(state){const expected=state.shallowCopy(),a=await account(expected,SHANGHAI_SENDER);await expected.modifyAccountFields(createAddressFromString(SHANGHAI_SENDER),{nonce:a.nonce+1n});return bytesToHex(await expected.getStateRoot());}

test('after-preview helper funding followed by REVERT is measured with unchanged deletion overlay; full VM agrees',async()=>{
  const f=await fixture(),q=query(f),result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:q.to,data:q.data}]});
  assert.equal(result.original.output.execution.status,'success');assert.equal(result.status,'complete',JSON.stringify(result));
  const m=result.measurements[0];assert.equal(m.status,'measured');assert.deepEqual(m.values.map(r=>[r.beforeRaw,r.afterRaw,r.deltaRaw]),[['42','42','0']]);
  assert.equal(m.after.output.trace.calls[0].error,'revert');assert.equal(m.after.output.trace.calls[0].calls[0].error,null);
  assert.deepEqual(m.after.changesBefore,result.original.changes);assert.deepEqual(m.after.changesAfter.accounts.filter(r=>r.address!==SHANGHAI_SENDER),result.original.changes.accounts.filter(r=>r.address!==SHANGHAI_SENDER));
  const before=await reference(f),expectedBefore=await expectedNonceOnlyRoot(before.state);await before.run(q,m.before.output);assert.equal(bytesToHex(await before.state.getStateRoot()),expectedBefore);
  const after=await reference(f);await after.run(f.request,result.original.output);const expectedAfter=await expectedNonceOnlyRoot(after.state);await after.run(q,m.after.output);assert.equal(bytesToHex(await after.state.getStateRoot()),expectedAfter);await assertMasked(after.state);
});

test('real child and parent proof validation retain both measurements after reverted rematerialization',async()=>{
  const f=await fixture(),q=query(f),saved=[];
  const rpc={async call(method,params,options){
    const result=await f.rpc.call(method,params,options);
    saved.push({request:{method,params:structuredClone(params)},result:structuredClone(result)});
    return result;
  }};
  const result=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc,queries:[{to:q.to,data:q.data}]});
  assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.error,null);
  assert.equal(result.preview.status,'complete');assert.equal(result.preview.original.output.execution.status,'success');
  assert.equal(result.isolation.processSeparated,true);assert.notEqual(result.isolation.childPid,process.pid);
  assert.equal(result.isolation.processClosed,true);assert.equal(result.isolation.exitCode,0);
  const original=result.preview.original,m=result.preview.measurements[0];
  assert.equal(result.preview.measurements.length,1);assert.equal(m.status,'measured');
  assert.deepEqual(m.values.map(r=>[r.beforeRaw,r.afterRaw,r.deltaRaw]),[['42','42','0']]);
  assert.deepEqual(original.changes.accounts.find(r=>r.address===VICTIM).existence,{before:true,after:false,basis:'shanghai_selfdestruct_deletion'});
  assert.deepEqual(original.output.lifecycle.finalizedDeletions.map(r=>r.address),[VICTIM]);
  assert.deepEqual(m.after.changesBefore,original.changes);
  assert.deepEqual(m.after.changesAfter.accounts.filter(r=>r.address!==SHANGHAI_SENDER),original.changes.accounts.filter(r=>r.address!==SHANGHAI_SENDER));
  for(const side of [m.before,m.after]){
    assert.equal(side.status,'measured');assert.equal(side.output.execution.returnData,word(42));
    assert.equal(side.mutationValidation.status,'verified');assert.equal(side.output.trace.calls[0].error,'revert');
  }
  assert.ok(saved.length>0);assert.equal(result.broker.calls,saved.length);assert.equal(result.broker.dispatches,saved.length);assert.equal(result.broker.pendingAtReturn,0);
  assert.equal(result.preview.inputEvidence.length,saved.length);assert.deepEqual(original.inputEvidence,result.preview.inputEvidence.slice(0,original.inputEvidence.length));
  assert.deepEqual(f.calls,saved.map(r=>r.request));
  saved.forEach((row,i)=>{
    const evidence=result.preview.inputEvidence[i],broker=result.broker.records[i],raw=JSON.stringify(row.result);
    assert.ok(['eth_getProof','eth_getCode'].includes(row.request.method));
    assert.deepEqual(row.request.params.at(-1),{blockHash:f.header.hash,requireCanonical:true});
    assert.equal(evidence.id,i+1);assert.equal(evidence.status,'received');assert.deepEqual(evidence.request,row.request);assert.deepEqual(evidence.result,row.result);
    assert.equal(broker.id,i+1);assert.equal(broker.status,'received');assert.equal(broker.dispatched,true);assert.deepEqual(broker.request,row.request);
    assert.equal(broker.resultBytes,Buffer.byteLength(raw));assert.equal(broker.resultSha256,createHash('sha256').update(raw).digest('hex'));
  });
});

test('an ancestor REVERT permits nested successful commits, restores rematerialization, and agrees with full VM',async()=>{
  const f=await fixture({helperReverts:false,getterReverts:true}),original=await deleteOriginal(f),prior=structuredClone(f.stateManager.snapshotChanges()),beforeNonce=await nonce(f.stateManager);
  const second=await executeEthereumCall({...f,request:query(f)});assert.equal(second.execution.status,'reverted',JSON.stringify(second.execution));assert.equal(second.trace.calls[0].error,null);assert.equal(second.trace.calls[0].calls[0].error,null);
  assert.equal(await nonce(f.stateManager),beforeNonce+1n);assert.deepEqual(f.stateManager.snapshotChanges().accounts.filter(r=>r.address!==SHANGHAI_SENDER),prior.accounts.filter(r=>r.address!==SHANGHAI_SENDER));await assertMasked(f.stateManager);
  const full=await reference(f);await full.run(f.request,original);const expected=await expectedNonceOnlyRoot(full.state);await full.run(query(f),second);assert.equal(bytesToHex(await full.state.getStateRoot()),expected);await assertMasked(full.state);
});

test('root helper REVERT restores temporary funding without classifying it as a host failure',async()=>{
  const f=await fixture(),original=await deleteOriginal(f),request={...query(f),to:HELPER},second=await executeEthereumCall({...f,request});
  assert.equal(second.execution.status,'reverted');assert.equal(second.stateDisposition,'message_result_retained_in_supplied_manager');assert.equal(second.trace.calls[0].error,null);await assertMasked(f.stateManager);
  const full=await reference(f);await full.run(f.request,original);const expected=await expectedNonceOnlyRoot(full.state);await full.run(request,second);assert.equal(bytesToHex(await full.state.getStateRoot()),expected);
});

test('surviving direct and nested rematerialization has explicit reset provenance and matches full-VM execution',async()=>{
  for(const nested of [false,true]){
    const f=await fixture({helperReverts:false}),original=await deleteOriginal(f),oldNonce=await nonce(f.stateManager);
    const request=nested?query(f):{...f.request,to:VICTIM,value:'1'},second=await executeEthereumCall({...f,request});
    assert.equal(second.execution.status,'success');assert.equal(second.stateDisposition,'message_result_retained_in_supplied_manager');
    const change=f.stateManager.snapshotChanges().accounts.find(row=>row.address===VICTIM);
    assert.deepEqual(change.reset,{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:original.lifecycle.finalizedDeletions[0].initialStorageRoot});
    assert.deepEqual(change.nonce,{before:'0x3',after:'0x0'});assert.deepEqual(change.balance,{before:'0x11',after:'0x1'});assert.deepEqual(change.code,{before:'0x73'+BENEFICIARY.slice(2)+'ff',after:'0x'});
    assert.equal(await nonce(f.stateManager),oldNonce+1n);assert.equal((await account(f.stateManager,HELPER)).balance,nested?1n:2n);assert.equal((await account(f.stateManager,VICTIM)).balance,1n);
    assert.equal(await code(f.stateManager,VICTIM),'0x');for(const slot of [991,992])assert.equal(await storage(f.stateManager,VICTIM,slot),0n);
    const full=await reference(f);await full.run(f.request,original);await full.run(request,second);
    assert.equal((await account(full.state,VICTIM)).balance,1n);assert.equal((await account(full.state,VICTIM)).nonce,0n);assert.equal(await code(full.state,VICTIM),'0x');
  }
});

test('a caller-owned outer checkpoint can revert the entire successful rematerializing invocation',async()=>{
  const f=await fixture();await deleteOriginal(f);const prior=structuredClone(f.stateManager.snapshotChanges());await f.stateManager.checkpoint();
  const second=await executeEthereumCall({...f,request:{...f.request,to:VICTIM,value:'1'}});assert.equal(second.execution.status,'success');assert.equal(second.stateDisposition,'message_result_retained_in_supplied_manager');
  assert.equal((await account(f.stateManager,VICTIM)).balance,1n);assert.equal(f.stateManager.snapshotChanges().accounts.find(row=>row.address===VICTIM).reset.basis,'shanghai_selfdestruct_deletion');
  await f.stateManager.revert();assert.deepEqual(f.stateManager.snapshotChanges(),prior);await assertMasked(f.stateManager);
});

test('unknown old slots and code stay masked during actual transient funding and across a copied rollback',async()=>{
  const f=await fixture();await deleteOriginal(f);const original=structuredClone(f.stateManager.snapshotChanges()),manager=f.stateManager.shallowCopy(),put=manager.putAccount.bind(manager);let observed=0;
  manager.putAccount=async(a,value)=>{await put(a,value);if(a.toString()===VICTIM&&value.balance===1n){observed++;const calls=f.calls.length;assert.equal(await code(manager,VICTIM),'0x');assert.equal(await storage(manager,VICTIM,991),0n);assert.equal(await storage(manager,VICTIM,992),0n);assert.equal(f.calls.length,calls);const row=manager.snapshotChanges().accounts.find(row=>row.address===VICTIM);assert.equal(row.reset.basis,'shanghai_selfdestruct_deletion');assert.deepEqual(row.nonce,{before:'0x3',after:'0x0'});}};
  const second=await executeEthereumCall({...f,stateManager:manager,request:query(f)});assert.equal(second.execution.status,'success',JSON.stringify(second.execution));assert.equal(observed,1);assert.equal(BigInt(second.execution.returnData),42n);await assertMasked(manager);
  assert.deepEqual(f.stateManager.snapshotChanges(),original);assert.equal(f.calls.some(r=>r.method==='eth_getProof'&&r.params[1].includes(word(991))),false,'reset reads must not fetch or resurrect the original undemanded trie');
});

test('direct rematerialization needs a checkpoint and defensive snapshots/commits reject invalid reset provenance',async()=>{
  const f=await fixture();await deleteOriginal(f);const prior=structuredClone(f.stateManager.snapshotChanges()),target=createAddressFromString(VICTIM),value=createAccount({nonce:0n,balance:1n});
  await assert.rejects(f.stateManager.putAccount(target,value),unsupported);assert.deepEqual(f.stateManager.snapshotChanges(),prior);
  await f.stateManager.checkpoint();await f.stateManager.putAccount(target,value);assert.equal((await account(f.stateManager,VICTIM)).balance,1n);
  assert.doesNotThrow(()=>f.stateManager.assertRepresentableAccountResets());assert.equal(f.stateManager.snapshotChanges().accounts.find(row=>row.address===VICTIM).reset.basis,'shanghai_selfdestruct_deletion');
  f.stateManager.resetStack.at(-1).set(VICTIM,'unverified_override');
  assert.throws(()=>f.stateManager.assertRepresentableAccountResets(),{code:'LOCAL_STATE_INVALID'});assert.throws(()=>f.stateManager.snapshotChanges(),{code:'LOCAL_STATE_INVALID'});await assert.rejects(f.stateManager.commit(),{code:'LOCAL_STATE_INVALID'});
  await f.stateManager.revert();assert.deepEqual(f.stateManager.snapshotChanges(),prior);await assertMasked(f.stateManager);
});
