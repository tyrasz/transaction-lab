// Synthetic authenticated initial state only. The full-VM counterpart shares
// EthereumJS, while signed admission/settlement and full-state MPT are separate.
import assert from 'node:assert/strict';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { compareFeeFullVM, balance } from './fee-fixture.js';
import { compareBlobFeeFullVM } from './blob-fee-fixture.js';

export const UNUSED='0x'+'aa'.repeat(20), ABSENT='0x'+'bb'.repeat(20), BENEFICIARY='0x'+'88'.repeat(20);
export const UNIT=Object.freeze({kind:'native_wei',scale:'1000000000000000000'});
export const native=account=>({kind:'native_balance',account});
export function assertNativeMeasurement(row,account,before,after,originalChanges){
  assert.equal(row.status,'measured',JSON.stringify(row.reason));
  assert.deepEqual(row.descriptor,native(account));assert.equal(row.query,null);assert.equal(row.returnBytes,0);
  assert.deepEqual(row.identity,{kind:'native_balance',account,chainId:'1'});
  assert.deepEqual(row.values,[{name:'balance',beforeRaw:String(before),afterRaw:String(after),deltaRaw:String(BigInt(after)-BigInt(before)),unit:UNIT}]);
  if(row.before===undefined)return; // Public projection keeps the full phases in attempt.preview.
  for(const [key,raw] of [['before',before],['after',after]]){
    const side=row[key];assert.deepEqual(Object.keys(side).sort(),['status','reason','output','values','readMethod','changesBefore','changesAfter','inputEvidenceIds','stateReads'].sort());
    assert.equal(side.status,'measured');assert.equal(side.reason,null);assert.equal(side.output,null);
    assert.equal(side.readMethod,'proof_state_account_balance');assert.deepEqual(side.values,[{name:'balance',raw:String(raw),unit:UNIT}]);
    assert.deepEqual(side.changesBefore,side.changesAfter,'Native queries must not mutate nonce, funds, code, storage or lifecycle markers');
    assert.deepEqual(side.stateReads,{total:1,distinct:1,reads:[{kind:'account',address:account}]});
    assert(Array.isArray(side.inputEvidenceIds));
    if(key==='before')assert.deepEqual(side.changesBefore.accounts,[]);
    else assert.deepEqual(side.changesBefore,originalChanges);
  }
}
export async function compareNativePreview(f,accounts,{status='success',blob=false}={}){
  const allocation=structuredClone(f.allocation),result=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries:accounts.map(native)});
  assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.preview.status,'complete');
  assert.equal(result.isolation.processSeparated,true);assert.notEqual(result.isolation.childPid,process.pid);assert.equal(result.isolation.processClosed,true);assert.equal(result.broker.pendingAtReturn,0);
  const p=result.preview;assert.equal(p.original.output.execution.status,status);assert.equal(p.usage.executions,1,'Native queries add no VM executions');
  const readsBeforeReference=structuredClone(f.calls),ref=await(blob?compareBlobFeeFullVM:compareFeeFullVM)(f,p.original.output,p.original.changes);
  assert.deepEqual(f.calls,readsBeforeReference,'The reference must not request product state facts');assert.deepEqual(f.allocation,allocation);
  assert.equal(p.scope.nativeEffectsMeasured,true);assert.equal(p.scope.nativeBalanceCoverage,'explicit_accounts_only');assert.equal(p.scope.queryGasScope,'CALL_only');
  for(let i=0;i<accounts.length;i++){
    const address=accounts[i],before=BigInt(allocation[address]?.balance??0),after=await balance(ref.state,address);
    assertNativeMeasurement(p.measurements[i],address,before,after,p.original.changes);
  }
  assert.deepEqual(f.stateManager.snapshotChanges().accounts,[],'Child and reference cannot mutate the fixture initial manager');
  return{result,preview:p,reference:ref};
}
