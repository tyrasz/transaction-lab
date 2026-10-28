// Fixed declarations only. Building an initial trie/signature executes no EVM.
import assert from 'node:assert/strict';
import { blobFeeFixture, BLOB_PROFILE, TX_SENDER, COINBASE, word } from '../../../engines/local-evm/test/blob-fee-fixture.js';

export const NAMES=Object.freeze([
  'cancun_maximum_blob_count', 'prague_maximum_blob_count', 'osaka_maximum_blob_count',
  'bpo1_maximum_blob_count', 'bpo2_maximum_blob_count', 'type2_blobbasefee_no_clamp',
  'blob_message_revert', 'blob_message_out_of_gas', 'blob_execution_refund_cap',
  'blob_calldata_floor_after_refund', 'blob_sender_equals_coinbase', 'blob_exact_max_cap_affordability',
]);
export const FORKS=Object.freeze({cancun:'Cancun',prague:'Prague',osaka:'Osaka',bpo1:'BPO1',bpo2:'BPO2'});
const schedules=[['cancun',6,6,3338477n],['prague',9,9,5007716n],['osaka',6,9,5007716n],['bpo1',6,15,8346193n],['bpo2',6,21,11684671n]];
const hashes=count=>Array.from({length:count},(_,i)=>'0x01'+BigInt(i+1).toString(16).padStart(62,'0'));
// Slots0..6 bind price, first/last/out-of-range hash, GASPRICE, BASEFEE and
// the sender's post-prepayment balance. A fixed LOG1 retains price/hash0 too.
export function observationCode(count){
  assert(Number.isInteger(count)&&count>=0&&count<=9);
  const push=n=>'60'+n.toString(16).padStart(2,'0');
  return '0x4a600055600049600155'+push(Math.max(0,count-1))+'49600255'+push(count)+
    '496003553a6004554860055533316006554a60005260004960205260b160406000a100';
}
const clearCode='0x60006000556000600155600060025500';
const clearStorage=()=>Object.fromEntries([0,1,2].map(i=>[word(i),7n]));
export function options(){
  const shared={gas:'300000',baseFee:7n,maxFee:13n,priorityFee:3n,maxBlobFee:100n,
    accounts:{[COINBASE]:{nonce:1n,balance:1n,code:'0x'}}};
  const two={fork:'osaka',blobCount:2,blobVersionedHashes:hashes(2),excessBlobGas:10015432n};
  return [
    ...schedules.map(([fork,count,blockMax,fraction])=>({...shared,fork,blobCount:count,
      blobVersionedHashes:hashes(count),excessBlobGas:2n*fraction,headerBlobGasUsed:BigInt(blockMax)*131072n,
      target:{nonce:1n,code:observationCode(count)}})),
    {...shared,fork:'osaka',profile:'unsigned_eip1559_block_end',excessBlobGas:0n,baseFee:1600n,maxFee:2000n,
      target:{nonce:1n,code:observationCode(0)}},
    {...shared,...two,gas:'100000',value:'19',target:{nonce:1n,code:'0x602a600055600160005360016000a060006000fd'}},
    {...shared,...two,gas:'50000',value:'19',target:{nonce:1n,code:'0x602a6000555b600556'}},
    {...shared,...two,gas:'200000',target:{nonce:1n,code:clearCode,storage:clearStorage()}},
    {...shared,...two,gas:'200000',data:'0x'+'ff'.repeat(2000),target:{nonce:1n,code:clearCode,storage:clearStorage()}},
    {...shared,...two,fork:'bpo2',excessBlobGas:23369342n,coinbase:TX_SENDER,target:{nonce:1n,code:observationCode(2)}},
    {...shared,...two,gas:'21000',value:'5',sender:{balance:26487405n}},
  ];
}
export async function fixtureAt(index){
  assert(Number.isSafeInteger(index)&&index>=0&&index<NAMES.length,'Foreign case');
  return blobFeeFixture(options()[index]);
}
export function canonicalAllocation(allocation){
  return Object.fromEntries(Object.entries(allocation).map(([address,account])=>{
    const storage={};for(const[k,v]of Object.entries(account.storage)){
      assert(BigInt(k)>=0n&&BigInt(k)<(1n<<256n));assert(BigInt(v)>=0n&&BigInt(v)<(1n<<256n));
      const key=word(BigInt(k)),value=word(BigInt(v));assert(!Object.hasOwn(storage,key),'Aliased storage key');
      assert.equal(BigInt(value),BigInt(v));storage[key]=value;
    }
    return[address,{...account,storage}];
  }));
}
export function initial(f,index){
  assert(Object.hasOwn(FORKS,f.headerVerification.hardfork));
  return {index,name:NAMES[index],fork:FORKS[f.headerVerification.hardfork],header:f.header,request:f.request,
    allocation:canonicalAllocation(f.allocation),contextScope:{hashOnlySignedType:f.request.executionProfile===BLOB_PROFILE?3:2,
      headerBlobGasUsedRetained:true,gethBlockBodyCapacityValidated:false,parentExcessTransitionValidated:false,sidecarsValidated:false}};
}
