// Saved artifacts only: no EVM/client execution, subprocess, RPC, or expected-state input.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
export const ROOT=path.resolve(HERE,'../../..');
const FAMILY='research/storage-creation-v035/eels-comparison',OLD='research/amsterdam-storage-creation-v033',SUP='research/amsterdam-root-creation-v033';
export const PINS=Object.freeze({plan:'0e74b7cf84737bb47e750404a8dd67cc12153dda5e95a2fda32f9fde5166f591',manifest:'0e56b466ed87ee7eeaf2d656598df87123d08c0ff588f89131e06f7eb881b390',toolchain:'5e67873833811992160173737d5c6f229dad327281e7e915ecce206cac4cb005'});
const OLD_PINS={manifest:'0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9',plan:'f5ce939bf9238d1ff52e5a22ff2596459e82faa67da053f6758c864f68ed69fe',source:'8d5c2e8dfa1ab8229a194ad5fc616f1bbf68cacc863cd36c46234476ba705444'};
const SUP_PINS={manifest:'0280a9e08de06a13ab163f8f7eaec07c65a05b3036058e4095c5a59f1ab0efbd',plan:'5b122fd04fc426f4f8cca9ae279fd182993ec21ed587ce7208497c8a92e1fcc9',source:'9ee836216994116e571a9f6535ac2f30f2a4f5d3ffc5c12242439be34607b466'};
const REVIEW_SOURCES={[OLD+'/review.mjs']:'1f8f2cc7ccff3672136a42cc074faecd81e43ca33904cfde880366d87ae67183',[SUP+'/verify.mjs']:'f00da79b9cfc2ca51c7b17879abcc338a9a62a805f6b07b186bb2ff1bdab25e0',[SUP+'/protocol.mjs']:'a87d157b22d1216435a44c90004240cf3a8fd1c218a8234f17323b8291292ba3'};
export const CHANNELS=Object.freeze(['executionStatus','returnData','chargedGas','singleTransactionBlockGasUsed','stateRoot','target','logs']);
const LIMITS={cases:6,fileBytes:67108864,inventoryBytes:536870912,inventoryFiles:30000,outputBytes:2097152,processSeconds:15,totalSeconds:180};
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const hex=b=>'0x'+Buffer.from(b).toString('hex'),bytes=s=>Uint8Array.from(Buffer.from(s.slice(2),'hex'));
const address=x=>{assert.match(x,/^0x[0-9a-f]{40}$/);return x;},word=x=>{assert.match(x,/^0x[0-9a-f]{64}$/);return x;};
function data(x){assert.equal(typeof x,'string');assert.match(x,/^0x(?:[0-9a-f]{2})*$/);return x;}
function decimal(x,max=(1n<<256n)-1n){assert.equal(typeof x,'string');assert.match(x,/^(?:0|[1-9][0-9]*)$/);const n=BigInt(x);assert(n<=max);return n;}
function quantity(x,max=(1n<<256n)-1n){assert.equal(typeof x,'string');assert.match(x,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);const n=BigInt(x);assert(n<=max);return n;}
function fields(x,keys){assert(x&&typeof x==='object'&&!Array.isArray(x));assert.deepEqual(Object.keys(x).sort(),[...keys].sort());}
const validTime=(v,max)=>Number.isFinite(v)&&v>=0&&v<=max;
function inventory(root,omit=[]){const out=[];function walk(rel=''){for(const name of fs.readdirSync(path.join(root,rel)).sort()){if(!rel&&omit.includes(name))continue;const p=rel?rel+'/'+name:name,s=fs.lstatSync(path.join(root,p));if(s.isDirectory()){assert(!s.isSymbolicLink());walk(p);}else out.push(p);}}walk();return out.sort();}
function entry(file,relative){const s=fs.lstatSync(file);if(s.isSymbolicLink()){const resolved=fs.realpathSync(file);assert(fs.statSync(resolved).isFile()&&fs.statSync(resolved).size<=LIMITS.fileBytes);return{path:relative,kind:'symlink',target:fs.readlinkSync(file),resolved,resolvedSha256:sha(read(resolved))};}assert(s.isFile()&&s.size<=LIMITS.fileBytes);return{path:relative,kind:'file',bytes:s.size,mode:s.mode&511,sha256:sha(read(file))};}
function checkRows(base,rows){assert(rows.length<=LIMITS.inventoryFiles);assert.equal(new Set(rows.map(r=>r.path)).size,rows.length);assert(rows.reduce((n,r)=>n+(r.bytes??0),0)<=LIMITS.inventoryBytes);for(const r of rows){assert(r.path&&!path.isAbsolute(r.path)&&!r.path.split('/').includes('..'));assert.deepEqual(entry(path.join(base,r.path),r.path),r);}}
function checkTree(base,rows,omit=[]){checkRows(base,rows);assert.deepEqual(inventory(base,omit),rows.map(r=>r.path).sort());}
function pinned(file,pin){assert.match(pin,/^[a-f0-9]{64}$/);assert.equal(sha(read(file)),pin);}

export async function primitives(root=ROOT){
 const runtime=path.join(root,OLD,'capture/runtime'),imp=p=>import(pathToFileURL(path.join(runtime,p)).href);
 const observations=await imp(OLD+'/observations.mjs');
 const {RLP}=await imp('engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js');
 const {keccak_256:keccak}=await imp('engines/local-evm/node_modules/@noble/hashes/sha3.js');
 const {createMPT}=await imp('engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js');
 return{...observations,RLP,keccak,createMPT};
}

export async function eelsObservation(input,out,crypto){
 const {allocationRoot,targetObservation,behavior,RLP,keccak,createMPT}=crypto;
 assert.equal(out.status,'completed');assert.equal(out.id,input.id);assert.equal(out.signedBytes,input.signedBytes);assert.equal(out.transactionHash,input.transactionHash);assert.equal(out.sender,input.request.from);
 assert.deepEqual(out.envelope,input.transaction);assert.deepEqual(out.environment,input.environment);
 for(const name of ['initialStateRoot','originalStateRoot','initialTargetStorageRoot'])assert.equal(out[name],input[name]);
 assert.equal(out.intrinsicGas,input.inputGas.intrinsic);decimal(out.calldataFloor,BigInt(input.request.gas));
 assert.equal(out.headerValidation,'declared_environment_only_not_full_block_validation');assert.equal(out.blockHashContext,'declared_parent_hash_only_no_earlier_hashes_supplied');
 assert.equal(out.scope,'one_signed_transaction_in_stock_Amsterdam_apply_body_with_declared_system_scaffold_and_empty_withdrawals');
 const allocation=out.allocation;assert(allocation&&typeof allocation==='object'&&!Array.isArray(allocation));assert(Object.keys(allocation).length<=64);let slots=0;
 for(const[a,row]of Object.entries(allocation)){address(a);fields(row,['nonce','balance','code','storage']);quantity(row.nonce,(1n<<64n)-1n);quantity(row.balance);data(row.code);assert(row.code.length<=131074);assert(row.storage&&typeof row.storage==='object'&&!Array.isArray(row.storage));for(const[k,v]of Object.entries(row.storage)){word(k);word(v);assert(BigInt(v)>0n);assert(++slots<=1024);}}
 assert.equal(await allocationRoot(allocation),word(out.stateRoot));
 for(const a of input.amendment.addresses)assert.deepEqual(allocation[a],input.allocation[a]);
 const target=targetObservation(input,allocation);assert.equal(out.target.address,input.target);assert.deepEqual(out.target.account,allocation[input.target]??null);
 assert.deepEqual(out.target.storage,Object.fromEntries(input.sentinel.slots.map(k=>[k,target.exists?target.slots[k]:'0'])));
 assert(Array.isArray(out.storageClears)&&out.storageClears.length<=64);assert.deepEqual(out.storageClears,[...new Set(out.storageClears)].sort());out.storageClears.forEach(address);
 fields(out.receipt,['status','chargedGas','logs']);assert(['success','failed'].includes(out.receipt.status));const charged=decimal(out.receipt.chargedGas,BigInt(input.request.gas));
 const regular=decimal(out.blockExecutionGasUsed,BigInt(input.request.gas)),state=decimal(out.blockStateGasUsed,BigInt(input.request.gas));assert.equal(decimal(out.blockGasUsed,BigInt(input.request.gas)),regular>state?regular:state);
 const logs=out.receipt.logs;assert(Array.isArray(logs)&&logs.length<=1024);for(const l of logs){fields(l,['address','topics','data']);address(l.address);assert(Array.isArray(l.topics)&&l.topics.length<=4);l.topics.forEach(word);data(l.data);assert(l.data.length<=131074);}
 const logRlp=logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]);
 assert.equal(hex(keccak(RLP.encode(logRlp))),word(out.logsHash));
 const bloom=Buffer.alloc(256);for(const l of logs)for(const v of[l.address,...l.topics]){const h=keccak(bytes(v));for(let j=0;j<6;j+=2){const n=((h[j]<<8)|h[j+1])&2047;bloom[255-(n>>3)]|=1<<(n&7);}}
 const receipt=bytes(data(out.receiptBytes));assert.equal(receipt[0],2);const decoded=RLP.decode(receipt.slice(1));assert(Array.isArray(decoded)&&decoded.length===4);assert.equal(hex(RLP.encode(decoded)),hex(receipt.slice(1)));
 assert.equal(hex(decoded[0]),out.receipt.status==='success'?'0x01':'0x');const gas=charged===0n?'':charged.toString(16).padStart(Math.ceil(charged.toString(16).length/2)*2,'0');assert.equal(hex(decoded[1]),'0x'+gas);assert.equal(hex(decoded[2]),hex(bloom));assert.deepEqual(decoded[3],logRlp);
 for(const [payload,reported]of[[receipt,out.receiptsRoot],[bytes(input.signedBytes),out.transactionsRoot]]){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);assert.equal(hex(trie.root()),word(reported));}
 assert.deepEqual(out.requests,[]);
 let executionStatus=out.receipt.status==='success'?'success':'failed',returnData=null;
 if(out.transactionEnd===null)assert.equal(out.returnDataAvailability,'unavailable_no_TransactionEnd_event');
 else{const t=out.transactionEnd;fields(t,['error','gasUsed','returnData']);assert.equal(out.returnDataAvailability,'official_TransactionEnd');assert.match(t.gasUsed,/^-?(?:0|[1-9][0-9]*)$/);returnData=data(t.returnData);assert.equal(t.error===null,out.receipt.status==='success');if(t.error!==null){fields(t.error,['type','message']);assert.equal(typeof t.error.type,'string');assert.equal(typeof t.error.message,'string');assert(t.error.message.length<=2048);if(t.error.type==='Revert')executionStatus='reverted';}}
 return{completedExecution:true,executionStatus,returnData,chargedGas:charged.toString(),singleTransactionBlockGasUsed:out.blockGasUsed,stateRoot:out.stateRoot,target,logs,targetBehavior:behavior(input,target),blockExecutionGasUsed:out.blockExecutionGasUsed,blockStateGasUsed:out.blockStateGasUsed,transactionEnd:out.transactionEnd};
}

function oldObservation(row){const o=row?.observation;return o?{...o,chargedGas:o.gasUsed}:null;}
export function comparePair(a,b){return Object.fromEntries(CHANNELS.map(k=>[k,!a?.completedExecution||!b?.completedExecution||a[k]==null||b[k]==null?null:isDeepStrictEqual(a[k],b[k])]));}

export async function compareSaved({root=ROOT,capture=path.join(root,FAMILY,'capture'),pins=PINS}={}){
 for(const[f,h]of Object.entries(REVIEW_SOURCES))pinned(path.join(root,f),h);
 for(const [family,expected]of[[OLD,OLD_PINS],[SUP,SUP_PINS]])for(const [key,file]of[['manifest','manifest.json'],['plan','plan.json'],['source','source-manifest.json']])pinned(path.join(root,family,'capture',file),expected[key]);
 const originalReview=await(await import(pathToFileURL(path.join(root,OLD,'review.mjs')).href)).verify(root);
 const supplementReview=await(await import(pathToFileURL(path.join(root,SUP,'verify.mjs')).href)).verify();
 assert.equal(supplementReview.manifestSha256,SUP_PINS.manifest);
 const oldResults=json(path.join(root,OLD,'capture/results.json')),suppResults=json(path.join(root,SUP,'capture/results.json'));
 const oldSource=json(path.join(root,OLD,'capture/source-manifest.json'));
 const at=p=>path.join(capture,p),j=p=>json(at(p));
 for(const[f,h]of[['manifest.json',pins.manifest],['plan.json',pins.plan],['toolchain.json',pins.toolchain]])pinned(at(f),h);
 const manifest=j('manifest.json'),plan=j('plan.json'),tc=j('toolchain.json'),results=j('results.json');
 assert.equal(manifest.planSha256,pins.plan);assert.deepEqual(plan.limits,LIMITS);assert.equal(plan.originalManifestSha256,OLD_PINS.manifest);assert.equal(plan.toolchainIdentity.sha256,pins.toolchain);assert.equal(plan.toolchainIdentity.bytes,read(at('toolchain.json')).length);
 checkRows(capture,manifest.files);assert.deepEqual(inventory(capture),[...manifest.files.map(r=>r.path),'manifest.json'].sort());checkRows(capture,[...plan.sources,...plan.inputs]);
 assert.deepEqual(plan.sources.map(r=>r.path),['worker.py','run.py','PLAN.md']);assert.deepEqual(plan.inputs.map(r=>r.path),Array.from({length:6},(_,i)=>'inputs/'+String(i+1).padStart(3,'0')+'.json'));
 for(const key of['source','venv'])checkTree(path.join(tc.toolchain,key),tc[key]);checkTree(tc.stdlibPath,tc.stdlib,['site-packages']);for(const row of tc.runtime)assert.deepEqual(entry(row.path,row.path),row);
 assert.equal(fs.existsSync(path.join(path.dirname(tc.stdlibPath),'python312.zip')),tc.stdlibZipExists);assert.equal(tc.python,path.join(tc.toolchain,'venv/bin/python'));
 const started=j('STARTED.json');assert.equal(started.planSha256,pins.plan);assert(Number.isFinite(started.atUnix)&&started.atUnix>=plan.createdAtUnix);
 assert.equal(results.rows.length,6);assert.deepEqual(results.rows.map(r=>r.index),[0,1,2,3,4,5]);
 const terminalBound=Object.values(results.elapsed).every(v=>validTime(v,LIMITS.totalSeconds));assert.equal(results.evidenceUsable,results.toolchainUnchanged&&terminalBound&&results.fatal===null);
 const crypto=await primitives(root),recordedCap=path.join(oldSource.sourceRoot,FAMILY,'capture'),rows=[];let total=0;
 for(let i=0;i<6;i++){
  const n=String(i+1).padStart(3,'0'),inputBytes=read(at('inputs/'+n+'.json')),input=JSON.parse(inputBytes),priorInput=read(path.join(root,OLD,'capture/inputs',n+'.json'));
  assert.deepEqual(inputBytes,priorInput);assert.equal(input.index,i);assert.equal(input.id,oldResults.rows[i].id);
  const prior=input.rootCreate?suppResults.rows.find(r=>r.index===i):oldResults.rows[i];assert.equal(prior.id,input.id);
  let observation=null,process=null,status='not_attempted';const result=results.rows[i];
  if(fs.existsSync(at(n+'-process.json'))){
   process=j(n+'-process.json');assert.deepEqual(process.argv,[tc.python,'-I','-B',path.join(recordedCap,'worker.py'),path.join(recordedCap,'inputs',n+'.json'),tc.toolchain]);
   assert(Number.isFinite(process.timeoutSeconds)&&process.timeoutSeconds>0&&process.timeoutSeconds<=15);assert.equal(process.stdout.path,n+'.stdout');assert.equal(process.stderr.path,n+'.stderr');checkRows(capture,[process.stdout,process.stderr]);
   const size=process.stdout.bytes+process.stderr.bytes;total+=size;
   const bounded=!process.limitTerminated&&size<=LIMITS.outputBytes&&Object.values(process.elapsed).every(v=>validTime(v,process.timeoutSeconds+1));assert.equal(process.bounded,bounded);
   const clean=process.returncode===0&&process.error===null&&bounded;
   status='unavailable';if(clean){const out=j(n+'.stdout');assert.equal(out.id,input.id);assert.equal(out.inputSha256,sha(inputBytes));assert.equal(out.sourceModule,path.join(tc.toolchain,'source/src/ethereum/forks/amsterdam/fork.py'));observation=await eelsObservation(input,out,crypto);status='observed';}
   assert.equal(result.status,status);
  }else assert.equal(result.status,'not_attempted');
  const peers=Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,oldObservation(prior[k])]));
  const usable=results.evidenceUsable?observation:null;
  rows.push({index:i,id:input.id,priorPacket:input.rootCreate?SUP:OLD,originalStatuses:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,oldResults.rows[i][k].status])),selectedPriorStatuses:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,prior[k].status])),eels:{status,observation,process},peers,comparisons:Object.fromEntries(Object.entries(peers).map(([k,v])=>['eels_'+k,comparePair(usable,v)]))});
 }
 assert.equal(total,results.totalRawBytes);assert.equal(results.unattempted,rows.filter(r=>r.eels.status==='not_attempted').length);
 checkRows(capture,manifest.files);pinned(at('manifest.json'),pins.manifest);
 const aggregate=Object.fromEntries(['product','ethereumjs','geth'].map(k=>{const comparisons=rows.map(r=>r.comparisons['eels_'+k]),all=comparisons.flatMap(Object.values);return[k,{matchedCases:comparisons.filter(c=>Object.values(c).every(v=>v===true)).length,mismatchedCases:comparisons.filter(c=>Object.values(c).some(v=>v===false)).length,unavailableCases:comparisons.filter(c=>Object.values(c).every(v=>v===null)).length,partialCases:comparisons.filter(c=>Object.values(c).includes(null)&&Object.values(c).includes(true)&&!Object.values(c).includes(false)).length,channels:{matched:all.filter(v=>v===true).length,mismatched:all.filter(v=>v===false).length,unavailable:all.filter(v=>v===null).length}}];}));
 return{kind:'saved_artifact_comparison',pins,oldPins:OLD_PINS,supplementPins:SUP_PINS,comparatorSha256:sha(read(fileURLToPath(import.meta.url))),sourceReviewPins:REVIEW_SOURCES,checks:{eelsEvidenceFiles:manifest.files.length,toolchainEntries:tc.source.length+tc.venv.length+tc.stdlib.length+tc.runtime.length,oldReview:originalReview.checks,supplementProcesses:supplementReview.rawProcesses,eelsReconstructedStateRoots:rows.filter(r=>r.eels.observation).length,rawBytes:total},evidenceUsable:results.evidenceUsable,channels:CHANNELS,aggregate,rows,limitations:['No target execution, subprocess or network occurred in this comparison.','Old artifact verifiers and archived JSONL parser/MPT/RLP primitives are reused; this is not an independent execution or wholly independent parser.','Old proof replies are joined to raw collector records and full initial allocation facts by the retained verifier, not independently re-walked here.','EELS source, venv, stdlib and Python files are external inventoried dependencies, checked at these recorded paths; OS libraries are not archived.','Root Node failures in the original capture remain preserved; only the explicitly separate root-wrapper observations supply root product/EthereumJS comparisons.','Unsupported product rollback roots are not execution predictions and all product comparison channels remain null for those cases.','TransactionEnd gas includes preparation/spill and is not compared to Geth root-frame gas. Charged gas and max(block execution gas, block state gas) are distinct channels.','Six known synthetic development inputs do not establish a canonical winner, all-fork coverage, deployed-chain reachability or population accuracy.']};
}

if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await compareSaved(),null,2));
