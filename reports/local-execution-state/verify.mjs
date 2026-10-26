// Standalone offline audit. Never imports the recorder, product or EVM engine.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const DIR=new URL('./',import.meta.url),ROOT=new URL('../../',import.meta.url);
const sha=b=>createHash('sha256').update(b).digest('hex'),json=o=>JSON.stringify(o,null,2)+'\n';
const load=async p=>JSON.parse(await readFile(new URL(p,DIR)));
const bytes=await readFile(new URL('capture.json',DIR)),captureSha256=sha(bytes),capture=JSON.parse(bytes),plan=await load('plan.json'),manifest=await load('manifest.json');
assert.notEqual(capture.status,'running');
for(const {file,sha256} of manifest.files)assert.equal(sha(await readFile(new URL(file,DIR))),sha256);
assert.equal(sha(await readFile(new URL('plan.json',DIR))),capture.planSha256);assert.equal(sha(await readFile(new URL('capture.mjs',DIR))),capture.scriptSha256);assert.equal(plan.scriptSha256,capture.scriptSha256);
for(const source of plan.sources)assert.equal(sha(await readFile(new URL(source.path,ROOT))),source.sha256);
if(process.argv[2]==='--pin'){assert.equal(process.argv[3],captureSha256);await writeFile(new URL('capture-pin.json',DIR),json({captureSha256,planSha256:capture.planSha256,scriptSha256:capture.scriptSha256}),{flag:'wx'});console.log(json({status:'pinned_offline',captureSha256,networkCalls:0}));process.exit(0);}
assert.ok(process.argv[2]==='--verify'||process.argv[2]===undefined);const pin=await load('capture-pin.json');assert.deepEqual(pin,{captureSha256,planSha256:capture.planSha256,scriptSha256:capture.scriptSha256});
const prior=JSON.parse(await readFile(new URL('reports/current-validated-decimal/capture.json',ROOT)));
const original=prior.cases.find(c=>c.id==='current-direct-transferfrom-a');assert.ok(original);
assert.deepEqual(capture.envelope,plan.envelope);assert.deepEqual(capture.pinned,plan.pinned);
for(const run of original.runs)assert.deepEqual(run.rpcCalls.find(r=>r.request.method==='debug_traceCall').request.params.slice(0,2),[plan.envelope,plan.pinned]);
assert.equal(plan.blockNumber,original.request.block);assert.equal(plan.pinned.blockHash,original.expectedBlockHash);assert.equal(plan.pinned.requireCanonical,true);
assert.deepEqual(plan.providers,[{id:'drpc',url:'https://hyperliquid.drpc.org'},{id:'hyperlend-archive',url:'https://rpc.hyperlend.finance/archive'}]);
assert.deepEqual(plan.completionFields,[{field:'nonce',method:'eth_getTransactionCount'},{field:'balance',method:'eth_getBalance'},{field:'code',method:'eth_getCode'}]);
assert.deepEqual(capture.budgets,plan.budgets);assert.equal(plan.budgets.maxRpcCalls,204);assert.equal(plan.budgets.maxRpcCallsPerProvider,102);assert.equal(plan.budgets.retries,0);
const HEADER=['hash','number','parentHash','timestamp','gasLimit','baseFeePerGas','mixHash','miner'];
const object=x=>x&&typeof x==='object'&&!Array.isArray(x), ADDRESS=/^0x[0-9a-f]{40}$/,WORD=/^0x[0-9a-f]{64}$/,BYTES=/^0x(?:[0-9a-f]{2})*$/;
function uint(x,max=(1n<<256n)-1n){assert.ok((typeof x==='string'&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(x))||(Number.isSafeInteger(x)&&x>=0));const n=BigInt(x);assert.ok(n>=0n&&n<=max);return n;}
function canonicalState(input){
  assert.ok(object(input));const out={},keys=Object.keys(input);assert.ok(keys.length>0&&keys.length<=32);
  for(const raw of keys){const address=raw.toLowerCase();assert.match(address,ADDRESS);assert.ok(!Object.hasOwn(out,address));const value=input[raw];assert.ok(object(value));assert.ok(Object.keys(value).every(k=>['nonce','balance','code','storage','codeHash'].includes(k)));
    const result={};for(const field of ['nonce','balance'])if(Object.hasOwn(value,field))result[field]=uint(value[field],field==='nonce'?(1n<<64n)-1n:(1n<<256n)-1n).toString();
    if(Object.hasOwn(value,'code')){assert.match(value.code.toLowerCase(),BYTES);result.code=value.code.toLowerCase();}
    if(Object.hasOwn(value,'codeHash')){assert.match(value.codeHash.toLowerCase(),WORD);result.codeHash=value.codeHash.toLowerCase();}
    if(Object.hasOwn(value,'storage')){assert.ok(object(value.storage));assert.ok(Object.keys(value.storage).length<=2000);result.storage={};for(const[s,v]of Object.entries(value.storage)){assert.match(s.toLowerCase(),WORD);assert.match(v.toLowerCase(),WORD);assert.ok(!Object.hasOwn(result.storage,s.toLowerCase()));result.storage[s.toLowerCase()]=v.toLowerCase();}}
    out[address]=result;
  }return Object.fromEntries(Object.keys(out).sort().map(k=>[k,out[k]]));
}
function equal(a,b){try{assert.deepEqual(a,b);return true;}catch{return false;}}
let totalBytes=0,successful=0,failed=0;const summaries=[],completedInputs=[];
for(const provider of plan.providers){
  const records=capture.records.filter(r=>r.provider===provider.id),meta=capture.providers.find(p=>p.id===provider.id);assert.ok(meta);assert.equal(meta.rpcCalls,records.length);assert.ok(records.length<=102);
  for(const [index,record]of records.entries()){
    assert.equal(record.endpoint,provider.url);assert.equal(record.request.id,index+1);assert.equal(record.request.jsonrpc,'2.0');assert.equal(record.requestText,JSON.stringify(record.request));assert.deepEqual(JSON.parse(record.requestText),record.request);totalBytes+=record.responseBytes;
    if(record.response){successful++;assert.equal(record.httpStatus,200);assert.equal(record.bodyComplete,true);assert.equal(record.error,undefined);assert.equal(record.response.id,index+1);assert.equal(record.response.jsonrpc,'2.0');assert.ok(Object.hasOwn(record.response,'result')&&!Object.hasOwn(record.response,'error'));assert.deepEqual(JSON.parse(record.responseText),record.response);assert.equal(sha(record.responseText),record.responseSha256);assert.equal(Buffer.byteLength(record.responseText),record.responseBytes);assert.ok(record.responseBytes<=8388608);}
    else{failed++;assert.ok(record.error);assert.equal(record.responseBodyWithheld,true);assert.equal(record.responseText,undefined);}
  }
  const check=(record,spec)=>{assert.ok(record);assert.equal(record.label,spec.label);assert.equal(record.request.method,spec.method);assert.deepEqual(record.request.params,spec.params);};
  // The sealed actual packet completed both providers. Any unavailable result
  // remains raw evidence; it must not be relabeled a complete input fixture.
  const summary={provider:provider.id,rpcCalls:records.length,inputStatus:'unavailable',accounts:[],inputRecordIds:[],comparisonRecordIds:[],completionReads:[]};summaries.push(summary);
  check(records[0],plan.fixedRequests[0]);if(!records[0].response||uint(records[0].response.result)!==999n)continue;
  check(records[1],plan.fixedRequests[1]);if(!records[1].response)continue;const firstHeader=records[1].response.result;
  for(const field of HEADER)assert.equal(firstHeader[field],plan.expectedHeader[field]);
  check(records[2],plan.fixedRequests[2]);assert.deepEqual(records[2].request.params,[plan.envelope,plan.pinned,{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:false,disableCode:false,disableStorage:false,includeEmpty:true}}]);
  if(!records[2].response)continue;
  let inputs;try{inputs=canonicalState(records[2].response.result);}catch{continue;}
  const expectedCompletions=[];for(const account of Object.keys(inputs).sort())for(const field of plan.completionFields)if(!Object.hasOwn(inputs[account],field.field))expectedCompletions.push({account,...field});
  assert.deepEqual(meta.completionReads,expectedCompletions.map(({account,field,method})=>({account,field,method})));assert.equal(records.length,6+expectedCompletions.length);
  let offset=3,incomplete=false;const provenance={};
  for(const [account,input]of Object.entries(inputs)){provenance[account]=Object.fromEntries(Object.keys(input).map(field=>[field,{recordId:3,source:'full_prestate'}]));}
  for(const completion of expectedCompletions){const record=records[offset++];check(record,{label:`missing-${completion.field}:${completion.account}`,method:completion.method,params:[completion.account,plan.pinned]});summary.completionReads.push({...completion,recordId:record.request.id});if(!record.response){incomplete=true;continue;}
    const value=record.response.result;if(completion.field==='code'){assert.ok(typeof value==='string');assert.match(value.toLowerCase(),BYTES);inputs[completion.account].code=value.toLowerCase();}else inputs[completion.account][completion.field]=uint(value,completion.field==='nonce'?(1n<<64n)-1n:(1n<<256n)-1n).toString();
    provenance[completion.account][completion.field]={recordId:record.request.id,source:'missing_basic_field_read'};
  }
  const trace=records[offset++],diff=records[offset++],last=records[offset++];check(trace,plan.fixedRequests[3]);check(diff,plan.fixedRequests[4]);check(last,plan.fixedRequests[5]);assert.equal(offset,records.length);
  assert.deepEqual(trace.request.params,[plan.envelope,plan.pinned,{tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true}}]);assert.deepEqual(diff.request.params,[plan.envelope,plan.pinned,{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true}}]);
  summary.inputRecordIds=[3,...summary.completionReads.map(x=>x.recordId)];summary.comparisonRecordIds=[trace.request.id,diff.request.id];assert.ok(summary.comparisonRecordIds.every(id=>!summary.inputRecordIds.includes(id)));
  if(!last.response){incomplete=true;}else for(const field of HEADER)assert.equal(last.response.result[field],firstHeader[field]);
  const oldRun=original.runs.find(r=>r.provider===provider.id),oldTrace=oldRun.rpcCalls.find(r=>r.request.method==='debug_traceCall'&&r.request.params[2].tracer==='callTracer'),oldDiff=oldRun.rpcCalls.find(r=>r.request.method==='debug_traceCall'&&r.request.params[2].tracer==='prestateTracer');
  summary.comparisonOutputs={traceAvailable:Boolean(trace.response),diffAvailable:Boolean(diff.response),traceEqualsPrior:trace.response?equal(trace.response.result,oldTrace.response.result):null,diffEqualsPrior:diff.response?equal(diff.response.result,oldDiff.response.result):null,executionError:trace.response?.result?.error??null};
  for(const[account,input]of Object.entries(inputs)){
    for(const field of['nonce','balance','code'])if(!Object.hasOwn(input,field))incomplete=true;
    summary.accounts.push({account,nonce:input.nonce??null,balance:input.balance??null,codeBytes:input.code===undefined?null:(input.code.length-2)/2,codeBytesSha256:input.code===undefined?null:sha(Buffer.from(input.code.slice(2),'hex')),storageSlots:Object.keys(input.storage??{}).length,explicitZeroStorageSlots:Object.values(input.storage??{}).filter(v=>BigInt(v)===0n).length,existence:input.nonce!==undefined&&input.balance!==undefined&&input.code!==undefined&&(BigInt(input.nonce)>0n||BigInt(input.balance)>0n||input.code!=='0x')?'nonempty_basic_fields':'not_proven',fieldProvenance:provenance[account]});
  }
  summary.inputStatus=incomplete?'incomplete_basic_fields_or_header':'sparse_prestate_inputs_and_basic_fields_verified';completedInputs.push({provider:provider.id,inputs,trace:trace.response?.result,diff:diff.response?.result});
}
assert.equal(capture.summary.rpcCalls,capture.records.length);assert.equal(capture.summary.successfulRpcCalls,successful);assert.equal(capture.summary.failedRpcCalls,failed);assert.equal(capture.summary.responseBytes,totalBytes);assert.ok(capture.records.length<=204&&totalBytes<=33554432);assert.ok(capture.elapsedMs<=360000);assert.equal(capture.skipped.length,0);assert.equal(capture.status,'complete');
const [a,b]=completedInputs;
console.log(json({status:'verified_offline_state_packet',captureSha256,summary:capture.summary,providers:summaries,crossProvider:{fullPrestateAndCompletedBasicFieldsEqual:a&&b?equal(a.inputs,b.inputs):null,originalCallTraceEqual:a?.trace&&b?.trace?equal(a.trace,b.trace):null,originalStateDiffEqual:a?.diff&&b?.diff?equal(a.diff,b.diff):null},networkCalls:0,liveSourceImported:false,limitations:['Sparse touched state is not complete world state; every unknown account/storage read must fail.','Inputs use only original full prestate and explicit missing-basic-field reads, never trace outputs or diff pre/post reconstruction.','This audit does not run an EVM, establish code-source attestation, prove account absence or cryptographically verify supplied state.','Local execution remains conditional on independently reconciled gas, warm-set, nonce and synthetic BASEFEE-zero context.']}));
