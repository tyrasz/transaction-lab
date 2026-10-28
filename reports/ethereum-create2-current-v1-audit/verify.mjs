// Supplemental offline audit. Frozen proof/code wires are the only RPC inputs
// to a fresh archived worker. Provider execution is compared only afterward.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
const PACKET=resolve(HERE,'../ethereum-create2-current-v1');
export const IDENTITIES=Object.freeze({
  evidence:'eba759a9e0bec7fd50a9160a42b0a76d79966a8f9f7f4d1c9d4cfc0bbce93dab',
  plan:'ff9a66e5006a96a76d353c3aa5aa6f77ac9089c367a939d1ec19f32a033c57cc',
  source:'49c5fd113a4fec2a2687b501d22e9b38deed767d55e656ee2ebc0ca6ce99bcf1',
  runner:'a11bd25335c75f7b98b1fb9b00b45e36ee2154ed1b37c363812736d02ca3cf62',
});
const RUNNER='research/standard-evm/lifecycle-current.mjs';
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
  assert.equal(wire.dispatched,true);assert.equal(wire.status,'completed');assert.equal(wire.httpStatus,200);
  assert.equal(wire.request.jsonrpc,'2.0');assert.equal(wire.id,wire.request.id);
  assert.equal(JSON.stringify(wire.request),wire.requestText);
  assert.equal(sha(wire.requestText),wire.requestSha256);assert.equal(Buffer.byteLength(wire.requestText),wire.requestBytes);
  const raw=Buffer.from(wire.rawBase64,'base64');assert.equal(raw.toString('base64'),wire.rawBase64);
  assert.equal(wire.transport.complete,true);assert.equal(raw.length,wire.transport.retainedBytes);
  assert.equal(raw.length,wire.transport.observedBytes);assert(raw.length<=8*1024*1024);
  for(const digest of [wire.transport.retainedSha256,wire.transport.observedSha256,wire.responseSha256])assert.equal(sha(raw),digest);
  assert.equal(new TextDecoder('utf8',{fatal:true}).decode(raw),wire.responseText);
  assert.deepEqual(JSON.parse(wire.responseText),wire.parsed);
  assert.equal(wire.parsed.id,wire.id);assert.equal(wire.parsed.jsonrpc,'2.0');
  assert(Object.hasOwn(wire.parsed,'result')&&!Object.hasOwn(wire.parsed,'error'));
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

// Independently construct the declared initcode and ABI, then apply EIP-1014's
// address formula. No trace/output field supplies any of these inputs.
export function deriveDeclaredCase(c,keccak){
  assert.equal(c.factory,'0xce0042b868300000d44a59004da54a005ffdcf9f');
  assert.equal(c.sender,'0xbb6e024b9cffacb947a71991e386681b1cd1477d');
  assert.equal(c.runtime,'0x60005460005260206000f3');
  const runtimeLength=(c.runtime.length-2)/2,len=runtimeLength.toString(16).padStart(4,'0');
  const init='0x602a60005561'+len+'61001460003961'+len+'6000f3'+c.runtime.slice(2);
  const salt='0x'+sha('transaction-lab/declared-create2-development/v1');
  const hash=bytes=>Buffer.from(keccak(bytes));
  const selector='0x'+hash(Buffer.from('deploy(bytes,bytes32)')).subarray(0,4).toString('hex');
  const data=selector+word(64).slice(2)+salt.slice(2)+word((init.length-2)/2).slice(2)+init.slice(2).padEnd(Math.ceil((init.length-2)/64)*64,'0');
  const initHash=hash(Buffer.from(init.slice(2),'hex'));
  const target='0x'+hash(Buffer.concat([Buffer.from([255]),Buffer.from(c.factory.slice(2),'hex'),Buffer.from(salt.slice(2),'hex'),initHash])).subarray(12).toString('hex');
  assert.equal(c.initcode,init);assert.equal(c.salt,salt);assert.equal(c.target,target);
  assert.deepEqual(c.request,{from:c.sender,to:c.factory,data,value:'0',gas:'5000000'});
  return {target,runtimeBytes:runtimeLength,initcodeBytes:(init.length-2)/2,initcodeHash:'0x'+initHash.toString('hex'),selector};
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
  const runner=await frozen(RUNNER);await runner.checkLifecycle({outputDirectory:PACKET,expectedPlanSha256:IDENTITIES.plan});
  return {manifest,source,get,frozen,runner,verifyFrozenSources,verifyNodeRuntime};
}

export async function audit({negativeProof=false}={}){
  const p=await loadPacket(),{get,frozen}=p,plan=get('plan.json'),results=get('results.json'),start=get('STARTED.json');
  for(const row of [results,start]){assert.equal(row.planSha256,IDENTITIES.plan);assert.equal(row.sourceManifestSha256,IDENTITIES.source);}
  assert.deepEqual(start.runtime,plan.runtime);assert(Date.parse(start.startedAt)>=Date.parse(plan.frozenAt));
  assert.equal(results.status,'complete');assert.equal(results.sourceUnchanged,true);assert.equal(results.runtimeUnchanged,true);assert.deepEqual(results.failures,[]);
  assert.deepEqual(results.scope,plan.scope);assert.equal(results.selectionStatus,'selected');assert.equal(results.localStatus,'success');assert.equal(results.providerRequests,3);
  assert(Number.isFinite(results.durationMs)&&results.durationMs>=0&&results.durationMs<=plan.policy.liveAndDrainCeilingMs);
  const {keccak_256}=await frozen('engines/local-evm/node_modules/@noble/hashes/sha3.js');
  const declared=deriveDeclaredCase(plan.case,keccak_256);
  const wires=p.manifest.files.filter(row=>/^wire\/[0-9]{6}\.json$/.test(row.path)).map(row=>verifyWire(get(row.path))).sort((a,b)=>a.globalId-b.globalId);
  assert.deepEqual(wires.map(row=>row.globalId),Array.from({length:11},(_,i)=>i+1));
  assert.deepEqual(wires.map(row=>row.profile),['census','census',...Array(6).fill('local'),...Array(3).fill('product')]);
  assert.deepEqual(wires.map(row=>row.id),[1,2,1,2,3,4,5,6,1,2,3]);
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
  const l=get('local.json'),local=l.attempt,localWires=wires.slice(2,8),selector={blockHash:header.hash,requireCanonical:true};
  assert.deepEqual(l.implementation,plan.localImplementation);assert.deepEqual(l.transportWireIds,[3,4,5,6,7,8]);assert.deepEqual(l.denied,[]);
  assert.equal(l.usage.attempts,6);assert.equal(l.usage.dispatches,6);assert.equal(l.usage.observedBytes,localWires.reduce((n,row)=>n+row.transport.observedBytes,0));
  assert.equal(local.inputEvidence.length,6);assert.equal(local.broker.records.length,6);assert.equal(local.broker.pendingAtReturn,0);
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
      const proof=await verifyStateProof({stateRoot:header.stateRoot,address,storageKeys:w.request.params[1],proof:w.parsed.result,code:codes.get(address)});
      assert.equal(proof.status,'verified');assert.equal(proof.code.status,'verified');
      assert.deepEqual(local.inputs.provenance.find(row=>row.account===address).accountProof,proof.account);
      proofRows.push({address,...proof.account,codeBytes:(proof.code.bytes.length-2)/2});
    }else assert.equal(w.request.method,'eth_getCode');
  }
  assert.equal(proofRows.length,3);assert.equal(codes.size,3);
  const {validateInputFacts}=await frozen('engines/local-evm/input-facts.js');
  await validateInputFacts({inputs:local.inputs,inputEvidence:local.inputEvidence,stateRoot:header.stateRoot});
  assert.deepEqual(local.inputs.accounts[declared.target],{exists:false});
  assert.deepEqual(local.inputs.provenance.find(row=>row.account===declared.target).storage,[{key:word(0),value:word(0),exists:false,evidenceId:5}]);
  assert.equal(local.inputs.context.expectedOutputsUsed,false);assert.deepEqual(local.inputs.context.header,header);
  // These arguments come only from the frozen declaration, selected header,
  // and six proof/code responses. No saved local/provider output is supplied.
  const inputWires=structuredClone(localWires);
  if(negativeProof){const node=inputWires[0].parsed.result.accountProof[0];inputWires[0].parsed.result.accountProof[0]=node.slice(0,-2)+(node.endsWith('00')?'01':'00');}
  const rpc=createPlayback(inputWires),{executeIsolatedEthereumCall}=await frozen('engines/local-evm/isolated-call.js');
  const replay=await executeIsolatedEthereumCall({request:plan.case.request,header,rpc,limits:{wallMs:plan.policy.localWallMs,drainMs:plan.policy.drainMs}});
  assert.equal(rpc.mismatch,null);assert.equal(replay.broker.pendingAtReturn,0);assert.equal(replay.isolation.processClosed,true);
  assert.equal(replay.isolation.exitCode,0);assert.equal(replay.isolation.exitSignal,null);assert.notEqual(replay.isolation.childPid,process.pid);
  if(negativeProof){
    assert.equal(replay.output.execution.status,'unavailable');assert.deepEqual(replay.changes.accounts,[]);assert(rpc.consumed<6);
    return {status:'corrupted_proof_rejected',consumedInputReads:rpc.consumed,execution:replay.output.execution.status};
  }
  assert.equal(rpc.consumed,6);assert.equal(replay.status,'completed');
  for(const key of ['status','error','output','inputs','inputUsage','inputReads','stateReads','changes','headerVerification'])assert.deepEqual(replay[key],local[key],key+' differs');
  assert.deepEqual(withoutDurations(replay.inputEvidence),withoutDurations(local.inputEvidence));
  assert.deepEqual({...replay.broker,records:withoutDurations(replay.broker.records)},{...local.broker,records:withoutDurations(local.broker.records)});
  const isolation=row=>{const copy=structuredClone(row);delete copy.durationMs;delete copy.childPid;return copy;};assert.deepEqual(isolation(replay.isolation),isolation(local.isolation));
  // Only now load provider output for the separate five-channel comparison.
  const provider=get('provider.json');assert.deepEqual(provider.records,wires.slice(8));assert.deepEqual(provider.denied,[]);
  assert.equal(provider.basis,'raw_provider_execution_not_product_API');assert.equal(provider.usage.attempts,3);assert.equal(provider.usage.dispatches,3);
  assert.equal(provider.usage.observedBytes,wires.slice(8).reduce((n,row)=>n+row.transport.observedBytes,0));
  const comparison=await p.runner.compareLifecycle({header,local:replay,provider:provider.records});
  assert.deepEqual(comparison,get('comparison.json'));assert.deepEqual(comparison,results.comparison);
  assert.deepEqual(comparison.channels,{execution:true,returnData:true,gas:true,logs:true,state:true});assert.equal(comparison.allChannelsComplete,true);assert.equal(comparison.status,'match');
  // Independent fixed-case checks on the actual output, including the absence
  // basis and every changed account, supplement the frozen comparator replay.
  const trace=provider.records[0].parsed.result,diff=provider.records[1].parsed.result;
  assert.deepEqual(provider.records[2].parsed.result,header);
  assert.deepEqual(Object.keys(diff.pre).sort(),[plan.case.sender,plan.case.factory].sort());
  assert.deepEqual(Object.keys(diff.post).sort(),[plan.case.sender,plan.case.factory,declared.target].sort());
  for(const address of [plan.case.sender,plan.case.factory]){
    assert.equal(BigInt(diff.pre[address].nonce),BigInt(local.inputs.accounts[address].nonce));
    assert.equal(BigInt(diff.post[address].nonce),BigInt(diff.pre[address].nonce)+1n);
    assert.deepEqual(Object.keys(diff.post[address]),['nonce']);
  }
  assert.deepEqual(diff.post[declared.target],{code:plan.case.runtime,nonce:1,storage:{[word(0)]:word(42)}});
  assert.equal(trace.output,word(BigInt(declared.target)));assert.equal(trace.calls[0].output,plan.case.runtime);
  assert.equal(replay.output.execution.returnData,trace.output);assert.deepEqual(replay.output.logs,[]);assert.equal(trace.logs,undefined);assert.equal(trace.calls[0].logs,undefined);
  const callBytes=Buffer.from(plan.case.request.data.slice(2),'hex'),zero=[...callBytes].filter(byte=>byte===0).length;
  const intrinsic=21000n+4n*BigInt(zero)+16n*BigInt(callBytes.length-zero);
  assert.equal(replay.output.execution.gasRefundCounter,'0');
  assert.equal(intrinsic+BigInt(replay.output.execution.executionGasUsed),BigInt(trace.gasUsed));
  assert.equal(comparison.gas.localTotal,'79180');assert.equal(replay.changes.accounts.length,3);
  await p.verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:IDENTITIES.source});await p.verifyNodeRuntime(p.source.runtime);
  for(const row of p.manifest.files)readMember(PACKET,row);
  return {status:'verified_and_reexecuted',identities:IDENTITIES,evidenceFiles:p.manifest.files.length,sourceEntries:p.source.files.length,
    localImplementationSha256:plan.localImplementation.sourceSha256,productImplementationSha256:plan.productImplementation.sourceSha256,
    block:{hash:header.hash,number:BigInt(header.number).toString(),stateRoot:header.stateRoot,hardfork:selection.verification.hardfork},
    declaredCase:declared,wireRecords:wires.length,responseEntityBytes:results.budget.observedBytes,unjoinedWireRecords:0,
    proofAudit:{proofs:proofRows,codeResponses:codes.size,slotZeroBasis:'cryptographically_proven_target_account_absence'},
    replay:{workerExecutions:1,proofCodeReads:rpc.consumed,exactExecutionAndState:true,execution:replay.output.execution.status,steps:replay.output.usage.steps,frames:replay.output.usage.frames,gas:comparison.gas,changedAccounts:replay.changes.accounts},
    comparison:{status:comparison.status,channels:comparison.channels,allChannelsComplete:comparison.allChannelsComplete},
    comparisonNormalizations:['inputEvidence[].durationMs','broker.records[].durationMs','isolation.durationMs','isolation.childPid (fresh child process checked separately)'],
    limitations:{singleFixedDevelopmentCase:true,rawProviderComparisonNotProductApi:true,sameProviderForProofsAndTraces:true,unsignedUnpricedBlockEnd:true,feesOrSignaturesVerified:false,consensusOrFinalityVerified:false,postStateRootRecomputed:false,completeEconomicInventory:false,fullCallTreeComparison:false,selfdestructSupported:false,osSandboxEstablished:false,populationAccuracyClaim:false,publicCallsDuringAudit:0}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await audit();
  if(process.argv[2]==='--write')writeFileSync(join(HERE,'results.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  else if(process.argv[2]==='--verify')assert.deepEqual(result,JSON.parse(readFileSync(join(HERE,'results.json'))));
  console.log(JSON.stringify(result,null,2));
}
