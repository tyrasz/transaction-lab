// Saved-byte projection only: no EVM, reference process, network or query run.
import assert from 'node:assert/strict';
import {isDeepStrictEqual as equal} from 'node:util';
import {createHash} from 'node:crypto';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {validateInputFacts} from '../../engines/local-evm/input-facts.js';
import {allocationRoot, normalizeAllocation, applyDelta, bytes, hex, word} from '../amsterdam-storage-creation-v033/observations.mjs';
import {TOOLCHAIN_SHA256} from './toolchain.mjs';

export const CHANNELS = Object.freeze(['executionStatus','returnData','chargedGas','logs','stateRoot','singleTransactionBlockGasUsed']);
export const DEPENDENCIES = Object.freeze([
  'research/amsterdam-storage-creation-v033/observations.mjs',
  'research/local-sequence-v036-reference-v2/toolchain.mjs',
  'research/storage-creation-lifecycle-v035/toolchain.mjs',
  'engines/local-evm/input-facts.js', 'engines/local-evm/isolated-protocol.js',
  'engines/local-evm/verified-state-proof.js',
]);
const sha = raw => createHash('sha256').update(raw).digest('hex');
const dec = (x,max=(1n<<256n)-1n) => {assert.equal(typeof x,'string');assert.match(x,/^(0|[1-9][0-9]*)$/);assert(BigInt(x)<=max);return BigInt(x);};
const qty = (x,max=(1n<<256n)-1n) => {assert.equal(typeof x,'string');assert.match(x,/^0x(0|[1-9a-f][0-9a-f]*)$/);assert(BigInt(x)<=max);return BigInt(x);};
const data = x => {assert.equal(typeof x,'string');assert.match(x,/^0x(?:[0-9a-f]{2})*$/);assert(x.length<=131074);return x;};
const address = x => {assert.equal(typeof x,'string');assert.match(x,/^0x[0-9a-f]{40}$/);return x;};
const hash = x => {assert.equal(typeof x,'string');assert.match(x,/^0x[0-9a-f]{64}$/);return x;};
const fields = (x, names) => {assert(x&&typeof x==='object'&&!Array.isArray(x));assert.deepEqual(Object.keys(x).sort(),[...names].sort());};
const int = n => n===0n?new Uint8Array():bytes('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));
const emptyChannels = () => Object.fromEntries(CHANNELS.map(k=>[k,null]));

export function validateLogs(logs) {
  assert(Array.isArray(logs)&&logs.length<=1024);
  for(const l of logs){fields(l,['address','topics','data']);address(l.address);data(l.data);assert(Array.isArray(l.topics)&&l.topics.length<=4);l.topics.forEach(hash);}
  const rlp=logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]),bloom=Buffer.alloc(256);
  for(const l of logs)for(const value of [l.address,...l.topics]){const h=keccak(bytes(value));for(let i=0;i<6;i+=2){const n=((h[i]<<8)|h[i+1])&2047;bloom[255-(n>>3)]|=1<<(n&7);}}
  return {rlp,bloom:hex(bloom),logsHash:hex(keccak(RLP.encode(rlp)))};
}
async function fullAllocation(allocation, root) {
  assert(allocation&&typeof allocation==='object'&&!Array.isArray(allocation));assert(Object.keys(allocation).length<=64);let slots=0;
  for(const [a,row] of Object.entries(allocation)){
    address(a);fields(row,['nonce','balance','code','storage']);qty(row.nonce,(1n<<64n)-1n);qty(row.balance);data(row.code);
    assert(row.storage&&typeof row.storage==='object'&&!Array.isArray(row.storage));
    for(const[k,v]of Object.entries(row.storage)){hash(k);hash(v);assert(BigInt(v)>0n);assert(++slots<=1024);}
  }
  assert.deepEqual(normalizeAllocation(allocation),allocation);assert.equal(await allocationRoot(allocation),hash(root));return allocation;
}
function bindInputHash(report, expected) {
  assert.match(report.inputSha256,/^[0-9a-f]{64}$/);
  if(expected!==undefined)assert.equal(report.inputSha256,expected);
}
function simpleDelta(input, changes) {
  assert(changes&&Array.isArray(changes.accounts));
  for(const row of changes.accounts){assert.equal(Object.hasOwn(row,'reset'),false,'Namespace reset is outside this fixture');assert.notEqual(row.existence?.after,false,'Deletion is outside this fixture');assert.equal(row.code,undefined,'Code replacement is outside this fixture');
    const storage=Object.hasOwn(row,'storage')?row.storage:[];assert(Array.isArray(storage));const slots=new Set();for(const slot of storage){hash(slot.slot);hash(slot.before);hash(slot.after);assert(!slots.has(slot.slot),'Duplicate cumulative storage slot');slots.add(slot.slot);}}
  return applyDelta(input.allocation,changes);
}
function factsMatchAllocation(input, inputs) {
  assert.equal(inputs.context.blockHash,input.headerHash);assert.equal(inputs.context.stateRoot,input.initialStateRoot);assert.equal(inputs.context.chainId,input.chainId);
  assert.deepEqual(inputs.context.header,input.header);
  for(const[a,fact]of Object.entries(inputs.accounts)){
    const row=input.allocation[a];assert.equal(fact.exists,!!row);
    if(row){assert.equal(BigInt(fact.nonce),BigInt(row.nonce));assert.equal(BigInt(fact.balance),BigInt(row.balance));assert.equal(fact.code,row.code);
      for(const[k,v]of Object.entries(fact.storage))assert.equal(BigInt(v),BigInt(row.storage[k]??0));}
  }
}

export async function productObservation(input, report, {inputSha256} = {}) {
  await fullAllocation(input.allocation,input.initialStateRoot);
  assert.equal(report.id,input.id);assert.equal(report.status,'completed');bindInputHash(report,inputSha256);
  assert.equal(report.scope,'frozen_four_case_unsigned_product_sequence');assert.equal(report.expectedPoststateConsumed,false);assert.equal(report.otherClientOutputsConsumed,false);
  assert(Number.isSafeInteger(report.workerPid)&&report.workerPid>0);assert.equal(report.processClosureValid,true);
  const a=report.attempt;assert.equal(a.status,'completed');assert.equal(a.error,null);
  assert.equal(a.isolation.processSeparated,true);assert.equal(a.isolation.processClosed,true);assert.equal(a.isolation.exitCode,0);assert.equal(a.isolation.exitSignal,null);
  assert(Number.isSafeInteger(a.isolation.childPid)&&a.isolation.childPid>0&&a.isolation.childPid!==report.workerPid);assert.equal(a.broker.pendingAtReturn,0);
  const s=a.sequence;assert(['complete','partial','unavailable'].includes(s.status));assert.equal(s.steps.length,3);
  assert.equal(s.scope.atomic,false);assert.equal(s.scope.sameHeader,true);assert.equal(s.scope.stateFeeds,'originals_only');assert.equal(s.scope.ordering,'all_originals_before_disposable_queries');
  assert.equal(s.scope.chainId,input.chainId);assert.equal(s.scope.stopOn,'first_original_non_success');
  assert(Array.isArray(report.proofRecords)&&report.proofRecords.length<=256);assert.equal(s.inputEvidence.length,report.proofRecords.length);
  assert.equal(a.broker.records.length,report.proofRecords.length);
  for(const[i,e]of s.inputEvidence.entries()){
    const raw=report.proofRecords[i],broker=a.broker.records[i];assert.equal(e.id,i+1);assert.deepEqual(e.request,{method:raw.method,params:raw.params});
    assert.deepEqual(broker.request,e.request);assert.equal(broker.id,e.id);
    if(e.status==='received'){assert(Object.hasOwn(raw,'result'));assert.deepEqual(e.result,raw.result);const text=JSON.stringify(raw.result);
      assert.equal(broker.status,'received');assert.equal(broker.resultSha256,sha(text));assert.equal(broker.resultBytes,Buffer.byteLength(text));}
  }
  assert.equal(s.inputUsage.calls,s.inputEvidence.length);factsMatchAllocation(input,s.inputs);
  // Shared production proof verifier, explicitly not another execution engine.
  await validateInputFacts({inputs:s.inputs,inputEvidence:s.inputEvidence,stateRoot:input.initialStateRoot,chainId:input.chainId});
  let priorAllocation=input.allocation,priorRoot=input.initialStateRoot,priorChanges=null,stopped=false;
  const rows=[];
  for(const[position,step]of s.steps.entries()){
    assert.equal(step.index,position);assert.deepEqual(step.request,input.steps[position].request);
    assert(['completed','unavailable','not_attempted'].includes(step.status));
    const row={position,disposition:step.status,observation:null};rows.push(row);
    if(stopped){assert.equal(step.status,'not_attempted');assert.equal(step.original,null);continue;}
    if(step.status==='not_attempted'){assert.equal(step.original,null);stopped=true;continue;}
    const original=step.original;
    if(original){
      assert.deepEqual(original.inputEvidence,s.inputEvidence.slice(0,original.inputUsage.calls));factsMatchAllocation(input,original.inputs);
      await validateInputFacts({inputs:original.inputs,inputEvidence:original.inputEvidence,stateRoot:input.initialStateRoot,chainId:input.chainId});
      if(priorChanges)assert.deepEqual(original.startingChanges,priorChanges);
      else assert.deepEqual(original.startingChanges.accounts,[]);
      assert.deepEqual(simpleDelta(input,original.startingChanges),priorAllocation);
    }
    if(step.status!=='completed'){if(original)assert.deepEqual(original.changes,original.startingChanges);stopped=true;continue;}
    assert(original?.output);const o=original.output;assert(['success','reverted','failed'].includes(o.execution.status));data(o.execution.returnData);
    const allocation=simpleDelta(input,original.changes),root=await allocationRoot(allocation);
    const gas=dec(o.gasAccounting.gasUsed,BigInt(step.request.gas)),blockGas=input.fork==='Amsterdam'?dec(o.gasAccounting.singleTransactionBlockGasUsed,BigInt(step.request.gas)):gas;
    validateLogs(o.logs);assert.equal(o.feeAccounting.kind,'eip1559');assert.equal(dec(o.feeAccounting.chargedGas),gas);assert.equal(dec(o.feeAccounting.gasCharge),gas*10n);
    assert.equal(dec(o.feeAccounting.coinbaseTip),gas*3n);assert.equal(dec(o.feeAccounting.baseFeeBurn),gas*7n);assert.equal(o.feeAccounting.coinbase,input.header.miner);
    assert.equal(BigInt(allocation[input.sender].nonce),BigInt(priorAllocation[input.sender].nonce)+1n);
    assert.equal(BigInt(allocation[input.sender].balance),BigInt(priorAllocation[input.sender].balance)-gas*10n);
    assert.equal(BigInt(allocation[input.header.miner]?.balance??0),BigInt(priorAllocation[input.header.miner]?.balance??0)+gas*3n);
    for(const address of input.amendment.addresses)assert.deepEqual(allocation[address],input.allocation[address]);
    row.observation={completedExecution:true,executionStatus:o.execution.status,returnData:o.execution.returnData,chargedGas:gas.toString(),logs:o.logs,
      startingStateRoot:priorRoot,stateRoot:root,singleTransactionBlockGasUsed:blockGas.toString(),allocation};
    priorAllocation=allocation;priorRoot=root;priorChanges=original.changes;stopped=o.execution.status!=='success';
  }
  if(s.status==='complete')assert(rows.every(r=>r.disposition==='completed'&&r.observation.executionStatus==='success'));
  return{id:input.id,status:s.status,steps:rows,finalStateRoot:priorRoot,queriesCompared:false,proofVerifier:'shared_production_validateInputFacts_no_execution'};
}

async function referenceStep(input, position, out, priorRoot) {
  const declared=input.steps[position];assert.equal(out.startingStateRoot,priorRoot);
  const allocation=await fullAllocation(out.allocation,out.stateRoot);for(const a of input.amendment.addresses)assert.deepEqual(allocation[a],input.allocation[a]);
  const charged=dec(out.chargedGas,BigInt(declared.request.gas)),logs=validateLogs(out.logs);assert.equal(out.logsHash,logs.logsHash);
  const receipt=bytes(data(out.receiptBytes));assert.equal(receipt[0],2);const decoded=RLP.decode(receipt.slice(1));assert(Array.isArray(decoded)&&decoded.length===4);
  assert.equal(hex(RLP.encode(decoded)),hex(receipt.slice(1)));const successful=hex(decoded[0])==='0x01';assert(successful||hex(decoded[0])==='0x');
  assert.equal(hex(decoded[1]),hex(int(charged)));assert.equal(hex(decoded[2]),logs.bloom);assert.deepEqual(decoded[3],logs.rlp);
  for(const[payload,claimed]of[[receipt,out.receiptsRoot],[bytes(declared.signedBytes),out.transactionsRoot]]){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);assert.equal(hex(trie.root()),hash(claimed));}
  const blockGas=dec(out.singleTransactionBlockGasUsed,BigInt(declared.request.gas));
  if(input.fork==='Amsterdam'){const regular=dec(out.regularGasUsed,BigInt(declared.request.gas)),state=dec(out.stateGasUsed,BigInt(declared.request.gas));assert.equal(blockGas,regular>state?regular:state);}
  else{assert.equal(out.regularGasUsed,null);assert.equal(out.stateGasUsed,null);assert.equal(blockGas,charged);}
  assert.equal(out.transactionEndGasMeaning,'grant_minus_remaining_before_refund_and_floor_not_receipt_gas');
  let executionStatus=successful?'success':null,returnData=null;
  if(out.transactionEnd===null){assert.equal(out.returnDataAvailability,'unavailable_no_TransactionEnd_event');assert.equal(out.returnData,null);}
  else{const t=out.transactionEnd;fields(t,['error','gasUsed','returnData']);assert.equal(out.returnDataAvailability,'official_TransactionEnd');
    assert.equal(typeof t.gasUsed,'string');assert.match(t.gasUsed,/^-?(0|[1-9][0-9]*)$/);returnData=data(t.returnData);assert.equal(out.returnData,returnData);assert.equal(t.error===null,successful);
    if(t.error!==null){fields(t.error,['type','message']);assert.equal(typeof t.error.type,'string');assert(t.error.type.length>0&&t.error.type.length<=128);assert.equal(typeof t.error.message,'string');assert(t.error.message.length<=2048);executionStatus=t.error.type==='Revert'?'reverted':'failed';}}
  assert.equal(out.executionStatus,executionStatus);assert(Array.isArray(out.storageClears)&&out.storageClears.length===0,'Creation/deletion outside fixed fixture');
  assert(Number.isSafeInteger(out.traceEvents)&&out.traceEvents>=0&&out.traceEvents<=200000);
  return{completedExecution:true,executionStatus,returnData,chargedGas:charged.toString(),logs:out.logs,stateRoot:out.stateRoot,startingStateRoot:priorRoot,
    singleTransactionBlockGasUsed:blockGas.toString(),allocation,receiptSuccess:successful};
}
export async function eelsObservation(input, report, {inputSha256} = {}) {
  await fullAllocation(input.allocation,input.initialStateRoot);
  assert.equal(report.id,input.id);assert.equal(report.fork,input.fork);assert(['completed','unavailable'].includes(report.status));bindInputHash(report,inputSha256);
  assert.equal(report.toolchainSha256,TOOLCHAIN_SHA256);assert.deepEqual(report.scope,input.scope);assert.equal(report.initialStateRoot,input.initialStateRoot);
  assert.equal(report.originalStateRoot,input.originalStateRoot);assert.equal(report.headerHash,input.headerHash);assert.deepEqual(report.environment,input.environment);
  assert.deepEqual(report.signedInputHashes,input.steps.map(s=>s.transactionHash));assert.equal(report.headerValidation,'full_header_RLP_hash_and_environment_only_not_consensus_or_full_block_validation');
  assert.equal(typeof report.sourceModule,'string');assert(report.sourceModule.endsWith('/source/src/ethereum/forks/'+input.fork.toLowerCase()+'/fork.py'));
  assert(Array.isArray(report.steps)&&report.steps.length===3);let priorRoot=input.initialStateRoot,stopped=false;const rows=[];
  for(const[position,step]of report.steps.entries()){
    assert.equal(step.position,position);assert.equal(step.transactionHash,input.steps[position].transactionHash);assert(['completed','unavailable','not_attempted'].includes(step.status));
    const row={position,disposition:step.status,observation:null};rows.push(row);
    if(stopped){assert.equal(step.status,'not_attempted');assert.equal(step.observation,null);continue;}
    if(step.status!=='completed'){assert.equal(step.observation,null);stopped=true;continue;}
    row.observation=await referenceStep(input,position,step.observation,priorRoot);priorRoot=row.observation.stateRoot;stopped=!row.observation.receiptSuccess;
  }
  assert.equal(report.finalStateRoot,priorRoot);return{id:input.id,status:report.status,steps:rows,finalStateRoot:priorRoot,queriesCompared:false};
}
export function comparePair(a,b){return Object.fromEntries(CHANNELS.map(k=>[k,!a?.completedExecution||!b?.completedExecution||a[k]==null||b[k]==null?null:equal(a[k],b[k])]));}
export function compareSequence(input, product, eels) {
  for(const o of [product,eels])if(o){assert.equal(o.id,input.id);assert.equal(o.steps.length,3);o.steps.forEach((r,i)=>assert.equal(r.position,i));}
  const rows=input.steps.map((step,position)=>{
    const p=product?.steps[position],e=eels?.steps[position];
    return{position,method:step.method,productDisposition:p?.disposition??'unavailable',referenceDisposition:e?.disposition??'unavailable',
      dispositionMatches:p&&e?p.disposition===e.disposition:null,channels:p?.disposition==='completed'&&e?.disposition==='completed'?comparePair(p.observation,e.observation):emptyChannels()};
  });
  const pattern=o=>o?.steps.map(r=>({position:r.position,disposition:r.disposition,nonSuccess:typeof r.observation?.receiptSuccess==='boolean'?!r.observation.receiptSuccess:r.observation?.completedExecution&&r.observation.executionStatus!==null?r.observation.executionStatus!=='success':null}))??null;
  return{id:input.id,positions:3,rows,stopConsistency:product&&eels?equal(pattern(product),pattern(eels)):null,
    matchedChannels:rows.flatMap(r=>Object.values(r.channels)).filter(v=>v===true).length,
    mismatchedChannels:rows.flatMap(r=>Object.values(r.channels)).filter(v=>v===false).length,
    unavailableChannels:rows.flatMap(r=>Object.values(r.channels)).filter(v=>v===null).length,queriesCompared:false};
}
