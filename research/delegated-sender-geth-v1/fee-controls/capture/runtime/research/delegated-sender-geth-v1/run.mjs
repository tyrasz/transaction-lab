// Fixed synthetic development controls, never a population accuracy estimate.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Common, Mainnet, Hardfork } from '../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createTx } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/fixture-evm/node_modules/@noble/hashes/sha3.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SHA='7b5bf7a815934953951908002cac69c1b74ae5a3d7ddd0dfc652b65a1a40959a';
const BINARY_SHA='10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521';
const BINARY=path.resolve(HERE,'../../../evm-toolchains/geth-v1.17.10/bin/evm');
const LIMITS={cases:14,perCaseMs:5000,totalMs:120000,outputBytes:1048576};
export const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const scope={syntheticDevelopment:true,expectedSource:'frozen_export_claiming_full_VM_and_product_delta_roots',productSourceProvenanceEstablished:false,independentOpcodeImplementation:'Geth_v1.17.10_1df30b18d9ed35ee9d28ffd4648442c2204554ad',compared:['full_poststate_root','Geth_internal_log_hash_assertion'],gasReturnReceiptCompared:false,originalTransactionReplay:false,publicRpc:0,populationAccuracy:false,retries:0};
function save(p,value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{bytes:b.length,sha256:sha(b)};}
const logsHash=logs=>bytesToHex(keccak_256(RLP.encode(logs.map(l=>[hexToBytes(l.address),l.topics.map(hexToBytes),hexToBytes(l.data)]))));
function scan(code){if(/^0xef0100[0-9a-f]{40}$/.test(code))return;const b=hexToBytes(code);for(let pc=0;pc<b.length;pc++){const op=b[pc];assert(![0x40,0x49,0x4a].includes(op),'Unmatched BLOCKHASH/blob context');if(op>=0x60&&op<=0x7f)pc+=op-0x5f;}}
export async function validateFixture(c){
  assert.match(c.name,/^[a-z0-9_]+$/);assert(['Osaka','Prague'].includes(c.fork));
  const common=new Common({chain:Mainnet,hardfork:Hardfork[c.fork]}),f=c.stateTest,h=c.header,r=c.request,p=f.post[c.fork][0];
  assert.deepEqual(Object.keys(f.post),[c.fork]);assert.equal(f.post[c.fork].length,1);assert(!Object.hasOwn(p,'expectException'));
  assert.equal(verifyEthereumHeader({header:h,expectedHash:h.hash}).hardfork,c.fork.toLowerCase());
  const state=await loadState(f.pre,common);assert.equal(bytesToHex(await state.getStateRoot()),h.stateRoot);
  const env={currentCoinbase:h.miner,currentDifficulty:h.difficulty,currentRandom:h.mixHash,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentBaseFee:h.baseFeePerGas,currentExcessBlobGas:h.excessBlobGas};assert.deepEqual(f.env,env);assert.equal(BigInt(h.baseFeePerGas),0n);
  const t=f.transaction;assert.equal(t.sender,r.from);assert.equal(t.to,r.to??'');assert.deepEqual(t.data,[r.data]);assert.equal(BigInt(t.value[0]),BigInt(r.value));assert.equal(BigInt(t.gasLimit[0]),BigInt(r.gas));assert.equal(BigInt(t.gasPrice),0n);assert.equal(BigInt(t.nonce),BigInt(f.pre[r.from].nonce));
  assert.deepEqual(p.indexes,{data:0,gas:0,value:0});
  const tx=createTx({type:0,nonce:BigInt(t.nonce),gasLimit:BigInt(r.gas),gasPrice:0n,to:r.to??undefined,value:BigInt(r.value),data:r.data},{common}).sign(hexToBytes(t.secretKey));assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),r.from);assert.equal(bytesToHex(tx.serialize()),p.txbytes);
  assert.equal(p.hash,c.fullVM.stateRoot);assert.equal(p.hash,c.product.appliedStateRoot);assert.equal(p.logs,c.fullVM.logsHash);assert.equal(p.logs,logsHash(c.product.output.logs));assert.equal(c.product.output.gasAccounting.gasUsed,c.fullVM.gasUsed);assert.equal(c.product.output.execution.status,c.fullVM.execution==='revert'?'reverted':c.fullVM.execution);
  for(const a of Object.values(f.pre))scan(a.code);
  function frames(frame){if(['CREATE','CREATE2'].includes(frame.type)){scan(frame.input);scan(frame.output);}frame.calls.forEach(frames);}frames(c.product.output.trace);
  return {name:c.name,fork:c.fork,stateRoot:p.hash,logsHash:p.logs};
}
export function adjudicate(raw,expected){
  if(raw.error!==null||raw.exitCode!==0||raw.signal!==null||!Number.isInteger(raw.timeoutMs)||raw.timeoutMs<=0||raw.timeoutMs>LIMITS.perCaseMs||!Number.isFinite(raw.elapsedMs)||raw.elapsedMs<0||raw.elapsedMs>raw.timeoutMs)return{status:'unavailable',reason:raw.error??'process_or_time_failure'};
  try{for(const stream of [raw.stdout,raw.stderr]){const b=Buffer.from(stream.base64,'base64');assert.equal(b.length,stream.bytes);assert.equal(sha(b),stream.sha256);}const bytes=Buffer.from(raw.stdout.base64,'base64');assert(bytes.length+raw.stderr.bytes<=LIMITS.outputBytes);
    const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assert(Array.isArray(rows)&&rows.length===1);const r=rows[0];assert.equal(r.name,expected.name);assert.equal(r.fork,expected.fork);assert.equal(typeof r.pass,'boolean');assert(Object.keys(r).every(k=>['name','fork','pass','stateRoot','error'].includes(k)));assert.match(r.stateRoot,/^0x[0-9a-f]{64}$/);if(r.pass)assert.equal(r.error,undefined);
    return{status:r.pass&&r.stateRoot===expected.stateRoot?'matched':'mismatched',checks:{stateRoot:r.stateRoot===expected.stateRoot,internalLogHash:r.pass},result:r};
  }catch{return{status:'unavailable',reason:'invalid_or_foreign_result'};}
}
export function dispatch(c,input,timeoutMs=LIMITS.perCaseMs){
  assert(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=LIMITS.perCaseMs);
  const args=['statetest','--statetest.fork='+c.fork,'--run=^'+c.name+'$',input],start=performance.now();
  const r=spawnSync(BINARY,args,{cwd:path.dirname(input),env:{PATH:'/usr/bin:/bin',GOMAXPROCS:'2',GOMEMLIMIT:'256MiB'},stdio:['ignore','pipe','pipe'],timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer:LIMITS.outputBytes});
  const streams=Object.fromEntries(['stdout','stderr'].map(k=>{const b=r[k]??Buffer.alloc(0);return[k,{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)}];}));
  return{args,exitCode:r.status,signal:r.signal,error:r.error?.code??null,elapsedMs:performance.now()-start,timeoutMs,...streams,processCompletion:'spawnSync_returned_after_child_and_pipes_closed'};
}
export async function run(){
  assert.equal(sha(read(path.join(HERE,'fixtures.json'))),FIXTURE_SHA);assert.equal(sha(read(BINARY)),BINARY_SHA);
  const capture=path.join(HERE,'capture');assert(!fs.existsSync(capture),'No overwrite or retry');
  const fixture=json(path.join(HERE,'fixtures.json'));assert.equal(fixture.cases.length,LIMITS.cases);assert.equal(new Set(fixture.cases.map(c=>c.name)).size,LIMITS.cases);
  const cases=[];for(const c of fixture.cases)cases.push(await validateFixture(c));
  const sources=Object.fromEntries(['run.mjs','fixtures.json','generator.mjs'].map(n=>[n,sha(read(path.join(HERE,n)))]));
  const plan={schemaVersion:1,startedAt:new Date().toISOString(),limits:LIMITS,scope,binary:BINARY,binarySha256:BINARY_SHA,node:process.version,sources,cases};save(path.join(capture,'PLAN.json'),plan);
  const start=performance.now(),results=[];for(let i=0;i<cases.length;i++){
    const expected=cases[i],c=fixture.cases[i],input=path.join(capture,'inputs',String(i+1).padStart(3,'0')+'.json');const inputIdentity=save(input,{[c.name]:c.stateTest});
    if(performance.now()-start>=LIMITS.totalMs){results.push({name:c.name,status:'unattempted',reason:'global_deadline'});continue;}
    assert.equal(sha(read(BINARY)),BINARY_SHA);assert.equal(sha(read(input)),inputIdentity.sha256);const remaining=Math.floor(LIMITS.totalMs-(performance.now()-start));if(remaining<=0){results.push({name:c.name,status:'unattempted',reason:'global_deadline'});continue;}const raw=dispatch(c,input,Math.min(LIMITS.perCaseMs,remaining));raw.inputIdentity=inputIdentity;save(path.join(capture,'raw',String(i+1).padStart(3,'0')+'.json'),raw);results.push({name:c.name,fork:c.fork,...adjudicate(raw,expected)});
  }
  assert.equal(sha(read(BINARY)),BINARY_SHA);for(const[n,s]of Object.entries(sources))assert.equal(sha(read(path.join(HERE,n))),s);
  const report={schemaVersion:1,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-start,sourceUnchanged:true,results,counts:Object.fromEntries(['matched','mismatched','unavailable','unattempted'].map(s=>[s,results.filter(r=>r.status===s).length])),scope};save(path.join(capture,'results.json'),report);
  const paths=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else{assert(e.isFile());paths.push(p);}}}walk(capture);
  const manifest=paths.sort().map(p=>{const b=read(p);return{path:path.relative(capture,p),bytes:b.length,sha256:sha(b)};});const seal=save(path.join(capture,'manifest.json'),{planSha256:sha(read(path.join(capture,'PLAN.json'))),files:manifest});return{counts:report.counts,elapsedMs:report.elapsedMs,manifestSha256:seal.sha256,scope};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.equal(process.argv[2],'run');console.log(JSON.stringify(await run(),null,2));}
