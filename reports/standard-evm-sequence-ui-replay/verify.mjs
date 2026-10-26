// Offline file audit after browser QA, not a browser or network rerun.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url)), PACKET = path.resolve(HERE, '../standard-evm-sequence');
const ORDER = ['supply-without-approval', 'approve-then-supply', 'approve-supply-repeat'];
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFile(path.join(HERE, file));
const json = async file => JSON.parse(await read(file));
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--manifest-sha256' && /^[0-9a-f]{64}$/.test(args[1]), 'Supply the independently confirmed live packet manifest hash.');
const binding = await json('binding.json'), log = await json('playback-results.json');
assert.equal(binding.manifestSha256, args[1]);
const manifestBytes = await fs.readFile(path.join(PACKET, 'manifest.json')), manifest = JSON.parse(manifestBytes);
assert.equal(sha(manifestBytes), args[1]);
async function boundRead(file) {
  const entry = manifest.files.find(item => item.path === file); assert.ok(entry);
  const bytes = await fs.readFile(path.join(PACKET, file));
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); return bytes;
}
const planBytes = await boundRead('plan.json'), plan = JSON.parse(planBytes);
assert.equal(sha(planBytes), binding.planSha256); assert.equal(manifest.planSha256, binding.planSha256);
assert.equal(binding.replayScriptSha256, sha(await read('replay-server.mjs')));
assert.deepEqual(binding.sourceFiles, plan.sources); assert.deepEqual(binding.implementation, plan.implementation);
assert.deepEqual(binding.plannedBrowserOrder, ORDER); assert.equal(binding.responseDelayMs, 50);
assert.equal(binding.publicNetworkRequests, 0); assert.equal(binding.mode, 'offline_browser_replay');
for (const source of plan.sources) {
  const bytes = await boundRead('source/' + source.path); assert.equal(bytes.length, source.bytes); assert.equal(sha(bytes), source.sha256);
}
const fingerprint = createHash('sha256');
for (const file of plan.implementation.sourceFiles) fingerprint.update(file + '\0').update(await boundRead('source/' + file)).update('\0');
assert.equal(fingerprint.digest('hex'), binding.implementation.sourceSha256);
assert.equal(log.mode, 'offline_browser_replay'); assert.equal(log.publicNetworkRequests, 0); assert.deepEqual(log.failures, []);
assert.deepEqual(log.plannedBrowserOrder, ORDER); assert.deepEqual(log.completed.map(row => row.id), ORDER); assert.equal(log.attempts.length, 3);
const semantic = value => {
  const copy = structuredClone(value); delete copy.id; delete copy.createdAt; delete copy.timing;
  for (const step of copy.steps ?? []) if (step.result) { delete step.result.id; delete step.result.createdAt; delete step.result.timing; }
  for (const record of copy.transportEvidence) delete record.transport.durationMs;
  return copy;
};
let rpcCount = 0, responseBytes = 0; const cases = [];
for (const [index, completed] of log.completed.entries()) {
  const planned = plan.cases[index], attempt = log.attempts[index];
  assert.equal(planned.id, completed.id); assert.equal(attempt.caseId, planned.id); assert.equal(attempt.index, index + 1);
  assert.equal(attempt.method, 'POST'); assert.equal(attempt.path, planned.route); assert.equal(attempt.contentType, 'application/json');
  assert.equal(attempt.requestBytes, Buffer.byteLength(attempt.requestText)); assert.equal(attempt.requestSha256, sha(attempt.requestText));
  assert.deepEqual(JSON.parse(attempt.requestText), planned.input); assert.deepEqual(completed.input, planned.input);
  assert.equal(completed.requestSha256, attempt.requestSha256);
  for (const call of completed.input.calls ?? [completed.input]) assert.equal(Object.hasOwn(call, 'queries'), false);
  const originalBytes = await boundRead(planned.id + '-response.json'), replayBytes = await read(planned.id + '-response.json');
  assert.equal(sha(originalBytes), completed.sourceResponseSha256); assert.equal(sha(replayBytes), completed.replayResponseSha256);
  assert.equal(binding.sourceResponses.find(row => row.id === planned.id).sha256, sha(originalBytes));
  assert.equal(attempt.responseSha256, sha(replayBytes)); assert.equal(attempt.responseBytes, replayBytes.length);
  const original = JSON.parse(originalBytes), replay = JSON.parse(replayBytes);
  assert.deepEqual(semantic(replay), semantic(original)); assert.deepEqual(replay.apiRequest, planned.input);
  assert.equal(attempt.httpStatus, 200); assert.equal(completed.httpStatus, 200); assert.equal(attempt.error, undefined);
  assert.equal(attempt.semanticResult, 'matched'); assert.equal(completed.semanticResult, 'matched');
  const ids = original.transportEvidence.map((_, i) => i + 1);
  assert.deepEqual(completed.consumedRpcIds, ids); assert.deepEqual(attempt.consumedRpcIds, ids); assert.equal(attempt.rpcAttempts.length, ids.length);
  for (const [i, record] of original.transportEvidence.entries()) {
    const requested = attempt.rpcAttempts[i];
    assert.equal(record.id, i + 1); assert.equal(record.request.id, i + 1); assert.equal(record.request.jsonrpc, '2.0');
    assert.equal(record.requestText, JSON.stringify(record.request)); assert.equal(sha(record.requestText), record.requestSha256);
    assert.equal(record.requestBytes, Buffer.byteLength(record.requestText));
    assert.equal(requested.index, i); assert.equal(requested.matched, true); assert.equal(requested.recordedId, i + 1);
    assert.equal(requested.bodyText, record.requestText); assert.equal(requested.sha256, sha(record.requestText));
    assert.equal(requested.responseSha256, sha(record.responseText));
    for (const key of ['responseSha256', 'observedPrefixSha256', 'retainedPrefixSha256']) assert.equal(record.transport[key], sha(record.responseText));
    assert.equal(record.transport.observedBytes, Buffer.byteLength(record.responseText)); assert.equal(record.transport.retainedPrefixBytes, Buffer.byteLength(record.responseText));
    assert.equal(record.transport.complete, true); assert.equal(record.transport.bodyRetained, true); assert.equal(record.error, undefined);
    const envelope = JSON.parse(record.responseText); assert.equal(envelope.id, i + 1); assert.equal(envelope.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(envelope, 'result')); assert.equal(Object.hasOwn(envelope, 'error'), false);
    rpcCount++; responseBytes += record.transport.observedBytes;
  }
  cases.push({ id: planned.id, httpStatus: 200, semanticResult: 'matched', recordedRpcResponses: ids.length,
    canonicalStatus: replay.canonicalStatus, sequence: replay.sequence ?? null,
    steps: (replay.steps ?? [{ index: 0, result: replay }]).map(step => ({ index: step.index, status: step.status ?? step.result?.execution.status,
      execution: step.result?.execution.status ?? null, stateSource: step.stateSource ?? null,
      tokenMeasurements: step.result?.preview.queries.map(row => ({ kind: row.kind, token: row.token, account: row.account, owner: row.owner, spender: row.spender, status: row.status, beforeRaw: row.beforeRaw, afterRaw: row.afterRaw, deltaRaw: row.deltaRaw })) ?? [],
      nativeMeasurements: step.result?.preview.nativeBalances.map(row => ({ account: row.account, status: row.status, beforeRaw: row.beforeRaw, afterRaw: row.afterRaw, deltaRaw: row.deltaRaw })) ?? [],
    })) });
}
assert.equal(rpcCount, binding.recordedRpcResponses);
console.log(JSON.stringify({ status: 'passed', verificationMode: 'offline_file_audit_of_browser_replay', publicNetworkRequests: 0,
  manifestSha256: binding.manifestSha256, sourceFilesVerified: binding.sourceFiles.length,
  recordedRpcResponsesConsumed: rpcCount, recordedRpcResponseBytes: responseBytes, cases,
  limitations: ['This audit verifies archived source and exact replay data, not visual appearance.',
    'Browser observations are recorded separately by the root task.', 'Recorded provider responses are not new independent execution evidence.'] }, null, 2));
