// Input-only declarations from the released synthetic fixture builders.
import assert from 'node:assert/strict';
import { createTx, createTxFromRLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { creationAttemptFixture, TARGET, HELPER, initcode, factoryCode, createdAddress, reentrantCreation }
  from '../../engines/local-evm/test/amsterdam-creation-attempts-fixture.js';
export const IDS=Object.freeze(['repeated_create2','initial_nonce_collision','initial_code_collision','constructor_revert','parent_rollback','reentrant_creation']);
export const SYSTEM_SCAFFOLDING=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:8000}),execution:Object.freeze({wallMs:8000})});
const key=hexToBytes('0x'+'01'.repeat(32));
const plain=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
export function specification(index){
  assert(Number.isSafeInteger(index)&&index>=0&&index<IDS.length);
  const init=initcode('00',''),accounts={};let body;
  if(index===0)body=factoryCode(init,{kind:'CREATE2',value:5,repeat:2});
  if(index===1||index===2){const kind=index===1?'CREATE':'CREATE2',target=createdAddress({creator:TARGET,kind,init});
    accounts[target]={nonce:index===1?3n:0n,balance:17n,code:index===1?'0x':'0x00'};body=factoryCode(init,{kind,value:5});}
  if(index===3)body=factoryCode('600160005560006000fd',{value:5,tail:'5000'});
  if(index===4)body=factoryCode(init,{kind:'CREATE2',value:5,repeat:2,tail:'5060006000fd'});
  if(index===5){const r=reentrantCreation(init,TARGET);body=r.body;accounts[HELPER]={nonce:1n,code:r.helper};}
  return{body,accounts,gas:'5000000'};
}
export async function fixture(index){const spec=specification(index);return creationAttemptFixture({...spec,accounts:{...spec.accounts,...Object.fromEntries(SYSTEM_SCAFFOLDING.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}]))}});}
export async function declaration(index){
  const f=await fixture(index),original=await creationAttemptFixture(specification(index)),r=f.request,h=f.header;
  const allocation=plain(f.allocation);
  for(const row of Object.values(allocation)) row.storage=Object.fromEntries(Object.entries(row.storage).map(([k,v])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(v).toString(16).padStart(64,'0')]));
  const initial=await loadState(allocation,f.common);assert.equal(bytesToHex(await initial.getStateRoot()),h.stateRoot);
  const tx=createTx({type:2,chainId:11155111n,nonce:1n,gasLimit:BigInt(r.gas),to:r.to,value:BigInt(r.value),data:r.data,
    maxFeePerGas:BigInt(r.fees.maxFeePerGas),maxPriorityFeePerGas:BigInt(r.fees.maxPriorityFeePerGas)}, {common:f.common}).sign(key);
  const signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});
  assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(decoded.chainId,11155111n);
  const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,
    currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,slotNumber:h.slotNumber,
    withdrawals:[],currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot};
  assert.equal(BigInt(h.blobGasUsed),0n);
  return{index,id:IDS[index],chainId:11155111,fork:'Amsterdam',sender:r.from,request:r,header:h,headerHash:h.hash,
    originalAllocation:plain(original.allocation),originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,
    environment,transaction:plain(tx.toJSON()),transactionHash:bytesToHex(tx.hash()),signedBytes,transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
    amendment:{kind:'identical_predeclared_inert_system_STOP_accounts',addresses:[...SYSTEM_SCAFFOLDING],originalAccountRowsChanged:false,actualDeployedChainState:false}};
}
