// Post-capture verification only. Imports the archived API after exact hashes
// are checked; its HTTP handler runs in memory and its RPC transport uses saved
// wire responses. No socket, provider connection, signing or broadcast occurs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

export const PLAN_SHA256 = 'd210d8867d00a19e26bf0464fe8a999f65b347702d3d90c2ac183d4ed5a6a6fd';
export const MANIFEST_SHA256 = '5a8a8d7d6749bad58c12f75349682bdc2773eb9ce0e567b52aee68b43193dc4c';
export const IMPLEMENTATION_SHA256 = '9c0917464c657429c37b01b73961f310adeb902e91ff585fc12b82c8b6053773';
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const noble = 'engines/standard-evm/node_modules/@noble/hashes';
export const IMPLEMENTATION_FILES = [
  'package.json', 'src/config.js', 'src/server.js', 'src/validate.js', 'src/standard-loader.js', 'src/standard-rpc.js', 'src/standard-simulation.js',
  'src/rpc.js', 'src/state.js', 'src/state-diff.js', 'src/query-validation.js',
  'src/account-effects.js', 'src/affected-balances.js', 'src/allowances.js', 'src/analyze.js', 'src/balances.js', 'src/current-state.js',
  'src/historical-state.js', 'src/lending-balances.js', 'src/lending.js', 'src/permissions.js', 'src/revert.js',
  'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json', 'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/provider-state-diff.js',
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => noble + '/' + name),
].sort();
export const ARCHIVE_FILES = [...IMPLEMENTATION_FILES, noble + '/LICENSE', 'public/app.js', 'public/index.html', 'public/style.css', 'reports/standard-evm-api/run-server.mjs'].sort();
export const PACKET_FILES = ['STARTED', 'aave-response.json', 'browser-checks.json', 'http/001.json', 'http/002.json', 'morpho-response.json', 'plan.json', 'results.json', ...ARCHIVE_FILES.map(file => 'source/' + file)].sort();
const METHODS = new Set(['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'debug_traceCall']);
const CASE_IDS = ['aave-usdc-supply-with-permit', 'morpho-kiln-usdc-deposit'];
const keys = value => Object.keys(value).sort();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteTime = value => assert.ok(Number.isFinite(value) && value >= 0, 'Generated duration is finite and nonnegative.');
function timestamp(value) { assert.equal(new Date(value).toISOString(), value); return Date.parse(value); }

export function validatePlan(plan) {
  assert.equal(plan.schemaVersion, '1.0');
  assert.equal(plan.provider, 'https://eth.drpc.org');
  assert.equal(plan.endpoint, 'http://127.0.0.1:5174/api/evm/simulate');
  assert.deepEqual(plan.policy, { browserAttemptsPerCase: 1, retainAllOutcomes: true, automaticRetries: false, replacements: false, signing: false, broadcasting: false });
  assert.deepEqual(plan.implementation, { name: 'Transaction Lab Ethereum preview', version: '0.9.0', sourceSha256: IMPLEMENTATION_SHA256, sourceFiles: IMPLEMENTATION_FILES });
  assert.deepEqual(plan.sources.map(source => source.path), ARCHIVE_FILES);
  assert.deepEqual(plan.cases.map(item => item.id), CASE_IDS);
  timestamp(plan.createdAt);
}

export function validateManifest(manifest, plan) {
  assert.deepEqual(keys(manifest), ['capturedRequests', 'files', 'implementationSha256', 'planSha256', 'schemaVersion', 'sealedAt', 'sourceFiles']);
  assert.equal(manifest.schemaVersion, '1.0'); assert.equal(manifest.planSha256, PLAN_SHA256);
  assert.equal(manifest.implementationSha256, IMPLEMENTATION_SHA256);
  assert.equal(manifest.capturedRequests, 2); assert.equal(manifest.sourceFiles, 35);
  assert.deepEqual(manifest.files.map(file => file.path), PACKET_FILES);
  assert.ok(timestamp(manifest.sealedAt) >= timestamp(plan.createdAt));
  for (const file of manifest.files) {
    assert.deepEqual(keys(file), ['bytes', 'path', 'sha256']);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0); assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  for (const source of plan.sources) assert.deepEqual(manifest.files.find(file => file.path === 'source/' + source.path), { ...source, path: 'source/' + source.path });
}

export function validateTransport(records) {
  assert.ok(Array.isArray(records)); assert.ok(records.length <= 65);
  let observedBytes = 0, retainedBytes = 0, durationMs = 0, withheld = 0;
  for (const [index, record] of records.entries()) {
    assert.equal(record.id, index + 1); assert.equal(record.provider, 'eth.drpc.org');
    assert.deepEqual(keys(record.request), ['id', 'jsonrpc', 'method', 'params']);
    assert.equal(record.request.id, index + 1); assert.equal(record.request.jsonrpc, '2.0');
    assert.ok(METHODS.has(record.request.method)); assert.ok(Array.isArray(record.request.params));
    assert.equal(record.requestText, JSON.stringify(record.request));
    assert.equal(record.requestBytes, Buffer.byteLength(record.requestText)); assert.equal(record.requestSha256, sha(record.requestText));
    const transport = record.transport;
    assert.ok(plain(transport)); assert.equal(typeof transport.complete, 'boolean'); assert.equal(typeof transport.bodyRetained, 'boolean');
    for (const key of ['observedBytes', 'retainedPrefixBytes']) assert.ok(Number.isSafeInteger(transport[key]) && transport[key] >= 0);
    assert.ok(transport.observedBytes >= transport.retainedPrefixBytes);
    assert.ok(transport.retainedPrefixBytes <= 8 * 1024 * 1024);
    assert.ok(transport.timeoutMs > 0 && transport.timeoutMs <= 25000); finiteTime(transport.durationMs);
    for (const key of ['observedPrefixSha256', 'retainedPrefixSha256']) assert.match(transport[key], /^[0-9a-f]{64}$/);
    observedBytes += transport.observedBytes; retainedBytes += transport.retainedPrefixBytes; durationMs += transport.durationMs;
    if (record.error !== undefined) {
      assert.ok(plain(record.error)); assert.equal(typeof record.error.code, 'string'); assert.equal(typeof record.error.message, 'string');
      assert.equal(record.responseText, undefined); assert.equal(transport.bodyRetained, false); withheld++;
      if (transport.complete && transport.observedBytes === transport.retainedPrefixBytes) assert.match(transport.responseSha256, /^[0-9a-f]{64}$/);
      else assert.equal(transport.responseSha256, undefined);
      continue;
    }
    assert.ok(record.httpStatus >= 200 && record.httpStatus < 300);
    assert.equal(typeof record.responseText, 'string');
    assert.equal(transport.complete, true); assert.equal(transport.bodyRetained, true);
    const bytes = Buffer.from(record.responseText, 'utf8');
    assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), record.responseText);
    assert.equal(bytes.length, transport.observedBytes); assert.equal(bytes.length, transport.retainedPrefixBytes);
    for (const key of ['observedPrefixSha256', 'retainedPrefixSha256', 'responseSha256']) assert.equal(transport[key], sha(bytes));
    const response = JSON.parse(record.responseText);
    assert.deepEqual(keys(response), ['id', 'jsonrpc', 'result']); assert.equal(response.id, record.id); assert.equal(response.jsonrpc, '2.0');
  }
  assert.ok(retainedBytes <= 32 * 1024 * 1024);
  return { rpcCalls: records.length, observedBytes, retainedBytes, durationMs, withheldErrorBodies: withheld };
}

export function validateExchange(exchange, planned, index, implementation) {
  assert.equal(exchange.index, index + 1);
  assert.ok(timestamp(exchange.completedAt) >= timestamp(exchange.startedAt));
  assert.deepEqual(keys(exchange.request), ['bodyText', 'bytes', 'contentType', 'method', 'path', 'sha256']);
  assert.equal(exchange.request.method, 'POST'); assert.equal(exchange.request.path, '/api/evm/simulate');
  assert.equal(exchange.request.contentType, 'application/json');
  for (const part of [exchange.request, exchange.response]) {
    assert.equal(typeof part.bodyText, 'string');
    assert.equal(part.bytes, Buffer.byteLength(part.bodyText)); assert.equal(part.sha256, sha(part.bodyText));
  }
  assert.deepEqual(JSON.parse(exchange.request.bodyText), planned.input, 'The entire original planned request is retained in order.');
  assert.ok(Number.isInteger(exchange.response.status) && exchange.response.status >= 100 && exchange.response.status <= 599);
  const report = JSON.parse(exchange.response.bodyText);
  if (exchange.response.status !== 200) {
    assert.ok(plain(report.error)); assert.equal(typeof report.error.code, 'string'); assert.equal(typeof report.error.message, 'string');
    return { report, accounting: null, exactWireReplayAvailable: false, reason: 'The observed HTTP failure has no complete provider wire-response set for deterministic reproduction.' };
  }
  assert.deepEqual(report.implementation, implementation);
  validateGenerated(report);
  assert.ok(timestamp(report.createdAt) >= timestamp(exchange.startedAt) && timestamp(report.createdAt) <= timestamp(exchange.completedAt));
  assert.deepEqual(report.apiRequest, planned.input);
  assert.equal(report.source.kind, 'standard_evm_unsigned_call'); assert.equal(report.source.profile, 'unsigned_unpriced_block_end');
  assert.deepEqual(report.source.blockSelection, { requested: planned.input.block, kind: 'pinned_hash', resolvedHash: planned.input.block, resolvedNumber: null, evidence: null });
  assert.deepEqual(report.security, { status: 'not_assessed' });
  const accounting = validateTransport(report.transportEvidence);
  assert.equal(report.accounting.rpcCalls, accounting.rpcCalls);
  assert.equal(report.evidence.length, accounting.rpcCalls);
  for (const [i, record] of report.transportEvidence.entries()) {
    assert.equal(report.evidence[i].method, record.request.method); assert.deepEqual(report.evidence[i].params, record.request.params);
    if (!record.error) assert.deepEqual(report.evidence[i].result, JSON.parse(record.responseText).result);
  }
  return { report, accounting, exactWireReplayAvailable: accounting.withheldErrorBodies === 0,
    ...(accounting.withheldErrorBodies ? { reason: 'Provider error body bytes were deliberately withheld; their hashes/counts are retained, but no response is invented for playback.' } : {}) };
}

function validateGenerated(report) {
  assert.match(report.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  timestamp(report.createdAt); assert.deepEqual(keys(report.timing), ['rpcMs', 'totalMs']);
  finiteTime(report.timing.totalMs); finiteTime(report.timing.rpcMs);
  for (const record of report.transportEvidence) finiteTime(record.transport.durationMs);
}
export function semanticReport(report) {
  validateGenerated(report);
  const result = structuredClone(report);
  delete result.id; delete result.createdAt; delete result.timing;
  for (const record of result.transportEvidence) delete record.transport.durationMs;
  return result;
}

async function invokeHandler(server, request) {
  const req = Readable.from([Buffer.from(request.bodyText)]);
  Object.assign(req, { method: request.method, url: request.path, headers: { host: '127.0.0.1:5174', 'content-type': request.contentType } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Archived in-memory API did not complete within the offline bound.')), 10000);
      const res = { statusCode: 200, writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
        end(body) { resolve({ status: this.statusCode, bodyText: Buffer.from(body ?? '').toString('utf8') }); return this; } };
      server.emit('request', req, res);
    });
  } finally { clearTimeout(timer); }
}

export async function replayExchange(exchange, plan, runtime) {
  const saved = JSON.parse(exchange.response.bodyText), records = saved.transportEvidence;
  let cursor = 0, factories = 0;
  const mismatches = [], consumed = [];
  const rpc = new runtime.StandardRpcClient({ url: plan.provider, fetchImpl: async (url, options) => {
    const index = cursor++, record = records[index];
    try {
      assert.ok(record, 'No extra request may use an invented response.');
      assert.equal(url.href, plan.provider + '/'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { 'content-type': 'application/json' });
      assert.equal(options.body, record.requestText, 'Exact original wire request/order is required.');
      assert.deepEqual(JSON.parse(options.body), record.request);
      assert.equal(record.error, undefined); assert.equal(record.transport.bodyRetained, true);
      assert.equal(sha(record.responseText), record.transport.responseSha256);
      consumed.push(record.id);
      return new Response(record.responseText, { status: record.httpStatus });
    } catch {
      // API/engine code can catch transport assertions. Retain an independent
      // latch and inspect it outside the complete handler before any pass.
      mismatches.push(index + 1); throw new Error('Recorded RPC wire mismatch.');
    }
  } });
  const server = runtime.createAppServer({ persist: false, standardRpcFactory() { factories++; return rpc; }, rpcFactory() {
    mismatches.push('unexpected_legacy_provider'); throw new Error('A legacy provider is outside this playback.');
  } });
  const replayed = await invokeHandler(server, exchange.request);
  assert.deepEqual(mismatches, [], 'RPC mismatches were latched outside the API and engine.');
  assert.equal(factories, 1); assert.equal(cursor, records.length); assert.deepEqual(consumed, records.map(record => record.id));
  assert.equal(new Set(consumed).size, consumed.length);
  assert.equal(replayed.status, exchange.response.status);
  assert.deepEqual(semanticReport(JSON.parse(replayed.bodyText)), semanticReport(saved), 'Every nongenerated API/result/wire field must reproduce exactly.');
  return { status: 'matched', consumedRpcIds: consumed, excludedGeneratedFields: ['id', 'createdAt', 'timing', 'transportEvidence[].transport.durationMs'] };
}

async function bound(directory, relative, expectedHash, expectedBytes) {
  const absolute = path.resolve(directory, relative); assert.ok(absolute.startsWith(directory + path.sep));
  assert.equal(await fs.realpath(absolute), absolute, 'Archive/evidence may not resolve through a symlink.');
  const bytes = await fs.readFile(absolute);
  if (expectedHash !== undefined) assert.equal(sha(bytes), expectedHash, relative);
  if (expectedBytes !== undefined) assert.equal(bytes.length, expectedBytes, relative);
  return bytes;
}

export async function verify({ directory = here } = {}) {
  directory = await fs.realpath(directory);
  const plan = JSON.parse(await bound(directory, 'plan.json', PLAN_SHA256)); validatePlan(plan);
  const manifest = JSON.parse(await bound(directory, 'manifest.json', MANIFEST_SHA256)); validateManifest(manifest, plan);
  for (const file of manifest.files) await bound(directory, file.path, file.sha256, file.bytes);
  const implementationHash = createHash('sha256');
  for (const source of plan.sources) await bound(directory, 'source/' + source.path, source.sha256, source.bytes);
  for (const file of IMPLEMENTATION_FILES) implementationHash.update(file + '\0').update(await bound(directory, 'source/' + file)).update('\0');
  assert.equal(implementationHash.digest('hex'), IMPLEMENTATION_SHA256);
  const actualSources = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      const child = relative + '/' + entry.name;
      if (entry.isDirectory()) await walk(child); else { assert.ok(entry.isFile()); actualSources.push(child.slice('source/'.length)); }
    }
  }
  await walk('source'); assert.deepEqual(actualSources.sort(), ARCHIVE_FILES);
  assert.deepEqual((await fs.readdir(path.join(directory, 'http'))).sort(), ['001.json', '002.json'], 'Exactly two attempts are retained; none may be omitted or replaced.');
  const started = (await bound(directory, 'STARTED')).toString('utf8').trim();
  assert.ok(timestamp(started) >= timestamp(plan.createdAt));
  const exchanges = await Promise.all(['001.json', '002.json'].map(file => bound(directory, 'http/' + file).then(JSON.parse)));
  assert.ok(timestamp(exchanges[0].startedAt) >= timestamp(started));
  assert.ok(timestamp(exchanges[1].startedAt) >= timestamp(exchanges[0].completedAt));
  assert.ok(timestamp(manifest.sealedAt) >= timestamp(exchanges[1].completedAt));
  const summaries = JSON.parse(await bound(directory, 'results.json'));
  const browser = JSON.parse(await bound(directory, 'browser-checks.json'));
  assert.equal(summaries.planSha256, PLAN_SHA256); assert.equal(summaries.runs.length, 2); assert.equal(browser.runs.length, 2);
  for (const time of [summaries.createdAt, browser.observedAt]) assert.ok(timestamp(time) >= timestamp(exchanges[1].completedAt) && timestamp(time) <= timestamp(manifest.sealedAt));
  assert.equal(browser.url, 'http://127.0.0.1:5174/');
  const runtime = {
    ...(await import(pathToFileURL(path.join(directory, 'source/src/server.js')).href)),
    ...(await import(pathToFileURL(path.join(directory, 'source/src/standard-rpc.js')).href)),
  };
  const { loadStandardApi } = await import(pathToFileURL(path.join(directory, 'source/src/standard-loader.js')).href);
  const loaded = await loadStandardApi(); assert.ok(loaded); assert.deepEqual(loaded.implementation, plan.implementation);
  assert.deepEqual(loaded.STANDARD_EXAMPLES.map(example => ({ id: example.id, input: example.input, reference: example.reference })), plan.cases);
  const cases = [];
  for (const [index, exchange] of exchanges.entries()) {
    const checked = validateExchange(exchange, plan.cases[index], index, plan.implementation);
    const report = checked.report, summary = summaries.runs[index], manual = browser.runs[index];
    const responseFile = ['aave-response.json', 'morpho-response.json'][index], httpFile = `http/00${index + 1}.json`;
    assert.deepEqual(JSON.parse(await bound(directory, responseFile)), report, 'Pretty response must retain the entire HTTP result.');
    assert.deepEqual(summary, { id: plan.cases[index].id, runId: report.id, httpFile,
      httpSha256: manifest.files.find(file => file.path === httpFile).sha256, responseFile,
      responseStatus: exchange.response.status, execution: report.execution?.status,
      measured: report.measurements?.filter(item => item.status === 'measured').length, queries: report.measurements?.length,
      rpcCalls: checked.accounting?.rpcCalls, rpcResponseBytes: checked.accounting?.observedBytes, totalMs: report.timing?.totalMs,
      gasUsed: report.execution?.gasUsed,
      queryChanges: report.preview?.queries.map(query => ({ token: query.token, account: query.account ?? query.owner,
        kind: query.kind, before: query.before, after: query.after, delta: query.delta })) });
    assert.equal(manual.caseId, plan.cases[index].id); assert.equal(manual.runId, report.id);
    assert.equal(manual.executionLabel, report.execution.status === 'success' ? 'Completed' : 'Failed');
    assert.equal(manual.checksLabel, `${summary.measured} / ${summary.queries} measured`);
    assert.deepEqual(manual.formattedDeltas, report.preview.queries.map(query => BigInt(query.deltaRaw) > 0n ? '+' + query.delta : query.delta));
    for (const [kind, field] of [['balanceOf', 'senderBalanceCardIndices'], ['allowance', 'senderAllowanceCardIndices']]) {
      const cards = report.preview.queries.filter(query => query.kind === kind);
      assert.deepEqual(manual[field], cards.flatMap((query, i) => query.accountIsSender ? [i] : []));
    }
    const playback = checked.exactWireReplayAvailable ? await replayExchange(exchange, plan, runtime) : { status: 'incomplete', reason: checked.reason };
    cases.push({ id: plan.cases[index].id, httpStatus: exchange.response.status, requestSha256: exchange.request.sha256, responseSha256: exchange.response.sha256,
      execution: checked.report.execution?.status ?? 'unavailable', canonicalStatus: checked.report.canonicalStatus ?? 'unavailable',
      measurements: checked.report.measurements?.map(item => ({ query: item.query, status: item.status, ...(item.status === 'measured' ? { beforeRaw: item.beforeRaw, afterRaw: item.afterRaw, deltaRaw: item.deltaRaw } : { reason: item.reason }) })) ?? [],
      accounting: checked.accounting, playback });
  }
  return { status: cases.every(item => item.playback.status === 'matched') ? 'passed' : 'incomplete',
    manifestSha256: MANIFEST_SHA256, planSha256: PLAN_SHA256, implementationSha256: IMPLEMENTATION_SHA256, sourceFiles: ARCHIVE_FILES.length, sealedFiles: PACKET_FILES.length,
    attachmentChecks: { completePrettyResponses: 2, derivedSummaries: 2, manualBrowserRecordsBoundToResults: 2, browserRenderingReplayed: false },
    publicNetworkRequests: 0, socketsOpened: 0, liveSourceImports: 0, replayMode: 'archived_createAppServer_handler_in_memory_with_archived_StandardRpcClient', cases,
    limitations: ['Recorded server-side prepared HTTP responses; this verifier does not reenact the browser rendering or socket delivery.',
      'Same-provider recorded-response playback verifies integrity and reproducibility, not independent EVM correctness or all-effects coverage.',
      'Historical parent-block-end unpriced unsigned executions do not validate original transaction position, outer signatures or fee settlement.',
      'Withheld error bodies cannot be reconstructed or substituted; such playback remains incomplete.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const result = await verify(), text = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2] === '--write') await fs.writeFile(path.join(here, 'verification.json'), text, { flag: 'wx', mode: 0o444 });
  process.stdout.write(text); if (result.status !== 'passed') process.exitCode = 1;
}
