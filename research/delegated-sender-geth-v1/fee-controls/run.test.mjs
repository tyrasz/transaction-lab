import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTxFromRLP } from '../../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { bytes,feeCommon,feeBlock } from '../../../engines/local-evm/test/fee-fixture.js';
import { bytesToHex } from '../../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { loadState } from '../../../engines/fixture-evm/state-test.js';
import { NAMES,fixtureAt,initial,canonicalAllocation } from './cases.mjs';
import { signedBytes,parseWorker,rawProcess,wrapper,fullVMAgreement,LIMITS,phaseClock,packetVerdict,readSealedProduct,artifactLedger } from './run.mjs';
import { sha,entry,sourcePaths,sourceCommit,PRODUCT_COMMIT } from './archive.mjs';
import { adjudicate } from '../run.mjs';
const stream=s=>{const b=Buffer.from(s);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const raw=result=>({error:null,exitCode:0,signal:null,timeoutMs:20000,elapsedMs:1,stdout:stream(JSON.stringify(result)),stderr:stream('')});
test('all sixteen frozen declarations reconstruct exact signed type-2/type-4 envelopes without execution',async()=>{
  assert.equal(NAMES.length,16);assert.equal(new Set(NAMES).size,16);const forks={};
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input=initial(f,i),common=feeCommon(f),tx=createTxFromRLP(bytes(signedBytes(f)),{common}),r=input.request;
    assert.equal(bytesToHex(await(await loadState(input.allocation,common)).getStateRoot()),input.header.stateRoot);assert.equal(bytesToHex(feeBlock(f,common).hash()),input.header.hash);
    assert.equal(tx.type,r.authorizationList?4:2);assert(tx.verifySignature());assert.equal(tx.getSenderAddress().toString(),r.from);assert.equal(tx.to?.toString()??null,r.to);assert.equal(tx.gasLimit,BigInt(r.gas));assert.equal(tx.value,BigInt(r.value));assert.equal(tx.nonce,BigInt(input.allocation[r.from].nonce));assert.equal(tx.maxFeePerGas,BigInt(r.fees.maxFeePerGas));assert.equal(tx.maxPriorityFeePerGas,BigInt(r.fees.maxPriorityFeePerGas));assert.deepEqual(tx.data,bytes(r.data));assert.equal(tx.authorizationList?.length,r.authorizationList?.length);assert.deepEqual(f.calls,[]);forks[input.fork]=(forks[input.fork]??0)+1;
  }
  assert.deepEqual(forks,{Osaka:13,Shanghai:1,Cancun:2});
});
test('worker result requires clean bounded process and lossless streams',()=>{assert.deepEqual(parseWorker(raw({status:'completed',value:1})),{status:'completed',value:1});for(const patch of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:20001},{timeoutMs:0},{elapsedMs:NaN}])assert.equal(parseWorker({...raw({status:'completed'}),...patch}),null);const r=raw({status:'completed'});r.stdout.sha256='0'.repeat(64);assert.equal(parseWorker(r),null);assert.equal(parseWorker(raw({status:'unavailable'})),null);});
test('actual unrelated node subprocess preserves nonzero-exit and partial-output failures',()=>{for(const script of ['process.stdout.write("{}");process.exitCode=1','process.stdout.write("{")']){const r=rawProcess(process.execPath,['-e',script],{cwd:tmpdir(),timeoutMs:1000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin'}});assert.equal(parseWorker(r),null);assert.equal(Buffer.from(r.stdout.base64,'base64').length,r.stdout.bytes);}});
test('archive entries reject links escaping their complete dependency tree',()=>{const d=mkdtempSync(path.join(tmpdir(),'fee-archive-'));try{writeFileSync(path.join(d,'a'),'x');symlinkSync('/etc/hosts',path.join(d,'bad'));assert.throws(()=>entry(d,'bad'));assert.throws(()=>entry(d,'../bad'));assert.equal(entry(d,'a').sha256,sha('x'));}finally{rmSync(d,{recursive:true,force:true});}});
test('Geth wrappers preserve fee/header/transaction bindings, canonical prestate and type-specific fields',async()=>{
  for(let i=0;i<NAMES.length;i++){
    const f=await fixtureAt(i),input={...initial(f,i),signedTransaction:signedBytes(f)},root='0x'+'11'.repeat(32),r=input.request;
    const product={result:{attempt:{status:'completed',output:{execution:{status:'success'},logs:[]}}}},reference={result:{status:'completed',productAppliedStateRoot:root,fullVM:{stateRoot:'0x'+'22'.repeat(32)}}},w=wrapper(input,product,reference),t=w.transaction;
    assert.equal(w.post[input.fork][0].hash,root);assert.equal(w.post[input.fork][0].txbytes,input.signedTransaction);assert.equal(t.to,r.to??'');assert.equal(BigInt(t.maxFeePerGas),BigInt(r.fees.maxFeePerGas));assert.equal(BigInt(t.maxPriorityFeePerGas),BigInt(r.fees.maxPriorityFeePerGas));assert.equal(w.env.currentBaseFee,input.header.baseFeePerGas);assert.equal(w.env.currentCoinbase,input.header.miner);assert.equal(Object.hasOwn(w.env,'currentExcessBlobGas'),input.fork!=='Shanghai');assert.deepEqual(w.pre,input.allocation);
    if(r.authorizationList)assert.deepEqual(t.authorizationList,r.authorizationList.map(({yParity,...a})=>({...a,v:yParity})));else assert.equal(Object.hasOwn(t,'authorizationList'),false);
    for(const a of Object.values(w.pre))for(const[k,v]of Object.entries(a.storage)){assert.match(k,/^0x[0-9a-f]{64}$/);assert.match(v,/^0x[0-9a-f]{64}$/);}
    assert.equal(wrapper(input,{result:null},reference),null);
  }
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

test('source inventory covers fee fixtures, both full dependency closures and committed product baseline without copying',()=>{
  const root=path.resolve(import.meta.dirname,'../../..'),paths=sourcePaths(root);
  for(const p of ['engines/local-evm/test/fee-fixture.js','engines/local-evm/test/authorization-fixture.js','engines/local-evm/test/lifecycle-fixture.js','engines/fixture-evm/state-test.js','engines/local-evm/fee-validation.js'])assert(paths.includes(p),p);
  assert(paths.some(p=>p.startsWith('engines/local-evm/node_modules/')));assert(paths.some(p=>p.startsWith('engines/fixture-evm/node_modules/')));assert(paths.every(p=>!p.includes('/capture/')));
  const identity=sourceCommit(root,paths);assert.equal(identity.productCommit,PRODUCT_COMMIT);assert.equal(identity.trackedProductUnchanged,true);
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
