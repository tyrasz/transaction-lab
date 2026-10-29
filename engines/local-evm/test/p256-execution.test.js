import test from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/nist.js';
import { createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { ethereumCallGas, ethereumCommon } from '../ethereum-profile.js';
import { P256_ADDRESS } from '../p256-runtime.js';
import { blobFeeFixture, TX_SENDER, TARGET, COINBASE, account, balance, word } from './blob-fee-fixture.js';
import { slot } from './fee-fixture.js';
const key=Uint8Array.from(Buffer.from(word(7n).slice(2),'hex')),hash=Uint8Array.from(Buffer.from(word(42n).slice(2),'hex'));
const sig=p256.sign(hash,key,{lowS:false,prehash:false}),pub=p256.getPublicKey(key,false);
const INPUT='0x'+Buffer.from(Uint8Array.from([...hash,...sig,...pub.subarray(1)])).toString('hex'),OUTPUT=word(1),INVALID=word(43)+INPUT.slice(66);
const bytes=(n,size)=>n.toString(16).padStart(size*2,'0');
function caller({kind='STATICCALL',gas=6900,value=0,prefix='',tail='6020523d60405260606000f3',embedded}={}){
  const op={CALL:'f1',CALLCODE:'f2',DELEGATECALL:'f4',STATICCALL:'fa'}[kind],size=embedded===undefined?'36':'6100a0';assert(op);
  const invoke='60206000'+size+'6000'+(['CALL','CALLCODE'].includes(kind)?'60'+bytes(value,1):'')+'61010062'+bytes(gas,3)+op+tail;
  if(embedded===undefined)return '0x'+prefix+'366000600037'+invoke;
  return '0x'+prefix+size+'61'+bytes(prefix.length/2+9+invoke.length/2,2)+'600039'+invoke+embedded.slice(2);
}
async function fixture({fork='osaka',priced=false,to=P256_ADDRESS,data=INPUT,gas='200000',value='0',code='0x00',accounts={}}={}){
  const f=await blobFeeFixture({fork,profile:'unsigned_eip1559_block_end',to,data,gas,value,baseFee:priced?7n:0n,maxFee:priced?13n:0n,priorityFee:priced?3n:0n,
    target:{nonce:1n,balance:100n,code},accounts:{[COINBASE]:{nonce:1n,balance:1n,code:'0x'},...accounts}});
  if(!priced){delete f.request.executionProfile;delete f.request.fees;}return f;
}
const execute=(f,extra={})=>executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,...extra});

test('P256 direct valid/invalid signatures complete on Osaka/BPO1/BPO2 with fixed6900 message gas',async()=>{
  for(const fork of ['osaka','bpo1','bpo2'])for(const data of [INPUT,INVALID,'0x']){
    const f=await fixture({fork,priced:true,data,value:'19'}),o=await execute(f);
    assert.equal(o.execution.status,'success',`${fork}/${data}`);assert.equal(o.execution.executionGasUsed,'6900');assert.equal(o.execution.returnData,data===INPUT?OUTPUT:'0x');
    assert.equal(await balance(f.stateManager,P256_ADDRESS),19n,'Invalid signatures do not revert CALL value');assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
    assert.equal(await balance(f.stateManager,TX_SENDER),1000000000000n-19n-BigInt(o.feeAccounting.gasCharge));
  }
});

test('P256 has exact6899/6900 gas boundary; OOG rolls back value while retaining ordinary transaction fees',async()=>{
  for(const gas of [6899n,6900n]){
    const f=await fixture({priced:true,value:'19'});f.request.gas=String(ethereumCallGas(INPUT,ethereumCommon(f.header),f.request).intrinsic+gas);
    const o=await execute(f);assert.equal(o.execution.status,gas===6900n?'success':'failed');assert.equal(o.execution.executionGasUsed,String(gas));assert.equal(o.execution.returnData,gas===6900n?OUTPUT:'0x');
    if(gas===6899n)assert.equal(o.execution.error,'out of gas');assert.equal(await balance(f.stateManager,P256_ADDRESS),gas===6900n?19n:0n);assert.equal(o.profile.feesSettled,true);
  }
});

test('P256 all nested call modes preserve output/flag/return-size; invalid is successful empty return and OOG is caught failure',async()=>{
  for(const kind of ['CALL','CALLCODE','DELEGATECALL','STATICCALL'])for(const mode of ['valid','invalid','oog']){
    const data=mode==='invalid'?INVALID:INPUT,f=await fixture({to:TARGET,data,code:caller({kind,gas:mode==='oog'?6899:6900,prefix:'602a600355'})}),o=await execute(f),child=o.trace.calls[0];
    assert.equal(o.execution.status,'success');assert.equal(await slot(f.stateManager,TARGET,3),42n);assert.equal(child.type,kind);assert.equal(child.to,P256_ADDRESS);
    assert.equal(child.executionAddress,['CALLCODE','DELEGATECALL'].includes(kind)?TARGET:P256_ADDRESS);
    assert.equal(o.execution.returnData,(mode==='valid'?OUTPUT:data.slice(0,66))+word(mode==='oog'?0:1).slice(2)+word(mode==='valid'?32:0).slice(2));
    assert.equal(child.error,mode==='oog'?'out of gas':null);
  }
});

test('enclosing REVERT removes successful P256 value and storage while preserving fees',async()=>{
  const f=await fixture({priced:true,to:TARGET,value:'19',code:caller({kind:'CALL',value:5,prefix:'602a600355',tail:'5060006000fd'})}),o=await execute(f);
  assert.equal(o.execution.status,'reverted');assert.equal(o.trace.calls[0].error,null);assert.equal(o.trace.calls[0].output,OUTPUT);assert.equal(await balance(f.stateManager,P256_ADDRESS),0n);assert.equal(await balance(f.stateManager,TARGET),100n);assert.equal(await slot(f.stateManager,TARGET,3),0n);assert.equal(o.profile.feesSettled,true);
});

test('Prague address0x100 remains ordinary account code rather than an early P256 precompile',async()=>{
  const f=await fixture({fork:'prague',accounts:{[P256_ADDRESS]:{nonce:1n,balance:0n,code:'0x602a60005260206000f3'}}}),o=await execute(f);
  assert.equal(o.execution.status,'success');assert.equal(o.execution.returnData,word(42));assert.notEqual(o.execution.executionGasUsed,'6900');
});

test('fresh before/after probes can use P256 without inheriting priced original context',async()=>{
  const getter='0x'+'77'.repeat(20),f=await fixture({priced:true,accounts:{[getter]:{nonce:1n,code:caller({embedded:INPUT,tail:'5060206000f3'})}}});
  const o=await executeEthereumPreview({request:f.request,queries:[{to:getter,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')}],header:f.header,rpc:f.rpc});
  assert.equal(o.status,'complete');assert.equal(o.measurements[0].values[0].beforeRaw,'1');assert.equal(o.measurements[0].values[0].afterRaw,'1');assert.equal(o.original.output.profile.feesSettled,true);
  for(const side of [o.measurements[0].before,o.measurements[0].after]){assert.equal(side.output.profile.declaredGasLimit,'1000000');assert.equal(side.output.profile.feesSettled,false);assert.equal(side.output.feeAccounting,undefined);assert.equal(side.output.trace.calls[0].input,INPUT);assert.equal(side.output.trace.calls[0].output,OUTPUT);}
});

test('P256 budget/host failures cannot be hidden by nested CALL and roll back the whole attempt including fees',async()=>{
  // Test-only clock seam targets this adapter's stack; no public crypto selector.
  for(const phase of [1,2])for(const failure of ['deadline','error','null','undefined']){
    const f=await fixture({priced:true,to:TARGET,value:'19',code:caller({kind:'CALL',value:5,prefix:'602a600355'})});
    await f.stateManager.checkpoint();const old=await account(f.stateManager,TARGET);old.balance=117n;await f.stateManager.putAccount(createAddressFromString(TARGET),old);
    const before=f.stateManager.snapshotChanges(),depth=f.stateManager.accountStack.length;let calls=0,fired=false,time=0;
    const now=()=>{if(new Error().stack.includes('p256-runtime.js')&&++calls===phase){fired=true;if(failure==='deadline')time=120000;else if(failure==='error')throw Error('private P256 host error');else if(failure==='null')throw null;else throw undefined;}return time;};
    const o=await execute(f,{now});assert(fired,`${phase}/${failure} reached P256 adapter`);assert.equal(calls,phase);assert.equal(o.execution.status,'unavailable');assert.equal(o.execution.error.code,failure==='deadline'?'LOCAL_RESOURCE_LIMIT':'LOCAL_EXECUTION_FAILED');assert.equal(o.stateDisposition,'rolled_back');assert.equal(o.feeAccounting,undefined);assert.equal(o.profile.feesSettled,false);assert.deepEqual(o.logs,[]);assert.equal(JSON.stringify(o).includes('private P256 host error'),false);
    assert.equal(f.stateManager.accountStack.length,depth);assert.deepEqual(f.stateManager.snapshotChanges(),before);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,1n);assert.equal(await balance(f.stateManager,P256_ADDRESS),0n);await f.stateManager.revert();
  }
});
