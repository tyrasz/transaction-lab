// Parent chronology over authenticated inputs and real entered-frame evidence.
// The equivalent delegated execution supplies only the trace; it does not
// supply authorization decisions or claim a signed-transaction gas comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString } from '@ethereumjs/util';
import { validateCreationAttempts } from '../creation-attempt-validation.js';
import { applyAmsterdamAuthorizations } from '../amsterdam-authorization.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { ethereumFeePlan } from '../ethereum-fees.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { factoryCode, initcode, IMPLEMENTATION } from './amsterdam-creation-attempts-fixture.js';
import { TEST_KEY, TX_SENDER, designation, signAuthorization } from './authorization-fixture.js';

const pending=new Map();
async function preparedPacket(priced=false){
  if(!pending.has(priced))pending.set(priced,(async()=>{
    const body=factoryCode(initcode('00',''),{kind:'CREATE2',value:5,repeat:2});
    const options={priced,to:TX_SENDER,sender:{nonce:1n,balance:65000007n},
      accounts:{[IMPLEMENTATION]:{nonce:1n,code:body}}};
    const f=await amsterdamExecutionFixture(options);
    f.request.authorizationList=[signAuthorization({key:TEST_KEY,address:IMPLEMENTATION,nonce:2n,chainId:11155111n})];
    await f.stateManager.checkpoint();
    const sender=createAddressFromString(TX_SENDER),caller=await f.stateManager.getAccount(sender);
    caller.nonce++;
    await f.stateManager.putAccount(sender,caller);
    const preparation=await applyAmsterdamAuthorizations({request:f.request,common:f.common,
      stateManager:f.stateManager,gasLimit:4900000n,stateGasReservoir:0n});
    assert.equal(preparation.outOfGas,false);
    assert.deepEqual(preparation.entries,[{index:0,authority:TX_SENDER,status:'applied',reason:null}]);
    const startingChanges=f.stateManager.snapshotChanges();
    assert.deepEqual(startingChanges.accounts.find(row=>row.address===TX_SENDER).nonce,{before:'0x1',after:'0x3'});
    const observation=await amsterdamExecutionFixture({...options,sender:{...options.sender,nonce:2n,code:designation(IMPLEMENTATION)}});
    const output=await executeEthereumCall({request:observation.request,header:observation.header,
      stateManager:observation.stateManager,blockchain:observation.inputs.blockchain,chainId:11155111});
    assert.equal(output.execution.status,'success',JSON.stringify(output.execution));
    assert.deepEqual(output.trace.creationAttempts.map(a=>[a.nonceBefore,a.nonceAfter,a.disposition]),
      [['0x3','0x4','entered'],['0x4','0x5','collision']]);
    // Fetch the original header's proofs for every observed address. Reusing
    // the equivalent execution's post-preparation sender proof would be wrong.
    for(const key of Object.keys(observation.inputs.snapshotInputs().accounts)){
      await f.stateManager.getAccount(createAddressFromString(key));
      await f.stateManager.getCode(createAddressFromString(key));
    }
    const args={output,inputs:f.inputs.snapshotInputs(),startingChanges,rootNoncePrepared:true,
      common:f.common,fees:priced?{plan:ethereumFeePlan(f.request,f.header,11155111)}:null};
    await f.stateManager.revert();
    return args;
  })());
  const args=await pending.get(priced);
  return {...structuredClone({...args,common:undefined}),common:args.common};
}

test('prepared self-authorization supplies code and nonce once for CREATE2 followed by collision',async()=>{
  const args=await preparedPacket();
  assert.deepEqual([...validateCreationAttempts(args)],[[TX_SENDER,2]]);
  assert.throws(()=>validateCreationAttempts({...args,rootNoncePrepared:false}),'A query-style extra bump must disagree with the first attempt');
  assert.throws(()=>validateCreationAttempts({...args,startingChanges:undefined}));
  assert.throws(()=>validateCreationAttempts({...args,rootNoncePrepared:1}));
});

test('prepared chronology rejects altered nonce/code snapshots and fee-bearing overlays',async()=>{
  const args=await preparedPacket();
  for(const change of [
    row=>{row.nonce.after='0x4';},
    row=>{row.nonce.before='0x0';},
    row=>{delete row.nonce;},
    row=>{row.code.after=designation('0x'+'88'.repeat(20));},
    row=>{row.balance={before:'0x3dfd247',after:'0x3dfd246'};},
  ]){
    const candidate={...args,startingChanges:structuredClone(args.startingChanges)};
    change(candidate.startingChanges.accounts.find(row=>row.address===TX_SENDER));
    assert.throws(()=>validateCreationAttempts(candidate));
  }
});

test('prepared chronology debits fees once before creator affordability checks',async()=>{
  const args=await preparedPacket(true);
  assert.equal(args.fees.plan.upfrontGasDebit,50000000n);
  assert.deepEqual([...validateCreationAttempts(args)],[[TX_SENDER,2]],'A second fee debit would exceed this sender balance');
  const candidate={...args,output:structuredClone(args.output)};
  for(const attempt of candidate.output.trace.creationAttempts)attempt.value='0x1312d00'; //20M
  candidate.output.trace.calls[0].value='0x1312d00';
  assert.throws(()=>validateCreationAttempts(candidate),'20M is unaffordable after the 50M fee prepayment');
  assert.deepEqual([...validateCreationAttempts({...candidate,fees:null})],[[TX_SENDER,2]],
    'The same observation would fit the undiscounted balance; the rejection binds the fee debit');
});
