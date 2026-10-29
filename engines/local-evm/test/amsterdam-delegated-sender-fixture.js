// Synthetic authenticated initial state with an existing exact delegation.
// No authorization list, real keys, RPC, or predicted poststate is supplied.
import assert from 'node:assert/strict';
import {bytesToHex,createAddressFromString} from '@ethereumjs/util';
import {createBlock} from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import {createTx} from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {createVM,runTx} from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import {loadState} from '../../fixture-evm/state-test.js';
import {amsterdamExecutionFixture,compareAmsterdamFullVM,TX_SENDER,TARGET,account,code,slot,word} from './amsterdam-execution-fixture.js';
import {TEST_KEY,bytes,appliedRoot,compareExecution} from './authorization-fixture.js';
export {compareAmsterdamFullVM,TX_SENDER,TARGET,account,code,slot,word};
export {initcode,factoryCode,createdAddress} from './lifecycle-fixture.js';
export {HELPER,callBytes,reentrantCreation} from './amsterdam-creation-attempts-fixture.js';
export {COINBASE} from './fee-fixture.js';
export const DELEGATE='0x'+'77'.repeat(20),RECIPIENT='0x'+'55'.repeat(20),ABSENT='0x'+'aa'.repeat(20),GETTER='0x'+'88'.repeat(20);
export const DESIGNATION='0xef0100'+DELEGATE.slice(2),RETURN42='602a60005260206000f3',REVERT='60006000fd';
export const native=account=>({kind:'native_balance',account});
export const scalarQuery=to=>({to,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});
export async function amsterdamDelegatedSenderFixture({delegateCode='0x00',senderCode=DESIGNATION,sender={},accounts={},to=TX_SENDER,priced=true,...options}={}){
  assert.equal(options.authorizationList,undefined,'This fixture is existing-delegation only');
  const f=await amsterdamExecutionFixture({...options,priced,to,sender:{nonce:1n,balance:1000000000000n,code:senderCode,...sender},accounts:{
    [DELEGATE]:{nonce:1n,balance:9n,code:delegateCode},[RECIPIENT]:{nonce:1n,balance:3n,code:'0x'},[GETTER]:{nonce:1n,code:'0x'+RETURN42},...accounts,
  }});
  assert.equal(f.common.hardfork(),'amsterdam');assert.equal(f.request.authorizationList,undefined);return f;
}
export function assertDelegated(output){
  assert.deepEqual(output.semantics.senderDelegation,{address:DELEGATE,authorizationListProcessed:false});
  assert.equal(output.semantics.callerNonce,'runCall_increment_and_committed_sender_creation_attempts');
  assert.equal(output.authorizationProcessing,undefined);
}
// A fresh unsigned query has zero price/basefee and a synthetic outer nonce.
// These signed full-VM counterparts reproduce that declared query context;
// they do not claim an includable transaction at the original priced header.
export async function compareDelegatedQuery(f,side,query,{state}={}){
  const current=state?state.shallowCopy():await loadState(f.allocation,f.common);
  const block=createBlock({header:{...f.block.header.toJSON(),baseFeePerGas:0n},withdrawals:[]},{common:f.common});
  const sender=await current.getAccount(createAddressFromString(TX_SENDER));
  const tx=createTx({type:2,chainId:11155111n,nonce:sender.nonce,gasLimit:1000000n,to:query.to,value:0n,data:query.data,maxFeePerGas:0n,maxPriorityFeePerGas:0n},{common:f.common}).sign(bytes(TEST_KEY));
  assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),TX_SENDER);
  const vm=await createVM({common:f.common,stateManager:current,blockchain:{async getBlock(){throw Error('No ancestry supplied by synthetic fixture');},shallowCopy(){return this;}}});
  const result=await runTx(vm,{tx,block});compareExecution(side.output,result);
  assert.equal(side.output.stateGasAccounting.settled.regularGasUsed,result.txRegularGas.toString());assert.equal(side.output.stateGasAccounting.settled.stateGasUsed,result.txStateGas.toString());
  assert.equal(await appliedRoot(f,side.changesAfter,f.common),bytesToHex(await current.getStateRoot()));
  return{state:current,result,tx};
}
