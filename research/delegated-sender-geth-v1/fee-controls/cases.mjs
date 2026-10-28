// Fixed inputs only: no product, VM, or Geth execution during preparation tests.
import assert from 'node:assert/strict';
import { feeFixture, TEST_KEY, TX_SENDER, TARGET, COINBASE, AUTHORITY, DELEGATE, signAuthorization, word } from '../../../engines/local-evm/test/fee-fixture.js';
import { factoryCode, createdAddress, initcode } from '../../../engines/local-evm/test/lifecycle-fixture.js';
export const NAMES=Object.freeze(['effective_prepayment','cap_clipped_price','sender_coinbase','self_authorized_sender_coinbase','authorization_authority_coinbase','exact_cap_value_affordability','zero_tip_empty_storage_coinbase','zero_tip_empty_storage_coinbase_revert','shanghai_deleted_coinbase','cancun_preexisting_coinbase','cancun_created_deleted_coinbase','authorization_revert','authorization_out_of_gas','storage_clear_refund','authorization_storage_calldata_floor','priced_root_create']);
const BENEFICIARY='0x'+'88'.repeat(20), selfdestruct=to=>'0x73'+to.slice(2)+'ff';
export function options(){
  const authority={nonce:0n,balance:7n,code:'0x'}, emptyMiner={nonce:0n,balance:0n,code:'0x',storage:{[word(991)]:91n}};
  return [
    {target:{nonce:1n,code:'0x3a80600055600052488060015560205232318060025560405260606000f3'}},
    {maxFee:8n,target:{nonce:1n,code:'0x3a80600055600052488060015560205232318060025560405260606000f3'}},
    {coinbase:TX_SENDER},
    {coinbase:TX_SENDER,authorizationList:[signAuthorization({key:TEST_KEY,nonce:2n})],accounts:{[DELEGATE]:{nonce:1n,code:'0x00'}}},
    {coinbase:AUTHORITY,authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{...authority,storage:{[word(991)]:91n}},[DELEGATE]:{nonce:1n,code:'0x00'}}},
    {gas:'21000',value:'5',sender:{balance:273005n}},
    {priorityFee:0n,accounts:{[COINBASE]:emptyMiner}},
    {priorityFee:0n,accounts:{[COINBASE]:emptyMiner},target:{nonce:1n,code:'0x60006000fd'}},
    {fork:'shanghai',coinbase:TARGET,target:{nonce:1n,balance:19n,code:selfdestruct(BENEFICIARY)},gas:'100000'},
    {fork:'cancun',coinbase:TARGET,target:{nonce:1n,balance:19n,code:selfdestruct(BENEFICIARY)},gas:'100000'},
    {fork:'cancun',coinbase:createdAddress({creator:TARGET,nonce:1n}),target:{nonce:1n,code:factoryCode(selfdestruct(BENEFICIARY).slice(2),{value:0,tail:'5000'})}},
    {to:AUTHORITY,gas:'100000',authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:authority,[DELEGATE]:{nonce:1n,code:'0x602a60005560006000fd'}}},
    {to:AUTHORITY,gas:'80000',authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:authority,[DELEGATE]:{nonce:1n,code:'0x602a6000555b600556'}}},
    {gas:'200000',target:{nonce:1n,code:'0x600060005500',storage:{[word(0)]:7n}}},
    {gas:'200000',data:'0x'+'ff'.repeat(2000),target:{nonce:1n,code:'0x600060005500',storage:{[word(0)]:7n}},authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:authority,[DELEGATE]:{nonce:1n,code:'0x00'}}},
    {to:null,data:'0x'+initcode('00','')},
  ];
}
export async function fixtureAt(index){assert(Number.isSafeInteger(index)&&index>=0&&index<NAMES.length,'Foreign case');return feeFixture(options()[index]);}
export function canonicalAllocation(allocation){
  return Object.fromEntries(Object.entries(allocation).map(([address,account])=>{
    const storage={};for(const[k,v]of Object.entries(account.storage)){const key=word(BigInt(k)),value=word(BigInt(v));assert(BigInt(k)>=0n&&BigInt(k)<(1n<<256n));assert(BigInt(v)>=0n&&BigInt(v)<(1n<<256n));assert(!Object.hasOwn(storage,key),'Aliased storage key');assert.equal(BigInt(value),BigInt(v));storage[key]=value;}
    return[address,{...account,storage}];
  }));
}
export function initial(f,index){const hardfork=f.headerVerification.hardfork;assert(['shanghai','cancun','osaka'].includes(hardfork));return{index,name:NAMES[index],fork:hardfork[0].toUpperCase()+hardfork.slice(1),header:f.header,request:f.request,allocation:canonicalAllocation(f.allocation)};}
