// Parent IPC and disposable-query controls for the narrowly admitted EIP-6780
// no-deletion behavior. Facts are synthetic authenticated MPT state.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const BENEFICIARY='0x4444444444444444444444444444444444444444';
const CHILD='0x5555555555555555555555555555555555555555';
const GETTER='0x6666666666666666666666666666666666666666';
const sd=address=>'73'+address.slice(2)+'ff';
const call=(address,delegate=false)=>'6000600060006000'+(delegate?'':'6000')+'73'+address.slice(2)+'61ffff'+(delegate?'f4':'f1');
const getter=address=>'0x'+call(address)+'50602a60005260206000f3';
const queries=[{to:GETTER,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}];
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc});
const preview=f=>executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries});
async function direct({beneficiary=BENEFICIARY,balance=1000n,code='0x'+sd(beneficiary),accounts={}}={}){
  return lifecycleFixture({code,accounts:{[FACTORY]:{nonce:7n,balance,code,storage:{[word(0)]:word(9)}},...accounts}});
}
async function mutateResult(t,f,mutate,isPreview=false){
  const fork=childProcess.fork;let changed=false;
  const mock=t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args),emit=child.emit;
    child.emit=function(event,...values){
      if(event==='message'&&typeof values[0]==='string'){
        const message=JSON.parse(values[0]);
        if(message.type==='result'){mutate(message.result);changed=true;values[0]=JSON.stringify(message);}
      }
      return emit.call(this,event,...values);
    };
    return child;
  });
  try{const result=await(isPreview?preview(f):run(f));assert.equal(changed,true);assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(isPreview?result.preview:result.output,null);}
  finally{mock.mock.restore();}
}

test('actual parent retains preexisting SELFDESTRUCT transfer without deletion or invented zero-value accounts',async()=>{
  const f=await direct(),result=await run(f);
  assert.equal(result.status,'completed');assert.equal(result.output.execution.status,'success');
  assert.equal(result.output.execution.gasRefundCounter,'0');
  assert.equal(result.inputs.accounts[FACTORY].code,'0x'+sd(BENEFICIARY));
  assert.deepEqual(result.changes.accounts.find(row=>row.address===FACTORY),{address:FACTORY,balance:{before:'0x3e8',after:'0x0'}});
  assert.deepEqual(result.changes.accounts.find(row=>row.address===BENEFICIARY),{address:BENEFICIARY,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:'0x3e8'}});
  for(const control of [await direct({beneficiary:FACTORY}),await direct({balance:0n})]){
    const r=await run(control);assert.equal(r.status,'completed');assert.equal(r.output.execution.status,'success');
    assert.deepEqual(r.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  }
});

test('parent rejects fabricated code/account deletion and forged beneficiary origin',async t=>{
  for(const mutate of [
    r=>{r.changes.accounts.find(row=>row.address===FACTORY).code={before:'0x'+sd(BENEFICIARY),after:'0x'};},
    r=>{r.changes.accounts.find(row=>row.address===FACTORY).existence={before:true,after:false,basis:'selfdestruct'};},
    r=>{r.changes.accounts.find(row=>row.address===BENEFICIARY).existence.basis='internal_contract_creation';},
    r=>{r.inputs.accounts[BENEFICIARY]={exists:true,nonce:'0',balance:'0',code:'0x',storage:{}};delete r.changes.accounts.find(row=>row.address===BENEFICIARY).existence;},
  ])await mutateResult(t,await direct(),mutate);
});

test('parent binds delegated SELFDESTRUCT to the proxy balance and preserves implementation state',async()=>{
  const f=await direct({code:'0x'+call(CHILD,true)+'5000',accounts:{[CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
  const result=await run(f);assert.equal(result.status,'completed');assert.equal(result.output.execution.status,'success');
  assert.equal(result.output.trace.calls[0].executionAddress,FACTORY);assert.equal(result.output.trace.calls[0].to,CHILD);
  assert.deepEqual(result.changes.accounts.find(row=>row.address===FACTORY),{address:FACTORY,balance:{before:'0x3e8',after:'0x0'}});
  assert.equal(result.changes.accounts.some(row=>row.address===CHILD),false);
  assert.equal(result.inputs.accounts[CHILD].balance,'17');
});

test('a root revert after successful SELFDESTRUCT cannot retain beneficiary funding',async t=>{
  const make=()=>direct({code:'0x'+call(CHILD)+'5060006000fd',accounts:{[CHILD]:{nonce:1n,balance:17n,code:'0x'+sd(BENEFICIARY)}}});
  const result=await run(await make());assert.equal(result.status,'completed');assert.equal(result.output.execution.status,'reverted');
  assert.equal(result.output.trace.calls[0].error,null);assert.deepEqual(result.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
  await mutateResult(t,await make(),r=>{r.changes.accounts.push({address:BENEFICIARY,existence:{before:false,after:true,basis:'positive_native_funding_of_proof_absent_account'},balance:{before:'0x0',after:'0x11'}});});
});

test('fresh getter self-beneficiary preserves original-created code while real transfers remain unmeasured',async t=>{
  const target=createdAddress();
  const make=beneficiary=>lifecycleFixture({code:factoryCode(initcode(sd(beneficiary),''),{value:5}),accounts:{[GETTER]:{nonce:1n,code:getter(target)}}});
  const self=await preview(await make(target));assert.equal(self.status,'completed');assert.equal(self.preview.status,'complete');
  const selfRow=self.preview.measurements[0];assert.equal(selfRow.status,'measured');assert.equal(selfRow.values[0].deltaRaw,'0');
  assert.equal(selfRow.after.output.trace.calls[0].error,null);
  assert.deepEqual(selfRow.after.changesBefore,self.preview.original.changes);
  assert.equal(self.preview.original.changes.accounts.find(row=>row.address===target).code.after,'0x'+sd(target));
  const transfer=await preview(await make(BENEFICIARY));assert.equal(transfer.status,'completed');assert.equal(transfer.preview.status,'partial');
  const row=transfer.preview.measurements[0];assert.equal(row.before.status,'measured');assert.equal(row.after.status,'unavailable');assert.equal(row.after.output.execution.status,'success');assert.equal(row.values,null);
  assert.equal(transfer.preview.original.changes.accounts.some(row=>row.address===BENEFICIARY),false);
  await mutateResult(t,await make(BENEFICIARY),r=>{
    const core=r.preview,m=core.measurements[0];
    core.status='complete';m.status='measured';m.reason=null;m.after.status='measured';m.after.reason=null;
    m.after.values=structuredClone(m.before.values);
    m.after.mutationValidation={status:'verified',scope:'net_changes_except_expected_query_sender_nonce'};
    m.values=m.before.values.map(v=>({name:v.name,beforeRaw:v.raw,afterRaw:v.raw,deltaRaw:'0',unit:v.unit}));
  },true);
});
