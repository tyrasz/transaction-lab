import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { captureHttp, proofTransport, sha } from './wire.mjs';
import { deriveCases } from './freeze.mjs';
import { createRpcStateInputs } from '../../engines/local-evm/rpc-state-inputs.js';

const response = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const call = (fetchImpl, extra = {}) => captureHttp({ url: 'https://example.invalid', body: { x: 1 }, deadline: performance.now() + 1000,
  requestMs: 100, responseBytes: 1024, shared: { bytes: 0, maxBytes: 2048 }, fetchImpl, ...extra });
const header = { hash: '0x' + '11'.repeat(32), stateRoot: '0x' + '22'.repeat(32) };
const address = '0x' + '33'.repeat(20), selector = { blockHash: header.hash, requireCanonical: true };
const params = [address, selector];
const makeTransport = (extra = {}) => proofTransport({ provider: { url: 'https://example.invalid' }, header,
  shared: { bytes: 0, maxBytes: 1000000 }, scope: { bytes: 0, maxBytes: 1000000 }, deadline: performance.now() + 5000,
  save: async () => {}, ...extra });
const echo = async (_url, init) => {
  const request = JSON.parse(init.body); return response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x' }));
};

test('success preserves exact UTF8/body/hash/request and prohibits redirects', async () => {
  const raw = '{"a":"é","result":false}\n'; let options;
  const r = await call(async (_url, init) => { options = init; return response(raw); });
  assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
  assert.equal(r.status, 'completed'); assert.equal(r.responseText, raw); assert.equal(r.transport.complete, true);
  assert.equal(r.transport.observedBytes, Buffer.byteLength(raw)); assert.equal(r.transport.retainedBytes, Buffer.byteLength(raw));
  assert.equal(r.transport.observedSha256, sha(raw)); assert.equal(r.transport.retainedSha256, sha(raw));
  assert.equal(Buffer.from(r.rawBase64, 'base64').toString(), raw); assert.equal(r.requestSha256, sha(options.body));
  assert.ok(r.transport.durationMs >= 0);
});
test('invalid UTF8 and BOM are failed without changing retained bytes or hashes', async () => {
  for (const raw of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"x":1}')])]) {
    const r = await call(async () => response(raw)); assert.equal(r.status, 'failed');
    assert.equal(r.transport.observedSha256, sha(raw)); assert.equal(r.transport.observedBytes, raw.length);
    assert.deepEqual(Buffer.from(r.rawBase64, 'base64'), raw);
  }
});
test('HTTP failure bodies and malformed JSON remain exact public raw evidence', async () => {
  for (const [raw, status] of [['{"error":"public archive unavailable"}', 503], ['not-json', 200]]) {
    const r = await call(async () => response(raw, status)); assert.equal(r.status, 'failed');
    assert.equal(r.httpStatus, status); assert.equal(r.transport.complete, true); assert.equal(r.transport.observedSha256, sha(raw));
    assert.equal(Buffer.from(r.rawBase64, 'base64').toString(), raw);
  }
});
test('per-body, per-case and shared budgets are independent and stop further fetch', async () => {
  for (const kind of ['body', 'case', 'shared']) {
    const shared = { bytes: 0, maxBytes: kind === 'shared' ? 4 : 100 }, scope = { bytes: 0, maxBytes: kind === 'case' ? 4 : 100 };
    const r = await call(async () => response('123456'), { responseBytes: kind === 'body' ? 4 : 100, shared, scope });
    assert.equal(r.error, 'response_byte_budget'); assert.equal(r.transport.complete, false);
    assert.equal(r.transport.observedBytes, 6); assert.equal(r.transport.retainedBytes, 4);
    assert.equal(shared.bytes, 6); assert.equal(scope.bytes, 6); assert.equal(r.transport.observedSha256, sha('123456'));
    assert.equal(r.transport.retainedSha256, sha('1234'));
    if (kind !== 'body') {
      let fetched = false;
      const next = await call(async () => { fetched = true; return response('{}'); }, { shared, scope });
      assert.equal(next.error, 'byte_budget'); assert.equal(fetched, false);
    }
  }
});
test('case budget cannot consume another case remaining shared budget', async () => {
  const shared = { bytes: 0, maxBytes: 20 }, first = { bytes: 0, maxBytes: 5 }, second = { bytes: 0, maxBytes: 5 };
  assert.equal((await call(async () => response('123456'), { shared, scope: first })).error, 'response_byte_budget');
  const r = await call(async () => response('{}'), { shared, scope: second });
  assert.equal(r.status, 'completed'); assert.equal(first.bytes, 6); assert.equal(second.bytes, 2); assert.equal(shared.bytes, 8);
});
test('ignored AbortSignal late fetch cannot mutate a returned record or counters', async () => {
  let resolve, canceled = false; const shared = { bytes: 0, maxBytes: 100 };
  const r = await call(() => new Promise(done => resolve = done), { requestMs: 5, shared });
  const before = JSON.stringify({ r, shared });
  resolve({ body: { cancel() { canceled = true; return new Promise(() => {}); } } });
  await new Promise(done => setTimeout(done, 10)); assert.equal(r.error, 'deadline'); assert.equal(canceled, true);
  assert.equal(JSON.stringify({ r, shared }), before);
});
test('body timeout, late read and hanging cancel settle once without mutation', async () => {
  let readDone, canceled = false;
  const r = await call(async () => ({ status: 200, ok: true, headers: new Map(), body: { getReader() { return {
    read() { return new Promise(done => readDone = done); }, cancel() { canceled = true; return new Promise(() => {}); },
  }; } } }), { requestMs: 5 });
  const before = JSON.stringify(r); readDone({ done: false, value: Buffer.from('{"late":1}') });
  await new Promise(done => setTimeout(done, 10)); assert.equal(canceled, true); assert.equal(r.error, 'deadline'); assert.equal(JSON.stringify(r), before);
});
test('exactly256 proof/code dispatches are allowed;257th cannot fetch or save', async () => {
  let fetched = 0, saved = 0;
  const rpc = makeTransport({ fetchImpl: async (...args) => { fetched++; return echo(...args); }, save: async () => saved++ });
  for (let i = 0; i < 256; i++) assert.equal(await rpc.call('eth_getCode', params), '0x');
  await assert.rejects(rpc.call('eth_getCode', params), { code: 'attempt_budget' }); await rpc.drain();
  assert.equal(fetched, 256); assert.equal(saved, 256); assert.equal(rpc.records.length, 256);
  assert.deepEqual(rpc.records.map(r => r.id), Array.from({ length: 256 }, (_, i) => i + 1));
  assert.equal(rpc.usage().dispatches, 256); assert.deepEqual(rpc.denied, [{ method: 'eth_getCode', code: 'attempt_budget' }]);
});
test('allowlist/hash binding guards before dispatch and rejects concurrent calls', async () => {
  let resolve, fetched = 0; const rpc = makeTransport({ fetchImpl: () => { fetched++; return new Promise(done => resolve = done); } });
  await assert.rejects(rpc.call('debug_traceCall', []), { code: 'method_not_allowed' });
  await assert.rejects(rpc.call('eth_getCode', [address, 'latest']), { code: 'state_binding' });
  assert.equal(fetched, 0); const active = rpc.call('eth_getCode', params);
  await assert.rejects(rpc.call('eth_getCode', params), { code: 'concurrent_dispatch' });
  resolve(response('{"jsonrpc":"2.0","id":1,"result":"0x"}')); await active; await rpc.drain(); assert.equal(fetched, 1);
});
test('JSONRPC id/result/error shape fails closed while raw error remains retained', async () => {
  for (const payload of [null, [], { jsonrpc: '2.0', id: 2, result: '0x' }, { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, result: '0x', error: null }, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'historical state unavailable' } }]) {
    const raw = JSON.stringify(payload), rpc = makeTransport({ fetchImpl: async () => response(raw) });
    await assert.rejects(rpc.call('eth_getCode', params)); await rpc.drain();
    assert.equal(rpc.records[0].status, 'failed'); assert.equal(rpc.records[0].transport.observedSha256, sha(raw));
    assert.equal(Buffer.from(rpc.records[0].rawBase64, 'base64').toString(), raw);
  }
});
test('returned parsed result cannot mutate retained wire result', async () => {
  const rpc = makeTransport({ fetchImpl: async () => response('{"jsonrpc":"2.0","id":1,"result":{"x":1}}') });
  const result = await rpc.call('eth_getCode', params); result.x = 2; assert.equal(rpc.records[0].parsed.result.x, 1);
});
test('collector deadline drains terminal save before snapshot and later phases', async () => {
  let finishSave, lateFetch; const shared = { bytes: 0, maxBytes: 1024 }, scope = { bytes: 0, maxBytes: 1024 };
  const rpc = makeTransport({ shared, scope, fetchImpl: () => new Promise(done => lateFetch = done), save: () => new Promise(done => finishSave = done) });
  const inputs = createRpcStateInputs({ chainId: 1, blockHash: header.hash, header, rpc, limits: { requestMs: 5 } });
  await assert.rejects(inputs.getAccount(address)); let drained = false;
  const draining = rpc.drain().then(() => drained = true); await new Promise(done => setTimeout(done, 5));
  assert.equal(drained, false); assert.equal(rpc.records.length, 1); assert.equal(rpc.records[0].error, 'deadline');
  finishSave(); await draining;
  const before = JSON.stringify({ records: rpc.records, shared, scope, inputs: inputs.snapshotInputs() });
  lateFetch(response('{"late":true}')); await new Promise(done => setTimeout(done, 10));
  assert.equal(JSON.stringify({ records: rpc.records, shared, scope, inputs: inputs.snapshotInputs() }), before);
});
test('failed wire persistence latches and cannot be reported as successfully drained', async () => {
  const rpc = makeTransport({ fetchImpl: echo, save: async () => { throw Error('disk failure'); } });
  await assert.rejects(rpc.call('eth_getCode', params), { code: 'wire_save_failed' });
  await assert.rejects(rpc.drain(), { code: 'wire_save_failed' }); assert.equal(rpc.records.length, 1);
});
test('fixed source inputs preserve exact case order and API envelope without old outputs as inputs', async () => {
  const read = async p => JSON.parse(await readFile(new URL(p, import.meta.url)));
  const old = await read('../standard-evm-deposits-v2/plan.json');
  const headers = await Promise.all(['025', '026'].map(n => read(`../standard-evm-discovery/raw/${n}.json`)));
  const cases = deriveCases(old, headers);
  for (const [i, name] of ['aave', 'morpho'].entries()) {
    assert.deepEqual(cases[i].request, old.cases[i].request);
    assert.deepEqual(cases[i].apiInput, (await read(`../standard-evm-auto/${name}-response.json`)).apiRequest);
    assert.equal(Object.hasOwn(cases[i].apiInput, 'queries'), false);
  }
  assert.throws(() => deriveCases({ ...old, cases: [...old.cases].reverse() }, headers), /selection/);
  const badHeader = structuredClone(headers); badHeader[0].response.result.hash = header.hash;
  assert.throws(() => deriveCases(old, badHeader), /binding/);
  const badRequest = structuredClone(old); badRequest.cases[0].request.value = '0x1';
  assert.throws(() => deriveCases(badRequest, headers), /envelope/);
});
