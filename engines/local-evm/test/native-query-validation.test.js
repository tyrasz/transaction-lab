import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreviewQueries, decodePreviewValues, nativeBalanceValues, PreviewQueryError } from '../preview-queries.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { feeFixture, TX_SENDER, TARGET } from './fee-fixture.js';
const account='0x'+'aB'.repeat(20),query={kind:'native_balance',account};
const compile=descriptor=>compilePreviewQueries([descriptor])[0];
const invalid=fn=>assert.throws(fn,PreviewQueryError);

test('native query is an immutable explicit account read with exact wei units, not ABI calldata',()=>{
  const c=compile(query);assert.deepEqual(c,{descriptor:{kind:'native_balance',account:account.toLowerCase()},query:null,
    identity:{kind:'native_balance',account:account.toLowerCase(),chainId:'1'},returnBytes:0,
    fields:[{name:'balance',bits:256,unit:{kind:'native_wei',scale:'1000000000000000000'}}]});
  assert(Object.isFrozen(c));assert(Object.isFrozen(c.fields[0].unit));
  for(const n of [0n,9007199254740993n,(1n<<256n)-1n])assert.deepEqual(nativeBalanceValues(JSON.parse(JSON.stringify(c)),n),
    [{name:'balance',raw:String(n),unit:{kind:'native_wei',scale:'1000000000000000000'}}]);
  for(const n of [-1n,1n<<256n,0,1,'0',null,undefined])invalid(()=>nativeBalanceValues(c,n));
  for(const bytes of ['0x','0x'+'00'.repeat(32)])invalid(()=>decodePreviewValues(c,bytes));
  const token=compile({to:account,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});invalid(()=>nativeBalanceValues(token,1n));
});
test('native identity cannot be widened with execution fields or duplicate normalized addresses',()=>{
  invalid(()=>compilePreviewQueries([query,{...query,account:account.toLowerCase()}]));
  for(const extra of [{to:TARGET},{data:'0x'},{chainId:1},{gas:'1000000'},{decimals:18},{stateOverrides:{}},{verified:true}])invalid(()=>compile({...query,...extra}));
  for(const bad of [{kind:'native_balance'}, {account}, {...query,account:'0x'}, {...query,account:1}, {...query,kind:'eth_balance'}])invalid(()=>compile(bad));
  const eight=Array.from({length:8},(_,i)=>({kind:'native_balance',account:'0x'+i.toString(16).padStart(40,'0')}));
  assert.equal(compilePreviewQueries(eight).length,8);invalid(()=>compilePreviewQueries([...eight,{kind:'native_balance',account:TARGET}]));
  const token={to:TARGET,data:'0x70a08231'+account.slice(2).toLowerCase().padStart(64,'0')};
  assert.equal(compilePreviewQueries([query,token]).length,2);
});
test('native compilation and formatting never execute supplied accessors or trust edited compiled metadata',()=>{
  let reads=0;
  for(const key of ['kind','account']){const value={...query};Object.defineProperty(value,key,{enumerable:true,get(){reads++;return query[key];}});invalid(()=>compile(value));}
  invalid(()=>compile(new Proxy(query,{get(){reads++;},getPrototypeOf(){reads++;}})));assert.equal(reads,0);
  for(const mutate of [c=>c.identity.account=TARGET,c=>c.fields[0].bits=512,c=>c.returnBytes=32,c=>c.query={to:TARGET,data:'0x'},c=>c.fields[0].unit.kind='token_raw_units']){
    const c=structuredClone(compile(query));mutate(c);invalid(()=>nativeBalanceValues(c,0n));
  }
});
test('native reads remain possible when the completed original exhausted its VM-step/frame allowance',async()=>{
  const f=await feeFixture({target:{nonce:1n,code:'0x00'}});delete f.request.executionProfile;delete f.request.fees;
  const queries=[{kind:'native_balance',account:TX_SENDER},{to:TARGET,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')}];
  const result=await executeEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries,limits:{steps:1,frames:1}});
  assert.equal(result.original.output.execution.status,'success');assert.equal(result.status,'partial');
  assert.equal(result.usage.executions,1);assert.equal(result.usage.steps,1);assert.equal(result.usage.frames,1);
  assert.equal(result.measurements[0].status,'measured');assert.equal(result.measurements[0].values[0].deltaRaw,'0');
  assert.equal(result.measurements[1].status,'not_attempted');assert.equal(result.scope.nativeEffectsMeasured,true);
});
