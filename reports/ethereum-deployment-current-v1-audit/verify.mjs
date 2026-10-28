// Supplemental offline audit. Frozen proof/code wires are the only RPC inputs
// to a fresh archived worker. Provider execution is compared only afterward.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
const PACKET=resolve(HERE,'../ethereum-deployment-current-v1');
export const IDENTITIES=Object.freeze({
  evidence:'3aab8f526c5dee2d5ce765f66ea6108119faca53bc80105d2b093921a01a3841',
  plan:'84d716f5e6c416cbf071ff8e9a7047213b083b50895e8d0daea0da75586001f7',
  source:'87c7695fa5a93532596309b57f087959b759538279c4c9c3007db405f588b1f5',
  runner:'bf8b272b5aec53c1eb8ceb2eb877c1ebad0f1fbbf886409bd6d81ce354eea450',
});
const RUNNER='research/standard-evm/deployment-current.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const withoutDurations=rows=>rows.map(row=>{const copy=structuredClone(row);delete copy.durationMs;return copy;});

function readMember(base,row){
  assert.equal(typeof row.path,'string');
  assert(!row.path.startsWith('/')&&!row.path.split('/').some(p=>['','.','..'].includes(p)));
  const file=join(base,row.path),stat=lstatSync(file);
  assert(stat.isFile()&&!stat.isSymbolicLink());
  const bytes=readFileSync(file);assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);
  return bytes;
}

export function verifyWire(wire){
  assert.equal(wire.url,'https://eth.drpc.org/');assert.equal(wire.provider,'drpc');
  assert.equal(wire.dispatched,true);
  assert.equal(wire.request.jsonrpc,'2.0');assert.equal(wire.id,wire.request.id);
  assert.equal(JSON.stringify(wire.request),wire.requestText);
  assert.equal(sha(wire.requestText),wire.requestSha256);assert.equal(Buffer.byteLength(wire.requestText),wire.requestBytes);
  const raw=Buffer.from(wire.rawBase64,'base64');assert.equal(raw.toString('base64'),wire.rawBase64);
  assert.equal(wire.transport.complete,true);assert.equal(raw.length,wire.transport.retainedBytes);
  assert.equal(raw.length,wire.transport.observedBytes);assert(raw.length<=8*1024*1024);
  for(const digest of [wire.transport.retainedSha256,wire.transport.observedSha256,wire.responseSha256])assert.equal(sha(raw),digest);
  assert.equal(new TextDecoder('utf8',{fatal:true}).decode(raw),wire.responseText);
  const parsed=JSON.parse(wire.responseText);
  assert.equal(parsed.id,wire.id);assert.equal(parsed.jsonrpc,'2.0');
  if(wire.status==='completed'){
    assert.equal(wire.httpStatus,200);assert.deepEqual(parsed,wire.parsed);
    assert(Object.hasOwn(parsed,'result')&&!Object.hasOwn(parsed,'error'));
  }else{
    assert.equal(wire.status,'failed');assert.equal(wire.httpStatus,400);assert.equal(wire.error,'http_error');
    assert.equal(Object.hasOwn(wire,'parsed'),false);
    assert.deepEqual(parsed,{id:wire.id,jsonrpc:'2.0',error:{message:'Error: -32602, Required "to" is empty',code:5}});
  }
  assert(Number.isFinite(wire.transport.durationMs)&&wire.transport.durationMs>=0&&wire.transport.durationMs<=25000);
  assert(Number.isFinite(Date.parse(wire.startedAt)));
  return wire;
}

export function createPlayback(wires){
  const saved=structuredClone(wires);let consumed=0,mismatch=null;
  return {get consumed(){return consumed;},get mismatch(){return mismatch;},async call(method,params){
    try{
      assert(['eth_getProof','eth_getCode'].includes(method),'Only proof/code input reads are admitted');
      const row=saved[consumed++];assert(row,'Unexpected extra input read');
      assert.deepEqual({method,params},{method:row.request.method,params:row.request.params});
      assert.equal(row.status,'completed');assert(Object.hasOwn(row.parsed,'result'));
      return structuredClone(row.parsed.result);
    }catch(error){mismatch??=error;throw error;}
  }};
}

// Fixed constructor bytes come only from the declaration. CREATE address uses
// an independently encoded RLP([sender, initial nonce]), never a trace address.
export function deriveDeclaredCase(c){
  assert.equal(c.sender,'0xbb6e024b9cffacb947a71991e386681b1cd1477d');
  assert.equal(c.runtime,'0x60005460005260206000f3');
  const runtimeLength=(c.runtime.length-2)/2,len=runtimeLength.toString(16).padStart(4,'0');
  const init='0x602a60005561'+len+'61001460003961'+len+'6000f3'+c.runtime.slice(2);
  assert.equal(c.initcode,init);
  assert.equal(c.targetDerivation,'keccak256_rlp_sender_proven_initial_nonce');
  assert.deepEqual(c.request,{from:c.sender,to:null,data:init,value:'0',gas:'5000000'});
  return {runtimeBytes:runtimeLength,initcodeBytes:(init.length-2)/2};
}
export function deriveCreateAddress(sender,nonceRaw,keccak){
  assert.match(sender,/^0x[0-9a-f]{40}$/);assert.match(nonceRaw,/^(?:0|[1-9][0-9]*)$/);
  const nonce=BigInt(nonceRaw);assert(nonce<(1n<<64n)-1n);
  let digits=nonce.toString(16);if(digits.length%2)digits='0'+digits;
  const bytes=nonce===0n?Buffer.alloc(0):Buffer.from(digits,'hex');
  const encodedNonce=bytes.length===1&&bytes[0]<128?bytes:Buffer.concat([Buffer.from([128+bytes.length]),bytes]);
  const payload=Buffer.concat([Buffer.from([148]),Buffer.from(sender.slice(2),'hex'),encodedNonce]);
  const rlp=Buffer.concat([Buffer.from([192+payload.length]),payload]);
  return '0x'+Buffer.from(keccak(rlp)).subarray(12).toString('hex');
}

export async function loadPacket(){
  const bytes=readFileSync(join(PACKET,'evidence-manifest.json'));assert.equal(sha(bytes),IDENTITIES.evidence);
  const manifest=JSON.parse(bytes),members=new Map(manifest.files.map(row=>[row.path,row]));assert.equal(members.size,manifest.files.length);
  for(const row of manifest.files)readMember(PACKET,row);
  const get=path=>{assert(members.has(path),'Unbound evidence '+path);return JSON.parse(readMember(PACKET,members.get(path)));};
  assert.equal(sha(readMember(PACKET,members.get('plan.json'))),IDENTITIES.plan);
  assert.equal(sha(readMember(PACKET,members.get('source-manifest.json'))),IDENTITIES.source);
  assert.equal(manifest.planSha256,IDENTITIES.plan);assert.equal(manifest.sourceManifestSha256,IDENTITIES.source);
  const source=get('source-manifest.json'),paths=new Set();
  for(const row of source.files){
    assert(!paths.has(row.path));paths.add(row.path);
    if(row.kind==='symlink'){
      assert(!row.path.startsWith('/')&&!row.path.split('/').some(p=>['','.','..'].includes(p)));
      const file=join(PACKET,'runtime',row.path);assert(lstatSync(file).isSymbolicLink());assert.equal(readlinkSync(file),row.target);
    }else readMember(join(PACKET,'runtime'),row);
  }
  assert.equal(source.files.find(row=>row.path===RUNNER)?.sha256,IDENTITIES.runner);
  const frozen=path=>{assert(paths.has(path),'Unbound source import '+path);return import(pathToFileURL(join(PACKET,'runtime',path)));};
  const {verifyFrozenSources,verifyNodeRuntime}=await frozen('research/standard-evm/cohort-freeze.mjs');
  await verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:IDENTITIES.source});await verifyNodeRuntime(source.runtime);
  const runner=await frozen(RUNNER);await runner.checkDeployment({outputDirectory:PACKET,expectedPlanSha256:IDENTITIES.plan});
  return {manifest,source,get,frozen,runner,verifyFrozenSources,verifyNodeRuntime};
}

export async function audit({negativeProof=false}={}){
  const p=await loadPacket(),{get,frozen}=p,plan=get('plan.json'),results=get('results.json'),start=get('STARTED.json');
  for(const row of [results,start]){assert.equal(row.planSha256,IDENTITIES.plan);assert.equal(row.sourceManifestSha256,IDENTITIES.source);}
  assert.deepEqual(start.runtime,plan.runtime);assert(Date.parse(start.startedAt)>=Date.parse(plan.frozenAt));
  assert.equal(results.status,'incomplete');assert.equal(results.sourceUnchanged,true);assert.equal(results.runtimeUnchanged,true);
  assert.deepEqual(results.failures,[{phase:'provider',code:'http_error'}]);
  assert.deepEqual(results.scope,plan.scope);assert.equal(results.selectionStatus,'selected');assert.equal(results.localStatus,'success');
  assert.equal(results.targetStatus,'verified');assert.equal(results.providerPlannedRequests,3);assert.equal(results.providerRequests,1);
  assert(Number.isFinite(results.durationMs)&&results.durationMs>=0&&results.durationMs<=plan.policy.liveAndDrainCeilingMs);
  const {keccak_256}=await frozen('engines/local-evm/node_modules/@noble/hashes/sha3.js');
  const declared=deriveDeclaredCase(plan.case);
  const wires=p.manifest.files.filter(row=>/^wire\/[0-9]{6}\.json$/.test(row.path)).map(row=>verifyWire(get(row.path))).sort((a,b)=>a.globalId-b.globalId);
  assert.deepEqual(wires.map(row=>row.globalId),Array.from({length:7},(_,i)=>i+1));
  assert.deepEqual(wires.map(row=>row.profile),['census','census',...Array(4).fill('local'),'product']);
  assert.deepEqual(wires.map(row=>row.id),[1,2,1,2,3,4,1]);
  assert.equal(results.budget.calls,wires.length);assert.equal(results.budget.dispatches,wires.length);assert.equal(results.budget.saveFailure,false);
  assert.equal(results.budget.observedBytes,wires.reduce((n,row)=>n+row.transport.observedBytes,0));
  assert.deepEqual(results.budget.limits,{calls:plan.policy.calls,totalBytes:plan.policy.totalBytes,wallMs:plan.policy.wallMs});
  for(let i=0;i<wires.length;i++){
    assert(Date.parse(wires[i].startedAt)>=Date.parse(start.startedAt));
    if(i)assert(Date.parse(wires[i].startedAt)>=Date.parse(wires[i-1].startedAt));
  }
  const selection=get('selection.json'),header=selection.header;
  assert.equal(wires[0].request.method,'eth_chainId');assert.deepEqual(wires[0].request.params,[]);assert.equal(wires[0].parsed.result,'0x1');
  assert.equal(wires[1].request.method,'eth_getBlockByNumber');assert.deepEqual(wires[1].request.params,['latest',false]);assert.deepEqual(wires[1].parsed.result,header);
  assert.equal(selection.status,'selected');assert.equal(selection.chainId,'0x1');
  const {verifyEthereumHeader}=await frozen('engines/local-evm/ethereum-header.js');
  assert.deepEqual(verifyEthereumHeader({header,expectedHash:header.hash}),selection.verification);
  const l=get('local.json'),local=l.attempt,localWires=wires.slice(2,6),selector={blockHash:header.hash,requireCanonical:true};
  assert.deepEqual(l.implementation,plan.localImplementation);assert.deepEqual(l.transportWireIds,[3,4,5,6]);assert.deepEqual(l.denied,[]);
  assert.equal(l.usage.attempts,4);assert.equal(l.usage.dispatches,4);assert.equal(l.usage.observedBytes,localWires.reduce((n,row)=>n+row.transport.observedBytes,0));
  assert.deepEqual(l.usage.limits,{calls:plan.policy.localCalls,totalBytes:plan.policy.localBytes,requestMs:plan.policy.requestMs,responseBytes:plan.policy.responseBytes,wallMs:145000});
  assert.equal(local.inputEvidence.length,4);assert.equal(local.broker.records.length,4);assert.equal(local.broker.pendingAtReturn,0);
  assert.equal(local.isolation.processClosed,true);assert.equal(local.isolation.exitCode,0);assert.equal(local.isolation.exitSignal,null);
  const codes=new Map(localWires.filter(row=>row.request.method==='eth_getCode').map(row=>[row.request.params[0],row.parsed.result]));
  const {verifyStateProof}=await frozen('engines/local-evm/verified-state-proof.js');const proofRows=[];
  for(const [i,w]of localWires.entries()){
    const inner=local.inputEvidence[i],broker=local.broker.records[i],request={method:w.request.method,params:w.request.params};
    assert.deepEqual(w.request.params.at(-1),selector);assert.equal(inner.id,i+1);assert.equal(broker.id,i+1);
    assert.deepEqual(inner.request,request);assert.deepEqual(broker.request,request);assert.equal(inner.requestText,JSON.stringify(request));assert.equal(inner.requestSha256,sha(inner.requestText));
    assert.deepEqual(inner.result,w.parsed.result);assert.equal(inner.resultSha256,sha(JSON.stringify(w.parsed.result)));assert.equal(broker.resultSha256,inner.resultSha256);
    assert.equal(inner.resultBytes,Buffer.byteLength(JSON.stringify(w.parsed.result)));assert.equal(broker.resultBytes,inner.resultBytes);
    assert.equal(inner.status,'received');assert.equal(inner.verification,'verified');assert.equal(broker.status,'received');assert.equal(broker.dispatched,true);
    if(w.request.method==='eth_getProof'){
      const address=w.request.params[0];assert.deepEqual(w.request.params[1],[]);
      const proof=await verifyStateProof({stateRoot:header.stateRoot,address,storageKeys:[],proof:w.parsed.result,code:codes.get(address)});
      assert.equal(proof.status,'verified');assert.equal(proof.code.status,'verified');
      assert.deepEqual(local.inputs.provenance.find(row=>row.account===address).accountProof,proof.account);
      proofRows.push({address,...proof.account,codeBytes:(proof.code.bytes.length-2)/2});
    }else assert.equal(w.request.method,'eth_getCode');
  }
  assert.equal(proofRows.length,2);assert.equal(codes.size,2);
  const senderProof=proofRows.find(row=>row.address===plan.case.sender);assert(senderProof?.exists);assert.equal(senderProof.codeBytes,0);
  const target=deriveCreateAddress(plan.case.sender,senderProof.nonceRaw,keccak_256);
  const proof=local.inputs.provenance.find(row=>row.account===plan.case.sender);
  const targetRecord={status:'verified',sender:plan.case.sender,senderNonceRaw:senderProof.nonceRaw,address:target,blockHash:header.hash,stateRoot:header.stateRoot,proofEvidenceId:proof.proofEvidenceId,codeEvidenceId:proof.codeEvidenceId,basis:plan.case.targetDerivation};
  assert.deepEqual(get('target.json'),targetRecord);
  assert.deepEqual(localWires.map(w=>[w.request.method,w.request.params[0]]),[['eth_getProof',plan.case.sender],['eth_getCode',plan.case.sender],['eth_getProof',target],['eth_getCode',target]]);
  const {validateInputFacts}=await frozen('engines/local-evm/input-facts.js');
  await validateInputFacts({inputs:local.inputs,inputEvidence:local.inputEvidence,stateRoot:header.stateRoot});
  assert.deepEqual(local.inputs.accounts[target],{exists:false});assert.equal(proofRows.find(row=>row.address===target).exists,false);
  assert.deepEqual(local.inputs.provenance.find(row=>row.account===target).storage,[{key:word(0),value:word(0),exists:false,evidenceId:3}]);
  assert.equal(local.inputs.context.expectedOutputsUsed,false);assert.deepEqual(local.inputs.context.header,header);
  // Only declaration, selected header and four proof/code responses enter the
  // fresh child. No recorded output or provider state enters execution inputs.
  const inputWires=structuredClone(localWires);
  if(negativeProof){const node=inputWires[0].parsed.result.accountProof[0];inputWires[0].parsed.result.accountProof[0]=node.slice(0,-2)+(node.endsWith('00')?'01':'00');}
  const rpc=createPlayback(inputWires),{executeIsolatedEthereumCall}=await frozen('engines/local-evm/isolated-call.js');
  const replay=await executeIsolatedEthereumCall({request:plan.case.request,header,rpc,limits:{wallMs:plan.policy.localWallMs,drainMs:plan.policy.drainMs}});
  assert.equal(rpc.mismatch,null);assert.equal(replay.broker.pendingAtReturn,0);assert.equal(replay.isolation.processClosed,true);
  assert.equal(replay.isolation.exitCode,0);assert.equal(replay.isolation.exitSignal,null);assert.notEqual(replay.isolation.childPid,process.pid);
  if(negativeProof){
    assert.equal(replay.output.execution.status,'unavailable');assert.deepEqual(replay.changes.accounts,[]);assert(rpc.consumed<4);
    return {status:'corrupted_proof_rejected',consumedInputReads:rpc.consumed,execution:replay.output.execution.status};
  }
  assert.equal(rpc.consumed,4);assert.equal(replay.status,'completed');
  for(const key of ['status','error','output','inputs','inputUsage','inputReads','stateReads','changes','headerVerification'])assert.deepEqual(replay[key],local[key],key+' differs');
  assert.deepEqual(withoutDurations(replay.inputEvidence),withoutDurations(local.inputEvidence));
  assert.deepEqual({...replay.broker,records:withoutDurations(replay.broker.records)},{...local.broker,records:withoutDurations(local.broker.records)});
  const isolation=row=>{const copy=structuredClone(row);delete copy.durationMs;delete copy.childPid;return copy;};assert.deepEqual(isolation(replay.isolation),isolation(local.isolation));
  // Provider rejection is loaded for comparison only after local reexecution.
  const provider=get('provider.json');assert.deepEqual(provider.records,wires.slice(6));assert.deepEqual(provider.denied,[]);
  assert.equal(provider.basis,'raw_provider_execution_not_product_API');assert.equal(provider.usage.attempts,1);assert.equal(provider.usage.dispatches,1);
  assert.equal(provider.usage.observedBytes,wires[6].transport.observedBytes);
  assert.deepEqual(provider.usage.limits,{calls:plan.policy.providerCalls,totalBytes:plan.policy.providerBytes,requestMs:plan.policy.requestMs,responseBytes:plan.policy.responseBytes,wallMs:145000});
  const expectedProviderRequest={method:'debug_traceCall',params:[{from:plan.case.sender,to:null,data:plan.case.initcode,value:'0x0',gas:'0x4c4b40',gasPrice:'0x0'},selector,{tracer:'callTracer',tracerConfig:{withLog:true},blockOverrides:{baseFeePerGas:'0x0'}}]};
  assert.deepEqual({method:wires[6].request.method,params:wires[6].request.params},expectedProviderRequest);
  const rejection=JSON.parse(wires[6].responseText);assert.equal(rejection.error.message,'Error: -32602, Required "to" is empty');
  const comparison=await p.runner.compareDeployment({header,local:replay,provider:provider.records});
  assert.deepEqual(comparison,get('comparison.json'));assert.deepEqual(comparison,results.comparison);
  assert.deepEqual(comparison,{status:'unavailable',channels:{},allChannelsComplete:false,reason:'provider_sequence_incomplete',scope:'retained_incomplete_development_comparison'});
  assert.deepEqual(await p.runner.deriveDeploymentTarget({header,local:replay}),targetRecord);
  // Independent fixed-case checks describe LOCAL results only. There is no
  // provider trace/diff or final canonical header to claim agreement against.
  const trace=replay.output.trace;
  assert.equal(trace.type,'CREATE');assert.equal(trace.from,plan.case.sender);assert.equal(trace.caller,plan.case.sender);
  assert.equal(trace.to,target);assert.equal(trace.executionAddress,target);assert.equal(trace.input,plan.case.initcode);
  assert.equal(trace.output,plan.case.runtime);assert.equal(trace.error,null);assert.deepEqual(trace.calls,[]);
  assert.equal(replay.output.execution.returnData,plan.case.runtime);assert.deepEqual(replay.output.logs,[]);
  assert.deepEqual(replay.changes.accounts,[
    {address:plan.case.sender,nonce:{before:'0x'+BigInt(senderProof.nonceRaw).toString(16),after:'0x'+(BigInt(senderProof.nonceRaw)+1n).toString(16)}},
    {address:target,existence:{before:false,after:true,basis:'top_level_contract_creation'},nonce:{before:'0x0',after:'0x1'},storage:[{slot:word(0),before:word(0),after:word(42)}],code:{before:'0x',after:plan.case.runtime}},
  ]);
  const callBytes=Buffer.from(plan.case.initcode.slice(2),'hex'),zero=[...callBytes].filter(byte=>byte===0).length;
  const wordGas=2n*((BigInt(callBytes.length)+31n)/32n),intrinsic=21000n+32000n+wordGas+4n*BigInt(zero)+16n*BigInt(callBytes.length-zero);
  const message=BigInt(replay.output.execution.executionGasUsed),total=intrinsic+message;
  assert.equal(replay.output.execution.gasRefundCounter,'0');assert.equal(replay.output.profile.intrinsicGas,intrinsic.toString());
  assert.equal(BigInt(trace.gas),5000000n-intrinsic);assert.equal(BigInt(trace.gasUsed),message);
  assert.deepEqual(replay.output.gasAccounting,{beforeRefund:total.toString(),appliedRefund:'0',floorAdjustment:'0',gasUsed:total.toString()});
  assert.equal(total,77720n);assert.equal(replay.changes.accounts.length,2);
  await p.verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:IDENTITIES.source});await p.verifyNodeRuntime(p.source.runtime);
  for(const row of p.manifest.files)readMember(PACKET,row);
  return {status:'verified_and_reexecuted_local_provider_unavailable',identities:IDENTITIES,evidenceFiles:p.manifest.files.length,sourceEntries:p.source.files.length,
    localImplementationSha256:plan.localImplementation.sourceSha256,productImplementationSha256:plan.productImplementation.sourceSha256,
    block:{hash:header.hash,number:BigInt(header.number).toString(),stateRoot:header.stateRoot,hardfork:selection.verification.hardfork,finalCanonicalRecheckObtained:false},
    declaredCase:{...declared,target,senderNonceRaw:senderProof.nonceRaw},wireRecords:wires.length,responseEntityBytes:results.budget.observedBytes,unjoinedWireRecords:0,
    proofAudit:{proofs:proofRows,codeResponses:codes.size,slotZeroBasis:'cryptographically_proven_target_account_absence'},
    replay:{workerExecutions:1,proofCodeReads:rpc.consumed,exactExecutionAndState:true,execution:replay.output.execution.status,steps:replay.output.usage.steps,frames:replay.output.usage.frames,gas:{intrinsic:intrinsic.toString(),creationIntrinsic:'32000',initcodeWordGas:wordGas.toString(),message:message.toString(),refundCounter:'0',total:total.toString()},changedAccounts:replay.changes.accounts},
    provider:{attemptedRequests:1,plannedRequests:3,httpStatus:400,error:rejection.error,traceObtained:false,stateDiffObtained:false,finalCanonicalHeaderObtained:false},
    comparison:{status:comparison.status,channels:comparison.channels,allChannelsComplete:comparison.allChannelsComplete,reason:comparison.reason,independentProviderAgreement:false},
    comparisonNormalizations:['inputEvidence[].durationMs','broker.records[].durationMs','isolation.durationMs','isolation.childPid (fresh child process checked separately)'],
    limitations:{singleFixedDevelopmentCase:true,rawProviderComparisonNotProductApi:true,proofsFromOneProvider:true,unsignedUnpricedBlockEnd:true,feesOrSignaturesVerified:false,consensusOrFinalityVerified:false,postStateRootRecomputed:false,completeEconomicInventory:false,fullCallTreeComparison:false,lifecycleScopeExpandedByAudit:false,osSandboxEstablished:false,populationAccuracyClaim:false,publicCallsDuringAudit:0}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await audit();
  if(process.argv[2]==='--write')writeFileSync(join(HERE,'results.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  else if(process.argv[2]==='--verify')assert.deepEqual(result,JSON.parse(readFileSync(join(HERE,'results.json'))));
  console.log(JSON.stringify(result,null,2));
}
