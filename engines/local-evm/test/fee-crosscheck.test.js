// Fixed synthetic controls. Signed transaction and full-state counterparts
// share EthereumJS opcodes, not product admission/settlement or proof state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { factoryCode, createdAddress, initcode } from './lifecycle-fixture.js';
import { feeFixture, feeFullVM, compareFeeFullVM, balance, account, code, slot, word, signAuthorization, designation, TEST_KEY, TX_SENDER, TARGET, COINBASE, AUTHORITY, DELEGATE, PROFILE } from './fee-fixture.js';
const BENEFICIARY='0x'+'88'.repeat(20);
const selfdestruct=to=>'0x73'+to.slice(2)+'ff';
const restoreWord=(...words)=>'0x'+words.map(x=>word(x).slice(2)).join('');
function assertAccounting(f,out,gas){
  const limit=BigInt(f.request.gas),cap=BigInt(f.request.fees.maxFeePerGas),base=BigInt(f.header.baseFeePerGas),tip=BigInt(f.request.fees.maxPriorityFeePerGas)<cap-base?BigInt(f.request.fees.maxPriorityFeePerGas):cap-base,effective=base+tip;
  assert.deepEqual(out.feeAccounting,{kind:'eip1559',gasLimit:String(limit),effectiveGasPrice:String(effective),baseFeePerGas:String(base),priorityFeePerGas:String(tip),maximumRequiredBalance:String(limit*cap+BigInt(f.request.value)),upfrontGasDebit:String(limit*effective),chargedGas:String(gas),gasCharge:String(gas*effective),senderRefund:String((limit-gas)*effective),baseFeeBurn:String(gas*base),coinbaseTip:String(gas*tip),coinbase:f.header.miner});
  assert.equal(out.profile.executionProfile,PROFILE);assert.equal(out.profile.feesSettled,true);assert.equal(out.semantics.feeSettlement,true);assert.equal(out.semantics.gasPrice,String(effective));
}
async function crosscheck(f,status='success'){
  const out=await executeEthereumCall(f);assert.equal(out.execution.status,status,JSON.stringify(out.execution));
  const ref=await compareFeeFullVM(f,out);assertAccounting(f,out,ref.result.totalGasSpent);return{out,ref};
}

test('fixture full VM admits exact signed type-2/type-4 inputs with real fees and immutable prestate',async()=>{
  for(const authorizations of [false,true]){
    const f=await feeFixture(authorizations?{authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x'},[DELEGATE]:{nonce:1n,code:'0x00'}}}:{});
    const before=structuredClone(f.allocation),ref=await feeFullVM(f),{tx,result}=await ref.run();
    assert.equal(tx.type,authorizations?4:2);assert.equal(result.totalGasSpent,authorizations?36800n:21000n);
    assert.equal(await balance(ref.state,TX_SENDER),1000000000000n-result.totalGasSpent*10n);assert.equal(await balance(ref.state,COINBASE),result.totalGasSpent*3n);
    assert.deepEqual(f.allocation,before);assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.deepEqual(f.calls,[],'Full VM never consumes or mutates product proof inputs');
  }
});

test('effective price, BASEFEE and sender balance inside execution reflect effective prepayment',async()=>{
  for(const [maxFee,priorityFee,effective]of [[13n,3n,10n],[8n,3n,8n],[7n,0n,7n]]){
    const f=await feeFixture({maxFee,priorityFee,target:{nonce:1n,code:'0x3a60005248602052323160405260606000f3'}});
    const{out}=await crosscheck(f);assert.equal(out.execution.returnData,restoreWord(effective,7n,1000000000000n-5000000n*effective));
  }
});

test('sender equal to coinbase settles sequentially without replacing nonce or returned funds',async()=>{
  const f=await feeFixture({coinbase:TX_SENDER});const{ref}=await crosscheck(f);
  assert.equal(ref.result.totalGasSpent,21000n);assert.equal(await balance(f.stateManager,TX_SENDER),1000000000000n-21000n*7n);
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
});

test('fee recipient aliases preserve authorization code, nonce and storage through settlement',async()=>{
  for(const self of [false,true]){
    const authority=self?TX_SENDER:AUTHORITY;
    const f=await feeFixture({coinbase:authority,authorizationList:[signAuthorization({...(self?{key:TEST_KEY,nonce:2n}:{})})],accounts:{[DELEGATE]:{nonce:1n,code:'0x00'},...(!self?{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x',storage:{[word(991)]:91n}}}:{})}});
    const{ref}=await crosscheck(f);assert.equal((await account(f.stateManager,authority)).nonce,self?3n:1n);assert.equal(await code(f.stateManager,authority),designation(DELEGATE));
    assert.equal(await balance(f.stateManager,authority),self?1000000000000n-ref.result.totalGasSpent*7n:7n+ref.result.totalGasSpent*3n);
    if(!self)assert.equal(await slot(f.stateManager,authority,991),91n);
  }
});

test('exact cap-plus-value affordability admits a zero-message-gas transfer without charging the cap',async()=>{
  const f=await feeFixture({gas:'21000',value:'5',sender:{balance:273005n}});const{out}=await crosscheck(f);
  assert.equal(out.execution.executionGasUsed,'0');assert.equal(out.feeAccounting.maximumRequiredBalance,'273005');assert.equal(out.feeAccounting.gasCharge,'210000');
  assert.equal(await balance(f.stateManager,TX_SENDER),63000n);assert.equal(await balance(f.stateManager,TARGET),5n);assert.equal(await balance(f.stateManager,COINBASE),63000n);
});

test('zero-tip coinbase touch removes existing empty accounts including hidden storage, also after REVERT',async()=>{
  for(const mode of ['absent','empty','empty_storage','revert']){
    const f=await feeFixture({priorityFee:0n,accounts:mode==='absent'?{}:{[COINBASE]:{nonce:0n,balance:0n,code:'0x',storage:mode==='empty'?{}:{[word(991)]:91n}}},target:{nonce:1n,code:mode==='revert'?'0x60006000fd':'0x00'}});
    const{out,ref}=await crosscheck(f,mode==='revert'?'reverted':'success');
    assert.equal(await account(f.stateManager,COINBASE),undefined);assert.equal(await account(ref.state,COINBASE),undefined);
    if(mode!=='absent'){assert(out.lifecycle.emptyAccountCleanup.deletions.some(x=>x.address===COINBASE));assert.equal(await slot(ref.state,COINBASE,991),0n);}
  }
});

test('Shanghai coinbase deletion burns settlement credit; Cancun preexisting coinbase retains it',async()=>{
  for(const fork of ['shanghai','cancun']){
    const f=await feeFixture({fork,coinbase:TARGET,target:{nonce:1n,balance:19n,code:selfdestruct(BENEFICIARY)},gas:'100000'});
    const{out,ref}=await crosscheck(f);assert.equal(await balance(f.stateManager,BENEFICIARY),19n);
    if(fork==='shanghai'){assert.equal(await account(f.stateManager,TARGET),undefined);assert(out.lifecycle.finalizedDeletions.some(x=>x.address===TARGET));}
    else{assert.equal(await balance(f.stateManager,TARGET),ref.result.totalGasSpent*3n);assert.equal(await code(f.stateManager,TARGET),selfdestruct(BENEFICIARY));}
    assert(BigInt(out.feeAccounting.coinbaseTip)>0n,'Accounting credit need not survive deletion as balance');
  }
});

test('Cancun same-transaction created coinbase receives priority credit before whole-account deletion',async()=>{
  const child=createdAddress({creator:TARGET,nonce:1n}),f=await feeFixture({fork:'cancun',coinbase:child,target:{nonce:1n,code:factoryCode(selfdestruct(BENEFICIARY).slice(2),{value:0,tail:'5000'})}});
  const{out}=await crosscheck(f);assert(out.lifecycle.finalizedDeletions.some(x=>x.address===child));assert.equal(await account(f.stateManager,child),undefined);assert(BigInt(out.feeAccounting.coinbaseTip)>0n);
});

test('authorization preparation and refund survive REVERT/OOG while message writes roll back',async()=>{
  for(const exceptional of [false,true]){
    const f=await feeFixture({to:AUTHORITY,gas:exceptional?'80000':'100000',authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x'},[DELEGATE]:{nonce:1n,code:'0x602a600055'+(exceptional?'5b600556':'60006000fd')}}});
    const{out,ref}=await crosscheck(f,exceptional?'failed':'reverted');assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');assert.equal(await code(f.stateManager,AUTHORITY),designation(DELEGATE));assert.equal((await account(f.stateManager,AUTHORITY)).nonce,1n);assert.equal(await slot(f.stateManager,AUTHORITY,0),0n);
    if(exceptional){assert.equal(ref.result.totalGasSpent,67500n);assert.equal(out.feeAccounting.senderRefund,'125000');}
  }
});

test('storage and authorization refunds are capped before the calldata floor sets charged gas',async()=>{
  for(const [data,withAuth]of [['0x',false],['0x'+'ff'.repeat(2000),false],['0x'+'ff'.repeat(2000),true]]){
    const f=await feeFixture({gas:'200000',data,target:{nonce:1n,code:'0x600060005500',storage:{[word(0)]:7n}},...(withAuth?{authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x'},[DELEGATE]:{nonce:1n,code:'0x00'}}}:{})});
    const{out,ref}=await crosscheck(f);assert.equal(out.execution.gasRefundCounter,'4800');assert.equal(await slot(f.stateManager,TARGET,0),0n);
    if(data!=='0x'){assert.equal(ref.result.totalGasSpent,101000n);assert.equal(out.feeAccounting.gasCharge,'1010000');}
    if(withAuth)assert.equal(out.authorizationProcessing.gasRefundCounter,'12500');
  }
});

test('maximum-cap affordability and overflowing maximum liability reject without any retained mutation',async()=>{
  for(const overflow of [false,true]){
    const f=await feeFixture({gas:'21000',maxFee:overflow?(1n<<256n)-1n:13n,sender:{balance:overflow?(1n<<256n)-1n:210000n}}),before=structuredClone(f.stateManager.snapshotChanges());
    const out=await executeEthereumCall(f);assert(!['success','reverted','failed'].includes(out.execution.status));assert.equal(out.feeAccounting,undefined);assert.deepEqual(f.stateManager.snapshotChanges(),before);
    const ref=await feeFullVM(f),root=bytesToHex(await ref.state.getStateRoot());await assert.rejects(ref.run(),overflow?/gasLimit \* maxFeePerGas cannot exceed MAX_INTEGER/:/funds|max cost|balance/i);assert.equal(bytesToHex(await ref.state.getStateRoot()),root);
  }
});

test('priced root creation includes creation gas and exact signed full-state settlement',async()=>{
  const f=await feeFixture({to:null,data:'0x'+initcode('00','')});const{out,ref}=await crosscheck(f);assert.equal(ref.tx.to,undefined);assert.equal(out.trace.type,'CREATE');assert.equal(out.execution.returnData,'0x00');
});

test('actual isolated child validates fees and full postroots for aliases, empty cleanup and authorization failure',async()=>{
  const configs=[{}, {coinbase:TX_SENDER}, {priorityFee:0n,accounts:{[COINBASE]:{nonce:0n,balance:0n,code:'0x',storage:{[word(991)]:91n}}}}, {fork:'shanghai',coinbase:TARGET,target:{nonce:1n,balance:19n,code:selfdestruct(BENEFICIARY)}}, {to:AUTHORITY,authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x'},[DELEGATE]:{nonce:1n,code:'0x60006000fd'}}}];
  for(const config of configs){const f=await feeFixture(config),attempt=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});assert.equal(attempt.status,'completed',JSON.stringify(attempt.error));assert.equal(attempt.isolation.processClosed,true);assert.equal(attempt.broker.pendingAtReturn,0);const ref=await compareFeeFullVM(f,attempt.output,attempt.changes);assertAccounting(f,attempt.output,ref.result.totalGasSpent);assert.deepEqual(attempt.inputEvidence.map(x=>x.request),f.calls);}
});
