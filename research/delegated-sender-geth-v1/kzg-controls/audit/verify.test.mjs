import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha, REL, NAMES, LIMITS, parseRaw, classifyGeth, recordedPaths, checkTiming, bindProcess, storageWords, bindKzgDeclaration } from './checks.mjs';
import { libraries, bindSignedTransaction, applyProductChanges, verifyInventory, verifyEvidence } from './verify.mjs';
import { fixtureAt } from '../cases.mjs';
import { signBlobFeeTransaction, feeCommon } from '../../../../engines/local-evm/test/blob-fee-fixture.js';
const root=path.resolve(import.meta.dirname,'../../../..'),lib=await libraries(root);
const pins=JSON.parse(fs.readFileSync(new URL('./pins.json',import.meta.url))),capture=path.resolve(import.meta.dirname,'../capture');
const stream=b=>{b=Buffer.from(b);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const expected={name:'unrelated-control',fork:'Osaka',stateRoot:'0x'+'12'.repeat(32)};
const raw=(pass=true)=>({binary:'/old/bin/evm',args:[],processCompletion:'spawnSync_returned_after_child_and_pipes_closed',exitCode:0,signal:null,error:null,timeoutMs:5000,elapsedMs:1,
  stdout:stream(JSON.stringify([{...expected,pass,...(pass?{}:{error:'assertion failed'})}])),stderr:stream('')});
async function inputAt(i){const f=await fixtureAt(i),common=feeCommon(f),signed=signBlobFeeTransaction({request:f.request,common,nonce:BigInt(f.allocation[f.request.from].nonce)});
  const input={request:structuredClone(f.request),header:structuredClone(f.header),allocation:structuredClone(f.allocation),signedTransaction:lib.bytesToHex(signed.serialize())};return{f,common,input};}

test('all sixteen initial headers, prestate roots and complete signed type2 envelopes bind without target execution',async()=>{
  assert.equal(NAMES.length,16);assert.equal(LIMITS.cases,16);const counts=[];
  for(let i=0;i<16;i++){const{f,common,input}=await inputAt(i);const tx=bindSignedTransaction(input,common,lib);
    assert.equal(tx.type,2);assert.equal(lib.verifyEthereumHeader({header:f.header,expectedHash:f.header.hash}).hardfork,common.hardfork());
    assert.equal(lib.bytesToHex(await(await lib.loadState(input.allocation,common)).getStateRoot()),f.header.stateRoot);assert.deepEqual(f.calls,[]);counts.push(input.request.blobVersionedHashes?.length??0);}
  assert.deepEqual(counts,Array(16).fill(0));
});
test('independent signed decoding rejects modified fee, blob, calldata, nonce, destination, access list and signature fields',async()=>{
  const{common,input}=await inputAt(0);
  for(const mutate of [r=>r.request.fees.maxFeePerBlobGas='101',r=>r.request.blobVersionedHashes=['0x01'+'00'.repeat(31)],r=>r.request.extra='unrecognized',
    r=>r.request.data='0x01',r=>r.request.to='0x'+'22'.repeat(20),r=>r.request.gas='299999',r=>r.request.value='1',r=>r.request.fees.maxFeePerGas='14',
    r=>r.request.fees.maxPriorityFeePerGas='2',r=>r.allocation[r.request.from].nonce='0x2',r=>r.request.authorizationList=[],r=>r.request.fees.extra='0',
    r=>r.request.accessList=[{address:r.request.to,storageKeys:[]}],r=>r.signedTransaction=r.signedTransaction.slice(0,-2)+'00']){
    const altered=structuredClone(input);mutate(altered);assert.throws(()=>bindSignedTransaction(altered,common,lib));}
  const plain=await inputAt(5);plain.input.request.blobVersionedHashes=['0x01'+'00'.repeat(31)];assert.throws(()=>bindSignedTransaction(plain.input,plain.common,lib));
});
test('proof facts bind normalized claims to exact initial proof and code bytes without executing bytecode',async()=>{
  const{f}=await inputAt(8),address=f.request.to,slot='0x'+'00'.repeat(32);await f.inputs.getStorage(address,slot);
  const evidence={inputs:f.inputs.snapshotInputs(),inputEvidence:f.inputs.snapshotEvidence(),stateRoot:f.header.stateRoot};
  assert.equal(await lib.validateInputFacts(evidence),true);
  for(const mutate of [r=>r.inputs.accounts[address].balance='1',r=>r.inputs.accounts[address].storage[slot]='0x'+'00'.repeat(31)+'01',r=>r.inputEvidence[0].result.accountProof=[],
    r=>r.inputEvidence[0].request.params.at(-1).requireCanonical=false,r=>r.inputEvidence[1].result='0x00']){
    const bad=structuredClone(evidence);mutate(bad);await assert.rejects(lib.validateInputFacts(bad));}
});
test('third MPT starts from initial state and rejects altered before facts or duplicate changes',async()=>{
  const{common,input}=await inputAt(8),address=input.request.to,slot='0x'+'00'.repeat(32),zero='0x'+'00'.repeat(32),seven='0x'+'00'.repeat(31)+'07';
  const load=()=>lib.loadState(input.allocation,common),changes={accounts:[{address,nonce:{before:'0x1',after:'0x2'},storage:[{slot,before:zero,after:seven}]}]};
  const state=await load(),observed=await applyProductChanges(state,changes,lib),independent=await load(),a=lib.createAddressFromString(address);
  await independent.modifyAccountFields(a,{nonce:2n});await independent.putStorage(a,lib.hexToBytes(slot),new Uint8Array([7]));
  assert.equal(observed,lib.bytesToHex(await independent.getStateRoot()));assert.notEqual(observed,input.header.stateRoot);
  for(const mutate of [r=>r.accounts.push(structuredClone(r.accounts[0])),r=>r.accounts[0].nonce.before='0x0',r=>r.accounts[0].storage[0].before=seven,
    r=>r.accounts[0].storage.push(structuredClone(r.accounts[0].storage[0]))]){const bad=structuredClone(changes);mutate(bad);await assert.rejects(applyProductChanges(await load(),bad,lib));}
});
test('pass false is retained despite matching root; closed process failures and foreign results never pass',()=>{
  assert.equal(classifyGeth(raw(),expected).status,'matched');assert.equal(classifyGeth(raw(false),expected).status,'mismatched');assert.equal(classifyGeth(raw(false),expected).checks.internalLogHash,false);
  for(const patch of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:5001}])assert.equal(classifyGeth({...raw(),...patch},expected).status,'unavailable');
  for(const body of ['{',JSON.stringify([{...expected,pass:'true'}]),JSON.stringify([{...expected,name:'foreign',pass:true}]),JSON.stringify([{...expected,pass:true,error:'failure'}])]){
    const r=raw();r.stdout=stream(body);assert.equal(classifyGeth(r,expected).status,'unavailable');}
});
test('raw counts, hashes, canonical base64, strict UTF8, output cap and closure bind before classification',()=>{
  for(const mutate of [r=>r.stdout.bytes++,r=>r.stdout.sha256='0'.repeat(64),r=>r.stdout.base64+='!',r=>r.stdout=stream([255]),r=>r.stderr=stream([255]),
    r=>r.processCompletion='open',r=>r.elapsedMs=NaN,r=>r.timeoutMs=5001]){const r=raw();mutate(r);assert.throws(()=>classifyGeth(r,expected));}
  assert.throws(()=>parseRaw(raw(),{timeout:5000,bytes:1}));
});
test('recorded process arguments are immutable while current artifact location may differ',()=>{
  const plan={sourceRoot:'/old/checkout',captureDirectory:'/old/checkout/'+REL+'/capture'},p=recordedPaths(plan);
  const r=raw();r.args=['statetest',p.capture+'/geth-inputs/001.json'];bindProcess(r,{binary:r.binary,args:r.args});
  assert.throws(()=>bindProcess(r,{binary:r.binary,args:['statetest','/new/checkout/input.json']}));assert.throws(()=>recordedPaths({...plan,captureDirectory:'/new/checkout/'+REL+'/capture'}));
});
test('complete-packet timing cannot ignore overruns, reversal or withheld integrity',()=>{
  const base={status:'complete',comparisonsUsable:true,sourceUnchanged:true,fatal:null,elapsedMs:3,phaseTimings:{preparation:{status:'within_budget',clockValid:true,limitMs:360000,wallElapsedMs:1,monotonicElapsedMs:1},geth:{status:'within_budget',clockValid:true,limitMs:120000,wallElapsedMs:1,monotonicElapsedMs:1}}};
  checkTiming(base);for(const mutate of [r=>r.phaseTimings.geth.wallElapsedMs=120001,r=>r.phaseTimings.preparation.clockValid=false,r=>r.elapsedMs=Infinity,r=>r.elapsedMs=0,r=>r.sourceUnchanged=false,r=>r.comparisonsUsable=false]){const r=structuredClone(base);mutate(r);assert.throws(()=>checkTiming(r));}
});
test('inventory survives relocation with exact relative symlinks and rejects resealed omissions, byte drift or escape',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kzg-audit-inventory-')),original=path.join(temp,'original'),copy=path.join(temp,'copy');
  try{const p='engine/node_modules/lib/index.js';fs.mkdirSync(path.join(original,'runtime','engine/node_modules/lib'),{recursive:true});fs.mkdirSync(path.join(original,'runtime','engine/node_modules/.bin'));
    fs.writeFileSync(path.join(original,'runtime',p),'initial');fs.symlinkSync('../lib/index.js',path.join(original,'runtime','engine/node_modules/.bin/tool'));
    fs.writeFileSync(path.join(original,'result.json'),'{}');const files=[{path:'engine/node_modules/.bin/tool',kind:'symlink',target:'../lib/index.js'},{path:p,kind:'file',bytes:7,sha256:sha('initial'),mode:fs.statSync(path.join(original,'runtime',p)).mode&0o777}];
    const manifest={files:[{path:'result.json',bytes:2,sha256:sha('{}')}]},source={files};verifyInventory(original,manifest,source);
    fs.cpSync(original,copy,{recursive:true,dereference:false,verbatimSymlinks:true});assert.deepEqual(verifyInventory(copy,manifest,source),verifyInventory(original,manifest,source));
    fs.writeFileSync(path.join(copy,'runtime',p),'altered');assert.throws(()=>verifyInventory(copy,manifest,source));fs.writeFileSync(path.join(copy,'runtime',p),'initial');
    assert.throws(()=>verifyInventory(copy,{files:[]},source));fs.unlinkSync(path.join(copy,'runtime','engine/node_modules/.bin/tool'));fs.symlinkSync('/etc/hosts',path.join(copy,'runtime','engine/node_modules/.bin/tool'));assert.throws(()=>verifyInventory(copy,manifest,source));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('storage words and external capture pins are mandatory before any archived import',async()=>{
  storageWords({x:{storage:{['0x'+'00'.repeat(32)]:'0x'+'00'.repeat(31)+'07'}}});assert.throws(()=>storageWords({x:{storage:{'0x0':'0x7'}}}));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kzg-audit-pins-'));try{await assert.rejects(verifyEvidence({captureDirectory:directory}));}finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('sealed fixed16 packet verifies independently without target execution',async()=>{
  const report=await verifyEvidence({captureDirectory:capture,...pins});
  assert.deepEqual(report.counts,{matched:16,mismatched:0,unavailable:0,unattempted:0});assert.equal(report.rows.length,16);
  assert.equal(report.limitations.targetReexecutions,0);assert.equal(report.limitations.gethGasReturnReceiptsCompared,false);
  assert.equal(report.limitations.sidecarsKZGVerified,false);assert.equal(report.limitations.wholeBlobValidityVerified,false);
  assert.equal(report.limitations.blockBodyCapacityVerified,false);
  await assert.rejects(verifyEvidence({captureDirectory:capture,...pins,expectedManifestSha256:'0'.repeat(64)}));
});

test('relocated sealed copy retains failures and rejects resealed semantic substitutions',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kzg-audit-copy-')),copy=path.join(directory,'capture');
  fs.cpSync(capture,copy,{recursive:true,dereference:false,verbatimSymlinks:true});
  const read=p=>fs.readFileSync(path.join(copy,p)),json=p=>JSON.parse(read(p)),write=(p,v)=>fs.writeFileSync(path.join(copy,p),JSON.stringify(v,null,2)+'\n');
  const originalManifest=read('manifest.json'),seal=()=>{const m=JSON.parse(originalManifest);for(const f of m.files){const b=read(f.path);f.bytes=b.length;f.sha256=sha(b);}write('manifest.json',m);return sha(read('manifest.json'));};
  const verify=()=>verifyEvidence({captureDirectory:copy,...pins,expectedManifestSha256:seal()});
  try{
    assert.deepEqual((await verifyEvidence({captureDirectory:copy,...pins})).counts,{matched:16,mismatched:0,unavailable:0,unattempted:0});
    for(const[name,mutate]of [
      ['results.json',r=>r.counts.matched=15],['raw/001.json',r=>r.args[3]='/relocated/replacement.json'],
      ['geth-inputs/001.json',r=>r.cancun_direct_official_point.transaction.data[0]='0x'],
      ['geth-inputs/001.json',r=>r.cancun_direct_official_point.post.Cancun[0].hash='0x'+'77'.repeat(32)],
      ['geth-inputs/001.json',r=>r.cancun_direct_official_point.transaction.maxFeePerGas='0xe'],
    ]){const old=read(name),value=JSON.parse(old);mutate(value);write(name,value);await assert.rejects(verify());fs.writeFileSync(path.join(copy,name),old);}
    // Synthetic negative: a false assertion with the same displayed root must
    // remain a mismatch even when every outer artifact hash is recomputed.
    const oldRaw=read('raw/001.json'),oldResults=read('results.json'),r=JSON.parse(oldRaw),body=JSON.parse(Buffer.from(r.stdout.base64,'base64').toString());
    body[0].pass=false;body[0].error='synthetic tamper control: assertion failed';r.stdout=stream(JSON.stringify(body));write('raw/001.json',r);
    await assert.rejects(verify());
    const results=JSON.parse(oldResults);results.rows[0]={...results.rows[0],status:'mismatched',checks:{stateRoot:true,internalLogHash:false},result:body[0]};results.counts.matched=15;results.counts.mismatched=1;write('results.json',results);
    const failure=await verify();assert.deepEqual(failure.counts,{matched:15,mismatched:1,unavailable:0,unattempted:0});assert.equal(failure.rows[0].logAssertionEstablished,false);
    fs.writeFileSync(path.join(copy,'raw/001.json'),oldRaw);fs.writeFileSync(path.join(copy,'results.json'),oldResults);
    const name='results/001-product.json',sealName='results/001-PRODUCT_SEALED.json',product=json(name),address=Object.keys(product.result.attempt.inputs.accounts)[0];
    product.result.attempt.inputs.accounts[address].balance='1';product.raw.stdout=stream(JSON.stringify(product.result)+'\n');write(name,product);
    const productSeal=json(sealName),bytes=read(name);productSeal.bytes=bytes.length;productSeal.sha256=sha(bytes);write(sealName,productSeal);
    await assert.rejects(verify());
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});


test('independent KZG declarations reject altered proof bytes, nested modes, fee context and prestate',()=>{
  const official=fs.readFileSync(path.join(capture,'runtime/engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/pointEvaluation.json'));
  for(const index of [5,11,13]){
    const input=JSON.parse(fs.readFileSync(path.join(capture,'inputs/'+String(index+1).padStart(3,'0')+'.json')));
    bindKzgDeclaration(input,index,official);
    for(const mutate of [
      x=>{x.request.data=x.request.data.slice(0,-2)+'01';},
      x=>{x.request.to='0x'+'55'.repeat(20);},x=>{x.request.gas='199999';},x=>{x.request.value='20';},
      x=>{x.header.excessBlobGas='0x1';},x=>{x.fork='Prague';},
      x=>{x.allocation['0x4444444444444444444444444444444444444444'].code='0x00ff';},
      x=>{x.allocation[x.request.from].balance='0x1';},
    ]){const bad=structuredClone(input);mutate(bad);assert.throws(()=>bindKzgDeclaration(bad,index,official));}
    assert.throws(()=>bindKzgDeclaration(input,index,Buffer.concat([official,Buffer.from(' ')])));
  }
});
