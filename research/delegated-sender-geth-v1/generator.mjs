// Existing EIP-7702 code designations in authenticated synthetic prestate.
// No authorization list or public RPC. Full-VM counterparts share the pinned
// opcode library but use signed zero-price admission and full-MPT finalization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RLP } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/node_modules/%40ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/node_modules/%40noble/hashes/sha3.js';
import { bytesToHex, bigIntToBytes, createAddressFromString, createAccount } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/node_modules/%40ethereumjs/util/dist/esm/index.js';
import { Common, Mainnet } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/fixture-evm/node_modules/%40ethereumjs/common/dist/esm/index.js';
import { createBlock } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/fixture-evm/node_modules/%40ethereumjs/block/dist/esm/index.js';
import { createTx } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/fixture-evm/node_modules/%40ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/fixture-evm/node_modules/%40ethereumjs/vm/dist/esm/index.js';
import { loadState } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/fixture-evm/state-test.js';
import { createRpcStateInputs } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/rpc-state-inputs.js';
import { createProofStateManager } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/proof-state.js';
import { executeEthereumCall } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/ethereum-call.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/isolated-call.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, FACTORY, SENDER, bytes, word } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/test/lifecycle-fixture.js';
import { integer } from 'file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/test/proof-fixture.js';

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


import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const cases=[
 ['external_transfer',{delegateCode:'0x602a60005500',to:R,value:'7'}],
 ['self_context',{value:'7',delegateCode:'0x3060005233602052326040523460605273'+D.slice(2)+'31608052602a60005560a06000f3'}],
 ['warm_delegate',{delegateCode:'0x73'+D.slice(2)+'3160005260206000f3'}],
 ['cold_delegate',{to:W,accounts:{[W]:{nonce:1n,code:'0x73'+D.slice(2)+'3160005260206000f3'}}}],
 ['successful_create',{delegateCode:factoryCode(initcode('00',''),{value:0,tail:'5000'})}],
 ['reverting_constructor',{delegateCode:factoryCode(REVERT,{value:0,tail:'5000'})}],
 ['create2_collision',{delegateCode:factoryCode(initcode('00',''),{kind:'CREATE2',repeat:2,value:0,tail:'5000'})}],
 ['callback_create',{to:W,delegateCode:factoryCode(initcode('00',''),{value:0,tail:'5000'}),accounts:{[W]:{nonce:1n,code:'0x'+call(S)+'5000'}}}],
 ['callback_revert',{to:W,delegateCode:factoryCode(initcode('00',''),{value:0,tail:'50'+REVERT}),accounts:{[W]:{nonce:1n,code:'0x'+call(S)+'5000'}}}],
 ['root_revert',{delegateCode:factoryCode(initcode('00',''),{value:0,tail:'50'+REVERT})}],
 ['insufficient_create_balance',{balance:0n,delegateCode:factoryCode(initcode('00',''),{value:1,tail:'5000'})}],
 ['create_nonce_limit',{nonce:MAX_NONCE-1n,delegateCode:factoryCode(initcode('00',''),{value:0,tail:'5000'})}],
 ['root_create',{to:null,delegateCode:'0x602a60005500'}],
 ['prague_external_transfer',{prague:true,to:R}],
];
const rows=[];
for(const [name,options]of cases){
 const f=await fixture(options);if(name==='root_create')f.request.data='0x'+initcode('00','');
 const product=await executeEthereumCall(f),changes=f.stateManager.snapshotChanges(),full=await compareFullVM(f,product,changes),common=commonFor(f),h=f.header;
 const tx=createTx({type:0,nonce:BigInt(f.allocation[S].nonce),gasPrice:0n,gasLimit:BigInt(f.request.gas),to:f.request.to??undefined,value:BigInt(f.request.value),data:f.request.data},{common}).sign(bytes(KEY));
 const stateRoot=bytesToHex(await full.state.getStateRoot()),logsHash=bytesToHex(keccak_256(RLP.encode(full.result.execResult.logs??[]))),fork=common.hardfork()==='prague'?'Prague':'Osaka';
 const transaction={sender:S,chainId:'0x1',to:f.request.to??'',data:[f.request.data],value:[qty(f.request.value)],gasLimit:[qty(f.request.gas)],gasPrice:'0x0',nonce:f.allocation[S].nonce,secretKey:KEY};
 const stateTest={_info:{'fixture-format':'state_test',comment:'Development fixture from immutable prestate; expected postroot and log hash are same-library full-VM results, independently cross-checked against sparse product deltas. No official expectation or public state.'},config:{chainid:'0x01'},env:{currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,currentExcessBlobGas:h.excessBlobGas},pre:f.allocation,transaction,post:{[fork]:[{hash:stateRoot,logs:logsHash,txbytes:bytesToHex(tx.serialize()),indexes:{data:0,gas:0,value:0}}]}};
 rows.push({name,fork,header:h,request:f.request,stateTest,fullVM:{stateRoot,logsHash,gasUsed:full.result.totalGasSpent.toString(),executionGasUsed:full.result.execResult.executionGasUsed.toString(),execution:full.result.execResult.exceptionError?.error??'success'},product:{output:product,changes,appliedStateRoot:await applyChanges(f,changes,common)}});
}
const source=readFileSync('/Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/test/delegated-sender.test.js');
writeFileSync('/tmp/evm-delegated-sender-fixtures.json',JSON.stringify({schemaVersion:1,scope:{syntheticDevelopment:true,publicRPC:false,authorizationListProcessed:false,sharedOpcodeLibrary:true,crossClientExecuted:false},source:{path:'/Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/engines/local-evm/test/delegated-sender.test.js',sha256:createHash('sha256').update(source).digest('hex')},cases:rows},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({count:rows.length,cases:rows.map(r=>({name:r.name,fork:r.fork,gas:r.fullVM.gasUsed,stateRoot:r.fullVM.stateRoot}))}));
