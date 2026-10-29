// Fabricated data and MPT arithmetic only. Never calls verify() or executes VM/Geth.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RLP} from '../../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {createMPT} from '../../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {sha,DUMMY,rawBytes,processRecord,logsCanonical,logFacts,classify,verifyEntry,normalizeAlloc,applyDelta,rootOf} from './verify.mjs';
const crypto={RLP,keccak,createMPT},clone=structuredClone,z32='0x'+'00'.repeat(32),a='0x'+'11'.repeat(20);
const pack=b=>{b=Buffer.from(typeof b==='string'?b:JSON.stringify(b));return{bytes:b.length,sha256:sha(b),base64:b.toString('base64')};};
function sample(nonempty=true){
 const input={id:'fabricated',transactionHash:'0x'+'22'.repeat(32),initialStateRoot:z32,transactionBody:'0x01',request:{gas:'5000000'},environment:{currentNumber:'0x1',currentTimestamp:'0x2',currentBaseFee:'0x7'}};
 const logs=nonempty?[{address:a,topics:['0x'+'33'.repeat(32)],data:'0x00'}]:[],facts=logFacts(logs,crypto),gas={totalGasSpent:'50000',txRegularGas:'30000',txStateGas:'20000'};
 const output={logs,execution:{status:'success'},gasAccounting:{gasUsed:'50000'},stateGasAccounting:{settled:{regularGasUsed:'30000',stateGasUsed:'20000'}}};
 const product={id:input.id,processClosureValid:true,attempt:{status:'completed',output,isolation:{processClosed:true},broker:{pendingAtReturn:0}},comparisonInput:{id:input.id,transactionHash:input.transactionHash,initialStateRoot:z32,stateRoot:z32,execution:{logsHash:facts.hash},receipt:{status:1},gas}};
 const receipt={type:'0x2',transactionHash:input.transactionHash,blockHash:DUMMY,blockNumber:'0x1',transactionIndex:'0x0',status:'0x1',gasUsed:'0xc350',cumulativeGasUsed:'0xc350',logsBloom:facts.bloom,logs:logs.map((l,i)=>({...clone(l),blockNumber:'0x1',transactionHash:input.transactionHash,transactionIndex:'0x0',blockHash:DUMMY,blockTimestamp:'0x2',logIndex:'0x'+i.toString(16),removed:false}))};
 const outputs={body:'0x01',result:{receipts:[receipt],stateRoot:z32,logsHash:facts.hash,logsBloom:facts.bloom,requests:[],blobGasUsed:'0x0',currentBaseFee:'0x7',currentDifficulty:null,gasUsed:'0x7530'}};
 return{input,product,outputs};
}
test('fabricated empty and nonempty log receipts match original five fields plus payload and bloom',()=>{
 for(const present of[false,true]){const{input,product,outputs}=sample(present),r=classify(input,product,outputs,crypto);assert.equal(r.status,'matched');assert.equal(r.exactReceiptLogs,true);assert.equal(r.bloomMatches,true);assert.equal(r.productLogs.length,present?1:0);}
 assert.equal(logFacts([],crypto).hash,'0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347');assert.equal(logFacts([],crypto).bloom,'0x'+'00'.repeat(256));
});
test('self-consistent changed native log payload is a disagreement, not malformed or matched',()=>{
 const{input,product,outputs}=sample();outputs.result.receipts[0].logs[0].data='0x01';const logs=logsCanonical(outputs.result.receipts[0].logs,input,true),f=logFacts(logs,crypto);outputs.result.logsHash=f.hash;outputs.result.logsBloom=outputs.result.receipts[0].logsBloom=f.bloom;
 const r=classify(input,product,outputs,crypto);assert.equal(r.status,'mismatched');assert.equal(r.channels.logsHash,false);assert.equal(r.exactReceiptLogs,false);assert.equal(r.bloomMatches,true);
});
test('missing/malformed/unbound log data and inconsistent hashes or blooms never match',()=>{
 for(const mutation of[o=>{delete o.result.receipts[0].logs;},o=>{o.result.receipts[0].logs=null;},o=>{o.result.receipts[0].logs[0].address='0x01';},o=>{o.result.receipts[0].logs[0].topics=['0x'];},o=>{o.result.receipts[0].logs[0].data='0x1';},o=>{o.result.receipts[0].logs[0].transactionHash=z32;},o=>{o.result.receipts[0].logs[0].blockHash=z32;},o=>{o.result.receipts[0].logs[0].blockTimestamp='0x3';},o=>{o.result.receipts[0].logs[0].logIndex='0x1';},o=>{o.result.receipts[0].logs[0].removed=true;},o=>{o.result.logsHash=z32;},o=>{o.result.receipts[0].logsBloom='0x'+'00'.repeat(256);},o=>{o.result.logsBloom='0x'+'00'.repeat(256);}]){const{input,product,outputs}=sample();mutation(outputs);assert.equal(classify(input,product,outputs,crypto).status,'unavailable');}
 const{input,product,outputs}=sample();product.comparisonInput.execution.logsHash=z32;assert.equal(classify(input,product,outputs,crypto).status,'unavailable');
});
test('root/status/gas disagreements survive and malformed envelopes are unavailable',()=>{
 for(const mutation of[o=>{o.result.stateRoot='0x'+'44'.repeat(32);},o=>{o.result.receipts[0].status='0x0';},o=>{o.result.receipts[0].gasUsed=o.result.receipts[0].cumulativeGasUsed='0xc351';},o=>{o.result.gasUsed='0x7531';}]){const{input,product,outputs}=sample();mutation(outputs);assert.equal(classify(input,product,outputs,crypto).status,'mismatched');}
 for(const mutation of[o=>{o.body='0x';},o=>{o.result.rejected=[{index:0}];},o=>{o.result.receipts=[];},o=>{o.result.currentDifficulty='0x0';}]){const{input,product,outputs}=sample();mutation(outputs);assert.equal(classify(input,product,outputs,crypto).status,'unavailable');}
});
test('raw process bytes, failures, UTF8, elapsed and output caps fail closed; empty Geth stdout is valid',()=>{
 const raw={process:{status:0,signal:null,error:null,timeoutMs:15000,wallElapsedMs:1,elapsedMs:1},stdout:pack({fake:true}),stderr:pack('')};assert.deepEqual(processRecord(raw),{fake:true});assert.equal(processRecord({...raw,stdout:pack('')},false),null);
 for(const p of[{status:1},{signal:'SIGKILL'},{error:{code:'ENOBUFS'}},{elapsedMs:15001},{timeoutMs:0}])assert.throws(()=>processRecord({...raw,process:{...raw.process,...p}}));
 for(const p of[{bytes:1},{sha256:z32},{base64:raw.stdout.base64+'!'}])assert.throws(()=>rawBytes({...raw.stdout,...p}));
 const invalid=Uint8Array.of(255);assert.throws(()=>processRecord({...raw,stdout:{bytes:1,base64:Buffer.from(invalid).toString('base64'),sha256:sha(invalid)}}));
});
test('inventory byte/mode/type and path substitutions are rejected',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'creation-log-check-'));try{const p=path.join(dir,'x');fs.writeFileSync(p,'abc',{mode:0o600});const f={path:'x',kind:'file',mode:0o600,bytes:3,sha256:sha(Buffer.from('abc'))};verifyEntry(dir,f);assert.throws(()=>verifyEntry(dir,{...f,path:'../x'}));fs.chmodSync(p,0o644);assert.throws(()=>verifyEntry(dir,f));fs.chmodSync(p,0o600);fs.writeFileSync(p,'abd');assert.throws(()=>verifyEntry(dir,f));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('fresh MPT arithmetic validates before values and reconstructs independent delta allocation',async()=>{
 const initial=normalizeAlloc({[a]:{nonce:'0x1',balance:'0x9',code:'0x00',storage:{}}}),changes={accounts:[{address:a,balance:{before:'0x9',after:'0x7'},nonce:{before:'0x1',after:'0x2'},storage:[]}]};
 const after=applyDelta(initial,changes),expected=normalizeAlloc({[a]:{nonce:'0x2',balance:'0x7',code:'0x00',storage:{}}});assert.deepEqual(after,expected);assert.equal(await rootOf(after,crypto),await rootOf(expected,crypto));assert.notEqual(await rootOf(initial,crypto),await rootOf(after,crypto));
 const bad=clone(changes);bad.accounts[0].balance.before='0xa';assert.throws(()=>applyDelta(initial,bad));bad.accounts[0].balance.before='0x9';bad.accounts.push(clone(bad.accounts[0]));assert.throws(()=>applyDelta(initial,bad));
 assert.equal(await rootOf({},crypto),'0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
});
