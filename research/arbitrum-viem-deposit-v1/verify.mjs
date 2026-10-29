import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inventory, verifyInventory, sha, text, SOURCE_ROOTS } from './artifacts.mjs';
import { ENDPOINT, LIMITS, METHODS, STATIC_CODE, validateRequest } from './policy.mjs';
import { executeScenario } from './run.mjs';

const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const json = bytes => JSON.parse(decode(bytes));
const clean = value => JSON.parse(text(value));
const finite = (n, max = Number.MAX_SAFE_INTEGER) => assert.ok(Number.isFinite(n) && n >= 0 && n <= max);
const equalJson = (actual, expected) => assert.deepEqual(clean(actual), clean(expected));
function read(root, relative) {
  assert.ok(typeof relative === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(relative) && !relative.split('/').includes('..') && !path.isAbsolute(relative));
  const file = path.join(root, relative); assert.ok(fs.lstatSync(file).isFile()); return fs.readFileSync(file);
}
function joined(root, entry) { const bytes = read(root, entry.path); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); return bytes; }

export function verifyWire({ capture, result, scenario }) {
  const rows = result.transport.exchanges;
  assert.ok(Array.isArray(rows) && rows.length <= LIMITS.calls); assert.equal(result.transport.requestAttempts, rows.length); assert.equal(result.transport.calls, rows.filter(row => row.dispatched).length);
  let retained = 0, observed = 0, finalCount = 0, discoveryCount = 0, mainCount = 0, phaseRank = -1; const records = [], overrides = [];
  const phases = ['selection', 'prechecks', 'viem', 'final'];
  for (const [i, row] of rows.entries()) {
    assert.equal(typeof row.dispatched, 'boolean');
    const id = i + 1, prefix = 'wire/' + String(id).padStart(3, '0'); assert.equal(row.id, id);
    equalJson(json(read(capture, prefix + '-exchange.json')), row);
    assert.equal(row.request.path, prefix + '-request.json'); assert.equal(row.response.path, prefix + '-response.body');
    const requestBytes = joined(capture, row.request), responseBytes = joined(capture, row.response);
    assert.ok(requestBytes.length <= LIMITS.requestBytes); assert.ok(responseBytes.length <= LIMITS.responseBytes);
    finite(row.durationMs); assert.ok(typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.finishedAt)));
    assert.ok(row.httpStatus === null || Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599);
    finite(row.observedBytes); assert.ok(row.observedBytes >= responseBytes.length); retained += responseBytes.length; observed += row.observedBytes;
    const request = json(requestBytes); assert.deepEqual(Object.keys(request).sort(), ['id', 'jsonrpc', 'method', 'params']); assert.equal(request.jsonrpc, '2.0'); assert.equal(request.id, id); assert.equal(request.method, row.method);
    const rank = phases.indexOf(row.phase); assert.ok(rank >= phaseRank && rank >= 0); phaseRank = rank;
    if (id === 1) assert.deepEqual(request, { jsonrpc: '2.0', id, method: 'eth_chainId', params: [] });
    if (id === 2) assert.deepEqual(request, { jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: ['latest', false] });
    if (row.phase === 'selection') assert.ok(id <= 2);
    if (row.phase === 'final') { finalCount++; assert.ok(finalCount <= 1); }
    const codeOverrides = validateRequest({ ...request, phase: row.phase, selected: result.selectedHeader, scenario });
    for (const value of codeOverrides) overrides.push({ wireId: id, address: value.address, codeSha256: sha(Buffer.from(value.code.slice(2), 'hex')), fields: ['code'] });
    if (request.method === 'eth_simulateV1') {
      if (request.params[0].blockStateCalls.length === 1) { discoveryCount++; assert.equal(mainCount, 0); assert.equal(discoveryCount, 1); }
      else { mainCount++; assert.equal(discoveryCount, 1); assert.equal(mainCount, 1); }
    }
    let response = null;
    if (row.status === 'rpc_result' || row.status === 'rpc_error') {
      assert.equal(row.responseComplete, true); assert.ok(row.httpStatus >= 200 && row.httpStatus < 300); assert.equal(row.observedBytes, responseBytes.length);
      response = json(responseBytes); assert.equal(response?.jsonrpc, '2.0'); assert.equal(response.id, id);
      assert.notEqual(Object.hasOwn(response, 'result'), Object.hasOwn(response, 'error'));
      if (row.status === 'rpc_result') { assert.ok(Object.hasOwn(response, 'result')); assert.equal(row.error, null); assert.equal(row.rpcError, null); }
      else { assert.ok(Object.hasOwn(response, 'error')); equalJson(response.error, row.rpcError); assert.ok(row.error); }
    } else { assert.ok(['unavailable', 'http_error'].includes(row.status)); assert.ok(row.error); }
    records.push({ row, request, response });
  }
  assert.ok(retained <= LIMITS.totalBytes); assert.equal(retained, result.transport.retainedBytes); assert.equal(observed, result.transport.observedBytes);
  assert.deepEqual(overrides, result.transport.measurementOverrides);
  assert.ok(Number.isInteger(result.transport.deniedCount) && result.transport.deniedCount >= 0); assert.ok(Array.isArray(result.transport.denials));
  finite(result.transport.elapsedMs); assert.ok(Number.isFinite(result.transport.wallMs) && Number.isFinite(result.transport.monotonicMs)); if (!result.transport.clockReversed) { finite(result.transport.wallMs); finite(result.transport.monotonicMs); }
  assert.equal(result.transport.elapsedMs, Math.max(0, result.transport.wallMs, result.transport.monotonicMs));
  assert.equal(result.transport.withinBounds, result.transport.elapsedMs <= LIMITS.overallMs && !result.transport.clockReversed);
  assert.ok(Number.isInteger(result.transport.pendingAdapterOperations) && result.transport.pendingAdapterOperations >= 0);
  assert.equal(result.drain.complete, result.drain.pendingAdapterOperations === 0); assert.equal(result.drain.pendingAdapterOperations, result.transport.pendingAdapterOperations);
  if (result.usable) {
    assert.equal(result.sourceUnchanged, true); assert.equal(result.transport.withinBounds, true); assert.equal(result.transport.hardFailure, null); assert.equal(result.transport.deniedCount, 0);
    assert.equal(result.drain.complete, true); assert.equal(finalCount, 1); assert.equal(result.headerConfirmed, true); assert.deepEqual(result.finalHeader, result.selectedHeader);
    assert.ok(rows.every(row => row.durationMs <= LIMITS.requestMs));
  }
  return { records, retainedBytes: retained, overrides, discoveryCount, mainCount };
}

export async function replayRecorded({ capture, result, scenario, records }) {
  // No fetch or RPC transport exists in this replay. The library consumes only saved replies.
  // A mismatch latch survives viem/runner error handling; expected decoded outputs are compared afterward.
  let position = 0, phase = 'selection', mismatch = null; const written = new Map();
  const recorder = {
    async request({ method, params = [] }) {
      const record = records[position++];
      try { assert.ok(record, 'Replay requested missing wire.'); assert.equal(record.row.phase, phase); assert.deepEqual(clean({ method, params }), { method: record.request.method, params: record.request.params }); }
      catch (error) { mismatch ??= error; throw error; }
      if (record.row.status === 'rpc_result') return structuredClone(record.response.result);
      const detail = record.row.status === 'rpc_error' ? record.response.error : record.row.error;
      const error = new Error(detail?.message ?? 'Unavailable'); if (detail?.name) error.name = detail.name;
      if (Number.isInteger(detail?.code)) error.code = detail.code; if (detail?.data !== undefined) error.data = detail.data; throw error;
    },
    setPhase(name) { phase = name; }, pin() {}, endPhase() {}, finish() {},
    async drain() { return structuredClone(result.drain); }, snapshot() { return structuredClone(result.transport); },
  };
  const replay = clean(await executeScenario({ scenario, recorder, write: (name, value) => { written.set(name, typeof value === 'string' ? JSON.parse(value) : clean(value)); return {}; } }));
  if (mismatch) throw mismatch; assert.equal(position, records.length, 'Saved wire not consumed by actual pinned viem replay.');
  for (const key of ['selectedHeader', 'prechecks', 'viem', 'finalHeader', 'headerConfirmed', 'error', 'drain', 'transport', 'assetObservation']) equalJson(replay[key], result[key]);
  if (result.sourceUnchanged) { assert.equal(replay.status, result.status); assert.equal(replay.usable, result.usable); }
  for (const [name, value] of written) equalJson(value, json(read(capture, name)));
  return { status: 'matched', consumedWireRecords: position, library: 'viem@2.57.13', freshNetworkCalls: 0, freshEvmExecution: false };
}

export async function verifyEvidence({ root, expectedManifestSha256, expectedPlanSha256 }) {
  root = fs.realpathSync(root); const capture = path.join(root, 'capture');
  assert.match(expectedManifestSha256, /^[0-9a-f]{64}$/); assert.match(expectedPlanSha256, /^[0-9a-f]{64}$/);
  const planBytes = read(root, 'plan.json'); assert.equal(sha(planBytes), expectedPlanSha256); const plan = json(planBytes);
  const sourceBytes = read(root, 'source-manifest.json'); assert.equal(sha(sourceBytes), plan.sourceManifestSha256); const source = json(sourceBytes); assert.deepEqual(source.roots, SOURCE_ROOTS); verifyInventory(root, source);
  assert.equal(plan.node.version, process.version); assert.equal(plan.node.sha256, sha(fs.readFileSync(process.execPath)));
  assert.equal(plan.endpoint, ENDPOINT); assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.methods, METHODS); assert.equal(plan.viem, '2.57.13');
  assert.equal(plan.helperCodeSha256, sha(Buffer.from(STATIC_CODE.slice(2), 'hex')));
  const scenarioBytes = read(root, 'scenario.json'); assert.equal(sha(scenarioBytes), plan.scenarioSha256); assert.equal(plan.scenarioSha256, '5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa');
  const scenario = json(scenarioBytes), frozen = json(read(root, 'FROZEN.json'));
  assert.equal(frozen.planSha256, expectedPlanSha256); assert.equal(frozen.sourceManifestSha256, plan.sourceManifestSha256);
  const manifestBytes = read(capture, 'evidence-manifest.json'); assert.equal(sha(manifestBytes), expectedManifestSha256); const manifest = json(manifestBytes);
  assert.equal(manifest.planSha256, expectedPlanSha256); assert.equal(manifest.sourceManifestSha256, plan.sourceManifestSha256);
  assert.deepEqual(inventory(capture, fs.readdirSync(capture).filter(name => name !== 'evidence-manifest.json')), manifest.files);
  const start = json(read(capture, 'STARTED.json')), result = json(read(capture, 'results.json'));
  for (const object of [start, result]) { assert.equal(object.planSha256, expectedPlanSha256); assert.equal(object.sourceManifestSha256, plan.sourceManifestSha256); }
  assert.deepEqual(result.scope, plan.scope); assert.equal(typeof result.usable, 'boolean'); assert.equal(typeof result.sourceUnchanged, 'boolean');
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(start.startedAt));
  const wires = verifyWire({ capture, result, scenario });
  equalJson(json(read(capture, 'measurement-overrides.json')), wires.overrides);
  let replay = { status: 'not_replayed_incomplete_transport', freshNetworkCalls: 0, freshEvmExecution: false };
  if (!result.transport.deniedCount && !result.transport.discardedCount && !result.transport.hardFailure && !result.transport.pendingAdapterOperations) replay = await replayRecorded({ capture, result, scenario, records: wires.records });
  else assert.equal(result.usable, false);
  verifyInventory(root, source); assert.equal(sha(read(root, 'plan.json')), expectedPlanSha256); assert.equal(sha(read(root, 'source-manifest.json')), plan.sourceManifestSha256); assert.equal(sha(read(capture, 'evidence-manifest.json')), expectedManifestSha256);
  assert.deepEqual(inventory(capture, fs.readdirSync(capture).filter(name => name !== 'evidence-manifest.json')), manifest.files);
  return { schemaVersion: 1, status: 'verified', planSha256: expectedPlanSha256, manifestSha256: expectedManifestSha256, sourceManifestSha256: plan.sourceManifestSha256,
    sourceFiles: source.files.length, evidenceFiles: manifest.files.length, calls: result.transport.calls, requestAttempts: wires.records.length, bytes: wires.retainedBytes,
    captureStatus: result.status, usableSourceObservation: result.usable, headerConfirmed: result.headerConfirmed, replay,
    sourceChainCalls: result.viem.result?.results?.map(row => ({ status: row.status, data: row.data, gasUsed: row.gasUsed })) ?? null,
    assetChanges: result.viem.result?.assetChanges ?? null, assetObservation: result.assetObservation, viemError: result.viem.error,
    scope: 'Hashes, request policy and exact pinned viem decoding replay from recorded provider replies. No new provider/VM execution, state-proof verification, outer transaction validation, complete asset inventory or destination-credit verification.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, 'Usage: verify.mjs EXPERIMENT_DIRECTORY MANIFEST_SHA256 PLAN_SHA256');
  console.log(text(await verifyEvidence({ root: process.argv[2], expectedManifestSha256: process.argv[3], expectedPlanSha256: process.argv[4] })));
}
