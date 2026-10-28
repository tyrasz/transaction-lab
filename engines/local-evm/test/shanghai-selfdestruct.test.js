import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString, bigIntToBytes, createAccount } from '@ethereumjs/util';
import { Common, Mainnet, Hardfork } from '../../fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { shanghaiFixture, SHANGHAI_SENDER, SHANGHAI_TEST_KEY } from './shanghai-fixture.js';
import { FACTORY, createdAddress, factoryCode, initcode, bytes, word } from './lifecycle-fixture.js';

// Actual bytecode over synthetic, authenticated prestate. Full-VM controls use
// the same pinned opcode library but independent full-MPT state/finalization,
// a real zero-price signed counterpart, and no product-derived initial facts.
const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const VICTIM=address(0x4444),BENEFICIARY=address(0x5555),OTHER=address(0x6666),DONOR=address(0x7777),MIDDLE=address(0x8888),GETTER=address(0x9999);
const sd=target=>'73'+target.slice(2)+'ff',FLAG='60005260206000f3';
function call(target,{value=0,gas=65535,kind='CALL',beneficiary}={}){
  return (beneficiary?'7f'+beneficiary.slice(2).padStart(64,'0')+'600052':'')+'6000600060'+(beneficiary?'20':'00')+'6000'+(['CALL','CALLCODE'].includes(kind)?'60'+value.toString(16).padStart(2,'0'):'')+'73'+target.slice(2)+'61'+gas.toString(16).padStart(4,'0')+({CALL:'f1',CALLCODE:'f2',DELEGATECALL:'f4',STATICCALL:'fa'}[kind]);
}
const account=(state,a)=>state.getAccount(createAddressFromString(a));
const code=(state,a)=>state.getCode(createAddressFromString(a)).then(bytesToHex);
const number=b=>b==='0x'?0n:BigInt(b);
const slot=(state,a,n)=>state.getStorage(createAddressFromString(a),bytes(word(n))).then(b=>number(bytesToHex(b)));
const oldVictim=(runtime=sd(BENEFICIARY),balance=17n)=>({nonce:3n,balance,code:'0x'+runtime,storage:{[word(0)]:11n,[word(991)]:99n}});
const row=(f,a)=>f.stateManager.snapshotChanges().accounts.find(r=>r.address===a);
const nonceOnly=()=>[{address:SHANGHAI_SENDER,nonce:{before:'0x1',after:'0x2'}}];
async function gone(f,a){
  const calls=f.calls.length;
  assert.equal(await account(f.stateManager,a),undefined);assert.equal(await code(f.stateManager,a),'0x');
  for(const key of [0,991,992])assert.equal(await slot(f.stateManager,a,key),0n);
  const copy=f.stateManager.shallowCopy();assert.equal(await account(copy,a),undefined);assert.equal(await code(copy,a),'0x');assert.equal(await slot(copy,a,993),0n);
  assert.equal(f.calls.length,calls,'Finalized deletion masks unrequested original slots without RPC or resurrection');
}
function blockFromHeader(h,common){return createBlock({header:{parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,difficulty:BigInt(h.difficulty),number:BigInt(h.number),gasLimit:BigInt(h.gasLimit),gasUsed:BigInt(h.gasUsed),timestamp:BigInt(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,baseFeePerGas:BigInt(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot},withdrawals:[]},{common});}
async function compareFullVm(f,output){
  const common=new Common({chain:Mainnet,hardfork:Hardfork.Shanghai});
  const reference=await loadState(f.allocation,common),applied=await loadState(f.allocation,common);
  assert.equal(bytesToHex(await reference.getStateRoot()),f.header.stateRoot);
  const block=blockFromHeader(f.header,common);assert.equal(bytesToHex(block.hash()),f.header.hash);
  const tx=createTx({type:0,nonce:BigInt(f.allocation[f.request.from].nonce),gasPrice:0n,gasLimit:BigInt(f.request.gas),to:f.request.to??undefined,value:BigInt(f.request.value),data:f.request.data},{common}).sign(bytes(SHANGHAI_TEST_KEY));
  assert.equal(tx.getSenderAddress().toString(),f.request.from);assert.equal(tx.verifySignature(),true);
  let unexpectedHistory=false;
  const blockchain={async getBlock(){unexpectedHistory=true;throw Error('Synthetic fixture supplies no ancestry');},shallowCopy(){return this;}};
  const vm=await createVM({common,stateManager:reference,blockchain}),result=await runTx(vm,{tx,block});assert.equal(unexpectedHistory,false);
  const error=result.execResult.exceptionError?.error;
  assert.equal(output.execution.status,error==='revert'?'reverted':error?'failed':'success');
  assert.equal(output.execution.returnData,bytesToHex(result.execResult.returnValue));
  assert.equal(output.execution.executionGasUsed,result.execResult.executionGasUsed.toString());
  assert.equal(output.gasAccounting.gasUsed,result.totalGasSpent.toString());
  assert.deepEqual(output.logs.map(({address,topics,data})=>({address,topics,data})),result.execResult.logs.map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})));
  for(const r of f.stateManager.snapshotChanges().accounts){
    const a=createAddressFromString(r.address),before=await applied.getAccount(a);
    if(r.existence)assert.equal(Boolean(before),r.existence.before);
    for(const field of ['nonce','balance'])if(r[field])assert.equal(before?.[field]??0n,number(r[field].before));
    if(r.code)assert.equal(await code(applied,r.address),r.code.before);
    for(const s of r.storage??[])assert.equal(number(bytesToHex(await applied.getStorage(a,bytes(s.slot)))),number(s.before));
    if(r.existence?.after===false)await applied.deleteAccount(a);
    else{
      if(!before){assert.equal(r.existence?.after,true);await applied.putAccount(a,createAccount({nonce:0n,balance:0n}));}
      for(const field of ['nonce','balance'])if(r[field])await applied.modifyAccountFields(a,{[field]:number(r[field].after)});
      if(r.code)await applied.putCode(a,bytes(r.code.after));
      for(const s of r.storage??[])await applied.putStorage(a,bytes(s.slot),bigIntToBytes(number(s.after)));
    }
  }
  assert.equal(bytesToHex(await applied.getStateRoot()),bytesToHex(await reference.getStateRoot()),'Sparse reported whole-account changes reproduce the independent full-VM final root');
}

test('Shanghai deletes preexisting code and the entire authenticated nonempty storage trie',async()=>{
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{[VICTIM]:oldVictim('602a600055'+sd(BENEFICIARY))}});
  const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success',JSON.stringify(output.execution));
  const [deletion]=output.lifecycle.finalizedDeletions;assert.equal(deletion.address,VICTIM);assert.equal(deletion.scope,'entire_account_including_code_and_storage');assert.notEqual(deletion.initialStorageRoot,EMPTY_STORAGE_ROOT);
  assert.deepEqual(row(f,VICTIM),{address:VICTIM,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'},balance:{before:'0x11',after:'0x0'}});
  assert.deepEqual(output.trace.calls[0].selfdestruct,{beneficiary:BENEFICIARY});assert.equal((await account(f.stateManager,BENEFICIARY)).balance,17n);
  assert.equal(output.execution.gasRefundCounter,'0');await gone(f,VICTIM);await compareFullVm(f,output);
});

test('root SELFDESTRUCT preserves prior committed logs while removing its old code and storage',async()=>{
  const runtime='602a6000527f'+word(123).slice(2)+'60206000a1'+sd(BENEFICIARY);
  const f=await shanghaiFixture({accounts:{[VICTIM]:oldVictim(runtime)}});f.request.to=VICTIM;f.request.value='5';
  const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');assert.deepEqual(output.trace.selfdestruct,{beneficiary:BENEFICIARY});
  assert.deepEqual(output.logs,[{address:VICTIM,topics:[word(123)],data:word(42)}]);assert.equal((await account(f.stateManager,BENEFICIARY)).balance,22n);
  await gone(f,VICTIM);await compareFullVm(f,output);
});

test('Shanghai self-beneficiary burns immediately, yet later funding remains until final deletion',async()=>{
  // Return the victim BALANCE immediately after self-destruction, then after a
  // separate donor refills it. Final deletion must also burn that refill.
  const balance='73'+VICTIM.slice(2)+'31';
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'50'+balance+'600052'+call(DONOR)+'50'+balance+'60205260406000f3',accounts:{[VICTIM]:oldVictim(sd(VICTIM)),[DONOR]:{nonce:1n,balance:7n,code:'0x'+sd(VICTIM)}}});
  let atDeletion;const finalize=f.stateManager.finalizeShanghaiContractDeletion.bind(f.stateManager);
  f.stateManager.finalizeShanghaiContractDeletion=async a=>{if(a.toString()===VICTIM)atDeletion=(await account(f.stateManager,VICTIM)).balance;return finalize(a);};
  const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');assert.equal(output.execution.returnData,word(0)+word(7).slice(2));assert.equal(atDeletion,7n);
  assert.deepEqual(output.lifecycle.finalizedDeletions.map(r=>r.address),[VICTIM,DONOR].sort());await gone(f,VICTIM);await gone(f,DONOR);await compareFullVm(f,output);
});

test('scheduled deletion retains executable code/storage and transfers repeated balances to different beneficiaries',async()=>{
  const runtime='600054600101600055600035ff';
  const f=await shanghaiFixture({code:'0x'+call(VICTIM,{beneficiary:BENEFICIARY})+'50'+call(VICTIM,{value:7,beneficiary:OTHER})+FLAG,accounts:{[VICTIM]:oldVictim(runtime,5n)}});
  let beforeDeletion;const finalize=f.stateManager.finalizeShanghaiContractDeletion.bind(f.stateManager);
  f.stateManager.finalizeShanghaiContractDeletion=async a=>{beforeDeletion={storage:await slot(f.stateManager,VICTIM,0),code:await code(f.stateManager,VICTIM)};return finalize(a);};
  const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');assert.equal(output.execution.returnData,word(1));
  assert.deepEqual(beforeDeletion,{storage:13n,code:'0x'+runtime});assert.deepEqual(output.trace.calls.map(c=>c.selfdestruct),[{beneficiary:BENEFICIARY},{beneficiary:OTHER}]);
  assert.equal((await account(f.stateManager,BENEFICIARY)).balance,5n);assert.equal((await account(f.stateManager,OTHER)).balance,7n);assert.equal(output.lifecycle.finalizedDeletions.length,1);
  await gone(f,VICTIM);await compareFullVm(f,output);
});

test('DELEGATECALL and CALLCODE delete their execution account while implementation remains intact',async()=>{
  for(const kind of ['DELEGATECALL','CALLCODE']){
    const runtime='0x'+call(VICTIM,{kind})+'50602a60005500';
    const f=await shanghaiFixture({code:runtime,accounts:{[VICTIM]:oldVictim(),[FACTORY]:{nonce:7n,balance:1000n,code:runtime,storage:{[word(0)]:9n,[word(991)]:42n}}}});
    const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');
    assert.equal(output.trace.calls[0].to,VICTIM);assert.equal(output.trace.calls[0].executionAddress,FACTORY);assert.deepEqual(output.trace.calls[0].selfdestruct,{beneficiary:BENEFICIARY});
    assert.deepEqual(output.lifecycle.finalizedDeletions.map(r=>r.address),[FACTORY]);assert.equal((await account(f.stateManager,VICTIM)).balance,17n);assert.equal(await code(f.stateManager,VICTIM),'0x'+sd(BENEFICIARY));assert.equal(await slot(f.stateManager,VICTIM,991),99n);
    assert.equal((await account(f.stateManager,BENEFICIARY)).balance,1000n);await gone(f,FACTORY);await compareFullVm(f,output);
  }
});

test('Shanghai root constructors delete both absent and prefunded creation targets',async()=>{
  const target=createdAddress({creator:SHANGHAI_SENDER,nonce:1n});
  for(const prefunded of [false,true]){
    const f=await shanghaiFixture({accounts:prefunded?{[target]:{nonce:0n,balance:17n,code:'0x'}}:{}});
    f.request={...f.request,to:null,data:'0x602a600055'+sd(BENEFICIARY),value:'5'};
    const output=await executeEthereumCall(f);assert.equal(output.execution.status,'success');assert.equal(output.trace.type,'CREATE');assert.equal(output.trace.to,target);
    assert.deepEqual(output.lifecycle.finalizedDeletions,[{address:target,scope:'entire_account_including_code_and_storage',initialStorageRoot:EMPTY_STORAGE_ROOT}]);
    assert.equal((await account(f.stateManager,BENEFICIARY)).balance,prefunded?22n:5n);
    assert.deepEqual(row(f,target),prefunded?{address:target,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'},balance:{before:'0x11',after:'0x0'}}:undefined);
    await gone(f,target);await compareFullVm(f,output);
  }
});

test('CREATE2 collision remains until transaction finalization even after a constructor SELFDESTRUCT',async()=>{
  const init=sd(BENEFICIARY),target=createdAddress({kind:'CREATE2',init});
  const f=await shanghaiFixture({code:factoryCode(init,{kind:'CREATE2',value:0,repeat:2})}),output=await executeEthereumCall(f);
  assert.equal(output.execution.status,'success');assert.equal(output.execution.returnData,word(0));assert.equal(output.trace.calls[0].error,null);assert.equal(output.trace.calls[1].error,'create collision');
  assert.equal(output.lifecycle.finalizedDeletions.length,1);await gone(f,target);await compareFullVm(f,output);
});

test('root revert and caught ancestor revert discard child deletion and native transfers',async()=>{
  const middle='0x'+call(VICTIM)+'5060006000fd';
  for(const caught of [false,true]){
    const f=await shanghaiFixture({code:caught?'0x'+call(MIDDLE)+FLAG:middle,accounts:{[VICTIM]:oldVictim(),[MIDDLE]:{nonce:1n,code:middle}}});
    const output=await executeEthereumCall(f);assert.equal(output.execution.status,caught?'success':'reverted');
    const child=caught?output.trace.calls[0].calls[0]:output.trace.calls[0];assert.deepEqual(child.selfdestruct,{beneficiary:BENEFICIARY});assert.equal(output.lifecycle,undefined);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,nonceOnly());assert.equal(await account(f.stateManager,BENEFICIARY),undefined);assert.equal((await account(f.stateManager,VICTIM)).balance,17n);assert.equal(await slot(f.stateManager,VICTIM,991),99n);
    await compareFullVm(f,output);
  }
});

test('STATICCALL and opcode OOG do not record a successful SELFDESTRUCT or delete the target',async()=>{
  for(const options of [{kind:'STATICCALL'},{gas:5000}]){
    const f=await shanghaiFixture({code:'0x'+call(VICTIM,options)+FLAG,accounts:{[VICTIM]:oldVictim()}}),output=await executeEthereumCall(f);
    assert.equal(output.execution.status,'success');assert.equal(output.execution.returnData,word(0));assert.equal(output.trace.calls[0].error,options.kind?'static state change':'out of gas');
    assert.equal(output.trace.calls[0].selfdestruct,undefined);assert.equal(output.lifecycle,undefined);assert.deepEqual(f.stateManager.snapshotChanges().accounts,nonceOnly());assert.equal(await code(f.stateManager,VICTIM),'0x'+sd(BENEFICIARY));
    await compareFullVm(f,output);
  }
});

test('zero-balance SELFDESTRUCT deletes its old account without materializing an absent beneficiary',async()=>{
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{[VICTIM]:oldVictim(sd(BENEFICIARY),0n)}}),output=await executeEthereumCall(f);
  assert.equal(output.execution.status,'success');assert.equal(await account(f.stateManager,BENEFICIARY),undefined);assert.deepEqual(row(f,VICTIM),{address:VICTIM,existence:{before:true,after:false,basis:'shanghai_selfdestruct_deletion'}});
  await gone(f,VICTIM);await compareFullVm(f,output);
});

test('fresh after-query sees deletion without restoring unknown original storage or changing its overlay',async()=>{
  // ABI-shaped query bytecode reports native balance; no token-identity claim.
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{[VICTIM]:oldVictim(),[GETTER]:{nonce:1n,code:'0x73'+VICTIM.slice(2)+'3160005260206000f3'}}});
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:GETTER,data:'0x70a08231'+f.request.from.slice(2).padStart(64,'0')}]});
  assert.equal(result.original.output.execution.status,'success');assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.measurements[0].status,'measured');
  assert.deepEqual(result.measurements[0].values.map(r=>[r.beforeRaw,r.afterRaw,r.deltaRaw]),[['17','0','-17']]);
  assert.deepEqual(result.measurements[0].after.changesBefore.accounts.find(r=>r.address===VICTIM),result.original.changes.accounts.find(r=>r.address===VICTIM));
});

test('fresh query deletion of an original-created contract is rejected as a net mutation',async()=>{
  const target=createdAddress(),runtime=sd(target);
  const f=await shanghaiFixture({code:factoryCode(initcode(runtime,''),{value:5}),accounts:{[GETTER]:{nonce:1n,code:'0x'+call(target)+'50602a60005260206000f3'}}});
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:GETTER,data:'0x70a08231'+f.request.from.slice(2).padStart(64,'0')}]});
  assert.equal(result.original.output.execution.status,'success');assert.equal(result.status,'partial');assert.equal(result.measurements[0].before.status,'measured');assert.equal(result.measurements[0].after.status,'unavailable');
  assert.equal(result.measurements[0].after.output.execution.status,'success');assert.equal(result.measurements[0].values,null);
  const original=result.original.changes.accounts.find(r=>r.address===target);assert.equal(original.code.after,'0x'+runtime);assert.deepEqual(original.balance,{before:'0x0',after:'0x5'});
  assert.equal(result.measurements[0].after.output.lifecycle.finalizedDeletions[0].address,target);
});

test('finalizer host failure after multiple deletions rolls back all code, slots, balances and sender nonce',async()=>{
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'50'+call(DONOR)+'5000',accounts:{[VICTIM]:oldVictim(),[DONOR]:oldVictim(sd(OTHER),7n)}}),finalize=f.stateManager.finalizeShanghaiContractDeletion.bind(f.stateManager),calls=[];
  f.stateManager.finalizeShanghaiContractDeletion=async a=>{calls.push(a.toString());await finalize(a);if(calls.length===2)throw Error('Synthetic host failure after second complete deletion');};
  const output=await executeEthereumCall(f);assert.equal(output.execution.status,'unavailable');assert.equal(output.stateDisposition,'rolled_back');assert.deepEqual(calls,[VICTIM,DONOR].sort());assert.equal(output.lifecycle,undefined);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f.stateManager,SHANGHAI_SENDER)).nonce,1n);
  for(const a of [VICTIM,DONOR]){assert.equal(await slot(f.stateManager,a,991),99n);assert.notEqual(await code(f.stateManager,a),'0x');}
  assert.equal((await account(f.stateManager,VICTIM)).balance,17n);assert.equal((await account(f.stateManager,DONOR)).balance,7n);assert.equal(await account(f.stateManager,BENEFICIARY),undefined);assert.equal(await account(f.stateManager,OTHER),undefined);
});

test('deadline after partial finalization and missing Shanghai finalizer fail closed with rollback',async()=>{
  for(const missing of [false,true]){
    const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{[VICTIM]:oldVictim()}});let expired=false;
    if(missing)f.stateManager.finalizeShanghaiContractDeletion=undefined;
    else{const finalize=f.stateManager.finalizeShanghaiContractDeletion.bind(f.stateManager);f.stateManager.finalizeShanghaiContractDeletion=async a=>{const result=await finalize(a);expired=true;return result;};}
    const output=await executeEthereumCall({...f,limits:{wallMs:100},now:()=>expired?101:0});
    assert.equal(output.execution.status,missing?'unsupported':'unavailable');assert.equal(output.execution.error.code,missing?'LOCAL_LIFECYCLE_UNSUPPORTED':'LOCAL_RESOURCE_LIMIT');assert.equal(output.lifecycle,undefined);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f.stateManager,SHANGHAI_SENDER)).nonce,1n);assert.equal((await account(f.stateManager,VICTIM)).balance,17n);assert.equal(await slot(f.stateManager,VICTIM,991),99n);
  }
});

test('a later invocation cannot silently rematerialize an originally nonempty deleted account',async()=>{
  const f=await shanghaiFixture({code:'0x'+call(VICTIM)+'5000',accounts:{[VICTIM]:oldVictim()}});
  const first=await executeEthereumCall(f);assert.equal(first.execution.status,'success');const prior=structuredClone(f.stateManager.snapshotChanges());
  const second=await executeEthereumCall({...f,request:{...f.request,to:VICTIM,value:'1'}});
  assert.equal(second.execution.status,'unsupported');assert.equal(second.stateDisposition,'rolled_back');assert.deepEqual(f.stateManager.snapshotChanges(),prior);await gone(f,VICTIM);
});

test('generic manager failures in sender/recipient value writes cannot become successful or caught EVM results',async()=>{
  // EthereumJS catches failures in balance transfer helpers. A host failure
  // must still invalidate the entire attempt, even if CALL would be caught.
  for(const mode of ['root-sender','root-recipient','create-recipient','nested-recipient']){
    const f=await shanghaiFixture({code:mode==='nested-recipient'?'0x'+call(VICTIM,{value:1})+FLAG:'0x00',accounts:{[VICTIM]:oldVictim('00')}});
    if(mode==='create-recipient')f.request={...f.request,to:null,data:'0x00',value:'1'};
    else if(mode!=='nested-recipient')f.request.value='1';
    const target=mode==='create-recipient'?createdAddress({creator:SHANGHAI_SENDER,nonce:1n}):mode==='nested-recipient'?VICTIM:FACTORY;
    let injected=0;const put=f.stateManager.putAccount.bind(f.stateManager);
    f.stateManager.putAccount=async(a,value)=>{
      const matches=mode==='root-sender'?a.toString()===SHANGHAI_SENDER&&value.balance===999999n:a.toString()===target&&value.balance===(mode==='create-recipient'?1n:mode==='nested-recipient'?18n:1001n);
      if(matches){injected++;throw Error('Synthetic host failure during value transfer');}return put(a,value);
    };
    const output=await executeEthereumCall(f);assert.equal(injected,1,mode);assert.equal(output.execution.status,'unavailable',mode);assert.equal(output.stateDisposition,'rolled_back',mode);
    assert.equal(output.execution.returnData,null);assert.equal(output.execution.executionGasUsed,null);assert.deepEqual(output.logs,[]);assert.equal(output.lifecycle,undefined);assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
    assert.equal((await account(f.stateManager,SHANGHAI_SENDER)).nonce,1n);assert.equal((await account(f.stateManager,SHANGHAI_SENDER)).balance,1000000n);assert.equal((await account(f.stateManager,FACTORY)).balance,1000n);assert.equal((await account(f.stateManager,VICTIM)).balance,17n);
    if(mode==='create-recipient')assert.equal(await account(f.stateManager,target),undefined);
  }
});
