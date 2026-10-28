import test from 'node:test';
import assert from 'node:assert/strict';
import {audit,playback} from './verify.mjs';
test('both saved proof-backed child executions reproduce all five channels at the newly selected states',async()=>{const r=await audit();assert.equal(r.unjoinedRecords,0);assert.equal(r.localWorkerExecutions,2);assert.deepEqual(r.cases.map(c=>[c.id,c.execution,c.gas]),[['002','reverted','317368'],['007','success','21000']]);});
test('corrupt proof cannot be repaired by expected outputs and leaves no retained state',async()=>{assert.equal((await audit({negativeProof:true})).status,'negative_control_rejected_corrupted_proof');});
test('saved adapter rejects wrong selector or extra query instead of fabricating a state response',async()=>{const row={status:'completed',request:{method:'eth_getCode',params:['0x1',{blockHash:'fixed',requireCanonical:true}]},parsed:{result:'0x'}};const wrong=playback([row]);await assert.rejects(wrong.call('eth_getCode',['0x1',{blockHash:'changed',requireCanonical:true}]));assert(wrong.mismatch);const empty=playback([]);await assert.rejects(empty.call('eth_getCode',row.request.params));assert(empty.mismatch);});
