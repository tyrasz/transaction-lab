// Artifact-only audit. Imports cryptographic/MPT and saved-byte validators only;
// never invokes a product, EELS worker, VM, RPC, or network operation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const prefix='research/local-sequence-v036-reference-v2',base=path.join(root,prefix,'capture');
const PLAN='a1df7fb169e89826b0a27e4dd4e83796b5c0fb9dbafba48c7821676d5bf88da4';
const MANIFEST='402045e7a4b5e69d51a7956e66fab4e6b0b71204b65430a310929db748e9f270';
const OLD_PLAN='76fb2f64a719f5e577869a43f915e4b555547bf85f1b6a8d769e96de5d557030';
const OLD_MANIFEST='adad620ff6b97af186670c3af46b40e662539a167ef392bb9c1b5be84f10b6b9';
const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p)),sha=b=>createHash('sha256').update(b).digest('hex');
const load=p=>json(path.join(base,p)),raw=p=>read(path.join(base,p));
const walk=(dir,rel='')=>fs.readdirSync(path.join(dir,rel)).sort().flatMap(n=>{const p=rel?rel+'/'+n:n;return fs.lstatSync(path.join(dir,p)).isDirectory()?walk(dir,p):[p];}).sort();
function inventory(dir,planPin,manifestPin){
 assert.equal(sha(read(path.join(dir,'plan.json'))),planPin);assert.equal(sha(read(path.join(dir,'manifest.json'))),manifestPin);
 const manifest=json(path.join(dir,'manifest.json'));assert.equal(manifest.planSha256,planPin);
 assert.deepEqual(walk(dir),[...manifest.files.map(f=>f.path),'manifest.json'].sort());let bytes=0;
 for(const f of manifest.files){const p=path.join(dir,f.path),s=fs.lstatSync(p);
  if(f.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),f.target);assert.equal(sha(read(fs.realpathSync(p))),f.resolvedSha256);}
  else{assert.equal(f.kind,'file');assert(s.isFile());assert.equal(s.size,f.bytes);assert.equal(s.mode&511,f.mode);assert.equal(sha(read(p)),f.sha256);bytes+=s.size;}}
 return{files:manifest.files.length,bytes,manifest};
}
const current=inventory(base,PLAN,MANIFEST),plan=load('plan.json'),results=load('results.json'),ledger=load('write-ledger.json');
const oldBase=path.join(root,'research/local-sequence-v036-reference/capture'),old=inventory(oldBase,OLD_PLAN,OLD_MANIFEST);
const pre=new Set([...plan.files.map(f=>'runtime/'+f.path),...plan.inputs.map(f=>f.path),'plan.json','toolchain.json',...walk(path.join(base,'preparation')).map(f=>'preparation/'+f)]);
assert.equal(ledger.schemaVersion,1);assert.deepEqual(ledger.files,current.manifest.files.filter(f=>f.path!=='write-ledger.json').map(f=>({...f,origin:pre.has(f.path)?'preexisting':'written'})));
for(const f of plan.files)assert.deepEqual(current.manifest.files.find(x=>x.path==='runtime/'+f.path),{...f,path:'runtime/'+f.path});
const runtime=path.join(base,'runtime'),imp=async p=>import(pathToFileURL(path.join(runtime,p)));
const {compare,validateRecordedProcess}=await imp(prefix+'/run.mjs');
const {createMPT}=await imp('engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js');
const {RLP}=await imp('engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js');
const {keccak_256:keccak}=await imp('engines/local-evm/node_modules/@noble/hashes/sha3.js');
const {ecrecover,pubToAddress}=await imp('engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js');
const b=h=>Uint8Array.from(Buffer.from(h.slice(2),'hex')),hex=v=>'0x'+Buffer.from(v).toString('hex');
const integer=n=>{n=BigInt(n);assert(n>=0n&&n<2n**256n);return n===0n?new Uint8Array():b('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));};
const quantity=n=>'0x'+BigInt(n).toString(16),number=v=>v.length?BigInt(hex(v)):0n;
let independentRoots=0;
async function stateRoot(allocation){
 const state=await createMPT({useKeyHashing:true});
 for(const[a,row]of Object.entries(allocation)){const storage=await createMPT({useKeyHashing:true});
  for(const[k,v]of Object.entries(row.storage)){assert(BigInt(v)>0n);await storage.put(b(k),RLP.encode(integer(v)));}
  await state.put(b(a),RLP.encode([integer(row.nonce),integer(row.balance),storage.root(),keccak(b(row.code))]));}
 independentRoots++;return hex(state.root());
}
function cumulative(initial,changes){
 const out=structuredClone(initial),seen=new Set();assert(Array.isArray(changes.accounts));
 for(const row of changes.accounts){assert(!seen.has(row.address));seen.add(row.address);assert(!Object.hasOwn(row,'reset'));assert(!Object.hasOwn(row,'code'));assert.notEqual(row.existence?.after,false);
  const existed=Object.hasOwn(out,row.address),a=out[row.address]??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};
  if(row.existence){assert.equal(row.existence.before,existed);assert.equal(row.existence.after,true);}
  for(const k of ['nonce','balance'])if(row[k]){assert.equal(BigInt(a[k]),BigInt(row[k].before));a[k]=quantity(row[k].after);}
  const slots=new Set();for(const s of row.storage??[]){assert(!slots.has(s.slot));slots.add(s.slot);assert.equal(BigInt(a.storage[s.slot]??0),BigInt(s.before));
   if(BigInt(s.after)===0n)delete a.storage[s.slot];else a.storage[s.slot]=s.after;}
  out[row.address]=a;
 }return out;
}
function logData(logs){
 const tuples=logs.map(l=>[b(l.address),l.topics.map(b),b(l.data)]),bloom=Buffer.alloc(256);
 for(const l of logs)for(const v of[l.address,...l.topics]){const h=keccak(b(v));for(let i=0;i<6;i+=2){const bit=((h[i]<<8)|h[i+1])&2047;bloom[255-Math.floor(bit/8)]|=1<<(bit%8);}}
 return{tuples,bloom:hex(bloom),hash:hex(keccak(RLP.encode(tuples)))};
}
async function singleTrie(payload){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);return hex(trie.root());}
const canonical=await compare(PLAN,MANIFEST); // Saved-byte operation, including full external toolchain and proofs.
const savedPath=path.join(root,'research/local-sequence-v036-work/reference-v2-comparison.json');assert.deepEqual(canonical,json(savedPath));
assert.deepEqual(results.rows.map(r=>[r.kind,r.index]),['product','eels'].flatMap(k=>Array.from({length:4},(_,i)=>[k,i])));
let rawBytes=0,proofRecords=0,signedInputs=0,receipts=0,logCount=0;const rows=[];
for(let i=0;i<4;i++){
 const input=load(plan.inputs[i].path),stem=String(i+1).padStart(3,'0');assert.equal(sha(raw(plan.inputs[i].path)),plan.inputs[i].sha256);
 assert.deepEqual(raw(plan.inputs[i].path),read(path.join(oldBase,plan.inputs[i].path)));
 assert.equal(await stateRoot(input.originalAllocation),input.originalStateRoot);assert.equal(await stateRoot(input.allocation),input.initialStateRoot);
 const amendment=structuredClone(input.originalAllocation);for(const a of input.amendment.addresses){assert(!Object.hasOwn(amendment,a));amendment[a]={nonce:'0x1',balance:'0x0',code:'0x00',storage:{}};}assert.deepEqual(amendment,input.allocation);
 for(const[position,step]of input.steps.entries()){
  const signed=b(step.signedBytes);assert.equal(signed[0],2);const fields=RLP.decode(signed.slice(1));assert.equal(fields.length,12);assert.deepEqual(RLP.encode(fields),signed.slice(1));
  assert.equal(number(fields[0]),BigInt(input.chainId));assert.equal(number(fields[1]),1n+BigInt(position));assert.equal(number(fields[2]),3n);assert.equal(number(fields[3]),13n);
  assert.equal(number(fields[4]),5000000n);assert.equal(hex(fields[5]),step.request.to);assert.equal(number(fields[6]),0n);assert.equal(hex(fields[7]),step.request.data);assert.deepEqual(fields[8],[]);
  const signing=keccak(Uint8Array.from([2,...RLP.encode(fields.slice(0,9))]));assert.equal(hex(pubToAddress(ecrecover(signing,number(fields[9])+27n,fields[10],fields[11]))),input.sender);
  assert.equal(hex(keccak(signed)),step.transactionHash);assert.equal(hex(RLP.encode([signed])),step.transactionBody);signedInputs++;
 }
 const reports={},processes={};
 for(const kind of ['product','eels']){
  const name=stem+'-'+kind,p=load(name+'-process.json'),seal=load(name+'-seal.json'),stdout=raw(name+'.stdout'),stderr=raw(name+'.stderr');
  assert.equal(sha(raw(name+'-process.json')),seal.processSha256);assert.deepEqual(seal.stdout,p.stdout);assert.deepEqual(seal.stderr,p.stderr);
  const v=validateRecordedProcess({plan,index:i,kind,record:p,stdout,stderr});assert.equal(v.bounded,true);assert.equal(v.status,'observed');assert.equal(p.status,0);assert.equal(p.signal,null);assert.equal(stderr.length,0);
  reports[kind]=v.report;processes[kind]={pid:p.pid,closed:p.processClosed,wallMs:p.wallMs,monotonicMs:p.monotonicMs,stdoutBytes:stdout.length,stderrBytes:stderr.length};rawBytes+=stdout.length+stderr.length;
 }
 const p=reports.product,e=reports.eels;proofRecords+=p.proofRecords.length;let previous=input.allocation,previousRoot=input.initialStateRoot;
 const positions=[];
 for(let position=0;position<3;position++){
  const ps=p.attempt.sequence.steps[position],es=e.steps[position],comp=canonical.rows[i].comparison.rows[position];assert.equal(ps.status,es.status);
  if(ps.status==='not_attempted'){assert.equal(ps.original,null);assert.equal(es.observation,null);assert(Object.values(comp.channels).every(v=>v===null));positions.push({position,disposition:'not_attempted',channels:comp.channels});continue;}
  assert.equal(ps.status,'completed');const original=ps.original,o=original.output,r=es.observation;
  assert.deepEqual(cumulative(input.allocation,original.startingChanges),previous);
  const productAllocation=cumulative(input.allocation,original.changes);assert.deepEqual(productAllocation,r.allocation);
  const productRoot=await stateRoot(productAllocation),referenceRoot=await stateRoot(r.allocation);assert.equal(productRoot,referenceRoot);assert.equal(referenceRoot,r.stateRoot);assert.equal(r.startingStateRoot,previousRoot);
  assert.equal(o.execution.status,r.executionStatus);assert.equal(o.execution.returnData,r.returnData);assert.deepEqual(o.logs,r.logs);
  const gas=BigInt(o.gasAccounting.gasUsed);assert.equal(gas,BigInt(r.chargedGas));assert.equal(BigInt(o.feeAccounting.gasCharge),gas*10n);assert.equal(BigInt(o.feeAccounting.coinbaseTip),gas*3n);assert.equal(BigInt(o.feeAccounting.baseFeeBurn),gas*7n);
  assert.equal(BigInt(productAllocation[input.sender].nonce),BigInt(previous[input.sender].nonce)+1n);assert.equal(BigInt(productAllocation[input.sender].balance),BigInt(previous[input.sender].balance)-gas*10n);
  assert.equal(BigInt(productAllocation[input.header.miner].balance),BigInt(previous[input.header.miner]?.balance??0)+gas*3n);
  const logs=logData(o.logs),receipt=b(r.receiptBytes);assert.equal(receipt[0],2);const rec=RLP.decode(receipt.slice(1));assert.equal(rec.length,4);
  assert.equal(number(rec[0]),o.execution.status==='success'?1n:0n);assert.equal(number(rec[1]),gas);assert.equal(hex(rec[2]),logs.bloom);assert.deepEqual(rec[3],logs.tuples);assert.equal(logs.hash,r.logsHash);
  assert.equal(await singleTrie(receipt),r.receiptsRoot);assert.equal(await singleTrie(b(input.steps[position].signedBytes)),r.transactionsRoot);receipts++;logCount+=o.logs.length;
  const blockGas=input.fork==='Amsterdam'?[BigInt(r.regularGasUsed),BigInt(r.stateGasUsed)].reduce((a,b)=>a>b?a:b):gas;
  assert.equal(blockGas,BigInt(r.singleTransactionBlockGasUsed));assert.equal(blockGas,BigInt(input.fork==='Amsterdam'?o.gasAccounting.singleTransactionBlockGasUsed:o.gasAccounting.gasUsed));
  if(o.execution.status==='reverted')for(const[a,row]of Object.entries(previous))assert.deepEqual(productAllocation[a].storage,row.storage,'Reverted step retained writes');
  positions.push({position,disposition:'completed',status:o.execution.status,chargedGas:gas.toString(),singleTransactionBlockGasUsed:blockGas.toString(),stateRoot:productRoot,logs:o.logs.length,channels:comp.channels});
  previous=productAllocation;previousRoot=productRoot;
 }
 assert.equal(e.finalStateRoot,previousRoot);assert.equal(canonical.rows[i].comparison.stopConsistency,true);rows.push({id:input.id,fork:input.fork,processes,positions});
}
assert.equal(rawBytes,results.totalBytes);assert.equal(rawBytes,results.totalObservedBytes);assert.equal(results.evidenceUsable,true);assert.equal(results.fatal,null);assert.equal(results.sourceUnchanged,true);
const sourceNotes=load('runtime/'+prefix+'/source-notes.json');
for(const f of Object.values(sourceNotes.priorCapture).filter(f=>f&&typeof f==='object'&&typeof f.path==='string')){assert.equal(read(path.join(root,f.path)).length,f.bytes);assert.equal(sha(read(path.join(root,f.path))),f.sha256);}
const firstComparison=json(path.join(root,sourceNotes.priorCapture.comparison.path));assert.equal(firstComparison.counts.mutuallyCompleted,0);assert.equal(firstComparison.counts.unavailableChannels,72);
for(let i=1;i<=4;i++){const old=json(path.join(oldBase,String(i).padStart(3,'0')+'-eels.stdout'));assert.equal(old.status,'unavailable');assert.deepEqual(old.error,{message:"unsupported operand type(s) for +: 'Uint' and 'U256'",type:'TypeError'});assert.deepEqual(old.steps.map(s=>s.status),['unavailable','not_attempted','not_attempted']);}
const oldRows=new Map(json(path.join(oldBase,'plan.json')).files.map(f=>[f.path,f]));let unchangedEngineEntries=0;
for(const row of plan.files.filter(r=>r.path.startsWith('engines/'))){assert.deepEqual(row,oldRows.get(row.path));unchangedEngineEntries++;}
const report={status:'pass',checkerSha256:sha(read(fileURLToPath(import.meta.url))),planSha256:PLAN,manifestSha256:MANIFEST,savedComparisonSha256:sha(read(savedPath)),
 integrity:{currentFiles:current.files,currentBytes:current.bytes,oldFiles:old.files,oldBytes:old.bytes,originalWriteLedgerEntries:ledger.files.length,runtimeEntries:plan.files.length,unchangedEngineEntries,toolchainEntries:plan.toolchain.entries,toolchainSha256:plan.toolchain.sha256,sourceAndExternalRuntimeVerifiedByArchivedComparator:true},
 raw:{processes:8,bytes:rawBytes,allObserved:true,allClosed:true,allStderrEmpty:true,elapsed:results.elapsed},
 reconstruction:{independentAllocationRoots:independentRoots,signedEnvelopesAndRecoveredSenders:signedInputs,receiptsAndTransactionTrieRoots:receipts,committedLogs:logCount,proofRecords,proofAndCodeJoins:'shared archived production validator'},
 counts:canonical.counts,rows,firstPacket:{planSha256:OLD_PLAN,manifestSha256:OLD_MANIFEST,rawProductObserved:4,rawEelsUnavailable:4,originalMutuallyCompleted:0,originalUnavailableChannels:72,unchanged:true},
 targetsExecutedByAudit:0,limitations:[
 'Four repeated synthetic sequences, not four new coverage cases; not Aave, Morpho, public-chain replay, or broad EVM accuracy.',
 'The independent reference is stock pinned EELS; the audit is saved-byte reconstruction, not a second execution or consensus attestation.',
 'The canonical comparator, production proof validator, and archived cryptographic/MPT libraries are shared. Separate audit code reapplies cumulative deltas and reconstructs initial/poststate roots, receipt/log blooms, transaction roots, fee arithmetic, and sender signatures.',
 'Product unsigned calls are compared with signed type2 reference transactions; fresh reference single-transaction context uses only prior EELS allocation and the same synthetic header, not cumulative block validation.',
 'Disposable query/native measurement channels are excluded. Both not-attempted positions retain six null channels each and are not matches.',
 'All-product-before-EELS is bound to frozen driver control flow and saved row order; seals have no independent trusted timestamps.',
 'The current Python runtime is explicitly inventoried and differs from older storage-creation captures; official EELS source and regular venv package bytes remain pinned as documented.'
 ]};
console.log(JSON.stringify(report,null,2));
