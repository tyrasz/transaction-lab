import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTxFromRLP } from '../../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../../engines/fixture-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../../engines/fixture-evm/node_modules/@noble/hashes/sha3.js';
import { TEST_KEY, feeCommon, qty, bytes, signBlobFeeTransaction } from '../../../engines/local-evm/test/blob-fee-fixture.js';
import { integer } from '../../../engines/local-evm/test/proof-fixture.js';
import { adjudicate } from '../run.mjs';
import { NAMES, fixtureAt, initial } from './cases.mjs';
import { PREFIX, BINARY_SHA, sha, json, save, walk, entry, freezeSources, checkSources, nodeIdentity, sourceCommit, sourcePaths } from './archive.mjs';

export const LIMITS=Object.freeze({cases:16,workerMs:20000,workerOutputBytes:16*1024*1024,preparationMs:360000,gethPerCaseMs:5000,gethTotalMs:120000,gethOutputBytes:1048576});
export const SCOPE=Object.freeze({syntheticDevelopment:true,syntheticHeaders:true,productionMainnetForkSelection:true,selectionKnownBeforeFreeze:true,publicRpc:0,retries:0,replacements:0,populationAccuracy:false,prospective:false,product:'archived_executeIsolatedEthereumCall',productSourceProvenanceEstablished:true,reference:'separate_pinned_EthereumJS_full_VM_plus_third_MPT',sharedOpcodeLibraryForFullVM:true,sharedKzgVerifierForFullVM:true,crossClient:'pinned_Geth_v1.17.10',gethCompared:['product_delta_full_poststate_root','Geth_internal_product_log_hash_assertion'],gethGasReturnReceiptCompared:false,nonzeroFeeStateRootSensitiveToSettlement:true,fullVMDisagreementsRetained:true,productUnavailableHasNoGethExpectation:true,originalSignedReplay:false,feeSettlement:true,blobFeeSettlement:false,executedPointEvaluation:true,sidecarKZGVerified:false,wholeBlobValidityVerified:false,blockBodyCapacityVerified:false,nestedPrecompileObservationsPersisted:true,directReturnComparedOnlyBySharedFullVM:true,validTransactionEnvelopesOnly:true,invalidPrecompileInputsRetained:true});
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../../..');
const read=p=>fs.readFileSync(p),logsHash=logs=>bytesToHex(keccak_256(RLP.encode(logs.map(l=>[hexToBytes(l.address),l.topics.map(hexToBytes),hexToBytes(l.data)]))));
export function phaseClock(limitMs,{now=Date.now,monotonic=()=>performance.now()}={}){
  const wallStart=now(),monoStart=monotonic();let wallPrior=wallStart,monoPrior=monoStart,invalid=!Number.isSafeInteger(wallStart)||wallStart<0||!Number.isFinite(monoStart)||monoStart<0;
  function sample(){const wall=now(),mono=monotonic();invalid ||= !Number.isSafeInteger(wall)||wall<wallPrior||!Number.isFinite(mono)||mono<monoPrior;wallPrior=wall;monoPrior=mono;return{wallElapsedMs:wall-wallStart,monotonicElapsedMs:mono-monoStart};}
  return{remaining(){const v=sample();return invalid?0:Math.max(0,Math.floor(limitMs-Math.max(v.wallElapsedMs,v.monotonicElapsedMs)));},terminal(){const v=sample();return{status:invalid?'clock_invalid':Math.max(v.wallElapsedMs,v.monotonicElapsedMs)>limitMs?'overrun':'within_budget',clockValid:!invalid,limitMs,...Object.fromEntries(Object.entries(v).map(([k,n])=>[k,Number.isFinite(n)?n:null]))};}};
}
export function packetVerdict({fatal,sourceUnchanged,phaseTimings}){const usable=fatal===null&&sourceUnchanged===true&&['preparation','geth'].every(k=>phaseTimings[k]?.status==='within_budget'&&phaseTimings[k].clockValid===true);return{status:usable?'complete':'interrupted',comparisonsUsable:usable};}
export function signedBytes(f){
  const tx=signBlobFeeTransaction({request:f.request,common:feeCommon(f),nonce:BigInt(f.allocation[f.request.from].nonce)});
  return bytesToHex(tx.serialize());
}
/** Canonical type-2 signed body and JSON message must agree field-for-field. */
export function decodeSignedInput(input){
  const r=input.request,serialized=bytes(input.signedTransaction),common=feeCommon(input);
  assert.equal(r.executionProfile,'unsigned_eip1559_block_end');
  assert.deepEqual(Object.keys(r).sort(),['from','to','data','gas','value','executionProfile','fees',...(Object.hasOwn(r,'accessList')?['accessList']:[])].sort());
  assert.deepEqual(Object.keys(r.fees).sort(),['maxFeePerGas','maxPriorityFeePerGas']);
  assert.equal(serialized[0],2);const fields=RLP.decode(serialized.subarray(1));assert(Array.isArray(fields));assert.equal(fields.length,12);
  const access=(r.accessList??[]).map(row=>[bytes(row.address),row.storageKeys.map(bytes)]);
  const unsigned=[integer(1n),integer(BigInt(input.allocation[r.from].nonce)),integer(BigInt(r.fees.maxPriorityFeePerGas)),
    integer(BigInt(r.fees.maxFeePerGas)),integer(BigInt(r.gas)),bytes(r.to),integer(BigInt(r.value)),bytes(r.data),access];
  assert.deepEqual(fields.slice(0,unsigned.length),unsigned,'Signed fields differ from declared request');
  const tx=createTxFromRLP(serialized,{common});assert.equal(tx.type,2);assert.equal(bytesToHex(tx.serialize()),input.signedTransaction);
  assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),r.from);assert.equal(tx.chainId,1n);return tx;
}
export function gethTransaction(input){
  const tx=decodeSignedInput(input),r=input.request;
  return {sender:tx.getSenderAddress().toString(),chainId:'0x1',to:tx.to.toString(),data:[bytesToHex(tx.data)],value:[qty(tx.value)],
    gasLimit:[qty(tx.gasLimit)],maxFeePerGas:qty(tx.maxFeePerGas),maxPriorityFeePerGas:qty(tx.maxPriorityFeePerGas),nonce:qty(tx.nonce),secretKey:TEST_KEY,
    ...(Object.hasOwn(r,'accessList')?{accessLists:[r.accessList]}:{})};
}
export async function freeze(capture){const {manifest,identity}=freezeSources(ROOT,capture);const module=await import(pathToFileURL(path.join(capture,'runtime',PREFIX,'run.mjs')));const rows=await module.freezeInputs(capture);
  const plan={schemaVersion:1,frozenAt:new Date().toISOString(),sourceRoot:ROOT,captureDirectory:path.resolve(capture),sourceManifestSha256:identity.sha256,node:manifest.node,geth:manifest.geth,git:manifest.git,limits:LIMITS,scope:SCOPE,cases:rows};const result=save(path.join(capture,'PLAN.json'),plan);checkSources(capture,identity.sha256);return{planSha256:result.sha256,sourceManifestSha256:identity.sha256,cases:rows.length,files:manifest.files.length};}
export async function freezeInputs(capture){const rows=[];for(let i=0;i<NAMES.length;i++){const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)};decodeSignedInput(input);const file=`inputs/${String(i+1).padStart(3,'0')}.json`;rows.push({index:i,name:NAMES[i],fork:input.fork,path:file,...save(path.join(capture,file),input)});}return rows;}
export function check(capture,expectedPlan){assert.match(expectedPlan,/^[0-9a-f]{64}$/);assert.equal(sha(read(path.join(capture,'PLAN.json'))),expectedPlan);const plan=json(path.join(capture,'PLAN.json'));assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.scope,SCOPE);assert.deepEqual(plan.cases.map(c=>c.name),NAMES);assert.deepEqual(plan.node,nodeIdentity());const source=checkSources(capture,plan.sourceManifestSha256);assert.deepEqual(plan.geth,source.geth);assert.deepEqual(plan.git,source.git);
  for(const c of plan.cases){assert.equal(c.path,`inputs/${String(c.index+1).padStart(3,'0')}.json`);const b=read(path.join(capture,c.path));assert.equal(b.length,c.bytes);assert.equal(sha(b),c.sha256);const input=JSON.parse(b);assert.equal(c.index,plan.cases.indexOf(c));assert.equal(input.name,c.name);assert.equal(input.index,c.index);assert.equal(input.fork,c.fork);}return plan;}
export function rawProcess(binary,args,{cwd,timeoutMs,maxBuffer,env}){const start=performance.now(),r=spawnSync(binary,args,{cwd,env,stdio:['ignore','pipe','pipe'],timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer});return{binary,args,exitCode:r.status,signal:r.signal,error:r.error?.code??null,elapsedMs:performance.now()-start,timeoutMs,processCompletion:'spawnSync_returned_after_child_and_pipes_closed',...Object.fromEntries(['stdout','stderr'].map(k=>{const b=r[k]??Buffer.alloc(0);return[k,{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)}];}))};}
export function parseWorker(raw){if(raw.error!==null||raw.exitCode!==0||raw.signal!==null||!Number.isSafeInteger(raw.timeoutMs)||raw.timeoutMs<=0||raw.timeoutMs>LIMITS.workerMs||!Number.isFinite(raw.elapsedMs)||raw.elapsedMs<0||raw.elapsedMs>raw.timeoutMs)return null;try{for(const v of [raw.stdout,raw.stderr]){const b=Buffer.from(v.base64,'base64');assert.equal(b.length,v.bytes);assert.equal(sha(b),v.sha256);}assert(raw.stdout.bytes+raw.stderr.bytes<=LIMITS.workerOutputBytes);const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(raw.stdout.base64,'base64')));return result.status==='completed'?result:null;}catch{return null;}}
export function wrapper(input,product,reference){const attempt=product.result?.attempt,h=input.header,ref=reference.result;
  if(attempt?.status!=='completed'||!['success','reverted','failed'].includes(attempt.output?.execution?.status)||ref?.status!=='completed'||!ref.productAppliedStateRoot)return null;
  assert.match(ref.productAppliedStateRoot,/^0x[0-9a-f]{64}$/);
  const p={hash:ref.productAppliedStateRoot,logs:logsHash(attempt.output.logs),txbytes:input.signedTransaction,indexes:{data:0,gas:0,value:0}};
  return{_info:{comment:'Fixed synthetic KZG precompile controls. Expected root is product deltas applied to a third MPT; full-VM diagnostic shares crypto and opcodes. No blob sidecar, whole-blob or body-capacity validation.'},config:{chainid:'0x01'},
    env:{currentCoinbase:h.miner,currentDifficulty:h.difficulty,currentRandom:h.mixHash,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentBaseFee:h.baseFeePerGas,currentExcessBlobGas:h.excessBlobGas},
    pre:input.allocation,transaction:gethTransaction(input),post:{[input.fork]:[p]}};
}
export function fullVMAgreement(product,reference){const a=product.result?.attempt?.output,b=reference.result;if(!a||!b?.fullVM||!b.productAppliedStateRoot)return{status:'unavailable'};const f=b.fullVM,checks={state:b.productAppliedStateRoot===f.stateRoot,logs:logsHash(a.logs)===f.logsHash,return:a.execution.returnData===f.returnData,status:a.execution.status===(f.execution==='revert'?'reverted':f.execution==='success'?'success':'failed'),gas:a.gasAccounting?.gasUsed===f.gasUsed};return{status:Object.values(checks).every(Boolean)?'matched':'mismatched',checks};}
export function readSealedProduct(capture,id){
  assert.match(id,/^\d{3}$/);const relative=`results/${id}-product.json`,seal=json(path.join(capture,`results/${id}-PRODUCT_SEALED.json`)),b=read(path.join(capture,relative));
  assert.equal(seal.path,relative);assert.equal(b.length,seal.bytes);assert.equal(sha(b),seal.sha256);return JSON.parse(b);
}
export function artifactLedger(capture){
  const entries=[];return{save(relative,value){assert(relative&&!path.isAbsolute(relative)&&!relative.split('/').includes('..'));const identity=save(path.join(capture,relative),value);entries.push({path:relative,...identity});return identity;},verify(){for(const item of entries){const b=read(path.join(capture,item.path));assert.equal(b.length,item.bytes);assert.equal(sha(b),item.sha256);}return entries.length;}};
}
function manifest(capture,planSha256){const files=walk(capture).filter(p=>!p.startsWith('runtime/')).map(p=>{const b=read(path.join(capture,p));return{path:p,bytes:b.length,sha256:sha(b)};});return save(path.join(capture,'manifest.json'),{schemaVersion:1,planSha256,files});}
export async function runFrozen(capture,planSha256){const plan=check(capture,planSha256);assert.equal(HERE,path.join(capture,'runtime',PREFIX));assert.equal(path.resolve(capture),plan.captureDirectory);const artifacts=artifactLedger(capture);artifacts.save('STARTED.json',{planSha256,startedAt:new Date().toISOString(),pid:process.pid});
  const rows=plan.cases.map(c=>({name:c.name,fork:c.fork,status:'unattempted',reason:'not_started'})),started=performance.now(),prepared=[],preparationClock=phaseClock(LIMITS.preparationMs),phaseTimings={preparation:null,geth:null};let fatal=null,sourceUnchanged=false,gethClock=null;
  const stable=()=>{check(capture,planSha256);const m=json(path.join(capture,'source-manifest.json'));assert.deepEqual(sourcePaths(plan.sourceRoot),m.files.map(f=>f.path));assert.deepEqual(m.files.map(f=>entry(plan.sourceRoot,f.path)),m.files);assert.deepEqual(sourceCommit(plan.sourceRoot,m.files.map(f=>f.path)),m.git);artifacts.verify();};
  try{
    for(const [i,c] of plan.cases.entries()){
      if(preparationClock.remaining()<=0){rows[i].reason='preparation_deadline';continue;}stable();const id=String(i+1).padStart(3,'0'),inputPath=path.join(capture,c.path),input=json(inputPath),worker=path.join(capture,'runtime',PREFIX,'worker.mjs');
      const launch=(mode,productPath)=>{assert.equal(sha(read(inputPath)),c.sha256);const remaining=preparationClock.remaining();if(remaining<=0)return null;const raw=rawProcess(process.execPath,[worker,mode,inputPath,...(productPath?[productPath]:[])],{cwd:path.join(capture,'runtime'),timeoutMs:Math.min(LIMITS.workerMs,remaining),maxBuffer:LIMITS.workerOutputBytes,env:{PATH:'/usr/bin:/bin'}});return{raw,result:parseWorker(raw)};};
      const product=launch('product');if(product===null){rows[i].reason='preparation_deadline';continue;}const productPath=path.join(capture,`results/${id}-product.json`),identity=artifacts.save(`results/${id}-product.json`,product);artifacts.save(`results/${id}-PRODUCT_SEALED.json`,{...identity,path:`results/${id}-product.json`,at:new Date().toISOString()});
      assert.deepEqual(readSealedProduct(capture,id),product);const reference=launch('reference',productPath);if(reference===null){rows[i].reason='preparation_deadline_after_product';continue;}assert.deepEqual(readSealedProduct(capture,id),product);artifacts.save(`results/${id}-reference.json`,reference);const agreement=fullVMAgreement(product,reference);artifacts.save(`results/${id}-fullVM-comparison.json`,agreement);
      const stateTest=wrapper(input,product,reference);if(!stateTest){rows[i]={...rows[i],status:'unavailable',reason:'no_complete_product_expectation',fullVM:agreement};continue;}
      const file=`geth-inputs/${id}.json`,binding=artifacts.save(file,{[c.name]:stateTest});prepared.push({index:i,input:file,binding,expected:{name:c.name,fork:c.fork,stateRoot:stateTest.post[c.fork][0].hash},fullVM:agreement});rows[i].reason='prepared';
    }
    artifacts.verify();artifacts.save('EXPECTATIONS_SEALED.json',{at:new Date().toISOString(),planSha256,prepared});stable();phaseTimings.preparation=preparationClock.terminal();assert.equal(phaseTimings.preparation.status,'within_budget','Preparation phase timing invalid');gethClock=phaseClock(LIMITS.gethTotalMs);
    for(const item of prepared){const i=item.index,c=plan.cases[i];let remaining=gethClock.remaining();if(remaining<=0){rows[i].reason='geth_deadline';continue;}const file=path.join(capture,item.input);assert.equal(sha(read(plan.geth.binary.path)),BINARY_SHA);assert.equal(sha(read(file)),item.binding.sha256);remaining=gethClock.remaining();if(remaining<=0){rows[i].reason='geth_deadline';continue;}
      const args=['statetest','--statetest.fork='+c.fork,'--run=^'+c.name+'$',file],raw=rawProcess(plan.geth.binary.path,args,{cwd:path.dirname(file),timeoutMs:Math.min(LIMITS.gethPerCaseMs,remaining),maxBuffer:LIMITS.gethOutputBytes,env:{PATH:'/usr/bin:/bin',GOMAXPROCS:'2',GOMEMLIMIT:'256MiB'}});raw.inputIdentity=item.binding;artifacts.save(`raw/${String(i+1).padStart(3,'0')}.json`,raw);rows[i]={name:c.name,fork:c.fork,...adjudicate(raw,item.expected),fullVM:item.fullVM};
    }stable();sourceUnchanged=true;phaseTimings.geth=gethClock.terminal();assert.equal(phaseTimings.geth.status,'within_budget','Geth phase timing invalid');
  }catch(error){fatal={name:error.name,message:String(error.message)};}
  phaseTimings.preparation??=preparationClock.terminal();if(gethClock)phaseTimings.geth??=gethClock.terminal();
  const result={schemaVersion:1,...packetVerdict({fatal,sourceUnchanged,phaseTimings}),planSha256,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-started,phaseTimings,sourceUnchanged,fatal,rows,counts:Object.fromEntries(['matched','mismatched','unavailable','unattempted'].map(s=>[s,rows.filter(r=>r.status===s).length])),scope:SCOPE};save(path.join(capture,'results.json'),result);const seal=manifest(capture,planSha256);return{...result,manifestSha256:seal.sha256};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const[command,dir,hash]=process.argv.slice(2),capture=path.resolve(dir??path.join(HERE,'capture'));if(command==='freeze')console.log(JSON.stringify(await freeze(capture),null,2));else if(command==='check')console.log(JSON.stringify({status:'verified',cases:check(capture,hash).cases.length}));else if(command==='run'){check(capture,hash);const archived=await import(pathToFileURL(path.join(capture,'runtime',PREFIX,'run.mjs')));console.log(JSON.stringify(await archived.runFrozen(capture,hash),null,2));}else throw Error('Use freeze DIR, check DIR PLAN_SHA, or run DIR PLAN_SHA; dispatch requires review.');}
