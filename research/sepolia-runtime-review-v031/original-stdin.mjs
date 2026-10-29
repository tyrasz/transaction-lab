import assert from 'node:assert/strict';
import { amsterdamExecutionFixture as fixture, TARGET, word } from './engines/local-evm/test/amsterdam-execution-fixture.js';
import { executeEthereumCall } from './engines/local-evm/ethereum-call.js';
const run=f=>executeEthereumCall({request:f.request,header:f.header,chainId:11155111,stateManager:f.stateManager,blockchain:f.inputs.blockchain});
const body='0x60003560005500';
for(const copy of [false,true]) {
 const f=await fixture({target:{nonce:1n,code:body},data:word(7)});
 const first=await run(f);assert.equal(first.execution.status,'success');
 if(copy) f.stateManager=f.stateManager.shallowCopy();
 f.request.data=word(0);const second=await run(f);
 const fresh=await fixture({target:{nonce:1n,code:body,storage:{[word(0)]:7n}},data:word(0)});const expected=await run(fresh);
 assert.equal(second.execution.status,'success');assert.deepEqual(second.execution,expected.execution);assert.deepEqual(second.stateGasAccounting,expected.stateGasAccounting);
}
for(const failure of [undefined,null,Error('host-cache')]) {
 const f=await fixture({target:{nonce:1n,code:body},data:word(7)});const before=f.stateManager.snapshotChanges();
 const getter=f.stateManager.originalStorageCache.get.bind(f.stateManager.originalStorageCache);let fired=false;
 f.stateManager.originalStorageCache.get=async(...args)=>{const result=await getter(...args);fired=true;throw failure;};
 const out=await run(f);assert(fired);assert.equal(out.execution.status,'unavailable');assert.equal(out.stateDisposition,'rolled_back');assert.equal(out.feeAccounting,undefined);assert.equal(out.stateGasAccounting,undefined);assert.deepEqual(f.stateManager.snapshotChanges(),before);
}
console.log('5/5 independent storage-cache reuse/copy and host-failure rollback checks passed');
