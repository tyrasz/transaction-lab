// Independent saved-result audit. Never starts Geth, the local VM, or a network client.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HASH=/^[a-f0-9]{64}$/,ROOT=/^0x[a-f0-9]{64}$/;
const LIMITS={cases:48,perCaseMs:5000,closeGraceMs:1000,totalMs:360000,outputBytes:1048576};
const SCOPE={officialRootAndInternalLogHash:true,receiptGasReturnComparison:false,productAccuracy:false,publicRequests:0,retries:0,replacements:0,independentOpcodeImplementation:true,portableToolchainArchive:false};
const TOOL_SHA='791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333';
const COMMIT='1df30b18d9ed35ee9d28ffd4648442c2204554ad';
export const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(value,message)=>{if(!value)throw Object.assign(Error(message),{code:'GETH_AUDIT_INVALID'});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const stamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const text=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
function safeName(name){need(typeof name==='string'&&name.length>0&&name.length<1024&&!path.isAbsolute(name)&&!name.includes('\\')&&!name.includes('\0')&&path.posix.normalize(name)===name&&!name.split('/').some(p=>['','.','..'].includes(p)),'Unsafe artifact path');return name;}
function read(root,name){safeName(name);let here=root;for(const part of name.split('/')){here=path.join(here,part);const s=fs.lstatSync(here);need(!s.isSymbolicLink(),'Artifact link is unsupported');}const stat=fs.lstatSync(here);need(stat.isFile()&&stat.size<=16*1024*1024,'Artifact is not a bounded regular file');return fs.readFileSync(here);}
function names(root,sub=''){const rows=[];for(const entry of fs.readdirSync(path.join(root,sub),{withFileTypes:true})){const name=sub?sub+'/'+entry.name:entry.name;safeName(name);need(entry.isDirectory()||entry.isFile(),'Artifact symlink or special file');if(entry.isDirectory())rows.push(...names(root,name));else rows.push(name);need(rows.length<=10000,'Artifact inventory is too large');}return rows.sort();}
export function verifyArtifactInventory({capture,expectedManifestSha256,expectedPlanSha256}){
 need(typeof expectedManifestSha256==='string'&&HASH.test(expectedManifestSha256)&&typeof expectedPlanSha256==='string'&&HASH.test(expectedPlanSha256),'Both explicit external hashes are required');
 const directory=fs.realpathSync(capture),manifestBytes=read(directory,'manifest.json');need(sha(manifestBytes)===expectedManifestSha256,'External manifest hash differs');const manifest=JSON.parse(manifestBytes);
 need(object(manifest)&&manifest.planSha256===expectedPlanSha256&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=10000,'Manifest shape/plan differs');const byPath=new Map(),folded=new Set();let total=0;
 for(const row of manifest.files){safeName(row.path);need(row.path!=='manifest.json'&&!byPath.has(row.path)&&!folded.has(row.path.toLowerCase())&&integer(row.bytes)&&HASH.test(row.sha256),'Manifest entry differs');const b=read(directory,row.path);need(b.length===row.bytes&&sha(b)===row.sha256,'Artifact bytes differ: '+row.path);total+=b.length;need(total<=512*1024*1024,'Total evidence bound exceeded');byPath.set(row.path,row);folded.add(row.path.toLowerCase());}
 need(equal([...byPath.keys()].sort(),names(directory).filter(n=>n!=='manifest.json')),'Manifest membership differs');need(byPath.get('plan.json')?.sha256===expectedPlanSha256,'Plan is not independently hash-bound');
 const get=name=>{need(byPath.has(name),'Loaded artifact is absent from manifest: '+name);const b=read(directory,name),entry=byPath.get(name);need(b.length===entry.bytes&&sha(b)===entry.sha256,'Artifact changed during audit');return JSON.parse(b);};
 return{directory,manifest,byPath,get,total};
}
function stream(value,claimed,limit){
 need(object(value)&&typeof value.base64==='string'&&value.base64.length<=Math.ceil(limit/3)*4&&integer(value.bytes)&&value.bytes<=limit&&HASH.test(value.sha256),'Raw stream metadata invalid');
 const b=Buffer.from(value.base64,'base64');need(b.toString('base64')===value.base64&&b.length===value.bytes&&sha(b)===value.sha256,'Raw stream bytes/count/hash differ');let decoded=null,valid=true;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{valid=false;}need(decoded===claimed,'Decoded stream differs from strict UTF-8 bytes');return{bytes:b.length,valid};
}
// This parser does not import or call the producer's adjudicate function.
export function inspectSavedResult(raw,expected,{inputPath}={}){
 need(object(raw)&&typeof raw.processClosed==='boolean'&&finite(raw.durationMs)&&integer(raw.observedBytes),'Process completion/usage missing');
 need(raw.exitCode===null||Number.isSafeInteger(raw.exitCode),'Exit code invalid');need(raw.signal===null||(typeof raw.signal==='string'&&/^SIG[A-Z0-9]+$/.test(raw.signal)),'Signal invalid');
 need(raw.reason===null||['case_deadline','output_limit','spawn_failure','kill_failure','invalid_utf8'].includes(raw.reason),'Unknown process reason');
 const out=stream(raw.stdoutRaw,raw.stdout,LIMITS.outputBytes),err=stream(raw.stderrRaw,raw.stderr,LIMITS.outputBytes),retained=out.bytes+err.bytes;
 need(retained<=LIMITS.outputBytes&&raw.observedBytes>=retained,'Combined output count exceeds bound or undercounts');
 need(raw.observedBytes===retained||raw.observedBytes>LIMITS.outputBytes,'Discarded output is not explained by the combined byte cap');
 if(raw.observedBytes>LIMITS.outputBytes||!out.valid||!err.valid||raw.durationMs>LIMITS.perCaseMs)need(raw.reason!==null,'Bound/UTF-8 failure lacks a terminal reason');
 if(raw.reason==='invalid_utf8')need(!out.valid||!err.valid,'Invalid-UTF8 reason contradicts both streams');
 if(inputPath!==undefined){const pattern='^'+expected.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';need(equal(raw.args,['statetest','--statetest.fork=Osaka','--run='+pattern,inputPath]),'Executed argument vector differs');}
 if(raw.reason!==null||raw.exitCode!==0||raw.signal!==null||!raw.processClosed)return{status:'unavailable',reason:raw.reason??'process_failure'};
 let row;try{const all=JSON.parse(raw.stdout);need(Array.isArray(all)&&all.length===1,'Exactly one result required');row=all[0];need(object(row)&&Object.keys(row).every(k=>['name','fork','pass','stateRoot','error'].includes(k)),'Unexpected result keys');need(row.name===expected.id&&row.fork==='Osaka'&&typeof row.pass==='boolean','Result identity/fork/pass differs');if(row.error!==undefined)need(typeof row.error==='string'&&row.error.length>0&&!row.pass,'Error/pass contradiction');if(row.stateRoot!==undefined)need(typeof row.stateRoot==='string'&&ROOT.test(row.stateRoot),'State root invalid');if(row.pass)need(row.error===undefined&&typeof row.stateRoot==='string'&&ROOT.test(row.stateRoot),'Passing result lacks root or has error');}catch{return{status:'unavailable',reason:'invalid_or_foreign_result'};}
 if(row.stateRoot===undefined)return{status:'unavailable',reason:'fixture_execution_did_not_produce_state',result:row};
 return{status:row.pass&&row.stateRoot===expected.stateRoot?'matched':'mismatched',result:row,checks:{reportedPass:row.pass,stateRoot:row.stateRoot===expected.stateRoot,logHashCheckedByGeth:row.pass},scope:'Official full state root plus pinned Geth internal log-hash assertion; receipt/gas/return not checked.'};
}
export function verifyResultLedger({plan,started,results,caseRecords,entries,capture,hasFailure=false,hasIntegrityFailure=false}){
 need(equal(plan.limits,LIMITS)&&equal(plan.scope,SCOPE)&&Array.isArray(plan.cases)&&plan.cases.length===48,'Frozen policy differs');need(Array.isArray(results.rows)&&results.rows.length===48&&equal(results.scope,SCOPE),'Result row count/scope differs');
 need(stamp(plan.createdAt)&&Date.parse(started.startedAt)>=Date.parse(plan.createdAt)&&stamp(started.startedAt)&&stamp(results.finishedAt)&&Date.parse(results.finishedAt)>=Date.parse(started.startedAt)&&finite(results.durationMs)&&typeof results.unchanged==='boolean'&&typeof results.valid==='boolean','Result timing/integrity flags invalid');
 need(results.fatal===null||['child_close_unconfirmed','integrity_or_artifact_failure','final_integrity_failure'].includes(results.fatal),'Invalid fatal state');need(results.valid===(results.unchanged&&results.fatal===null),'Validity hides a fatal/integrity failure');
 if(!results.unchanged)need(hasIntegrityFailure&&results.fatal!==null,'Unchanged failure lacks evidence');if(results.fatal==='integrity_or_artifact_failure')need(hasFailure,'Artifact failure lacks evidence');if(results.fatal==='final_integrity_failure')need(!results.unchanged&&hasIntegrityFailure,'Final integrity failure lacks its changed-source evidence');
 const counts={selected:48,matched:0,mismatched:0,unavailable:0,not_attempted:0},recomputed=[];let stopped=null,attempted=0,bytes=0;
 for(let i=0;i<48;i++){
  const c=plan.cases[i],summary=results.rows[i],name='results/'+String(i+1).padStart(3,'0')+'.json',saved=caseRecords.get(name);
  need(c.index===i+1&&summary.index===c.index&&summary.id===c.id,'Ordered case identity differs');need(Object.hasOwn(counts,summary.status)&&summary.status!=='selected','Unknown result status');
  if(summary.status==='not_attempted'){need(!saved&&!entries.has(name)&&['overall_deadline','child_close_unconfirmed','integrity_or_artifact_failure'].includes(summary.reason),'Unattempted case has output or invalid reason');need(!stopped||stopped===summary.reason,'Failure tail reason changes');stopped??=summary.reason;need(equal(summary,{index:c.index,id:c.id,status:'not_attempted',reason:summary.reason}),'Unattempted summary contains extra result claims');}
  else if(saved){need(!stopped,'Execution resumes after an unattempted/closed tail');need(equal(saved.case,c),'Per-case fixture expectation differs');const observed=inspectSavedResult(saved.raw,c,{inputPath:path.join(capture,c.path)});need(equal(saved.observed,observed),'Saved adjudication differs from independent raw output');need(equal(summary,{index:c.index,id:c.id,...observed,evidenceSha256:entries.get(name)?.sha256}),'Summary differs from exact evidence');bytes+=saved.raw.observedBytes;attempted++;recomputed.push({index:c.index,id:c.id,...observed});if(!saved.raw.processClosed){need(results.fatal==='child_close_unconfirmed','Unclosed child is not fatal');stopped='child_close_unconfirmed';}}
  else{need(summary.status==='unavailable'&&summary.reason==='integrity_or_artifact_failure'&&hasFailure&&results.fatal==='integrity_or_artifact_failure','Attempted row lacks exact evidence');need(equal(summary,{index:c.index,id:c.id,status:'unavailable',reason:'integrity_or_artifact_failure'}),'Failed summary contains unsupported claims');stopped='integrity_or_artifact_failure';}
  counts[summary.status]++;
 }
 need(equal(results.counts,counts),'Counts differ from all 48 ordered cases');need(caseRecords.size===attempted,'Extra or unbound case result');if(results.fatal==='child_close_unconfirmed')need(stopped==='child_close_unconfirmed','Claimed unclosed child has no retained record');
 return{counts,attempted,observedOutputBytes:bytes,recomputed,valid:results.valid,allCasesMatched:results.valid&&counts.matched===48};
}
export async function verifyGethCapture({capture,expectedManifestSha256,expectedPlanSha256}){
 const packet=verifyArtifactInventory({capture,expectedManifestSha256,expectedPlanSha256}),plan=packet.get('plan.json'),started=packet.get('STARTED.json'),results=packet.get('results.json');
 need(started.planSha256===expectedPlanSha256&&results.planSha256===expectedPlanSha256&&packet.get('FROZEN.json').planSha256===expectedPlanSha256,'Frozen/start/result plan bindings differ');
 need(plan.sourceCommit===COMMIT&&plan.toolchainManifestSha256===TOOL_SHA&&packet.byPath.get('toolchain-manifest.json')?.sha256===TOOL_SHA,'Pinned tool provenance differs');
 const required=['runtime/research/cross-client-geth-v1/run.mjs','runtime/research/cross-client-geth-v1/run.test.mjs','runtime/research/cross-client-geth-v1/PLAN.md','runtime/research/standard-evm/cohort-freeze.mjs'];
 need(Array.isArray(plan.sources)&&equal(plan.sources.map(x=>x.path).sort(),required.sort())&&Array.isArray(plan.inputs),'Frozen source closure differs');
 for(const entry of [...plan.sources,...plan.inputs])need(equal(packet.byPath.get(entry.path),entry),'Frozen source/input entry is not manifest-bound');
 // Reuse only frozen input/tool/Node verification. No producer result adjudication.
 const producer=await import(pathToFileURL(path.join(packet.directory,'runtime/research/cross-client-geth-v1/run.mjs')));
 const bound=await producer.verify(packet.directory,expectedPlanSha256);need(equal(bound.plan,plan),'Frozen input verifier returned different plan');
 const records=new Map();for(const name of packet.byPath.keys())if(name.startsWith('results/')){need(/^results\/0[0-4][0-9]\.json$/.test(name),'Unexpected result path');records.set(name,packet.get(name));}
 const audit=verifyResultLedger({plan,started,results,caseRecords:records,entries:packet.byPath,capture:packet.directory,hasFailure:packet.byPath.has('FAILURE.json'),hasIntegrityFailure:packet.byPath.has('INTEGRITY-FAILURE.json')});
 const allowed=new Set([...plan.sources,...plan.inputs].map(r=>r.path).concat(['plan.json','FROZEN.json','STARTED.json','results.json',...records.keys(),...(packet.byPath.has('FAILURE.json')?['FAILURE.json']:[]),...(packet.byPath.has('INTEGRITY-FAILURE.json')?['INTEGRITY-FAILURE.json']:[])]));need(equal([...allowed].sort(),[...packet.byPath.keys()].sort()),'Unexplained captured file');
 verifyArtifactInventory({capture:packet.directory,expectedManifestSha256,expectedPlanSha256});
 return{schemaVersion:'1.0',status:'verified',expectedManifestSha256,expectedPlanSha256,evidenceFiles:packet.byPath.size,evidenceBytes:packet.total,runnerSha256:packet.byPath.get(required.find(n=>n.endsWith('/run.mjs'))).sha256,
 tool:{commit:plan.sourceCommit,binarySha256:plan.binary.sha256,toolchainManifestSha256:plan.toolchainManifestSha256},...audit,
 scope:{...SCOPE,rawResultAdjudication:'independently_recomputed',frozenInputVerification:'reused_archived_verifier',newGethExecution:false,newLocalExecution:false,externalLogHashRecomputed:false,fullPoststateRootReportedAndOfficialExpectedCompared:true,currentLocalCoverageRate:false,toolchainPortable:false}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const[capture,planHash,manifestHash]=process.argv.slice(2);console.log(JSON.stringify(await verifyGethCapture({capture,expectedPlanSha256:planHash,expectedManifestSha256:manifestHash}),null,2));}
