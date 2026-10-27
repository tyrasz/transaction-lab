import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMPT } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { verifyStateProof, StateProofError, STATE_PROOF_LIMITS, EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH } from '../verified-state-proof.js';
import { proofFixture, A, B, C, word, hex, bytes, integer, minimalProof } from './proof-fixture.js';
const invalid=e=>e instanceof StateProofError&&e.code==='STATE_PROOF_INVALID';
const limited=e=>e instanceof StateProofError&&e.code==='STATE_PROOF_LIMIT';
const clone=x=>structuredClone(x);
const {input:valid}=await proofFixture();
async function mutated(fn,base=valid,check=invalid){const input=clone(base);fn(input);await assert.rejects(verifyStateProof(input),check);}

test('synthetic valid account/storage inclusion and exclusion bind to the explicit root',async()=>{
  const result=await verifyStateProof(valid);
  assert.equal(result.status,'verified');assert.equal(result.stateRoot,valid.stateRoot);assert.equal(result.address,A);
  assert.deepEqual(result.account,{exists:true,nonceRaw:'3',balanceRaw:'123456789',codeHash:valid.proof.codeHash,storageRoot:valid.proof.storageHash});
  assert.deepEqual(result.code,{status:'verified',bytes:'0x600100'});
  assert.deepEqual(result.storage,[{key:word(0),exists:true,valueRaw:'7',valueWord:word(7)},{key:word(1),exists:true,valueRaw:((1n<<255n)+1n).toString(),valueWord:word((1n<<255n)+1n)},{key:word(2),exists:false,valueRaw:'0',valueWord:word(0)}]);
  assert.deepEqual(result.coverage,{storage:'requested_keys_only',unrequestedStorage:'unknown',stateRootTrust:'caller_supplied'});assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.storage[0]));
});
test('proofs cannot substitute another state root or another account address',async()=>{
  await mutated(i=>{i.stateRoot=word(123);});await mutated(i=>{i.address=B;});await mutated(i=>{i.address=B;i.proof.address=B;});
});
test('valid absent account proves zero basic state and empty code, distinct from unknown',async()=>{
  const {input}=await proofFixture({address:C});delete input.code;const result=await verifyStateProof(input);
  assert.deepEqual(result.account,{exists:false,nonceRaw:'0',balanceRaw:'0',storageRoot:EMPTY_STORAGE_ROOT,codeHash:EMPTY_CODE_HASH});assert.deepEqual(result.code,{status:'verified',bytes:'0x'});assert.ok(result.storage.every(x=>!x.exists&&x.valueRaw==='0'));
  await mutated(i=>{i.proof.balance='0x1';},input);await mutated(i=>{i.code='0x00';},input);
});
test('empty global trie and empty storage trie require empty proofs and bind absence',async()=>{
  const absent={stateRoot:EMPTY_STORAGE_ROOT,address:A,storageKeys:[word(0)],proof:{address:A,accountProof:[],nonce:'0x0',balance:'0x0',codeHash:EMPTY_CODE_HASH,storageHash:EMPTY_STORAGE_ROOT,storageProof:[{key:'0x0',value:'0x0',proof:[]}]}};
  assert.equal((await verifyStateProof(absent)).account.exists,false);
  const {input}=await proofFixture({emptyStorage:true});assert.ok((await verifyStateProof(input)).storage.every(x=>!x.exists));
  await mutated(i=>{i.proof.accountProof=['0x80'];},absent);await mutated(i=>{i.proof.storageProof[0].proof=valid.proof.storageProof[0].proof;},input);
});
test('missing proof/code/slots do not become zero or empty by default',async()=>{
  const missing=clone(valid);delete missing.code;assert.deepEqual((await verifyStateProof(missing)).code,{status:'unknown'});
  await mutated(i=>{i.proof.accountProof=[];});await mutated(i=>{i.proof.storageProof[0].proof=[];});await mutated(i=>{i.proof.storageProof.pop();});await mutated(i=>{delete i.proof.nonce;});
});
test('every redundant account field is checked against the RLP-proven value',async()=>{
  for(const[field,value]of[['nonce','0x4'],['balance','0x1'],['codeHash',word(42)],['storageHash',EMPTY_STORAGE_ROOT]])await mutated(i=>{i.proof[field]=value;});
});
test('code is checked against the account proof, not merely the reported hash',async()=>{
  await mutated(i=>{i.code='0x600101';});await mutated(i=>{i.code='0x600101';i.proof.codeHash=hex(keccak_256(bytes(i.code)));});await mutated(i=>{i.code='0x0';});await mutated(i=>{i.code=null;});
});
test('storage root/value/key substitutions cannot borrow another valid proof',async()=>{
  await mutated(i=>{i.proof.storageProof[0].value='0x8';});
  await mutated(i=>{i.proof.storageProof[0].proof=i.proof.storageProof[1].proof;});
  await mutated(i=>{i.storageKeys[0]=word(99);i.proof.storageProof[0].key=word(99);});
  const {input:other}=await proofFixture({emptyStorage:true});await mutated(i=>{i.proof.storageProof=other.proof.storageProof;});
});
test('response storage keys accept canonical quantity or full word but reject ambiguous aliases',async()=>{
  const input=clone(valid);input.proof.storageProof[0].key='0x0';input.proof.storageProof[1].key='0x1';assert.equal((await verifyStateProof(input)).storage.length,3);
  await mutated(i=>{i.proof.storageProof[0].key='0x00';});await mutated(i=>{i.storageKeys.push(i.storageKeys[0]);i.proof.storageProof.push(clone(i.proof.storageProof[0]));});await mutated(i=>{i.proof.storageProof.reverse();});
});
test('extra, duplicate, reordered and truncated proof nodes are rejected',async()=>{
  await mutated(i=>{i.proof.accountProof.push(i.proof.accountProof[0]);});
  const other=await proofFixture({address:B});await mutated(i=>{i.proof.accountProof.push(other.input.proof.accountProof.at(-1));});
  await mutated(i=>{i.proof.accountProof.reverse();});await mutated(i=>{i.proof.accountProof.pop();});await mutated(i=>{i.proof.accountProof[0]=i.proof.accountProof[0].slice(0,-2)+'00';});
});
test('quantities reject leading zeros, decimal, numbers, negatives and overflowing nonce/balance',async()=>{
  for(const value of ['0x00','3',3,-1,'-0x1','0x','0x'+(1n<<256n).toString(16)])await mutated(i=>{i.proof.balance=value;});
  await mutated(i=>{i.proof.nonce='0x10000000000000000';});
});
test('record shapes reject unknown properties, getters, coercible arrays and nonplain prototypes',async()=>{
  await mutated(i=>{i.proof.extra=1;});await mutated(i=>{i.extra=1;});await mutated(i=>{i.stateRoot=[i.stateRoot];});
  const i=clone(valid);Object.defineProperty(i.proof,'nonce',{enumerable:true,get(){throw new Error('Accessor must never execute.');}});await assert.rejects(verifyStateProof(i),invalid);
  const custom=clone(valid);Object.setPrototypeOf(custom.proof,{other:true});await assert.rejects(verifyStateProof(custom),invalid);
  const symbol=clone(valid);symbol.proof[Symbol('x')]=1;await assert.rejects(verifyStateProof(symbol),invalid);
});
test('sparse and accessor arrays are invalid and cumulative work is bounded before trie reads',async()=>{
  await mutated(i=>{delete i.proof.accountProof[0];});await mutated(i=>{i.storageKeys.extra=1;});
  await mutated(i=>{i.storageKeys=Array.from({length:STATE_PROOF_LIMITS.storageKeys+1},(_,n)=>word(n));},valid,limited);
  await mutated(i=>{i.proof.accountProof=Array.from({length:129},()=> '0xc0');},valid,limited);
  await mutated(i=>{i.proof.accountProof=['0x'+'00'.repeat(STATE_PROOF_LIMITS.nodeBytes+1)];},valid,limited);
  await mutated(i=>{i.code='0x'+'00'.repeat(STATE_PROOF_LIMITS.codeBytes+1);},valid,limited);
});
test('malformed and nonminimal account RLP is rejected even under its matching synthetic root',async()=>{
  for(const account of [[new Uint8Array([0]),integer(1n),bytes(EMPTY_STORAGE_ROOT),bytes(EMPTY_CODE_HASH)], [integer(1n),integer(1n),new Uint8Array(31),bytes(EMPTY_CODE_HASH)], [integer(1n),integer(1n),bytes(EMPTY_STORAGE_ROOT),bytes(EMPTY_CODE_HASH),new Uint8Array()]]){
    const state=await createMPT({useKeyHashing:true});await state.put(bytes(A),RLP.encode(account));const input={stateRoot:hex(state.root()),address:A,storageKeys:[],proof:{address:A,accountProof:await minimalProof(state,A),nonce:'0x0',balance:'0x1',storageHash:EMPTY_STORAGE_ROOT,codeHash:EMPTY_CODE_HASH,storageProof:[]},code:'0x'};await assert.rejects(verifyStateProof(input),invalid);
  }
});
test('explicit-zero and leading-zero storage leaves are not canonical Ethereum storage',async()=>{
  for(const scalar of [new Uint8Array(),new Uint8Array([0]),new Uint8Array([0,7])]){
    const storage=await createMPT({useKeyHashing:true}),state=await createMPT({useKeyHashing:true});await storage.put(bytes(word(0)),RLP.encode(scalar));await state.put(bytes(A),RLP.encode([integer(1n),integer(1n),storage.root(),bytes(EMPTY_CODE_HASH)]));
    const input={stateRoot:hex(state.root()),address:A,storageKeys:[word(0)],proof:{address:A,accountProof:await minimalProof(state,A),nonce:'0x1',balance:'0x1',codeHash:EMPTY_CODE_HASH,storageHash:hex(storage.root()),storageProof:[{key:word(0),value:'0x0',proof:await minimalProof(storage,word(0))}]},code:'0x'};await assert.rejects(verifyStateProof(input),invalid);
  }
});
test('asynchronous verification snapshots inputs and returns immutable detached facts',async()=>{
  const input=clone(valid),pending=verifyStateProof(input);input.proof.nonce='0xff';input.proof.storageProof[0].proof=[];input.code='0xff';const result=await pending;assert.equal(result.account.nonceRaw,'3');assert.equal(result.storage[0].valueRaw,'7');assert.throws(()=>{result.storage[0].valueRaw='99';},TypeError);
});

function compactPath(nibbles,leaf){const odd=nibbles.length%2,all=[(leaf?2:0)+odd,...(odd?[]:[0]),...nibbles];return Uint8Array.from(Array.from({length:all.length/2},(_,i)=>(all[2*i]<<4)|all[2*i+1]));}
async function storageRootFixture(nodes,value='0x7'){
  const state=await createMPT({useKeyHashing:true}),root=keccak_256(nodes[0]);await state.put(bytes(A),RLP.encode([integer(1n),integer(1n),root,bytes(EMPTY_CODE_HASH)]));
  return{stateRoot:hex(state.root()),address:A,storageKeys:[word(0)],proof:{address:A,accountProof:await minimalProof(state,A),nonce:'0x1',balance:'0x1',codeHash:EMPTY_CODE_HASH,storageHash:hex(root),storageProof:[{key:word(0),value,proof:nodes.map(hex)}]},code:'0x'};
}
test('embedded extension/branch/leaf children are verified without inventing external proof nodes',async()=>{
  const path=[...keccak_256(bytes(word(0)))].flatMap(v=>[v>>4,v&15]),branch=Array.from({length:17},()=>new Uint8Array());
  const leaf=[compactPath(path.slice(63),true),RLP.encode(integer(7n))];branch[path[62]]=leaf;branch[(path[62]+1)%16]=[compactPath([0],true),RLP.encode(integer(8n))];
  assert.ok(RLP.encode(branch).length<32);const root=RLP.encode([compactPath(path.slice(0,62),false),branch]),input=await storageRootFixture([root]);
  assert.equal((await verifyStateProof(input)).storage[0].valueRaw,'7');
  await mutated(i=>{i.proof.storageProof[0].proof.push(hex(RLP.encode(leaf)));},input);
});
test('malformed compact paths and short secure-key leaves are rejected under matching roots',async()=>{
  for(const path of [new Uint8Array([0x40]),new Uint8Array([0x01]),new Uint8Array([0x00]),new Uint8Array([0x20])]){
    const root=RLP.encode([path,RLP.encode(integer(7n))]),input=await storageRootFixture([root],'0x0');await assert.rejects(verifyStateProof(input),invalid);
  }
});
test('shared proof-byte budget rejects a large collection before evaluating any trie',async()=>{
  const nodes=Array.from({length:128},(_,i)=>'0x'+'ab'.repeat(2046)+i.toString(16).padStart(4,'0'));
  const input=clone(valid);input.proof.accountProof=nodes;input.storageKeys=Array.from({length:9},(_,n)=>word(n));input.proof.storageProof=input.storageKeys.map(key=>({key,value:'0x0',proof:nodes}));
  await assert.rejects(verifyStateProof(input),limited);
});
test('explicit EOA existence remains distinct from proof of absence',async()=>{
  const{input}=await proofFixture({address:B});const result=await verifyStateProof(input);assert.equal(result.account.exists,true);assert.equal(result.account.nonceRaw,'1');assert.deepEqual(result.code,{status:'verified',bytes:'0x'});assert.ok(result.storage.every(row=>row.exists===false));
});

test('Geth zero hash metadata is admitted only after account exclusion and kept separate',async()=>{
  const{input}=await proofFixture({address:C});input.proof.codeHash=word(0);input.proof.storageHash=word(0);delete input.code;
  const result=await verifyStateProof(input);
  assert.deepEqual(result.account,{exists:false,nonceRaw:'0',balanceRaw:'0',codeHash:EMPTY_CODE_HASH,storageRoot:EMPTY_STORAGE_ROOT});
  assert.deepEqual(result.reportedAccount,{nonceRaw:'0',balanceRaw:'0',codeHash:word(0),storageRoot:word(0)});
  assert.ok(Object.isFrozen(result.reportedAccount));assert.deepEqual(result.code,{status:'verified',bytes:'0x'});
  assert.ok(result.storage.every(row=>row.exists===false&&row.valueRaw==='0'));
  for(const change of [i=>{i.proof.accountProof=[];},i=>{i.proof.nonce='0x1';},i=>{i.proof.balance='0x1';},i=>{i.proof.codeHash=word(4);},i=>{i.proof.codeHash=EMPTY_CODE_HASH;},i=>{i.proof.storageHash=EMPTY_STORAGE_ROOT;},i=>{i.code='0x00';},i=>{i.proof.storageProof[0].value='0x1';},i=>{i.proof.storageProof[0].proof=valid.proof.storageProof[0].proof;}])await mutated(change,input);
  await mutated(i=>{i.proof.codeHash=word(0);i.proof.storageHash=word(0);});
  const {input:eoa}=await proofFixture({address:B});await mutated(i=>{i.proof.codeHash=word(0);i.proof.storageHash=word(0);},eoa);
});

test('pinned public development packet proves both USDC responses and dRPC account absence offline',async()=>{
  const body=await readFile(new URL('../../../reports/ethereum-proof-capability/capture.json',import.meta.url));
  assert.equal(createHash('sha256').update(body).digest('hex'),'d0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
  const capture=JSON.parse(body),record=id=>capture.records.find(r=>r.id===id);
  const response=id=>{const row=record(id);assert.equal(row.response.complete,true);assert.equal(Buffer.byteLength(row.response.bodyText),row.response.retainedBytes);assert.equal(createHash('sha256').update(row.response.bodyText).digest('hex'),row.response.retainedSha256);assert.equal(row.response.retainedSha256,row.response.observedSha256);return JSON.parse(row.response.bodyText);};
  const results=[];
  for(const[proofId,codeId,headerId]of[[3,4,2],[9,10,8],[5,null,2]]){
    const row=record(proofId),header=response(headerId).result;
    assert.equal(header.hash,'0xd5c5a3ba092484a5e1b3b54a054de8d1b1df7e24e60717f92517adccb0d6ce9e');
    assert.equal(header.stateRoot,'0x7a9eaf8bef6cb59ee3c58cbf7d96c173c3cc849f2a088ebe073d2069a1793af3');
    assert.deepEqual(row.request.body.params[2],{blockHash:header.hash,requireCanonical:true});
    const result=await verifyStateProof({stateRoot:header.stateRoot,address:row.request.body.params[0],storageKeys:row.request.body.params[1],proof:response(proofId).result,...(codeId?{code:response(codeId).result}:{})});results.push(result);
  }
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].account.exists,true);assert.equal(results[0].account.nonceRaw,'1');assert.equal(results[0].account.balanceRaw,'0');
  assert.equal(results[0].account.codeHash,'0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505');assert.equal((results[0].code.bytes.length-2)/2,2186);
  assert.deepEqual(results[0].storage,[{key:word(0),exists:true,valueRaw:'1442626706025541066953462928744535818996053290554',valueWord:'0x000000000000000000000000fcb19e6a322b27c06842a71e8c725399f049ae3a'}]);
  assert.equal(results[2].account.exists,false);assert.equal(results[2].reportedAccount.codeHash,word(0));assert.equal(results[2].reportedAccount.storageRoot,word(0));assert.deepEqual(results[2].code,{status:'verified',bytes:'0x'});assert.deepEqual(results[2].storage,[{key:word(0),exists:false,valueRaw:'0',valueWord:word(0)}]);
  // The other provider's absence query is a retained RPC failure, not a second
  // exclusion proof. Header trust here is conditional, not a consensus check.
  assert.equal(response(11).error.code,-32602);
});
