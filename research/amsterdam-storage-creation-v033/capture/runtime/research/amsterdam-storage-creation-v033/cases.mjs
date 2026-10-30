// Fixed input construction only: no expected state or execution supplies input.
import assert from 'node:assert/strict';
import {createTx,createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {bytesToHex,hexToBytes} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {storageCollisionDiagnosticFixture,STORAGE_DIAGNOSTIC_CASES,STORAGE_SENTINEL_INIT,STORAGE_SENTINEL_RUNTIME,TEST_KEY} from '../../engines/local-evm/test/amsterdam-storage-collision-fixture.js';
import {allocationRoot,normalizeAllocation} from './observations.mjs';
export const IDS=Object.freeze(STORAGE_DIAGNOSTIC_CASES.map(c=>c.id));
export const SYSTEM=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:8000}),execution:Object.freeze({wallMs:8000})});
export async function fixture(index,scaffold=true){assert(Number.isSafeInteger(index)&&index>=0&&index<6);return storageCollisionDiagnosticFixture({...STORAGE_DIAGNOSTIC_CASES[index],priced:true,
 accounts:scaffold?Object.fromEntries(SYSTEM.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}])):{}});}
export function transaction(f){const r=f.request;return createTx({type:2,chainId:11155111n,nonce:1n,gasLimit:BigInt(r.gas),to:r.to??undefined,value:BigInt(r.value),data:r.data,
 maxFeePerGas:BigInt(r.fees.maxFeePerGas),maxPriorityFeePerGas:BigInt(r.fees.maxPriorityFeePerGas)},{common:f.common}).sign(hexToBytes(TEST_KEY));}
export async function declaration(index){
 const f=await fixture(index),original=await fixture(index,false),r=f.request,h=f.header,allocation=normalizeAllocation(f.allocation),tx=transaction(f),signedBytes=bytesToHex(tx.serialize());
 const decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});assert.equal(decoded.type,2);assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);
 assert.equal(await allocationRoot(allocation),h.stateRoot);assert.equal(tx.nonce,BigInt(allocation[r.from].nonce));
 const intrinsic=tx.getIntrinsicGas(),target=allocation[f.collisionAddress];
 // Pinned Geth state_transition.go executeCreate charges this before root entry.
 // These six inputs have no reservoir (total gas <= 5M), authorizations or
 // delegated recipients. No child output contributes to this derivation.
 const empty=!target||(BigInt(target.nonce)===0n&&BigInt(target.balance)===0n&&target.code==='0x');
 const rootAccountStateCharge=STORAGE_DIAGNOSTIC_CASES[index].rootCreate&&empty?183600n:0n;
 return{index,...STORAGE_DIAGNOSTIC_CASES[index],chainId:11155111,fork:'Amsterdam',request:r,header:h,headerHash:h.hash,
  originalAllocation:normalizeAllocation(original.allocation),originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,
  target:f.collisionAddress,creator:f.creator,initialTargetStorageRoot:f.collisionStorageRoot,sentinel:{initcode:'0x'+STORAGE_SENTINEL_INIT,runtime:'0x'+STORAGE_SENTINEL_RUNTIME,slots:['0','1','2','991']},
  environment:{currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,
   currentBaseFee:h.baseFeePerGas,slotNumber:h.slotNumber,withdrawals:[],currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot},
  transaction:tx.toJSON(),signedBytes,transactionHash:bytesToHex(tx.hash()),transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
  inputGas:{intrinsic:intrinsic.toString(),rootAccountStateCharge:rootAccountStateCharge.toString(),gethRootGas:(BigInt(r.gas)-intrinsic-rootAccountStateCharge).toString()},
  amendment:{kind:'identical_inert_system_STOP_accounts',addresses:[...SYSTEM],originalAccountRowsChanged:false,actualDeployedChainState:false}};
}
