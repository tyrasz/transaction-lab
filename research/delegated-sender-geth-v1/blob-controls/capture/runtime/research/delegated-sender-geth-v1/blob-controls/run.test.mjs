import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bytes,feeCommon,feeBlock } from '../../../engines/local-evm/test/blob-fee-fixture.js';
import { bytesToHex } from '../../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { loadState } from '../../../engines/fixture-evm/state-test.js';
import { NAMES,fixtureAt,initial,canonicalAllocation } from './cases.mjs';
import { signedBytes,decodeSignedInput,gethTransaction,freeze,parseWorker,rawProcess,wrapper,fullVMAgreement,LIMITS,phaseClock,packetVerdict,readSealedProduct,artifactLedger } from './run.mjs';
import { sha,entry,sourcePaths,sourceCommit,PRODUCT_COMMIT,PROTOCOL_ORIGIN } from './archive.mjs';
import { adjudicate } from '../run.mjs';
const stream=s=>{const b=Buffer.from(s);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const raw=result=>({error:null,exitCode:0,signal:null,timeoutMs:20000,elapsedMs:1,stdout:stream(JSON.stringify(result)),stderr:stream('')});
test('all twelve declarations reconstruct exact signed type-3/type-2 envelopes and initial roots without execution',async()=>{
  assert.equal(NAMES.length,12);assert.equal(new Set(NAMES).size,12);const forks={},counts=[];
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)},common=feeCommon(f),tx=decodeSignedInput(input),r=input.request;
    assert.equal(bytesToHex(await(await loadState(input.allocation,common)).getStateRoot()),input.header.stateRoot);
    assert.equal(bytesToHex(feeBlock(f,common).hash()),input.header.hash);
    assert.equal(tx.type,i===5?2:3);assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),r.from);
    assert.equal(tx.to.toString(),r.to);assert.equal(tx.gasLimit,BigInt(r.gas));assert.equal(tx.value,BigInt(r.value));
    assert.equal(tx.nonce,BigInt(input.allocation[r.from].nonce));assert.equal(tx.maxFeePerGas,BigInt(r.fees.maxFeePerGas));
    assert.equal(tx.maxPriorityFeePerGas,BigInt(r.fees.maxPriorityFeePerGas));assert.deepEqual(tx.data,bytes(r.data));
    if(tx.type===3){assert.equal(tx.maxFeePerBlobGas,BigInt(r.fees.maxFeePerBlobGas));assert.deepEqual(tx.blobVersionedHashes,r.blobVersionedHashes);}
    assert.deepEqual(f.calls,[]);forks[input.fork]=(forks[input.fork]??0)+1;counts.push(r.blobVersionedHashes?.length??0);
    if(i<5){assert.equal(r.blobVersionedHashes[0],'0x01'+'0'.repeat(61)+'1');assert.equal(new Set(r.blobVersionedHashes).size,counts[i]);}
  }
  assert.deepEqual(forks,{Cancun:1,Prague:1,Osaka:7,BPO1:1,BPO2:2});
  assert.deepEqual(counts,[6,9,6,6,6,0,2,2,2,2,2,2]);
});
test('worker result requires clean bounded process and lossless streams',()=>{assert.deepEqual(parseWorker(raw({status:'completed',value:1})),{status:'completed',value:1});for(const patch of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:20001},{timeoutMs:0},{elapsedMs:NaN}])assert.equal(parseWorker({...raw({status:'completed'}),...patch}),null);const r=raw({status:'completed'});r.stdout.sha256='0'.repeat(64);assert.equal(parseWorker(r),null);assert.equal(parseWorker(raw({status:'unavailable'})),null);});
test('actual unrelated node subprocess preserves nonzero-exit and partial-output failures',()=>{for(const script of ['process.stdout.write("{}");process.exitCode=1','process.stdout.write("{")']){const r=rawProcess(process.execPath,['-e',script],{cwd:tmpdir(),timeoutMs:1000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin'}});assert.equal(parseWorker(r),null);assert.equal(Buffer.from(r.stdout.base64,'base64').length,r.stdout.bytes);}});
test('archive entries reject links escaping their complete dependency tree',()=>{const d=mkdtempSync(path.join(tmpdir(),'fee-archive-'));try{writeFileSync(path.join(d,'a'),'x');symlinkSync('/etc/hosts',path.join(d,'bad'));assert.throws(()=>entry(d,'bad'));assert.throws(()=>entry(d,'../bad'));assert.equal(entry(d,'a').sha256,sha('x'));}finally{rmSync(d,{recursive:true,force:true});}});
test('Geth wrappers bind current excess, signed hashes/caps and canonical prestate without claiming body validation',async()=>{
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)},root='0x'+'11'.repeat(32),r=input.request;
    const product={result:{attempt:{status:'completed',output:{execution:{status:'success'},logs:[]}}}},reference={result:{status:'completed',productAppliedStateRoot:root,fullVM:{stateRoot:'0x'+'22'.repeat(32)}}},w=wrapper(input,product,reference),t=w.transaction;
    assert.equal(w.post[input.fork][0].hash,root);assert.equal(w.post[input.fork][0].txbytes,input.signedTransaction);
    assert.deepEqual(t,gethTransaction(input));assert.equal(t.to,r.to);assert.equal(BigInt(t.maxFeePerGas),BigInt(r.fees.maxFeePerGas));
    assert.equal(BigInt(t.maxPriorityFeePerGas),BigInt(r.fees.maxPriorityFeePerGas));assert.equal(w.env.currentBaseFee,input.header.baseFeePerGas);
    assert.equal(w.env.currentCoinbase,input.header.miner);assert.equal(w.env.currentExcessBlobGas,input.header.excessBlobGas);
    assert.equal(input.contextScope.gethBlockBodyCapacityValidated,false);assert.deepEqual(w.pre,input.allocation);
    if(i===5){assert.equal(Object.hasOwn(t,'maxFeePerBlobGas'),false);assert.equal(Object.hasOwn(t,'blobVersionedHashes'),false);}
    else {assert.equal(BigInt(t.maxFeePerBlobGas),BigInt(r.fees.maxFeePerBlobGas));assert.deepEqual(t.blobVersionedHashes,r.blobVersionedHashes);}
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
    x=>{x.request.blobVersionedHashes.reverse();},x=>{x.request.blobVersionedHashes.pop();},
    x=>{x.request.accessList=[{address:x.request.to,storageKeys:[]}];},
    x=>{x.request.authorizationList=[];},x=>{x.request.fees.extra='0';},
    x=>{x.request.executionProfile='unsigned_eip1559_block_end';},
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
test('reused Geth adjudicator retains exit-zero assertion failure and requires exact expected case',()=>{const expected={name:'example',fork:'Osaka',stateRoot:'0x'+'11'.repeat(32)},r={...raw([{...expected,pass:false,error:'logs mismatch'}]),timeoutMs:5000};assert.equal(adjudicate(r,expected).status,'mismatched');assert.equal(adjudicate({...r,exitCode:1},expected).status,'unavailable');assert.equal(adjudicate(r,{...expected,name:'foreign'}).status,'unavailable');assert.equal(LIMITS.cases,12);});
test('dual-clock phase terminal overruns and latched reversals withhold the whole packet',()=>{
  for(const field of ['wall','mono']){const time={wall:1000,mono:10},clock=phaseClock(100,{now:()=>time.wall,monotonic:()=>time.mono});time[field]+=101;assert.equal(clock.remaining(),0);assert.equal(clock.terminal().status,'overrun');}
  const time={wall:1000,mono:10},clock=phaseClock(100,{now:()=>time.wall,monotonic:()=>time.mono});time.wall--;assert.equal(clock.remaining(),0);time.wall=1010;assert.equal(clock.terminal().status,'clock_invalid');
  const valid={status:'within_budget',clockValid:true},base={fatal:null,sourceUnchanged:true,phaseTimings:{preparation:valid,geth:valid}};assert.deepEqual(packetVerdict(base),{status:'complete',comparisonsUsable:true});for(const patch of [{fatal:{message:'drift'}},{sourceUnchanged:false},{phaseTimings:{preparation:valid,geth:{status:'overrun',clockValid:true}}},{phaseTimings:{preparation:valid,geth:null}}])assert.deepEqual(packetVerdict({...base,...patch}),{status:'interrupted',comparisonsUsable:false});
});

test('complete source inventory binds the reviewed product baseline without creating a capture',async()=>{
  const root=path.resolve(import.meta.dirname,'../../..'),paths=sourcePaths(root);
  for(const p of ['engines/local-evm/test/blob-fee-fixture.js','engines/local-evm/test/fee-fixture.js','engines/local-evm/test/authorization-fixture.js','engines/local-evm/test/lifecycle-fixture.js','engines/fixture-evm/state-test.js','engines/local-evm/ethereum-blob-fees.js'])assert(paths.includes(p),p);
  assert(paths.some(p=>p.startsWith('engines/local-evm/node_modules/')));assert(paths.some(p=>p.startsWith('engines/fixture-evm/node_modules/')));assert(paths.every(p=>!p.includes('/capture/')));
  assert.equal(PROTOCOL_ORIGIN.commit,'948a489f88ac3344473f541426fd208be64ba2f2');
  if(PRODUCT_COMMIT===null){
    assert.throws(()=>sourceCommit(root,paths),/pin is pending/);
    const directory=mkdtempSync(path.join(tmpdir(),'blob-pending-'));try{
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
