// Synthetic prestate only. The signed full-VM counterpart shares EthereumJS
// opcodes; its transaction admission/settlement and full MPT are separate from
// the product. This is not an independent-client oracle or public-chain data.
import assert from 'node:assert/strict';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
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
import { TEST_KEY, TX_SENDER, TARGET, DELEGATE, AUTHORITY, qty, account, appliedRoot, compareExecution } from './authorization-fixture.js';
export { TEST_KEY, TX_SENDER, TARGET, DELEGATE, AUTHORITY, qty, account, bytes, word, appliedRoot };
export { signAuthorization, designation, slot, code, call, ZERO } from './authorization-fixture.js';
export const COINBASE='0x'+'99'.repeat(20);
export const PROFILE='unsigned_eip1559_block_end';
const order=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const numeric=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
const forks={shanghai:[18000000,1681338455,17],cancun:[20000000,1710338135,20],prague:[22500000,1746612311,21],osaka:[24000000,1764798551,21]};
export async function feeFixture({fork='osaka',baseFee=7n,maxFee=13n,priorityFee=3n,coinbase=COINBASE,sender={},target={nonce:1n,code:'0x00'},accounts={},to=TARGET,value='0',data='0x',gas='5000000',authorizationList,accessList,limits}={}) {
  assert(Object.hasOwn(forks,fork));
  const supplied={ [TX_SENDER]:{nonce:1n,balance:1000000000000n,code:'0x',...sender},...(target===null?{}:{[TARGET]:target}),...accounts };
  const f=await lifecycleFixture({code:'0x00',accounts:supplied,limits});
  const [number,timestamp,length]=forks[fork];
  Object.assign(f.header,{number:qty(number),timestamp:qty(timestamp),baseFeePerGas:qty(baseFee),miner:coinbase,gasUsed:'0x0'});
  for(const key of order.slice(length))delete f.header[key];
  f.header.hash=bytesToHex(keccak_256(RLP.encode(order.slice(0,length).map(k=>numeric.has(k)?integer(BigInt(f.header[k])):bytes(f.header[k])))));
  f.headerVerification=verifyEthereumHeader({header:f.header,expectedHash:f.header.hash});assert.equal(f.headerVerification.hardfork,fork);
  f.request={from:TX_SENDER,to,data,value,gas,executionProfile:PROFILE,fees:{maxFeePerGas:String(maxFee),maxPriorityFeePerGas:String(priorityFee)},...(authorizationList!==undefined?{authorizationList}:{}),...(accessList!==undefined?{accessList}:{})};
  f.inputs=createRpcStateInputs({chainId:1,blockHash:f.header.hash,header:f.header,rpc:f.rpc,...(limits?{limits}:{})});f.stateManager=createProofStateManager({inputs:f.inputs});
  const specifications={ [FACTORY]:{nonce:7n,balance:1000n,code:'0x00'},[SENDER]:{nonce:1n,balance:1000000n,code:'0x'},...supplied };
  f.allocation=Object.fromEntries(Object.entries(specifications).map(([address,input])=>{const a={nonce:0n,balance:0n,code:'0x',storage:{},...input};return[address,{nonce:qty(a.nonce),balance:qty(a.balance),code:a.code,storage:Object.fromEntries(Object.entries(a.storage).map(([key,v])=>[key,qty(v)]))}];}));
  return f;
}
export function feeCommon(f){const common=new Common({chain:Mainnet});common.setHardforkBy({blockNumber:BigInt(f.header.number),timestamp:BigInt(f.header.timestamp)});return common;}
export function feeBlock(f,common){const h=f.header;return createBlock({header:{parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,difficulty:BigInt(h.difficulty),number:BigInt(h.number),gasLimit:BigInt(h.gasLimit),gasUsed:BigInt(h.gasUsed),timestamp:BigInt(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,baseFeePerGas:BigInt(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot,...(h.blobGasUsed===undefined?{}:{blobGasUsed:BigInt(h.blobGasUsed),excessBlobGas:BigInt(h.excessBlobGas),parentBeaconBlockRoot:h.parentBeaconBlockRoot}),...(h.requestsHash===undefined?{}:{requestsHash:h.requestsHash})},withdrawals:[]},{common});}
export async function feeFullVM(f){
  const common=feeCommon(f),state=await loadState(f.allocation,common),block=feeBlock(f,common);
  assert.equal(bytesToHex(await state.getStateRoot()),f.header.stateRoot);assert.equal(bytesToHex(block.hash()),f.header.hash);
  const vm=await createVM({common,stateManager:state,blockchain:{async getBlock(){throw Error('No synthetic ancestry supplied');},shallowCopy(){return this;}}});
  return {state,common,block,async run(request=f.request){
    const sender=await account(state,request.from),list=request.authorizationList;
    const tx=createTx({type:list?4:2,chainId:1n,nonce:sender?.nonce??0n,gasLimit:BigInt(request.gas),to:request.to??undefined,value:BigInt(request.value),data:request.data,maxFeePerGas:BigInt(request.fees.maxFeePerGas),maxPriorityFeePerGas:BigInt(request.fees.maxPriorityFeePerGas),...(request.accessList?{accessList:request.accessList}:{}),...(list?{authorizationList:list.map(t=>['chainId','address','nonce','yParity','r','s'].map(k=>k==='address'?bytes(t[k]):integer(BigInt(t[k]))))}:{})},{common}).sign(bytes(TEST_KEY));
    assert.equal(tx.getSenderAddress().toString(),request.from);assert(tx.verifySignature());
    return {tx,result:await runTx(vm,{tx,block})};
  }};
}
export async function compareFeeFullVM(f,output,changes=f.stateManager.snapshotChanges()){
  const ref=await feeFullVM(f),{tx,result}=await ref.run();compareExecution(output,result);
  assert.equal(await appliedRoot(f,changes,ref.common),bytesToHex(await ref.state.getStateRoot()),'Full signed transaction root must equal product deltas applied to an independent third MPT');
  return {...ref,tx,result};
}
export const balance=(state,address)=>state.getAccount(createAddressFromString(address)).then(a=>a?.balance??0n);
