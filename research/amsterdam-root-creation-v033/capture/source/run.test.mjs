// Input-only preparation; no worker, EVM, Geth or network execution.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import {HOME,ORIGINAL,INDICES,LIMITS,number,sha,read,original,expectedWorker,bounded,report,unpack} from './protocol.mjs';
test('all six archived declarations roundtrip exactly; only root transaction.to own-undefined fails old assertion',async()=>{
 const o=await original();for(let i=0;i<6;i++){const declaration=await o.cases.declaration(i),saved=read(path.join(ORIGINAL,'inputs/'+number(i)+'.json'));assert.deepEqual(JSON.parse(JSON.stringify(declaration)),saved);
  if(INDICES.includes(i)){assert(Object.hasOwn(declaration.transaction,'to'));assert.equal(declaration.transaction.to,undefined);assert(!Object.hasOwn(saved.transaction,'to'));assert.throws(()=>assert.deepEqual(declaration,saved));const copy={...declaration,transaction:{...declaration.transaction}};delete copy.transaction.to;assert.deepEqual(copy,saved);}
  else assert.deepEqual(declaration,saved);
 }
});
test('corrected worker has only serialization assertion and original-archive import redirects',()=>{assert.equal(fs.readFileSync(path.join(HOME,'worker.mjs'),'utf8'),expectedWorker());});
test('fabricated process records reject error, timeout, output bounds and altered raw evidence',()=>{
 const pack=b=>({bytes:b.length,sha256:sha(b),base64:b.toString('base64')}),r={process:{status:0,signal:null,error:null,timeoutMs:15000,wallMs:1,monotonicMs:1},stdout:pack(Buffer.from('{"fabricated":true}')),stderr:pack(Buffer.alloc(0))};
 assert.deepEqual(report(r),{fabricated:true});for(const p of[{status:1},{signal:'SIGKILL'},{error:{code:'X'}},{wallMs:15001},{monotonicMs:-1},{timeoutMs:0},{error:{code:'ENOBUFS'}}])assert.throws(()=>report({...r,process:{...r.process,...p}}));
 assert(!bounded({...r,stdout:{...r.stdout,bytes:LIMITS.processBytes+1}}));assert.throws(()=>unpack({...r.stdout,sha256:'0'.repeat(64)}));assert.throws(()=>unpack({...r.stdout,base64:r.stdout.base64+'!'}));assert.deepEqual(INDICES,[0,2,4]);assert.equal(LIMITS.processes,6);
});
