// Artifact-only review. No producer worker, EVM, subprocess, or network call.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const PREFIX='research/amsterdam-storage-creation-v033';
export const PINS=Object.freeze({
 plan:'f5ce939bf9238d1ff52e5a22ff2596459e82faa67da053f6758c864f68ed69fe',
 source:'8d5c2e8dfa1ab8229a194ad5fc616f1bbf68cacc863cd36c46234476ba705444',
 manifest:'0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9',
 dependencySource:'f60cfd73f3987ac3f1a7cc826251a44cf2a2f8b36dacbc7ebb0f1e818e0fcc41',
 binary:'10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521',
 toolchain:'791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333',
});
export const IDS=['root_create_storage_only','internal_create2_storage_only','root_create_absent','internal_create2_absent','root_create_empty_storage','internal_create2_empty_storage'];
const SYSTEM=['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282'];
const FIELDS=['executionStatus','returnData','gasUsed','singleTransactionBlockGasUsed','stateRoot','target','logs'];
export const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const bytes=h=>Uint8Array.from(Buffer.from(h.replace(/^0x/,''),'hex')),hex=b=>'0x'+Buffer.from(b).toString('hex');
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),q=n=>'0x'+BigInt(n).toString(16);
const integer=v=>{const n=BigInt(v);assert(n>=0n&&n<2n**256n);return n===0n?new Uint8Array():bytes(n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));};
const num=b=>b.length?BigInt(hex(b)):0n;
export const list=(dir,rel='')=>fs.readdirSync(path.join(dir,rel),{withFileTypes:true}).flatMap(e=>{const p=rel?rel+'/'+e.name:e.name;return e.isDirectory()?list(dir,p):[p];}).sort();
export function checkFiles(base,files){
 assert.equal(new Set(files.map(f=>f.path)).size,files.length);
 for(const f of files){assert(f.path&&!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'));const p=path.join(base,f.path),s=fs.lstatSync(p);
  if(f.kind==='file'){assert(s.isFile());assert.equal(s.size,f.bytes);assert.equal(s.mode&511,f.mode);assert.equal(sha(read(p)),f.sha256);}
  else{assert(['symlink','dependency_link'].includes(f.kind));assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),f.target);}
 }
}
export function rawBytes(s){const b=Buffer.from(s.base64,'base64');assert.equal(b.toString('base64'),s.base64);assert.equal(b.length,s.bytes);assert.equal(sha(b),s.sha256);return b;}
export function processRecord(raw){
 const p=raw.process;assert(Number.isSafeInteger(p.timeoutMs)&&p.timeoutMs>0&&p.timeoutMs<=15000);
 for(const n of[p.wallElapsedMs,p.elapsedMs])assert(Number.isFinite(n)&&n>=0&&n<=p.timeoutMs);
 assert.notEqual(p.error?.code,'ENOBUFS');const stdout=rawBytes(raw.stdout),stderr=rawBytes(raw.stderr);assert(stdout.length+stderr.length<=2097152);
 new TextDecoder('utf-8',{fatal:true}).decode(stderr);
 const clean=p.status===0&&p.signal===null&&p.error===null;
 return{clean,stdout,stderr,bytes:stdout.length+stderr.length};
}
export function normalize(alloc){
 const out={};for(const [key,row]of Object.entries(alloc)){const a=key.startsWith('0x')?key:'0x'+key;assert.match(a,/^0x[0-9a-f]{40}$/);assert(!Object.hasOwn(out,a));
  const code=row.code??'0x';assert.match(code,/^0x(?:[0-9a-f]{2})*$/);const storage={};
  for(const[k,v]of Object.entries(row.storage??{})){const slot=word(k.startsWith('0x')?k:'0x'+k);assert.equal(slot.length,66);integer(v);if(BigInt(v))storage[slot]=word(v);}
  integer(row.nonce??0);integer(row.balance??0);out[a]={nonce:q(row.nonce??0),balance:q(row.balance??0),code,storage};
 }return out;
}
export function applyDelta(initial,changes){
 const out=normalize(initial),seen=new Set();assert(Array.isArray(changes.accounts));
 for(const row of changes.accounts){assert.match(row.address,/^0x[0-9a-f]{40}$/);assert(!seen.has(row.address));seen.add(row.address);assert.equal(row.reset,undefined);
  const existed=Object.hasOwn(out,row.address),a=out[row.address]??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};
  if(row.existence)assert.equal(row.existence.before,existed);
  for(const k of['nonce','balance'])if(row[k])assert.equal(BigInt(row[k].before),BigInt(a[k]));if(row.code)assert.equal(row.code.before,a.code);
  const slots=new Set();for(const s of row.storage??[]){assert(!slots.has(word(s.slot)));slots.add(word(s.slot));assert.equal(BigInt(s.before),BigInt(a.storage[word(s.slot)]??0));}
  if(row.existence?.after===false){delete out[row.address];continue;}
  for(const k of['nonce','balance','code'])if(row[k])a[k]=row[k].after;
  for(const s of row.storage??[])if(BigInt(s.after))a.storage[word(s.slot)]=word(s.after);else delete a.storage[word(s.slot)];out[row.address]=a;
 }return normalize(out);
}
export function target(input,alloc){const a=normalize(alloc)[input.target];return{exists:!!a,nonce:a?BigInt(a.nonce).toString():null,balance:a?BigInt(a.balance).toString():null,code:a?.code??null,
 slots:Object.fromEntries(input.sentinel.slots.map(k=>[k,a?BigInt(a.storage[word(k)]??0).toString():null]))};}
export function behavior(input,t){if(!t)return null;if(t.code!==input.sentinel.runtime)return'not_deployed';if(input.collision!=='storage')return'deployed_control';
 if(t.slots['0']==='999'&&t.slots['1']==='123456'&&t.slots['2']==='42'&&t.slots['991']==='123456')return'deployed_preserving_initial_storage';
 if(t.slots['0']==='0'&&t.slots['1']==='0'&&t.slots['2']==='42'&&t.slots['991']==='0')return'deployed_clearing_initial_storage';return'other_deployed_state';}
export function compare(observations){const out={};for(const[a,b]of[['product','ethereumjs'],['product','geth'],['ethereumjs','geth']]){
 const x=observations[a],y=observations[b],complete=o=>!!o&&o.completedExecution===true&&['success','reverted','failed'].includes(o.executionStatus);
 out[a+'_'+b]=Object.fromEntries(FIELDS.map(k=>[k,!complete(x)||!complete(y)||x[k]==null||y[k]==null?null:JSON.stringify(x[k])===JSON.stringify(y[k])]));
 }return out;}
export function assertRollback(saved,input,allocation,root){const a=saved.attempt,o=a.output;
 assert(!['success','reverted','failed'].includes(o.execution.status));assert.deepEqual(a.changes.accounts,[]);assert.deepEqual(allocation,normalize(input.allocation));assert.equal(root,input.initialStateRoot);
 assert.equal(o.stateDisposition,'rolled_back');assert(o.gasAccounting===null||o.gasAccounting===undefined);assert.equal(o.feeAccounting,undefined);assert.equal(o.execution.executionGasUsed,null);assert.equal(o.execution.returnData,null);assert.deepEqual(o.logs,[]);
 assert.equal(saved.observation,null);assert.deepEqual(saved.withheldState,{scope:'rolled_back_product_attempt_not_execution_prediction',executionStatus:o.execution.status,stateDisposition:o.stateDisposition,rollbackStateRoot:root,target:target(input,allocation),gasAccounting:null});
}
export function verifyInputRecords(input,saved){
 const a=saved.attempt,records=saved.proofRecords;assert.equal(a.inputs.status,'available');assert.equal(a.inputs.context.chainId,11155111);assert.equal(a.inputs.context.blockHash,input.headerHash);assert.equal(a.inputs.context.stateRoot,input.initialStateRoot);assert.deepEqual(a.inputs.context.header,input.header);
 assert.equal(records.length,a.inputEvidence.length);assert.equal(records.length,a.broker.records.length);assert.equal(records.length,a.broker.calls);assert.equal(records.length,a.broker.dispatches);
 for(let i=0;i<records.length;i++){const r=records[i],e=a.inputEvidence[i],b=a.broker.records[i];assert.equal(r.error,undefined);assert(['eth_getProof','eth_getCode'].includes(r.method));assert.deepEqual(r.params.at(-1),{blockHash:input.headerHash,requireCanonical:true});
  assert.equal(e.id,i+1);assert.equal(b.id,i+1);assert.deepEqual(e.request,{method:r.method,params:r.params});assert.deepEqual(b.request,e.request);assert.equal(e.requestText,JSON.stringify(e.request));assert.equal(e.requestSha256,sha(e.requestText));assert.deepEqual(e.result,r.result);
  const text=JSON.stringify(r.result);assert.equal(e.resultBytes,Buffer.byteLength(text));assert.equal(e.resultSha256,sha(text));assert.equal(b.resultBytes,e.resultBytes);assert.equal(b.resultSha256,e.resultSha256);assert.equal(e.status,'received');assert.equal(b.status,'received');assert.equal(b.dispatched,true);assert.equal(e.verification,'verified');
 }
 for(const[address,fact]of Object.entries(a.inputs.accounts)){const row=input.allocation[address];assert.equal(fact.exists,!!row);if(row){assert.equal(BigInt(fact.nonce),BigInt(row.nonce));assert.equal(BigInt(fact.balance),BigInt(row.balance));assert.equal(fact.code,row.code);for(const[k,v]of Object.entries(fact.storage))assert.equal(BigInt(v),BigInt(row.storage[k]??0));}}
}

export async function verify(root,pins=PINS){
 const cap=path.join(root,PREFIX,'capture'),at=p=>path.join(cap,p),j=p=>json(at(p));
 for(const[f,h]of[['manifest.json',pins.manifest],['plan.json',pins.plan],['source-manifest.json',pins.source]]){assert.match(h,/^[a-f0-9]{64}$/);assert.equal(sha(read(at(f))),h);}
 const manifest=j('manifest.json'),plan=j('plan.json'),source=j('source-manifest.json'),results=j('results.json');
 assert.equal(manifest.artifactHashCoverageComplete,true);checkFiles(cap,manifest.files);assert.deepEqual(list(cap).filter(p=>p!=='manifest.json'),manifest.files.map(f=>f.path));
 checkFiles(at('runtime'),source.files);assert.deepEqual(list(at('runtime')),source.files.map(f=>f.path));
 const depcap=path.resolve(cap,source.dependencyReference.captureRelative);assert.equal(sha(read(path.join(depcap,'source-manifest.json'))),pins.dependencySource);
 const depmanifest=json(path.join(depcap,'source-manifest.json')),trees=['engines/local-evm/node_modules','engines/fixture-evm/node_modules'],deps=depmanifest.files.filter(f=>trees.some(t=>f.path.startsWith(t+'/')));
 assert.deepEqual(source.dependencyReference.files,deps);assert.equal(source.dependencyReference.sourceSha256,pins.dependencySource);checkFiles(path.join(depcap,'runtime'),deps);
 assert.deepEqual(trees.flatMap(t=>list(path.join(depcap,'runtime'),t)).sort(),deps.map(f=>f.path));for(const t of trees)assert.equal(fs.realpathSync(at('runtime/'+t)),fs.realpathSync(path.join(depcap,'runtime',t)));
 assert.equal(sha(read(source.node.executable)),source.node.sha256);assert.equal(source.geth.binary.sha256,pins.binary);assert.equal(sha(read(source.geth.binary.path)),pins.binary);
 assert.equal(source.geth.manifestSha256,pins.toolchain);const toolPins={'toolchain-manifest.json':pins.toolchain,'source-inventory.json':source.geth.source.inventory.sha256,'dependency-inventory.json':source.geth.dependencyInventory.sha256,'build-manifest.json':source.geth.buildManifest.sha256};
 for(const[p,h]of Object.entries(toolPins))assert.equal(sha(read(at('toolchain/'+p))),h);
 for(const f of source.toolFiles){const b=read(at('toolchain/'+f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
 const toolInventory=j('toolchain/source-inventory.json');for(const f of source.toolFiles.filter(f=>f.path.startsWith('source/'))){const p=toolInventory.files.find(v=>v.path===f.path.slice(7));assert(p);assert.equal(f.bytes,p.bytes);assert.equal(f.sha256,p.sha256);}
 const imp=p=>import(pathToFileURL(at('runtime/'+p)).href);
 const {RLP}=await imp('engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js'),{keccak_256:keccak}=await imp('engines/local-evm/node_modules/@noble/hashes/sha3.js'),{createMPT}=await imp('engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js');
 const {createTxFromRLP}=await imp('engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js'),{Common,Sepolia}=await imp('engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js');
 const {parseTrace}=await imp(PREFIX+'/observations.mjs'); // Shared, disclosed framing parser only.
 const common=new Common({chain:Sepolia,hardfork:'amsterdam'}),emptyRoot=hex((await createMPT({useKeyHashing:true})).root());
 let rootCount=0,proofCount=0,rawTotal=0;const processes=[],seals=[],rows=[];
 async function storageRoot(storage){const trie=await createMPT({useKeyHashing:true});for(const[k,v]of Object.entries(storage))if(BigInt(v))await trie.put(bytes(k),RLP.encode(integer(v)));return hex(trie.root());}
 async function allocationRoot(alloc){rootCount++;const trie=await createMPT({useKeyHashing:true});for(const[a,row]of Object.entries(normalize(alloc)))await trie.put(bytes(a),RLP.encode([integer(row.nonce),integer(row.balance),bytes(await storageRoot(row.storage)),keccak(bytes(row.code))]));return hex(trie.root());}
 const logsHash=logs=>hex(keccak(RLP.encode(logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]))));
 function bloom(logs){const out=Buffer.alloc(256);for(const l of logs)for(const value of[l.address,...l.topics]){const h=keccak(bytes(value));for(let i=0;i<6;i+=2){const n=((h[i]<<8)|h[i+1])&2047;out[255-(n>>3)]|=1<<(n&7);}}return hex(out);}
 function seal(p){const s=j(p+'.seal.json'),b=read(at(p));assert.equal(s.bytes,b.length);assert.equal(s.sha256,sha(b));seals.push(s);return s;}
 const recordedCap=path.join(source.sourceRoot,PREFIX,'capture'),recordedRuntime=path.join(recordedCap,'runtime');
 function proc(p,executable,args){const raw=j(p),out=processRecord(raw);assert.equal(raw.process.executable,executable);assert.deepEqual(raw.process.args,args);rawTotal+=out.bytes;processes.push({path:p,status:raw.process.status,signal:raw.process.signal,error:raw.process.error,stdoutBytes:out.stdout.length,stderrBytes:out.stderr.length,clean:out.clean});return{raw,...out};}
 assert.deepEqual(plan.declarations.map(d=>d.id),IDS);assert.equal(plan.sourceManifestSha256,pins.source);assert.equal(manifest.planSha256,pins.plan);assert.equal(plan.chainId,11155111);assert.equal(plan.fork,'Amsterdam');assert.equal(plan.rewards,-1);assert.deepEqual(plan.withdrawals,[]);
 assert.equal(plan.scope.canonicalWinnerSelected,false);assert.equal(plan.scope.eels,'source_only_no_runner_executed');assert.equal(plan.scope.productUnavailableRemainsNull,true);
 for(let i=0;i<6;i++){
  const n=String(i+1).padStart(3,'0'),d=plan.declarations[i];for(const f of Object.values(d.files)){const b=read(at(f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
  const input=j(d.files.declaration.path);assert.equal(input.index,i);assert.equal(input.id,IDS[i]);assert.equal(input.rootCreate,i%2===0);assert.equal(input.collision,['storage','storage','absent','absent','empty','empty'][i]);assert.deepEqual(j(d.files.alloc.path),input.allocation);assert.deepEqual(j(d.files.env.path),input.environment);assert.equal(j(d.files.txs.path),input.transactionBody);
  assert.equal(input.chainId,11155111);assert.equal(input.fork,'Amsterdam');assert.equal(input.request.from,'0x1a642f0e3c3af545e7acbd38b07251b3990914f1');assert.equal(input.request.executionProfile,'unsigned_eip1559_block_end');assert.deepEqual(input.request.fees,{maxFeePerGas:'13',maxPriorityFeePerGas:'3'});assert.equal(input.request.gas,'5000000');assert.equal(input.request.authorizationList,undefined);assert.equal(input.request.blobVersionedHashes,undefined);
  assert.equal(input.sentinel.runtime,'0x6001546000526002546020526103df5460405260606000f3');assert.equal(input.sentinel.initcode,'0x6103df54600155602a60025561001861001b6000396100186000f36001546000526002546020526103df5460405260606000f3');assert.deepEqual(input.sentinel.slots,['0','1','2','991']);
  assert.deepEqual(input.amendment.addresses,SYSTEM);assert.deepEqual(Object.keys(input.allocation).filter(a=>!Object.hasOwn(input.originalAllocation,a)).sort(),[...SYSTEM].sort());for(const[a,v]of Object.entries(input.originalAllocation))assert.deepEqual(input.allocation[a],v);for(const a of SYSTEM)assert.deepEqual(input.allocation[a],{nonce:'0x1',balance:'0x0',code:'0x00',storage:{}});
  const initialTarget=input.allocation[input.target];if(input.collision==='absent')assert.equal(initialTarget,undefined);else assert.deepEqual(initialTarget,{nonce:'0x0',balance:'0x11',code:'0x',storage:input.collision==='storage'?{[word(0)]:word(999),[word(991)]:word(123456)}:{}});
  assert.equal(await storageRoot(initialTarget?.storage??{}),input.initialTargetStorageRoot);
  const tx=createTxFromRLP(bytes(input.signedBytes),{common});assert(tx.verifySignature());assert.deepEqual(JSON.parse(JSON.stringify(tx.toJSON())),input.transaction);assert.equal(tx.getSenderAddress().toString(),input.request.from);assert.equal(hex(tx.hash()),input.transactionHash);assert.equal(tx.nonce,BigInt(input.allocation[input.request.from].nonce));assert.deepEqual(RLP.decode(bytes(input.transactionBody)),[bytes(input.signedBytes)]);
  const decoded=RLP.decode(bytes(input.signedBytes).slice(1));assert.equal(bytes(input.signedBytes)[0],2);assert.equal(decoded.length,12);assert.deepEqual(decoded.slice(0,5).map(num),[11155111n,1n,3n,13n,5000000n]);assert.equal(hex(decoded[5]),input.request.to??'0x');assert.equal(num(decoded[6]),BigInt(input.request.value));assert.equal(hex(decoded[7]),input.request.data);assert.deepEqual(decoded[8],[]);
  if(input.rootCreate){assert.equal(input.request.to,null);assert.equal(input.request.data,input.sentinel.initcode);assert.equal(input.request.value,'5');}else{assert.equal(input.request.value,'0');assert.equal(input.creator,input.request.to);}
  const headerFields=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber'],ints=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
  assert.equal(hex(keccak(RLP.encode(headerFields.map(k=>ints.has(k)?integer(input.header[k]):bytes(input.header[k]))))),input.headerHash);assert.equal(input.headerHash,input.header.hash);
  for(const[e,k]of Object.entries({currentCoinbase:'miner',currentGasLimit:'gasLimit',currentNumber:'number',currentTimestamp:'timestamp',currentRandom:'mixHash',currentDifficulty:'difficulty',currentBaseFee:'baseFeePerGas',slotNumber:'slotNumber',currentExcessBlobGas:'excessBlobGas',parentBeaconBlockRoot:'parentBeaconBlockRoot'}))assert.equal(input.environment[e],input.header[k]);assert.deepEqual(input.environment.withdrawals,[]);
  assert.equal(BigInt(input.inputGas.intrinsic),tx.getIntrinsicGas());const debit=input.rootCreate&&input.collision==='absent'?183600n:0n;assert.equal(BigInt(input.inputGas.rootAccountStateCharge),debit);assert.equal(BigInt(input.inputGas.gethRootGas),5000000n-tx.getIntrinsicGas()-debit);
  const roots={original:await allocationRoot(input.originalAllocation),initial:await allocationRoot(input.allocation),product:null,ethereumjs:null,geth:null};assert.equal(roots.original,input.originalStateRoot);assert.equal(roots.initial,input.initialStateRoot);assert.equal(roots.initial,input.header.stateRoot);
  const row={id:input.id},savedWorkers={};
  const project=(alloc,execution)=>{const t=target(input,alloc);return{completedExecution:true,...execution,allocation:alloc,target:t,targetBehavior:behavior(input,t)};};
  for(const mode of['product','ethereumjs']){
   const p=mode+'/'+n+'.json',r=proc(p,source.node.executable,['--max-old-space-size=256',path.join(recordedRuntime,PREFIX,'worker.mjs'),mode,path.join(recordedCap,d.files.declaration.path)]);seal(p);
   row[mode]={status:'unavailable',observation:null,error:'dispatch_started'};
   if(!r.clean)continue;const saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.stdout));savedWorkers[mode]=saved;assert.equal(saved.id,input.id);assert.equal(saved.mode,mode);
   if(mode==='product'&&saved.attempt){const a=saved.attempt;assert.equal(saved.processClosureValid,true);assert.equal(a.broker.pendingAtReturn,0);assert.equal(a.isolation.processClosed,true);
    verifyInputRecords(input,saved);proofCount+=saved.proofRecords.length;assert.equal(a.status,'completed');assert.equal(a.error,null);const allocation=applyDelta(input.allocation,a.changes);roots.product=await allocationRoot(allocation);const o=a.output;
    if(['success','reverted','failed'].includes(o.execution.status)){const g=o.gasAccounting;assert(g);assert.deepEqual(saved.observation,project(allocation,{stateRoot:roots.product,executionStatus:o.execution.status,executionError:o.execution.error,returnData:o.execution.returnData,gasUsed:g.gasUsed,executionGasUsed:o.execution.executionGasUsed,preRefundGasWithFloor:g.preRefundGasWithFloor,singleTransactionBlockGasUsed:g.singleTransactionBlockGasUsed,regularGasUsed:g.regularGasUsed,stateGasUsed:g.stateGasUsed,logs:o.logs}));}
    else assertRollback(saved,input,allocation,roots.product);
   }else if(mode==='ethereumjs'&&saved.observation){const raw=saved.rawResult,o=saved.observation,allocation=normalize(o.allocation);roots.ethereumjs=await allocationRoot(allocation);assert.equal(roots.ethereumjs,o.stateRoot);assert.equal(raw.transactionHash,input.transactionHash);assert.equal(raw.receipt.status,raw.execResult.exceptionError===null?1:0);assert.equal(raw.receipt.cumulativeBlockGasUsed,raw.totalGasSpent);assert.equal(raw.amountSpent,(BigInt(raw.totalGasSpent)*10n).toString());assert.equal(raw.receipt.bitvector,bloom(raw.execResult.logs));
    assert.deepEqual(o,project(allocation,{stateRoot:roots.ethereumjs,executionStatus:raw.execResult.exceptionError==='revert'?'reverted':raw.execResult.exceptionError?'failed':'success',executionError:raw.execResult.exceptionError,returnData:raw.execResult.returnValue,gasUsed:raw.totalGasSpent,executionGasUsed:raw.execResult.executionGasUsed,preRefundGasWithFloor:raw.blockGasSpent,singleTransactionBlockGasUsed:(BigInt(raw.txRegularGas)>BigInt(raw.txStateGas)?raw.txRegularGas:raw.txStateGas),regularGasUsed:raw.txRegularGas,stateGasUsed:raw.txStateGas,logs:raw.execResult.logs}));
   }
   row[mode]={status:saved.observation?'observed':mode==='product'?(saved.attempt?.output?.execution?.status??'unavailable'):'unavailable',observation:saved.observation,withheldState:saved.withheldState??null,error:saved.error??saved.attempt?.error??null};
  }
  const folder='geth/'+n,gp=proc(folder+'-process.json',source.geth.binary.path,['t8n','--state.fork=Amsterdam','--state.chainid=11155111','--state.reward=-1','--input.alloc='+path.join(recordedCap,d.files.alloc.path),'--input.env='+path.join(recordedCap,d.files.env.path),'--input.txs='+path.join(recordedCap,d.files.txs.path),'--output.basedir='+path.join(recordedCap,folder),'--output.alloc=alloc.json','--output.result=result.json','--output.body=body.rlp','--trace','--trace.callframes','--trace.memory']);
  assert.equal(gp.raw.productSealedSha256,sha(read(at('product/'+n+'.json'))));assert.equal(gp.raw.ethereumJsSealedSha256,sha(read(at('ethereumjs/'+n+'.json'))));assert(gp.clean);
  const files=fs.readdirSync(at(folder)).sort();assert.deepEqual(files,['alloc.json','body.rlp','result.json','trace-0-'+input.transactionHash+'.jsonl']);for(const f of files){const s=fs.lstatSync(at(folder+'/'+f));assert(s.isFile()&&s.size<=4194304);rawTotal+=s.size;}
  const result=j(folder+'/result.json'),receipt=result.receipts[0],allocation=normalize(j(folder+'/alloc.json'));assert.equal(result.receipts.length,1);assert(!result.rejected||result.rejected.length===0);assert.deepEqual(result.requests,[]);assert.equal(result.currentDifficulty,null);assert.equal(BigInt(result.currentBaseFee),BigInt(input.header.baseFeePerGas));assert.equal(BigInt(result.blobGasUsed),0n);assert.equal(j(folder+'/body.rlp'),input.transactionBody);
  roots.geth=await allocationRoot(allocation);assert.equal(roots.geth,result.stateRoot);for(const a of SYSTEM)assert.deepEqual(allocation[a],input.allocation[a]);
  assert.equal(BigInt(receipt.type),2n);assert.equal(receipt.transactionHash,input.transactionHash);assert.equal(BigInt(receipt.transactionIndex),0n);assert.equal(BigInt(receipt.blockNumber),BigInt(input.header.number));assert.equal(BigInt(receipt.gasUsed),BigInt(receipt.cumulativeGasUsed));assert(BigInt(receipt.gasUsed)<=5000000n&&BigInt(result.gasUsed)<=5000000n);
  const trace=parseTrace(read(at(folder+'/trace-0-'+input.transactionHash+'.jsonl')),input);assert.equal(BigInt(receipt.status),trace.error===null?1n:0n);
  const logs=receipt.logs.map((l,index)=>{assert.match(l.address,/^0x[0-9a-f]{40}$/);assert(l.topics.length<=4);for(const t of l.topics)assert.match(t,/^0x[0-9a-f]{64}$/);assert.match(l.data,/^0x(?:[0-9a-f]{2})*$/);assert.equal(l.transactionHash,input.transactionHash);assert.equal(BigInt(l.transactionIndex),0n);assert.equal(BigInt(l.logIndex),BigInt(index));assert.equal(BigInt(l.blockNumber),BigInt(input.header.number));return{address:l.address,topics:l.topics,data:l.data};});
  assert.equal(logsHash(logs),result.logsHash);assert.equal(bloom(logs),receipt.logsBloom);assert.equal(bloom(logs),result.logsBloom);
  const geth=project(allocation,{stateRoot:roots.geth,executionStatus:trace.error==='execution reverted'?'reverted':trace.error?'failed':'success',executionError:trace.error,returnData:trace.returnData,gasUsed:BigInt(receipt.gasUsed).toString(),executionGasUsed:trace.executionGasUsed,preRefundGasWithFloor:null,singleTransactionBlockGasUsed:BigInt(result.gasUsed).toString(),regularGasUsed:null,stateGasUsed:null,logs,trace});
  // Producer adds trace after target; object insertion order matters only for
  // its JSON comparison of target/log values, not for deep observation joins.
  row.geth={status:'observed',observation:geth,error:null};row.comparisons=compare(Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,row[k].observation])));
  assert.deepEqual(row,j(folder+'-observation.json'));assert.deepEqual(row,results.rows[i]);
  rows.push({id:input.id,roots,statuses:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,row[k].status])),targetBehaviors:Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,row[k].observation?.targetBehavior??null])),comparisons:row.comparisons});
 }
 const counts=Object.fromEntries(['product','ethereumjs','geth'].map(k=>[k,Object.fromEntries([...new Set(results.rows.map(r=>r[k].status))].map(s=>[s,results.rows.filter(r=>r[k].status===s).length]))]));assert.deepEqual(results.counts,counts);assert.equal(results.rows.length,6);assert.equal(rawTotal,results.totalOutputBytes);assert(rawTotal<=50331648);
 assert.equal(results.planSha256,pins.plan);assert.equal(results.sourceManifestSha256,pins.source);assert.equal(results.sourceUnchanged,true);assert.equal(results.artifactsUnchanged,true);assert.equal(results.artifactHashCoverageComplete,true);assert.equal(results.observationsUsable,results.fatal===null&&results.sourceUnchanged&&results.artifactsUnchanged);assert.equal(results.status,results.fatal?'interrupted':'complete');assert.deepEqual(results.scope,plan.scope);
 const t=results.terminalTiming;assert.equal(t.clockReversed,false);assert.equal(t.valid,true);for(const n of[t.wallMs,t.monotonicMs])assert(Number.isFinite(n)&&n>=0&&n<=240000);
 const started=j('STARTED.json');assert.equal(started.planSha256,pins.plan);const start=Date.parse(started.at);assert(Number.isFinite(start));for(const s of seals){const time=Date.parse(s.at);assert(Number.isFinite(time)&&time>=start&&time<=start+t.wallMs+1);}
 const summary={scope:plan.scope,observationsUsable:results.observationsUsable,counts,rows:results.rows.map(r=>({id:r.id,...Object.fromEntries(['product','ethereumjs','geth'].map(k=>{const x=r[k],o=x.observation;return[k,{status:x.status,executionStatus:o?.executionStatus??x.withheldState?.executionStatus??null,error:x.error??null,stateRoot:o?.stateRoot??null,rollbackStateRoot:x.withheldState?.rollbackStateRoot??null,targetBehavior:o?.targetBehavior??null,target:o?.target??null,gasUsed:o?.gasUsed??null,singleTransactionBlockGasUsed:o?.singleTransactionBlockGasUsed??null}];})),comparisons:r.comparisons}))};assert.deepEqual(summary,j('summary.json'));
 checkFiles(cap,manifest.files);assert.equal(sha(read(at('manifest.json'))),pins.manifest);
 return{kind:'bounded_artifact_only_review',pins,reviewScriptSha256:sha(read(fileURLToPath(import.meta.url))),checks:{manifestEntries:manifest.files.length,runtimeEntries:source.files.length,referencedDependencies:deps.length,processRecords:processes.length,rawBytes:rawTotal,signedInputs:6,headerHashes:6,reconstructedFullMptRoots:rootCount,joinedInputReplies:proofCount,allSavedClassificationsReproduced:true},observationsUsable:results.observationsUsable,counts,processes,rows,
  limitations:['No VM, Geth, public RPC, subprocess target, or destination execution was performed by this review.','JSONL framing uses the pinned archived pure parser; MPT construction and signature recovery use pinned shared primitives. This is not a second EVM or wholly independent parser.','Saved proof/code replies are bound to collector/broker hashes and their claimed facts to complete initial allocations; individual account/storage proof paths were not re-walked.','Unsupported product attempts retain null execution comparisons. Their full rollback roots are not executable poststate predictions.','Unclean Node workers retain raw process failures and unavailable rows; no target outcome is inferred from failed declaration setup.','Chronology uses frozen driver control flow and durable seals; process records have no independently attested absolute start time.','Synthetic six-case development diagnostic with four inert system accounts. EELS remains source-only and no canonical winner, population accuracy, or general fork coverage is established.']};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verify(path.resolve(process.argv[2]??path.join(path.dirname(fileURLToPath(import.meta.url)),'../..'))),null,2));
