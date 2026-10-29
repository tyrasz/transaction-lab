// Artifact-only audit. No producer import, EVM execution, fetch or RPC client.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const family=path.join(root,'research/sepolia-owned-smoke-v031-1rpc');
const capture=path.join(family,'capture');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=b=>'0x'+Buffer.from(b).toString('hex');
const raw=h=>Uint8Array.from(Buffer.from(h.slice(2),'hex'));
const bytes=n=>fs.readFileSync(path.join(capture,n));
const read=n=>JSON.parse(bytes(n));
const manifestSha256='80250020a55703755f9b09330cac8b3b6707f338c71732b3415dd5669a7c2448';

// Independent fixed-length secure MPT path walk. This packet has eight hashed
// branches and one hashed leaf; reject another shape instead of generalizing.
function verifySenderLeaf(stateRoot,address,proof) {
  const nibbles=[...keccak_256(raw(address))].flatMap(n=>[n>>4,n&15]);
  assert.equal(proof.address,address); assert.equal(proof.accountProof.length,9);
  let expected=stateRoot,at=0,account;
  for(const [i,text] of proof.accountProof.entries()) {
    assert(/^0x(?:[0-9a-f]{2})+$/.test(text));const b=raw(text);
    assert.equal(hex(keccak_256(b)),expected);
    const node=RLP.decode(b);assert.deepEqual(RLP.encode(node),b);
    if(i<8){assert(Array.isArray(node)&&node.length===17);assert.equal(node[16].length,0);const link=node[nibbles[at++]];assert(link instanceof Uint8Array&&link.length===32);expected=hex(link);}
    else {assert(Array.isArray(node)&&node.length===2);const compact=node[0],flag=compact[0]>>4;assert(flag===2||flag===3);const tail=[];if(flag===3)tail.push(compact[0]&15);else assert.equal(compact[0]&15,0);for(const n of compact.slice(1))tail.push(n>>4,n&15);assert.deepEqual(tail,nibbles.slice(at));account=RLP.decode(node[1]);assert.deepEqual(RLP.encode(account),node[1]);}
  }
  assert(Array.isArray(account)&&account.length===4&&account.every(x=>x instanceof Uint8Array));
  const integer=b=>{assert(b.length===0||b[0]!==0);return b.length?BigInt(hex(b)):0n;};
  const nonce=integer(account[0]),balance=integer(account[1]);assert(nonce<(1n<<64n)&&balance<(1n<<256n));
  assert.equal(account[2].length,32);assert.equal(account[3].length,32);
  assert.equal(nonce,BigInt(proof.nonce));assert.equal(balance,BigInt(proof.balance));
  assert.equal(hex(account[2]),proof.storageHash);assert.equal(hex(account[3]),proof.codeHash);assert.deepEqual(proof.storageProof,[]);
  return {address,exists:true,nonce:nonce.toString(),balanceWei:balance.toString(),storageRoot:hex(account[2]),codeHash:hex(account[3]),proofNodes:9};
}

assert.equal(sha(bytes('manifest.json')),manifestSha256);
const manifest=read('manifest.json'),names=new Set();let artifactBytes=0;
for(const row of manifest.files){assert(/^[A-Za-z0-9._-]+$/.test(row.path)&&!names.has(row.path));names.add(row.path);const stat=fs.lstatSync(path.join(capture,row.path));assert(stat.isFile()&&!stat.isSymbolicLink());const b=bytes(row.path);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);artifactBytes+=b.length;}
assert.equal(names.size,16);assert.deepEqual(fs.readdirSync(capture).sort(),[...names,'manifest.json'].sort());
const plan=read('plan.json'),source=read('source.json'),result=read('results.json'),preview=read('preview.json'),seal=read('PRODUCT_SEALED.json');
assert.equal(sha(JSON.stringify(source)),plan.sourceSha256);assert.equal(read('STARTED.json').sourceSha256,plan.sourceSha256);
assert.equal(source.implementation.sourceSha256,sha(JSON.stringify({files:source.implementation.inventory,runtime:source.implementation.runtime})));
assert.deepEqual(source.implementation.sourceFiles,source.implementation.inventory.map(x=>x.path));
let sourceBytes=0,symlinks=0;const sourcePaths=new Set();
for(const row of source.implementation.inventory){assert(!path.isAbsolute(row.path)&&!row.path.split('/').includes('..')&&!sourcePaths.has(row.path));sourcePaths.add(row.path);const file=path.join(root,row.path),stat=fs.lstatSync(file);if(row.kind==='symlink'){assert(stat.isSymbolicLink());assert.equal(fs.readlinkSync(file),row.target);symlinks++;}else{assert.equal(row.kind,'file');assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o777,row.mode);const b=fs.readFileSync(file);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);sourceBytes+=b.length;}}
for(const row of source.harness){const b=fs.readFileSync(path.join(family,row.path));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
const node=fs.readFileSync(process.execPath),runtime=source.implementation.runtime;assert.equal(node.length,runtime.executableBytes);assert.equal(sha(node),runtime.executableSha256);assert.equal(process.version,runtime.node);assert.equal(process.versions.v8,runtime.v8);assert.equal(process.platform,runtime.platform);assert.equal(process.arch,runtime.arch);
assert.equal(plan.policy.endpoint,'https://public.1rpc.io/sepolia');assert.equal(plan.policy.chainId,11155111);assert.equal(plan.policy.retries,0);
const request={from:'0x6efb29cee3b414272eb7a8f3ebabf873d36bc033',to:'0x000000000000000000000000000000000000dead',value:'1000000000000000',gas:'21000',data:'0x'};
const queries=[request.from,request.to].map(account=>({kind:'native_balance',account}));assert.deepEqual(plan.request,request);assert.deepEqual(plan.queries,queries);
const wires=[1,2,3,4,5,6].map(i=>read(`wire-0${i}.json`));let responseBytes=0;
for(const[i,w]of wires.entries()){
  assert.equal(w.index,i+1);assert.equal(Buffer.byteLength(w.requestText),w.requestBytes);assert.equal(sha(w.requestText),w.requestSha256);
  const b=Buffer.from(w.responseBase64,'base64');assert.equal(b.toString('base64'),w.responseBase64);assert.equal(b.length,w.responseBytes);assert.equal(sha(b),w.responseSha256);assert(w.completeBody);responseBytes+=b.length;w.request=JSON.parse(w.requestText);w.response=JSON.parse(b);assert(w.responseBytes<=plan.policy.responseBytes);
  for(const t of[w.started,w.finished]){assert(t.wallMs>=0&&t.monotonicMs>=0);assert.equal(t.elapsedMs,Math.max(t.wallMs,t.monotonicMs));}
  if(i<5){assert.equal(w.url,plan.policy.endpoint);assert.equal(w.request.jsonrpc,'2.0');assert.equal(w.request.id,i+1);assert.equal(w.response.jsonrpc,'2.0');if(w.httpStatus===200){assert.equal(w.response.id,i+1);assert(Object.hasOwn(w.response,'result'));assert(!Object.hasOwn(w.response,'error'));}else{assert(!Object.hasOwn(w.response,'result'));assert(w.response.error);}}
}
assert.deepEqual(wires[0].request,{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});assert.equal(wires[0].response.result,'0xaa36a7');
assert.deepEqual(wires[1].request,{jsonrpc:'2.0',id:2,method:'eth_getBlockByNumber',params:['latest',false]});
const header=read('header.json');assert.deepEqual(wires[1].response.result,header);assert.equal(names.has('final-header.json'),false);
const verifiedHeader=verifyEthereumHeader({header,expectedHash:header.hash,chainId:11155111});assert.deepEqual(verifiedHeader,read('header-verification.json'));
const selector={blockHash:header.hash,requireCanonical:true},proofRequest={method:'eth_getProof',params:[request.from,[],selector]},codeRequest={method:'eth_getCode',params:[request.from,selector]};
assert.deepEqual(wires[2].request,{jsonrpc:'2.0',id:3,...proofRequest});assert.deepEqual(wires[3].request,{jsonrpc:'2.0',id:4,...codeRequest});
assert.equal(wires[3].httpStatus,400);assert.equal(wires[3].response.id,4);assert.deepEqual(wires[3].response.error,{message:'chain is not available on free plan, please upgrade to paid plan',code:35});
assert.deepEqual(wires[4].request,{jsonrpc:'2.0',id:5,method:'eth_getBlockByNumber',params:[header.number,false]});assert.equal(wires[4].httpStatus,429);assert.equal(wires[4].response.id,null);assert.equal(wires[4].response.error.code,-32005);
const proof=wires[2].response.result,sender=verifySenderLeaf(header.stateRoot,request.from,proof);
assert.equal(sender.codeHash,hex(keccak_256(new Uint8Array())));assert.equal(sender.storageRoot,hex(keccak_256(RLP.encode(new Uint8Array()))));
// Negative controls mutate in-memory copies only; neither sealed packet changes.
assert.throws(()=>verifySenderLeaf(header.stateRoot,request.from,{...proof,balance:'0x0'}));
assert.throws(()=>verifySenderLeaf('0x'+'00'.repeat(32),request.from,proof));
assert.throws(()=>verifySenderLeaf(header.stateRoot,request.to,{...proof,address:request.to}));
assert.throws(()=>verifySenderLeaf(header.stateRoot,request.from,{...proof,accountProof:[proof.accountProof[0].slice(0,-2)+'01',...proof.accountProof.slice(1)]}));
assert.deepEqual(result.preview,preview);assert.equal(seal.previewSha256,sha(bytes('preview.json')));assert.equal(seal.wireCount,4);assert(seal.timestamp.elapsedMs<85000);assert(wires[4].started.elapsedMs>=seal.timestamp.elapsedMs);
assert.equal(preview.broker.calls,2);assert.equal(preview.broker.records.length,2);assert.equal(preview.broker.pendingAtReturn,0);
const parsedProof=JSON.stringify(proof);for(const view of[preview.preview,preview.preview.original]){
  assert.deepEqual(view.inputs.accounts,{});assert.equal(view.inputEvidence.length,2);assert.equal(view.inputs.status,'unavailable');assert.equal(view.inputs.failure.code,'RPC_STATE_INPUT_UNAVAILABLE');
  for(const[i,e]of view.inputEvidence.entries()){const req=[proofRequest,codeRequest][i];assert.equal(e.id,i+1);assert.deepEqual(e.request,req);assert.equal(e.requestText,JSON.stringify(req));assert.equal(e.requestSha256,sha(JSON.stringify(req)));const b=preview.broker.records[i];assert.deepEqual(b.request,req);assert.equal(b.status,e.status);if(i===0){assert.equal(e.status,'received');assert.equal(e.verification,'verified');assert.deepEqual(e.result,proof);for(const r of[e,b]){assert.equal(r.resultSha256,sha(parsedProof));assert.equal(r.resultBytes,Buffer.byteLength(parsedProof));}}else assert.equal(e.status,'unavailable');}
}
const p=preview.preview;assert.equal(p.status,'unavailable');assert.equal(preview.status,'completed');assert.equal(p.usage.steps,0);assert.equal(p.usage.frames,0);assert.equal(p.inputUsage.accounts,0);assert.equal(p.inputUsage.calls,2);assert.equal(p.original.output.execution.status,'unavailable');assert.equal(p.original.output.trace,null);assert.deepEqual(p.original.changes.accounts,[]);assert.equal(p.original.output.gasAccounting,null);
assert.equal(p.measurements.length,2);for(const[i,m]of p.measurements.entries()){assert.deepEqual(m.descriptor,queries[i]);assert.equal(m.status,'not_attempted');assert.equal(m.before,null);assert.equal(m.after,null);assert.equal(m.values,null);}
assert.equal(preview.isolation.processClosed,true);assert.equal(preview.isolation.exitCode,0);
const http=wires[5];assert.equal(http.url,'http://127.0.0.1:5174/api/evm/local-preview');assert.deepEqual(http.request,{chainId:11155111,...request,block:header.hash,queries});assert.equal(http.httpStatus,400);assert.deepEqual(http.response,{error:{code:'UNSUPPORTED_CHAIN',message:'Only Ethereum chain 1 is supported.'}});assert.equal(result.publicHttp.httpStatus,400);assert.deepEqual(result.publicHttp.response,http.response);assert.deepEqual(read('public-http.json'),{request:http.request,...result.publicHttp});
assert.equal(result.status,'unavailable');assert.equal(result.usable,false);assert.equal(result.headerConfirmed,false);assert.equal(result.sourceUnchanged,true);assert.equal(result.transport.publicCalls,5);assert.equal(result.transport.responseBytes,responseBytes);assert.equal(result.transport.complete,true);assert.equal(result.transport.withinDeadline,true);assert.equal(result.transport.active,0);assert.equal(result.transport.cancelling,0);assert.equal(result.transport.hardFailure,null);assert(result.transport.terminalAfterIntegrity.elapsedMs<120000);
console.log(JSON.stringify({artifactOnly:true,networkRequests:0,evmReexecuted:false,manifestSha256,planSha256:sha(bytes('plan.json')),sourceSha256:plan.sourceSha256,artifactFiles:names.size,artifactBytes,implementationEntries:sourcePaths.size,implementationFileBytes:sourceBytes,implementationSymlinks:symlinks,harnessFiles:source.harness.length,nodeExecutableVerified:true,header:verifiedHeader,headerRereadConfirmed:false,publicRpcRequests:5,loopbackRequests:1,rawResponseBytes:responseBytes,independentlyVerifiedSender:sender,proofNegativeControls:4,completeInputAccounts:0,executionFrames:0,executionSteps:0,measurementAttempts:0,status:result.status,usable:result.usable,codeRequestFailure:{httpStatus:400,...wires[3].response.error},finalHeaderFailure:{httpStatus:429,responseId:null,...wires[4].response.error},publicHttpStatus:400,publicHttpCode:http.response.error.code,elapsedMs:result.transport.terminalAfterIntegrity.elapsedMs,limitations:['Sender membership proof is consistent with the selected header state root; it does not establish consensus/finality or successful final-header reread.','Authenticated code hash is the empty-code hash; the requested eth_getCode response was unavailable.','No complete engine input account, recipient proof, transfer execution or before/after measurement was established.','The frozen original verifier rejects the non-200 final-header error with id:null; that failure is preserved, not changed into a successful simulation.','Source inventory checked against current files, not a retained dependency archive.']},null,2));
