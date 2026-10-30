// Projection-only controls: generated initial proofs/headers, no EVM execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSelectedCase } from './projection.mjs';
import { oracleRequests } from './outcomes.mjs';
import { authorizationFixture, signAuthorization, word } from '../../engines/local-evm/test/authorization-fixture.js';
import { shanghaiFixture } from '../../engines/local-evm/test/shanghai-fixture.js';
const HASH='0x'+'12'.repeat(32);
const censusTuple=t=>Object.fromEntries(Object.entries(t).map(([k,v])=>[k,k==='address'?v:BigInt(v).toString()]));
function input(f,changes={}){
  const row={transactionHash:HASH,blockHash:'0x'+'13'.repeat(32),blockNumber:(BigInt(f.header.number)+1n).toString(),transactionIndex:'0',selected:true,parentBlockHash:f.header.hash,parentHeader:f.header};
  const envelope={hash:HASH,from:f.request.from,to:f.request.to,input:f.request.data,value:f.request.value,gas:'100000',type:'4',extensions:{},authorizationList:[censusTuple(signAuthorization())],...changes};
  return {row,census:{selected:[row],envelopes:[{...row,normalizedEnvelope:envelope}]}};
}
test('typed authorization census preserves signed tuple values, order, duplicates and exact oracle representation',async()=>{
  const f=await authorizationFixture({prague:true}),first=signAuthorization(),skip=signAuthorization({chainId:2n,patch:{r:'0x0',yParity:'0xff'}});
  const original=input(f,{authorizationList:[first,skip,first].map(censusTuple),accessList:[{address:first.address,storageKeys:[word(1),word(1)]}]}),before=structuredClone(original);
  const result=projectSelectedCase(original);assert.equal(result.status,'projectable');assert.deepEqual(result.request.authorizationList,[first,skip,first]);assert.deepEqual(original,before);
  assert.equal(result.signatureVerified,false);assert(!result.omittedOuterFields.includes('authorizationList'));
  const requests=oracleRequests({request:result.request,header:f.header});assert.deepEqual(requests[1].params[0].authorizationList,[first,skip,first]);assert.deepEqual(requests[2].params[0],requests[1].params[0]);
});
test('invalid, over-budget and incompatible authorization envelopes remain explicit selected unsupported slots',async()=>{
  const f=await authorizationFixture(),tuple=censusTuple(signAuthorization());
  for(const [change,reason] of [
    [{authorizationList:undefined},'authorization_context_exceeds_profile'],[{authorizationList:[]},'authorization_context_exceeds_profile'],
    [{authorizationList:Array(17).fill(tuple)},'authorization_context_exceeds_profile'],[{type:'2'},'authorization_context_exceeds_profile'],
    [{authorizationList:[{...tuple,nonce:'0x0'}]},'authorization_context_exceeds_profile'],[{authorizationList:[{...tuple,r:'0x1'}]},'authorization_context_exceeds_profile'],
    [{authorizationList:[{...tuple,extra:'x'}]},'authorization_context_exceeds_profile'],[{authorizationList:[{...tuple,nonce:(1n<<64n).toString()}]},'authorization_context_exceeds_profile'],
    [{to:null},'authorization_creation_unsupported'],[{blobVersionedHashes:['0x01'+'00'.repeat(31)]},'authorization_blob_context_unsupported'],
  ]){
    // An absent property is how a malformed saved envelope reaches projection.
    const sample=input(f,change);if(change.authorizationList===undefined&&Object.hasOwn(change,'authorizationList'))delete sample.census.envelopes[0].normalizedEnvelope.authorizationList;
    const result=projectSelectedCase(sample);assert.equal(result.status,'unsupported');assert(result.reasons.includes(reason));assert.equal(result.request,undefined);assert.equal(result.transactionHash,HASH);
  }
  const historical=projectSelectedCase(input(await shanghaiFixture()));assert(historical.reasons.includes('authorization_before_prague'));
});
test('ordinary calls retain historical omission record and do not invent authorization context',async()=>{
  const f=await authorizationFixture(),sample=input(f,{type:'2'});delete sample.census.envelopes[0].normalizedEnvelope.authorizationList;
  const result=projectSelectedCase(sample);assert.equal(result.status,'projectable');assert(!Object.hasOwn(result.request,'authorizationList'));assert(result.omittedOuterFields.includes('authorizationList'));
});
