// Fabricated artifact controls only; no capture evaluation or target execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sha,rawBytes,processRecord,checkFiles,list,normalize,applyDelta,compare,target,assertRollback,verifyInputRecords} from './review.mjs';
const A='0x'+'11'.repeat(20),H='0x'+'22'.repeat(32),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const pack=s=>{const b=Buffer.from(s);return{base64:b.toString('base64'),bytes:b.length,sha256:sha(b)};};
const raw=()=>({process:{status:0,signal:null,error:null,timeoutMs:15000,wallElapsedMs:2,elapsedMs:1},stdout:pack('{"ok":true}'),stderr:pack('')});
test('raw stream identities and failed Node processes remain distinct from parsed success',()=>{
 const good=raw();assert.equal(processRecord(good).clean,true);
 const failed=raw();failed.process.status=1;failed.stdout=pack('');failed.stderr=pack('AssertionError: declaration differs');
 const seen=processRecord(failed);assert.equal(seen.clean,false);assert.equal(seen.stdout.length,0);assert(seen.stderr.length>0);
 for(const mutate of[r=>r.stdout.bytes++,r=>r.stdout.sha256='0'.repeat(64),r=>r.stdout.base64+='!',r=>r.process.elapsedMs=15001,r=>r.process.error={code:'ENOBUFS'}]){const r=raw();mutate(r);assert.throws(()=>processRecord(r));}
 assert.throws(()=>rawBytes({...pack('x'),base64:'eA== '}));
});
test('file inventory rejects modified bytes, duplicate paths and replaced links after relocation',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'storage-review-'));
 try{const dir=path.join(temp,'one');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'a'),'x');fs.symlinkSync('a',path.join(dir,'b'));
  const files=[{path:'a',kind:'file',bytes:1,sha256:sha('x'),mode:fs.statSync(path.join(dir,'a')).mode&511},{path:'b',kind:'symlink',target:'a'}];
  checkFiles(dir,files);const moved=path.join(temp,'two');fs.renameSync(dir,moved);checkFiles(moved,files);assert.deepEqual(list(moved),['a','b']);
  assert.throws(()=>checkFiles(moved,[...files,files[0]]));assert.throws(()=>checkFiles(moved,[{...files[0],path:'../escape'}]));
  fs.writeFileSync(path.join(moved,'a'),'y');assert.throws(()=>checkFiles(moved,files));fs.writeFileSync(path.join(moved,'a'),'x');fs.unlinkSync(path.join(moved,'b'));fs.symlinkSync('missing',path.join(moved,'b'));assert.throws(()=>checkFiles(moved,files));
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('delta reconstruction preserves undemanded storage and rejects forged baselines or resets',()=>{
 const alloc={[A]:{nonce:'0x0',balance:'0x11',code:'0x',storage:{[word(991)]:word(123456)}}};
 const delta={accounts:[{address:A,balance:{before:'0x11',after:'0x16'},storage:[{slot:word(1),before:word(0),after:word(123456)}]}]};
 const out=applyDelta(alloc,delta);assert.equal(out[A].storage[word(991)],word(123456));assert.equal(out[A].storage[word(1)],word(123456));assert.equal(out[A].balance,'0x16');assert.deepEqual(applyDelta(alloc,{accounts:[]}),normalize(alloc));
 for(const mutate of[d=>d.accounts[0].balance.before='0x12',d=>d.accounts[0].storage[0].before=word(1),d=>d.accounts[0].reset={},d=>d.accounts.push(d.accounts[0]),d=>d.accounts[0].storage.push(d.accounts[0].storage[0])]){const d=structuredClone(delta);mutate(d);assert.throws(()=>applyDelta(alloc,d));}
});
test('missing and unsupported observations retain null comparisons, real disagreement stays false',()=>{
 const good={completedExecution:true,executionStatus:'success',returnData:'0x',gasUsed:'1',singleTransactionBlockGasUsed:'1',stateRoot:H,target:{exists:true},logs:[]};
 const different={...good,gasUsed:'2',target:{exists:false}};
 let pairs=compare({product:null,ethereumjs:good,geth:different});assert(Object.values(pairs.product_geth).every(x=>x===null));assert.equal(pairs.ethereumjs_geth.gasUsed,false);assert.equal(pairs.ethereumjs_geth.executionStatus,true);
 pairs=compare({product:{...good,executionStatus:'unsupported'},ethereumjs:good,geth:good});assert(Object.values(pairs.product_ethereumjs).every(x=>x===null));assert(Object.values(pairs.ethereumjs_geth).every(x=>x===true));
 assert.equal(compare({product:good,ethereumjs:good,geth:{...good,returnData:null}}).product_geth.returnData,null);
});
test('withheld state is bound to empty changes and a rollback root, never an execution prediction',()=>{
 const input={target:A,initialStateRoot:H,sentinel:{slots:['0']},allocation:{[A]:{nonce:'0x0',balance:'0x11',code:'0x',storage:{}}}};
 const allocation=normalize(input.allocation),saved={observation:null,attempt:{changes:{accounts:[]},output:{execution:{status:'unsupported',executionGasUsed:null,returnData:null},logs:[],stateDisposition:'rolled_back'}},withheldState:{scope:'rolled_back_product_attempt_not_execution_prediction',executionStatus:'unsupported',stateDisposition:'rolled_back',rollbackStateRoot:H,target:target(input,allocation),gasAccounting:null}};
 assertRollback(saved,input,allocation,H);saved.attempt.output.gasAccounting=null;assertRollback(saved,input,allocation,H);
 for(const mutate of[s=>s.observation={},s=>s.attempt.output.execution.executionGasUsed='0',s=>s.attempt.output.gasAccounting={},s=>s.attempt.changes.accounts.push({address:A}),s=>s.withheldState.rollbackStateRoot='other']){const s=structuredClone(saved);mutate(s);assert.throws(()=>assertRollback(s,input,allocation,H));}
});
test('proof reply joins bind actual requests, raw results, header context and initial facts',()=>{
 const input={headerHash:H,initialStateRoot:H,header:{hash:H},allocation:{[A]:{nonce:'0x0',balance:'0x11',code:'0x',storage:{}}}},request={method:'eth_getCode',params:[A,{blockHash:H,requireCanonical:true}]},result='0x',text=JSON.stringify(result);
 const evidence={id:1,request,requestText:JSON.stringify(request),requestSha256:sha(JSON.stringify(request)),result,resultBytes:Buffer.byteLength(text),resultSha256:sha(text),status:'received',verification:'verified'};
 const saved={proofRecords:[{...request,result}],attempt:{inputs:{status:'available',context:{chainId:11155111,blockHash:H,stateRoot:H,header:input.header},accounts:{[A]:{exists:true,nonce:'0',balance:'17',code:'0x',storage:{}}}},inputEvidence:[evidence],broker:{calls:1,dispatches:1,records:[{id:1,request,resultBytes:evidence.resultBytes,resultSha256:evidence.resultSha256,status:'received',dispatched:true}]}}};
 verifyInputRecords(input,saved);
 for(const mutate of[s=>s.proofRecords[0].result='0x01',s=>s.attempt.inputEvidence[0].resultSha256='0'.repeat(64),s=>s.attempt.broker.records[0].dispatched=false,s=>s.attempt.inputs.accounts[A].balance='18',s=>s.attempt.inputs.context.blockHash='wrong']){const s=structuredClone(saved);mutate(s);assert.throws(()=>verifyInputRecords(input,s));}
});
