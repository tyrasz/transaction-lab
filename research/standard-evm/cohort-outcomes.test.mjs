import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { adjudicateCohortOutcome, providerChanges } from './cohort-outcomes.mjs';
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

// Development regression from a sealed prospective sample. This exercises the
// NEW comparator against unchanged recordings; it does not rewrite/reclassify
// the frozen sample, whose archived comparator still records not_comparable.
const cohortDirectory = new URL('../../reports/ordinary-ethereum-cohort-v2/', import.meta.url);
const cohortManifestBytes = readFileSync(new URL('evidence-manifest.json', cohortDirectory));
assert.equal(sha(cohortManifestBytes), '583dfee6412385547791da6069ed6e33322928e0b0231e645c4e956711d1bc2a');
const cohortManifest = JSON.parse(cohortManifestBytes);
function cohortRead(path) {
  const bytes = readFileSync(new URL(path, cohortDirectory)), entry = cohortManifest.files.find(e => e.path === path);
  assert(entry); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); return JSON.parse(bytes);
}
function nativeFixture() {
  const request = cohortRead('cases/005/request.json'), plan = cohortRead('plan.json'), q = request.projection.request;
  return { transactionHash: request.transactionHash, request: { from: q.from, to: q.to, data: q.data, value: q.value, gas: '5000000' },
    header: request.parentHeader, expectedProductImplementation: plan.productImplementation, expectedLocalImplementation: plan.localImplementation,
    product: cohortRead('cases/005/product.json'), local: cohortRead('cases/005/local.json') };
}
const nativeRow = f => f.local.attempt.changes.accounts.find(r => r.address === f.request.to);
const nativeProof = f => f.local.attempt.inputs.provenance.find(p => p.account === f.request.to);
function changeInputResult(e, mutate) { mutate(e.result); const text = JSON.stringify(e.result); e.resultSha256 = sha(text); e.resultBytes = Buffer.byteLength(text); }
function changeNativeDiff(f, mutate) { const row = original(f, 'prestateTracer'), diff = JSON.parse(row.responseText).result; mutate(diff); replaceResult(row, diff); }
function requireNativeUnavailable(f, label) {
  const result = adjudicateCohortOutcome(f);
  assert.equal(result.channels.fullObservedStateChanges.status, 'unavailable', label);
  assert.notEqual(result.outcome.comparison, 'match', label);
  return result;
}
test('new comparison matches recorded direct funding with exclusion proof; frozen outcome is unchanged', () => {
  const f = nativeFixture(), before = JSON.stringify(f), result = adjudicateCohortOutcome(f);
  assert.equal(JSON.stringify(f), before); assert.equal(result.outcome.execution, 'success'); assert.equal(result.outcome.comparison, 'match');
  assert.equal(result.channels.gasAccounting.product, '21000'); assert.equal(result.channels.committedLogs.product.length, 0);
  const recipient = result.channels.fullObservedStateChanges.product.find(r => r.address === f.request.to);
  assert.deepEqual(recipient, { address: f.request.to, existence: { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' }, balance: { before: '0x0', after: '0xb5e620f48000' } });
  assert.equal(result.limitations.independentProofsReverified, false);
  assert.equal(cohortRead('cases/005/outcome.json').outcome.comparison, 'not_comparable');
  assert.throws(() => providerChanges(JSON.parse(original(f, 'prestateTracer').responseText).result, f.local.attempt.inputs), /lifecycle/,
    'Unscoped public diff normalization cannot admit an absent account');
});
test('native admission accepts explicit unchanged zero fields or omitted pre-zero only with retained exclusion facts', () => {
  for (const explicit of [false, true]) {
    const f = nativeFixture(); changeNativeDiff(f, diff => {
      if (explicit) for (const phase of [diff.pre, diff.post]) Object.assign(phase[f.request.to], { nonce: 0, code: '0x', storage: {} });
      else delete diff.pre[f.request.to].balance;
    });
    assert.equal(adjudicateCohortOutcome(f).outcome.comparison, 'match');
  }
});
test('native exclusion admission requires exact retained proof/code identities and hashed bodies', () => {
  const controls = [
    ['missing proof result', f => { delete f.local.attempt.inputEvidence[2].result; }],
    ['proof hash mismatch', f => { f.local.attempt.inputEvidence[2].resultSha256 = '0'.repeat(64); }],
    ['unverified proof', f => { f.local.attempt.inputEvidence[2].verification = 'pending'; }],
    ['wrong block', f => { const e = f.local.attempt.inputEvidence[2]; e.request.params[2].blockHash = word(9); e.requestText = JSON.stringify(e.request); e.requestSha256 = sha(e.requestText); }],
    ['ambiguous evidence', f => { f.local.attempt.inputEvidence.push(structuredClone(f.local.attempt.inputEvidence[2])); }],
    ['wrong address', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.address = f.request.from; })],
    ['empty proof nodes', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.accountProof = []; })],
    ['nonzero proof nonce', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.nonce = '0x1'; })],
    ['nonzero proof balance', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.balance = '0x1'; })],
    ['mixed empty hashes', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.codeHash = nativeProof(f).accountProof.codeHash; })],
    ['proof storage', f => changeInputResult(f.local.attempt.inputEvidence[2], p => { p.storageProof = [{}]; })],
    ['nonempty code', f => { const e = f.local.attempt.inputEvidence[3]; e.result = '0x00'; e.resultSha256 = sha(JSON.stringify(e.result)); e.resultBytes = 6; }],
    ['missing provenance', f => { f.local.attempt.inputs.provenance.pop(); }],
    ['duplicate provenance', f => { f.local.attempt.inputs.provenance.push(structuredClone(nativeProof(f))); }],
    ['exists true in exclusion fact', f => { nativeProof(f).accountProof.exists = true; }],
    ['nonzero normalized balance', f => { nativeProof(f).accountProof.balanceRaw = '1'; }],
    ['nonempty normalized storage root', f => { nativeProof(f).accountProof.storageRoot = word(9); }],
    ['invented absent basics', f => { f.local.attempt.inputs.accounts[f.request.to].balance = '0'; }],
  ];
  for (const [name, mutate] of controls) { const f = nativeFixture(); mutate(f); requireNativeUnavailable(f, name); }
});
test('native admission rejects altered lifecycle markers and local overlay code/storage/nonce changes', () => {
  const controls = [
    ['basis', f => { nativeRow(f).existence.basis = 'CREATE'; }],
    ['existing before', f => { nativeRow(f).existence.before = true; }],
    ['deleted after', f => { nativeRow(f).existence.after = false; }],
    ['missing existence', f => { delete nativeRow(f).existence; }],
    ['nonce', f => { nativeRow(f).nonce = { before: '0x0', after: '0x1' }; }],
    ['code', f => { nativeRow(f).code = '0x6000'; }],
    ['storage', f => { nativeRow(f).storage = [{ slot: word(0), before: word(0), after: word(1) }]; }],
    ['nonzero prior balance', f => { nativeRow(f).balance.before = '0x1'; }],
    ['zero balance after', f => { nativeRow(f).balance.after = '0x0'; }],
    ['incorrect funding value', f => { nativeRow(f).balance.after = '0x1'; }],
    ['duplicate changes', f => { f.local.attempt.changes.accounts.push(structuredClone(nativeRow(f))); }],
    ['sender missing debit', f => { delete f.local.attempt.changes.accounts[0].balance; }],
  ];
  for (const [name, mutate] of controls) { const f = nativeFixture(); mutate(f); requireNativeUnavailable(f, name); }
});
test('native funding does not loosen raw whole-account/code/storage/nonce guards', () => {
  const controls = [
    ['post-only account', (d, f) => { delete d.pre[f.request.to]; }],
    ['pre-only account', (d, f) => { delete d.post[f.request.to]; }],
    ['new code', (d, f) => { d.post[f.request.to].code = '0x6000'; }],
    ['new code hash', (d, f) => { d.post[f.request.to].codeHash = word(3); }],
    ['new nonce', (d, f) => { d.post[f.request.to].nonce = 1; }],
    ['new storage', (d, f) => { d.post[f.request.to].storage = { [word(0)]: word(1) }; }],
    ['zero storage still outside scope', (d, f) => { d.pre[f.request.to].storage = { [word(0)]: word(0) }; }],
    ['unknown field', (d, f) => { d.post[f.request.to].deleted = true; }],
    ['no positive funding', (d, f) => { d.post[f.request.to].balance = '0x0'; }],
    ['nonzero pre balance', (d, f) => { d.pre[f.request.to].balance = '0x1'; }],
  ];
  for (const [name, mutate] of controls) { const f = nativeFixture(); changeNativeDiff(f, d => mutate(d, f)); requireNativeUnavailable(f, name); }
});
test('native funding excludes nested or lifecycle calls, logs and reverted materialization', () => {
  for (const type of ['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']) {
    const f = nativeFixture(), trace = JSON.parse(original(f, 'callTracer').responseText).result;
    trace.calls = [{ type, from: f.request.to, to: f.request.from, input: '0x', value: '0x0', gas: '0x100', gasUsed: '0x0', output: '0x', error: 'execution reverted' }];
    setProductTrace(f, trace); requireNativeUnavailable(f, type);
  }
  for (const mutate of [
    f => { f.local.attempt.output.trace.calls = [{ type: 'CALL' }]; },
    f => { f.local.attempt.output.execution.executionGasUsed = '15'; f.local.attempt.output.trace.gasUsed = '0xf'; },
    f => { f.local.attempt.output.logs = [{ address: f.request.to, topics: [], data: '0x' }]; },
    f => { const trace = JSON.parse(original(f, 'callTracer').responseText).result; trace.logs = [{ address: f.request.to, topics: [], data: '0x', position: 0 }]; setProductTrace(f, trace); },
    f => { const trace = JSON.parse(original(f, 'callTracer').responseText).result; trace.error = 'execution reverted'; setProductTrace(f, trace); },
  ]) { const f = nativeFixture(); mutate(f); requireNativeUnavailable(f, 'nontrivial or failed call'); }
});
test('valid but differing provider native balances remain mismatches, not hidden by new-account support', () => {
  for (const who of ['from', 'to']) {
    const f = nativeFixture(); changeNativeDiff(f, d => { d.post[f.request[who]].balance = hex(BigInt(d.post[f.request[who]].balance) + 1n); });
    const result = adjudicateCohortOutcome(f); assert.equal(result.outcome.comparison, 'mismatch'); assert.equal(result.channels.fullObservedStateChanges.status, 'mismatch');
  }
});

// Optional-context controls are synthetic comparisons, not new executions of
// the sealed sample's unsupported access-list/blob transactions. The original
// recordings have neither result; no missing provider response is fabricated.
const blobHash = '0x01' + 'ab'.repeat(31);
function contextFixture(context) {
  const f = synthetic(), o = f.local.attempt.output, p = o.profile;
  Object.assign(f.request, structuredClone(context));
  const rpcContext = { ...structuredClone(context), ...(context.blobVersionedHashes ? { maxFeePerBlobGas: '0x0' } : {}) };
  Object.assign(f.product.report.request.transaction, rpcContext);
  for (const kind of ['callTracer', 'prestateTracer']) {
    const e = original(f, kind), r = structuredClone(e.request); Object.assign(r.params[0], rpcContext);
    if (context.blobVersionedHashes) r.params[2].blockOverrides = { baseFeePerGas: '0x0', blobBaseFee: '0x0' };
    replaceRequest(e, r);
  }
  const addresses = context.accessList?.length ?? 0, keys = context.accessList?.reduce((n, r) => n + r.storageKeys.length, 0) ?? 0;
  const accessGas = BigInt(addresses) * 2400n + BigInt(keys) * 1900n;
  if (Object.hasOwn(context, 'accessList')) {
    Object.assign(p, { accessList: structuredClone(context.accessList), accessListAddressCount: String(addresses), accessListStorageKeyCount: String(keys), accessListIntrinsicGas: accessGas.toString() });
    o.semantics.warmAddresses = 'sender_destination_coinbase_fork_active_precompiles_and_declared_access_list';
  }
  if (context.blobVersionedHashes) Object.assign(p, { blobVersionedHashes: structuredClone(context.blobVersionedHashes), executionBlobBaseFee: '0', sourceExcessBlobGas: BigInt(f.header.excessBlobGas).toString() });
  p.intrinsicGas = (BigInt(p.intrinsicGas) + accessGas).toString(); p.messageGasLimit = (5000000n - BigInt(p.intrinsicGas)).toString();
  o.trace.gas = hex(p.messageGasLimit);
  const before = BigInt(p.intrinsicGas) + BigInt(o.execution.executionGasUsed), floor = BigInt(p.calldataFloor), adjustment = floor > before ? floor - before : 0n;
  o.gasAccounting = { beforeRefund: before.toString(), appliedRefund: '0', floorAdjustment: adjustment.toString(), gasUsed: (before + adjustment).toString() };
  const trace = JSON.parse(original(f, 'callTracer').responseText).result; trace.gasUsed = hex(before + adjustment); setProductTrace(f, trace);
  return f;
}
const repeatedAccess = () => [
  { address: '0x' + '12'.repeat(20), storageKeys: [word(3), word(3)] },
  { address: '0x' + '12'.repeat(20), storageKeys: [word(3)] },
  { address: '0x' + '34'.repeat(20), storageKeys: [] },
];
test('synthetic access-list/blob comparisons preserve explicit empty lists, duplicates and order', () => {
  for (const context of [{ accessList: [] }, { accessList: repeatedAccess() }, { blobVersionedHashes: [blobHash, blobHash] }, { accessList: repeatedAccess(), blobVersionedHashes: [blobHash] }]) {
    const f = contextFixture(context), before = JSON.stringify(f), result = adjudicateCohortOutcome(f);
    assert.equal(result.outcome.comparison, 'match'); assert.equal(result.allChannelsComplete, true); assert.equal(JSON.stringify(f), before);
    if (context.accessList?.length) assert.equal(f.local.attempt.output.profile.accessListIntrinsicGas, '12900', 'Every occurrence incurs its intrinsic cost');
  }
});
test('provider original trace and diff must both retain the exact optional context and zero blob cap', () => {
  for (const [name, mutate] of [
    ['missing access list', e => { delete e.accessList; }],
    ['reordered access list', e => { e.accessList.reverse(); }],
    ['deduplicated slots', e => { e.accessList[0].storageKeys.pop(); }],
    ['missing hashes', e => { delete e.blobVersionedHashes; }],
    ['changed hash', e => { e.blobVersionedHashes[0] = '0x01' + 'cd'.repeat(31); }],
    ['missing cap', e => { delete e.maxFeePerBlobGas; }],
    ['priced cap', e => { e.maxFeePerBlobGas = '0x1'; }],
  ]) for (const kind of ['callTracer', 'prestateTracer']) {
    const f = contextFixture({ accessList: repeatedAccess(), blobVersionedHashes: [blobHash] });
    const wire = original(f, kind), request = structuredClone(wire.request); mutate(request.params[0]); replaceRequest(wire, request);
    assert.equal(adjudicateCohortOutcome(f).outcome.execution, 'provider_unavailable', `${name}: ${kind}`);
  }
});
test('both original blob tracers require only the exact synthetic zero blob fee override', () => {
  for (const mutate of [o => { delete o.blockOverrides; }, o => { o.blockOverrides.blobBaseFee = '0x1'; }, o => { o.blockOverrides.baseFeePerGas = '0x1'; }, o => { delete o.blockOverrides.baseFeePerGas; }, o => { o.blockOverrides.number = '0x1'; }]) {
    for (const kind of ['callTracer', 'prestateTracer']) {
      const f = contextFixture({ blobVersionedHashes: [blobHash] }), wire = original(f, kind), request = structuredClone(wire.request);
      mutate(request.params[2]); replaceRequest(wire, request);
      assert.equal(adjudicateCohortOutcome(f).outcome.execution, 'provider_unavailable');
    }
  }
});

test('local optional context identities, cost counts and warming cannot be silently dropped or changed', () => {
  for (const [name, mutate] of [
    ['omitted list', o => { delete o.profile.accessList; }],
    ['reordered list', o => { o.profile.accessList.reverse(); }],
    ['deduplicated list', o => { o.profile.accessList.splice(0, 1); }],
    ['address count', o => { o.profile.accessListAddressCount = '2'; }],
    ['key count', o => { o.profile.accessListStorageKeyCount = '2'; }],
    ['access gas', o => { o.profile.accessListIntrinsicGas = '0'; }],
    ['warming', o => { o.semantics.warmAddresses = 'sender_only'; }],
    ['omitted hashes', o => { delete o.profile.blobVersionedHashes; }],
    ['hash order', o => { o.profile.blobVersionedHashes.reverse(); }],
    ['blob base fee', o => { o.profile.executionBlobBaseFee = '1'; }],
    ['source excess', o => { o.profile.sourceExcessBlobGas = (BigInt(o.profile.sourceExcessBlobGas) + 1n).toString(); }],
    ['wrong fork', o => { o.profile.hardfork = 'cancun'; }],
  ]) {
    const f = contextFixture({ accessList: repeatedAccess(), blobVersionedHashes: [blobHash, '0x01' + 'cd'.repeat(31)] }); mutate(f.local.attempt.output);
    assert.equal(adjudicateCohortOutcome(f).outcome.comparison, 'oracle_unavailable', name);
  }
  const legacy = fixture(); legacy.local.attempt.output.profile.accessList = [];
  assert.equal(adjudicateCohortOutcome(legacy).outcome.comparison, 'oracle_unavailable', 'Legacy context is not silently warmed with an undeclared list');
});
test('intrinsic gas and calldata floor are independently recomputed, not accepted from self-consistent claims', () => {
  for (const mutate of [
    o => { const p = o.profile; p.intrinsicGas = (BigInt(p.intrinsicGas) - 1900n).toString(); p.messageGasLimit = (5000000n - BigInt(p.intrinsicGas)).toString(); o.trace.gas = hex(p.messageGasLimit); o.gasAccounting.beforeRefund = (BigInt(p.intrinsicGas) + BigInt(o.execution.executionGasUsed)).toString(); },
    o => { o.profile.calldataFloor = '0'; },
    o => { o.profile.calldataZeroBytes = '0'; },
    o => { o.profile.calldataNonzeroBytes = '0'; },
  ]) {
    const f = contextFixture({ accessList: repeatedAccess() }); mutate(f.local.attempt.output);
    const result = adjudicateCohortOutcome(f); assert.equal(result.channels.gasAccounting.status, 'unavailable'); assert.notEqual(result.outcome.comparison, 'match');
  }
});
test('malformed or excessive optional context and client-supplied fee fields remain unsupported', () => {
  for (const fields of [
    { accessList: null }, { accessList: [{ address: '0x1234', storageKeys: [] }] },
    { accessList: [{ address: '0x' + '12'.repeat(20), storageKeys: [word(1)], extra: true }] },
    { accessList: Array.from({ length: 129 }, () => ({ address: '0x' + '12'.repeat(20), storageKeys: [] })) },
    { blobVersionedHashes: [] }, { blobVersionedHashes: [word(1)] }, { blobVersionedHashes: Array(33).fill(blobHash) },
    { blobVersionedHashes: [blobHash], maxFeePerBlobGas: '0x0' }, { authorizationList: [] },
  ]) { const f = fixture(); Object.assign(f.request, fields); assert.equal(adjudicateCohortOutcome(f).outcome.execution, 'unsupported'); }
});
test('synthetic declared fork boundaries control blob admission and calldata floor independently', () => {
  function headerAt(f, timestamp, hardfork) {
    f.header.timestamp = hex(timestamp); f.local.attempt.inputs.context.header = structuredClone(f.header);
    const o = f.local.attempt.output; o.environment.timestamp = String(timestamp); o.environment.hardfork = hardfork; o.profile.hardfork = hardfork;
    for (const e of f.product.report.transportEvidence.filter(e => ['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(e.request.method))) replaceResult(e, f.header);
  }
  const blobBeforeCancun = contextFixture({ blobVersionedHashes: [blobHash] }); headerAt(blobBeforeCancun, 1710338134, 'shanghai');
  assert.equal(adjudicateCohortOutcome(blobBeforeCancun).outcome.comparison, 'oracle_unavailable');
  for (const [timestamp, hardfork] of [[1746612310, 'cancun'], [1746612311, 'prague']]) {
    const f = contextFixture({ accessList: [] }); headerAt(f, timestamp, hardfork);
    const o = f.local.attempt.output, p = o.profile;
    const floor = timestamp < 1746612311 ? 0n : 21000n + 10n * (BigInt(p.calldataZeroBytes) + 4n * BigInt(p.calldataNonzeroBytes));
    p.calldataFloor = floor.toString(); const before = BigInt(p.intrinsicGas) + BigInt(o.execution.executionGasUsed), extra = floor > before ? floor - before : 0n;
    Object.assign(o.gasAccounting, { beforeRefund: before.toString(), floorAdjustment: extra.toString(), gasUsed: (before + extra).toString() });
    const trace = JSON.parse(original(f, 'callTracer').responseText).result; trace.gasUsed = hex(before + extra); setProductTrace(f, trace);
    assert.equal(adjudicateCohortOutcome(f).outcome.comparison, 'match', hardfork);
  }
});
