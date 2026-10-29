// Fixed input-only type-4 declarations. No runtime result supplies input state.
import assert from 'node:assert/strict';
import {createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {bytesToHex,hexToBytes} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {loadState} from '../../engines/fixture-evm/state-test.js';
import {amsterdamAuthorizationExecutionFixture,signedAuthorizationTransaction,authorization,AUTHORITY,TEST_KEY,TX_SENDER,DELEGATE,SECOND_DELEGATE,ZERO,TARGET,
  RETURN42,REVERT,initcode,factoryCode,callBytes} from '../../engines/local-evm/test/amsterdam-authorization-execution-fixture.js';
export const IDS=Object.freeze(['existing_empty_install','self_authorization_callback_create2_collision','late_authorization_oog','recipient_preparation_oog','entered_revert_retains_authorization','duplicate_clear_reinstall']);
export const SYSTEM_SCAFFOLDING=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:8000}),execution:Object.freeze({wallMs:8000})});
const plain=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
export function specification(index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<IDS.length);
 const options={priced:true,to:TARGET,gas:'5000000',authorizationList:[authorization()]};
 if(index===0)options.authority={nonce:0n,balance:0n,code:'0x'};
 if(index===1){options.authorizationList=[authorization({key:TEST_KEY,nonce:2n})];options.targetCode='0x'+callBytes(TX_SENDER)+RETURN42;options.delegateCode=factoryCode(initcode('00',''),{kind:'CREATE2',value:5,repeat:2});}
 if(index===2){options.authorizationList=[authorization(),authorization({key:'0x'+'03'.repeat(32)}),authorization({nonce:1n})];options.gas=String(15000n+3n*7816n+50000n);}
 if(index===3){options.to=AUTHORITY;options.gas=String(15000n+7816n+44190n+2999n);}
 if(index===4){options.to=AUTHORITY;options.delegateCode='0x602a600055'+REVERT;}
 if(index===5){options.to=AUTHORITY;options.authorizationList=[authorization(),authorization({address:SECOND_DELEGATE}),authorization({nonce:1n,address:ZERO}),authorization({nonce:2n,address:SECOND_DELEGATE})];}
 return options;
}
export async function fixture(index){return amsterdamAuthorizationExecutionFixture({...specification(index),accounts:Object.fromEntries(SYSTEM_SCAFFOLDING.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}]))});}
export async function declaration(index){
 const f=await fixture(index),original=await amsterdamAuthorizationExecutionFixture(specification(index)),r=f.request,h=f.header,allocation=plain(f.allocation);
 for(const row of Object.values(allocation))row.storage=Object.fromEntries(Object.entries(row.storage).map(([k,v])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(v).toString(16).padStart(64,'0')]));
 const state=await loadState(allocation,f.common);assert.equal(bytesToHex(await state.getStateRoot()),h.stateRoot);
 const tx=signedAuthorizationTransaction(f),signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});assert.equal(decoded.type,4);assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(decoded.chainId,11155111n);assert.equal(decoded.nonce,BigInt(allocation[r.from].nonce));
 const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,slotNumber:h.slotNumber,withdrawals:[],currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot};assert.equal(BigInt(h.blobGasUsed),0n);
 // Pinned Geth charges successful authorizations before CALL/haltTopFrame.
 // A failed atomic charge consumes no partial cost. These are input-derived
 // interpretation offsets, not expected execution/state/log results.
 const authDebit=[227790n,35190n,44190n,44190n,44190n,44190n][index];
 const recipientDebit=[0n,0n,0n,0n,3000n,3000n][index];
 const intrinsic=tx.getIntrinsicGas(),phase=index===2?'authorization_out_of_gas':index===3?'recipient_out_of_gas':'message';
 return{index,id:IDS[index],chainId:11155111,fork:'Amsterdam',sender:r.from,request:r,header:h,headerHash:h.hash,originalAllocation:plain(original.allocation),originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,environment,
 transaction:plain(tx.toJSON()),transactionHash:bytesToHex(tx.hash()),signedBytes,transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
 inputGas:{intrinsic:intrinsic.toString(),gethAuthorizationDebitBeforeRoot:authDebit.toString(),gethRecipientDebitBeforeRoot:recipientDebit.toString(),gethRootGas:(BigInt(r.gas)-intrinsic-authDebit-recipientDebit).toString(),expectedPreparationPhase:phase,productMessageEntered:index!==2,gethRootRepresentsPreparationHalt:index===2||index===3},
 amendment:{kind:'identical_predeclared_inert_system_STOP_accounts',addresses:[...SYSTEM_SCAFFOLDING],originalAccountRowsChanged:false,actualDeployedChainState:false}};
}
