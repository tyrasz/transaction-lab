// Fixed declarations only: no EVM or pairing executes during construction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { blobFeeFixture, TARGET, TX_SENDER, COINBASE, word } from '../../../engines/local-evm/test/blob-fee-fixture.js';
import { kzgCallerCode, KZG_ADDRESS, KZG_INPUT, KZG_VECTOR_SOURCE_SHA256 } from '../../../engines/local-evm/test/kzg-fixture.js';
import { ethereumCallGas, ethereumCommon } from '../../../engines/local-evm/ethereum-profile.js';
export const NAMES=Object.freeze([
  'cancun_direct_official_point', 'prague_direct_official_point', 'osaka_direct_official_point',
  'bpo1_direct_official_point', 'bpo2_direct_official_point', 'nested_call_value',
  'nested_callcode_value', 'nested_delegatecall_value', 'nested_staticcall',
  'nested_staticcall_caught_oog', 'nested_call_enclosing_revert', 'direct_incorrect_proof',
  'direct_malformed_proof', 'direct_zero_polynomial_infinity', 'direct_exact_precompile_gas', 'direct_below_precompile_gas',
]);
export const FORKS=Object.freeze({cancun:'Cancun',prague:'Prague',osaka:'Osaka',bpo1:'BPO1',bpo2:'BPO2'});
export const PREFIX_CODE='602a600355';
export const RETURN_TAIL='60405260005160005560205160015560405160025560a160606000a160606000f3';
export const REVERT_TAIL=RETURN_TAIL.slice(0,-2)+'fd';
const replaceWord=(input,index,value)=>input.slice(0,2+index*64)+word(value).slice(2)+input.slice(66+index*64);
export const INCORRECT_INPUT=replaceWord(KZG_INPUT,2,BigInt('0x'+KZG_INPUT.slice(130,194))+1n);
export const MALFORMED_INPUT=KZG_INPUT.slice(0,290)+'00'.repeat(48);
export const INFINITY_POINT='c0'+'00'.repeat(47);
const infinityHash=createHash('sha256').update(Buffer.from(INFINITY_POINT,'hex')).digest('hex');
export const INFINITY_INPUT='0x01'+infinityHash.slice(2)+'00'.repeat(64)+INFINITY_POINT+INFINITY_POINT;
export function options(){
  const shared={profile:'unsigned_eip1559_block_end',gas:'200000',baseFee:7n,maxFee:13n,priorityFee:3n,value:'19',
    to:KZG_ADDRESS,data:KZG_INPUT,excessBlobGas:0n,headerBlobGasUsed:0n,
    sender:{nonce:1n,balance:1000000000000n},target:{nonce:1n,balance:100n,code:'0x00'},
    accounts:{[COINBASE]:{nonce:1n,balance:1n,code:'0x'}}};
  const nested=(kind,gas=50000,revert=false)=>({...shared,fork:'osaka',to:TARGET,
    target:{nonce:1n,balance:100n,code:kzgCallerCode({kind,gas,value:['CALL','CALLCODE'].includes(kind)?5:0,
      prefix:PREFIX_CODE,tail:revert?REVERT_TAIL:RETURN_TAIL})}});
  return [
    ...Object.keys(FORKS).map(fork=>({...shared,fork})),
    nested('CALL'),nested('CALLCODE'),nested('DELEGATECALL'),nested('STATICCALL'),nested('STATICCALL',49999),nested('CALL',50000,true),
    {...shared,fork:'osaka',data:INCORRECT_INPUT}, {...shared,fork:'osaka',data:MALFORMED_INPUT},
    {...shared,fork:'osaka',data:INFINITY_INPUT}, {...shared,fork:'cancun'}, {...shared,fork:'cancun'},
  ];
}
export async function fixtureAt(index){
  assert(Number.isSafeInteger(index)&&index>=0&&index<NAMES.length,'Foreign case');
  const f=await blobFeeFixture(options()[index]);
  if(index>=14)f.request.gas=String(ethereumCallGas(f.request.data,ethereumCommon(f.header),f.request).intrinsic+BigInt(index===14?50000:49999));
  return f;
}
export function canonicalAllocation(allocation){
  return Object.fromEntries(Object.entries(allocation).map(([address,account])=>{
    const storage={};for(const[k,v]of Object.entries(account.storage)){
      assert(BigInt(k)>=0n&&BigInt(k)<(1n<<256n));assert(BigInt(v)>=0n&&BigInt(v)<(1n<<256n));
      const key=word(BigInt(k)),value=word(BigInt(v));assert(!Object.hasOwn(storage,key),'Aliased storage key');
      assert.equal(BigInt(value),BigInt(v));storage[key]=value;
    }return[address,{...account,storage}];
  }));
}
export function initial(f,index){
  assert(Object.hasOwn(FORKS,f.headerVerification.hardfork));
  return {index,name:NAMES[index],fork:FORKS[f.headerVerification.hardfork],header:f.header,request:f.request,
    allocation:canonicalAllocation(f.allocation),contextScope:{signedType:2,syntheticHeader:true,productionMainnetForkSelection:true,
      executedSinglePointEvaluation:true,officialInputSourceSha256:KZG_VECTOR_SOURCE_SHA256,
      sharedCryptoAndOpcodesForFullVM:true,sidecarsValidated:false,wholeBlobValidityValidated:false,gethBlockBodyCapacityValidated:false}};
}
