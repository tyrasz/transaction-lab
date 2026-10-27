import {readFile,writeFile,mkdir,readdir,lstat,readlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';import {isDeepStrictEqual as equal} from 'node:util';
import {sha,captureHttp,proofTransport} from './wire.mjs';import {compareReference} from './compare.mjs';
const DIR=dirname(fileURLToPath(import.meta.url)),ROOT=join(DIR,'../..');
const save=async(p,v)=>writeFile(join(DIR,p),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
async function checkFiles(plan,original=true){for(const entry of plan.sourceFiles){for(const base of original?[ROOT,join(DIR,'runtime')]:[join(DIR,'runtime')]){const p=join(base,entry.path);if(entry.kind==='symlink'){if(await readlink(p)!==entry.target)throw Error('Dependency symlink changed');}else{const b=await readFile(p);if(b.length!==entry.bytes||sha(b)!==entry.sha256)throw Error('Runtime source changed: '+entry.path);}}}
  for(const e of [...plan.inputFiles,...plan.scripts]){const b=await readFile(join(DIR,e.path));if(b.length!==e.bytes||sha(b)!==e.sha256)throw Error('Frozen packet source changed');}}
async function inventory(dir=DIR,prefix=''){const out=[];for(const e of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(prefix,e.name);if(path==='manifest.json')continue;if(e.isDirectory())out.push(...await inventory(join(dir,e.name),path));else if(e.isSymbolicLink())out.push({path,kind:'symlink',target:await readlink(join(dir,e.name))});else{const b=await readFile(join(dir,e.name));out.push({path,bytes:b.length,sha256:sha(b)});}}return out;}
async function load(expected){const bytes=await readFile(join(DIR,'plan.json')),plan=JSON.parse(bytes);if(sha(bytes)!==expected)throw Error('Plan SHA differs');if(process.version!==plan.runtime.node)throw Error('Node version differs');await checkFiles(plan);const mod=p=>import(pathToFileURL(join(DIR,'runtime/engines/local-evm',p)));const [{verifyEthereumHeader},{createRpcStateInputs},{createProofStateManager},{executeEthereumCall}]=await Promise.all(['ethereum-header.js','rpc-state-inputs.js','proof-state.js','ethereum-call.js'].map(mod));const headerVerification=verifyEthereumHeader({header:plan.header,expectedHash:plan.api.input.block});return{plan,headerVerification,createRpcStateInputs,createProofStateManager,executeEthereumCall};}
export async function run(expected){
  const {plan,headerVerification,createRpcStateInputs,createProofStateManager,executeEthereumCall}=await load(expected);
  await mkdir(join(DIR,'raw'),{recursive:true});await save('STARTED.json',{planSha256:expected,startedAt:new Date().toISOString(),runtime:plan.runtime,headerVerification});
  const began=performance.now(),shared={bytes:0,maxBytes:plan.limits.sharedLocalResponseBytes},attempts=[];let productRecord=null,fatal=null;
  try{
    for(const provider of plan.providers){const started=performance.now(),deadline=started+plan.limits.attemptMs;
      const rpc=proofTransport({provider,header:plan.header,shared,deadline,save:async record=>{const base=`raw/${provider.id}-${String(record.id).padStart(3,'0')}`;await writeFile(join(DIR,base+'.body'),Buffer.from(record.rawBase64,'base64'),{flag:'wx'});delete record.rawBase64;await save(base+'.json',record);}});
      const inputs=createRpcStateInputs({chainId:1,blockHash:plan.header.hash,header:plan.header,rpc,limits:{calls:64,wallMs:120000}}),state=createProofStateManager({inputs});
      const output=await executeEthereumCall({request:plan.request,header:plan.header,stateManager:state,limits:{wallMs:120000}});
      // The collector may time out just before the bounded wire recorder has
      // persisted its terminal outcome. Finish that existing call before any
      // snapshots, next attempt, product request or manifest can be sealed.
      await rpc.drain();
      const row={provider,startedAt:new Date(Date.now()-(performance.now()-started)).toISOString(),durationMs:performance.now()-started,output,inputs:inputs.snapshotInputs(),inputEvidence:inputs.snapshotEvidence(),inputUsage:inputs.snapshotUsage(),stateReads:state.snapshotReads(),changes:state.snapshotChanges(),transport:rpc.records,headerVerification};
      attempts.push(row);await save(provider.id+'-local.json',row);console.log(JSON.stringify({provider:provider.id,status:output.execution.status,calls:rpc.records.length,bytes:rpc.records.reduce((s,r)=>s+r.transport.observedBytes,0),durationMs:row.durationMs}));
    }
    // This is the first access to product execution. Its output cannot enter
    // either already-completed, separately saved local attempt.
    productRecord=await captureHttp({url:plan.api.url,body:plan.api.input,deadline:performance.now()+plan.limits.apiTimeoutMs,requestMs:plan.limits.apiTimeoutMs,responseBytes:plan.limits.apiBodyBytes,shared:{bytes:0,maxBytes:plan.limits.apiBodyBytes}});
    await writeFile(join(DIR,'product-response.body'),Buffer.from(productRecord.rawBase64,'base64'),{flag:'wx'});delete productRecord.rawBase64;await save('product-http.json',productRecord);
    if(productRecord.parsed)await save('product-response.json',productRecord.parsed);
  }catch(error){fatal={code:'capture_interrupted',message:'The fixed capture could not complete. Saved attempts and wire outcomes are retained.'};console.log(JSON.stringify(fatal));}
  let sourceUnchanged=true;try{await checkFiles(plan);}catch{sourceUnchanged=false;}
  const product=productRecord?.parsed,results={schemaVersion:'1.0',planSha256:expected,completedAt:new Date().toISOString(),durationMs:performance.now()-began,workloads:1,plannedLocalAttempts:2,completedLocalAttempts:attempts.length,retries:0,replacements:0,sourceUnchanged,fatal,headerVerification,
    localCalls:attempts.reduce((s,a)=>s+a.transport.length,0),localObservedBytes:shared.bytes,
    product:{attempted:productRecord!==null,httpStatus:productRecord?.httpStatus??null,status:productRecord?.status??'not_attempted',implementation:product?.implementation??null,implementationMatched:equal(product?.implementation,plan.api.expectedImplementation),rpcCalls:product?.transportEvidence?.length??null,observedRpcBytes:product?.transportEvidence?.reduce((s,r)=>s+r.transport.observedBytes,0)??null},
    attempts:plan.providers.map(provider=>{const local=attempts.find(a=>a.provider.id===provider.id);return{provider:provider.id,executionStatus:local?.output.execution.status??'not_attempted',comparison:local&&product?compareReference(local,product,plan.request,plan.header,plan.api.expectedImplementation):{status:'incomplete',reason:'Local or product response unavailable.'}};}),
    limitations:['One constructed development transfer with two independent state-input attempts, not two cases or a scored cohort.','Execution header hash and initial account/storage/code commitments are verified against the selected hash; consensus, finality and block body are not authenticated.','The product uses a remote execution engine; matching this workload is not proof of universal local completeness.']};
  results.violations=[];if(results.product.rpcCalls>plan.limits.apiInternalRpcCalls)results.violations.push('product_rpc_budget');if(results.product.observedRpcBytes>plan.limits.apiInternalResponseBytes)results.violations.push('product_rpc_byte_budget');if(shared.bytes>shared.maxBytes)results.violations.push('local_wire_byte_budget');
  if(!sourceUnchanged)results.validity='invalid_source_drift';if(results.violations.length)results.validity='invalid_resource_budget';await save('results.json',results);const files=await inventory();await save('manifest.json',{schemaVersion:'1.0',sealedAt:new Date().toISOString(),planSha256:expected,files,filesCount:files.length});console.log(JSON.stringify({manifestSha256:sha(await readFile(join(DIR,'manifest.json'))),results}));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){if(!/^[0-9a-f]{64}$/.test(process.argv[3]??''))throw Error('Pass --check or --run and exact plan SHA');if(process.argv[2]==='--check'){const{plan,headerVerification}=await load(process.argv[3]);console.log(JSON.stringify({status:'ready',sources:plan.sourceFiles.length,headerVerification}));}else if(process.argv[2]==='--run')await run(process.argv[3]);else throw Error('Invalid command');}
