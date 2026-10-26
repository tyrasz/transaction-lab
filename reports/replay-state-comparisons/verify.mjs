// Offline transport and guard-evidence verification; never contacts a provider.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = new URL('./', import.meta.url), root = new URL('../../', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async file => JSON.parse(await readFile(new URL(file, dir)));
const plan = await load('plan.json'), binding = await load('frozen-core.json'), capture = await load('capture.json'), manifest = await load('manifest.json');
for (const item of manifest.files) assert.equal(sha(await readFile(new URL(item.file, dir))), item.sha256, item.file);
assert.equal(capture.planSha256, sha(await readFile(new URL('plan.json', dir))));
assert.equal(capture.coreBindingSha256, sha(await readFile(new URL('frozen-core.json', dir))));
assert.equal(capture.scriptSha256, plan.scriptSha256);
assert.equal(capture.implementation.sourceSha256, binding.sourceSha256);
for (const item of plan.sources) assert.equal(sha(await readFile(new URL(item.path, root))), item.sha256);
const expected = plan.cases.flatMap(c => c.providers.map(provider => ({ id: c.id, provider, hash: c.transactionHash })));
const seen = new Set(), totals = { attempted: 0, http200: 0, failedHttp: 0, rpcCalls: 0, rpcResponseBytes: 0, httpResponseBytes: 0 };
const outcomes = [];
for (const item of capture.cases) for (const run of item.runs) {
  const key = item.id + ':' + run.provider; assert.equal(seen.has(key), false); seen.add(key);
  assert.ok(expected.some(e => e.id === item.id && e.provider === run.provider && e.hash === item.transactionHash));
  assert.deepEqual(run.request, { chainId: 999, transactionHash: item.transactionHash });
  assert.deepEqual(JSON.parse(run.http.request.bodyText), run.request); assert.deepEqual(run.http.request.body, run.request);
  assert.equal(run.http.request.method, 'POST'); assert.match(run.http.request.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/replay$/);
  totals.attempted++;
  for (const [i, entry] of run.rpcCalls.entries()) {
    totals.rpcCalls++; totals.rpcResponseBytes += entry.responseBytes ?? 0;
    assert.equal(entry.request.id, i + 1); assert.equal(entry.request.jsonrpc, '2.0');
    if (entry.requestText) assert.deepEqual(JSON.parse(entry.requestText), entry.request);
    if (entry.response) {
      assert.equal(entry.error, undefined); assert.equal(entry.httpStatus, 200); assert.equal(entry.bodyComplete, true);
      assert.deepEqual(JSON.parse(entry.responseText), entry.response); assert.equal(sha(entry.responseText), entry.responseSha256);
      assert.equal(Buffer.byteLength(entry.responseText), entry.responseBytes); assert.equal(entry.response.id, entry.request.id);
      assert.equal(entry.response.jsonrpc, '2.0'); assert.equal(Object.hasOwn(entry.response, 'error'), false);
      assert.ok(entry.responseBytes <= plan.budgets.maxResponseBytes);
    } else { assert.ok(entry.error); assert.equal(entry.responseBodyWithheld, true); }
  }
  assert.ok(run.rpcCalls.length <= plan.budgets.maxRpcCallsPerRun);
  const response = run.http.response;
  if (response) {
    totals.httpResponseBytes += response.responseBytes;
    assert.deepEqual(JSON.parse(response.bodyText), response.body); assert.equal(sha(response.bodyText), response.bodySha256);
    assert.equal(Buffer.byteLength(response.bodyText), response.responseBytes); assert.ok(response.responseBytes <= plan.budgets.maxResponseBytes);
    if (response.status === 200) {
      totals.http200++; assert.deepEqual(run.response, response.body);
      assert.equal(run.response.implementation.sourceSha256, binding.sourceSha256); assert.equal(run.response.implementation.version, binding.version);
      assert.deepEqual(run.response.implementation.sourceFiles, binding.sourceFiles);
    } else totals.failedHttp++;
  } else { totals.failedHttp++; totals.httpResponseBytes += run.http.failure?.responseBytes ?? 0; assert.ok(run.error); }
  const body = run.response;
  const measured = ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges'].filter(field => body?.[field]?.status === 'measured');
  let guard = 'not_admitted';
  if (measured.length) {
    for (const field of measured) assert.equal(body[field].executionIdentity.validation.originalReplayState, 'complete_pre_post_diff_match');
    const original = run.rpcCalls.filter(e => e.request.method === 'debug_traceTransaction' && e.request.params[0] === item.transactionHash && e.request.params[1]?.tracer === 'prestateTracer' && e.request.params[1]?.tracerConfig?.diffMode === true);
    assert.equal(original.length, 1); assert.ok(original[0].response);
    const replay = run.rpcCalls.filter(e => e.request.method === 'debug_traceCallMany' && e.request.params[2]?.tracer === 'prestateTracer' && e.request.params[0]?.[0]?.transactions?.[0]?.data === body.request.data);
    assert.equal(replay.length, 1); assert.ok(replay[0].response);
    const result = replay[0].response.result; assert.ok(Array.isArray(result) && result.length === 1 && Array.isArray(result[0]) && result[0].length === 1);
    // This packet asserts the stronger observed exact parsed-object equality.
    // A future formatting-only difference needs its own stated validation.
    assert.deepEqual(result[0][0], original[0].response.result);
    assert.ok(run.rpcCalls.indexOf(replay[0]) > run.rpcCalls.indexOf(original[0]));
    guard = 'raw_original_and_replay_pre_post_equal';
  }
  outcomes.push({ caseId: item.id, provider: run.provider, httpStatus: response?.status ?? null, rpcCalls: run.rpcCalls.length, measured, guard, error: run.error?.code ?? null });
}
for (const skip of capture.skipped) { const key = skip.caseId + ':' + skip.provider; assert.equal(seen.has(key), false); seen.add(key); assert.ok(expected.some(e => e.id === skip.caseId && e.provider === skip.provider)); }
assert.equal(seen.size, 14);
for (const [key, value] of Object.entries(totals)) assert.equal(capture.summary[key], value, key);
assert.equal(capture.summary.responseBytes, totals.rpcResponseBytes + totals.httpResponseBytes);
assert.ok(totals.rpcCalls <= plan.budgets.maxRpcCalls);
if (capture.status === 'complete') { assert.equal(capture.skipped.length, 0); assert.equal(totals.attempted, 14); assert.ok(capture.summary.responseBytes <= plan.budgets.maxTotalResponseBytes); assert.ok(capture.elapsedMs <= plan.budgets.maxRunSequenceMs); }
console.log(JSON.stringify({ status: 'verified_offline', captureSha256: sha(await readFile(new URL('capture.json', dir))), totals, skipped: capture.skipped, outcomes, networkCalls: 0 }, null, 2));
