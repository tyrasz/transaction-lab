import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import childProcess from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import {performance} from 'node:perf_hooks';
import {amsterdamExecutionFixture} from '../../../engines/local-evm/test/amsterdam-execution-fixture.js';
import {feeFixture,TARGET,TX_SENDER} from '../../../engines/local-evm/test/fee-fixture.js';
import {executeIsolatedEthereumCall} from '../../../engines/local-evm/isolated-call.js';
const HOME=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HOME,'../../..');
const DELEGATE='0x'+'66'.repeat(20),SECOND='0x'+'77'.repeat(20),ROUTER='0x'+'88'.repeat(20),RETURN42='0x602a60005260206000f3',EXACT='0xef0100'+DELEGATE.slice(2);
const CASES=[
 ['root_length3','amsterdam','root','0xef0100'],['root_length22','amsterdam','root','0xef0100'+DELEGATE.slice(2,-2)],['root_length24','amsterdam','root',EXACT+'00'],
 ['nested_call_length3','amsterdam','call','0xef0100'],['nested_delegatecall_length24','amsterdam','delegatecall',EXACT+'00'],
 ['root_exact23','amsterdam','root',EXACT],['nested_call_exact23','amsterdam','call',EXACT],['nested_delegatecall_exact23','amsterdam','delegatecall',EXACT],
 ['root_chained_designation','amsterdam','root',EXACT],['cancun_root_exact23','cancun','root',EXACT],['prague_root_length24','prague','root',EXACT+'00'],['root_invalid_opcode','amsterdam','root','0xfe'],
];
const sha=b=>createHash('sha256').update(b).digest('hex');
function save(p,value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{bytes:b.length,sha256:sha(b)};}
const identity=p=>{const b=fs.readFileSync(path.join(ROOT,p));return{path:p,bytes:b.length,sha256:sha(b)};};
function sources(){const names=['engines/evm-context.js','reports/ethereum-proof-capability/capture.json','research/delegation-runtime-v034/probe/PLAN.md','research/delegation-runtime-v034/probe/run.mjs'];
 for(const engine of ['local-evm','fixture-evm'])for(const f of fs.readdirSync(path.join(ROOT,'engines',engine),{withFileTypes:true}))if(f.isFile()&&(f.name.endsWith('.js')||['package.json','package-lock.json'].includes(f.name)))names.push('engines/'+engine+'/'+f.name);
 for(const f of ['amsterdam-execution-fixture.js','fee-fixture.js','authorization-fixture.js','lifecycle-fixture.js','proof-fixture.js'])names.push('engines/local-evm/test/'+f);
 return [...new Set(names)].sort().map(identity);
}
const nested=kind=>'0x6020602060006000'+(kind==='call'?'6000':'')+'73'+TARGET.slice(2)+'620186a0'+(kind==='call'?'f1':'f4')+'60005260406000f3';
async function fixture(row){const[id,fork,kind,targetCode]=row,options={gas:'200000',target:{nonce:1n,balance:17n,code:targetCode},accounts:{[DELEGATE]:{nonce:1n,code:id==='root_chained_designation'?'0xef0100'+SECOND.slice(2):RETURN42},[SECOND]:{nonce:1n,code:RETURN42},...(kind!=='root'?{[ROUTER]:{nonce:1n,balance:19n,code:nested(kind)}}:{})},...(kind!=='root'?{to:ROUTER}:{})};return fork==='amsterdam'?amsterdamExecutionFixture(options):feeFixture({...options,fork});}
const LIMITS={wallMs:10000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:{wallMs:8000},execution:{wallMs:8000}};
const fixtures=[],inputs=[],before=sources();assert.equal(CASES.length,12);
for(let index=0;index<CASES.length;index++){const f=await fixture(CASES[index]);fixtures.push(f);const input={index,id:CASES[index][0],fork:CASES[index][1],kind:CASES[index][2],chainId:f.chainId??1,request:f.request,header:f.header,allocation:f.allocation,headerVerification:f.headerVerification,limits:LIMITS};const filename='inputs/'+String(index+1).padStart(3,'0')+'.json';inputs.push({path:filename,...save(path.join(HOME,filename),input)});}
const sourceIdentity=save(path.join(HOME,'source-before.json'),{files:before,node:{version:process.version,executable:process.execPath,sha256:sha(fs.readFileSync(process.execPath))}});
const planIdentity=save(path.join(HOME,'plan.json'),{schemaVersion:1,cases:CASES,inputs,sourceIdentity,limits:LIMITS,totalMs:120000,actualIsolatedExecutions:12,at:new Date().toISOString()});
save(path.join(HOME,'STARTED.json'),{at:new Date().toISOString(),planIdentity});
let current=null;const fork=childProcess.fork,wall0=Date.now(),mono0=performance.now(),rows=[];let fatal=null;
childProcess.fork=function(...args){const child=fork.apply(this,args),record=current;assert(record);record.childSpawn={args};child.on('message',raw=>record.childMessages.push(raw));for(const name of ['stdout','stderr'])child[name]?.on('data',b=>record[name].push(Buffer.from(b).toString('base64')));return child;};
try{for(let index=0;index<CASES.length;index++){assert(Date.now()-wall0>=0&&Date.now()-wall0<120000&&performance.now()-mono0<120000);assert.deepEqual(sources(),before);const f=fixtures[index],n=String(index+1).padStart(3,'0');current={index,id:CASES[index][0],childMessages:[],stdout:[],stderr:[],proofRecords:[],parentResult:null,error:null};
 const rpc={async call(method,params,options){const record={method,params:structuredClone(params)};current.proofRecords.push(record);try{record.result=await f.rpc.call(method,params,options);return structuredClone(record.result);}catch(error){record.error={name:error?.name??null,message:error?.message??String(error)};throw error;}}};
 const start=performance.now();try{current.parentResult=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:f.chainId??1,rpc,limits:LIMITS});}catch(error){current.error={name:error?.name??null,message:error?.message??String(error)};}current.elapsedMs=performance.now()-start;
 const id=save(path.join(HOME,'outputs/'+n+'.json'),current),childResult=current.childMessages.map(m=>typeof m==='string'?JSON.parse(m):m).find(m=>m.type==='result')?.result;
 const p=current.parentResult,o=p?.output,c=childResult?.output;const row={index,id:current.id,raw:id,status:p?.status??null,parentError:p?.error??current.error,execution:o?.execution??null,childExecution:c?.execution??null,childCalls:c?.trace?.calls??null,gasAccounting:o?.gasAccounting??null,proofCalls:current.proofRecords.length,elapsedMs:current.elapsedMs};rows.push(row);console.log(JSON.stringify({index,id:row.id,status:row.status,execution:row.execution?.status,error:row.execution?.error,parentError:row.parentError}));}
}catch(error){fatal={name:error?.name??null,message:error?.message??String(error)};}finally{childProcess.fork=fork;current=null;}
const after=sources(),sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);save(path.join(HOME,'source-after.json'),{files:after,sourceUnchanged});
const wallMs=Date.now()-wall0,monotonicMs=performance.now()-mono0,usable=fatal===null&&sourceUnchanged&&wallMs>=0&&wallMs<=120000&&monotonicMs<=120000&&rows.length===12;
save(path.join(HOME,'results.json'),{schemaVersion:1,planIdentity,sourceIdentity,sourceUnchanged,fatal,usable,wallMs,monotonicMs,declared:CASES.length,attempted:rows.length,rows});
function walk(root,base=''){return fs.readdirSync(path.join(root,base),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(root,path.join(base,e.name)):[path.join(base,e.name)]).sort();}
const files=walk(HOME).map(p=>{const b=fs.readFileSync(path.join(HOME,p));return{path:p,bytes:b.length,sha256:sha(b)};});console.log(JSON.stringify({usable,fatal,manifest:save(path.join(HOME,'manifest.json'),{schemaVersion:1,planIdentity,files})}));
