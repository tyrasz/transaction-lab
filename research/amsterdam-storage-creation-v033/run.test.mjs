// Input construction and fabricated evidence only. No product/VM/Geth dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IDS,SYSTEM,PRODUCT_LIMITS,declaration,fixture} from './cases.mjs';
import {sha,save,sourcePaths,dependencyIdentity,PREFIX} from './archive.mjs';
import {LIMITS,SCOPE,validTime,validProcess,validProcessBounds,rawBytes,observation,scanOutput,OutputBoundsError,readSealed,exactInventory} from './run.mjs';
import {allocationRoot,applyDelta,normalizeAllocation,targetObservation,behavior,compareObservations,parseTrace,gethObservation,word,bytes,hex} from './observations.mjs';
import {createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const pack=value=>{const b=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value));return{bytes:b.length,sha256:sha(b),base64:b.toString('base64')};};
const raw=()=>({process:{status:0,signal:null,error:null,timeoutMs:15000,wallElapsedMs:2,elapsedMs:2},stdout:pack({fabricated:true}),stderr:pack('')});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'storage-creation-preparation-'));
test('all six fixed declarations retain exact original allocations and only add disclosed STOP scaffolding',async()=>{
 assert.deepEqual(IDS,['root_create_storage_only','internal_create2_storage_only','root_create_absent','internal_create2_absent','root_create_empty_storage','internal_create2_empty_storage']);
 for(let i=0;i<6;i++){const d=await declaration(i);assert.equal(d.index,i);assert.equal(d.chainId,11155111);assert.equal(d.fork,'Amsterdam');assert.equal(await allocationRoot(d.allocation),d.initialStateRoot);assert.equal(await allocationRoot(d.originalAllocation),d.originalStateRoot);
  assert.deepEqual(Object.keys(d.allocation).filter(a=>!Object.hasOwn(d.originalAllocation,a)).sort(),[...SYSTEM].sort());for(const[a,row]of Object.entries(d.originalAllocation))assert.deepEqual(d.allocation[a],row);
  for(const a of SYSTEM)assert.deepEqual(d.allocation[a],{nonce:'0x1',balance:'0x0',code:'0x00',storage:{}});
  const target=d.allocation[d.target];if(d.collision==='absent')assert.equal(target,undefined);else{assert.equal(target.balance,'0x11');assert.equal(target.nonce,'0x0');assert.equal(target.code,'0x');assert.deepEqual(target.storage,d.collision==='storage'?{[word(0)]:word(999),[word(991)]:word(123456)}:{});}
  assert.equal(d.environment.currentExcessBlobGas,d.header.excessBlobGas);assert.equal(d.environment.slotNumber,d.header.slotNumber);assert.equal(d.environment.currentNumber,d.header.number);assert.equal(d.environment.currentGasLimit,d.header.gasLimit);assert.equal(d.environment.currentTimestamp,d.header.timestamp);assert.equal(d.environment.currentBaseFee,d.header.baseFeePerGas);assert.equal(d.environment.currentRandom,d.header.mixHash);assert.equal(d.environment.currentCoinbase,d.header.miner);assert.deepEqual(d.environment.withdrawals,[]);
 }
});
test('signed type2 bytes bind exact product envelope and header network with no authorization or blobs',async()=>{
 for(let i=0;i<6;i++){const d=await declaration(i),f=await fixture(i),tx=createTxFromRLP(bytes(d.signedBytes),{common:f.common});assert.equal(tx.type,2);assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),d.request.from);assert.equal(tx.nonce,1n);assert.equal(tx.common.chainId(),11155111n);assert.equal(tx.to?.toString()??null,d.request.to);assert.equal(hex(tx.data),d.request.data);assert.equal(tx.value,BigInt(d.request.value));assert.equal(tx.gasLimit,BigInt(d.request.gas));assert(tx.gasLimit<=5000000n);assert.equal(tx.maxFeePerGas,13n);assert.equal(tx.maxPriorityFeePerGas,3n);assert.equal(hex(tx.hash()),d.transactionHash);assert.equal(hex(RLP.encode([bytes(d.signedBytes)])),d.transactionBody);assert.equal(tx.authorizationList,undefined);assert.equal(tx.blobVersionedHashes,undefined);assert.equal(d.request.authorizationList,undefined);
  if(d.rootCreate)assert.equal(d.request.data,d.sentinel.initcode);
 }
});
test('actual delta application requires original balances and storage and preserves 32-byte slot encoding',async()=>{
 const d=await declaration(0),a=d.target;assert.equal(await allocationRoot(applyDelta(d.allocation,{accounts:[]})),d.initialStateRoot);
 const changes={accounts:[{address:a,balance:{before:'17',after:'22'},storage:[{slot:word(1),before:'0',after:'123456'},{slot:word(2),before:'0',after:'42'}]}]};
 const out=applyDelta(d.allocation,changes);assert.equal(out[a].storage[word(991)],word(123456));assert.equal(out[a].storage[word(1)],word(123456));assert.notEqual(await allocationRoot(out),d.initialStateRoot);
 for(const modify of[c=>c.accounts[0].balance.before='18',c=>c.accounts[0].storage[0].before='1',c=>c.accounts[0].reset={},c=>c.accounts.push(c.accounts[0])]){const c=structuredClone(changes);modify(c);assert.throws(()=>applyDelta(d.allocation,c));}
 assert.throws(()=>normalizeAllocation({[a]:{storage:{[word(0)]:word(2n**256n)}}}));
});
test('fabricated sentinel states distinguish hypotheses without asserting an observed winner',async()=>{
 const d=await declaration(0),allocation=structuredClone(d.allocation);assert.equal(behavior(d,targetObservation(d,allocation)),'not_deployed');
 allocation[d.target].code=d.sentinel.runtime;allocation[d.target].storage[word(1)]=word(123456);allocation[d.target].storage[word(2)]=word(42);assert.equal(behavior(d,targetObservation(d,allocation)),'deployed_preserving_initial_storage');
 allocation[d.target].storage={[word(2)]:word(42)};assert.equal(behavior(d,targetObservation(d,allocation)),'deployed_clearing_initial_storage');assert.equal(behavior(d,null),null);
 assert.equal(SCOPE.eels,'source_only_no_runner_executed');assert.equal(SCOPE.canonicalWinnerSelected,false);assert.equal(SCOPE.populationCoverage,false);
});
test('unsupported rollback and missing channels never produce pairwise matches',()=>{
 const a={completedExecution:true,executionStatus:'success',returnData:'0x',gasUsed:'1',singleTransactionBlockGasUsed:'1',stateRoot:'x',target:{},logs:[]};
 let pairs=compareObservations({product:null,ethereumjs:a,geth:a});assert(Object.values(pairs.product_geth).every(v=>v===null));assert(Object.values(pairs.ethereumjs_geth).every(v=>v===true));
 for(const p of[{...a,executionStatus:'unsupported'}, {...a,completedExecution:false},{}])assert(Object.values(compareObservations({product:p,ethereumjs:a,geth:a}).product_geth).every(v=>v===null));
 const b={...a,gasUsed:undefined,returnData:'0x01'};pairs=compareObservations({product:a,ethereumjs:a,geth:b});assert.equal(pairs.product_geth.gasUsed,null);assert.equal(pairs.product_geth.returnData,false);
});
async function fabricated(){const d=await declaration(2),trace=Buffer.from(JSON.stringify({type:'CREATE',from:d.request.from,to:d.target,value:'0x'+BigInt(d.request.value).toString(16),input:d.request.data,gas:'0x'+BigInt(d.inputGas.gethRootGas).toString(16)})+'\n'+JSON.stringify({output:'',gasUsed:'0x0'})+'\n');
 return{d,o:{allocation:d.allocation,body:d.transactionBody,trace,result:{stateRoot:d.initialStateRoot,logsHash:hex(keccak_256(RLP.encode([]))),requests:[],blobGasUsed:'0x0',currentBaseFee:d.header.baseFeePerGas,gasUsed:'0x3000',receipts:[{type:'0x2',transactionHash:d.transactionHash,transactionIndex:'0x0',blockNumber:d.header.number,status:'0x1',gasUsed:'0x3000',cumulativeGasUsed:'0x3000',logs:[]}]}}};}
test('fabricated Geth evidence binds signed input, receipt, root trace, full allocation and log hash',async()=>{
 const{d,o}=await fabricated(),got=await gethObservation(d,o);assert.equal(got.stateRoot,d.initialStateRoot);assert.equal(got.regularGasUsed,null);assert.equal(got.executionStatus,'success');
 for(const mutate of[x=>x.body='0x',x=>x.result.receipts[0].transactionHash='0x'+'00'.repeat(32),x=>x.result.receipts[0].type='0x4',x=>x.result.receipts[0].status='0x0',x=>x.result.stateRoot='0x'+'00'.repeat(32),x=>x.result.logsHash='0x'+'00'.repeat(32),x=>x.allocation[SYSTEM[0]].code='0x01',x=>x.result.rejected=[{error:'invalid'}],x=>x.result.requests=['0x01']]){const x=structuredClone(o);x.trace=Buffer.from(x.trace);mutate(x);await assert.rejects(gethObservation(d,x));}
 const trace=o.trace.toString();assert.throws(()=>parseTrace(Buffer.from(trace.replace(d.request.from,d.target)),d));assert.throws(()=>parseTrace(Buffer.from(trace.trim()),d));assert.throws(()=>parseTrace(Buffer.from([255]),d));
 for(const mutate of[rows=>rows[0].gas='0x1',rows=>rows[1].error={},rows=>rows[1].error='']){const rows=trace.trim().split('\n').map(JSON.parse);mutate(rows);assert.throws(()=>parseTrace(Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'),d));}
 for(const field of['address','topics','data']){const x=structuredClone(o);x.trace=Buffer.from(x.trace);x.result.receipts[0].logs=[{address:d.request.from,topics:[],data:'0x',transactionHash:d.transactionHash,transactionIndex:'0x0',logIndex:'0x0',blockNumber:d.header.number,[field]:field==='topics'?['0x01']:'malformed'}];await assert.rejects(gethObservation(d,x));}
});
test('raw bytes, strict UTF8, exit status, signals and process bounds are independently required',()=>{
 const r=raw();assert.deepEqual(observation(r),{fabricated:true});for(const p of[{status:1},{signal:'SIGKILL'},{error:{code:'X'}}])assert.equal(validProcess({...r,process:{...r.process,...p}}),false);
 for(const p of[{timeoutMs:0},{timeoutMs:15001},{elapsedMs:15001},{wallElapsedMs:-1},{wallElapsedMs:Infinity},{error:{code:'ENOBUFS'}}])assert.equal(validProcessBounds({...r,process:{...r.process,...p}}),false);
 for(const p of[{bytes:r.stdout.bytes+1},{sha256:'0'.repeat(64)},{base64:r.stdout.base64+'!'}])assert.throws(()=>rawBytes({...r.stdout,...p}));assert.throws(()=>observation({...r,stdout:pack(Buffer.from([255]))}));
 assert(!validTime(240001,1,LIMITS.totalMs));assert(!validTime(1,NaN,LIMITS.totalMs));assert.equal(PRODUCT_LIMITS.wallMs,10000);assert.equal(LIMITS.productProcesses,6);assert.equal(LIMITS.ethereumJsProcesses,6);assert.equal(LIMITS.gethProcesses,6);
});
test('file caps and immutable preclient seals reject mutation, symlink and excessive output',()=>{
 const dir=temp();try{const s=save(path.join(dir,'raw.json'),raw());save(path.join(dir,'raw.json.seal.json'),s);exactInventory(dir,['raw.json','raw.json.seal.json']);fs.writeFileSync(path.join(dir,'extra'),'x');assert.throws(()=>exactInventory(dir,['raw.json','raw.json.seal.json']));fs.unlinkSync(path.join(dir,'extra'));assert.deepEqual(observation(readSealed(dir,'raw.json')),{fabricated:true});fs.appendFileSync(path.join(dir,'raw.json'),' ');assert.throws(()=>readSealed(dir,'raw.json'));assert.throws(()=>save(path.join(dir,'raw.json'),{}));
  const out=path.join(dir,'out');fs.mkdirSync(out);fs.writeFileSync(path.join(out,'a'),'x');assert.equal(scanOutput(out,0).totalBytes,1);assert.throws(()=>scanOutput(out,LIMITS.totalOutputBytes),OutputBoundsError);fs.symlinkSync('a',path.join(out,'b'));assert.throws(()=>scanOutput(out,0),OutputBoundsError);fs.unlinkSync(path.join(out,'b'));fs.truncateSync(path.join(out,'a'),LIMITS.outputFileBytes+1);assert.throws(()=>scanOutput(out,0),OutputBoundsError);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('source closure includes new guards, fixture and source notes with exact sealed dependency identities',()=>{
 const paths=sourcePaths(root),set=new Set(paths);for(const p of['engines/local-evm/creation-support.js','engines/local-evm/amsterdam-authorization-validation.js','engines/local-evm/test/amsterdam-storage-collision-fixture.js',PREFIX+'/SOURCES.md',PREFIX+'/source-notes.json'])assert(set.has(p),p);
 const deps=dependencyIdentity(root);assert.equal(deps.files.length,3841);for(const p of paths){const b=fs.readFileSync(path.join(root,p));if(!/\.(?:m?js)$/.test(p))continue;for(const m of b.toString().matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;const target=path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1]));assert(set.has(target)||target.includes('/node_modules/'),p+' -> '+target);}}
 assert.equal(sha(fs.readFileSync(path.join(root,'engines/local-evm/test/amsterdam-storage-collision-fixture.js'))),'1b761ef7bc407c6d55dddf44c2a1379837259cd8594a386f0b71b655861ad526');
});
