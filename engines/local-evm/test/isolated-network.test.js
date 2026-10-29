// Authenticated synthetic MPT fixtures only; no public RPC or network inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';
import { compilePreviewQueries } from '../preview-queries.js';
import { ETHEREUM_NETWORK_SCHEDULES } from '../ethereum-network.js';
import { lifecycleFixture, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const queries = [{ kind: 'native_balance', account: SENDER }, { to: FACTORY, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') }];
const fixture = () => lifecycleFixture({ code: '0x4660005260206000f3' });
const options = (f, extra = {}) => ({ request: f.request, header: f.header, rpc: f.rpc, ...extra });
const run = (f, extra = {}) => executeIsolatedEthereumCall(options(f, extra));
const preview = (f, extra = {}) => executeIsolatedEthereumPreview(options(f, { queries, ...extra }));

test('default and explicit mainnet use identical retained context and actual CHAINID execution', async t => {
  const starts = [], fork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), send = child.send;
    child.send = function (raw, ...rest) { const message = JSON.parse(raw); if (message.type === 'start') starts.push(message.payload); return send.call(this, raw, ...rest); };
    return child;
  });
  const a = await run(await fixture()), b = await run(await fixture(), { chainId: 1 });
  for (const result of [a,b]) {
    assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.output.execution.status, 'success');
    assert.equal(result.output.execution.returnData, word(1)); assert.equal(result.output.environment.chainId, 1);
    assert.equal(result.output.profile.chainId, 1); assert.equal(result.output.profile.forkSchedule, ETHEREUM_NETWORK_SCHEDULES[1]);
    assert.equal(result.inputs.context.chainId, 1); assert.equal(result.headerVerification.chainId, undefined);
    assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitCode, 0);
  }
  for (const key of ['execution','trace','profile','environment','semantics','gasAccounting']) assert.deepEqual(a.output[key], b.output[key]);
  assert.deepEqual(a.changes, b.changes); assert.deepEqual(a.inputs, b.inputs);
  assert.equal(starts.length, 2); assert.deepEqual(starts[0], starts[1]); assert.equal(Object.hasOwn(starts[0], 'chainId'), false);
});

test('actual native and disposable CALL previews preserve mainnet scope and separately bound query identities', async () => {
  const result = await preview(await fixture(), { chainId: 1 });
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.preview.status, 'complete');
  const p = result.preview; assert.equal(p.scope.chainId, 1); assert.equal(p.inputs.context.chainId, 1);
  const compiled = compilePreviewQueries(queries);
  p.measurements.forEach((row, i) => { assert.deepEqual(row.identity, compiled[i].identity); assert.equal(row.status, 'measured'); });
  assert.deepEqual(p.measurements[0].values[0], { name: 'balance', beforeRaw: '1000000', afterRaw: '1000000', deltaRaw: '0', unit: { kind: 'native_wei', scale: '1000000000000000000' } });
  assert.equal(p.measurements[1].values[0].beforeRaw, '1'); assert.equal(p.measurements[1].values[0].afterRaw, '1');
  for (const side of ['before','after']) {
    assert.equal(p.measurements[1][side].output.environment.chainId, 1);
    assert.equal(p.measurements[1][side].output.profile.forkSchedule, ETHEREUM_NETWORK_SCHEDULES[1]);
  }
});

test('unsupported selectors and claims inside request/header/query cannot select a network before dispatch', async t => {
  let forks = 0, traps = 0;
  t.mock.method(childProcess, 'fork', () => { forks++; throw Error('must not fork'); });
  const hostile = new Proxy({}, { get() { traps++; throw Error('must not coerce'); }, getPrototypeOf() { traps++; throw Error('must not reflect'); } });
  const f = await fixture();
  for (const chainId of [null,0,999,42161,'1','11155111',1n,11155111n,NaN,Infinity,hostile]) {
    const call = await run(f, { chainId }), measured = await preview(f, { chainId });
    assert.equal(call.error.code, 'LOCAL_ISOLATED_INPUT'); assert.equal(call.output, null);
    assert.equal(measured.error.code, 'LOCAL_ISOLATED_INPUT'); assert.equal(measured.preview, null);
    const core = await executeEthereumPreview(options(f, { queries, chainId }));
    assert.equal(core.error.code, 'LOCAL_PREVIEW_INPUT'); assert.equal(core.original, null);
  }
  for (const patch of [{ request: { ...f.request, chainId: 11155111 } }, { header: { ...f.header, chainId: 11155111 } }, { queries: [{ ...queries[0], chainId: 11155111 }] }]) {
    const result = await preview(f, patch); assert.equal(result.error.code, 'LOCAL_ISOLATED_INPUT'); assert.equal(result.preview, null);
  }
  // A current mainnet header lacks Amsterdam's Sepolia suffixes. Its timestamp
  // cannot be relabeled as a valid Sepolia header by selecting another chain.
  const wrong = await run(f, { chainId: 11155111 }); assert.equal(wrong.error.code, 'LOCAL_ISOLATED_INPUT');
  assert.equal(forks, 0); assert.equal(f.calls.length, 0); assert.equal(traps, 0);
});

test('a changed host-to-worker selector cannot yield a mainnet result or pass its parent context checks', async t => {
  for (const chainId of [11155111,999]) {
    const fork = childProcess.fork; let changed = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), send = child.send;
      child.send = function(raw, ...rest) {
        const message = JSON.parse(raw);
        if (message.type === 'start') { message.payload.chainId = chainId; changed = true; raw = JSON.stringify(message); }
        return send.call(this, raw, ...rest);
      }; return child;
    });
    try { const result = await run(await fixture()); assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.output, null); assert.equal(result.isolation.processClosed, true); }
    finally { mock.mock.restore(); }
  }
});

async function tampered(t, mutate, previewMode = false) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...args) {
      if (event === 'message' && typeof args[0] === 'string') {
        const message = JSON.parse(args[0]);
        if (message.type === 'result') { mutate(message.result); changed = true; args[0] = JSON.stringify(message); }
      }
      return emit.call(this, event, ...args);
    }; return child;
  });
  try {
    const result = await (previewMode ? preview(await fixture()) : run(await fixture()));
    assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(previewMode ? result.preview : result.output, null);
  } finally { mock.mock.restore(); }
}

test('parent independently rejects forged execution, input proof and fork schedule labels', async t => {
  for (const mutate of [
    r => { r.inputs.context.chainId = 11155111; },
    r => { r.output.environment.chainId = 11155111; },
    r => { r.output.profile.chainId = 11155111; },
    r => { r.output.profile.forkSchedule = ETHEREUM_NETWORK_SCHEDULES[11155111]; },
    r => { r.output.stateGasAccounting = {}; },
  ]) await tampered(t, mutate);
});

test('parent independently rejects forged preview scope, native/CALL identities and fresh query network labels', async t => {
  for (const mutate of [
    r => { r.preview.scope.chainId = 11155111; },
    r => { r.preview.headerVerification.chainId = 11155111; },
    r => { r.preview.measurements[0].identity.chainId = '11155111'; },
    r => { r.preview.measurements[1].identity.chainId = '11155111'; },
    r => { r.preview.measurements[1].before.output.environment.chainId = 11155111; },
    r => { r.preview.measurements[1].after.output.profile.forkSchedule = ETHEREUM_NETWORK_SCHEDULES[11155111]; },
  ]) await tampered(t, mutate, true);
});
