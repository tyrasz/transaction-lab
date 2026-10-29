// Fixed synthetic development regressions. Shared-EthereumJS full-VM matches
// are wrapper controls; named divergences are retained, never forced to match.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bytesToHex} from '@ethereumjs/util';
import {executeEthereumCall} from '../ethereum-call.js';
import {executeIsolatedEthereumCall,executeIsolatedEthereumPreview} from '../isolated-call.js';
import {amsterdamAuthorizationExecutionFixture as fixture,authorization,authorizationFullVM,compareAuthorizationFullVM,signedAuthorizationTransaction,
  expectedAuthorizationStop,appliedRoot,TEST_KEY,TX_SENDER,AUTHORITY,DELEGATE,SECOND_DELEGATE,TARGET,ZERO,MAX_NONCE,RETURN42,RETURN7,REVERT,FUNDS,GETTER,HELPER,COINBASE,
  account,code,slot,word,qty,designation,query,native,initcode,factoryCode,createdAddress,callBytes} from './amsterdam-authorization-execution-fixture.js';
const applied=(index=0,authority=AUTHORITY)=>({index,authority,status:'applied',reason:null});
const entries=o=>o.authorizationProcessing.entries;
async function run(f,{status='success',reference=true,phase='message'}={}){
  const output=await executeEthereumCall({request:f.request,header:f.header,chainId:11155111,stateManager:f.stateManager,blockchain:f.inputs.blockchain});
  assert.equal(output.execution.status,status,JSON.stringify(output.execution));assert.equal(output.authorizationProcessing.gasRefundCounter,'0');
  const prep=output.authorizationProcessing.preparation;
  assert.deepEqual(Object.keys(prep).sort(),['phase','retained','failedIndex','authorizationGasUsed','stateGasReservoir','executionStateGasUsed','stateGasSpilled','senderAuthorizationIncrements'].sort());
  assert.equal(prep.phase,phase);assert.equal(prep.retained,phase==='message');assert.equal(prep.failedIndex,phase==='authorization_out_of_gas'?entries(output).at(-1).index:null);
  for(const key of['authorizationGasUsed','stateGasReservoir','executionStateGasUsed','stateGasSpilled','senderAuthorizationIncrements'])assert.match(prep[key],/^(?:0|[1-9][0-9]*)$/);
  assert.equal(prep.stateGasReservoir,'0','Every declared envelope fits the 5M regular pool');
  if(phase!=='message')for(const key of['executionStateGasUsed','stateGasSpilled','senderAuthorizationIncrements'])assert.equal(prep[key],'0');
  const changes=f.stateManager.snapshotChanges();const ref=reference?await compareAuthorizationFullVM(f,output,changes,{preparationHalt:phase!=='message'}):null;
  const isolated=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc});
  assert.equal(isolated.status,'completed',JSON.stringify(isolated.error));assert.equal(isolated.isolation.processClosed,true);assert.equal(isolated.broker.pendingAtReturn,0);
  assert.deepEqual(isolated.changes,changes);for(const field of['execution','trace','logs','authorizationProcessing','gasAccounting','stateGasAccounting'])assert.deepEqual(isolated.output[field],output[field]);
  return{output,changes,ref,isolated};
}
const intrinsic=f=>signedAuthorizationTransaction(f).getIntrinsicGas();
const unchanged=(changes,address)=>assert.equal(changes.accounts.some(r=>r.address===address),false);
const stateGas=o=>BigInt(o.stateGasAccounting.settled.stateGasUsed);

test('priced and unpriced install, replacement and clearing preserve ordered authorization and exact signed settlement',async()=>{
  for(const priced of[false,true])for(const mode of['install','replace','clear']){
    const f=await fixture({priced,to:AUTHORITY,authority:{nonce:0n,balance:7n,code:mode==='install'?'0x':designation(SECOND_DELEGATE)},authorizationList:[authorization({address:mode==='clear'?ZERO:DELEGATE})]}),{output}=await run(f);
    assert.deepEqual(entries(output),[applied()]);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal(await code(f.stateManager,AUTHORITY),mode==='clear'?'0x':designation(DELEGATE));
    assert.equal(output.execution.returnData,mode==='clear'?'0x':word(42));assert.equal(stateGas(output),mode==='install'?35190n:0n);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
    assert.equal(output.authorizationProcessing.preparation.executionStateGasUsed,mode==='install'?'35190':'0');assert.equal(output.authorizationProcessing.preparation.authorizationGasUsed,mode==='install'?'44190':'9000');
  }
});

test('sequential duplicates, clear and reinstall charge a single first write and indicator allocation',async()=>{
  for(const absent of[false,true]){
    const list=[authorization(),authorization({address:SECOND_DELEGATE}),authorization({nonce:1n,address:ZERO}),authorization({nonce:2n,address:SECOND_DELEGATE})];
    const f=await fixture({authority:absent?null:undefined,to:AUTHORITY,authorizationList:list}),{output}=await run(f);
    assert.deepEqual(entries(output),[applied(0),{index:1,authority:AUTHORITY,status:'skipped',reason:'nonce_mismatch'},applied(2),applied(3)]);
    assert.equal((await account(f.stateManager,AUTHORITY)).nonce,3n);assert.equal(await code(f.stateManager,AUTHORITY),designation(SECOND_DELEGATE));assert.equal(output.execution.returnData,word(7));assert.equal(stateGas(output),35190n+(absent?183600n:0n));
    assert.equal(output.authorizationProcessing.preparation.authorizationGasUsed,(44190n+(absent?183600n:0n)).toString());
  }
});

test('ordered wrong-chain, overflow, parity, high-S and nonce skips do not charge a valid authorization twice',async()=>{
  const list=[authorization({chainId:1n}),authorization({nonce:MAX_NONCE}),authorization({patch:{yParity:'0x2'}}),authorization({patch:{s:qty(1n<<255n)}}),authorization({nonce:9n}),authorization()];
  const f=await fixture({authorizationList:list}),{output}=await run(f);
  assert.deepEqual(entries(output).map(e=>[e.status,e.reason,e.authority]),[
    ['skipped','wrong_chain',null],['skipped','nonce_overflow',null],['skipped','invalid_signature',null],['skipped','invalid_signature',null],['skipped','nonce_mismatch',AUTHORITY],['applied',null,AUTHORITY],
  ]);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal(stateGas(output),35190n);
  const denied=await fixture({authority:{nonce:0n,balance:7n,code:'0x00'}}),r=await run(denied);assert.equal(entries(r.output)[0].reason,'authority_has_code');unchanged(r.changes,AUTHORITY);assert.equal(stateGas(r.output),0n);
});

test('absent and existing-empty authorities pay identical state gas; pinned fullVM empty-leaf undercharge stays an explicit divergence',async()=>{
  for(const priced of[false,true])for(const existing of[false,true]){
    const f=await fixture({priced,authority:existing?{nonce:0n,balance:0n,code:'0x'}:null}),{output,changes}=await run(f,{reference:false});
    const paid=intrinsic(f)+9000n+183600n+35190n,expected=await expectedAuthorizationStop(f,{paidGas:paid});
    assert.equal(output.gasAccounting.gasUsed,paid.toString());assert.equal(stateGas(output),218790n);assert.equal(await appliedRoot(f,changes,f.common),expected.stateRoot);
    const ref=await authorizationFullVM(f);assert.equal(ref.result.totalGasSpent,paid-(existing?183600n:0n));
    assert.equal(ref.result.txStateGas,existing?35190n:218790n);assert.equal(await code(ref.state,AUTHORITY),designation(DELEGATE));assert.equal((await account(ref.state,AUTHORITY)).nonce,1n);
    if(existing&&priced)assert.notEqual(ref.stateRoot,expected.stateRoot,'Known fee/root disagreement must remain visible');else assert.equal(ref.stateRoot,expected.stateRoot);
    const row=changes.accounts.find(r=>r.address===AUTHORITY);assert.equal(row.existence?.basis,existing?undefined:'eip7702_authorization_materialization');
  }
});

test('authorized runtime uses authority storage while preserving authenticated old untouched slots',async()=>{
  const f=await fixture({to:AUTHORITY,authority:{nonce:0n,balance:7n,code:'0x',storage:{[word(991)]:91n}},delegateCode:'0x602a60005560005460005260206000f3'}),{output}=await run(f);
  assert.equal(output.execution.returnData,word(42));assert.equal(output.trace.executionAddress,AUTHORITY);assert.equal(await slot(f.stateManager,AUTHORITY,0),42n);assert.equal(await slot(f.stateManager,AUTHORITY,991),91n);assert.equal(await slot(f.stateManager,DELEGATE,0),0n);
});

test('self-authorization precedes callback CREATE2 attempts; root or ancestor rollback retains only the authorization increment',async()=>{
  const init=initcode('00','');
  for(const mode of['committed','root_revert','caught_revert']){
    const reverted=mode!=='committed',f=await fixture({to:mode==='caught_revert'?TARGET:TX_SENDER,authorizationList:[authorization({key:TEST_KEY,nonce:1n}),authorization({key:TEST_KEY,nonce:2n})],
      delegateCode:factoryCode(init,{kind:'CREATE2',value:5,repeat:2,tail:'50'+(reverted?REVERT:'00')}),targetCode:'0x'+callBytes(TX_SENDER)+'00'}),{output,changes}=await run(f,{status:mode==='root_revert'?'reverted':'success'});
    assert.deepEqual(entries(output),[{index:0,authority:TX_SENDER,status:'skipped',reason:'nonce_mismatch'},applied(1,TX_SENDER)]);
    assert.equal(output.authorizationProcessing.preparation.senderAuthorizationIncrements,'1');assert.equal(output.authorizationProcessing.preparation.authorizationGasUsed,'35190');
    const frame=mode==='caught_revert'?output.trace.calls[0]:output.trace;assert.deepEqual(frame.creationAttempts.map(a=>[a.nonceBefore,a.nonceAfter,a.disposition]),[['0x3','0x4','entered'],['0x4','0x5','collision']]);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,reverted?3n:5n);assert.equal(await code(f.stateManager,TX_SENDER),designation(DELEGATE));
    const target=createdAddress({creator:TX_SENDER,kind:'CREATE2',init});assert.equal((await account(f.stateManager,target))!==undefined,!reverted);if(reverted)unchanged(changes,target);
  }
});

test('regular, state and late-list preparation OOG discard every tuple write while retaining sender nonce and paid gas',async()=>{
  for(const mode of['regular','state','late']){
    const list=mode==='late'?[authorization(),authorization({key:'0x'+'03'.repeat(32)}),authorization({nonce:1n})]:[authorization({address:SECOND_DELEGATE})];
    const f=await fixture({authorizationList:list,authority:mode==='regular'?{nonce:0n,balance:7n,code:designation(DELEGATE)}:undefined});
    f.request.gas=(intrinsic(f)+(mode==='regular'?8999n:mode==='state'?44189n:50000n)).toString();
    const {output,changes}=await run(f,{status:'failed',phase:'authorization_out_of_gas'});assert.equal(output.execution.error,'out of gas');assert.equal(output.gasAccounting.gasUsed,f.request.gas);assert.equal(stateGas(output),0n);
    assert.equal(output.trace,null);assert.equal(output.execution.executionGasUsed,'0');assert.equal(output.stateGasAccounting.counters.messageGasUsed,'0');assert.equal(output.stateGasAccounting.counters.authorizationGasUsed,(BigInt(f.request.gas)-intrinsic(f)).toString());
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,0n);assert.equal(await code(f.stateManager,AUTHORITY),mode==='regular'?designation(DELEGATE):'0x');unchanged(changes,AUTHORITY);assert.equal(output.logs.length,0);
    assert.equal(entries(output).at(-1).status,'out_of_gas');assert.equal(entries(output).length,mode==='late'?2:1);
  }
});

test('recipient delegation-access OOG rolls previously applied authorization back before message execution',async()=>{
  const f=await fixture({to:AUTHORITY});f.request.gas=(intrinsic(f)+44190n+2999n).toString();
  const {output,changes}=await run(f,{status:'failed',phase:'recipient_out_of_gas'});assert.equal(output.execution.error,'out of gas');assert.equal(output.gasAccounting.gasUsed,f.request.gas);assert.equal(stateGas(output),0n);unchanged(changes,AUTHORITY);
  assert(output.trace);assert.equal(output.execution.executionGasUsed,'2999');assert.equal(output.stateGasAccounting.counters.authorizationGasUsed,'44190');assert.deepEqual(entries(output),[applied()]);
  assert.equal((await account(f.stateManager,AUTHORITY)).nonce,0n);assert.equal(await code(f.stateManager,AUTHORITY),'0x');assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal(output.logs.length,0);
});

test('entered message REVERT and INVALID preserve authorization state while discarding message storage',async()=>{
  for(const ending of[REVERT,'fe']){
    const f=await fixture({to:AUTHORITY,gas:'500000',delegateCode:'0x602a600055'+ending}),{output,changes}=await run(f,{status:ending==='fe'?'failed':'reverted'});
    assert.deepEqual(entries(output),[applied()]);assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal(await code(f.stateManager,AUTHORITY),designation(DELEGATE));assert.equal(await slot(f.stateManager,AUTHORITY,0),0n);assert.equal(changes.accounts.find(r=>r.address===AUTHORITY).storage,undefined);assert.equal(stateGas(output),35190n);
  }
});

test('value-bearing authorization recipient prepays its first write and preserves exact native transfer logs',async()=>{
  const f=await fixture({to:AUTHORITY,value:'19'}),{output}=await run(f);assert.equal(stateGas(output),35190n);
  assert.equal(output.stateGasAccounting.counters.authorizationGasUsed,'35190');assert.equal((await account(f.stateManager,AUTHORITY)).balance,26n);assert.equal(output.logs.length,1);
});

test('post-authorization proof and deadline failures roll the entire attempt back without publishing preparation',async()=>{
  for(const deadline of[false,true]){
    const f=await fixture({to:AUTHORITY,delegateCode:'0x73'+HELPER.slice(2)+'3100'});let clock=0,appliedCount=0;const apply=f.stateManager.applyAuthorization.bind(f.stateManager);
    f.stateManager.applyAuthorization=async(...args)=>{const r=await apply(...args);appliedCount++;if(deadline)clock=2;return r;};
    if(!deadline){const call=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params,...args)=>{if(params[0]===HELPER)throw Object.assign(Error('Synthetic missing post-authorization proof'),{code:'RPC_EXECUTION_ERROR'});return call(method,params,...args);};}
    const output=await executeEthereumCall({request:f.request,header:f.header,chainId:11155111,stateManager:f.stateManager,blockchain:f.inputs.blockchain,...(deadline?{now:()=>clock,limits:{wallMs:1}}:{})});
    assert.equal(appliedCount,1);assert(['unavailable','unsupported'].includes(output.execution.status));assert.equal(output.authorizationProcessing,undefined);assert.equal(output.execution.returnData,null);assert.equal(output.stateDisposition,'rolled_back');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
    assert.equal(await appliedRoot(f,f.stateManager.snapshotChanges(),f.common),f.header.stateRoot);
  }
});

async function compareQuery(f,side,q,state){
  const request={from:TX_SENDER,to:q.to,data:q.data,value:'0',gas:'1000000'},ref=await authorizationFullVM(f,{request,state,queryContext:true}),error=ref.result.execResult.exceptionError?.error;
  assert.equal(side.output.execution.status,error==='revert'?'reverted':error?'failed':'success');assert.equal(side.output.execution.returnData,bytesToHex(ref.result.execResult.returnValue));assert.equal(side.output.execution.executionGasUsed,ref.result.execResult.executionGasUsed.toString());
  assert.equal(side.output.gasAccounting.gasUsed,ref.result.totalGasSpent.toString());assert.equal(await appliedRoot(f,side.changesAfter,f.common),ref.stateRoot);
}
test('before/after getters execute old/new authorized code without replay and retain exact sender/authority balances',async()=>{
  const f=await fixture({authority:{nonce:0n,balance:7n,code:designation(SECOND_DELEGATE)}}),q=query(AUTHORITY);
  const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc,queries:[q,native(AUTHORITY),native(TX_SENDER)]});
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'complete');assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  const p=r.preview,ref=await compareAuthorizationFullVM(f,p.original.output,p.original.changes),m=p.measurements[0];assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['7','42','35']]);
  for(const side of[m.before,m.after]){assert.equal(side.output.authorizationProcessing,undefined);assert.equal(side.output.profile.authorizationList,undefined);assert.equal(side.output.feeAccounting,undefined);assert.equal(side.mutationValidation.status,'verified');}
  await compareQuery(f,m.before,q);await compareQuery(f,m.after,q,ref.state);assert.equal(p.measurements[1].values[0].deltaRaw,'0');assert.equal(p.measurements[2].values[0].afterRaw,(await account(ref.state,TX_SENDER)).balance.toString());
});

test('query callback creation after self-authorization is withheld without poisoning later native observations',async()=>{
  const f=await fixture({authorizationList:[authorization({key:TEST_KEY,nonce:2n})],delegateCode:factoryCode(initcode('00',''),{tail:'5000'}),accounts:{[GETTER]:{nonce:1n,code:'0x'+callBytes(TX_SENDER)+RETURN42}}}),q=query(GETTER);
  const r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc,queries:[q,native(TX_SENDER)]});
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.preview.status,'partial');assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  const p=r.preview,ref=await compareAuthorizationFullVM(f,p.original.output,p.original.changes),m=p.measurements[0];assert.equal(m.status,'unavailable');assert.equal(m.values,null);assert.equal(m.before.output.execution.returnData,word(42));assert.equal(m.before.output.authorizationProcessing,undefined);
  assert.equal(p.measurements[1].status,'measured');assert.equal(p.measurements[1].values[0].afterRaw,(await account(ref.state,TX_SENDER)).balance.toString());assert.deepEqual(p.measurements[1].after.changesBefore,p.original.changes);assert.equal(p.original.changes.accounts.find(a=>a.address===TX_SENDER).nonce.after,'0x3');
});
