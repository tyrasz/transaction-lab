// Fixed read-only capability matrix. No execution result is an accuracy claim.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';
import { createArtifactWriter, sealEvidence } from './cohort-pilot.mjs';
import { captureHttp } from '../../reports/ethereum-lending-local-reference/wire.mjs';
import { DEPLOYMENT_CASE, deriveDeploymentTarget } from './deployment-current.mjs';

const ROOT=fileURLToPath(new URL('../..',import.meta.url)),SELF='research/standard-evm/deployment-capability.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),own=(o,k)=>Object.hasOwn(o,k);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export const CAPABILITY_REFERENCE=Object.freeze({directory:'reports/ethereum-deployment-current-v1',evidenceManifestSha256:'3aab8f526c5dee2d5ce765f66ea6108119faca53bc80105d2b093921a01a3841',planSha256:'84d716f5e6c416cbf071ff8e9a7047213b083b50895e8d0daea0da75586001f7',sourceManifestSha256:'87c7695fa5a93532596309b57f087959b759538279c4c9c3007db405f588b1f5',blockHash:'0x9d73e3dcf2701d54ca3ef88d36597307ef5847940ad31767be1379bf5768d3ea',blockNumber:'0x191232c'});
export const CAPABILITY_POLICY=Object.freeze({calls:12,requestMs:25000,responseBytes:8388608,totalBytes:33554432,wallMs:330000,terminalDrainMs:25000,liveAndDrainCeilingMs:360000,retries:0,replacements:0});
export const CAPABILITY_PROVIDERS=Object.freeze({drpc:'https://eth.drpc.org/',publicnode:'https://ethereum-rpc.publicnode.com/'});
export const CAPABILITY_DOCS=Object.freeze([
 {url:'https://drpc.org/docs/ethereum-api/debugandtrace/debug_traceCall',basis:'Provider documentation requires to; the preserved null-destination call returned HTTP400. Debug availability is documented as paid tier.'},
 {url:'https://drpc.org/docs/ethereum-api/debugandtrace/trace_call',basis:'Provider documents null to for contract creation and trace/stateDiff output. Public endpoint availability remains unestablished.'},
 {url:'https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug',basis:'Client documents debug_traceCall creation with destination omitted, and hash/number selection plus blockOverrides.'},
 {url:'https://raw.githubusercontent.com/ethereum/go-ethereum/master/internal/ethapi/transaction_args.go',basis:'Client TransactionArgs.To is nullable; client source semantics do not authenticate a provider implementation.'},
 {url:'https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers',basis:'callTracer describes CREATE frames; prestateTracer diff mode describes inserted accounts and storage.'},
 {url:'https://docs.erigon.tech/interacting-with-erigon/trace',basis:'trace_call documents trace/stateDiff and numeric block selection; fee/balance bailout and gas semantics need separate adjudication.'},
 {url:'https://docs.nethermind.io/interacting/json-rpc-ns/trace/',basis:'trace_call returns output, trace and stateDiff; it is not the Geth callTracer schema.'},
 {url:'https://ethereum.publicnode.com/',basis:'Operator publishes this keyless Ethereum endpoint; no trace-method availability guarantee was found.'},
]);
const SCOPE=Object.freeze({purpose:'fixed_root_CREATE_RPC_capability_discovery_only',localReference:'previously_sealed_successful_proof_backed_execution_before_all_new_provider_calls',providerOutputsUsedAsLocalInputs:false,accuracyEvaluated:false,fiveChannelAgreement:false,committedLogsVerified:false,consensusVerified:false,debugSelector:'exact_blockHash_requireCanonical',paritySelector:'numeric_block_with_before_after_complete_header_comparison_not_atomic_hash_binding',parityFeeContext:'gasPrice_zero_without_block_override_not_claimed_identical_to_local_unpriced_environment',failurePolicy:'attempt_each_predeclared_row_independently_until_shared_budget_or_persistence_failure_no_retry',timing:'330s_dispatch_plus_at_most25s_terminal_drain_offline_hashing_and_sealing_excluded'});
function read(path,max=32*1024*1024){const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=max,'invalid_reference_file');const bytes=readFileSync(path);return{bytes,value:JSON.parse(bytes)};}
function pathAllowed(path){return typeof path==='string'&&/^[A-Za-z0-9_.\/-]+$/.test(path)&&!path.startsWith('/')&&!path.split('/').some(x=>!x||x==='.'||x==='..');}

export async function verifyCapabilityReference(directory,{sourceArchive=false}={}){
 const root=realpathSync(resolve(directory)),manifest=read(join(root,'evidence-manifest.json'));
 need(sha(manifest.bytes)===CAPABILITY_REFERENCE.evidenceManifestSha256,'reference_manifest_changed');
 need(manifest.value.planSha256===CAPABILITY_REFERENCE.planSha256&&manifest.value.sourceManifestSha256===CAPABILITY_REFERENCE.sourceManifestSha256,'reference_identity_changed');
 const files=[],seen=new Set();let total=0;
 for(const entry of manifest.value.files){need(pathAllowed(entry.path)&&!seen.has(entry.path),'reference_inventory_invalid');seen.add(entry.path);const saved=read(join(root,entry.path));need(saved.bytes.length===entry.bytes&&sha(saved.bytes)===entry.sha256,'reference_bytes_changed');total+=saved.bytes.length;need(total<=32*1024*1024,'reference_size_limit');files.push({...entry,bytesValue:saved.bytes});}
 for(const required of ['plan.json','source-manifest.json','selection.json','local.json','target.json','STARTED.json','results.json'])need(seen.has(required),'reference_file_missing');
 const plan=read(join(root,'plan.json')).value,selection=read(join(root,'selection.json')).value,local=read(join(root,'local.json')).value,result=read(join(root,'results.json')).value;
 need(equal(plan.case,DEPLOYMENT_CASE)&&selection.status==='selected'&&selection.chainId==='0x1'&&selection.header.hash===CAPABILITY_REFERENCE.blockHash&&selection.header.number===CAPABILITY_REFERENCE.blockNumber,'reference_case_or_header_changed');
 need(result.sourceUnchanged===true&&result.runtimeUnchanged===true&&local.attempt?.status==='completed'&&local.attempt.output?.execution?.status==='success'&&equal(local.implementation,plan.localImplementation),'reference_local_unavailable');
 const target=await deriveDeploymentTarget({header:selection.header,local:local.attempt});need(equal(target,read(join(root,'target.json')).value),'reference_target_changed');
 if(sourceArchive)await verifyFrozenSources({outputDirectory:root,expectedManifestSha256:CAPABILITY_REFERENCE.sourceManifestSha256});
 return{header:selection.header,target,localImplementation:plan.localImplementation,files,manifestBytes:manifest.bytes};
}

export function capabilityRows(header){
 need(header?.hash===CAPABILITY_REFERENCE.blockHash&&header.number===CAPABILITY_REFERENCE.blockNumber,'fixed_header_required');
 const rows=[];const add=(provider,label,method,params,kind)=>rows.push({id:rows.length+1,provider,url:CAPABILITY_PROVIDERS[provider],label,kind,request:{jsonrpc:'2.0',id:rows.length+1,method,params}});
 const base={from:DEPLOYMENT_CASE.sender,data:DEPLOYMENT_CASE.initcode,value:'0x0',gas:'0x4c4b40',gasPrice:'0x0'};
 const selector={blockHash:header.hash,requireCanonical:true};
 for(const provider of ['drpc','publicnode']){
  add(provider,'chain','eth_chainId',[],'chain');
  add(provider,'header-before','eth_getBlockByHash',[header.hash,false],'header-before');
  if(provider==='publicnode')for(const variant of ['null','omitted'])for(const tracer of ['callTracer','prestateTracer']){
   const call={...base,...(variant==='null'?{to:null}:{})};
   add(provider,`debug-${variant}-${tracer}`,'debug_traceCall',[call,selector,{tracer,tracerConfig:tracer==='callTracer'?{withLog:true}:{diffMode:true},blockOverrides:{baseFeePerGas:'0x0'}}],tracer);
  }
  add(provider,'parity-null-trace-stateDiff','trace_call',[{...base,to:null},['trace','stateDiff'],header.number],'parity');
  add(provider,'header-after','eth_getBlockByNumber',[header.number,false],'header-after');
 }
 need(rows.length===12,'matrix_size_invalid');return rows;
}
function limitsBelow(supplied={}){need(plain(supplied),'invalid_limits');const limits={...CAPABILITY_POLICY};for(const[key,value]of Object.entries(supplied)){need(['calls','requestMs','responseBytes','totalBytes','wallMs'].includes(key)&&Number.isSafeInteger(value)&&value>0&&value<=limits[key],'invalid_limits');limits[key]=value;}return limits;}
function observedShape(kind,value){
 if(kind==='chain')return{recognized:typeof value==='string',kind};
 if(kind==='header-before'||kind==='header-after')return{recognized:plain(value)&&typeof value.hash==='string',kind};
 if(kind==='callTracer')return{recognized:plain(value)&&typeof value.type==='string',kind,rootType:typeof value?.type==='string'?value.type.slice(0,32):null,returnPresent:typeof value?.output==='string',gasUsedPresent:typeof value?.gasUsed==='string',logsFieldPresent:Array.isArray(value?.logs),errorPresent:plain(value)&&own(value,'error')};
 if(kind==='prestateTracer')return{recognized:plain(value)&&plain(value.pre)&&plain(value.post),kind,prePresent:plain(value?.pre),postPresent:plain(value?.post)};
 return{recognized:plain(value)&&typeof value.output==='string'&&Array.isArray(value.trace)&&plain(value.stateDiff),kind,outputPresent:typeof value?.output==='string',tracePresent:Array.isArray(value?.trace),stateDiffPresent:plain(value?.stateDiff),committedLogsVerified:false};
}

/** Each row has a unique declared ID and is attempted once, independent of RPC
 * failures. Tightened budgets are for offline controls, never a live expansion.
 * captureHttp seals late I/O and retains exact entity bytes including failures. */
export async function collectCapabilityRows({header,save=()=>{},fetchImpl=fetch,signal,limits:override}={}){
 const rows=capabilityRows(header),limits=limitsBelow(override),start=performance.now(),deadline=start+limits.wallMs;
 const shared={bytes:0,maxBytes:limits.totalBytes},records=[],ledger=[];let calls=0,dispatches=0,saveFailure=false;
 need(typeof save==='function'&&typeof fetchImpl==='function','invalid_adapter');
 for(const row of rows){
  const reason=saveFailure?'artifact_save_failed':signal?.aborted?'cancelled':calls>=limits.calls?'call_budget':performance.now()>=deadline?'wall_budget':shared.bytes>=shared.maxBytes?'byte_budget':null;
  if(reason){ledger.push({id:row.id,provider:row.provider,label:row.label,status:'not_attempted',reason});continue;}
  calls++;
  const wire=await captureHttp({url:row.url,body:row.request,deadline,requestMs:limits.requestMs,responseBytes:limits.responseBytes,shared,signal,fetchImpl:(url,options)=>{dispatches++;return fetchImpl(url,options);}});
  Object.assign(wire,{id:row.id,provider:row.provider,label:row.label,kind:row.kind,request:row.request});
  const parsed=wire.parsed;
  if(wire.status==='completed'&&(!plain(parsed)||parsed.jsonrpc!=='2.0'||parsed.id!==row.id||own(parsed,'result')===own(parsed,'error'))){wire.status='failed';wire.error='jsonrpc_envelope';}
  if(wire.status==='completed'&&own(parsed,'error')){wire.status='failed';wire.error='rpc_error';}
  records.push(wire);
  try{const pending=save(structuredClone(wire));if(pending!==undefined){pending?.catch?.(()=>{});throw Error('synchronous_save_required');}}
  catch{saveFailure=true;}
  ledger.push({id:row.id,provider:row.provider,label:row.label,status:saveFailure?'persistence_failed':wire.status==='completed'?'returned':'failed',wirePath:`wire/${String(row.id).padStart(3,'0')}.json`,...(wire.status==='completed'?{shape:observedShape(row.kind,parsed.result)}:{error:wire.error})});
 }
 const binding={};
 for(const provider of Object.keys(CAPABILITY_PROVIDERS)){
  const match=kind=>{const wire=records.find(row=>row.provider===provider&&row.kind===kind);return wire?.status!=='completed'?'unavailable':equal(wire.parsed.result,kind==='chain'?'0x1':header)?'matched':'mismatched';};
  const chain=match('chain'),before=match('header-before'),after=match('header-after');
  binding[provider]={chain,beforeHeader:before,afterHeader:after,completeHeaderEquality:chain==='matched'&&before==='matched'&&after==='matched',numericSelectorAtomicHashBinding:false,consensusVerified:false};
 }
 return{ledger,binding,records,usage:{planned:12,calls,dispatches,observedBytes:shared.bytes,saveFailure,durationMs:performance.now()-start,limits},scope:SCOPE};
}

export async function freezeDeploymentCapability({repoRoot=ROOT,outputDirectory,expectedProductSha256}={}){
 need(typeof expectedProductSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedProductSha256),'explicit_product_hash_required');
 const reference=await verifyCapabilityReference(join(repoRoot,CAPABILITY_REFERENCE.directory),{sourceArchive:true});
 const frozen=await freezeCohortSources({repoRoot,outputDirectory,extraFiles:['research/standard-evm/cohort-deployments.json','research/standard-evm/deployment-current.mjs',SELF]});
 need(frozen.manifest.productImplementation.sourceSha256===expectedProductSha256,'source_identity_differs');
 const directory=frozen.outputDirectory,writer=createArtifactWriter(directory);mkdirSync(join(directory,'reference'));
 const copies=[...reference.files,{path:'evidence-manifest.json',bytes:reference.manifestBytes.length,sha256:sha(reference.manifestBytes),bytesValue:reference.manifestBytes}];
 for(const file of copies){const target=join(directory,'reference',file.path);mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,file.bytesValue,{flag:'wx',mode:0o444});need(sha(readFileSync(target))===file.sha256,'reference_copy_changed');}
 const plan={schemaVersion:'1.0',frozenAt:new Date().toISOString(),policy:CAPABILITY_POLICY,scope:SCOPE,providers:CAPABILITY_PROVIDERS,docs:CAPABILITY_DOCS,reference:CAPABILITY_REFERENCE,referenceFiles:copies.map(({bytesValue,...file})=>file),referenceLocalImplementation:reference.localImplementation,referenceSourceArchiveVerifiedAtFreeze:true,referenceSourceArchiveCopied:false,header:reference.header,target:reference.target,rows:capabilityRows(reference.header),sourceManifestSha256:frozen.manifestSha256,productImplementation:frozen.manifest.productImplementation,localImplementation:frozen.manifest.localImplementation,runtime:frozen.manifest.runtime};
 writer.write('plan.json',plan);const planSha256=sha(readFileSync(join(directory,'plan.json')));writer.write('FROZEN.json',{planSha256,sourceManifestSha256:plan.sourceManifestSha256,frozenAt:plan.frozenAt,publicDispatches:0});
 await checkDeploymentCapability({outputDirectory:directory,expectedPlanSha256:planSha256});return{directory,planSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0};
}
export async function checkDeploymentCapability({outputDirectory,expectedPlanSha256}={}){
 const directory=realpathSync(resolve(outputDirectory)),saved=read(join(directory,'plan.json')),plan=saved.value;
 need(sha(saved.bytes)===expectedPlanSha256&&plan.schemaVersion==='1.0'&&equal(plan.policy,CAPABILITY_POLICY)&&equal(plan.scope,SCOPE)&&equal(plan.providers,CAPABILITY_PROVIDERS)&&equal(plan.docs,CAPABILITY_DOCS)&&equal(plan.reference,CAPABILITY_REFERENCE),'frozen_plan_changed');
 const source=await verifyFrozenSources({outputDirectory:directory,expectedManifestSha256:plan.sourceManifestSha256});
 need([SELF,'research/standard-evm/deployment-current.mjs'].every(path=>source.manifest.files.some(file=>file.path===path))&&equal(plan.runtime,source.manifest.runtime)&&equal(plan.productImplementation,source.manifest.productImplementation)&&equal(plan.localImplementation,source.manifest.localImplementation),'source_identity_differs');
 const reference=await verifyCapabilityReference(join(directory,'reference'));
 const files=[...reference.files.map(({bytesValue,...file})=>file),{path:'evidence-manifest.json',bytes:reference.manifestBytes.length,sha256:sha(reference.manifestBytes)}];
 need(equal(plan.referenceFiles,files)&&equal(plan.header,reference.header)&&equal(plan.target,reference.target)&&equal(plan.referenceLocalImplementation,reference.localImplementation)&&plan.referenceSourceArchiveVerifiedAtFreeze===true&&plan.referenceSourceArchiveCopied===false&&equal(plan.rows,capabilityRows(reference.header)),'reference_binding_changed');
 need(equal(read(join(directory,'FROZEN.json')).value,{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,frozenAt:plan.frozenAt,publicDispatches:0}),'freeze_record_changed');return{directory,plan};
}
export async function runDeploymentCapability({outputDirectory,expectedPlanSha256}={}){
 const{directory,plan}=await checkDeploymentCapability({outputDirectory,expectedPlanSha256});need(realpathSync(fileURLToPath(import.meta.url))===join(directory,'runtime',SELF),'archived_entrypoint_required');await verifyNodeRuntime(plan.runtime);
 const writer=createArtifactWriter(directory);writer.write('STARTED.json',{startedAt:new Date().toISOString(),planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,referenceEvidenceManifestSha256:CAPABILITY_REFERENCE.evidenceManifestSha256,runtime:plan.runtime,pid:process.pid});
 const captured=await collectCapabilityRows({header:plan.header,save:wire=>writer.write(`wire/${String(wire.id).padStart(3,'0')}.json`,wire)});
 let sourceUnchanged=false,runtimeUnchanged=false;try{await checkDeploymentCapability({outputDirectory:directory,expectedPlanSha256});sourceUnchanged=true;}catch{}try{await verifyNodeRuntime(plan.runtime);runtimeUnchanged=true;}catch{}
 const{records,...summary}=captured,result={schemaVersion:'1.0',status:sourceUnchanged&&runtimeUnchanged&&!writer.failed&&!captured.usage.saveFailure?'sealed':'integrity_failed',statusMeaning:'capture_completion_not_RPC_support_or_accuracy',planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,sourceUnchanged,runtimeUnchanged,...summary};
 writer.write('results.json',result);return{...result,evidence:sealEvidence(directory,expectedPlanSha256,plan.sourceManifestSha256)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const[command,outputDirectory,expected]=process.argv.slice(2);
 if(command==='freeze')console.log(JSON.stringify(await freezeDeploymentCapability({outputDirectory,expectedProductSha256:expected}),null,2));
 else if(command==='check')console.log(JSON.stringify(await checkDeploymentCapability({outputDirectory,expectedPlanSha256:expected}),null,2));
 else if(command==='run'){const{directory}=await checkDeploymentCapability({outputDirectory,expectedPlanSha256:expected});const archived=await import(pathToFileURL(join(directory,'runtime',SELF)));console.log(JSON.stringify(await archived.runDeploymentCapability({outputDirectory:directory,expectedPlanSha256:expected}),null,2));}
 else throw Error('Usage: deployment-capability.mjs freeze DIRECTORY PRODUCT_SHA | check DIRECTORY PLAN_SHA | run DIRECTORY PLAN_SHA');
}
