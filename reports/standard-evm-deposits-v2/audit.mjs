// Supplementary, post-capture audit. The frozen runner and verifier are unchanged.
// Only Node builtins are imported until every archived source is hash-checked.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

export const CAPTURE_SHA256 = '149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e';
export const PLAN_SHA256 = 'd458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f';
const directory = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const noble = 'engines/standard-evm/node_modules/@noble/hashes';
const engine = 'engines/standard-evm/unsigned-call.js';
export const REQUIRED_SOURCES = [
  `${noble}/_u64.js`, `${noble}/LICENSE`, `${noble}/package.json`, `${noble}/sha3.js`, `${noble}/utils.js`,
  'engines/standard-evm/package-lock.json', 'engines/standard-evm/package.json',
  'engines/standard-evm/provider-state-diff.js', engine, 'package.json',
  'reports/standard-evm-deposits-v2/capture.mjs', 'reports/standard-evm-deposits-v2/verify.mjs',
  'src/config.js', 'src/query-validation.js', 'src/rpc.js', 'src/state-diff.js', 'src/state.js',
];
const CASE_IDS = ['aave-usdc-supply-with-permit', 'morpho-kiln-usdc-deposit'];
const keys = value => Object.keys(value).sort();

// Pure controls intentionally exported so negative tests do not rewrite evidence.
export function validateBindings(capture, plan, started) {
  assert.equal(capture.schemaVersion, '2');
  assert.equal(capture.kind, 'experimental_standard_evm_deposit_capture');
  assert.equal(capture.planSha256, PLAN_SHA256);
  assert.equal(started.planSha256, PLAN_SHA256);
  assert.deepEqual(capture.plan, plan);
  assert.equal(plan.sourceBinding, 'frozen');
  assert.deepEqual(plan.sourceInventory.map(s => s.path), REQUIRED_SOURCES);
  assert.deepEqual(capture.sourceInventoryBefore, plan.sourceInventory);
  assert.deepEqual(capture.sourceInventoryAfter, plan.sourceInventory);
  assert.deepEqual(started.sources, plan.sourceInventory);
  assert.deepEqual(started.runtime, capture.runtime);
  assert.equal(capture.sourceUnchanged, true);
  assert.equal(capture.accounting.sourceBound, true);
  assert.deepEqual(capture.limits, plan.limits);
  assert.deepEqual(capture.warnings, plan.warnings);
  assert.equal(capture.sourceArchive.length, REQUIRED_SOURCES.length);
  assert.deepEqual(capture.sourceArchive.map(({ archiveFile, ...source }) => source), plan.sourceInventory);
  assert.deepEqual(plan.cases.map(c => c.id), CASE_IDS);
  assert.equal(capture.cases.length, plan.cases.length, 'Every planned case must be retained.');
  for (const [index, recorded] of capture.cases.entries()) {
    const planned = plan.cases[index];
    assert.equal(recorded.id, planned.id, 'Planned case order changed.');
    assert.equal(recorded.provider, 'ethereum-drpc-public');
    assert.equal(recorded.originalTransactionHash, planned.originalTransactionHash);
    assert.equal(recorded.blockHash, planned.blockHash);
    assert.deepEqual(recorded.request, planned.request);
    assert.deepEqual(recorded.queryRoles, planned.queries);
    assert.deepEqual(recorded.receiptReference, planned.references.receipt);
  }
}

export function validateEnvelope(call, endpoint) {
  const request = call.request;
  assert.equal(request.url, endpoint);
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { 'content-type': 'application/json' });
  assert.deepEqual(keys(request.body), ['id', 'jsonrpc', 'method', 'params']);
  assert.equal(request.body.jsonrpc, '2.0');
  assert.equal(request.body.id, call.sequence);
  assert.equal(typeof request.body.method, 'string');
  assert.ok(Array.isArray(request.body.params));
  assert.equal(request.bodyText, JSON.stringify(request.body));
  assert.equal(request.bodyBytes, Buffer.byteLength(request.bodyText));
  assert.equal(request.bodySha256, hash(request.bodyText));
  // This packet has no transport/RPC failures. A genuine recorded failure stays
  // an error during playback; it is never replaced with a successful response.
  if (call.error !== undefined) {
    assert.equal(typeof call.error.message, 'string');
    assert.equal(typeof call.error.code, 'string');
    if (call.response !== undefined) {
      assert.equal(call.response.jsonrpc, '2.0');
      assert.equal(call.response.id, request.body.id);
      assert.notEqual(Object.hasOwn(call.response, 'result'), Object.hasOwn(call.response, 'error'));
    }
    if (call.error.code === 'RPC') assert.ok(Object.hasOwn(call.response, 'error'));
    return;
  }
  assert.ok(call.http.status >= 200 && call.http.status < 300);
  assert.equal(call.transport.complete, true);
  assert.deepEqual(keys(call.response), ['id', 'jsonrpc', 'result']);
  assert.equal(call.response.jsonrpc, '2.0');
  assert.equal(call.response.id, request.body.id);
}

export async function replayCaseStrict(recorded, planned, plan, simulateUnsignedCall) {
  let cursor = 0;
  const mismatches = [], usedIds = [];
  const rpc = { async call(method, params) {
    const index = cursor++, saved = recorded.rpcCalls[index];
    try {
      assert.ok(saved, 'The engine requested an unrecorded RPC.');
      validateEnvelope(saved, plan.endpoint);
      assert.equal(method, saved.request.body.method);
      assert.deepEqual(params, saved.request.body.params);
      usedIds.push(saved.sequence);
    } catch {
      // The engine sanitizes adapter exceptions. Latch independently, then
      // assert after it returns so a matching unavailable result cannot hide it.
      mismatches.push(index + 1);
      throw new Error('Saved RPC request or envelope mismatch.');
    }
    if (saved.error) throw new Error(saved.error.message);
    return structuredClone(saved.response.result);
  } };
  let replayed, thrown;
  try {
    replayed = await simulateUnsignedCall({ rpc, chainId: plan.chainId, blockHash: planned.blockHash,
      request: structuredClone(planned.request), queries: planned.queries.map(q => structuredClone(q.call)) });
  } catch (error) { thrown = error; }
  assert.deepEqual(mismatches, [], 'Playback request/order/envelope mismatches were latched outside the engine.');
  assert.equal(cursor, recorded.rpcCalls.length, 'Every saved RPC must be consumed exactly once.');
  assert.deepEqual(usedIds, recorded.rpcCalls.map(c => c.sequence));
  assert.equal(new Set(usedIds).size, usedIds.length);
  assert.equal(thrown, undefined, 'Archived engine unexpectedly threw.');
  assert.deepEqual(replayed, recorded.result, 'Entire result must match, including failures and raw engine evidence.');
  return { result: replayed, usedIds };
}

async function readBound(relative, sha256, bytes) {
  const absolute = path.resolve(directory, relative);
  assert.ok(absolute.startsWith(directory + path.sep));
  assert.equal(await fs.realpath(absolute), absolute, 'Symlinked evidence is not admitted.');
  const data = await fs.readFile(absolute);
  if (sha256 !== undefined) assert.equal(hash(data), sha256, relative);
  if (bytes !== undefined) assert.equal(data.length, bytes, relative);
  return data;
}

async function verifyArchive(capture) {
  const sourceText = new Map();
  for (const source of capture.sourceArchive) {
    assert.equal(source.archiveFile, 'sources/' + source.path);
    const bytes = await readBound(source.archiveFile, source.sha256, source.bytes);
    sourceText.set(source.path, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  // Exact known static import closure, resolved in the archive, includes the
  // engine, adapter, all five core helpers and all three noble runtime files.
  const visited = new Set();
  async function visit(relative) {
    if (visited.has(relative)) return;
    assert.ok(sourceText.has(relative), 'Missing archived dependency: ' + relative);
    visited.add(relative);
    const source = sourceText.get(relative);
    assert.ok(!/\b(?:import\s*\(|require\s*\()/.test(source));
    for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(?:(?:[^'";]+?)\s+from\s*)?['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      let dependency;
      if (specifier.startsWith('.')) dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      else {
        assert.equal(specifier, '@noble/hashes/sha3.js');
        const resolved = createRequire(path.join(directory, 'sources', relative)).resolve(specifier);
        assert.equal(resolved, path.join(directory, 'sources', noble, 'sha3.js'));
        dependency = noble + '/sha3.js';
      }
      await visit(dependency);
    }
  }
  await visit(engine);
  assert.deepEqual([...visited].sort(), REQUIRED_SOURCES.filter(p => p.endsWith('.js')).sort());
  const rootPackage = JSON.parse(sourceText.get('package.json'));
  const enginePackage = JSON.parse(sourceText.get('engines/standard-evm/package.json'));
  const dependencyPackage = JSON.parse(sourceText.get(noble + '/package.json'));
  assert.equal(rootPackage.type, 'module'); assert.equal(enginePackage.type, 'module');
  assert.deepEqual(enginePackage.dependencies, { '@noble/hashes': '2.4.0' });
  assert.equal(dependencyPackage.version, '2.4.0');
  assert.equal(dependencyPackage.exports['./sha3.js'], './sha3.js');
  return visited.size;
}

export async function audit() {
  const capture = JSON.parse(await readBound('capture.json', CAPTURE_SHA256));
  const plan = JSON.parse(await readBound('plan.json', PLAN_SHA256));
  const started = JSON.parse(await readBound('STARTED.json'));
  validateBindings(capture, plan, started);
  const runtimeModules = await verifyArchive(capture);
  const { simulateUnsignedCall } = await import(pathToFileURL(path.join(directory, 'sources', engine)).href);
  let count = 0, received = 0, retained = 0, complete = 0, failures = 0;
  const cases = [];
  for (const [index, recorded] of capture.cases.entries()) {
    assert.deepEqual(JSON.parse(await readBound(recorded.id + '.json')), recorded);
    for (const [caseIndex, call] of recorded.rpcCalls.entries()) {
      count++;
      assert.equal(call.sequence, count); assert.equal(call.caseSequence, caseIndex + 1);
      validateEnvelope(call, plan.endpoint);
      const prefix = 'raw/' + String(count).padStart(3, '0');
      assert.equal(call.transport.rawFile, prefix + '.body');
      const bytes = await readBound(prefix + '.body', call.transport.retainedSha256, call.transport.retainedBytes);
      assert.deepEqual(JSON.parse(await readBound(prefix + '.json')), call);
      assert.equal(call.transport.rawBase64, bytes.toString('base64'));
      assert.ok(call.transport.receivedBytes >= bytes.length);
      if (call.transport.complete) {
        complete++;
        assert.equal(call.transport.receivedBytes, bytes.length);
        assert.equal(call.transport.observedPrefixSha256, hash(bytes));
        assert.equal(call.transport.responseSha256, hash(bytes));
      } else assert.equal(call.transport.responseSha256, undefined);
      if (call.responseText !== undefined) assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), call.responseText);
      if (call.response !== undefined) assert.deepEqual(JSON.parse(call.responseText), call.response);
      assert.ok(bytes.length <= plan.limits.responseBytes);
      assert.ok(call.transport.timeoutMs > 0 && call.transport.timeoutMs <= plan.limits.requestMs);
      assert.ok(call.transport.durationMs >= 0);
      if (call.error) failures++;
      received += call.transport.receivedBytes; retained += bytes.length;
    }
    assert.ok(recorded.rpcCalls.length <= plan.limits.caseRpc);
    const { result, usedIds } = await replayCaseStrict(recorded, plan.cases[index], plan, simulateUnsignedCall);
    cases.push({ id: recorded.id, usedRpcIds: usedIds, entireResultMatched: true,
      execution: result.execution.status, canonicalStatus: result.canonicalStatus,
      measurements: result.measurements.map((m, i) => ({ id: plan.cases[index].queries[i].id, ...m })),
      codeHashClaims: result.providerCodeHashChecks.claims.length });
  }
  assert.equal(count, capture.accounting.attemptedRpc);
  assert.equal(complete, capture.accounting.completedBodies);
  assert.equal(received, capture.accounting.observedResponseBytes);
  assert.equal(retained, capture.accounting.retainedResponseBytes);
  assert.ok(count <= plan.limits.totalRpc && retained <= plan.limits.totalResponseBytes);
  assert.ok(capture.accounting.durationMs >= 0 && capture.accounting.durationMs < plan.limits.totalMs);
  return { verified: true, auditKind: 'supplementary_post_capture_integrity_and_exact_archived_playback',
    captureSha256: CAPTURE_SHA256, planSha256: PLAN_SHA256, networkRequests: 0, liveSourceImports: 0,
    sourceInventoriesExactlyBound: true, archivedSourceFiles: REQUIRED_SOURCES.length, runtimeModules,
    allPlannedCasesRetainedInOrder: true, playbackMismatchesLatchedExternally: true,
    rpcCalls: count, completeResponseBodies: complete, receivedBytes: received, retainedBytes: retained,
    recordedRpcFailures: failures, cases,
    limitations: ['Post-capture integrity and deterministic playback check, not an independent EVM or state oracle.',
      'Explicit parent-block-end, unpriced unsigned profile and twelve selected queries; not original-position replay or all-effects coverage.',
      'Provider codeHash checks establish consistency with explicit provider bytecode only.',
      'No timing is fabricated; this successful packet replays without scheduling-dependent failures.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--capture-sha256=' + CAPTURE_SHA256]);
  console.log(JSON.stringify(await audit(), null, 2));
}
