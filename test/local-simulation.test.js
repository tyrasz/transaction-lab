import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RLP } from '../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { proofFixture, minimalProof, A, B, C, hex } from '../engines/local-evm/test/proof-fixture.js';
import { validateLocalSimulation, simulateLocal, withholdLocalSimulation, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { InputError } from '../src/validate.js';

const raw = readFileSync(new URL('../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(raw).digest('hex'), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const originalHeader = JSON.parse(raw).selectedHeader;
const order = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
const query = { to: A, data: '0x70a08231' + B.slice(2).padStart(64, '0') };
const input = { chainId: 1, from: B, to: A, data: '0x', value: '0', queries: [query] };

// Synthetic state and rehashed header: actual bytecode and proof verification,
// without a new public-chain observation or mocked execution result.
async function fixture({ original = '602a60005500', queryCode = '60005460005260206000f3', finalHeader, failProof = false, drainComplete = true } = {}) {
  const offset = 5 + queryCode.length / 2;
  const code = '0x361560' + offset.toString(16).padStart(2, '0') + '57' + queryCode + '5b' + original;
  const f = await proofFixture({ code }), header = { ...originalHeader, stateRoot: f.input.stateRoot };
  header.hash = hex(keccak_256(RLP.encode(order.map(key => {
    let value = header[key].slice(2);
    if (integers.has(key)) { value = BigInt(header[key]) === 0n ? '' : BigInt(header[key]).toString(16); if (value.length % 2) value = '0' + value; }
    return Buffer.from(value, 'hex');
  }))));
  const records = []; let pinned = null, cancelled = false, reads = 0;
  const start = performance.now();
  const rpc = {
    pinBlockHash(hash) { assert.equal(pinned, null); assert.equal(hash, header.hash); pinned = hash; },
    async call(method, params, { signal } = {}) {
      assert.equal(cancelled, false); assert.equal(signal?.aborted, false);
      records.push({ method, params: structuredClone(params) });
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') {
        reads++; return structuredClone(reads > 1 && finalHeader ? finalHeader(header) : header);
      }
      assert.equal(pinned, header.hash); assert.ok(['eth_getProof', 'eth_getCode'].includes(method));
      assert.deepEqual(params.at(-1), { blockHash: header.hash, requireCanonical: true });
      if (failProof) throw new Error('private upstream detail must not escape');
      const [address, slots] = params;
      if (method === 'eth_getCode') return address === A ? code : '0x';
      const base = (await proofFixture({ code, address: address === A ? A : address === B ? B : C })).input.proof;
      return { ...base, address, accountProof: await minimalProof(f.state, address), storageProof: await Promise.all(slots.map(async key => ({ key,
        value: '0x' + (address === A ? f.values.get(key) ?? 0n : 0n).toString(16), proof: address === A ? await minimalProof(f.storage, key) : [] }))) };
    },
    snapshotEvidence() { return structuredClone(records); },
    usage() { return { calls: records.length, observedBytes: 0, remainingWallMs: 145000 - (performance.now() - start), limits: { calls: 260, totalBytes: 33554432 } }; },
    cancel() { cancelled = true; },
    async drain() { return { complete: drainComplete, pending: 0, adapterPending: drainComplete ? 0 : 1 }; },
  };
  return { rpc, header, records };
}

test('local input is normalized independently, with explicit bounded queries and no execution settings', async () => {
  const normalized = validateLocalSimulation(input);
  assert.equal(normalized.block, 'latest'); assert.deepEqual(normalized.queries, [query]);
  assert.equal(LOCAL_CAPABILITIES.querySelection, 'explicit_only');
  for (const change of [{ chainId: 8453 }, { queries: undefined }, { queries: [] }, { queries: [query, query] }, { gas: '1' }, { stateOverrides: {} }, { value: '0x0' }, { block: 'pending' }, { to: null }, { data: '0xa' }]) {
    await assert.rejects(simulateLocal({ ...input, ...change }, { call() { assert.fail('Invalid input reached RPC'); } }), InputError);
  }
  const bad = { ...input }; Object.defineProperty(bad, 'from', { get() { assert.fail('Accessor executed'); }, enumerable: true });
  assert.throws(() => validateLocalSimulation(bad), InputError);
});

test('actual isolated execution measures synthetic writes and binds latest and full final header', async () => {
  const f = await fixture(), result = await simulateLocal(input, f.rpc);
  assert.equal(result.status, 'complete'); assert.equal(result.execution.status, 'success');
  assert.equal(result.source.canonicalStatus, 'verified'); assert.equal(result.source.blockSelection.blockHash, f.header.hash);
  assert.equal(result.attempt.isolation.processSeparated, true); assert.equal(result.attempt.broker.pendingAtReturn, 0);
  assert.deepEqual(result.measurements[0].values, [{ name: 'balance', beforeRaw: '7', afterRaw: '42', deltaRaw: '35', unit: { kind: 'token_raw_units', scale: null } }]);
  assert.equal(result.measurements[0].identity.account, B); assert.equal(result.measurements[0].identity.token, A);
  assert.deepEqual(f.records[1], { method: 'eth_getBlockByNumber', params: ['latest', false] });
  assert.deepEqual(f.records.at(-1), { method: 'eth_getBlockByNumber', params: [f.header.number, false] });
});

test('hash selector does not add a number-resolution call, and wrong numeric header fails before proof dispatch', async () => {
  const f = await fixture();
  const result = await simulateLocal({ ...input, block: f.header.hash }, f.rpc);
  assert.equal(result.status, 'complete'); assert.equal(f.records[1].method, 'eth_getBlockByHash');
  const wrong = await fixture();
  const failed = await simulateLocal({ ...input, block: '0x1' }, wrong.rpc);
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.attempt, null); assert.equal(wrong.records.length, 2);
});

test('full header mismatch clears all nested measurement amounts but retains labeled original audit', async () => {
  for (const finalHeader of [header => ({ ...header, timestamp: '0x1' }), header => ({ ...header, transactions: [] })]) {
    const f = await fixture({ finalHeader }), result = await simulateLocal(input, f.rpc);
    assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_CANONICAL');
    assert.equal(result.execution.status, 'unavailable'); assert.deepEqual(result.measurements, []); assert.equal(result.attempt.preview, null);
    assert.equal(result.audit.status, 'unverified_not_a_measurement'); assert.equal(result.audit.original.output.execution.status, 'success');
    assert.ok(result.transportEvidence.length > 2);
  }
});

test('completed revert retains execution and independently measured zero effect, unsupported stays unavailable', async () => {
  const revert = await fixture({ original: '602a60005560006000fd' });
  const result = await simulateLocal(input, revert.rpc);
  assert.equal(result.status, 'complete'); assert.equal(result.execution.status, 'reverted');
  assert.equal(result.measurements[0].values[0].deltaRaw, '0');
  const unsupported = await fixture({ original: '6000ff' });
  const unavailable = await simulateLocal(input, unsupported.rpc);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.execution.status, 'unsupported');
  assert.equal(unavailable.measurements[0].status, 'not_attempted'); assert.equal(unavailable.measurements[0].values, null);
});

test('query mutation produces partial availability; proof failures do not leak provider text', async () => {
  const changed = await fixture({ queryCode: '600960015560005460005260206000f3' });
  const partial = await simulateLocal(input, changed.rpc);
  assert.equal(partial.status, 'partial'); assert.equal(partial.execution.status, 'success'); assert.equal(partial.measurements[0].values, null);
  const missing = await fixture({ failProof: true }), failed = await simulateLocal(input, missing.rpc);
  assert.equal(failed.status, 'unavailable'); assert.equal(JSON.stringify(failed).includes('private upstream'), false);
});

test('cancellation before dispatch and incomplete drain withhold all preview values', async () => {
  const cancelled = await fixture(), controller = new AbortController(); controller.abort();
  const first = await simulateLocal(input, cancelled.rpc, { signal: controller.signal });
  assert.equal(first.error.code, 'LOCAL_PREVIEW_CANCELLED'); assert.equal(cancelled.records.length, 0);
  const undrained = await fixture({ drainComplete: false }), second = await simulateLocal(input, undrained.rpc);
  assert.equal(second.error.code, 'LOCAL_PREVIEW_DRAIN'); assert.equal(second.attempt.preview, null); assert.deepEqual(second.measurements, []);
});

test('source invalidation removes successful nested preview and declared amounts', async () => {
  const f = await fixture(), report = await simulateLocal(input, f.rpc);
  assert.equal(report.status, 'complete');
  withholdLocalSimulation(report, 'LOCAL_PREVIEW_SOURCE_CHANGED');
  assert.equal(report.execution.status, 'unavailable'); assert.equal(report.attempt.preview, null); assert.deepEqual(report.measurements, []);
  assert.equal(report.audit.original.output.execution.status, 'success');
});
