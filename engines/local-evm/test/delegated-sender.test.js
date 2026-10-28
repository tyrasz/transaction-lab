// Existing EIP-7702 code designations in authenticated synthetic prestate.
// No authorization list or public RPC. Full-VM counterparts share the pinned
// opcode library but use signed zero-price admission and full-MPT finalization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, bigIntToBytes, createAddressFromString, createAccount } from '@ethereumjs/util';
import { Common, Mainnet } from '../../fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';
import { integer } from './proof-fixture.js';

const KEY='0x'+'01'.repeat(32),S='0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
const D='0x'+'22'.repeat(20),W='0x'+'44'.repeat(20),R='0x'+'55'.repeat(20),G='0x'+'66'.repeat(20);
const DESIGNATION='0xef0100'+D.slice(2),MAX_NONCE=(1n<<64n)-1n;
const RETURN42='602a60005260206000f3',REVERT='60006000fd';
const call=target=>'6000600060006000600073'+target.slice(2)+'620f4240f1';
const qty=n=>'0x'+BigInt(n).toString(16),addr=createAddressFromString;
const getAccount=(state,address)=>state.getAccount(addr(address));
const hOrder=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const hNumeric=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);

async function fixture({delegateCode='0x00',senderCode=DESIGNATION,nonce=1n,balance=1000000n,to=S,value='0',accounts={},prePrague=false,prague=false}={}){
  const supplied={
    [S]:{nonce,balance,code:senderCode},[D]:{nonce:1n,balance:9n,code:delegateCode},
    [R]:{nonce:1n,balance:3n,code:'0x'},[G]:{nonce:1n,code:'0x'+RETURN42},...accounts,
  };
  const f=await lifecycleFixture({code:'0x00',accounts:supplied});
  f.request={...f.request,from:S,to,value};f.header.baseFeePerGas='0x0';
  // Explicit Osaka controls can also be handed unchanged to a different client.
  f.header.number=qty(24000000);f.header.timestamp=qty(1764798551);
  if(prague){f.header.number=qty(22500000);f.header.timestamp=qty(1746612311);}
  if(prePrague){f.header.number=qty(19500000);f.header.timestamp=qty(1710338135);delete f.header.requestsHash;}
  f.header.hash=bytesToHex(keccak_256(RLP.encode(hOrder.filter(k=>Object.hasOwn(f.header,k)).map(k=>hNumeric.has(k)?integer(BigInt(f.header[k])):bytes(f.header[k])))));
  f.inputs=createRpcStateInputs({chainId:1,blockHash:f.header.hash,header:f.header,rpc:f.rpc});
  f.stateManager=createProofStateManager({inputs:f.inputs});
  const all={ [FACTORY]:{nonce:7n,balance:1000n,code:'0x00'},[SENDER]:{nonce:1n,balance:1000000n,code:'0x'},...supplied };
  f.allocation=Object.fromEntries(Object.entries(all).map(([address,input])=>{
    const a={nonce:0n,balance:0n,code:'0x',storage:{},...input};
    return[address,{nonce:qty(a.nonce),balance:qty(a.balance),code:a.code,storage:Object.fromEntries(Object.entries(a.storage).map(([slot,value])=>[slot,qty(value)]))}];
  }));return f;
}
function commonFor(f){const common=new Common({chain:Mainnet});common.setHardforkBy({blockNumber:BigInt(f.header.number),timestamp:BigInt(f.header.timestamp)});return common;}
function blockFor(f,common){const h=f.header;return createBlock({header:{
  parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,
  difficulty:BigInt(h.difficulty),number:BigInt(h.number),gasLimit:BigInt(h.gasLimit),gasUsed:BigInt(h.gasUsed),timestamp:BigInt(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,
  baseFeePerGas:BigInt(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot,blobGasUsed:BigInt(h.blobGasUsed),excessBlobGas:BigInt(h.excessBlobGas),parentBeaconBlockRoot:h.parentBeaconBlockRoot,...(h.requestsHash?{requestsHash:h.requestsHash}:{})
},withdrawals:[]},{common});}
async function applyChanges(f,changes,common){
  const state=await loadState(f.allocation,common);
  for(const row of changes.accounts){
    const address=addr(row.address),before=await state.getAccount(address);
    if(row.existence)assert.equal(before!==undefined,row.existence.before);
    for(const field of ['nonce','balance'])if(row[field])assert.equal(before?.[field]??0n,BigInt(row[field].before));
    if(row.code)assert.equal(bytesToHex(await state.getCode(address)),row.code.before);
    for(const slot of row.storage??[]){const value=await state.getStorage(address,bytes(slot.slot));assert.equal(value.length?BigInt(bytesToHex(value)):0n,BigInt(slot.before));}
    if(row.existence?.after===false){await state.deleteAccount(address);continue;}
    if(!before)await state.putAccount(address,createAccount({nonce:0n,balance:0n}));
    for(const field of ['nonce','balance'])if(row[field])await state.modifyAccountFields(address,{[field]:BigInt(row[field].after)});
    if(row.code)await state.putCode(address,bytes(row.code.after));
    for(const slot of row.storage??[])await state.putStorage(address,bytes(slot.slot),bigIntToBytes(BigInt(slot.after)));
  }return bytesToHex(await state.getStateRoot());
}
async function compareFullVM(f,output,changes=f.stateManager.snapshotChanges()){
  const common=commonFor(f),state=await loadState(f.allocation,common),block=blockFor(f,common);
  assert.equal(bytesToHex(await state.getStateRoot()),f.header.stateRoot);assert.equal(bytesToHex(block.hash()),f.header.hash);
  const initial=await getAccount(state,S),request=f.request;
  const tx=createTx({type:0,nonce:initial.nonce,gasPrice:0n,gasLimit:BigInt(request.gas),to:request.to??undefined,value:BigInt(request.value),data:request.data},{common}).sign(bytes(KEY));
  assert.equal(tx.getSenderAddress().toString(),S);
  const vm=await createVM({common,stateManager:state,blockchain:{async getBlock(){throw Error('No synthetic ancestry supplied');},shallowCopy(){return this;}}});
  const result=await runTx(vm,{tx,block}),error=result.execResult.exceptionError?.error;
  assert.equal(output.execution.status,error==='revert'?'reverted':error?'failed':'success');
  assert.equal(output.execution.returnData,bytesToHex(result.execResult.returnValue));
  assert.equal(output.execution.executionGasUsed,result.execResult.executionGasUsed.toString());
  assert.equal(output.gasAccounting.gasUsed,result.totalGasSpent.toString());
  assert.deepEqual(output.logs.map(({address,topics,data})=>({address,topics,data})),(result.execResult.logs??[]).map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})));
  assert.equal(await applyChanges(f,changes,common),bytesToHex(await state.getStateRoot()),'Sparse changes independently applied to initial full MPT must match full VM');
  return{state,result};
}
function admitted(output){assert.deepEqual(output.semantics.senderDelegation,{address:D,authorizationListProcessed:false});assert.equal(output.semantics.callerNonce,'runCall_increment_and_committed_sender_creation_attempts');}
const senderNonce=state=>getAccount(state,S).then(a=>a.nonce);
const query=to=>({to,data:'0x70a08231'+S.slice(2).padStart(64,'0')});

test('delegated sender can transfer to another address without executing or warming its implementation',async()=>{
  const f=await fixture({delegateCode:'0x602a60005500',to:R,value:'7'}),out=await executeEthereumCall(f);
  assert.equal(out.execution.status,'success');admitted(out);assert.equal(out.gasAccounting.gasUsed,'21000');
  assert.equal(await senderNonce(f.stateManager),2n);assert.equal((await getAccount(f.stateManager,S)).balance,999993n);assert.equal((await getAccount(f.stateManager,R)).balance,10n);
  assert.equal(bytesToHex(await f.stateManager.getCode(addr(S))),DESIGNATION);assert.equal(f.stateManager.snapshotChanges().accounts.some(r=>r.storage),false);await compareFullVM(f,out);
  const cold=await fixture({to:W,accounts:{[W]:{nonce:1n,code:'0x73'+D.slice(2)+'3160005260206000f3'}}}),coldOut=await executeEthereumCall(cold);
  assert.equal(coldOut.gasAccounting.gasUsed,'23618');await compareFullVM(cold,coldOut);
});

test('self-call executes in sender storage/address context and warms the resolved implementation',async()=>{
  const f=await fixture({value:'7',delegateCode:'0x3060005233602052326040523460605273'+D.slice(2)+'31608052602a60005560a06000f3'}),out=await executeEthereumCall(f);
  assert.equal(out.execution.status,'success');admitted(out);assert.equal(out.trace.executionAddress,S);assert.equal(out.trace.caller,S);
  const words=out.execution.returnData.slice(2).match(/.{64}/g).map(v=>BigInt('0x'+v));assert.deepEqual(words,[BigInt(S),BigInt(S),BigInt(S),7n,9n]);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(r=>r.address===S).storage,[{slot:word(0),before:word(0),after:word(42)}]);assert.equal((await getAccount(f.stateManager,S)).balance,1000000n);await compareFullVM(f,out);
  const warm=await fixture({delegateCode:'0x73'+D.slice(2)+'3160005260206000f3'}),warmOut=await executeEthereumCall(warm);
  assert.equal(warmOut.gasAccounting.gasUsed,'21118');await compareFullVM(warm,warmOut);
});

test('entered successful and reverted CREATE both retain the delegated sender creation nonce',async()=>{
  for(const revert of [false,true]){
    const f=await fixture({delegateCode:factoryCode(revert?REVERT:initcode('00',''),{value:0,tail:'5000'})}),out=await executeEthereumCall(f);
    assert.equal(out.execution.status,'success');assert.equal(await senderNonce(f.stateManager),3n);admitted(out);
    const target=createdAddress({creator:S,nonce:2n});assert.equal(out.trace.calls.length,1);assert.equal(out.trace.calls[0].from,S);assert.equal(out.trace.calls[0].to,target);assert.equal(out.trace.calls[0].error,revert?'revert':null);
    assert.equal((await getAccount(f.stateManager,target))!==undefined,!revert);await compareFullVM(f,out);
  }
});

test('CREATE2 success followed by collision counts both entered attempts and preserves only the first deployment',async()=>{
  const init=initcode('00',''),f=await fixture({delegateCode:factoryCode(init,{kind:'CREATE2',value:0,repeat:2,tail:'5000'})}),out=await executeEthereumCall(f),target=createdAddress({creator:S,kind:'CREATE2',init});
  assert.equal(out.execution.status,'success');assert.equal(await senderNonce(f.stateManager),4n);assert.deepEqual(out.trace.calls.map(r=>r.to),[target,target]);assert.equal(out.trace.calls[0].error,null);assert.equal(out.trace.calls[1].error,'create collision');
  assert.equal(bytesToHex(await f.stateManager.getCode(addr(target))),'0x00');await compareFullVM(f,out);
});

test('callback creation counts only when its parent ancestry commits, even if a successful constructor is later reverted',async()=>{
  for(const revert of [false,true]){
    const f=await fixture({to:W,delegateCode:factoryCode(initcode('00',''),{value:0,tail:revert?'50'+REVERT:'5000'}),accounts:{[W]:{nonce:1n,code:'0x'+call(S)+'5000'}}}),out=await executeEthereumCall(f);
    assert.equal(out.execution.status,'success');assert.equal(await senderNonce(f.stateManager),revert?2n:3n);assert.equal(out.trace.calls[0].error,revert?'revert':null);assert.equal(out.trace.calls[0].calls[0].error,null);
    assert.equal((await getAccount(f.stateManager,createdAddress({creator:S,nonce:2n})))!==undefined,!revert);await compareFullVM(f,out);
  }
});

test('root REVERT undoes all entered creation effects but preserves the outer transaction nonce',async()=>{
  const f=await fixture({delegateCode:factoryCode(initcode('00',''),{value:0,tail:'50'+REVERT})}),out=await executeEthereumCall(f);
  assert.equal(out.execution.status,'reverted');assert.equal(out.trace.calls[0].error,null);assert.deepEqual(f.stateManager.snapshotChanges().accounts,[{address:S,nonce:{before:'0x1',after:'0x2'}}]);await compareFullVM(f,out);
});

test('pre-entry CREATE balance and uint64 nonce refusals do not invent a creation nonce or frame',async()=>{
  for(const nonceLimit of [false,true]){
    const f=await fixture({nonce:nonceLimit?MAX_NONCE-1n:1n,balance:nonceLimit?1000000n:0n,delegateCode:factoryCode(initcode('00',''),{value:nonceLimit?0:1,tail:'5000'})}),out=await executeEthereumCall(f);
    assert.equal(out.execution.status,'success');assert.equal(await senderNonce(f.stateManager),nonceLimit?MAX_NONCE:2n);assert.deepEqual(out.trace.calls,[]);await compareFullVM(f,out);
  }
});

test('top-level CREATE uses original sender nonce without executing its designation',async()=>{
  const f=await fixture({to:null,delegateCode:'0x602a60005500'});f.request.data='0x'+initcode('00','');
  const out=await executeEthereumCall(f);assert.equal(out.execution.status,'success');admitted(out);assert.equal(out.trace.type,'CREATE');assert.equal(out.trace.to,createdAddress({creator:S,nonce:1n}));assert.equal(await senderNonce(f.stateManager),2n);await compareFullVM(f,out);
});

test('exact designations work at Prague while pre-Prague and malformed sender code stay unsupported',async()=>{
  const prague=await fixture({prague:true,to:R}),positive=await executeEthereumCall(prague);assert.equal(commonFor(prague).hardfork(),'prague');assert.equal(positive.execution.status,'success');admitted(positive);await compareFullVM(prague,positive);
  for(const options of [{prePrague:true},{senderCode:'0x00'},{senderCode:DESIGNATION.slice(0,-2)},{senderCode:DESIGNATION+'00'},{senderCode:'0xef0200'+D.slice(2)}]){
    const f=await fixture(options),out=await executeEthereumCall(f);assert.equal(out.execution.status,'unsupported');assert.equal(out.execution.error.code,'LOCAL_SENDER_CODE_UNSUPPORTED');assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal(await senderNonce(f.stateManager),1n);
  }
});

test('overflow and unsupported nested bytecode restore the entire attempt even inside a caller checkpoint',async()=>{
  const overflow=await fixture({nonce:MAX_NONCE}),invalid=await executeEthereumCall(overflow);assert.equal(invalid.execution.status,'invalid');assert.equal(invalid.execution.error.code,'LOCAL_CALL_NONCE_OVERFLOW');assert.equal(await senderNonce(overflow.stateManager),MAX_NONCE);assert.deepEqual(overflow.stateManager.snapshotChanges().accounts,[]);
  for(const outer of [false,true]){
    const f=await fixture({to:W,delegateCode:'0x602a6000554a00',accounts:{[W]:{nonce:1n,code:'0x'+call(S)+'5000'}}});
    if(outer)await f.stateManager.checkpoint();const before=structuredClone(f.stateManager.snapshotChanges()),out=await executeEthereumCall(f);
    assert.equal(out.execution.status,'unsupported');assert.equal(out.stateDisposition,'rolled_back');assert.deepEqual(f.stateManager.snapshotChanges(),before);assert.equal(await senderNonce(f.stateManager),1n);if(outer)await f.stateManager.revert();
  }
});

test('real child and parent validation accept committed, reverted-constructor, collision and rolled-back callback nonce accounting',async()=>{
  for(const kind of ['success','constructor_revert','collision','ancestor_revert']){
    const init=kind==='constructor_revert'?REVERT:initcode('00','');
    const f=await fixture({to:W,delegateCode:factoryCode(init,{kind:kind==='collision'?'CREATE2':'CREATE',repeat:kind==='collision'?2:1,value:0,tail:kind==='ancestor_revert'?'50'+REVERT:'5000'}),accounts:{[W]:{nonce:1n,code:'0x'+call(S)+'5000'}}});
    const result=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
    assert.equal(result.status,'completed',kind+': '+JSON.stringify(result.error));assert.equal(result.isolation.processClosed,true);assert.equal(result.broker.pendingAtReturn,0);admitted(result.output);
    const expected=kind==='ancestor_revert'?'0x2':kind==='collision'?'0x4':'0x3';assert.equal(result.changes.accounts.find(r=>r.address===S).nonce.after,expected);
    assert.deepEqual(result.inputEvidence.map(r=>r.request),f.calls);await compareFullVM(f,result.output,result.changes);
  }
});

test('real preview permits neutral queries from a delegated sender and rejects extra creation nonce effects',async()=>{
  for(const mutating of [false,true]){
    const f=await fixture({delegateCode:factoryCode(initcode('00',''),{value:0,tail:'5000'}),accounts:{[G]:{nonce:1n,code:'0x'+(mutating?call(S)+'50':'')+RETURN42}}});
    const result=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[query(G)]});
    assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.preview.original.output.execution.status,'success');assert.equal(result.preview.original.changes.accounts.find(r=>r.address===S).nonce.after,'0x3');
    const m=result.preview.measurements[0];assert.deepEqual(m.query,query(G));assert.equal(result.preview.status,mutating?'partial':'complete');assert.equal(m.status,mutating?'unavailable':'measured');
    if(mutating){assert.equal(m.values,null);assert.equal(m.before.values,null);assert.equal(m.after,null);assert.equal(m.before.output.execution.status,'success');assert.equal(m.before.output.trace.calls[0].calls[0].type,'CREATE');}
    else{assert.deepEqual(m.values.map(r=>[r.beforeRaw,r.afterRaw,r.deltaRaw]),[['42','42','0']]);for(const side of [m.before,m.after]){assert.equal(side.mutationValidation.status,'verified');admitted(side.output);}assert.deepEqual(m.after.changesBefore,result.preview.original.changes);}
    assert.deepEqual(result.preview.inputEvidence.map(r=>r.request),f.calls);assert.deepEqual(result.preview.original.inputEvidence,result.preview.inputEvidence.slice(0,result.preview.original.inputEvidence.length));assert.equal(result.broker.pendingAtReturn,0);
  }
});
