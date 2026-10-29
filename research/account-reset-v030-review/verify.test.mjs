import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {audit,primitives,DEFAULT_CAPTURE,checkEntry} from './verify.mjs';
import {sha,word,processResult,signedInput,applyAllocation,comparePrefix,executionGas} from './checks.mjs';
const get=p=>JSON.parse(fs.readFileSync(path.join(DEFAULT_CAPTURE,p)));
const libs=await primitives(),input=get('inputs/001.json'),common=libs.feeCommon(input),product=get('product/001.json');
const root=async a=>libs.bytesToHex(await(await libs.loadState(a,common)).getStateRoot());

test('complete artifact-only audit preserves five matched and ten unavailable, without VM or Geth',async()=>{
 const r=await audit();assert.deepEqual(r.counts,{matched:5,mismatched:0,unavailable:10,not_attempted:0});assert.equal(r.verified.proofCalls,27);assert.equal(r.verified.emptyLaterTraces,18);assert.equal(r.scope.auditExecutedVm,false);assert.equal(r.scope.auditExecutedGeth,false);
});
test('raw process parsed result, stream bytes, process bounds and late success cannot be substituted',()=>{
 for(const alter of [x=>x.result.steps[0].output.execution.returnData='0x01',x=>x.stdout.sha256='0'.repeat(64),x=>x.process.error={code:'ENOBUFS'},x=>x.process.wallElapsedMs=15001]){const p=structuredClone(product);alter(p);assert.throws(()=>processResult(p));}
});
test('signed sender value nonce and ordered prefix bodies are independently bound',()=>{
 signedInput(input,{...libs,common});for(const alter of [x=>x.requests[0].value='1',x=>x.signed[0].nonce='2',x=>x.prefixBodies.reverse(),x=>x.signed[0].bytes=x.signed[0].bytes.slice(0,-2)+'00']){const x=structuredClone(input);alter(x);assert.throws(()=>signedInput(x,{...libs,common}));}
});
test('proof reported balance or supplied code cannot override authenticated account facts',async()=>{
 const r=product.result.proofRecords.find(r=>r.method==='eth_getProof'),code=product.result.proofRecords.find(c=>c.method==='eth_getCode'&&c.params[0]===r.params[0]).result;
 const args={stateRoot:input.header.stateRoot,address:r.params[0],storageKeys:r.params[1],proof:r.result,code};await libs.verifyStateProof(args);
 const forged=structuredClone(args);forged.proof.balance='0x1';await assert.rejects(libs.verifyStateProof(forged));await assert.rejects(libs.verifyStateProof({...args,code:'0x00'}));
 const facts=structuredClone(product.result.inputs),address=Object.keys(facts.accounts)[0];facts.accounts[address].balance='1';await assert.rejects(libs.validateInputFacts({inputs:facts,inputEvidence:product.result.inputEvidence,stateRoot:input.header.stateRoot}));
});
test('reset namespace retains old-equal code nonce and writes but clears untouched hidden slots',async()=>{
 const address='0x'+'33'.repeat(20),initial={nonce:'0x3',balance:'0x7',code:'0x6000',storage:{[word(0)]:word(5),[word(99)]:word(9)}},f={allocation:{[address]:initial}},s=await libs.loadState(f.allocation,common),storageRoot=libs.bytesToHex((await s.getAccount(libs.createAddressFromString(address))).storageRoot),roots=new Map([[address,storageRoot]]);
 const changes={scope:'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.',accounts:[{address,reset:{basis:'shanghai_selfdestruct_deletion',initialStorageRoot:storageRoot},storage:[{slot:word(0),before:word(0),after:word(5)}]}]};
 const applied=applyAllocation(f,changes,roots);assert.equal(applied[address].nonce,initial.nonce);assert.equal(applied[address].code,initial.code);assert.deepEqual(applied[address].storage,{[word(0)]:'0x5'});
 assert.equal(await root(applied),await root({[address]:{...initial,storage:{[word(0)]:word(5)}}}));assert.notEqual(await root(applied),await root(f.allocation));
 const wrongRoot=structuredClone(changes);wrongRoot.accounts[0].reset.initialStorageRoot='0x'+'00'.repeat(32);assert.throws(()=>applyAllocation(f,wrongRoot,roots));
 const oldBefore=structuredClone(changes);oldBefore.accounts[0].storage[0].before=word(5);assert.throws(()=>applyAllocation(f,oldBefore,roots));
 const omittedWrite=structuredClone(changes);delete omittedWrite.accounts[0].storage;assert.notEqual(await root(applyAllocation(f,omittedWrite,roots)),await root(applied));
});
test('captured deletion applies to entire account rather than enumerated slots',async()=>{
 const step=product.result.steps[0],roots=new Map(),applied=applyAllocation(input,step.changes,roots);const removed=step.changes.accounts.find(a=>a.existence?.after===false);assert(removed);assert.equal(applied[removed.address],undefined);assert.equal(await root(applied),get('expectations/001.json').result.steps[0].stateRoot);
 const omitted=structuredClone(step.changes);omitted.accounts=omitted.accounts.filter(a=>a.address!==removed.address);assert.notEqual(await root(applyAllocation(input,omitted,roots)),await root(applied));
});
test('receipt failures and return mismatches remain mismatched despite matching full root',()=>{
 const expected=get('expectations/001.json').result.steps,dir='geth/001-01',saved={result:get(`${dir}/result.json`),body:get(`${dir}/body.rlp`),traces:[get(`${dir}/trace-0-${input.signed[0].hash}.json`)]};assert.equal(comparePrefix(input,1,expected,saved).status,'matched');
 const bad=structuredClone(saved);bad.result.receipts[0].status='0x0';assert.equal(comparePrefix(input,1,expected,bad).status,'mismatched');
 const output=structuredClone(saved);output.traces[0].output='0x1234';assert.equal(comparePrefix(input,1,expected,output).channels.returnData,false);
 const empty=structuredClone(saved);empty.traces=[null];assert.throws(()=>comparePrefix(input,1,expected,empty));
});
test('independent gas derivation rejects fabricated charged gas and refund',()=>{
 const good=product.result.steps[0].output;executionGas(input.requests[0],good);for(const alter of [o=>o.gasAccounting.gasUsed='1',o=>o.feeAccounting.chargedGas='1',o=>o.execution.gasRefundCounter='10000']){const x=structuredClone(good);alter(x);assert.throws(()=>executionGas(input.requests[0],x));}
});
test('inventory rejects same-size byte edits, unsafe paths and escaping symlinks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reset-audit-control-'));try{fs.writeFileSync(path.join(dir,'x'),'abc');const e={path:'x',kind:'file',bytes:3,sha256:sha('abc')};checkEntry(dir,e);fs.writeFileSync(path.join(dir,'x'),'abd');assert.throws(()=>checkEntry(dir,e));assert.throws(()=>checkEntry(dir,{...e,path:'../x'}));fs.symlinkSync('/tmp',path.join(dir,'link'));assert.throws(()=>checkEntry(dir,{path:'link',kind:'symlink',target:'/tmp'}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
