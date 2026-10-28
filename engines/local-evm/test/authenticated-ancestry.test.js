import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedAncestry, validateAncestryEvidence } from '../authenticated-ancestry.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { chain, rehash, word } from './ancestry-fixture.js';
const hashOf = block => '0x' + Buffer.from(block.hash()).toString('hex');
const collector = (c, rpc, limits) => createRpcStateInputs({ chainId:1,blockHash:c.header.hash,header:c.header,rpc,limits });

test('source commitment supplies N-1; N-256 follows exactly255 authenticated hash links and caches', async () => {
  const c = chain(), seen = [], inputs = collector(c,{async call(method,params){ seen.push({method,params}); return structuredClone(c.byHash.get(params[0])); }});
  const n = BigInt(c.header.number);
  assert.equal(hashOf(await inputs.blockchain.getBlock(n-1n)),c.header.parentHash); assert.equal(seen.length,0);
  assert.equal(hashOf(await inputs.blockchain.getBlock(n-256n)),c.blocks[0].hash); assert.equal(seen.length,255);
  assert.equal(hashOf(await inputs.blockchain.getBlock(n-100n)),c.blocks[156].hash); assert.equal(seen.length,255);
  assert(seen.every(row=>row.method==='eth_getBlockByHash'&&row.params[1]===false));
  assert.equal(inputs.snapshotInputs().ancestry.headers.length,255);
  validateAncestryEvidence(c.header,inputs.snapshotInputs().ancestry,inputs.snapshotEvidence());
  const copy=inputs.snapshotInputs(); copy.ancestry.headers[0].parentHash=word(2);
  assert.throws(()=>validateAncestryEvidence(c.header,copy.ancestry,inputs.snapshotEvidence()));
});

test('current/future/older-than256 return zero without adapter dispatch or retained ancestry lookups', async()=>{
  const c=chain(1), inputs=collector(c,{call(){throw Error('No read expected');}}),n=BigInt(c.header.number);
  for(const height of [n,n+1n,n-257n,(1n<<256n)-1n]) assert.equal(hashOf(await inputs.blockchain.getBlock(height)),word(0));
  assert.equal(inputs.snapshotUsage().calls,0);assert.deepEqual(inputs.snapshotInputs().ancestry.lookups,[]);
});

test('hash substitution, changed fields, number gaps and nondecreasing timestamp cannot extend ancestry',()=>{
  const c=chain(3), parent=c.blocks.at(-2);
  for(const bad of [{...parent,stateRoot:word(1)},{...parent,hash:word(1)},null]) assert.throws(()=>createAuthenticatedAncestry(c.header).accept(bad,1));
  for(const badParent of [rehash({...parent,number:'0x1'}),rehash({...parent,timestamp:c.header.timestamp})]) {
    const root=rehash({...c.header,parentHash:badParent.hash}); assert.throws(()=>createAuthenticatedAncestry(root).accept(badParent,1));
  }
  const cursor=createAuthenticatedAncestry(c.header); cursor.accept(parent,1);
  assert.throws(()=>cursor.accept(parent,2));assert.throws(()=>cursor.accept(c.blocks.at(-3),1));
});

test('snapshots cannot add unsupported lookups, omit received header proof or invent provenance',async()=>{
  const c=chain(2), inputs=collector(c,{call:async(_m,p)=>c.byHash.get(p[0])});await inputs.blockchain.getBlock(BigInt(c.header.number)-2n);
  const evidence=inputs.snapshotEvidence(),snapshot=inputs.snapshotInputs().ancestry;
  for(const mutate of [s=>{s.lookups[0].hash=word(7);},s=>{s.headers[0].evidenceId=2;},s=>{s.lookups.push({...s.lookups[0]});},s=>{s.consensusVerified=true;}]) {
    const changed=structuredClone(snapshot);mutate(changed);assert.throws(()=>validateAncestryEvidence(c.header,changed,evidence));
  }
  const removed=structuredClone(evidence);delete removed[0].result;assert.throws(()=>validateAncestryEvidence(c.header,snapshot,removed));
  assert.throws(()=>validateAncestryEvidence(c.header,undefined,evidence));
});

test('ancestor reads share call/byte/time budgets and poison subsequent reads on failure',async()=>{
  const c=chain(4),n=BigInt(c.header.number);
  for(const limits of [{calls:1},{responseBytes:10},{totalBytes:10}]) {
    let calls=0;const inputs=collector(c,{call:async(_m,p)=>{calls++;return c.byHash.get(p[0]);}},limits);
    await assert.rejects(inputs.blockchain.getBlock(n-3n));const prior=calls;
    await assert.rejects(inputs.blockchain.getBlock(n-1n));assert.equal(calls,prior);assert.equal(inputs.snapshotUsage().status,'unavailable');
  }
  let release;const inputs=collector(c,{call:()=>new Promise(resolve=>{release=resolve;})},{requestMs:5});
  await assert.rejects(inputs.blockchain.getBlock(n-2n));const sealed=JSON.stringify(inputs.snapshotEvidence());release(c.blocks.at(-2));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(JSON.stringify(inputs.snapshotEvidence()),sealed);
});

test('invalid ancestors retain rejected evidence and do not become valid cached facts',async()=>{
 const c=chain(2),inputs=collector(c,{call:async()=>({...c.blocks.at(-2),gasUsed:'0x0'})});
 await assert.rejects(inputs.blockchain.getBlock(BigInt(c.header.number)-2n),{code:'RPC_STATE_INPUT_INVALID_ANCESTRY'});
 assert.equal(inputs.snapshotEvidence()[0].verification,'rejected');assert.equal(Object.hasOwn(inputs.snapshotEvidence()[0],'result'),false);assert.deepEqual(inputs.snapshotInputs().ancestry.headers,[]);
});
