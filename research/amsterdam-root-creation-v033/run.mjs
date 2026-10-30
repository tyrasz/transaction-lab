import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {performance} from 'node:perf_hooks';import {fileURLToPath} from 'node:url';
import {HOME,ORIGINAL,CAPTURE,PINS,INDICES,FILES,LIMITS,number,sha,read,walk,entry,save,match,original,expectedWorker,checkOwn,validTime,bounded,report,projected} from './protocol.mjs';

export async function freeze(){
 const o=await original();assert(!fs.existsSync(CAPTURE));assert.equal(fs.readFileSync(path.join(HOME,'worker.mjs'),'utf8'),expectedWorker());
 const files=FILES.map(p=>entry(HOME,p));fs.mkdirSync(path.join(CAPTURE,'source'),{recursive:true});
 for(const f of files)fs.writeFileSync(path.join(CAPTURE,'source',f.path),fs.readFileSync(path.join(HOME,f.path)),{flag:'wx',mode:f.mode});
 const inputs=[];for(const i of INDICES){const p='inputs/'+number(i)+'.json';fs.mkdirSync(path.join(CAPTURE,'inputs'),{recursive:true});fs.writeFileSync(path.join(CAPTURE,p),fs.readFileSync(path.join(ORIGINAL,p)),{flag:'wx'});inputs.push(entry(CAPTURE,p));}
 const source=save(path.join(CAPTURE,'source-manifest.json'),{files,node:o.source.node,original:PINS});
 const plan={schemaVersion:1,executionDirectory:HOME,original:PINS,indices:INDICES,limits:LIMITS,files,inputs,sourceSha256:source.sha256,at:new Date().toISOString(),originalCounts:o.results.counts};checkOwn(plan);
 return save(path.join(CAPTURE,'plan.json'),plan);
}
export async function run(pin){
 assert.equal(sha(fs.readFileSync(path.join(CAPTURE,'plan.json'))),pin);const plan=read(path.join(CAPTURE,'plan.json')),o=await original();checkOwn(plan);
 assert.equal(sha(fs.readFileSync(path.join(CAPTURE,'source-manifest.json'))),plan.sourceSha256);
 const ledger=new Map(walk(CAPTURE).map(p=>[p,entry(CAPTURE,p)])),put=(p,v)=>{const id=save(path.join(CAPTURE,p),v);ledger.set(p,entry(CAPTURE,p));return id;};
 const check=async()=>{checkOwn(plan);await original();assert.deepEqual(walk(CAPTURE),[...ledger.keys()].sort());for(const f of ledger.values())match(CAPTURE,f);};
 const wall0=Date.now(),mono0=performance.now();let lastWall=0,lastMono=0,reversed=false,totalBytes=0,fatal=null;
 const timing=()=>{const wallMs=Date.now()-wall0,monotonicMs=performance.now()-mono0;reversed ||=wallMs<lastWall||monotonicMs<lastMono;lastWall=wallMs;lastMono=monotonicMs;return{wallMs,monotonicMs,reversed};};
 put('STARTED.json',{at:new Date(wall0).toISOString(),planSha256:pin});
 const rows=INDICES.map(i=>({index:i,id:read(path.join(CAPTURE,'inputs/'+number(i)+'.json')).id,product:{status:'not_attempted',observation:null},ethereumjs:{status:'not_attempted',observation:null},geth:o.results.rows[i].geth,comparisons:null}));
 try{for(const mode of ['product','ethereumjs']){
  for(const row of rows){await check();const t=timing();assert(!t.reversed&&validTime(t.wallMs,t.monotonicMs,LIMITS.totalMs));const timeoutMs=Math.floor(Math.min(LIMITS.processMs,LIMITS.totalMs-Math.max(t.wallMs,t.monotonicMs)));assert(timeoutMs>0);
   row[mode]={status:'unavailable',observation:null,error:'dispatch_started'};const args=['--max-old-space-size=256',path.join(HOME,'worker.mjs'),mode,path.join(CAPTURE,'inputs/'+number(row.index)+'.json')];
   const wall=Date.now(),mono=performance.now(),r=spawnSync(o.source.node.executable,args,{cwd:path.join(ORIGINAL,'runtime'),encoding:null,timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer:LIMITS.processBytes,env:{PATH:process.env.PATH??'',TZ:'UTC',LANG:'C'}});
   const pack=b=>{b??=Buffer.alloc(0);totalBytes+=b.length;return{bytes:b.length,sha256:sha(b),base64:b.toString('base64')};};
   const raw={process:{executable:o.source.node.executable,args,timeoutMs,wallMs:Date.now()-wall,monotonicMs:performance.now()-mono,status:r.status,signal:r.signal,error:r.error?{name:r.error.name,message:r.error.message,code:r.error.code??null}:null},stdout:pack(r.stdout),stderr:pack(r.stderr)};
   const p=mode+'/'+number(row.index)+'.json',id=put(p,raw);put(p+'.seal.json',{...id,at:new Date().toISOString()});
   assert(bounded(raw)&&totalBytes<=LIMITS.totalBytes,'Process output/time bound exceeded');
   try{const out=report(raw);assert.equal(out.id,row.id);assert.equal(out.mode,mode);if(mode==='product'&&out.attempt)assert.equal(out.processClosureValid,true);row[mode]=projected(out);}catch(error){row[mode].error={name:error.name,message:error.message};}
   console.log(JSON.stringify({id:row.id,mode,status:row[mode].status}));
  }
  if(mode==='product')put('PRODUCTS_SEALED.json',{at:new Date().toISOString(),files:INDICES.map(i=>entry(CAPTURE,'product/'+number(i)+'.json'))});
 }}catch(error){fatal={name:error?.name??null,message:error?.message??String(error)};}
 let sourceUnchanged=false;try{await check();sourceUnchanged=true;}catch(error){fatal??={name:error.name,message:error.message};}
 const terminalTiming=timing();if(terminalTiming.reversed||!validTime(terminalTiming.wallMs,terminalTiming.monotonicMs,LIMITS.totalMs)||totalBytes>LIMITS.totalBytes)fatal??={name:'BoundsError',message:'Terminal bounds exceeded'};
 for(const row of rows)row.comparisons=o.observations.compareObservations(Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,row[k].observation])));
 const results={schemaVersion:1,planSha256:pin,original:PINS,originalCounts:o.results.counts,indices:INDICES,rows,fatal,sourceUnchanged,observationsUsable:!fatal&&sourceUnchanged,totalBytes,terminalTiming,
  counts:Object.fromEntries(['product','ethereumjs'].map(k=>[k,Object.fromEntries([...new Set(rows.map(r=>r[k].status))].map(s=>[s,rows.filter(r=>r[k].status===s).length]))]))};
 put('results.json',results);assert.deepEqual(walk(CAPTURE),[...ledger.keys()].sort());for(const f of ledger.values())match(CAPTURE,f);
 return{counts:results.counts,observationsUsable:results.observationsUsable,fatal,manifest:save(path.join(CAPTURE,'manifest.json'),{schemaVersion:1,planSha256:pin,files:[...ledger.values()].sort((a,b)=>a.path.localeCompare(b.path))})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){if(process.argv[2]==='freeze')console.log(JSON.stringify(await freeze(),null,2));else if(process.argv[2]==='run')console.log(JSON.stringify(await run(process.argv[3]),null,2));else throw Error('Use freeze or run PLAN_SHA');}
