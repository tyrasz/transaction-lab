// Synthetic wire comparators, not independent oracle/conformance observations.
// Actual isolated children consume genuine generated MPT proofs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectSelectedCase, oracleRequests, adjudicateLocalOutcome, oracleStateChanges, oracleLogs } from './case.mjs';
import { lifecycleFixture, FACTORY, SENDER, initcode, factoryCode, createdAddress, word } from '../../engines/local-evm/test/lifecycle-fixture.js';
import { shanghaiFixture } from '../../engines/local-evm/test/shanghai-fixture.js';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { createCohortWireBudget, createCohortTransport } from '../standard-evm/cohort-wire.mjs';

const HASH='0x'+'17'.repeat(32), OTHER='0x'+'33'.repeat(20), VICTIM='0x'+'44'.repeat(20);
const implementation={name:'synthetic source-binding fixture',version:'test',sourceSha256:'a'.repeat(64),sourceFiles:['engines/local-evm/execute.js','engines/local-evm/isolated-call.js']};
const hx=n=>'0x'+BigInt(n).toString(16),sha=b=>createHash('sha256').update(b).digest('hex');
const copy=x=>structuredClone(x);
function projectionInput(f,changes={}){
  const row={transactionHash:HASH,blockHash:'0x'+'18'.repeat(32),blockNumber:(BigInt(f.header.number)+1n).toString(),transactionIndex:'0',selected:true,parentBlockHash:f.header.hash,parentHeader:f.header};
  const envelope={hash:HASH,from:f.request.from,to:f.request.to,input:f.request.data,value:f.request.value,gas:'100000',type:'0',extensions:{},...changes};
  return {row,census:{selected:[row],envelopes:[{...row,normalizedEnvelope:envelope}]}};
}
function rawTrace(frame,root,gas){
  const out={type:frame.type,from:frame.from,to:frame.to,input:frame.input,value:frame.value,gas:root?'0x4c4b40':frame.gas,gasUsed:root?hx(gas):frame.gasUsed};
  if(frame.output!=='0x')out.output=frame.output;
  if(frame.error)out.error=frame.error==='revert'?'execution reverted':frame.error;
  if(frame.calls.length)out.calls=frame.calls.map(c=>rawTrace(c,false));
  return out;
}
function rawDiff(attempt){
  const pre={},post={};
  for(const row of attempt.changes.accounts){
    const a=attempt.inputs.accounts[row.address];
    if(a.exists)pre[row.address]={nonce:hx(a.nonce),balance:hx(a.balance),code:a.code};
    if(row.existence?.after===false)continue;
    const next={};post[row.address]=next;
    for(const k of ['nonce','balance'])if(row[k])next[k]=row[k].after;
    if(row.code)next.code=row.code.after;
    if(row.storage){
      const old={},current={};for(const s of row.storage){if(BigInt(s.before)!==0n)old[s.slot]=s.before;if(BigInt(s.after)!==0n)current[s.slot]=s.after;}
      if(Object.keys(old).length){pre[row.address]??={};pre[row.address].storage=old;}
      if(Object.keys(current).length)next.storage=current;
    }
  }
  return {pre,post};
}
async function wires(f,results){
  let index=0;const transport=createCohortTransport({budget:createCohortWireBudget(),provider:'drpc',profile:'product',blockHash:f.header.hash,fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body),result=results[index++];return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,...(result?.rpcError?{error:{code:-32000,message:'synthetic unavailable'}}:{result})}));
  }});
  for(const p of oracleRequests({request:f.request,header:f.header}))try{await transport.call(p.method,p.params);}catch{}
  await transport.drain();assert.equal(index,4);return transport.records();
}
async function fixture(options={}){
  const f=options.shanghai?await shanghaiFixture(options):await lifecycleFixture({code:'0x602a60005500',...options});
  if(options.request)Object.assign(f.request,options.request);
  const attempt=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
  assert.equal(attempt.status,'completed',JSON.stringify(attempt.error));
  const trace=rawTrace(attempt.output.trace,true,attempt.output.gasAccounting?.gasUsed??0),diff=rawDiff(attempt);
  const records=await wires(f,[f.header,trace,diff,f.header]);
  return {f,trace,diff,input:{transactionHash:HASH,request:f.request,header:f.header,expectedLocalImplementation:copy(implementation),local:{dispatch:'completed',implementation:copy(implementation),attempt},oracle:{dispatch:'completed',records}}};
}
function rewrite(wire,result){
  const body=JSON.stringify({jsonrpc:'2.0',id:wire.id,result}),raw=Buffer.from(body);
  Object.assign(wire,{responseText:body,rawBase64:raw.toString('base64'),parsed:JSON.parse(body),responseSha256:sha(raw)});
  Object.assign(wire.transport,{complete:true,retainedBytes:raw.length,observedBytes:raw.length,retainedSha256:sha(raw),observedSha256:sha(raw)});
}

test('selected projection admits explicit CREATE and ordered duplicate context without changing sample; blocked envelopes stay present',async()=>{
  const f=await lifecycleFixture({code:'0x00'});
  const base=projectionInput(f,{to:null,input:'0x',accessList:[{address:OTHER,storageKeys:[word(1),word(1)]},{address:OTHER,storageKeys:[]}]});
  const p=projectSelectedCase(base);assert.equal(p.status,'projectable');assert.equal(p.request.to,null);assert.equal(p.request.gas,'5000000');assert.deepEqual(p.request.accessList,base.census.envelopes[0].normalizedEnvelope.accessList);
  for(const [change,why]of [[{gas:'5000001'},'original_gas_limit_exceeds_profile'],[{type:'4'},'authorization_context_exceeds_profile'],[{extensions:{newField:1}},'unrecognized_envelope_fields'],[{to:null,blobVersionedHashes:['0x01'+'11'.repeat(31)]},'blob_creation_unsupported'],[{input:'0x'+'00'.repeat(32769)},'calldata_exceeds_profile']]){
    const out=projectSelectedCase(projectionInput(f,change));assert.equal(out.status,'unsupported');assert.ok(out.reasons.includes(why));assert.equal(out.transactionHash,HASH);assert.equal(out.request,undefined);
  }
  const wrong=projectionInput(f);wrong.row=copy(wrong.row);wrong.row.transactionIndex='2';assert.throws(()=>projectSelectedCase(wrong));
});
test('oracle plan declares exact unsigned call/context without state overrides or injected nonce, and omits creation to',async()=>{
  const f=await lifecycleFixture({code:'0x00'});f.request.to=null;f.request.data='0x6000';
  const p=oracleRequests({request:f.request,header:f.header});assert.equal(p.length,4);assert.equal(Object.hasOwn(p[1].params[0],'to'),false);assert.equal(p[1].params[0].gasPrice,'0x0');assert.deepEqual(p[1].params[2].blockOverrides,{baseFeePerGas:'0x0'});assert.deepEqual(p[1].params[0],p[2].params[0]);assert.equal(p[1].params[2].stateOverrides,undefined);
  f.request.to=FACTORY;f.request.blobVersionedHashes=['0x01'+'12'.repeat(31)];f.request.accessList=[{address:OTHER,storageKeys:[word(1),word(1)]}];
  const b=oracleRequests({request:f.request,header:f.header});assert.deepEqual(b[1].params[0].accessList,f.request.accessList);assert.equal(b[1].params[0].maxFeePerBlobGas,'0x0');assert.equal(b[1].params[2].blockOverrides.blobBaseFee,'0x0');
});
test('actual local state write is scored as evaluated product, five exact synthetic oracle channels match',async()=>{
  const {input}=await fixture();const result=await adjudicateLocalOutcome(input);
  assert.equal(result.outcome.execution,'success');assert.equal(result.outcome.comparison,'match',JSON.stringify(result));assert.equal(result.allChannelsComplete,true);assert.equal(result.limitations.providerContextExecutionAttested,false);
});
test('actual root revert counts completed, with nonce-only state retained',async()=>{
  const {input}=await fixture({code:'0x60006000fd'});const r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.execution,'reverted');assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
});
test('actual invalid opcode accepts exact Geth INVALID spelling with raw binding and independent channels',async()=>{
  const {input,trace,diff}=await fixture({code:'0xfe'});
  assert.equal(input.local.attempt.output.execution.error,'invalid opcode');
  const baseline=await adjudicateLocalOutcome(input);assert.equal(baseline.outcome.comparison,'match');
  const geth={...trace,error:'invalid opcode: INVALID'};rewrite(input.oracle.records[1],geth);
  const result=await adjudicateLocalOutcome(input);assert.equal(result.outcome.execution,'failed');assert.equal(result.outcome.comparison,'match',JSON.stringify(result));assert.equal(result.allChannelsComplete,true);
  assert(Object.values(result.channels).every(c=>c.status==='match'));assert.equal(result.evidence.oracle.rawExecutionError,'invalid opcode: INVALID');
  const badRaw=copy(input);badRaw.oracle.records[1].parsed.result.error='invalid opcode';
  assert.equal((await adjudicateLocalOutcome(badRaw)).outcome.comparison,'oracle_unavailable');
  const unknown=copy(input);rewrite(unknown.oracle.records[1],{...geth,error:'invalid opcode: INVALID extra'});
  const missing=await adjudicateLocalOutcome(unknown);assert.equal(missing.channels.executionStatus.status,'unavailable');assert.equal(missing.outcome.comparison,'not_comparable');
  for(const name of['returnData','committedLogs','gasAccounting','fullObservedStateChanges'])assert.equal(missing.channels[name].status,'match');
  const gas=copy(input);rewrite(gas.oracle.records[1],{...geth,gasUsed:hx(BigInt(geth.gasUsed)-1n)});
  const gasResult=await adjudicateLocalOutcome(gas);assert.equal(gasResult.channels.executionStatus.status,'match');assert.equal(gasResult.channels.gasAccounting.status,'mismatch');
  const logs=copy(input);rewrite(logs.oracle.records[1],{...geth,logs:[{address:FACTORY,topics:['0x01'],data:'0x'}]});
  const logResult=await adjudicateLocalOutcome(logs);assert.equal(logResult.channels.executionStatus.status,'match');assert.equal(logResult.channels.committedLogs.status,'unavailable');
  const state=copy(input),changed=copy(diff),sender=input.request.from;changed.post[sender].nonce=hx(BigInt(changed.post[sender].nonce)+1n);rewrite(state.oracle.records[2],changed);
  const stateResult=await adjudicateLocalOutcome(state);assert.equal(stateResult.channels.executionStatus.status,'match');assert.equal(stateResult.channels.fullObservedStateChanges.status,'mismatch');
});
test('actual top-level deployment, internal deployment and Shanghai whole-account deletion are comparable',async()=>{
  for(const options of [{request:{to:null,data:'0x'+initcode()}},{code:undefined},{shanghai:true,code:'0x73'+OTHER.slice(2)+'ff',accounts:{[FACTORY]:{nonce:7n,balance:1000n,code:'0x73'+OTHER.slice(2)+'ff',storage:{[word(991)]:99n}}}}]){
    // Undefined explicitly selects lifecycleFixture default factory CREATE.
    const {input}=await fixture(options),r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.execution,'success');assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
  }
});
test('proof-absent native funding remains distinct from deletion',async()=>{
  const {input}=await fixture({code:'0x00',request:{to:OTHER,value:'7'}}),r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
  assert.deepEqual(r.channels.fullObservedStateChanges.product.find(x=>x.address===OTHER).existence,{before:false,after:true});
});
test('actual access-list occurrences and blob opcode results retain full local profile and unsigned gas binding',async()=>{
  for(const request of [{accessList:[{address:FACTORY,storageKeys:[word(1),word(1)]},{address:FACTORY,storageKeys:[]}]},{blobVersionedHashes:['0x01'+'12'.repeat(31)]}]){
    const {input}=await fixture({code:'0x60004960005260206000f3',request});const r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
    if(request.blobVersionedHashes)assert.equal(input.local.attempt.output.execution.returnData,request.blobVersionedHashes[0]);
  }
});
test('Cancun created deletion handles transient absence and whole prefunded account removal; old contract is not deleted',async()=>{
  const init='73'+OTHER.slice(2)+'ff',code=factoryCode(init),target=createdAddress();
  // CREATE address depends only on factory/nonce, not constructor bytes.
  for(const accounts of [{},{[target]:{nonce:0n,balance:9n,code:'0x'}}]){
    const {input}=await fixture({code,accounts}),r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
    assert.equal(r.channels.fullObservedStateChanges.product.some(x=>x.address===target),Object.keys(accounts).length>0);
  }
  const {input}=await fixture({code:'0x73'+OTHER.slice(2)+'ff'}),r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'match',JSON.stringify(r));assert.equal(r.channels.fullObservedStateChanges.product.find(x=>x.address===FACTORY).existence,undefined);
});
test('EIP161 entire unknown storage trie deletion is represented by authenticated root, never invented cleared slots',async()=>{
  const call='6000600060006000600073'+VICTIM.slice(2)+'61fffff15000';
  const {input}=await fixture({code:'0x'+call,accounts:{[VICTIM]:{nonce:0n,balance:0n,code:'0x',storage:{[word(991)]:99n}}}}),r=await adjudicateLocalOutcome(input);
  assert.equal(r.outcome.comparison,'match',JSON.stringify(r));const deleted=r.channels.fullObservedStateChanges.product.find(x=>x.address===VICTIM);
  assert.deepEqual(deleted.existence,{before:true,after:false});assert.equal(deleted.storage,undefined);assert.match(deleted.initialStorageRoot,/^0x[0-9a-f]{64}$/);
});
test('oracle trace failure is oracle_unavailable without erasing completed local execution; missing diff leaves partial channels',async()=>{
  const {input,f,trace}=await fixture();
  input.oracle.records=await wires(f,[f.header,{rpcError:true},{rpcError:true},f.header]);input.oracle.dispatch='unavailable';let r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.execution,'success');assert.equal(r.outcome.comparison,'oracle_unavailable');
  input.oracle.records=await wires(f,[f.header,trace,{rpcError:true},f.header]);r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'not_comparable');assert.equal(r.channels.returnData.status,'match');assert.equal(r.channels.fullObservedStateChanges.status,'unavailable');
  const mismatch=copy(trace);mismatch.gasUsed=hx(BigInt(trace.gasUsed)+1n);rewrite(input.oracle.records[1],mismatch);r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'mismatch');assert.equal(r.allChannelsComplete,false);
});
test('source/header/returned proof mutations cannot become local completed accuracy evidence',async()=>{
  const {input}=await fixture();
  for(const mutate of [x=>x.local.implementation.sourceSha256='b'.repeat(64),x=>x.local.attempt.inputs.context.header.number='0x1',x=>x.local.attempt.inputEvidence.find(r=>r.request.method==='eth_getProof').result.balance='0x123',x=>x.local.attempt.output.profile.declaredGasLimit='1']){
    const x=copy(input);mutate(x);const r=await adjudicateLocalOutcome(x);assert.equal(r.outcome.execution,'provider_unavailable');assert.notEqual(r.outcome.comparison,'match');
  }
});
test('changed full header, corrupt raw response hash, wrong trace options and duplicate oracle records are not comparable',async()=>{
  const {input}=await fixture();
  for(const mutate of [x=>rewrite(x.oracle.records[3],{...x.header,unknownField:1}),x=>x.oracle.records[1].transport.retainedSha256='0'.repeat(64),x=>x.oracle.records[1].request.params[2].stateOverrides={},x=>x.oracle.records[2]=copy(x.oracle.records[1])]){
    const x=copy(input);mutate(x);const r=await adjudicateLocalOutcome(x);assert.equal(r.outcome.execution,'success');assert.equal(r.outcome.comparison,'oracle_unavailable');
  }
});
test('unknown provider state fields and unproven added changed accounts are unavailable, omitted real change is mismatch',async()=>{
  const {input,diff}=await fixture();
  for(const mutate of [d=>d.post[FACTORY].mystery=1,d=>d.post[VICTIM]={balance:'0x1'},d=>d.post[FACTORY].codeHash='0x'+'12'.repeat(32)]){
    const x=copy(input),d=copy(diff);mutate(d);rewrite(x.oracle.records[2],d);const r=await adjudicateLocalOutcome(x);assert.equal(r.channels.fullObservedStateChanges.status,'unavailable');assert.notEqual(r.outcome.comparison,'match');
  }
  const x=copy(input),d=copy(diff);delete d.pre[FACTORY];delete d.post[FACTORY];rewrite(x.oracle.records[2],d);const r=await adjudicateLocalOutcome(x);assert.equal(r.channels.fullObservedStateChanges.status,'mismatch');
});
test('sparse slot clearing uses explicit prior key; omitted maps do not erase unknown trie, post-only unknown slot rejected',async()=>{
  const {input}=await fixture({code:'0x600060015500',accounts:{[FACTORY]:{nonce:7n,balance:1000n,code:'0x600060015500',storage:{[word(1)]:42n,[word(991)]:99n}}}});
  const r=await adjudicateLocalOutcome(input);assert.equal(r.outcome.comparison,'match',JSON.stringify(r));
  const diff={pre:{[FACTORY]:{}},post:{[FACTORY]:{}}};assert.deepEqual(oracleStateChanges(diff,input.local.attempt.inputs),[]);
  diff.post[FACTORY].storage={[word(555)]:word(1)};assert.throws(()=>oracleStateChanges(diff,input.local.attempt.inputs),/not independently proven/);
});
test('committed log order validates indices/positions and rollback and supports creation/delegate execution contexts',()=>{
  const log=(address,index,position)=>({address,topics:[],data:'0x',index,position});
  const child={type:'CREATE',from:FACTORY,to:OTHER,value:'0x0',gas:'0x100',gasUsed:'0x1',input:'0x',logs:[log(OTHER,'0x1','0x0')]};
  const root={type:'CALL',from:SENDER,to:FACTORY,value:'0x0',gas:'0x200',gasUsed:'0x2',input:'0x',calls:[child],logs:[log(FACTORY,'0x0','0x0'),log(FACTORY,'0x2','0x1')]};
  assert.deepEqual(oracleLogs(root).map(x=>x.address),[FACTORY,OTHER,FACTORY]);
  const failed=copy(root);failed.error='execution reverted';assert.deepEqual(oracleLogs(failed),[]);
  const contradictory=copy(root);contradictory.logs[1].position='0x0';assert.throws(()=>oracleLogs(contradictory));
  const delegate=copy(root);Object.assign(delegate.calls[0],{type:'DELEGATECALL',to:VICTIM,logs:[log(FACTORY,'0x1','0x0')]});assert.equal(oracleLogs(delegate).length,3);
  delegate.calls[0].logs[0].address=VICTIM;assert.throws(()=>oracleLogs(delegate),/emitter/);
});
test('local unavailable/unsupported and oracle budgets preserve accounting roles and no fabricated comparison',async()=>{
  const {input}=await fixture();
  let x=copy(input);x.local.dispatch='budget_unattempted';assert.deepEqual((await adjudicateLocalOutcome(x)).outcome,{transactionHash:HASH,execution:'budget_unattempted',comparison:'budget_unattempted'});
  x=copy(input);x.oracle={dispatch:'budget_unattempted',records:[]};assert.equal((await adjudicateLocalOutcome(x)).outcome.execution,'success');assert.equal((await adjudicateLocalOutcome(x)).outcome.comparison,'budget_unattempted');
  x=copy(input);x.local.attempt.output.execution.status='unavailable';assert.equal((await adjudicateLocalOutcome(x)).outcome.execution,'provider_unavailable');
  const f=await lifecycleFixture({code:'0x00',accounts:{[SENDER]:{nonce:1n,balance:1000000n,code:'0x00'}}});const attempt=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
  x={...input,request:f.request,header:f.header,local:{dispatch:'completed',implementation,attempt}};assert.equal((await adjudicateLocalOutcome(x)).outcome.execution,'unsupported');
});
