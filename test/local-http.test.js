import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { validateLocalSimulation, withholdLocalSimulation, LOCAL_CAPABILITIES } from '../src/local-simulation.js';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
const input = () => ({ chainId: 1, from: A, to: B, data: '0x', value: '0', queries: [{ to: B, data: '0x70a08231' + A.slice(2).padStart(64, '0') }] });
const identity = Object.freeze({ name: 'synthetic HTTP routing control', sourceSha256: 'a'.repeat(64), version: 'test' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('HTTP control did not reach its expected stage.')), 5000); })]); }
  finally { clearTimeout(timer); }
}
const report = () => ({ kind: 'local_proof_preview', id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-27T00:00:00.000Z', status: 'partial', execution: { status: 'reverted' }, measurements: [{ status: 'unavailable', values: null }], attempt: null, transportEvidence: [] });
const usage = () => ({ remainingWallMs: 10000, clockValid: true });
const api = simulateLocal => ({ validateLocalSimulation, withholdLocalSimulation, LOCAL_CAPABILITIES, implementation: identity, simulateLocal: simulateLocal ?? (async () => report()) });
async function start(t, options = {}) {
  const server = createAppServer({ persist: false, standardLoader: async () => null, localLoader: async () => api(), ...options });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, value = input(), options = {}) => fetch(base + '/api/evm/local-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...options });

test('owned capability is independent of the standard engine and configuration creates no transport', async t => {
  let constructed = 0;
  const base = await start(t, { proofRpcFactory() { constructed++; assert.fail('Configuration needs no provider.'); } });
  const response = await fetch(base + '/api/config'); assert.equal(response.status, 200);
  const config = await response.json(); assert.equal(config.localEvm.available, true);
  assert.deepEqual(config.localEvm.capabilities, LOCAL_CAPABILITIES); assert.equal(config.standardEvm.available, false);
  assert.equal(constructed, 0); assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('local route rejects malformed requests, unsupported fields and origins before provider construction', async t => {
  let constructed = 0, simulated = 0;
  const base = await start(t, { localLoader: async () => api(async () => { simulated++; assert.fail('Invalid request reached simulation.'); }), proofRpcFactory() { constructed++; assert.fail('No provider allowed.'); } });
  for (const change of [{ chainId: 999 }, { gas: '20999' }, { gas: '5000001' }, { gas: 21000 }, { gasPrice: '1' }, { stateOverrides: {} }, { rpcUrl: 'https://external.invalid' }, { value: '0x0' }, { to: undefined }, { data: '0x1' }, { block: 'pending' }, { queries: [] }, { queries: null }, { queries: Array(9).fill(input().queries[0]) }]) {
    const response = await post(base, { ...input(), ...change }); assert.equal(response.status, 400); assert.ok((await response.json()).error.code);
  }
  const missing = input(); delete missing.queries; assert.equal((await post(base, missing)).status, 400);
  assert.equal((await post(base, input(), { body: '{invalid' })).status, 400);
  assert.equal((await post(base, input(), { headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await post(base, input(), { headers: { 'content-type': 'application/json', origin: 'https://external.invalid' } })).status, 403);
  const huge = await post(base, { ...input(), data: '0x' + '11'.repeat(128 * 1024) });
  assert.equal(huge.status, 400); assert.equal((await huge.json()).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(constructed, 0); assert.equal(simulated, 0);
});

test('missing owned dependencies disable only this route and create no proof transport', async t => {
  let constructed = 0;
  const base = await start(t, { localLoader: async () => null, proofRpcFactory() { constructed++; assert.fail('Disabled engine must not construct transport.'); } });
  const response = await post(base); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'LOCAL_EVM_UNAVAILABLE');
  const config = await (await fetch(base + '/api/config')).json(); assert.equal(config.localEvm.available, false); assert.equal(config.localEvm.capabilities, null);
  assert.equal((await fetch(base + '/api/health')).status, 200); assert.equal(constructed, 0);
});

test('actual HTTP retains core statuses and raw result, attaches implementation and saves the same JSON', async t => {
  const reportDir = await mkdtemp(join(tmpdir(), 'local-preview-http-')); t.after(() => rm(reportDir, { recursive: true, force: true }));
  let constructed = 0, cancelled = 0, signal;
  const rpc = { usage, cancel() { cancelled++; } };
  const original = report(); original.syntheticRoutingOnly = true;
  const base = await start(t, { persist: true, reportDir, proofRpcFactory() { constructed++; return rpc; }, localLoader: async () => api(async (request, received, options) => {
    assert.deepEqual(request, input()); assert.equal(received, rpc); signal = options.signal; assert.equal(signal.aborted, false); return structuredClone(original);
  }) });
  const response = await post(base); assert.equal(response.status, 200);
  const actual = await response.json(); assert.deepEqual(actual, { ...original, implementation: identity });
  assert.deepEqual(JSON.parse(await readFile(join(reportDir, 'simulations', original.id + '.json'), 'utf8')), actual);
  assert.equal(constructed, 1); assert.equal(cancelled, 1); assert.equal(signal.aborted, true);
});

test('local imports cannot bypass shared two-simulation limit and slots release afterward', async t => {
  const loaded = deferred(), allEntered = deferred(), twoRunning = deferred(), finish = deferred();
  let loads = 0, constructed = 0, running = 0;
  t.after(() => { loaded.resolve(); finish.resolve(); });
  const implementation = api(async () => { if (++running === 2) twoRunning.resolve(); await finish.promise; return report(); });
  const base = await start(t, { localLoader: async () => { if (++loads === 3) allEntered.resolve(); await loaded.promise; return implementation; }, proofRpcFactory() { constructed++; return { usage, cancel() {} }; }, rpcFactory() { assert.fail('Busy legacy route must not construct a provider.'); } });
  const requests = [post(base), post(base), post(base)];
  await bounded(allEntered.promise); assert.equal(constructed, 0); loaded.resolve(); await bounded(twoRunning.promise);
  assert.equal((await bounded(Promise.race(requests))).status, 429); assert.equal(constructed, 2);
  const standard = await fetch(base + '/api/evm/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
  assert.equal(standard.status, 429);
  finish.resolve(); assert.deepEqual((await Promise.all(requests)).map(r => r.status).sort(), [200, 200, 429]);
  assert.equal((await post(base)).status, 200); assert.equal(constructed, 3);
});

test('client disconnect aborts the running owned request and cancels transport before releasing its slot', async t => {
  const entered = deferred(), cancelled = deferred(), completed = deferred(); let calls = 0, transportCancels = 0;
  t.after(() => cancelled.resolve());
  const base = await start(t, { proofRpcFactory: () => ({ usage, cancel() { transportCancels++; } }), localLoader: async () => api(async (_request, _rpc, { signal }) => {
    if (++calls === 1) {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); entered.resolve();
      await cancelled.promise; assert.equal(signal.aborted, true); completed.resolve();
    }
    return report();
  }) });
  const controller = new AbortController();
  const request = post(base, input(), { signal: controller.signal }).catch(error => error);
  await bounded(entered.promise); controller.abort(); await bounded(cancelled.promise); await bounded(completed.promise); await request;
  assert.ok(transportCancels >= 1); assert.equal((await post(base)).status, 200);
});
