// Supplemental offline audit. No imports from current product code, no VM run,
// no network, no writes to any original packet. Frozen helpers are imported only
// after their entire source inventory has been checked against pinned evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url)),ROOT=resolve(HERE,'../..');
const PACKET=join(ROOT,'reports/ordinary-ethereum-unresolved-v4');
const MANIFEST='dce9038a13613eea736defdf135b6bfc2cf5abed9fddec0a2714ec33df6fd024';
const V3='107f69a3659b9ba1f1b1bb9beac928ab10a1ecf3051e927d6e86e4e5b9fb16a9';
const V2='583dfee6412385547791da6069ed6e33322928e0b0231e645c4e956711d1bc2a';
const sha=x=>createHash('sha256').update(x).digest('hex');
const json=p=>JSON.parse(readFileSync(p));
function memberPath(base,path){assert.equal(typeof path,'string');assert(!path.startsWith('/')&&!path.split('/').some(x=>['','..','.'].includes(x)));return join(base,path);}
function verifyMember(base,row){const path=memberPath(base,row.path),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink());const bytes=readFileSync(path);assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);return bytes;}
function evidence(base,expected,all=true){const bytes=readFileSync(join(base,'evidence-manifest.json'));assert.equal(sha(bytes),expected);const manifest=JSON.parse(bytes),byPath=new Map(manifest.files.map(r=>[r.path,r]));assert.equal(byPath.size,manifest.files.length);if(all)for(const row of manifest.files)verifyMember(base,row);return {manifest,read(path){assert(byPath.has(path),'Unbound artifact '+path);return JSON.parse(verifyMember(base,byPath.get(path)));}};}
export function verifyWire(wire){
  assert.equal(wire.url,'https://eth.drpc.org/');assert.equal(wire.provider,'drpc');assert.equal(wire.dispatched,true);
  assert.equal(JSON.stringify(wire.request),wire.requestText);assert.equal(sha(wire.requestText),wire.requestSha256);assert.equal(Buffer.byteLength(wire.requestText),wire.requestBytes);
  const raw=Buffer.from(wire.rawBase64,'base64');assert.equal(raw.toString('base64'),wire.rawBase64);assert.equal(sha(raw),wire.transport.retainedSha256);assert.equal(raw.length,wire.transport.retainedBytes);
  assert(Number.isFinite(wire.transport.durationMs)&&wire.transport.durationMs>=0);
  if(wire.transport.complete){assert.equal(raw.length,wire.transport.observedBytes);assert.equal(sha(raw),wire.transport.observedSha256);assert.equal(sha(raw),wire.responseSha256);assert.equal(new TextDecoder('utf8',{fatal:true}).decode(raw),wire.responseText);const body=JSON.parse(wire.responseText);assert.deepEqual(body,wire.parsed);assert.equal(body.id,wire.request.id);assert.equal(body.jsonrpc,'2.0');assert.notEqual(Object.hasOwn(body,'result'),Object.hasOwn(body,'error'));}
  assert.equal(wire.id,wire.request.id);return wire;
}
export function joinProduct(wire,inner,engine){
  assert.equal(wire.profile,'product');assert.deepEqual(inner.request,wire.request);assert.equal(inner.requestText,wire.requestText);assert.equal(inner.requestSha256,wire.requestSha256);assert.equal(inner.requestBytes,wire.requestBytes);
  assert.equal(inner.httpStatus,wire.httpStatus);assert.equal(inner.transport.observedBytes,wire.transport.observedBytes);assert.equal(inner.transport.complete,wire.transport.complete);assert.equal(inner.transport.responseSha256,wire.responseSha256);
  assert.equal(engine.id,inner.id);assert.deepEqual({method:engine.method,params:engine.params},{method:wire.request.method,params:wire.request.params});
  if(Object.hasOwn(wire.parsed,'result')){assert.equal(inner.responseText,wire.responseText);assert.deepEqual(engine.result,wire.parsed.result);assert(!Object.hasOwn(engine,'error'));}
  else {assert(!Object.hasOwn(inner,'responseText'));assert(!Object.hasOwn(engine,'result'));assert.equal(typeof engine.error,'string');assert.equal(inner.error.detail.rpcCode,wire.parsed.error.code);}
}
export async function audit(){
  const e=evidence(PACKET,MANIFEST),plan=e.read('plan.json'),results=e.read('results.json'),source=e.read('source-manifest.json');
  assert.equal(sha(readFileSync(join(PACKET,'plan.json'))),results.planSha256);assert.equal(results.planSha256,e.manifest.planSha256);assert.equal(results.sourceManifestSha256,e.manifest.sourceManifestSha256);assert.equal(sha(readFileSync(join(PACKET,'source-manifest.json'))),results.sourceManifestSha256);
  for(const row of source.files){const path=memberPath(join(PACKET,'runtime'),row.path);if(row.kind==='symlink'){assert(lstatSync(path).isSymbolicLink());assert.equal(readlinkSync(path),row.target);}else verifyMember(join(PACKET,'runtime'),row);}
  const frozen=path=>import(pathToFileURL(join(PACKET,'runtime',path)));
  const {verifyFrozenSources,verifyNodeRuntime}=await frozen('research/standard-evm/cohort-freeze.mjs');
  await verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:results.sourceManifestSha256});await verifyNodeRuntime(plan.runtime);
  const {verifyEthereumHeader}=await frozen('engines/local-evm/ethereum-header.js');
  const {verifyStateProof}=await frozen('engines/local-evm/verified-state-proof.js');
  const {adjudicateCohortOutcome}=await frozen('research/standard-evm/cohort-outcomes.mjs');
  const {compactAdjudication}=await frozen('research/standard-evm/cohort-runner.mjs');
  const {checkRecheck}=await frozen('research/standard-evm/recheck-unresolved.mjs');
  await checkRecheck({outputDirectory:PACKET,expectedPlanSha256:results.planSha256});
  const start=e.read('STARTED.json');assert.equal(start.planSha256,results.planSha256);assert.equal(start.sourceManifestSha256,results.sourceManifestSha256);assert.deepEqual(start.runtime,plan.runtime);assert.deepEqual(start.cases,plan.cases.map(c=>c.id));assert.equal(start.startedAt,results.startedAt);
  assert.equal(results.status,'complete');assert.equal(results.comparisonStatus,'available');assert.deepEqual(results.failures,[]);assert.equal(results.frozenPlanAndInputsUnchanged,true);assert.equal(results.runtimeUnchanged,true);
  const wireRows=e.manifest.files.filter(x=>/^wire\/[0-9]{6}\.json$/.test(x.path)).map(x=>verifyWire(e.read(x.path))).sort((a,b)=>a.globalId-b.globalId);
  assert.deepEqual(wireRows.map(x=>x.globalId),Array.from({length:52},(_,i)=>i+1));assert.equal(results.budget.calls,wireRows.length);assert.equal(results.budget.observedBytes,wireRows.reduce((n,x)=>n+x.transport.observedBytes,0));
  const claimed=new Set(),cases=[],proofs=[];let joinedEngine=0,joinedLocal=0;
  const oldBase=join(ROOT,'reports/ordinary-ethereum-cohort-v2'),old=evidence(oldBase,V2,false);
  for(const c of plan.cases){
    assert.deepEqual(e.read(`cases/${c.id}/request.json`),c);verifyEthereumHeader({header:c.header,expectedHash:c.header.hash});
    const l=e.read(`cases/${c.id}/local.json`),p=e.read(`cases/${c.id}/product.json`),pinned={blockHash:c.header.hash,requireCanonical:true};
    for(const [phase,artifact]of[['local',l],['product',p]]){
      assert.deepEqual(artifact.transportDenied,[]);assert.equal(artifact.transportUsage.attempts,artifact.transportWireIds.length);
      for(const id of artifact.transportWireIds){assert(!claimed.has(id));claimed.add(id);const w=wireRows[id-1];assert.equal(w.caseId,c.id);assert.equal(w.profile,phase);const{method,params}=w.request;
        if(method==='eth_chainId')assert.deepEqual(params,[]);
        else if(method==='eth_getBlockByHash')assert.deepEqual(params,[c.header.hash,false]);
        else if(method==='eth_getBlockByNumber')assert.deepEqual(params,[c.header.number,false]);
        else if(method==='debug_traceCall')assert.deepEqual(params[1],pinned);
        else {assert(['eth_getProof','eth_getCode','eth_getBalance','eth_getTransactionCount'].includes(method));assert.deepEqual(params.at(-1),pinned);}
      }
    }
    assert.equal(l.transportWireIds.length,1);assert.equal(l.attempt.output.execution.status,'unavailable');assert.equal(l.attempt.inputUsage.status,'unavailable');assert.equal(l.attempt.broker.pendingAtReturn,0);
    const lw=wireRows[l.transportWireIds[0]-1],le=l.attempt.inputEvidence[0],broker=l.attempt.broker.records[0];
    assert.equal(lw.request.method,'eth_getProof');assert.deepEqual(le.request,{method:lw.request.method,params:lw.request.params});assert.deepEqual(broker.request,le.request);assert.equal(le.status,'unavailable');assert.equal(broker.status,'unavailable');assert.equal(lw.parsed.error.code,-32000);assert.match(lw.parsed.error.message,/historical state .* is not available/);assert(!Object.hasOwn(le,'result'));joinedLocal++;
    assert.equal(p.httpStatus,200);assert.equal(p.response.sha256,sha(p.response.bodyText));assert.equal(p.response.bytes,Buffer.byteLength(p.response.bodyText));assert.deepEqual(JSON.parse(p.response.bodyText),p.report);assert.equal(p.request.bodySha256,sha(p.request.bodyText));assert.deepEqual(JSON.parse(p.request.bodyText),c.apiRequest);assert.deepEqual(p.report.apiRequest,c.apiRequest);assert.deepEqual(p.report.implementation,plan.productImplementation);
    assert.equal(p.report.transportEvidence.length,p.transportWireIds.length);assert.equal(p.report.evidence.length,p.transportWireIds.length);
    for(let i=0;i<p.transportWireIds.length;i++){joinProduct(wireRows[p.transportWireIds[i]-1],p.report.transportEvidence[i],p.report.evidence[i]);joinedEngine++;}
    const args={transactionHash:c.transactionHash,request:c.localRequest,header:c.header,expectedProductImplementation:plan.productImplementation,expectedLocalImplementation:plan.localImplementation};
    const outcome=adjudicateCohortOutcome({...args,local:l,product:p});assert.deepEqual(outcome,e.read(`cases/${c.id}/outcome.json`));assert.deepEqual(compactAdjudication(outcome),results.rows.find(x=>x.id===c.id).outcome);assert.notEqual(outcome.outcome.comparison,'match');
    let supplement=null;
    if(c.savedInputSupplement){
      const saved=e.read(c.savedInputSupplement),s=e.read(`cases/${c.id}/local-saved-inputs.json`);assert.equal(saved.expectedOutputsIncluded,false);assert.equal(s.playback.networkCalls,0);assert.equal(s.playback.exactSequence,true);assert.equal(s.playback.unexpectedRequest,false);
      const origin=old.read(`cases/${c.id}/local.json`);assert.equal(saved.source.sha256,sha(readFileSync(join(oldBase,`cases/${c.id}/local.json`))));assert.equal(saved.source.manifestSha256,V2);
      assert.equal(saved.records.length,4);assert.equal(s.attempt.inputEvidence.length,saved.records.length);assert.equal(s.attempt.broker.records.length,saved.records.length);
      const codeByAddress=new Map(saved.records.filter(x=>x.request.method==='eth_getCode').map(x=>[x.request.params[0],x.result]));
      for(const [i,r]of saved.records.entries()){
        const raw=origin.attempt.inputEvidence[i],actual=s.attempt.inputEvidence[i],br=s.attempt.broker.records[i];assert.deepEqual(r.request,raw.request);assert.deepEqual(r.result,raw.result);assert.equal(r.sourceEvidenceId,raw.id);assert.equal(r.resultSha256,sha(JSON.stringify(r.result)));
        const sourceWire=verifyWire(old.read(`wire/${String(origin.transportWireIds[i]).padStart(6,'0')}.json`));assert.deepEqual(r.request,{method:sourceWire.request.method,params:sourceWire.request.params});assert.deepEqual(r.result,sourceWire.parsed.result);
        assert.deepEqual(actual.request,r.request);assert.deepEqual(actual.result,r.result);assert.equal(actual.resultSha256,r.resultSha256);assert.equal(actual.verification,'verified');assert.deepEqual(br.request,r.request);assert.equal(br.resultSha256,r.resultSha256);assert.deepEqual(r.request.params.at(-1),pinned);
        if(r.request.method==='eth_getProof'){
          const address=r.request.params[0],proof=await verifyStateProof({stateRoot:c.header.stateRoot,address,storageKeys:r.request.params[1],proof:r.result,code:codeByAddress.get(address)});
          assert.equal(proof.status,'verified');const provenance=s.attempt.inputs.provenance.find(x=>x.account===address);assert.deepEqual(provenance.accountProof,proof.account);
          const actualAccount=s.attempt.inputs.accounts[address];assert.equal(actualAccount.exists,proof.account.exists);if(proof.account.exists){assert.equal(actualAccount.nonce,proof.account.nonceRaw);assert.equal(actualAccount.balance,proof.account.balanceRaw);assert.equal(actualAccount.code,proof.code.bytes);}
          proofs.push({caseId:c.id,address,exists:proof.account.exists,stateRoot:c.header.stateRoot,codeVerified:proof.code.status==='verified',storageKeys:r.request.params[1].length});
        }else assert.equal(r.request.method,'eth_getCode');
      }
      const so=adjudicateCohortOutcome({...args,local:s,product:p});assert.deepEqual(so,e.read(`cases/${c.id}/supplement-outcome.json`));assert.deepEqual(compactAdjudication(so),results.rows.find(x=>x.id===c.id).supplementOutcome);assert.equal(so.outcome.comparison,'match');assert.equal(so.allChannelsComplete,true);
      supplement={comparison:so.outcome.comparison,execution:so.outcome.execution,channels:Object.keys(so.channels),gas:s.attempt.output.gasAccounting.gasUsed,proofSource:'retained_v2_same_parent_state_not_fresh_provider_reads'};
    }
    const originalTrace=p.report.evidence.find(x=>x.method==='debug_traceCall'&&x.params[2].tracer==='callTracer');
    const originalDiff=p.report.evidence.find(x=>x.method==='debug_traceCall'&&x.params[2].tracer==='prestateTracer');
    assert.deepEqual(originalTrace.params.slice(0,2),originalDiff.params.slice(0,2));
    if(c.id==='007'){assert.equal(p.report.canonicalStatus,'unverified');assert.equal(p.report.blobContextValidation.status,'unavailable');assert.equal(originalTrace.result.gasUsed,'0x5208');assert.equal(originalTrace.params[0].maxFeePerBlobGas,'0x0');assert.match(wireRows[p.transportWireIds.at(-1)-1].parsed.error.message,/max fee per blob gas less than block blob gas fee/);}
    else assert.equal(p.report.canonicalStatus,'verified');
    cases.push({id:c.id,liveLocal:'unavailable_historical_state',providerExecution:p.report.execution.status,canonicalStatus:p.report.canonicalStatus,outcome:outcome.outcome,supplement});
  }
  assert.equal(claimed.size,wireRows.length);assert.equal(joinedEngine,48);assert.equal(joinedLocal,4);assert.equal(proofs.length,4);
  const priorBase=join(ROOT,'reports/ordinary-ethereum-unresolved-v3'),prior=evidence(priorBase,V3),pr=prior.read('results.json'),pw=prior.manifest.files.filter(x=>/^wire\//.test(x.path)).map(x=>verifyWire(prior.read(x.path)));
  assert(pr.executionWindowMs>pr.budget.limits.wallMs+25000);const late=pw.filter(x=>x.transport.durationMs>25000);assert(late.length>0);
  assert.deepEqual(pr.rows.filter(x=>x.product.dispatch==='budget_unattempted').map(x=>x.id),['007','016']);
  return {status:'verified_with_retained_limitations',packetManifestSha256:MANIFEST,planSha256:results.planSha256,sourceManifestSha256:results.sourceManifestSha256,
    evidenceFiles:e.manifest.files.length,sourceEntries:source.files.length,wireRecords:wireRows.length,wireBytes:results.budget.observedBytes,independentlyJoinedProductRecords:joinedEngine,independentlyJoinedLocalRecords:joinedLocal,unjoinedRecords:0,
    proofAudit:{freshVerifiedProofs:0,freshFailedProofReads:4,savedAccountProofsVerified:proofs.length,savedCodeValuesVerified:4,proofs},cases,
    priorTiming:{manifestSha256:V3,declaredExecutionMs:pr.budget.limits.wallMs,declaredDrainMs:25000,observedExecutionMs:pr.executionWindowMs,overrunMs:pr.executionWindowMs-pr.budget.limits.wallMs,maxObservedRequestMs:Math.max(...pw.map(x=>x.transport.durationMs)),lateRequests:late.map(x=>({globalId:x.globalId,caseId:x.caseId,error:x.error??null,durationMs:x.transport.durationMs})),unattemptedCases:['007','016'],cause:'Raw timestamps prove delayed scheduling/deadline overrun; host suspension is operator context, not independently proven by RPC records.'},
    limitations:{newVmExecution:false,outcomesRecomputedWithFrozenAdjudicator:true,proofsReverifiedAgainstRehashedHeader:true,independentExecutionEngineRun:false,independentProvider:false,headerConsensusOrFinalityVerified:false,originalTransactionPosition:false,signedFeesOrBlobSidecarsValidated:false,prospectiveHoldout:false,populationAccuracyClaim:false}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const output=await audit(),path=join(HERE,'results.json');
  if(process.argv[2]==='--write')writeFileSync(path,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
  else if(process.argv[2]==='--verify')assert.deepEqual(output,json(path));
  console.log(JSON.stringify({status:output.status,wireRecords:output.wireRecords,proofAudit:output.proofAudit,cases:output.cases,publicCalls:0},null,2));
}
