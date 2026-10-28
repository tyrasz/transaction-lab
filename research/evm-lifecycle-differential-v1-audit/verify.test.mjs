import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, validateManifestShape, validateSeal, validateReference, validateProofJoins, replayRpc, normalizeAttempt, independentGas } from './verify.mjs';

const read = relative => fs.readFileSync(path.join(capture, relative));
const json = relative => JSON.parse(read(relative));
const plan = json('plan.json'), manifest = json('manifest.json'), declaration = json(plan.cases[0].path);
const product = json('results/001-product.json'), seal = json('results/001-PRODUCT_SEALED.json'), reference = json('results/001-reference.json');

test('manifest accounting rejects missing, duplicate and foreign declared-case files', () => {
  validateManifestShape(plan, manifest);
  for (const change of [m => m.files.pop(), m => m.files.push(m.files[0]), m => m.files[0].path = 'foreign.json', m => m.files[0].path = '../escape.json']) {
    const mutated = structuredClone(manifest); change(mutated); assert.throws(() => validateManifestShape(plan, mutated));
  }
});
test('product prefix seal binds exact saved bytes, identity and plan', () => {
  validateSeal(plan.cases[0], read('results/001-product.json'), seal);
  for (const change of [s => s.caseIndex++, s => s.caseId += '-foreign', s => s.productSha256 = '0'.repeat(64), s => s.productBytes++, s => s.planSha256 = '0'.repeat(64)]) {
    const mutated = structuredClone(seal); change(mutated); assert.throws(() => validateSeal(plan.cases[0], read('results/001-product.json'), mutated));
  }
  assert.throws(() => validateSeal(plan.cases[0], Buffer.concat([read('results/001-product.json'), Buffer.from(' ')]), seal));
});
test('reference completed status cannot hide abnormal termination or changed serialized input', () => {
  validateReference(reference, declaration);
  for (const change of [r => r.exitCode = 1, r => r.signal = 'SIGKILL', r => r.status = 'unavailable', r => r.stdout = '{}', r => r.result.output.serializedTransaction = '0x']) {
    const mutated = structuredClone(reference); change(mutated); assert.throws(() => validateReference(mutated, declaration));
  }
});
test('proof joins reject omitted reads, altered result bytes, request identity and counters', () => {
  validateProofJoins(product, declaration);
  for (const change of [p => p.proofRecords.pop(), p => p.proofRecords[0].result.balance = '0x1',
    p => p.proofRecords[0].request.params[0] = '0x' + '11'.repeat(20), p => p.attempt.broker.calls++,
    p => p.attempt.inputEvidence[0].resultSha256 = '0'.repeat(64), p => p.attempt.broker.pendingAtReturn = 1]) {
    const mutated = structuredClone(product); change(mutated); assert.throws(() => validateProofJoins(mutated, declaration));
  }
});
test('playback latches unexpected input even when the consumer catches the rejection', async () => {
  const replay = replayRpc(product.proofRecords);
  try { await replay.rpc.call('eth_getProof', ['unexpected']); } catch { /* simulated engine catch */ }
  assert.throws(() => replay.assertComplete());
  const missing = replayRpc(product.proofRecords); assert.throws(() => missing.assertComplete());
});
test('exact playback preserves all repeated positions and rejects reads beyond the retained sequence', async () => {
  const records = [product.proofRecords[0], product.proofRecords[0]], replay = replayRpc(records);
  for (const record of records) assert.deepEqual(await replay.rpc.call(record.request.method, record.request.params), record.result);
  replay.assertComplete();
  await assert.rejects(() => replay.rpc.call(records[0].request.method, records[0].request.params));
  assert.throws(() => replay.assertComplete());
});
test('replay normalization excludes only bounded process identity and elapsed durations', () => {
  const modified = structuredClone(product.attempt); modified.isolation.childPid++; modified.isolation.durationMs++;
  for (const row of [...modified.inputEvidence, ...modified.broker.records]) row.durationMs++;
  assert.deepEqual(normalizeAttempt(modified), normalizeAttempt(product.attempt));
  for (const change of [r => r.output.execution.executionGasUsed = '1', r => r.output.limits.wallMs--,
    r => r.inputUsage.limits.wallMs--, r => r.isolation.limits.wallMs--, r => r.changes.accounts = []]) {
    const mutated = structuredClone(product.attempt); change(mutated);
    assert.notDeepEqual(normalizeAttempt(mutated), normalizeAttempt(product.attempt));
  }
  for (const value of [-1, NaN, Infinity, '1']) { const mutated = structuredClone(product.attempt); mutated.isolation.durationMs = value; assert.throws(() => normalizeAttempt(mutated)); }
});
test('independent gas derivation rejects altered intrinsic, charged gas and invalid refund', () => {
  assert.equal(independentGas(declaration, product.attempt.output), reference.result.output.gasUsed);
  for (const change of [o => o.profile.intrinsicGas = '21000', o => o.gasAccounting.gasUsed = '1', o => o.execution.gasRefundCounter = '-1']) {
    const mutated = structuredClone(product.attempt.output); change(mutated); assert.throws(() => independentGas(declaration, mutated));
  }
});
