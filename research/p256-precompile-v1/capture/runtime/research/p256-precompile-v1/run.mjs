// Fixed pure-precompile corpus. No RPC, VM, signed transaction or Geth process.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {performance} from 'node:perf_hooks';import {fileURLToPath,pathToFileURL} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../..'),CAP=path.join(HERE,'capture');
const TOOL=path.resolve(ROOT,'../evm-toolchains/geth-v1.17.10'),MEMBER='core/vm/testdata/precompiles/p256Verify.json';
const COMMIT='1df30b18d9ed35ee9d28ffd4648442c2204554ad',VECTOR_SHA='72be71957c3e4292d874b3e2a6a2fc2142524433b01cb9a9552b9bb2528c214d';
const sha=b=>createHash('sha256').update(b).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n',read=p=>JSON.parse(fs.readFileSync(p));
function put(p,b){if(!Buffer.isBuffer(b))b=Buffer.from(json(b));fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx',0o644);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function inventory(root,prefix=''){return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(e=>{const n=path.posix.join(prefix,e.name),p=path.join(root,n),s=fs.lstatSync(p);if(s.isDirectory())return inventory(root,n);if(s.isSymbolicLink()){const target=fs.readlinkSync(p);assert(!path.isAbsolute(target));assert(fs.realpathSync(p).startsWith(root+'/'));return[{path:n,kind:'symlink',target}];}assert(s.isFile());const b=fs.readFileSync(p);return[{path:n,kind:'file',bytes:b.length,mode:s.mode&0o777,sha256:sha(b)}];}).sort((a,b)=>a.path.localeCompare(b.path,'en'));}
function check(root,rows){assert.deepEqual(inventory(root),rows);}
function nodeIdentity(){return{version:process.version,path:process.execPath,sha256:sha(fs.readFileSync(process.execPath))};}
function verify(pin){const pb=fs.readFileSync(path.join(CAP,'PLAN.json'));assert.equal(sha(pb),pin);const plan=JSON.parse(pb),mb=fs.readFileSync(path.join(CAP,'source-manifest.json'));assert.equal(sha(mb),plan.sourceManifestSha256);check(path.join(CAP,'runtime'),JSON.parse(mb).files);assert.deepEqual(nodeIdentity(),plan.node);assert.equal(sha(fs.readFileSync(path.join(CAP,'vectors.json'))),VECTOR_SHA);assert.equal(sha(fs.readFileSync(path.join(CAP,'provenance.json'))),plan.provenanceSha256);assert.equal(sha(fs.readFileSync(import.meta.filename)),plan.runnerSha256);return plan;}
const command=process.argv[2];
if(command==='freeze'){
  assert(!fs.existsSync(CAP));const inv=read(path.join(TOOL,'source-inventory.json'));assert.equal(inv.commit,COMMIT);const row=inv.files.find(x=>x.path===MEMBER),raw=fs.readFileSync(path.join(TOOL,'source',MEMBER));assert(row);assert.equal(row.sha256,VECTOR_SHA);assert.equal(sha(raw),VECTOR_SHA);assert.equal(raw.length,row.bytes);
  const vectors=JSON.parse(raw);assert.equal(vectors.length,782);for(const v of vectors){assert.match(v.Input,/^(?:[0-9a-fA-F]{2})*$/);assert(['','0'.repeat(63)+'1'].includes(v.Expected));assert.equal(v.Gas,6900);assert.equal(typeof v.Name,'string');}
  fs.mkdirSync(CAP);put(path.join(CAP,'vectors.json'),raw);
  const provenance={repository:'https://github.com/ethereum/go-ethereum',commit:COMMIT,tree:inv.tree,path:MEMBER,sha256:VECTOR_SHA,bytes:raw.length,sourceInventorySha256:sha(fs.readFileSync(path.join(TOOL,'source-inventory.json'))),source:'Already retained official source checkout; no network acquisition in this packet.',specification:'https://eips.ethereum.org/EIPS/eip-7951'};put(path.join(CAP,'provenance.json'),provenance);
  const names=['engines/local-evm/p256-runtime.js','engines/local-evm/package.json','engines/local-evm/package-lock.json','research/p256-precompile-v1/run.mjs'];
  const localDeps=path.join(ROOT,'engines/local-evm/node_modules'),deps=inventory(localDeps);assert(deps.length<10000);assert(deps.reduce((n,f)=>n+(f.bytes??0),0)<128*1024*1024);
  for(const name of names){const p=path.join(ROOT,name),before=fs.readFileSync(p);put(path.join(CAP,'runtime',name),before);fs.chmodSync(path.join(CAP,'runtime',name),fs.statSync(p).mode&0o777);assert.equal(sha(fs.readFileSync(p)),sha(before));}
  fs.cpSync(localDeps,path.join(CAP,'runtime/engines/local-evm/node_modules'),{recursive:true,dereference:false,verbatimSymlinks:true});check(path.join(CAP,'runtime/engines/local-evm/node_modules'),deps);check(localDeps,deps);
  const sources={files:inventory(path.join(CAP,'runtime'))};put(path.join(CAP,'source-manifest.json'),sources);
  const plan={schemaVersion:1,frozenAt:new Date().toISOString(),runnerSha256:sha(fs.readFileSync(import.meta.filename)),sourceManifestSha256:sha(Buffer.from(json(sources))),provenanceSha256:sha(Buffer.from(json(provenance))),node:nodeIdentity(),limits:{cases:782,wallMs:60000,gasPerCase:6900,reruns:0,replacements:0},scope:{purePrecompile:true,productTransactionExecution:false,independentRuntimeExecution:false,expectedOutputs:'Unmodified pinned Geth corpus',publicRpc:0},cases:vectors.map((v,index)=>({index,name:v.Name,inputSha256:sha(Buffer.from(v.Input,'hex')),expected:v.Expected,gas:v.Gas}))};put(path.join(CAP,'PLAN.json'),plan);
  console.log(JSON.stringify({planSha256:sha(Buffer.from(json(plan))),sourceManifestSha256:plan.sourceManifestSha256,vectors:782,files:sources.files.length}));
}else if(command==='check'){const p=verify(process.argv[3]);console.log(JSON.stringify({verified:true,cases:p.cases.length}));}
else if(command==='run'){
  const pin=process.argv[3],plan=verify(pin);put(path.join(CAP,'STARTED.json'),{planSha256:pin,at:new Date().toISOString(),pid:process.pid});
  const started=performance.now(),wall=Date.now(),vectors=read(path.join(CAP,'vectors.json'));const rows=[];let fatal=null,sourceUnchanged=false;
  const budget=()=>{if(performance.now()-started>=60000||Date.now()-wall>=60000||Date.now()<wall)throw Error('CORPUS_DEADLINE');};
  try{
    const {createP256Precompile}=await import(pathToFileURL(path.join(CAP,'runtime/engines/local-evm/p256-runtime.js')));let latched=false;const p=createP256Precompile(budget,()=>{latched=true;});
    for(let index=0;index<vectors.length;index++){
      budget();const v=vectors[index];assert.equal(sha(Buffer.from(v.Input,'hex')),plan.cases[index].inputSha256);
      // Expected bytes are compared only after the fixed adapter returned.
      const result=p({data:Uint8Array.from(Buffer.from(v.Input,'hex')),gasLimit:6900n});const actual=Buffer.from(result.returnValue).toString('hex');
      rows.push({index,name:v.Name,status:actual===v.Expected&&result.executionGasUsed===6900n&&result.exceptionError===undefined?'matched':'mismatched',expected:v.Expected,actual,gasUsed:result.executionGasUsed.toString(),exceptionError:result.exceptionError?.error??null});
    }assert.equal(latched,false);budget();
  }catch(e){fatal={code:e?.message==='CORPUS_DEADLINE'?'CORPUS_DEADLINE':'CORPUS_FAILURE'};}
  while(rows.length<782){const i=rows.length;rows.push({index:i,name:vectors[i].Name,status:i===rows.filter(r=>r.status!=='unattempted').length&&fatal?'unavailable':'unattempted',reason:fatal?.code??'NO_RESULT'});if(rows.at(-1).status==='unavailable'){while(rows.length<782){const j=rows.length;rows.push({index:j,name:vectors[j].Name,status:'unattempted',reason:'Prior terminal failure'});}break;}}
  try{verify(pin);sourceUnchanged=true;}catch{fatal??={code:'SOURCE_CHANGED'};}
  const result={planSha256:pin,status:fatal?'unavailable':'complete',comparisonsUsable:!fatal&&sourceUnchanged,sourceUnchanged,fatal,counts:Object.fromEntries(['matched','mismatched','unavailable','unattempted'].map(s=>[s,rows.filter(r=>r.status===s).length])),elapsedMs:performance.now()-started,rows};put(path.join(CAP,'results.json'),result);
  put(path.join(CAP,'manifest.json'),{planSha256:pin,files:inventory(CAP)});console.log(JSON.stringify({...result,rows:undefined,manifestSha256:sha(fs.readFileSync(path.join(CAP,'manifest.json')))}));
}else throw Error('Use freeze, check EXACT_PLAN_SHA, or run EXACT_PLAN_SHA once.');
