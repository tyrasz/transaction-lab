import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha, REL, PINS, NAMES, LIMITS, relative, recordedPaths, parseRaw, classifyGeth, checkTiming, bindProcess, storageWords, bindKzgDeclaration } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE,'../../../..');
const DEFAULT_CAPTURE = path.resolve(HERE,'../capture');
const date = s => { const n = Date.parse(s); assert(Number.isFinite(n)); return n; };
function walk(root, sub = '') {
  return fs.readdirSync(path.join(root,sub),{withFileTypes:true}).flatMap(e => {
    const p = sub ? sub+'/'+e.name : e.name; relative(p);
    return e.isDirectory() ? walk(root,p) : [p];
  }).sort();
}
function file(root, rel) { relative(rel); const p = path.join(root,rel), st = fs.lstatSync(p); assert(st.isFile() && !st.isSymbolicLink()); return fs.readFileSync(p); }
export function verifyInventory(capture, manifest, source) {
  const paths = manifest.files.map(f => relative(f.path)); assert.deepEqual(paths,[...new Set(paths)].sort());
  assert.deepEqual(walk(capture).filter(p => !p.startsWith('runtime/') && p !== 'manifest.json'),paths);
  for (const f of manifest.files) { const b = file(capture,f.path); assert.equal(b.length,f.bytes); assert.equal(sha(b),f.sha256); }
  const runtime = fs.realpathSync(path.join(capture,'runtime')); assert.deepEqual(walk(runtime),source.files.map(f => f.path));
  assert.deepEqual(source.files.map(f=>f.path),[...new Set(source.files.map(f=>f.path))].sort());
  let bytes = 0, symlinks = 0;
  for (const f of source.files) {
    relative(f.path); const p = path.join(runtime,f.path), st = fs.lstatSync(p);
    if (f.kind === 'file') { const b = file(runtime,f.path); assert.equal(b.length,f.bytes); assert.equal(sha(b),f.sha256); assert.equal(st.mode&0o777,f.mode); bytes += b.length; }
    else {
      assert.equal(f.kind,'symlink'); assert(st.isSymbolicLink()); assert.equal(fs.readlinkSync(p),f.target);
      assert(!path.isAbsolute(f.target)); const target = relative(path.posix.normalize(path.posix.join(path.posix.dirname(f.path),f.target)));
      assert(f.path.includes('/node_modules/')); assert(target.startsWith(f.path.split('/node_modules/')[0]+'/node_modules/'));
      assert(source.files.some(x => x.kind === 'file' && x.path === target)); assert.equal(fs.realpathSync(p),path.join(runtime,target)); symlinks++;
    }
  }
  return {sourceEntries:source.files.length,sourceBytes:bytes,sourceSymlinks:symlinks,evidenceFiles:paths.length};
}
export async function libraries(runtime) {
  const load = p => import(pathToFileURL(path.join(runtime,p)).href);
  const prefix = 'engines/fixture-evm/node_modules/';
  return {
    ...await load(prefix+'@ethereumjs/common/dist/esm/index.js'), ...await load(prefix+'@ethereumjs/tx/dist/esm/index.js'),
    ...await load(prefix+'@ethereumjs/util/dist/esm/index.js'), ...await load(prefix+'@ethereumjs/rlp/dist/esm/index.js'),
    ...await load(prefix+'@noble/hashes/sha3.js'), ...await load('engines/fixture-evm/state-test.js'),
    ...await load('engines/local-evm/ethereum-header.js'), ...await load('engines/local-evm/input-facts.js'), ...await load('engines/local-evm/verified-state-proof.js'),
  };
}
export async function applyProductChanges(state, changes, lib) {
  assert(Array.isArray(changes.accounts)); assert.equal(new Set(changes.accounts.map(r=>r.address)).size,changes.accounts.length);
  for (const row of changes.accounts) {
    const address = lib.createAddressFromString(row.address), before = await state.getAccount(address);
    if (row.existence) assert.equal(before !== undefined,row.existence.before);
    for (const key of ['nonce','balance']) if (row[key]) assert.equal(before?.[key]??0n,BigInt(row[key].before));
    if (row.code) assert.equal(lib.bytesToHex(await state.getCode(address)),row.code.before);
    assert.equal(new Set((row.storage??[]).map(s=>s.slot)).size,(row.storage??[]).length);
    for (const slot of row.storage??[]) { const b = await state.getStorage(address,lib.hexToBytes(slot.slot)); assert.equal(b.length?BigInt(lib.bytesToHex(b)):0n,BigInt(slot.before)); }
    if (row.existence?.after === false) { await state.deleteAccount(address); continue; }
    if (!before) await state.putAccount(address,lib.createAccount({nonce:0n,balance:0n}));
    for (const key of ['nonce','balance']) if (row[key]) await state.modifyAccountFields(address,{[key]:BigInt(row[key].after)});
    if (row.code) await state.putCode(address,lib.hexToBytes(row.code.after));
    for (const slot of row.storage??[]) await state.putStorage(address,lib.hexToBytes(slot.slot),lib.bigIntToBytes(BigInt(slot.after)));
  }
  return lib.bytesToHex(await state.getStateRoot());
}
export function bindSignedTransaction(input, common, lib) {
  const r=input.request,raw=lib.hexToBytes(input.signedTransaction);
  assert.equal(r.executionProfile,'unsigned_eip1559_block_end');
  assert.deepEqual(Object.keys(r).sort(),['from','to','data','gas','value','executionProfile','fees',...(Object.hasOwn(r,'accessList')?['accessList']:[])].sort());
  assert.equal(raw[0],2); const fields=lib.RLP.decode(raw.subarray(1)); assert(Array.isArray(fields)); assert.equal(fields.length,12);
  const tx=lib.createTxFromRLP(raw,{common});
  assert.equal(tx.type,2);assert.equal(tx.chainId,1n);assert(tx.verifySignature());
  assert.equal(lib.bytesToHex(tx.serialize()),input.signedTransaction);assert.equal(tx.getSenderAddress().toString(),r.from);
  assert.equal(tx.to.toString(),r.to);assert.equal(tx.nonce,BigInt(input.allocation[r.from].nonce));
  for(const[key,expected]of [['gasLimit',r.gas],['value',r.value],['maxFeePerGas',r.fees.maxFeePerGas],['maxPriorityFeePerGas',r.fees.maxPriorityFeePerGas]])assert.equal(tx[key],BigInt(expected));
  assert.equal(lib.bytesToHex(tx.data),r.data);assert.deepEqual(tx.accessList,(r.accessList??[]).map(row=>[lib.hexToBytes(row.address),row.storageKeys.map(lib.hexToBytes)]));
  assert.deepEqual(Object.keys(r.fees).sort(),['maxFeePerGas','maxPriorityFeePerGas']);
  return tx;
}
export async function verifyEvidence({captureDirectory=DEFAULT_CAPTURE,expectedManifestSha256,expectedPlanSha256,expectedSourceSha256,expectedProductCommit} = {}) {
  const capture = fs.realpathSync(captureDirectory), runtime = path.join(capture,'runtime'), read = p=>file(capture,p), json = p=>JSON.parse(read(p));
  for (const h of [expectedManifestSha256,expectedPlanSha256,expectedSourceSha256]) assert.match(h,/^[0-9a-f]{64}$/);
  for (const [p,h] of [['manifest.json',expectedManifestSha256],['PLAN.json',expectedPlanSha256],['source-manifest.json',expectedSourceSha256]]) assert.equal(sha(read(p)),h);
  const manifest=json('manifest.json'),plan=json('PLAN.json'),source=json('source-manifest.json'),results=json('results.json'),seal=json('EXPECTATIONS_SEALED.json'),started=json('STARTED.json');
  assert.equal(manifest.schemaVersion,1); assert.equal(manifest.planSha256,expectedPlanSha256); assert.equal(plan.sourceManifestSha256,expectedSourceSha256);
  const inventory=verifyInventory(capture,manifest,source),recorded=recordedPaths(plan);
  assert.deepEqual(plan.limits,LIMITS); assert.deepEqual(plan.cases.map(c=>c.name),NAMES); assert.deepEqual(plan.node,source.node); assert.deepEqual(plan.geth,source.geth); assert.deepEqual(plan.git,source.git);
  assert.match(expectedProductCommit,/^[0-9a-f]{40}$/); assert.equal(plan.git.productCommit,expectedProductCommit); assert.equal(plan.git.trackedProductUnchanged,true);
  assert.equal(plan.scope.publicRpc,0); assert.equal(plan.scope.populationAccuracy,false); assert.equal(plan.scope.prospective,false);
  assert.equal(plan.scope.gethGasReturnReceiptCompared,false); assert.equal(plan.scope.retries,0); assert.equal(plan.scope.replacements,0);
  for (const key of ['sidecarKZGVerified','wholeBlobValidityVerified','blockBodyCapacityVerified']) assert.equal(plan.scope[key],false);
  for(const key of ['syntheticHeaders','productionMainnetForkSelection','sharedOpcodeLibraryForFullVM','sharedKzgVerifierForFullVM','executedPointEvaluation','directReturnComparedOnlyBySharedFullVM'])assert.equal(plan.scope[key],true);
  assert.equal(plan.scope.blobFeeSettlement,false);assert.equal(plan.scope.syntheticDevelopment,true);assert.equal(plan.scope.product,'archived_executeIsolatedEthereumCall');
  assert.deepEqual(results.scope,plan.scope); assert.equal(results.planSha256,expectedPlanSha256); checkTiming(results);
  assert.equal(started.planSha256,expectedPlanSha256); assert(Number.isSafeInteger(started.pid)&&started.pid>0); assert.equal(seal.planSha256,expectedPlanSha256);
  assert(date(plan.frozenAt)<=date(started.startedAt)); assert(date(started.startedAt)<=date(seal.at)); assert(date(seal.at)<=date(results.finishedAt));
  assert(Math.abs(date(results.finishedAt)-date(started.startedAt)-results.elapsedMs)<1000);
  assert.equal(seal.prepared.length,16); assert.equal(results.rows.length,16);
  // Tool provenance is checked from captured copies, never by executing a tool.
  const tool=json('toolchain/toolchain-manifest.json'); assert.equal(sha(read('toolchain/toolchain-manifest.json')),PINS.toolchain);
  assert.equal(tool.binary.sha256,PINS.binary); assert.equal(plan.geth.binary.sha256,PINS.binary); assert.deepEqual(plan.geth.binary,tool.binary);
  assert.deepEqual(plan.geth.source,tool.source); assert.deepEqual(plan.geth.dependencyInventory,tool.build.moduleInventory); assert.deepEqual(plan.geth.buildManifest,tool.build.rawManifest);
  for (const binding of [tool.source.inventory,tool.build.moduleInventory,tool.build.rawManifest]) { const b=read('toolchain/'+binding.path); assert.equal(b.length,binding.bytes); assert.equal(sha(b),binding.sha256); }
  assert.equal(tool.source.commit,'1df30b18d9ed35ee9d28ffd4648442c2204554ad');
  // Do not require the original absolute checkout or executable path to exist.
  assert.equal(sha(fs.readFileSync(process.execPath)),plan.node.sha256); assert.equal(process.version,plan.node.version); assert.equal(process.platform,plan.node.platform); assert.equal(process.arch,plan.node.arch);
  const localBinary=path.resolve(ROOT,'../evm-toolchains/geth-v1.17.10/bin/evm');
  const binaryPresent=fs.existsSync(localBinary); if(binaryPresent)assert.equal(sha(fs.readFileSync(localBinary)),PINS.binary);
  const lib=await libraries(runtime),hashLogs=logs=>lib.bytesToHex(lib.keccak_256(lib.RLP.encode(logs.map(l=>[lib.hexToBytes(l.address),l.topics.map(lib.hexToBytes),lib.hexToBytes(l.data)]))));
  const fixtureModule=await import(pathToFileURL(path.join(runtime,REL,'cases.mjs')).href);
  assert.deepEqual(fixtureModule.NAMES,NAMES);
  let rawBytes=0,proofCalls=0; const rows=[],counts={matched:0,mismatched:0,unavailable:0,unattempted:0};
  for (const [i,c] of plan.cases.entries()) {
    const id=String(i+1).padStart(3,'0'); assert.equal(c.index,i); assert.equal(c.path,`inputs/${id}.json`);
    const input=json(c.path); assert.equal(input.index,i); assert.equal(input.name,c.name); assert.equal(input.fork,c.fork);
    assert.equal(read(c.path).length,c.bytes); assert.equal(sha(read(c.path)),c.sha256); storageWords(input.allocation);
    bindKzgDeclaration(input,i,file(runtime,'engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/pointEvaluation.json'));
    // Pure reconstruction only: no product, full-VM runTx, or Geth target.
    const f=await fixtureModule.fixtureAt(i); const allocation=Object.fromEntries(Object.entries(f.allocation).map(([a,v])=>[a,{...v,storage:Object.fromEntries(Object.entries(v.storage).map(([k,val])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(val).toString(16).padStart(64,'0')]))}]));
    assert.deepEqual(input.header,f.header); assert.deepEqual(input.request,f.request); assert.deepEqual(input.allocation,allocation); assert.deepEqual(f.calls,[]);
    assert.deepEqual(input.contextScope,{signedType:2,syntheticHeader:true,productionMainnetForkSelection:true,executedSinglePointEvaluation:true,officialInputSourceSha256:'e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d',sharedCryptoAndOpcodesForFullVM:true,sidecarsValidated:false,wholeBlobValidityValidated:false,gethBlockBodyCapacityValidated:false});
    const common=new lib.Common({chain:lib.Mainnet}); common.setHardforkBy({blockNumber:BigInt(input.header.number),timestamp:BigInt(input.header.timestamp)});
    assert.equal(lib.verifyEthereumHeader({header:input.header,expectedHash:input.header.hash}).hardfork,c.fork.toLowerCase());
    const state=await lib.loadState(input.allocation,common); assert.equal(lib.bytesToHex(await state.getStateRoot()),input.header.stateRoot);
    const tx=bindSignedTransaction(input,common,lib);assert.equal(tx.type,2);
    const product=json(`results/${id}-product.json`),reference=json(`results/${id}-reference.json`),productSeal=json(`results/${id}-PRODUCT_SEALED.json`);
    for (const [mode,record] of [['product',product],['reference',reference]]) {
      bindProcess(record.raw,{binary:plan.node.executable,args:[recorded.worker,mode,path.posix.join(recorded.capture,c.path),...(mode==='reference'?[path.posix.join(recorded.capture,`results/${id}-product.json`)]:[])]});
      const parsed=parseRaw(record.raw,{timeout:LIMITS.workerMs,bytes:LIMITS.workerOutputBytes}); assert(parsed.clean&&parsed.jsonValid); assert.deepEqual(parsed.parsed,record.result); assert.equal(record.result.status,'completed'); rawBytes+=parsed.bytes;
    }
    assert.equal(productSeal.path,`results/${id}-product.json`); assert.equal(productSeal.bytes,read(productSeal.path).length); assert.equal(productSeal.sha256,sha(read(productSeal.path)));
    assert(date(productSeal.at)>=date(started.startedAt)&&date(productSeal.at)<=date(seal.at));
    const a=product.result.attempt,out=a.output,ref=reference.result;
    assert.equal(a.status,'completed'); assert.equal(a.error,null); assert(['success','reverted','failed'].includes(out.execution.status));
    assert.equal(a.isolation.processClosed,true); assert.equal(a.isolation.exitCode,0); assert.equal(a.isolation.exitSignal,null); assert.equal(a.isolation.terminateRequested,false);
    assert(Number.isSafeInteger(a.isolation.childPid)&&a.isolation.childPid>0); assert(a.isolation.durationMs>=0&&a.isolation.durationMs<=11000);
    assert.equal(a.broker.pendingAtReturn,0); assert.equal(a.broker.rawWireCaptured,false);
    assert.deepEqual(a.inputs.context.header,input.header); assert.equal(a.inputs.context.stateRoot,input.header.stateRoot);
    assert.deepEqual(product.result.requests,a.inputEvidence.map(e=>e.request)); assert.equal(a.broker.calls,a.inputEvidence.length); assert.equal(a.broker.records.length,a.inputEvidence.length);
    for (const [index,e] of a.inputEvidence.entries()) {
      const b=a.broker.records[index],request=e.request; assert.equal(e.id,index+1); assert.equal(b.id,e.id); assert.deepEqual(b.request,request);
      assert.equal(e.requestText,JSON.stringify(request)); assert.equal(e.requestSha256,sha(e.requestText));
      assert(['eth_getProof','eth_getCode'].includes(request.method)); assert.deepEqual(request.params.at(-1),{blockHash:input.header.hash,requireCanonical:true});
      const encoded=Buffer.from(JSON.stringify(e.result)); assert.equal(e.resultBytes,encoded.length); assert.equal(e.resultSha256,sha(encoded)); assert.equal(b.resultBytes,e.resultBytes); assert.equal(b.resultSha256,e.resultSha256);
      assert.equal(e.status,'received'); assert.equal(b.status,'received'); assert.equal(e.representation,'parsed_rpc_result_not_wire_bytes');
      if(request.method==='eth_getProof'){
        const code=a.inputEvidence.find(row=>row.request.method==='eth_getCode'&&row.request.params[0]===request.params[0]);assert(code);
        await lib.verifyStateProof({stateRoot:input.header.stateRoot,address:request.params[0],storageKeys:request.params[1],proof:e.result,code:code.result});
        proofCalls++;
      }
    }
    await lib.validateInputFacts({inputs:a.inputs,inputEvidence:a.inputEvidence,stateRoot:input.header.stateRoot});
    const applied=await applyProductChanges(state,a.changes,lib),logHash=hashLogs(out.logs);
    assert.equal(ref.productApplicationError,null); assert.equal(ref.productAppliedStateRoot,applied);
    const agreement=ref.fullVM?{status:'matched',checks:{state:applied===ref.fullVM.stateRoot,logs:logHash===ref.fullVM.logsHash,return:out.execution.returnData===ref.fullVM.returnData,status:out.execution.status===(ref.fullVM.execution==='revert'?'reverted':ref.fullVM.execution==='success'?'success':'failed'),gas:out.gasAccounting.gasUsed===ref.fullVM.gasUsed}}:{status:'unavailable'};
    if(ref.fullVM){assert.equal(ref.fullVMError,null);assert.equal(hashLogs(ref.fullVM.logs),ref.fullVM.logsHash);if(!Object.values(agreement.checks).every(Boolean))agreement.status='mismatched';}
    else assert(ref.fullVMError&&typeof ref.fullVMError.message==='string');
    assert.deepEqual(json(`results/${id}-fullVM-comparison.json`),agreement);
    const wrapObject=json(`geth-inputs/${id}.json`); assert.deepEqual(Object.keys(wrapObject),[c.name]); const w=wrapObject[c.name],r=input.request,h=input.header;
    assert.deepEqual(w.config,{chainid:'0x01'}); assert.deepEqual(w.pre,input.allocation);
    assert.deepEqual(w.env,{currentCoinbase:h.miner,currentDifficulty:h.difficulty,currentRandom:h.mixHash,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentBaseFee:h.baseFeePerGas,...(h.excessBlobGas===undefined?{}:{currentExcessBlobGas:h.excessBlobGas})});
    const q=x=>'0x'+BigInt(x).toString(16),expectedTx={sender:r.from,chainId:'0x1',to:r.to??'',data:[r.data],value:[q(r.value)],gasLimit:[q(r.gas)],maxFeePerGas:q(r.fees.maxFeePerGas),maxPriorityFeePerGas:q(r.fees.maxPriorityFeePerGas),nonce:q(input.allocation[r.from].nonce),secretKey:w.transaction.secretKey,...(r.accessList?{accessLists:[r.accessList]}:{})};
    assert.deepEqual(w.transaction,expectedTx); assert.equal(lib.bytesToHex(lib.privateToAddress(lib.hexToBytes(w.transaction.secretKey))),r.from);
    assert.deepEqual(w.post,{[c.fork]:[{hash:applied,logs:logHash,txbytes:input.signedTransaction,indexes:{data:0,gas:0,value:0}}]});
    const binding={bytes:read(`geth-inputs/${id}.json`).length,sha256:sha(read(`geth-inputs/${id}.json`))},expected={name:c.name,fork:c.fork,stateRoot:applied};
    assert.deepEqual(seal.prepared[i],{index:i,input:`geth-inputs/${id}.json`,binding,expected,fullVM:agreement});
    const raw=json(`raw/${id}.json`); bindProcess(raw,{binary:plan.geth.binary.path,args:['statetest','--statetest.fork='+c.fork,'--run=^'+c.name+'$',path.posix.join(recorded.capture,`geth-inputs/${id}.json`)]});
    assert.deepEqual(raw.inputIdentity,binding); const parsed=parseRaw(raw,{timeout:5000,bytes:1048576}); rawBytes+=parsed.bytes;
    const comparison=classifyGeth(raw,expected); assert.deepEqual(results.rows[i],{name:c.name,fork:c.fork,...comparison,fullVM:agreement}); counts[comparison.status]++;
    rows.push({index:i+1,name:c.name,fork:c.fork,status:comparison.status,reportedRootMatches:comparison.checks?.stateRoot??null,gethPass:comparison.result?.pass??null,
      logAssertionEstablished:comparison.result?.pass===true,rawError:comparison.result?.error??null,productExecution:out.execution.status,productDeltaRoot:applied,fullVM:agreement.status,gas:out.gasAccounting.gasUsed,committedLogs:out.logs.length});
  }
  assert.deepEqual(results.counts,counts);
  verifyInventory(capture,manifest,source); // No artifact changed while checked.
  return {status:'verified',manifestSha256:expectedManifestSha256,planSha256:expectedPlanSha256,sourceManifestSha256:expectedSourceSha256,productCommit:expectedProductCommit,...inventory,
    rawOutputBytes:rawBytes,verifiedProofCalls:proofCalls,counts,rows,nodeExecutableHashVerified:true,gethBinaryHashVerified:binaryPresent,
    limitations:{publicRpc:0,targetReexecutions:0,newProductOrFullVMExecution:0,independentRawClassification:true,independentProductDeltaApplication:true,
      reusedArchivedHeaderProofMPTAndTransactionPrimitives:true,proofInputsAreSyntheticParsedResultsNotNetworkWires:true,
      sourceCommitClaimBoundByReviewedFrozenManifest:true,gitCommitHistoryReconstructed:false,chronologyEstablishedBySavedProtocolAndSourceNotExternalClock:true,
      gethGasReturnReceiptsCompared:false,failedPassIsNeverOverriddenByDisplayedRoot:true,populationAccuracyEstablished:false,sidecarsKZGVerified:false,wholeBlobValidityVerified:false,sharedKzgVerifierForFullVM:true,directReturnComparedOnlyBySharedFullVM:true,blockBodyCapacityVerified:false,
      strictCompletePacketAudit:true,incompleteProductOrMissingExpectedRootRejectedRatherThanScored:true},
    dependencyPaths:source.files.filter(f=>f.path.includes('/node_modules/')).map(f=>REL+'/capture/runtime/'+f.path)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),[captureDirectory,expectedManifestSha256,expectedPlanSha256,expectedSourceSha256,expectedProductCommit]=args;
  const options=args[0]==='--pinned'?{captureDirectory:DEFAULT_CAPTURE,...JSON.parse(fs.readFileSync(path.join(HERE,'pins.json')))}
    :{captureDirectory,expectedManifestSha256,expectedPlanSha256,expectedSourceSha256,expectedProductCommit};
  assert(options.captureDirectory&&options.expectedManifestSha256&&options.expectedPlanSha256&&options.expectedSourceSha256&&options.expectedProductCommit,'Supply capture, manifest SHA, plan SHA, source SHA and product commit, or --pinned for the independently supplied pins.json.');
  const report=await verifyEvidence(options);
  const dependencyPaths=report.dependencyPaths;delete report.dependencyPaths;const list=Buffer.from(dependencyPaths.join('\0')+'\0');
  report.forceAdd={path:REL+'/audit/ignored-dependencies.paths0',count:dependencyPaths.length,sha256:sha(list)};
  if(args.includes('--write')){fs.writeFileSync(path.join(HERE,'report.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(HERE,'ignored-dependencies.paths0'),list);}
  console.log(JSON.stringify({status:report.status,counts:report.counts,sourceEntries:report.sourceEntries,evidenceFiles:report.evidenceFiles,verifiedProofCalls:report.verifiedProofCalls,dependencyPaths:dependencyPaths.length}));
}
