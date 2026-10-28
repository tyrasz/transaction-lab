import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { createProofStateManager } from '../proof-state.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { proofFixture, minimalProof, A, B, C, hex, word } from './proof-fixture.js';

// Synthetic valid account/storage proofs and rehashed header; these controls
// exercise actual bytecode, never claim new public-chain observations.
const raw = readFileSync(new URL('../../../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(raw).digest('hex'), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const realHeader = JSON.parse(raw).selectedHeader;
const order = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
const balance = (account = B) => ({ to: A, data: '0x70a08231' + account.slice(2).padStart(64, '0') });
const getter = '60005460005260206000f3';
function contract({ query = getter, original = '602a60005500' } = {}) {
  const offset = 5 + query.length / 2;
  assert(offset < 256);
  return '0x361560' + offset.toString(16).padStart(2, '0') + '57' + query + '5b' + original;
}
async function fixture({ query, original, from = B } = {}) {
  const code = contract({ query, original }), f = await proofFixture({ code });
  const header = { ...realHeader, stateRoot: f.input.stateRoot };
  const encoded = order.map(key => {
    let s = header[key].slice(2);
    if (integers.has(key)) { s = BigInt(header[key]) === 0n ? '' : BigInt(header[key]).toString(16); if (s.length % 2) s = '0' + s; }
    return Buffer.from(s, 'hex');
  });
  header.hash = hex(keccak_256(RLP.encode(encoded)));
  const calls = [];
  const rpc = { async call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    assert.deepEqual(params.at(-1), { blockHash: header.hash, requireCanonical: true });
    const [address, slots] = params;
    assert(['eth_getProof', 'eth_getCode'].includes(method), 'No trace or execution RPC may supply state');
    if (method === 'eth_getCode') return address === A ? code : '0x';
    const base = (await proofFixture({ code, address: address === A ? A : address === B ? B : C })).input.proof;
    const storageProof = [];
    for (const key of slots) {
      const value = address === A ? f.values.get(key) ?? 0n : 0n;
      storageProof.push({ key, value: '0x' + value.toString(16), proof: address === A ? await minimalProof(f.storage, key) : [] });
    }
    return { ...base, address, accountProof: await minimalProof(f.state, address), storageProof };
  } };
  return { request: { from, to: A, data: '0x', value: '0', gas: '5000000' }, header, rpc, queries: [balance(from)], calls };
}
const run = ({ calls, ...options }, extra = {}) => executeEthereumPreview({ ...options, ...extra });

test('real EVM queries measure original writes with independent before/post overlays and no extra nonce carry', async () => {
  const f = await fixture(), result = await run(f, { queries: [balance(B), balance(C)] });
  assert.equal(result.status, 'complete'); assert.equal(result.original.output.execution.status, 'success');
  assert.equal(result.usage.executions, 5);
  for (const row of result.measurements) {
    assert.deepEqual(row.values.map(({ beforeRaw, afterRaw, deltaRaw }) => ({ beforeRaw, afterRaw, deltaRaw })), [{ beforeRaw: '7', afterRaw: '42', deltaRaw: '35' }]);
    assert.equal(row.before.output.trace.from, B); assert.equal(row.after.output.trace.from, B);
    assert.equal(row.before.output.execution.returnData, word(7)); assert.equal(row.after.output.execution.returnData, word(42));
  }
  const sender = result.original.changes.accounts.find(a => a.address === B);
  assert.deepEqual(sender.nonce, { before: '0x1', after: '0x2' });
  assert.equal(result.scope.processIsolation, false);
  assert.equal(result.scope.allEffectsCoverage, 'not_established');
});

test('genuine original REVERT and EVM fault preserve zero token delta and their actual status', async () => {
  for (const [original, status] of [['602a60005560006000fd', 'reverted'], ['602a600055fe', 'failed']]) {
    const result = await run(await fixture({ original }));
    assert.equal(result.status, 'complete'); assert.equal(result.original.output.execution.status, status);
    assert.deepEqual(result.original.changes.accounts, [{ address: B, nonce: { before: '0x1', after: '0x2' } }]);
    assert.equal(result.measurements[0].values[0].beforeRaw, '7'); assert.equal(result.measurements[0].values[0].afterRaw, '7');
    assert.equal(result.measurements[0].values[0].deltaRaw, '0');
  }
});

test('query mutations, logs, malformed return and query revert are unavailable without altering original', async () => {
  for (const query of ['6009600155' + getter, '60006000a0' + getter, '600160005360016000f3', '60006000fd']) {
    const result = await run(await fixture({ query }));
    assert.equal(result.status, 'partial'); assert.equal(result.original.output.execution.status, 'success');
    assert.equal(result.measurements[0].status, 'unavailable'); assert.equal(result.measurements[0].values, null);
    assert.equal(result.measurements[0].before.status, 'unavailable');
    assert.equal(result.measurements[0].before.values, null); assert.equal(result.measurements[0].after, null);
    assert.deepEqual(result.original.changes.accounts.find(a => a.address === A).storage, [{ slot: word(0), before: word(7), after: word(42) }]);
  }
});

test('proven absent sender is materialized once by original; query-only nonce materialization never carries', async () => {
  const result = await run(await fixture({ from: C }));
  assert.equal(result.status, 'complete'); assert.equal(result.measurements[0].values[0].deltaRaw, '35');
  assert.deepEqual(result.original.changes.accounts.find(a => a.address === C), { address: C,
    existence: { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' }, nonce: { before: '0x0', after: '0x1' } });
});

test('unsupported original has no after-state measurements or speculative getter reads', async () => {
  const result = await run(await fixture({ original: '6000ff' }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.original.output.execution.status, 'unsupported');
  assert.equal(result.usage.executions, 1); assert.equal(result.measurements[0].status, 'not_attempted');
  assert.equal(result.measurements[0].before, null); assert.equal(result.measurements[0].after, null); assert.equal(result.measurements[0].values, null);
});

test('original plus all probes share execution and root-return budgets', async () => {
  const full = await run(await fixture());
  const limited = await run(await fixture(), { limits: { steps: full.original.output.usage.steps + 1 } });
  assert.equal(limited.original.output.execution.status, 'success'); assert.equal(limited.status, 'partial');
  assert.equal(limited.usage.executions, 2); assert.equal(limited.measurements[0].values, null);
  const bytesLimited = await run(await fixture(), { limits: { rootReturnBytes: 32 } });
  assert.equal(bytesLimited.status, 'partial'); assert.equal(bytesLimited.usage.rootReturnBytes, 32);
  assert.equal(bytesLimited.usage.executions, 2); assert.equal(bytesLimited.measurements[0].values, null);
});

test('tightened proof-state and execution limits reach the actual collectors and EVM', async () => {
  const accounts = await run(await fixture(), { limits: { accounts: 1, slots: 1, reads: 10, codeBytes: 128 } });
  assert.equal(accounts.status, 'unavailable'); assert.equal(accounts.inputUsage.limits.accounts, 1);
  assert.equal(accounts.inputUsage.limits.slots, 1); assert.equal(accounts.inputUsage.limits.reads, 10);
  assert.equal(accounts.inputUsage.limits.codeBytes, 128); assert.equal(accounts.inputUsage.accounts, 1);
  const gas = await run(await fixture(), { limits: { gas: 100000, depth: 3, memoryBytes: 64, calldataBytes: 32 } });
  assert.equal(gas.status, 'unavailable'); assert.equal(gas.original.output.execution.status, 'unavailable');
  assert.equal(gas.original.output.execution.error.code, 'LOCAL_INVALID_INPUT');
  assert.equal(gas.original.output.limits.gas, 100000); assert.equal(gas.original.output.limits.depth, 3);
  assert.equal(gas.original.output.limits.memoryBytes, 64); assert.equal(gas.original.output.limits.calldataBytes, 32);
});

test('injected overlay-isolation failure withholds nested values as well as the final pair', async t => {
  const f = await fixture();
  const inputs = createRpcStateInputs({ chainId: 1, blockHash: f.header.hash, header: f.header, rpc: f.rpc });
  const prototype = Object.getPrototypeOf(createProofStateManager({ inputs }));
  // Model a broken state-copy implementation: post queries now mutate the
  // original manager. The preview must detect this and invalidate every pair.
  t.mock.method(prototype, 'shallowCopy', function () { return this; });
  const result = await run(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_INTEGRITY');
  const row = result.measurements[0]; assert.equal(row.status, 'unavailable'); assert.equal(row.values, null);
  for (const side of [row.before, row.after]) {
    assert.equal(side.status, 'unavailable'); assert.equal(side.values, null);
    assert.equal(side.output.execution.status, 'success', 'Raw execution remains evidence, never a valid measurement');
  }
  assert.deepEqual(result.original.changes.accounts.find(a => a.address === B).nonce, { before: '0x1', after: '0x2' });
});

test('unbound headers, injected poststate and invalid queries reject before any state transport', async () => {
  const f = await fixture();
  for (const extra of [{ header: { ...f.header, stateRoot: word(1) } }, { expectedOutputs: {} }, { queries: [] }, { queries: [{ ...balance(), stateOverrides: {} }] }, { limits: { returnBytes: 32 } }]) {
    const result = await run(f, extra); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_INPUT');
  }
  assert.equal(f.calls.length, 0);
});

test('actual child preview uses original context only and fresh context-free getters over the retained overlay',async()=>{
 const {executeIsolatedEthereumPreview}=await import('../isolated-call.js');
 const f=await fixture({original:'60004960005500'}), hash='0x01'+'ab'.repeat(31);
 f.request.accessList=[{address:A,storageKeys:[word(0),word(0)]}];f.request.blobVersionedHashes=[hash];
 const {calls,...options}=f,r=await executeIsolatedEthereumPreview(options);
 assert.equal(r.status,'completed');assert.equal(r.preview.status,'complete');assert.equal(r.preview.original.output.execution.status,'success');
 assert.deepEqual(r.preview.original.output.profile.accessList,f.request.accessList);assert.deepEqual(r.preview.original.output.profile.blobVersionedHashes,[hash]);
 const measurement=r.preview.measurements[0];assert.equal(measurement.values[0].beforeRaw,'7');assert.equal(measurement.values[0].afterRaw,BigInt(hash).toString());
 for(const phase of [measurement.before,measurement.after]){
  for(const key of ['accessList','accessListAddressCount','accessListStorageKeyCount','accessListIntrinsicGas','blobVersionedHashes','executionBlobBaseFee','sourceExcessBlobGas'])assert.equal(Object.hasOwn(phase.output.profile,key),false);
  assert.equal(phase.output.semantics.warmAddresses,'sender_destination_coinbase_and_fork_active_precompiles_no_access_list');assert.equal(phase.mutationValidation.status,'verified');
 }
 assert(calls.every(x=>['eth_getProof','eth_getCode'].includes(x.method)));assert.equal(r.broker.pendingAtReturn,0);
});


test('actual child preview BLOBHASH getters see the fresh empty context before and after a blob original', async () => {
  const { executeIsolatedEthereumPreview } = await import('../isolated-call.js');
  // Original stores its declared hash. Getter returns storage + BLOBHASH(0):
  // leaking the original context would incorrectly add the hash a second time.
  const f = await fixture({ original: '60004960005500', query: '6000546000490160005260206000f3' });
  const hash = '0x01' + 'ab'.repeat(31); f.request.blobVersionedHashes = [hash];
  const { calls, ...options } = f, r = await executeIsolatedEthereumPreview(options);
  assert.equal(r.status, 'completed'); assert.equal(r.preview.status, 'complete');
  assert.equal(r.preview.original.output.execution.status, 'success');
  assert.deepEqual(r.preview.original.output.profile.blobVersionedHashes, [hash]);
  assert.deepEqual(r.preview.original.changes.accounts.find(a => a.address === A).storage, [{ slot: word(0), before: word(7), after: hash }]);
  const row = r.preview.measurements[0]; assert.equal(row.status, 'measured');
  assert.deepEqual(row.values.map(({ beforeRaw, afterRaw, deltaRaw }) => ({ beforeRaw, afterRaw, deltaRaw })),
    [{ beforeRaw: '7', afterRaw: BigInt(hash).toString(), deltaRaw: (BigInt(hash) - 7n).toString() }]);
  for (const phase of [row.before, row.after]) {
    assert.equal(phase.output.execution.status, 'success'); assert.equal(phase.mutationValidation.status, 'verified');
    assert.equal(Object.hasOwn(phase.output.profile, 'blobVersionedHashes'), false);
    assert.equal(Object.hasOwn(phase.output.profile, 'executionBlobBaseFee'), false);
  }
  assert(calls.every(x => ['eth_getProof', 'eth_getCode'].includes(x.method))); assert.equal(r.broker.pendingAtReturn, 0);
});
