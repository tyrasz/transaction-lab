// Controls are synthetic mutations in memory. The observed packet is unchanged.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { audit, validateBindings, validateEnvelope, replayCaseStrict } from './audit.mjs';

const read = name => fs.readFile(new URL(name, import.meta.url), 'utf8').then(JSON.parse);
const [capture, plan, started] = await Promise.all(['capture.json', 'plan.json', 'STARTED.json'].map(read));
const clone = structuredClone;

test('genuine packet: all seventeen sources, two entire outputs and seventy-six RPC records reproduce', async () => {
  const result = await audit();
  assert.equal(result.verified, true);
  assert.equal(result.archivedSourceFiles, 17);
  assert.equal(result.runtimeModules, 10);
  assert.equal(result.rpcCalls, 76);
  assert.equal(result.completeResponseBodies, 76);
  assert.equal(result.retainedBytes, 443865);
  assert.equal(result.recordedRpcFailures, 0);
  assert.deepEqual(result.cases.map(c => [c.id, c.usedRpcIds.length, c.measurements.length, c.codeHashClaims]), [
    ['aave-usdc-supply-with-permit', 30, 4, 3], ['morpho-kiln-usdc-deposit', 46, 8, 5],
  ]);
});

test('inventories cannot agree with each other while differing from the frozen plan', () => {
  const bad = clone(capture), begin = clone(started);
  bad.sourceInventoryBefore[0].sha256 = '0'.repeat(64);
  bad.sourceInventoryAfter = clone(bad.sourceInventoryBefore);
  begin.sources = clone(bad.sourceInventoryBefore);
  assert.throws(() => validateBindings(bad, plan, begin));
  const missingPlan = clone(plan);
  missingPlan.sourceInventory = missingPlan.sourceInventory.filter(s => !s.path.endsWith('/unsigned-call.js'));
  const missing = clone(capture); missing.plan = missingPlan;
  missing.sourceInventoryBefore = clone(missingPlan.sourceInventory);
  missing.sourceInventoryAfter = clone(missingPlan.sourceInventory);
  begin.sources = clone(missingPlan.sourceInventory);
  assert.throws(() => validateBindings(missing, missingPlan, begin));
  const staleStart = clone(started); staleStart.sources[1].bytes++;
  assert.throws(() => validateBindings(capture, plan, staleStart));
});

test('missing, duplicated, reordered or changed case bindings are rejected', () => {
  for (const mutate of [
    c => { c.cases.pop(); },
    c => { c.cases[1] = clone(c.cases[0]); },
    c => { c.cases.reverse(); },
    c => { c.cases[0].originalTransactionHash = '0x' + '0'.repeat(64); },
    c => { c.cases[0].blockHash = '0x' + '0'.repeat(64); },
    c => { c.cases[0].queryRoles.pop(); },
    c => { c.cases[0].receiptReference.sha256 = '0'.repeat(64); },
  ]) {
    const bad = clone(capture); mutate(bad);
    assert.throws(() => validateBindings(bad, plan, started));
  }
});

test('wrong response ids, result-plus-error and changed wire bytes cannot be admitted', () => {
  for (const mutate of [
    c => { c.response.id++; },
    c => { c.response.error = null; },
    c => { c.request.bodyText += ' '; },
    c => { c.request.body.id++; },
    c => { c.http.status = 503; },
  ]) {
    const bad = clone(capture.cases[0].rpcCalls[0]); mutate(bad);
    assert.throws(() => validateEnvelope(bad, plan.endpoint));
  }
});

test('request, parameter and envelope mismatches remain failures after an engine catches them', async () => {
  const planned = plan.cases[0];
  const failureResult = { execution: { status: 'unavailable' } };
  const recorded = { rpcCalls: [clone(capture.cases[0].rpcCalls[0])], result: failureResult };
  const swallowingEngine = (method, params) => async ({ rpc }) => {
    try { await rpc.call(method, params); } catch {}
    return clone(failureResult);
  };
  await assert.rejects(replayCaseStrict(recorded, planned, plan, swallowingEngine('eth_getBalance', [])), /latched outside/);
  await assert.rejects(replayCaseStrict(recorded, planned, plan, swallowingEngine('eth_chainId', ['unexpected'])), /latched outside/);
  const wrongEnvelope = clone(recorded); wrongEnvelope.rpcCalls[0].response.id++;
  await assert.rejects(replayCaseStrict(wrongEnvelope, planned, plan, swallowingEngine('eth_chainId', [])), /latched outside/);
  const missing = { rpcCalls: [], result: failureResult };
  await assert.rejects(replayCaseStrict(missing, planned, plan, swallowingEngine('eth_chainId', [])), /latched outside/);
});

test('genuine-shaped recorded RPC failure is preserved, but malformed failure identity is not hidden', async () => {
  const saved = clone(capture.cases[0].rpcCalls[0]);
  saved.response = { jsonrpc: '2.0', id: saved.sequence, error: { code: -32000, message: 'Synthetic failure control.' } };
  saved.error = { code: 'RPC', message: 'The endpoint returned a JSON-RPC error.' };
  const unavailable = { execution: { status: 'unavailable' }, rawErrorRetained: true };
  const fakeEngine = async ({ rpc }) => {
    await assert.rejects(rpc.call('eth_chainId', []), /endpoint returned/);
    return clone(unavailable);
  };
  const recorded = { rpcCalls: [saved], result: unavailable };
  const replayed = await replayCaseStrict(recorded, plan.cases[0], plan, fakeEngine);
  assert.deepEqual(replayed.result, unavailable);
  saved.response.id++;
  await assert.rejects(replayCaseStrict(recorded, plan.cases[0], plan, fakeEngine), /latched outside/);
});

test('saved RPCs must be consumed once in exact order, and every result field is compared', async () => {
  const first = clone(capture.cases[0].rpcCalls[0]);
  const fakeResult = { execution: { status: 'success' }, evidence: [{ original: true }] };
  const recorded = { rpcCalls: [first], result: fakeResult };
  await assert.rejects(replayCaseStrict(recorded, plan.cases[0], plan, async () => clone(fakeResult)), /consumed exactly once/);
  await assert.rejects(replayCaseStrict(recorded, plan.cases[0], plan, async ({ rpc }) => {
    await rpc.call('eth_chainId', []);
    return { ...fakeResult, evidence: [] };
  }), /Entire result/);
  const two = { rpcCalls: clone(capture.cases[0].rpcCalls.slice(0, 2)), result: fakeResult };
  await assert.rejects(replayCaseStrict(two, plan.cases[0], plan, async ({ rpc }) => {
    for (const saved of two.rpcCalls.toReversed()) {
      try { await rpc.call(saved.request.body.method, saved.request.body.params); } catch {}
    }
    return clone(fakeResult);
  }), /latched outside/);
});
