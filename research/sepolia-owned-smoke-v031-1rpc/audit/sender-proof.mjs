// Artifact-only account proof audit. No RPC, code-fetch substitution, or execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { verifyEvidence } from './verify.mjs';
import { verifyStateProof, EMPTY_CODE_HASH } from '../../../engines/local-evm/verified-state-proof.js';
import { verifyEthereumHeader } from '../../../engines/local-evm/ethereum-header.js';
import { POLICY, sha } from '../run.mjs';

export async function verifySavedSenderProof({directory,manifestSha256}) {
  const evidence = await verifyEvidence({directory,manifestSha256});
  const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name)));
  const header=read('header.json'), wire=read('wire-03.json');
  const headerVerification=verifyEthereumHeader({header,expectedHash:header.hash,chainId:11155111});
  assert.equal(wire.httpStatus,200); assert.equal(wire.completeBody,true);
  const request=JSON.parse(wire.requestText), response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(wire.responseBase64,'base64')));
  assert.deepEqual(request,{jsonrpc:'2.0',id:3,method:'eth_getProof',params:[POLICY.sender,[],{blockHash:header.hash,requireCanonical:true}]});
  assert.equal(response.id,3); assert(Object.hasOwn(response,'result')&&!Object.hasOwn(response,'error'));
  const proof=response.result;
  const fact=await verifyStateProof({stateRoot:header.stateRoot,address:POLICY.sender,storageKeys:[],proof});
  assert.equal(fact.code.status,'unknown');
  // The authenticated account commits to keccak256(empty bytes). This fact
  // does not turn the refused eth_getCode call into a received engine input.
  assert.equal(fact.account.codeHash,EMPTY_CODE_HASH);
  const emptyPreimage=await verifyStateProof({stateRoot:header.stateRoot,address:POLICY.sender,storageKeys:[],proof,code:'0x'});
  assert.equal(emptyPreimage.code.status,'verified');
  const balance=BigInt(fact.account.balanceRaw), scale=10n**18n;
  const exactEth=(balance/scale).toString()+'.'+(balance%scale).toString().padStart(18,'0');
  const preview=read('preview.json');
  assert.equal(Object.keys(preview.preview.inputs.accounts).length,0);
  assert.equal(preview.preview.usage.steps,0); assert.equal(preview.preview.usage.frames,0);
  assert.equal(preview.preview.inputUsage.accounts,0); assert.equal(evidence.usable,false);
  assert.equal(read('results.json').headerConfirmed,false);
  return {artifactOnly:true,networkRequests:0,targetReexecuted:false,manifestSha256,
    sourceSha256:evidence.sourceSha256,headerVerification,blockNumber:BigInt(header.number).toString(),blockHash:header.hash,stateRoot:header.stateRoot,
    sender:POLICY.sender,proofWireSha256:sha(fs.readFileSync(path.join(directory,'wire-03.json'))),proofNodes:proof.accountProof.length,
    fact,balanceTestEth:exactEth,emptyRuntimeCommitted:true,emptyRuntimeBasis:'authenticated_codeHash_equals_keccak256_empty_bytes',
    codeRpcReceived:false,engineAcceptedAccountCodePairs:0,vmSteps:0,finalHeaderConfirmed:false,
    scope:'Account membership and fields against the selected provider-supplied header stateRoot; no consensus/finality attestation, complete engine input, execution or before/after measurement.'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) console.log(JSON.stringify(await verifySavedSenderProof({directory:process.argv[2],manifestSha256:process.argv[3]}),null,2));
