import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compilePreviewQueries } from '../../engines/local-evm/preview-queries.js';
import { committedLogs } from '../../reports/ethereum-lending-local-reference/compare.mjs';
import { compareQueryObservation, compareOriginalObservation, compareLendingSequence, providerSequenceContexts, requireQueryState } from './observations.mjs';

// These controls synthesize counterpart shapes from SAVED provider output.
// They test the comparator, never count as independent execution agreement.
const saved = JSON.parse(fs.readFileSync(new URL('../../reports/standard-evm-positions-v3/aave-approval-position-sequence-response.json', import.meta.url)));
function queryControl(index = 0) {
  const result = structuredClone(saved.steps[0].result), provider = result.measurements[index];
  const compiled = compilePreviewQueries(saved.apiRequest.calls[0].queries, { chainId: 1 })[index];
  const side = name => {
    const e = result.evidence.find(e => e.id === provider.queryEvidence.find(q => q.state === name).traceEvidenceId);
    return { status: 'measured', output: { execution: { status: 'success', returnData: e.result.output }, trace: structuredClone(e.result) } };
  };
  const values = provider.position ? provider.rows : [{ name: compiled.fields[0].name, beforeRaw: provider.beforeRaw, afterRaw: provider.afterRaw, deltaRaw: provider.deltaRaw }];
  return { compiled, local: { ...structuredClone(compiled), status: 'measured', before: side('before'), after: side('after'), values: structuredClone(values) },
    provider, providerResult: result, from: saved.apiRequest.from, blockHash: saved.apiRequest.block,
    expectedOverrides: providerSequenceContexts({ steps: saved.steps, calls: saved.apiRequest.calls, from: saved.apiRequest.from, blockHash: saved.apiRequest.block })[0] };
}
function originalControl(index = 0) {
  const providerStep = structuredClone(saved.steps[index]), p = providerStep.result;
  const { queries, ...call } = saved.apiRequest.calls[index];
  const request = { from: saved.apiRequest.from, ...call, gas: '5000000' };
  return { request, blockHash: saved.apiRequest.block, providerStep,
    localStep: { status: 'completed', request: structuredClone(request), original: { output: {
      execution: { status: 'success', returnData: p.execution.returnData },
      gasAccounting: { beforeRefund: p.execution.gasUsed, appliedRefund: '0', floorAdjustment: '0', gasUsed: p.execution.gasUsed },
      logs: committedLogs(p.execution.trace),
    } } } };
}
const allNull = channels => assert(Object.values(channels).every(v => v === null));

test('query eligibility requires two anchored overlays but does not hide a valid state disagreement', () => {
  const valid = { status: 'comparable', localChanges: { accounts: [] }, providerChanges: { accounts: [] }, matches: false };
  assert.doesNotThrow(() => requireQueryState(valid));
  for (const state of [null, { ...valid, status: 'unavailable' }, { ...valid, localChanges: null }, { ...valid, providerChanges: null }]) {
    assert.throws(() => requireQueryState(state), /getter state is not validated/);
  }
});

test('saved scalar and typed-position shapes parse as distinct query controls', () => {
  for (const index of [0, 1]) {
    const result = compareQueryObservation(queryControl(index));
    assert.equal(result.error, null); assert.deepEqual(Object.values(result.channels), [true, true, true]);
    assert.equal(result.scope, 'corresponding_sequence_snapshots_different_getter_gas_limits');
    assert.equal(result.localGas, '1000000'); assert.equal(result.providerGas, '300000');
  }
});
test('unavailable and missing getter states retain null channels', () => {
  for (const change of [x => x.local.status = 'unavailable', x => x.provider.status = 'not_applicable', x => x.local.after = null]) {
    const x = queryControl(); change(x); const r = compareQueryObservation(x); assert(r.error); allNull(r.channels);
  }
});
test('request, identity, calldata, gas and state-selector substitutions are rejected', () => {
  const mutations = [
    x => x.local.identity.owner = '0x' + '11'.repeat(20),
    x => x.local.query.data = '0x',
    x => x.local.after.output.trace.from = '0x' + '22'.repeat(20),
    x => x.provider.query.to = '0x' + '33'.repeat(20),
    x => x.providerResult.evidence.find(e => e.id === x.provider.queryEvidence[0].traceEvidenceId).params[0].gas = '0xf4240',
    x => x.blockHash = '0x' + '00'.repeat(32),
    x => x.provider.position = { identity: {}, returnBytes: 32 },
  ];
  for (const change of mutations) { const x = queryControl(); change(x); const r = compareQueryObservation(x); assert(r.error); allNull(r.channels); }
});
test('projected amount tampering cannot pass because the raw getter bytes agree', () => {
  for (const change of [x => x.local.values[0].afterRaw = '999', x => x.provider.deltaRaw = '1', x => x.local.values[0].name = 'wrong']) {
    const x = queryControl(); change(x); const r = compareQueryObservation(x); assert(r.error); allNull(r.channels);
  }
});
test('missing, duplicate or differently overridden mutation evidence is rejected', () => {
  for (const change of [
    x => x.provider.queryEvidence.push(x.provider.queryEvidence[0]),
    x => x.provider.queryEvidence[0].mutationEvidenceId = 99999,
    x => x.providerResult.evidence.find(e => e.id === x.provider.queryEvidence[0].mutationEvidenceId).params[2].stateOverrides = { unexpected: {} },
  ]) { const x = queryControl(); change(x); const r = compareQueryObservation(x); assert(r.error); allNull(r.channels); }
});
test('even internally consistent getter overrides must match the selected sequence side', () => {
  const x = queryControl();
  for (const id of [x.provider.queryEvidence[0].traceEvidenceId, x.provider.queryEvidence[0].mutationEvidenceId]) {
    x.providerResult.evidence.find(e => e.id === id).params[2].stateOverrides = structuredClone(x.expectedOverrides.after);
  }
  const r = compareQueryObservation(x); assert(r.error); allNull(r.channels);
});
test('saved provider cumulative contexts bind raw diffs and prior state before comparison', () => {
  const args = { steps: structuredClone(saved.steps), calls: saved.apiRequest.calls, from: saved.apiRequest.from, blockHash: saved.apiRequest.block };
  const contexts = providerSequenceContexts(args);
  assert.equal(contexts[0].before, undefined); assert.deepEqual(contexts[1].before, contexts[0].after);
  args.steps[0].result.stateDiff.post[args.from].nonce = '999';
  assert.throws(() => providerSequenceContexts(args), /Projected state diff/);
});
test('a valid raw trace at the wrong original starting overlay is rejected', () => {
  const args = { steps: structuredClone(saved.steps), calls: saved.apiRequest.calls, from: saved.apiRequest.from, blockHash: saved.apiRequest.block };
  const e = args.steps[1].result.evidence.find(e => e.method === 'debug_traceCall' && e.params[0]?.data === args.calls[1].data && e.params[2]?.tracer === 'callTracer');
  e.params[2].stateOverrides = {};
  assert.throws(() => providerSequenceContexts(args), /wrong preceding state/);
});
test('original RPC options cannot select a different transaction position or disable evidence', () => {
  for (const mutate of [
    e => e.params[2].txIndex = 0,
    e => e.params[2].tracerConfig.disableStorage = true,
    e => e.params.push({ stateOverrides: {} }),
  ]) {
    const args = { steps: structuredClone(saved.steps), calls: saved.apiRequest.calls, from: saved.apiRequest.from, blockHash: saved.apiRequest.block };
    for (const e of args.steps[0].result.evidence.filter(e => e.method === 'debug_traceCall' && e.params[0]?.data === args.calls[0].data)) mutate(e);
    assert.throws(() => providerSequenceContexts(args), /Unexpected original/);
  }
});
test('typed position identity and ABI return lengths cannot be substituted', () => {
  for (const change of [x => x.provider.position.identity.user = x.provider.query.to, x => x.provider.beforeReturnData = '0x', x => x.local.before.output.execution.returnData = '0x']) {
    const x = queryControl(1); change(x); const r = compareQueryObservation(x); assert(r.error); allNull(r.channels);
  }
});
test('different valid getter values are mismatches, not unavailable or passing zeros', () => {
  const x = queryControl(); const before = '9007199254740993', after = '9007199254740994';
  x.local.before.output.execution.returnData = '0x' + BigInt(before).toString(16).padStart(64, '0');
  x.local.after.output.execution.returnData = '0x' + BigInt(after).toString(16).padStart(64, '0');
  x.local.values = [{ name: 'allowance', beforeRaw: before, afterRaw: after, deltaRaw: '1' }];
  const r = compareQueryObservation(x); assert.equal(r.error, null); assert.deepEqual(Object.values(r.channels), [false, false, false]);
  assert.equal(r.localValues[0].beforeRaw, before);
});
test('saved original controls distinguish output channels from uncomputed state', () => {
  for (const index of [0, 1]) {
    const r = compareOriginalObservation(originalControl(index)); assert.equal(r.error, null);
    assert.deepEqual(r.channels, { executionStatus: true, returnData: true, chargedGas: true, orderedLogs: true, observedNetState: null });
  }
});
test('missing originals and unverified canonical context are never execution matches', () => {
  for (const change of [x => x.localStep.status = 'not_attempted', x => x.providerStep.status = 'skipped', x => x.providerStep.result.canonicalStatus = 'unverified']) {
    const x = originalControl(); change(x); const r = compareOriginalObservation(x); assert(r.error); allNull(r.channels);
  }
});
test('original envelope and gas-accounting inconsistencies withhold channels', () => {
  for (const change of [
    x => x.request.value = '1',
    x => x.localStep.original.output.gasAccounting.appliedRefund = '1',
    x => x.providerStep.result.execution.gasUsed = '1',
    x => x.providerStep.result.executionIdentity.executionBaseFee = '1',
    x => x.providerStep.result.execution.status = 'reverted_or_failed',
    x => x.providerStep.result.evidence = [],
    x => x.blockHash = '0x' + '00'.repeat(32),
  ]) { const x = originalControl(); change(x); const r = compareOriginalObservation(x); assert(r.error); allNull(r.channels); }
});
test('valid differing original return/gas/logs are retained as measured mismatches', () => {
  const x = originalControl(), o = x.localStep.original.output;
  o.execution.returnData = '0x'; o.gasAccounting.beforeRefund = '21000'; o.gasAccounting.gasUsed = '21000'; o.logs = [];
  const r = compareOriginalObservation(x); assert.equal(r.error, null);
  assert.deepEqual(r.channels, { executionStatus: true, returnData: false, chargedGas: false, orderedLogs: false, observedNetState: null });
});
test('missing full capture gate preserves every declared position/query in denominator', async () => {
  const declaration = { id: 'negative-control', from: saved.apiRequest.from, header: { hash: saved.apiRequest.block },
    localInput: { calls: [{}, {}, {}], queries: saved.apiRequest.calls[0].queries }, steps: ['approve', 'supply', 'withdraw'].map(operation => ({ operation })) };
  const r = await compareLendingSequence({ declaration, localRecord: null, providerRecord: null });
  assert(r.gateError); assert.equal(r.steps.length, 3);
  assert.deepEqual(r.counts, { originalChannels: { matched: 0, mismatched: 0, unavailable: 15 }, queryChannels: { matched: 0, mismatched: 0, unavailable: 18 } });
});
