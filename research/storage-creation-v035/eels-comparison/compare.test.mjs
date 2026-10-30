// Artifact-only controls. No producer worker or target client is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT,PINS,CHANNELS,primitives,eelsObservation,comparePair,compareSaved} from './compare.mjs';
const cap=path.join(ROOT,'research/storage-creation-v035/eels-comparison/capture');
const read=p=>JSON.parse(fs.readFileSync(p)),put=(p,o)=>fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n');
const sha=b=>createHash('sha256').update(b).digest('hex');
const input=read(path.join(cap,'inputs/001.json')),saved=read(path.join(cap,'001.stdout'));
const crypto=await primitives();

test('saved six-case packet binds old/new artifacts and preserves each disagreement',async()=>{
 const r=await compareSaved();assert.equal(r.rows.length,6);assert.equal(r.checks.eelsReconstructedStateRoots,6);
 assert.equal(r.aggregate.product.matchedCases,4);assert.equal(r.aggregate.product.unavailableCases,2);
 assert.equal(r.aggregate.ethereumjs.mismatchedCases,2);assert.equal(r.aggregate.geth.mismatchedCases,2);
 for(const peer of Object.values(r.aggregate))assert.equal(peer.matchedCases+peer.mismatchedCases+peer.unavailableCases+peer.partialCases,6);
 assert.deepEqual(r.rows[0].comparisons.eels_geth,{executionStatus:true,returnData:true,chargedGas:false,singleTransactionBlockGasUsed:false,stateRoot:false,target:false,logs:true});
});

test('allocation and duplicate target facts cannot be changed without failing independent joins',async()=>{
 for(const mutate of[
  x=>{x.allocation[input.target].balance='0x17';},
  x=>{x.target.storage['991']='123456';},
  x=>{x.target.account.nonce='0x2';},
  x=>{x.allocation[input.target].storage['0x'+'00'.repeat(32)]='0x'+'00'.repeat(32);},
 ]){const x=structuredClone(saved);mutate(x);await assert.rejects(eelsObservation(input,x,crypto));}
});

test('receipt status, charged gas, exact logs, bloom and trie root remain joined',async()=>{
 for(const mutate of[
  x=>{x.receipt.chargedGas=(BigInt(x.receipt.chargedGas)+1n).toString();},
  x=>{x.receipt.status='failed';},
  x=>{x.receipt.logs[0].data='0x'+'00'.repeat(32);},
  x=>{x.receiptsRoot='0x'+'00'.repeat(32);},
  x=>{x.transactionsRoot='0x'+'00'.repeat(32);},
 ]){const x=structuredClone(saved);mutate(x);await assert.rejects(eelsObservation(input,x,crypto));}
});

test('gas dimensions, signed input and trace/receipt status inconsistencies are rejected',async()=>{
 for(const mutate of[
  x=>{x.blockGasUsed=x.receipt.chargedGas;},
  x=>{x.blockStateGasUsed='-1';},
  x=>{x.signedBytes=x.signedBytes.slice(0,-2)+'00';},
  x=>{x.transactionEnd.error={type:'Revert',message:''};},
 ]){const x=structuredClone(saved);mutate(x);await assert.rejects(eelsObservation(input,x,crypto));}
});

test('missing return event stays unknown and unsupported peers never acquire comparisons',async()=>{
 const x=structuredClone(saved);x.transactionEnd=null;x.returnDataAvailability='unavailable_no_TransactionEnd_event';
 const missing=await eelsObservation(input,x,crypto),complete=await eelsObservation(input,saved,crypto);
 assert.equal(comparePair(missing,complete).returnData,null);assert.equal(comparePair(missing,complete).stateRoot,true);
 assert.deepEqual(comparePair(complete,null),Object.fromEntries(CHANNELS.map(k=>[k,null])));
 const changed={...complete,chargedGas:'1'};assert.equal(comparePair(complete,changed).chargedGas,false);
});

function reseal(directory,changed){
 const m=read(path.join(directory,'manifest.json'));
 for(const relative of changed){const p=path.join(directory,relative),old=m.files.find(f=>f.path===relative);assert(old);old.bytes=fs.statSync(p).size;old.sha256=sha(fs.readFileSync(p));}
 put(path.join(directory,'manifest.json'),m);return{...PINS,manifest:sha(fs.readFileSync(path.join(directory,'manifest.json')))};
}
test('a resealed raw output/progress ledger cannot forge target observations',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'eels-artifact-control-'));
 try{
  fs.cpSync(cap,directory,{recursive:true});const x=read(path.join(directory,'001.stdout'));x.target.storage['1']='123456';put(path.join(directory,'001.stdout'),x);
  const p=read(path.join(directory,'001-process.json'));p.stdout.bytes=fs.statSync(path.join(directory,'001.stdout')).size;p.stdout.sha256=sha(fs.readFileSync(path.join(directory,'001.stdout')));put(path.join(directory,'001-process.json'),p);
  const r=read(path.join(directory,'results.json'));r.totalRawBytes+=p.stdout.bytes-fs.statSync(path.join(cap,'001.stdout')).size;put(path.join(directory,'results.json'),r);
  const pins=reseal(directory,['001.stdout','001-process.json','results.json']);await assert.rejects(compareSaved({capture:directory,pins}));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('a resealed process cannot substitute another declaration argument',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'eels-argv-control-'));
 try{
  fs.cpSync(cap,directory,{recursive:true});const p=read(path.join(directory,'001-process.json'));p.argv[4]=p.argv[4].replace('001.json','002.json');put(path.join(directory,'001-process.json'),p);
  const pins=reseal(directory,['001-process.json']);await assert.rejects(compareSaved({capture:directory,pins}));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
