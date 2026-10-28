import test from 'node:test';
import assert from 'node:assert/strict';
import {audit,loadPacket,verifyWire,createPlayback,deriveDeclaredCase} from './verify.mjs';

const packet=await loadPacket(),plan=packet.get('plan.json');
const wires=Array.from({length:11},(_,i)=>packet.get(`wire/${String(i+1).padStart(6,'0')}.json`));

test('lossless wire hashes reject raw bytes, parsed results, IDs and request substitutions',()=>{
  verifyWire(wires[2]);
  for(const mutate of [
    row=>{row.rawBase64=Buffer.from(row.responseText+' ').toString('base64');},
    row=>{row.parsed.result.balance='0x0';},
    row=>{row.id++;},
    row=>{row.request.params[0]=plan.case.target;},
  ]){const row=structuredClone(wires[2]);mutate(row);assert.throws(()=>verifyWire(row));}
});

test('proof-only playback rejects reordered reads, extra reads and provider traces',async()=>{
  const rpc=createPlayback(wires.slice(2,8));
  await assert.rejects(rpc.call(wires[3].request.method,wires[3].request.params));
  assert(rpc.mismatch);assert.equal(rpc.consumed,1);
  const empty=createPlayback([]);await assert.rejects(empty.call('eth_getProof',[]));assert(empty.mismatch);
  const trace=createPlayback(wires.slice(8));await assert.rejects(trace.call('debug_traceCall',wires[8].request.params));assert(trace.mismatch);
});

test('address and ABI derive from exact 11-byte runtime and frozen salt, not output',async()=>{
  const {keccak_256}=await packet.frozen('engines/local-evm/node_modules/@noble/hashes/sha3.js');
  assert.equal(deriveDeclaredCase(plan.case,keccak_256).target,'0xd7de4766a65d3dc6d02766ecadc6ae9a3f5e0039');
  for(const mutate of [c=>{c.target='0x7205e70e3737b772b5d19b093f92c0c1d003474f';},c=>{c.initcode=c.initcode.replaceAll('61000b','61000a');},c=>{c.request.data=c.request.data.slice(0,-2)+'01';}]){
    const c=structuredClone(plan.case);mutate(c);assert.throws(()=>deriveDeclaredCase(c,keccak_256));
  }
});

test('saved provider diff cannot omit creation or alter actual runtime, storage or nonce',async()=>{
  const header=packet.get('selection.json').header,local=packet.get('local.json').attempt,provider=packet.get('provider.json').records;
  for(const mutate of [
    rows=>{rows[1].parsed.result={pre:{},post:{}};},
    rows=>{rows[1].parsed.result.post[plan.case.target].storage={};},
    rows=>{rows[1].parsed.result.post[plan.case.target].code='0x';},
    rows=>{rows[1].parsed.result.post[plan.case.factory].nonce++;},
    rows=>{rows[0].request.params[1].requireCanonical=false;},
  ]){const rows=structuredClone(provider);mutate(rows);const result=await packet.runner.compareLifecycle({header,local,provider:rows});assert.notEqual(result.status,'match');}
});

test('an actual archived worker with a corrupted saved initial proof is unavailable and rolls back',async()=>{
  const result=await audit({negativeProof:true});
  assert.equal(result.status,'corrupted_proof_rejected');assert.equal(result.execution,'unavailable');assert.equal(result.consumedInputReads,1);
});
