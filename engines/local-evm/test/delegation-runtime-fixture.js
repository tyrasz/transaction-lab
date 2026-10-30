// Synthetic authenticated state only; no reference client or predicted output.
import {amsterdamExecutionFixture} from './amsterdam-execution-fixture.js';
import {feeFixture,TX_SENDER,TARGET} from './fee-fixture.js';
export {TX_SENDER,TARGET};
export {word,designation} from './authorization-fixture.js';
export const DELEGATE='0x'+'66'.repeat(20),SECOND='0x'+'77'.repeat(20),ROUTER='0x'+'88'.repeat(20);
export const RETURN42='0x602a60005260206000f3',EXACT='0xef0100'+DELEGATE.slice(2);
export const MALFORMED=['0xef0100','0xef0100'+DELEGATE.slice(2,-2),EXACT+'00'];
const OPS={CALL:'f1',CALLCODE:'f2',DELEGATECALL:'f4',STATICCALL:'fa'};
// Parent storage survives a caught child fault. Return [success, return word,
// delegate balance] so a subsequent cold read also detects accidental warming.
export function nestedRuntime(kind,{value=5,gas=100000,prefix='602a600055'}={}){
 if(!Object.hasOwn(OPS,kind))throw Error('Unknown call kind');
 return'0x'+prefix+'6020602060006000'+(['CALL','CALLCODE'].includes(kind)?'60'+value.toString(16).padStart(2,'0'):'')+
  '73'+TARGET.slice(2)+'62'+gas.toString(16).padStart(6,'0')+OPS[kind]+'60005273'+DELEGATE.slice(2)+'3160405260606000f3';
}
export async function delegationRuntimeFixture({fork='amsterdam',kind=null,targetCode=EXACT,delegateCode=RETURN42,gas=kind?'300000':'200000',value=kind?'7':'0',accounts={},...options}={}){
 const args={...options,gas,value,target:{nonce:1n,balance:17n,code:targetCode},accounts:{
  [DELEGATE]:{nonce:1n,balance:9n,code:delegateCode},[SECOND]:{nonce:1n,balance:11n,code:RETURN42},
  ...(kind?{[ROUTER]:{nonce:1n,balance:19n,code:nestedRuntime(kind)}}:{}),...accounts,
 },...(kind?{to:ROUTER}:{})};
 return fork==='amsterdam'?amsterdamExecutionFixture(args):feeFixture({...args,fork});
}
