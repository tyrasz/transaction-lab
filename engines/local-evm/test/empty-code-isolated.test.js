// Authenticated synthetic state and real isolated workers only. No public RPC,
// expected poststate, code substitution or independent-client accuracy claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { amsterdamExecutionFixture, TX_SENDER, TARGET, COINBASE, word } from './amsterdam-execution-fixture.js';

const CHAIN=11155111, UNIT={kind:'native_wei',scale:'1000000000000000000'};
const native=account=>({kind:'native_balance',account});
function transport(f,{contractCode='forbidden'}={}) {
  const calls=[],violations=[];
  return {calls,violations,rpc:{async call(method,params){
    calls.push({method,params:structuredClone(params)});
    try {
      assert.deepEqual(params.at(-1),{blockHash:f.header.hash,requireCanonical:true});
      assert(['eth_getProof','eth_getCode'].includes(method));
      if(method==='eth_getCode') {
        assert.notEqual(contractCode,'forbidden','A proof-derived empty account must not dispatch eth_getCode');
        assert.equal(params[0],TARGET,'Only the nonempty contract may require real code');
        if(contractCode==='missing')throw Error('synthetic required code unavailable');
        if(contractCode==='corrupt')return '0x00';
      }
      return await f.rpc.call(method,params);
    } catch(error) {
      if(error.code==='ERR_ASSERTION')violations.push(error.message);
      throw error;
    }
  }}};
}
async function run(f,p,accounts=[TX_SENDER,TARGET]) {
  const r=await executeIsolatedEthereumPreview({chainId:CHAIN,request:f.request,header:f.header,rpc:p.rpc,queries:accounts.map(native)});
  assert.deepEqual(p.violations,[],'Transport assertion failures must not be swallowed by the worker');
  assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.isolation.processClosed,true);assert.equal(r.isolation.exitCode,0);
  assert.equal(r.isolation.processSeparated,true);assert.notEqual(r.isolation.childPid,process.pid);assert.equal(r.broker.pendingAtReturn,0);
  assert.equal(r.broker.calls,p.calls.length);assert.equal(r.preview.inputEvidence.length,p.calls.length);
  for(const [i,e] of r.preview.inputEvidence.entries())assert.deepEqual(e.request,p.calls[i]);
  return r.preview;
}
function amount(row,address,before,after,changes) {
  assert.equal(row.status,'measured');assert.deepEqual(row.identity,{kind:'native_balance',account:address,chainId:String(CHAIN)});
  assert.deepEqual(row.descriptor,native(address));assert.equal(row.query,null);assert.equal(row.returnBytes,0);
  assert.deepEqual(row.values,[{name:'balance',beforeRaw:String(before),afterRaw:String(after),deltaRaw:String(after-before),unit:UNIT}]);
  for(const [name,raw] of [['before',before],['after',after]]){
    assert.equal(row[name].readMethod,'proof_state_account_balance');assert.equal(row[name].output,null);
    assert.deepEqual(row[name].values,[{name:'balance',raw:String(raw),unit:UNIT}]);
    assert.deepEqual(row[name].changesBefore,row[name].changesAfter);
    assert.deepEqual(row[name].changesBefore.accounts,name==='before'?[]:changes.accounts);
  }
}
function derived(p,address,kind) {
  const row=p.inputs.provenance.find(x=>x.account===address);assert(row);
  assert.equal(row.codeEvidenceId,null);assert.equal(row.codeDerivation,kind);
  const proof=p.inputEvidence.find(e=>e.id===row.proofEvidenceId);assert.equal(proof.request.method,'eth_getProof');assert.equal(proof.verification,'verified');
}

test('actual Sepolia native previews use only proven-empty or exclusion proofs, with exact priced/unpriced balances',async()=>{
  for(const priced of [false,true])for(const absent of [false,true]){
    // Empty runtime need not imply empty storage: no slot value is requested or
    // inferred for this existing recipient with a nonempty storage trie.
    const f=await amsterdamExecutionFixture({priced,value:'17',gas:absent?'5000000':'21000',target:absent?null:{nonce:1n,balance:9n,code:'0x',storage:{[word(0)]:7n}}});
    const p=transport(f),accounts=priced?[TX_SENDER,TARGET,COINBASE]:[TX_SENDER,TARGET],result=await run(f,p,accounts);
    assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.original.output.execution.status,'success');
    assert.equal(result.original.output.environment.chainId,CHAIN);assert.equal(result.headerVerification.hardfork,'amsterdam');
    assert.equal(result.original.output.gasAccounting.gasUsed,absent?'204600':'21000');
    assert.equal(result.usage.executions,1,'Native reads must not run disposable EVM calls');
    assert(p.calls.every(r=>r.method==='eth_getProof'));assert.equal(p.calls.length,accounts.length);
    derived(result,TX_SENDER,'verified_account_empty_code_hash');
    derived(result,TARGET,absent?'verified_account_absence':'verified_account_empty_code_hash');
    const charge=priced?BigInt(result.original.output.feeAccounting.gasCharge):0n;
    if(priced){assert.equal(charge,BigInt(result.original.output.gasAccounting.gasUsed)*10n);derived(result,COINBASE,'verified_account_absence');}
    else assert.equal(result.original.output.feeAccounting,undefined);
    amount(result.measurements[0],TX_SENDER,1000000000000n,1000000000000n-17n-charge,result.original.changes);
    amount(result.measurements[1],TARGET,absent?0n:9n,absent?17n:26n,result.original.changes);
    if(priced)amount(result.measurements[2],COINBASE,0n,BigInt(result.original.output.feeAccounting.coinbaseTip),result.original.changes);
    assert.deepEqual(result.original.changes.accounts.find(r=>r.address===TX_SENDER).nonce,{before:'0x1',after:'0x2'});
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
  }
});

test('nonempty contract runtime still requires one real hash-checked code response',async()=>{
  const f=await amsterdamExecutionFixture({priced:false,value:'17',target:{nonce:1n,balance:9n,code:'0x602b60005260206000f3'}}),p=transport(f,{contractCode:'valid'}),result=await run(f,p);
  assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.original.output.execution.returnData,word(43));
  assert.deepEqual(p.calls.filter(r=>r.method==='eth_getCode').map(r=>r.params[0]),[TARGET]);
  const provenance=result.inputs.provenance.find(r=>r.account===TARGET);assert.equal(Object.hasOwn(provenance,'codeDerivation'),false);
  assert(Number.isSafeInteger(provenance.codeEvidenceId));assert(provenance.codeEvidenceId>provenance.proofEvidenceId);
  const code=result.inputEvidence.find(r=>r.id===provenance.codeEvidenceId);assert.equal(code.request.method,'eth_getCode');assert.equal(code.result,'0x602b60005260206000f3');assert.equal(code.verification,'verified');
  amount(result.measurements[0],TX_SENDER,1000000000000n,999999999983n,result.original.changes);amount(result.measurements[1],TARGET,9n,26n,result.original.changes);
});

test('missing or hash-mismatched nonempty runtime withholds native measurements and rolls back nonce and fees',async()=>{
  for(const contractCode of ['missing','corrupt']){
    const f=await amsterdamExecutionFixture({priced:true,value:'17',target:{nonce:1n,balance:9n,code:'0x602b60005260206000f3'}}),p=transport(f,{contractCode}),result=await run(f,p);
    assert.equal(result.status,'unavailable');assert.equal(result.original.output.execution.status,'unavailable');
    assert.equal(result.original.output.stateDisposition,'rolled_back');assert.deepEqual(result.original.changes.accounts,[]);
    assert.equal(result.original.output.feeAccounting,undefined);assert.equal(result.original.output.profile.feesSettled,false);
    assert(result.measurements.every(m=>m.status==='not_attempted'&&m.values===null));
    assert.equal(result.inputUsage.failure.code,contractCode==='missing'?'RPC_STATE_INPUT_UNAVAILABLE':'RPC_STATE_INPUT_INVALID_PROOF');
    assert.deepEqual(p.calls.filter(r=>r.method==='eth_getCode').map(r=>r.params[0]),[TARGET]);
    assert.equal(Object.hasOwn(result.inputs.accounts,TARGET),false);assert.equal(result.inputs.accounts[TX_SENDER].nonce,'1');assert.equal(result.inputs.accounts[TX_SENDER].balance,'1000000000000');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
  }
});
