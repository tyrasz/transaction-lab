// Fixed input-only declarations. No target execution or expected poststate.
import assert from 'node:assert/strict';
import { createTx, createTxFromRLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { amsterdamExecutionFixture, TX_SENDER } from '../../engines/local-evm/test/amsterdam-execution-fixture.js';
import { HELPER, initcode, factoryCode, reentrantCreation, program, createParts, callBytes } from '../../engines/local-evm/test/amsterdam-creation-attempts-fixture.js';
export const IDS=Object.freeze(['nonself_transfer','self_call_cold_delegate','self_call_warm_delegate','repeated_create2_collision','reverted_ancestor_creation','reentrant_creation']);
export const DELEGATE='0x'+'77'.repeat(20),RECIPIENT='0x'+'55'.repeat(20),RETURN42='602a60005260206000f3';
export const SYSTEM_SCAFFOLDING=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:8000}),execution:Object.freeze({wallMs:8000})});
const key=hexToBytes('0x'+'01'.repeat(32));
const plain=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
export function specification(index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<IDS.length);
 const init=initcode('00',''),accounts={};let body='0x'+RETURN42;
 if(index===3)body=factoryCode(init,{kind:'CREATE2',value:5,repeat:2});
 if(index===4){const{copy,op}=createParts(init);body=program(['36',{push2:'inner'},'57',callBytes(HELPER)+RETURN42,{label:'inner'},'5b',...copy,op+'5000',{label:'init'},init]);accounts[HELPER]={nonce:1n,code:'0x6001600053'+callBytes(TX_SENDER,{inputLength:1,gas:2000000})+'60006000fd'};}
 if(index===5){const r=reentrantCreation(init,TX_SENDER);body=r.body;accounts[HELPER]={nonce:1n,code:r.helper};}
 return{sender:{nonce:1n,balance:1000000000000n,code:'0xef0100'+DELEGATE.slice(2)},to:index===0?RECIPIENT:TX_SENDER,value:index===0?'17':'0',gas:'5000000',
 accounts:{[DELEGATE]:{nonce:1n,balance:9n,code:body},[RECIPIENT]:{nonce:1n,balance:3n,code:'0x'},...accounts},...(index===2?{accessList:[{address:DELEGATE,storageKeys:[]}]}:{})};
}
export async function fixture(index){const spec=specification(index);return amsterdamExecutionFixture({...spec,accounts:{...spec.accounts,...Object.fromEntries(SYSTEM_SCAFFOLDING.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}]))}});}
export async function declaration(index){
 const f=await fixture(index),original=await amsterdamExecutionFixture(specification(index)),r=f.request,h=f.header;
 const allocation=plain(f.allocation);
 for(const row of Object.values(allocation))row.storage=Object.fromEntries(Object.entries(row.storage).map(([k,v])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(v).toString(16).padStart(64,'0')]));
 const initial=await loadState(allocation,f.common);assert.equal(bytesToHex(await initial.getStateRoot()),h.stateRoot);
 const tx=createTx({type:2,chainId:11155111n,nonce:1n,gasLimit:BigInt(r.gas),to:r.to,value:BigInt(r.value),data:r.data,maxFeePerGas:13n,maxPriorityFeePerGas:3n,...(r.accessList?{accessList:r.accessList}:{})},{common:f.common}).sign(key);
 const signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});
 assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(decoded.chainId,11155111n);assert.equal(BigInt(allocation[r.from].nonce),decoded.nonce);
 const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,slotNumber:h.slotNumber,withdrawals:[],currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot};assert.equal(BigInt(h.blobGasUsed),0n);
 const intrinsic=tx.getIntrinsicGas(),topDelegateAccessGas=index===0?0n:index===2?100n:3000n;
 return{index,id:IDS[index],chainId:11155111,fork:'Amsterdam',sender:r.from,request:r,header:h,headerHash:h.hash,originalAllocation:plain(original.allocation),originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,environment,transaction:plain(tx.toJSON()),transactionHash:bytesToHex(tx.hash()),signedBytes,transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
 inputGas:{intrinsic:intrinsic.toString(),topDelegateAccessGas:topDelegateAccessGas.toString(),gethRootGas:(BigInt(r.gas)-intrinsic-topDelegateAccessGas).toString()},
 amendment:{kind:'identical_predeclared_inert_system_STOP_accounts',addresses:[...SYSTEM_SCAFFOLDING],originalAccountRowsChanged:false,actualDeployedChainState:false}};
}
