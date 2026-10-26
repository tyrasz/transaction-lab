import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { simulateStandard } from '../src/standard-simulation.js';

// Composite saved-result fixture, NOT an exact original wire replay. Automatic
// discovery changes call order. Each exact method+params occurrence consumes
// one genuine saved parsed result; no state, amount or response is invented.
const FIXTURE_MODE = 'composite_saved_results_keyed_by_exact_method_and_params';
const bytes = await readFile(new URL('../reports/standard-evm-api/aave-response.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '7c1e57462ea9974bbb5486538d0cf2182a26af22455fdac8ef79ccca17724936');
const recorded = JSON.parse(bytes), input = structuredClone(recorded.apiRequest);
delete input.queries;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const SENDER = '0x48c16c5652add27eddb0f896748a35fc60b8d1b4';
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const word = address => address.slice(2).padStart(64, '0');
const query = (to, account, spender) => ({ to, data: spender ? '0xdd62ed3e' + word(account) + word(spender) : '0x70a08231' + word(account) });
const expected = [
  { query: query(USDC, SENDER), beforeRaw: '3962903485', afterRaw: '0', deltaRaw: '-3962903485' },
  { query: query(ATOKEN, SENDER), beforeRaw: '0', afterRaw: '3962903484', deltaRaw: '3962903484' },
  { query: query(USDC, ATOKEN), beforeRaw: '151987610826648', afterRaw: '151991573730133', deltaRaw: '3962903485' },
  { query: query(USDC, SENDER, POOL), beforeRaw: '0', afterRaw: '0', deltaRaw: '0' },
];
const key = (method, params) => JSON.stringify([method, params]);
const queryKey = value => value.to + ':' + value.data;

function savedResults({ omitId } = {}) {
  const remaining = new Map(), used = [], unexpected = [];
  for (const row of recorded.transportEvidence) {
    assert.equal(row.error, undefined); assert.equal(row.transport.complete, true); assert.equal(row.transport.bodyRetained, true);
    assert.equal(createHash('sha256').update(row.responseText).digest('hex'), row.transport.responseSha256);
    const payload = JSON.parse(row.responseText); assert.equal(payload.id, row.id);
    if (row.id === omitId) continue;
    const identity = key(row.request.method, row.request.params), queue = remaining.get(identity) ?? [];
    queue.push({ row, result: payload.result }); remaining.set(identity, queue);
  }
  return { mode: FIXTURE_MODE, used, unexpected, rpc: { async call(method, params) {
    const queue = remaining.get(key(method, params));
    const saved = queue?.shift();
    if (!saved) {
      unexpected.push({ method, params: structuredClone(params) });
      throw new Error('Composite fixture has no unused exact saved result.');
    }
    try { assert.deepEqual({ method, params }, { method: saved.row.request.method, params: saved.row.request.params }); }
    catch (error) { unexpected.push({ method, params: structuredClone(params) }); throw error; }
    used.push(saved.row.id); return structuredClone(saved.result);
  } }, finish() {
    assert.deepEqual(unexpected, [], 'Engine-caught requests cannot hide an unexpected fixture lookup.');
    assert.equal(new Set(used).size, used.length, 'No saved occurrence can be silently reused.');
    assert.equal(used.length, recorded.transportEvidence.length);
    assert.ok([...remaining.values()].every(queue => queue.length === 0));
  } };
}

test('automatic Aave API adapter discovers four measured queries from composite saved results, not explicit query input', async () => {
  assert.equal(Object.hasOwn(input, 'queries'), false);
  const fixture = savedResults(), report = await simulateStandard(input, fixture.rpc);
  fixture.finish(); assert.equal(fixture.mode, FIXTURE_MODE);
  assert.notDeepEqual(fixture.used, recorded.transportEvidence.map(row => row.id), 'This fixture changes execution order and must not be labeled original wire replay.');
  assert.deepEqual(report.apiRequest, input); assert.equal(Object.hasOwn(report.apiRequest, 'queries'), false);
  assert.equal(report.execution.status, 'success'); assert.equal(report.canonicalStatus, 'verified');
  assert.equal(report.security.status, 'not_assessed'); assert.equal(report.scope.allEffectsCoverage, 'inconclusive');
  assert.equal(report.discovery.status, 'discovered'); assert.equal(report.discovery.counts.selected, 4);
  assert.equal(report.discovery.counts.omitted, 0); assert.equal(report.discovery.scope.tokenIdentityVerified, false);
  assert.equal(report.request.querySelection, 'bounded_observed_trace_candidates');
  assert.equal(report.preview.scope, 'observed_queried_accounts');
  const expectedByQuery = new Map(expected.map(item => [queryKey(item.query), item]));
  assert.equal(report.measurements.length, expectedByQuery.size);
  assert.deepEqual(new Set(report.request.queries.map(queryKey)), new Set(expectedByQuery.keys()));
  for (const measurement of report.measurements) {
    const value = expectedByQuery.get(queryKey(measurement.query)); assert.ok(value);
    assert.equal(measurement.status, 'measured');
    assert.deepEqual({ query: measurement.query, beforeRaw: measurement.beforeRaw, afterRaw: measurement.afterRaw, deltaRaw: measurement.deltaRaw }, value);
    assert.equal(measurement.basis, 'isolated_traced_ABI_queries_with_nonce_only_effects');
    assert.deepEqual(measurement.queryEvidence.map(proof => proof.state), ['before', 'after']);
    for (const proof of measurement.queryEvidence) {
      const trace = report.evidence[proof.traceEvidenceId - 1], diff = report.evidence[proof.mutationEvidenceId - 1];
      assert.equal(trace.method, 'debug_traceCall'); assert.equal(diff.method, 'debug_traceCall');
      assert.equal(trace.params[0].to, measurement.query.to); assert.equal(trace.params[0].data, measurement.query.data);
      assert.deepEqual(trace.params.slice(0, 2), diff.params.slice(0, 2));
      assert.equal(trace.params[2].tracer, 'callTracer'); assert.equal(diff.params[2].tracer, 'prestateTracer');
      assert.ok(trace.result && diff.result);
    }
  }
  const preview = report.preview.queries;
  assert.equal(preview.find(row => row.token === ATOKEN).deltaRaw, '3962903484', 'The receipt token amount is one unit below the deposited principal; do not copy the supply amount.');
  assert.equal(preview.find(row => row.token === USDC && row.account === ATOKEN).accountIsSender, false);
  assert.equal(preview.find(row => row.kind === 'allowance').afterRaw, '0', 'A permit approval and its consumption do not imply a nonzero final allowance.');
  assert.ok(preview.every(row => row.status === 'measured' && row.metadata.verifiedForSimulation === false));
});

test('missing independent aToken query response cannot be replaced by an observed mint or requested amount', async () => {
  const withheld = recorded.transportEvidence.find(row => row.request.method === 'debug_traceCall'
    && row.request.params[0].to === ATOKEN && row.request.params[0].data === query(ATOKEN, SENDER).data
    && row.request.params[2].tracer === 'callTracer' && row.request.params[2].stateOverrides);
  assert.ok(withheld, 'Negative control withholds an actual saved after-state query result.');
  const fixture = savedResults({ omitId: withheld.id }), report = await simulateStandard(input, fixture.rpc);
  assert.equal(fixture.unexpected.length, 1);
  assert.deepEqual(fixture.unexpected[0], { method: withheld.request.method, params: withheld.request.params });
  assert.throws(() => fixture.finish(), /Engine-caught requests cannot hide/);
  assert.equal(report.execution.status, 'success'); assert.equal(report.canonicalStatus, 'verified');
  const measurement = report.measurements.find(item => item.query.to === ATOKEN), preview = report.preview.queries.find(item => item.token === ATOKEN);
  assert.equal(measurement.status, 'unavailable'); assert.equal(preview.status, 'unavailable');
  for (const field of ['beforeRaw', 'afterRaw', 'deltaRaw']) { assert.equal(measurement[field], undefined); assert.equal(preview[field], undefined); }
  assert.equal(report.measurements.filter(item => item.status === 'measured').length, 3);
  assert.ok(report.discovery.observations.some(item => item.token === ATOKEN && item.kind === 'transfer_event'), 'Mint observation remains visible but cannot manufacture a measured value.');
});
