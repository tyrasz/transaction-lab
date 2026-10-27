import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateUnsignedCall } from '../unsigned-call.js';

const a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),h=n=>'0x'+BigInt(n).toString(16),w=n=>BigInt(n).toString(16).padStart(64,'0');
const S=a(11),T=a(12),R=a(13),TOKEN=a(15),IMPL=a(16),PROBE=a(0xba1a);
const HEADER={hash:'0x'+w(90),parentHash:'0x'+w(89),mixHash:'0x'+w(91),miner:a(92),number:h(9000001),timestamp:h(1700000000),gasLimit:h(30000000),baseFeePerGas:h(17000000000)};
const words=[9000001,1700000000,30000000,0,91,92,1,89];
const frame=(from,to,value,extra={})=>({type:'CALL',from,to,value:h(value),input:'0x',output:'0x',gas:h(5000000),gasUsed:h(21000),...extra});
// Synthetic balances are independent from witness outputs; fault cases alter
// one source at a time. No fixture values are supplied to the production engine.
function fixture({value=100n,self=false,fresh=false,refund=0n,token=false,mutate}={}){
  const target=self?S:T,request={from:S,to:target,data:'0x',value:h(value),gas:h(5000000)};
  const initial={[S]:1000n,[T]:fresh?0n:500n,[R]:50n};
  const final={...initial,[S]:1000n-(self?0n:value)+refund};if(!self)final[T]=initial[T]+value-refund;
  const raw=frame(S,target,value);if(refund)raw.calls=[frame(T,S,refund)];
  const diff={pre:{[S]:{nonce:7,balance:h(initial[S])}},post:{[S]:{nonce:8,...(final[S]===initial[S]?{}:{balance:h(final[S])})}}};
  if(!self){if(!fresh)diff.pre[T]={balance:h(initial[T])};diff.post[T]={balance:h(final[T])};}
  const records=[];const rpc={async call(method,params){
    const call=method==='debug_traceCall'?params[0]:null,opt=method==='debug_traceCall'?params[2]:null;
    const after=Boolean(opt?.stateOverrides?.[S]);let result,stage=method;
    if(method==='eth_chainId')result='0x1';
    else if(method==='eth_getBlockByHash'||method==='eth_getBlockByNumber')result=structuredClone(HEADER);
    else if(method==='eth_getBalance')result=h(initial[params[0]]??0n);
    else if(method==='eth_getTransactionCount')result=params[0]===S?'0x7':'0x0';
    else if(method==='eth_getCode')result=params[0]===TOKEN?'0x6000':'0x';
    else if(call?.to===PROBE){
      const isDiff=opt.tracer==='prestateTracer';stage=`witness_${after?'after':'before'}_${isDiff?'diff':'trace'}`;
      if(isDiff)result={pre:{[S]:{nonce:after?8:7,balance:h(after?final[S]:initial[S])}},post:{[S]:{nonce:after?9:8}}};
      else{
        const accounts=[...opt.stateOverrides[PROBE].code.matchAll(/73([0-9a-f]{40})3161/g)].map(m=>'0x'+m[1]);
        result=frame(S,PROBE,0n,{gas:call.gas,output:'0x'+[...words,...accounts.map(account=>(after?final:initial)[account]??0n)].map(w).join('')});
      }
    }else if(call?.to===TOKEN){
      const isDiff=opt.tracer==='prestateTracer';stage=`token_${after?'after':'before'}_${isDiff?'diff':'trace'}`;
      result=isDiff?{pre:{[S]:{nonce:after?8:7,balance:h(after?final[S]:initial[S])}},post:{[S]:{nonce:after?9:8}}}:frame(S,TOKEN,0n,{input:call.data,gas:call.gas,output:'0x'+w(after?2:1)});
    }else if(call){stage=opt.tracer==='prestateTracer'?'original_diff':'original_trace';result=structuredClone(stage==='original_diff'?diff:raw);}
    else assert.fail('Unexpected method '+method);
    const replacement=mutate?.({method,params,stage,result,initial,final,raw,diff});if(replacement!==undefined)result=replacement;
    records.push({method,params:structuredClone(params),result:structuredClone(result)});return result;
  }};
  return {rpc,chainId:1,blockHash:HEADER.hash,request,...(token?{queries:[{to:TOKEN,data:'0x70a08231'+S.slice(2).padStart(64,'0')}]}:{}),records,initial,final};
}
const assertUnavailable=result=>{assert.equal(result.nativeEffects.status,'unavailable');for(const row of [...result.nativeEffects.measurements,...result.measurements])for(const field of ['beforeRaw','afterRaw','deltaRaw','basis'])assert.equal(row[field],undefined);};

test('positive wallet transfer measures exact before/after BALANCE outputs and passes the exact value',async()=>{
  const f=fixture(),r=await simulateUnsignedCall(f);
  assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.nativeEffects.status,'measured');
  assert.deepEqual(r.nativeEffects.measurements.map(x=>[x.account,x.beforeRaw,x.afterRaw,x.deltaRaw]),[[S,'1000','900','-100'],[T,'500','600','100']]);
  assert.deepEqual(r.nativeEffects.counts,{candidates:2,selected:2,omitted:0,measured:2});assert.equal(r.nativeEffects.feeScope,'excluded');
  const calls=f.records.filter(x=>x.method==='debug_traceCall'&&x.params[0].to===T);assert.equal(calls.length,2);assert.ok(calls.every(x=>x.params[0].value==='0x64'));
  assert.ok(r.nativeEffects.measurements.every(x=>x.queryEvidence.length===2&&x.anchorEvidenceId));
  assert.equal(r.accounting.rpcCalls,15);
});

test('self transfer is measured unchanged and does not invent a debit',async()=>{
  const r=await simulateUnsignedCall(fixture({self:true}));assert.equal(r.canonicalStatus,'verified',r.measurementFailure);
  assert.deepEqual(r.nativeEffects.measurements.map(x=>[x.account,x.beforeRaw,x.afterRaw,x.deltaRaw]),[[S,'1000','1000','0']]);
});

test('internal refund and token probes use the post-execution sender balance',async()=>{
  const f=fixture({refund:40n,token:true}),r=await simulateUnsignedCall(f);assert.equal(r.canonicalStatus,'verified',r.measurementFailure);
  assert.deepEqual(r.nativeEffects.measurements.map(x=>x.deltaRaw),['-60','60']);assert.equal(r.measurements[0].status,'measured');
  assert.equal(r.measurements[0].deltaRaw,'1');
  const bad=await simulateUnsignedCall(fixture({refund:40n,token:true,mutate:x=>{if(x.stage==='token_after_diff')x.result.pre[S].balance='0x3e8';}}));
  assert.equal(bad.nativeEffects.status,'measured');assert.equal(bad.measurements[0].status,'unavailable');assert.equal(bad.measurements[0].beforeRaw,undefined);
});

test('funding an empty code-free recipient requires pinned zero balance, nonce and code while preserving original diff',async()=>{
  const r=await simulateUnsignedCall(fixture({fresh:true}));assert.equal(r.canonicalStatus,'verified',r.measurementFailure);
  assert.equal(r.nativeEffects.measurements[1].beforeRaw,'0');assert.equal(r.nativeEffects.measurements[1].afterRaw,'100');
  assert.equal(r.stateDiff.pre[T],undefined);assert.equal(r.nativeEffects.stateNormalization.length,1);
  for(const method of ['eth_getBalance','eth_getCode','eth_getTransactionCount'])assert.ok(r.evidence.some(e=>e.method===method&&e.params[0]===T));
  for(const mutate of [
    x=>x.method==='eth_getBalance'&&x.params[0]===T?'0x1':undefined,
    x=>x.method==='eth_getTransactionCount'&&x.params[0]===T?'0x1':undefined,
    x=>x.method==='eth_getCode'&&x.params[0]===T?'0x6000':undefined,
    x=>{if(x.stage==='original_diff')x.result.post[T].nonce=1;},
  ])assertUnavailable(await simulateUnsignedCall(fixture({fresh:true,mutate})));
});

test('native shared failures remove all native and token values including late canonical changes',async()=>{
  for(const mutate of [
    x=>{if(x.stage==='original_trace')x.result.value='0x65';},
    x=>{if(x.stage==='original_diff')x.result.post[T].balance=h(601);},
    x=>x.method==='eth_getBalance'&&x.params[0]===T?h(501):undefined,
    x=>{if(x.stage==='witness_after_trace')x.result.output=x.result.output.slice(0,-64)+w(601);},
    x=>{if(x.stage==='witness_before_diff')x.result.post[S].balance=h(999);},
    x=>{if(x.stage==='witness_after_diff')x.result.pre[S].balance=h(1000);},
    x=>{if(x.method==='eth_getBlockByNumber')x.result.transactions=['0x'+w(999)];},
  ]){const r=await simulateUnsignedCall(fixture({token:true,mutate}));assert.equal(r.canonicalStatus,'unverified');assertUnavailable(r);}
});

test('explicit post zero is preserved, omitted pre zero is anchored and a nonzero omission fails',async()=>{
  const drained=await simulateUnsignedCall(fixture({value:1000n}));assert.equal(drained.canonicalStatus,'verified',drained.measurementFailure);assert.equal(drained.nativeEffects.measurements[0].afterRaw,'0');
  const omitted=await simulateUnsignedCall(fixture({fresh:true,mutate:x=>{if(x.stage==='original_diff')x.result.pre[T]={};}}));
  assert.equal(omitted.canonicalStatus,'verified',omitted.measurementFailure);assert.equal(omitted.nativeEffects.measurements[1].beforeRaw,'0');
  assertUnavailable(await simulateUnsignedCall(fixture({mutate:x=>{if(x.stage==='original_diff')delete x.result.pre[T].balance;}})));
});

test('original failure stays not applicable with no native amounts',async()=>{
  const r=await simulateUnsignedCall(fixture({mutate:x=>{if(x.stage==='original_trace')x.result.error='execution reverted';}}));
  assert.equal(r.canonicalStatus,'verified');assert.equal(r.nativeEffects.status,'not_applicable');assert.deepEqual(r.nativeEffects.measurements,[]);
});

test('automatic payable calls retain both native and discovered token measurements',async()=>{
  const r=await simulateUnsignedCall(fixture({mutate:x=>{
    if(x.stage==='original_trace')x.result.calls=[frame(T,TOKEN,0n,{logs:[{address:TOKEN,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+w(S),'0x'+w(T)],data:'0x'+w(1),position:'0x0'}]})];
  }}));
  assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.nativeEffects.status,'measured');
  assert.equal(r.discovery.queries.length,2,r.discovery.reason);assert.equal(r.measurements.length,2);assert.ok(r.measurements.every(row=>row.status==='measured'));
});

test('native selection cap preserves omitted accounts and still rejects their inconsistent state changes',async()=>{
  function fanout(x,bad){
    if(x.stage==='original_trace'){
      x.result.calls=Array.from({length:9},(_,i)=>frame(T,a(20+i),1n));x.final[T]=491n;x.diff.post[T].balance=h(491n);
      for(let i=20;i<29;i++){x.initial[a(i)]=0n;x.final[a(i)]=1n;x.diff.pre[a(i)]={balance:'0x0',nonce:1};x.diff.post[a(i)]={balance:'0x1'};}
    }
    if(bad&&x.stage==='original_diff')x.result.post[a(28)].balance='0x2';
  }
  const r=await simulateUnsignedCall(fixture({value:0n,mutate:x=>fanout(x,false)}));
  assert.equal(r.canonicalStatus,'verified',r.measurementFailure);assert.equal(r.nativeEffects.status,'partial');
  assert.deepEqual(r.nativeEffects.counts,{candidates:10,selected:8,omitted:2,measured:8});
  assert.deepEqual(r.nativeEffects.candidates.filter(c=>!c.selected).map(c=>c.account),[a(27),a(28)]);
  assert.equal(r.nativeEffects.measurements[0].deltaRaw,'-9');assert.ok(r.accounting.rpcCalls<=64);
  const bad=await simulateUnsignedCall(fixture({value:0n,mutate:x=>fanout(x,true)}));assertUnavailable(bad);assert.match(bad.measurementFailure,/committed CALL/);
});

test('missing native anchors cannot exhaust the budget and silently truncate the complete after-state',async()=>{
  const r=await simulateUnsignedCall(fixture({value:0n,mutate:x=>{
    if(x.stage==='original_trace'){
      x.result.gasUsed=h(2000000);x.result.calls=Array.from({length:60},(_,i)=>frame(T,a(100+i),1n));
      x.final[T]=440n;x.diff.post[T].balance=h(440n);
      for(let i=100;i<160;i++){x.initial[a(i)]=0n;x.final[a(i)]=1n;x.diff.pre[a(i)]={nonce:1};x.diff.post[a(i)]={balance:'0x1'};}
    }
  }}));
  assertUnavailable(r);assert.match(r.measurementFailure,/reserved RPC budget/);assert.ok(r.accounting.rpcCalls<64);
  assert.equal(r.nativeEffects.candidates.length,61);assert.equal(Object.keys(r.stateDiff.post).length,62);
  assert.equal(r.evidence.some(e=>e.method==='debug_traceCall'&&e.params[0].to===PROBE),false);
});


test('allowing a code-free transaction recipient does not allow it to become a selected token target',async()=>{
  const r=await simulateUnsignedCall(fixture({mutate:x=>{
    if(x.stage==='original_trace')x.result.logs=[{address:T,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+w(S),'0x'+w(T)],data:'0x'+w(1),position:'0x0'}];
  }}));
  assertUnavailable(r);assert.match(r.measurementFailure,/selected target/);
  assert.equal(r.evidence.some(e=>e.method==='debug_traceCall'&&e.params[0].data.startsWith('0x70a08231')),false);
});
