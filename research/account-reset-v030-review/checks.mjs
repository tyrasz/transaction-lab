import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const IDS = ['delete_fund_inspect','delete_recreate_getter','repeated_recreation','constructor_revert','reverting_recreation_getter'];
export const LENGTHS = [3,3,5,2,2];
export const sha = value => createHash('sha256').update(value).digest('hex');
export const word = value => '0x' + BigInt(value).toString(16).padStart(64,'0');
export const quantity = value => '0x' + BigInt(value).toString(16);
export function relative(value) {
  assert.equal(typeof value,'string'); assert(value.length && !value.startsWith('/') && !value.includes('\\'));
  assert(value.split('/').every(part => part && part !== '.' && part !== '..')); return value;
}
export function processResult(raw, { parsed = true } = {}) {
  for (const name of ['stdout','stderr']) {
    const stream = raw[name], data = Buffer.from(stream.base64,'base64');
    assert.equal(data.toString('base64'),stream.base64); assert.equal(data.length,stream.bytes); assert.equal(sha(data),stream.sha256);
  }
  const p = raw.process;
  assert.equal(p.status,0); assert.equal(p.signal,null); assert.equal(p.error,null);
  assert(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0 && p.timeoutMs <= 15000);
  for (const elapsed of [p.elapsedMs,p.wallElapsedMs]) assert(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= p.timeoutMs);
  assert(raw.stdout.bytes + raw.stderr.bytes <= 8388608);
  if (!parsed) return;
  assert.equal(raw.parseError,undefined);
  const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(raw.stdout.base64,'base64')));
  assert.deepEqual(raw.result,result); return result;
}
export function signedInput(input, lib) {
  assert.equal(input.signed.length,input.requests.length); const base = BigInt(input.allocation[input.requests[0].from].nonce);
  const blobs = [];
  for (let i=0;i<input.signed.length;i++) {
    const saved=input.signed[i], request=input.requests[i], tx=lib.createTxFromRLP(lib.hexToBytes(saved.bytes),{common:lib.common});
    assert.equal(tx.type,2); assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(),request.from);
    assert.equal(tx.common.chainId(),1n); assert.equal(tx.nonce,base+BigInt(i)); assert.equal(saved.nonce,tx.nonce.toString());
    assert.equal(tx.to.toString(),request.to); assert.equal(lib.bytesToHex(tx.data),request.data);
    assert.equal(tx.value,BigInt(request.value)); assert.equal(tx.gasLimit,BigInt(request.gas));
    assert.equal(tx.maxFeePerGas,0n); assert.equal(tx.maxPriorityFeePerGas,0n); assert.deepEqual(tx.accessList,[]);
    assert.equal(lib.bytesToHex(tx.serialize()),saved.bytes); assert.equal(lib.bytesToHex(tx.hash()),saved.hash);
    assert.equal(request.authorizationList,undefined); assert.equal(request.accessList,undefined); assert.equal(request.blobVersionedHashes,undefined);
    if(request.fees) assert.deepEqual(request.fees,{maxFeePerGas:'0',maxPriorityFeePerGas:'0'});
    blobs.push(lib.hexToBytes(saved.bytes)); assert.equal(lib.bytesToHex(lib.RLP.encode(blobs)),input.prefixBodies[i]);
  }
}
export function executionGas(request, output) {
  assert(['success','reverted','failed'].includes(output.execution.status));
  let intrinsic=21000n;
  for(const byte of Buffer.from(request.data.slice(2),'hex')) intrinsic+=byte===0?4n:16n;
  const before=intrinsic+BigInt(output.execution.executionGasUsed), counter=BigInt(output.execution.gasRefundCounter);
  assert(counter>=0n); const refund=counter<before/5n?counter:before/5n, gas=before-refund;
  assert(gas<=BigInt(request.gas));
  assert.deepEqual(output.gasAccounting,{beforeRefund:String(before),appliedRefund:String(refund),floorAdjustment:'0',gasUsed:String(gas)});
  if(request.fees) {
    const f=output.feeAccounting; assert(f); assert.equal(f.kind,'eip1559'); assert.equal(f.gasLimit,request.gas);
    assert.equal(f.chargedGas,String(gas)); assert.equal(f.maximumRequiredBalance,request.value);
    for(const name of ['effectiveGasPrice','baseFeePerGas','priorityFeePerGas','upfrontGasDebit','gasCharge','senderRefund','baseFeeBurn','coinbaseTip']) assert.equal(f[name],'0');
  } else assert.equal(output.feeAccounting,undefined);
  return gas;
}
export function applyAllocation(input, changes, initialRoots) {
  assert.equal(changes.scope,'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.');
  assert.equal(new Set(changes.accounts.map(r=>r.address)).size,changes.accounts.length);
  const allocation=structuredClone(input.allocation);
  for(const row of changes.accounts) {
    assert.match(row.address,/^0x[0-9a-f]{40}$/); assert(Object.keys(row).every(k=>['address','existence','nonce','balance','code','storage','reset'].includes(k)));
    const initial=input.allocation[row.address];
    if(row.existence) assert.equal(initial!==undefined,row.existence.before);
    for(const field of ['nonce','balance']) if(row[field]) { assert.equal(BigInt(row[field].before),BigInt(initial?.[field]??0)); assert.notEqual(row[field].before,row[field].after); }
    if(row.code) { assert.equal(row.code.before,initial?.code??'0x'); assert.notEqual(row.code.before,row.code.after); }
    if(row.existence?.after===false) { assert.equal(row.reset,undefined); assert.equal(row.code,undefined); assert.equal(row.storage,undefined); delete allocation[row.address]; continue; }
    const current=initial?structuredClone(initial):{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};
    if(row.reset) {
      assert(initial); assert.equal(row.existence,undefined); assert.deepEqual(Object.keys(row.reset).sort(),['basis','initialStorageRoot']);
      assert(['shanghai_selfdestruct_deletion','same_invocation_created_contract_deletion','eip161_empty_account_cleanup'].includes(row.reset.basis));
      assert.equal(row.reset.initialStorageRoot,initialRoots.get(row.address)); current.storage={};
    }
    for(const field of ['nonce','balance']) if(row[field]) current[field]=quantity(row[field].after);
    if(row.code) current.code=row.code.after;
    assert.equal(new Set((row.storage??[]).map(s=>s.slot)).size,(row.storage??[]).length);
    for(const slot of row.storage??[]) {
      assert.match(slot.slot,/^0x[0-9a-f]{64}$/); assert.match(slot.before,/^0x[0-9a-f]{64}$/); assert.match(slot.after,/^0x[0-9a-f]{64}$/);
      assert.equal(BigInt(slot.before),row.reset?0n:BigInt(initial?.storage?.[slot.slot]??0));
      assert.notEqual(slot.before,slot.after); if(row.reset) assert(BigInt(slot.after)>0n);
      if(BigInt(slot.after)===0n) delete current.storage[slot.slot]; else current.storage[slot.slot]=quantity(slot.after);
    }
    allocation[row.address]=current;
  }
  return allocation;
}
export function comparePrefix(input, count, expected, observed) {
  const {result,traces,body}=observed; assert.equal(body,input.prefixBodies[count-1]);
  assert.equal(result.receipts.length,count); assert.equal(traces.length,count); assert.deepEqual(result.rejected??[],[]);
  const end=expected[count-1], channels={stateRoot:result.stateRoot===end.stateRoot,logsHash:result.logsHash===end.logsHash,gas:BigInt(result.gasUsed)===BigInt(end.cumulativeGasUsed),execution:true,returnData:true};
  for(let i=0;i<count;i++) {
    const receipt=result.receipts[i],trace=traces[i],request=input.requests[i],e=expected[i];
    assert.equal(receipt.transactionHash,input.signed[i].hash); assert.equal(BigInt(receipt.transactionIndex),BigInt(i));
    assert.equal(trace.type,'CALL'); assert.equal(trace.from,request.from); assert.equal(trace.to,request.to);
    assert.equal(trace.input??'0x',request.data); assert.equal(BigInt(trace.value??0),BigInt(request.value));
    const success=e.execution.status==='success';
    channels.execution&&=(BigInt(receipt.status)===1n)===success&&(trace.error===undefined)===success;
    channels.returnData&&=(trace.output??'0x')===e.execution.returnData;
    channels.gas&&=BigInt(receipt.gasUsed)===BigInt(e.gasUsed)&&BigInt(receipt.cumulativeGasUsed)===BigInt(e.cumulativeGasUsed);
  }
  return{status:Object.values(channels).every(Boolean)?'matched':'mismatched',channels};
}
