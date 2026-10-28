// Independent execution controls over signed synthetic authorizations and
// proof-only initial state. No public RPC or provider execution outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { factoryCode, initcode, createdAddress } from './lifecycle-fixture.js';
import { authorizationFixture, signAuthorization, compareFullVM, fullVMReference, compareExecution, TEST_KEY, TX_SENDER, AUTHORITY, TARGET, DELEGATE, SECOND_DELEGATE, ZERO, MAX_NONCE, RETURN42, RETURN7, REVERT, designation, account, code, slot, call, query, word, qty } from './authorization-fixture.js';

const entries=output=>output.authorizationProcessing.entries;
const applied=(index=0,authority=AUTHORITY)=>({index,authority,status:'applied',reason:null});
function complete(output,status='success') {
  assert.equal(output.execution.status,status,JSON.stringify(output.execution));
  assert.equal(output.semantics.callerNonce,'outer_increment_authorizations_and_committed_sender_creation_attempts');
  assert.ok(output.authorizationProcessing);assert.equal(output.profile.authorizationCount,String(entries(output).length));
  assert.equal(output.profile.authorizationIntrinsicGas,String(entries(output).length*25000));
}

test('install, replace and clear retain exact authority storage and full signed type-4 postroots',async()=>{
  for(const mode of ['install','replace','clear']){
    const prior=mode==='install'?'0x':designation(SECOND_DELEGATE),target=mode==='clear'?ZERO:DELEGATE;
    const f=await authorizationFixture({authority:{nonce:3n,balance:7n,code:prior,storage:{[word(991)]:91n}},authorizationList:[signAuthorization({nonce:3n,address:target})]}),out=await executeEthereumCall(f);
    complete(out);assert.deepEqual(entries(out),[applied()]);assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');
    assert.equal(await code(f.stateManager,AUTHORITY),mode==='clear'?'0x':designation(DELEGATE));assert.equal((await account(f.stateManager,AUTHORITY)).nonce,4n);assert.equal(await slot(f.stateManager,AUTHORITY,991),91n);
    assert.equal(f.stateManager.snapshotChanges().accounts.find(r=>r.address===AUTHORITY).storage,undefined,'Authorization must not clear the existing storage trie');
    await compareFullVM(f,out);
  }
});

test('proof-absent and existing empty authorities differ by the existence refund',async()=>{
  for(const exists of [false,true]){
    const f=await authorizationFixture({authority:exists?{nonce:0n,balance:0n,code:'0x'}:null}),out=await executeEthereumCall(f);
    complete(out);assert.deepEqual(entries(out),[applied()]);assert.equal(out.authorizationProcessing.gasRefundCounter,exists?'12500':'0');
    assert.equal(out.execution.gasRefundCounter,'0');assert.equal(out.profile.intrinsicGas,'46000');assert.equal(out.gasAccounting.gasUsed,exists?'36800':'46000');
    const row=f.stateManager.snapshotChanges().accounts.find(r=>r.address===AUTHORITY);
    if(!exists)assert.deepEqual(row.existence,{before:false,after:true,basis:'eip7702_authorization_materialization'});
    assert.equal(await code(f.stateManager,AUTHORITY),designation(DELEGATE));await compareFullVM(f,out);
  }
});

test('ordered duplicate authorizations consume sequential nonces and keep skipped tuples in place',async()=>{
  const list=[signAuthorization(),signAuthorization(),signAuthorization({nonce:1n,address:SECOND_DELEGATE}),signAuthorization({nonce:2n,address:ZERO})];
  const f=await authorizationFixture({authority:null,authorizationList:list}),out=await executeEthereumCall(f);
  complete(out);assert.deepEqual(entries(out),[applied(),{index:1,authority:AUTHORITY,status:'skipped',reason:'nonce_mismatch'},applied(2),applied(3)]);
  assert.equal(out.authorizationProcessing.gasRefundCounter,'25000');assert.equal((await account(f.stateManager,AUTHORITY)).nonce,3n);assert.equal(await code(f.stateManager,AUTHORITY),'0x');
  assert.deepEqual(out.profile.authorizationList,list);await compareFullVM(f,out);
});

test('self-authorization reads the sender nonce after its outer increment and executes the new code',async()=>{
  for(const nonce of [1n,2n]){
    const f=await authorizationFixture({to:TX_SENDER,authorizationList:[signAuthorization({key:TEST_KEY,nonce})]}),out=await executeEthereumCall(f);
    complete(out);assert.deepEqual(entries(out),[nonce===2n?applied(0,TX_SENDER):{index:0,authority:TX_SENDER,status:'skipped',reason:'nonce_mismatch'}]);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,nonce===2n?3n:2n);
    assert.equal(out.execution.returnData,nonce===2n?word(42):'0x');
    if(nonce===2n)assert.deepEqual(out.semantics.senderDelegation,{address:DELEGATE,authorizationListProcessed:true});
    await compareFullVM(f,out);
  }
});

test('wrong chain, max nonce, invalid parity, high-s and zero-r are protocol skips, not dropped inputs',async()=>{
  const order=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const list=[signAuthorization({chainId:2n}),signAuthorization({nonce:MAX_NONCE}),signAuthorization({patch:{yParity:'0x2'}}),signAuthorization({patch:{s:qty(order/2n+1n)}}),signAuthorization({patch:{r:'0x0'}}),signAuthorization({chainId:0n})];
  const f=await authorizationFixture({authorizationList:list}),out=await executeEthereumCall(f);
  complete(out);assert.deepEqual(entries(out),['wrong_chain','nonce_overflow','invalid_signature','invalid_signature','invalid_signature'].map((reason,index)=>({index,authority:null,status:'skipped',reason})).concat(applied(5)));
  assert.equal(out.profile.authorizationIntrinsicGas,'150000');assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');await compareFullVM(f,out);
});

test('code and nonce guards skip recoverable authorities without mutating them',async()=>{
  for(const reason of ['authority_has_code','nonce_mismatch']){
    const f=await authorizationFixture({authority:{nonce:reason==='nonce_mismatch'?8n:0n,balance:7n,code:reason==='authority_has_code'?'0x00':'0x'}}),out=await executeEthereumCall(f);
    complete(out);assert.deepEqual(entries(out),[{index:0,authority:AUTHORITY,status:'skipped',reason}]);assert.equal(out.authorizationProcessing.gasRefundCounter,'0');
    assert.equal(f.stateManager.snapshotChanges().accounts.some(r=>r.address===AUTHORITY),false);await compareFullVM(f,out);
  }
});

test('recoverable skipped authorities are warm even though their authorization was not applied',async()=>{
  const f=await authorizationFixture({authority:{nonce:9n,balance:7n,code:'0x'},targetCode:'0x73'+AUTHORITY.slice(2)+'3160005260206000f3'}),out=await executeEthereumCall(f);
  complete(out);assert.equal(entries(out)[0].reason,'nonce_mismatch');assert.equal(out.execution.executionGasUsed,'118');assert.equal(out.execution.returnData,word(7));await compareFullVM(f,out);
});

test('REVERT and out of gas roll back message writes but retain preceding authorization state and refunds',async()=>{
  for(const failed of [false,true]){
    const f=await authorizationFixture({to:AUTHORITY,delegateCode:'0x602a600055'+(failed?'5b600556':REVERT),gas:failed?'80000':'5000000'}),out=await executeEthereumCall(f);
    complete(out,failed?'failed':'reverted');assert.deepEqual(entries(out),[applied()]);assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');
    assert.equal(await code(f.stateManager,AUTHORITY),designation(DELEGATE));assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal(await slot(f.stateManager,AUTHORITY,0),0n);
    assert.equal(f.stateManager.snapshotChanges().accounts.find(r=>r.address===AUTHORITY).storage,undefined);await compareFullVM(f,out);
  }
});

test('successful delegated message storage writes use authority context and preserve old unknown slots',async()=>{
  const f=await authorizationFixture({to:AUTHORITY,authority:{nonce:0n,balance:7n,code:'0x',storage:{[word(991)]:91n}},delegateCode:'0x602a60005560005460005260206000f3'}),out=await executeEthereumCall(f);
  complete(out);assert.equal(out.trace.executionAddress,AUTHORITY);assert.equal(out.execution.returnData,word(42));assert.equal(await slot(f.stateManager,AUTHORITY,0),42n);assert.equal(await slot(f.stateManager,AUTHORITY,991),91n);await compareFullVM(f,out);
});

test('a newly materialized authority may write storage without being marked as a constructor creation',async()=>{
  const f=await authorizationFixture({authority:null,to:AUTHORITY,delegateCode:'0x602a60005560005460005260206000f3'}),out=await executeEthereumCall(f);
  complete(out);assert.equal(out.execution.returnData,word(42));assert.equal(await slot(f.stateManager,AUTHORITY,0),42n);
  const row=f.stateManager.snapshotChanges().accounts.find(r=>r.address===AUTHORITY);assert.equal(row.existence.basis,'eip7702_authorization_materialization');
  assert.deepEqual(row.storage,[{slot:word(0),before:word(0),after:word(42)}]);await compareFullVM(f,out);
});

test('authorization materialization is not EIP-6780 creation and SELFDESTRUCT keeps its designation',async()=>{
  const f=await authorizationFixture({authority:null,to:AUTHORITY,value:'5',delegateCode:'0x73'+TARGET.slice(2)+'ff'}),out=await executeEthereumCall(f);
  complete(out);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal((await account(f.stateManager,AUTHORITY)).balance,0n);
  assert.equal(await code(f.stateManager,AUTHORITY),designation(DELEGATE));assert.equal((await account(f.stateManager,TARGET)).balance,5n);
  assert.equal(out.lifecycle?.finalizedDeletions?.some(r=>r.address===AUTHORITY)??false,false);await compareFullVM(f,out);
});

test('message storage-clear refund is separate from the authorization existence refund',async()=>{
  const f=await authorizationFixture({to:AUTHORITY,authority:{nonce:0n,balance:7n,code:'0x',storage:{[word(0)]:7n}},delegateCode:'0x600060005500'}),out=await executeEthereumCall(f);
  complete(out);assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');assert.equal(out.execution.gasRefundCounter,'4800');assert.equal(await slot(f.stateManager,AUTHORITY,0),0n);await compareFullVM(f,out);
});

test('authorization nonce precedes CREATE and only committed message ancestry retains creator increments',async()=>{
  for(const rootReverts of [false,true]){
    const f=await authorizationFixture({to:AUTHORITY,delegateCode:factoryCode(initcode('00',''),{value:0,tail:rootReverts?'50'+REVERT:'5000'})}),out=await executeEthereumCall(f);
    complete(out,rootReverts?'reverted':'success');const child=createdAddress({creator:AUTHORITY,nonce:1n});
    assert.equal(out.trace.calls[0].from,AUTHORITY);assert.equal(out.trace.calls[0].to,child);assert.equal(out.trace.calls[0].error,null);
    assert.equal((await account(f.stateManager,AUTHORITY)).nonce,rootReverts?1n:2n);assert.equal((await account(f.stateManager,child))!==undefined,!rootReverts);await compareFullVM(f,out);
  }
});

test('self-authorization and committed sender creation attempts each consume their distinct nonce',async()=>{
  for(const rootReverts of [false,true]){
    const f=await authorizationFixture({to:TX_SENDER,authorizationList:[signAuthorization({key:TEST_KEY,nonce:2n})],delegateCode:factoryCode(initcode('00',''),{value:0,tail:rootReverts?'50'+REVERT:'5000'})}),out=await executeEthereumCall(f);
    complete(out,rootReverts?'reverted':'success');assert.deepEqual(entries(out),[applied(0,TX_SENDER)]);assert.equal(out.trace.calls[0].to,createdAddress({creator:TX_SENDER,nonce:3n}));
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,rootReverts?3n:4n);assert.equal(await code(f.stateManager,TX_SENDER),designation(DELEGATE));await compareFullVM(f,out);
  }
});

test('Prague activates authorization processing and uses the same signed transaction behavior',async()=>{
  const f=await authorizationFixture({prague:true,to:AUTHORITY}),out=await executeEthereumCall(f);complete(out);assert.equal(out.profile.hardfork,'prague');assert.equal(out.execution.returnData,word(42));await compareFullVM(f,out);
});

test('a proof failure after authorization and a post-authorization deadline restore the complete attempt',async()=>{
  for(const deadline of [false,true]){
    const f=await authorizationFixture();let appliedCount=0,clock=0;
    const apply=f.stateManager.applyAuthorization.bind(f.stateManager);
    f.stateManager.applyAuthorization=async(...args)=>{const result=await apply(...args);appliedCount++;if(deadline)clock=2;return result;};
    if(!deadline){const original=f.rpc.call;f.rpc.call=async(method,params)=>{if(params[0]===TARGET)throw Object.assign(Error('Synthetic missing target proof'),{code:'RPC_EXECUTION_ERROR'});return original(method,params);};}
    const out=await executeEthereumCall({...f,...(deadline?{now:()=>clock,limits:{wallMs:1}}:{})});
    assert.equal(appliedCount,1);assert.ok(['unavailable','unsupported'].includes(out.execution.status));assert.equal(out.execution.returnData,null);assert.equal(out.authorizationProcessing,undefined);assert.equal(out.stateDisposition,'rolled_back');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
    if(deadline){assert.equal((await account(f.stateManager,TX_SENDER)).nonce,1n);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,0n);assert.equal(await code(f.stateManager,AUTHORITY),'0x');}
    else await assert.rejects(account(f.stateManager,TX_SENDER),error=>error.code==='LOCAL_STATE_MISSING','Poisoned proof inputs must not permit continuation after rollback');
  }
});

test('failure inside a caller checkpoint restores that checkpoint without retaining authorization provenance',async()=>{
  const f=await authorizationFixture({to:AUTHORITY,delegateCode:'0x4a00'});await f.stateManager.checkpoint();const before=structuredClone(f.stateManager.snapshotChanges());
  const out=await executeEthereumCall(f);assert.equal(out.execution.status,'unsupported');assert.equal(out.authorizationProcessing,undefined);assert.deepEqual(f.stateManager.snapshotChanges(),before);await f.stateManager.revert();assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
});

test('real isolated child retains signature decisions, complete changes and five full-VM channels',async()=>{
  const f=await authorizationFixture({authority:null,to:AUTHORITY}),out=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
  assert.equal(out.status,'completed',JSON.stringify(out.error));assert.equal(out.isolation.processClosed,true);assert.equal(out.broker.pendingAtReturn,0);complete(out.output);assert.deepEqual(entries(out.output),[applied()]);assert.equal(out.output.execution.returnData,word(42));
  assert.deepEqual(out.inputEvidence.map(r=>r.request),f.calls);await compareFullVM(f,out.output,out.changes);
});

test('real isolated before/after queries see old/new code without replaying original authorizations',async()=>{
  const f=await authorizationFixture({authority:{nonce:0n,balance:7n,code:designation(SECOND_DELEGATE)}}),q=query(AUTHORITY);
  const out=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[q]});
  assert.equal(out.status,'completed',JSON.stringify(out.error));assert.equal(out.preview.status,'complete',JSON.stringify(out.preview.error));
  const original=out.preview.original,m=out.preview.measurements[0];complete(original.output);assert.deepEqual(entries(original.output),[applied()]);assert.equal(m.status,'measured');assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['7','42','35']]);
  for(const side of [m.before,m.after]){assert.equal(side.output.authorizationProcessing,undefined);assert.equal(side.output.profile.authorizationList,undefined);assert.equal(side.mutationValidation.status,'verified');}
  assert.deepEqual(m.after.changesBefore,original.changes);assert.equal(out.broker.pendingAtReturn,0);
  await compareFullVM(f,original.output,original.changes);
  for(const after of [false,true]){
    const ref=await fullVMReference(f);if(after)await ref.run();const before=ref.state.shallowCopy(),sender=await account(before,TX_SENDER);await before.modifyAccountFields(createAddressFromString(TX_SENDER),{nonce:sender.nonce+1n});const expected=bytesToHex(await before.getStateRoot());
    const result=await ref.run({from:TX_SENDER,to:q.to,data:q.data,value:'0',gas:'1000000'});compareExecution(after?m.after.output:m.before.output,result);assert.equal(bytesToHex(await ref.state.getStateRoot()),expected,'Query must change only the outer sender nonce');
  }
});
