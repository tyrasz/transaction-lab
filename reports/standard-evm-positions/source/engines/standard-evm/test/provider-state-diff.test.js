import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeProviderStateDiff } from '../provider-state-diff.js';
import { canonicalStateDiff } from '../../../src/state-diff.js';
import { buildStateOverrides, StateValidationError } from '../../../src/state.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const upper = value => '0x' + value.slice(2).toUpperCase();
const A = address(0xab), B = address(0xcd);
// Standard Keccak-256 vectors, distinct from SHA3-256.
const EMPTY_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const ZERO_BYTE_HASH = '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a';

const captureBytes = await readFile(new URL('../../../reports/standard-evm-deposits/capture.json', import.meta.url));
assert.equal(sha(captureBytes), 'e0bde3899b5dc2795206ed70b6faa82f2a8bcaa5f8f82a79c3151f2fa093f778');
const capture = JSON.parse(captureBytes), morpho = capture.cases.find(item => item.id === 'morpho-kiln-usdc-deposit');
const record = morpho.rpcCalls.find(item => item.sequence === 41);
assert.equal(record.request.body.method, 'debug_traceCall'); assert.equal(record.request.body.params[2].tracer, 'prestateTracer'); assert.equal(record.request.body.params[2].tracerConfig.diffMode, true);
assert.equal(record.request.body.params[1].blockHash, '0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61');
assert.equal(sha(record.responseText), 'c46bba16904003c47122b9776e711b3142290ee8da201a0bb670accc64a01b3e');
assert.equal(Buffer.byteLength(record.responseText), 86512); assert.deepEqual(JSON.parse(record.responseText), record.response);
const raw = record.response.result;
const EXPECTED_CHECKS = [
  ['0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b', '0xadde58ed66192b6e998912e7fa41bc6f3bdbcfe3ced6b6689b7b875721dea2dd', 283],
  ['0x870ac11d48b15db9a138cf899d20f13f79ba00bc', '0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd', 2717],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505', 2186],
  ['0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c', 15623],
  ['0xbeef01735c132ada46aa9aa4c54623caa92a64cb', '0x178de337f452135bd08591e764910cb3ac423a6b26f72da7c1d09f15019bdd07', 19340],
].map(([address,codeHash,codeBytes]) => ({phase:'pre',address,codeHash,codeBytes}));
const minimal = () => ({ pre: {[A]:{code:'0x00',codeHash:ZERO_BYTE_HASH}}, post: {[A]:{}} });
const reject = value => assert.throws(() => normalizeProviderStateDiff(value), StateValidationError);

test('five actual Morpho pre-codeHash claims match explicit runtime bytes without changing raw or any state field', () => {
  const snapshot = structuredClone(raw), normalized = normalizeProviderStateDiff(raw);
  assert.deepEqual(normalized.codeHashChecks, EXPECTED_CHECKS); assert.deepEqual(raw, snapshot);
  const withoutMetadata = structuredClone(raw);
  for(const phase of ['pre','post'])for(const value of Object.values(withoutMetadata[phase]))delete value.codeHash;
  assert.deepEqual(normalized.diff, canonicalStateDiff(withoutMetadata));
  assert.equal(Object.keys(normalized.diff.pre).length, 6); assert.equal(Object.keys(normalized.diff.post).length, 6);
  for(const claim of EXPECTED_CHECKS){assert.equal(normalized.diff.pre[claim.address].code,raw.pre[claim.address].code);assert.equal(normalized.diff.post[claim.address].code,undefined);assert.equal(Object.hasOwn(normalized.diff.pre[claim.address],'codeHash'),false);}
  // The metadata adapter does not alter storage values or relax the existing
  // reconstruction guard. Original raw failure remains immutable in capture.
  assert.doesNotThrow(() => buildStateOverrides(normalized.diff));
  assert.equal(morpho.result.canonicalStatus,'unverified');
});

test('every observed claim rejects altered runtime code, altered hash and absent same-record code', () => {
  for(const {address:account} of EXPECTED_CHECKS)for(const change of [
    value=>{value.code=value.code.slice(0,-2)+(value.code.endsWith('00')?'01':'00');},
    value=>{value.codeHash=word(1);},value=>{delete value.code;},
  ]){const modified=structuredClone(raw);change(modified.pre[account]);reject(modified);}
});

test('Keccak empty/zero-byte vectors and case normalization are explicit, with deterministic phase/address checks', () => {
  const input={pre:{[upper(B)]:{code:'0x',codeHash:upper(EMPTY_HASH)},[upper(A)]:{code:'0x00',codeHash:upper(ZERO_BYTE_HASH)}},post:{[B]:{code:'0x',codeHash:EMPTY_HASH},[A]:{code:'0x00',codeHash:ZERO_BYTE_HASH}}};
  assert.deepEqual(normalizeProviderStateDiff(input),{diff:{pre:{[A]:{code:'0x00'},[B]:{code:'0x'}},post:{[A]:{code:'0x00'},[B]:{code:'0x'}}},codeHashChecks:[
    {phase:'post',address:A,codeHash:ZERO_BYTE_HASH,codeBytes:1},{phase:'post',address:B,codeHash:EMPTY_HASH,codeBytes:0},
    {phase:'pre',address:A,codeHash:ZERO_BYTE_HASH,codeBytes:1},{phase:'pre',address:B,codeHash:EMPTY_HASH,codeBytes:0},
  ]});
  assert.equal(sha(Buffer.alloc(0))===EMPTY_HASH.slice(2),false,'The Keccak claim must not be checked using SHA-256');
});

test('post codeHash cannot inherit pre-code, while explicit matching post code is checked and remains present', () => {
  const absent = minimal(); absent.post[A].codeHash=ZERO_BYTE_HASH; reject(absent);
  const explicit=minimal(); explicit.post[A]={code:'0x00',codeHash:ZERO_BYTE_HASH};
  const result=normalizeProviderStateDiff(explicit); assert.equal(result.codeHashChecks.length,2); assert.equal(result.diff.post[A].code,'0x00'); assert.doesNotThrow(()=>buildStateOverrides(result.diff));
  for(const value of [undefined,null,['0x00'],'0x0','0xgg',0]){const modified=minimal();modified.post[A]={code:value,codeHash:ZERO_BYTE_HASH};reject(modified);}
});

test('a correct hash for changed post code is not permission to apply a runtime-code mutation', () => {
  const changed=minimal();changed.post[A]={code:'0x',codeHash:EMPTY_HASH};
  const result=normalizeProviderStateDiff(changed);assert.equal(result.codeHashChecks.length,2);assert.equal(result.diff.post[A].code,'0x');
  assert.throws(()=>buildStateOverrides(result.diff),/Contract code changes/);
  const creation={pre:{},post:{[A]:{code:'0x00',codeHash:ZERO_BYTE_HASH}}};
  assert.throws(()=>buildStateOverrides(normalizeProviderStateDiff(creation).diff),/creation or deletion/);
});

test('ordinary diffs remain identical, preserving absent versus explicit-zero fields and cleared storage', () => {
  for(const ordinary of [
    {pre:{},post:{}}, {pre:{[A]:{}},post:{[A]:{nonce:'0x1'}}},
    {pre:{[A]:{balance:'0x0',nonce:0,storage:{[word(1)]:word(4)}}},post:{[A]:{nonce:'1',storage:{}}}},
    {pre:{[upper(A)]:{code:'0xAbCd',nonce:1}},post:{[A]:{nonce:2}}},
  ]){const snapshot=structuredClone(ordinary),result=normalizeProviderStateDiff(ordinary);assert.deepEqual(result,{diff:canonicalStateDiff(ordinary),codeHashChecks:[]});assert.deepEqual(ordinary,snapshot);}
  const cleared=normalizeProviderStateDiff({pre:{[A]:{storage:{[word(1)]:word(7)}}},post:{[A]:{storage:{}}}});
  assert.deepEqual(buildStateOverrides(cleared.diff),{[A]:{stateDiff:{[word(1)]:word(0)}}});
});

test('malformed hashes, bytes, types and unfamiliar metadata are rejected rather than stripped', () => {
  for(const value of [undefined,null,[],[ZERO_BYTE_HASH],0,true,{},'0x','0x1234','0x'+'g'.repeat(64),ZERO_BYTE_HASH+'00']){const input=minimal();input.pre[A].codeHash=value;reject(input);}
  for(const value of [undefined,null,[],['0x00'],0,true,{},'00','0x0','0x0g']){const input=minimal();input.pre[A].code=value;reject(input);}
  for(const change of [
    x=>{x.extra={};},x=>{x.pre[A].storageRoot=word(0);},x=>{x.pre[A].CodeHash=x.pre[A].codeHash;},x=>{x.post[A].unknown='0x';},
    x=>{x.pre[A].nonce=-1;},x=>{x.pre[A].balance='-1';},x=>{x.pre[A].storage={codeHash:word(0)};},
  ]){const input=minimal();change(input);reject(input);}
  for(const input of [null,[],{}, {pre:{},post:[]}, {pre:[],post:{}}, {pre:{[A]:[]},post:{}}])reject(input);
});

test('normalized address/slot collisions and non-JSON descriptors fail before executing accessors', () => {
  const collision=minimal();collision.pre[upper(A)]=structuredClone(collision.pre[A]);reject(collision);
  const postCollision=minimal();postCollision.post[A]={};postCollision.post[upper(A)]={};reject(postCollision);
  const slot='0x'+'ab'.repeat(32),slots=minimal();slots.pre[A].storage={[slot]:word(1),[upper(slot)]:word(2)};reject(slots);
  let executed=false;
  for(const target of ['root','map','account','storage']){
    const input=minimal();input.pre[A].storage={};const record=target==='root'?input:target==='map'?input.pre:target==='account'?input.pre[A]:input.pre[A].storage;
    Object.defineProperty(record,'syntheticGetter',{enumerable:true,get(){executed=true;throw new Error('must not run');}});reject(input);assert.equal(executed,false);
  }
  for(const key of [Symbol('hidden'),'hidden']){const input=minimal();Object.defineProperty(input.pre[A],key,{value:0,enumerable:false});reject(input);}
  const prototype=minimal();Object.setPrototypeOf(prototype.pre[A],{codeHash:ZERO_BYTE_HASH});reject(prototype);
});

test('metadata adapter preserves account/slot/code bounds before attempting hash verification', () => {
  const tooMany={pre:Object.fromEntries(Array.from({length:101},(_,i)=>[address(i+1),{}])),post:{}};assert.throws(()=>normalizeProviderStateDiff(tooMany),/100-account/);
  const tooManyAcross={pre:Object.fromEntries(Array.from({length:100},(_,i)=>[address(i+1),{}])),post:{[address(101)]:{}}};assert.throws(()=>normalizeProviderStateDiff(tooManyAcross),/100-account/);
  const slots=minimal();slots.pre[A].storage=Object.fromEntries(Array.from({length:2001},(_,i)=>[word(i),word(i)]));assert.throws(()=>normalizeProviderStateDiff(slots),/2000-slot/);
  const oversized=minimal();oversized.pre[A].code='0x'+'00'.repeat(4*1024*1024);oversized.pre[A].codeHash=word(0);
  assert.throws(()=>normalizeProviderStateDiff(oversized),/code evidence.*size limit/,'Byte budget must fail before hashing a deliberately incorrect claim');
  const aggregate=minimal();aggregate.pre[A].code='0x'+'00'.repeat(2*1024*1024);aggregate.post[A]={code:aggregate.pre[A].code,codeHash:ZERO_BYTE_HASH};
  assert.throws(()=>normalizeProviderStateDiff(aggregate),/code evidence.*size limit/,'Code limits cover both phases');
});
