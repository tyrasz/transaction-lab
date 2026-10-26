// Post-capture verification only. Imports the archived API after exact hashes
// are checked; its HTTP handler runs in memory and its RPC transport uses saved
// wire responses. No socket, provider connection, signing or broadcast occurs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

export const PLAN_SHA256 = 'c393b1bdd032e0f18ae8d6a698d5022ac27bae8f6ea4b5db90cb89e974992603';
export const MANIFEST_SHA256 = '473e1a366c7b20ca41f4fa7adb481500ea44e806bcfc3005285198550f276a52';
export const IMPLEMENTATION_SHA256 = '46c44c52578a050e56aef17f8f562b16f9e539bfdfe9aa4c5775d8b75447dc4e';
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const noble = 'engines/standard-evm/node_modules/@noble/hashes';
export const IMPLEMENTATION_FILES = [
  'package.json', 'src/config.js', 'src/server.js', 'src/validate.js', 'src/standard-loader.js', 'src/standard-rpc.js', 'src/standard-simulation.js',
  'src/rpc.js', 'src/state.js', 'src/state-diff.js', 'src/query-validation.js',
  'src/account-effects.js', 'src/affected-balances.js', 'src/allowances.js', 'src/analyze.js', 'src/balances.js', 'src/current-state.js',
  'src/historical-state.js', 'src/lending-balances.js', 'src/lending.js', 'src/permissions.js', 'src/revert.js',
  'engines/standard-evm/discovery.js', 'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json', 'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/provider-state-diff.js',
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => noble + '/' + name),
].sort();
export const ARCHIVE_FILES = [...IMPLEMENTATION_FILES, noble + '/LICENSE', 'public/app.js', 'public/index.html', 'public/style.css', 'reports/standard-evm-auto/run-server.mjs'].sort();
export const PACKET_FILES = ['STARTED', 'SWAP_CLIENT_STARTED', 'aave-response.json', 'browser-checks.json', 'http/001.json', 'http/002.json', 'http/003.json', 'morpho-response.json', 'plan.json', 'results.json', 'swap-client.json', 'swap-response.json', ...ARCHIVE_FILES.map(file => 'source/' + file)].sort();
const METHODS = new Set(['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'debug_traceCall']);
export const CASE_IDS = ['aave-usdc-supply-with-permit', 'morpho-kiln-usdc-deposit', 'contract-held-usdc-weth-swap'];
const keys = value => Object.keys(value).sort();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteTime = value => assert.ok(Number.isFinite(value) && value >= 0, 'Generated duration is finite and nonnegative.');
function timestamp(value) { assert.equal(new Date(value).toISOString(), value); return Date.parse(value); }

export function validatePlan(plan) {
  assert.equal(plan.schemaVersion, '1.0');
  assert.equal(plan.provider, 'https://eth.drpc.org');
  assert.equal(plan.endpoint, 'http://127.0.0.1:5174/api/evm/simulate');
  assert.deepEqual(plan.policy, { attemptsPerCase: 1, retainAllOutcomes: true, automaticRetries: false, replacements: false, signing: false, broadcasting: false, maxCases: 3 });
  assert.deepEqual(plan.implementation, { name: 'Transaction Lab Ethereum preview', version: '0.10.0', sourceSha256: IMPLEMENTATION_SHA256, sourceFiles: IMPLEMENTATION_FILES });
  assert.deepEqual(plan.sources.map(source => source.path), ARCHIVE_FILES);
  assert.deepEqual(plan.cases.map(item => item.id), CASE_IDS);
  assert.deepEqual(plan.cases.map(item => item.submission), ['browser', 'browser', 'HTTP_client']);
  assert.deepEqual(plan.cases.map(item => item.responseFile), ['aave-response.json', 'morpho-response.json', 'swap-response.json']);
  for (const item of plan.cases) assert.equal(Object.hasOwn(item.input, 'queries'), false, 'The frozen cases use automatic discovery.');
  timestamp(plan.createdAt);
}

export function validateManifest(manifest, plan) {
  assert.deepEqual(keys(manifest), ['capturedRequests', 'files', 'implementationSha256', 'planSha256', 'schemaVersion', 'sealedAt', 'sourceFiles']);
  assert.equal(manifest.schemaVersion, '1.0'); assert.equal(manifest.planSha256, PLAN_SHA256);
  assert.equal(manifest.implementationSha256, IMPLEMENTATION_SHA256);
  assert.equal(manifest.capturedRequests, 3); assert.equal(manifest.sourceFiles, 36);
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
  validateAutomaticReport(report);
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


export function validateAutomaticReport(report) {
  const discovery = report.discovery;
  assert.ok(plain(discovery)); assert.ok(['discovered','none','unavailable','not_applicable'].includes(discovery.status));
  assert.ok(Array.isArray(discovery.queries)); assert.ok(Array.isArray(discovery.candidates));
  assert.ok(discovery.queries.length <= 8); assert.ok(discovery.candidates.length <= 128);
  const selected = discovery.candidates.filter(item => item.selection === 'selected');
  assert.deepEqual(selected.map(item => item.query), discovery.queries, 'Selected candidate identities must equal the query list.');
  assert.equal(new Set(discovery.candidates.map(item => item.id)).size, discovery.candidates.length);
  if (discovery.counts) {
    assert.equal(typeof discovery.counts.complete, 'boolean'); assert.equal(typeof discovery.counts.truncated, 'boolean');
    assert.equal(discovery.counts.candidates, discovery.candidates.length); assert.equal(discovery.counts.selected, selected.length);
    assert.equal(discovery.counts.omitted, discovery.candidates.filter(item => item.selection === 'omitted_query_limit').length);
    assert.equal(discovery.counts.observations, discovery.observations.length);
    const ids = new Set(discovery.observations.map(item => item.id)); assert.equal(ids.size, discovery.observations.length);
    for (const item of discovery.candidates) {
      assert.ok(item.observationIds.length > 0); assert.ok(item.observationIds.every(id => ids.has(id)));
      assert.equal(item.id, item.query.to + ':' + item.query.data);
      for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(item[field], undefined, 'Candidate observations are not measurements.');
    }
  }
  if (report.request) {
    assert.equal(report.request.querySelection, 'bounded_observed_trace_candidates');
    assert.deepEqual(report.request.queries, discovery.queries);
  }
  assert.deepEqual(report.measurements.map(item => item.query), discovery.queries);
  assert.equal(report.preview.queries.length, report.measurements.length);
  for (const [index, measurement] of report.measurements.entries()) {
    const preview = report.preview.queries[index];
    assert.equal(preview.status, measurement.status);
    if (measurement.status !== 'measured') {
      for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(measurement[field], undefined);
      continue;
    }
    const observed = {};
    assert.deepEqual(measurement.queryEvidence.map(item => item.state), ['before', 'after']);
    for (const query of measurement.queryEvidence) {
      const evidence = report.evidence.find(item => item.id === query.traceEvidenceId);
      assert.equal(evidence.method, 'debug_traceCall');
      assert.equal(evidence.params[0].to, measurement.query.to); assert.equal(evidence.params[0].data, measurement.query.data);
      assert.deepEqual(evidence.params[1], report.request.block);
      assert.equal(evidence.params[2].tracer, 'callTracer');
      assert.equal(evidence.result.error, undefined); assert.equal(evidence.result.revertReason, undefined);
      assert.match(evidence.result.output, /^0x[0-9a-f]{64}$/i);
      observed[query.state] = BigInt(evidence.result.output);
      const mutation = report.evidence.find(item => item.id === query.mutationEvidenceId);
      assert.equal(mutation.method, 'debug_traceCall'); assert.equal(mutation.params[2].tracer, 'prestateTracer');
      assert.deepEqual(mutation.params.slice(0, 2), evidence.params.slice(0, 2));
      assert.deepEqual(mutation.params[2].stateOverrides, evidence.params[2].stateOverrides);
    }
    assert.equal(measurement.beforeRaw, observed.before.toString()); assert.equal(measurement.afterRaw, observed.after.toString());
    assert.equal(measurement.deltaRaw, (observed.after - observed.before).toString());
    for (const field of ['beforeRaw','afterRaw','deltaRaw']) assert.equal(preview[field], measurement[field]);
  }
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
  const attempts = ['001.json', '002.json', '003.json'];
  assert.deepEqual((await fs.readdir(path.join(directory, 'http'))).sort(), attempts, 'Exactly three attempts are retained; none may be omitted or replaced.');
  const started = (await bound(directory, 'STARTED')).toString('utf8').trim();
  assert.ok(timestamp(started) >= timestamp(plan.createdAt));
  const exchanges = await Promise.all(attempts.map(file => bound(directory, 'http/' + file).then(JSON.parse)));
  assert.ok(timestamp(exchanges[0].startedAt) >= timestamp(started));
  for (let i = 1; i < exchanges.length; i++) assert.ok(timestamp(exchanges[i].startedAt) >= timestamp(exchanges[i - 1].completedAt));
  assert.ok(timestamp(manifest.sealedAt) >= timestamp(exchanges.at(-1).completedAt));
  const swapStarted = (await bound(directory, 'SWAP_CLIENT_STARTED')).toString('utf8').trim();
  assert.ok(timestamp(swapStarted) >= timestamp(exchanges[1].completedAt));
  assert.ok(timestamp(exchanges[2].startedAt) >= timestamp(swapStarted));
  const swapClient = JSON.parse(await bound(directory, 'swap-client.json'));
  assert.deepEqual(swapClient, { status: exchanges[2].response.status, bodyText: exchanges[2].response.bodyText }, 'Independent HTTP client retained the complete third response.');
  const summaries = JSON.parse(await bound(directory, 'results.json'));
  const browser = JSON.parse(await bound(directory, 'browser-checks.json'));
  assert.equal(summaries.schemaVersion, '1.0'); assert.equal(summaries.developmentOnly, true); assert.equal(summaries.purpose, plan.purpose);
  assert.equal(summaries.planSha256, PLAN_SHA256); assert.equal(summaries.cases.length, 3);
  assert.equal(browser.cases.length, 2); assert.equal(browser.url, 'http://127.0.0.1:5174/');
  assert.deepEqual(browser.swap, { id: CASE_IDS[2], submission: 'HTTP_client', browserNotExercised: true });
  const runtime = {
    ...(await import(pathToFileURL(path.join(directory, 'source/src/server.js')).href)),
    ...(await import(pathToFileURL(path.join(directory, 'source/src/standard-rpc.js')).href)),
  };
  const { loadStandardApi } = await import(pathToFileURL(path.join(directory, 'source/src/standard-loader.js')).href);
  const loaded = await loadStandardApi(); assert.ok(loaded); assert.deepEqual(loaded.implementation, plan.implementation);
  // The third planned call is a separate HTTP input, not an invented UI example.
  assert.equal(loaded.STANDARD_EXAMPLES.length, 2);
  for (const [index, example] of loaded.STANDARD_EXAMPLES.entries()) {
    const { queries, ...automatic } = example.input;
    assert.deepEqual({id:example.id,input:automatic,reference:example.reference},
      {id:plan.cases[index].id,input:plan.cases[index].input,reference:plan.cases[index].reference});
  }
  const cases = [];
  for (const [index, exchange] of exchanges.entries()) {
    const checked = validateExchange(exchange, plan.cases[index], index, plan.implementation);
    const report = checked.report, summary = summaries.cases[index], planned = plan.cases[index];
    assert.deepEqual(JSON.parse(await bound(directory, planned.responseFile)), report, 'Pretty response must retain the entire HTTP result.');
    assert.deepEqual(summary, {
      id: planned.id, runId: report.id, responseFile: planned.responseFile, responseStatus: exchange.response.status,
      execution: report.execution?.status, canonicalStatus: report.canonicalStatus, discoveryStatus: report.discovery?.status,
      discoveryCounts: report.discovery?.counts, selectedQueries: report.measurements?.length,
      measuredQueries: report.measurements?.filter(item => item.status === 'measured').length,
      rpcCalls: checked.accounting?.rpcCalls, rpcResponseBytes: checked.accounting?.observedBytes,
      totalMs: report.timing?.totalMs, gasUsed: report.execution?.gasUsed, previewQueries: report.preview?.queries,
      omittedCandidates: report.discovery?.candidates.filter(item => item.selection === 'omitted_query_limit'),
    });
    if (planned.submission === 'browser') {
      const manual = browser.cases[index]; assert.equal(manual.id, planned.id); assert.equal(manual.runId, report.id);
      assert.equal(manual.submission, 'browser'); assert.equal(manual.automaticDefault, true); assert.equal(manual.requestOmittedQueries, true);
      assert.equal(manual.checksShown, summary.discoveryCounts.candidates+' candidates / '+summary.selectedQueries+' selected / '+summary.measuredQueries+' measured / '+summary.discoveryCounts.omitted+' omitted');
      const senderBalances = report.preview.queries.filter(query => query.kind === 'balanceOf' && query.accountIsSender);
      const deltas = senderBalances.map(query => query.metadata.symbol+' '+(BigInt(query.deltaRaw)>0n?'+':'')+query.delta).sort();
      assert.deepEqual([...manual.exactSenderBalanceChanges].sort(), deltas);
      const senderAllowances = report.preview.queries.filter(query => query.kind === 'allowance' && query.accountIsSender);
      assert.equal(senderAllowances.length, 1);
      assert.equal(manual.senderAllowance, senderAllowances[0].before+' to '+senderAllowances[0].after);
    }
    const playback = checked.exactWireReplayAvailable ? await replayExchange(exchange, plan, runtime) : { status: 'incomplete', reason: checked.reason };
    cases.push({id:planned.id,submission:planned.submission,httpStatus:exchange.response.status,requestSha256:exchange.request.sha256,responseSha256:exchange.response.sha256,
      execution:report.execution?.status??'unavailable',canonicalStatus:report.canonicalStatus??'unavailable',
      discovery:{status:report.discovery?.status,counts:report.discovery?.counts,selectedQueries:report.discovery?.queries,
        omittedCandidates:report.discovery?.candidates.filter(item=>item.selection==='omitted_query_limit')},
      measurements:report.measurements?.map(item=>({query:item.query,status:item.status,...(item.status==='measured'?{beforeRaw:item.beforeRaw,afterRaw:item.afterRaw,deltaRaw:item.deltaRaw}:{reason:item.reason})}))??[],
      accounting:checked.accounting,playback});
  }
  const totals = {rpcCalls:cases.reduce((n,c)=>n+(c.accounting?.rpcCalls??0),0),rpcResponseBytes:cases.reduce((n,c)=>n+(c.accounting?.observedBytes??0),0)};
  assert.deepEqual(summaries.totals,totals);
  return {status:cases.every(item=>item.playback.status==='matched')?'passed':'incomplete',
    manifestSha256:MANIFEST_SHA256,planSha256:PLAN_SHA256,implementationSha256:IMPLEMENTATION_SHA256,sourceFiles:ARCHIVE_FILES.length,sealedFiles:PACKET_FILES.length,
    attachmentChecks:{completePrettyResponses:3,derivedSummaries:3,manualBrowserRecordsBoundToResults:2,independentHttpClientResponse:1,browserRenderingReplayed:false},
    publicNetworkRequests:0,socketsOpened:0,liveSourceImports:0,replayMode:'archived_createAppServer_handler_in_memory_with_archived_StandardRpcClient',totals,cases,
    limitations:['Recorded server-side prepared HTTP responses; this verifier does not reenact browser rendering or socket delivery. The third response also matches the saved independent HTTP client body.',
      'Same-provider recorded-response playback verifies integrity and reproducibility, not independent EVM correctness or all-effects coverage.',
      'Historical parent-block-end unpriced unsigned executions do not validate original transaction position, outer signatures or fee settlement.',
      'Candidate selection is reproduced completely, including omitted candidates; emitted/call amounts never replace measured state.',
      'Contract-held swap balances are not attributed to the external submitter. Unknown display metadata stays raw.',
      'Withheld error bodies cannot be reconstructed or substituted; such playback remains incomplete.']};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const result = await verify(), text = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2] === '--write') await fs.writeFile(path.join(here, 'verification.json'), text, { flag: 'wx', mode: 0o444 });
  process.stdout.write(text); if (result.status !== 'passed') process.exitCode = 1;
}
