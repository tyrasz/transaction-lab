// One fixed top-level CREATE development comparison. No signing or broadcast.
// Local proof inputs are collected before independent raw provider execution.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';
import { createArtifactWriter, sealEvidence } from './cohort-pilot.mjs';
import { createCohortTransport, createCohortWireBudget, COHORT_PROVIDERS } from './cohort-wire.mjs';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { ethereumCommon } from '../../engines/local-evm/ethereum-profile.js';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { validateInputFacts } from '../../engines/local-evm/input-facts.js';
import { EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH } from '../../engines/local-evm/verified-state-proof.js';
import { canonicalStateChanges } from '../../engines/local-evm/preview-mutations.js';
const ROOT=fileURLToPath(new URL('../..',import.meta.url)),SELF='research/standard-evm/deployment-current.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>'0x'+BigInt(x).toString(16),word=x=>'0x'+BigInt(x).toString(16).padStart(64,'0');
const hashCode=x=>'0x'+Buffer.from(keccak_256(Buffer.from(x.slice(2),'hex'))).toString('hex');
const own=(o,k)=>Object.hasOwn(o,k),plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype,ADDRESS=/^0x[0-9a-f]{40}$/,WORD=/^0x[0-9a-f]{64}$/,DATA=/^0x(?:[0-9a-f]{2})*$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
function q(x){need((typeof x==='string'&&/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/.test(x)&&x.length<=80)||(Number.isSafeInteger(x)&&x>=0&&!Object.is(x,-0)),'malformed_quantity');const n=BigInt(x);need(n>=0n&&n<(1n<<256n),'quantity_out_of_range');return n;}
function fields(o,allowed){need(plain(o)&&Object.keys(o).every(k=>allowed.includes(k)),'unknown_state_field');}
function bounded(o){need(Buffer.byteLength(JSON.stringify(o))<=8*1024*1024,'comparison_byte_limit');}
const SENDER='0xbb6e024b9cffacb947a71991e386681b1cd1477d';
const RUNTIME='0x60005460005260206000f3';
const INIT='0x602a60005561000b61001460003961000b6000f3'+RUNTIME.slice(2);
export const DEPLOYMENT_CASE=Object.freeze({id:'eip2470-sender-root-create-storage42',reference:'https://eips.ethereum.org/EIPS/eip-2470',sender:SENDER,initcode:INIT,runtime:RUNTIME,targetDerivation:'keccak256_rlp_sender_proven_initial_nonce',request:Object.freeze({from:SENDER,to:null,data:INIT,value:'0',gas:'5000000'})});
export const DEPLOYMENT_POLICY=Object.freeze({calls:261,totalBytes:41*1024*1024,wallMs:330000,requestMs:25000,responseBytes:8*1024*1024,localCalls:256,localBytes:32*1024*1024,localWallMs:120000,providerCalls:3,providerBytes:8*1024*1024,drainMs:25000,liveAndDrainCeilingMs:360000});
const SCOPE=Object.freeze({chainId:1,purpose:'single_fixed_top_level_CREATE_development_not_accuracy_sample',selection:'latest_once_after_source_freeze',referenceInputs:'proof_and_code_only_before_provider_execution',target:'derived_from_authenticated_sender_initial_nonce_never_provider_output',providerComparison:'raw_debug_traceCall_not_product_measurement_API',comparisonAdmission:'five_channels_only_for_successful_fixed_constructor',feesSettled:false,signatureVerified:false,consensusVerified:false,retries:false,replacements:false,stopOnProviderFailure:true});
export function deploymentProviderRequests(header){const call={from:SENDER,to:null,data:INIT,value:'0x0',gas:'0x4c4b40',gasPrice:'0x0'},selector={blockHash:header.hash,requireCanonical:true},blockOverrides={baseFeePerGas:'0x0'};return [
 {method:'debug_traceCall',params:[call,selector,{tracer:'callTracer',tracerConfig:{withLog:true},blockOverrides}]},
 {method:'debug_traceCall',params:[call,selector,{tracer:'prestateTracer',tracerConfig:{diffMode:true},blockOverrides}]},
 {method:'eth_getBlockByNumber',params:[header.number,false]},
];}
/** Recompute CREATE's address from cryptographically checked initial facts.
 * This authenticates the supplied root, not chain consensus or finality. */
export async function deriveDeploymentTarget({header,local}){
 const verified=verifyEthereumHeader({header,expectedHash:header.hash});
 need(local?.inputs?.status==='available'&&equal(local.headerVerification,verified)&&equal(local.inputs.context.header,header),'local_header_or_inputs_unavailable');
 await validateInputFacts({inputs:local.inputs,inputEvidence:local.inputEvidence,stateRoot:header.stateRoot});
 const initial=local.inputs.accounts[SENDER],provenance=local.inputs.provenance.find(row=>row.account===SENDER);
 need(initial&&provenance&&(!initial.exists||initial.code==='0x'),'sender_proof_or_code_unavailable');
 const nonce=initial.exists?q(initial.nonce):0n;need(nonce<(1n<<64n)-1n,'sender_nonce_not_admissible');
 let encoded=nonce===0n?'':nonce.toString(16);if(encoded.length%2)encoded='0'+encoded;
 const digest=keccak_256(RLP.encode([Buffer.from(SENDER.slice(2),'hex'),Buffer.from(encoded,'hex')]));
 return {status:'verified',sender:SENDER,senderNonceRaw:nonce.toString(),address:'0x'+Buffer.from(digest).subarray(12).toString('hex'),blockHash:header.hash,stateRoot:header.stateRoot,proofEvidenceId:provenance.proofEvidenceId,codeEvidenceId:provenance.codeEvidenceId,basis:DEPLOYMENT_CASE.targetDerivation};
}
function output(frame){if(!own(frame,'output'))return'0x';need(typeof frame.output==='string'&&DATA.test(frame.output),'malformed_trace_output');return frame.output;}
function traceFrame(frame,depth=0,counts={frames:0,logs:0}){
 need(plain(frame)&&++counts.frames<=1000&&depth<=32&&['CALL','CALLCODE','DELEGATECALL','STATICCALL','CREATE','CREATE2'].includes(frame.type),'malformed_trace_frame');
 need(typeof frame.from==='string'&&ADDRESS.test(frame.from)&&typeof frame.to==='string'&&ADDRESS.test(frame.to)&&typeof frame.input==='string'&&DATA.test(frame.input),'malformed_trace_frame');
 need(q(frame.gasUsed)<=q(frame.gas)&&q(frame.gas)<=5000000n,'invalid_trace_gas');q(frame.value);
 need(!own(frame,'error')||typeof frame.error==='string'&&frame.error.length>0&&frame.error.length<=2000,'malformed_trace_error');
 need(!own(frame,'revertReason')||typeof frame.revertReason==='string'&&frame.revertReason.length<=2000&&(!frame.revertReason||frame.error),'malformed_revert_reason');output(frame);
 if(own(frame,'logs')){
  need(Array.isArray(frame.logs)&&frame.logs.length<=2000,'malformed_trace_logs');
  for(const log of frame.logs){
   fields(log,['address','topics','data','position','index']);
   need(++counts.logs<=2000&&typeof log.address==='string'&&ADDRESS.test(log.address)&&Array.isArray(log.topics)&&log.topics.length<=4&&log.topics.every(x=>typeof x==='string'&&WORD.test(x))&&typeof log.data==='string'&&DATA.test(log.data)&&log.data.length<=131074,'malformed_trace_log');
   for(const key of ['position','index'])if(own(log,key))need(q(log[key])<(1n<<64n),'malformed_trace_log_order');
  }
 }
 if(own(frame,'calls')){need(Array.isArray(frame.calls)&&frame.calls.length<=1000,'malformed_trace_calls');for(const child of frame.calls)traceFrame(child,depth+1,counts);}
}
function providerChanges(diff,inputs,target,scope){
 bounded(diff);need(plain(diff)&&equal(Object.keys(diff).sort(),['post','pre'])&&plain(diff.pre)&&plain(diff.post),'missing_original_state_diff');
 const addresses=[...new Set([...Object.keys(diff.pre),...Object.keys(diff.post)])].sort();need(addresses.length>0&&addresses.length<=128,'incomplete_state_diff');let slots=0;const accounts=[];
 for(const address of addresses){
  need(ADDRESS.test(address),'malformed_state_address');const initial=inputs.accounts[address];need(initial&&typeof initial.exists==='boolean','state_account_not_proven');
  const pre=diff.pre[address],post=diff.post[address];need(post!==undefined,'account_deletion_unsupported');fields(post,['balance','nonce','code','codeHash','storage']);
  if(pre!==undefined)fields(pre,['balance','nonce','code','codeHash','storage']);
  const deployment=address===target;
  const senderMaterialization=address===SENDER&&!initial.exists;
  if(!initial.exists)need((deployment||senderMaterialization)&&pre===undefined,'unproven_or_unexpected_creation');else need(pre!==undefined,'missing_existing_prestate');
  const prior={nonce:initial.exists?q(initial.nonce):0n,balance:initial.exists?q(initial.balance):0n,code:initial.exists?initial.code:'0x',storage:initial.exists?initial.storage:{}};
  need(typeof prior.code==='string'&&DATA.test(prior.code)&&plain(prior.storage),'malformed_initial_state');
  if(deployment){
   const proof=inputs.provenance.find(row=>row.account===address)?.accountProof;
   need(proof?.nonceRaw==='0'&&proof.codeHash===EMPTY_CODE_HASH&&proof.storageRoot===EMPTY_STORAGE_ROOT&&prior.nonce===0n&&prior.code==='0x'&&Object.values(prior.storage).every(v=>v===word(0)),'target_not_deployable');
  }
  const change={address};if(!initial.exists)change.existence={before:false,after:true,basis:deployment?'top_level_contract_creation':'unsigned_sender_nonce_materialization'};
  for(const key of ['nonce','balance']){
   if(pre&&own(pre,key))need(q(pre[key])===prior[key],'prior_basic_state_contradicts_proof');
   const next=own(post,key)?q(post[key]):initial.exists?prior[key]:0n;
   if(next!==prior[key]){need(!initial.exists||pre&&own(pre,key)||prior[key]===0n,'missing_nonzero_prior_basic');change[key]={before:hex(prior[key]),after:hex(next)};}
  }
  for(const phase of ['pre','post']){const row=phase==='pre'?pre:post;if(!row)continue;const code=own(row,'code')?row.code:phase==='post'&&deployment?null:prior.code;
   if(code!==null)need(typeof code==='string'&&DATA.test(code),'malformed_runtime');
   if(phase==='pre'&&own(row,'code'))need(code===prior.code,'prior_code_contradicts_proof');
   if(own(row,'codeHash'))need(code!==null&&row.codeHash===hashCode(code),'runtime_hash_contradiction');
  }
  const nextCode=own(post,'code')?post.code:prior.code;
  if(nextCode!==prior.code){need(deployment,'unrelated_code_mutation');change.code={before:prior.code,after:nextCode};}
  const ps=pre?.storage??{},ns=post.storage??{};need(plain(ps)&&plain(ns),'malformed_storage');const storage=[];
  for(const slot of [...new Set([...Object.keys(ps),...Object.keys(ns)])].sort()){
   need(++slots<=1024&&WORD.test(slot),'storage_limit_or_key');let old=prior.storage[slot];if(old===undefined&&deployment)old=word(0);need(typeof old==='string'&&WORD.test(old),'unproven_prior_storage');
   if(own(ps,slot))need(ps[slot]===old,'prior_storage_contradicts_proof');else need(old===word(0),'missing_nonzero_prior_storage');
   const next=own(ns,slot)?ns[slot]:word(0);need(typeof next==='string'&&WORD.test(next),'malformed_next_storage');if(next!==old)storage.push({slot,before:old,after:next});
  }
  if(storage.length)change.storage=storage;if(Object.keys(change).length>1)accounts.push(change);
 }
 return canonicalStateChanges({scope,accounts});
}

/** Fixed successful root CREATE only. Every unavailable/fault/collision remains
 * retained, without a substitute case or a population accuracy claim. */
export async function compareDeployment({header,local,provider}){
 const channels={};
 try{
  need(local?.status==='completed'&&local.output?.execution?.status==='success','local_reference_unavailable');
  need(local.broker?.pendingAtReturn===0&&local.isolation?.processClosed===true,'local_drain_incomplete');
  const target=await deriveDeploymentTarget({header,local}),original=local.output,root=original.trace;
  need(root?.type==='CREATE'&&root.from===SENDER&&root.caller===SENDER&&root.to===target.address&&root.executionAddress===target.address&&root.input===INIT&&q(root.value)===0n&&root.error===null,'local_request_binding');
  need(Array.isArray(root.calls)&&root.calls.length===0&&root.output===RUNTIME&&original.execution.returnData===RUNTIME&&original.execution.error===null&&equal(original.logs,[]),'local_execution_outside_fixed_scope');
  need(original.stateDisposition==='message_result_retained_in_supplied_manager','local_state_not_retained');
  const bytes=Buffer.from(INIT.slice(2),'hex'),zero=BigInt([...bytes].filter(x=>x===0).length),nonzero=BigInt(bytes.length)-zero,words=(BigInt(bytes.length)+31n)/32n;
  const intrinsic=21000n+32000n+2n*words+4n*zero+16n*nonzero,floor=ethereumCommon(header).isActivatedEIP(7623)?21000n+10n*(zero+4n*nonzero):0n;
  const profile={name:'ethereum_unsigned_unpriced_call',chainId:1,hardfork:ethereumCommon(header).hardfork(),forkSchedule:'pinned_ethereumjs_common_10.1.3_mainnet',sourceBlockHash:header.hash,sourceStateRoot:header.stateRoot,sourceBlockIdentityVerified:false,sourceStateProofVerified:false,actualBlockBaseFee:q(header.baseFeePerGas).toString(),executionBaseFee:'0',gasPrice:'0',declaredGasLimit:'5000000',intrinsicGas:intrinsic.toString(),calldataFloor:floor.toString(),messageGasLimit:(5000000n-intrinsic).toString(),calldataZeroBytes:zero.toString(),calldataNonzeroBytes:nonzero.toString(),outerSignatureVerified:false,feesSettled:false,originalTransactionPosition:false,expectedOutputsUsed:false,operation:'create',initcodeBytes:bytes.length.toString(),creationIntrinsicGas:'32000',initcodeWordGas:(2n*words).toString()};
  need(equal(original.profile,profile),'local_profile_binding');
  need(equal(original.environment,{chainId:1,hardfork:profile.hardfork,number:q(header.number).toString(),timestamp:q(header.timestamp).toString(),gasLimit:q(header.gasLimit).toString(),baseFeePerGas:'0',mixHash:header.mixHash,miner:header.miner,sourceBlockHash:header.hash,sourceParentHash:header.parentHash,sourceBlockIdentityVerified:false}),'local_environment_binding');
  const message=q(original.execution.executionGasUsed),refund=q(original.execution.gasRefundCounter),before=intrinsic+message,capped=refund<before/5n?refund:before/5n,total=before-capped>floor?before-capped:floor;
  need(message<=5000000n-intrinsic&&q(root.gas)===5000000n-intrinsic&&q(root.gasUsed)===message&&equal(original.gasAccounting,{beforeRefund:before.toString(),appliedRefund:capped.toString(),floorAdjustment:(total-(before-capped)).toString(),gasUsed:total.toString()}),'local_gas_accounting_binding');
  const requests=deploymentProviderRequests(header);need(Array.isArray(provider)&&provider.length===3,'provider_sequence_incomplete');
  for(let i=0;i<3;i++){const row=provider[i];need(row.status==='completed'&&row.request.jsonrpc==='2.0'&&Number.isSafeInteger(row.request.id)&&row.request.id>0&&row.parsed?.jsonrpc==='2.0'&&row.parsed.id===row.request.id&&own(row.parsed,'result')&&!own(row.parsed,'error')&&equal({method:row.request.method,params:row.request.params},requests[i]),'provider_request_or_response_binding');}
  const trace=provider[0].parsed.result,diff=provider[1].parsed.result,confirmed=provider[2].parsed.result;
  verifyEthereumHeader({header:confirmed,expectedHash:header.hash});need(equal(confirmed,header),'full_header_changed');bounded(trace);traceFrame(trace);
  need(trace.type==='CREATE'&&trace.from===SENDER&&trace.to===target.address&&trace.input===INIT&&q(trace.value)===0n&&q(trace.gas)===5000000n,'provider_root_binding');
  // Preserve an already established discrepancy if a later channel is absent.
  channels.execution=!trace.error;
  channels.returnData=output(trace)===original.execution.returnData;
  channels.gas=q(trace.gasUsed)===total;
  channels.logs=(trace.logs??[]).length===0;
  need((trace.calls??[]).length===0,'provider_calls_outside_fixed_scope');
  need(!trace.error,'provider_failed_deployment');
  const expected=canonicalStateChanges(local.changes),state=providerChanges(diff,local.inputs,target.address,expected.scope);
  const senderPre=diff.pre[SENDER],senderPost=diff.post[SENDER];
  need(senderPost&&own(senderPost,'nonce')&&(target.senderNonceRaw==='0'||senderPre&&own(senderPre,'nonce')),'missing_sender_nonce_proof');
  need((senderPre&&own(senderPre,'nonce')?q(senderPre.nonce):0n)===BigInt(target.senderNonceRaw)&&q(senderPost.nonce)===BigInt(target.senderNonceRaw)+1n,'sender_nonce_contradiction');
  need(diff.post[target.address]?.code===output(trace),'provider_runtime_views_disagree');
  channels.state=equal(state,expected);
  return {status:Object.values(channels).every(Boolean)?'match':'mismatch',channels,allChannelsComplete:true,target,providerChanges:state,localChanges:expected,gas:{intrinsic:intrinsic.toString(),creationIntrinsic:'32000',initcodeWordGas:(2n*words).toString(),message:message.toString(),refundCounter:refund.toString(),cappedRefund:capped.toString(),calldataFloor:floor.toString(),localTotal:total.toString(),providerTotal:q(trace.gasUsed).toString()},scope:'five_output_channels_for_fixed_successful_root_CREATE_not_population_accuracy'};
 }catch(error){return {status:Object.values(channels).includes(false)?'mismatch':'unavailable',channels,allChannelsComplete:false,reason:typeof error.code==='string'?error.code:'comparison_evidence_invalid',scope:'retained_incomplete_development_comparison'};}
}
function read(path){const bytes=readFileSync(path);need(bytes.length<=16*1024*1024,'artifact_too_large');return{bytes,value:JSON.parse(bytes)};}
export async function freezeDeployment({repoRoot=ROOT,outputDirectory,expectedProductSha256}){
 need(typeof expectedProductSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedProductSha256),'stable_product_hash_required');
 const frozen=await freezeCohortSources({repoRoot,outputDirectory,extraFiles:['research/standard-evm/cohort-deployments.json',SELF]}),writer=createArtifactWriter(frozen.outputDirectory);
 need(frozen.manifest.productImplementation.sourceSha256===expectedProductSha256,'stable_product_identity_differs');
 const plan={schemaVersion:'1.0',frozenAt:new Date().toISOString(),policy:DEPLOYMENT_POLICY,scope:SCOPE,case:DEPLOYMENT_CASE,provider:COHORT_PROVIDERS.drpc,sourceManifestSha256:frozen.manifestSha256,productImplementation:frozen.manifest.productImplementation,localImplementation:frozen.manifest.localImplementation,runtime:frozen.manifest.runtime};
 writer.write('plan.json',plan);const planSha256=sha(readFileSync(join(frozen.outputDirectory,'plan.json')));writer.write('FROZEN.json',{planSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0,frozenAt:plan.frozenAt});
 await checkDeployment({outputDirectory:frozen.outputDirectory,expectedPlanSha256:planSha256});return{outputDirectory:frozen.outputDirectory,planSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0};
}
export async function checkDeployment({outputDirectory,expectedPlanSha256}){
 const directory=realpathSync(resolve(outputDirectory)),saved=read(join(directory,'plan.json')),plan=saved.value;need(sha(saved.bytes)===expectedPlanSha256&&plan.schemaVersion==='1.0'&&equal(plan.case,DEPLOYMENT_CASE)&&equal(plan.policy,DEPLOYMENT_POLICY)&&equal(plan.scope,SCOPE)&&plan.provider===COHORT_PROVIDERS.drpc,'frozen_plan_differs');
 const source=await verifyFrozenSources({outputDirectory:directory,expectedManifestSha256:plan.sourceManifestSha256});need(source.manifest.files.some(f=>f.path===SELF)&&equal(plan.productImplementation,source.manifest.productImplementation)&&equal(plan.localImplementation,source.manifest.localImplementation)&&equal(plan.runtime,source.manifest.runtime),'source_identity_differs');
 need(equal(read(join(directory,'FROZEN.json')).value,{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0,frozenAt:plan.frozenAt}),'freeze_record_differs');return{directory,plan};
}
export async function runDeployment({outputDirectory,expectedPlanSha256}){
 const {directory,plan}=await checkDeployment({outputDirectory,expectedPlanSha256});need(realpathSync(fileURLToPath(import.meta.url))===join(directory,'runtime',SELF),'run_requires_archived_entrypoint');await verifyNodeRuntime(plan.runtime);
 const writer=createArtifactWriter(directory);writer.write('STARTED.json',{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,runtime:plan.runtime,startedAt:new Date().toISOString(),pid:process.pid});
 const started=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),plan.policy.wallMs),budget=createCohortWireBudget({limits:{calls:plan.policy.calls,totalBytes:plan.policy.totalBytes,wallMs:plan.policy.wallMs}}),active=new Set();let header=null,selection=null,local=null,target=null,provider=null,comparison=null,sourceUnchanged=false,runtimeUnchanged=false;const failures=[];
 const remaining=()=>Math.max(0,Math.floor(plan.policy.wallMs-(performance.now()-started)));
 const transport=(profile,limits,anchor)=>{const rpc=createCohortTransport({budget,provider:'drpc',profile,...(anchor?{blockHash:anchor.hash,...(profile==='local'?{header:anchor}:{})}:{}),limits:{...limits,wallMs:Math.max(1,Math.min(profile==='census'?plan.policy.wallMs:145000,remaining()))},save:wire=>writer.write(`wire/${String(wire.globalId).padStart(6,'0')}.json`,wire)});active.add(rpc);return rpc;};
 const integrity=async()=>{need(!writer.failed&&!budget.snapshot().saveFailure,'wire_save_failed');await checkDeployment({outputDirectory:directory,expectedPlanSha256});need(!controller.signal.aborted&&remaining()>0,'run_budget_exhausted');};
 try{
  const rpc=transport('census',{calls:2,totalBytes:1024*1024});
  try{const chainId=await rpc.call('eth_chainId',[],{signal:controller.signal});need(chainId==='0x1','wrong_chain');header=await rpc.call('eth_getBlockByNumber',['latest',false],{signal:controller.signal});selection={status:'selected',chainId,header,verification:verifyEthereumHeader({header,expectedHash:header?.hash})};}
  catch(error){selection={status:'unavailable',header,reason:error.code??'selection_unavailable'};}
  await rpc.drain();writer.write('selection.json',selection);active.delete(rpc);need(selection.status==='selected','selection_unavailable');await integrity();
  const localRpc=transport('local',{calls:plan.policy.localCalls,totalBytes:plan.policy.localBytes},header);
  local=await executeIsolatedEthereumCall({request:plan.case.request,header,rpc:localRpc,signal:controller.signal,limits:{wallMs:Math.max(1,Math.min(plan.policy.localWallMs,remaining())),drainMs:plan.policy.drainMs}});
  await localRpc.drain();writer.write('local.json',{implementation:plan.localImplementation,attempt:local,transportWireIds:localRpc.records().map(w=>w.globalId),usage:localRpc.usage(),denied:localRpc.denied()});active.delete(localRpc);
  need(local.broker?.pendingAtReturn===0&&(!local.isolation?.childPid||local.isolation.processClosed),'local_drain_incomplete');
  try{target=await deriveDeploymentTarget({header,local});}catch(error){target={status:'unavailable',reason:error.code??'target_proof_unavailable'};}writer.write('target.json',target);await integrity();
  const providerRpc=transport('product',{calls:plan.policy.providerCalls,totalBytes:plan.policy.providerBytes},header);
  for(const request of deploymentProviderRequests(header)){try{await providerRpc.call(request.method,request.params,{signal:controller.signal});}catch(error){failures.push({phase:'provider',code:error.code??'provider_unavailable'});break;}}
  await providerRpc.drain();provider=providerRpc.records();writer.write('provider.json',{records:provider,usage:providerRpc.usage(),denied:providerRpc.denied(),basis:'raw_provider_execution_not_product_API'});active.delete(providerRpc);await integrity();
  comparison=await compareDeployment({header,local,provider});
 }catch(error){failures.push({phase:'run',code:error.code??'run_unavailable'});}
 finally{clearTimeout(timer);controller.abort();for(const rpc of active){try{await rpc.drain();}catch{failures.push({phase:'drain',code:'wire_save_failed'});}}}
 try{await checkDeployment({outputDirectory:directory,expectedPlanSha256});sourceUnchanged=true;}catch{failures.push({phase:'seal',code:'source_or_plan_drift'});}
 try{await verifyNodeRuntime(plan.runtime);runtimeUnchanged=true;}catch{failures.push({phase:'seal',code:'runtime_drift'});}
 if(!sourceUnchanged||!runtimeUnchanged||writer.failed||budget.snapshot().saveFailure)comparison={status:'unavailable',channels:{},allChannelsComplete:false,reason:'capture_integrity_failure'};
 const result={schemaVersion:'1.0',status:failures.length?'incomplete':'complete',statusMeaning:'capture_process_completion_not_execution_success_or_accuracy',planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,sourceUnchanged,runtimeUnchanged,selectionStatus:selection?.status??'not_attempted',localStatus:local===null?'not_attempted':local.output?.execution?.status??local.status,targetStatus:target?.status??'not_attempted',providerPlannedRequests:3,providerRequests:provider?.length??0,comparison:comparison??{status:'unavailable',channels:{},allChannelsComplete:false,reason:'comparison_not_reached'},failures,budget:budget.snapshot(),durationMs:performance.now()-started,scope:SCOPE};
 writer.write('comparison.json',result.comparison);writer.write('results.json',result);const evidence=sealEvidence(directory,expectedPlanSha256,plan.sourceManifestSha256);return{...result,evidence};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,outputDirectory,expected]=process.argv.slice(2);
 if(command==='freeze')console.log(JSON.stringify(await freezeDeployment({outputDirectory,expectedProductSha256:expected}),null,2));
 else if(command==='check')console.log(JSON.stringify(await checkDeployment({outputDirectory,expectedPlanSha256:expected}),null,2));
 else if(command==='run'){const {directory}=await checkDeployment({outputDirectory,expectedPlanSha256:expected});const archived=await import(pathToFileURL(join(directory,'runtime',SELF)));console.log(JSON.stringify(await archived.runDeployment({outputDirectory:directory,expectedPlanSha256:expected}),null,2));}
 else throw Error('Usage: deployment-current.mjs freeze DIRECTORY PRODUCT_SHA | check DIRECTORY PLAN_SHA | run DIRECTORY PLAN_SHA');
}
