// Post-capture audit by the capability-runner author. Independent wire/diff
// adjudication; not an independent source-author review or an execution replay.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';

const HERE=fileURLToPath(new URL('.',import.meta.url)), PACKET=resolve(HERE,'../ethereum-deployment-capability-v1');
export const EXPECTED=Object.freeze({manifest:'d6f402d95e53a62a1991e1ec74855f8e375034512d53d555c8c75a5a293c641e',plan:'8ff678c2a4a72e58e6aaa1114bab24da66bd9699bce1efb7a54990e0dd6f2450',source:'df32a4c2dcc9afa48bf04488a9ad565ad39c43fc16c67a1c1e5f76d7e2d02c76',referenceManifest:'3aab8f526c5dee2d5ce765f66ea6108119faca53bc80105d2b093921a01a3841'});
const sha=x=>createHash('sha256').update(x).digest('hex'), own=(x,k)=>Object.hasOwn(x,k);
const need=(ok,message)=>{if(!ok)throw Error(message);};
const read=(base,path)=>JSON.parse(readFileSync(join(base,path)));
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const safe=p=>typeof p==='string'&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..');
function inventory(base,prefix='') {return readdirSync(join(base,prefix)).sort().flatMap(name=>{const p=prefix?prefix+'/'+name:name,s=lstatSync(join(base,p));return s.isDirectory()?inventory(base,p):[p];});}
function verifyFiles(base,entries,{modes=false}={}) {
 const names=new Set();let bytes=0;
 for(const entry of entries){need(safe(entry.path)&&!names.has(entry.path),'invalid manifest path');names.add(entry.path);const path=join(base,entry.path),stat=lstatSync(path);
  if(entry.kind==='symlink'){need(stat.isSymbolicLink()&&readlinkSync(path)===entry.target,'symlink mismatch');const target=relative(base,resolve(path,'..',entry.target));need(safe(target)&&entries.some(e=>e.path===target&&e.kind==='file'),'symlink outside exact archive');}
  else{need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32*1024*1024,'invalid file');const raw=readFileSync(path);need(raw.length===entry.bytes&&sha(raw)===entry.sha256,'file bytes mismatch');if(modes)need((stat.mode&0o777)===entry.mode,'mode mismatch');bytes+=raw.length;}
 }
 return{files:names.size,bytes};
}
function fields(value,keys){need(plain(value)&&equal(Object.keys(value).sort(),[...keys].sort()),'unexpected schema');}
const quantity=x=>{need(typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(x)&&x.length<=66,'invalid quantity');return BigInt(x);};
const data=x=>{need(typeof x==='string'&&/^0x(?:[0-9a-f]{2})*$/.test(x)&&x.length<=2+8*1024*1024*2,'invalid bytes');return x;};

export function verifyWire(wire,expectedRequest=wire.request) {
 need(equal(wire.request,expectedRequest)&&wire.requestText===JSON.stringify(expectedRequest),'request binding');
 need(sha(wire.requestText)===wire.requestSha256&&Buffer.byteLength(wire.requestText)===wire.requestBytes,'request bytes');
 const raw=Buffer.from(wire.rawBase64,'base64');need(raw.toString('base64')===wire.rawBase64,'base64 encoding');
 const t=wire.transport;need(t.complete===true&&t.observedBytes===raw.length&&t.retainedBytes===raw.length,'incomplete body');
 need([t.observedSha256,t.retainedSha256,wire.responseSha256].every(hash=>hash===sha(raw)),'response bytes');
 need(Number.isFinite(t.durationMs)&&t.durationMs>=0&&t.durationMs<25000,'request duration');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);need(text===wire.responseText,'response text');
 // All 19 actual responses are JSON, including HTTP errors. Parsing here does
 // not promote the original HTTP failure into a successful capture.
 const json=JSON.parse(text);need(plain(json)&&json.jsonrpc==='2.0'&&json.id===expectedRequest.id&&own(json,'result')!==own(json,'error'),'response envelope');
 const httpOk=wire.httpStatus>=200&&wire.httpStatus<300;
 const status=httpOk&&!own(json,'error')?'completed':'failed',error=httpOk?'rpc_error':'http_error';
 need(wire.status===status&&(status==='completed'?!own(wire,'error'):wire.error===error),'failure classification');
 if(httpOk)need(equal(wire.parsed,json),'parsed response');else need(!own(wire,'parsed'),'HTTP failure was parsed by runner');
 return{json,rawBytes:raw.length,status,error:status==='completed'?null:error};
}

export function verifyHeaderBinding(wires,header) {
 const result={};
 for(const [provider,ids]of [['drpc',[1,2,4]],['publicnode',[5,6,12]]]){
  const values=ids.map(id=>verifyWire(wires[id-1]).json.result);
  need(values[0]==='0x1'&&equal(values[1],header)&&equal(values[2],header),'full header bracket mismatch');
  result[provider]={chain:'matched',beforeHeader:'matched',afterHeader:'matched',completeHeaderEquality:true,numericSelectorAtomicHashBinding:false,consensusVerified:false};
 }return result;
}

/** A narrow, independent decoder of the actual Parity stateDiff vocabulary.
 * Unsupported lifecycle/operators fail; omitted state does not become zero.
 * Absence zeros come only from the independently verified initial proof. */
export function parityChanges(stateDiff,inputs) {
 need(plain(stateDiff)&&Object.keys(stateDiff).length<=128,'state diff schema');const out=[];
 for(const [address,value]of Object.entries(stateDiff)){
  need(/^0x[0-9a-f]{40}$/.test(address),'address');fields(value,['balance','code','nonce','storage']);need(plain(value.storage),'storage schema');
  const initial=inputs.accounts[address];need(initial&&typeof initial.exists==='boolean','unknown initial account');const row={address};
  if(!initial.exists)row.existence={before:false,after:true,basis:'top_level_contract_creation'};
  for(const field of ['balance','nonce','code']){
   const change=value[field],before=initial.exists?(field==='code'?initial.code:'0x'+BigInt(initial[field]).toString(16)):(field==='code'?'0x':'0x0');let after;
   if(!initial.exists){fields(change,['+']);after=change['+'];}
   else if(change==='=')continue;
   else{fields(change,['*']);fields(change['*'],['from','to']);need(change['*'].from===before,'initial value mismatch');after=change['*'].to;}
   if(field==='code')data(after);else quantity(after);
   if(before!==after)row[field]={before,after};
  }
  const storage=[];
  for(const[slot,change]of Object.entries(value.storage)){
   need(/^0x[0-9a-f]{64}$/.test(slot),'slot');const before=initial.exists?initial.storage[slot]:'0x'+'00'.repeat(32);need(before!==undefined,'unknown initial slot');let after;
   if(!initial.exists){fields(change,['+']);after=change['+'];}else if(change==='=')continue;else{fields(change,['*']);fields(change['*'],['from','to']);need(change['*'].from===before,'initial slot mismatch');after=change['*'].to;}
   need(/^0x[0-9a-f]{64}$/.test(after),'storage word');if(before!==after)storage.push({slot,before,after});
  }
  if(storage.length)row.storage=storage.sort((a,b)=>a.slot.localeCompare(b.slot));if(Object.keys(row).length>1)out.push(row);
 }return out.sort((a,b)=>a.address.localeCompare(b.address));
}

export function compareObserved(parity,local,request,target) {
 fields(parity,['output','stateDiff','trace','vmTrace']);need(parity.vmTrace===null&&Array.isArray(parity.trace)&&parity.trace.length===1,'unexpected trace topology');
 const frame=parity.trace[0];fields(frame,['action','result','subtraces','traceAddress','type']);fields(frame.action,['from','creationMethod','gas','init','value']);fields(frame.result,['address','code','gasUsed']);
 need(frame.type==='create'&&frame.action.creationMethod==='create'&&frame.subtraces===0&&equal(frame.traceAddress,[]),'not one root creation');
 need(frame.action.from===request.from&&frame.action.init===request.data&&frame.action.value===request.value&&frame.result.address===target,'root request binding');
 data(parity.output);data(frame.result.code);const gas=quantity(frame.result.gasUsed),available=quantity(frame.action.gas);
 const bytes=Buffer.from(request.data.slice(2),'hex'),zero=bytes.filter(v=>v===0).length,nonzero=bytes.length-zero;
 const intrinsic=21000n+32000n+BigInt(zero*4+nonzero*16)+2n*BigInt(Math.ceil(bytes.length/32)),floor=21000n+10n*BigInt(zero+4*nonzero);
 need(quantity(request.gas)-intrinsic===available&&gas<=available,'gas envelope binding');
 const original=local.output;need(original.profile.sourceBlockHash===local.inputs.context.blockHash&&original.profile.sourceStateRoot===local.inputs.context.stateRoot,'local context');
 const normalized=parityChanges(parity.stateDiff,local.inputs),expected=[...local.changes.accounts].sort((a,b)=>a.address.localeCompare(b.address));
 return{label:'exploratory_observed_fields_only',status:original.execution.status==='success'?'equal':'different',returnData:parity.output===original.execution.returnData?'equal':'different',runtimeCode:frame.result.code===original.execution.returnData?'equal':'different',derivedAddress:frame.result.address,observedStateChanges:equal(normalized,expected)?'equal':'different',providerNormalizedChanges:normalized,
  gas:{providerMessageGas:gas.toString(),localMessageGas:original.execution.executionGasUsed,messageGas:gas.toString()===original.execution.executionGasUsed?'equal':'different',independentlyDerivedIntrinsic:intrinsic.toString(),calldataFloor:floor.toString(),providerMessagePlusIntrinsic:(gas+intrinsic).toString(),localUnsignedGas:original.gasAccounting.gasUsed,localRefundCounter:original.execution.gasRefundCounter,totalGasInterpretation:'Arithmetic only; Parity refund/fee context is not independently authenticated.'},
  equivalentExecutionContext:false,providerCommittedLogsVerified:false,postStateRootVerified:false,fiveChannelAgreement:false,accuracyRate:null};
}

export async function auditPacket() {
 const manifestBytes=readFileSync(join(PACKET,'evidence-manifest.json'));need(sha(manifestBytes)===EXPECTED.manifest,'evidence manifest identity');const manifest=JSON.parse(manifestBytes);
 need(manifest.planSha256===EXPECTED.plan&&manifest.sourceManifestSha256===EXPECTED.source,'manifest identities');const evidence=verifyFiles(PACKET,manifest.files);
 need(equal(inventory(PACKET).filter(p=>!p.startsWith('runtime/')&&p!=='evidence-manifest.json'),manifest.files.map(e=>e.path).sort()),'evidence inventory');
 const source=read(PACKET,'source-manifest.json');need(sha(readFileSync(join(PACKET,'source-manifest.json')))===EXPECTED.source,'source identity');const archive=verifyFiles(join(PACKET,'runtime'),source.files,{modes:true});
 need(equal(inventory(join(PACKET,'runtime')),source.files.map(e=>e.path).sort())&&source.filesCount===archive.files&&source.regularFileBytes===archive.bytes,'source inventory');
 // Only after all source bytes are authenticated, reuse its existing complete
 // dependency/identity verifier and cryptographic header/proof implementations.
 const runtime=join(PACKET,'runtime'),module=p=>import(pathToFileURL(join(runtime,p)));
 const freeze=await module('research/standard-evm/cohort-freeze.mjs');await freeze.verifyFrozenSources({outputDirectory:PACKET,expectedManifestSha256:EXPECTED.source});
 const plan=read(PACKET,'plan.json'),started=read(PACKET,'STARTED.json'),results=read(PACKET,'results.json'),frozen=read(PACKET,'FROZEN.json');
 need(sha(readFileSync(join(PACKET,'plan.json')))===EXPECTED.plan&&equal(plan.runtime,source.runtime)&&equal(plan.productImplementation,source.productImplementation)&&equal(plan.localImplementation,source.localImplementation),'plan/source identity');
 need(started.planSha256===EXPECTED.plan&&started.sourceManifestSha256===EXPECTED.source&&equal(started.runtime,plan.runtime)&&frozen.planSha256===EXPECTED.plan&&frozen.sourceManifestSha256===EXPECTED.source&&frozen.publicDispatches===0,'start/freeze binding');
 need(started.referenceEvidenceManifestSha256===EXPECTED.referenceManifest&&plan.reference.evidenceManifestSha256===EXPECTED.referenceManifest,'reference identity');
 const referenceManifest=read(PACKET,'reference/evidence-manifest.json');need(sha(readFileSync(join(PACKET,'reference/evidence-manifest.json')))===EXPECTED.referenceManifest,'reference manifest bytes');verifyFiles(join(PACKET,'reference'),referenceManifest.files);
 const original=read(PACKET,'reference/local.json'),selection=read(PACKET,'reference/selection.json'),target=read(PACKET,'reference/target.json');
 need(equal(plan.header,selection.header)&&equal(plan.target,target)&&original.attempt.status==='completed'&&original.attempt.output.execution.status==='success','sealed local reference');
 const{verifyEthereumHeader}=await module('engines/local-evm/ethereum-header.js');verifyEthereumHeader({header:plan.header,expectedHash:plan.header.hash});
 const{verifyStateProof}=await module('engines/local-evm/verified-state-proof.js');const proofFacts=[];
 const oldWires=Array.from({length:7},(_,i)=>read(PACKET,`reference/wire/${String(i+1).padStart(6,'0')}.json`));oldWires.forEach(w=>verifyWire(w));
 for(const[index,address]of [plan.target.sender,plan.target.address].entries()){
  const proof=oldWires[2+index*2],code=oldWires[3+index*2],selector={blockHash:plan.header.hash,requireCanonical:true};
  need(equal(proof.request.params,[address,[],selector])&&equal(code.request.params,[address,selector]),'reference proof wire binding');
  const verified=await verifyStateProof({stateRoot:plan.header.stateRoot,address,storageKeys:[],proof:proof.parsed.result,code:code.parsed.result});proofFacts.push({address,...verified.account});
  const initial=original.attempt.inputs.accounts[address];
  need(initial.exists===verified.account.exists&&(!initial.exists||(initial.nonce===verified.account.nonceRaw&&initial.balance===verified.account.balanceRaw&&initial.code===code.parsed.result)),'proven initial facts differ');
  for(const [j,wire]of [[index*2,proof],[index*2+1,code]]){const entry=original.attempt.inputEvidence[j];need(equal(entry.request,{method:wire.request.method,params:wire.request.params})&&equal(entry.result,wire.parsed.result),'original input evidence join');}
 }
 const{createAddressFromString,createContractAddress}=await module('engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js');
 need(createContractAddress(createAddressFromString(target.sender),BigInt(proofFacts[0].nonceRaw)).toString()===target.address&&proofFacts[1].exists===false,'authenticated derived target');
 need(oldWires[6].httpStatus===400&&oldWires[6].status==='failed','original debug failure changed');
 need(Date.parse(oldWires[6].startedAt)+oldWires[6].transport.durationMs<Date.parse(started.startedAt)&&Date.parse(plan.frozenAt)<=Date.parse(started.startedAt),'reference/freeze chronology');
 const wires=Array.from({length:12},(_,i)=>read(PACKET,`wire/${String(i+1).padStart(3,'0')}.json`));need(plan.rows.length===12&&results.ledger.length===12,'matrix denominator');let bytes=0;const outcomes=[];
 for(let i=0;i<12;i++){
  const wire=wires[i],row=plan.rows[i],decoded=verifyWire(wire,row.request),ledger=results.ledger[i];
  need(row.id===i+1&&wire.id===row.id&&wire.url===row.url&&wire.provider===row.provider&&wire.kind===row.kind&&wire.label===row.label,'matrix identity');
  need(ledger.id===row.id&&ledger.provider===row.provider&&ledger.label===row.label&&ledger.wirePath===`wire/${String(i+1).padStart(3,'0')}.json`&&ledger.status===(decoded.status==='completed'?'returned':'failed'),'ledger binding');
  if(decoded.status==='failed')need(ledger.error===decoded.error,'failure ledger');
  need(Date.parse(wire.startedAt)>=Date.parse(started.startedAt)&&(i===0||Date.parse(wire.startedAt)+2>=Date.parse(wires[i-1].startedAt)+wires[i-1].transport.durationMs),'dispatch ordering');
  need(decoded.rawBytes<=plan.policy.responseBytes,'body bound');bytes+=decoded.rawBytes;
  outcomes.push({id:row.id,provider:row.provider,method:row.request.method,label:row.label,httpStatus:wire.httpStatus,status:decoded.status,responseBytes:decoded.rawBytes,...(decoded.json.error?{rpcError:decoded.json.error}:{})});
 }
 const binding=verifyHeaderBinding(wires,plan.header);need(equal(binding,results.binding),'header summary');
 need(results.status==='sealed'&&results.sourceUnchanged&&results.runtimeUnchanged&&results.planSha256===EXPECTED.plan&&results.sourceManifestSha256===EXPECTED.source,'completion/source summary');
 need(results.usage.planned===12&&results.usage.calls===12&&results.usage.dispatches===12&&results.usage.observedBytes===bytes&&bytes<=plan.policy.totalBytes&&results.usage.saveFailure===false&&equal(results.usage.limits,plan.policy)&&results.usage.durationMs<plan.policy.wallMs,'budget summary');
 need(equal(results.scope,plan.scope)&&!plan.scope.accuracyEvaluated&&!plan.scope.fiveChannelAgreement&&!plan.scope.committedLogsVerified,'scope claims');
 const observed=compareObserved(verifyWire(wires[2]).json.result,original.attempt,plan.rows[2].request.params[0],target.address);
 return{schemaVersion:'1.0',role:'postseal_wire_and_field_audit_by_capability_runner_author_not_independent_source_author_review',packetIdentities:EXPECTED,evidence,archive,wireRecords:19,capabilityCalls:12,capabilityBytes:bytes,captureDurationMs:results.usage.durationMs,sourceAndEvidenceHashesVerified:true,nodeIdentityBoundToPlan:true,nodeExecutableRerunOrReverification:false,originalVMReexecuted:false,initialProofsReverified:proofFacts,headerHashRecomputed:true,headerBinding:binding,outcomes,exploratoryObservedComparison:observed,limitations:['Same historical workload, not a new independent accuracy case.','Numeric trace_call selection plus unchanged headers is not atomic hash binding.','Parity zero-gas-price execution and refund/fee semantics are not independently equivalent to the local unpriced profile.','Parity trace/stateDiff has no authenticated committed-log channel here.','No full post-state-root, consensus, finality, signed admission, fee settlement or population accuracy claim.','Original dRPC debug_traceCall HTTP400 remains a failed comparison; it is not rewritten by this later capability discovery.']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const actual=await auditPacket();
 if(process.argv.includes('--write'))writeFileSync(join(HERE,'audit.json'),JSON.stringify(actual,null,2)+'\n',{flag:'wx'});
 else {
  const sealed=read(HERE,'audit-manifest.json');need(equal(sealed.packetIdentities,EXPECTED),'audit packet identities');verifyFiles(HERE,sealed.files);
  need(equal(inventory(HERE).filter(p=>p!=='audit-manifest.json'),sealed.files.map(f=>f.path).sort()),'audit inventory');
  need(equal(actual,read(HERE,'audit.json')),'stored audit differs');
 }
 console.log(JSON.stringify({status:'verified',calls:actual.capabilityCalls,bytes:actual.capabilityBytes,observed:actual.exploratoryObservedComparison},null,2));
}
