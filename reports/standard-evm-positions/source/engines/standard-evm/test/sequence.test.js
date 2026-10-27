import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateUnsignedCall, simulateUnsignedSequence, SEQUENCE_LIMITS } from '../unsigned-call.js';

const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0'),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),hex=n=>'0x'+BigInt(n).toString(16);
const S=addr(11),TOKEN=addr(21),POOL=addr(31),RECEIPT=addr(41),RECIPIENT=addr(51),PROBE=addr(0xba1a),BLOCK=word(90);
const ALLOW=word(1),BAL=word(2),SHARES=word(3);
const HEADER={hash:BLOCK,parentHash:word(89),mixHash:word(91),miner:addr(92),number:hex(9000001),timestamp:hex(1700000000),gasLimit:hex(30000000),baseFeePerGas:hex(17000000000)};
const balanceOf=a=>'0x70a08231'+word(a).slice(2),allowance='0xdd62ed3e'+word(S).slice(2)+word(POOL).slice(2);
const QUERIES=[{to:TOKEN,data:balanceOf(S)},{to:TOKEN,data:allowance},{to:RECEIPT,data:balanceOf(S)}];
const input=(to,data,value='0x0')=>({request:{from:S,to,data,value,gas:'0x4c4b40'},queries:structuredClone(QUERIES)});
const approve=n=>input(TOKEN,'0x095ea7b3'+word(POOL).slice(2)+word(n).slice(2));
const deposit=input(POOL,'0x617ba037'+word(TOKEN).slice(2)+word(50).slice(2)+word(S).slice(2)+word(0).slice(2));
const native=n=>input(RECIPIENT,'0x',hex(n));

// Deliberately synthetic RPC control. Original transaction state transitions
// are distinct from queries; every request derives its own isolated state from
// the pinned baseline plus the exact overrides supplied on that request.
function harness({mutate,failDeposit=false}={}){
  const records=[];
  function base(){return {nonce:7n,native:1000000n,recipient:0n,allowance:0n,balance:100n,shares:0n};}
  const rpc={async call(method,params){
    const record={method,params:structuredClone(params)};records.push(record);let result,stage=method;
    if(method==='eth_chainId')result='0x1';
    else if(method==='eth_getBlockByHash'||method==='eth_getBlockByNumber')result=structuredClone(HEADER);
    else if(method==='eth_getTransactionCount')result=params[0]===S?'0x7':'0x0';
    else if(method==='eth_getBalance')result=params[0]===S?hex(1000000):'0x0';
    else if(method==='eth_getCode')result=[S,PROBE,RECIPIENT].includes(params[0])?'0x':'0x60006000f3';
    else if(method==='debug_traceCall'){
      const [call,,options]=params,st=base(),overrides=options.stateOverrides??{},diff=options.tracer==='prestateTracer';
      if(overrides[S]?.nonce!==undefined)st.nonce=BigInt(overrides[S].nonce);
      if(overrides[S]?.balance!==undefined)st.native=BigInt(overrides[S].balance);
      if(overrides[RECIPIENT]?.balance!==undefined)st.recipient=BigInt(overrides[RECIPIENT].balance);
      if(overrides[TOKEN]?.stateDiff?.[ALLOW]!==undefined)st.allowance=BigInt(overrides[TOKEN].stateDiff[ALLOW]);
      if(overrides[TOKEN]?.stateDiff?.[BAL]!==undefined)st.balance=BigInt(overrides[TOKEN].stateDiff[BAL]);
      if(overrides[RECEIPT]?.stateDiff?.[SHARES]!==undefined)st.shares=BigInt(overrides[RECEIPT].stateDiff[SHARES]);
      const frame={type:'CALL',from:call.from,to:call.to,input:call.data,value:call.value,gas:call.gas,gasUsed:'0x5208',output:'0x'};
      const senderDiff=()=>({pre:{[S]:{nonce:Number(st.nonce),balance:hex(st.native)}},post:{[S]:{nonce:Number(st.nonce+1n)}}});
      if(call.to===PROBE){
        stage='witness';
        const accounts=[...overrides[PROBE].code.matchAll(/73([0-9a-f]{40})3161/g)].map(match=>'0x'+match[1]);
        const values=[9000001,1700000000,30000000,0,HEADER.mixHash,HEADER.miner,1,HEADER.parentHash,...accounts.map(a=>a===S?st.native:a===RECIPIENT?st.recipient:0n)];
        result=diff?senderDiff():{...frame,output:'0x'+values.map(n=>word(n).slice(2)).join('')};
      }else if(call.data.startsWith('0x70a08231')||call.data===allowance){
        stage=diff?'query_diff':'query_trace';
        const value=call.data===allowance?st.allowance:call.to===RECEIPT?st.shares:st.balance;
        result=diff?senderDiff():{...frame,output:word(value)};
      }else if(call.data.startsWith('0x095ea7b3')){
        stage=diff?'approval_diff':'approval_trace';const amount=BigInt('0x'+call.data.slice(74));
        result=diff?senderDiff():{...frame,output:word(1)};
        if(diff){result.pre[TOKEN]={storage:{[ALLOW]:word(st.allowance)}};result.post[TOKEN]={storage:{[ALLOW]:word(amount)}};}
      }else if(call.to===POOL){
        stage=diff?'deposit_diff':'deposit_trace';
        if(st.allowance<50n||st.balance<50n||failDeposit)result={...frame,error:'execution reverted',revertReason:'insufficient allowance or balance'};
        else if(diff){
          result=senderDiff();result.pre[TOKEN]={storage:{[ALLOW]:word(st.allowance),[BAL]:word(st.balance)}};
          result.post[TOKEN]={storage:{[BAL]:word(st.balance-50n)}};
          result.pre[RECEIPT]={storage:{[SHARES]:word(st.shares)}};result.post[RECEIPT]={storage:{[SHARES]:word(st.shares+49n)}};
        }else result=frame;
      }else if(call.to===RECIPIENT){
        stage=diff?'native_diff':'native_trace';const value=BigInt(call.value);
        if(value>st.native)result={...frame,error:'insufficient funds'};
        else if(diff){result=senderDiff();result.post[S].balance=hex(st.native-value);result.pre[RECIPIENT]={balance:hex(st.recipient)};result.post[RECIPIENT]={balance:hex(st.recipient+value)};}
        else result=frame;
      }else assert.fail('Unexpected call '+call.to+' '+call.data);
    }else assert.fail('Unexpected method '+method);
    const changed=mutate?.({method,params,stage,result,records});if(changed!==undefined)result=changed;
    record.result=structuredClone(result);return result;
  }};
  return {rpc,records,chainId:1,blockHash:BLOCK,calls:[approve(50),structuredClone(deposit)]};
}
const run=h=>simulateUnsignedSequence(h);
const values=result=>result.measurements.map(m=>[m.beforeRaw,m.afterRaw,m.deltaRaw]);

test('approval state feeds deposit, retains step allowances and measures receipt shares separately',async()=>{
  const independent=harness();const without=await simulateUnsignedCall({...independent,...deposit});
  assert.equal(without.execution.status,'reverted_or_failed');
  const h=harness(),result=await run(h);
  assert.equal(result.canonicalStatus,'verified');assert.equal(result.sequence.status,'completed');assert.equal(result.sequence.completedSteps,2);
  assert.deepEqual(values(result.steps[0].result),[['100','100','0'],['0','50','50'],['0','0','0']]);
  assert.deepEqual(values(result.steps[1].result),[['100','50','-50'],['50','0','-50'],['0','49','49']]);
  assert.deepEqual(result.steps[1].stateSource,{kind:'after_step',stepIndex:0});
  const start=result.steps[1].result.startingState;
  assert.equal(start.priorCalls,1);assert.equal(start.overrides[S].nonce,'0x8');assert.equal(start.overrides[TOKEN].stateDiff[ALLOW],word(50));
  assert.deepEqual(start.basicStateReads[0],{account:S,field:'nonce',pinnedEvidenceId:3,pinnedRaw:'7',startingRaw:'8',basis:'validated_previous_state_override'});
  assert.ok(start.overlapChecks.some(row=>row.account===TOKEN&&row.slot===ALLOW&&row.expectedRaw===word(50)));
  const depositCalls=h.records.filter(r=>r.method==='debug_traceCall'&&r.params[0].to===POOL);
  assert.equal(depositCalls.length,2);for(const r of depositCalls)assert.deepEqual(r.params[2].stateOverrides,start.overrides);
  assert.equal(h.records.filter(r=>r.method==='eth_getBlockByNumber').length,3);
  assert.equal(result.accounting.rpcCalls,h.records.length);assert.equal(result.scope.atomic,false);
});

test('three calls retain spent zero allowance and untouched balances while approving anew',async()=>{
  const h=harness();h.calls.push(approve(25));const result=await run(h);
  assert.equal(result.sequence.status,'completed');assert.deepEqual(values(result.steps[2].result),[['50','50','0'],['0','25','25'],['49','49','0']]);
  const carried=result.steps[2].result.startingState.overrides;
  assert.equal(carried[TOKEN].stateDiff[ALLOW],word(0));assert.equal(carried[TOKEN].stateDiff[BAL],word(50));assert.equal(carried[RECEIPT].stateDiff[SHARES],word(49));assert.equal(carried[S].nonce,'0x9');
});

test('four calls advance only original nonces; private continuation cannot exceed the four-call cap',async()=>{
  const h=harness();h.calls=[approve(50),structuredClone(deposit),approve(25),approve(0)];
  const result=await run(h);assert.equal(result.sequence.status,'completed');assert.equal(result.sequence.completedSteps,4);
  assert.equal(result.steps[3].result.startingState.overrides[S].nonce,'0xa');
  assert.deepEqual(values(result.steps[3].result),[['50','50','0'],['25','0','-25'],['49','49','0']]);
  const separate=harness();let previous;
  for(let i=0;i<4;i++)previous=await simulateUnsignedCall({...separate,...approve(i),...(previous?{previous}:{})});
  const before=separate.records.length,fifth=await simulateUnsignedCall({...separate,...approve(5),previous});
  assert.equal(fifth.execution.status,'unavailable');assert.equal(separate.records.length,before);
});

test('an invalid isolated query cannot invent a value or prevent carrying valid original state',async()=>{
  let broken=false;const h=harness({mutate:x=>{
    if(!broken&&x.stage==='query_trace'&&x.params[0].to===RECEIPT){broken=true;x.result.output='0x01';}
  }}),result=await run(h);
  assert.equal(result.sequence.status,'completed');assert.equal(result.canonicalStatus,'verified');
  assert.equal(result.steps[0].result.measurements[2].status,'unavailable');assert.equal(result.steps[0].result.measurements[2].beforeRaw,undefined);
  assert.deepEqual(values(result.steps[1].result),[['100','50','-50'],['50','0','-50'],['0','49','49']]);
});

test('native starting balances carry actual prior effects while pinned read provenance stays explicit',async()=>{
  const h=harness();h.calls=[native(60),native(40)];const result=await run(h);
  assert.equal(result.sequence.status,'completed');
  const rows=result.steps[1].result.nativeEffects.measurements;
  const sender=rows.find(r=>r.account===S),recipient=rows.find(r=>r.account===RECIPIENT);
  assert.deepEqual([sender.beforeRaw,sender.afterRaw,sender.deltaRaw],['999940','999900','-40']);
  assert.deepEqual([recipient.beforeRaw,recipient.afterRaw],['60','100']);
  assert.equal(sender.startingBalance.pinnedRaw,'1000000');assert.equal(sender.startingBalance.startingRaw,'999940');
  assert.equal(recipient.startingBalance.pinnedRaw,'0');assert.equal(recipient.startingBalance.basis,'validated_previous_state_override');
  const evidence=result.steps[1].result.evidence;assert.equal(evidence[sender.anchorEvidenceId-1].result,hex(1000000));
});

test('revert stops later calls without rolling back the earlier approval',async()=>{
  const h=harness({failDeposit:true});h.calls.push(approve(0));const result=await run(h);
  assert.equal(result.canonicalStatus,'verified');assert.equal(result.sequence.status,'stopped');assert.equal(result.sequence.completedSteps,1);assert.equal(result.sequence.attemptedSteps,2);
  assert.deepEqual(result.steps.map(s=>s.status),['completed','reverted_or_failed','skipped']);assert.equal(result.steps[2].result,undefined);
  assert.deepEqual(values(result.steps[0].result)[1],['0','50','50']);
  assert.equal(h.records.filter(r=>r.method==='debug_traceCall'&&r.params[0].data.startsWith('0x095ea7b3')&&r.params[2].tracer==='callTracer').length,1);
});

test('final shared header change invalidates all earlier amounts',async()=>{
  let rechecks=0;const h=harness({mutate:x=>{if(x.method==='eth_getBlockByNumber'&&++rechecks===3)x.result.hash=word(999);}}),result=await run(h);
  assert.equal(result.canonicalStatus,'unverified');assert.equal(result.sequence.status,'unavailable');assert.equal(result.sequence.completedSteps,0);
  for(const step of result.steps){assert.equal(step.status,'unavailable');for(const row of step.result.measurements){assert.equal(row.status,'unavailable');assert.equal(row.beforeRaw,undefined);assert.equal(row.afterRaw,undefined);assert.equal(row.deltaRaw,undefined);}}
});

test('provider ignoring carried prestate is rejected instead of reporting an independent deposit',async()=>{
  const h=harness({mutate:x=>{if(x.stage==='deposit_diff')x.result.pre[TOKEN].storage[ALLOW]=word(0);}}),result=await run(h);
  assert.equal(result.sequence.status,'unavailable');assert.equal(result.steps[1].status,'unavailable');assert.equal(result.canonicalStatus,'unverified');
  assert.ok(result.steps[1].result.measurementFailure);assert.ok(result.steps[1].result.measurements.every(r=>r.status==='unavailable'));
});

test('same hash with changed source contents cannot start a continuation',async()=>{
  let reads=0;const h=harness({mutate:x=>{if(x.method==='eth_getBlockByHash'&&++reads===2)x.result.stateRoot=word(999);}}),result=await run(h);
  assert.equal(result.sequence.status,'unavailable');assert.equal(result.canonicalStatus,'unverified');
  assert.match(result.steps[1].result.measurementFailure,/header or block contents differ/);
  assert.equal(h.records.filter(r=>r.method==='debug_traceCall'&&r.params[0].to===POOL).length,0);
});

test('all sequence inputs validate before RPC, including later calls and queries',async()=>{
  for(const change of [h=>h.calls.pop(),h=>h.calls.push(approve(1),approve(2),approve(3)),h=>h.calls[1].request.from=addr(999),h=>h.calls[1].queries=[],h=>h.calls[1].request.stateOverrides={},h=>h.calls[1].queries=[{to:PROBE,data:balanceOf(S)}],h=>h.calls[1].previous={}]){
    const h=harness();change(h);await assert.rejects(run(h));assert.equal(h.records.length,0);
  }
});

test('continuation refuses serialized, mutated, failed or cross-context predecessors without RPC',async()=>{
  for(const variant of ['clone','mutate','sender','block','failed']){
    const h=harness();const first=await simulateUnsignedCall({...h,...(variant==='failed'?deposit:approve(50))});
    let previous=variant==='clone'?structuredClone(first):first;if(variant==='mutate')first.measurements[0].afterRaw='999';
    const next={...h,...deposit,previous};if(variant==='sender')next.request={...next.request,from:addr(123)};if(variant==='block')next.blockHash=word(123);
    const before=h.records.length,result=await simulateUnsignedCall(next);assert.equal(result.execution.status,'unavailable');assert.equal(result.canonicalStatus,'unverified');assert.equal(h.records.length,before);
  }
});

test('sequence uses a shared scheduling budget and retains skipped steps on exhaustion',async()=>{
  const h=harness();let tick=0;h.now=()=>++tick<100?0:SEQUENCE_LIMITS.wallMs+1;const result=await run(h);
  assert.equal(result.sequence.status,'unavailable');assert.equal(result.canonicalStatus,'unverified');assert.ok(result.accounting.rpcCalls<=SEQUENCE_LIMITS.rpc);
  for(const step of result.steps)if(step.result)assert.ok(step.result.measurements.every(row=>row.beforeRaw===undefined));
});
