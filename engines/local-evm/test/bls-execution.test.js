import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeUnsignedCall } from '../execute.js';
import { ethereumCallGas, ethereumCommon } from '../ethereum-profile.js';
import { feeFixture, compareFeeFullVM, account, balance, slot, TX_SENDER, TARGET, COINBASE, word } from './fee-fixture.js';
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const execute=(f,extra={})=>executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,...extra});
async function fixture({fork='osaka',to=address(11),data='0x'+'00'.repeat(256),value='0',code='0x00',accounts={},priced=false,...rest}={}) {
  const f=await feeFixture({fork,to,data,value,baseFee:priced?7n:0n,maxFee:priced?13n:0n,priorityFee:priced?3n:0n,
    target:{nonce:1n,balance:100n,code},accounts:{[COINBASE]:{nonce:1n,balance:1n,code:'0x'},...accounts},...rest});
  if(!priced){delete f.request.executionProfile;delete f.request.fees;}return f;
}
function caller({kind='CALL',gas=375,value=0,tail='60805260a06000f3',prefix='602a600055'}={}) {
  const op={CALL:'f1',STATICCALL:'fa',CALLCODE:'f2',DELEGATECALL:'f4'}[kind];
  return '0x'+prefix+'36600060003760806000366000'+(['CALL','CALLCODE'].includes(kind)?'60'+value.toString(16).padStart(2,'0'):'')+
    '600b62'+gas.toString(16).padStart(6,'0')+op+tail;
}
test('all seven BLS precompiles execute at their actual addresses after activation',async()=>{
  for(const fork of ['prague','osaka'])for(const [to,length,gas,width] of [[11,256,375,128],[12,160,12000,128],[13,512,600,256],[14,288,22500,256],
    [15,384,70300,32],[16,64,5500,128],[17,128,23800,256]]){
    const f=await fixture({fork,to:address(to),data:'0x'+'00'.repeat(length)}),o=await execute(f);
    assert.equal(o.execution.status,'success',`${fork}/${to}`);assert.equal(o.execution.executionGasUsed,String(gas));
    assert.equal(o.execution.returnData.length,2+width*2);assert.equal(o.trace.to,address(to));
    if(to===15)assert.equal(o.execution.returnData,word(1));
    if(to<15)assert.equal(o.execution.returnData,'0x'+'00'.repeat(width));
    // Shared Noble arithmetic, but separate stock decoder, signed transaction
    // finalization and full MPT paths. This is not independent-client evidence.
    const priced=await fixture({fork,to:address(to),data:f.request.data,priced:true});await compareFeeFullVM(priced,await execute(priced));
  }
});
test('BLS message gas boundary and transaction calldata floor are distinct',async()=>{
  for(const gas of [374n,375n]){
    const f=await fixture();f.request.gas=String(ethereumCallGas(f.request.data,ethereumCommon(f.header),f.request).intrinsic+gas);
    const rejected=await execute(f);assert.equal(rejected.execution.status,'invalid','The complete transaction is below the Prague calldata floor');
    const {gas:declared,...request}=f.request;
    const o=await executeUnsignedCall({request:{...request,gasLimit:String(gas)},block:f.header,stateManager:f.stateManager,chainId:1});
    assert.equal(o.execution.status,gas===375n?'success':'failed');assert.equal(o.execution.executionGasUsed,String(gas));
    assert.equal(o.stateDisposition,'message_result_retained_in_supplied_manager');
  }
});
test('malformed BLS input preserves EVM failure semantics and rolls back transferred value',async()=>{
  const f=await fixture({data:'0x',value:'19'}),o=await execute(f);
  assert.equal(o.execution.status,'failed');assert.equal(await balance(f.stateManager,address(11)),0n);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
});
test('nested BLS calls retain correct value, execution context and enclosing rollback',async()=>{
  for(const kind of ['CALL','STATICCALL','CALLCODE','DELEGATECALL'])for(const revert of [false,true]){
    const f=await fixture({to:TARGET,value:'19',priced:true,code:caller({kind,value:5,tail:revert?'5060016000a060006000fd':undefined})}),o=await execute(f);
    assert.equal(o.execution.status,revert?'reverted':'success');assert.equal(o.trace.calls[0].error,null);assert.equal(o.trace.calls[0].output,'0x'+'00'.repeat(128));
    assert.equal(o.trace.calls[0].executionAddress,['CALLCODE','DELEGATECALL'].includes(kind)?TARGET:address(11));
    assert.equal(await balance(f.stateManager,address(11)),!revert&&kind==='CALL'?5n:0n);
    assert.equal(await slot(f.stateManager,TARGET,0),revert?0n:42n);assert.deepEqual(o.logs,[]);await compareFeeFullVM(f,o);
  }
});
test('caught invalid BLS input retains valid parent work rather than becoming host failure',async()=>{
  const f=await fixture({to:TARGET,data:'0x',priced:true,code:caller()}),o=await execute(f);
  assert.equal(o.execution.status,'success');assert.notEqual(o.trace.calls[0].error,null);assert.equal(await slot(f.stateManager,TARGET,0),42n);
  assert.equal(BigInt('0x'+o.execution.returnData.slice(-64)),0n);await compareFeeFullVM(f,o);
});
test('BLS addresses retain ordinary account behavior before Prague',async()=>{
  for(const n of [11,12,13,14,15,16,17]){
    const f=await fixture({fork:'cancun',to:address(n),data:'0x',value:'7',accounts:{[address(n)]:{nonce:1n,code:'0x602a60005500'}},priced:true}),o=await execute(f);
    assert.equal(o.execution.status,'success');assert.equal(await slot(f.stateManager,address(n),0),42n);assert.equal(await balance(f.stateManager,address(n)),7n);await compareFeeFullVM(f,o);
  }
});
test('BLS host and deadline failures cannot be caught by CALL or retain fees, nonce, value or storage',async()=>{
  for(const phase of [1,2])for(const kind of ['deadline','error','null','undefined']){
    const f=await fixture({to:TARGET,value:'19',priced:true,code:caller({value:5})});
    let checks=0,time=0,fired=false;const now=()=>{
      if(new Error().stack.includes('bls-runtime.js')&&++checks===phase){fired=true;if(kind==='deadline')time=120000;else if(kind==='error')throw Error('private host marker');else if(kind==='null')throw null;else throw undefined;}return time;
    };
    const o=await execute(f,{now});assert(fired);assert.equal(checks,phase);assert.equal(o.execution.status,'unavailable');
    assert.equal(o.execution.error.code,kind==='deadline'?'LOCAL_RESOURCE_LIMIT':'LOCAL_EXECUTION_FAILED');assert.equal(o.stateDisposition,'rolled_back');
    assert.equal(o.profile.feesSettled,false);assert.equal(o.feeAccounting,undefined);assert.deepEqual(o.logs,[]);assert.equal(JSON.stringify(o).includes('private host marker'),false);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,1n);
  }
});
