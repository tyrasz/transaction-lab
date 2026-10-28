// Fixed supplemental development controls selected before this packet executes.
import { authorizationFixture, signAuthorization, TEST_KEY, TX_SENDER, AUTHORITY, TARGET, DELEGATE, SECOND_DELEGATE, ZERO, MAX_NONCE, REVERT, designation, word, qty } from '../../../engines/local-evm/test/authorization-fixture.js';
import { factoryCode, initcode } from '../../../engines/local-evm/test/lifecycle-fixture.js';
export const NAMES=Object.freeze(['install_existing','install_absent','install_existing_empty','replace','clear','ordered_duplicates','self_authorization','protocol_skips','nonce_mismatch','malformed_designation_authority','message_revert','message_out_of_gas','storage_write_log','storage_clear_refund','authorization_selfdestruct_not_creation','prague_self_authorization_create']);
export function options(){
  const order=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return [
    {},{authority:null},{authority:{nonce:0n,balance:0n,code:'0x'}},
    {authority:{nonce:3n,balance:7n,code:designation(SECOND_DELEGATE),storage:{[word(991)]:91n}},authorizationList:[signAuthorization({nonce:3n})]},
    {authority:{nonce:3n,balance:7n,code:designation(DELEGATE),storage:{[word(991)]:91n}},authorizationList:[signAuthorization({nonce:3n,address:ZERO})]},
    {authority:null,authorizationList:[signAuthorization(),signAuthorization(),signAuthorization({nonce:1n,address:SECOND_DELEGATE}),signAuthorization({nonce:2n,address:ZERO})]},
    {to:TX_SENDER,authorizationList:[signAuthorization({key:TEST_KEY,nonce:2n})]},
    {authorizationList:[signAuthorization({chainId:2n}),signAuthorization({nonce:MAX_NONCE}),signAuthorization({patch:{yParity:'0x2'}}),signAuthorization({patch:{s:qty(order/2n+1n)}}),signAuthorization({patch:{r:'0x0'}}),signAuthorization({chainId:0n})]},
    {authority:{nonce:8n,balance:7n,code:'0x'}},
    {authority:{nonce:0n,balance:7n,code:designation(DELEGATE).slice(0,-2)}},
    {to:AUTHORITY,delegateCode:'0x602a600055'+REVERT},
    {to:AUTHORITY,delegateCode:'0x602a6000555b600556',gas:'80000'},
    {to:AUTHORITY,authority:{nonce:0n,balance:7n,code:'0x',storage:{[word(991)]:91n}},delegateCode:'0x602a600055602a60005260206000a000'},
    {to:AUTHORITY,authority:{nonce:0n,balance:7n,code:'0x',storage:{[word(0)]:7n}},delegateCode:'0x600060005500'},
    {authority:null,to:AUTHORITY,value:'5',delegateCode:'0x73'+TARGET.slice(2)+'ff'},
    {prague:true,to:TX_SENDER,authorizationList:[signAuthorization({key:TEST_KEY,nonce:2n})],delegateCode:factoryCode(initcode('00',''),{value:0,tail:'5000'})},
  ];
}
export async function fixtureAt(index){if(!Number.isSafeInteger(index)||index<0||index>=NAMES.length)throw Error('Foreign case');return authorizationFixture(options()[index]);}
export function initial(f,index){return {index,name:NAMES[index],fork:f.headerVerification.hardfork==='prague'?'Prague':'Osaka',header:f.header,request:f.request,allocation:f.allocation};}
