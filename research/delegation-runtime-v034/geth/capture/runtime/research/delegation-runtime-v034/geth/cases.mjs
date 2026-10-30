// Fixed declarations only: signing, header construction and MPT input checks.
// No VM execution or poststate is used to choose these seven cases.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTx,createTxFromRLP} from '../../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {bytesToHex,hexToBytes} from '../../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {RLP} from '../../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {loadState} from '../../../engines/fixture-evm/state-test.js';
import {amsterdamExecutionFixture} from '../../../engines/local-evm/test/amsterdam-execution-fixture.js';
import {feeFixture,feeCommon,TEST_KEY,TARGET} from '../../../engines/local-evm/test/fee-fixture.js';
import {amsterdamAuthorizationExecutionFixture,authorization,signedAuthorizationTransaction} from '../../../engines/local-evm/test/amsterdam-authorization-execution-fixture.js';
export const IDS=Object.freeze(['root_length3','root_length24','nested_call_length3','nested_delegatecall_length24','root_exact23','prague_root_length24','authorization_retained_after_malformed_recipient']);
export const PROBE_NUMBERS=Object.freeze([1,3,4,5,6,11]);
export const PROBE_PLAN_SHA='016aa44b2b161dea06ffd89cb6ac007543badf871a7e624220e7292cb43aed0c';
export const SYSTEM_SCAFFOLDING=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:8000}),execution:Object.freeze({wallMs:8000})});
const DELEGATE='0x'+'66'.repeat(20),SECOND='0x'+'77'.repeat(20),ROUTER='0x'+'88'.repeat(20),RETURN42='0x602a60005260206000f3',EXACT='0xef0100'+DELEGATE.slice(2);
const sha=b=>createHash('sha256').update(b).digest('hex');
const plain=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
const nested=kind=>'0x6020602060006000'+(kind==='call'?'6000':'')+'73'+TARGET.slice(2)+'620186a0'+(kind==='call'?'f1':'f4')+'60005260406000f3';
export function originalProbe(index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<6);
 const b=fs.readFileSync(new URL('../probe/plan.json',import.meta.url));assert.equal(sha(b),PROBE_PLAN_SHA);
 const plan=JSON.parse(b),number=PROBE_NUMBERS[index],f=plan.inputs[number-1];assert.equal(f.path,'inputs/'+String(number).padStart(3,'0')+'.json');
 const bytes=fs.readFileSync(new URL('../probe/'+f.path,import.meta.url));assert.equal(bytes.length,f.bytes);assert.equal(sha(bytes),f.sha256);
 const input=JSON.parse(bytes);assert.equal(input.id,IDS[index]);return{input,identity:{path:'research/delegation-runtime-v034/probe/'+f.path,bytes:f.bytes,sha256:f.sha256}};
}
export function specification(index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<IDS.length);
 if(index===6)return{targetCode:EXACT+'00',authorizationList:[authorization()],gas:'67106'};
 const rows=[['amsterdam','root','0xef0100'],['amsterdam','root',EXACT+'00'],['amsterdam','call','0xef0100'],['amsterdam','delegatecall',EXACT+'00'],['amsterdam','root',EXACT],['prague','root',EXACT+'00']];
 const [fork,kind,targetCode]=rows[index];
 return{fork,gas:'200000',target:{nonce:1n,balance:17n,code:targetCode},accounts:{[DELEGATE]:{nonce:1n,code:RETURN42},[SECOND]:{nonce:1n,code:RETURN42},...(kind!=='root'?{[ROUTER]:{nonce:1n,balance:19n,code:nested(kind)}}:{})},...(kind!=='root'?{to:ROUTER}:{})};
}
async function build(index,scaffolding){
 const spec=specification(index),accounts={...spec.accounts,...(scaffolding?Object.fromEntries(SYSTEM_SCAFFOLDING.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}])):{})};
 if(index===6)return amsterdamAuthorizationExecutionFixture({...spec,accounts});
 const {fork,...options}=spec;
 if(fork==='amsterdam')return amsterdamExecutionFixture({...options,accounts});
 const f=await feeFixture({...options,fork,accounts});return{...f,common:feeCommon(f),chainId:1};
}
export async function fixture(index){return build(index,true);}
export async function declaration(index){
 const original=await build(index,false),f=await fixture(index),r=f.request,h=f.header,allocation=plain(f.allocation);
 let probeInput=null;
 if(index<6){const p=originalProbe(index);assert.deepEqual(original.request,p.input.request);assert.deepEqual(original.header,p.input.header);assert.deepEqual(original.allocation,p.input.allocation);assert.equal(f.chainId,p.input.chainId);probeInput=p.identity;}
 assert.deepEqual(r,original.request);
 const originalHeader={...original.header,stateRoot:h.stateRoot,hash:h.hash};assert.deepEqual(h,originalHeader);
 for(const [address,row]of Object.entries(original.allocation))assert.deepEqual(allocation[address],row);
 for(const row of Object.values(allocation))row.storage=Object.fromEntries(Object.entries(row.storage).map(([k,v])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(v).toString(16).padStart(64,'0')]));
 const state=await loadState(allocation,f.common);assert.equal(bytesToHex(await state.getStateRoot()),h.stateRoot);
 const tx=index===6?signedAuthorizationTransaction(f):createTx({type:2,chainId:BigInt(f.chainId),nonce:1n,gasLimit:BigInt(r.gas),to:r.to,value:BigInt(r.value),data:r.data,maxFeePerGas:13n,maxPriorityFeePerGas:3n},{common:f.common}).sign(hexToBytes(TEST_KEY));
 const signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(decoded.chainId,BigInt(f.chainId));assert.equal(decoded.nonce,BigInt(allocation[r.from].nonce));assert.equal(decoded.type,index===6?4:2);
 const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,...(h.slotNumber===undefined?{}:{slotNumber:h.slotNumber}),withdrawals:[],currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot};assert.equal(BigInt(h.blobGasUsed),0n);
 const intrinsic=tx.getIntrinsicGas(),authorizationDebit=index===6?44190n:0n,topDelegateAccessGas=index===4?3000n:0n;
 if(index===6){assert.equal(intrinsic,22816n);assert.equal(BigInt(r.gas)-intrinsic-authorizationDebit,100n);}
 return{index,id:IDS[index],probeInput,chainId:f.chainId,fork:index===5?'Prague':'Amsterdam',sender:r.from,request:r,header:h,headerHash:h.hash,originalAllocation:plain(original.allocation),originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,environment,
 transaction:plain(tx.toJSON()),transactionHash:bytesToHex(tx.hash()),signedBytes,transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
 inputGas:{intrinsic:intrinsic.toString(),authorizationDebit:authorizationDebit.toString(),topDelegateAccessGas:topDelegateAccessGas.toString(),gethRootGas:(BigInt(r.gas)-intrinsic-authorizationDebit-topDelegateAccessGas).toString()},
 amendment:{kind:'identical_predeclared_inert_system_STOP_accounts',addresses:[...SYSTEM_SCAFFOLDING],originalAccountRowsChanged:false,actualDeployedChainState:false}};
}
