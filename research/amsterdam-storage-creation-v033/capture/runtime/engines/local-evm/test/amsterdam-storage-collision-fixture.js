// Initial-only authenticated synthetic accounts. Storage-only collision is the
// pinned EthereumJS/EIP-7610 behavior under investigation, not a pinned-Geth
// compatibility claim: that client's nonce/code predicate differs.
import assert from 'node:assert/strict';
import {bytesToHex,createAddressFromString} from '@ethereumjs/util';
import {createBlock} from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import {createTx} from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {createVM,runTx} from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import {loadState} from '../../fixture-evm/state-test.js';
import {integer} from './proof-fixture.js';
import {amsterdamExecutionFixture,compareAmsterdamFullVM,TX_SENDER,TARGET,COINBASE,account,code,slot,word,bytes,appliedRoot} from './amsterdam-execution-fixture.js';
import {TEST_KEY,designation,signAuthorization,compareExecution} from './authorization-fixture.js';
import {initcode,factoryCode,createdAddress} from './lifecycle-fixture.js';
import {callBytes} from './amsterdam-creation-attempts-fixture.js';
export {amsterdamExecutionFixture,compareAmsterdamFullVM,TX_SENDER,TARGET,COINBASE,account,code,slot,word,bytes,appliedRoot,TEST_KEY,designation,initcode,factoryCode,createdAddress,callBytes};
export const HELPER='0x'+'66'.repeat(20),DELEGATE='0x'+'77'.repeat(20),GETTER='0x'+'88'.repeat(20);
export const EMPTY_CODE_HASH='0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
export const EMPTY_STORAGE_ROOT='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
export const RETURN42='602a60005260206000f3',REVERT='60006000fd';
export const HIDDEN_STORAGE=Object.freeze({[word(0)]:999n,[word(991)]:123456n});
// Source-discrepancy probe: deployment preserves or clears old slot991 before
// this constructor copies it to slot1 and sets fresh slot2. EJS instead rejects
// the deployment entirely. No expected result is fed to either execution path.
export const STORAGE_SENTINEL_RUNTIME='6001546000526002546020526103df5460405260606000f3';
export const STORAGE_SENTINEL_INIT=initcode(STORAGE_SENTINEL_RUNTIME,'6103df54600155602a600255');
export const q=n=>'0x'+BigInt(n).toString(16),native=account=>({kind:'native_balance',account});
export const scalar=to=>({to,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});
export const selfAuthorization=()=>signAuthorization({key:TEST_KEY,chainId:11155111n,nonce:2n,address:DELEGATE});
export const storageOnlyAccount=(balance=17n)=>({nonce:0n,balance,code:'0x',storage:{...HIDDEN_STORAGE}});
export async function initialStorageRoot(f,address){
 const state=await loadState(f.allocation,f.common),a=await state.getAccount(createAddressFromString(address));
 assert(a);return bytesToHex(a.storageRoot);
}
export async function amsterdamStorageCollisionFixture({kind='CREATE2',priced=true,collision='storage',collisionBalance=17n,nonce=7n,value=5,
 init=initcode('00',''),tail='80600052602a60015560206000f3',repeat=1,creator=TARGET,body,accounts={},...options}={}){
 const address=createdAddress({creator,nonce,kind,init}),factory=body??factoryCode(init,{kind,value,repeat,tail});
 const target=collision==='absent'?null:collision==='empty'?{nonce:0n,balance:collisionBalance,code:'0x',storage:{}}:storageOnlyAccount(collisionBalance);
 const f=await amsterdamExecutionFixture({priced,...options,target:{nonce,balance:1000n,code:creator===TARGET?factory:'0x00',storage:{[word(1)]:5n}},accounts:{
  ...(creator===TARGET?{}:{[creator]:{nonce,balance:1000n,code:factory,storage:{[word(1)]:5n}}}),...(target?{[address]:target}:{}),...accounts}});
 return{...f,collisionAddress:address,creator,kind,init,collision,collisionStorageRoot:target?await initialStorageRoot(f,address):EMPTY_STORAGE_ROOT};
}
// Input-only alternatives for a separately authorized client diagnostic. These
// helpers construct proofs/MPT/header/signable requests but execute no EVM.
export const STORAGE_DIAGNOSTIC_CASES=Object.freeze([
 Object.freeze({id:'root_create_storage_only',rootCreate:true,collision:'storage'}),
 Object.freeze({id:'internal_create2_storage_only',rootCreate:false,collision:'storage'}),
 Object.freeze({id:'root_create_absent',rootCreate:true,collision:'absent'}),
 Object.freeze({id:'internal_create2_absent',rootCreate:false,collision:'absent'}),
 Object.freeze({id:'root_create_empty_storage',rootCreate:true,collision:'empty'}),
 Object.freeze({id:'internal_create2_empty_storage',rootCreate:false,collision:'empty'}),
]);
export async function storageCollisionDiagnosticFixture({rootCreate=false,priced=true,collision='storage',accounts={}}={}){
 assert(['storage','absent','empty'].includes(collision));
 if(!rootCreate)return amsterdamStorageCollisionFixture({priced,collision,accounts,kind:'CREATE2',init:STORAGE_SENTINEL_INIT,tail:'60005260206000f3'});
 const address=createdAddress({creator:TX_SENDER,nonce:1n,init:STORAGE_SENTINEL_INIT});
 const target=collision==='absent'?null:collision==='storage'?storageOnlyAccount():{nonce:0n,balance:17n,code:'0x',storage:{}};
 const f=await amsterdamExecutionFixture({priced,to:null,data:'0x'+STORAGE_SENTINEL_INIT,value:'5',accounts:{...(target?{[address]:target}:{}),...accounts}});
 return{...f,collisionAddress:address,creator:TX_SENDER,kind:'CREATE',init:STORAGE_SENTINEL_INIT,collision,collisionStorageRoot:target?await initialStorageRoot(f,address):EMPTY_STORAGE_ROOT};
}
// Fixed expected non-creation writes, with fee balances independently derived
// from the request and observed scalar gas (which the signed reference checks).
// The unchanged hidden target storage is included in the full expected trie.
export async function expectedCollisionRoot(f,output,{extraNonces={},storageWrites={},codeWrites={}}={}){
 const a=structuredClone(f.allocation),sender=a[TX_SENDER],base=BigInt(f.header.baseFeePerGas),fees=f.request.fees;
 const effective=fees?(BigInt(fees.maxFeePerGas)<base+BigInt(fees.maxPriorityFeePerGas)?BigInt(fees.maxFeePerGas):base+BigInt(fees.maxPriorityFeePerGas)):0n;
 const paid=BigInt(output.gasAccounting.gasUsed),tip=effective>base?effective-base:0n;
 sender.nonce=q(BigInt(sender.nonce)+1n);sender.balance=q(BigInt(sender.balance)-paid*effective);
 for(const[address,n]of Object.entries(extraNonces))a[address].nonce=q(BigInt(a[address].nonce)+BigInt(n));
 for(const[address,values]of Object.entries(storageWrites))for(const[key,value]of Object.entries(values))a[address].storage[word(key)]=q(value);
 for(const[address,value]of Object.entries(codeWrites))a[address].code=value;
 if(tip){const miner=a[f.header.miner]??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};miner.balance=q(BigInt(miner.balance)+paid*tip);a[f.header.miner]=miner;}
 return{allocation:a,root:bytesToHex(await(await loadState(a,f.common)).getStateRoot())};
}
// Signed type2/type4 wrapper observation shares EthereumJS execution/crypto.
// No independent-client claim; all initial state comes from f.allocation.
export async function storageCollisionFullVM(f,{request=f.request,state,queryContext=false}={}){
 const current=state?state.shallowCopy():await loadState(f.allocation,f.common);
 if(!state)assert.equal(bytesToHex(await current.getStateRoot()),f.header.stateRoot);
 const block=queryContext?createBlock({header:{...f.block.header.toJSON(),baseFeePerGas:0n},withdrawals:[]},{common:f.common}):f.block;
 const sender=await account(current,request.from),list=request.authorizationList;
 const tx=createTx({type:list?4:2,chainId:11155111n,nonce:sender.nonce,gasLimit:BigInt(request.gas),to:request.to??undefined,value:BigInt(request.value),data:request.data,
  maxFeePerGas:BigInt(request.fees?.maxFeePerGas??0),maxPriorityFeePerGas:BigInt(request.fees?.maxPriorityFeePerGas??0),...(request.accessList?{accessList:request.accessList}:{}),
  ...(list?{authorizationList:list.map(t=>['chainId','address','nonce','yParity','r','s'].map(k=>k==='address'?bytes(t[k]):integer(BigInt(t[k]))))}:{})},{common:f.common}).sign(bytes(TEST_KEY));
 assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),request.from);
 const vm=await createVM({common:f.common,stateManager:current,blockchain:{async getBlock(){throw Error('No synthetic ancestry supplied');},shallowCopy(){return this;}}});
 const result=await runTx(vm,{tx,block});return{state:current,tx,result,root:bytesToHex(await current.getStateRoot())};
}
export async function compareStorageCollisionFullVM(f,output,changes,options){
 const ref=await storageCollisionFullVM(f,options);compareExecution(output,ref.result);
 assert.equal(output.stateGasAccounting.settled.regularGasUsed,ref.result.txRegularGas.toString());
 assert.equal(output.stateGasAccounting.settled.stateGasUsed,ref.result.txStateGas.toString());
 assert.equal(await appliedRoot(f,changes,f.common),ref.root);return ref;
}
