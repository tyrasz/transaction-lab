// Preparation only: no child processes, VM execution, RPC or output-file writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Common, Mainnet, Hardfork } from '../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createTx, createTxFromRLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { RLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/fixture-evm/node_modules/@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, createAddressFromString } from '../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';

export const CORPUS = Object.freeze({ directory:'research/evm-lifecycle-differential-v1/capture-v2', count:16,
  manifestSha256:'299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3',
  planSha256:'82edf8c8f06d33180ac109f61ed9247da6b596a5c618b9c2fa7ea16937fd1f86',
  productVersion:'0.18.0', productBaseCommit:'dcc0554' });
export const SCOPE = Object.freeze({ synthetic:true, officialExpectedPostUsed:false, independentOpcodeImplementation:true,
  expectedRootSource:'sealed_full_VM_reference', expectedLogsSource:'sealed_full_VM_reference_RLP_Keccak',
  comparedChannels:['full_poststate_root','Geth_internal_log_hash_assertion'], oldProductVersion:'0.18.0',
  currentProductAccuracy:false, populationCoverage:false, fiveChannelAgreement:false, gasReturnReceiptChecked:false,
  blockSystemCalls:false, injectedSystemCode:false, targetExecutionsDuringPreparation:0 });
const ADDRESS=/^0x[0-9a-f]{40}$/, WORD=/^0x[0-9a-f]{64}$/, DATA=/^0x(?:[0-9a-f]{2})*$/;
const MAX_FILE=32*1024*1024;
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function keys(v,names){assert(object(v));assert.deepEqual(Object.keys(v).sort(),[...names].sort());}
function decimal(v){assert.equal(typeof v,'string');assert.match(v,/^(0|[1-9][0-9]*)$/);const n=BigInt(v);assert(n<(1n<<256n));return n;}
const hex=n=>'0x'+BigInt(n).toString(16);
function bytes(v){assert.equal(typeof v,'string');assert.match(v,DATA);assert(v.length<=2*MAX_FILE+2);return hexToBytes(v);}
const detached=v=>JSON.parse(JSON.stringify(v));

/** Ethereum Log's consensus RLP contains address/topics/data only. */
export function logsHash(logs){
  assert(Array.isArray(logs)&&logs.length<=2000);let total=0;
  const encoded=logs.map(log=>{keys(log,['address','topics','data']);assert.match(log.address,ADDRESS);assert(Array.isArray(log.topics)&&log.topics.length<=4);log.topics.forEach(t=>assert.match(t,WORD));
    const data=bytes(log.data);assert((total+=data.length)<=8*1024*1024);return[hexToBytes(log.address),log.topics.map(hexToBytes),data];});
  return bytesToHex(keccak_256(RLP.encode(encoded)));
}
/** Conservative scan at instruction boundaries, excluding PUSH payloads. This
 * describes compatibility, not execution coverage or a reachability proof. */
export function contextOpcodes(code){
  const b=bytes(code),found=[];for(let pc=0;pc<b.length;pc++){const op=b[pc];if([0x40,0x49,0x4a].includes(op))found.push({pc,opcode:hex(op)});if(op>=0x60&&op<=0x7f)pc+=op-0x5f;}return found;
}
function codeCompatibility(declaration,product){
  const rows=Object.entries(declaration.pre).map(([address,a])=>({origin:'initial:'+address,code:a.code}));let frames=0;
  function walk(f,depth=0){assert(object(f)&&++frames<=1000&&depth<=32);assert(Array.isArray(f.calls));
    if(['CREATE','CREATE2'].includes(f.type)){rows.push({origin:'recorded_initcode:'+frames,code:f.input});rows.push({origin:'recorded_runtime:'+frames,code:f.output});}f.calls.forEach(c=>walk(c,depth+1));}
  walk(product.attempt.output.trace);
  const hits=rows.flatMap(r=>contextOpcodes(r.code).map(hit=>({origin:r.origin,...hit})));
  assert.deepEqual(hits,[],'Statetest BLOCKHASH/blob context is not interchangeable; do not repair or substitute this case.');
  return{examinedCodeItems:rows.length,instructionBoundaryContextOpcodeHits:hits,staticScanOnly:true,reachabilityOrOpcodeCoverageEstablished:false};
}

export async function adaptSyntheticCase({declaration,reference,product,comparison}){
  // Expected outputs stay in the post assertions; they never enter pre/header/tx.
  const d=detached(declaration);assert.equal(d.schemaVersion,1);assert.equal(d.kind,'synthetic_zero_fee_counterpart_not_official_replay');
  assert(object(d.identity)&&Number.isSafeInteger(d.identity.index)&&d.identity.index>0&&typeof d.identity.id==='string'&&d.identity.id.length<4096);
  keys(d.request,['from','to','data','value','gas']);keys(d.transaction,['type','chainId','from','to','data','value','gasLimit','nonce','gasPrice','secretKey']);
  const tx=d.transaction;assert.equal(tx.type,0);assert.equal(tx.chainId,1);assert.equal(tx.gasPrice,'0');assert.match(tx.from,ADDRESS);assert(tx.to===null||ADDRESS.test(tx.to));assert.match(tx.secretKey,WORD);
  assert.deepEqual(d.request,{from:tx.from,to:tx.to,data:tx.data,value:tx.value,gas:tx.gasLimit});bytes(tx.data);assert(tx.data.length<=65538);
  const gas=decimal(tx.gasLimit);assert(gas>0n&&gas<=5000000n);decimal(tx.value);assert(decimal(tx.nonce)<1n<<64n);
  const h=d.header,verified=verifyEthereumHeader({header:h,expectedHash:h.hash});assert.equal(verified.hardfork,'osaka');
  assert.equal(BigInt(h.number),22000000n);assert.equal(BigInt(h.timestamp),1764798551n);assert.equal(BigInt(h.baseFeePerGas),0n);assert.equal(BigInt(h.difficulty),0n);assert.equal(BigInt(h.excessBlobGas),0n);assert.equal(BigInt(h.blobGasUsed),0n);assert(gas<=BigInt(h.gasLimit));
  assert.equal(d.initialStateRoot,h.stateRoot);assert.equal(d.transformations.originalExpectedOutputsUsed,false);assert.equal(d.transformations.syntheticGas,tx.gasLimit);assert.equal(d.transformations.syntheticGasPrice,'0');assert.deepEqual(d.transformations.syntheticHeader,h);
  const common=new Common({chain:Mainnet,hardfork:Hardfork.Osaka});
  const state=await loadState(d.pre,common);assert.equal(bytesToHex(await state.getStateRoot()),d.initialStateRoot);
  const sender=await state.getAccount(createAddressFromString(tx.from));assert(sender);assert.equal(sender.nonce,BigInt(tx.nonce));
  const signed=createTx({type:0,nonce:BigInt(tx.nonce),gasLimit:gas,gasPrice:0n,to:tx.to??undefined,value:BigInt(tx.value),data:tx.data},{common}).sign(hexToBytes(tx.secretKey));
  assert.equal(bytesToHex(signed.serialize()),d.serializedTransaction);const decoded=createTxFromRLP(bytes(d.serializedTransaction),{common});assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),tx.from);
  assert.equal(reference.status,'completed');assert.equal(reference.reason,null);assert.equal(reference.exitCode,0);assert.equal(reference.signal,null);assert.equal(reference.stderr,'');assert.deepEqual(JSON.parse(reference.stdout),reference.result);
  const ref=reference.result;assert.equal(ref.status,'completed');assert.match(ref.output.stateRoot,WORD);assert.equal(ref.output.serializedTransaction,d.serializedTransaction);assert(['success','reverted','failed'].includes(ref.output.execution));
  assert.equal(ref.scope.originalOfficialExpectedPostUsed,false);assert.equal(ref.scope.fullVmSignedTransaction,true);assert.equal(ref.scope.fullMptFinalization,true);assert.equal(ref.scope.zeroGasPrice,true);assert.equal(ref.scope.zeroBaseFee,true);
  assert.equal(product.attempt.status,'completed');assert.equal(product.attempt.output.profile.sourceBlockHash,h.hash);assert.equal(product.attempt.output.profile.sourceStateRoot,d.initialStateRoot);assert.equal(product.attempt.output.profile.hardfork,'osaka');
  assert.equal(product.attempt.output.execution.status,ref.output.execution);assert.deepEqual(product.attempt.output.logs.map(({address,topics,data})=>({address,topics,data})),ref.output.logs);
  assert.equal(comparison.status,'matched');assert.deepEqual(comparison.checks,{execution:true,returnData:true,logs:true,gas:true,stateRoot:true});assert.equal(comparison.applied.stateRoot,ref.output.stateRoot);
  // The fixed corpus's coinbase is absent before and after. The additional
  // Geth zero-value coinbase touch therefore has no retained account effect.
  assert(!Object.keys(d.pre).some(a=>a.toLowerCase()===h.miner));const coinbase=ref.observedState.filter(a=>a.address===h.miner);assert.equal(coinbase.length,1);assert.equal(coinbase[0].exists,false);
  const compatibility={...codeCompatibility(d,product),coinbaseAbsentBeforeAndInSealedReference:true,legacyTransactionOnly:true,
    blockhash:'Geth vmTestBlockHash invents Keccak(decimal number); scanned corpus code has no BLOCKHASH',
    blobBaseFee:'Geth derives fee from excessBlobGas; no blob transaction or scanned blob opcode in this corpus',
    signature:'Adapter independently binds signature bytes to message fields; Geth statetest itself only separately recovers txbytes'};
  const expected={stateRoot:ref.output.stateRoot,logsHash:logsHash(ref.output.logs)};
  const fixture={env:{currentCoinbase:h.miner,currentDifficulty:h.difficulty,currentRandom:h.mixHash,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentBaseFee:h.baseFeePerGas,currentExcessBlobGas:h.excessBlobGas},
    pre:d.pre,transaction:{gasPrice:'0x0',nonce:hex(tx.nonce),to:tx.to??'',data:[tx.data],gasLimit:[hex(gas)],value:[hex(tx.value)],secretKey:tx.secretKey,sender:tx.from},
    post:{Osaka:[{hash:expected.stateRoot,logs:expected.logsHash,txbytes:d.serializedTransaction,indexes:{data:0,gas:0,value:0}}]}};
  return{index:d.identity.index,id:d.identity.id,category:d.identity.category,wrapper:{[d.identity.id]:fixture},expected,compatibility,scope:detached(SCOPE)};
}

function safePath(relative){assert.equal(typeof relative,'string');assert(relative&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'));return relative;}
async function regular(root,relative){const parts=safePath(relative).split('/');for(let i=1;i<=parts.length;i++){const s=await fs.lstat(path.join(root,...parts.slice(0,i)));assert(!s.isSymbolicLink());assert(i===parts.length?s.isFile()&&s.size<=MAX_FILE:s.isDirectory());}return fs.readFile(path.join(root,relative));}
/** Bind every original evidence artifact. Runtime source is separately bound by
 * the old plan; a future executable harness must freeze its own full imports. */
export async function verifyEvidenceInventory({directory,manifestSha256,planSha256}){
  const root=await fs.realpath(directory),raw=await regular(root,'manifest.json');assert.equal(sha(raw),manifestSha256);const manifest=JSON.parse(raw);
  assert.equal(manifest.planSha256,planSha256);assert(Array.isArray(manifest.files)&&manifest.files.length<=10000);const records=new Map(),loaded=new Map();
  for(const item of manifest.files){keys(item,['path','bytes','sha256']);safePath(item.path);assert(!records.has(item.path));assert(Number.isSafeInteger(item.bytes)&&item.bytes>=0&&item.bytes<=MAX_FILE);assert.match(item.sha256,/^[0-9a-f]{64}$/);
    const b=await regular(root,item.path);assert.equal(b.length,item.bytes);assert.equal(sha(b),item.sha256);records.set(item.path,item);loaded.set(item.path,b);}
  assert(records.has('plan.json'));assert.equal(records.get('plan.json').sha256,planSha256);
  return{manifest,read(relative){assert(loaded.has(relative),'Artifact is outside original manifest');return JSON.parse(loaded.get(relative));},record(relative){assert(records.has(relative));return detached(records.get(relative));}};
}
export async function loadSealedCorpus(repoRoot){
  const packet=await verifyEvidenceInventory({directory:path.join(repoRoot,CORPUS.directory),manifestSha256:CORPUS.manifestSha256,planSha256:CORPUS.planSha256});
  const plan=packet.read('plan.json');assert.equal(plan.productVersion,CORPUS.productVersion);assert.equal(plan.productBaseCommit,CORPUS.productBaseCommit);assert.equal(plan.cases.length,CORPUS.count);
  const rows=[],seen=new Set();
  for(let i=0;i<CORPUS.count;i++){
    const c=plan.cases[i],tag=String(i+1).padStart(3,'0');assert.equal(c.index,i+1);assert.equal(c.path,`declarations/${tag}.json`);assert(!seen.has(c.id));seen.add(c.id);const declaration=packet.read(c.path);assert.equal(declaration.identity.id,c.id);assert.equal(declaration.identity.index,c.index);assert.equal(declaration.identity.category,c.category);assert.equal(c.sha256,packet.record(c.path).sha256);assert.equal(c.bytes,packet.record(c.path).bytes);
    const referencePath=`results/${tag}-reference.json`,productPath=`results/${tag}-product.json`,comparisonPath=`results/${tag}-comparison.json`,sealPath=`results/${tag}-PRODUCT_SEALED.json`;
    const seal=packet.read(sealPath),productRecord=packet.record(productPath);assert.equal(seal.planSha256,CORPUS.planSha256);assert.equal(seal.caseIndex,c.index);assert.equal(seal.caseId,c.id);assert.equal(seal.productPath,`${tag}-product.json`);assert.equal(seal.productSha256,productRecord.sha256);assert.equal(seal.productBytes,productRecord.bytes);
    rows.push({...await adaptSyntheticCase({declaration,reference:packet.read(referencePath),product:packet.read(productPath),comparison:packet.read(comparisonPath)}),
      originalArtifacts:[c.path,referencePath,productPath,comparisonPath,sealPath].map(p=>packet.record(p))});
  }
  return{schemaVersion:1,sourceCapture:{...CORPUS,manifest:packet.manifest},count:rows.length,rows,scope:detached(SCOPE)};
}
