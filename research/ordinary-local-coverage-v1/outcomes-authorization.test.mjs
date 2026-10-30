// Pure arithmetic/signature and retained-artifact controls only. No EVM target,
// client, live transport, or new accuracy observation is executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationAccounting,costs,localGas,localStateChanges,oracleRequests,oracleStateChanges,adjudicateLocalOutcome} from './outcomes.mjs';
import {signAuthorization,AUTHORITY,TX_SENDER,TEST_KEY,DELEGATE,SECOND_DELEGATE,ZERO,designation} from '../../engines/local-evm/test/authorization-fixture.js';
import {keccak_256} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';

const EMPTY='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const codeHash=code=>'0x'+Buffer.from(keccak_256(Buffer.from(code.slice(2),'hex'))).toString('hex');
const header={hash:'0x'+'11'.repeat(32),number:'0x1800000',timestamp:'1746612311',baseFeePerGas:'0x0'};
const request=list=>({from:TX_SENDER,to:DELEGATE,data:'0x',value:'0',gas:'5000000',...(list?{authorizationList:list}:{})});
function facts(authority={exists:true,nonce:'0',balance:'7',code:'0x',storage:{}},sender={exists:true,nonce:'1',balance:'1000000',code:'0x',storage:{}}){
 const accounts={[TX_SENDER]:sender,[AUTHORITY]:authority};
 return {accounts,provenance:Object.entries(accounts).map(([account,a])=>({account,accountProof:{exists:a.exists,storageRoot:EMPTY,codeHash:codeHash(a.exists?a.code:'0x')}}))};
}
const absent={exists:false};
const t=options=>signAuthorization(options);
const copy=x=>structuredClone(x);

test('oracle requests preserve ordered canonical authorization tuples and exact unsigned zero-price profile',()=>{
 const list=[t(),t({nonce:1n,address:ZERO}),t({nonce:2n,address:SECOND_DELEGATE})],r=request(list),planned=oracleRequests({request:r,header});
 assert.deepEqual(planned[1].params[0].authorizationList,list);assert.deepEqual(planned[1].params[0],planned[2].params[0]);
 assert.equal(planned[1].params[0].gas,'0x4c4b40');assert.equal(planned[1].params[0].gasPrice,'0x0');assert.equal(Object.hasOwn(planned[1].params[0],'nonce'),false);
 assert.deepEqual(planned[1].params[1],{blockHash:header.hash,requireCanonical:true});assert.deepEqual(planned[1].params[2].blockOverrides,{baseFeePerGas:'0x0'});assert.equal(planned[1].params[2].stateOverrides,undefined);
 assert.deepEqual(r.authorizationList,list);
 for(const mutate of [x=>x.authorizationList=[],x=>x.authorizationList[0].nonce='0x00',x=>x.authorizationList[0].address=x.authorizationList[0].address.toUpperCase(),x=>x.authorizationList[0].authority=AUTHORITY,x=>x.to=null,x=>x.blobVersionedHashes=['0x01'+'22'.repeat(31)]]){
  const forged=copy(r);mutate(forged);assert.throws(()=>oracleRequests({request:forged,header}));
 }
 assert.throws(()=>oracleRequests({request:r,header:{...header,timestamp:'1710338135'}}),/Prague/);
});

test('independent Prague intrinsic counts every tuple including invalid/skipped entries and excludes authorization from calldata floor',()=>{
 const r=request([t(),t({patch:{r:'0x0'}}),t({chainId:999n})]);r.data='0x0001';r.accessList=[{address:DELEGATE,storageKeys:['0x'+'00'.repeat(32)]},{address:DELEGATE,storageKeys:[]}];
 const c=costs(r,header);assert.equal(c.authorization,75000n);assert.equal(c.intrinsic,21000n+20n+4800n+1900n+75000n);assert.equal(c.floor,21050n);
 for(const timestamp of ['1746612311','1764798551','1765290071','1767747671'])assert.equal(costs(r,{...header,timestamp}).authorization,75000n);
});

test('existing empty and existing funded authorities earn equal refunds; absent first install does not',()=>{
 const r=request([t()]);
 for(const balance of ['0','7']){const f=facts({exists:true,nonce:'0',balance,code:'0x',storage:{}}),before=copy(f),a=authorizationAccounting(r,f);assert.equal(a.refund,12500n);assert.deepEqual(a.processing.entries,[{index:0,authority:AUTHORITY,status:'applied',reason:null}]);assert.deepEqual(a.codeChanges.get(AUTHORITY),{before:'0x',after:designation(DELEGATE)});assert.deepEqual(f,before);}
 const a=authorizationAccounting(r,facts(absent));assert.equal(a.refund,0n);assert.equal(a.processing.entries[0].status,'applied');
});

test('ordered duplicate clear/reinstall uses incremented nonce, existence and exact initial code',()=>{
 const list=[t(),t(),t({nonce:1n,address:ZERO}),t({nonce:2n,address:SECOND_DELEGATE})];
 const a=authorizationAccounting(request(list),facts(absent));assert.equal(a.refund,25000n);
 assert.deepEqual(a.processing.entries.map(x=>[x.status,x.reason]),[['applied',null],['skipped','nonce_mismatch'],['applied',null],['applied',null]]);
 assert.deepEqual(a.codeChanges.get(AUTHORITY),{before:'0x',after:designation(SECOND_DELEGATE)});
 const self=authorizationAccounting(request([t({key:TEST_KEY,nonce:2n}),t({key:TEST_KEY,nonce:3n,address:ZERO})]),facts());
 assert.equal(self.refund,25000n);assert(self.processing.entries.every(x=>x.authority===TX_SENDER&&x.status==='applied'));assert.deepEqual(self.codeChanges.get(TX_SENDER),{before:'0x',after:'0x'});
});

test('signature/chain/nonce/code eligibility failures stay ordered skips; missing recovered facts stay unavailable',()=>{
 const list=[t({chainId:999n}),t({nonce:(1n<<64n)-1n}),t({patch:{yParity:'0x2'}}),t({patch:{r:'0x0'}}),t({nonce:3n})];
 const a=authorizationAccounting(request(list),facts());assert.equal(a.refund,0n);assert.deepEqual(a.processing.entries.map(x=>x.reason),['wrong_chain','nonce_overflow','invalid_signature','invalid_signature','nonce_mismatch']);
 for(const code of ['0x00','0xef0100',designation(DELEGATE)+'00']){const f=facts({exists:true,nonce:'0',balance:'7',code,storage:{}});assert.equal(authorizationAccounting(request([t()]),f).processing.entries[0].reason,'authority_has_code');}
 const valid=facts({exists:true,nonce:'0',balance:'7',code:designation(DELEGATE),storage:{}});assert.equal(authorizationAccounting(request([t({address:ZERO})]),valid).refund,12500n);
 const missing=facts();delete missing.accounts[AUTHORITY];assert.throws(()=>authorizationAccounting(request([t()]),missing),/independently proven/);
 const invalidOnly=request([t({patch:{r:'0x0'}})]);assert.equal(authorizationAccounting(invalidOnly,missing).refund,0n);
});

test('message plus independently derived authorization refund is capped before applying calldata floor',()=>{
 const c=costs(request([t()]),header),a=authorizationAccounting(request([t()]),facts());
 const run=(message,refund,costs,gas)=>localGas({costs,authorization:a,output:{execution:{executionGasUsed:String(message),gasRefundCounter:String(refund)},gasAccounting:gas}});
 assert.equal(run(0,0,c,{beforeRefund:'46000',appliedRefund:'9200',floorAdjustment:'0',gasUsed:'36800'}),'36800');
 assert.equal(run(100000,20000,c,{beforeRefund:'146000',appliedRefund:'29200',floorAdjustment:'0',gasUsed:'116800'}),'116800');
 assert.equal(run(0,0,{...c,floor:45000n},{beforeRefund:'46000',appliedRefund:'9200',floorAdjustment:'8200',gasUsed:'45000'}),'45000');
 assert.throws(()=>run(0,0,c,{beforeRefund:'46000',appliedRefund:'0',floorAdjustment:'0',gasUsed:'46000'}),/accounting/);
 assert.throws(()=>run(5000000,0,c,{}),/budget/);
});

test('authorization-only code replacement is bound to independently recovered authority and final code, without general replacement permission',()=>{
 const f=facts({exists:true,nonce:'4',balance:'7',code:designation(DELEGATE),storage:{}}),a=authorizationAccounting(request([t({nonce:4n,address:ZERO})]),f);
 const diff={pre:{[AUTHORITY]:{nonce:'0x4',code:designation(DELEGATE)}},post:{[AUTHORITY]:{nonce:'0x5',code:'0x'}}};
 const rows=oracleStateChanges(diff,f,a);assert.deepEqual(rows[0].code,{before:designation(DELEGATE),after:'0x'});
 assert.throws(()=>oracleStateChanges(diff,f),/runtime replacement/);
 const forged=copy(diff);forged.post[AUTHORITY].code=designation(SECOND_DELEGATE);assert.throws(()=>oracleStateChanges(forged,f,a),/runtime replacement/);
});

test('canonical surviving reset with an empty-code successor stays unavailable to sparse-diff comparison',()=>{
 const oldRoot='0x'+'35'.repeat(32),inputs=facts(),changes={scope:'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.',accounts:[{address:AUTHORITY,nonce:{before:'0x0',after:'0x1'},reset:{basis:'contract_creation_storage_clear',initialStorageRoot:oldRoot}}]};
 inputs.provenance.find(x=>x.account===AUTHORITY).accountProof.storageRoot=oldRoot;
 // The unchanged empty code avoids ordinary runtime-replacement checks, but
 // the reset still erases an entire unknown original storage namespace.
 assert.throws(()=>localStateChanges({inputs,changes}),/Sparse oracle diff cannot establish whole storage namespace reset/);
 delete changes.accounts[0].reset;assert.deepEqual(localStateChanges({inputs,changes}),[{address:AUTHORITY,nonce:{before:'0x0',after:'0x1'}}]);
});

test('retained non-authorization packet remains comparable under current parent binding; altered request and raw oracle requests cannot inherit its match',async()=>{
 const base=new URL('../../reports/ordinary-local-coverage-v1/cases/001/',import.meta.url),read=name=>JSON.parse(readFileSync(new URL(name,base)));
 const req=read('request.json'),local=read('local.json'),oracle=read('oracle.json');
 const input={transactionHash:req.transactionHash,request:req.projection.request,header:req.parentHeader,expectedLocalImplementation:local.implementation,local,oracle};
 const got=await adjudicateLocalOutcome(input);assert.equal(got.outcome.comparison,'match',JSON.stringify(got));
 const authRequest=copy(input);authRequest.request.authorizationList=[t()];assert.equal((await adjudicateLocalOutcome(authRequest)).outcome.execution,'provider_unavailable');
 for(const mutate of [x=>x.oracle.records[1].request.params[0].authorizationList=[t()],x=>x.oracle.records[2].request.params[0].value='0x1',x=>x.local.attempt.output.gasAccounting.gasUsed='1']){
  const forged=copy(input);mutate(forged);assert.notEqual((await adjudicateLocalOutcome(forged)).outcome.comparison,'match');
 }
 // Byte identity is checked here only for this test's immutable retained files;
 // the production runner separately pins its complete source/evidence manifests.
 assert.equal(createHash('sha256').update(readFileSync(new URL('local.json',base))).digest('hex'),'6d8e059dac4022a96c70fefe31ba264968a70021904fb30fecb33519d5c9cdeb');
});

test('fifteen saved actual Prague/Osaka authorization attempts pass current proof/parent binding without replay; altered processing is refused',async()=>{
 const base=new URL('../delegated-sender-geth-v1/authorization-controls/capture/',import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
 const mb=readFileSync(new URL('manifest.json',base));assert.equal(sha(mb),'c53e86b76856b2ae0b9b56e0c1dba30580619e18e9970b0561b2657d008032ae');const manifest=JSON.parse(mb);
 const saved=name=>{const b=readFileSync(new URL(name,base));assert.equal(sha(b),manifest.files.find(x=>x.path===name).sha256);return JSON.parse(b);};
 const identity={name:'saved comparator-binding control',version:'test',sourceSha256:'a'.repeat(64),sourceFiles:['saved-attempt']};
 // The old OOG case012 deliberately used80,000 gas and remains outside this
 // fixed5M evaluator; it is neither altered nor counted as a new observation.
 for(const i of [1,2,3,4,5,6,7,8,9,10,11,13,14,15,16]){
  const n=String(i).padStart(3,'0'),decl=saved('inputs/'+n+'.json'),raw=saved('results/'+n+'-product.json'),attempt=raw.result.attempt;
  const input={transactionHash:'0x'+'12'.repeat(32),request:decl.request,header:decl.header,expectedLocalImplementation:identity,local:{dispatch:'completed',implementation:identity,attempt},oracle:{dispatch:'budget_unattempted',records:[]}};
  const result=await adjudicateLocalOutcome(input);assert.equal(result.outcome.execution,attempt.output.execution.status,n+': '+JSON.stringify(result));assert.equal(result.outcome.comparison,'budget_unattempted');
  assert(Object.values(result.channels).every(x=>x.status==='unavailable'),'No new oracle match is invented');
  if(i===1){for(const mutate of [x=>x.local.attempt.output.authorizationProcessing.gasRefundCounter='0',x=>x.local.attempt.output.authorizationProcessing.entries[0].authority=DELEGATE,x=>x.local.attempt.changes.accounts.find(r=>r.address===AUTHORITY).nonce.after='0x2']){
    const forged=copy(input);mutate(forged);assert.equal((await adjudicateLocalOutcome(forged)).outcome.execution,'provider_unavailable');
  }}
 }
});
