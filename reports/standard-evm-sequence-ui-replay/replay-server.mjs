// Supplemental browser QA. The real archived handler and transport consume
// exact recorded RPC bytes. No public network or direct response shortcut.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKET = path.resolve(HERE, '../standard-evm-sequence');
const ORDER = ['supply-without-approval', 'approve-then-supply', 'approve-supply-repeat'];
const RESPONSE_DELAY_MS = 50;
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFile(path.join(PACKET, file));
const args = process.argv.slice(2);
assert.ok(args.length === 3 && ['--check', '--serve'].includes(args[0]) && args[1] === '--manifest-sha256' && /^[0-9a-f]{64}$/.test(args[2]), 'Use --check or --serve --manifest-sha256 <sealed hash>.');
const manifestBytes = await read('manifest.json'), manifest = JSON.parse(manifestBytes);
assert.equal(sha(manifestBytes), args[2], 'The root-approved sealed manifest must match.');
const manifestFiles = new Map(manifest.files.map(entry => [entry.path, entry]));
assert.equal(manifestFiles.size, manifest.files.length);
async function boundRead(file) {
  const entry = manifestFiles.get(file); assert.ok(entry, 'Unbound packet file: ' + file);
  const bytes = await read(file); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); return bytes;
}
const planBytes = await boundRead('plan.json'), plan = JSON.parse(planBytes);
const frozen = JSON.parse(await boundRead('FROZEN.json'));
assert.equal(manifest.planSha256, sha(planBytes)); assert.equal(frozen.planSha256, sha(planBytes));
assert.deepEqual(plan.cases.map(item => item.id), ORDER);
assert.equal(plan.provider, 'https://eth.drpc.org');
assert.equal(manifest.implementationSha256, plan.implementation.sourceSha256);
assert.deepEqual(plan.implementation.sourceFiles, [...plan.implementation.sourceFiles].sort());
const implementationHash = createHash('sha256');
for (const source of plan.sources) {
  const bytes = await boundRead('source/' + source.path);
  assert.equal(bytes.length, source.bytes); assert.equal(sha(bytes), source.sha256);
}
for (const file of plan.implementation.sourceFiles) implementationHash.update(file + '\0').update(await boundRead('source/' + file)).update('\0');
assert.equal(implementationHash.digest('hex'), plan.implementation.sourceSha256);
const cases = [];
for (const [caseIndex, item] of plan.cases.entries()) {
  assert.equal(item.route, caseIndex === 0 ? '/api/evm/simulate' : '/api/evm/simulate-sequence');
  assert.equal(item.profile, caseIndex === 0 ? 'single' : 'sequence');
  assert.equal(item.requestText, JSON.stringify(item.input));
  assert.equal(item.requestSha256, sha(item.requestText)); assert.equal(item.requestBytes, Buffer.byteLength(item.requestText));
  for (const call of item.input.calls ?? [item.input]) assert.equal(Object.hasOwn(call, 'queries'), false, 'Captured requests must use automatic query selection.');
  const bytes = await boundRead(item.id + '-response.json'), saved = JSON.parse(bytes);
  const http = JSON.parse(await boundRead('http/' + String(caseIndex + 1).padStart(3, '0') + '.json'));
  assert.deepEqual(saved.apiRequest, item.input); assert.deepEqual(saved.implementation, plan.implementation);
  assert.equal(http.request.bodyText, item.requestText); assert.equal(http.response.status, 200); assert.equal(http.response.complete, true);
  assert.deepEqual(JSON.parse(http.response.bodyText), saved);
  assert.equal(http.response.sha256, sha(http.response.bodyText)); assert.equal(http.response.bytes, Buffer.byteLength(http.response.bodyText));
  for (const [index, record] of saved.transportEvidence.entries()) {
    assert.equal(record.id, index + 1); assert.equal(record.request.id, index + 1); assert.equal(record.request.jsonrpc, '2.0');
    assert.equal(record.requestText, JSON.stringify(record.request));
    assert.equal(record.requestBytes, Buffer.byteLength(record.requestText)); assert.equal(record.requestSha256, sha(record.requestText));
    assert.equal(record.error, undefined, 'Withheld provider failures cannot be invented as replay bytes.');
    assert.equal(record.transport.complete, true); assert.equal(record.transport.bodyRetained, true);
    assert.equal(record.transport.observedBytes, Buffer.byteLength(record.responseText));
    assert.equal(record.transport.retainedPrefixBytes, Buffer.byteLength(record.responseText));
    for (const key of ['responseSha256', 'observedPrefixSha256', 'retainedPrefixSha256']) assert.equal(record.transport[key], sha(record.responseText));
    const response = JSON.parse(record.responseText);
    assert.equal(response.id, index + 1); assert.equal(response.jsonrpc, '2.0'); assert.ok(Object.hasOwn(response, 'result')); assert.equal(Object.hasOwn(response, 'error'), false);
  }
  cases.push({ ...item, saved, sourceResponseSha256: sha(bytes) });
}
const ready = { status: 'ready', mode: 'offline_browser_replay', url: 'http://127.0.0.1:5176/',
  manifestSha256: sha(manifestBytes), planSha256: sha(planBytes), implementation: plan.implementation,
  plannedBrowserOrder: ORDER, publicNetworkRequests: 0, responseDelayMs: RESPONSE_DELAY_MS,
  recordedRpcResponses: cases.reduce((sum, item) => sum + item.saved.transportEvidence.length, 0) };
if (args[0] === '--check') { console.log(JSON.stringify(ready, null, 2)); process.exit(0); }

const failures = [], attempts = [], completed = [], attemptedCases = new Set();
function blocked() { failures.push({ code: 'OUTBOUND_NETWORK_BLOCKED' }); throw new Error('This browser replay does not permit outgoing connections.'); }
globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
const { createAppServer } = await import(pathToFileURL(path.join(PACKET, 'source/src/server.js')));
const { StandardRpcClient } = await import(pathToFileURL(path.join(PACKET, 'source/src/standard-rpc.js')));
const binding = { schemaVersion: '1.0', ...ready, sourceFiles: plan.sources,
  replayScriptSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  sourceResponses: cases.map(item => ({ id: item.id, sha256: item.sourceResponseSha256 })),
  limitations: ['Supplemental browser rendering check, not a new live blockchain simulation.',
    'Only exact recorded RPC requests have responses; unexpected inputs and outgoing connections fail.',
    'A fixed local response delay permits loading-state inspection; response bytes and execution evidence are unchanged.',
    'HTTP input objects must match exactly; JSON property order may differ and actual browser bytes are retained.',
    'No product or original packet files are changed.'] };
await fs.writeFile(path.join(HERE, 'binding.json'), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
let active = null;
const server = createAppServer({ persist: false, rpcFactory: blocked,
  standardRpcFactory(options) {
    assert.ok(active && !active.rpc, 'One saved RPC client per matched case.');
    const context = active; assert.deepEqual(options, { profile: context.item.profile });
    context.rpc = new StandardRpcClient({ url: plan.provider, profile: context.item.profile, fetchImpl: async (url, options) => {
      const index = context.cursor++, recorded = context.item.saved.transportEvidence[index];
      const request = { index, bodyText: options.body, sha256: sha(options.body), matched: false };
      context.rpcAttempts.push(request);
      try {
        assert.ok(recorded, 'Extra RPC call rejected.'); assert.equal(url.href, plan.provider + '/');
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
        assert.deepEqual(options.headers, { 'content-type': 'application/json' });
        assert.equal(options.body, recorded.requestText, 'Exact recorded RPC wire order is required.');
        assert.deepEqual(JSON.parse(options.body), recorded.request);
        request.matched = true; request.recordedId = recorded.id; request.responseSha256 = sha(recorded.responseText);
        context.consumed.push(recorded.id);
        await delay(RESPONSE_DELAY_MS);
        return new Response(recorded.responseText, { status: recorded.httpStatus });
      } catch (error) { failures.push({ caseId: context.item.id, index, error: error.message }); throw error; }
    } });
    return context.rpc;
  },
});
const originalHandler = server.listeners('request')[0]; server.removeAllListeners('request');
const semantic = value => {
  const copy = structuredClone(value); delete copy.id; delete copy.createdAt; delete copy.timing;
  for (const step of copy.steps ?? []) if (step.result) { delete step.result.id; delete step.result.createdAt; delete step.result.timing; }
  for (const row of copy.transportEvidence) delete row.transport.durationMs;
  return copy;
};
async function checkpoint() { await fs.writeFile(path.join(HERE, 'playback-results.json'), JSON.stringify({ mode: 'offline_browser_replay', publicNetworkRequests: 0, plannedBrowserOrder: ORDER, attempts, completed, failures }, null, 2) + '\n'); }
await checkpoint();
server.on('request', async (req, res) => {
  if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css', '/api/config', '/api/health', '/api/benchmarks', '/favicon.ico'].includes(req.url)) return originalHandler.call(server, req, res);
  const attempt = { index: attempts.length + 1, startedAt: new Date().toISOString(), method: req.method, path: req.url, contentType: req.headers['content-type'] ?? null };
  attempts.push(attempt); let context;
  try {
    assert.equal(req.method, 'POST'); assert.equal(active, null, 'Only one replay at a time.');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 384 * 1024, 'Browser body limit exceeded.'); chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString('utf8');
    Object.assign(attempt, { requestText: body, requestBytes: bytes, requestSha256: sha(body) });
    const input = JSON.parse(body), item = cases[completed.length];
    assert.ok(item, 'All planned cases already completed.'); assert.equal(req.url, item.route); assert.deepEqual(input, item.input, 'Browser input must match the next planned case exactly.');
    assert.ok(!attemptedCases.has(item.id), 'Each planned case may execute only once.'); attemptedCases.add(item.id);
    attempt.caseId = item.id;
    context = { item, cursor: 0, consumed: [], rpcAttempts: [], rpc: null }; active = context;
    const responseChunks = [], write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) responseChunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) responseChunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    const replayReq = Readable.from([Buffer.from(body)]); Object.assign(replayReq, { method: req.method, url: req.url, headers: req.headers });
    await originalHandler.call(server, replayReq, res);
    const responseBody = Buffer.concat(responseChunks).toString('utf8'), report = JSON.parse(responseBody);
    Object.assign(attempt, { httpStatus: res.statusCode, responseSha256: sha(responseBody), responseBytes: Buffer.byteLength(responseBody), consumedRpcIds: context.consumed, rpcAttempts: context.rpcAttempts });
    await fs.writeFile(path.join(HERE, item.id + '-response.json'), responseBody, { flag: 'wx' });
    assert.equal(res.statusCode, 200); assert.equal(context.cursor, item.saved.transportEvidence.length);
    assert.deepEqual(context.consumed, item.saved.transportEvidence.map(record => record.id));
    assert.deepEqual(semantic(report), semantic(item.saved));
    attempt.semanticResult = 'matched'; attempt.completedAt = new Date().toISOString();
    completed.push({ id: item.id, startedAt: attempt.startedAt, completedAt: attempt.completedAt, input,
      requestSha256: sha(body), sourceResponseSha256: item.sourceResponseSha256, replayResponseSha256: sha(responseBody),
      consumedRpcIds: context.consumed, semanticResult: 'matched', httpStatus: res.statusCode });
    active = null; await checkpoint();
  } catch (error) {
    Object.assign(attempt, { completedAt: new Date().toISOString(), error: error.message, ...(context ? { rpcAttempts: context.rpcAttempts, consumedRpcIds: context.consumed } : {}) });
    failures.push({ attempt: attempt.index, message: error.message });
    if (active === context) active = null;
    await checkpoint();
    if (!res.headersSent) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Offline replay rejected this request. No provider was contacted.' } })); }
  }
});
server.listen(5176, '127.0.0.1', () => console.log(JSON.stringify(ready)));
