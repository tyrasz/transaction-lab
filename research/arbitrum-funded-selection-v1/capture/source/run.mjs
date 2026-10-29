import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ENDPOINT,TOKEN,MESSENGER,KNOWN,TOPIC,LIMITS,logFilter,candidatesFromLogs,balanceCall,allowanceCall,assessCandidate} from './selection.mjs';
import {transport,errorOf} from './transport.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const text=v=>JSON.stringify(v,null,2)+'\n';
export function inventory(root,sub=''){return fs.readdirSync(path.join(root,sub),{withFileTypes:true}).flatMap(e=>{const p=path.posix.join(sub,e.name);if(e.isDirectory())return inventory(root,p);assert(e.isFile());const b=fs.readFileSync(path.join(root,p));return[{path:p,bytes:b.length,sha256:sha(b),mode:fs.statSync(path.join(root,p)).mode&0o777}];}).sort((a,b)=>a.path.localeCompare(b.path,'en'));}
export function writer(root){const entries=[];let failed=null;return{save(name,value){try{if(failed)throw failed;assert(/^[\w.\/-]+$/.test(name)&&!name.split('/').includes('..')&&!path.isAbsolute(name));const b=Buffer.isBuffer(value)?value:Buffer.from(text(value)),p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx',0o644);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const e={path:name,bytes:b.length,sha256:sha(b)};entries.push(e);return e;}catch(e){failed=e;throw e;}},verify(){if(failed)throw failed;for(const e of entries){const p=path.join(root,e.path);assert(fs.lstatSync(p).isFile());const b=fs.readFileSync(p);assert.equal(b.length,e.bytes);assert.equal(sha(b),e.sha256);}}};}
export async function executeSelection({rpc,save}){
  const result={status:'selection_unavailable',selectedHeader:null,discovery:null,probes:[],selected:null,finalHeader:null,headerConfirmed:false,error:null};
  try{
    assert.equal(await rpc('eth_chainId',[],'selection'),'0xa4b1');
    const header=await rpc('eth_getBlockByNumber',['latest',false],'selection');logFilter(header);result.selectedHeader=header;save('selected-header.json',header);
    const logs=await rpc('eth_getLogs',[logFilter(result.selectedHeader)],'discovery');result.discovery=candidatesFromLogs(logs,result.selectedHeader);save('candidate-order.json',result.discovery);
    for(const[index,candidate]of result.discovery.candidates.entries()){
      const row={index,...candidate};for(const[name,method,params]of [['balance','eth_call',[balanceCall(candidate.address),result.selectedHeader.number]],['allowance','eth_call',[allowanceCall(candidate.address),result.selectedHeader.number]],['code','eth_getCode',[candidate.address,result.selectedHeader.number]]]){
        try{row[name]={status:'observed',value:await rpc(method,params,'probe'),error:null};}catch(e){row[name]={status:'unavailable',value:null,error:errorOf(e)};}
      }row.assessment=assessCandidate(row);result.probes.push(row);save('probes/'+String(index+1).padStart(3,'0')+'.json',row);
    }
  }catch(e){result.error=errorOf(e);}
  if(result.selectedHeader){try{result.finalHeader=await rpc('eth_getBlockByNumber',[result.selectedHeader.number,false],'final');save('final-header.json',result.finalHeader);assert.deepEqual(result.finalHeader,result.selectedHeader);result.headerConfirmed=true;}catch(e){result.finalError=errorOf(e);}}
  if(result.headerConfirmed&&!result.error){const first=result.probes.find(p=>p.assessment.status==='eligible');if(first){result.selected={address:first.address,candidateIndex:first.index,...first.assessment};result.status='selected';}}
  return result;
}
const HERE=path.dirname(fileURLToPath(import.meta.url));
export function freeze(root=HERE){
  const files=inventory(root);assert(!files.some(f=>f.path.startsWith('capture/')));const provenance=JSON.parse(fs.readFileSync(path.join(root,'sources/provenance.json')));
  for(const f of provenance.files){const b=fs.readFileSync(path.join(root,f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}assert.equal(provenance.eventTopic,TOPIC);
  assert.equal(sha(fs.readFileSync(path.join(root,'sources/scenario.json'))),'5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa');
  const capture=path.join(root,'capture');fs.mkdirSync(capture);const w=writer(capture);for(const f of files){w.save('source/'+f.path,fs.readFileSync(path.join(root,f.path)));fs.chmodSync(path.join(capture,'source',f.path),f.mode);}
  assert.deepEqual(inventory(path.join(capture,'source')),files);assert.deepEqual(inventory(root).filter(f=>!f.path.startsWith('capture/')),files);
  const sources=w.save('source-manifest.json',{files});const plan={schema:1,frozenAt:new Date().toISOString(),producerRoot:root,sourceManifestSha256:sources.sha256,node:{executable:process.execPath,version:process.version,sha256:sha(fs.readFileSync(process.execPath))},endpoint:ENDPOINT,chainId:'0xa4b1',token:TOKEN,messenger:MESSENGER,known:KNOWN,eventTopic:TOPIC,limits:LIMITS,ordering:'unique depositors descending blockNumber/transactionIndex/logIndex, then preserved sender; first8 only; probe all then first observed eligible',eligibility:{balanceRaw:'100000000',allowanceRaw:'100000000',spender:MESSENGER,codeMustBeObserved:true},scope:{developmentSelection:true,populationSample:false,providerReportedState:true,cryptographicStateProofs:false,numericSelectorAtomic:false,liveCodeIdentityAttested:false,signing:false,broadcast:false,overrides:false,targetSimulation:false,retries:0,windowWidening:false}};
  const identity=w.save('PLAN.json',plan);w.verify();return{capture,planSha256:identity.sha256,sourceManifestSha256:sources.sha256,files:files.length};
}
export function check(capture,pin){const b=fs.readFileSync(path.join(capture,'PLAN.json'));assert.equal(sha(b),pin);const plan=JSON.parse(b),sb=fs.readFileSync(path.join(capture,'source-manifest.json'));assert.equal(sha(sb),plan.sourceManifestSha256);const source=JSON.parse(sb);assert.deepEqual(inventory(path.join(capture,'source')),source.files);assert.deepEqual(inventory(plan.producerRoot).filter(f=>!f.path.startsWith('capture/')),source.files);assert.deepEqual(plan.limits,LIMITS);assert.equal(plan.endpoint,ENDPOINT);assert.deepEqual(plan.node,{executable:process.execPath,version:process.version,sha256:sha(fs.readFileSync(process.execPath))});return plan;}
export async function run(capture,pin){const plan=check(capture,pin);assert.equal(HERE,path.join(capture,'source'));const w=writer(capture);w.save('STARTED.json',{planSha256:pin,startedAt:new Date().toISOString(),pid:process.pid});const t=transport({save:w.save});const result=await executeSelection({rpc:t.request,save:w.save});result.transport=await t.finish();w.verify();
  result.sourceUnchanged=false;try{check(capture,pin);result.sourceUnchanged=true;}catch(e){result.integrityError=errorOf(e);}result.transport=t.snapshot();
  result.usable=result.sourceUnchanged&&result.headerConfirmed&&result.transport.withinBounds&&!result.transport.clockReversed&&!result.transport.fatal&&result.transport.pendingOperations===0;
  if(!result.usable){result.selected=null;result.status='selection_unavailable';}result.planSha256=pin;result.scope=plan.scope;result.finishedAt=new Date().toISOString();w.save('results.json',result);w.verify();const files=inventory(capture).filter(f=>!f.path.startsWith('source/'));const manifest=w.save('manifest.json',{planSha256:pin,sourceManifestSha256:plan.sourceManifestSha256,files});w.verify();return{manifest,status:result.status,selected:result.selected,candidates:result.probes.length,calls:result.transport.calls,retainedBytes:result.transport.retainedBytes,elapsedMs:result.transport.elapsedMs,sourceUnchanged:result.sourceUnchanged,usable:result.usable,error:result.error};}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--freeze')console.log(text(freeze()));
  else if(process.argv[2]==='--check')console.log(text(check(path.resolve(process.argv[3]),process.argv[4])));
  else if(process.argv[2]==='--run')console.log(text(await run(path.resolve(process.argv[3]),process.argv[4])));
  else throw Error('Use --freeze, --check CAPTURE PLAN_SHA, or archived --run CAPTURE PLAN_SHA');
}
