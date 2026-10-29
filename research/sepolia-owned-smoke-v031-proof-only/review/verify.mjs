// Independent saved-artifact audit; no producer verifier/engine import or network.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {RLP} from '../../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256} from '../../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export const CAPTURE=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../capture');
export const MANIFEST='3bf80e4b389bed4c1cce7e53f9b1ef5e3c46c96159a69c622ed977fa6a31b8d4';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=b=>'0x'+Buffer.from(b).toString('hex');
const raw=h=>{assert(typeof h==='string'&&/^0x(?:[0-9a-f]{2})*$/.test(h));return Uint8Array.from(Buffer.from(h.slice(2),'hex'));};
const qty=h=>{assert(typeof h==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h));const n=BigInt(h);assert(n<(1n<<256n));return n;};
const qhex=n=>'0x'+n.toString(16);
const emptyCode=hex(keccak_256(new Uint8Array())),emptyStorage=hex(keccak_256(RLP.encode(new Uint8Array())));
const from='0x6efb29cee3b414272eb7a8f3ebabf873d36bc033',to='0x000000000000000000000000000000000000dead';
const request={from,to,value:'1000000000000000',gas:'21000',data:'0x'};
const queries=[from,to].map(account=>({kind:'native_balance',account}));
const policy={endpoint:'https://rpc.sepolia.ethpandaops.io',chainId:11155111,sender:from,recipient:to,value:request.value,gas:request.gas,calls:12,responseBytes:2097152,totalBytes:8388608,requestMs:25000,selectionMs:30000,productEndMs:85000,productMs:55000,finalHeaderMs:110000,loopbackEndMs:115000,drainMs:5000,totalMs:120000,retries:0,loopback:'http://127.0.0.1:5174/api/evm/local-preview'};
const timing=t=>{assert(t&&Number.isFinite(t.wallMs)&&Number.isFinite(t.monotonicMs)&&t.wallMs>=0&&t.monotonicMs>=0);assert.equal(t.elapsedMs,Math.max(t.wallMs,t.monotonicMs));return t.elapsedMs;};
const duration=(n,cap)=>assert(Number.isFinite(n)&&n>=0&&n<=cap);

// Narrow independent secure-MPT walker for these two retained inclusion proofs.
// All links are hashed branches followed by one terminal leaf. Other shapes fail.
export function accountLeaf(stateRoot,address,proof,nodes) {
  assert.equal(raw(stateRoot).length,32);assert.equal(raw(address).length,20);
  assert.equal(proof.address,address);assert.equal(proof.accountProof.length,nodes);assert([8,9].includes(nodes));
  const nibbles=[...keccak_256(raw(address))].flatMap(n=>[n>>4,n&15]);let expected=stateRoot,at=0,account;
  for(const[i,text]of proof.accountProof.entries()){
    const b=raw(text);assert(b.length>0&&b.length<=4096);assert.equal(hex(keccak_256(b)),expected);
    const node=RLP.decode(b);assert.deepEqual(RLP.encode(node),b);
    if(i<nodes-1){assert(Array.isArray(node)&&node.length===17);assert.equal(node[16].length,0);const link=node[nibbles[at++]];assert(link instanceof Uint8Array&&link.length===32);expected=hex(link);}
    else{assert(Array.isArray(node)&&node.length===2&&node[0] instanceof Uint8Array&&node[0].length>0);const compact=node[0],flag=compact[0]>>4;assert(flag===2||flag===3);const tail=[];if(flag===3)tail.push(compact[0]&15);else assert.equal(compact[0]&15,0);for(const n of compact.slice(1))tail.push(n>>4,n&15);assert.deepEqual(tail,nibbles.slice(at));account=RLP.decode(node[1]);assert.deepEqual(RLP.encode(account),node[1]);}
  }
  assert(Array.isArray(account)&&account.length===4&&account.every(x=>x instanceof Uint8Array));
  const integer=b=>{assert(b.length===0||b[0]!==0);return b.length?BigInt(hex(b)):0n;};const nonce=integer(account[0]),balance=integer(account[1]);assert(nonce<(1n<<64n)&&balance<(1n<<256n));assert.equal(account[2].length,32);assert.equal(account[3].length,32);
  assert.equal(nonce,qty(proof.nonce));assert.equal(balance,qty(proof.balance));assert.equal(hex(account[2]),proof.storageHash);assert.equal(hex(account[3]),proof.codeHash);assert.deepEqual(proof.storageProof,[]);
  return {address,exists:true,nonce:nonce.toString(),balanceWei:balance.toString(),storageRoot:hex(account[2]),codeHash:hex(account[3]),proofNodes:nodes};
}

// Full 23-field Amsterdam header RLP in pinned Geth Header declaration order.
// Does not import the production header verifier, Common, Block or Trie.
export function headerIdentity(h){
  const fixed=(key,length)=>{const b=raw(h[key]);assert.equal(b.length,length,key);return b;};
  const number=key=>{let n=qty(h[key]);if(['number','gasLimit','gasUsed','timestamp','blobGasUsed','excessBlobGas','slotNumber'].includes(key))assert(n<(1n<<64n));if(n===0n)return new Uint8Array();let s=n.toString(16);return raw('0x'+(s.length%2?'0':'')+s);};
  const extra=raw(h.extraData);assert(extra.length<=32);assert.equal(h.difficulty,'0x0');assert.equal(h.nonce,'0x0000000000000000');assert(qty(h.gasUsed)<=qty(h.gasLimit));assert(qty(h.timestamp)>=1791294816n);
  const fields=[fixed('parentHash',32),fixed('sha3Uncles',32),fixed('miner',20),fixed('stateRoot',32),fixed('transactionsRoot',32),fixed('receiptsRoot',32),fixed('logsBloom',256),number('difficulty'),number('number'),number('gasLimit'),number('gasUsed'),number('timestamp'),extra,fixed('mixHash',32),fixed('nonce',8),number('baseFeePerGas'),fixed('withdrawalsRoot',32),number('blobGasUsed'),number('excessBlobGas'),fixed('parentBeaconBlockRoot',32),fixed('requestsHash',32),fixed('blockAccessListHash',32),number('slotNumber')];
  const b=RLP.encode(fields);assert.equal(hex(keccak_256(b)),h.hash);
  return{status:'verified',blockHash:h.hash,stateRoot:h.stateRoot,parentHash:h.parentHash,number:qty(h.number).toString(),timestamp:qty(h.timestamp).toString(),hardfork:'amsterdam',encodedBytes:b.length,headerFields:23,consensusVerified:false,finalityVerified:false,bodyVerified:false,chainId:11155111,forkSchedule:'pinned_ethereumjs_common_10.1.3_sepolia_amsterdam_1791294816'};
}

export function wireEvidence(wires){
  assert.equal(wires.length,6);let total=0,previous=null;
  return{wires:wires.map((w,i)=>{
    assert.equal(w.index,i+1);assert.equal(Buffer.byteLength(w.requestText),w.requestBytes);assert.equal(sha(w.requestText),w.requestSha256);
    const b=Buffer.from(w.responseBase64,'base64');assert.equal(b.toString('base64'),w.responseBase64);assert.equal(b.length,w.responseBytes);assert.equal(sha(b),w.responseSha256);assert.equal(w.completeBody,true);assert(b.length<=policy.responseBytes);total+=b.length;assert(total<=policy.totalBytes);
    timing(w.started);timing(w.finished);for(const key of['wallMs','monotonicMs']){assert(w.finished[key]>=w.started[key]);assert(w.finished[key]-w.started[key]<=policy.requestMs);if(previous)assert(w.started[key]>=previous[key]);}previous=w.finished;
    const phase=['selection','selection','input','input','final_header','public_http'][i];assert.equal(w.phase,phase);assert(w.finished.elapsedMs<({selection:30000,input:85000,final_header:110000,public_http:115000}[phase]));
    const req=JSON.parse(w.requestText),res=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));assert.equal(w.url,i<5?policy.endpoint:policy.loopback);
    if(i<5){assert.equal(w.httpStatus,200);assert.equal(w.error,null);assert.equal(req.id,i+1);assert.equal(req.jsonrpc,'2.0');assert.deepEqual(Object.keys(res).sort(),['id','jsonrpc','result']);assert.equal(res.jsonrpc,'2.0');assert.equal(res.id,i+1);}
    else{assert.equal(w.httpStatus,400);assert.equal(w.error.code,'ERR_ASSERTION');assert.deepEqual(res,{error:{code:'UNSUPPORTED_CHAIN',message:'Only Ethereum chain 1 is supported.'}});}
    return{...w,request:req,response:res};
  }),get bytes(){return total;}};
}

export function inspectSemantics(p){
  const plan=p['plan.json'],h=p['header.json'],v=p['preview.json'],q=v.preview,o=q.original,r=p['results.json'],seal=p['PRODUCT_SEALED.json'];
  assert.deepEqual(plan.policy,policy);assert.deepEqual(plan.request,request);assert.deepEqual(plan.queries,queries);assert.equal(plan.execution,'owned_internal_isolated_engine');assert.equal(plan.publicHttpSupportClaim,false);assert.equal(plan.priorV2ManifestSha256,'ed60aad67ef1a2656a08b3d3ff5228fcd5492d576d78eac6a76c6044e99a460c');
  const header=headerIdentity(h);assert.deepEqual(p['header-verification.json'],header);assert.deepEqual(v.headerVerification,header);assert.deepEqual(q.headerVerification,header);
  const wires=wireEvidence([1,2,3,4,5,6].map(i=>p[`wire-0${i}.json`])),w=wires.wires,selector={blockHash:h.hash,requireCanonical:true};
  assert.deepEqual(w[0].request,{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});assert.equal(w[0].response.result,'0xaa36a7');
  assert.deepEqual(w[1].request,{jsonrpc:'2.0',id:2,method:'eth_getBlockByNumber',params:['latest',false]});assert.deepEqual(w[1].response.result,h);
  const proofs=w.slice(2,4).map(x=>x.response.result),accounts=proofs.map((proof,i)=>accountLeaf(h.stateRoot,[from,to][i],proof,9-i));
  for(const [i,a] of accounts.entries()){
    assert.equal(a.codeHash,emptyCode);assert.equal(a.storageRoot,emptyStorage);const req={method:'eth_getProof',params:[a.address,[],selector]};assert.deepEqual(w[i+2].request,{jsonrpc:'2.0',id:i+3,...req});
    const broker=v.broker.records[i];assert.equal(broker.id,i+1);assert.deepEqual(broker.request,req);assert.equal(broker.status,'received');assert.equal(broker.dispatched,true);assert.equal(broker.representation,'parsed_rpc_result_not_wire_bytes');const text=JSON.stringify(proofs[i]);assert.equal(broker.resultBytes,Buffer.byteLength(text));assert.equal(broker.resultSha256,sha(text));duration(broker.durationMs,policy.productMs);
    for(const view of[q,o]){
      assert.equal(view.inputs.status,'available');assert.equal(view.inputs.context.chainId,11155111);assert.equal(view.inputs.context.blockHash,h.hash);assert.equal(view.inputs.context.stateRoot,h.stateRoot);assert.deepEqual(view.inputs.context.header,h);assert.deepEqual(view.inputs.context.selector,selector);assert.equal(view.inputs.context.expectedOutputsUsed,false);
      assert.deepEqual(view.inputs.accounts[a.address],{exists:true,nonce:a.nonce,balance:a.balanceWei,code:'0x',storage:{}});
      assert.deepEqual(view.inputs.provenance[i],{account:a.address,accountProof:{exists:true,nonceRaw:a.nonce,balanceRaw:a.balanceWei,codeHash:a.codeHash,storageRoot:a.storageRoot},proofEvidenceId:i+1,codeEvidenceId:null,codeDerivation:'verified_account_empty_code_hash',storage:[]});
      const e=view.inputEvidence[i];assert.equal(e.id,i+1);assert.deepEqual(e.request,req);assert.equal(e.requestText,JSON.stringify(req));assert.equal(e.requestSha256,sha(e.requestText));assert.equal(e.status,'received');assert.equal(e.verification,'verified');assert.equal(e.representation,'parsed_rpc_result_not_wire_bytes');assert.deepEqual(e.result,proofs[i]);assert.equal(e.resultSha256,sha(text));assert.equal(e.resultBytes,Buffer.byteLength(text));duration(e.durationMs,policy.productMs);
    }
  }
  for(const view of[q,o]){assert.equal(view.inputEvidence.length,2);assert.equal(view.inputs.provenance.length,2);assert.deepEqual(Object.keys(view.inputs.accounts).sort(),[from,to].sort());assert.equal(view.inputUsage.calls,2);assert.equal(view.inputUsage.accounts,2);assert.equal(view.inputUsage.slots,0);assert.equal(view.inputUsage.observedResultBytes,15318);assert.equal(view.inputUsage.retainedResultBytes,15318);}
  assert.equal(v.broker.calls,2);assert.equal(v.broker.dispatches,2);assert.equal(v.broker.records.length,2);assert.equal(v.broker.accountedParsedResultBytes,15318);assert.equal(v.broker.pendingAtReturn,0);assert.equal(v.broker.rawWireCaptured,false);
  assert.deepEqual(p['request.json'],{chainId:11155111,request,queries,blockHash:h.hash});assert.deepEqual(r.preview,v);assert.equal(v.status,'completed');assert.equal(v.error,null);assert.equal(q.status,'complete');assert.equal(q.error,null);
  assert.equal(v.isolation.processClosed,true);assert.equal(v.isolation.exitCode,0);assert.equal(v.isolation.exitSignal,null);assert.equal(v.isolation.processSeparated,true);assert(Number.isSafeInteger(v.isolation.childPid)&&v.isolation.childPid>0);duration(v.isolation.durationMs,policy.productMs);assert.equal(v.isolation.sourceImplementationBound,false);
  const out=o.output,amount=BigInt(request.value),sender=BigInt(accounts[0].balanceWei),recipient=BigInt(accounts[1].balanceWei),nonce=BigInt(accounts[0].nonce);assert(sender>=amount);
  const changes=[{address:from,nonce:{before:qhex(nonce),after:qhex(nonce+1n)},balance:{before:qhex(sender),after:qhex(sender-amount)}},{address:to,balance:{before:qhex(recipient),after:qhex(recipient+amount)}}];assert.deepEqual(o.changes.accounts,changes);
  assert.deepEqual(out.execution,{status:'success',executionGasUsed:'0',gasRefundCounter:'0',executionStateGasUsed:'0',returnData:'0x',error:null});
  assert.deepEqual(out.trace,{type:'CALL',from,to,executionAddress:to,caller:from,value:qhex(amount),input:'0x',gas:'0x0',gasUsed:'0x0',output:'0x',error:null,depth:0,calls:[]});
  assert.deepEqual(out.logs,[{address:'0xfffffffffffffffffffffffffffffffffffffffe',topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+from.slice(2).padStart(64,'0'),'0x'+to.slice(2).padStart(64,'0')],data:'0x'+amount.toString(16).padStart(64,'0')}]);
  for(const key of['feeAccounting','authorizationProcessing','lifecycle'])assert.equal(out[key],undefined);
  assert.equal(out.profile.name,'ethereum_unsigned_unpriced_call');assert.equal(out.profile.executionBaseFee,'0');assert.equal(out.profile.actualBlockBaseFee,qty(h.baseFeePerGas).toString());assert.equal(out.profile.gasPrice,'0');assert.equal(out.profile.feesSettled,false);assert.equal(out.profile.outerSignatureVerified,false);assert.equal(out.profile.expectedOutputsUsed,false);assert.equal(out.profile.sourceStateRoot,h.stateRoot);assert.equal(out.profile.sourceBlockHash,h.hash);assert.equal(out.profile.chainId,11155111);
  assert.equal(out.environment.chainId,11155111);assert.equal(out.environment.hardfork,'amsterdam');assert.equal(out.environment.number,qty(h.number).toString());assert.equal(out.environment.slotNumber,qty(h.slotNumber).toString());assert.equal(out.environment.timestamp,qty(h.timestamp).toString());assert.equal(out.environment.baseFeePerGas,'0');assert.equal(out.environment.sourceBlockHash,h.hash);
  const settled={beforeRefund:'21000',refundCounter:'0',appliedRefund:'0',floorAdjustment:'0',gasUsed:'21000',reportedRefundCounter:'0',reservoirDelta:'0',stateGasUsedRaw:'0',executionRegularGasUsed:'0',stateGasUsed:'0',regularGasUsed:'21000',blockGasUsed:'21000'};
  assert.deepEqual(out.gasAccounting,settled);assert.deepEqual(out.stateGasAccounting,{budget:{gasLimit:'21000',intrinsicRegular:'21000',floor:'21000',intrinsicState:'0',regularGasLimit:'16777216',messageGasLimit:'0',stateGasReservoirInitial:'0'},counters:{messageGasUsed:'0',authorizationGasUsed:'0',stateGasReservoir:'0',executionStateGasUsed:'0',messageRefundCounter:'0',authorizationRefundCounter:'0',postTargetOutOfGas:false},settled});
  assert.equal(q.usage.executions,1);assert.equal(q.usage.steps,0);assert.equal(q.usage.frames,1);assert.equal(out.usage.logOpcodes,0);assert.equal(q.scope.feesSettled,false);assert.equal(q.scope.nativeEffectsMeasured,true);assert.equal(q.scope.nativeBalanceCoverage,'explicit_accounts_only');assert.equal(q.scope.queryGasScope,'CALL_only');assert.equal(q.scope.consensusVerified,false);assert.equal(q.scope.originalTransactionReplay,false);
  assert.equal(q.measurements.length,2);const unit={kind:'native_wei',scale:'1000000000000000000'};
  const native=q.measurements.map((m,i)=>{
    const address=[from,to][i],before=[sender,recipient][i],after=i?recipient+amount:sender-amount;
    assert.deepEqual(m.descriptor,queries[i]);assert.equal(m.query,null);assert.equal(m.returnBytes,0);assert.equal(m.status,'measured');assert.equal(m.reason,null);assert.deepEqual(m.identity,{kind:'native_balance',account:address,chainId:'11155111'});assert.deepEqual(m.fields,[{name:'balance',bits:256,unit}]);
    const values=[{name:'balance',beforeRaw:before.toString(),afterRaw:after.toString(),deltaRaw:(after-before).toString(),unit}];assert.deepEqual(m.values,values);
    for(const[phase,expected]of[['before',before],['after',after]]){const side=m[phase];assert.equal(side.status,'measured');assert.equal(side.reason,null);assert.equal(side.output,null);assert.equal(side.readMethod,'proof_state_account_balance');assert.deepEqual(side.values,[{name:'balance',raw:expected.toString(),unit}]);assert.deepEqual(side.changesBefore,side.changesAfter);assert.deepEqual(side.changesBefore,phase==='before'?{scope:o.changes.scope,accounts:[]}:o.changes);assert.deepEqual(side.inputEvidenceIds,[]);assert.deepEqual(side.stateReads,{total:1,distinct:1,reads:[{kind:'account',address}]});}
    return{address,...values[0]};
  });
  assert.equal(seal.wireCount,4);assert(timing(seal.timestamp)<policy.productEndMs);assert(w[3].finished.elapsedMs<=seal.timestamp.elapsedMs);assert(w[4].started.elapsedMs>=seal.timestamp.elapsedMs);
  assert.deepEqual(w[4].request,{jsonrpc:'2.0',id:5,method:'eth_getBlockByNumber',params:[h.number,false]});assert.deepEqual(w[4].response.result,h);assert.deepEqual(p['final-header.json'],h);
  assert.deepEqual(w[5].request,{chainId:11155111,...request,block:h.hash,queries});assert.deepEqual(r.publicHttp,{error:w[5].error,httpStatus:400,response:w[5].response});assert.deepEqual(p['public-http.json'],{request:w[5].request,...r.publicHttp});
  assert.equal(r.status,'completed');assert.equal(r.usable,true);assert.equal(r.error,null);assert.equal(r.headerConfirmed,true);assert.equal(r.sourceUnchanged,true);assert.equal(r.transport.publicCalls,5);assert.equal(r.transport.responseBytes,wires.bytes);assert.equal(r.transport.complete,true);assert.equal(r.transport.withinDeadline,true);assert.equal(r.transport.active,0);assert.equal(r.transport.cancelling,0);assert.equal(r.transport.hardFailure,null);timing(r.transport.timing);timing(r.transport.terminalAfterIntegrity);assert(r.transport.timing.elapsedMs>=w[5].finished.elapsedMs);assert(r.transport.terminalAfterIntegrity.elapsedMs>=r.transport.timing.elapsedMs&&r.transport.terminalAfterIntegrity.elapsedMs<policy.totalMs);
  assert.equal(p['STARTED.json'].sourceSha256,plan.sourceSha256);assert(Number.isFinite(Date.parse(p['STARTED.json'].startedAt)));
  return{header,accounts,native,rawResponseBytes:wires.bytes,status:r.status,usable:r.usable,headerRereadConfirmed:true,publicRpcRequests:5,loopbackRequests:1,publicHttpStatus:400,publicHttpCode:w[5].response.error.code,executionFrames:1,executionSteps:0,gasUsed:'21000',senderNonceBefore:nonce.toString(),senderNonceAfter:(nonce+1n).toString(),feesSettled:false,elapsedMs:r.transport.terminalAfterIntegrity.elapsedMs};
}

export function loadPacket(directory=CAPTURE){const p={};for(const n of fs.readdirSync(directory))p[n]=JSON.parse(fs.readFileSync(path.join(directory,n)));return p;}
export function audit({directory=CAPTURE,root=ROOT}={}){
  const read=n=>fs.readFileSync(path.join(directory,n));assert.equal(sha(read('manifest.json')),MANIFEST);const manifest=JSON.parse(read('manifest.json')),names=new Set();let artifactBytes=0;
  for(const row of manifest.files){assert(/^[A-Za-z0-9._-]+$/.test(row.path)&&!names.has(row.path));names.add(row.path);const stat=fs.lstatSync(path.join(directory,row.path));assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,row.bytes);assert(stat.size<2*1024*1024);const b=read(row.path);assert.equal(sha(b),row.sha256);artifactBytes+=b.length;}
  assert.equal(names.size,17);assert.deepEqual(fs.readdirSync(directory).sort(),[...names,'manifest.json'].sort());const p=loadPacket(directory);assert.equal(p['PRODUCT_SEALED.json'].previewSha256,sha(read('preview.json')));
  const source=p['source.json'],plan=p['plan.json'],implementation=source.implementation;assert.equal(sha(JSON.stringify(source)),plan.sourceSha256);assert.equal(implementation.sourceSha256,sha(JSON.stringify({files:implementation.inventory,runtime:implementation.runtime})));assert.deepEqual(implementation.sourceFiles,implementation.inventory.map(x=>x.path));
  const paths=new Set();let sourceBytes=0,symlinks=0;
  for(const row of implementation.inventory){assert(!path.isAbsolute(row.path)&&!row.path.split('/').includes('..')&&!paths.has(row.path));paths.add(row.path);const file=path.join(root,row.path),s=fs.lstatSync(file);if(row.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(file),row.target);const resolved=fs.realpathSync(file);assert(resolved.startsWith(fs.realpathSync(root)+path.sep));symlinks++;}else{assert.equal(row.kind,'file');assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,row.mode);assert.equal(s.size,row.bytes);const b=fs.readFileSync(file);assert.equal(sha(b),row.sha256,row.path);sourceBytes+=b.length;}}
  const family=path.join(root,'research/sepolia-owned-smoke-v031-proof-only');for(const row of source.harness){assert(/^[A-Za-z0-9._-]+$/.test(row.path));const b=fs.readFileSync(path.join(family,row.path));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
  const runtime=implementation.runtime,node=fs.readFileSync(process.execPath);assert.equal(node.length,runtime.executableBytes);assert.equal(sha(node),runtime.executableSha256);for(const[key,value]of Object.entries({node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch}))assert.equal(runtime[key],value);
  return{artifactOnly:true,networkRequests:0,targetReexecuted:false,producerVerifierImported:false,manifestSha256:MANIFEST,planSha256:sha(read('plan.json')),sourceSha256:plan.sourceSha256,implementationSha256:implementation.sourceSha256,artifactFiles:names.size,artifactBytes,implementationEntries:paths.size,implementationFileBytes:sourceBytes,implementationSymlinks:symlinks,harnessFiles:source.harness.length,nodeExecutableVerified:true,...inspectSemantics(p),limitations:['Two inclusion proofs establish account membership relative to the reconstructed header root, not consensus, finality or network membership.','The same provider returned the same numbered header after execution; this is not independent consensus attestation.','The saved isolated engine result is an unsigned unpriced local overlay; no transaction was signed/broadcast and no on-chain transfer, wallet-key ownership or settlement is established.','Only the two explicit native balances and exact saved nonce/value arithmetic were checked; no post-state root or independent-client execution was reconstructed.','Empty code is derived from the authenticated empty-code hash, with codeEvidenceId null; no eth_getCode request or fabricated code response exists.','The one retained protocol native-transfer log is simulated output, not an on-chain receipt or emitted contract LOG opcode.','Public HTTP Sepolia support remains rejected with 400 UNSUPPORTED_CHAIN.','Runtime/dependencies were rehashed against the current checkout and Node executable; they were not independently archived in this capture. Captured child sourceImplementationBound is false; the harness records source identity before/after.','RLP and Keccak primitives are shared pinned libraries; proof-walk/header construction and arithmetic are independent audit logic.']};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(audit(),null,2));
