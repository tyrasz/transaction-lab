import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bytes,feeCommon,feeBlock } from '../../../engines/local-evm/test/blob-fee-fixture.js';
import { bytesToHex } from '../../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { loadState } from '../../../engines/fixture-evm/state-test.js';
import { NAMES,fixtureAt,initial,canonicalAllocation,options,PREFIX_CODE,RETURN_TAIL,REVERT_TAIL,INCORRECT_INPUT,MALFORMED_INPUT,INFINITY_INPUT,INFINITY_POINT } from './cases.mjs';
import { signedBytes,decodeSignedInput,gethTransaction,freeze,parseWorker,rawProcess,wrapper,fullVMAgreement,LIMITS,phaseClock,packetVerdict,readSealedProduct,artifactLedger } from './run.mjs';
import { sha,entry,sourcePaths,sourceCommit,PRODUCT_COMMIT,PROTOCOL_ORIGIN } from './archive.mjs';
import { adjudicate } from '../run.mjs';
import { createHash } from 'node:crypto';
import { KZG_INPUT,KZG_ADDRESS,TARGET,TX_SENDER,COINBASE,kzgCallerCode } from '../../../engines/local-evm/test/kzg-fixture.js';
const stream=s=>{const b=Buffer.from(s);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const raw=result=>({error:null,exitCode:0,signal:null,timeoutMs:20000,elapsedMs:1,stdout:stream(JSON.stringify(result)),stderr:stream('')});
test('all sixteen declarations reconstruct exact signed type-2 envelopes and initial roots without execution',async()=>{
  assert.equal(NAMES.length,16);assert.equal(new Set(NAMES).size,16);const forks={};
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)},common=feeCommon(f),tx=decodeSignedInput(input),r=input.request;
    assert.equal(bytesToHex(await(await loadState(input.allocation,common)).getStateRoot()),input.header.stateRoot);
    assert.equal(bytesToHex(feeBlock(f,common).hash()),input.header.hash);assert.equal(tx.type,2);assert(tx.verifySignature());
    assert.equal(tx.getSenderAddress().toString(),TX_SENDER);assert.equal(tx.to.toString(),r.to);assert.equal(tx.gasLimit,BigInt(r.gas));assert.equal(tx.value,19n);
    assert.equal(tx.nonce,1n);assert.equal(tx.maxFeePerGas,13n);assert.equal(tx.maxPriorityFeePerGas,3n);assert.deepEqual(tx.data,bytes(r.data));
    assert.equal(r.blobVersionedHashes,undefined);assert.equal(r.authorizationList,undefined);assert.equal(input.header.baseFeePerGas,'0x7');
    assert.equal(input.header.blobGasUsed,'0x0');assert.equal(input.header.excessBlobGas,'0x0');
    assert.equal(BigInt(input.allocation[TX_SENDER].balance),1000000000000n);assert.equal(BigInt(input.allocation[TARGET].balance),100n);assert.equal(BigInt(input.allocation[TARGET].nonce),1n);
    assert.deepEqual(input.allocation[COINBASE],{nonce:'0x1',balance:'0x1',code:'0x',storage:{}});
    assert.deepEqual(f.calls,[]);forks[input.fork]=(forks[input.fork]??0)+1;
    assert.equal(input.contextScope.syntheticHeader,true);assert.equal(input.contextScope.sharedCryptoAndOpcodesForFullVM,true);
    if(i<14)assert.equal(r.gas,'200000');
    else{const octets=Buffer.from(r.data.slice(2),'hex'),intrinsic=21000+Array.from(octets).reduce((sum,n)=>sum+(n===0?4:16),0);assert.equal(BigInt(r.gas),BigInt(intrinsic+(i===14?50000:49999)));}
  }
  assert.deepEqual(forks,{Cancun:3,Prague:1,Osaka:10,BPO1:1,BPO2:1});
});
test('fixed nested bytecode and negative/infinity inputs are declared independently of execution',async()=>{
  const rows=options();assert.equal(rows.length,16);
  for(let i=0;i<5;i++){assert.equal(rows[i].to,KZG_ADDRESS);assert.equal(rows[i].data,KZG_INPUT);}
  assert.equal(PREFIX_CODE,'602a600355');assert.equal(RETURN_TAIL,'60405260005160005560205160015560405160025560a160606000a160606000f3');assert.equal(REVERT_TAIL,RETURN_TAIL.slice(0,-2)+'fd');
  for(const [i,kind,gas,value,revert]of [[5,'CALL',50000,5,false],[6,'CALLCODE',50000,5,false],[7,'DELEGATECALL',50000,0,false],[8,'STATICCALL',50000,0,false],[9,'STATICCALL',49999,0,false],[10,'CALL',50000,5,true]]){
    assert.equal(rows[i].to,TARGET);assert.equal(rows[i].data,KZG_INPUT);assert.equal(rows[i].target.code,kzgCallerCode({kind,gas,value,prefix:PREFIX_CODE,tail:revert?REVERT_TAIL:RETURN_TAIL}));
  }
  assert.equal(INCORRECT_INPUT.length,KZG_INPUT.length);assert.equal(INCORRECT_INPUT.slice(0,130),KZG_INPUT.slice(0,130));assert.equal(INCORRECT_INPUT.slice(194),KZG_INPUT.slice(194));
  assert.equal(BigInt('0x'+INCORRECT_INPUT.slice(130,194)),BigInt('0x'+KZG_INPUT.slice(130,194))+1n);
  assert.equal(MALFORMED_INPUT.slice(0,290),KZG_INPUT.slice(0,290));assert.equal(MALFORMED_INPUT.slice(290),'00'.repeat(48));
  const data=Buffer.from(INFINITY_INPUT.slice(2),'hex'),commitment=data.subarray(96,144),proof=data.subarray(144);assert.equal(data.length,192);
  assert.equal(commitment.toString('hex'),INFINITY_POINT);assert.deepEqual(proof,commitment);assert(data.subarray(32,96).every(b=>b===0));
  const hash=createHash('sha256').update(commitment).digest();hash[0]=1;assert.deepEqual(data.subarray(0,32),hash);
  assert.equal(rows[11].data,INCORRECT_INPUT);assert.equal(rows[12].data,MALFORMED_INPUT);assert.equal(rows[13].data,INFINITY_INPUT);
});
test('worker result requires clean bounded process and lossless streams',()=>{assert.deepEqual(parseWorker(raw({status:'completed',value:1})),{status:'completed',value:1});for(const patch of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:20001},{timeoutMs:0},{elapsedMs:NaN}])assert.equal(parseWorker({...raw({status:'completed'}),...patch}),null);const r=raw({status:'completed'});r.stdout.sha256='0'.repeat(64);assert.equal(parseWorker(r),null);assert.equal(parseWorker(raw({status:'unavailable'})),null);});
test('actual unrelated node subprocess preserves nonzero-exit and partial-output failures',()=>{for(const script of ['process.stdout.write("{}");process.exitCode=1','process.stdout.write("{")']){const r=rawProcess(process.execPath,['-e',script],{cwd:tmpdir(),timeoutMs:1000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin'}});assert.equal(parseWorker(r),null);assert.equal(Buffer.from(r.stdout.base64,'base64').length,r.stdout.bytes);}});
test('archive entries reject links escaping their complete dependency tree',()=>{const d=mkdtempSync(path.join(tmpdir(),'fee-archive-'));try{writeFileSync(path.join(d,'a'),'x');symlinkSync('/etc/hosts',path.join(d,'bad'));assert.throws(()=>entry(d,'bad'));assert.throws(()=>entry(d,'../bad'));assert.equal(entry(d,'a').sha256,sha('x'));}finally{rmSync(d,{recursive:true,force:true});}});
test('Geth wrappers bind exact signed type-2 messages and synthetic headers without claiming independent gas or sidecars',async()=>{
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)},root='0x'+'11'.repeat(32),r=input.request;
    const product={result:{attempt:{status:'completed',output:{execution:{status:'success'},logs:[]}}}},reference={result:{status:'completed',productAppliedStateRoot:root,fullVM:{stateRoot:'0x'+'22'.repeat(32)}}},w=wrapper(input,product,reference),t=w.transaction;
    assert.equal(w.post[input.fork][0].hash,root);assert.equal(w.post[input.fork][0].txbytes,input.signedTransaction);
    assert.deepEqual(t,gethTransaction(input));assert.equal(t.to,r.to);assert.equal(BigInt(t.maxFeePerGas),BigInt(r.fees.maxFeePerGas));
    assert.equal(BigInt(t.maxPriorityFeePerGas),BigInt(r.fees.maxPriorityFeePerGas));assert.equal(w.env.currentBaseFee,input.header.baseFeePerGas);
    assert.equal(w.env.currentCoinbase,input.header.miner);assert.equal(w.env.currentExcessBlobGas,input.header.excessBlobGas);
    assert.equal(input.contextScope.gethBlockBodyCapacityValidated,false);assert.deepEqual(w.pre,input.allocation);
    assert.equal(Object.hasOwn(t,'maxFeePerBlobGas'),false);assert.equal(Object.hasOwn(t,'blobVersionedHashes'),false);
    assert.equal(Object.hasOwn(t,'authorizationList'),false);
    for(const a of Object.values(w.pre))for(const[k,v]of Object.entries(a.storage)){assert.match(k,/^0x[0-9a-f]{64}$/);assert.match(v,/^0x[0-9a-f]{64}$/);}
    assert.equal(wrapper(input,{result:null},reference),null);
  }
});
test('decoded signed bytes reject every material JSON-envelope mutation and corrupted signatures',async()=>{
  const f=await fixtureAt(0),input={...initial(f,0),signedTransaction:signedBytes(f)};
  for(const mutate of [
    x=>{x.request.from='0x'+'11'.repeat(20);x.allocation[x.request.from]={nonce:'0x1'};},
    x=>{x.request.to='0x'+'11'.repeat(20);},x=>{x.request.gas='299999';},x=>{x.request.value='1';},
    x=>{x.request.data='0x00';},x=>{x.allocation[x.request.from].nonce='0x2';},
    x=>{x.request.fees.maxFeePerGas='14';},x=>{x.request.fees.maxPriorityFeePerGas='2';},x=>{x.request.fees.maxFeePerBlobGas='101';},
    x=>{x.request.blobVersionedHashes=['0x01'+'00'.repeat(31)];},x=>{x.request.extra='ignored';},
    x=>{x.request.accessList=[{address:x.request.to,storageKeys:[]}];},
    x=>{x.request.authorizationList=[];},x=>{x.request.fees.extra='0';},
    x=>{x.request.executionProfile='unsigned_eip4844_block_end';},
    x=>{x.signedTransaction=x.signedTransaction.slice(0,-2)+(x.signedTransaction.endsWith('00')?'01':'00');},
  ]){const altered=structuredClone(input);mutate(altered);assert.throws(()=>gethTransaction(altered));}
});
test('storage encoding changes representation only, including odd and zero values; collisions and overflow reject',()=>{
  const a={x:{nonce:'0x0',balance:'0x5',code:'0x',storage:{'0x0':'0x7','0x1':'0x0'}}},out=canonicalAllocation(a);
  assert.equal(a.x.storage['0x0'],'0x7');assert.deepEqual({...out.x,storage:a.x.storage},a.x);
  assert.equal(BigInt(out.x.storage['0x'+'00'.repeat(32)]),7n);assert.equal(Object.values(out.x.storage)[1],'0x'+'00'.repeat(32));
  assert.throws(()=>canonicalAllocation({x:{storage:{'0x0':'0x7','0x00':'0x8'}}}));assert.throws(()=>canonicalAllocation({x:{storage:{'0x0':'0x1'+'00'.repeat(32)}}}));
});
test('same-library disagreement is retained rather than silently dropping the product expectation',()=>{const a={result:{attempt:{output:{execution:{status:'success',returnData:'0x'},gasAccounting:{gasUsed:'46000'},logs:[]}}}},b={result:{productAppliedStateRoot:'a',fullVM:{stateRoot:'b',logsHash:'wrong',execution:'success',returnData:'0x',gasUsed:'36800'}}};const c=fullVMAgreement(a,b);assert.equal(c.status,'mismatched');assert.equal(c.checks.state,false);assert.equal(c.checks.gas,false);assert.equal(c.checks.status,true);});
test('reused Geth adjudicator retains exit-zero assertion failure and requires exact expected case',()=>{const expected={name:'example',fork:'Osaka',stateRoot:'0x'+'11'.repeat(32)},r={...raw([{...expected,pass:false,error:'logs mismatch'}]),timeoutMs:5000};assert.equal(adjudicate(r,expected).status,'mismatched');assert.equal(adjudicate({...r,exitCode:1},expected).status,'unavailable');assert.equal(adjudicate(r,{...expected,name:'foreign'}).status,'unavailable');assert.equal(LIMITS.cases,16);});
test('dual-clock phase terminal overruns and latched reversals withhold the whole packet',()=>{
  for(const field of ['wall','mono']){const time={wall:1000,mono:10},clock=phaseClock(100,{now:()=>time.wall,monotonic:()=>time.mono});time[field]+=101;assert.equal(clock.remaining(),0);assert.equal(clock.terminal().status,'overrun');}
  const time={wall:1000,mono:10},clock=phaseClock(100,{now:()=>time.wall,monotonic:()=>time.mono});time.wall--;assert.equal(clock.remaining(),0);time.wall=1010;assert.equal(clock.terminal().status,'clock_invalid');
  const valid={status:'within_budget',clockValid:true},base={fatal:null,sourceUnchanged:true,phaseTimings:{preparation:valid,geth:valid}};assert.deepEqual(packetVerdict(base),{status:'complete',comparisonsUsable:true});for(const patch of [{fatal:{message:'drift'}},{sourceUnchanged:false},{phaseTimings:{preparation:valid,geth:{status:'overrun',clockValid:true}}},{phaseTimings:{preparation:valid,geth:null}}])assert.deepEqual(packetVerdict({...base,...patch}),{status:'interrupted',comparisonsUsable:false});
});

test('complete source inventory binds the reviewed product baseline without creating a capture',async()=>{
  const root=path.resolve(import.meta.dirname,'../../..'),paths=sourcePaths(root);
  for(const p of ['engines/local-evm/test/blob-fee-fixture.js','engines/local-evm/test/fee-fixture.js','engines/local-evm/test/authorization-fixture.js','engines/local-evm/test/lifecycle-fixture.js','engines/fixture-evm/state-test.js','engines/local-evm/ethereum-blob-fees.js','engines/local-evm/kzg-point-evaluation.js','engines/local-evm/kzg-runtime.js','engines/local-evm/test/kzg-fixture.js','engines/local-evm/test/fixtures/kzg-point-evaluation/provenance.json','engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/pointEvaluation.json'])assert(paths.includes(p),p);
  assert(paths.some(p=>p.startsWith('engines/local-evm/node_modules/')));assert(paths.some(p=>p.startsWith('engines/fixture-evm/node_modules/')));assert(paths.every(p=>!p.includes('/capture/')));
  assert.equal(PROTOCOL_ORIGIN.commit,'28f08f282c4c1c9e0b046cbb5f1b1c0b825db93e');
  if(PRODUCT_COMMIT===null){
    assert.throws(()=>sourceCommit(root,paths),/pin is pending/);
    const directory=mkdtempSync(path.join(tmpdir(),'kzg-pending-'));try{
      const capture=path.join(directory,'capture');await assert.rejects(freeze(capture),/pin is pending/);
      assert.equal(existsSync(capture),false);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }else{const identity=sourceCommit(root,paths);assert.equal(identity.productCommit,PRODUCT_COMMIT);assert.equal(identity.trackedProductUnchanged,true);}
});
test('durable product identity and artifact ledger reject changed bytes and changed seals',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'fee-seal-'));try{
    const ledger=artifactLedger(directory),product={result:{attempt:{status:'completed',changes:{accounts:[]}}}},identity=ledger.save('results/001-product.json',product);
    ledger.save('results/001-PRODUCT_SEALED.json',{...identity,path:'results/001-product.json',at:new Date().toISOString()});
    assert.deepEqual(readSealedProduct(directory,'001'),product);assert.equal(ledger.verify(),2);
    const changed=JSON.stringify({...product,replaced:true});writeFileSync(path.join(directory,'results/001-product.json'),changed);assert.throws(()=>readSealedProduct(directory,'001'));assert.throws(()=>ledger.verify());
    writeFileSync(path.join(directory,'results/001-PRODUCT_SEALED.json'),JSON.stringify({path:'results/001-product.json',bytes:Buffer.byteLength(changed),sha256:sha(changed)}));assert.throws(()=>ledger.verify());
    assert.throws(()=>readSealedProduct(directory,'../001'));assert.throws(()=>ledger.save('../escape.json',{}));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
