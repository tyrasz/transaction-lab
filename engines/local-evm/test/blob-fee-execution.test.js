import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { ethereumFeePlan } from '../ethereum-fees.js';
import { blobFeeFixture, BLOB_HASH, TX_SENDER, TARGET, COINBASE, balance, account,
  compareBlobFeeFullVM as compareFullVM } from './blob-fee-fixture.js';
import { slot } from './authorization-fixture.js';

const FUNDS=1000000000000n, EXCESS=10015432n;
const execute=(f,extra={})=>executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,...extra});
const words=hex=>Array.from({length:(hex.length-2)/64},(_,i)=>BigInt('0x'+hex.slice(2+64*i,66+64*i)));
test('priced blob opcodes and sender BALANCE observe exact hashes, current price and both upfront charges',async()=>{
  const f=await blobFeeFixture({excessBlobGas:EXCESS,gas:'100000',value:'11',blobCount:2,
    target:{nonce:1n,code:'0x4a6000526000496020526002496040523a60605248608052333160a05260c06000f3'}});
  const o=await execute(f);assert.equal(o.execution.status,'success');
  const p=ethereumFeePlan(f.request,f.header);
  assert.deepEqual(words(o.execution.returnData),[7n,BigInt(BLOB_HASH),0n,10n,7n,FUNDS-p.totalUpfrontDebit-11n]);
  assert.equal(o.profile.name,'ethereum_unsigned_eip4844_call');assert.equal(o.profile.executionBlobBaseFee,'7');
  assert.equal(o.environment.blobBaseFeePerGas,'7');assert.equal(o.profile.feesSettled,true);
  assert.equal(await balance(f.stateManager,TX_SENDER),FUNDS-BigInt(o.feeAccounting.totalFeeCharge)-11n);
  assert.equal(await balance(f.stateManager,COINBASE),BigInt(o.feeAccounting.coinbaseTip));
  await compareFullVM(f,o);
});

test('each fork admits its exact blob count even when the selected block already used its full capacity',async()=>{
  for(const [fork,count,blockMax] of [['cancun',6,6],['prague',9,9],['osaka',6,9],['bpo1',6,15],['bpo2',6,21]]) {
    const f=await blobFeeFixture({fork,blobCount:count,headerBlobGasUsed:BigInt(blockMax)*131072n,gas:'30000'});
    const o=await execute(f);assert.equal(o.execution.status,'success',fork);assert.equal(o.feeAccounting.blobCount,String(count));
    await compareFullVM(f,o);
  }
});

test('EVM revert and out-of-gas retain blob burn plus settled execution charges while reverting storage/value',async()=>{
  for(const [code,gas,status] of [['0x602a60005560006000fd','100000','reverted'],['0x602a6000555b600556','50000','failed']]) {
    const f=await blobFeeFixture({excessBlobGas:EXCESS,gas,value:'19',target:{nonce:1n,code}}),o=await execute(f);
    assert.equal(o.execution.status,status);assert.equal(o.feeAccounting.blobFeeBurn,'917504');
    assert.equal(await slot(f.stateManager,TARGET,0),0n);assert.equal(await balance(f.stateManager,TARGET),0n);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);
    assert.equal(await balance(f.stateManager,TX_SENDER),FUNDS-BigInt(o.feeAccounting.totalFeeCharge));
    assert.equal(o.profile.feesSettled,true);await compareFullVM(f,o);
  }
});

test('priced nonblob calls expose real BLOBBASEFEE while Shanghai preserves its ordinary invalid opcode',async()=>{
  for(const [fork,status,expected] of [['cancun','success',7n],['osaka','success',7n],['shanghai','failed',null]]) {
    const fraction=fork==='cancun'?3338477n:5007716n;
    const f=await blobFeeFixture({profile:'unsigned_eip1559_block_end',fork,excessBlobGas:2n*fraction,gas:'30000',target:{nonce:1n,code:'0x4a60005260004960205260406000f3'}}),o=await execute(f);
    assert.equal(o.execution.status,status);assert.equal(o.feeAccounting.kind,'eip1559');assert.equal(o.feeAccounting.blobFeeBurn,undefined);
    if(expected!==null)assert.deepEqual(words(o.execution.returnData),[expected,0n]);
    else assert.equal(o.environment.blobBaseFeePerGas,undefined);
    await compareFullVM(f,o);
  }
});

test('fork, cap, count and bounded-price failures precede proof reads and cannot emit accounting',async()=>{
  for(const options of [{fork:'shanghai'},{fork:'cancun',blobCount:7},{fork:'osaka',blobCount:7},
    {excessBlobGas:EXCESS,maxBlobFee:6n},{excessBlobGas:(1n<<64n)-1n}]) {
    const f=await blobFeeFixture(options);let reads=0;
    f.stateManager.getAccount=async()=>{reads++;assert.fail('Invalid profile reached state');};
    const o=await execute(f);assert(['invalid','unsupported'].includes(o.execution.status));assert.equal(reads,0);
    assert.equal(o.feeAccounting,undefined);assert.equal(o.stateDisposition,'unchanged');
    if(options.excessBlobGas===(1n<<64n)-1n)assert.equal(o.execution.error.code,'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT');
  }
  const f=await blobFeeFixture({sender:{balance:1000000n},gas:'30000'}),o=await execute(f);
  assert.equal(o.execution.status,'invalid');assert.equal(o.execution.error.code,'LOCAL_CALL_INSUFFICIENT_BALANCE');
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);assert.equal(o.feeAccounting,undefined);
});

test('host and deadline failures after blob debit or final credits roll back everything including caller checkpoints',async()=>{
  for(const phase of ['prepayment','coinbase','deadline']) {
    const f=await blobFeeFixture({excessBlobGas:EXCESS,gas:'100000',target:{nonce:1n,code:'0x602a60005500'}});
    await f.stateManager.checkpoint();const a=await account(f.stateManager,TARGET);a.balance=17n;
    await f.stateManager.putAccount(createAddressFromString(TARGET),a);
    const before=f.stateManager.snapshotChanges(),depth=f.stateManager.accountStack.length,plan=ethereumFeePlan(f.request,f.header);
    const put=f.stateManager.putAccount.bind(f.stateManager);let hit=false,time=0;
    f.stateManager.putAccount=async(address,value)=>{await put(address,value);
      if((phase==='prepayment'&&address.toString()===TX_SENDER&&value.balance===FUNDS-plan.totalUpfrontDebit)||
        (phase!=='prepayment'&&address.toString()===COINBASE)){
        hit=true;if(phase==='deadline')time=120000;else throw Error('private blob settlement failure');
      }};
    const o=await execute(f,{now:()=>time});assert(hit);assert.equal(o.execution.status,'unavailable');
    assert.equal(o.feeAccounting,undefined);assert.equal(o.profile.feesSettled,false);assert.equal(o.semantics.feeSettlement,false);
    assert.equal(JSON.stringify(o).includes('private blob'),false);assert.equal(o.stateDisposition,'rolled_back');
    assert.equal(f.stateManager.accountStack.length,depth);assert.deepEqual(f.stateManager.snapshotChanges(),before);
    assert.equal(await balance(f.stateManager,TX_SENDER),FUNDS);await f.stateManager.revert();
  }
});

test('unpriced probes omit original blob hashes and fees; BLOBBASEFEE remains explicitly unavailable',async()=>{
  for(const [code,measured] of [['0x60004960005260206000f3',true],['0x4a60005260206000f3',false]]) {
    const f=await blobFeeFixture({excessBlobGas:EXCESS,gas:'100000',target:{nonce:1n,code}});
    const p=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[{to:TARGET,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')}]});
    assert.equal(p.original.output.execution.status,'success');assert.equal(p.original.output.feeAccounting.kind,'eip4844');
    const m=p.measurements[0];assert.equal(m.status,measured?'measured':'unavailable');
    if(measured){assert.equal(p.status,'complete');assert.equal(m.values[0].beforeRaw,'0');assert.equal(m.values[0].afterRaw,'0');}
    else {assert.equal(p.status,'partial');assert.equal(m.values,null);assert.equal(m.before.output.execution.error.code,'LOCAL_BLOB_UNSUPPORTED');}
    for(const probe of [m.before,m.after].filter(Boolean)) {
      assert.equal(probe.output.feeAccounting,undefined);assert.equal(probe.output.profile.feesSettled,false);
      assert.equal(probe.output.profile.declaredGasLimit,'1000000');assert.equal(probe.output.profile.blobVersionedHashes,undefined);
      assert.equal(probe.output.environment.blobBaseFeePerGas,undefined);
    }
  }
});

test('KZG remains unsupported and zero-tip cleanup uses the blob-specific transaction scope',async()=>{
  const f=await blobFeeFixture({gas:'100000',to:'0x'+'00'.repeat(19)+'0a'}),o=await execute(f);
  assert.equal(o.execution.status,'unsupported');assert.equal(o.execution.error.code,'LOCAL_BLOB_UNSUPPORTED');assert.equal(o.feeAccounting,undefined);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
  const z=await blobFeeFixture({gas:'30000',priorityFee:0n,accounts:{[COINBASE]:{nonce:0n,balance:0n,code:'0x'}}}),zo=await execute(z);
  assert.equal(zo.execution.status,'success');assert.equal(zo.lifecycle.emptyAccountCleanup.scope,'unsigned_eip4844_transaction_touches');
  assert.equal(await account(z.stateManager,COINBASE),undefined);await compareFullVM(z,zo);
});
