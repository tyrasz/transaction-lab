// Fixed synthetic16 lifecycle corpus. No target executes before explicit frozen-plan dispatch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { dispatch as boundedDispatch, adjudicate as gethAdjudicate } from '../cross-client-geth-v1/run.mjs';
import { CORPUS, SCOPE as ADAPTER_SCOPE } from './adapter.mjs';
import { archiveSources, verifyArchive, verifyTool, verifyNodeRuntime, read, write, identity, seal, sha, need, COMMIT, TOOLCHAIN_SHA, SEMANTICS, RELEASED_DISPATCH_SHA } from './archive.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../..'),RELATIVE='research/cross-client-synthetic-geth-v1';
export const LIMITS=Object.freeze({cases:16,perCaseMs:5000,closeGraceMs:1000,totalMs:360000,outputBytes:1048576});
export const SCOPE=Object.freeze({...ADAPTER_SCOPE,publicRequests:0,retries:0,replacements:0,portableToolchainArchive:false,archivedRuntimeSelfContainedExceptExactBinaryAndNode:true,processMemory:'GOMEMLIMIT256MiB_soft_not_hard_RSS',expectedPostAssertionsOnly:true});
const load=(root,p)=>JSON.parse(read(root,p));
const patternCase=(row,index)=>({index:index+1,id:row.id,category:row.category,path:`cases/${String(index+1).padStart(3,'0')}.json`,expected:row.expected,compatibility:row.compatibility,originalArtifacts:row.originalArtifacts});
export function adjudicateSynthetic(raw,c){
 if(raw.processClosed!==true)return{status:'unavailable',reason:raw.reason??'process_failure'};
 const observed=gethAdjudicate(raw,{id:c.id,stateRoot:c.expected.stateRoot});
 if(observed.scope)observed.scope='Synthetic sealed-reference full state root plus Geth internal log-hash assertion; gas/return/receipt and current-product coverage not checked.';
 return observed;
}
export async function freeze(capture,toolchainManifest){
 const toolBytes=fs.readFileSync(toolchainManifest),tool=verifyTool(toolBytes),archived=await archiveSources({repoRoot:ROOT,capture});capture=archived.capture;
 write(capture,'toolchain-manifest.json',toolBytes);const semantics=[];
 for(const p of SEMANTICS){const source=path.join(path.dirname(toolchainManifest),'source'),bound=tool.source.interpretationSources.find(r=>r.path==='source/'+p);need(bound&&equal(identity(source,p),{bytes:bound.bytes,sha256:bound.sha256}),'Pinned interpretation source differs');const saved=write(capture,'geth-semantics/'+p,read(source,p));semantics.push({path:'geth-semantics/'+p,...saved});}
 const adapter=await import(pathToFileURL(path.join(capture,'runtime',RELATIVE,'adapter.mjs'))),corpus=await adapter.loadSealedCorpus(path.join(capture,'runtime'));need(corpus.count===16,'Fixed corpus count differs');const cases=[];
 for(const [i,row]of corpus.rows.entries()){need(row.index===i+1,'Fixed corpus order differs');const c=patternCase(row,i),saved=write(capture,c.path,row.wrapper);cases.push({...c,...saved});}
 const plan={schemaVersion:1,createdAt:new Date().toISOString(),limits:LIMITS,scope:SCOPE,sourceManifestSha256:archived.sourceManifestSha256,node:archived.manifest.node,
  toolchainManifestSha256:TOOLCHAIN_SHA,binary:tool.binary,sourceCommit:COMMIT,releasedDispatcherSha256:RELEASED_DISPATCH_SHA,semantics,originalCorpus:CORPUS,cases};
 const saved=write(capture,'plan.json',plan);write(capture,'FROZEN.json',{planSha256:saved.sha256,sourceManifestSha256:archived.sourceManifestSha256,publicRequests:0,targetExecutions:0});await verifyInputs(capture,saved.sha256);return{capture,planSha256:saved.sha256,sourceManifestSha256:archived.sourceManifestSha256,cases:16,targetExecutions:0};
}
export async function verifyInputs(capture,expectedPlanSha256){
 need(typeof expectedPlanSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedPlanSha256),'Explicit external plan hash required');capture=fs.realpathSync(capture);const bytes=read(capture,'plan.json');need(sha(bytes)===expectedPlanSha256,'Plan differs');const plan=JSON.parse(bytes);
 need(plan.schemaVersion===1&&equal(plan.limits,LIMITS)&&equal(plan.scope,SCOPE)&&equal(plan.originalCorpus,CORPUS)&&plan.sourceCommit===COMMIT&&plan.releasedDispatcherSha256===RELEASED_DISPATCH_SHA,'Frozen policy/corpus differs');need(Array.isArray(plan.cases)&&plan.cases.length===16&&new Set(plan.cases.map(c=>c.id)).size===16,'Sixteen unique fixed cases required');
 const source=await verifyArchive({capture,expectedSourceSha256:plan.sourceManifestSha256});need(equal(plan.node,source.node),'Node identity differs');
 for(const p of ['archive.mjs','run.mjs','run.test.mjs','adapter.mjs','adapter.test.mjs','PLAN.md'])need(source.files.some(r=>r.path===RELATIVE+'/'+p&&r.kind==='file'),'Required frozen harness source absent');
 const toolBytes=read(capture,'toolchain-manifest.json'),tool=verifyTool(toolBytes);need(plan.toolchainManifestSha256===TOOLCHAIN_SHA&&equal(plan.binary,tool.binary),'Exact tool differs');need(Array.isArray(plan.semantics)&&plan.semantics.length===SEMANTICS.length,'Interpretation inventory differs');
 for(const [i,p]of SEMANTICS.entries()){const bound=tool.source.interpretationSources.find(r=>r.path==='source/'+p),expected={path:'geth-semantics/'+p,bytes:bound.bytes,sha256:bound.sha256};need(equal(plan.semantics[i],expected)&&equal(identity(capture,expected.path),{bytes:expected.bytes,sha256:expected.sha256}),'Interpretation source differs');}
 need(equal(load(capture,'FROZEN.json'),{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,publicRequests:0,targetExecutions:0}),'Frozen declaration differs');
 const adapter=await import(pathToFileURL(path.join(capture,'runtime',RELATIVE,'adapter.mjs'))),corpus=await adapter.loadSealedCorpus(path.join(capture,'runtime'));need(corpus.count===16,'Archived corpus count differs');
 for(const [i,row]of corpus.rows.entries()){need(row.index===i+1,'Archived corpus order differs');const expected=patternCase(row,i),body=Buffer.from(JSON.stringify(row.wrapper,null,2)+'\n');need(equal(plan.cases[i],{...expected,bytes:body.length,sha256:sha(body)}),'Recomputed wrapper/provenance differs');need(read(capture,expected.path).equals(body),'Exact recomputed wrapper bytes differ');}
 return{capture,plan,planSha256:expectedPlanSha256,sourceFiles:source.filesCount,originalArtifacts:101};
}
// Separable only for unrelated synthetic process/artifact controls. Production
// run supplies the exact released dispatcher and bound binary/wrapper checks.
export async function executeFixedCases({plan,capture,save,checkCase,dispatch=boundedDispatch,now=()=>performance.now()}){
 need(plan&&Array.isArray(plan.cases)&&plan.cases.length===16&&new Set(plan.cases.map(c=>c.id)).size===16&&plan.cases.every((c,i)=>c.index===i+1&&c.path===`cases/${String(i+1).padStart(3,'0')}.json`),'Fixed sixteen-case order required before dispatch');
 const began=now(),rows=[];let fatal=null;
 for(const c of plan.cases){const remaining=LIMITS.totalMs-(now()-began);if(fatal||remaining<=0){rows.push({index:c.index,id:c.id,status:'not_attempted',reason:fatal??'overall_deadline'});continue;}
  try{await checkCase(c);const left=LIMITS.totalMs-(now()-began);if(left<=0){rows.push({index:c.index,id:c.id,status:'not_attempted',reason:'overall_deadline'});continue;}
   const raw=await dispatch({binary:plan.binary.path,input:path.join(capture,c.path),id:c.id,timeoutMs:Math.min(left,LIMITS.perCaseMs),closeGraceMs:LIMITS.closeGraceMs});const observed=adjudicateSynthetic(raw,c),saved=save(`results/${String(c.index).padStart(3,'0')}.json`,{case:c,raw,observed});rows.push({index:c.index,id:c.id,...observed,evidenceSha256:saved.sha256});if(raw.processClosed!==true)fatal='child_close_unconfirmed';
  }catch(error){fatal='integrity_or_artifact_failure';rows.push({index:c.index,id:c.id,status:'unavailable',reason:fatal});save('FAILURE.json',{index:c.index,name:typeof error?.name==='string'?error.name:'Error',message:'Case integrity or durable artifact save failed'});}
 }
 need(rows.length===16,'All sixteen slots must remain');return{rows,fatal,durationMs:now()-began};
}
export async function run(capture,expectedPlanSha256){
 capture=fs.realpathSync(capture);need(fs.realpathSync(HERE)===path.join(capture,'runtime',RELATIVE),'Use exact frozen entrypoint');const{plan}=await verifyInputs(capture,expectedPlanSha256);
 write(capture,'STARTED.json',{planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,startedAt:new Date().toISOString()});
 const began=performance.now(),executed=await executeFixedCases({plan,capture,save:(p,v)=>write(capture,p,v),checkCase:async c=>{verifyTool(read(capture,'toolchain-manifest.json'));need(equal(identity(capture,c.path),{bytes:c.bytes,sha256:c.sha256}),'Wrapper changed before dispatch');}});
 let unchanged=false,fatal=executed.fatal;try{await verifyInputs(capture,expectedPlanSha256);await verifyNodeRuntime(plan.node);unchanged=true;}catch(error){fatal??='final_integrity_failure';write(capture,'INTEGRITY-FAILURE.json',{name:typeof error?.name==='string'?error.name:'Error',message:'Final source/input/tool/runtime integrity check failed'});}
 const counts={selected:16,matched:0,mismatched:0,unavailable:0,not_attempted:0};for(const row of executed.rows)counts[row.status]++;
 const results={planSha256:expectedPlanSha256,sourceManifestSha256:plan.sourceManifestSha256,finishedAt:new Date().toISOString(),durationMs:performance.now()-began,dispatchWindowMs:executed.durationMs,rows:executed.rows,counts,unchanged,fatal,valid:unchanged&&fatal===null,scope:plan.scope};write(capture,'results.json',results);return{counts,unchanged,fatal,...seal(capture,expectedPlanSha256)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const archived=HERE.endsWith(path.join('runtime',RELATIVE)),capture=archived?path.resolve(HERE,'../../..'):path.join(HERE,'capture');if(process.argv[2]==='--freeze'&&process.argv[3]&&!archived)console.log(JSON.stringify(await freeze(capture,path.resolve(process.argv[3]))));
 else if(process.argv[2]==='--check'){const checked=await verifyInputs(capture,process.argv[3]);console.log(JSON.stringify({status:'verified',planSha256:checked.planSha256,sourceFiles:checked.sourceFiles,cases:16,targetExecutions:0}));}
 else if(process.argv[2]==='--run'){await verifyInputs(capture,process.argv[3]);const archived=await import(pathToFileURL(path.join(capture,'runtime',RELATIVE,'run.mjs')));console.log(JSON.stringify(await archived.run(capture,process.argv[3])));}
 else throw Error('Use --freeze TOOL_MANIFEST, --check PLAN_SHA, or --run PLAN_SHA; dispatch requires prior review/authorization.');
}
