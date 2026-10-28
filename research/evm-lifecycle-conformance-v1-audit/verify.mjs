// Post-seal audit helper; not part of the original run or result manifest.
import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';
const audit=path.dirname(fileURLToPath(import.meta.url)),base=path.resolve(audit,'../evm-lifecycle-conformance-v1'),hash=b=>createHash('sha256').update(b).digest('hex');
const PLAN='0e8cfe9f56e75f090ea2468fb19348914d3ba438fb9bceeec33be016b9e412b5',MANIFEST='de6a85b5734c2e985c51dac592e0d80a199223107b3d65ee58cd29338e993942';
export function validateManifest(manifest){assert.equal(manifest.planSha256,PLAN);assert.deepEqual(manifest.files.map(r=>r.path).sort(),['STARTED.json','results.json',...Array.from({length:16},(_,i)=>'results/'+String(i+1).padStart(3,'0')+'.json')].sort());}
export function validateCapturedRow(row,captured,fixture){
 assert.equal(captured.index,row.index);assert.equal(captured.id,row.id);assert.equal(captured.family,row.family);
 assert.equal(captured.status,'completed');assert.equal(captured.exitCode,0);assert.equal(captured.signal,null);assert.equal(captured.reason,null);assert.deepEqual(JSON.parse(captured.stdout),captured.result);
 const result=captured.result.result,o=result.observed,p=fixture.post.Osaka[row.postIndex];
 assert.equal(o.serializedTransaction,p.txbytes.toLowerCase());assert.equal(o.sender,fixture.transaction.sender.toLowerCase());assert.equal(o.stateRoot,p.hash.toLowerCase());assert.equal(o.logsHash,p.logs.toLowerCase());assert.deepEqual(o.logs,p.receipt.logs);assert.equal(o.receiptStatus,p.receipt.status);assert.equal(o.execution==='success',p.receipt.status);assert.equal(o.gasUsed,BigInt(p.receipt.cumulativeGasUsed).toString());assert.equal(o.transactionHash,p.receipt.transactionHash.toLowerCase());assert.equal(o.receiptBloom,p.receipt.bloom.toLowerCase());assert.equal(o.admission,'accepted');assert.equal(p.expectException,undefined);assert.equal(result.comparison.status,'matched');assert.deepEqual(Object.keys(result.comparison.checks).sort(),['admission','stateRoot','logsHash','receiptStatus','gasUsed','transactionHash','receiptBloom'].sort());assert(Object.values(result.comparison.checks).every(x=>x===true));return result;
}
export async function verify({replay=false}={}){
 const rawPlan=fs.readFileSync(path.join(base,'frozen-plan.json'));assert.equal(hash(rawPlan),PLAN);const plan=JSON.parse(rawPlan);
 const rawManifest=fs.readFileSync(path.join(base,'results-manifest.json'));assert.equal(hash(rawManifest),MANIFEST);const manifest=JSON.parse(rawManifest);assert.equal(manifest.planSha256,PLAN);
 validateManifest(manifest);
 for(const r of manifest.files){const bytes=fs.readFileSync(path.join(base,r.path));assert.equal(bytes.length,r.bytes);assert.equal(hash(bytes),r.sha256);}
 const runBytes=fs.readFileSync(path.join(base,'run.mjs'));assert.equal(hash(runBytes),plan.sourceFiles.find(r=>r.path==='harness/run.mjs').sha256);
 const {verifyFrozen,dispatchVector}=await import('../evm-lifecycle-conformance-v1/run.mjs');const checked=verifyFrozen();assert.equal(checked.planSha256,PLAN);
 const started=JSON.parse(fs.readFileSync(path.join(base,'STARTED.json'))),results=JSON.parse(fs.readFileSync(path.join(base,'results.json')));assert.equal(started.planSha256,PLAN);assert.equal(started.selectionSha256,plan.selectionSha256);assert.equal(started.vectorCount,16);assert.equal(results.sourceUnchanged,true);assert.equal(results.productAccuracyClaim,false);assert.equal(results.validForDependencyConformance,true);assert.equal(results.planSha256,PLAN);assert.equal(results.selectionSha256,plan.selectionSha256);assert.equal(results.rows.length,16);
 assert.deepEqual(results.rows.map(r=>r.index),Array.from({length:16},(_,i)=>i+1));const counts={selected:16,matched:0,mismatched:0,unavailable:0,not_attempted:0},families={},types={},executions={},replayed=[];let logCount=0;const start=performance.now();
 for(const row of checked.selection.selected){
  const captured=JSON.parse(fs.readFileSync(path.join(base,'results',String(row.index).padStart(3,'0')+'.json'))),raw=fs.readFileSync(path.join(base,'source/fixtures',row.file));assert.equal(hash(raw),row.fileSha256);const fixture=JSON.parse(raw)[row.id];const result=validateCapturedRow(row,captured,fixture);
  assert.deepEqual(results.rows[row.index-1],{index:row.index,id:row.id,family:row.family,status:captured.status,reason:captured.reason,comparison:result.comparison});counts.matched++;families[row.family]=(families[row.family]??0)+1;
  const lead=Number.parseInt(result.observed.serializedTransaction.slice(2,4),16),type=lead>=0xc0?'legacy':String(lead);types[type]=(types[type]??0)+1;executions[result.observed.execution]=(executions[result.observed.execution]??0)+1;logCount+=result.observed.logs.length;
  if(replay){const remaining=360000-(performance.now()-start);assert(remaining>0);const actual=await dispatchVector({row,timeoutMs:Math.min(10000,remaining)});assert.equal(actual.status,captured.status);assert.deepEqual(actual.result,captured.result,'Archived reexecution differs at vector '+row.index);assert.equal(actual.stdout,captured.stdout);assert.equal(actual.stderr,captured.stderr);assert.equal(actual.exitCode,captured.exitCode);assert.equal(actual.signal,captured.signal);replayed.push(row.index);}
 }
 assert.deepEqual(counts,results.counts);verifyFrozen();return{schemaVersion:1,verifiedAt:new Date().toISOString(),originalPlanSha256:PLAN,originalResultsManifestSha256:MANIFEST,sourceFiles:plan.sourceFiles.length,counts,families,transactionTypes:types,topLevelExecutions:executions,committedLogs:logCount,archivedVectorsReexecuted:replayed,normalizations:['Child host elapsedMs only; all VM outputs/observed state and comparison fields are exact.'],limitations:['This fixed selected dependency-conformance slice is not a product or all-EVM accuracy rate.','This packet includes two root constructor reverts and two nonempty log cases; it does not exercise the sparse product finalizer.','No header consensus, signed block processing, blob/KZG sidecars or future-fork coverage is established.']};
}

function auditSeal(){const manifest=JSON.parse(fs.readFileSync(path.join(audit,'manifest.json')));assert.equal(manifest.originalPlanSha256,PLAN);assert.equal(manifest.originalResultsManifestSha256,MANIFEST);assert.deepEqual(manifest.files.map(r=>r.path).sort(),['NOTES.md','verification.json','verify.mjs','verify.test.mjs']);for(const row of manifest.files){const raw=fs.readFileSync(path.join(audit,row.path));assert.equal(raw.length,row.bytes);assert.equal(hash(raw),row.sha256);}return manifest;}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--record')){
  assert(!fs.existsSync(path.join(audit,'manifest.json')));const report=await verify({replay:true});
  fs.writeFileSync(path.join(audit,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const files=['NOTES.md','verification.json','verify.mjs','verify.test.mjs'].map(file=>{const raw=fs.readFileSync(path.join(audit,file));return{path:file,bytes:raw.length,sha256:hash(raw)};});
  fs.writeFileSync(path.join(audit,'manifest.json'),JSON.stringify({schemaVersion:1,originalPlanSha256:PLAN,originalResultsManifestSha256:MANIFEST,files},null,2)+'\n',{flag:'wx'});
  auditSeal();console.log(JSON.stringify({counts:report.counts,replayed:report.archivedVectorsReexecuted.length,auditManifestSha256:hash(fs.readFileSync(path.join(audit,'manifest.json')))}));
 }else{
  auditSeal();const report=await verify({replay:process.argv.includes('--replay')});const saved=JSON.parse(fs.readFileSync(path.join(audit,'verification.json')));
  for(const field of ['counts','families','transactionTypes','topLevelExecutions','committedLogs'])assert.deepEqual(report[field],saved[field]);
  console.log(JSON.stringify(report,null,2));
 }
}
