import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { adjudicateCohortOutcome } from './cohort-outcomes.mjs';
import { createCohortSelection, accountCohortOutcomes } from './cohort-accounting.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const directory = new URL('../../reports/ethereum-lending-local-reference/', import.meta.url);
const manifestBytes = readFileSync(new URL('manifest.json', directory));
assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
const manifest = JSON.parse(manifestBytes);
function read(path) {
  const bytes = readFileSync(new URL(path, directory)), entry = manifest.files.find(x => x.path === path);
  assert(entry); assert.equal(entry.sha256, sha(bytes)); assert.equal(entry.bytes, bytes.length);
  return JSON.parse(bytes);
}
const plan = read('plan.json'), hex = value => '0x' + BigInt(value).toString(16), word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
// Existing evidence predates the isolated-wrapper identity field. This test-only
// wrapper derives a concrete digest from its sealed source inventory and Node
// runtime. It is not a new historical field or a fresh execution observation.
const identity = {
  name: 'Sealed proof-backed local reference fixture', version: 'test-wrapper-1',
  sourceSha256: sha(JSON.stringify({ runtime: plan.runtime, sourceFiles: plan.sourceFiles })),
  sourceFiles: plan.sourceFiles.map(x => x.path),
};
function fixture(index = 0) {
  const c = plan.cases[index];
  return { transactionHash: c.originalTransactionHash, request: structuredClone(c.request), header: structuredClone(c.header),
    expectedProductImplementation: structuredClone(plan.api.expectedImplementation), expectedLocalImplementation: structuredClone(identity),
    product: { dispatch: 'completed', httpStatus: 200, report: read(c.id + '-product.json') },
    local: { dispatch: 'completed', implementation: structuredClone(identity), attempt: read(c.id + '-local.json') } };
}
const original = (f, kind) => f.product.report.transportEvidence.find(e => e.request.method === 'debug_traceCall' && e.request.params[0].gas === '0x4c4b40' && e.request.params[2].tracer === kind);
function replaceResult(row, result) {
  row.responseText = JSON.stringify({ jsonrpc: '2.0', id: row.id, result });
  row.transport.responseSha256 = sha(row.responseText); row.transport.observedBytes = Buffer.byteLength(row.responseText);
}
function replaceRequest(row, request) { row.request = request; row.requestText = JSON.stringify(request); row.requestSha256 = sha(row.requestText); row.requestBytes = Buffer.byteLength(row.requestText); }
function setProductTrace(f, trace) {
  replaceResult(original(f, 'callTracer'), trace);
  f.product.report.execution = { status: trace.error ? 'reverted_or_failed' : 'success', gasUsed: BigInt(trace.gasUsed).toString(), returnData: trace.output ?? '0x', error: trace.error ?? null, revertReason: trace.revertReason ?? null, trace: structuredClone(trace) };
}
// Constructed controls only: these are not captured live transactions. Keep
// authentic contexts/proven inputs, but replace result channels coherently to
// exercise reverts, faults, value transfers and missing evidence independently.
function synthetic({ status = 'success', diff = true, value = 0n, nonceZero = false } = {}) {
  const f = fixture(), sender = f.request.from, target = f.request.to, attempt = f.local.attempt, output = attempt.output;
  f.request.value = hex(value); f.product.report.request.transaction.value = hex(value);
  const nonce = nonceZero ? 0n : BigInt(attempt.inputs.accounts[sender].nonce), balance = BigInt(attempt.inputs.accounts[sender].balance);
  if (nonceZero) { attempt.inputs.accounts[sender].nonce = '0x0'; const read = f.product.report.transportEvidence.find(e => e.request.method === 'eth_getTransactionCount'); replaceResult(read, '0x0'); }
  const intrinsic = BigInt(output.profile.intrinsicGas), beforeRefund = intrinsic + 1000n, floor = BigInt(output.profile.calldataFloor), adjustment = floor > beforeRefund ? floor - beforeRefund : 0n, gas = beforeRefund + adjustment;
  const error = status === 'reverted' ? 'execution reverted' : status === 'failed' ? 'invalid opcode: opcode 0xfe not defined' : null;
  const trace = { type: 'CALL', from: sender, to: target, input: f.request.data, value: hex(value), gas: '0x4c4b40', gasUsed: hex(gas), output: status === 'reverted' ? '0xdeadbeef' : '0x', ...(error ? { error } : {}) };
  for (const kind of ['callTracer', 'prestateTracer']) { const wire = original(f, kind), request = structuredClone(wire.request); request.params[0].value = hex(value); replaceRequest(wire, request); }
  setProductTrace(f, trace);
  const changes = [{ address: sender, nonce: { before: hex(nonce), after: hex(nonce + 1n) } }];
  const rawDiff = { pre: { [sender]: { nonce: hex(nonce), balance: hex(balance) } }, post: { [sender]: { nonce: hex(nonce + 1n) } } };
  if (nonceZero) delete rawDiff.pre[sender].nonce;
  if (value) {
    assert.equal(status, 'success'); const targetBalance = BigInt(attempt.inputs.accounts[target].balance);
    rawDiff.post[sender].balance = hex(balance - value); rawDiff.pre[target] = { balance: hex(targetBalance) }; rawDiff.post[target] = { balance: hex(targetBalance + value) };
    changes[0].balance = { before: hex(balance), after: hex(balance - value) };
    changes.push({ address: target, balance: { before: hex(targetBalance), after: hex(targetBalance + value) } });
  }
  replaceResult(original(f, 'prestateTracer'), rawDiff);
  if (!diff) f.product.report.transportEvidence = f.product.report.transportEvidence.filter(e => e !== original(f, 'prestateTracer'));
  const localError = status === 'reverted' ? 'revert' : status === 'failed' ? 'invalid opcode' : null;
  output.execution = { status, executionGasUsed: '1000', gasRefundCounter: '0', returnData: trace.output, error: localError };
  output.trace = { ...output.trace, input: f.request.data, value: hex(value), gasUsed: '0x3e8', output: trace.output, error: localError, calls: [] };
  output.logs = []; output.gasAccounting = { beforeRefund: beforeRefund.toString(), appliedRefund: '0', floorAdjustment: adjustment.toString(), gasUsed: gas.toString() };
  attempt.changes.accounts = changes;
  return f;
}

test('both sealed lending workloads match all five channels with exact existing wire evidence', () => {
  for (const index of [0, 1]) {
    const f = fixture(index), before = JSON.stringify(f), result = adjudicateCohortOutcome(f);
    assert.equal(JSON.stringify(f), before, 'Adjudicator does not mutate retained input');
    assert.equal(result.outcome.execution, 'success'); assert.equal(result.outcome.comparison, 'match'); assert.equal(result.allChannelsComplete, true);
    assert.deepEqual(Object.values(result.channels).map(c => c.status), Array(5).fill('match'));
    assert.equal(result.channels.committedLogs.product.length, index ? 16 : 7);
    assert.equal(result.channels.gasAccounting.product, index ? '1413682' : '189775');
  }
});
test('synthetic genuine reverts count as completed even without the provider diff; no state match is invented', () => {
  const result = adjudicateCohortOutcome(synthetic({ status: 'reverted', diff: false }));
  assert.equal(result.outcome.execution, 'reverted'); assert.equal(result.outcome.comparison, 'not_comparable');
  assert.equal(result.channels.fullObservedStateChanges.status, 'unavailable'); assert.match(result.channels.fullObservedStateChanges.reason, /diff missing/);
  for (const key of ['executionStatus', 'returnData', 'committedLogs', 'gasAccounting']) assert.equal(result.channels[key].status, 'match');
  assert.equal(result.evidence.product.rawExecutionError, 'execution reverted'); assert.equal(result.evidence.local.rawExecutionError, 'revert');
});
test('complete synthetic revert evidence can match without requiring success', () => {
  const result = adjudicateCohortOutcome(synthetic({ status: 'reverted' }));
  assert.deepEqual([result.outcome.execution, result.outcome.comparison], ['reverted', 'match']);
});
test('actual EVM exceptions are a distinct completed failed status, not revert or RPC failure', () => {
  const f = synthetic({ status: 'failed' }), result = adjudicateCohortOutcome(f);
  assert.deepEqual([result.outcome.execution, result.outcome.comparison], ['failed', 'match']);
  assert.equal(result.channels.executionStatus.product.exception, 'invalid_opcode');
  const selection = createCohortSelection({ chainId: 1, seed: word(11), sampleSize: 1, census: [{ transactionHash: f.transactionHash, blockHash: f.header.hash, blockNumber: BigInt(f.header.number).toString(), transactionIndex: '0' }] });
  assert.equal(accountCohortOutcomes(selection, [result.outcome]).metrics.executionAvailability.fraction, '1/1');
});
test('unknown provider errors cannot masquerade as completed EVM faults or leak into safe reasons', () => {
  const f = synthetic({ status: 'failed' }), trace = JSON.parse(original(f, 'callTracer').responseText).result;
  trace.error = 'provider failure https://credential.example/private-secret'; setProductTrace(f, trace);
  const result = adjudicateCohortOutcome(f); assert.equal(result.outcome.execution, 'provider_unavailable');
  assert.equal(result.outcome.comparison, 'not_comparable'); assert.doesNotMatch(JSON.stringify(result), /credential|private-secret/);
  assert.match(f.product.report.execution.error, /private-secret/, 'Raw error is retained in the unmodified source artifact');
});
test('local proof, transport, invalid-input and unsupported failures remain unknown oracle outcomes', () => {
  for (const change of [
    f => { f.local.dispatch = 'unavailable'; },
    f => { f.local.attempt.inputs.status = 'unavailable'; },
    f => { f.local.attempt.output.execution.status = 'unsupported'; },
    f => { f.local.attempt.output.execution.status = 'invalid'; },
    f => { f.local.attempt.output = null; },
  ]) { const f = fixture(); change(f); const r = adjudicateCohortOutcome(f); assert.equal(r.outcome.execution, 'success'); assert.equal(r.outcome.comparison, 'oracle_unavailable'); assert(Object.values(r.channels).every(c => c.status === 'unavailable')); }
});
test('budget slots are retained and outside-profile creation is unsupported', () => {
  const budget = fixture(); budget.product = { dispatch: 'budget_unattempted' };
  assert.deepEqual(adjudicateCohortOutcome(budget).outcome, { transactionHash: budget.transactionHash, execution: 'budget_unattempted', comparison: 'budget_unattempted' });
  const oracle = fixture(); oracle.local = { dispatch: 'budget_unattempted' }; assert.equal(adjudicateCohortOutcome(oracle).outcome.comparison, 'budget_unattempted');
  const creation = fixture(); creation.request.to = null; assert.equal(adjudicateCohortOutcome(creation).outcome.execution, 'unsupported');
  creation.product = { dispatch: 'budget_unattempted' }; assert.equal(adjudicateCohortOutcome(creation).outcome.execution, 'budget_unattempted');
  const unavailable = fixture(); unavailable.product.httpStatus = 503; assert.equal(adjudicateCohortOutcome(unavailable).outcome.execution, 'provider_unavailable');
});
test('retained RPC error envelopes are unavailable, not EVM faults; outward reasons omit private text', () => {
  const f = fixture(), row = original(f, 'callTracer');
  row.responseText = JSON.stringify({ jsonrpc: '2.0', id: row.id, error: { code: -32000, message: 'RPC_EXECUTION_ERROR private-provider-token' } });
  row.transport.responseSha256 = sha(row.responseText); row.transport.observedBytes = Buffer.byteLength(row.responseText);
  const result = adjudicateCohortOutcome(f); assert.equal(result.outcome.execution, 'provider_unavailable'); assert.equal(result.outcome.comparison, 'not_comparable');
  assert.doesNotMatch(JSON.stringify(result), /private-provider-token/); assert.match(row.responseText, /private-provider-token/);
});
test('explicit source-bound coded-sender rejection is unsupported, not a network failure', () => {
  const f = fixture(), p = f.product.report; p.canonicalStatus = 'unverified'; p.measurementFailure = 'Only code-free senders are supported.';
  const code = p.transportEvidence.find(e => e.request.method === 'eth_getCode' && e.request.params[0] === f.request.from); replaceResult(code, '0x6000');
  assert.equal(adjudicateCohortOutcome(f).outcome.execution, 'unsupported');
  replaceResult(code, '0x'); assert.equal(adjudicateCohortOutcome(f).outcome.execution, 'provider_unavailable');
});
test('wrong product source/header/envelope/summary evidence never counts completed execution', () => {
  for (const mutate of [
    f => { f.product.report.implementation.sourceSha256 = '0'.repeat(64); },
    f => { f.product.report.canonicalStatus = 'unverified'; },
    f => { const row = f.product.report.transportEvidence.find(e => e.request.method === 'eth_getBlockByNumber'); const h = JSON.parse(row.responseText).result; h.stateRoot = word(99); replaceResult(row, h); },
    f => { const row = original(f, 'callTracer'), req = structuredClone(row.request); req.params[0].value = '0x1'; replaceRequest(row, req); },
    f => { f.product.report.execution.returnData = '0x1234'; },
    f => { f.product.report.execution.error = 'execution reverted'; },
    f => { original(f, 'callTracer').responseText += ' '; },
    f => { f.product.report.transportEvidence.push(structuredClone(original(f, 'callTracer'))); },
  ]) { const f = fixture(); mutate(f); const r = adjudicateCohortOutcome(f); assert.equal(r.outcome.execution, 'provider_unavailable'); assert.equal(r.outcome.comparison, 'not_comparable'); }
});
test('wrong local source/profile/state and nonce evidence cannot manufacture a mismatch', () => {
  for (const mutate of [
    f => { f.local.implementation.sourceSha256 = '0'.repeat(64); },
    f => { f.local.attempt.inputs.context.stateRoot = word(99); },
    f => { f.local.attempt.output.profile.executionBaseFee = '1'; },
    f => { f.local.attempt.output.environment.timestamp = '1'; },
    f => { f.local.attempt.inputs.accounts[f.request.from].nonce = '0x1'; },
    f => { f.local.attempt.output.stateDisposition = 'rolled_back'; },
  ]) { const f = fixture(); mutate(f); assert.equal(adjudicateCohortOutcome(f).outcome.comparison, 'oracle_unavailable'); }
});
test('each complete differing channel is a mismatch and missing later evidence does not erase it', () => {
  const changes = [
    ['executionStatus', f => { f.local.attempt.output.execution.status = 'reverted'; f.local.attempt.output.execution.error = 'revert'; f.local.attempt.output.trace.error = 'revert'; }],
    ['returnData', f => { f.local.attempt.output.execution.returnData = '0xab'; f.local.attempt.output.trace.output = '0xab'; }],
    ['committedLogs', f => { f.local.attempt.output.logs.pop(); }],
    ['fullObservedStateChanges', f => { const storage = f.local.attempt.changes.accounts.find(x => x.storage).storage; storage[0].after = word(123); }],
    ['gasAccounting', f => { const p = original(f, 'callTracer'), trace = JSON.parse(p.responseText).result; trace.gasUsed = hex(BigInt(trace.gasUsed) + 1n); setProductTrace(f, trace); }],
  ];
  for (const [channel, mutate] of changes) { const f = fixture(); mutate(f); const result = adjudicateCohortOutcome(f); assert.equal(result.outcome.comparison, 'mismatch', channel); assert.equal(result.channels[channel].status, 'mismatch', channel); }
  const partial = synthetic({ diff: false }); partial.local.attempt.output.execution.returnData = '0xab'; partial.local.attempt.output.trace.output = '0xab';
  const result = adjudicateCohortOutcome(partial); assert.equal(result.channels.returnData.status, 'mismatch'); assert.equal(result.channels.fullObservedStateChanges.status, 'unavailable'); assert.equal(result.outcome.comparison, 'mismatch');
});
test('missing channel data never becomes an empty equality or a match', () => {
  for (const [channel, mutate] of [
    ['fullObservedStateChanges', f => { f.local.attempt.changes.accounts = undefined; }],
    ['committedLogs', f => { f.local.attempt.output.logs = undefined; }],
    ['gasAccounting', f => { f.local.attempt.output.gasAccounting = undefined; }],
  ]) { const f = fixture(); mutate(f); const result = adjudicateCohortOutcome(f); assert.equal(result.channels[channel].status, 'unavailable'); assert.equal(result.outcome.comparison, 'not_comparable'); }
});
test('execution availability is separate from ambiguous committed-log ordering', () => {
  const f = fixture(), trace = JSON.parse(original(f, 'callTracer').responseText).result;
  function strip(frame) { for (const log of frame.logs ?? []) { delete log.position; delete log.index; delete log.logIndex; } for (const c of frame.calls ?? []) strip(c); }
  strip(trace); setProductTrace(f, trace);
  const r = adjudicateCohortOutcome(f); assert.equal(r.outcome.execution, 'success'); assert.equal(r.channels.committedLogs.status, 'unavailable'); assert.equal(r.outcome.comparison, 'not_comparable');
});
test('valid reverted lifecycle trace stays a completed revert when the local engine cannot execute it', () => {
  const f = synthetic({ status: 'reverted', diff: false }), trace = JSON.parse(original(f, 'callTracer').responseText).result;
  trace.calls = [{ type: 'CREATE', from: f.request.to, to: '0x' + '12'.repeat(20), input: '0x6000', output: '0x', value: '0x0', gas: '0x100', gasUsed: '0x80', error: 'execution reverted' }];
  setProductTrace(f, trace); f.local.attempt.output.execution.status = 'unsupported';
  const r = adjudicateCohortOutcome(f); assert.equal(r.outcome.execution, 'reverted'); assert.equal(r.outcome.comparison, 'oracle_unavailable');
});
test('positive native value and independently proven omitted zero nonce are supported without funding', () => {
  for (const options of [{ value: 1n }, { nonceZero: true }]) { const r = adjudicateCohortOutcome(synthetic(options)); assert.equal(r.outcome.comparison, 'match'); }
});
test('full observed state refuses lifecycle, unknown storage and duplicate local accounts', () => {
  const mutations = [
    f => { const row = original(f, 'prestateTracer'), diff = JSON.parse(row.responseText).result; delete diff.post[f.request.from]; replaceResult(row, diff); },
    f => { const row = original(f, 'prestateTracer'), diff = JSON.parse(row.responseText).result; const account = Object.keys(diff.pre).find(k => diff.pre[k].storage); diff.pre[account].storage[word(999)] = word(1); diff.post[account].storage[word(999)] = word(2); replaceResult(row, diff); },
    f => { f.local.attempt.changes.accounts.push(structuredClone(f.local.attempt.changes.accounts[0])); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); const r = adjudicateCohortOutcome(f); assert.equal(r.channels.fullObservedStateChanges.status, 'unavailable'); assert.equal(r.outcome.comparison, 'not_comparable'); }
});
test('adjudicator labels only five observed channels, not inventory, consensus or source authenticity', () => {
  const result = adjudicateCohortOutcome(fixture()); assert.equal(Object.keys(result.channels).length, 5);
  assert(Object.values(result.limitations).every(x => x === false)); assert.equal(result.limitations.artifactHashesBound, false); assert.equal(result.limitations.tokenOrEventInventoryAccuracy, false);
});
