// Read-only audit of an already sealed packet. No worker, VM, RPC or replay.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url)),CAPTURE=path.resolve(HERE,'../storage-creation-lifecycle-v035/capture');
const PLAN='0ba3335340a195cc775f4ebf162ea879246ce6dd45c736a2f5ac3f0f3b92607d',MANIFEST='cecb92a4fda58ea2b0646e4f2b332b16c7721e406b551b32adf2c46d2e76e7ff';
const hash=b=>createHash('sha256').update(b).digest('hex'),read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const walk=(base,rel='')=>fs.readdirSync(path.join(base,rel),{withFileTypes:true}).flatMap(e=>{const p=rel?rel+'/'+e.name:e.name;return e.isDirectory()?walk(base,p):[p];}).sort();
function verifyCapture(){
  assert.equal(hash(read(path.join(CAPTURE,'manifest.json'))),MANIFEST);assert.equal(hash(read(path.join(CAPTURE,'plan.json'))),PLAN);
  const manifest=json(path.join(CAPTURE,'manifest.json'));assert.equal(manifest.planSha256,PLAN);assert(manifest.files.length<10000);
  assert.deepEqual(walk(CAPTURE),[...manifest.files.map(r=>r.path),'manifest.json'].sort());let total=0;
  for(const r of manifest.files){
    assert(!path.isAbsolute(r.path)&&!r.path.split('/').includes('..'));const p=path.join(CAPTURE,r.path),s=fs.lstatSync(p);
    if(r.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),r.target);const real=fs.realpathSync(p);assert(real.startsWith(CAPTURE+path.sep));assert.equal(hash(read(real)),r.resolvedSha256);}
    else{assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&511,r.mode);assert.equal(s.size,r.bytes);assert(s.size<=67108864);total+=s.size;assert(total<=536870912);assert.equal(hash(read(p)),r.sha256);}
  }
  return{files:manifest.files.length,regularFileBytes:total};
}
const inventoryBefore=verifyCapture(),plan=json(path.join(CAPTURE,'plan.json'));
const runtime=path.join(CAPTURE,'runtime'),prefix='research/storage-creation-lifecycle-v035';
const {applyCandidateDelta}=await import(pathToFileURL(path.join(runtime,prefix,'delta.mjs')).href);
const {allocationRoot}=await import(pathToFileURL(path.join(runtime,'research/amsterdam-storage-creation-v033/observations.mjs')).href);
const frames=(f,parents=[],indices=[])=>[{frame:f,parents,path:indices},...(f.calls??[]).flatMap((c,i)=>frames(c,[...parents,f],[...indices,i]))];
const productDestruct=(output,target)=>frames(output.trace).filter(({frame:f})=>f.executionAddress===target&&f.selfdestruct);
const productSummary=({frame:f,parents,path:indices})=>({path:indices,type:f.type,address:f.executionAddress,beneficiary:f.selfdestruct?.beneficiary??null,error:f.error,
  ancestorErrors:parents.map(p=>({address:p.executionAddress,error:p.error})),committed:f.error===null&&parents.every(p=>p.error===null)});
const rawSources=[],rows=[];let productContractHalves=0,referenceContractHalves=0,nativeHalves=0,productQueryDestructs=0,referenceQueryDestructs=0;
for(let index=0;index<8;index++){
  const n=String(index+1).padStart(3,'0'),inputPath=plan.inputs[index].path,d=json(path.join(CAPTURE,inputPath)),p=json(path.join(CAPTURE,n+'-product.stdout')),e=json(path.join(CAPTURE,n+'-eels.stdout'));
  for(const rel of[inputPath,n+'-product.stdout',n+'-eels.stdout'])rawSources.push({path:rel,sha256:hash(read(path.join(CAPTURE,rel)))});
  assert.equal(p.id,d.id);assert.equal(e.id,d.id);assert.equal(p.status,'completed');assert.equal(e.status,'completed');
  const preview=p.attempt.preview,original=preview.original.output,pAllocation=await applyCandidateDelta(d,preview.original.changes);
  assert.deepEqual(pAllocation,e.allocation);assert.equal(await allocationRoot(pAllocation),e.stateRoot);
  assert.equal(original.execution.status,'success');assert.equal(e.receipt.status,'success');assert.equal(original.execution.returnData,word(d.target));assert.equal(e.transactionEnd.returnData,word(d.target));
  const creations=frames(original.trace).filter(({frame:f})=>f.type==='CREATE2'&&f.executionAddress===d.target);assert.equal(creations.length,1);
  assert.equal(creations[0].frame.error,null);assert.equal(creations[0].frame.input,d.sentinel.initcode);assert(creations[0].parents.every(f=>f.error===null));
  const committedRead=logs=>logs.filter(l=>l.address===d.target&&l.topics.length===1&&l.topics[0]===d.probes.hiddenRead.logTopic);
  for(const logs of[original.logs,e.receipt.logs]){const selected=committedRead(logs);assert.equal(selected.length,1);assert.equal(selected[0].data,word(0));}
  const row={case:n,id:d.id,fork:d.fork,target:d.target,original:{successfulCreate2:true,productCreation:productSummary(creations[0]),
    committedHiddenRead:'0',referenceOpcodeTraceAvailable:false,referenceReachabilityBasis:'successful_nonzero_CREATE2_return_and_committed_constructor_log_with_frozen_linear_initcode_and_complete_final_state',
    finalAccount:e.allocation[d.target]??null},contractQueries:[],nativeSnapshots:[]};
  if(index<4){assert.equal(creations[0].frame.selfdestruct.beneficiary,d.probes.lifecycle.beneficiary);assert(d.sentinel.initcode.endsWith('ff'));}
  else assert.equal(creations[0].frame.selfdestruct,undefined);
  for(const reference of e.queryReferences){
    const m=preview.measurements[reference.index];assert.deepEqual(reference.template,d.queryTemplates[reference.index]);
    for(const phase of['before','after']){
      const q=reference[phase],observed=m[phase],initial=phase==='before'?d.allocation:e.allocation,root=phase==='before'?d.initialStateRoot:e.stateRoot;
      assert.equal(q.status,'observed');assert.equal(q.inputStateRoot,root);
      if(reference.kind==='native_balance'){
        nativeHalves++;assert(observed);assert.equal(observed.status,'measured');assert.equal(q.balance,BigInt(initial[q.account]?.balance??0).toString());
        assert.deepEqual(await applyCandidateDelta(d,observed.changesBefore),initial);assert.deepEqual(await applyCandidateDelta(d,observed.changesAfter),initial);
        assert.equal(observed.values[0].raw,q.balance);row.nativeSnapshots.push({index:reference.index,phase,account:q.account,balance:q.balance,inputStateRoot:root,unchangedOriginalSnapshot:true});continue;
      }
      referenceContractHalves++;assert.deepEqual(q.initialAllocation,initial);assert.equal(q.senderNonceBefore,BigInt(initial[d.request.from].nonce).toString());
      assert.equal(q.executionStatus,'success');assert.equal(q.returnData,word(42));assert.equal(await allocationRoot(q.allocation),q.stateRoot);
      const target=index===7?d.queryCreation.target:d.target,sd=q.lifecycle.selfdestructs.filter(s=>s.address===target),record={index:reference.index,phase,
        productAttempted:observed!==null,productMeasurementStatus:observed?.status??null,referenceNeutral:q.neutralExceptSenderNonce,
        referenceSelfdestructs:sd,referenceFrames:q.lifecycle.frames,referenceStateRoot:q.stateRoot,inputStateRoot:root,productSelfdestructs:null};
      if(index>=4&&index<=6){assert.equal(sd.length,phase==='before'?0:1);assert.equal(q.targetSelfdestructObserved,phase==='after');}
      else if(index===7){assert.equal(sd.length,1);assert.equal(q.targetSelfdestructObserved,false);}
      for(const s of sd){assert.equal(s.beneficiary,target);assert.equal(s.completed,true);assert.equal(s.error,null);assert.equal(s.frameError,null);referenceQueryDestructs++;}
      if(index===7){
        const s=sd[0],f=q.lifecycle.frames[s.frame],parent=q.lifecycle.frames[f.parent];assert.equal(f.codeAddress,null);assert.equal(parent.address,d.queryCreation.creator);
        assert.equal(parent.error?.type??null,reference.index===0?'Revert':null);assert.equal(s.committed,reference.index===1);
        assert.equal(q.neutralExceptSenderNonce,reference.index===0);
        if(reference.index===0){assert.deepEqual(q.allocation[target],initial[target]);assert.equal(q.allocation[d.queryCreation.creator].nonce,initial[d.queryCreation.creator].nonce);assert.deepEqual(q.logs,[]);}
        else{assert.deepEqual(q.allocation[target].storage,{});assert.equal(q.allocation[target].nonce,'0x0');assert.equal(q.allocation[target].code,'0x');assert.equal(q.allocation[target].balance,initial[target].balance);
          assert.equal(BigInt(q.allocation[d.queryCreation.creator].nonce),BigInt(initial[d.queryCreation.creator].nonce)+1n);
          const logs=q.logs.filter(l=>l.address===target&&l.topics[0]===d.probes.hiddenRead.logTopic);assert.equal(logs.length,1);assert.equal(logs[0].data,word(0));}
      }else if(phase==='after'){assert.equal(sd[0].committed,true);assert.equal(q.neutralExceptSenderNonce,index!==4);}
      if(observed===null){assert.equal(index,7);assert.equal(reference.index,1);assert.equal(phase,'after');assert.equal(m.status,'unavailable');}
      else{
        productContractHalves++;assert(observed.output);assert.equal(observed.output.execution.status,'success');assert.equal(observed.output.execution.returnData,word(42));
        assert.deepEqual(await applyCandidateDelta(d,observed.changesBefore),initial);assert.deepEqual(await applyCandidateDelta(d,observed.changesAfter),q.allocation);
        const selected=productDestruct(observed.output,target);assert.equal(selected.length,sd.length);record.productSelfdestructs=selected.map(productSummary);
        for(const hit of selected){productQueryDestructs++;assert.equal(hit.frame.error,null);assert.equal(hit.frame.selfdestruct.beneficiary,target);
          assert.equal(productSummary(hit).committed,sd[0].committed);if(index===7){assert.equal(hit.frame.type,'CREATE2');assert.equal(hit.frame.input,d.queryCreation.initcode);
            assert.equal(hit.parents.at(-1).executionAddress,d.queryCreation.creator);assert.equal(hit.parents.at(-1).error,reference.index===0?'revert':null);}}
      }
      row.contractQueries.push(record);
    }
  }
  rows.push(row);
}
assert.equal(referenceContractHalves,10);assert.equal(productContractHalves,9);assert.equal(nativeHalves,44);assert.equal(referenceQueryDestructs,7);assert.equal(productQueryDestructs,6);
const inventoryAfter=verifyCapture();assert.deepEqual(inventoryAfter,inventoryBefore);
const report={kind:'saved_lifecycle_path_reachability_audit',status:'passed',targetExecutionInvoked:false,captureModified:false,planSha256:PLAN,manifestSha256:MANIFEST,
  inventoryBefore,inventoryAfter,sourceSha256:hash(read(fileURLToPath(import.meta.url))),rawSources,
  counts:{originals:8,originalProductSelfdestructConstructorFrames:4,referenceContractHalves,productContractHalves,nativeHalves,
    referenceQuerySelfdestructInstructions:referenceQueryDestructs,productQuerySelfdestructInstructions:productQueryDestructs,unpairedReferenceHalves:1},
  limitations:['Read-only saved-artifact checks, not new executions or independent samples.','Original EELS adapter retained no opcode trace; original reference reachability uses actual return/log/state evidence plus frozen linear initcode.',
    'Constant return 42 is never treated as proof that the inner call or CREATE2 succeeded.','Case008 retaining after half has EELS evidence only; product observation remains missing.'],rows};
const out=path.join(HERE,'audit.json');fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const files=['audit.mjs','audit.json'].map(p=>({path:p,bytes:fs.statSync(path.join(HERE,p)).size,sha256:hash(read(path.join(HERE,p)))}));
fs.writeFileSync(path.join(HERE,'manifest.json'),JSON.stringify({kind:report.kind,captureManifestSha256:MANIFEST,files},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,counts:report.counts,auditSha256:files[1].sha256,manifestSha256:hash(read(path.join(HERE,'manifest.json')))}));
