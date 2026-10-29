import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { feeFixture,TX_SENDER,TARGET,COINBASE } from './fee-fixture.js';
const queries=[TX_SENDER,TARGET,COINBASE].map(account=>({kind:'native_balance',account}));
async function resultFixture(){const f=await feeFixture({value:'19',target:{nonce:1n,balance:100n,code:'0x00'}});return f;}
function alterAmount(preview,index,phase,delta){
  const row=preview.measurements[index],old=BigInt(row[phase].values[0].raw),value=String(old+delta);
  row[phase].values[0].raw=value;row.values[0][phase+'Raw']=value;
  row.values[0].deltaRaw=String(BigInt(row.values[0].afterRaw)-BigInt(row.values[0].beforeRaw));
}

test('parent binds native rows to authentic initial proofs and exact validated poststate',async t=>{
  const attacks=[
    ['before amount',p=>alterAmount(p,0,'before',1n)],
    ['after amount',p=>alterAmount(p,1,'after',1n)],
    ['invented ABI execution',p=>p.measurements[0].before.output=structuredClone(p.original.output)],
    ['wrong read method',p=>p.measurements[0].after.readMethod='eth_getBalance'],
    ['different account read',p=>p.measurements[0].before.stateReads.reads[0].address=TARGET],
    ['missing read evidence',p=>delete p.measurements[0].before.inputEvidenceIds],
    ['query mutated nonce',p=>{const s=p.measurements[0].after; s.changesAfter.accounts.find(r=>r.address===TX_SENDER).nonce.after='0x3';}],
    ['changed before overlay',p=>{const s=p.measurements[0].before; s.changesBefore=structuredClone(p.original.changes);s.changesAfter=structuredClone(s.changesBefore);}],
    ['false native scope',p=>p.scope.nativeEffectsMeasured=false],
    ['invented complete coverage',p=>p.scope.nativeBalanceCoverage='all_accounts'],
    ['changed declared identity',p=>p.measurements[0].identity.account=TARGET],
    ['changed units',p=>{const r=p.measurements[0];for(const values of [r.values,r.before.values,r.after.values])values[0].unit.scale='1000000';}],
    ['omitted transfer deltas',p=>{
      for(const row of p.original.changes.accounts)delete row.balance;
      p.original.changes.accounts=p.original.changes.accounts.filter(r=>Object.keys(r).length>1);
      for(let i=0;i<p.measurements.length;i++){
        const m=p.measurements[i];m.after.changesBefore=structuredClone(p.original.changes);m.after.changesAfter=structuredClone(p.original.changes);
        m.after.values[0].raw=m.before.values[0].raw;m.values[0].afterRaw=m.values[0].beforeRaw;m.values[0].deltaRaw='0';
      }
    }],
  ];
  for(const [name,mutate] of attacks)await t.test(name,async sub=>{
    const f=await resultFixture();if(name==='omitted transfer deltas'){delete f.request.executionProfile;delete f.request.fees;}
    const fork=childProcess.fork;let intercepted=false;
    const mock=sub.mock.method(childProcess,'fork',(...args)=>{
      const child=fork(...args),emit=child.emit;
      child.emit=function(event,...values){
        if(event==='message'&&typeof values[0]==='string'){
          const message=JSON.parse(values[0]);
          if(message.type==='result'){
            assert.equal(message.result.preview.status,'complete');mutate(message.result.preview);intercepted=true;values[0]=JSON.stringify(message);
          }
        }return emit.call(this,event,...values);
      };return child;
    });
    try{
      const out=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries});
      assert(intercepted);assert.equal(out.status,'unavailable');assert.equal(out.error.code,'LOCAL_ISOLATED_PROTOCOL');assert.equal(out.preview,null);
    }finally{mock.mock.restore();}
  });
});

test('native cached proofs keep exact read provenance without charging query executions',async()=>{
  const f=await resultFixture(),out=await executeIsolatedEthereumPreview({request:f.request,header:f.header,rpc:f.rpc,queries});
  assert.equal(out.status,'completed',JSON.stringify(out.error));const p=out.preview;
  assert.equal(p.status,'complete');assert.equal(p.usage.executions,1);assert.equal(p.scope.queryGasScope,'CALL_only');
  for(const row of p.measurements)for(const side of [row.before,row.after]){
    assert.equal(side.output,null);assert.equal(side.readMethod,'proof_state_account_balance');assert.deepEqual(side.inputEvidenceIds,[]);
    assert.deepEqual(side.stateReads,{total:1,distinct:1,reads:[{kind:'account',address:row.descriptor.account}]});
    assert.deepEqual(side.changesBefore,side.changesAfter);assert.equal(side.mutationValidation,undefined);
  }
  assert.equal(p.measurements[1].values[0].beforeRaw,'100');assert.equal(p.measurements[1].values[0].afterRaw,'119');
});
