import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import timersPromises from 'node:timers/promises';
import { createTimingGate, freezeRun, loadPlan, executeCases, withholdCaseMetrics, POLICY } from './run.mjs';
import { createArtifactWriter, sealEvidence } from './artifacts.mjs';
import { createCohortSelection, accountCohortOutcomes } from '../standard-evm/cohort-accounting.mjs';
import { verifyTiming } from './verify.mjs';
const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url))),sha=v=>createHash('sha256').update(v).digest('hex');
const temp=t=>{const d=mkdtempSync('/tmp/ordinary-local-test-');t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};

test('absolute deadline, backwards clocks and excessive wait gaps close the gate without new targets',()=>{
  let wall=1000,mono=0;const gate=createTimingGate({wallStart:wall,monotonicStart:mono,now:()=>wall,monotonic:()=>mono});
  assert.equal(gate.remaining(),POLICY.collectionAndExecutionMs);wall+=POLICY.collectionAndExecutionMs;assert.equal(gate.remaining(),0);assert.throws(()=>gate.checkWait(wall));
  wall=1000;const gap=createTimingGate({wallStart:wall,monotonicStart:0,now:()=>wall,monotonic:()=>0});wall=121002;assert.throws(()=>gap.checkWait(61000));assert.equal(gap.violation().code,'wait_overrun');
  wall=1000;const bad=createTimingGate({wallStart:wall,monotonicStart:0,now:()=>wall,monotonic:()=>0});wall--;assert.equal(bad.remaining(),0);assert.equal(bad.violation().code,'clock_invalid');
});

test('both phase clocks and terminal global clocks independently withhold late completion',()=>{
 for(const clock of ['wall','monotonic']){
  let wall=1000,mono=0;const gate=createTimingGate({wallStart:wall,monotonicStart:mono,now:()=>wall,monotonic:()=>mono});
  const phase=gate.beginPhase('local',POLICY.localWallMs);
  if(clock==='wall')wall+=POLICY.localWallMs+1;else mono+=POLICY.localWallMs+1;
  const timing=gate.endPhase(phase);assert.equal(timing.withinBudget,false);assert.equal(gate.violation().code,'phase_deadline');assert.equal(gate.remaining(),0);
  assert.equal(verifyTiming(timing,'local',POLICY.localWallMs).withinBudget,false);
  assert.throws(()=>verifyTiming({...timing,withinBudget:true},'local',POLICY.localWallMs));
  assert.throws(()=>verifyTiming({...timing,limitMs:timing.limitMs+1},'local',POLICY.localWallMs));
 }
 let wall=1000,mono=0;const gate=createTimingGate({wallStart:wall,monotonicStart:mono,now:()=>wall,monotonic:()=>mono});
 wall+=POLICY.collectionAndExecutionMs+1;assert.equal(gate.snapshot().withinBudget,false);assert.equal(gate.violation().code,'absolute_deadline');
});

test('durable artifact writer rejects overwrite and sealing binds every non-runtime file',t=>{
 const d=temp(t),w=createArtifactWriter(d);w.write('local.json',{exact:'value'});const sealed=sealEvidence(d,'a'.repeat(64),'b'.repeat(64));assert.equal(sealed.manifestSha256,sha(readFileSync(join(d,'evidence-manifest.json'))));assert.throws(()=>w.write('local.json',{}),{code:'artifact_save_failed'});
});

// Offline only: synthetic future blocks/clock and exact archived proof/code
// responses. The oracle answers are synthetic reuse of a prior saved trace;
// this validates plumbing, not a new independent accuracy observation.
test('real frozen worker retains exact oracle bytes on success and late final response; audit never promotes late metrics',async t=>{
 for(const delayed of [false,true]){
 const dir=temp(t),out=join(dir,'capture'),source=new URL('../../reports/ethereum-lending-local-reference/',import.meta.url);
 const mb=readFileSync(new URL('manifest.json',source));assert.equal(sha(mb),'34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');const manifest=JSON.parse(mb);
 const read=name=>{const b=readFileSync(new URL(name,source));assert.equal(sha(b),manifest.files.find(r=>r.path===name).sha256);return JSON.parse(b);};
 const old=read('plan.json').cases[0],local=read(old.id+'-local.json'),product=read(old.id+'-product.json');
 const require=createRequire(new URL('../../engines/local-evm/package.json',import.meta.url));
 const{RLP}=await import(require.resolve('@ethereumjs/rlp')),{keccak_256}=await import(require.resolve('@noble/hashes/sha3.js'));
 const q=n=>'0x'+BigInt(n).toString(16),empty='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
 const order=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'],ints=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
 const headers=[structuredClone(old.header)];
 for(let i=1;i<=3;i++){const h={...structuredClone(old.header),parentHash:headers.at(-1).hash,number:q(BigInt(old.header.number)+BigInt(i)),timestamp:q(BigInt(old.header.timestamp)+BigInt(12*i)),transactions:[],transactionsRoot:i===1?old.header.transactionsRoot:empty,gasUsed:i===1?'0x2e54f':'0x0',blobGasUsed:'0x0'};
 h.hash='0x'+Buffer.from(keccak_256(RLP.encode(order.map(k=>{let v=h[k].slice(2);if(ints.has(k)){v=BigInt(h[k])===0n?'':BigInt(h[k]).toString(16);if(v.length%2)v='0'+v;}return Buffer.from(v,'hex');})))).toString('hex');headers.push(h);}
 const h1=headers[1];h1.transactions=[{hash:old.originalTransactionHash,from:old.request.from,to:old.request.to,input:old.request.data,value:'0x0',gas:'0x4c4b40',nonce:'0x1',blockHash:h1.hash,blockNumber:h1.number,transactionIndex:'0x0',type:'0x2',chainId:'0x1',maxFeePerGas:'0x38d7ea4c68000',maxPriorityFeePerGas:'0x1',accessList:[],v:'0x0',r:'0x1',s:'0x2'}];
 const frozen=await freezeRun({repoRoot:ROOT,outputDirectory:out}),loaded=await loadPlan({outputDirectory:out,expectedPlanSha256:frozen.planSha256});assert.equal(loaded.plan.localImplementation.version,JSON.parse(readFileSync(join(ROOT,'package.json'))).version);
 const archived=await import(pathToFileURL(join(out,'runtime/research/ordinary-local-coverage-v1/run.mjs')));
 const RealDate=globalThis.Date,realFetch=globalThis.fetch,realDelay=timersPromises.setTimeout;let clock=RealDate.now(),calls=0,unexpected=null,oracleCalls=0;
 class FakeDate extends RealDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}}
 const diff=product.transportEvidence.find(r=>r.request.method==='debug_traceCall'&&r.request.params[2]?.tracer==='prestateTracer'&&r.request.params[2]?.tracerConfig?.diffMode&&!r.request.params[2]?.stateOverrides);
 assert(diff,'Recorded original diff exists');const trace=product.execution.trace;
 globalThis.Date=FakeDate;timersPromises.setTimeout=async(ms)=>{clock+=ms;};syncBuiltinESMExports();
 globalThis.fetch=async(_url,options)=>{calls++;const r=JSON.parse(options.body);let result;
 if(r.method==='eth_chainId')result='0x1';
 else if(r.method==='eth_getBlockByNumber'&&r.params[0]==='latest')result=headers[0];
 else if(r.method==='eth_getBlockByNumber'&&r.params[0]==='finalized')result=headers[3];
 else if(r.method==='eth_getBlockByHash'&&headers.some(h=>h.hash===r.params[0])){const h=headers.find(h=>h.hash===r.params[0]);result=r.params[1]?h:{...h,transactions:h.transactions.map(tx=>typeof tx==='string'?tx:tx.hash)};}
 else if(r.method==='eth_getBlockByNumber'&&r.params[0]===old.header.number){result=headers[0];if(delayed)clock+=POLICY.oracleWallMs+1;}
 else if(['eth_getProof','eth_getCode'].includes(r.method)){const answer=local.transport.find(a=>a.request.method===r.method&&JSON.stringify(a.request.params)===JSON.stringify(r.params));if(answer)result=answer.parsed.result;}
 else if(r.method==='debug_traceCall'){assert(existsSync(join(out,'cases/001/LOCAL_SEALED.json')),'Product must be durably sealed before oracle trace');oracleCalls++;result=r.params[2].tracer==='callTracer'?trace:JSON.parse(diff.responseText).result;}
 if(result===undefined){unexpected={method:r.method,params:r.params};throw Error('No fake response; network is forbidden');}return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));};
 let result;
 try{result=await archived.runFrozen({outputDirectory:out,expectedPlanSha256:frozen.planSha256});assert.equal(unexpected,null,JSON.stringify(unexpected));assert.equal(result.status,delayed?'interrupted':'complete',JSON.stringify(result));
  if(delayed){assert.equal(result.caseRun.accounting,null);assert.equal(result.timingViolation.code,'phase_deadline');assert.equal(result.caseRun.interruptedLedger.filter(r=>r.selected).length,1);
   const retained=JSON.parse(readFileSync(join(out,'cases/001/oracle.json')));assert.equal(retained.records.length,4);assert(retained.records.every(r=>r.status==='completed'));assert.equal(retained.timing.withinBudget,false);
   assert.equal(JSON.parse(readFileSync(join(out,'cases/001/local.json'))).attempt.output.execution.status,'success');
  }else{assert.equal(result.caseRun.accounting.counts.selected,1);assert.equal(result.caseRun.accounting.counts.comparison.match,1,JSON.stringify(result.caseRun));}
  assert.equal(oracleCalls,2);const prior=calls;await assert.rejects(archived.runFrozen({outputDirectory:out,expectedPlanSha256:frozen.planSha256}),{code:'artifact_save_failed'});assert.equal(calls,prior);}
 finally{globalThis.Date=RealDate;globalThis.fetch=realFetch;timersPromises.setTimeout=realDelay;syncBuiltinESMExports();}
 const verifier=await import(pathToFileURL(join(out,'runtime/research/ordinary-local-coverage-v1/verify.mjs')));
 globalThis.fetch=async()=>{throw Error('Audit network forbidden');};
 try{
  const verified=await verifier.verifyEvidence({outputDirectory:out,expectedManifestSha256:result.evidence.manifestSha256});assert.equal(verified.status,'verified');assert.equal(verified.metricsAvailable,!delayed);assert.equal(verified.selected,1);assert.equal(verified.outcomesRecomputed,1);assert(verified.proofsVerified>0);assert.equal(verified.limitations.newIndependentExecution,false);
  if(!delayed){
   // Artifact-only interrupted-packet control: retain both actual phases, but
   // model failure before the outcome file became durable. No target rerun.
   const names=['results.json','cases/001/outcome.json','write-ledger.json','evidence-manifest.json'];
   const original=new Map(names.map(name=>[name,readFileSync(join(out,name))]));
   const write=(name,value)=>{chmodSync(join(out,name),0o644);writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');};
   const reseal=()=>{
    const manifest=JSON.parse(original.get('evidence-manifest.json'));
    const files=manifest.files.filter(e=>e.path!=='write-ledger.json'&&existsSync(join(out,e.path))).map(e=>{const bytes=readFileSync(join(out,e.path));return{path:e.path,bytes:bytes.length,sha256:sha(bytes),origin:['source-manifest.json','plan.json','FROZEN.json'].includes(e.path)?'preexisting':'written'};}).sort((a,b)=>a.path.localeCompare(b.path));
    write('write-ledger.json',{schemaVersion:'1.0',files});rmSync(join(out,'evidence-manifest.json'));return sealEvidence(out,frozen.planSha256,frozen.sourceManifestSha256);
   };
   try{
    const interrupted=JSON.parse(original.get('results.json')),row=interrupted.caseRun.rows[0],outcome={transactionHash:row.transactionHash,execution:'provider_unavailable',comparison:'not_comparable'};
    const selection=JSON.parse(readFileSync(join(out,'selection.json'))).census.selection;
    interrupted.status='interrupted';interrupted.caseRun={...interrupted.caseRun,status:'interrupted',fatal:{caseId:'001',code:'artifact_save_failed'},accounting:null,interruptedLedger:accountCohortOutcomes(selection,[outcome]).ledger,
     rows:[{id:row.id,transactionHash:row.transactionHash,projection:row.projection,adjudication:{outcome,channels:{},reasons:['Case could not retain a complete verified result'],allChannelsComplete:false}}]};
    write('results.json',interrupted);rmSync(join(out,'cases/001/outcome.json'));
    const pin=reseal(),partial=await verifier.verifyEvidence({outputDirectory:out,expectedManifestSha256:pin.manifestSha256});
    assert.equal(partial.metricsAvailable,false);assert.equal(partial.partialCases,1);assert.equal(partial.outcomesRecomputed,0);assert.equal(partial.selected,1);assert.equal(partial.completeWireBinding,true);
    interrupted.caseRun.accounting=accountCohortOutcomes(selection,[outcome]);write('results.json',interrupted);const promoted=reseal();
    await assert.rejects(verifier.verifyEvidence({outputDirectory:out,expectedManifestSha256:promoted.manifestSha256}),/withhold metrics/);
   }finally{for(const[name,bytes]of original){if(existsSync(join(out,name)))chmodSync(join(out,name),0o644);writeFileSync(join(out,name),bytes);}}
  }
  for(const [path,mutate]of [
   ['cases/001/LOCAL_SEALED.json',x=>{x.sha256='0'.repeat(64);}],
   ['cases/001/oracle.json',x=>{x.records[1].request.params[0].value='0x1';}],
   ['cases/001/local.json',x=>{x.attempt.inputs.accounts[x.attempt.output.trace.from].balance='1';}],
   ['results.json',x=>{x.caseRun.accounting={counts:{selected:2}};}],
  ]){
   const target=join(out,path),before=readFileSync(target),value=JSON.parse(before);mutate(value);chmodSync(target,0o644);writeFileSync(target,JSON.stringify(value,null,2)+'\n');rmSync(join(out,'evidence-manifest.json'));const forged=sealEvidence(out,frozen.planSha256,frozen.sourceManifestSha256);
   await assert.rejects(verifier.verifyEvidence({outputDirectory:out,expectedManifestSha256:forged.manifestSha256}));
   writeFileSync(target,before);rmSync(join(out,'evidence-manifest.json'));sealEvidence(out,frozen.planSha256,frozen.sourceManifestSha256);
  }
 }finally{globalThis.fetch=realFetch;}
 }
});

function caseCensus(types=['2','2','4']){
 const header=JSON.parse(readFileSync(new URL('../../reports/ethereum-lending-local-reference/plan.json',import.meta.url))).cases[0].header;
 const rows=types.map((type,i)=>({transactionHash:'0x'+(i+1).toString(16).padStart(64,'0'),blockHash:'0x'+'ab'.repeat(32),blockNumber:(BigInt(header.number)+1n).toString(),transactionIndex:String(i)}));
 const selection=createCohortSelection({chainId:1,census:rows,seed:'0x'+'ff'.repeat(32),sampleSize:16});
 const selected=selection.rows.map(r=>({...r,parentBlockHash:header.hash,parentHeader:header}));
 return{selection,selected,envelopes:rows.map((r,i)=>({...r,normalizedEnvelope:{type:types[i],from:'0x'+'11'.repeat(20),to:'0x'+'22'.repeat(20),input:'0x',value:'0',gas:'21000',extensions:{}}}))};
}
const identity={name:'test local identity',version:'0.test',sourceSha256:'a'.repeat(64),sourceFiles:['engine.js']};
function memoryArtifacts(){const artifacts=new Map();return{artifacts,save:(path,value)=>{assert(!artifacts.has(path));artifacts.set(path,structuredClone(value));},hashArtifact:path=>{const text=JSON.stringify(artifacts.get(path));return{path,bytes:Buffer.byteLength(text),sha256:sha(text)};}};}
test('unsupported and exhausted selected slots remain in the full denominator without a replacement dispatch',async()=>{
 const a=memoryArtifacts();let calls=0;const result=await executeCases({census:caseCensus(),implementation:identity,...a,canAttempt:()=>false,assertHealthy:()=>{},executeLocal:()=>{calls++;},executeOracle:()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.status,'complete');assert.equal(result.rows.length,3);assert.equal(result.accounting.counts.selected,3);assert.equal(result.accounting.counts.execution.budget_unattempted,2);assert.equal(result.accounting.counts.execution.unsupported,1);assert.equal(result.accounting.metrics.exactComparatorAgreement.fraction,'0/3');
 assert.equal(a.artifacts.get('cases/003/local.json').dispatch,'unsupported');assert.equal(a.artifacts.get('cases/001/oracle.json').dispatch,'budget_unattempted');
});
test('a failed durable local seal stops the oracle and later cases, preserving an interrupted all-slot ledger',async()=>{
 const a=memoryArtifacts();let locals=0,oracles=0;const result=await executeCases({census:caseCensus(['2','2','2']),implementation:identity,...a,
 save:(path,value)=>{if(path.endsWith('LOCAL_SEALED.json'))throw Object.assign(Error('disk failure'),{code:'artifact_save_failed'});a.save(path,value);},
 canAttempt:()=>true,assertHealthy:()=>{},executeLocal:async()=>{locals++;return{dispatch:'unavailable',implementation:identity,attempt:null,transportWireIds:[]};},executeOracle:()=>{oracles++;}});
 assert.equal(locals,1);assert.equal(oracles,0);assert.equal(result.status,'interrupted');assert.equal(result.fatal.code,'artifact_save_failed');assert.equal(result.accounting,null);assert.equal(result.rows.length,3);assert.equal(result.interruptedLedger.length,3);assert.equal(result.rows[1].adjudication.outcome.execution,'budget_unattempted');
});


test('projection failure retains all selected slots and final integrity withholding preserves a completed ledger',async()=>{
 const census=caseCensus();census.envelopes[0].normalizedEnvelope.value='malformed';let calls=0;const a=memoryArtifacts();
 const result=await executeCases({census,implementation:identity,...a,canAttempt:()=>true,assertHealthy:()=>{},executeLocal:()=>{calls++;},executeOracle:()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.status,'interrupted');assert.equal(result.rows.length,3);assert.equal(result.rows[0].projection,null);assert.equal(result.interruptedLedger.length,3);assert.equal(result.rows[1].adjudication.outcome.execution,'budget_unattempted');
 const clean=await executeCases({census:caseCensus(),implementation:identity,...memoryArtifacts(),canAttempt:()=>false,assertHealthy:()=>{},executeLocal:()=>{throw Error('never');},executeOracle:()=>{throw Error('never');}});
 const withheld=withholdCaseMetrics(clean);assert.equal(withheld.accounting,null);assert.equal(withheld.status,'interrupted');assert.deepEqual(withheld.interruptedLedger,clean.accounting.ledger);assert.equal(withheld.rows.length,3);
});

test('failed selection and excessive wait gap retain no denominator and audit without replacement reads',async t=>{
 const directory=temp(t),header=JSON.parse(readFileSync(new URL('../../reports/ethereum-lending-local-reference/plan.json',import.meta.url))).cases[0].header;
 const RealDate=globalThis.Date,realFetch=globalThis.fetch,realDelay=timersPromises.setTimeout;
 for(const scenario of ['chain_error','wait_gap']){
  const out=join(directory,scenario),frozen=await freezeRun({repoRoot:ROOT,outputDirectory:out});
  const archived=await import(pathToFileURL(join(out,'runtime/research/ordinary-local-coverage-v1/run.mjs'))),verifier=await import(pathToFileURL(join(out,'runtime/research/ordinary-local-coverage-v1/verify.mjs')));
  let clock=RealDate.now(),calls=0;class FakeDate extends RealDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}}
  globalThis.Date=FakeDate;timersPromises.setTimeout=async(ms)=>{clock+=ms+60001;};syncBuiltinESMExports();
  globalThis.fetch=async(_url,options)=>{calls++;const request=JSON.parse(options.body);if(scenario==='chain_error')return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'synthetic unavailable'}}));assert(calls<=2,'No post-gap request allowed');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='eth_chainId'?'0x1':header}));};
  let result;try{result=await archived.runFrozen({outputDirectory:out,expectedPlanSha256:frozen.planSha256});}finally{globalThis.Date=RealDate;globalThis.fetch=realFetch;timersPromises.setTimeout=realDelay;syncBuiltinESMExports();}
  assert.equal(result.status,'selection_failed');assert.equal(result.caseRun,null);assert.equal(calls,scenario==='chain_error'?1:2);assert.equal(result.timingViolation?.code,scenario==='wait_gap'?'wait_overrun':undefined);
  globalThis.fetch=async()=>{throw Error('offline only');};try{const audited=await verifier.verifyEvidence({outputDirectory:out,expectedManifestSha256:result.evidence.manifestSha256});assert.equal(audited.status,'verified');assert.equal(audited.census,null);assert.equal(audited.selected,null);assert.equal(audited.outcomesRecomputed,0);}finally{globalThis.fetch=realFetch;}
 }
});
