import assert from 'node:assert/strict';
import { bytesToHex } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { feeFixture,feeCommon,TX_SENDER,TARGET,COINBASE,word } from '../../engines/local-evm/test/fee-fixture.js';
import { blobFeeFixture,signBlobFeeTransaction } from '../../engines/local-evm/test/blob-fee-fixture.js';
import { factoryCode,createdAddress } from '../../engines/local-evm/test/lifecycle-fixture.js';
import { native,UNUSED,ABSENT,BENEFICIARY } from '../../engines/local-evm/test/native-balance-fixture.js';
export const IDS=['fee_transfer_unused_accounts','sender_is_coinbase','completed_revert','blob_completed_revert','shanghai_miner_deletion','created_account_deletion'];
export async function fixtureAt(index){
 assert(Number.isInteger(index)&&index>=0&&index<IDS.length);let f,accounts;
 if(index===0){f=await feeFixture({value:'123',target:{nonce:1n,balance:9n,code:'0x'},accounts:{[UNUSED]:{nonce:3n,balance:77n,code:'0xfe',storage:{[word(991)]:19n}}}});accounts=[TX_SENDER,TARGET,COINBASE,UNUSED,ABSENT];}
 if(index===1){f=await feeFixture({coinbase:TX_SENDER,value:'7',target:{nonce:1n,balance:0n,code:'0x'}});accounts=[TX_SENDER,TARGET];}
 if(index===2){f=await feeFixture({value:'17',gas:'30000',target:{nonce:1n,balance:9n,code:'0x60006000fd'}});accounts=[TX_SENDER,TARGET,COINBASE];}
 if(index===3){f=await blobFeeFixture({blobCount:2,excessBlobGas:10000000n,value:'23',gas:'100000',target:{nonce:1n,balance:5n,code:'0x60006000fd'}});accounts=[TX_SENDER,TARGET,COINBASE];}
 if(index===4){f=await feeFixture({fork:'shanghai',coinbase:TARGET,gas:'100000',target:{nonce:1n,balance:19n,code:'0x73'+BENEFICIARY.slice(2)+'ff'}});accounts=[TX_SENDER,TARGET,BENEFICIARY];}
 if(index===5){const child=createdAddress({creator:TARGET,nonce:1n});f=await feeFixture({fork:'cancun',target:{nonce:1n,balance:100n,code:factoryCode('73'+BENEFICIARY.slice(2)+'ff',{value:5,tail:'5000'})}});accounts=[TX_SENDER,TARGET,child,BENEFICIARY];}
 return{...f,index,id:IDS[index],queries:accounts.map(native)};
}
export function declaration(f){const tx=signBlobFeeTransaction({request:f.request,common:feeCommon(f),nonce:BigInt(f.allocation[f.request.from].nonce)});return{index:f.index,id:f.id,request:f.request,header:f.header,allocation:f.allocation,queries:f.queries,signedCounterpart:bytesToHex(tx.serialize()),scope:'known_synthetic_development_shared_EthereumJS_not_independent_client_or_population'};}
