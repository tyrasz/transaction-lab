// Synthetic keys and authenticated initial MPT only. The full-VM counterpart
// shares pinned EthereumJS opcodes, but uses signed type-4 transaction admission
// and a separate full state manager. It is not an independent-client oracle.
import assert from 'node:assert/strict';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, bigIntToBytes, privateToAddress, createAddressFromString, createAccount, eoaCode7702SignAuthorization } from '@ethereumjs/util';
import { Common, Mainnet } from '../../fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { lifecycleFixture, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';
import { integer } from './proof-fixture.js';

export { bytes, word };
export const TEST_KEY='0x'+'01'.repeat(32), AUTH_KEY='0x'+'02'.repeat(32);
export const TX_SENDER=bytesToHex(privateToAddress(bytes(TEST_KEY))), AUTHORITY=bytesToHex(privateToAddress(bytes(AUTH_KEY)));
export const TARGET='0x'+'44'.repeat(20), DELEGATE='0x'+'66'.repeat(20), SECOND_DELEGATE='0x'+'77'.repeat(20);
export const ZERO='0x'+'00'.repeat(20), MAX_NONCE=(1n<<64n)-1n;
export const RETURN42='602a60005260206000f3', RETURN7='600760005260206000f3', REVERT='60006000fd';
export const designation=address=>'0xef0100'+address.slice(2);
export const qty=n=>'0x'+BigInt(n).toString(16);
export const account=(manager,address)=>manager.getAccount(createAddressFromString(address));
export const code=(manager,address)=>manager.getCode(createAddressFromString(address)).then(bytesToHex);
export const slot=(manager,address,key)=>manager.getStorage(createAddressFromString(address),bytes(word(key))).then(v=>v.length?BigInt(bytesToHex(v)):0n);
export const call=(target,value=0)=>'600060006000600060'+value.toString(16).padStart(2,'0')+'73'+target.slice(2)+'620f4240f1';
export const query=to=>({to,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});
export function signAuthorization({key=AUTH_KEY,address=DELEGATE,nonce=0n,chainId=1n,patch={}}={}) {
  const values=eoaCode7702SignAuthorization([integer(chainId),bytes(address),integer(nonce)],bytes(key));
  return {...Object.fromEntries(['chainId','address','nonce','yParity','r','s'].map((field,i)=>[field,field==='address'?bytesToHex(values[i]):qty(values[i].length?BigInt(bytesToHex(values[i])):0n)])),...patch};
}
const order=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const numeric=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
export async function authorizationFixture({authority={nonce:0n,balance:7n,code:'0x'},sender={},targetCode='0x00',delegateCode='0x'+RETURN42,accounts={},authorizationList=[signAuthorization()],to=TARGET,value='0',data='0x',gas='5000000',prague=false}={}) {
  const supplied={
    [TX_SENDER]:{nonce:1n,balance:1000000n,code:'0x',...sender},
    [TARGET]:{nonce:1n,code:targetCode},[DELEGATE]:{nonce:1n,code:delegateCode},[SECOND_DELEGATE]:{nonce:1n,code:'0x'+RETURN7},
    ...(authority===null?{}:{[AUTHORITY]:authority}),...accounts,
  };
  const f=await lifecycleFixture({code:'0x00',accounts:supplied});
  Object.assign(f.header,{number:qty(prague?22500000:24000000),timestamp:qty(prague?1746612311:1764798551),baseFeePerGas:'0x0',gasUsed:'0x0'});
  f.header.hash=bytesToHex(keccak_256(RLP.encode(order.map(k=>numeric.has(k)?integer(BigInt(f.header[k])):bytes(f.header[k])))));
  f.headerVerification=verifyEthereumHeader({header:f.header,expectedHash:f.header.hash});
  assert.equal(f.headerVerification.hardfork,prague?'prague':'osaka');
  f.request={from:TX_SENDER,to,data,value,gas,...(authorizationList===undefined?{}:{authorizationList})};
  f.inputs=createRpcStateInputs({chainId:1,blockHash:f.header.hash,header:f.header,rpc:f.rpc});
  f.stateManager=createProofStateManager({inputs:f.inputs});
  const initial={[FACTORY]:{nonce:7n,balance:1000n,code:'0x00'},[SENDER]:{nonce:1n,balance:1000000n,code:'0x'},...supplied};
  f.allocation=Object.fromEntries(Object.entries(initial).map(([address,input])=>{
    const a={nonce:0n,balance:0n,code:'0x',storage:{},...input};
    return [address,{nonce:qty(a.nonce),balance:qty(a.balance),code:a.code,storage:Object.fromEntries(Object.entries(a.storage).map(([k,v])=>[k,qty(v)]))}];
  }));return f;
}
export function commonFor(f){const c=new Common({chain:Mainnet});c.setHardforkBy({blockNumber:BigInt(f.header.number),timestamp:BigInt(f.header.timestamp)});return c;}
export function blockFor(f,common){const h=f.header;return createBlock({header:{
  parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,
  difficulty:BigInt(h.difficulty),number:BigInt(h.number),gasLimit:BigInt(h.gasLimit),gasUsed:BigInt(h.gasUsed),timestamp:BigInt(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,
  baseFeePerGas:BigInt(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot,blobGasUsed:BigInt(h.blobGasUsed),excessBlobGas:BigInt(h.excessBlobGas),parentBeaconBlockRoot:h.parentBeaconBlockRoot,requestsHash:h.requestsHash,
},withdrawals:[]},{common});}
export async function appliedRoot(f,changes,common=commonFor(f)) {
  const state=await loadState(f.allocation,common);
  for(const row of changes.accounts){
    const address=createAddressFromString(row.address),before=await state.getAccount(address);
    if(row.existence)assert.equal(before!==undefined,row.existence.before);
    for(const field of ['nonce','balance'])if(row[field])assert.equal(before?.[field]??0n,BigInt(row[field].before));
    if(row.code)assert.equal(bytesToHex(await state.getCode(address)),row.code.before);
    for(const item of row.storage??[]){const v=await state.getStorage(address,bytes(item.slot));assert.equal(v.length?BigInt(bytesToHex(v)):0n,BigInt(item.before));}
    if(row.existence?.after===false){await state.deleteAccount(address);continue;}
    if(!before)await state.putAccount(address,createAccount({nonce:0n,balance:0n}));
    for(const field of ['nonce','balance'])if(row[field])await state.modifyAccountFields(address,{[field]:BigInt(row[field].after)});
    if(row.code)await state.putCode(address,bytes(row.code.after));
    for(const item of row.storage??[])await state.putStorage(address,bytes(item.slot),bigIntToBytes(BigInt(item.after)));
  }
  return bytesToHex(await state.getStateRoot());
}
export async function fullVMReference(f) {
  const common=commonFor(f),state=await loadState(f.allocation,common),block=blockFor(f,common);
  assert.equal(bytesToHex(await state.getStateRoot()),f.header.stateRoot);assert.equal(bytesToHex(block.hash()),f.header.hash);
  const vm=await createVM({common,stateManager:state,blockchain:{async getBlock(){throw Error('No synthetic ancestry supplied');},shallowCopy(){return this;}}});
  return {state,common,async run(request=f.request){
    const sender=await account(state,request.from),list=request.authorizationList;
    const tx=createTx({type:list?4:0,nonce:sender.nonce,gasLimit:BigInt(request.gas),to:request.to??undefined,value:BigInt(request.value),data:request.data,
      ...(list?{maxFeePerGas:0n,maxPriorityFeePerGas:0n,authorizationList:list.map(t=>['chainId','address','nonce','yParity','r','s'].map(k=>k==='address'?bytes(t[k]):integer(BigInt(t[k]))))}:{gasPrice:0n})},{common}).sign(bytes(TEST_KEY));
    assert.equal(tx.getSenderAddress().toString(),TX_SENDER);assert(tx.verifySignature());
    return runTx(vm,{tx,block});
  }};
}
export function compareExecution(output,result) {
  const error=result.execResult.exceptionError?.error;
  assert.equal(output.execution.status,error==='revert'?'reverted':error?'failed':'success');
  assert.equal(output.execution.returnData,bytesToHex(result.execResult.returnValue));
  assert.equal(output.execution.executionGasUsed,result.execResult.executionGasUsed.toString());
  assert.equal(output.execution.gasRefundCounter,(result.execResult.gasRefund??0n).toString(),'Message refund excludes authorization refund');
  assert.equal(output.gasAccounting.gasUsed,result.totalGasSpent.toString());
  assert.deepEqual(output.logs.map(({address,topics,data})=>({address,topics,data})),(result.execResult.logs??[]).map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})));
}
export async function compareFullVM(f,output,changes=f.stateManager.snapshotChanges()) {
  const ref=await fullVMReference(f),result=await ref.run();compareExecution(output,result);
  assert.equal(await appliedRoot(f,changes,ref.common),bytesToHex(await ref.state.getStateRoot()),'Product changes applied to a third full MPT must equal signed type-4 postroot');
  return {...ref,result};
}
