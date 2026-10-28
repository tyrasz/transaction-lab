import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeUnsignedCall } from '../execute.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { ethereumCallGas, ethereumCommon } from '../ethereum-profile.js';
import { blobFeeFixture } from './blob-fee-fixture.js';
import { kzgFixture, kzgCallerCode, compareKzgFullVM, KZG_ADDRESS, KZG_INPUT, KZG_OUTPUT,
  TX_SENDER, TARGET, COINBASE, account, balance, slot, word } from './kzg-fixture.js';
const execute=(f,extra={})=>executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,...extra});
const replaceWord=(input,index,value)=>input.slice(0,2+index*64)+word(value).slice(2)+input.slice(66+index*64);
const falseProof=replaceWord(KZG_INPUT,2,BigInt('0x'+KZG_INPUT.slice(130,194))+1n);
const invalidInputs=[
  ['empty','0x','invalid input length'],
  ['short',KZG_INPUT.slice(0,-2),'invalid input length'],
  ['long',KZG_INPUT+'00','invalid input length'],
  ['hash',replaceWord(KZG_INPUT,0,0n),'kzg commitment does not match versioned hash'],
  ['noncanonical z',replaceWord(KZG_INPUT,1,BigInt('0x'+KZG_OUTPUT.slice(66))),'kzg inputs invalid'],
  ['noncanonical y',replaceWord(KZG_INPUT,2,BigInt('0x'+KZG_OUTPUT.slice(66))),'kzg inputs invalid'],
  ['malformed proof',KZG_INPUT.slice(0,290)+'00'.repeat(48),'kzg inputs invalid'],
  ['incorrect proof',falseProof,'kzg proof invalid'],
];
const successfulNested=KZG_OUTPUT+word(1).slice(2),failedNested=KZG_INPUT.slice(0,130)+word(0).slice(2);
const senderNonce=f=>account(f.stateManager,TX_SENDER).then(a=>a.nonce);

// Exact bytes/return value/gas come from the pinned official Geth vector.
// Full-VM counterparts below share the fixed verifier and opcode implementation.
test('official point evaluation succeeds without blob context on Cancun, Prague and Osaka',async()=>{
  for(const fork of ['cancun','prague','osaka']){
    const f=await kzgFixture({fork}),o=await execute(f);
    assert.equal(o.execution.status,'success',fork);assert.equal(o.execution.returnData,KZG_OUTPUT);
    assert.equal(o.execution.executionGasUsed,'50000');assert.equal(o.trace.gasUsed,'0xc350');
    assert.equal(o.profile.blobVersionedHashes,undefined);assert.equal(o.profile.feesSettled,false);
    assert.equal(o.usage.steps,0);assert.equal(o.trace.to,KZG_ADDRESS);assert.equal(await senderNonce(f),2n);
    await compareKzgFullVM(f,o);
  }
});

test('direct point evaluation has an exact 49999/50000 message-gas boundary',async()=>{
  for(const gas of [49999n,50000n]){
    const f=await kzgFixture({fork:'cancun'});
    const intrinsic=ethereumCallGas(f.request.data,ethereumCommon(f.header),f.request).intrinsic;
    f.request.gas=String(intrinsic+gas);const o=await execute(f);
    assert.equal(o.profile.messageGasLimit,String(gas));assert.equal(o.execution.status,gas===50000n?'success':'failed');
    assert.equal(o.execution.executionGasUsed,String(gas));assert.equal(o.execution.returnData,gas===50000n?KZG_OUTPUT:'0x');
    if(gas===49999n)assert.equal(o.execution.error,'out of gas');
    assert.equal(await senderNonce(f),2n);await compareKzgFullVM(f,o);
  }
});

test('CALL, STATICCALL, CALLCODE and DELEGATECALL run the precompile in their exact execution context',async()=>{
  for(const kind of ['CALL','STATICCALL','CALLCODE','DELEGATECALL']){
    const f=await kzgFixture({to:TARGET,code:kzgCallerCode({kind})}),o=await execute(f),child=o.trace.calls[0];
    assert.equal(o.execution.status,'success',kind);assert.equal(o.execution.returnData,successfulNested);
    assert.equal(child.type,kind);assert.equal(child.to,KZG_ADDRESS);assert.equal(child.gas,'0xc350');assert.equal(child.gasUsed,'0xc350');
    assert.equal(child.executionAddress,['CALLCODE','DELEGATECALL'].includes(kind)?TARGET:KZG_ADDRESS);
    assert.equal(child.caller,kind==='DELEGATECALL'?TX_SENDER:TARGET);assert.equal(child.error,null);assert.equal(child.output,KZG_OUTPUT);
    await compareKzgFullVM(f,o);
  }
});

test('a caught nested KZG OOG returns zero and retains only successful parent work',async()=>{
  const f=await kzgFixture({to:TARGET,code:kzgCallerCode({gas:49999,prefix:'602a600055'})}),o=await execute(f);
  assert.equal(o.execution.status,'success');assert.equal(o.execution.returnData,failedNested);assert.equal(await slot(f.stateManager,TARGET,0),42n);
  assert.equal(o.trace.calls[0].error,'out of gas');assert.equal(o.trace.calls[0].gasUsed,'0xc34f');
  await compareKzgFullVM(f,o);
});

test('malformed and well-formed incorrect proofs are ordinary completed EVM failures',async()=>{
  for(const [name,data,error] of invalidInputs){
    const f=await kzgFixture({data,value:'19'}),o=await execute(f);
    assert.equal(o.execution.status,'failed',name);assert.equal(o.execution.error,error,name);assert.equal(o.execution.returnData,'0x');
    assert.equal(o.execution.executionGasUsed,o.profile.messageGasLimit);assert.equal(o.gasAccounting.gasUsed,f.request.gas);
    assert.equal(await senderNonce(f),2n);assert.equal(await balance(f.stateManager,KZG_ADDRESS),0n);
    assert.equal(await balance(f.stateManager,TX_SENDER),1000000000000n);assert.equal(o.stateDisposition,'message_result_retained_in_supplied_manager');
    if(name==='incorrect proof'||name==='malformed proof')await compareKzgFullVM(f,o);
  }
});

test('caught invalid proof is not a host failure and does not abort valid parent storage',async()=>{
  const f=await kzgFixture({to:TARGET,data:falseProof,code:kzgCallerCode({prefix:'602a600055'})}),o=await execute(f);
  assert.equal(o.execution.status,'success');assert.equal(o.execution.returnData,failedNested);
  assert.equal(o.trace.calls[0].error,'kzg proof invalid');assert.equal(await slot(f.stateManager,TARGET,0),42n);
  await compareKzgFullVM(f,o);
});

test('successful precompile value transfer commits, but enclosing REVERT discards value, storage and logs',async()=>{
  for(const revert of [false,true]){
    const tail=revert?'5060016000a060006000fd':'60405260606000f3';
    const f=await kzgFixture({to:TARGET,value:'19',code:kzgCallerCode({kind:'CALL',value:5,prefix:'602a600055',tail})}),o=await execute(f);
    assert.equal(o.execution.status,revert?'reverted':'success');assert.equal(o.trace.calls[0].error,null);assert.equal(o.trace.calls[0].value,'0x5');
    assert.equal(await balance(f.stateManager,KZG_ADDRESS),revert?0n:5n);assert.equal(await balance(f.stateManager,TARGET),revert?100n:114n);
    assert.equal(await balance(f.stateManager,TX_SENDER),1000000000000n-(revert?0n:19n));
    assert.equal(await slot(f.stateManager,TARGET,0),revert?0n:42n);assert.deepEqual(o.logs,[]);assert.equal(await senderNonce(f),2n);
    await compareKzgFullVM(f,o);
  }
});

test('priced success, invalid proof and precompile OOG retain execution fees with correct value rollback',async()=>{
  for(const variant of ['success','invalid','oog']){
    const f=await kzgFixture({priced:true,value:'19',data:variant==='invalid'?falseProof:KZG_INPUT});
    if(variant==='oog')f.request.gas=String(ethereumCallGas(f.request.data,ethereumCommon(f.header),f.request).intrinsic+49999n);
    const o=await execute(f);assert.equal(o.execution.status,variant==='success'?'success':'failed');assert.equal(o.feeAccounting.kind,'eip1559');
    assert.equal(await balance(f.stateManager,TX_SENDER),1000000000000n-BigInt(o.feeAccounting.gasCharge)-(variant==='success'?19n:0n));
    assert.equal(await balance(f.stateManager,KZG_ADDRESS),variant==='success'?19n:0n);
    assert.equal(await balance(f.stateManager,COINBASE),1n+BigInt(o.feeAccounting.coinbaseTip));assert.equal(o.profile.feesSettled,true);
    await compareKzgFullVM(f,o);
  }
});

test('fresh unpriced before/after queries can verify embedded proof without inheriting original blob hashes or fees',async()=>{
  const other='0x'+'77'.repeat(20),f=await blobFeeFixture({gas:'100000',to:other,
    accounts:{[other]:{nonce:1n,code:'0x00'}},target:{nonce:1n,code:kzgCallerCode({input:KZG_INPUT,tail:'5060206000f3'})}});
  const p=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:TARGET,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')}]});
  assert.equal(p.status,'complete');assert.equal(p.original.output.feeAccounting.kind,'eip4844');
  const m=p.measurements[0];assert.equal(m.status,'measured');assert.equal(m.values[0].beforeRaw,'4096');assert.equal(m.values[0].afterRaw,'4096');
  for(const side of [m.before,m.after]){
    assert.equal(side.output.profile.declaredGasLimit,'1000000');assert.equal(side.output.profile.blobVersionedHashes,undefined);
    assert.equal(side.output.profile.feesSettled,false);assert.equal(side.output.feeAccounting,undefined);
    assert.equal(side.output.trace.calls[0].output,KZG_OUTPUT);assert.equal(side.output.trace.calls[0].input,KZG_INPUT);
  }
});

test('Shanghai address 0x0a remains ordinary code or an ordinary empty recipient',async()=>{
  const code='0x602a600055602a60005260206000f3';
  const f=await kzgFixture({fork:'shanghai',data:'0x',value:'19',accounts:{[KZG_ADDRESS]:{nonce:1n,balance:3n,code}}}),o=await execute(f);
  assert.equal(o.execution.status,'success');assert.equal(o.execution.returnData,word(42));assert.equal(await slot(f.stateManager,KZG_ADDRESS,0),42n);
  assert.equal(await balance(f.stateManager,KZG_ADDRESS),22n);await compareKzgFullVM(f,o);
  const empty=await kzgFixture({fork:'shanghai',data:'0x',gas:'21000',value:'7'}),e=await execute(empty);
  assert.equal(e.execution.status,'success');assert.equal(e.execution.executionGasUsed,'0');assert.equal(await balance(empty.stateManager,KZG_ADDRESS),7n);
  await compareKzgFullVM(empty,e);
});

test('legacy chain999 still rejects direct and nested 0x0a without retained mutations',async()=>{
  for(const direct of [true,false]){
    const f=await kzgFixture({to:direct?KZG_ADDRESS:TARGET,code:kzgCallerCode({prefix:'602a600055'})});
    const {gas,...request}=f.request;const o=await executeUnsignedCall({request:{...request,gasLimit:gas},block:f.header,chainId:999,stateManager:f.stateManager});
    assert.equal(o.execution.status,'unsupported');assert.equal(o.execution.error.code,'LOCAL_BLOB_UNSUPPORTED');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal(await senderNonce(f),1n);
  }
});

test('verifier pre/post budget or host failure cannot become a catchable CALL result or retain any outer state',async()=>{
  // Test-only clock seam: identify the adapter call stack, not an arbitrary
  // earlier clock read. Production callers cannot inject this clock/verifier.
  for(const phase of [1,2])for(const failure of ['deadline','error','null','undefined']){
    const f=await kzgFixture({priced:true,to:TARGET,value:'19',code:kzgCallerCode({kind:'CALL',value:5,prefix:'602a600055'})});
    await f.stateManager.checkpoint();const old=await account(f.stateManager,TARGET);old.balance=117n;await f.stateManager.putAccount(createAddressFromString(TARGET),old);
    const before=f.stateManager.snapshotChanges(),depth=f.stateManager.accountStack.length;let checks=0,fired=false,time=0;
    const now=()=>{
      if(new Error().stack.includes('kzg-runtime.js')&&++checks===phase){
        fired=true;if(failure==='deadline')time=120000;
        else if(failure==='error')throw Error('private crypto host marker');else if(failure==='null')throw null;else throw undefined;
      }return time;
    };
    const o=await execute(f,{now});assert(fired,`${phase}/${failure} injection must reach KZG adapter`);assert.equal(checks,phase);
    assert.equal(o.execution.status,'unavailable');assert.equal(o.execution.error.code,failure==='deadline'?'LOCAL_RESOURCE_LIMIT':'LOCAL_EXECUTION_FAILED');
    assert.equal(o.stateDisposition,'rolled_back');assert.equal(o.profile.feesSettled,false);assert.equal(o.feeAccounting,undefined);assert.deepEqual(o.logs,[]);
    assert.equal(JSON.stringify(o).includes('private crypto host marker'),false);assert.equal(f.stateManager.accountStack.length,depth);
    assert.deepEqual(f.stateManager.snapshotChanges(),before);assert.equal(await senderNonce(f),1n);assert.equal(await balance(f.stateManager,KZG_ADDRESS),0n);
    await f.stateManager.revert();
  }
});

test('nonzero CALLCODE and delegated execution value never transfer native funds to the precompile code address',async()=>{
  for(const kind of ['CALLCODE','DELEGATECALL']){
    const f=await kzgFixture({to:TARGET,value:'19',code:kzgCallerCode({kind,value:5})}),o=await execute(f),child=o.trace.calls[0];
    assert.equal(o.execution.status,'success');assert.equal(o.execution.returnData,successfulNested);
    assert.equal(child.type,kind);assert.equal(child.executionAddress,TARGET);assert.equal(child.to,KZG_ADDRESS);
    assert.equal(child.value,kind==='DELEGATECALL'?'0x13':'0x5');assert.equal(child.gas,kind==='CALLCODE'?'0xcc4c':'0xc350');
    assert.equal(child.gasUsed,'0xc350');assert.equal(await balance(f.stateManager,KZG_ADDRESS),0n);
    assert.equal(await balance(f.stateManager,TARGET),119n);assert.equal(await balance(f.stateManager,TX_SENDER),999999999981n);
    await compareKzgFullVM(f,o);
  }
});
