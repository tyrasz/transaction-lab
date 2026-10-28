// One fixed CREATE2 development comparison. No transaction is signed/broadcast.
// Raw provider execution is separate from the lifecycle-rejecting product API.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
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
const ROOT=fileURLToPath(new URL('../..',import.meta.url)),SELF='research/standard-evm/lifecycle-current.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>'0x'+BigInt(x).toString(16),word=x=>'0x'+BigInt(x).toString(16).padStart(64,'0');
const hashCode=x=>'0x'+Buffer.from(keccak_256(Buffer.from(x.slice(2),'hex'))).toString('hex');
const own=(o,k)=>Object.hasOwn(o,k),plain=x=>x&&typeof x==='object'&&!Array.isArray(x),ADDRESS=/^0x[0-9a-f]{40}$/,WORD=/^0x[0-9a-f]{64}$/,DATA=/^0x(?:[0-9a-f]{2})*$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
function q(x){need((typeof x==='string'&&/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/.test(x)&&x.length<=80)||(Number.isSafeInteger(x)&&x>=0&&!Object.is(x,-0)),'malformed_quantity');const n=BigInt(x);need(n>=0n&&n<(1n<<256n),'quantity_out_of_range');return n;}
function fields(o,allowed){need(plain(o)&&Object.keys(o).every(k=>allowed.includes(k)),'unknown_state_field');}
function bounded(o){need(Buffer.byteLength(JSON.stringify(o))<=8*1024*1024,'comparison_byte_limit');}
const FACTORY='0xce0042b868300000d44a59004da54a005ffdcf9f',SENDER='0xbb6e024b9cffacb947a71991e386681b1cd1477d';
const RUNTIME='0x60005460005260206000f3';
const RUNTIME_LENGTH=((RUNTIME.length-2)/2).toString(16).padStart(4,'0');
const INIT='0x602a60005561'+RUNTIME_LENGTH+'61001460003961'+RUNTIME_LENGTH+'6000f3'+RUNTIME.slice(2);
const SALT='0x'+sha('transaction-lab/declared-create2-development/v1');
const DATA_CALL='0x4af63f02'+word(64).slice(2)+SALT.slice(2)+word((INIT.length-2)/2).slice(2)+INIT.slice(2).padEnd(Math.ceil((INIT.length-2)/64)*64,'0');
const TARGET='0x'+hashCode('0xff'+FACTORY.slice(2)+SALT.slice(2)+hashCode(INIT).slice(2)).slice(-40);
export const LIFECYCLE_CASE=Object.freeze({id:'eip2470-create2-storage42',reference:'https://eips.ethereum.org/EIPS/eip-2470',factory:FACTORY,sender:SENDER,salt:SALT,initcode:INIT,runtime:RUNTIME,target:TARGET,request:Object.freeze({from:SENDER,to:FACTORY,data:DATA_CALL,value:'0',gas:'5000000'})});
export const LIFECYCLE_POLICY=Object.freeze({calls:261,totalBytes:41*1024*1024,wallMs:330000,requestMs:25000,responseBytes:8*1024*1024,localCalls:256,localBytes:32*1024*1024,localWallMs:120000,providerCalls:3,providerBytes:8*1024*1024,drainMs:25000,liveAndDrainCeilingMs:360000});
const SCOPE=Object.freeze({chainId:1,purpose:'single_fixed_CREATE2_development_not_accuracy_sample',selection:'latest_once_after_source_freeze',referenceInputs:'proof_and_code_only_before_provider_execution',providerComparison:'raw_debug_traceCall_not_product_measurement_API',feesSettled:false,signatureVerified:false,consensusVerified:false,retries:false,replacements:false});
export function lifecycleProviderRequests(header){const call={from:SENDER,to:FACTORY,data:DATA_CALL,value:'0x0',gas:'0x4c4b40',gasPrice:'0x0'},selector={blockHash:header.hash,requireCanonical:true},blockOverrides={baseFeePerGas:'0x0'};return [
 {method:'debug_traceCall',params:[call,selector,{tracer:'callTracer',tracerConfig:{withLog:true},blockOverrides}]},
 {method:'debug_traceCall',params:[call,selector,{tracer:'prestateTracer',tracerConfig:{diffMode:true},blockOverrides}]},
 {method:'eth_getBlockByNumber',params:[header.number,false]},
];}
function output(frame){if(!own(frame,'output'))return'0x';need(typeof frame.output==='string'&&DATA.test(frame.output),'malformed_trace_output');return frame.output;}
function traceFrame(frame){need(plain(frame)&&ADDRESS.test(frame.from)&&ADDRESS.test(frame.to)&&typeof frame.input==='string'&&DATA.test(frame.input),'malformed_trace_frame');need(q(frame.gasUsed)<=q(frame.gas)&&q(frame.gas)<=5000000n&&q(frame.value)===0n,'invalid_trace_gas_value');need(!own(frame,'error')||typeof frame.error==='string'&&frame.error.length>0&&frame.error.length<=2000,'malformed_trace_error');need(!own(frame,'revertReason')||typeof frame.revertReason==='string'&&frame.revertReason.length<=2000&&(!frame.revertReason||frame.error),'malformed_revert_reason');output(frame);need(!own(frame,'logs')||Array.isArray(frame.logs)&&frame.logs.length===0,'unexpected_logs_outside_fixed_scope');}
function providerChanges(diff,inputs,created,scope){
 bounded(diff);need(plain(diff)&&equal(Object.keys(diff).sort(),['post','pre'])&&plain(diff.pre)&&plain(diff.post),'missing_original_state_diff');
 const addresses=[...new Set([...Object.keys(diff.pre),...Object.keys(diff.post)])].sort();need(addresses.length>0&&addresses.length<=128,'incomplete_state_diff');let slots=0;const accounts=[];
 for(const address of addresses){
  need(ADDRESS.test(address),'malformed_state_address');const initial=inputs.accounts[address];need(initial&&typeof initial.exists==='boolean','state_account_not_proven');
  const pre=diff.pre[address],post=diff.post[address];need(post!==undefined,'account_deletion_unsupported');fields(post,['balance','nonce','code','codeHash','storage']);
  if(pre!==undefined)fields(pre,['balance','nonce','code','codeHash','storage']);
  const deployment=address===TARGET&&created;
  if(!initial.exists)need(deployment&&pre===undefined,'unproven_or_unexpected_creation');else need(pre!==undefined,'missing_existing_prestate');
  const prior={nonce:initial.exists?q(initial.nonce):0n,balance:initial.exists?q(initial.balance):0n,code:initial.exists?initial.code:'0x',storage:initial.exists?initial.storage:{}};
  need(typeof prior.code==='string'&&DATA.test(prior.code)&&plain(prior.storage),'malformed_initial_state');
  if(deployment){
   const proof=inputs.provenance.find(row=>row.account===address)?.accountProof;
   need(proof?.nonceRaw==='0'&&proof.codeHash===EMPTY_CODE_HASH&&proof.storageRoot===EMPTY_STORAGE_ROOT&&prior.nonce===0n&&prior.code==='0x'&&Object.values(prior.storage).every(v=>v===word(0)),'target_not_deployable');
  }
  const change={address};if(!initial.exists)change.existence={before:false,after:true,basis:'internal_contract_creation'};
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

/** Five output channels, deliberately narrow to the frozen successful factory
 * CREATE2 path. Collision/revert/unknown deletion remains retained/unavailable,
 * never repaired or promoted into a passing accuracy observation. */
export async function compareLifecycle({header,local,provider}){
 const channels={};
 try{
  need(local?.status==='completed'&&local.output?.execution?.status==='success'&&local.inputs?.status==='available','local_reference_unavailable');
  need(local.broker?.pendingAtReturn===0&&local.isolation?.processClosed===true,'local_drain_incomplete');
  const verified=verifyEthereumHeader({header,expectedHash:header.hash});need(equal(local.headerVerification,verified)&&equal(local.inputs.context.header,header),'local_header_binding');
  await validateInputFacts({inputs:local.inputs,inputEvidence:local.inputEvidence,stateRoot:header.stateRoot});
  const original=local.output,root=original.trace;need(root?.from===SENDER&&root.to===FACTORY&&root.input===DATA_CALL&&q(root.value)===0n,'local_request_binding');
  need(original.profile?.sourceBlockHash===header.hash&&original.profile.declaredGasLimit==='5000000'&&original.profile.executionBaseFee==='0'&&original.profile.gasPrice==='0','local_profile_binding');
  need(Array.isArray(root.calls)&&root.calls.length===1&&root.calls[0].type==='CREATE2'&&root.calls[0].error===null&&root.calls[0].to===TARGET&&root.calls[0].input===INIT&&root.calls[0].output===RUNTIME,'local_collision_or_unexpected_execution');
  need(equal(original.logs,[]),'local_logs_outside_fixed_scope');
  const requests=lifecycleProviderRequests(header);need(Array.isArray(provider)&&provider.length===3,'provider_sequence_incomplete');
  for(let i=0;i<3;i++)need(provider[i].status==='completed'&&equal({method:provider[i].request.method,params:provider[i].request.params},requests[i]),'provider_request_or_response_binding');
  const trace=provider[0].parsed.result,diff=provider[1].parsed.result,confirmed=provider[2].parsed.result;
  verifyEthereumHeader({header:confirmed,expectedHash:header.hash});need(equal(confirmed,header),'full_header_changed');bounded(trace);traceFrame(trace);
  need(trace.type==='CALL'&&trace.from===SENDER&&trace.to===FACTORY&&trace.input===DATA_CALL&&q(trace.gas)===5000000n,'provider_root_binding');
  // Admit a channel only after its request and complete selected header bind.
  // Preserve an established discrepancy if another channel is unavailable.
  channels.execution=!trace.error;
  channels.returnData=output(trace)===original.execution.returnData;
  const bytes=Buffer.from(DATA_CALL.slice(2),'hex'),zero=BigInt([...bytes].filter(x=>x===0).length),nonzero=BigInt(bytes.length)-zero,intrinsic=21000n+4n*zero+16n*nonzero;
  const floor=ethereumCommon(header).isActivatedEIP(7623)?21000n+10n*(zero+4n*nonzero):0n,message=q(original.execution.executionGasUsed),refund=q(original.execution.gasRefundCounter),before=intrinsic+message,capped=refund<before/5n?refund:before/5n,total=before-capped>floor?before-capped:floor;
  need(q(original.profile.intrinsicGas)===intrinsic&&q(root.gas)===5000000n-intrinsic&&q(root.gasUsed)===message&&q(original.gasAccounting.gasUsed)===total,'local_gas_accounting_binding');
  channels.gas=q(trace.gasUsed)===total;
  need(Array.isArray(trace.calls)&&trace.calls.length===1,'provider_factory_path_unavailable');const child=trace.calls[0];traceFrame(child);
  need(child.type==='CREATE2'&&child.from===FACTORY&&child.to===TARGET&&child.input===INIT&&(!own(child,'calls')||Array.isArray(child.calls)&&child.calls.length===0),'provider_create2_binding');
  channels.logs=true;
  need(!trace.error&&!child.error,'provider_failed_deployment');
  const expected=canonicalStateChanges(local.changes),state=providerChanges(diff,local.inputs,true,expected.scope);
  need(diff.pre[SENDER]&&own(diff.pre[SENDER],'nonce')&&diff.post[SENDER]&&own(diff.post[SENDER],'nonce'),'missing_sender_nonce_proof');
  need(q(diff.pre[SENDER].nonce)===q(local.inputs.accounts[SENDER].nonce)&&q(diff.post[SENDER].nonce)===q(local.inputs.accounts[SENDER].nonce)+1n,'sender_nonce_contradiction');
  need(diff.post[TARGET]?.code===output(child),'provider_runtime_views_disagree');
  channels.state=equal(state,expected);
  return {status:Object.values(channels).every(Boolean)?'match':'mismatch',channels,allChannelsComplete:true,providerChanges:state,localChanges:expected,gas:{intrinsic:intrinsic.toString(),message:message.toString(),refundCounter:refund.toString(),cappedRefund:capped.toString(),calldataFloor:floor.toString(),localTotal:total.toString(),providerTotal:q(trace.gasUsed).toString()},scope:'five_output_channels_for_fixed_successful_CREATE2_not_full_call_tree_or_accuracy_score'};
 }catch(error){return {status:Object.values(channels).includes(false)?'mismatch':'unavailable',channels,allChannelsComplete:false,reason:typeof error.code==='string'?error.code:'comparison_evidence_invalid',scope:'retained_incomplete_development_comparison'};}
}
function read(path){const bytes=readFileSync(path);need(bytes.length<=16*1024*1024,'artifact_too_large');return{bytes,value:JSON.parse(bytes)};}
export async function freezeLifecycle({repoRoot=ROOT,outputDirectory,expectedProductSha256}){
 need(typeof expectedProductSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedProductSha256),'stable_product_hash_required');
 const frozen=await freezeCohortSources({repoRoot,outputDirectory,extraFiles:['research/standard-evm/cohort-deployments.json',SELF]}),writer=createArtifactWriter(frozen.outputDirectory);
 need(frozen.manifest.productImplementation.sourceSha256===expectedProductSha256,'stable_product_identity_differs');
 const plan={schemaVersion:'1.0',frozenAt:new Date().toISOString(),policy:LIFECYCLE_POLICY,scope:SCOPE,case:LIFECYCLE_CASE,provider:COHORT_PROVIDERS.drpc,sourceManifestSha256:frozen.manifestSha256,productImplementation:frozen.manifest.productImplementation,localImplementation:frozen.manifest.localImplementation,runtime:frozen.manifest.runtime};
 writer.write('plan.json',plan);const planSha256=sha(readFileSync(join(frozen.outputDirectory,'plan.json')));writer.write('FROZEN.json',{planSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0,frozenAt:plan.frozenAt});
 await checkLifecycle({outputDirectory:frozen.outputDirectory,expectedPlanSha256:planSha256});return{outputDirectory:frozen.outputDirectory,planSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0};
}
export async function checkLifecycle({outputDirectory,expectedPlanSha256}){
 const directory=realpathSync(resolve(outputDirectory)),saved=read(join(directory,'plan.json')),plan=saved.value;need(sha(saved.bytes)===expectedPlanSha256&&plan.schemaVersion==='1.0'&&equal(plan.case,LIFECYCLE_CASE)&&equal(plan.policy,LIFECYCLE_POLICY)&&equal(plan.scope,SCOPE)&&plan.provider===COHORT_PROVIDERS.drpc,'frozen_plan_differs');
 const source=await verifyFrozenSources({outputDirectory:directory,expectedManifestSha256:plan.sourceManifestSha256});need(source.manifest.files.some(f=>f.path===SELF)&&equal(plan.productImplementation,source.manifest.productImplementation)&&equal(plan.localImplementation,source.manifest.localImplementation)&&equal(plan.runtime,source.manifest.runtime),'source_identity_differs');
 need(equal(read(join(directory,'FROZEN.json')).value,{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,publicDispatches:0,frozenAt:plan.frozenAt}),'freeze_record_differs');return{directory,plan};
}
export async function runLifecycle({outputDirectory,expectedPlanSha256}){
 const {directory,plan}=await checkLifecycle({outputDirectory,expectedPlanSha256});need(realpathSync(fileURLToPath(import.meta.url))===join(directory,'runtime',SELF),'run_requires_archived_entrypoint');await verifyNodeRuntime(plan.runtime);
 const writer=createArtifactWriter(directory);writer.write('STARTED.json',{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,runtime:plan.runtime,startedAt:new Date().toISOString(),pid:process.pid});
 const started=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),plan.policy.wallMs),budget=createCohortWireBudget({limits:{calls:plan.policy.calls,totalBytes:plan.policy.totalBytes,wallMs:plan.policy.wallMs}}),active=new Set();let header=null,selection=null,local=null,provider=null,comparison=null,sourceUnchanged=false,runtimeUnchanged=false;const failures=[];
 const remaining=()=>Math.max(0,Math.floor(plan.policy.wallMs-(performance.now()-started)));
 const transport=(profile,limits,anchor)=>{const rpc=createCohortTransport({budget,provider:'drpc',profile,...(anchor?{blockHash:anchor.hash,...(profile==='local'?{header:anchor}:{})}:{}),limits:{...limits,wallMs:Math.max(1,Math.min(profile==='census'?plan.policy.wallMs:145000,remaining()))},save:wire=>writer.write(`wire/${String(wire.globalId).padStart(6,'0')}.json`,wire)});active.add(rpc);return rpc;};
 const integrity=async()=>{need(!writer.failed&&!budget.snapshot().saveFailure,'wire_save_failed');await checkLifecycle({outputDirectory:directory,expectedPlanSha256});need(!controller.signal.aborted&&remaining()>0,'run_budget_exhausted');};
 try{
  const rpc=transport('census',{calls:2,totalBytes:1024*1024});
  try{const chainId=await rpc.call('eth_chainId',[],{signal:controller.signal});need(chainId==='0x1','wrong_chain');header=await rpc.call('eth_getBlockByNumber',['latest',false],{signal:controller.signal});selection={status:'selected',chainId,header,verification:verifyEthereumHeader({header,expectedHash:header?.hash})};}
  catch(error){selection={status:'unavailable',header,reason:error.code??'selection_unavailable'};}
  await rpc.drain();writer.write('selection.json',selection);active.delete(rpc);need(selection.status==='selected','selection_unavailable');await integrity();
  const localRpc=transport('local',{calls:plan.policy.localCalls,totalBytes:plan.policy.localBytes},header);
  local=await executeIsolatedEthereumCall({request:plan.case.request,header,rpc:localRpc,signal:controller.signal,limits:{wallMs:Math.max(1,Math.min(plan.policy.localWallMs,remaining())),drainMs:plan.policy.drainMs}});
  await localRpc.drain();writer.write('local.json',{implementation:plan.localImplementation,attempt:local,transportWireIds:localRpc.records().map(w=>w.globalId),usage:localRpc.usage(),denied:localRpc.denied()});active.delete(localRpc);
  need(local.broker?.pendingAtReturn===0&&(!local.isolation?.childPid||local.isolation.processClosed),'local_drain_incomplete');await integrity();
  const providerRpc=transport('product',{calls:plan.policy.providerCalls,totalBytes:plan.policy.providerBytes},header);
  for(const request of lifecycleProviderRequests(header)){try{await providerRpc.call(request.method,request.params,{signal:controller.signal});}catch(error){failures.push({phase:'provider',code:error.code??'provider_unavailable'});break;}}
  await providerRpc.drain();provider=providerRpc.records();writer.write('provider.json',{records:provider,usage:providerRpc.usage(),denied:providerRpc.denied(),basis:'raw_provider_execution_not_product_API'});active.delete(providerRpc);await integrity();
  comparison=await compareLifecycle({header,local,provider});
 }catch(error){failures.push({phase:'run',code:error.code??'run_unavailable'});}
 finally{clearTimeout(timer);controller.abort();for(const rpc of active){try{await rpc.drain();}catch{failures.push({phase:'drain',code:'wire_save_failed'});}}}
 try{await checkLifecycle({outputDirectory:directory,expectedPlanSha256});sourceUnchanged=true;}catch{failures.push({phase:'seal',code:'source_or_plan_drift'});}
 try{await verifyNodeRuntime(plan.runtime);runtimeUnchanged=true;}catch{failures.push({phase:'seal',code:'runtime_drift'});}
 if(!sourceUnchanged||!runtimeUnchanged||writer.failed||budget.snapshot().saveFailure)comparison={status:'unavailable',channels:{},allChannelsComplete:false,reason:'capture_integrity_failure'};
 const result={schemaVersion:'1.0',status:failures.length?'incomplete':'complete',statusMeaning:'capture_process_completion_not_execution_success_or_accuracy',planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,sourceUnchanged,runtimeUnchanged,selectionStatus:selection?.status??'not_attempted',localStatus:local===null?'not_attempted':local.output?.execution?.status??local.status,providerRequests:provider?.length??0,comparison:comparison??{status:'unavailable',channels:{},allChannelsComplete:false,reason:'comparison_not_reached'},failures,budget:budget.snapshot(),durationMs:performance.now()-started,scope:SCOPE};
 writer.write('comparison.json',result.comparison);writer.write('results.json',result);const evidence=sealEvidence(directory,expectedPlanSha256,plan.sourceManifestSha256);return{...result,evidence};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,outputDirectory,expected]=process.argv.slice(2);
 if(command==='freeze')console.log(JSON.stringify(await freezeLifecycle({outputDirectory,expectedProductSha256:expected}),null,2));
 else if(command==='check')console.log(JSON.stringify(await checkLifecycle({outputDirectory,expectedPlanSha256:expected}),null,2));
 else if(command==='run'){const {directory}=await checkLifecycle({outputDirectory,expectedPlanSha256:expected});const archived=await import(pathToFileURL(join(directory,'runtime',SELF)));console.log(JSON.stringify(await archived.runLifecycle({outputDirectory:directory,expectedPlanSha256:expected}),null,2));}
 else throw Error('Usage: lifecycle-current.mjs freeze DIRECTORY PRODUCT_SHA | check DIRECTORY PLAN_SHA | run DIRECTORY PLAN_SHA');
}
