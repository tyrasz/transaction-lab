// Offline audit only: no fetch, no endpoint access, no replacement responses.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { simulateUnsignedCall } from '../../engines/standard-evm/unsigned-call.js';
import { canonicalStateDiff } from '../../src/state-diff.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const captureBytes = await fs.readFile(path.join(directory, 'capture.json'));
assert.equal(hash(captureBytes), 'e0bde3899b5dc2795206ed70b6faa82f2a8bcaa5f8f82a79c3151f2fa093f778');
const capture = JSON.parse(captureBytes);
const planBytes = await fs.readFile(path.join(directory, 'plan.json'));
assert.equal(hash(planBytes), '18ca6712e4142cdb52ee80564ed2709437a19422942a151feb58311f628117df');
assert.equal(capture.planSha256, hash(planBytes));
assert.deepEqual(capture.plan, JSON.parse(planBytes));
assert.deepEqual(capture.sourceInventoryBefore, capture.sourceInventoryAfter);
assert.equal(capture.sourceUnchanged, true);
for (const source of capture.sourceInventoryBefore) {
  const bytes = await fs.readFile(path.join(root, source.path));
  assert.equal(bytes.length, source.bytes);
  assert.equal(hash(bytes), source.sha256, source.path);
}
const started = JSON.parse(await fs.readFile(path.join(directory, 'STARTED.json')));
assert.equal(started.planSha256, capture.planSha256);
assert.deepEqual(started.sources, capture.sourceInventoryBefore);
assert.deepEqual(started.runtime, capture.runtime);
assert.deepEqual(Object.keys(capture.runtime).sort(), ['arch', 'node', 'platform', 'v8']);
let count = 0, bytes = 0;
const summary = [];
for (const [caseIndex, recorded] of capture.cases.entries()) {
  const planned = capture.plan.cases[caseIndex];
  assert.equal(recorded.id, planned.id);
  assert.deepEqual(recorded.request, planned.request);
  assert.deepEqual(recorded.queryRoles, planned.queries);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${recorded.id}.json`))), recorded);
  for (const [i, call] of recorded.rpcCalls.entries()) {
    count++;
    assert.equal(call.sequence, count);
    assert.equal(call.caseSequence, i + 1);
    assert.equal(call.request.url, capture.plan.endpoint);
    assert.equal(call.request.method, 'POST');
    assert.deepEqual(JSON.parse(call.request.bodyText), call.request.body);
    assert.equal(Buffer.byteLength(call.request.bodyText), call.request.bodyBytes);
    assert.equal(hash(call.request.bodyText), call.request.bodySha256);
    const body = await fs.readFile(path.join(directory, call.transport.rawFile));
    assert.equal(call.transport.complete, true);
    assert.equal(call.transport.receivedBytes, body.length);
    assert.equal(call.transport.retainedBytes, body.length);
    for (const field of ['observedPrefixSha256', 'retainedSha256', 'responseSha256']) assert.equal(hash(body), call.transport[field]);
    assert.equal(body.toString('base64'), call.transport.rawBase64);
    assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), call.responseText);
    assert.deepEqual(JSON.parse(call.responseText), call.response);
    assert.equal(call.response.id, call.request.body.id);
    assert.equal(call.response.jsonrpc, '2.0');
    assert.equal(call.error, undefined);
    assert.equal(call.response.error, undefined);
    assert.equal(call.http.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `raw/${String(count).padStart(3, '0')}.json`))), call);
    assert.ok(body.length <= capture.limits.responseBytes);
    assert.ok(call.transport.timeoutMs <= capture.limits.requestMs);
    bytes += body.length;
  }
  // Playback consumes each recorded request in its actual order. Any added,
  // missing, or changed query is rejected; no synthetic response is supplied.
  let cursor = 0;
  const rpc = { async call(method, params) {
    const call = recorded.rpcCalls[cursor++];
    assert.ok(call, 'Replay requested an unrecorded call.');
    assert.equal(method, call.request.body.method);
    assert.deepEqual(params, call.request.body.params);
    return structuredClone(call.response.result);
  } };
  const replayed = await simulateUnsignedCall({ rpc, chainId: capture.plan.chainId, blockHash: planned.blockHash, request: planned.request, queries: planned.queries.map(q => q.call) });
  assert.equal(cursor, recorded.rpcCalls.length);
  assert.deepEqual(replayed, recorded.result);
  assert.ok(recorded.rpcCalls.length <= capture.limits.caseRpc);
  summary.push({ id: recorded.id, rpcCalls: cursor, execution: replayed.execution.status, canonical: replayed.canonicalStatus, measurements: replayed.measurements.map(m => m.status) });
}
assert.equal(count, 41);
assert.equal(bytes, 403724);
assert.equal(capture.accounting.attemptedRpc, count);
assert.equal(capture.accounting.completedBodies, count);
assert.equal(capture.accounting.retainedResponseBytes, bytes);
assert.equal(capture.accounting.observedResponseBytes, bytes);
assert.ok(bytes <= capture.limits.totalResponseBytes);
assert.ok(capture.accounting.durationMs < capture.limits.totalMs);

const aave = capture.cases[0].result;
assert.equal(aave.execution.status, 'success');
assert.equal(aave.canonicalStatus, 'verified');
assert.deepEqual(aave.measurements.map(m => [m.beforeRaw, m.afterRaw, m.deltaRaw]), [
  ['3962903485', '0', '-3962903485'],
  ['0', '3962903484', '3962903484'],
  ['151987610826648', '151991573730133', '3962903485'],
  ['0', '0', '0'],
]);
const morpho = capture.cases[1];
assert.equal(morpho.result.execution.status, 'success');
assert.equal(morpho.result.canonicalStatus, 'unverified');
assert.ok(morpho.result.measurements.every(m => m.status === 'unavailable' && m.beforeRaw === undefined && m.afterRaw === undefined));
const originalDiff = morpho.rpcCalls.at(-1).response.result;
const extraFields = Object.entries(originalDiff.pre).flatMap(([account, state]) => Object.keys(state).filter(k => !['nonce', 'balance', 'code', 'storage'].includes(k)).map(field => ({ account, field })));
assert.equal(extraFields.length, 5);
assert.ok(extraFields.every(x => x.field === 'codeHash'));
assert.throws(() => canonicalStateDiff(originalDiff), /State diff contains unsupported account fields/);
console.log(JSON.stringify({ verified: true, networkRequests: 0, sourceFiles: capture.sourceInventoryBefore.length, rawRpcBodies: count, responseBytes: bytes, completeEngineReplay: summary, morphoRejection: { stage: 'canonicalStateDiff', unsupportedFields: extraFields } }, null, 2));
