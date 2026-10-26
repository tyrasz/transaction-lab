import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { discoverTokenQueries, DISCOVERY_LIMITS } from '../discovery.js';

const address = n => '0x'+BigInt(n).toString(16).padStart(40,'0');
const word = n => '0x'+BigInt(n).toString(16).padStart(64,'0');
const pad = a => a.slice(2).padStart(64,'0');
const S=address(1),T=address(2),R=address(3),I=address(4),O=address(5),B=address(6),Z=address(0),MAX=(1n<<256n)-1n;
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL='0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const transfer=(to,n=7n)=>'0xa9059cbb'+pad(to)+word(n).slice(2);
const transferFrom=(from,to,n=7n)=>'0x23b872dd'+pad(from)+pad(to)+word(n).slice(2);
const approve=(to,n=7n)=>'0x095ea7b3'+pad(to)+word(n).slice(2);
const balance=(token,account)=>({to:token,data:'0x70a08231'+pad(account)});
const allowance=(token,owner,spender)=>({to:token,data:'0xdd62ed3e'+pad(owner)+pad(spender)});
const key=q=>q.to+':'+q.data;
function frame(extra={}) {return {type:'CALL',from:S,to:T,input:'0x12345678',output:'0x',gas:'0x4c4b40',gasUsed:'0x5208',value:'0x0',...extra};}
function log(from=S,to=R,amount=7n,token=T,signature=TRANSFER) {return {address:token,topics:[signature,word(from),word(to)],data:word(amount)};}
function run(trace,options={}) {return discoverTokenQueries({request:{from:S,to:T,data:trace.input,value:'0x0',gas:'0x4c4b40'},trace,...options});}
function withheld(result,truncated=false) {
  assert.equal(result.status,'unavailable');assert.deepEqual(result.queries,[]);assert.equal(result.counts.complete,false);assert.equal(result.counts.truncated,truncated);
  assert.ok(result.candidates.every(c=>c.selection==='unavailable'));
  assert.ok(result.candidates.length<=128);assert.ok(result.observations.length<=512);assert.ok(result.diagnostics.length<=256);
}
const captured=[];
for(const [name,hash] of [['aave','7c1e57462ea9974bbb5486538d0cf2182a26af22455fdac8ef79ccca17724936'],['morpho','7b03ac36baeeaa7b666eb0485d39f33b96aa3919ca0ad8d63254bed8b418a0b8']]) {
  const bytes=await readFile(new URL(`../../../reports/standard-evm-api/${name}-response.json`,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);captured.push(JSON.parse(bytes));
}
const USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',ATOKEN='0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',POOL='0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const OUTER='0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b',INNER='0xbeef01735c132ada46aa9aa4c54623caa92a64cb',BLUE='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',FEE='0x255c7705e8bb334dfcae438197f7c4297988085a';

test('sealed Aave trace discovers four independent state queries without substituting emitted principal for values',()=>{
  const input={request:captured[0].request.transaction,trace:captured[0].execution.trace},snapshot=structuredClone(input),d=discoverTokenQueries(input),owner='0x48c16c5652add27eddb0f896748a35fc60b8d1b4';
  assert.equal(d.status,'discovered');assert.deepEqual(d.queries,[balance(ATOKEN,owner),balance(USDC,owner),allowance(USDC,owner,POOL),balance(USDC,ATOKEN)]);
  assert.equal(d.counts.frames,18);assert.equal(d.counts.logs,7);assert.equal(d.counts.candidates,4);assert.equal(d.counts.omitted,0);assert.equal(d.counts.complete,true);
  const event=d.observations.find(o=>o.kind==='approval_event'),spend=d.observations.find(o=>o.kind==='transfer_from_call');
  assert.equal(event.amountRaw,'3962903485');assert.equal(event.amountMeaning,'emitted_approval_value');
  assert.equal(spend.spender,POOL);assert.equal(spend.owner,owner);assert.equal(spend.submitter,owner);assert.equal(spend.amountMeaning,'requested_transfer_amount');
  assert.equal(event.provenance.storageAddress,USDC);assert.notEqual(event.provenance.codeAddress,USDC);assert.equal(event.provenance.messageSender,POOL);
  assert.equal(d.candidates.find(c=>c.kind==='allowance').observationIds.length,2);
  for(const c of d.candidates)for(const field of ['beforeRaw','afterRaw','deltaRaw','amountRaw'])assert.equal(c[field],undefined);
  assert.equal(d.scope.tokenIdentityVerified,false);assert.equal(d.scope.allEffectsCoverage,'inconclusive');assert.deepEqual(input,snapshot);
});

test('sealed Morpho trace retains eleven candidates, including call-only spending permissions and all three omitted pairs',()=>{
  const owner='0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668',d=discoverTokenQueries({request:captured[1].request.transaction,trace:captured[1].execution.trace});
  const expected=[balance(OUTER,owner),balance(USDC,owner),allowance(USDC,owner,OUTER),balance(OUTER,OUTER),balance(USDC,OUTER),balance(USDC,BLUE),balance(USDC,INNER),balance(INNER,FEE),balance(INNER,OUTER),allowance(USDC,OUTER,INNER),allowance(USDC,INNER,BLUE)];
  assert.equal(d.status,'discovered');assert.deepEqual(d.candidates.map(c=>c.query),expected);assert.deepEqual(d.queries,expected.slice(0,8));
  assert.equal(d.counts.candidates,11);assert.equal(d.counts.selected,8);assert.equal(d.counts.omitted,3);assert.equal(d.counts.complete,true);assert.equal(d.counts.truncated,false);
  assert.deepEqual(d.candidates.slice(8).map(c=>c.selection),Array(3).fill('omitted_query_limit'));
  const senderAllowance=d.candidates.find(c=>c.kind==='allowance'&&c.owner===owner);
  assert.equal(senderAllowance.observationIds.length,1);assert.equal(d.observations.find(o=>o.id===senderAllowance.observationIds[0]).kind,'transfer_from_call');
  assert.ok(d.observations.some(o=>o.kind==='transfer_from_call'&&o.owner===INNER&&o.spender===BLUE&&o.submitter===owner));
  assert.equal(d.candidates.some(c=>c.token===INNER&&c.account===owner),false,'Inner shares belong to the wrapper/fee recipient, not the external submitter.');
  assert.ok(d.observations.some(o=>o.token===INNER&&o.to===OUTER&&o.amountRaw==='305565121166487000888945'));
  assert.equal(d.candidates.some(c=>c.account===Z),false);
});

test('nested delegate storage context preserves true owner, immediate CALL spender and external submitter without duplicate implementation queries',()=>{
  const data=transferFrom(O,B,MAX),tokenCall=frame({from:T,to:R,input:data,output:word(0),calls:[frame({type:'DELEGATECALL',from:R,to:I,input:data,output:word(0)})]});
  const trace=frame({calls:[frame({type:'DELEGATECALL',from:T,to:I,calls:[tokenCall]})]}),d=run(trace);
  assert.equal(d.status,'discovered');assert.equal(d.observations.length,1);assert.equal(d.observations[0].kind,'transfer_from_call');
  assert.deepEqual([d.observations[0].owner,d.observations[0].spender,d.observations[0].recipient,d.observations[0].submitter],[O,T,B,S]);
  assert.equal(d.observations[0].amountRaw,MAX.toString());assert.equal(d.observations[0].returnEvidence,'false');assert.equal(d.observations[0].effectEstablished,false);
  assert.deepEqual(new Set(d.queries.map(key)),new Set([balance(R,O),balance(R,B),allowance(R,O,T)].map(key)));
  assert.ok(d.candidates.every(c=>c.token===R));
});

test('direct canonical calls without events retain hypotheses for empty, false, true and noncanonical returns',()=>{
  for(const [output,expected] of [['0x','empty'],[word(0),'false'],[word(1),'true'],[word(2),'noncanonical'],['0x01','noncanonical']]) {
    const d=run(frame({input:approve(R,MAX),output}));assert.equal(d.status,'discovered');assert.deepEqual(d.queries,[allowance(T,S,R)]);
    assert.equal(d.observations[0].returnEvidence,expected);assert.equal(d.observations[0].amountMeaning,'requested_allowance_value');assert.equal(d.observations[0].effectEstablished,false);
  }
  const direct=run(frame({input:transfer(R)}));assert.deepEqual(new Set(direct.queries.map(key)),new Set([balance(T,S),balance(T,R)].map(key)));
  const self=run(frame({input:transferFrom(S,S)}));assert.deepEqual(self.queries,[balance(T,S),allowance(T,S,S)]);assert.equal(self.candidates[0].observationIds.length,1);
  const burn=run(frame({input:transfer(Z),logs:[log(S,Z)]}));assert.deepEqual(burn.queries,[balance(T,S)]);assert.equal(burn.counts.zeroAddressCandidatesExcluded,2);
});

test('failed root, caught reverted ancestors and every static descendant exclude observations',()=>{
  const reverted=run(frame({input:transfer(R),logs:[log()],error:'execution reverted'}));
  assert.equal(reverted.status,'not_applicable');assert.equal(reverted.counts.complete,true);assert.deepEqual(reverted.queries,[]);assert.deepEqual(reverted.observations,[]);
  const child=frame({from:T,to:R,input:transfer(B),logs:[log(R,B,9n,R)],calls:[frame({from:R,to:I,input:approve(B)})]});
  const failed=structuredClone(child);failed.error='execution reverted';
  const staticChild=structuredClone(child);staticChild.type='STATICCALL';
  const d=run(frame({logs:[log(S,O)],calls:[failed,staticChild]}));
  assert.deepEqual(d.queries,[balance(T,S),balance(T,O)]);assert.equal(d.observations.length,1);assert.equal(d.counts.failedFrames,2);assert.equal(d.counts.staticFrames,2);
});

test('committed NFT-shaped events suppress ambiguous shared-selector call candidates only for that token',()=>{
  const nft={address:T,topics:[TRANSFER,word(S),word(R),word(99)],data:'0x'};
  const d=run(frame({input:transferFrom(S,R,99n),logs:[nft],calls:[frame({from:T,to:B,logs:[log(S,O,8n,B)]})]}));
  assert.deepEqual(d.queries,[balance(B,S),balance(B,O)]);assert.equal(d.counts.nftTransferLogs,1);
  assert.ok(d.diagnostics.some(x=>x.code==='NFT_SHAPED_EVENT_EXCLUDED'));assert.ok(d.diagnostics.some(x=>x.code==='NFT_CALL_AMBIGUITY'));assert.ok(d.candidates.every(c=>c.token!==T));
  const approval=run(frame({input:approve(R,99n),logs:[{...nft,topics:[APPROVAL,word(S),word(R),word(99)]}]}));assert.equal(approval.status,'none');assert.deepEqual(approval.queries,[]);
  assert.equal(run(frame({input:transferFrom(S,R),logs:[{...nft,data:'0X'}]})).status,'none','Hex letter case cannot bypass NFT ambiguity.');
  const caught=run(frame({input:transferFrom(S,R),calls:[frame({from:T,to:T,error:'execution reverted',logs:[nft]})]}));assert.equal(caught.status,'discovered');assert.equal(caught.counts.nftTransferLogs,0);
});

test('malformed known signatures are disclosed and excluded while unrelated canonical candidates survive',()=>{
  const malformed=[{...log(),data:'0x01'},{...log(),topics:[TRANSFER,word(S)]},{...log(),topics:[APPROVAL,'0x1'+'0'.repeat(23)+S.slice(2),word(R)]}];
  const d=run(frame({logs:[...malformed,log(S,B)]}));assert.equal(d.status,'discovered');assert.deepEqual(d.queries,[balance(T,S),balance(T,B)]);
  assert.equal(d.counts.malformedKnownSignatures,3);assert.equal(d.diagnostics.length,3);assert.ok(d.diagnostics.every(x=>x.code==='MALFORMED_ERC20_EVENT'));
  for(const input of [transfer(R)+'00',transfer(R).slice(0,-2),'0xa9059cbb'+'1'+transfer(R).slice(11),approve(R)+'00',transferFrom(S,R)+'00']) {
    const result=run(frame({input}));assert.equal(result.status,'none');assert.equal(result.counts.malformedKnownSignatures,1);assert.equal(result.diagnostics[0].code,'MALFORMED_ERC20_CALL');
  }
});

test('counterfeit cross-contract logs, wrong delegate callers and mutated contexts fail closed',()=>{
  for(const change of [
    t=>{t.logs[0].address=I;},t=>{t.calls[0].from=I;},t=>{t.calls[0].value='0x1';},t=>{t.calls[0].type='CALLCODE';},t=>{t.calls[0].logs=[log(S,R,7n,I)];},
  ]) {
    const trace=frame({logs:[log()],calls:[frame({type:'DELEGATECALL',from:T,to:I})]});change(trace);withheld(run(trace));
  }
  const trace=frame({calls:[frame({type:'DELEGATECALL',from:T,to:I,logs:[log()]})]});
  const d=run(trace);assert.equal(d.status,'discovered');assert.ok(d.candidates.every(c=>c.token===T));assert.equal(d.observations[0].provenance.messageSender,S);assert.equal(d.observations[0].provenance.frameFrom,T);
});

test('deterministic selection honors sender priorities and retains all bounded omitted candidates independently of event array order',()=>{
  const logs=[log(O,R),log(S,B),log(S,O,5n,T,APPROVAL),log(O,B,9n,T,APPROVAL),log(O,S)];
  const a=run(frame({logs}),{maxQueries:2}),b=run(frame({logs:[...logs].reverse()}),{maxQueries:2});
  assert.deepEqual(a.queries,[balance(T,S),allowance(T,S,O)]);assert.deepEqual(a.queries,b.queries);
  assert.equal(a.counts.candidates,6);assert.equal(a.counts.omitted,4);assert.equal(a.counts.complete,true);assert.equal(a.counts.truncated,false);
  assert.deepEqual(a.candidates.map(c=>[c.id,c.selection]),b.candidates.map(c=>[c.id,c.selection]));
  assert.ok(a.candidates.every(c=>c.observationIds.length>0));
});

test('empty and unknown-event traces never mean no assets or complete effects',()=>{
  for(const trace of [frame(),frame({logs:[{address:T,topics:[word(42)],data:'0x'}]})]) {
    const d=run(trace);assert.equal(d.status,'none');assert.equal(d.counts.complete,true);assert.equal(d.scope.noCandidatesMeansNoAssets,false);assert.equal(d.scope.allEffectsCoverage,'inconclusive');assert.match(d.reason,/does not establish/);
  }
});

test('strict root binding and hostile trace shapes never coerce fields or invoke accessors',()=>{
  const changes=[t=>{t.from=O;},t=>{t.to=R;},t=>{t.input='0x87654321';},t=>{t.value='0x1';},t=>{t.gas='0x4c4b3f';},t=>{t.gasUsed='0x4c4b41';},t=>{t.gasUsed='0x0';},t=>{delete t.input;},t=>{delete t.gasUsed;},t=>{t.error='';},t=>{t.revertReason={message:'private'};},t=>{t.extra=true;},t=>{t.logs[0].address=[T];},t=>{t.logs[0].topics[0]=[TRANSFER];},t=>{t.logs[0].removed=true;},t=>{t.logs[0].position='0x1';},t=>{t.calls={};},t=>{t.calls=null;},t=>{t.logs=null;},t=>{t.output=null;},t=>{t.value=null;},t=>{Object.setPrototypeOf(t.logs,{});},t=>{t.logs=[,log()];},t=>{t.logs[0].topics.push(word(3),word(4));},t=>{t.logs[0].data='0x1';}];
  const request={from:S,to:T,data:'0x12345678',value:'0x0',gas:'0x4c4b40'};
  for(const change of changes){const trace=frame({logs:[log()]});change(trace);withheld(discoverTokenQueries({request,trace}));}
  let invoked=false;const trace=frame();Object.defineProperty(trace,'to',{get(){invoked=true;throw new Error('PRIVATE_PROVIDER_MARKER');}});const d=discoverTokenQueries({request,trace});withheld(d);assert.equal(invoked,false);assert.equal(JSON.stringify(d).includes('PRIVATE_PROVIDER_MARKER'),false);
  const cycle=frame();cycle.calls=[cycle];withheld(discoverTokenQueries({request,trace:cycle}));
  const shared=frame({from:T,to:R});withheld(run(frame({calls:[shared,shared]})));
});

test('all hard discovery budgets withhold every query and label retained prefix incomplete',()=>{
  const cases=[];
  cases.push(frame({calls:Array.from({length:1000},()=>frame({from:T,to:R}))}));
  let deep=frame(),tail=deep;for(let i=0;i<33;i++){const child=frame({from:tail.to,to:T});tail.calls=[child];tail=child;}cases.push(deep);
  cases.push(frame({logs:Array.from({length:2001},()=>log())}));
  cases.push(frame({logs:Array.from({length:129},(_,i)=>log(Z,address(i+100)))}));
  cases.push(frame({logs:Array.from({length:513},()=>log(S,R))}));
  cases.push(frame({calls:Array.from({length:342},()=>frame({from:T,to:R,input:transferFrom(S,B)}))}));
  cases.push(frame({logs:Array.from({length:257},()=>({...log(),data:'0x01'}))}));
  cases.push(frame({output:'0x'+'00'.repeat(4*1024*1024+1)}));
  for(const trace of cases)withheld(run(trace),true);
  const prefix=run(cases[3]);assert.equal(prefix.candidates.length,128);assert.equal(prefix.counts.selected,0);assert.ok(prefix.observations.length>0);
  const references=run(cases[5]);assert.match(references.reason,/references/);assert.equal(references.candidates.reduce((n,c)=>n+c.observationIds.length,0),1024);
  assert.equal(Object.isFrozen(DISCOVERY_LIMITS),true);
});

test('invalid query limits and request envelopes cannot silently relax bounds',()=>{
  for(const maxQueries of [0,9,1.5,NaN,'8',null])withheld(run(frame(),{maxQueries}));
  for(const change of [{value:'1'},{gas:'0x0'},{gas:'0x4c4b41'},{from:[S]},{data:'0x1'},{stateOverrides:{}}]) {
    const request={from:S,to:T,data:'0x12345678',value:'0x0',gas:'0x4c4b40',...change};withheld(discoverTokenQueries({request,trace:frame()}));
  }
});
