// Supplemental, read-only audit of one selected development comparison.
// Original capture files are never rewritten. No network or VM execution.
import assert from 'node:assert/strict';
import { readFile, lstat, readlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const dir=dirname(fileURLToPath(import.meta.url)), root=resolve(dir,'../..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=async p=>readFile(resolve(root,p));
const json=async p=>JSON.parse(await read(p));
const LOCAL='reports/local-evm-api-live-latest-approve-v1', PROVIDER='reports/local-evm-api-latest-approve-comparison-v1';
const pinned={local:'dd9e722a8690e507438f38f2bb026d7531ebd31a561bf6f8fb7c3361963d6a11',provider:'44fd22c28f37cc8c8fa7d587e5497163206742e4ef00c66ddf09ca302d733b68',localSource:'5285db4735d7bdb82653f33f018489a9dbf6649c977dc264881d715ac452ab21',providerSource:'e4895b01e43b14358d83d0747b05bef1b239f70621d18ced84ce40b149f11817'};
const files=[];
for(const [base,names] of [[LOCAL,['declaration.json','request.json','response.json','metadata.json']],[PROVIDER,['request.json','response.json','metadata.json']]])for(const name of names){const path=base+'/'+name,b=await read(path);files.push({path,bytes:b.length,sha256:sha(b)});}
const l=await json(LOCAL+'/response.json'),p=await json(PROVIDER+'/response.json'), lm=await json(LOCAL+'/metadata.json'),pm=await json(PROVIDER+'/metadata.json'),decl=await json(LOCAL+'/declaration.json');
assert.equal(sha(await read(LOCAL+'/response.json')),pinned.local);assert.equal(sha(await read(PROVIDER+'/response.json')),pinned.provider);
assert.equal(lm.responseSha256,pinned.local);assert.equal(pm.responseSha256,pinned.provider);assert.equal(pm.localResponseSha256,pinned.local);
assert.equal(lm.responseBytes,(await read(LOCAL+'/response.json')).length);assert.equal(lm.status,200);assert.equal(pm.httpStatus,200);
assert.equal(decl.requestSha256,sha(await read(LOCAL+'/request.json')));assert.equal(decl.requestBytes,(await read(LOCAL+'/request.json')).length);
assert.equal(l.implementation.sourceSha256,pinned.localSource);assert.equal(p.implementation.sourceSha256,pinned.providerSource);
assert.equal(l.implementation.version,'0.14.0');assert.equal(p.implementation.version,'0.14.0');
// Recompute declared source identities before importing proof/header verifiers.
assert.deepEqual(l.implementation.sourceFiles,l.implementation.inventory.map(x=>x.path));
for(const f of l.implementation.inventory){const path=resolve(root,f.path),st=await lstat(path);if(f.kind==='symlink'){assert(st.isSymbolicLink());assert.equal(await readlink(path),f.target);}else{assert(st.isFile()&&!st.isSymbolicLink());const b=await readFile(path);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);assert.equal(st.mode&0o777,f.mode);}}
assert.equal(sha(JSON.stringify({files:l.implementation.inventory,runtime:l.implementation.runtime})),pinned.localSource);
const nodeBytes=await readFile(process.execPath);assert.equal(sha(nodeBytes),l.implementation.runtime.executableSha256);assert.equal(nodeBytes.length,l.implementation.runtime.executableBytes);assert.equal(process.version,l.implementation.runtime.node);assert.equal(process.versions.v8,l.implementation.runtime.v8);assert.equal(process.platform,l.implementation.runtime.platform);assert.equal(process.arch,l.implementation.runtime.arch);
const ph=createHash('sha256');for(const path of p.implementation.sourceFiles)ph.update(path+'\0').update(await read(path)).update('\0');assert.equal(ph.digest('hex'),pinned.providerSource);
const {verifyEthereumHeader}=await import(resolve(root,'engines/local-evm/ethereum-header.js'));
const {verifyStateProof}=await import(resolve(root,'engines/local-evm/verified-state-proof.js'));
const req=l.apiRequest,block=l.source.blockSelection.blockHash,header=l.source.blockSelection.header,pinnedBlock={blockHash:block,requireCanonical:true};
assert.deepEqual(await json(LOCAL+'/request.json'),req);assert.deepEqual(await json(PROVIDER+'/request.json'),p.apiRequest);
assert.deepEqual(p.apiRequest,{...req,block});assert.equal(req.block,'latest');assert.equal(l.status,'complete');assert.equal(l.error,null);assert.equal(l.source.canonicalStatus,'verified');assert.equal(p.canonicalStatus,'verified');
const headerVerification=verifyEthereumHeader({header,expectedHash:block});assert.equal(headerVerification.status,'verified');assert.equal(headerVerification.consensusVerified,false);
function wires(report){let bytes=0;const methods={};for(const [i,r] of report.transportEvidence.entries()){
 assert.equal(r.id,i+1);assert.equal(r.provider,'eth.drpc.org');assert.equal(r.httpStatus,200);assert.equal(r.error,undefined);assert.equal(r.transport.complete,true);assert.equal(r.transport.bodyRetained,true);
 assert.deepEqual(JSON.parse(r.requestText),r.request);assert.equal(r.request.id,r.id);assert.equal(r.request.jsonrpc,'2.0');assert.equal(r.requestBytes,Buffer.byteLength(r.requestText));assert.equal(r.requestSha256,sha(r.requestText));
 const raw=r.responseText,b=Buffer.byteLength(raw),h=sha(raw),parsed=JSON.parse(raw);assert.equal(parsed.id,r.id);assert.equal(parsed.jsonrpc,'2.0');assert(Object.hasOwn(parsed,'result')&&!Object.hasOwn(parsed,'error'));
 for(const name of ['observedBytes','retainedPrefixBytes'])assert.equal(r.transport[name],b);for(const name of ['observedPrefixSha256','retainedPrefixSha256','responseSha256'])assert.equal(r.transport[name],h);
 bytes+=b;methods[r.request.method]=(methods[r.request.method]??0)+1;
 }return {calls:report.transportEvidence.length,bytes,methods};}
const localWire=wires(l),providerWire=wires(p);
assert.equal(localWire.calls,14);assert.equal(localWire.bytes,212590);assert.equal(l.usage.observedBytes,localWire.bytes);assert.equal(providerWire.calls,20);assert.equal(p.accounting.rpcCalls,20);
const result=r=>JSON.parse(r.responseText).result,rawL=l.transportEvidence.map(result),rawP=p.transportEvidence.map(result);
assert.equal(rawL[0],'0x1');assert.equal(rawP[0],'0x1');assert.deepEqual(l.transportEvidence[1].request.params,['latest',false]);assert.deepEqual(p.transportEvidence[1].request.params,[block,false]);
for(const h of [rawL[1],rawL.at(-1),rawP[1],rawP.at(-1)])assert.deepEqual(h,header);
for(const r of [l.transportEvidence.at(-1),p.transportEvidence.at(-1)])assert.deepEqual(r.request.params,[header.number,false]);
assert.equal(p.evidence.length,p.transportEvidence.length);for(const [i,e] of p.evidence.entries()){const w=p.transportEvidence[i];assert.equal(e.id,w.id);assert.equal(e.method,w.request.method);assert.deepEqual(e.params,w.request.params);assert.deepEqual(e.result,rawP[i]);}
const preview=l.attempt.preview,original=preview.original,facts=preview.inputs.accounts;
assert.equal(l.attempt.status,'completed');assert.deepEqual(l.execution,original.output.execution);assert.equal(l.execution.status,'success');assert.equal(p.execution.status,'success');assert.equal(l.execution.returnData,p.execution.returnData);assert.equal(l.execution.error,null);assert.equal(p.execution.error,null);
assert.deepEqual(original.inputs.context.header,header);assert.equal(preview.inputs.context.stateRoot,header.stateRoot);assert.equal(preview.inputs.context.blockHash,block);
// No product trace/diff enters local input state. Every inner input record joins
// one exact saved proof/code wire, in order; all eight proofs are reverified.
const localInputs=l.transportEvidence.slice(2,-1);assert.equal(localInputs.length,11);assert.equal(preview.inputEvidence.length,11);
const verifiedProofs=[];for(const [i,w] of localInputs.entries()){
 assert(['eth_getProof','eth_getCode'].includes(w.request.method));assert.deepEqual(w.request.params.at(-1),pinnedBlock);
 const e=preview.inputEvidence[i];assert.deepEqual(e.request,{method:w.request.method,params:w.request.params});assert.deepEqual(e.result,result(w));assert.equal(e.requestSha256,sha(e.requestText));assert.equal(e.resultSha256,sha(JSON.stringify(e.result)));assert.equal(e.resultBytes,Buffer.byteLength(JSON.stringify(e.result)));
 if(w.request.method==='eth_getProof'){
 const [address,storageKeys]=w.request.params,codeWire=localInputs.find(x=>x.request.method==='eth_getCode'&&x.request.params[0]===address);assert(codeWire);
 const v=await verifyStateProof({stateRoot:header.stateRoot,address,storageKeys,proof:result(w),code:result(codeWire)}),f=facts[address];
 assert.equal(v.account.exists,f.exists);assert.equal(v.account.nonceRaw,f.nonce);assert.equal(v.account.balanceRaw,f.balance);assert.equal(v.code.bytes,f.code);
 for(const s of v.storage)assert.equal(s.valueWord,f.storage[s.key]);verifiedProofs.push({wireId:w.id,address,storageKeys,account:v.account,storage:v.storage});
 }}
assert.equal(verifiedProofs.length,8);assert.deepEqual(Object.keys(facts).sort(),[...new Set(verifiedProofs.map(x=>x.address))].sort());for(const [address,f] of Object.entries(facts))assert.deepEqual(Object.keys(f.storage).sort(),verifiedProofs.filter(x=>x.address===address).flatMap(x=>x.storageKeys).sort());assert.deepEqual(original.inputEvidence,preview.inputEvidence.slice(0,original.inputEvidence.length));
const sender=req.from,token=req.to,spender='0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',slot='0x26336f21a63aacd3574e840a3278fccb16fd789e8d3e700e5b9587a87e8da134';
const qhex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
assert.equal(req.data,'0x095ea7b3'+spender.slice(2).padStart(64,'0')+word(100000000).slice(2));assert.equal(req.value,'0');assert.equal(facts[sender].nonce,'55');assert.equal(facts[token].storage[slot],word(0));
const call={from:sender,to:token,data:req.data,gas:'0x4c4b40',value:'0x0'};
for(const i of [7,8]){assert.deepEqual(p.evidence[i].params.slice(0,2),[call,pinnedBlock]);assert.equal(p.evidence[i].params[2].stateOverrides,undefined);assert.equal(p.evidence[i].params[2].blockOverrides,undefined);}
assert.deepEqual(p.execution.trace,rawP[7]);assert.deepEqual(p.evidence[7].params[2],{tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true}});assert.deepEqual(p.evidence[8].params[2],{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true}});
const expectedDiff={pre:{[sender]:{balance:qhex(facts[sender].balance),nonce:55},[token]:{balance:'0x0',code:facts[token].code,nonce:1}},post:{[sender]:{nonce:56},[token]:{storage:{[slot]:word(100000000)}}}};
assert.deepEqual(rawP[8],expectedDiff); // Includes unchanged prefields and exact absolute values.
const normalizedDiff=structuredClone(expectedDiff);for(const phase of Object.values(normalizedDiff))for(const account of Object.values(phase))for(const key of ['nonce','balance'])if(Object.hasOwn(account,key))account[key]=BigInt(account[key]).toString();assert.deepEqual(p.stateDiff,normalizedDiff);
const expectedChanges=[{address:sender,nonce:{before:'0x37',after:'0x38'}},{address:token,storage:[{slot,before:word(0),after:word(100000000)}]}];
assert.deepEqual(original.changes.accounts,expectedChanges);
const expectedOverrides={[sender]:{nonce:'0x38'},[token]:{stateDiff:{[slot]:word(100000000)}}};
// This fixed successful tree has one child and exactly one log, so no global
// ordering inference or failed-branch filtering is needed.
const trace=p.execution.trace;assert.equal(trace.type,'CALL');assert.equal(trace.from,sender);assert.equal(trace.to,token);assert.equal(trace.input,req.data);assert.equal(trace.value,'0x0');assert.equal(trace.calls.length,1);assert.equal(trace.logs,undefined);assert.equal(trace.error,undefined);
const child=trace.calls[0];assert.equal(child.type,'DELEGATECALL');assert.equal(child.from,token);assert.equal(child.to,'0x43506849d7c04f9138d1a2050bbf3a0c054402dd');assert.equal(child.input,req.data);assert.equal(child.output,l.execution.returnData);assert.equal(child.value,'0x0');assert.equal(child.error,undefined);assert.equal(child.calls,undefined);assert.equal(child.logs.length,1);assert.equal(child.logs[0].index,'0x0');assert.equal(child.logs[0].position,'0x0');
const {index,position,...event}=child.logs[0];assert.deepEqual(original.output.logs,[event]);assert.deepEqual(event,{address:token,topics:['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',word(sender),word(spender)],data:word(100000000)});
const data=Buffer.from(req.data.slice(2),'hex'),zero=data.filter(x=>x===0).length,nonzero=data.length-zero,intrinsic=21000n+4n*BigInt(zero)+16n*BigInt(nonzero),floor=21000n+10n*BigInt(zero+4*nonzero),used=BigInt(l.execution.executionGasUsed);
assert.equal(zero,41);assert.equal(nonzero,27);assert.equal(intrinsic,21596n);assert.equal(floor,22490n);assert.equal(l.execution.gasRefundCounter,'0');assert.equal((used+intrinsic).toString(),p.execution.gasUsed);assert(used+intrinsic>floor);assert.equal(BigInt(trace.gasUsed).toString(),p.execution.gasUsed);
assert.deepEqual(original.output.gasAccounting,{beforeRefund:'55558',appliedRefund:'0',floorAdjustment:'0',gasUsed:'55558'});assert.equal(original.output.profile.messageGasLimit,(5000000n-intrinsic).toString());assert.equal(original.output.profile.executionBaseFee,'0');assert.equal(original.output.profile.gasPrice,'0');assert.equal(original.output.profile.feesSettled,false);
// Independently decode the two eight-word header witnesses; its only extra
// override is the exact fixed witness program, not funding.
const probe='0x000000000000000000000000000000000000ba1a',probeCode='0x43600052426020524560405248606052446080524160a0524660c0527f'+word(BigInt(header.number)-1n).slice(2)+'4060e0526101006000f3';
const witness=[header.number,header.timestamp,header.gasLimit,'0x0',header.mixHash,header.miner,'0x1',header.parentHash].map(word).map(x=>x.slice(2)).join('');
for(const [offset,id]of[10,11].entries()){const e=p.evidence[id-1];assert.deepEqual(e.params[0],{from:sender,to:probe,data:'0x',value:'0x0',gas:'0x493e0'});assert.deepEqual(e.params[1],pinnedBlock);assert.deepEqual(e.params[2].stateOverrides,{...(offset?expectedOverrides:{}),[probe]:{code:probeCode}});assert.equal(e.result.output,'0x'+witness);assert.equal(e.result.error,undefined);assert.equal(e.result.calls,undefined);assert.equal(e.result.logs,undefined);}
const measurementChecks=[];assert.equal(l.measurements.length,2);assert.equal(p.measurements.length,2);assert.equal(preview.measurements.length,2);
for(let i=0;i<2;i++){
 const lm=l.measurements[i],pm=p.measurements[i],m=preview.measurements[i],identity=i?{kind:'balanceOf',chainId:'1',token,account:sender,contractIdentityVerified:false}:{kind:'allowance',chainId:'1',token,owner:sender,spender,contractIdentityVerified:false};
 assert.deepEqual(lm.identity,identity);assert.deepEqual(m.identity,identity);assert.deepEqual(lm.query,req.queries[i]);assert.deepEqual(pm.query,req.queries[i]);assert.equal(lm.status,'measured');assert.equal(pm.status,'measured');assert.equal(m.status,'measured');
 assert.equal(lm.values.length,1);assert.deepEqual(lm.values,m.values);for(const k of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(lm.values[0][k],pm[k]);
 for(const state of ['before','after']){
 const side=m[state],ev=pm.queryEvidence.find(x=>x.state===state),tr=p.evidence[ev.traceEvidenceId-1],df=p.evidence[ev.mutationEvidenceId-1],after=state==='after',baseNonce=after?56:55;
 assert.equal(side.status,'measured');assert.equal(side.output.execution.status,'success');assert.deepEqual(side.output.logs,[]);assert.deepEqual(side.values,[{name:i?'balance':'allowance',raw:BigInt(side.output.execution.returnData).toString(),unit:{kind:'token_raw_units',scale:null}}]);assert.equal(side.values[0].raw,pm[state+'Raw']);
 assert.deepEqual(tr.params.slice(0,2),[{from:sender,...req.queries[i],value:'0x0',gas:'0x493e0'},pinnedBlock]);assert.deepEqual(df.params.slice(0,2),tr.params.slice(0,2));
 for(const e of [tr,df])assert.deepEqual(e.params[2].stateOverrides,after?expectedOverrides:undefined);
 assert.equal(tr.result.input,req.queries[i].data);assert.equal(tr.result.to,token);assert.equal(tr.result.from,sender);assert.equal(tr.result.error,undefined);assert.equal(tr.result.output,side.output.execution.returnData);assert.equal(tr.result.logs,undefined);assert.equal(tr.result.calls.length,1);assert.equal(tr.result.calls[0].logs,undefined);assert.equal(tr.result.calls[0].error,undefined);
 assert.deepEqual(df.result,{pre:{[sender]:{balance:qhex(facts[sender].balance),nonce:baseNonce}},post:{[sender]:{nonce:baseNonce+1}}});
 assert.deepEqual(side.changesBefore.accounts,after?expectedChanges:[]);const afterChanges=structuredClone(after?expectedChanges:[{address:sender,nonce:{before:'0x37',after:'0x38'}}]);afterChanges[0].nonce.after=qhex(baseNonce+1);assert.deepEqual(side.changesAfter.accounts,afterChanges);assert.equal(side.mutationValidation.status,'verified');
 assert.equal(side.output.trace.from,sender);assert.equal(side.output.trace.to,token);assert.equal(side.output.trace.input,req.queries[i].data);assert.equal(side.output.profile.sourceStateRoot,header.stateRoot);assert.equal(side.output.profile.sourceBlockHash,block);
 }
 measurementChecks.push({index:i,identity,values:lm.values,providerEvidence:pm.queryEvidence,localNetProbeMutation:'sender_nonce_only',providerNetProbeMutation:'sender_nonce_only'});
}
assert(Date.parse(lm.finishedAt)<Date.parse(pm.startedAt));
const audit={schemaVersion:1,kind:'supplemental_post_capture_offline_comparison',status:'passed',newNetworkRequests:0,selectedWorkloads:1,files,implementations:{local:{sha256:pinned.localSource,inventoryFiles:l.implementation.inventory.length,runtime:l.implementation.runtime},provider:{sha256:pinned.providerSource,sourceFiles:p.implementation.sourceFiles.length},currentDiskBytesVerified:true},block:{number:BigInt(header.number).toString(),hash:block,stateRoot:header.stateRoot,fullInitialAndFinalHeadersEqual:true,headerCommitmentReverified:true,consensusVerified:false,finalityVerified:false,bodyVerified:false},transport:{local:localWire,provider:providerWire,allRequestAndResponseHashesVerified:true,allParsedEvidenceJoinedToWire:true,localProofsReverified:verifiedProofs.length,localCodeReads:3,localInputOrderBeforeProviderCapture:Date.parse(lm.finishedAt)<Date.parse(pm.startedAt)},channels:{status:'matched',returnData:'matched',committedLogs:'matched',fullObservedChanges:'matched',unsignedGas:'matched'},execution:{status:'success',returnData:l.execution.returnData,committedLogs:original.output.logs,changes:original.changes.accounts,gas:{localMessageGas:used.toString(),calldataBytes:data.length,zeroBytes:zero,nonzeroBytes:nonzero,intrinsicGas:intrinsic.toString(),calldataFloor:floor.toString(),refundApplied:'0',floorAdjustment:'0',comparableGas:'55558',providerGas:p.execution.gasUsed,feesSettled:false}},measurements:measurementChecks,verifiedProofs,limitations:['One selected approval development workload, not a representative cohort or accuracy/security score.','Local execution uses proof/code input state only; the cryptographic proof/header checks reuse the pinned local verifier implementation, not a second verifier implementation.','Both captures use eth.drpc.org input data; agreement is between local execution and provider execution, not independent node consensus.','Latest was resolved once; provider comparison uses that exact hash. This is unsigned, unpriced block-end simulation, not original-position replay or a signed transaction.','Only demanded initial state and observed changes are compared; no global post-state root or complete economic-effect proof.','Queried token identity is calldata/address identity; token label/decimals and deployment semantics are not re-attested.','The failed historical Aave capture remains a separate retained outcome and is not replaced by this selected approval.','No VM reexecution or fresh public requests are performed by this audit. Current source/dependency bytes must still match captured identities to rerun.'],auditScriptSha256:sha(await readFile(fileURLToPath(import.meta.url)))};
if(process.argv.includes('--write'))await writeFile(resolve(dir,'independent-audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
else assert.deepEqual(await json(PROVIDER+'/independent-audit.json'),audit);
console.log(JSON.stringify({status:audit.status,channels:audit.channels,transport:audit.transport,artifact:PROVIDER+'/independent-audit.json'}));
