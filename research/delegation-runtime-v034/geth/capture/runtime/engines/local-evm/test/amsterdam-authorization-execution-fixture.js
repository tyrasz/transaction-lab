// Authenticated synthetic initial allocations. Signed type-4 references share
// EthereumJS; known client-divergent cases are explicitly compared as such.
import assert from 'node:assert/strict';
import {bytesToHex,createAddressFromString} from '@ethereumjs/util';
import {createBlock} from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import {createTx} from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {createVM,runTx} from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import {loadState} from '../../fixture-evm/state-test.js';
import {amsterdamExecutionFixture} from './amsterdam-execution-fixture.js';
import {TEST_KEY,AUTH_KEY,TX_SENDER,AUTHORITY,DELEGATE,SECOND_DELEGATE,TARGET,ZERO,MAX_NONCE,RETURN42,RETURN7,REVERT,
  bytes,word,qty,account,code,slot,designation,signAuthorization,query,appliedRoot} from './authorization-fixture.js';
import {integer} from './proof-fixture.js';
export {TEST_KEY,AUTH_KEY,TX_SENDER,AUTHORITY,DELEGATE,SECOND_DELEGATE,TARGET,ZERO,MAX_NONCE,RETURN42,RETURN7,REVERT,
  bytes,word,qty,account,code,slot,designation,query,appliedRoot};
export {COINBASE} from './fee-fixture.js';
export {initcode,factoryCode,createdAddress} from './lifecycle-fixture.js';
export {callBytes} from './amsterdam-creation-attempts-fixture.js';
export const CHAIN=11155111n,FUNDS=1000000000000n,GETTER='0x'+'88'.repeat(20),HELPER='0x'+'aa'.repeat(20);
export const authorization=extra=>signAuthorization({chainId:CHAIN,...extra});
export const native=account=>({kind:'native_balance',account});
export async function amsterdamAuthorizationExecutionFixture({authority={nonce:0n,balance:7n,code:'0x'},delegateCode='0x'+RETURN42,secondDelegateCode='0x'+RETURN7,
  targetCode='0x00',authorizationList=[authorization()],accounts={},...options}={}){
  return amsterdamExecutionFixture({...options,target:{nonce:1n,code:targetCode},authorizationList,accounts:{
    [DELEGATE]:{nonce:1n,balance:9n,code:delegateCode},[SECOND_DELEGATE]:{nonce:1n,balance:11n,code:secondDelegateCode},
    ...(authority===null?{}:{[AUTHORITY]:authority}),...accounts,
  }});
}
export function signedAuthorizationTransaction(f,request=f.request,{nonce=1n}={}){
  const list=request.authorizationList;
  const tx=createTx({type:list?4:2,chainId:CHAIN,nonce,gasLimit:BigInt(request.gas),to:request.to,value:BigInt(request.value),data:request.data,
    maxFeePerGas:BigInt(request.fees?.maxFeePerGas??0),maxPriorityFeePerGas:BigInt(request.fees?.maxPriorityFeePerGas??0),
    ...(request.accessList?{accessList:request.accessList}:{}),...(list?{authorizationList:list.map(t=>['chainId','address','nonce','yParity','r','s'].map(k=>k==='address'?bytes(t[k]):integer(BigInt(t[k]))))}:{})},
    {common:f.common}).sign(bytes(TEST_KEY));
  assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),request.from);return tx;
}
export async function authorizationFullVM(f,{request=f.request,state,queryContext=false}={}){
  const current=state?state.shallowCopy():await loadState(f.allocation,f.common);
  if(!state)assert.equal(bytesToHex(await current.getStateRoot()),f.header.stateRoot);
  const block=queryContext?createBlock({header:{...f.block.header.toJSON(),baseFeePerGas:0n},withdrawals:[]},{common:f.common}):f.block;
  const sender=await current.getAccount(createAddressFromString(request.from));
  const tx=signedAuthorizationTransaction(f,request,{nonce:sender.nonce});
  const vm=await createVM({common:f.common,stateManager:current,blockchain:{async getBlock(){throw Error('No synthetic ancestry supplied');},shallowCopy(){return this;}}});
  let rootEntry=null;
  const runCall=vm.evm.runCall.bind(vm.evm);vm.evm.runCall=async opts=>{if(opts.message===undefined){assert.equal(rootEntry,null);rootEntry={gasLimit:opts.gasLimit,stateGas:vm.evm.executionStateGasUsed,reservoir:vm.evm.stateGasReservoir};}return runCall(opts);};
  const result=await runTx(vm,{tx,block});return{state:current,tx,result,rootEntry,prepOog:vm.evm.eip2780PrepOog===true,stateRoot:bytesToHex(await current.getStateRoot())};
}
export async function compareAuthorizationFullVM(f,output,changes,{preparationHalt=false}={}){
  const ref=await authorizationFullVM(f),r=ref.result,error=r.execResult.exceptionError?.error;
  assert.equal(output.execution.status,error==='revert'?'reverted':error?'failed':'success');assert.equal(output.execution.returnData,bytesToHex(r.execResult.returnValue));
  assert.equal(output.gasAccounting.gasUsed,r.totalGasSpent.toString());assert.equal(output.execution.gasRefundCounter,(r.execResult.gasRefund??0n).toString());
  assert.equal(output.stateGasAccounting.settled.regularGasUsed,r.txRegularGas.toString());assert.equal(output.stateGasAccounting.settled.stateGasUsed,r.txStateGas.toString());
  assert.deepEqual(output.logs,(r.execResult.logs??[]).map(([address,topics,data])=>({address:bytesToHex(address),topics:topics.map(bytesToHex),data:bytesToHex(data)})));
  // Failed preparation can partition consumed regular gas differently between
  // no-message output and runTx's synthetic execResult. Receipt/dimensions/root
  // remain exact checks; entered messages must also match their raw gas.
  if(!preparationHalt)assert.equal(output.execution.executionGasUsed,r.execResult.executionGasUsed.toString());
  assert.equal(await appliedRoot(f,changes,f.common),ref.stateRoot);return ref;
}
export async function expectedAllocationRoot(allocation,common){return bytesToHex(await(await loadState(allocation,common)).getStateRoot());}
// Only the explicitly declared simple STOP case uses this expected allocation.
// It independently applies authorized nonce/code, outer nonce and gas-price
// arithmetic; no production settlement helper or observed delta supplies it.
export async function expectedAuthorizationStop(f,{paidGas,authorityNonce=1n,authorityCode=designation(DELEGATE),retained=true}={}){
  const a=structuredClone(f.allocation),sender=a[TX_SENDER],base=BigInt(f.header.baseFeePerGas),fees=f.request.fees;
  const effective=fees?(BigInt(fees.maxFeePerGas)<base+BigInt(fees.maxPriorityFeePerGas)?BigInt(fees.maxFeePerGas):base+BigInt(fees.maxPriorityFeePerGas)):0n;
  sender.nonce=qty(BigInt(sender.nonce)+1n);sender.balance=qty(BigInt(sender.balance)-paidGas*effective);
  if(retained){const authority=a[AUTHORITY]??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};authority.nonce=qty(authorityNonce);authority.code=authorityCode;a[AUTHORITY]=authority;}
  if(effective>base){const key=f.header.miner,miner=a[key]??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};miner.balance=qty(BigInt(miner.balance)+paidGas*(effective-base));a[key]=miner;}
  return{allocation:a,stateRoot:await expectedAllocationRoot(a,f.common)};
}
