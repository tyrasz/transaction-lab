// Fabricated helper controls only; never reads or evaluates the capture.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {applyDelta,verifyInputs} from './review.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),address='0x'+'11'.repeat(20);
test('independent scalar/code delta application binds immutable before-values and rejects unsupported namespaces',()=>{
 const alloc={[address]:{balance:'0x7',nonce:'0x1',code:'0x',storage:{}}},changes={accounts:[{address,nonce:{before:'0x1',after:'0x2'},code:{before:'0x',after:'0xef0100'+'22'.repeat(20)}}]};
 const result=applyDelta(alloc,changes);assert.equal(result[address].nonce,'0x2');assert.equal(result[address].code,changes.accounts[0].code.after);assert.equal(alloc[address].nonce,'0x1');
 for(const mutation of[r=>r.nonce.before='0x0',r=>r.code.before='0xfe',r=>r.reset={},r=>r.storage=[]]){const c=structuredClone(changes);mutation(c.accounts[0]);assert.throws(()=>applyDelta(alloc,c));}
 assert.throws(()=>applyDelta(alloc,{accounts:[...changes.accounts,...changes.accounts]}));
});
test('saved input replies must bind trusted chain, exact request/result bytes and broker evidence',()=>{
 const input={chainId:1,headerHash:'0x'+'33'.repeat(32),initialStateRoot:'0x'+'44'.repeat(32),header:{synthetic:true}},request={method:'eth_getCode',params:[address,{blockHash:input.headerHash,requireCanonical:true}]},result='0xef0100',requestText=JSON.stringify(request),resultText=JSON.stringify(result);
 const evidence={id:1,request,requestText,requestSha256:sha(requestText),result,resultBytes:Buffer.byteLength(resultText),resultSha256:sha(resultText),status:'received',verification:'verified'};
 const saved={proofRecords:[{...request,result}],attempt:{inputs:{status:'available',context:{chainId:1,blockHash:input.headerHash,stateRoot:input.initialStateRoot,header:input.header}},inputEvidence:[evidence],broker:{calls:1,dispatches:1,records:[{...evidence,dispatched:true}]}}};
 verifyInputs(input,saved,sha);
 for(const mutate of[x=>x.attempt.inputs.context.chainId=11155111,x=>x.proofRecords[0].result='0x',x=>x.attempt.inputEvidence[0].resultSha256='0'.repeat(64),x=>x.attempt.broker.records[0].dispatched=false]){const x=structuredClone(saved);mutate(x);assert.throws(()=>verifyInputs(input,x,sha));}
});
