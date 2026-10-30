import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createAppServer } from '../src/server.js';
import { StandardRpcClient } from '../src/standard-rpc.js';
import { loadStandardApi } from '../src/standard-loader.js';
import { EXAMPLES, VERSION } from '../src/config.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../', import.meta.url);
const captureBytes = await readFile(new URL('reports/standard-evm-deposits-v2/capture.json', root));
assert.equal(sha(captureBytes), '149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e');
const capture = JSON.parse(captureBytes);
const api = await loadStandardApi();
assert.ok(api, 'The production optional dependency is installed for these integration tests.');
const input = index => structuredClone(api.STANDARD_EXAMPLES[index].input);
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local test did not reach its expected stage.')), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function start(t, options = {}) {
  const server = createAppServer({ persist: false, ...options });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, route, value, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });

async function expectedImplementation() {
  const files = [
    'package.json', 'src/config.js', 'src/server.js', 'src/validate.js', 'src/standard-loader.js', 'src/standard-rpc.js', 'src/standard-simulation.js',
    'src/local-loader.js', 'src/local-simulation.js', 'src/proof-rpc.js',
    'engines/evm-context.js',
    'engines/local-evm/delegation-runtime-patch.js',
    'src/rpc.js', 'src/state.js', 'src/state-diff.js', 'src/query-validation.js',
    'src/account-effects.js', 'src/affected-balances.js', 'src/allowances.js', 'src/analyze.js', 'src/arbitrum-loader.js', 'src/balances.js', 'src/current-state.js',
    'src/historical-state.js', 'src/lending-balances.js', 'src/lending.js', 'src/permissions.js', 'src/revert.js',
    'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json', 'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/position-queries.js', 'engines/standard-evm/provider-state-diff.js', 'engines/standard-evm/discovery.js', 'engines/standard-evm/native-effects.js', 'engines/standard-evm/sequence-state.js',
    ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => 'engines/standard-evm/node_modules/@noble/hashes/' + name),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(await readFile(new URL(file, root))).update('\0');
  return { name: 'Transaction Lab Ethereum preview', version: VERSION, sourceSha256: hash.digest('hex'), sourceFiles: files };
}

test('configuration exposes experimental Ethereum separately and binds its complete current implementation closure', async t => {
  let factories = 0;
  const base = await start(t, { standardRpcFactory() { factories++; throw new Error('No RPC is needed.'); }, rpcFactory() { factories++; throw new Error('No RPC is needed.'); } });
  const response = await fetch(base + '/api/config'); assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.standardEvm.available, true);
  assert.deepEqual(config.standardEvm.examples, api.STANDARD_EXAMPLES);
  assert.deepEqual(config.standardEvm.capabilities, api.STANDARD_CAPABILITIES);
  assert.deepEqual(config.standardEvm.sequenceCapabilities, api.STANDARD_SEQUENCE_CAPABILITIES);
  assert.deepEqual(config.standardEvm.sequenceExamples, api.STANDARD_SEQUENCE_EXAMPLES);
  assert.deepEqual(config.examples, EXAMPLES);
  assert.deepEqual(config.chains, [{ chainId: 999, name: 'HyperEVM' }, { chainId: 1, name: 'Ethereum', experimental: true }, { chainId: 11155111, name: 'Sepolia', experimental: true, localOnly: true }, { chainId: 42161, name: 'Arbitrum', experimental: true }]);
  assert.deepEqual(api.implementation, await expectedImplementation());
  assert.equal(await loadStandardApi(), api, 'The loaded implementation identity is stable for this process.');
  assert.ok(api.implementation.sourceFiles.includes('src/standard-rpc.js'));
  assert.equal(api.implementation.sourceFiles.length, 40);
  assert.ok(api.implementation.sourceFiles.includes('src/analyze.js'), 'Transitive server imports belong to the standard API identity.');
  assert.ok(api.implementation.sourceFiles.includes('src/historical-state.js'));
  assert.ok(api.implementation.sourceFiles.includes('engines/standard-evm/unsigned-call.js'));
  assert.ok(api.implementation.sourceFiles.includes('engines/standard-evm/node_modules/@noble/hashes/sha3.js'));
  assert.equal(factories, 0);
});

test('HTTP validation, origin and host protections reject inputs before creating either provider', async t => {
  let factories = 0;
  const base = await start(t, { standardRpcFactory() { factories++; throw new Error('No provider should be constructed.'); }, rpcFactory() { factories++; throw new Error('No provider should be constructed.'); } });
  for (const change of [{ chainId: 999 }, { value: '0x0' }, { value: (1n << 256n).toString() }, { rpcUrl: 'https://user-supplied.invalid/private' }, { stateOverrides: {} }, { queries: [] }, { queries: Array(9).fill(input(0).queries[0]) }, { block: 'pending' }, { data: '0x0' }]) {
    const response = await post(base, '/api/evm/simulate', { ...input(0), ...change });
    assert.equal(response.status, 400); assert.ok((await response.json()).error.code);
  }
  const malformed = await fetch(base + '/api/evm/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  const contentType = await post(base, '/api/evm/simulate', input(0), { 'content-type': 'text/plain' });
  assert.equal(contentType.status, 400);
  const crossOrigin = await post(base, '/api/evm/simulate', input(0), { origin: 'https://external.invalid' });
  assert.equal(crossOrigin.status, 403); assert.equal((await crossOrigin.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/evm/simulate', base), { method: 'POST', headers: { host: 'external.invalid', 'content-type': 'application/json' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject); request.end(JSON.stringify(input(0)));
  });
  assert.equal(badHost.status, 403); assert.equal(badHost.body.error.code, 'INVALID_HOST');
  for (const route of ['/api/simulate', '/api/replay']) {
    const legacyInput = route === '/api/replay' ? { chainId: 1, transactionHash: EXAMPLES[0].transactionHash } : { ...EXAMPLES[0].request, chainId: 1 };
    const response = await post(base, route, legacyInput);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'UNSUPPORTED_CHAIN');
    assert.equal(response.headers.get('location'), null, 'The established API does not redirect chain 1 into a different engine.');
  }
  assert.equal((await post(base, '/api/send', input(0))).status, 404);
  assert.equal(factories, 0);
});

test('missing optional dependency returns 503 while health and the established HyperEVM route keep working', async t => {
  let standardFactories = 0, legacyFactories = 0;
  const request = EXAMPLES[0].request;
  const base = await start(t, { standardLoader: async () => null,
    standardRpcFactory() { standardFactories++; throw new Error('The missing engine must not construct a provider.'); },
    rpcFactory() { legacyFactories++; return { provider: 'synthetic-local-control', rpcMs: 0, async verifyChain() {}, async call(method) {
      if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: '0x' + 'a'.repeat(64), timestamp: '0x2' };
      if (method === 'debug_traceCall') return { type: 'CALL', from: request.from, to: request.to, input: request.data, value: '0x0', gasUsed: '0x5208', error: 'execution reverted', output: '0x', logs: [] };
      throw new Error('Unexpected legacy request.');
    } }; },
  });
  const config = await (await fetch(base + '/api/config')).json();
  assert.deepEqual(config.standardEvm.examples, []); assert.equal(config.standardEvm.available, false); assert.equal(config.standardEvm.capabilities, null);
  assert.match(config.standardEvm.reason, /Install/);
  const unavailable = await post(base, '/api/evm/simulate', input(0));
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'STANDARD_EVM_UNAVAILABLE');
  const health = await fetch(base + '/api/health'); assert.equal(health.status, 200); assert.equal((await health.json()).readOnly, true);
  const legacy = await post(base, '/api/simulate', request); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).execution.status, 'reverted');
  assert.equal(standardFactories, 0); assert.equal(legacyFactories, 1);
});

test('the two-simulation limit is rechecked after asynchronous loading and shared with the legacy route', async t => {
  const loaded = defer(), allEntered = defer(), bothRunning = defer(), finish = defer();
  let loads = 0, factories = 0, running = 0, legacyFactories = 0;
  const complete = async () => {
    if (++running === 2) bothRunning.resolve(); await finish.promise;
    return { syntheticConcurrencyControl: true };
  };
  const syntheticApi = { ...api, simulateStandard: complete, simulateStandardSequence: complete };
  t.after(() => { loaded.resolve(); finish.resolve(); });
  const base = await start(t, { standardLoader: async () => { if (++loads === 3) allEntered.resolve(); await loaded.promise; return syntheticApi; },
    standardRpcFactory() { factories++; return {}; }, rpcFactory() { legacyFactories++; throw new Error('Busy requests must not create a provider.'); } });
  const sequenceInput = structuredClone(api.STANDARD_SEQUENCE_EXAMPLES[0].input);
  const requests = [post(base, '/api/evm/simulate', input(0)), post(base, '/api/evm/simulate-sequence', sequenceInput), post(base, '/api/evm/simulate-sequence', sequenceInput)];
  await bounded(allEntered.promise); assert.equal(factories, 0); loaded.resolve();
  await bounded(bothRunning.promise);
  const first = await bounded(Promise.race(requests)); assert.equal(first.status, 429); assert.equal((await first.clone().json()).error.code, 'BUSY');
  assert.equal(factories, 2); assert.equal(loads, 3);
  const legacy = await post(base, '/api/simulate', EXAMPLES[0].request); assert.equal(legacy.status, 429); assert.equal((await legacy.json()).error.code, 'BUSY');
  assert.equal(legacyFactories, 0);
  finish.resolve();
  assert.deepEqual((await Promise.all(requests)).map(response => response.status).sort(), [200, 200, 429]);
  const after = await post(base, '/api/evm/simulate', input(0)); assert.equal(after.status, 200); assert.equal(factories, 3, 'The shared slot is released after completion.');
});

// Aave uses original wire request/response bytes. The capture numbered Morpho
// 31..76, whereas every production client starts at 1. For Morpho only, replace
// the top-level JSON-RPC id token (31..76 -> 1..46) in request and response
// envelopes. All remaining bytes, including the complete result, stay exact.
function playback(run, idAdapted) {
  let cursor = 0;
  const mismatches = [], mapping = [], wire = [];
  const rpc = new StandardRpcClient({ url: 'https://eth.drpc.org', fetchImpl: async (url, options) => {
    const recorded = run.rpcCalls[cursor++];
    try {
      assert.ok(recorded, 'No unrecorded request is allowed.');
      const requested = JSON.parse(options.body), original = recorded.request.body;
      assert.equal(url.href, 'https://eth.drpc.org/'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.equal(requested.id, cursor);
      assert.deepEqual(requested, { ...original, id: idAdapted ? cursor : original.id });
      const oldRequestPrefix = `{"jsonrpc":"2.0","id":${original.id},`, newRequestPrefix = `{"jsonrpc":"2.0","id":${cursor},`;
      const oldResponsePrefix = `{"id":${original.id},`, newResponsePrefix = `{"id":${cursor},`;
      assert.ok(recorded.request.bodyText.startsWith(oldRequestPrefix));
      assert.ok(recorded.responseText.startsWith(oldResponsePrefix));
      assert.equal(sha(recorded.responseText), recorded.transport.responseSha256);
      const requestText = idAdapted ? newRequestPrefix + recorded.request.bodyText.slice(oldRequestPrefix.length) : recorded.request.bodyText;
      const responseText = idAdapted ? newResponsePrefix + recorded.responseText.slice(oldResponsePrefix.length) : recorded.responseText;
      assert.equal(options.body, requestText);
      assert.equal(responseText.slice(newResponsePrefix.length), recorded.responseText.slice(oldResponsePrefix.length));
      assert.deepEqual(JSON.parse(responseText).result, recorded.response.result);
      mapping.push({ recordedId: original.id, playbackId: cursor, mode: idAdapted ? 'JSONRPC-envelope-ID-adapted-playback' : 'exact-original-wire-playback' });
      wire.push({ requestText, responseText });
      return new Response(responseText, { status: recorded.http.status });
    } catch (error) { mismatches.push({ index: cursor, message: error.message }); throw error; }
  } });
  return { rpc, wire, mapping, finish() {
    assert.deepEqual(mismatches, [], 'Engine-caught transport assertions cannot hide replay mismatches.');
    assert.equal(cursor, run.rpcCalls.length); assert.equal(new Set(mapping.map(x => x.recordedId)).size, cursor);
  } };
}

for (const [index, run] of capture.cases.entries()) test(`full HTTP production transport: ${run.id} (${index ? 'ID-adapted Morpho' : 'exact original Aave'} playback)`, async t => {
  const reportDir = await mkdtemp(path.join(os.tmpdir(), 'transaction-lab-standard-http-'));
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  const recorded = playback(run, index === 1); let factories = 0;
  const base = await start(t, { persist: true, reportDir, standardRpcFactory() { factories++; return recorded.rpc; }, rpcFactory() { throw new Error('Ethereum must not use the legacy provider.'); } });
  const response = await post(base, '/api/evm/simulate', input(index));
  assert.equal(response.status, 200);
  const report = await response.json(); recorded.finish(); assert.equal(factories, 1);
  const { id, createdAt, apiRequest, source, preview, timing, implementation, transportEvidence, nativeEffects, ...engine } = report;
  assert.deepEqual(nativeEffects, { status: 'none', feeScope: 'excluded', maxAccounts: 8,
    candidates: [], netValueByAccount: {}, selectedAccounts: [], counts: { candidates: 0, selected: 0, omitted: 0, measured: 0 }, measurements: [] });
  assert.deepEqual(preview.nativeBalances, []);
  assert.deepEqual(engine, run.result, 'Every engine field, raw trace, diff, evidence row, measurement and codeHash check is preserved.');
  assert.deepEqual(apiRequest, api.validateStandardSimulation(input(index)));
  assert.equal(source.profile, 'unsigned_unpriced_block_end'); assert.equal(source.blockSelection.resolvedHash, run.blockHash);
  assert.deepEqual(implementation, await expectedImplementation());
  assert.match(id, /^[0-9a-f-]{36}$/); assert.ok(Number.isFinite(Date.parse(createdAt)));
  assert.ok(timing.totalMs >= 0 && timing.rpcMs >= 0);
  assert.equal(preview.queries.length, index ? 8 : 4); assert.ok(preview.queries.every(q => q.status === 'measured'));
  assert.ok(preview.queries.every(q => q.metadata.verifiedForSimulation === false));
  assert.equal(report.security.status, 'not_assessed');
  assert.equal(transportEvidence.length, run.rpcCalls.length);
  for (const [i, row] of transportEvidence.entries()) {
    const expected = recorded.wire[i];
    assert.equal(row.id, i + 1); assert.equal(row.requestText, expected.requestText);
    assert.equal(row.requestSha256, sha(expected.requestText));
    assert.equal(row.responseText, expected.responseText); assert.equal(row.error, undefined);
    assert.equal(row.transport.complete, true); assert.equal(row.transport.bodyRetained, true);
    assert.equal(row.transport.observedBytes, Buffer.byteLength(expected.responseText));
    assert.equal(row.transport.retainedPrefixBytes, Buffer.byteLength(expected.responseText));
    assert.equal(row.transport.responseSha256, sha(expected.responseText));
  }
  assert.deepEqual(recorded.mapping.map(row => row.recordedId), run.rpcCalls.map(row => row.sequence));
  assert.deepEqual(recorded.mapping.map(row => row.playbackId), Array.from({ length: run.rpcCalls.length }, (_, i) => i + 1));
  assert.deepEqual(JSON.parse(await readFile(path.join(reportDir, 'simulations', id + '.json'), 'utf8')), report, 'Saved JSON retains the full API response including transport evidence.');
});

test('provider failure remains an explicit unavailable HTTP result with hashed, withheld error bytes', async t => {
  const secret = 'TEST_PRIVATE_PROVIDER_CREDENTIAL'; let calls = 0;
  const rpc = new StandardRpcClient({ fetchImpl: async (_url, options) => {
    calls++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, error: { code: -32000, message: secret, data: { url: secret } } }));
  } });
  const base = await start(t, { standardRpcFactory: () => rpc });
  const response = await post(base, '/api/evm/simulate', input(0)); assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(calls, 1); assert.equal(report.execution.status, 'unavailable'); assert.equal(report.canonicalStatus, 'unverified');
  assert.ok(report.preview.queries.every(q => q.status === 'unavailable' && q.beforeRaw === undefined && q.afterRaw === undefined && q.deltaRaw === undefined));
  assert.equal(report.transportEvidence.length, 1); assert.equal(report.transportEvidence[0].responseText, undefined);
  assert.equal(report.transportEvidence[0].error.code, 'RPC_EXECUTION_ERROR');
  assert.equal(report.transportEvidence[0].transport.complete, true); assert.match(report.transportEvidence[0].transport.responseSha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('HTTP accepts canonical positive wei and preserves its exact engine value without displaying unmeasured native balances', async t => {
  let calls = 0;
  const rpc = new StandardRpcClient({ fetchImpl: async (_url, options) => {
    calls++; const request = JSON.parse(options.body);
    assert.equal(request.method, 'eth_chainId'); assert.deepEqual(request.params, []);
    // Intentional wrong-chain control stops execution without any public call.
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x2' }));
  } });
  const base = await start(t, { standardRpcFactory: () => rpc });
  const request = { ...input(0), value: '1' }; delete request.queries;
  const response = await post(base, '/api/evm/simulate', request); assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(calls, 1); assert.deepEqual(report.apiRequest, request);
  assert.equal(report.request.transaction.value, '0x1'); assert.equal(report.execution.status, 'unavailable');
  assert.equal(report.nativeEffects.status, 'unavailable'); assert.equal(report.nativeEffects.feeScope, 'excluded');
  assert.deepEqual(report.preview.nativeBalances, []); assert.deepEqual(report.preview.queries, []);
});
