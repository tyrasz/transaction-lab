import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { compareExecution } from './authorization-fixture.js';
import { resetPreviewFixture, RESET_TARGET, RESET_BENEFICIARY } from './reset-preview-fixture.js';
import { resetFixture, resetReference, request, expectedAllocation, assertFullPoststate, appliedResetRoot, account, code, storage, FACTORY, FUNDER, INSPECTOR, TX_SENDER, OLD_SLOT, UNREAD_SLOT, bytes, word } from './sequential-reset-fixture.js';

test('signed full-MPT sequence: delete old code/nonce/storage then native-fund the address without resurrection',async()=>{
  for(const nested of [false,true]){
    const f=await resetFixture(),ref=await resetReference(f);
    assert.equal((await ref.run()).status,'success');await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:1,deleted:true}));
    assert.equal((await ref.run(request(f,nested?FUNDER:f.victim,nested?{}:{value:'7'}))).status,'success');
    await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:2,deleted:true,funding:7n,fromFunder:nested}));
    const get=await ref.run(request(f,INSPECTOR));assert.equal(get.returnData,word(7)+word(0).slice(2)+bytesToHex(keccak_256(new Uint8Array())).slice(2));
    await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:3,deleted:true,funding:7n,fromFunder:nested}));
  }
});

test('signed full-MPT sequence: CREATE2 reuses an authenticated deleted namespace and a fresh getter sees only new storage',async()=>{
  const f=await resetFixture(),ref=await resetReference(f);await ref.run();
  const creation=await ref.run(request(f,FACTORY));assert.equal(creation.status,'success');assert.equal(creation.returnData,'0x'+f.victim.slice(2).padStart(64,'0'));
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:2,deleted:true,deployments:1,created:true}));
  const get=await ref.run(request(f,f.victim));assert.equal(get.returnData,word(42));
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:3,deleted:true,deployments:1,created:true}));
  assert.equal(await storage(ref.state,f.victim,OLD_SLOT),0n);assert.equal(await storage(ref.state,f.victim,UNREAD_SLOT),0n);
});

test('signed full-MPT sequence: a recreated contract can delete and be recreated again across Shanghai transactions',async()=>{
  const f=await resetFixture(),ref=await resetReference(f);await ref.run();await ref.run(request(f,FACTORY));
  assert.equal((await ref.run(request(f,f.victim,{data:'0x01'}))).status,'success');
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:3,deleted:true,deployments:1,beneficiary:22n}));
  assert.equal((await ref.run(request(f,FACTORY))).status,'success');
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:4,deleted:true,deployments:2,beneficiary:22n,created:true}));
  assert.equal((await ref.run(request(f,f.victim))).returnData,word(42));
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:5,deleted:true,deployments:2,beneficiary:22n,created:true}));
});

test('signed full-MPT sequence: constructor revert retains deletion and factory nonce, without old storage',async()=>{
  const f=await resetFixture({constructorReverts:true}),ref=await resetReference(f);await ref.run();
  const row=await ref.run(request(f,FACTORY));assert.equal(row.status,'success');assert.equal(row.returnData,word(0));
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:2,deleted:true,creationAttempts:1}));
});

test('actual local rollback and signed sequence agree when later funding is reverted by its ancestor',async()=>{
  const f=await resetFixture({ancestorReverts:true}),ref=await resetReference(f);
  for(const input of [request(f,f.victim),request(f,FUNDER)]){
    const local=await executeEthereumCall({...f,request:input}),full=await ref.run(input);compareExecution(local,full.result);
  }
  assert.equal(ref.history[1].status,'reverted');await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:2,deleted:true}));
  assert.equal(await account(f.stateManager,f.victim),undefined);assert.equal(await code(f.stateManager,f.victim),'0x');
  const reads=f.calls.length;for(const slot of [OLD_SLOT,UNREAD_SLOT])assert.equal(await storage(f.stateManager,f.victim,slot),0n);assert.equal(f.calls.length,reads,'Deleted old slots must not trigger original trie reads');
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,3n);
});

test('pinned reference cache diagnostic: committed empty trie differs from the stale address cache without altering sequence execution',async t=>{
  const f=await resetFixture(),ref=await resetReference(f);await ref.run();await ref.run(request(f,f.victim,{value:'7'}));
  const root=bytesToHex(await ref.state.getStateRoot()),cached=await storage(ref.state,f.victim,OLD_SLOT),fresh=ref.state.shallowCopy(),committed=await storage(fresh,f.victim,OLD_SLOT);
  assert.equal(cached,99n);assert.equal(committed,0n);assert.equal(bytesToHex(await fresh.getStateRoot()),root);assert.equal(bytesToHex(await ref.state.getStateRoot()),root);
  assert.equal(root,await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:2,deleted:true,funding:7n})));
  t.diagnostic(JSON.stringify({kind:'pinned_ethereumjs_storage_trie_cache_diagnostic',transactionsExecuted:ref.history.length,address:f.victim,slot:word(OLD_SLOT),cachedRaw:cached.toString(),freshCommittedRaw:committed.toString(),unchangedRoot:root,referenceExecutionModified:false}));
});

async function both(f,ref,input){
  const local=await executeEthereumCall({...f,request:input}),full=await ref.run(input);compareExecution(local,full.result);
  assert.equal(await appliedResetRoot(f,f.stateManager.snapshotChanges()),full.stateRoot,'Reset-aware product deltas applied to a third fresh MPT must match the carried full-VM state');
  return local;
}

test('retained local manager matches signed sequence and third-MPT roots for direct/nested permanent native rematerialization',async()=>{
  for(const nested of [false,true]){
    const f=await resetFixture(),ref=await resetReference(f);await both(f,ref,request(f,f.victim));
    await both(f,ref,request(f,nested?FUNDER:f.victim,nested?{}:{value:'7'}));
    const changes=f.stateManager.snapshotChanges(),row=changes.accounts.find(a=>a.address===f.victim);assert.equal(row.reset.basis,'shanghai_selfdestruct_deletion');assert.equal(row.existence,undefined);
    assert.deepEqual(row.nonce,{before:'0x3',after:'0x0'});assert.deepEqual(row.code,{before:f.allocation[f.victim].code,after:'0x'});
    assert.equal(await code(f.stateManager,f.victim),'0x');assert.equal(await storage(f.stateManager,f.victim,UNREAD_SLOT),0n);
    await both(f,ref,request(f,INSPECTOR));await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:3,deleted:true,funding:7n,fromFunder:nested}));
  }
});

test('retained local manager matches repeated CREATE2 recreation, fresh getters and entire cleared storage roots',async()=>{
  const f=await resetFixture(),ref=await resetReference(f);await both(f,ref,request(f,f.victim));await both(f,ref,request(f,FACTORY));
  const row=f.stateManager.snapshotChanges().accounts.find(a=>a.address===f.victim);assert(row.reset);assert.deepEqual(row.storage,[{slot:word(0),before:word(0),after:word(42)}]);
  assert.equal((await both(f,ref,request(f,f.victim))).execution.returnData,word(42));assert.equal(await storage(f.stateManager,f.victim,OLD_SLOT),0n);
  await both(f,ref,request(f,f.victim,{data:'0x01'}));await both(f,ref,request(f,FACTORY));assert.equal((await both(f,ref,request(f,f.victim))).execution.returnData,word(42));
  await assertFullPoststate(f,ref,expectedAllocation(f,{transactions:6,deleted:true,deployments:2,beneficiary:22n,created:true}));
});

test('failed constructor and copied-manager recreation preserve the correct reset namespace and rollback',async()=>{
  const reverted=await resetFixture({constructorReverts:true}),reference=await resetReference(reverted);await both(reverted,reference,request(reverted,reverted.victim));await both(reverted,reference,request(reverted,FACTORY));
  assert.equal(await account(reverted.stateManager,reverted.victim),undefined);await assertFullPoststate(reverted,reference,expectedAllocation(reverted,{transactions:2,deleted:true,creationAttempts:1}));
  const f=await resetFixture(),ref=await resetReference(f);await both(f,ref,request(f,f.victim));const prior=structuredClone(f.stateManager.snapshotChanges()),copy=f.stateManager.shallowCopy();
  await both({...f,stateManager:copy},ref,request(f,FACTORY));assert.deepEqual(f.stateManager.snapshotChanges(),prior);assert.equal(await account(f.stateManager,f.victim),undefined);assert.equal(await code(copy,f.victim),f.runtime);
  const copied=structuredClone(copy.snapshotChanges());await copy.checkpoint();await copy.putStorage(createAddressFromString(f.victim),bytes(word(UNREAD_SLOT)),bytes('0x63'));await copy.revert();assert.deepEqual(copy.snapshotChanges(),copied);assert.equal(await storage(copy,f.victim,UNREAD_SLOT),0n);
});

test('host failure during surviving rematerialization rolls back nonce, balance and reset provenance atomically',async()=>{
  const f=await resetFixture();await executeEthereumCall(f);const before=structuredClone(f.stateManager.snapshotChanges()),put=f.stateManager.putAccount.bind(f.stateManager);let injected=0;
  f.stateManager.putAccount=async(address,value)=>{await put(address,value);if(address.toString()===f.victim&&value.balance===7n){injected++;throw Error('Injected host failure after native rematerialization');}};
  const result=await executeEthereumCall({...f,request:request(f,f.victim,{value:'7'})});assert.equal(injected,1);assert.equal(result.execution.status,'unavailable');assert.equal(result.stateDisposition,'rolled_back');assert.deepEqual(f.stateManager.snapshotChanges(),before);assert.equal(await account(f.stateManager,f.victim),undefined);assert.equal(await storage(f.stateManager,f.victim,UNREAD_SLOT),0n);
});

test('actual isolated before/after recreation getter agrees with separate signed full-VM sequences and unchanged rollback roots',async()=>{
  const f=await resetPreviewFixture(),product=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:[f.query]});assert.equal(product.status,'completed');assert.equal(product.preview.status,'complete');
  const m=product.preview.measurements[0];assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['0','43','43']]);
  const before=await resetReference(f),b=await before.run(f.queryRequest);compareExecution(m.before.output,b.result);assert.equal(b.returnData,word(0));
  const beforeExpected=structuredClone(f.allocation);beforeExpected[TX_SENDER].nonce='0x2';await assertFullPoststate(f,before,beforeExpected);
  const after=await resetReference(f),original=await after.run(f.request);compareExecution(product.preview.original.output,original.result);const a=await after.run(f.queryRequest);compareExecution(m.after.output,a.result);assert.equal(a.returnData,word(43));
  const afterExpected=structuredClone(f.allocation);delete afterExpected[RESET_TARGET];afterExpected[TX_SENDER].nonce='0x3';afterExpected[RESET_BENEFICIARY].balance='0x16';await assertFullPoststate(f,after,afterExpected);
  assert.equal(await appliedResetRoot(f,m.after.changesAfter),a.stateRoot);
});
