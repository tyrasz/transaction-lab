import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {performance} from 'node:perf_hooks';import {fileURLToPath,pathToFileURL} from 'node:url';
import {PREFIX,sha,json,save,walk,entry,freezeSources,checkSources,BINARY_SHA} from './archive.mjs';
import {IDS,PRODUCT_LIMITS} from './cases.mjs';
import {gethObservation,compareObservations} from './observations.mjs';
export const LIMITS=Object.freeze({totalMs:240000,processMs:15000,processBytes:2097152,outputFileBytes:4194304,outputFiles:8,totalOutputBytes:50331648,cases:6,productProcesses:6,isolatedChildProcesses:6,ethereumJsProcesses:6,gethProcesses:6});
export const SCOPE=Object.freeze({purpose:'storage_creation_client_semantics_diagnostic',selectedSyntheticCases:true,populationCoverage:false,canonicalWinnerSelected:false,publicApiTested:false,publicRpc:false,
 product:'owned_isolated_unsigned_priced_call',ethereumjs:'signed_type2_shared_dependency_full_VM',geth:'independent_pinned_signed_type2_transition_tool',eels:'source_only_no_runner_executed',
 allInputsPredeclared:true,productBeforeOtherClients:true,expectedPoststateConsumed:false,sameAmendedInitialAllocation:true,systemScaffolding:'four_inert_STOP_accounts_geth_postblock_only',
 separateGethGasDimensionsExposed:false,productUnavailableRemainsNull:true});
const decode=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
export const validTime=(wall,mono,bound)=>[wall,mono].every(n=>Number.isFinite(n)&&n>=0&&n<=bound);
export function rawBytes(s){const b=Buffer.from(s.base64,'base64');assert.equal(b.toString('base64'),s.base64);assert.equal(b.length,s.bytes);assert.equal(sha(b),s.sha256);return b;}
export function validProcessBounds(raw){const p=raw.process;return Number.isSafeInteger(p.timeoutMs)&&p.timeoutMs>0&&p.timeoutMs<=LIMITS.processMs&&validTime(p.wallElapsedMs,p.elapsedMs,p.timeoutMs)&&p.error?.code!=='ENOBUFS'&&[raw.stdout.bytes,raw.stderr.bytes].every(n=>Number.isSafeInteger(n)&&n>=0)&&raw.stdout.bytes+raw.stderr.bytes<=LIMITS.processBytes;}
export const validProcess=raw=>validProcessBounds(raw)&&raw.process.status===0&&raw.process.signal===null&&raw.process.error===null;
export function observation(raw){assert(validProcess(raw));new TextDecoder('utf-8',{fatal:true}).decode(rawBytes(raw.stderr));return decode(rawBytes(raw.stdout));}
export class OutputBoundsError extends Error{constructor(files,totalBytes){super('Output kind, count or byte bound exceeded');this.files=files;this.totalBytes=totalBytes;}}
export function scanOutput(dir,currentBytes){const files=fs.readdirSync(dir).sort().map(name=>{const s=fs.lstatSync(path.join(dir,name));return{path:name,kind:s.isFile()?'file':s.isSymbolicLink()?'symlink':'other',bytes:s.size,mode:s.mode&511};}),totalBytes=files.reduce((n,f)=>n+f.bytes,currentBytes);
 if(files.length>LIMITS.outputFiles||files.some(f=>f.kind!=='file'||f.bytes>LIMITS.outputFileBytes)||!Number.isSafeInteger(totalBytes)||totalBytes>LIMITS.totalOutputBytes)throw new OutputBoundsError(files,totalBytes);return{files,totalBytes};}
export function readSealed(capture,p){const b=fs.readFileSync(path.join(capture,p)),s=json(path.join(capture,p+'.seal.json'));assert.equal(b.length,s.bytes);assert.equal(sha(b),s.sha256);return decode(b);}
export const exactInventory=(root,paths)=>assert.deepEqual(walk(root),[...paths].sort());
export async function freeze(root,capture){const source=freezeSources(root,capture),module=await import(pathToFileURL(path.join(capture,'runtime',PREFIX,'cases.mjs')).href),declarations=[];
 assert.deepEqual(module.IDS,IDS);for(let i=0;i<6;i++){const input=await module.declaration(i),prefix='inputs/'+String(i+1).padStart(3,'0'),files={};
  for(const[key,suffix,value]of[['declaration','.json',input],['alloc','-alloc.json',input.allocation],['env','-env.json',input.environment],['txs','-txs.rlp',input.transactionBody]]){const p=prefix+suffix;files[key]={path:p,...save(path.join(capture,p),value)};}declarations.push({id:input.id,files});}
 checkSources(capture,source.identity.sha256);const plan={schemaVersion:1,at:new Date().toISOString(),sourceManifestSha256:source.identity.sha256,declarations,limits:LIMITS,productLimits:PRODUCT_LIMITS,scope:SCOPE,fork:'Amsterdam',chainId:11155111,rewards:-1,withdrawals:[]};
 return{planSha256:save(path.join(capture,'plan.json'),plan).sha256,sourceSha256:source.identity.sha256,cases:6,sourceFiles:source.manifest.files.length};}
export function checkPlan(capture,pin){assert.match(pin,/^[a-f0-9]{64}$/);const b=fs.readFileSync(path.join(capture,'plan.json'));assert.equal(sha(b),pin);const plan=decode(b);assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.productLimits,PRODUCT_LIMITS);assert.deepEqual(plan.scope,SCOPE);assert.deepEqual(plan.declarations.map(d=>d.id),IDS);
 assert.equal(plan.fork,'Amsterdam');assert.equal(plan.chainId,11155111);assert.equal(plan.rewards,-1);assert.deepEqual(plan.withdrawals,[]);const source=checkSources(capture,plan.sourceManifestSha256);
 const inputs=plan.declarations.map((d,i)=>{for(const f of Object.values(d.files)){const b=fs.readFileSync(path.join(capture,f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}const input=json(path.join(capture,d.files.declaration.path));assert.equal(input.index,i);assert.equal(input.id,d.id);assert.deepEqual(json(path.join(capture,d.files.alloc.path)),input.allocation);assert.deepEqual(json(path.join(capture,d.files.env.path)),input.environment);assert.equal(json(path.join(capture,d.files.txs.path)),input.transactionBody);return input;});return{plan,source,inputs};}
export async function run(capture,pin){assert.equal(fs.realpathSync(fileURLToPath(import.meta.url)),fs.realpathSync(path.join(capture,'runtime',PREFIX,'run.mjs')),'Only frozen driver may dispatch');
 const{plan,source,inputs}=checkPlan(capture,pin),runtime=path.join(capture,'runtime'),ledger=new Map(),unhashed=new Map();
 const admit=p=>{const f=entry(capture,p);ledger.set(p,f);return f;},put=(p,v)=>{const s=save(path.join(capture,p),v);admit(p);return s;},checkLedger=()=>{for(const[p,f]of ledger)assert.deepEqual(entry(capture,p),f);};
 for(const p of['plan.json','source-manifest.json',...plan.declarations.flatMap(d=>Object.values(d.files).map(f=>f.path))])admit(p);
 const inventory=()=>exactInventory(capture,[...ledger.keys(),...unhashed.keys(),...source.files.map(f=>'runtime/'+f.path),...source.toolFiles.map(f=>'toolchain/'+f.path)]);
 const wall0=Date.now(),mono0=performance.now();let previousWall=0,previousMono=0,reversed=false,totalBytes=0,fatal=null;
 const timing=()=>{const wallMs=Date.now()-wall0,monotonicMs=performance.now()-mono0;reversed ||= wallMs<previousWall||monotonicMs<previousMono;previousWall=wallMs;previousMono=monotonicMs;return{wallMs,monotonicMs,clockReversed:reversed};};
 const remaining=()=>{const t=timing();assert(!t.clockReversed&&validTime(t.wallMs,t.monotonicMs,LIMITS.totalMs));const n=Math.floor(Math.min(LIMITS.processMs,LIMITS.totalMs-Math.max(t.wallMs,t.monotonicMs)));assert(n>0);return n;};
 const guard=()=>{checkLedger();checkPlan(capture,pin);assert(totalBytes<=LIMITS.totalOutputBytes);return remaining();};
 const dispatch=(executable,args)=>{guard();assert.equal(sha(fs.readFileSync(executable)),executable===source.node.executable?source.node.sha256:BINARY_SHA);const timeoutMs=remaining(),wall=Date.now(),mono=performance.now();
  const r=spawnSync(executable,args,{cwd:runtime,encoding:null,timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer:LIMITS.processBytes,env:{PATH:process.env.PATH??'',TZ:'UTC',LANG:'C'}}),pack=b=>{b??=Buffer.alloc(0);totalBytes+=b.length;return{bytes:b.length,sha256:sha(b),base64:b.toString('base64')};};
  return{process:{executable,args,timeoutMs,wallElapsedMs:Date.now()-wall,elapsedMs:performance.now()-mono,status:r.status,signal:r.signal,error:r.error?{name:r.error.name,code:r.error.code??null,message:r.error.message}:null},stdout:pack(r.stdout),stderr:pack(r.stderr)};};
 put('STARTED.json',{at:new Date(wall0).toISOString(),planSha256:pin});
 const rows=IDS.map(id=>({id,product:{status:'not_attempted',observation:null},ethereumjs:{status:'not_attempted',observation:null},geth:{status:'not_attempted',observation:null},comparisons:null}));
 try{
  // Seal all owned product observations before either comparison client runs.
  for(const mode of['product','ethereumjs'])for(let i=0;i<6;i++){
   const p=mode+'/'+String(i+1).padStart(3,'0')+'.json';rows[i][mode]={status:'unavailable',observation:null,error:'dispatch_started'};
   const raw=dispatch(source.node.executable,['--max-old-space-size=256',path.join(runtime,PREFIX,'worker.mjs'),mode,path.join(capture,plan.declarations[i].files.declaration.path)]),id=put(p,raw);put(p+'.seal.json',{...id,at:new Date().toISOString()});
   assert(validProcessBounds(raw),'Process bound exceeded');if(validProcess(raw)){
    const out=observation(readSealed(capture,p));assert.equal(out.id,IDS[i]);assert.equal(out.mode,mode);
    if(mode==='product'&&out.attempt)assert.equal(out.processClosureValid,true,'Product child closure/drain unconfirmed');
    rows[i][mode]={status:out.observation?'observed':mode==='product'?(out.attempt?.output?.execution?.status??'unavailable'):'unavailable',observation:out.observation,withheldState:out.withheldState??null,error:out.error??out.attempt?.error??null};
   }guard();
  }
  for(let i=0;i<6;i++){
   const n=String(i+1).padStart(3,'0'),p='geth/'+n,out=path.join(capture,p),input=inputs[i],d=plan.declarations[i];guard();
   const productRaw=readSealed(capture,'product/'+n+'.json'),ejsRaw=readSealed(capture,'ethereumjs/'+n+'.json');
   assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});rows[i].geth={status:'unavailable',observation:null,error:'dispatch_started'};
   const args=['t8n','--state.fork=Amsterdam','--state.chainid=11155111','--state.reward=-1','--input.alloc='+path.join(capture,d.files.alloc.path),'--input.env='+path.join(capture,d.files.env.path),'--input.txs='+path.join(capture,d.files.txs.path),
    '--output.basedir='+out,'--output.alloc=alloc.json','--output.result=result.json','--output.body=body.rlp','--trace','--trace.callframes','--trace.memory'];
   const raw=dispatch(source.geth.binary.path,args);put(p+'-process.json',{...raw,productSealedSha256:sha(fs.readFileSync(path.join(capture,'product/'+n+'.json'))),ethereumJsSealedSha256:sha(fs.readFileSync(path.join(capture,'ethereumjs/'+n+'.json')))});
   try{const scan=scanOutput(out,totalBytes);totalBytes=scan.totalBytes;for(const f of scan.files)admit(p+'/'+f.path);
    assert.deepEqual(scan.files.map(f=>f.path),['alloc.json','body.rlp','result.json','trace-0-'+input.transactionHash+'.jsonl']);assert(validProcess(raw));rawBytes(raw.stdout);rawBytes(raw.stderr);
    const observed=await gethObservation(input,{allocation:decode(fs.readFileSync(path.join(out,'alloc.json'))),result:decode(fs.readFileSync(path.join(out,'result.json'))),body:decode(fs.readFileSync(path.join(out,'body.rlp'))),trace:fs.readFileSync(path.join(out,'trace-0-'+input.transactionHash+'.jsonl'))});
    rows[i].geth={status:'observed',observation:observed,error:null};
   }catch(error){if(error instanceof OutputBoundsError){totalBytes=error.totalBytes;for(const f of error.files){const name=p+'/'+f.path;unhashed.set(name,{...f,path:name,kind:'unhashed_output',observedKind:f.kind,sha256:null,reason:'declared_output_bound_exceeded'});}throw error;}
    rows[i].geth={status:'unavailable',observation:null,error:{name:error.name,message:error.message}};}
   assert(validProcessBounds(raw),'Geth process bound exceeded');guard();rows[i].comparisons=compareObservations(Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,rows[i][k].observation])));put(p+'-observation.json',rows[i]);console.log(JSON.stringify({id:input.id,statuses:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,rows[i][k].status]))}));
  }
 }catch(error){fatal={name:error?.name??null,message:error?.message??String(error)};}
 let sourceUnchanged=false,artifactsUnchanged=false;try{checkPlan(capture,pin);sourceUnchanged=true;checkLedger();inventory();artifactsUnchanged=unhashed.size===0;}catch(error){fatal??={name:error.name,message:error.message};}
 const terminalTiming=timing();terminalTiming.valid=!terminalTiming.clockReversed&&validTime(terminalTiming.wallMs,terminalTiming.monotonicMs,LIMITS.totalMs)&&totalBytes<=LIMITS.totalOutputBytes;if(!terminalTiming.valid)fatal??={name:'BoundsError',message:'Terminal bounds invalid'};
 const results={schemaVersion:1,planSha256:pin,sourceManifestSha256:plan.sourceManifestSha256,status:fatal?'interrupted':'complete',observationsUsable:fatal===null&&sourceUnchanged&&artifactsUnchanged,sourceUnchanged,artifactsUnchanged,fatal,terminalTiming,totalOutputBytes:totalBytes,artifactHashCoverageComplete:unhashed.size===0,scope:SCOPE,rows,
  counts:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,Object.fromEntries([...new Set(rows.map(r=>r[k].status))].map(s=>[s,rows.filter(r=>r[k].status===s).length]))]))};put('results.json',results);
 put('summary.json',{scope:SCOPE,observationsUsable:results.observationsUsable,counts:results.counts,rows:rows.map(r=>({id:r.id,...Object.fromEntries(['product','ethereumjs','geth'].map(k=>{const x=r[k],o=x.observation;return[k,{status:x.status,executionStatus:o?.executionStatus??x.withheldState?.executionStatus??null,error:x.error??null,stateRoot:o?.stateRoot??null,rollbackStateRoot:x.withheldState?.rollbackStateRoot??null,targetBehavior:o?.targetBehavior??null,target:o?.target??null,gasUsed:o?.gasUsed??null,singleTransactionBlockGasUsed:o?.singleTransactionBlockGasUsed??null}];})),comparisons:r.comparisons}))});
 checkLedger();inventory();const files=[...ledger.values(),...unhashed.values(),...source.files.map(f=>({...f,path:'runtime/'+f.path})),...source.toolFiles.map(f=>entry(capture,'toolchain/'+f.path))].sort((a,b)=>a.path<b.path?-1:1);
 return{counts:results.counts,observationsUsable:results.observationsUsable,manifestSha256:save(path.join(capture,'manifest.json'),{schemaVersion:1,planSha256:pin,artifactHashCoverageComplete:unhashed.size===0,files}).sha256};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');if(process.argv[2]==='freeze')console.log(JSON.stringify(await freeze(root,path.join(root,PREFIX,'capture')),null,2));
 else if(process.argv[2]==='check'){const r=checkPlan(path.resolve(process.argv[3]),process.argv[4]);console.log(JSON.stringify({cases:r.inputs.length,sourceUnchanged:true}));}
 else if(process.argv[2]==='run')console.log(JSON.stringify(await run(path.resolve(process.argv[3]),process.argv[4]),null,2));else throw Error('Use freeze, check CAPTURE PLAN_SHA, or archived run CAPTURE PLAN_SHA');}
