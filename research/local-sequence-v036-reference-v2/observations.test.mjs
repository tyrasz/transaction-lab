// Fabricated saved-result controls plus initial-proof reads only. No transaction
// is executed. These internally consistent observations are not reference data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {declaration, fixture} from './cases.mjs';
import {CHANNELS,validateLogs,productObservation,eelsObservation,compareSequence} from './observations.mjs';
import {TOOLCHAIN_SHA256} from './toolchain.mjs';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {applyDelta,allocationRoot,bytes,hex,word} from '../amsterdam-storage-creation-v033/observations.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),q=x=>'0x'+BigInt(x).toString(16);
const int=n=>n===0n?new Uint8Array():bytes('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));
const cache=new Map();
async function fabricated(index=0){
  if(cache.has(index))return structuredClone(await cache.get(index));
  const promise=(async()=>{
    const input=await declaration(index),f=await fixture(index),inputSha256=sha(JSON.stringify(input));
    // Actual initial-only proof/code generation, without any VM call.
    for(const a of [input.sender,input.addresses.token,input.addresses.vault,input.header.miner])await f.inputs.getCode(a);
    await f.inputs.getStorage(input.addresses.token,input.slots.senderVaultAllowance);
    const inputs=f.inputs.snapshotInputs(),inputEvidence=f.inputs.snapshotEvidence(),inputUsage=f.inputs.snapshotUsage();
    const proofRecords=inputEvidence.map(e=>({...structuredClone(e.request),result:structuredClone(e.result)}));
    const broker={pendingAtReturn:0,records:proofRecords.map((r,i)=>({id:i+1,request:{method:r.method,params:r.params},status:'received',
      resultSha256:sha(JSON.stringify(r.result)),resultBytes:Buffer.byteLength(JSON.stringify(r.result))}))};
    const sequence={status:index<2?'complete':'partial',scope:{atomic:false,sameHeader:true,stateFeeds:'originals_only',ordering:'all_originals_before_disposable_queries',chainId:input.chainId,stopOn:'first_original_non_success'},
      inputEvidence,inputs,inputUsage,steps:[]};
    const product={id:input.id,inputSha256,workerPid:100,scope:'frozen_four_case_unsigned_product_sequence',expectedPoststateConsumed:false,otherClientOutputsConsumed:false,status:'completed',
      attempt:{status:'completed',error:null,isolation:{processSeparated:true,processClosed:true,exitCode:0,exitSignal:null,childPid:101},broker,sequence},proofRecords,processClosureValid:true};
    const reference={id:input.id,inputSha256,fork:input.fork,status:'completed',toolchainSha256:TOOLCHAIN_SHA256,scope:input.scope,
      initialStateRoot:input.initialStateRoot,originalStateRoot:input.originalStateRoot,headerHash:input.headerHash,environment:input.environment,
      signedInputHashes:input.steps.map(s=>s.transactionHash),headerValidation:'full_header_RLP_hash_and_environment_only_not_consensus_or_full_block_validation',
      sourceModule:'/synthetic/source/src/ethereum/forks/'+input.fork.toLowerCase()+'/fork.py',steps:[]};
    let changes={scope:'cumulative_immutable_initial',accounts:[]},root=input.initialStateRoot;
    const charged=30000n;
    for(let position=0;position<3;position++){
      if(index>=2&&position===2){sequence.steps.push({index:position,request:input.steps[position].request,status:'not_attempted',original:null});reference.steps.push({position,transactionHash:input.steps[position].transactionHash,status:'not_attempted',observation:null});continue;}
      const status=index>=2&&position===1?'reverted':'success',startingChanges=structuredClone(changes),total=charged*BigInt(position+1);
      changes={scope:changes.scope,accounts:[
        {address:input.sender,nonce:{before:input.allocation[input.sender].nonce,after:q(position+2)},balance:{before:input.allocation[input.sender].balance,after:q(BigInt(input.allocation[input.sender].balance)-total*10n)},storage:[]},
        {address:input.header.miner,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:q(total*3n)},storage:[]},
        {address:input.addresses.token,storage:[{slot:input.slots.senderVaultAllowance,before:word(0),after:word(100)}]},
      ]};
      const allocation=applyDelta(input.allocation,changes),stateRoot=await allocationRoot(allocation),logs=position===0?[{address:input.addresses.token,topics:['0x'+'12'.repeat(32)],data:word(100)}]:[];
      const blockGas=input.fork==='Amsterdam'?25000n:charged;
      const output={execution:{status,returnData:'0x'},gasAccounting:{gasUsed:charged.toString(),...(input.fork==='Amsterdam'?{singleTransactionBlockGasUsed:blockGas.toString()}: {})},logs,
        feeAccounting:{kind:'eip1559',chargedGas:charged.toString(),gasCharge:(charged*10n).toString(),coinbaseTip:(charged*3n).toString(),baseFeeBurn:(charged*7n).toString(),coinbase:input.header.miner}};
      sequence.steps.push({index:position,request:input.steps[position].request,status:'completed',original:{output,startingChanges,changes:structuredClone(changes),inputs,inputEvidence,inputUsage}});
      const parsed=validateLogs(logs),receipt=Uint8Array.from([2,...RLP.encode([int(status==='success'?1n:0n),int(charged),bytes(parsed.bloom),parsed.rlp])]);
      const roots=[];for(const payload of [receipt,bytes(input.steps[position].signedBytes)]){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);roots.push(hex(trie.root()));}
      reference.steps.push({position,transactionHash:input.steps[position].transactionHash,status:'completed',observation:{executionStatus:status,startingStateRoot:root,stateRoot,allocation,
        chargedGas:charged.toString(),logs,logsHash:parsed.logsHash,receiptBytes:hex(receipt),receiptsRoot:roots[0],transactionsRoot:roots[1],
        transactionEnd:{returnData:'0x',gasUsed:'9000',error:status==='success'?null:{type:'Revert',message:''}},returnData:'0x',returnDataAvailability:'official_TransactionEnd',
        transactionEndGasMeaning:'grant_minus_remaining_before_refund_and_floor_not_receipt_gas',regularGasUsed:input.fork==='Amsterdam'?'25000':null,stateGasUsed:input.fork==='Amsterdam'?'5000':null,
        singleTransactionBlockGasUsed:blockGas.toString(),storageClears:[],traceEvents:123}});
      root=stateRoot;
    }
    reference.finalStateRoot=root;
    return{input,product,reference,inputSha256};
  })();cache.set(index,promise);return structuredClone(await promise);
}

test('fabricated four-sequence comparisons bind full roots, proofs, receipts, six channels and stop rows',async()=>{
  let matched=0,nulls=0;
  for(let i=0;i<4;i++){
    const {input,product,reference,inputSha256}=await fabricated(i),options={inputSha256};
    const p=await productObservation(input,product,options),e=await eelsObservation(input,reference,options),comparison=compareSequence(input,p,e);
    assert.equal(comparison.positions,3);assert.equal(comparison.stopConsistency,true);assert(comparison.rows.every(r=>r.dispositionMatches===true));
    assert.equal(comparison.matchedChannels,i<2?18:12);assert.equal(comparison.unavailableChannels,i<2?0:6);assert.equal(comparison.mismatchedChannels,0);
    if(i>=2)assert(Object.values(comparison.rows[2].channels).every(x=>x===null));matched+=comparison.matchedChannels;nulls+=comparison.unavailableChannels;
  }
  assert.equal(matched,60);assert.equal(nulls,12);assert.equal(CHANNELS.length,6);
});

test('reference refuses changed full allocation, receipt gas/logs, transaction root and carry root',async()=>{
  for(const mutate of [
    r=>{r.steps[1].observation.allocation['0x'+'71'.repeat(20)].nonce='0x2';},
    r=>{r.steps[0].observation.chargedGas='30001';},
    r=>{r.steps[0].observation.logs[0].data=word(101);},
    r=>{r.steps[1].observation.transactionsRoot=r.steps[0].observation.transactionsRoot;},
    r=>{r.steps[1].observation.startingStateRoot=r.initialStateRoot;},
    r=>{r.steps[1].observation.regularGasUsed='25001';},
  ]){const f=await fabricated(1);mutate(f.reference);await assert.rejects(eelsObservation(f.input,f.reference,{inputSha256:f.inputSha256}));}
});

test('reference does not turn missing fields or root terminal data into zero values',async()=>{
  const f=await fabricated(0);delete f.reference.steps[0].observation.allocation[f.input.sender].nonce;
  await assert.rejects(eelsObservation(f.input,f.reference));
  const g=await fabricated(2),o=g.reference.steps[1].observation;o.transactionEnd=null;o.returnData=null;o.executionStatus=null;o.returnDataAvailability='unavailable_no_TransactionEnd_event';
  const p=await productObservation(g.input,g.product),e=await eelsObservation(g.input,g.reference),c=compareSequence(g.input,p,e);
  assert.equal(c.rows[1].channels.returnData,null);assert.equal(c.rows[1].channels.executionStatus,null);assert.equal(c.stopConsistency,true);
  assert.equal(c.matchedChannels,10);assert.equal(c.unavailableChannels,8);
});

test('product refuses initial-proof poisoning, carried-state substitution, cumulative-delta misuse and fee disagreement',async()=>{
  for(const mutate of [
    f=>{f.product.proofRecords[0].result.nonce='0x9';},
    f=>{f.product.attempt.sequence.steps[1].original.startingChanges=f.product.attempt.sequence.steps[0].original.startingChanges;},
    f=>{f.product.attempt.sequence.steps[1].original.changes.accounts[0].balance.before=f.product.attempt.sequence.steps[0].original.changes.accounts[0].balance.after;},
    f=>{f.product.attempt.sequence.steps[1].original.output.feeAccounting.gasCharge='300001';},
    f=>{f.product.processClosureValid=false;},
  ]){const f=await fabricated();mutate(f);await assert.rejects(productObservation(f.input,f.product,{inputSha256:f.inputSha256}));}
});

test('extra reset semantics and unbound input hashes are rejected, while query changes cannot alter comparison',async()=>{
  const f=await fabricated();f.product.attempt.sequence.steps[1].original.changes.accounts[2].reset={basis:'contract_creation_storage_clear',initialStorageRoot:'0x'+'00'.repeat(32)};
  await assert.rejects(productObservation(f.input,f.product));
  const g=await fabricated();await assert.rejects(productObservation(g.input,g.product,{inputSha256:'0'.repeat(64)}));
  await assert.rejects(eelsObservation(g.input,g.reference,{inputSha256:'0'.repeat(64)}));
  const p=await productObservation(g.input,g.product);g.product.attempt.sequence.steps.forEach(s=>{s.measurements=[{status:'measured',values:['ignored query evidence']}];});
  assert.deepEqual(await productObservation(g.input,g.product),p);
});

test('fixed denominator and separate disposition comparison survive missing reference or different stop position',async()=>{
  const f=await fabricated(2),p=await productObservation(f.input,f.product),e=await eelsObservation(f.input,f.reference);
  const missing=compareSequence(f.input,p,null);assert.equal(missing.rows.length,3);assert.equal(missing.unavailableChannels,18);assert.equal(missing.stopConsistency,null);
  e.steps[1]={position:1,disposition:'unavailable',observation:null};const changed=compareSequence(f.input,p,e);
  assert.equal(changed.rows[1].dispositionMatches,false);assert.equal(changed.stopConsistency,false);assert.equal(changed.matchedChannels,6);assert.equal(changed.unavailableChannels,12);
});

test('a non-success observation cannot be followed by another completed execution',async()=>{
  const f=await fabricated(2),g=await fabricated(0);f.product.attempt.sequence.steps[2]=g.product.attempt.sequence.steps[2];
  await assert.rejects(productObservation(f.input,f.product));
  f.reference.steps[2]=g.reference.steps[2];await assert.rejects(eelsObservation(f.input,f.reference));
});

test('duplicate identical cumulative storage slots cannot pass merely because their full root is unchanged',async()=>{
  const f=await fabricated(),storage=f.product.attempt.sequence.steps[0].original.changes.accounts[2].storage;
  storage.push(structuredClone(storage[0]));
  await assert.rejects(productObservation(f.input,f.product),/Duplicate cumulative storage slot/);
});

test('omitted storage on nonce/balance-only rows is valid but explicit null remains malformed',async()=>{
  const f=await fabricated();for(const step of f.product.attempt.sequence.steps)for(const changes of[step.original.startingChanges,step.original.changes])for(const row of changes.accounts)if(row.storage?.length===0)delete row.storage;
  const p=await productObservation(f.input,f.product);assert.equal(p.steps.filter(r=>r.observation).length,3);
  f.product.attempt.sequence.steps[0].original.changes.accounts[0].storage=null;
  await assert.rejects(productObservation(f.input,f.product));
});

test('actual first-capture product rows with omitted storage validate as retained evidence, not new execution',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),base=path.join(root,'research/local-sequence-v036-reference/capture');
  const planRaw=fs.readFileSync(path.join(base,'plan.json')),manifestRaw=fs.readFileSync(path.join(base,'manifest.json'));
  assert.equal(sha(planRaw),'76fb2f64a719f5e577869a43f915e4b555547bf85f1b6a8d769e96de5d557030');
  assert.equal(sha(manifestRaw),'adad620ff6b97af186670c3af46b40e662539a167ef392bb9c1b5be84f10b6b9');
  const plan=JSON.parse(planRaw),manifest=JSON.parse(manifestRaw);let completed=0,skipped=0,omitted=0;
  for(let index=0;index<4;index++){
    const inputRaw=fs.readFileSync(path.join(base,plan.inputs[index].path));assert.equal(sha(inputRaw),plan.inputs[index].sha256);
    const name=String(index+1).padStart(3,'0')+'-product.stdout',raw=fs.readFileSync(path.join(base,name));assert.equal(sha(raw),manifest.files.find(f=>f.path===name).sha256);
    const input=JSON.parse(inputRaw),report=JSON.parse(raw),p=await productObservation(input,report,{inputSha256:plan.inputs[index].sha256});
    completed+=p.steps.filter(r=>r.disposition==='completed').length;skipped+=p.steps.filter(r=>r.disposition==='not_attempted').length;
    omitted+=report.attempt.sequence.steps.flatMap(s=>s.original?.changes.accounts??[]).filter(r=>!Object.hasOwn(r,'storage')).length;
    assert.deepEqual(p.steps.map(s=>s.disposition),index<2?['completed','completed','completed']:['completed','completed','not_attempted']);
  }
  assert.equal(completed,10);assert.equal(skipped,2);assert(omitted>0);
});
