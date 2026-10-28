import test from 'node:test';
import assert from 'node:assert/strict';
import {audit,loadPacket,verifyWire,createPlayback,deriveDeclaredCase,deriveCreateAddress} from './verify.mjs';

const packet=await loadPacket(),plan=packet.get('plan.json');
const wires=Array.from({length:7},(_,i)=>packet.get(`wire/${String(i+1).padStart(6,'0')}.json`));

test('lossless successful wire hashes reject raw bytes, parsed results, IDs and request substitutions',()=>{
  verifyWire(wires[2]);
  for(const mutate of [
    row=>{row.rawBase64=Buffer.from(row.responseText+' ').toString('base64');},
    row=>{row.parsed.result.nonce='0x2';},
    row=>{row.id++;},
    row=>{row.request.params[0]='0x'+'00'.repeat(20);},
  ]){const row=structuredClone(wires[2]);mutate(row);assert.throws(()=>verifyWire(row));}
});

test('retained HTTP rejection cannot be relabelled as completed or carry invented parsed output',()=>{
  verifyWire(wires[6]);
  for(const mutate of [
    row=>{row.status='completed';row.httpStatus=200;row.parsed={jsonrpc:'2.0',id:1,result:{}};},
    row=>{row.httpStatus=200;},
    row=>{row.parsed=JSON.parse(row.responseText);},
    row=>{row.error='execution_reverted';},
    row=>{row.responseText=row.responseText.replace('empty','unsupported');},
  ]){const row=structuredClone(wires[6]);mutate(row);assert.throws(()=>verifyWire(row));}
});

test('proof-only playback rejects reordered reads, extra reads and provider traces',async()=>{
  const rpc=createPlayback(wires.slice(2,6));
  await assert.rejects(rpc.call(wires[3].request.method,wires[3].request.params));
  assert(rpc.mismatch);assert.equal(rpc.consumed,1);
  const empty=createPlayback([]);await assert.rejects(empty.call('eth_getProof',[]));assert(empty.mismatch);
  const trace=createPlayback(wires.slice(6));await assert.rejects(trace.call('debug_traceCall',wires[6].request.params));assert(trace.mismatch);
});

test('CREATE encoding binds explicit null/initcode and independently encodes nonce boundaries',async()=>{
  assert.deepEqual(deriveDeclaredCase(plan.case),{runtimeBytes:11,initcodeBytes:31});
  const {keccak_256}=await packet.frozen('engines/local-evm/node_modules/@noble/hashes/sha3.js');
  const {RLP}=await packet.frozen('engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js');
  for(const nonce of [0n,1n,127n,128n,255n,256n,(1n<<64n)-2n]){
    let digits=nonce===0n?'':nonce.toString(16);if(digits.length%2)digits='0'+digits;
    const encoded=RLP.encode([Buffer.from(plan.case.sender.slice(2),'hex'),Buffer.from(digits,'hex')]);
    const expected='0x'+Buffer.from(keccak_256(encoded)).subarray(12).toString('hex');
    assert.equal(deriveCreateAddress(plan.case.sender,nonce.toString(),keccak_256),expected);
  }
  assert.equal(deriveCreateAddress(plan.case.sender,'1',keccak_256),'0x3be7f950380997a5fbbd6ace42b422c7ef437f1b');
  for(const mutate of [c=>{delete c.request.to;},c=>{c.request.to=plan.case.sender;},c=>{c.initcode=c.initcode.replaceAll('61000b','61000a');},c=>{c.request.data=c.request.data.slice(0,-2)+'01';}]){
    const c=structuredClone(plan.case);mutate(c);assert.throws(()=>deriveDeclaredCase(c));
  }
  for(const nonce of ['01','-1',(1n<<64n).toString()])assert.throws(()=>deriveCreateAddress(plan.case.sender,nonce,keccak_256));
});

test('proof-derived nonce/absence cannot be altered to supply a convenient deployment target',async()=>{
  const header=packet.get('selection.json').header,local=packet.get('local.json').attempt;
  for(const mutate of [
    row=>{row.inputs.accounts[plan.case.sender].nonce='2';},
    row=>{row.inputs.provenance[0].accountProof.nonceRaw='2';},
    row=>{row.inputs.provenance[0].proofEvidenceId=3;},
    row=>{row.inputs.accounts[packet.get('target.json').address]={exists:true,nonce:'0',balance:'0',code:'0x',storage:{}};},
    row=>{row.inputEvidence[0].request.params[2].requireCanonical=false;},
  ]){const changed=structuredClone(local);mutate(changed);await assert.rejects(packet.runner.deriveDeploymentTarget({header,local:changed}));}
});

test('retained provider rejection yields no comparison channels even when local output succeeds',async()=>{
  const header=packet.get('selection.json').header,local=packet.get('local.json').attempt,provider=packet.get('provider.json').records;
  const result=await packet.runner.compareDeployment({header,local,provider});
  assert.deepEqual(result,{status:'unavailable',channels:{},allChannelsComplete:false,reason:'provider_sequence_incomplete',scope:'retained_incomplete_development_comparison'});
  assert.equal(provider.length,1);assert.equal(provider[0].httpStatus,400);
});

test('actual archived worker with a corrupted initial proof becomes unavailable and rolls back',async()=>{
  const result=await audit({negativeProof:true});
  assert.equal(result.status,'corrupted_proof_rejected');assert.equal(result.execution,'unavailable');assert.equal(result.consumedInputReads,1);
});
