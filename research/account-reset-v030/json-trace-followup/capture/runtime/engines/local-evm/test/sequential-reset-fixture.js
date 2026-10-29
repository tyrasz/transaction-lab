// Authenticated initial facts only. Signed transactions carry one independent
// full MPT across invocations. EthereumJS is shared, so this is not an
// independent-client oracle. No expected poststate is an execution input.
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString, createAccount, bigIntToBytes } from '@ethereumjs/util';
import { loadState } from '../../fixture-evm/state-test.js';
import { feeFixture, feeFullVM, feeCommon, TX_SENDER, COINBASE } from './fee-fixture.js';
import { FACTORY, factoryCode, createdAddress, initcode, bytes, word } from './lifecycle-fixture.js';
export { TX_SENDER, COINBASE, FACTORY, bytes, word };
export const BENEFICIARY='0x'+'88'.repeat(20), FUNDER='0x'+'77'.repeat(20), INSPECTOR='0x'+'66'.repeat(20);
export const OLD_SLOT=991, UNREAD_SLOT=992;
export const callCode=(target,value=0)=>'600060006000600060'+value.toString(16).padStart(2,'0')+'73'+target.slice(2)+'620f4240f1';
export const selfdestructCode='73'+BENEFICIARY.slice(2)+'ff';
// Empty calldata returns slot zero; nonempty calldata deletes on Shanghai.
export const RECREATED_RUNTIME='3615601b5773'+BENEFICIARY.slice(2)+'ff5b60005460005260206000f3';
const quantity=n=>'0x'+BigInt(n).toString(16);
export const account=(state,a)=>state.getAccount(createAddressFromString(a));
export const code=(state,a)=>state.getCode(createAddressFromString(a)).then(bytesToHex);
export const storage=(state,a,k)=>state.getStorage(createAddressFromString(a),bytes(word(k))).then(v=>v.length?BigInt(bytesToHex(v)):0n);
export const request=(f,to,extra={})=>({...f.request,to,data:'0x',value:'0',...extra});

export async function resetFixture({constructorReverts=false,ancestorReverts=false,fork='shanghai'}={}){
  const init=constructorReverts?'602a60005560006000fd':initcode(RECREATED_RUNTIME,'6103df54600155602a600055');
  const victim=createdAddress({kind:'CREATE2',init}),factory=factoryCode(init,{kind:'CREATE2',value:5});
  const inspector='0x73'+victim.slice(2)+'3160005273'+victim.slice(2)+'3b60205273'+victim.slice(2)+'3f60405260606000f3';
  const f=await feeFixture({fork,baseFee:0n,maxFee:0n,priorityFee:0n,to:victim,accounts:{
    [FACTORY]:{nonce:7n,balance:1000n,code:factory},
    [victim]:{nonce:3n,balance:17n,code:'0x'+selfdestructCode,storage:{[word(0)]:29n,[word(OLD_SLOT)]:99n,[word(UNREAD_SLOT)]:777n}},
    [FUNDER]:{nonce:1n,balance:50n,code:'0x'+callCode(victim,7)+'50'+(ancestorReverts?'60006000fd':'00')},
    [INSPECTOR]:{nonce:1n,balance:0n,code:inspector},
  }});
  return {...f,victim,init,runtime:'0x'+RECREATED_RUNTIME};
}
export async function resetReference(f){
  const ref=await feeFullVM(f),history=[];
  return{...ref,history,async run(input=request(f,f.victim)){
    // Unpriced getter counterparts use a signed type-2 transaction with both
    // caps zero against this same zero-base-fee header, without skip flags.
    if(input.fees===undefined)assert.equal(BigInt(f.header.baseFeePerGas),0n);
    const {tx,result}=await ref.run(input.fees===undefined?{...input,fees:{maxFeePerGas:'0',maxPriorityFeePerGas:'0'}}:input),error=result.execResult.exceptionError?.error??null;
    const row={request:structuredClone(input),signedTransaction:bytesToHex(tx.serialize()),nonce:tx.nonce.toString(),result,stateRoot:bytesToHex(await ref.state.getStateRoot()),status:error==='revert'?'reverted':error?'failed':'success',error,returnData:bytesToHex(result.execResult.returnValue)};
    history.push(row);return row;
  }};
}
export function expectedAllocation(f,{transactions=0,deleted=false,funding=0n,fromFunder=false,deployments=0,creationAttempts=deployments,beneficiary=deleted?17n:0n,created=false}={}){
  const allocation=structuredClone(f.allocation);
  allocation[TX_SENDER].nonce=quantity(BigInt(allocation[TX_SENDER].nonce)+BigInt(transactions));
  if(funding&&!fromFunder)allocation[TX_SENDER].balance=quantity(BigInt(allocation[TX_SENDER].balance)-funding);
  if(funding&&fromFunder)allocation[FUNDER].balance=quantity(BigInt(allocation[FUNDER].balance)-funding);
  allocation[FACTORY].nonce=quantity(7n+BigInt(creationAttempts));allocation[FACTORY].balance=quantity(1000n-BigInt(deployments)*5n);
  if(deleted)delete allocation[f.victim];
  if(funding||created)allocation[f.victim]={nonce:created?'0x1':'0x0',balance:quantity(funding+(created?5n:0n)),code:created?f.runtime:'0x',storage:created?{[word(0)]:'0x2a'}:{}};
  if(beneficiary)allocation[BENEFICIARY]={nonce:'0x0',balance:quantity(beneficiary),code:'0x',storage:{}};
  return allocation;
}
export async function assertFullPoststate(f,ref,expected){
  const manual=await loadState(expected,feeCommon(f)),root=bytesToHex(await manual.getStateRoot());
  assert.equal(bytesToHex(await ref.state.getStateRoot()),root,'Entire full-VM poststate must equal the independently specified allocation');
  // Inspect the actual committed trie through a fresh read-only view. The
  // pinned library's deleteAccount leaves an address-keyed _storageTries cache
  // on the execution manager: after simple funding it can report old values
  // despite the correct empty storageRoot. Do not modify that execution
  // manager or substitute expected-state facts into the running reference.
  const view=ref.state.shallowCopy();assert.equal(bytesToHex(await view.getStateRoot()),root);
  for(const address of new Set([...Object.keys(f.allocation),...Object.keys(expected),BENEFICIARY,COINBASE])){
    const a=await account(view,address),e=expected[address];assert.equal(a!==undefined,e!==undefined,address+' existence');
    if(e){assert.equal(a.nonce,BigInt(e.nonce),address+' nonce');assert.equal(a.balance,BigInt(e.balance),address+' balance');assert.equal(await code(view,address),e.code,address+' code');}
    for(const slot of [0,1,OLD_SLOT,UNREAD_SLOT,993])assert.equal(await storage(view,address,slot),BigInt(e?.storage?.[word(slot)]??0),address+' storage '+slot);
  }
  return root;
}

/** Apply only product delta rows to a third full MPT. Reset rows erase the
 * entire old namespace before applying final values; they never enumerate or
 * import the independent reference's poststate. */
export async function appliedResetRoot(f,changes){
  const state=await loadState(f.allocation,feeCommon(f));
  for(const row of changes.accounts){
    const address=createAddressFromString(row.address),before=await state.getAccount(address),beforeCode=bytesToHex(await state.getCode(address));
    if(row.existence)assert.equal(before!==undefined,row.existence.before);
    for(const field of ['nonce','balance'])if(row[field])assert.equal(before?.[field]??0n,BigInt(row[field].before));
    if(row.code)assert.equal(beforeCode,row.code.before);
    if(row.reset){
      assert(before);assert.equal(row.existence,undefined);assert(['shanghai_selfdestruct_deletion','same_invocation_created_contract_deletion','eip161_empty_account_cleanup'].includes(row.reset.basis));
      assert.equal(row.reset.initialStorageRoot,bytesToHex(before.storageRoot));
      await state.deleteAccount(address);
      // Drop only the third-MPT library's stale trie view. This is an explicit
      // whole-account reset represented by row.reset, not an expected result.
      await state.setStateRoot(await state.getStateRoot());
      await state.putAccount(address,createAccount({nonce:BigInt(row.nonce?.after??before.nonce),balance:BigInt(row.balance?.after??before.balance)}));
      await state.putCode(address,bytes(row.code?.after??beforeCode));
      for(const item of row.storage??[]){assert.equal(item.before,word(0));assert(BigInt(item.after)>0n);await state.putStorage(address,bytes(item.slot),bigIntToBytes(BigInt(item.after)));}
      continue;
    }
    for(const item of row.storage??[])assert.equal(await storage(state,row.address,BigInt(item.slot)),BigInt(item.before));
    if(row.existence?.after===false){await state.deleteAccount(address);continue;}
    if(!before)await state.putAccount(address,createAccount({nonce:0n,balance:0n}));
    for(const field of ['nonce','balance'])if(row[field])await state.modifyAccountFields(address,{[field]:BigInt(row[field].after)});
    if(row.code)await state.putCode(address,bytes(row.code.after));
    for(const item of row.storage??[])await state.putStorage(address,bytes(item.slot),bigIntToBytes(BigInt(item.after)));
  }
  return bytesToHex(await state.getStateRoot());
}
