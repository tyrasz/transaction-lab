import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verify, validatePlan, validateManifest, validateTransport, validateExchange, semanticReport, replayExchange, validateAutomaticReport,
  PLAN_SHA256, MANIFEST_SHA256, IMPLEMENTATION_SHA256, PACKET_FILES } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(path.join(here, file), 'utf8'));
const plan = await readJson('plan.json'), manifest = await readJson('manifest.json');
const exchanges = await Promise.all(['http/001.json', 'http/002.json', 'http/003.json'].map(readJson));
const reports = exchanges.map(exchange => JSON.parse(exchange.response.bodyText));
let temporary, result, runtime, attemptedPublicRequests = 0;

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-auto-packet-'));
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

test('isolated archived API reproduces all three complete automatic results and every saved wire exchange', () => {
  assert.equal(result.status, 'passed'); assert.equal(result.manifestSha256, MANIFEST_SHA256);
  assert.equal(result.planSha256, PLAN_SHA256); assert.equal(result.implementationSha256, IMPLEMENTATION_SHA256);
  assert.equal(result.sourceFiles, 36); assert.equal(result.sealedFiles, 48); assert.equal(attemptedPublicRequests, 0);
  assert.equal(result.socketsOpened, 0); assert.equal(result.liveSourceImports, 0);
  assert.deepEqual(result.cases.map(item => [item.httpStatus, item.accounting.rpcCalls, item.accounting.observedBytes]), [[200, 30, 98187], [200, 46, 345927], [200, 30, 203990]]);
  assert.deepEqual(result.cases.map(item => item.measurements.map(value => value.deltaRaw)), [
    ['3962903484', '-3962903485', '0', '3962903485'],
    ['330497511812', '-350000000000', '-350000000000', '55312640', '0', '350000000000', '0', '27347370306362683662'],
    ['-13542516010', '13542516010', '5801876231282977354', '-5801876231282977354'],
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

test('current files cannot substitute changed archived source, HTTP bytes, or a hidden fourth attempt', async () => {
  for (const file of ['source/src/server.js', 'http/001.json']) {
    const filename = path.join(temporary, file), original = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
    try { await assert.rejects(verify({ directory: temporary }), error => error.message.includes(file)); }
    finally { await fs.writeFile(filename, original); }
  }
  const extra = path.join(temporary, 'http/004.json'); await fs.copyFile(path.join(temporary, 'http/002.json'), extra);
  try { await assert.rejects(verify({ directory: temporary }), /Exactly three attempts/); }
  finally { await fs.unlink(extra); }
});

test('planned endpoint, case order, complete request, source identity and generated metadata are checked', () => {
  for (const mutate of [value => value.cases.reverse(), value => { value.provider = 'https://example.invalid'; }, value => { value.implementation.version = '0.11.0'; }]) {
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
    value => { value.preview.queries[3].accountIsSender = true; },
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


test('automatic candidates, omissions and raw measurements are reproduced, not trusted as summary-only assertions', async () => {
  for (const mutate of [
    value => { value.discovery.candidates[0].account = '0x'+'1'.repeat(40); },
    value => { value.discovery.observations[0].amountRaw = '999999999999999999'; },
    value => { value.discovery.candidates.at(-1).selection = 'selected'; },
    value => { value.discovery.scope.tokenIdentityVerified = true; },
    value => { value.discovery.counts.complete = false; },
    value => { value.measurements[0].deltaRaw = '-1'; value.preview.queries[0].deltaRaw = '-1'; },
  ]) {
    const changed = structuredClone(exchanges[1]), response = structuredClone(reports[1]);
    mutate(response); changed.response.bodyText = JSON.stringify(response);
    await assert.rejects(replayExchange(changed, plan, runtime), /Every nongenerated API\/result\/wire field/);
  }
  const dropped = structuredClone(exchanges[1]), response = structuredClone(reports[1]);
  response.discovery.candidates.pop(); response.discovery.counts.candidates--; response.discovery.counts.omitted--;
  dropped.response.bodyText = JSON.stringify(response);
  await assert.rejects(replayExchange(dropped, plan, runtime), /Every nongenerated API\/result\/wire field/);
});

test('independent discovery invariants bind selections, observed query return words and before/after pairing', () => {
  for (const mutate of [
    value => { value.discovery.candidates[0].selection = 'omitted_query_limit'; },
    value => { value.discovery.candidates[0].observationIds = ['invented']; },
    value => { value.discovery.counts.omitted = 0; },
    value => { value.measurements[0].afterRaw = '2'; value.preview.queries[0].afterRaw = '2'; },
    value => { value.measurements[0].queryEvidence.reverse(); },
    value => { value.evidence.find(e=>e.id===value.measurements[0].queryEvidence[1].traceEvidenceId).result.output = '0x01'; },
    value => { value.discovery.candidates[0].deltaRaw = '123'; },
  ]) { const altered = structuredClone(reports[1]); mutate(altered); assert.throws(()=>validateAutomaticReport(altered)); }
});

test('missing declared case and unexpected extra runtime RPC remain fatal rather than becoming unavailable success', async () => {
  const missingPlan = structuredClone(plan); missingPlan.cases.pop(); assert.throws(()=>validatePlan(missingPlan));
  const filename = path.join(temporary,'http/003.json'), original = await fs.readFile(filename);
  await fs.unlink(filename);
  try { await assert.rejects(verify({directory:temporary}), error=>error.code==='ENOENT'); }
  finally { await fs.writeFile(filename,original); }
  const changed = structuredClone(exchanges[2]), response = structuredClone(reports[2]);
  response.transportEvidence.pop(); changed.response.bodyText = JSON.stringify(response);
  await assert.rejects(replayExchange(changed,plan,runtime), /RPC mismatches were latched outside/);
});

test('the swap measures contract accounts without borrowing sender ownership or invented token display metadata', () => {
  const swap = reports[2];
  assert.equal(result.attachmentChecks.independentHttpClientResponse,1);
  assert.equal(result.attachmentChecks.manualBrowserRecordsBoundToResults,2);
  assert.equal(swap.discovery.counts.candidates,4); assert.equal(swap.discovery.counts.omitted,0);
  assert.ok(swap.preview.queries.every(q=>q.accountIsSender===false));
  assert.ok(swap.preview.queries.every(q=>q.account!==swap.apiRequest.from));
  const weth=swap.preview.queries.filter(q=>q.token==='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  assert.equal(weth.length,2);assert.ok(weth.every(q=>q.metadata===null&&q.before===undefined&&q.after===undefined&&q.delta===undefined));
  assert.deepEqual(result.cases.map(c=>[c.discovery.counts.candidates,c.discovery.counts.selected,c.discovery.counts.omitted]),[[4,4,0],[11,8,3],[4,4,0]]);
});
