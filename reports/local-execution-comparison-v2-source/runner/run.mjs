// Offline local execution/report. Inputs are constructed and executed before
// comparison channels are read. No fetch, RPC client, signing or broadcast API.
import assert from 'node:assert/strict';
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const DIR=new URL('./',import.meta.url),ROOT=new URL('../../',import.meta.url),ENGINE=new URL('engines/local-evm/',ROOT);
const sha=b=>createHash('sha256').update(b).digest('hex'),json=o=>JSON.stringify(o,null,2)+'\n';
const mode=process.argv[2];assert.ok(['--write','--verify','--check'].includes(mode),'Use --check, --write once, or --verify.');
const captureBytes=await readFile(new URL('reports/local-execution-state/capture.json',ROOT));
assert.equal(sha(captureBytes),'8e7ca6979a894a6a4340379ef2ff875e7b398e2b48f157324d081dd319c40876');
const capture=JSON.parse(captureBytes),stateManifest=JSON.parse(await readFile(new URL('reports/local-execution-state/packet-manifest.json',ROOT)));
for(const entry of stateManifest.files)assert.equal(sha(await readFile(new URL('reports/local-execution-state/'+entry.file,ROOT))),entry.sha256);
assert.equal(capture.status,'complete');assert.equal(capture.skipped.length,0);assert.equal(capture.summary.failedRpcCalls,0);
async function sources(){
  const runtime=(await readdir(ENGINE)).filter(f=>f.endsWith('.js')).sort();
  assert.deepEqual(runtime,['compare-recorded.js','execute.js','prestate-inputs.js','recorded-state.js']);
  const tests=(await readdir(new URL('test/',ENGINE))).filter(f=>f.endsWith('.test.js')).sort().map(f=>'test/'+f);
  const digest=createHash('sha256'),files=[];
  for(const file of [...runtime,'package.json','package-lock.json',...tests]){const b=await readFile(new URL(file,ENGINE));files.push({file,bytes:b.length,sha256:sha(b)});digest.update(file+'\0').update(b).update('\0');}
  const packageJson=JSON.parse(await readFile(new URL('package.json',ENGINE))),lock=JSON.parse(await readFile(new URL('package-lock.json',ENGINE))),dependencies=[];
  for(const[name,version]of Object.entries(packageJson.dependencies).sort(([a],[b])=>a<b?-1:1)){const installed=JSON.parse(await readFile(new URL('node_modules/'+name+'/package.json',ENGINE)));assert.equal(installed.version,version);assert.equal(lock.packages['node_modules/'+name].version,version);dependencies.push({name,version,lockIntegrity:lock.packages['node_modules/'+name].integrity??null});}
  return {sourceSha256:digest.digest('hex'),files,dependencies,lockSha256:files.find(f=>f.file==='package-lock.json').sha256,node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch};
}
const previousPacketBytes=await readFile(new URL('reports/local-execution-comparison/packet-manifest.json',ROOT));
assert.equal(sha(previousPacketBytes),'3f20d0cd30c2578154258656ada5d4e696e5ac6b27833688bcc60da7077385f7');
for(const entry of JSON.parse(previousPacketBytes).files)assert.equal(sha(await readFile(new URL('reports/local-execution-comparison/'+entry.file,ROOT))),entry.sha256);
const archivedSourceBytes=await readFile(new URL('reports/local-execution-comparison-v1-source/source-inventory.json',ROOT));
assert.equal(JSON.parse(archivedSourceBytes).sourceSha256,'16cc789d64560349e88a694cc6104c1bda6f4bebe05c4ef8c683ae4276a38d61');
const revision={kind:'separate_corrected_comparator_report',previousResultsSha256:'bfc85b6ed1875d028b70e8d59968e645d0c1a2d8025f603cc837513ad2c916fb',previousPacketManifestSha256:sha(previousPacketBytes),archivedSourceInventorySha256:sha(archivedSourceBytes),corrections:['Bind original parent/block hashes and completed retained-state disposition.','Require native provider input and nonstatic call value; explicitly normalize omitted provider output and STATICCALL value only.','Validate supplied log positions and ordered sibling log ranges while permitting distinct index gaps.'],inputSelectionChanged:false,rawEvidenceChanged:false};
const binding=await sources();
const runnerSha256=sha(await readFile(new URL('run.mjs',DIR)));
if(mode==='--check'){console.log(json({status:'ready_offline',runnerSha256,engine:binding,captureSha256:sha(captureBytes),networkCalls:0}));process.exit(0);}
let prior;
if(mode==='--verify'){
  const manifest=JSON.parse(await readFile(new URL('manifest.json',DIR)));
  for(const entry of manifest.files)assert.equal(sha(await readFile(new URL(entry.file,DIR))),entry.sha256);
  prior=JSON.parse(await readFile(new URL('results.json',DIR)));assert.deepEqual(prior.provenance.engine,binding,'Engine/runtime changed since report binding; do not reexecute under a different profile.');assert.equal(prior.provenance.runnerSha256,runnerSha256);
}
// Only import engine modules after source/lock/version identity is established.
const {buildPrestateInputs}=await import(new URL('prestate-inputs.js',ENGINE));
const {createRecordedStateManager}=await import(new URL('recorded-state.js',ENGINE));
const {executeUnsignedCall}=await import(new URL('execute.js',ENGINE));
const {compareRecordedExecution}=await import(new URL('compare-recorded.js',ENGINE));
const USDC='0xb88339cb7199b77e23db6e890353e22632ba630f',IMPL='0x003f73f58ca78880da3642c5cb71d7459b3fe4f8';
function prestateOnly(provider){
  const rows=capture.records.filter(r=>r.provider===provider),pre=rows.find(r=>r.label==='full-prestate');
  const completions=rows.filter(r=>r.label.startsWith('missing-'));
  return {provider,inputRecordIds:[pre.request.id,...completions.map(r=>r.request.id)],headerRecordId:2,packet:{prestate:structuredClone(pre.response.result),completionReads:completions.map(r=>({address:r.request.params[0],field:r.label.slice(8).split(':')[0],request:structuredClone(r.request),result:structuredClone(r.response.result)})),envelope:structuredClone(capture.envelope),header:structuredClone(rows.find(r=>r.label==='header-before').response.result),pinned:structuredClone(capture.pinned),prestateRequest:structuredClone(pre.request)}};
}
const inputPackets=capture.providers.map(p=>prestateOnly(p.id));
async function executeThenCompare(source,mutate){
  const inputs=buildPrestateInputs(structuredClone(source.packet));mutate?.(inputs);
  const manager=await createRecordedStateManager({accounts:inputs.accounts});
  const execution=await executeUnsignedCall({request:inputs.request,block:inputs.block,stateManager:manager});
  const changes=manager.snapshotChanges(),reads=manager.snapshotReads();
  // Execution has completed. Only now retrieve provider output channels.
  const rows=capture.records.filter(r=>r.provider===source.provider),trace=rows.find(r=>r.label==='original-call-trace'),diff=rows.find(r=>r.label==='original-state-diff');
  const comparison=compareRecordedExecution({inputs,envelope:source.packet.envelope,localExecution:execution,localChanges:changes,providerTrace:trace.response.result,providerDiff:diff.response.result});
  return {provider:source.provider,inputRecordIds:source.inputRecordIds,inputPacketSha256:sha(json(source.packet)),normalizedInputsSha256:sha(json(inputs)),comparisonRecordIds:[trace.request.id,diff.request.id],profile:inputs.profile,unresolvedAccounts:inputs.unresolvedAccounts,localExecution:execution,localChanges:changes,localReads:reads,comparison};
}
const cases=[];for(const source of inputPackets)cases.push(await executeThenCompare(source));
const controls=[];
for(const control of [
  {id:'missing_required_slot',description:'Remove one originally captured touched proxy slot.',mutate:inputs=>delete inputs.accounts[USDC].storage[Object.keys(inputs.accounts[USDC].storage).sort()[0]],status:'unavailable',disposition:'rolled_back'},
  {id:'missing_implementation_account',description:'Remove the complete implementation account, so an actual execution read is unknown.',mutate:inputs=>delete inputs.accounts[IMPL],status:'unavailable',disposition:'rolled_back'},
  {id:'explicit_empty_implementation_code',description:'Replace explicit implementation bytes with empty code as deliberately changed input state, not missing data.',mutate:inputs=>inputs.accounts[IMPL].code='0x',status:'success',comparison:'diverged'},
  {id:'explicit_changed_owner_balance_slot',description:'Increase the captured1541542 raw-unit owner balance slot by one; keep the changed input, without output-based repair.',mutate:inputs=>{const slot=Object.keys(inputs.accounts[USDC].storage).find(s=>BigInt(inputs.accounts[USDC].storage[s])===1541542n);assert.ok(slot);inputs.accounts[USDC].storage[slot]='0x'+(1541543n).toString(16).padStart(64,'0');},status:'success',comparison:'diverged'},
]){
  const result=await executeThenCompare(inputPackets[0],control.mutate);assert.equal(result.localExecution.execution.status,control.status);if(control.disposition){assert.equal(result.localExecution.stateDisposition,control.disposition);assert.deepEqual(result.localChanges.accounts,[]);}if(control.comparison)assert.equal(result.comparison.status,control.comparison);
  controls.push({id:control.id,kind:'synthetic_input_mutation_control',description:control.description,result});
}
const missingCode=structuredClone(inputPackets[0].packet);missingCode.completionReads=missingCode.completionReads.filter(r=>r.address!==capture.envelope.from);let rejection;
try{buildPrestateInputs(missingCode);}catch(error){rejection=error.code;}
assert.equal(rejection,'LOCAL_INPUT_PACKET_INVALID');controls.push({id:'missing_sender_code_completion',kind:'synthetic_input_omission_control',description:'Omit the separately observed sender code field; conversion rejects before creating or executing a manager.',status:'unavailable',stage:'input_conversion',code:rejection,stateDisposition:'no_manager_created'});
await assert.doesNotReject(async()=>assert.deepEqual(await sources(),binding));
const report={schemaVersion:'1.1',revision,provenance:{captureSha256:sha(captureBytes),statePacketManifestSha256:sha(await readFile(new URL('reports/local-execution-state/packet-manifest.json',ROOT))),runnerSha256,engine:binding,executionOrder:'prestate_only_conversion_then_local_execution_then_provider_output_comparison',expectedOutputsUsedToConstructInputs:false},cases,controls,summary:{cases:cases.length,matched:cases.filter(c=>c.comparison.status==='matched').length,diverged:cases.filter(c=>c.comparison.status==='diverged').length,unavailable:cases.filter(c=>c.comparison.status==='unavailable').length,controls:controls.length,networkCalls:0},limits:['One preselected standard-EVM USDC transfer, executed twice from endpoint-supplied state; not a general coverage or security score.','State is sparse provider input, not a cryptographic proof or an independently reconstructed chain.','Zero-value unsigned synthetic BASEFEE-zero Cancun profile; no signed-envelope or fee-settlement validation.','Full entered-message tree and committed logs are compared; absent/provider-unsupported frame evidence remains unavailable.','Gas comparison is restricted to zero refund and input-derived intrinsic normalization.','Lock integrity and installed direct dependency versions are recorded; the complete installed dependency tree is not independently attested.']};
if(mode==='--verify'){
  assert.deepEqual(report,prior,'Reexecuted deterministic comparison differs from sealed report.');assert.deepEqual(JSON.parse(await readFile(new URL('input-packets.json',DIR))),inputPackets);
  console.log(json({status:'verified_offline_by_reexecution',resultsSha256:sha(await readFile(new URL('results.json',DIR))),summary:report.summary,engineSourceSha256:binding.sourceSha256,lockSha256:binding.lockSha256}));
}else{
  await writeFile(new URL('input-packets.json',DIR),json(inputPackets),{flag:'wx'});await writeFile(new URL('results.json',DIR),json(report),{flag:'wx'});
  const files=await Promise.all(['run.mjs','input-packets.json','results.json'].map(async file=>({file,sha256:sha(await readFile(new URL(file,DIR)))})));
  await writeFile(new URL('manifest.json',DIR),json({schemaVersion:'1.0',engineSourceSha256:binding.sourceSha256,lockSha256:binding.lockSha256,files}),{flag:'wx'});
  console.log(json({status:'written_offline',resultsSha256:sha(json(report)),summary:report.summary,engineSourceSha256:binding.sourceSha256,lockSha256:binding.lockSha256}));
}

