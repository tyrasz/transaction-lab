// Saved bytes only. No worker, execution API, EVM, RPC, or network is invoked.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,json,sha,walk,checkRows,nodeIdentity,verifyPacket,entry} from './archive.mjs';
import {PREFIX,LIMITS,SCOPE,ORDER,sourceRows,validatePreparation,validateReport,validateProcessRecord,validateWireDirectory} from './run.mjs';
import {compareLendingSequence,ORIGINAL_CHANNELS,QUERY_CHANNELS} from './observations.mjs';
const n=i=>String(i+1).padStart(3,'0');
const reason=e=>String(e?.message??e).slice(0,1024);
const counts=values=>({matched:values.filter(v=>v===true).length,mismatched:values.filter(v=>v===false).length,unavailable:values.filter(v=>v===null).length});
export function comparisonCounts(rows){
 const original=[],queries=[];for(const row of rows){assert.equal(row.steps.length,3);for(const step of row.steps){assert.deepEqual(Object.keys(step.original.channels).sort(),[...ORIGINAL_CHANNELS].sort());original.push(...Object.values(step.original.channels));for(const q of step.queries){assert.deepEqual(Object.keys(q.channels).sort(),[...QUERY_CHANNELS].sort());queries.push(...Object.values(q.channels));}}}
 assert(original.every(v=>[true,false,null].includes(v)));assert(queries.every(v=>[true,false,null].includes(v)));
 return{originalChannels:counts(original),queryChannels:counts(queries)};
}
export async function compareFixedCases(cases,records,usable){
 assert.equal(cases.length,2);const rows=[];for(let index=0;index<2;index++){
  const row=await compareLendingSequence({declaration:cases[index],localRecord:usable?records[index]?.local:null,providerRecord:usable?records[index]?.provider:null});
  assert.equal(row.id,cases[index].id);assert.equal(row.declaredPositions,3);assert.equal(row.steps.length,3);
  for(const[position,step]of row.steps.entries()){assert.equal(step.index,position);assert.equal(step.queries.length,cases[index].queryRoles.length);}
  const rederived=comparisonCounts([row]);assert.deepEqual(row.counts,rederived);rows.push(row);
 }
 const totals=comparisonCounts(rows);assert.equal(Object.values(totals.originalChannels).reduce((a,b)=>a+b),30);assert.equal(Object.values(totals.queryChannels).reduce((a,b)=>a+b),117);
 if(!usable){assert.equal(totals.originalChannels.unavailable,30);assert.equal(totals.queryChannels.unavailable,117);}
 return{rows,counts:totals,metrics:usable?totals:null};
}
export function validateSavedAttempt({capture,plan,index,kind,saved,expectedImplementation,request,normalized}){
 const result={index,kind,id:plan.inputs[index].id,status:saved.status,bounded:null,calls:null,networkBytes:null,report:null,workerFiles:[],error:null};
 assert.equal(saved.index,index);assert.equal(saved.kind,kind);assert.equal(saved.id,result.id);
 const relative=kind+'/'+n(index),directory=path.join(capture,relative),stem='processes/'+kind+'-'+n(index);
 if(saved.process===null){assert(['unavailable','not_attempted'].includes(saved.status));assert(!fs.existsSync(path.join(capture,stem+'-process.json')));assert(!fs.existsSync(directory)||walk(directory).length===0);result.bounded=saved.status==='not_attempted'?null:false;return result;}
 assert.equal(saved.process,stem+'-process.json');assert.equal(saved.seal,stem+'-seal.json');
 const record=json(path.join(capture,saved.process)),seal=json(path.join(capture,saved.seal));assert.equal(sha(read(path.join(capture,saved.process))),seal.processSha256);
 assert.deepEqual(seal.stdout,record.stdout);assert.deepEqual(seal.stderr,record.stderr);
 for(const k of['stdout','stderr']){assert.equal(record[k].path,stem+'.'+k);const bytes=read(path.join(capture,record[k].path));assert.equal(bytes.length,record[k].bytes);assert.equal(sha(bytes),record[k].sha256);}
 const stdout=read(path.join(capture,record.stdout.path)),stderr=read(path.join(capture,record.stderr.path));
 if(seal.workerSealed){
  assert.match(seal.workerManifestSha256,/^[a-f0-9]{64}$/);assert.equal(seal.workerManifestSha256,saved.workerManifestSha256);const summary=JSON.parse(stdout);assert.equal(summary.status,'captured');assert.equal(summary.manifestSha256,seal.workerManifestSha256);
  const manifest=verifyPacket(directory,seal.workerManifestSha256),ledger=json(path.join(directory,'write-ledger.json'));
  assert(ledger.files.every(r=>r.origin==='written'),'Worker directory was not initially empty');
  result.workerFiles=[...manifest.files,entry(directory,'manifest.json')].map(r=>({...r,path:relative+'/'+r.path}));
  assert(result.workerFiles.every(r=>{const p=r.path.slice(relative.length+1);return['request.json','report.json','write-ledger.json','manifest.json'].includes(p)||/^wire\/\d{4}\.json$/.test(p);}),'Unexpected worker artifact');
  const report=json(path.join(directory,'report.json'));result.report=report;
  assert.deepEqual(json(path.join(directory,'request.json')),{id:result.id,kind,inputSha256:plan.inputs[index].sha256,request,normalized});
  assert.deepEqual(report.implementation,expectedImplementation,'Worker loader identity differs from frozen current implementation');
  if(kind==='local'&&report.report)assert.deepEqual(report.report.implementation,expectedImplementation,'Nested local API source identity differs');
  try{validateProcessRecord(record,{plan,index,kind,outDir:path.join(plan.inputBase,relative),prepareOnly:false,stdout,stderr});validateWireDirectory(directory,report);
   const v=validateReport(report,{plan,index,kind,prepareOnly:false,pid:record.pid});Object.assign(result,v);
  }catch(e){Object.assign(result,{status:'unavailable',bounded:false,calls:null,networkBytes:null,error:reason(e)});}
 }else{result.workerFiles=fs.existsSync(directory)?walk(directory).map(p=>entry(capture,relative+'/'+p)):[];result.status='unavailable';result.bounded=false;result.error='Worker evidence did not seal';}
 const projected={status:result.status,bounded:result.bounded,calls:result.calls,networkBytes:result.networkBytes};
 assert.deepEqual(Object.fromEntries(Object.keys(projected).map(k=>[k,saved[k]])),projected,'Saved attempt classification differs from raw evidence');
 return result;
}
export async function adjudicateSavedCapture(capture,planPin,manifestPin){
 capture=path.resolve(capture);assert.match(planPin,/^[a-f0-9]{64}$/);assert.match(manifestPin,/^[a-f0-9]{64}$/);
 assert.equal(sha(read(path.join(capture,'plan.json'))),planPin);const manifest=verifyPacket(capture,manifestPin);assert.equal(manifest.planSha256,planPin);
 const archived=path.join(capture,'runtime',PREFIX,'adjudicate.mjs');assert.equal(sha(read(archived)),sha(read(fileURLToPath(import.meta.url))),'Audit source differs from pinned archived checker');
 // Working entrypoints delegate to the verified archived imports; process args
 // remain their original recorded paths even when evidence is relocated.
 if(fileURLToPath(import.meta.url)!==archived)return(await import(pathToFileURL(archived))).adjudicateSavedCapture(capture,planPin,manifestPin);
 const plan=json(path.join(capture,'plan.json')),results=json(path.join(capture,'results.json')),ledger=json(path.join(capture,'write-ledger.json')),runtime=path.join(capture,'runtime');
 assert.equal(results.planSha256,planPin);assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.scope,SCOPE);assert.deepEqual(results.scope,SCOPE);assert.equal(results.prepareOnly,false);
 assert.deepEqual(nodeIdentity(),plan.node);assert.deepEqual(walk(runtime),plan.files.map(r=>r.path));checkRows(runtime,plan.files);assert.deepEqual(await sourceRows(runtime),plan.files);
 const {loadLendingSequenceDeclarations}=await import(pathToFileURL(path.join(runtime,PREFIX,'declarations.mjs')));const declarations=await loadLendingSequenceDeclarations({root:runtime});
 assert.deepEqual(json(path.join(capture,'declarations.json')),declarations);assert.equal(plan.inputs.length,2);
 for(let i=0;i<2;i++){const p='inputs/'+n(i)+'.json',r=plan.inputs[i];assert.equal(r.path,p);assert.equal(r.id,declarations.cases[i].id);assert.deepEqual(entry(capture,p),Object.fromEntries(Object.entries(r).filter(([k])=>k!=='id')));assert.deepEqual(json(path.join(capture,p)),declarations.cases[i]);}
 const prepared=validatePreparation(path.join(capture,'preparation'),plan.preparationManifestSha256);assert.deepEqual(prepared.plan.files,plan.files);assert.deepEqual(prepared.plan.node,plan.node);assert.deepEqual(prepared.plan.inputs,plan.inputs);
 assert.deepEqual(json(path.join(capture,'preparation/declarations.json')),declarations);
 const started=json(path.join(capture,'STARTED.json'));assert.equal(started.planSha256,planPin);assert.equal(started.flag,'--execute-frozen-readonly');assert(Number.isSafeInteger(started.pid)&&started.pid>0);
 const localApi=await(await import(pathToFileURL(path.join(runtime,'src/local-loader.js')))).loadLocalApi(),providerApi=await(await import(pathToFileURL(path.join(runtime,'src/standard-loader.js')))).loadStandardApi();assert(localApi&&providerApi);
 assert.deepEqual(results.rows.map(r=>({kind:r.kind,index:r.index})),ORDER);const attempts=[],records=[{},{}],workerFiles=new Map();let knownCalls=0,knownBytes=0,unbounded=false,stopped=false;
 for(const{kind,index}of ORDER){const saved=results.rows[attempts.length];if(stopped)assert.equal(saved.status,'not_attempted','Dispatch after unproven bounds');
  const declaration=declarations.cases[index],api=kind==='local'?localApi:providerApi,request=kind==='local'?declaration.localInput:declaration.providerInput;
  const normalized=api[kind==='local'?'validateLocalSequence':'validateStandardSequence'](request);
  const a=validateSavedAttempt({capture,plan,index,kind,saved,expectedImplementation:api.implementation,request,normalized});
  for(const f of a.workerFiles)workerFiles.set(f.path,{...f,origin:'retained_unsealed_failure'});
  // The seal, rather than a bounded classification, establishes ledger origin.
  if(saved.process!==null){const seal=json(path.join(capture,saved.seal));for(const f of a.workerFiles)workerFiles.get(f.path).origin=seal.workerSealed?'worker_original_write_ledger':'retained_unsealed_failure';}
  if(a.bounded===true){knownCalls+=a.calls;knownBytes+=a.networkBytes;}else{unbounded=true;stopped=true;}
  records[index][kind]=a.report;attempts.push({...a,report:undefined,workerFiles:a.workerFiles.map(r=>r.path)});
 }
 const pre=new Set([...plan.files.map(r=>'runtime/'+r.path),...plan.inputs.map(r=>r.path),'declarations.json','plan.json',...walk(path.join(capture,'preparation')).map(p=>'preparation/'+p)]);
 const processFiles=attempts.filter((_,position)=>results.rows[position].process!==null).flatMap(a=>{const s='processes/'+a.kind+'-'+n(a.index);return[s+'.stdout',s+'.stderr',s+'-process.json',s+'-seal.json'];});
 const allowed=new Set([...pre,...workerFiles.keys(),...processFiles,'STARTED.json','results.json','write-ledger.json','manifest.json']);assert.deepEqual(walk(capture),[...allowed].sort(),'Unexpected capture membership');
 const expectedLedger=manifest.files.filter(r=>r.path!=='write-ledger.json').map(r=>({...r,origin:pre.has(r.path)?'preexisting':workerFiles.get(r.path)?.origin??'written'}));assert.deepEqual(ledger.files,expectedLedger);
 assert.equal(results.knownBoundedNetworkCalls,knownCalls);assert.equal(results.knownBoundedNetworkBytes,knownBytes);
 const elapsed=results.elapsed,timeValid=elapsed.reversed===false&&[elapsed.wallMs,elapsed.monotonicMs].every(n=>Number.isFinite(n)&&n>=0&&n<LIMITS.totalMs);
 const usable=!unbounded&&results.fatal===null&&results.sourceUnchanged===true&&timeValid&&knownCalls<=LIMITS.networkCalls&&knownBytes<=LIMITS.networkBytes;
 assert.equal(results.evidenceUsable,usable,'Claimed packet usability differs from raw bounds');
 assert.equal(results.networkCalls,results.fatal?null:knownCalls);assert.equal(results.networkBytes,results.fatal?null:knownBytes);
 const comparison=await compareFixedCases(declarations.cases,records,usable);
 // Recheck identities after interpretation, without changing any captured bytes.
 checkRows(runtime,plan.files);verifyPacket(capture,manifestPin);assert.deepEqual(nodeIdentity(),plan.node);
 return{kind:'saved_lending_sequence_API_comparison',planSha256:planPin,manifestSha256:manifestPin,sourceSha256:sha(Buffer.from(JSON.stringify(plan.files))),
  evidenceUsable:usable,declaredSequences:2,declaredPositions:6,declaredOriginalChannels:30,declaredQueryChannels:117,
  retainedAttempts:attempts,networkCalls:results.networkCalls,networkBytes:results.networkBytes,elapsed,rows:comparison.rows,counts:comparison.counts,metrics:comparison.metrics,
  integrity:{manifestFiles:manifest.files.length,runtimeFiles:plan.files.length,allOriginalWriteIdentitiesVerified:true,workerLoaderIdentitiesReconstructed:true,allLocalAttemptsBeforeProviderAttempts:true},
  limitations:['Direct current API adapter evidence, not HTTP or UI execution.','Two selected non-atomic unsigned sequences at saved block-end state, not representative coverage or signed historical replay.','Both sides use eth.drpc.org infrastructure; provider state/execution is not independently consensus authenticated.',
   'Local getters use 1M gas after all originals; provider getters use 300k gas between originals. Query comparison is observational only.','State comparison is observed cumulative net changes, not complete public-chain poststate roots.','Saved validators and query compiler are shared with the product; this checker does not execute another EVM.','Saved row order and frozen control flow establish local-before-provider sequencing without independently trusted timestamps.','Direct-worker closure and cleanup signalling do not independently attest OS process-tree extinction.'],targetsExecuted:0};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,5);console.log(JSON.stringify(await adjudicateSavedCapture(...process.argv.slice(2)),null,2));}
