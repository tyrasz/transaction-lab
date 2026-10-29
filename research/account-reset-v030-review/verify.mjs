import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {IDS,LENGTHS,sha,relative,processResult,signedInput,executionGas,applyAllocation,comparePrefix} from './checks.mjs';
export const PINS=Object.freeze({manifest:'df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1',plan:'38dd6775fd91592ca3e152e27994c840b6eebaf8101ef53a12066f43f657a3f7',source:'f8ad4fa047b5db8117829b310889d39ab356700a68fd09e9bda82356caa0c787'});
export const DEFAULT_CAPTURE=fileURLToPath(new URL('../account-reset-v030/capture/',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(p));
function inventory(root,dir='') {return fs.readdirSync(path.join(root,dir)).sort().flatMap(n=>{const p=path.posix.join(dir,n),s=fs.lstatSync(path.join(root,p));return s.isDirectory()?inventory(root,p):[p];});}
export function checkEntry(root,e) {
 const p=path.join(root,relative(e.path)),s=fs.lstatSync(p);
 if(e.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),e.target);const target=fs.realpathSync(p);assert(target.startsWith(fs.realpathSync(root)+path.sep));}
 else {assert.equal(e.kind??'file','file');assert(s.isFile());assert.equal(s.size,e.bytes);assert.equal(sha(fs.readFileSync(p)),e.sha256);if(e.mode!==undefined)assert.equal(s.mode&0o777,e.mode);}
}
export async function primitives(capture=DEFAULT_CAPTURE) {
 const root=path.join(capture,'runtime'),imp=p=>import(pathToFileURL(path.join(root,p)).href);
 const [util,rlp,hash,tx,state,fee,header,proof,facts,shape,cases]=await Promise.all([
  imp('engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js'),imp('engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js'),imp('engines/local-evm/node_modules/@noble/hashes/sha3.js'),imp('engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js'),imp('engines/fixture-evm/state-test.js'),imp('engines/local-evm/test/fee-fixture.js'),imp('engines/local-evm/ethereum-header.js'),imp('engines/local-evm/verified-state-proof.js'),imp('engines/local-evm/input-facts.js'),imp('engines/local-evm/preview-mutations.js'),imp('research/account-reset-v030/cases.mjs')]);
 return {...util,...rlp,...hash,createTxFromRLP:tx.createTxFromRLP,loadState:state.loadState,feeCommon:fee.feeCommon,...header,...proof,...facts,canonicalStateChanges:shape.canonicalStateChanges,fixtureAt:cases.fixtureAt,declaration:cases.declaration};
}
export async function audit(capture=DEFAULT_CAPTURE) {
 capture=path.resolve(capture);const get=p=>read(path.join(capture,p)),raw=p=>fs.readFileSync(path.join(capture,p));
 for(const [name,pin]of [['manifest.json',PINS.manifest],['plan.json',PINS.plan],['source-manifest.json',PINS.source]])assert.equal(sha(raw(name)),pin,name);
 const manifest=get('manifest.json'),plan=get('plan.json'),source=get('source-manifest.json'),result=get('results.json');
 assert.equal(manifest.planSha256,PINS.plan);assert.equal(manifest.artifactHashCoverageComplete,true);assert.equal(plan.sourceManifestSha256,PINS.source);
 assert.deepEqual(inventory(capture).filter(p=>p!=='manifest.json').sort(),manifest.files.map(e=>e.path).sort());
 assert.equal(new Set(manifest.files.map(e=>e.path)).size,manifest.files.length);for(const e of manifest.files)checkEntry(capture,e);
 assert.deepEqual(inventory(path.join(capture,'runtime')).sort(),source.files.map(e=>e.path).sort());for(const e of source.files)checkEntry(path.join(capture,'runtime'),e);
 for(const e of source.toolFiles)checkEntry(path.join(capture,'toolchain'),e);
 assert.equal(source.geth.manifestSha256,'791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333');
 assert.equal(source.geth.binary.sha256,'10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521');
 assert.equal(source.geth.source.commit,'1df30b18d9ed35ee9d28ffd4648442c2204554ad');
 assert.deepEqual(plan.declarations.map(d=>d.id),IDS);assert.deepEqual(plan.declarations.map(d=>d.count),LENGTHS);
 assert.deepEqual(plan.limits,{totalMs:180000,processMs:15000,processBytes:8388608,outputFileBytes:4194304,totalOutputBytes:100663296,productSequences:5,gethPrefixes:15});
 assert.equal(result.planSha256,PINS.plan);assert.equal(result.sourceManifestSha256,PINS.source);
 for(const k of ['comparisonsUsable','sourceUnchanged','artifactsUnchanged','artifactHashCoverageComplete'])assert.equal(result[k],true);
 assert.equal(result.status,'complete');assert.equal(result.fatal,null);assert.deepEqual(result.unhashedOutputs,[]);assert.equal(result.terminalTiming.clockReversed,false);assert.equal(result.terminalTiming.valid,true);
 for(const n of [result.terminalTiming.wallMs,result.terminalTiming.monotonicMs])assert(n>=0&&n<=180000);
 const lib=await primitives(capture), logsHash=logs=>lib.bytesToHex(lib.keccak_256(lib.RLP.encode(logs.map(l=>[lib.hexToBytes(l.address),l.topics.map(lib.hexToBytes),lib.hexToBytes(l.data)]))));
 const rootFor=async(alloc,common)=>lib.bytesToHex(await(await lib.loadState(alloc,common)).getStateRoot());
 let records=0,proofs=0,proofBytes=0,productCalls=0,prefixes=0,receipts=0,emptyTraces=0,readableTraces=0,totalOutputBytes=0,resetRows=0;const rows=[],sequenceReports=[];
 for(let index=0;index<5;index++){
  const key=String(index+1).padStart(3,'0'),d=plan.declarations[index];
  for(const e of [d.files.declaration,d.files.alloc,d.files.env,...d.files.prefixes])checkEntry(capture,e);
  const input=get(d.files.declaration.path),common=lib.feeCommon(input);assert.equal(common.hardfork(),'shanghai');assert.equal(input.id,IDS[index]);assert.equal(input.index,index);
  const f=await lib.fixtureAt(index);assert.deepEqual(lib.declaration(f),input);assert.equal(f.calls.length,0); // Builds initial tries and signatures only; no execution entry point is called.
  assert.equal(lib.verifyEthereumHeader({header:input.header,expectedHash:input.header.hash}).status,'verified');
  assert.deepEqual(get(d.files.alloc.path),input.allocation);assert.deepEqual(get(d.files.env.path),input.environment);
  for(let i=0;i<d.count;i++)assert.equal(get(d.files.prefixes[i].path),input.prefixBodies[i]);
  signedInput(input,{...lib,common});assert.equal(await rootFor(input.allocation,common),input.header.stateRoot);
  const initialState=await lib.loadState(input.allocation,common),initialRoots=new Map();for(const address of Object.keys(input.allocation))initialRoots.set(address,lib.bytesToHex((await initialState.getAccount(lib.createAddressFromString(address))).storageRoot));
  const productRaw=get(`product/${key}.json`),product=processResult(productRaw),expectedRaw=get(`expectations/${key}.json`),expectation=processResult(expectedRaw);
  const recorded=path.dirname(path.dirname(productRaw.process.args[3]));const worker=path.join(recorded,'runtime/research/account-reset-v030/worker.mjs');
  for(const [mode,p,extra]of [['product',productRaw,[]],['expectation',expectedRaw,[path.join(recorded,`product/${key}.json`)]]]){assert.equal(p.process.executable,source.node.executable);assert.deepEqual(p.process.args,['--max-old-space-size=256',worker,mode,path.join(recorded,`inputs/${key}.json`),...extra]);totalOutputBytes+=p.stdout.bytes+p.stderr.bytes;}
  for(const folder of ['product','expectations']){const seal=get(`${folder}/${key}.json.seal.json`),bytes=raw(`${folder}/${key}.json`);assert.equal(seal.bytes,bytes.length);assert.equal(seal.sha256,sha(bytes));assert(Number.isFinite(Date.parse(seal.at)));}
  assert.equal(expectation.productSha256,sha(raw(`product/${key}.json`)));assert.equal(product.id,input.id);assert.equal(expectation.id,input.id);assert.equal(product.steps.length,d.count);assert.equal(expectation.steps.length,d.count);
  assert.deepEqual(product.scope,{execution:'actual_proof_backed_core_retained_manager',publicApiSequenceEndpoint:false,publicRpc:false,expectedPoststateUsed:false});assert.deepEqual(expectation.scope,{thirdMptOnly:true,fullVMExecuted:false,expectedFromProductDeltas:true});
  assert.deepEqual(product.inputs.context,{chainId:1,blockHash:input.header.hash,stateRoot:input.header.stateRoot,header:input.header,selector:{blockHash:input.header.hash,requireCanonical:true},provenance:'verified_eip1186_proofs_and_code_hash',stateRootTrust:'caller_supplied_header',expectedOutputsUsed:false});
  assert.equal(product.proofRecords.length,product.inputEvidence.length);let bytes=0;
  for(let i=0;i<product.proofRecords.length;i++){
   const r=product.proofRecords[i],e=product.inputEvidence[i];assert.equal(r.id,i+1);assert.equal(e.id,r.id);assert.equal(r.status,'completed');assert.equal(e.status,'received');assert.equal(e.verification,'verified');assert.equal(e.representation,'parsed_rpc_result_not_wire_bytes');
   assert(['eth_getProof','eth_getCode'].includes(r.method));assert.deepEqual(e.request,{method:r.method,params:r.params});assert.deepEqual(e.result,r.result);assert.equal(e.requestText,JSON.stringify(e.request));assert.equal(e.requestSha256,sha(e.requestText));assert.equal(e.resultBytes,Buffer.byteLength(JSON.stringify(r.result)));assert.equal(e.resultSha256,sha(JSON.stringify(r.result)));bytes+=e.resultBytes;
   assert.deepEqual(r.params.at(-1),{blockHash:input.header.hash,requireCanonical:true});
   if(r.method==='eth_getProof'){const codes=product.proofRecords.filter(c=>c.method==='eth_getCode'&&c.params[0]===r.params[0]);assert(codes.length);assert(codes.every(c=>c.result===codes[0].result));await lib.verifyStateProof({stateRoot:input.header.stateRoot,address:r.params[0],storageKeys:r.params[1],proof:r.result,code:codes[0].result});proofs++;}
   records++;
  }
  await lib.validateInputFacts({inputs:product.inputs,inputEvidence:product.inputEvidence,stateRoot:input.header.stateRoot});
  assert.equal(product.inputUsage.calls,product.proofRecords.length);assert.equal(product.inputUsage.observedResultBytes,bytes);assert.equal(product.inputUsage.retainedResultBytes,bytes);proofBytes+=bytes;
  const derived=[],allLogs=[];let cumulative=0n;
  for(let i=0;i<d.count;i++){
   const step=product.steps[i],e=expectation.steps[i];assert.equal(step.status,'completed');assert.equal(e.status,'derived');lib.canonicalStateChanges(step.changes);
   const gas=executionGas(input.requests[i],step.output);cumulative+=gas;allLogs.push(...step.output.logs);
   if(input.requests[i].fees)assert.equal(step.output.feeAccounting.coinbase,input.header.miner);
   const allocation=applyAllocation(input,step.changes,initialRoots),stateRoot=await rootFor(allocation,common);resetRows+=step.changes.accounts.filter(a=>a.reset).length;
   const expected={status:'derived',stateRoot,logsHash:logsHash(allLogs),gasUsed:String(gas),cumulativeGasUsed:String(cumulative),execution:step.output.execution,request:input.requests[i]};assert.deepEqual(e,expected);derived.push(expected);productCalls++;
  }
  for(let count=1;count<=d.count;count++){
   const prefix=`${key}-${String(count).padStart(2,'0')}`,dir=`geth/${prefix}`,process=get(`geth/${prefix}-process.json`);processResult(process,{parsed:false});totalOutputBytes+=process.stdout.bytes+process.stderr.bytes;
   assert.equal(process.process.executable,source.geth.binary.path);assert.deepEqual(process.process.args,['t8n','--state.fork=Shanghai','--state.chainid=1','--state.reward=-1',`--input.alloc=${recorded}/inputs/${key}-alloc.json`,`--input.env=${recorded}/inputs/${key}-env.json`,`--input.txs=${recorded}/inputs/${prefix}.rlp`,`--output.basedir=${recorded}/${dir}`,'--output.alloc=alloc.json','--output.result=result.json','--output.body=body.rlp','--trace.tracer=callTracer','--trace.jsonconfig={"onlyTopCall":false}']);
   const files=inventory(path.join(capture,dir)),expectedNames=['alloc.json','result.json','body.rlp',...input.signed.slice(0,count).map((s,i)=>`trace-${i}-${s.hash}.json`)];assert.deepEqual(files,expectedNames.sort());for(const name of files){const size=fs.statSync(path.join(capture,dir,name)).size;assert(size<=4194304);totalOutputBytes+=size;}
   const g=get(`${dir}/result.json`),body=get(`${dir}/body.rlp`),dump=get(`${dir}/alloc.json`);assert.equal(body,input.prefixBodies[count-1]);assert.deepEqual(g.rejected??[],[]);assert.equal(g.receipts.length,count);
   const dumpAlloc=Object.fromEntries(Object.entries(dump).map(([a,row])=>[a,{balance:'0x0',nonce:'0x0',code:'0x',storage:{},...row}]));assert.equal(await rootFor(dumpAlloc,common),g.stateRoot);
   const end=derived[count-1];assert.equal(g.stateRoot,end.stateRoot);assert.equal(g.logsHash,end.logsHash);assert.equal(BigInt(g.gasUsed),BigInt(end.cumulativeGasUsed));const receiptLogs=[],traces=[];
   for(let i=0;i<count;i++){
    const receipt=g.receipts[i],e=derived[i];assert.equal(receipt.type,'0x2');assert.equal(receipt.transactionHash,input.signed[i].hash);assert.equal(BigInt(receipt.transactionIndex),BigInt(i));assert.equal(BigInt(receipt.gasUsed),BigInt(e.gasUsed));assert.equal(BigInt(receipt.cumulativeGasUsed),BigInt(e.cumulativeGasUsed));assert.equal(BigInt(receipt.status),e.execution.status==='success'?1n:0n);receiptLogs.push(...receipt.logs);receipts++;
    const b=raw(`${dir}/trace-${i}-${input.signed[i].hash}.json`);if(b.length===0){assert(i>0);emptyTraces++;traces.push(null);}else{const trace=JSON.parse(b);assert.equal(i,0);assert.equal(trace.type,'CALL');assert.equal(trace.from,input.requests[i].from);assert.equal(trace.to,input.requests[i].to);assert.equal(trace.input??'0x',input.requests[i].data);assert.equal(BigInt(trace.value??0),BigInt(input.requests[i].value));assert.equal(trace.output??'0x',e.execution.returnData);assert.equal(BigInt(trace.gas),BigInt(input.requests[i].gas));assert.equal(BigInt(trace.gasUsed),BigInt(e.gasUsed));assert.equal(trace.error,undefined);traces.push(trace);readableTraces++;}
   }
   assert.equal(logsHash(receiptLogs),g.logsHash);const saved=get(`geth/${prefix}-comparison.json`);assert.deepEqual(saved,result.rows[prefixes]);assert.equal(saved.id,input.id);assert.equal(saved.prefix,count);
   if(count===1){const comparison=comparePrefix(input,count,derived,{result:g,traces,body});assert.deepEqual(saved,{id:input.id,prefix:count,...comparison,reason:null});}
   else {assert.equal(saved.status,'unavailable');assert.equal(saved.channels,null);assert.equal(saved.reason,'Output inventory failure: Unexpected end of JSON input');assert(traces.slice(1).every(t=>t===null));assert(Buffer.from(process.stderr.base64,'base64').toString().includes('incorrect number of top-level calls'));}
   rows.push({id:input.id,prefix:count,recordedStatus:saved.status,availableArtifactChecks:{stateRoot:true,logsHash:true,receiptGasAndStatus:true,signedBody:true,allocationRoot:true},rootReturnData:count===1?'verified':'incomplete_empty_later_traces'});prefixes++;
  }
  sequenceReports.push({id:input.id,transactions:d.count,proofRecords:product.proofRecords.length,productRoots:derived.map(e=>e.stateRoot)});
 }
 assert.equal(result.totalOutputBytes,totalOutputBytes);assert(totalOutputBytes<=100663296);assert.equal(result.rows.length,15);assert.deepEqual(result.counts,{matched:5,mismatched:0,unavailable:10,not_attempted:0});
 for(const e of manifest.files)checkEntry(capture,e);assert.equal(sha(raw('manifest.json')),PINS.manifest);
 return {schemaVersion:1,status:'verified_saved_artifacts',pins:PINS,counts:result.counts,inventory:{captureEntries:manifest.files.length,runtimeEntries:source.files.length,symlinks:source.files.filter(e=>e.kind==='symlink').length,totalOutputBytes},verified:{sequences:5,productCalls,prefixes,signedReceiptOccurrences:receipts,proofRecords:records,proofCalls:proofs,proofResultBytes:proofBytes,cumulativeResetRows:resetRows,readableRootTraces:readableTraces,emptyLaterTraces:emptyTraces},sequences:sequenceReports,rows,scope:{auditExecutedVm:false,auditExecutedGeth:false,publicRpc:false,signatureAndMptOnly:true,originalClassificationsPreserved:true,independentClientEvidence:'saved pinned Geth t8n outputs',productExecution:'direct proof-backed retained core; no public sequence API',allPrefixStateLogGasReceiptChecks:true,allPrefixReturnComparison:false,consensusOrMainnetReachability:false,populationAccuracy:false,processTiming:'saved diagnostics checked, not independent trusted clock',proofPhaseIds:'whole retained proof joins; no independently authenticated per-phase fetch partition'}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await audit(process.argv[2]??DEFAULT_CAPTURE),null,2));
