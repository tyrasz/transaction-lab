// Offline verification from the archived engine and dependency closure.
// Supply the separately published capture hash; no fetch or live source imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = process.argv[2];
assert.match(expected ?? '', /^--capture-sha256=[0-9a-f]{64}$/);
assert.equal(process.argv.length, 3);
const captureBytes = await fs.readFile(path.join(directory, 'capture.json'));
assert.equal(hash(captureBytes), expected.slice('--capture-sha256='.length));
const capture = JSON.parse(captureBytes);
assert.equal(capture.schemaVersion, '2');
const planBytes = await fs.readFile(path.join(directory, 'plan.json'));
assert.equal(hash(planBytes), capture.planSha256);
assert.deepEqual(JSON.parse(planBytes), capture.plan);
const oldPlanBytes = await fs.readFile(path.join(root, capture.plan.previousPlan.path));
const oldCaptureBytes = await fs.readFile(path.join(root, capture.plan.previousCapture.path));
assert.equal(hash(oldPlanBytes), '18ca6712e4142cdb52ee80564ed2709437a19422942a151feb58311f628117df');
assert.equal(hash(oldCaptureBytes), 'e0bde3899b5dc2795206ed70b6faa82f2a8bcaa5f8f82a79c3151f2fa093f778');
assert.deepEqual(capture.plan.cases, JSON.parse(oldPlanBytes).cases);
assert.deepEqual(capture.sourceInventoryBefore, capture.sourceInventoryAfter);
assert.equal(capture.sourceUnchanged, true);
assert.equal(capture.sourceArchive.length, capture.sourceInventoryBefore.length);
const sourcePaths = new Set();
for (const [i, source] of capture.sourceArchive.entries()) {
  const { archiveFile, ...metadata } = source;
  assert.deepEqual(metadata, capture.sourceInventoryBefore[i]);
  assert.equal(archiveFile, 'sources/' + source.path);
  const absolute = path.resolve(directory, archiveFile);
  assert.ok(absolute.startsWith(path.join(directory, 'sources') + path.sep));
  assert.equal(await fs.realpath(absolute), absolute);
  const bytes = await fs.readFile(absolute);
  assert.equal(bytes.length, source.bytes);
  assert.equal(hash(bytes), source.sha256, archiveFile);
  assert.ok(!sourcePaths.has(source.path));
  sourcePaths.add(source.path);
}
for (const required of ['package.json', 'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json', 'engines/standard-evm/provider-state-diff.js', 'engines/standard-evm/node_modules/@noble/hashes/package.json', 'engines/standard-evm/node_modules/@noble/hashes/LICENSE', 'engines/standard-evm/node_modules/@noble/hashes/sha3.js', 'engines/standard-evm/node_modules/@noble/hashes/_u64.js', 'engines/standard-evm/node_modules/@noble/hashes/utils.js']) assert.ok(sourcePaths.has(required), required);
const archivedPackage = JSON.parse(await fs.readFile(path.join(directory, 'sources/engines/standard-evm/node_modules/@noble/hashes/package.json')));
assert.equal(archivedPackage.name, '@noble/hashes');
assert.equal(archivedPackage.version, '2.4.0');
assert.equal(archivedPackage.exports['./sha3.js'], './sha3.js');
const started = JSON.parse(await fs.readFile(path.join(directory, 'STARTED.json')));
assert.equal(started.planSha256, capture.planSha256);
assert.deepEqual(started.sources, capture.sourceInventoryBefore);
assert.deepEqual(started.runtime, capture.runtime);

// Relative engine imports and noble package resolution stay entirely inside
// the archived repository-shaped tree, whose source bytes were checked above.
const { simulateUnsignedCall } = await import(pathToFileURL(path.join(directory, 'sources/engines/standard-evm/unsigned-call.js')).href);
let count = 0, received = 0, retained = 0, complete = 0;
const cases = [];
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
    assert.equal(call.transport.retainedBytes, body.length);
    assert.equal(call.transport.retainedSha256, hash(body));
    assert.equal(call.transport.rawBase64, body.toString('base64'));
    assert.ok(call.transport.receivedBytes >= body.length);
    if (call.transport.complete) {
      complete++;
      assert.equal(call.transport.receivedBytes, body.length);
      assert.equal(call.transport.observedPrefixSha256, hash(body));
      assert.equal(call.transport.responseSha256, hash(body));
    } else assert.equal(call.transport.responseSha256, undefined);
    if (call.responseText !== undefined) assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), call.responseText);
    if (call.response !== undefined) assert.deepEqual(JSON.parse(call.responseText), call.response);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `raw/${String(count).padStart(3, '0')}.json`))), call);
    assert.ok(body.length <= capture.limits.responseBytes);
    assert.ok(call.transport.timeoutMs <= capture.limits.requestMs);
    received += call.transport.receivedBytes; retained += body.length;
  }
  // Exact method/params/order only; no invented responses for missing calls.
  // Scheduling-dependent captures can fail this strict audit rather than
  // substituting fabricated timing or results to make the playback succeed.
  let cursor = 0;
  const rpc = { async call(method, params) {
    const call = recorded.rpcCalls[cursor++];
    assert.ok(call, 'Replay requested an unrecorded RPC.');
    assert.equal(method, call.request.body.method);
    assert.deepEqual(params, call.request.body.params);
    if (call.error) throw new Error(call.error.message);
    return structuredClone(call.response.result);
  } };
  const replayed = await simulateUnsignedCall({ rpc, chainId: capture.plan.chainId, blockHash: planned.blockHash, request: planned.request, queries: planned.queries.map(q => q.call) });
  assert.equal(cursor, recorded.rpcCalls.length);
  assert.deepEqual(replayed, recorded.result);
  assert.ok(recorded.rpcCalls.length <= capture.limits.caseRpc);
  cases.push({ id: recorded.id, rpcCalls: cursor, execution: replayed.execution.status, canonical: replayed.canonicalStatus, measurements: replayed.measurements.map(m => m.status), codeHashClaims: replayed.providerCodeHashChecks?.claims?.length ?? 0 });
}
assert.equal(count, capture.accounting.attemptedRpc);
assert.equal(received, capture.accounting.observedResponseBytes);
assert.equal(retained, capture.accounting.retainedResponseBytes);
assert.equal(complete, capture.accounting.completedBodies);
assert.ok(count <= capture.limits.totalRpc);
assert.ok(retained <= capture.limits.totalResponseBytes);
assert.ok(capture.accounting.durationMs < capture.limits.totalMs);
console.log(JSON.stringify({ verified: true, networkRequests: 0, liveSourceImports: 0, archivedSourceFiles: sourcePaths.size, rawRpcBodies: count, completeResponseBodies: complete, responseBytes: retained, archivedEngineReplay: cases, purpose: 'Adapter fix and regression on the identical selected cases; not an independent accuracy sample.' }, null, 2));
