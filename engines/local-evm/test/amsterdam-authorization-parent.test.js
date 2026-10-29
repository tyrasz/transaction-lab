// Actual child-boundary negatives. Recounting bytes and, where meaningful,
// recomputing settlement prevents incidental JSON-size/arithmetic rejection
// from substituting for the parent's independent preparation/state binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { settleEthereumStateGas } from '../ethereum-state-gas.js';
import { ethereumFeePlan, settleEthereumFees } from '../ethereum-fees.js';
import { ethereumCallGas } from '../ethereum-profile.js';
import { amsterdamAuthorizationExecutionFixture as fixture, authorization, signedAuthorizationTransaction,
  AUTHORITY, DELEGATE, SECOND_DELEGATE, TX_SENDER, TEST_KEY, AUTH_KEY, TARGET, REVERT,
  designation, factoryCode, initcode } from './amsterdam-authorization-execution-fixture.js';

const hex=n=>'0x'+BigInt(n).toString(16);
const strings=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v]));
const numbers=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='boolean'?v:BigInt(v)]));
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc,chainId:11155111});
const intrinsic=f=>signedAuthorizationTransaction(f).getIntrinsicGas();
function recount(output){
  output.usage.retainedTraceBytes=Buffer.byteLength(JSON.stringify({trace:output.trace,logs:output.logs,
    ...(output.lifecycle?{lifecycle:output.lifecycle}:{}),
    ...(output.authorizationProcessing?{authorizationProcessing:output.authorizationProcessing}:{}),
    ...(output.feeAccounting?{feeAccounting:output.feeAccounting}:{}),
    ...(output.stateGasAccounting?{stateGasAccounting:output.stateGasAccounting}:{})}));
}
function reprice(result,f){
  const output=result.output,a=output.stateGasAccounting;
  a.settled=strings(settleEthereumStateGas(numbers(a.budget),numbers(a.counters)));
  output.gasAccounting={...a.settled};
  const old=output.feeAccounting;
  if(!old)return;
  const updated=settleEthereumFees(ethereumFeePlan(f.request,f.header,11155111),{gasUsed:BigInt(a.settled.gasUsed)});
  const deltas=new Map([[TX_SENDER,BigInt(old.gasCharge)-BigInt(updated.gasCharge)]]);
  deltas.set(updated.coinbase,(deltas.get(updated.coinbase)??0n)+BigInt(updated.coinbaseTip)-BigInt(old.coinbaseTip));
  for(const [address,delta] of deltas){
    if(delta===0n)continue;
    const row=result.changes.accounts.find(row=>row.address===address);
    assert(row?.balance,'Fixture must expose the affected fee delta');
    row.balance.after=hex(BigInt(row.balance.after)+delta);
  }
  output.feeAccounting=updated;
}
function retainAuthority(result){
  result.changes.accounts.push({address:AUTHORITY,nonce:{before:'0x0',after:'0x1'},
    code:{before:'0x',after:designation(DELEGATE)}});
  result.changes.accounts.sort((a,b)=>a.address.localeCompare(b.address));
}
async function baseline(f,phase='message',status='success'){
  const r=await run(f);
  assert.equal(r.status,'completed',JSON.stringify(r.error));
  assert.equal(r.output.execution.status,status);
  assert.equal(r.output.authorizationProcessing.preparation.phase,phase);
  return r;
}
async function tamper(t,f,change){
  const fork=childProcess.fork;let changed=false;
  const mock=t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args),emit=child.emit;
    child.emit=function(event,...values){
      if(event==='message'&&typeof values[0]==='string'){
        const message=JSON.parse(values[0]);
        if(message.type==='result'){
          assert(message.result.output?.authorizationProcessing,'Negative must start from a completed authorization result');
          change(message.result,f);recount(message.result.output);changed=true;
          values[0]=JSON.stringify(message);
        }
      }
      return emit.call(this,event,...values);
    };
    return child;
  });
  try{
    const r=await run(f);
    assert.equal(changed,true);assert.equal(r.status,'unavailable');
    assert.equal(r.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(r.output,null);assert.equal(r.changes,null);
    assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);
  }finally{mock.mock.restore();}
}

test('Amsterdam parent binds successful ordered decisions, preparation costs, nonce and code',async t=>{
  const f=await fixture({to:AUTHORITY});await baseline(f);
  for(const change of [
    r=>{r.output.authorizationProcessing.entries[0].authority=TX_SENDER;},
    r=>{r.output.authorizationProcessing.entries[0].status='skipped';r.output.authorizationProcessing.entries[0].reason='nonce_mismatch';},
    r=>{r.output.authorizationProcessing.preparation.failedIndex=0;},
    r=>{r.output.authorizationProcessing.preparation.retained=false;},
    r=>{r.changes.accounts.find(row=>row.address===AUTHORITY).nonce.after='0x2';},
    r=>{r.changes.accounts.find(row=>row.address===AUTHORITY).code.after=designation(SECOND_DELEGATE);},
    (r,f)=>{const p=r.output.authorizationProcessing.preparation,c=r.output.stateGasAccounting.counters;
      p.authorizationGasUsed=(BigInt(p.authorizationGasUsed)+1n).toString();c.authorizationGasUsed=p.authorizationGasUsed;reprice(r,f);},
  ])await tamper(t,f,change);
});

test('authorization preparation OOG cannot acquire an invented entered frame, dropped phase or retained write',async t=>{
  const f=await fixture({authorizationList:[authorization(),authorization({key:'0x'+'03'.repeat(32)}),authorization({nonce:1n})]});
  f.request.gas=(intrinsic(f)+50000n).toString();
  const positive=await baseline(f,'authorization_out_of_gas','failed');
  assert.equal(positive.output.trace,null);assert.equal(positive.output.authorizationProcessing.entries[0].status,'applied');
  assert.equal(positive.output.authorizationProcessing.entries[1].status,'out_of_gas');
  for(const change of [
    r=>{r.output.trace={type:'CALL',from:TX_SENDER,to:TARGET,executionAddress:TARGET,caller:TX_SENDER,value:'0x0',input:'0x',gas:'0xc350',gasUsed:'0x0',output:'0x',error:'out of gas',depth:0,calls:[],creationAttempts:[]};r.output.usage.frames=1;},
    r=>{delete r.output.authorizationProcessing.preparation;},
    r=>{r.output.authorizationProcessing.preparation.phase='completed';},
    r=>{r.output.authorizationProcessing.preparation.phase='message';r.output.authorizationProcessing.preparation.retained=true;},
    r=>{r.output.authorizationProcessing.preparation.failedIndex=0;},
    retainAuthority,
  ])await tamper(t,f,change);
});

test('recipient preparation OOG binds the separate authorization and entered-root gas debits',async t=>{
  const f=await fixture({to:AUTHORITY});f.request.gas=(intrinsic(f)+44190n+2999n).toString();
  const positive=await baseline(f,'recipient_out_of_gas','failed');
  assert.equal(positive.output.execution.executionGasUsed,'2999');assert.equal(positive.output.usage.steps,0);
  for(const change of [
    r=>{r.output.trace.calls.push({type:'CALL',from:AUTHORITY,to:DELEGATE,executionAddress:DELEGATE,
      caller:AUTHORITY,value:'0x0',input:'0x',gas:'0x1',gasUsed:'0x1',output:'0x',error:'invalid opcode',
      depth:1,calls:[],creationAttempts:[]});
      r.output.usage.frames=2;r.output.usage.steps=1;r.output.usage.maxDepth=1;},
    r=>{r.output.usage.steps=1;},
    // Keep total paid gas, fees and dimensions exact while falsely attributing
    // the root's debit to authorization preparation instead.
    (r,f)=>{const o=r.output,p=o.authorizationProcessing.preparation,c=o.stateGasAccounting.counters;
      p.authorizationGasUsed='47189';c.authorizationGasUsed='47189';c.messageGasUsed='0';
      o.execution.executionGasUsed='0';o.trace.gasUsed='0x0';reprice(r,f);},
    r=>{r.output.authorizationProcessing.preparation.authorizationGasUsed='47189';r.output.stateGasAccounting.counters.authorizationGasUsed='47189';},
    (r,f)=>{const o=r.output,p=o.authorizationProcessing.preparation,c=o.stateGasAccounting.counters;
      p.phase='authorization_out_of_gas';p.failedIndex=0;p.authorizationGasUsed='47189';
      o.authorizationProcessing.entries[0]={index:0,authority:AUTHORITY,status:'out_of_gas',reason:'out_of_gas'};
      c.authorizationGasUsed='47189';c.messageGasUsed='0';o.execution.executionGasUsed='0';o.trace=null;o.usage.frames=0;reprice(r,f);},
    retainAuthority,
  ])await tamper(t,f,change);
});

test('entered message REVERT retains authorization state and its nonrefundable state-gas charge',async t=>{
  const f=await fixture({to:AUTHORITY,gas:'500000',delegateCode:'0x602a600055'+REVERT});
  const positive=await baseline(f,'message','reverted');
  assert.equal(positive.output.execution.executionStateGasUsed,'35190');
  for(const change of [
    r=>{r.changes.accounts=r.changes.accounts.filter(row=>row.address!==AUTHORITY);},
    r=>{r.output.authorizationProcessing.preparation.retained=false;},
    (r,f)=>{r.output.execution.executionStateGasUsed='0';r.output.stateGasAccounting.counters.executionStateGasUsed='0';reprice(r,f);},
    (r,f)=>{const o=r.output;o.execution.executionStateGasUsed='0';o.stateGasAccounting.counters.executionStateGasUsed='0';
      o.authorizationProcessing.preparation.executionStateGasUsed='0';o.authorizationProcessing.preparation.stateGasSpilled='0';
      r.changes.accounts=r.changes.accounts.filter(row=>row.address!==AUTHORITY);reprice(r,f);},
  ])await tamper(t,f,change);
});

test('self-authorization creator chronology cannot absorb an extra prepared or committed sender nonce',async t=>{
  const f=await fixture({to:TX_SENDER,authorizationList:[authorization({key:TEST_KEY,nonce:2n})],
    delegateCode:factoryCode(initcode('00',''),{kind:'CREATE2',repeat:2,value:5})});
  const positive=await baseline(f);
  assert.equal(positive.changes.accounts.find(row=>row.address===TX_SENDER).nonce.after,'0x5');
  for(const change of [
    r=>{r.output.authorizationProcessing.preparation.senderAuthorizationIncrements='0';},
    r=>{r.changes.accounts.find(row=>row.address===TX_SENDER).nonce.after='0x4';},
    r=>{r.output.semantics.senderDelegation.authorizationListProcessed=false;},
    r=>{for(const attempt of r.output.trace.creationAttempts){attempt.nonceBefore=hex(BigInt(attempt.nonceBefore)+1n);attempt.nonceAfter=hex(BigInt(attempt.nonceAfter)+1n);}
      r.changes.accounts.find(row=>row.address===TX_SENDER).nonce.after='0x6';},
  ])await tamper(t,f,change);
});

test('absent sender self-authorization retains its materialization basis only after preparation completes',async t=>{
  for(const mode of ['stop','revert','authorization_oog']){
    const f=await fixture({priced:false,authority:null,to:AUTHORITY,
      delegateCode:mode==='revert'?'0x'+REVERT:'0x00',
      authorizationList:[authorization({key:AUTH_KEY,nonce:1n})]});
    f.request.from=AUTHORITY;
    if(mode==='authorization_oog')f.request.gas=(ethereumCallGas(f.request.data,f.common,f.request).intrinsic+35189n).toString();
    const halt=mode==='authorization_oog',r=await baseline(f,halt?'authorization_out_of_gas':'message',
      halt?'failed':mode==='revert'?'reverted':'success');
    const row=r.changes.accounts.find(row=>row.address===AUTHORITY);
    assert.equal(r.inputs.accounts[AUTHORITY].exists,false);
    assert.deepEqual(row.existence,{before:false,after:true,
      basis:halt?'unsigned_sender_nonce_materialization':'eip7702_authorization_materialization'});
    assert.deepEqual(row.nonce,{before:'0x0',after:halt?'0x1':'0x2'});
    assert.deepEqual(row.code,halt?undefined:{before:'0x',after:designation(DELEGATE)});
    if(halt)assert.equal(r.output.trace,null);
    await tamper(t,f,candidate=>{candidate.changes.accounts.find(row=>row.address===AUTHORITY).existence.basis=
      halt?'eip7702_authorization_materialization':'unsigned_sender_nonce_materialization';});
  }
});
