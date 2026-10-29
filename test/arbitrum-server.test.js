import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createAppServer } from '../src/server.js';
import { InputError } from '../src/validate.js';
import { simulateArbitrum, validateArbitrumSimulation, withholdArbitrumSimulation, ARBITRUM_CAPABILITIES, ARBITRUM_EXAMPLES } from '../src/arbitrum-simulation.js';
import { decodeCctpHypercoreIntent } from '../src/arbitrum-cctp.js';

const api = { simulateArbitrum, validateArbitrumSimulation, ARBITRUM_CAPABILITIES, ARBITRUM_EXAMPLES, implementation: { name: 'recorded-test-adapter' } };
const input = () => structuredClone(ARBITRUM_EXAMPLES[0].request);
const post = (base, body, headers = {}) => fetch(base + '/api/arbitrum/simulate', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function start(t, options = {}) {
  const server = createAppServer({ persist: false, arbitrumLoader: async () => api, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Arbitrum input and origin validation happen before creating a transport', async t => {
  let transports = 0;
  const base = await start(t, { arbitrumOptions() { transports++; throw new Error('Must not create transport'); } });
  for (const fields of [{ chainId: 1 }, { to: null }, { gas: '5000001' }, { gas: '02000000' }, { value: '-1' }, { stateOverrides: [] }, { fees: {} }, { block: 'pending' }, { block: '0x' + 'a'.repeat(64) }]) {
    const response = await post(base, { ...input(), ...fields });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal((await response.json()).error.code, 'ARBITRUM_INPUT');
  }
  assert.equal((await post(base, input(), { origin: 'https://untrusted.example' })).status, 403);
  assert.equal(transports, 0);
});

test('missing Arbitrum engine leaves health available and reports explicit unavailability', async t => {
  const base = await start(t, { arbitrumLoader: async () => null });
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.arbitrumEvm.available, false); assert.deepEqual(config.arbitrumEvm.examples, []);
  assert.equal((await post(base, input())).status, 503);
  assert.equal((await (await fetch(base + '/api/health')).json()).readOnly, true);
});

test('pre-dispatch deadline and cancellation have explicit unavailable HTTP responses', async t => {
  for (const code of ['ARBITRUM_DEADLINE', 'ARBITRUM_CANCELLED']) {
    const base = await start(t, { arbitrumLoader: async () => ({ ...api, async simulateArbitrum() { throw Object.assign(new Error('Stopped before dispatch'), { code }); } }) });
    const response = await post(base, input()); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, code);
  }
});

test('withheld observations do not retain a usable measured-asset count', () => {
  const raw = { retained: true }, report = { assetChanges: [{ deltaRaw: '-100' }], coverage: { discoveredAssets: 2, measuredAssets: 2, unverifiedAssets: 0 }, rawViem: raw };
  withholdArbitrumSimulation(report, 'ARBITRUM_SOURCE_CHANGED');
  assert.equal(report.coverage.measuredAssets, 0); assert.equal(report.coverage.unverifiedAssets, null); assert.equal(report.coverage.observationsWithheld, true);
  assert.deepEqual(report.assetChanges, []); assert.equal(report.rawViem, raw);
});

test('Arbitrum shares the concurrency limit and checks again after asynchronous loading', async t => {
  const loaded = deferred(), entered = deferred(), running = deferred(), done = deferred();
  let loads = 0, starts = 0;
  t.after(() => { loaded.resolve(); done.resolve(); });
  const base = await start(t, { arbitrumLoader: async () => {
    if (++loads === 3) entered.resolve(); await loaded.promise;
    return { ...api, async simulateArbitrum() { if (++starts === 2) running.resolve(); await done.promise; return { status: 'partial' }; } };
  } });
  const requests = [post(base, input()), post(base, input()), post(base, input())];
  await entered.promise; loaded.resolve(); await running.promise;
  const busy = await Promise.race(requests); assert.equal(busy.status, 429); assert.equal(starts, 2);
  done.resolve(); assert.deepEqual((await Promise.all(requests)).map(r => r.status).sort(), [200, 200, 429]);
});

test('disconnect cancels the active Arbitrum transport and releases its shared slot', async t => {
  const started = deferred(), cancelled = deferred(); let calls = 0;
  const base = await start(t, { arbitrumLoader: async () => ({ ...api, async simulateArbitrum(_input, { signal }) {
    if (++calls > 1) return { status: 'partial' };
    started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cancelled.resolve(); return { status: 'unavailable' };
  } }) });
  const request = http.request(base + '/api/arbitrum/simulate', { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {}); request.end(JSON.stringify(input()));
  await started.promise; request.destroy(); await cancelled.promise;
  assert.equal((await post(base, input())).status, 200);
});

test('protocol interpretation never turns a requested burn into a measured debit or destination credit', () => {
  const request = validateArbitrumSimulation(input());
  const decoded = decodeCctpHypercoreIntent({ chainId: '42161', from: request.from, to: request.to, data: request.data, value: request.value });
  assert.equal(decoded.status, 'recognized_intent'); assert.equal(decoded.intent.requestedBurn.amountRaw, '100000000');
  assert.equal(decoded.intent.maxFee.kind, 'cap_not_quote'); assert.equal(decoded.intent.destination.requestedBalance, 'perps');
  for (const key of ['sourceExecution', 'measuredOutgoingAmount', 'destinationSettlement', 'destinationCreditAmount']) assert.equal(decoded.intent[key], null);
  assert.equal(decoded.intent.basis.destinationRecipientValidationVerified, false);
  const other = { ...request, chainId: '42161', to: '0x' + '11'.repeat(20) }; delete other.gas; delete other.block;
  assert.equal(decodeCctpHypercoreIntent(other).status, 'unrecognized');
  assert.throws(() => validateArbitrumSimulation({ ...input(), chainId: 999 }), InputError);
});

test('production HTTP adapter replays the saved live revert without inventing a 100 USDC debit', async t => {
  const directory = new URL('../research/arbitrum-viem-deposit-v1/capture/wire/', import.meta.url);
  const wires = Array.from({ length: 11 }, (_, i) => {
    const id = String(i + 1).padStart(3, '0');
    return { request: JSON.parse(readFileSync(new URL(`${id}-request.json`, directory))), response: JSON.parse(readFileSync(new URL(`${id}-response.body`, directory))) };
  });
  const used = [], mismatches = [];
  const fetchImpl = async (url, options) => {
    try {
      assert.equal(String(url), 'https://arb1.arbitrum.io/rpc');
      const requested = JSON.parse(options.body);
      const record = wires.find(row => row.request.method === requested.method && JSON.stringify(row.request.params) === JSON.stringify(requested.params));
      assert.ok(record, `Unexpected request ${requested.method}`); used.push(record.request.id);
      // Only the transport envelope ID changes; the saved provider result is unchanged.
      return Response.json({ ...record.response, id: requested.id });
    } catch (error) { mismatches.push(error); throw error; }
  };
  const base = await start(t, { arbitrumOptions: () => ({ fetchImpl }) });
  const response = await post(base, input()); assert.equal(response.status, 200);
  const result = await response.json(); assert.deepEqual(mismatches, []);
  assert.equal(result.source.headerConfirmed, true); assert.equal(result.execution.status, 'reverted');
  assert.equal(result.execution.gasUsed, '58256'); assert.deepEqual(result.execution.logs, []);
  assert.equal(result.protocol.intent.requestedBurn.amountRaw, '100000000');
  assert.equal(result.protocol.intent.measuredOutgoingAmount, null); assert.equal(result.protocol.intent.destinationCreditAmount, null);
  assert.ok(!result.assetChanges.some(row => row.deltaRaw === '-100000000'));
  assert.equal(result.coverage.inventoryComplete, false); assert.equal(result.security.status, 'not_assessed');
  assert.ok(used.includes(7) && used.includes(10) && used.includes(11));
  assert.ok(Array.isArray(result.transportEvidence) && result.transportEvidence.length > 0);
});
