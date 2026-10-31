// Bounded saved-only extraction. No EVM, process target or network execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {isDeepStrictEqual as same} from 'node:util';
import {fileURLToPath} from 'node:url';
import {read,json,sha,verifyPacket} from '../lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/archive.mjs';
import {validateWireDirectory} from '../lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/run.mjs';
import {providerSequenceContexts} from '../lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/observations.mjs';
import {validateProviderHeaders,validateProviderQueryMutation} from '../lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/context-validation.mjs';
import {compilePreviewQueries} from '../lending-local-sequence-v037/capture/runtime/engines/local-evm/preview-queries.js';
import {committedLogs,providerOutput} from '../lending-local-sequence-v037/capture/runtime/reports/ethereum-lending-local-reference/compare.mjs';
const capture=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../lending-local-sequence-v037/capture');
const planPin='727d4a3fe8dfa7901323cf9f7b4d09518c232c448eabddfb7f7b81c113ce5cad',manifestPin='1a414e70a04610bb8e7b784f97ce2edb2773ef07e40205c7a8edb8d533ea85ea';
assert.equal(sha(read(path.join(capture,'plan.json'))),planPin);const manifest=verifyPacket(capture,manifestPin);assert.equal(manifest.planSha256,planPin);
const eq=(a,b)=>assert.deepEqual(a,b),cases=[];let evidenceRows=0,originals=0,measurements=0,halves=0;
for(const number of ['001','002']){
 const declaration=json(path.join(capture,'inputs',number+'.json')),record=json(path.join(capture,'provider',number,'report.json')),report=record.report;
 assert(record.status==='returned'&&report.canonicalStatus==='verified');eq(report.apiRequest,declaration.providerInput);assert.equal(report.steps.length,3);
 validateWireDirectory(path.join(capture,'provider',number),record);
 const wires=fs.readdirSync(path.join(capture,'provider',number,'wire')).sort().map(name=>{const p='provider/'+number+'/wire/'+name,w=json(path.join(capture,p));return{path:p,sha256:sha(read(path.join(capture,p))),...w,body:JSON.parse(Buffer.from(w.rawBase64,'base64'))};});
 function join(row){
  const candidates=wires.filter(w=>{const request=JSON.parse(w.requestText);return request.method===row.method&&same(request.params,row.params)&&w.body.jsonrpc==='2.0'&&w.body.id===request.id&&!Object.hasOwn(w.body,'error')&&same(w.body.result,row.result);});
  assert(candidates.length>0,'Projected evidence lacks raw RPC result');evidenceRows++;return candidates.map(w=>({path:w.path,sha256:w.sha256,rpcId:w.body.id,responseSha256:w.transport.retainedSha256}));
 }
 const contexts=providerSequenceContexts({steps:report.steps,calls:declaration.localInput.calls,from:declaration.from,blockHash:declaration.header.hash}),compiled=compilePreviewQueries(declaration.localInput.queries,{chainId:1});
 const first=report.steps[0].result,initialField=(method)=>{const rows=first.evidence.filter(e=>e.method===method&&e.params[0]===declaration.from);assert.equal(rows.length,1);return rows[0].result;};
 // These are provider read results, explicitly not authenticated proof inputs.
 const providerFacts={context:{chainId:1,blockHash:declaration.header.hash},accounts:{[declaration.from]:{exists:true,nonce:initialField('eth_getTransactionCount'),balance:initialField('eth_getBalance'),code:initialField('eth_getCode')}}};
 const steps=[];
 for(const [index,step] of report.steps.entries()){
  assert.equal(step.status,'completed');const result=step.result,execution=result.execution;assert.equal(execution.status,'success');assert.equal(execution.error,null);
  for(const row of result.evidence)join(row);
  validateProviderHeaders({result,header:declaration.header,from:declaration.from,expectedOverrides:contexts[index]});
  const call={from:declaration.from,to:declaration.localInput.calls[index].to,data:declaration.localInput.calls[index].data,value:'0x0',gas:'0x4c4b40'};
  eq(result.request.transaction,call);eq([execution.trace.type,execution.trace.from,execution.trace.to,execution.trace.input],['CALL',call.from,call.to,call.data]);
  assert.equal(BigInt(execution.trace.gas),5000000n);assert.equal(BigInt(execution.trace.value),0n);assert.equal(BigInt(execution.trace.gasUsed).toString(),execution.gasUsed);assert.equal(providerOutput(execution.trace),execution.returnData);assert(!execution.trace.error);
  const originalEvidence=result.evidence.filter(e=>e.method==='debug_traceCall'&&same(e.params[0],call)&&e.params[2]?.tracer==='callTracer');assert.equal(originalEvidence.length,1);eq(originalEvidence[0].result,execution.trace);
  assert.equal(result.measurements.length,compiled.length);const queries=[];
  for(const [q,m] of result.measurements.entries()){
   assert.equal(m.status,'measured');const c=compiled[q];eq(m.query,c.query);
   validateProviderQueryMutation({result,measurement:m,from:declaration.from,expectedOverrides:contexts[index],initialInputs:providerFacts});
   const sides={};
   for(const side of ['before','after']){
    const refs=m.queryEvidence.filter(e=>e.state===side);assert.equal(refs.length,1);const ref=refs[0];
    const trace=result.evidence.find(e=>e.id===ref.traceEvidenceId),mutation=result.evidence.find(e=>e.id===ref.mutationEvidenceId);assert(trace&&mutation);
    const output=providerOutput(trace.result);assert.match(output,/^0x(?:[0-9a-f]{2})*$/);assert.equal(output.length,2+c.returnBytes*2);
    sides[side]={returnData:output,trace:join(trace),mutation:join(mutation),values:c.fields.map((field,i)=>{const value=BigInt('0x'+output.slice(2+64*i,66+64*i));assert(value<2n**BigInt(field.bits));return{name:field.name,raw:value.toString()};})};halves++;
   }
   const values=sides.before.values.map((v,i)=>({name:v.name,beforeRaw:v.raw,afterRaw:sides.after.values[i].raw,deltaRaw:(BigInt(sides.after.values[i].raw)-BigInt(v.raw)).toString()}));
   if(m.position){eq(m.rows.map(({name,beforeRaw,afterRaw,deltaRaw})=>({name,beforeRaw,afterRaw,deltaRaw})),values);eq([m.beforeReturnData,m.afterReturnData],[sides.before.returnData,sides.after.returnData]);const {contractIdentityVerified,...identity}=c.identity;eq(m.position.identity,identity);}
   else eq(values,[{name:c.fields[0].name,beforeRaw:m.beforeRaw,afterRaw:m.afterRaw,deltaRaw:m.deltaRaw}]);
   queries.push({index:q,id:declaration.queryRoles[q].id,label:declaration.queryRoles[q].label,subject:declaration.queryRoles[q].subject,status:'provider_measured',values,sides});measurements++;
  }
  steps.push({index,operation:declaration.steps[index].operation,status:'provider_success',gasUsed:execution.gasUsed,returnData:execution.returnData,committedLogCount:committedLogs(execution.trace).length,originalRaw:join(originalEvidence[0]),beforeOverridesSha256:sha(JSON.stringify(contexts[index].before??null)),afterOverridesSha256:sha(JSON.stringify(contexts[index].after)),queries});originals++;
 }
 const localRecord=json(path.join(capture,'local',number,'report.json'));validateWireDirectory(path.join(capture,'local',number),localRecord);
 const localProof=fs.readdirSync(path.join(capture,'local',number,'wire')).map(name=>{const p='local/'+number+'/wire/'+name,w=json(path.join(capture,p));return{path:p,sha256:sha(read(path.join(capture,p))),request:JSON.parse(w.requestText),response:JSON.parse(Buffer.from(w.rawBase64,'base64'))};}).filter(w=>w.request.method==='eth_getProof');
 assert.equal(localProof.length,1);assert.equal(localProof[0].response.error.code,-32000);assert.match(localProof[0].response.error.message,/historical state .* is not available/);
 cases.push({id:declaration.id,blockHash:declaration.header.hash,blockNumber:BigInt(declaration.header.number).toString(),sender:declaration.from,amounts:declaration.amounts,providerReportSha256:sha(read(path.join(capture,'provider',number,'report.json'))),rpcCalls:record.captureUsage.calls,initialSenderFactScope:'provider_reads_not_proofs',steps,localFailure:localProof[0]});
}
assert.equal(originals,6);assert.equal(measurements,39);assert.equal(halves,78);verifyPacket(capture,manifestPin);
console.log(JSON.stringify({kind:'provider_only_saved_observations',planSha256:planPin,manifestSha256:manifestPin,extractorSha256:sha(read(fileURLToPath(import.meta.url))),manifestFiles:manifest.files.length,counts:{originals,measurements,halves,evidenceJoinsIncludingRepeatedReferences:evidenceRows},cases,
 localAgreement:{originalChannels:{matched:0,mismatched:0,unavailable:30},queryChannels:{matched:0,mismatched:0,unavailable:117}},
 scope:{source:'saved_drpc_responses_only',targetsExecuted:0,networkCalls:0,independentExecutionAgreement:false,initialStateProofsAvailable:false,originalGas:5000000,providerQueryGas:300000,priced:false,signedHistoricalReplay:false,completeEffects:false},
 limitations:['Both local proof attempts failed on unavailable historical state; provider success does not establish local execution correctness.','Header hashes/witnesses, overrides, raw response joins, getter ABI values and nonce-only query mutations were checked using archived shared validators; this is not a second execution engine.','Provider sender nonce/balance/code reads anchor query mutation checks but are not authenticated state proofs.','Gas is the saved callTracer/API reported charge, not an independently reconstructed receipt.','Aave account-data base units have unknown currency/scale here; Morpho position belongs to the inner vault, not directly to the sender.','Contract-held balances and shares are not assumed to be sender assets.']},null,2));
