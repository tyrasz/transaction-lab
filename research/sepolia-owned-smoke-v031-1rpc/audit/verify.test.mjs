import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvidence } from './verify.mjs';
import { verifySavedSenderProof } from './sender-proof.mjs';
import { verifyStateProof } from '../../../engines/local-evm/verified-state-proof.js';
import { sha, POLICY } from '../run.mjs';
const directory=fileURLToPath(new URL('../capture/',import.meta.url));
const pin='80250020a55703755f9b09330cac8b3b6707f338c71732b3415dd5669a7c2448';
const read=(name,dir=directory)=>JSON.parse(fs.readFileSync(path.join(dir,name)));
function reseal(dir) {
  const manifest=read('manifest.json',dir);
  for(const row of manifest.files){const b=fs.readFileSync(path.join(dir,row.path));row.bytes=b.length;row.sha256=sha(b);}
  const b=JSON.stringify(manifest,null,2)+'\n';fs.writeFileSync(path.join(dir,'manifest.json'),b);return sha(b);
}
async function mutated(fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sepolia-artifact-'));
  try{fs.cpSync(directory,dir,{recursive:true});fn(dir);await assert.rejects(verifyEvidence({directory:dir,manifestSha256:reseal(dir)}));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('retained non-200 null-id error is accepted only as unavailable artifact evidence',async()=>{
  const r=await verifyEvidence({directory,manifestSha256:pin});assert.equal(r.usable,false);assert.equal(r.verifiedAccounts,0);assert.equal(r.native,null);
});
test('re-sealed non-200 result and fabricated usable flag both reject',async()=>{
  await mutated(dir=>{const row=read('wire-05.json',dir);const raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:null,result:null}));row.responseBase64=raw.toString('base64');row.responseBytes=raw.length;row.responseSha256=sha(raw);fs.writeFileSync(path.join(dir,'wire-05.json'),JSON.stringify(row));});
  await mutated(dir=>{const r=read('results.json',dir);r.usable=true;fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(r));});
});
test('saved sender account proof verifies independently of the incomplete engine input pair',async()=>{
  const r=await verifySavedSenderProof({directory,manifestSha256:pin});assert.equal(r.fact.account.balanceRaw,'13136158997187517584658');assert.equal(r.fact.account.nonceRaw,'748694');assert.equal(r.balanceTestEth,'13136.158997187517584658');assert.equal(r.emptyRuntimeCommitted,true);assert.equal(r.codeRpcReceived,false);assert.equal(r.engineAcceptedAccountCodePairs,0);assert.equal(r.vmSteps,0);assert.equal(r.finalHeaderConfirmed,false);
});
test('balance, root and code-hash alterations cannot pass the saved MPT proof',async()=>{
  const header=read('header.json'),wire=read('wire-03.json'),proof=JSON.parse(Buffer.from(wire.responseBase64,'base64')).result;
  for(const alter of [x=>x.proof.balance='0x1',x=>x.stateRoot='0x'+'11'.repeat(32),x=>x.proof.codeHash='0x'+'00'.repeat(32)]){
    const input={stateRoot:header.stateRoot,address:POLICY.sender,storageKeys:[],proof:structuredClone(proof)};alter(input);await assert.rejects(verifyStateProof(input));
  }
});
