import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {diagnosticInput,classify,clean,LIMITS,artifactLedger} from './run.mjs';
const archived=new URL('./original-input.json',import.meta.url),original=JSON.parse(fs.readFileSync(fs.existsSync(archived)?archived:new URL('../capture/inputs/007.json',import.meta.url))),input=diagnosticInput(original),zero='0x'+'00'.repeat(32),root='0x'+'11'.repeat(32);
const stream=s=>{const b=Buffer.from(s);return{base64:b.toString('base64'),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};};
const rows=()=>input.controls.map((c,i)=>({name:c.name,beforeRoot:'0x'+'22'.repeat(32),beforeSlot:i?zero:'0x'+(91).toString(16).padStart(64,'0'),intermediateRoot:root,commitRoot:i?root:zero,commitError:i?null:`unexpected storage wiping, ${input.coinbase.slice(2)}`,accountExistsAfter:false}));
const raw=x=>({exitCode:0,signal:null,error:null,timeoutMs:5000,elapsedMs:1,stdout:stream(JSON.stringify(x)),stderr:stream('')});
test('controls preserve the old input and alter only the second coinbase storage map',()=>{const x=structuredClone(input.controls[1].allocation);x[input.coinbase].storage=structuredClone(original.allocation[input.coinbase].storage);assert.deepEqual(x,original.allocation);assert.deepEqual(input.controls[0].allocation,original.allocation);assert.equal(Object.keys(input.controls[1].allocation[input.coinbase].storage).length,0);assert.equal(input.fork,'Osaka');assert.equal(LIMITS.invocations,1);});
test('classifier independently distinguishes direct commit failure, successful control and other observations',()=>{assert.equal(classify(raw({rows:rows()}),input).status,'corroborated');const changed=rows();changed[0].commitError=null;changed[0].commitRoot=root;assert.equal(classify(raw({rows:changed}),input).status,'different_observation');const other=rows();other[1].commitError='different failure';assert.equal(classify(raw({rows:other}),input).status,'different_observation');});
test('nonzero exits, timeout, bad wire hash and foreign controls cannot corroborate',()=>{const r=raw({rows:rows()});for(const p of [{exitCode:1},{signal:'SIGKILL'},{error:'ETIMEDOUT'},{elapsedMs:5001},{timeoutMs:0}]){assert.equal(clean({...r,...p}),false);assert.equal(classify({...r,...p},input).status,'unavailable');}const bad=structuredClone(r);bad.stdout.sha256='0'.repeat(64);assert.equal(clean(bad),false);const foreign=rows();foreign[0].name='foreign';assert.equal(classify(raw({rows:foreign}),input).status,'unavailable');assert.equal(classify(raw({rows:[rows()[0]]}),input).status,'unavailable');});
test('original case identity and slot controls reject changed inputs before any Go process',()=>{for(const change of [x=>x.name='different',x=>x.fork='Cancun',x=>x.allocation[input.coinbase].nonce='0x1',x=>x.allocation[input.coinbase].storage={}]){const x=structuredClone(original);change(x);assert.throws(()=>diagnosticInput(x));}});
test('artifact ledger binds saved module/build/raw/STARTED/binary identities instead of later modified bytes',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fee-diagnostic-ledger-'));try{
    const ledger=artifactLedger(directory),names=['STARTED.json','modules-before.json','build.json','raw.json','modules-after.json','diagnostic-binary.json'];
    for(const name of names)ledger.save(name,{name,raw:raw({rows:rows()})});fs.writeFileSync(path.join(directory,'diagnostic'),'synthetic binary');ledger.record('diagnostic');assert.equal(ledger.verify(),7);
    for(const name of [...names,'diagnostic']){const p=path.join(directory,name),before=fs.readFileSync(p);fs.writeFileSync(p,'mutated');assert.throws(()=>ledger.verify());fs.writeFileSync(p,before);assert.equal(ledger.verify(),7);}
    assert.throws(()=>ledger.save('raw.json',{}));assert.throws(()=>ledger.record('../escape'));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
