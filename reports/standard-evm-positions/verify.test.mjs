// Offline harness controls. Mutated/generated responses here are synthetic
// fault controls, never new on-chain evidence or expected live amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { INPUT_FILES,buildCases,bindMorphoPosition,VAULT,MARKET } from './selection.mjs';
import { validateStep,validateReport,independentQuery } from './checks.mjs';
import { validateTransport,replayExchange,invokeHandler,checkEngineEvidence } from './verify.mjs';
import { validateCases,LIMITS,IMPLEMENTATION_FILES } from './run.mjs';
import { keccak_256 as keccak } from '../ethereum-lending-local-reference/runtime/engines/local-evm/node_modules/@noble/hashes/sha3.js';
import * as api from '../../src/standard-simulation.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url)));
const files=Object.fromEntries(INPUT_FILES.map(x=>[x.path,readFileSync(new URL('../../'+x.originalPath,import.meta.url))]));
const cases=buildCases(files,keccak),pair=read('standard-evm-sequence/approve-then-supply-response.json');
const source=read('ethereum-lending-local-reference/morpho-kiln-usdc-deposit-product.json');
test('fixed envelopes pass actual API; query counts and owner identities are fixed',()=>{
  validateCases(api,cases);assert.deepEqual(cases.map(x=>x.input.calls?.map(c=>c.queries.length)??x.input.queries.length),[5,4,[2,5]]);
  assert.equal(cases[1].input.queries[3].user,VAULT);assert.equal(cases[1].input.queries[3].marketId,MARKET);assert.notEqual(cases[1].input.from,VAULT);
  assert.equal(LIMITS.totalRpcCalls,388);assert.equal(LIMITS.rpcTotalBytes,192*1024*1024);assert.equal(LIMITS.totalWallMs,600000);assert.equal(LIMITS.port,0);assert.equal(IMPLEMENTATION_FILES.length,34);
});
test('mutated source input is rejected by its pin',()=>{const altered={...files,'inputs/deposit-plan.json':Buffer.from('{}')};assert.throws(()=>buildCases(altered,keccak));});
function mutateSource(fn){const p=structuredClone(source),w=p.transportEvidence.find(x=>x.id===8),b=JSON.parse(w.responseText);let f=b.result;for(const n of[1,11,1,52])f=f.calls[n];fn(f);w.responseText=JSON.stringify(b);w.transport.responseSha256=sha(w.responseText);return p;}
test('independently recomputed Morpho market and user bind the sole Blue supply',()=>{assert.equal(bindMorphoPosition(source,keccak).marketId,MARKET);assert.throws(()=>bindMorphoPosition(mutateSource(f=>{f.from=cases[1].input.from;}),keccak));assert.throws(()=>bindMorphoPosition(mutateSource(f=>{f.logs[0].topics[1]='0x'+'00'.repeat(32);}),keccak));});
function approval(){
  const report=structuredClone(pair.steps[0].result);delete report.discovery;report.apiRequest.queries=structuredClone(report.request.queries);report.preview.positions=[];
  const {chainId,from,block,...input}=report.apiRequest;return{report,input,shared:{chainId,from,block},keccak};
}
test('recorded real approval state, query words, header and nonce evidence survive manual projection',()=>{const fixture=approval();assert.equal(validateStep(fixture.report,fixture).measurements[0].afterRaw,'3962903485');});
function syntheticPosition(kind='aave_v3_user_account_data'){
  const fixture=approval(),{report,shared}=fixture,descriptor=kind==='aave_v3_user_account_data'?cases[0].input.queries[4]:cases[1].input.queries[3],compiled=independentQuery(descriptor,keccak);
  const count=compiled.fields.length,values=[Array(count).fill(0n),Array(count).fill(7n)];if(count===6)values[0][5]=values[1][5]=(1n<<256n)-1n;
  const row=report.measurements[0];row.query=compiled.query;row.position=compiled.position;row.contractIdentityVerified=false;
  for(const field of['beforeRaw','afterRaw','deltaRaw'])delete row[field];
  for(const [index,proof]of row.queryEvidence.entries()){
    const trace=report.evidence[proof.traceEvidenceId-1],mutation=report.evidence[proof.mutationEvidenceId-1];
    for(const record of[trace,mutation])Object.assign(record.params[0],compiled.query);
    const output='0x'+values[index].map(x=>x.toString(16).padStart(64,'0')).join('');
    trace.result={type:'CALL',from:shared.from,to:compiled.query.to,input:compiled.query.data,value:'0x0',gas:'0x493e0',gasUsed:'0x100',output};
    row[index?'afterReturnData':'beforeReturnData']=output;
  }
  row.rows=compiled.fields.map(([name,bits,unit],i)=>({name,abiType:'uint'+bits,beforeRaw:values[0][i].toString(),afterRaw:values[1][i].toString(),deltaRaw:(values[1][i]-values[0][i]).toString(),unit}));
  report.request.queries=[descriptor];report.apiRequest.queries=[descriptor];fixture.input.queries=[descriptor];
  report.preview.queries=[];report.preview.positions=[{index:0,...compiled.position.identity,userIsSender:descriptor.user===shared.from,contractIdentityVerified:false,status:'measured',query:compiled.query,rows:structuredClone(row.rows),queryEvidence:row.queryEvidence}];
  return fixture;
}
test('synthetic Aave tuple keeps max health word and exact arithmetic, without interpreting it',()=>{const f=syntheticPosition();const result=validateStep(f.report,f);assert.equal(result.measurements[0].rows[5].beforeRaw,((1n<<256n)-1n).toString());});
test('synthetic tuple high bits, length and false subtraction fail closed',()=>{
  const f=syntheticPosition('morpho_blue_position'),r=f.report.measurements[0];r.rows[1].afterRaw=(1n<<128n).toString();assert.throws(()=>validateStep(f.report,f));
  const a=syntheticPosition();a.report.evidence[11].result.output+='00';assert.throws(()=>validateStep(a.report,a));
  const b=syntheticPosition();b.report.measurements[0].rows[0].deltaRaw='8';assert.throws(()=>validateStep(b.report,b));
});
test('query state omission and mutation beyond nonce are rejected',()=>{
  const a=syntheticPosition();delete a.report.evidence[13].params[2].stateOverrides;assert.throws(()=>validateStep(a.report,a));
  const b=syntheticPosition();b.report.evidence[12].result.post[b.shared.from].balance='0x1';assert.throws(()=>validateStep(b.report,b));
});
test('unavailable position never accepts raw amounts',()=>{const f=syntheticPosition();f.report.canonicalStatus='unverified';f.report.measurements[0].status='unavailable';assert.throws(()=>validateReport(f.report,{input:f.report.apiRequest,profile:'single'},keccak));});
test('explicit typed revert retains not-applicable identities, with no query values',()=>{
  const base=read('standard-evm-sequence/supply-without-approval-response.json'),descriptor=cases[0].input.queries[4],compiled=independentQuery(descriptor,keccak);
  const report=structuredClone(base);delete report.discovery;report.request.queries=[descriptor];report.apiRequest.queries=[descriptor];report.measurements=[{query:compiled.query,position:compiled.position,contractIdentityVerified:false,status:'not_applicable'}];report.preview.queries=[];report.preview.positions=[{index:0,status:'not_applicable'}];
  const {chainId,from,block,...input}=report.apiRequest,context={input,shared:{chainId,from,block},keccak};
  assert.equal(validateStep(report,context).status,'reverted_or_failed');report.measurements[0].beforeReturnData='0x';assert.throws(()=>validateStep(report,context));
});
test('archived transport validates all real saved wires and detects body corruption',()=>{
  assert.equal(validateTransport(pair.transportEvidence,'sequence').withheldErrorBodies,0);
  const records=structuredClone(pair.transportEvidence);records[0].responseText+=' ';assert.throws(()=>validateTransport(records,'sequence'));
});
test('real archived handler replay is exact and an altered request is latched',async()=>{
  const root=new URL('../standard-evm-sequence/source/',import.meta.url);
  const runtime={...await import(new URL('src/server.js',root)),...await import(new URL('src/standard-rpc.js',root))};
  const exchange=read('standard-evm-sequence/http/003.json'),plan=read('standard-evm-sequence/plan.json');
  assert.equal((await replayExchange(exchange,plan,runtime,'sequence')).status,'matched');
  const changed=structuredClone(exchange),output=JSON.parse(changed.response.bodyText);output.transportEvidence[0].requestText+=' ';changed.response.bodyText=JSON.stringify(output);
  await assert.rejects(replayExchange(changed,plan,runtime,'sequence'));
});
test('actual current handler retains early failed context and skipped sequence step; exact offline replay works',async()=>{
  const runtime={...await import('../../src/server.js'),...await import('../../src/standard-rpc.js')};
  let calls=0;
  const rpc=new runtime.StandardRpcClient({url:'https://eth.drpc.org',profile:'sequence',fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);assert.equal(++calls,1);assert.equal(request.method,'eth_chainId');
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x2'}),{status:200});
  }});
  const server=runtime.createAppServer({persist:false,standardRpcFactory:()=>rpc,rpcFactory:()=>{throw new Error('Unexpected legacy call');}});
  const request={method:'POST',path:'/api/evm/simulate-sequence',contentType:'application/json',bodyText:cases[2].requestText};
  const response=await invokeHandler(server,request),report=JSON.parse(response.bodyText);assert.equal(response.status,200);
  assert.equal(report.sequence.status,'unavailable');assert.equal(report.steps[0].status,'unavailable');assert.equal(report.steps[1].status,'skipped');assert.equal(report.steps[1].result,undefined);
  checkEngineEvidence(report,report.transportEvidence);assert.equal(validateReport(report,cases[2],keccak)[0].status,'unavailable');
  assert.equal((await replayExchange({request,response},{provider:'https://eth.drpc.org'},runtime,'sequence')).status,'matched');
});
