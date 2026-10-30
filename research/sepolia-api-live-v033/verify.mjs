import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POLICY, REQUEST, STEPS, HARNESS, sha, json, decode } from './contract.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const need = condition => assert(condition);
function validTime(t) {
  need(t && typeof t.valid === 'boolean'); need(Number.isFinite(t.wallMs) && Number.isFinite(t.monotonicMs));
  assert.equal(t.elapsedMs,Math.max(t.wallMs,t.monotonicMs));
}
export function verifyHttp(row,index) {
  const step=STEPS[index]; assert.equal(row.index,index); assert.equal(row.method,step.method); assert.equal(row.url,POLICY.origin+step.path);
  assert.equal(row.requestText,index===2?JSON.stringify(REQUEST):''); assert.equal(row.requestBytes,Buffer.byteLength(row.requestText)); assert.equal(row.requestSha256,sha(row.requestText));
  const b=Buffer.from(row.responseBase64,'base64'); assert.equal(b.toString('base64'),row.responseBase64); assert.equal(row.responseBytes,b.length); assert.equal(row.responseSha256,sha(b));
  need(b.length <= (index<2?POLICY.setupBytes:POLICY.resultBytes)); need(Number.isSafeInteger(row.observedBytes) && row.observedBytes>=b.length);
  for(const k of ['completeBody','requestClosed','responseClosed','dispatched']) need(typeof row[k]==='boolean');
  validTime(row.started); validTime(row.finished); need(Number.isSafeInteger(row.timeoutMs) && row.timeoutMs>=1 && row.timeoutMs<=POLICY.totalMs);
  if(row.error===null) {
    need(row.dispatched && row.completeBody && row.requestClosed && row.responseClosed && row.started.valid && row.finished.valid);
    need(row.started.wallMs>=0 && row.started.monotonicMs>=0 && row.finished.wallMs>=row.started.wallMs && row.finished.monotonicMs>=row.started.monotonicMs);
    need(row.finished.elapsedMs<=POLICY.totalMs && row.finished.elapsedMs-row.started.elapsedMs<=row.timeoutMs);
    assert.equal(row.observedBytes,b.length);
  }
  if(row.completeBody && row.error===null) return decode(b);
  return null;
}
function verifySources(source) {
  const impl=source.implementation;
  assert.equal(impl.sourceSha256,sha(JSON.stringify({files:impl.inventory,runtime:impl.runtime})));
  assert.deepEqual(impl.sourceFiles,impl.inventory.map(r=>r.path));
  const names=new Set();
  for(const row of impl.inventory) {
    need(typeof row.path==='string' && !row.path.startsWith('/') && !row.path.includes('\\') && !row.path.split('/').some(p=>['','.','..'].includes(p)) && !names.has(row.path)); names.add(row.path);
    const file=path.join(ROOT,row.path),stat=fs.lstatSync(file);
    if(row.kind==='symlink') { need(stat.isSymbolicLink()); assert.equal(fs.readlinkSync(file),row.target); }
    else { assert.equal(row.kind,'file'); need(stat.isFile()&&!stat.isSymbolicLink()); const b=fs.readFileSync(file); assert.equal(b.length,row.bytes); assert.equal(sha(b),row.sha256); assert.equal(stat.mode&0o777,row.mode); }
  }
  assert.equal(impl.runtime.node,process.version); assert.equal(impl.runtime.v8,process.versions.v8);
  assert.equal(impl.runtime.executableSha256,sha(fs.readFileSync(fs.realpathSync(process.execPath))));
  assert.deepEqual(source.harness.map(r=>r.path),HARNESS);
  for(const row of source.harness) { const b=fs.readFileSync(new URL(row.path,import.meta.url)); assert.equal(b.length,row.bytes); assert.equal(sha(b),row.sha256); }
}
function rpcRecords(report) {
  const rows=report.transportEvidence; need(Array.isArray(rows)&&rows.length<=260); let bytes=0;
  return rows.map((row,i)=>{
    assert.equal(row.id,i+1); assert.equal(row.requestBytes,Buffer.byteLength(row.requestText)); assert.equal(row.requestSha256,sha(row.requestText));
    const q=JSON.parse(row.requestText); assert.deepEqual(q,row.request); assert.equal(q.jsonrpc,'2.0'); assert.equal(q.id,i+1);
    need(['eth_chainId','eth_getBlockByNumber','eth_getBlockByHash','eth_getProof','eth_getCode'].includes(q.method));
    let response=null;
    if(row.status==='completed') {
      need(row.dispatched && row.httpStatus>=200 && row.httpStatus<300 && row.transport.complete && row.transport.bodyRetained);
      need(typeof row.responseText==='string'); const b=Buffer.from(row.responseText);
      assert.equal(b.length,row.transport.observedBytes); assert.equal(b.length,row.transport.retainedPrefixBytes);
      for(const k of ['responseSha256','observedPrefixSha256','retainedPrefixSha256']) assert.equal(row.transport[k],sha(b));
      response=JSON.parse(row.responseText); assert.equal(response.jsonrpc,'2.0'); assert.equal(response.id,q.id); need(Object.hasOwn(response,'result')&&!Object.hasOwn(response,'error'));
    } else { assert.equal(row.status,'failed'); need(row.error); need(!Object.hasOwn(row,'responseText')); }
    need(Number.isSafeInteger(row.transport.observedBytes)&&row.transport.observedBytes>=0); bytes+=row.transport.observedBytes;
    return {...row,response};
  });
}
export async function verifyApiReport(report,implementation) {
  assert.equal(report.kind,'local_proof_preview'); assert.deepEqual(report.apiRequest,REQUEST); assert.deepEqual(report.implementation,implementation);
  const wires=rpcRecords(report), out={status:report.status,execution:report.execution?.status??null,usable:false,publicRpcRequests:wires.length,verifiedAccounts:0,native:null};
  if(report.status!=='complete') {
    need(['unavailable','partial'].includes(report.status));
    if(report.status==='unavailable') need(report.measurements.length===0 || report.measurements.every(r=>r.values===null));
    return out;
  }
  assert.equal(report.error,null); assert.equal(report.source.chainId,11155111); assert.equal(report.source.profile,'unsigned_unpriced_block_end');
  assert.equal(report.source.canonicalStatus,'verified'); assert.equal(report.source.consensusVerified,false); assert.equal(report.source.originalTransactionReplay,false);
  const selection=report.source.blockSelection,header=selection.header;
  const {verifyEthereumHeader}=await import('../../engines/local-evm/ethereum-header.js');
  assert.deepEqual(verifyEthereumHeader({header,expectedHash:header.hash,chainId:11155111}),selection.headerVerification);
  assert.equal(selection.requested,'latest'); assert.equal(selection.blockHash,header.hash); assert.equal(selection.blockNumber,BigInt(header.number).toString());
  assert.deepEqual(wires[0].request,{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}); assert.equal(wires[0].response?.result,'0xaa36a7');
  assert.deepEqual(wires[1].request.params,['latest',false]); assert.equal(wires[1].request.method,'eth_getBlockByNumber'); assert.deepEqual(wires[1].response?.result,header);
  const last=wires.at(-1); assert.equal(last.request.method,'eth_getBlockByNumber'); assert.deepEqual(last.request.params,[header.number,false]); assert.deepEqual(last.response?.result,header);
  const inputWires=wires.slice(2,-1);
  for(const row of inputWires) { need(['eth_getProof','eth_getCode','eth_getBlockByHash'].includes(row.request.method)); if(row.request.method!=='eth_getBlockByHash') assert.deepEqual(row.request.params.at(-1),{blockHash:header.hash,requireCanonical:true}); }
  const attempt=report.attempt,core=attempt.preview,original=core.original,output=original.output;
  assert.equal(attempt.status,'completed'); assert.equal(core.status,'complete'); assert.equal(attempt.isolation.processClosed,true); assert.equal(attempt.isolation.exitCode,0);
  need(Number.isSafeInteger(attempt.isolation.childPid)&&attempt.isolation.childPid>0); assert.equal(attempt.broker.pendingAtReturn,0);
  assert.equal(report.drain.complete,true); assert.equal(report.drain.pending,0); assert.equal(report.drain.adapterPending,0);
  assert.equal(report.usage.pending,0); assert.equal(report.usage.adapterPending,0); assert.equal(report.usage.clockValid,true); assert.equal(report.usage.calls,wires.length);
  assert.equal(attempt.broker.records.length,inputWires.length);
  for(const [i,row]of attempt.broker.records.entries()) { const wire=inputWires[i]; assert.deepEqual(row.request,{method:wire.request.method,params:wire.request.params}); assert.equal(row.status,'received');
    assert.equal(row.resultSha256,sha(JSON.stringify(wire.response.result))); assert.equal(row.resultBytes,Buffer.byteLength(JSON.stringify(wire.response.result))); }
  const {validateInputFacts}=await import('../../engines/local-evm/input-facts.js');
  for(const view of[original,core]) {
    for(const evidence of view.inputEvidence) { const wire=inputWires[evidence.id-1]; need(wire); assert.deepEqual(evidence.request,{method:wire.request.method,params:wire.request.params}); assert.deepEqual(evidence.result,wire.response.result); }
    await validateInputFacts({inputs:view.inputs,inputEvidence:view.inputEvidence,stateRoot:header.stateRoot,chainId:11155111});
  }
  assert.equal(core.inputEvidence.length,inputWires.length); out.verifiedAccounts=Object.keys(core.inputs.accounts).length;
  assert.equal(output.environment.chainId,11155111); assert.equal(output.profile.chainId,11155111); assert.equal(core.scope.chainId,11155111);
  assert.equal(output.profile.executionBaseFee,'0'); assert.equal(output.profile.gasPrice,'0'); assert.equal(output.profile.feesSettled,false);
  assert.equal(output.feeAccounting,undefined); assert.equal(output.authorizationProcessing,undefined); assert.deepEqual(report.execution,output.execution);
  const request={from:REQUEST.from,to:REQUEST.to,data:REQUEST.data,value:REQUEST.value,gas:REQUEST.gas};
  const {ethereumCommon}=await import('../../engines/local-evm/ethereum-profile.js');
  const {deriveVerifiedGas}=await import('../../engines/local-evm/gas-validation.js');
  const {validateExecutionChanges}=await import('../../engines/local-evm/execution-changes.js');
  deriveVerifiedGas({request,header,output,chainId:11155111});
  validateExecutionChanges({changes:original.changes,inputs:original.inputs,output,sender:REQUEST.from,destination:REQUEST.to,common:ethereumCommon(header,11155111),request,header});
  for(const [k,v]of Object.entries({type:'CALL',from:REQUEST.from,caller:REQUEST.from,to:REQUEST.to,executionAddress:REQUEST.to,value:'0x'+BigInt(REQUEST.value).toString(16),input:'0x'})) assert.equal(output.trace[k],v);
  assert.equal(output.execution.error,output.trace.error); assert.equal(output.execution.returnData,output.trace.output);
  assert.equal(report.measurements.length,2); assert.equal(core.measurements.length,2);
  const unit={kind:'native_wei',scale:'1000000000000000000'};
  out.native=core.measurements.map((m,i)=>{
    const account=REQUEST.queries[i].account,initial=core.inputs.accounts[account]; need(initial);
    const before=initial.exists?BigInt(initial.balance):0n,change=original.changes.accounts.find(r=>r.address===account);
    const after=change?.existence?.after===false?0n:change?.balance?BigInt(change.balance.after):before;
    assert.deepEqual(m.descriptor,REQUEST.queries[i]); assert.deepEqual(m.identity,{kind:'native_balance',account,chainId:'11155111'});
    assert.equal(m.query,null); assert.equal(m.returnBytes,0); assert.equal(m.status,'measured');
    assert.deepEqual(m.values,[{name:'balance',beforeRaw:String(before),afterRaw:String(after),deltaRaw:String(after-before),unit}]);
    for(const [phase,n]of[['before',before],['after',after]]) { const side=m[phase]; assert.equal(side.status,'measured'); assert.equal(side.output,null); assert.equal(side.readMethod,'proof_state_account_balance');
      assert.deepEqual(side.values,[{name:'balance',raw:String(n),unit}]); assert.deepEqual(side.changesBefore,side.changesAfter);
      if(phase==='before') assert.deepEqual(side.changesBefore.accounts,[]); else assert.deepEqual(side.changesBefore,original.changes); }
    const projected=report.measurements[i]; for(const k of['descriptor','identity','query','returnBytes','status','values']) assert.deepEqual(projected[k],m[k]); assert.equal(projected.index,i);
    return {account,...m.values[0]};
  });
  if(output.execution.status==='success') assert.deepEqual(out.native.map(r=>r.deltaRaw),['-'+REQUEST.value,REQUEST.value]);
  else { need(['reverted','failed'].includes(output.execution.status)); assert.deepEqual(out.native.map(r=>r.deltaRaw),['0','0']); }
  out.usable=true; return out;
}
export async function verifyEvidence({directory,manifestSha256,planSha256}) {
  const bytes=name=>fs.readFileSync(path.join(directory,name)),read=name=>decode(bytes(name));
  assert.equal(sha(bytes('manifest.json')),manifestSha256); const manifest=read('manifest.json'),names=new Set();
  for(const row of manifest.files) { need(/^[a-zA-Z0-9._-]+$/.test(row.path)&&!names.has(row.path)); names.add(row.path); const stat=fs.lstatSync(path.join(directory,row.path)); need(stat.isFile()&&!stat.isSymbolicLink()); const b=bytes(row.path); assert.equal(b.length,row.bytes); assert.equal(sha(b),row.sha256); }
  assert.deepEqual(fs.readdirSync(directory).sort(),[...names,'manifest.json'].sort());
  assert.equal(sha(bytes('plan.json')),planSha256); const plan=read('plan.json'),before=read('source-before.json'),result=read('result.json');
  assert.deepEqual(plan.policy,POLICY); assert.deepEqual(plan.request,REQUEST); assert.deepEqual(plan.sequence,STEPS); assert.equal(plan.sourceSha256,sha(json(before))); verifySources(before);
  assert.equal(read('STARTED.json').planSha256,planSha256); assert.equal(read('STARTED.json').sourceSha256,plan.sourceSha256);
  assert.equal(result.planSha256,planSha256); assert.equal(result.sourceSha256,plan.sourceSha256);
  const rows=[...names].filter(n=>/^http-[123]\.json$/.test(n)).sort().map(read); need(rows.length>=1&&rows.length<=3); assert.equal(result.httpRequests,rows.length);
  const parsed=rows.map(verifyHttp); need(rows.reduce((n,r)=>n+r.responseBytes,0)<=POLICY.totalBytes);
  assert.equal(result.postDispatched,rows.some(r=>r.method==='POST'&&r.dispatched));
  if(rows.length>1) { assert.equal(parsed[0]?.status,'ok'); assert.equal(parsed[0].readOnly,true); assert.equal(parsed[0].version,before.implementation.version); }
  if(rows.length>2) { assert.equal(parsed[1]?.localEvm?.available,true); need(parsed[1].localEvm.capabilities.chainIds.includes(11155111)); assert.deepEqual(parsed[1].localEvm.examples[0].request,REQUEST); }
  const after=names.has('source-after.json')?read('source-after.json'):null; assert.equal(result.sourceUnchanged,JSON.stringify(before)===JSON.stringify(after));
  validTime(result.terminal); assert.equal(result.withinDeadline,result.terminal.valid&&result.terminal.wallMs>=0&&result.terminal.monotonicMs>=0&&result.terminal.elapsedMs<=POLICY.totalMs);
  const body=names.has('api-response.json')?read('api-response.json'):null; if(body) { assert.equal(rows.length,3); assert.deepEqual(body,parsed[2]); }
  assert.equal(result.clientComplete,result.error===null&&rows.length===3); if(result.clientComplete) need(rows.every(r=>r.error===null&&r.httpStatus===200)&&body!==null);
  let checked={usable:false,status:null,execution:null,publicRpcRequests:null,verifiedAccounts:0,native:null};
  if(body) checked=await verifyApiReport(body,before.implementation);
  assert.equal(result.apiStatus,body?.status??null); assert.equal(result.executionStatus,body?.execution?.status??null); assert.equal(result.publicRpcRequests,body?.transportEvidence?.length??null);
  assert.equal(result.usable,result.clientComplete&&result.sourceUnchanged&&result.withinDeadline&&checked.usable);
  return {artifactOnly:true,targetReexecuted:false,networkRequests:0,manifestSha256,planSha256,sourceSha256:plan.sourceSha256,
    files:names.size,httpRequests:rows.length,postDispatched:result.postDispatched,...checked,usable:result.usable,clientError:result.error,
    scope:'one_owned_API_observation_not_independent_client_or_coverage_rate'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) console.log(json(await verifyEvidence({directory:path.resolve(process.argv[2]),manifestSha256:process.argv[3],planSha256:process.argv[4]})));
