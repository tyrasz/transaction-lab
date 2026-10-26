import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { collectNativeEffects, NATIVE_EFFECT_LIMITS } from '../native-effects.js';
import { semanticTrace } from '../../../src/query-validation.js';
import { StateValidationError } from '../../../src/state.js';

const address = n => '0x'+BigInt(n).toString(16).padStart(40,'0');
const S=address(9),T=address(8),R=address(3),I=address(4),J=address(5),Z=address(0),MAX=(1n<<256n)-1n;
const empty = () => ({pre:{},post:{}});
function frame(extra={}) { return {type:'CALL',from:S,to:T,input:'0x',output:'0x',value:'0',gasUsed:'21000',error:null,revertReason:null,logs:[],calls:[],...extra}; }
function child(extra={}) { return frame({from:T,to:R,gasUsed:'100',...extra}); }
const run = (trace,diff=empty(),options) => collectNativeEffects(trace,diff,options);
const net = result => result.netValueByAccount;
const invalid = callback => assert.throws(callback,error => error instanceof StateValidationError && !error.message.includes('PRIVATE_PROVIDER_MARKER'));
const sealed = [];
for (const [name,hash] of [['aave','7c1e57462ea9974bbb5486538d0cf2182a26af22455fdac8ef79ccca17724936'],['morpho','7b03ac36baeeaa7b666eb0485d39f33b96aa3919ca0ad8d63254bed8b418a0b8']]) {
  const bytes=await readFile(new URL(`../../../reports/standard-evm-api/${name}-response.json`,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);sealed.push(JSON.parse(bytes));
}

test('sealed Aave and Morpho token deposits have no modeled native-value candidates',()=>{
  for (const response of sealed) {
    const trace=semanticTrace(response.execution.trace),diff=response.stateDiff,snapshot=structuredClone({trace,diff});
    const result=run(trace,diff);
    assert.equal(result.status,'complete');assert.equal(result.feeScope,'excluded');
    assert.deepEqual(result.candidates,[]);assert.deepEqual(result.selectedAccounts,[]);assert.deepEqual(net(result),{});
    assert.deepEqual(result.counts,{candidates:0,selected:0,omitted:0});assert.deepEqual({trace,diff},snapshot);
  }
});

test('positive root value is counted once with exact uint256 arithmetic, independent of logs or diff amounts',()=>{
  const amount='1000000000000000001',trace=frame({value:amount}),diff={pre:{[S]:{balance:'2000000000000000002'},[T]:{balance:'0'}},post:{[S]:{balance:amount},[T]:{balance:amount}}};
  const result=run(trace,diff);
  assert.deepEqual(net(result),{[S]:'-'+amount,[T]:amount});assert.deepEqual(result.selectedAccounts,[S,T]);
  assert.ok(result.candidates.every(candidate=>candidate.reason==='selected'&&candidate.selected));
  assert.deepEqual(net(run(frame({value:MAX.toString()}))),{[S]:(-MAX).toString(),[T]:MAX.toString()});
  const changed=structuredClone(diff);changed.post[T].balance='1';
  assert.deepEqual(net(run(trace,changed)),net(result),'The collector does not substitute reported balances for committed CALL flow.');
});

test('internal transfers, refunds and repeated recipients are accumulated without losing zero-net participants',()=>{
  const trace=frame({value:'20',calls:[child({value:'7',calls:[frame({from:R,to:S,value:'2'})]}),child({value:'3'}),child({to:I,value:'4'}),child({to:I,value:'0'})]});
  assert.deepEqual(net(run(trace)),{[S]:'-18',[T]:'6',[R]:'8',[I]:'4'});
  const returned=frame({value:'10',calls:[child({to:S,value:'10'})]});
  assert.deepEqual(net(run(returned)),{[S]:'0',[T]:'0'});
  assert.deepEqual(run(returned).selectedAccounts,[S,T]);
});

test('self-transfers cancel while positive root and internal participants remain candidates, including the zero address',()=>{
  const self=run(frame({to:S,value:'99'}));assert.deepEqual(net(self),{[S]:'0'});assert.deepEqual(self.counts,{candidates:1,selected:1,omitted:0});
  const nested=run(frame({calls:[child({to:T,value:'7'}),child({to:Z,value:'5'})]}));
  assert.deepEqual(net(nested),{[T]:'-5',[Z]:'5'});assert.deepEqual(nested.selectedAccounts,[T,Z]);
});

test('delegate inherited value never transfers to the implementation account and nested CALL uses storage context',()=>{
  const trace=frame({value:'10',calls:[child({type:'DELEGATECALL',to:I,value:'10',calls:[child({value:'4'})]})]});
  assert.deepEqual(net(run(trace)),{[S]:'-10',[T]:'6',[R]:'4'});assert.equal(Object.hasOwn(net(run(trace)),I),false);
  const bad=structuredClone(trace);bad.calls[0].calls[0].from=I;invalid(()=>run(bad));
  const inherited=structuredClone(trace);inherited.calls[0].value='0';invalid(()=>run(inherited));
});

test('CALLCODE keeps native/storage account while its explicit value becomes subsequent delegate context',()=>{
  const trace=frame({value:'10',calls:[child({type:'CALLCODE',to:I,value:'7',calls:[child({type:'DELEGATECALL',to:J,value:'7',calls:[child({value:'3'})]})]})]});
  assert.deepEqual(net(run(trace)),{[S]:'-10',[T]:'7',[R]:'3'});
  assert.equal(Object.hasOwn(net(run(trace)),I),false);assert.equal(Object.hasOwn(net(run(trace)),J),false);
  const bad=structuredClone(trace);bad.calls[0].calls[0].value='10';invalid(()=>run(bad));
});

test('root and caught ancestor reverts discard every nested native transfer, including successful descendants',()=>{
  const caught=child({value:'100',error:'execution reverted',calls:[frame({from:R,to:I,value:'80'})]});
  const trace=frame({value:'7',calls:[caught,child({value:'2'})]});assert.deepEqual(net(run(trace)),{[S]:'-7',[T]:'5',[R]:'2'});
  trace.error='execution reverted';assert.deepEqual(net(run(trace)),{});
  trace.error=null;trace.revertReason='bounded revert';assert.deepEqual(net(run(trace)),{});
  const malformed=structuredClone(trace);malformed.calls[0].calls[0].from=I;invalid(()=>run(malformed));
});

test('static ancestry rejects value transfer while allowing EIP-214 CALLCODE and inherited delegate value',()=>{
  const quiet=frame({calls:[child({type:'STATICCALL',calls:[frame({type:'DELEGATECALL',from:R,to:I,value:'0',calls:[frame({from:R,to:T,value:'0'})]})]})]});
  assert.deepEqual(net(run(quiet)),{});
  for (const type of ['CALL','DELEGATECALL']) {
    const bad=frame({calls:[child({type:'STATICCALL',error:'execution reverted',calls:[frame({type,from:R,to:I,value:'1'})]})]});invalid(()=>run(bad));
  }
  invalid(()=>run(frame({calls:[child({type:'STATICCALL',value:'1'})]})));
  const exception=frame({calls:[child({type:'STATICCALL',calls:[frame({type:'CALLCODE',from:R,to:I,value:'1',calls:[frame({type:'DELEGATECALL',from:R,to:J,value:'1'})]})]})]});
  assert.deepEqual(net(run(exception)),{},'CALLCODE value and inherited delegate value do not move native funds.');
  exception.calls[0].calls[0].calls[0].calls=[frame({from:R,to:S,value:'1'})];invalid(()=>run(exception));
});

test('explicit post balances discover unmatched state changes and missing initial fields without guessing zero',()=>{
  const diff={pre:{[S]:{nonce:'1',balance:'8'},[T]:{balance:'7'},[R]:{},[I]:{balance:'0'},[J]:{balance:'9'}},post:{[S]:{nonce:'2'},[T]:{balance:'7'},[R]:{balance:'0'},[I]:{balance:'5'},[J]:{balance:'0'},[Z]:{balance:'2'}}};
  const result=run(frame(),diff);
  assert.deepEqual(result.selectedAccounts,[Z,R,I,J]);assert.deepEqual(net(result),{[Z]:'0',[R]:'0',[I]:'0',[J]:'0'});
  assert.equal(Object.hasOwn(net(result),S),false,'Omitted post balance is unchanged.');
  assert.equal(Object.hasOwn(net(result),T),false,'Explicit equal balances do not imply native movement.');
  assert.equal(result.candidates.find(candidate=>candidate.account===J).netValueRaw,'0','A balance diff is not converted into an observed CALL.');
});

test('selection ranks sender then original recipient then lexical while retaining all omitted flow and diff accounts',()=>{
  const recipients=Array.from({length:10},(_,i)=>address(100-i));
  const trace=frame({value:'10',calls:recipients.map(to=>child({to,value:'1'}))});
  const result=run(trace,empty(),{maxAccounts:3});
  assert.deepEqual(result.selectedAccounts,[S,T,...recipients.toSorted().slice(0,1)]);
  assert.equal(result.counts.candidates,12);assert.equal(result.counts.selected,3);assert.equal(result.counts.omitted,9);
  assert.ok(result.candidates.slice(3).every(candidate=>candidate.selected===false&&candidate.reason==='account-limit'));
  assert.equal(Object.keys(net(result)).length,12);assert.equal(net(result)[T],'0');
  const noQueries=run(trace,empty(),{maxAccounts:0});assert.deepEqual(noQueries.selectedAccounts,[]);assert.deepEqual(net(noQueries),net(result));assert.equal(noQueries.counts.omitted,12);
});

test('every lifecycle or unknown context is rejected even under a reverted ancestor',()=>{
  for (const type of ['CREATE','CREATE2','SELFDESTRUCT','AUTHCALL','call']) invalid(()=>run(frame({error:'execution reverted',calls:[child({type})]})));
  for (const type of ['STATICCALL','DELEGATECALL','CALLCODE']) invalid(()=>run(frame({type})));
  invalid(()=>run(frame({calls:[child({from:S})]})));
});

test('normalized frame schema rejects coercions, omitted fields, malformed errors and noncanonical values safely',()=>{
  for (const field of ['type','from','to','input','output','value','gasUsed','error','revertReason','calls','logs']) { const bad=frame();delete bad[field];invalid(()=>run(bad)); }
  for (const value of ['01','0x1','-1','1.0',1,(MAX+1n).toString(),['1']]) invalid(()=>run(frame({value})));
  for (const extra of [{gas:'0x4c4b40'},{from:[S]},{input:['0x']},{gasUsed:'0'},{error:''},{error:{message:'PRIVATE_PROVIDER_MARKER'}},{revertReason:undefined},{calls:null},{logs:{}}]) invalid(()=>run(frame(extra)));
  const getter=frame();Object.defineProperty(getter,'value',{enumerable:true,get(){throw new Error('PRIVATE_PROVIDER_MARKER');}});invalid(()=>run(getter));
  const repeated=child();invalid(()=>run(frame({calls:[repeated,repeated]})));
  const cycle=frame();cycle.calls.push(cycle);invalid(()=>run(cycle));
  const sparse=frame();sparse.calls.length=1;invalid(()=>run(sparse));
});

test('event evidence is validated for context and bounds but cannot create or price native effects',()=>{
  const log={address:T,topics:[],data:'0x',position:'0'};
  assert.deepEqual(net(run(frame({logs:[log]}))),{});
  for (const invalidLog of [{...log,address:I},{...log,position:'1'},{...log,topics:[['0x'+'0'.repeat(64)]]},{...log,data:'0x0'},{...log,index:'00'},{...log,removed:false}]) invalid(()=>run(frame({logs:[invalidLog]})));
  const context=frame({calls:[child({type:'DELEGATECALL',to:I,logs:[log]})]});assert.deepEqual(net(run(context)),{});
  context.calls[0].logs[0].address=I;invalid(()=>run(context));
});

test('candidate, frame, depth, log and text limits fail closed without truncation',()=>{
  assert.equal(run(frame({calls:Array.from({length:127},(_,i)=>child({to:address(100+i),value:'1'}))})).counts.candidates,128);
  invalid(()=>run(frame({calls:Array.from({length:128},(_,i)=>child({to:address(100+i),value:'1'}))})));
  assert.equal(run(frame({calls:Array.from({length:999},()=>child())})).status,'complete');
  invalid(()=>run(frame({calls:Array.from({length:1000},()=>child())})));
  function chain(depth) { const root=frame();let current=root;for(let i=0;i<depth;i++){const next=child({from:current.to,to:address(100+i)});current.calls.push(next);current=next;}return root; }
  assert.equal(run(chain(32)).status,'complete');invalid(()=>run(chain(33)));
  const logs=Array.from({length:2000},()=>({address:T,topics:[],data:'0x'}));assert.equal(run(frame({logs})).status,'complete');
  invalid(()=>run(frame({logs:[...logs,{address:T,topics:[],data:'0x'}]})));
  invalid(()=>run(frame({input:'0x'+'00'.repeat(NATIVE_EFFECT_LIMITS.maxStringBytes/2)})));
  for(const maxAccounts of [-1,9,1.5,'8',null])invalid(()=>run(frame(),empty(),{maxAccounts}));
});

test('diff schema and collisions are rejected without invoking untrusted accessors or echoing provider text',()=>{
  invalid(()=>run(frame(),{pre:{},post:{},error:'PRIVATE_PROVIDER_MARKER'}));
  const mixed='0x'+'a'.repeat(40),upper='0x'+'A'.repeat(40);invalid(()=>run(frame(),{pre:{[mixed]:{},[upper]:{}},post:{}}));
  invalid(()=>run(frame(),{pre:{[S]:{balance:'-1'}},post:{}}));
  invalid(()=>run(frame(),{pre:{},post:{[S]:{unknown:'PRIVATE_PROVIDER_MARKER'}}}));
  const diff=empty();Object.defineProperty(diff.post,S,{enumerable:true,get(){throw new Error('PRIVATE_PROVIDER_MARKER');}});invalid(()=>run(frame(),diff));
});
