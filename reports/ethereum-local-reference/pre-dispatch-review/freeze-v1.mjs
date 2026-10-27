import {readFile,writeFile,mkdir,readdir,lstat,readlink,copyFile,symlink} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha} from './wire.mjs';
const DIR=dirname(fileURLToPath(import.meta.url)),ROOT=join(DIR,'../..');
export const MODULES=['ethereum-call.js','ethereum-profile.js','ethereum-header.js','execute.js','rpc-state-inputs.js','proof-state.js','verified-state-proof.js','package.json','package-lock.json'].map(f=>'engines/local-evm/'+f);
async function walk(dir){const files=[];for(const e of(await readdir(join(ROOT,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);if(e.isDirectory())files.push(...await walk(p));else files.push(p);}return files;}
const save=async(p,v)=>writeFile(join(DIR,p),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
export async function freeze(){
  const sourcePaths=[...MODULES,...await walk('engines/local-evm/node_modules')].sort(),sources=[];
  for(const path of sourcePaths){const src=join(ROOT,path),dst=join(DIR,'runtime',path),stat=await lstat(src);await mkdir(dirname(dst),{recursive:true});
    if(stat.isSymbolicLink()){const target=await readlink(src);if(target.startsWith('/')||target.includes('../..'))throw Error('Unexpected dependency symlink');await symlink(target,dst);sources.push({path,kind:'symlink',target});}
    else{const bytes=await readFile(src);await writeFile(dst,bytes,{flag:'wx'});sources.push({path,kind:'file',bytes:bytes.length,sha256:sha(bytes)});}}
  await mkdir(join(DIR,'inputs'),{recursive:true});const inputs=[];
  for(const name of ['plan.json','capture.json','manifest.json']){const path='reports/ethereum-proof-capability/'+name,bytes=await readFile(join(ROOT,path));await writeFile(join(DIR,'inputs',name),bytes,{flag:'wx'});inputs.push({path:'inputs/'+name,source:path,bytes:bytes.length,sha256:sha(bytes)});}
  if(inputs.find(x=>x.path==='inputs/capture.json').sha256!=='d0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e')throw Error('Capability capture changed');
  const capability=JSON.parse(await readFile(join(DIR,'inputs/capture.json'))),header=capability.selectedHeader,oldPlan=JSON.parse(await readFile(join(DIR,'inputs/plan.json')));
  const request={from:'0x28c6c06298d514db089934071355e5743bf21d60',to:oldPlan.targets.usdc,data:'0xa9059cbb'+oldPlan.targets.absenceCandidate.slice(2).padStart(64,'0')+'1'.padStart(64,'0'),value:'0x0',gas:'0x4c4b40'};
  const scripts=[];for(const path of ['freeze.mjs','run.mjs','wire.mjs','compare.mjs','compare.test.mjs']){const b=await readFile(join(DIR,path));scripts.push({path,bytes:b.length,sha256:sha(b)});}
  const plan={schemaVersion:'1.0',purpose:'One fixed constructed unsigned USDC transfer development workload with two proof-input attempts; not historical signed replay, held-out coverage or an accuracy score.',createdAt:new Date().toISOString(),header,request,
    headerTrust:'Recompute exact fork execution-header hash; externally chosen hash comes from prior provider observations, not verified consensus/finality/body.',
    providers:[{id:'publicnode',url:'https://ethereum-rpc.publicnode.com'},{id:'drpc',url:'https://eth.drpc.org'}],
    limits:{attempts:2,proofCodeCallsPerAttempt:64,bodyBytes:8388608,sharedLocalResponseBytes:33554432,requestMs:25000,attemptMs:120000,apiRequests:1,apiTimeoutMs:160000,apiBodyBytes:67108864,apiInternalRpcCalls:65,apiInternalResponseBytes:33554432},
    api:{url:'http://127.0.0.1:5174/api/evm/simulate',input:{chainId:1,from:request.from,to:request.to,data:request.data,value:'0',block:header.hash}},
    policy:{retries:0,replacements:0,fallback:false,ordering:'Both local attempts complete and outputs are saved before the single product comparison request.',stateInputs:'Only independently verified eth_getProof and eth_getCode with EIP1898 hash binding. No product trace, state diff or expected output enters local execution.',missingBlockhash:'No ancestry queries; an execution requiring historical BLOCKHASH fails closed.',failedAttempt:'Retain outcome and continue the other predeclared independent attempt, never repair or retry.',comparison:'Independent raw provider-diff interpretation and committed log sequence; incomplete or unsupported evidence is explicit. Local gasAccounting versus raw root trace gasUsed; no transaction fee or signature claim.'},
    runtime:{node:process.version,versions:process.versions,platform:process.platform,arch:process.arch},sourceFiles:sources,inputFiles:inputs,scripts};
  await save('plan.json',plan);console.log(JSON.stringify({planSha256:sha(await readFile(join(DIR,'plan.json'))),sourceFiles:sources.length,dependencyFiles:sources.filter(x=>x.path.includes('/node_modules/')).length,sourceBytes:sources.reduce((s,x)=>s+(x.bytes??0),0),request}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))await freeze();
