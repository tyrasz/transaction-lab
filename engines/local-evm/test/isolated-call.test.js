import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { proofFixture, A, B, word } from './proof-fixture.js';

const read = name => readFileSync(new URL('../../../reports/ethereum-local-reference/' + name, import.meta.url));
const planBytes = read('plan.json'), recordedBytes = read('drpc-local.json');
assert.equal(createHash('sha256').update(planBytes).digest('hex'), 'ffa5f14e267e3fb4ec2eb53aa3bb2da241ace700368a244cde9042f2b7f1a220');
assert.equal(createHash('sha256').update(recordedBytes).digest('hex'), '38446149c8f126819dbd7cd1b2c8158d8492ce341095f5e3b35efba9d13dad32');
const plan = JSON.parse(planBytes), recorded = JSON.parse(recordedBytes);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function syntheticHeader(stateRoot) {
  // Synthetic proof root + explicitly reconstructed header, never chain evidence.
  const header = { ...plan.header, stateRoot };
  const order = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
  const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
  const values = order.map(key => {
    let value = header[key].slice(2);
    if (integers.has(key)) { value = BigInt(header[key]) === 0n ? '' : BigInt(header[key]).toString(16); if (value.length % 2) value = '0' + value; }
    return Buffer.from(value, 'hex');
  });
  header.hash = '0x' + Buffer.from(keccak_256(RLP.encode(values))).toString('hex'); return header;
}
async function fixture(code = '0x602a600055602a60005260206000f3', mutate) {
  const initial = await proofFixture({ requested: [], code }), header = syntheticHeader(initial.input.stateRoot), calls = [];
  return { request: { from: B, to: A, data: '0x', value: '1', gas: '100000' }, header, calls,
    rpc: { async call(method, params) {
      calls.push({ method, params }); assert.deepEqual(params.at(-1), { blockHash: header.hash, requireCanonical: true });
      const proof = await proofFixture({ code, address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
      const result = method === 'eth_getProof' ? proof.input.proof : proof.input.code;
      return mutate ? mutate({ method, params, result }) : result;
    } } };
}
const run = ({ calls, ...options }, changes = {}) => executeIsolatedEthereumCall({ ...options, ...changes });

test('real saved proof/code wire replays in an actual fixed worker with exact observed execution and changes', async () => {
  let at = 0, mismatch = null;
  const result = await executeIsolatedEthereumCall({ request: plan.request, header: plan.header, limits: { calls: 64, inputs: { wallMs: 120000 } }, rpc: { async call(method, params) {
    const row = recorded.transport[at++];
    try { assert(row); assert.deepEqual({ method, params }, { method: row.request.method, params: row.request.params }); }
    catch (error) { mismatch = error; throw error; }
    return structuredClone(row.parsed.result); // Proof/code only; no expected output enters the child.
  } } });
  assert.equal(mismatch, null); assert.equal(at, 11); assert.equal(result.status, 'completed'); assert.equal(result.error, null);
  assert.deepEqual(result.output, recorded.output); assert.deepEqual(result.inputs, recorded.inputs);
  assert.deepEqual(result.changes, recorded.changes); assert.deepEqual(result.stateReads, recorded.stateReads);
  assert.deepEqual(result.headerVerification, recorded.headerVerification);
  assert.equal(result.isolation.processSeparated, true); assert.notEqual(result.isolation.childPid, process.pid);
  assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitCode, 0); assert.equal(result.isolation.v8OldSpaceMiB, 256);
  assert.equal(result.isolation.hardTotalRssCap, false); assert.equal(result.isolation.osNetworkSandbox, false); assert.equal(result.isolation.osFilesystemSandbox, false);
  assert.equal(result.isolation.sourceImplementationBound, false); assert.equal(result.broker.rawWireCaptured, false);
  assert.equal(result.broker.calls, 11); assert.equal(result.broker.dispatches, 11); assert.equal(result.broker.pendingAtReturn, 0);
});

test('synthetic proven inputs execute real SSTORE/return and native value in the separate worker', async () => {
  const result = await run(await fixture());
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success'); assert.equal(result.output.execution.returnData, word(42));
  const sender = result.changes.accounts.find(row => row.address === B), recipient = result.changes.accounts.find(row => row.address === A);
  assert.deepEqual(sender.nonce, { before: '0x1', after: '0x2' }); assert.deepEqual(sender.balance, { before: '0x14', after: '0x13' });
  assert.deepEqual(recipient.storage, [{ slot: word(0), before: word(7), after: word(42) }]);
  assert.equal(result.inputs.accounts[A].storage[word(0)], word(7));
});

test('real REVERT rolls back value/storage and retains only the unsigned sender nonce', async () => {
  const result = await run(await fixture('0x602a60005560006000fd'));
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'reverted');
  assert.deepEqual(result.changes.accounts, [{ address: B, nonce: { before: '0x1', after: '0x2' } }]);
  assert.deepEqual(result.output.logs, []);
});

test('invalid proof after a local write causes rollback; provider exception details are never copied', async () => {
  const f = await fixture('0x602a6000556001545000', ({ method, params, result }) => {
    if (method === 'eth_getProof' && params[1].includes(word(1))) result.storageProof = [];
    return result;
  });
  const result = await run(f);
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'unavailable');
  assert.equal(result.output.stateDisposition, 'rolled_back'); assert.deepEqual(result.changes.accounts, []);
  assert.equal(result.inputUsage.failure.code, 'RPC_STATE_INPUT_INVALID_PROOF');
  const poisoned = await run(await fixture(), { rpc: { call() { throw new Error('PRIVATE_PROVIDER_TOKEN'); } } });
  assert.equal(poisoned.status, 'completed'); assert.equal(poisoned.output.execution.status, 'unavailable');
  assert.equal(JSON.stringify(poisoned).includes('PRIVATE_PROVIDER_TOKEN'), false);
});

test('parent rejects unbound headers, widened limits and non-call fields before forking or dispatch', async t => {
  const f = await fixture(); let forks = 0;
  t.mock.method(childProcess, 'fork', () => { forks++; throw Error('Must not fork.'); });
  for (const changes of [{ header: { ...f.header, stateRoot: word(1) } }, { request: { ...f.request, stateOverrides: {} } },
    { request: { ...f.request, gas: '5000001' } }, { limits: { heapMiB: 63 } }, { limits: { calls: 257 } }, { worker: '/tmp/foreign.js' }, { expected: {} }]) {
    const result = await run(f, changes); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_INPUT'); assert.equal(result.output, null);
  }
  assert.equal(forks, 0); assert.equal(f.calls.length, 0);
});

test('hard process wall timer kills a nonresponsive actual child independently of cooperative EVM checks', async t => {
  const original = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => { const child = original(...args); child.kill('SIGSTOP'); return child; });
  const f = await fixture(), result = await run(f, { limits: { wallMs: 100, drainMs: 20 } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_TIMEOUT'); assert.equal(result.output, null);
  assert.equal(result.isolation.terminateRequested, true); assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitSignal, 'SIGKILL');
  assert.equal(f.calls.length, 0); assert(result.isolation.durationMs < 3000);
});

test('a child crash is unavailable, not an empty successful execution', async t => {
  const original = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => { const child = original(...args); setTimeout(() => child.kill('SIGKILL'), 10); return child; });
  const result = await run(await fixture());
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_EXIT'); assert.equal(result.output, null); assert.equal(result.inputs, null);
});

test('cancellation aborts and drains cooperative parent reads before returning', async () => {
  const controller = new AbortController(); let finished = false, observedSignal = false;
  const result = await run(await fixture(), { signal: controller.signal, rpc: { call(_method, _params, { signal }) {
    setTimeout(() => controller.abort(), 5);
    return new Promise((_, reject) => signal.addEventListener('abort', () => { observedSignal = true; setTimeout(() => { finished = true; reject(new Error('PRIVATE_ABORT')); }, 15); }, { once: true }));
  } } });
  assert.equal(result.error.code, 'LOCAL_ISOLATED_CANCELLED'); assert.equal(result.output, null); assert.equal(finished, true); assert.equal(observedSignal, true);
  assert.equal(result.broker.pendingAtReturn, 0); assert.equal(JSON.stringify(result).includes('PRIVATE_ABORT'), false);
});

test('uncooperative late adapter replies cannot restore success or mutate sealed failure evidence', async () => {
  const controller = new AbortController(); let release;
  const result = await run(await fixture(), { signal: controller.signal, limits: { drainMs: 20 }, rpc: { call() {
    setTimeout(() => controller.abort(), 5); return new Promise(resolve => { release = resolve; });
  } } });
  assert.equal(result.error.code, 'LOCAL_ISOLATED_CANCELLED'); assert.equal(result.output, null); assert.equal(result.broker.pendingAtReturn, 1);
  const snapshot = JSON.stringify(result); release('0x'); await delay(20); assert.equal(JSON.stringify(result), snapshot);
});

test('RPC deadline, response byte limit and output limit withhold incomplete process results', async () => {
  const timeout = await run(await fixture(), { limits: { requestMs: 20, drainMs: 10 }, rpc: { call() { return new Promise(() => {}); } } });
  assert.equal(timeout.status, 'unavailable'); assert.equal(timeout.output, null); assert.match(timeout.error.code, /RPC_TIMEOUT|RPC_CANCELLED/);
  const oversized = await run(await fixture(), { limits: { responseBytes: 32 } });
  assert.equal(oversized.status, 'unavailable'); assert.equal(oversized.error.code, 'LOCAL_ISOLATED_SIZE'); assert.equal(oversized.output, null);
  const output = await run(await fixture(), { limits: { outputBytes: 1024 } });
  assert.equal(output.status, 'unavailable'); assert.equal(output.output, null);
});

test('call and cumulative byte ceilings do not create replacement reads; pre-aborted calls never fork', async t => {
  const capped = await run(await fixture(), { limits: { calls: 1 } });
  assert.equal(capped.status, 'completed'); assert.equal(capped.output.execution.status, 'unavailable');
  assert.equal(capped.inputUsage.failure.code, 'RPC_STATE_INPUT_LIMIT'); assert.equal(capped.broker.dispatches, 1);
  const f = await fixture(), bytes = await run(f, { limits: { totalResponseBytes: 16 } });
  assert.equal(bytes.status, 'unavailable'); assert.equal(bytes.error.code, 'LOCAL_ISOLATED_SIZE'); assert.equal(bytes.output, null); assert.equal(f.calls.length, 1);
  const controller = new AbortController(); controller.abort();
  const mock = t.mock.method(childProcess, 'fork', () => { throw Error('Must not fork.'); });
  const cancelled = await run(await fixture(), { signal: controller.signal });
  assert.equal(cancelled.error.code, 'LOCAL_ISOLATED_CANCELLED'); assert.equal(mock.mock.callCount(), 0);
});

test('an in-range BLOCKHASH has no fabricated ancestry and remains explicitly unsupported', async () => {
  const previous = BigInt(plan.header.number) - 1n;
  const result = await run(await fixture('0x63' + previous.toString(16).padStart(8, '0') + '4060005260206000f3'));
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'unsupported');
  assert.equal(result.output.execution.error.code, 'LOCAL_BLOCKHASH_MISSING'); assert.deepEqual(result.changes.accounts, []);
  assert.equal(result.broker.inRangeBlockhash, 'unsupported_without_independent_ancestry');
});

function fakeWorker(emit) {
  const child = new EventEmitter(); Object.assign(child, { connected: true, pid: 999999, stdout: new PassThrough(), stderr: new PassThrough() });
  child.send = (raw, callback) => { callback?.(); if (JSON.parse(raw).type === 'start') queueMicrotask(() => emit(child)); return true; };
  child.kill = signal => { child.connected = false; queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}
test('parent IPC rejects wrong method, block, IDs, concurrent reads and malformed results without extra dispatch', async t => {
  const f = await fixture(), base = { v: 1, type: 'rpc', id: 1, method: 'eth_getProof', params: [B, [], { blockHash: f.header.hash, requireCanonical: true }] };
  const invalid = [
    { ...base, method: 'debug_traceCall' }, { ...base, id: 2 }, { ...base, params: [B, [], 'latest'] },
    { ...base, params: [B, [], { blockHash: word(1), requireCanonical: true }] },
    { ...base, params: [B, [], { blockHash: f.header.hash, requireCanonical: false }] },
    { v: 1, type: 'result', id: 1, result: {} },
  ];
  for (const message of invalid) {
    const mock = t.mock.method(childProcess, 'fork', (_path, _args, options) => {
      assert.deepEqual(options.execArgv, ['--max-old-space-size=256']); assert.deepEqual(options.env, {});
      return fakeWorker(child => child.emit('message', JSON.stringify(message)));
    });
    const result = await run(f); mock.mock.restore();
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.output, null);
  }
  assert.equal(f.calls.length, 0);
  t.mock.method(childProcess, 'fork', () => fakeWorker(child => { child.emit('message', JSON.stringify(base)); child.emit('message', JSON.stringify({ ...base, id: 2 })); }));
  const concurrent = await run(f); assert.equal(concurrent.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(f.calls.length, 0);
});

test('diagnostic output is discarded, bounded, and never copied into a result', async t => {
  t.mock.method(childProcess, 'fork', () => fakeWorker(child => child.stderr.write('PRIVATE_DIAGNOSTIC'.repeat(10))));
  const result = await run(await fixture(), { limits: { stdioBytes: 10 } });
  assert.equal(result.error.code, 'LOCAL_ISOLATED_STDIO'); assert.equal(JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'), false);
});
