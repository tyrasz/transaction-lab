import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verify, validatePlan, validateManifest, validateTransport, validateExchange, semanticReport, replayExchange,
  PLAN_SHA256, MANIFEST_SHA256, IMPLEMENTATION_SHA256, PACKET_FILES } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(path.join(here, file), 'utf8'));
const plan = await readJson('plan.json'), manifest = await readJson('manifest.json');
const exchanges = await Promise.all(['http/001.json', 'http/002.json'].map(readJson));
const reports = exchanges.map(exchange => JSON.parse(exchange.response.bodyText));
let temporary, result, runtime, attemptedPublicRequests = 0;

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-api-packet-'));
  // Deliberately copy only the sealed packet, not the current repository,
  // installed dependencies, sibling captures, verifier or original wrapper.
  for (const file of ['manifest.json', ...PACKET_FILES]) {
    await fs.mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await fs.copyFile(path.join(here, file), path.join(temporary, file));
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { attemptedPublicRequests++; throw new Error('Public network forbidden in offline verification.'); };
  try { result = await verify({ directory: temporary }); }
  finally { globalThis.fetch = originalFetch; }
  runtime = {
    ...(await import(pathToFileURL(path.join(temporary, 'source/src/server.js')).href)),
    ...(await import(pathToFileURL(path.join(temporary, 'source/src/standard-rpc.js')).href)),
  };
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

test('isolated archived API reproduces both complete results and every saved wire exchange', () => {
  assert.equal(result.status, 'passed'); assert.equal(result.manifestSha256, MANIFEST_SHA256);
  assert.equal(result.planSha256, PLAN_SHA256); assert.equal(result.implementationSha256, IMPLEMENTATION_SHA256);
  assert.equal(result.sourceFiles, 35); assert.equal(result.sealedFiles, 43); assert.equal(attemptedPublicRequests, 0);
  assert.equal(result.socketsOpened, 0); assert.equal(result.liveSourceImports, 0);
  assert.deepEqual(result.cases.map(item => [item.httpStatus, item.accounting.rpcCalls, item.accounting.observedBytes]), [[200, 30, 98187], [200, 46, 345269]]);
  assert.deepEqual(result.cases.map(item => item.measurements.map(value => value.deltaRaw)), [
    ['-3962903485', '3962903484', '3962903485', '0'],
    ['-350000000000', '330497511812', '305565121166487000888945', '0', '0', '350000000000', '-350000000000', '0'],
  ]);
  for (const item of result.cases) assert.deepEqual(item.playback.consumedRpcIds, Array.from({ length: item.accounting.rpcCalls }, (_, i) => i + 1));
  assert.equal(result.attachmentChecks.browserRenderingReplayed, false);
});

test('inventory rejects omission, duplicates, extra source, and conflicting predeclared source hashes', () => {
  for (const mutate of [
    value => value.files.pop(),
    value => { value.files[0] = structuredClone(value.files[1]); },
    value => value.files.push({ path: 'source/src/unplanned.js', bytes: 1, sha256: '0'.repeat(64) }),
    value => { value.files.find(file => file.path === 'source/src/server.js').sha256 = '0'.repeat(64); },
  ]) { const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateManifest(changed, plan)); }
});

test('current files cannot substitute changed archived source, HTTP bytes, or a hidden third attempt', async () => {
  for (const file of ['source/src/server.js', 'http/001.json']) {
    const filename = path.join(temporary, file), original = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
    try { await assert.rejects(verify({ directory: temporary }), error => error.message.includes(file)); }
    finally { await fs.writeFile(filename, original); }
  }
  const extra = path.join(temporary, 'http/003.json'); await fs.copyFile(path.join(temporary, 'http/002.json'), extra);
  try { await assert.rejects(verify({ directory: temporary }), /Exactly two attempts/); }
  finally { await fs.unlink(extra); }
});

test('planned endpoint, case order, complete request, source identity and generated metadata are checked', () => {
  for (const mutate of [value => value.cases.reverse(), value => { value.provider = 'https://example.invalid'; }, value => { value.implementation.version = '0.10.0'; }]) {
    const changed = structuredClone(plan); mutate(changed); assert.throws(() => validatePlan(changed));
  }
  const changed = structuredClone(exchanges[0]);
  const body = JSON.parse(changed.request.bodyText); body.from = '0x' + '1'.repeat(40);
  changed.request.bodyText = JSON.stringify(body); changed.request.bytes = Buffer.byteLength(changed.request.bodyText); changed.request.sha256 = sha(changed.request.bodyText);
  assert.throws(() => validateExchange(changed, plan.cases[0], 0, plan.implementation), /entire original planned request/);
  for (const mutate of [value => { value.implementation.sourceSha256 = '0'.repeat(64); }, value => { value.id = 'invented'; }, value => { value.timing.rpcMs = -1; }]) {
    const response = structuredClone(reports[0]); mutate(response);
    const exchange = structuredClone(exchanges[0]); exchange.response.bodyText = JSON.stringify(response);
    exchange.response.bytes = Buffer.byteLength(exchange.response.bodyText); exchange.response.sha256 = sha(exchange.response.bodyText);
    assert.throws(() => validateExchange(exchange, plan.cases[0], 0, plan.implementation));
  }
});

test('only valid IDs and times are excluded; quantities, role labels, raw evidence and unavailable outcomes remain semantic', () => {
  const changed = structuredClone(reports[0]); changed.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; changed.createdAt = '2030-01-01T00:00:00.000Z';
  changed.timing = { rpcMs: 1, totalMs: 2 }; for (const record of changed.transportEvidence) record.transport.durationMs = 0;
  assert.deepEqual(semanticReport(changed), semanticReport(reports[0]));
  for (const mutate of [
    value => { value.measurements[0].deltaRaw = '-1'; },
    value => { value.preview.queries[2].accountIsSender = true; },
    value => { value.evidence[0].result = '0x2'; },
    value => { value.execution.status = 'unavailable'; },
    value => { value.security.status = 'safe'; },
  ]) { const altered = structuredClone(reports[0]); mutate(altered); assert.notDeepEqual(semanticReport(altered), semanticReport(reports[0])); }
});

test('RPC wire/order mismatch remains fatal outside API catch; leftover duplicate response cannot be reused', async () => {
  for (const mutate of [
    value => { value.transportEvidence[0].requestText += ' '; },
    value => { [value.transportEvidence[0], value.transportEvidence[1]] = [value.transportEvidence[1], value.transportEvidence[0]]; },
  ]) {
    const changed = structuredClone(exchanges[0]), response = structuredClone(reports[0]); mutate(response); changed.response.bodyText = JSON.stringify(response);
    await assert.rejects(replayExchange(changed, plan, runtime), /RPC mismatches were latched outside/);
  }
  const changed = structuredClone(exchanges[0]), response = structuredClone(reports[0]);
  response.transportEvidence.push(structuredClone(response.transportEvidence.at(-1))); changed.response.bodyText = JSON.stringify(response);
  await assert.rejects(replayExchange(changed, plan, runtime));
});

test('wire hashes and JSON-RPC result envelopes reject altered success data; withheld errors stay incomplete', () => {
  for (const mutate of [
    value => { value.responseText += ' '; },
    value => { value.transport.observedBytes++; },
    value => {
      const payload = JSON.parse(value.responseText); payload.error = null; value.responseText = JSON.stringify(payload);
      value.transport.observedBytes = value.transport.retainedPrefixBytes = Buffer.byteLength(value.responseText);
      for (const key of ['observedPrefixSha256', 'retainedPrefixSha256', 'responseSha256']) value.transport[key] = sha(value.responseText);
    },
  ]) { const altered = structuredClone(reports[0].transportEvidence); mutate(altered[0]); assert.throws(() => validateTransport(altered)); }
  const errors = structuredClone(reports[0].transportEvidence);
  errors[0].error = { code: 'RPC_RESPONSE_INVALID', message: 'Provider response unavailable.' };
  delete errors[0].responseText; errors[0].transport.bodyRetained = false;
  assert.equal(validateTransport(errors).withheldErrorBodies, 1);
  const failed = structuredClone(exchanges[0]); failed.response.status = 503;
  failed.response.bodyText = JSON.stringify({ error: { code: 'STANDARD_UNAVAILABLE', message: 'Unavailable.' } });
  failed.response.bytes = Buffer.byteLength(failed.response.bodyText); failed.response.sha256 = sha(failed.response.bodyText);
  const check = validateExchange(failed, plan.cases[0], 0, plan.implementation);
  assert.equal(check.exactWireReplayAvailable, false); assert.equal(check.report.error.code, 'STANDARD_UNAVAILABLE');
});
