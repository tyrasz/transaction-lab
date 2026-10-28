// Supplemental saved-wire reexecution only. No network and no current runtime
// imports. Product output never enters the local input adapter.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const HERE=dirname(fileURLToPath(import.meta.url)),ROOT=resolve(HERE,'../..'),PACKET=join(ROOT,'reports/ordinary-ethereum-current-context-v1');
const MANIFEST='69774b826eced318cf6a15a8fd9b854ae3f763334cae771f2ab24c98ec1a69c7';
const SOURCE='5869cbd6bf7c0a9635bc0ef755ee694ee347771aed5792ffd1ac9c5fe6ea2aff';
const HELPER='reports/ordinary-ethereum-unresolved-v4-audit/verify.mjs',HELPER_SHA='74afb2b53eade67fe55af894e4928131b92bf1550be6cc9fd9dc21383f2b0ea9';
const sha=x=>createHash('sha256').update(x).digest('hex');
function readMember(base,row){assert(!row.path.startsWith('/')&&!row.path.split('/').some(x=>['..','.',''].includes(x)));const file=join(base,row.path);assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());const b=readFileSync(file);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);return b;}
const json=file=>JSON.parse(readFileSync(file));
export function playback(wires){let at=0,mismatch=null;return{get consumed(){return at;},get mismatch(){return mismatch;},async call(method,params){try{const row=wires[at++];assert(row,'Unexpected extra input read');assert.deepEqual({method,params},{method:row.request.method,params:row.request.params});assert(['eth_getProof','eth_getCode'].includes(method));assert.equal(row.status,'completed');assert(Object.hasOwn(row.parsed,'result'));return structuredClone(row.parsed.result);}catch(error){mismatch=error;throw error;}}};}
const withoutDurations=rows=>rows.map(row=>{const copy=structuredClone(row);delete copy.durationMs;return copy;});
export async function audit({negativeProof=false}={}){
  const manifestBytes=readFileSync(join(PACKET,'evidence-manifest.json'));assert.equal(sha(manifestBytes),MANIFEST);const manifest=JSON.parse(manifestBytes),members=new Map(manifest.files.map(x=>[x.path,x]));assert.equal(members.size,manifest.files.length);for(const row of manifest.files)readMember(PACKET,row);
  const get=path=>{assert(members.has(path));return JSON.parse(readMember(PACKET,members.get(path)));};
  const source=get('source-manifest.json');assert.equal(sha(readMember(PACKET,members.get('source-manifest.json'))),SOURCE);
  for(const row of source.files){if(row.kind==='symlink'){const file=join(PACKET,'runtime',row.path);assert(lstatSync(file).isSymbolicLink());assert.equal(readlinkSync(file),row.target);}else readMember(join(PACKET,'runtime'),row);}
  const frozen=path=>import(pathToFileURL(join(PACKET,'runtime',path)));
  const {verifyFrozenSources,verifyNodeRuntime}=await frozen('research/standard-evm/cohort-freeze.mjs');await verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:SOURCE});await verifyNodeRuntime(source.runtime);
  const {verifyEthereumHeader}=await frozen('engines/local-evm/ethereum-header.js'),{verifyStateProof}=await frozen('engines/local-evm/verified-state-proof.js');
  const {executeIsolatedEthereumCall}=await frozen('engines/local-evm/isolated-call.js'),{adjudicateCohortOutcome}=await frozen('research/standard-evm/cohort-outcomes.mjs');
  const {compactAdjudication}=await frozen('research/standard-evm/cohort-runner.mjs'),{checkCurrentContext,bindCurrentSelection,verifySelectedProductHeader}=await frozen('research/standard-evm/recheck-current-context.mjs');
  assert.equal(sha(readFileSync(join(ROOT,HELPER))),HELPER_SHA);const {verifyWire,joinProduct}=await import(pathToFileURL(join(ROOT,HELPER)));
  const plan=get('plan.json'),results=get('results.json'),start=get('STARTED.json');assert.equal(sha(readMember(PACKET,members.get('plan.json'))),results.planSha256);assert.equal(results.planSha256,manifest.planSha256);assert.equal(results.sourceManifestSha256,SOURCE);assert.equal(start.planSha256,results.planSha256);assert.equal(start.sourceManifestSha256,SOURCE);assert.equal(start.startedAt,results.startedAt);
  await checkCurrentContext({outputDirectory:PACKET,expectedPlanSha256:results.planSha256});
  assert.equal(results.status,'complete');assert.equal(results.comparisonStatus,'available');assert.deepEqual(results.failures,[]);
  const wires=manifest.files.filter(x=>/^wire\/[0-9]{6}\.json$/.test(x.path)).map(x=>verifyWire(get(x.path))).sort((a,b)=>a.globalId-b.globalId);assert.deepEqual(wires.map(x=>x.globalId),Array.from({length:36},(_,i)=>i+1));assert.equal(results.budget.calls,wires.length);assert.equal(results.budget.observedBytes,wires.reduce((n,x)=>n+x.transport.observedBytes,0));
  const claimed=new Set(),caseReports=[];let proofCount=0,codeCount=0;
  const take=(ids,caseId,profile)=>ids.map(id=>{assert(!claimed.has(id));claimed.add(id);const w=wires[id-1];assert.equal(w.caseId,caseId);assert.equal(w.profile,profile);return w;});
  for(const planned of plan.cases){
    const id=planned.id,selection=get(`cases/${id}/selection.json`),c=get(`cases/${id}/request.json`),l=get(`cases/${id}/local.json`);
    assert.deepEqual(get(`cases/${id}/planned-input.json`),planned);assert.deepEqual(c,bindCurrentSelection(planned,selection));assert.notEqual(c.header.hash,planned.originalParentHeader.hash);assert.equal(selection.status,'selected');assert.deepEqual(selection.transportDenied,[]);
    const selectedWires=take(selection.transportWireIds,id,'census');assert.equal(selectedWires.length,2);assert.deepEqual(selectedWires[0].request.params,[]);assert.equal(selectedWires[0].request.method,'eth_chainId');assert.equal(selectedWires[0].parsed.result,'0x1');assert.equal(selectedWires[1].request.method,'eth_getBlockByNumber');assert.deepEqual(selectedWires[1].request.params,['latest',false]);assert.deepEqual(selectedWires[1].parsed.result,c.header);verifyEthereumHeader({header:c.header,expectedHash:c.header.hash});
    const localWires=take(l.transportWireIds,id,'local'),pinned={blockHash:c.header.hash,requireCanonical:true};assert.equal(localWires.length,4);assert.deepEqual(l.transportDenied,[]);assert.equal(l.attempt.broker.pendingAtReturn,0);assert.equal(l.attempt.isolation.processClosed,true);assert.deepEqual(l.implementation,plan.localImplementation);
    const codes=new Map(localWires.filter(w=>w.request.method==='eth_getCode').map(w=>[w.request.params[0],w.parsed.result]));
    for(const [i,w]of localWires.entries()){
      assert.deepEqual(w.request.params.at(-1),pinned);const input=l.attempt.inputEvidence[i],broker=l.attempt.broker.records[i];assert.deepEqual(input.request,{method:w.request.method,params:w.request.params});assert.deepEqual(broker.request,input.request);assert.deepEqual(input.result,w.parsed.result);assert.equal(input.resultSha256,sha(JSON.stringify(w.parsed.result)));assert.equal(broker.resultSha256,input.resultSha256);assert.equal(input.verification,'verified');
      if(w.request.method==='eth_getProof'){const address=w.request.params[0],proof=await verifyStateProof({stateRoot:c.header.stateRoot,address,storageKeys:w.request.params[1],proof:w.parsed.result,code:codes.get(address)});assert.equal(proof.status,'verified');assert.equal(proof.code.status,'verified');assert.deepEqual(l.attempt.inputs.provenance.find(x=>x.account===address).accountProof,proof.account);proofCount++;}else{assert.equal(w.request.method,'eth_getCode');codeCount++;}
    }
    // Only selected header, fixed unsigned envelope, and captured proof/code
    // responses are passed to the actual archived child. Expected outputs and
    // product traces are accessed for comparison only after this call returns.
    const inputs=structuredClone(localWires);
    if(negativeProof)inputs[0].parsed.result.accountProof[0]=inputs[0].parsed.result.accountProof[0].slice(0,-2)+'00';
    const rpc=playback(inputs),replayed=await executeIsolatedEthereumCall({request:c.localRequest,header:c.header,rpc,limits:{wallMs:l.attempt.isolation.wallMs,drainMs:l.attempt.isolation.drainMs}});
    assert.equal(rpc.mismatch,null);assert.equal(replayed.broker.pendingAtReturn,0);assert.equal(replayed.isolation.processClosed,true);assert.notEqual(replayed.isolation.childPid,process.pid);
    if(negativeProof){assert.equal(replayed.status,'completed');assert.equal(replayed.output.execution.status,'unavailable');assert.deepEqual(replayed.changes.accounts,[]);assert.equal(rpc.consumed,1);return{status:'negative_control_rejected_corrupted_proof',caseId:id};}
    assert.equal(rpc.consumed,localWires.length);assert.equal(replayed.status,'completed');
    for(const key of ['output','inputs','inputUsage','inputReads','stateReads','changes','headerVerification'])assert.deepEqual(replayed[key],l.attempt[key],key+' differs');
    assert.deepEqual(withoutDurations(replayed.inputEvidence),withoutDurations(l.attempt.inputEvidence));assert.deepEqual({...replayed.broker,records:withoutDurations(replayed.broker.records)},{...l.attempt.broker,records:withoutDurations(l.attempt.broker.records)});
    const iso=x=>{const y=structuredClone(x);delete y.durationMs;delete y.childPid;return y;};assert.deepEqual(iso(replayed.isolation),iso(l.attempt.isolation));
    const p=get(`cases/${id}/product.json`),productWires=take(p.transportWireIds,id,'product');assert.equal(productWires.length,12);assert.deepEqual(p.transportDenied,[]);assert.equal(p.httpStatus,200);assert.deepEqual(JSON.parse(p.request.bodyText),c.apiRequest);assert.equal(p.request.bodySha256,sha(p.request.bodyText));assert.deepEqual(JSON.parse(p.response.bodyText),p.report);assert.equal(p.response.sha256,sha(p.response.bodyText));assert.equal(p.response.bytes,Buffer.byteLength(p.response.bodyText));
    for(let i=0;i<productWires.length;i++)joinProduct(productWires[i],p.report.transportEvidence[i],p.report.evidence[i]);
    const binding=verifySelectedProductHeader(c,p);assert.deepEqual(binding,get(`cases/${id}/header-binding.json`));assert.equal(binding.status,'verified');assert.equal(binding.observedHeaders,2);
    const outcome=adjudicateCohortOutcome({transactionHash:c.transactionHash,request:c.localRequest,header:c.header,expectedProductImplementation:plan.productImplementation,expectedLocalImplementation:plan.localImplementation,local:{...l,attempt:replayed},product:p});assert.deepEqual(outcome,get(`cases/${id}/outcome.json`));assert.deepEqual(compactAdjudication(outcome),results.rows.find(x=>x.id===id).outcome);assert.equal(outcome.outcome.comparison,'match');assert.equal(outcome.allChannelsComplete,true);
    caseReports.push({id,blockHash:c.header.hash,blockNumber:BigInt(c.header.number).toString(),originalParentHash:planned.originalParentHeader.hash,execution:replayed.output.execution.status,gas:replayed.output.gasAccounting.gasUsed,messageGas:replayed.output.execution.executionGasUsed,intrinsicGas:replayed.output.profile.intrinsicGas,accessListEntries:replayed.output.profile.accessListAddressCount??'0',accessListStorageKeys:replayed.output.profile.accessListStorageKeyCount??'0',blobHashes:replayed.output.profile.blobVersionedHashes?.length??0,exactProofCodeReads:rpc.consumed,exactExecutionAndStateReplay:true,comparison:outcome.outcome.comparison,matchedChannels:Object.keys(outcome.channels)});
  }
  assert.equal(claimed.size,wires.length);assert.equal(proofCount,4);assert.equal(codeCount,4);
  await verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:SOURCE});await verifyNodeRuntime(source.runtime);
  return{status:'verified_and_reexecuted',evidenceManifestSha256:MANIFEST,sourceManifestSha256:SOURCE,planSha256:results.planSha256,evidenceFiles:manifest.files.length,sourceEntries:source.files.length,wireRecords:wires.length,responseEntityBytes:results.budget.observedBytes,unjoinedRecords:0,verifiedAccountProofs:proofCount,verifiedCodeValues:codeCount,localWorkerExecutions:caseReports.length,cases:caseReports,
    comparisonNormalizations:['inputEvidence[].durationMs','broker.records[].durationMs','isolation.durationMs','isolation.childPid (fresh process identity checked separately)'],
    limitations:{newStatesNotOriginalParentReplay:true,selectedDevelopmentCasesNotProspectiveSample:true,sameProviderForProofsAndTraces:true,independentLocalExecutionAlgorithm:true,consensusOrFinalityVerified:false,completeEconomicInventory:false,signedFeesOrBlobSidecarsVerified:false,populationAccuracyClaim:false},auditDependency:{path:HELPER,sha256:HELPER_SHA}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const out=await audit();if(process.argv[2]==='--write')writeFileSync(join(HERE,'results.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});else if(process.argv[2]==='--verify')assert.deepEqual(out,json(join(HERE,'results.json')));console.log(JSON.stringify(out,null,2));}
