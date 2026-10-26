// Fixed current-query development capture. --check/--bind are offline; --capture
// requires the exact plan and source binding hashes after root's freeze signal.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DIR = new URL('./', import.meta.url), ROOT = new URL('../../', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const planBytes = await readFile(new URL('plan.json', DIR)), plan = JSON.parse(planBytes), planSha256 = sha(planBytes);
const scriptSha256 = sha(await readFile(new URL('capture.mjs', DIR)));
assert.equal(scriptSha256, plan.scriptSha256);
assert.equal(plan.cases.reduce((n, c) => n + c.providers.length, 0), 8);
assert.equal(plan.budgets.plannedHttpRequests, 8); assert.equal(plan.budgets.retries, 0);
assert.equal(plan.expectedRpcCallsIfPriorOutcomesPersist, null);
assert.deepEqual(plan.providers, { drpc: 'https://hyperliquid.drpc.org', 'hyperlend-archive': 'https://rpc.hyperlend.finance/archive' });
for (const item of plan.cases) {
  assert.equal(item.request.chainId, 999); assert.match(item.request.block, /^0x[0-9a-f]+$/);
  assert.match(item.expectedBlockHash, /^0x[0-9a-f]{64}$/);
  for (const field of ['from', 'to']) assert.match(item.request[field], /^0x[0-9a-f]{40}$/);
  assert.match(item.request.data, /^0x(?:[0-9a-f]{2})*$/); assert.equal(BigInt(item.request.value), 0n);
  assert.deepEqual(Object.keys(item.request).sort(), ['block','chainId','data','from','to','value']);
  for (const provider of item.providers) assert.ok(Object.hasOwn(plan.providers, provider));
}
for (const source of plan.sources) assert.equal(sha(await readFile(new URL(source.path, ROOT))), source.sha256);

async function fingerprint() {
  const source = await readFile(new URL('src/server.js', ROOT), 'utf8');
  const match = source.match(/const engineFiles = (\[[^;]+\]);/); assert.ok(match, 'Product source inventory is required.');
  const sourceFiles = JSON.parse(match[1].replaceAll("'", '"'));
  assert.ok(['query-validation.js', 'historical-state.js', 'state-diff.js', 'current-state.js'].every(file => sourceFiles.includes(file)));
  const digest = createHash('sha256'), files = [];
  for (const file of sourceFiles) {
    assert.match(file, /^[a-z-]+\.js$/);
    const bytes = await readFile(new URL('src/' + file, ROOT));
    digest.update(file + '\0').update(bytes).update('\0'); files.push({ file, sha256: sha(bytes), bytes: bytes.length });
  }
  return { sourceFiles, sourceSha256: digest.digest('hex'), files };
}
const mode = process.argv[2];
if (mode === '--check') {
  console.log(json({ status: 'validated_no_network', planSha256, scriptSha256, plannedHttpRequests: 8, conditionalRpc: null, limits: plan.budgets, coreFreezeRequired: true })); process.exit(0);
}
if (mode === '--bind') {
  const actual = await fingerprint(); assert.equal(actual.sourceSha256, process.argv[3]); assert.match(process.argv[4] ?? '', /^\d+\.\d+\.\d+$/);
  const binding = { schemaVersion: '1.0', boundAt: new Date().toISOString(), version: process.argv[4], ...actual, planSha256, scriptSha256, authorization: 'Root supplied this exact source fingerprint and version after freezing the implementation; no RPC performed by binding.' };
  await writeFile(new URL('frozen-core.json', DIR), json(binding), { flag: 'wx' });
  console.log(json({ status: 'bound_no_network', planSha256, coreBindingSha256: sha(json(binding)), implementation: actual.sourceSha256 })); process.exit(0);
}
assert.equal(mode, '--capture', 'Use --check, --bind ROOT_SOURCE_SHA VERSION, or --capture PLAN_SHA CORE_BINDING_SHA.');
assert.equal(process.argv[3], planSha256);
const bindingBytes = await readFile(new URL('frozen-core.json', DIR)), binding = JSON.parse(bindingBytes), coreBindingSha256 = sha(bindingBytes);
assert.equal(process.argv[4], coreBindingSha256); assert.equal(binding.planSha256, planSha256); assert.equal(binding.scriptSha256, scriptSha256);
async function confirmFrozen() { const actual = await fingerprint(); assert.deepEqual(actual, { sourceFiles: binding.sourceFiles, sourceSha256: binding.sourceSha256, files: binding.files }); }
await confirmFrozen();
// Import only after validating the explicitly authorized frozen implementation.
const { createAppServer } = await import('../../src/server.js');
const { RpcClient, RpcError, assertNoProviderErrorResult } = await import('../../src/rpc.js');

const recording = {
  schemaVersion: '1.0', status: 'running', startedAt: new Date().toISOString(), planSha256, scriptSha256, coreBindingSha256,
  implementation: { version: binding.version, sourceSha256: binding.sourceSha256, sourceFiles: binding.sourceFiles }, budgets: plan.budgets,
  executionTransport: { kind: 'ephemeral_local_http', route: 'POST /api/simulate' }, cases: [], skipped: [],
  summary: { planned: 8, attempted: 0, http200: 0, failedHttp: 0, rpcCalls: 0, rpcResponseBytes: 0, httpResponseBytes: 0, responseBytes: 0 },
  limitations: ['Preselected development regression cases, not a prospective or blinded cohort.', 'No retries, fallbacks, transaction replacements, signatures or broadcasts.', 'Two endpoints do not establish independent execution engines or cryptographic state proof.', 'Successful JSON-RPC response bodies are retained exactly; rejected provider envelopes retain only hashes, byte counts and fixed local diagnostics.', 'These are unsigned current simulations at fixed selected block-end states, not original-position historical replays or signed transaction validation. Parent-state direct/router output quantities are deliberately not predeclared.'],
};
const output = new URL('capture.json', DIR);
await writeFile(output, json(recording), { flag: 'wx' });
const save = () => writeFile(output, json(recording));
const began = performance.now(); let stopReason = null, activeRpc;
const server = createAppServer({ persist: false, rpcFactory: () => { assert.ok(activeRpc); return activeRpc; } });
const fail = code => Object.assign(new Error(code), { code });
const transportCodes = new Set(['CAPTURE_TIMEOUT', 'CAPTURE_WALL_LIMIT', 'CAPTURE_BYTE_LIMIT', 'CAPTURE_TOTAL_BYTE_LIMIT', 'CAPTURE_RPC_LIMIT', 'CAPTURE_REDIRECT_OR_CONNECTION', 'CAPTURE_INVALID_RESPONSE']);
const safeHeaders = headers => Object.fromEntries(['content-type', 'date', 'server', 'cache-control', 'x-content-type-options'].flatMap(k => headers.has(k) ? [[k, headers.get(k)]] : []));
function globalReason() {
  if (stopReason) return stopReason;
  if (performance.now() - began >= plan.budgets.maxRunSequenceMs) return stopReason = 'CAPTURE_WALL_LIMIT';
  if (recording.summary.responseBytes >= plan.budgets.maxTotalResponseBytes) return stopReason = 'CAPTURE_TOTAL_BYTE_LIMIT';
  if (recording.summary.rpcCalls >= plan.budgets.maxRpcCalls) return stopReason = 'CAPTURE_RPC_LIMIT';
  return null;
}
// The transport owns its deadline until EOF and seals before returning. A late
// read/fetch completion cannot change a retained entry after the race resolves.
async function transport(url, options, entry, kind, outerSignal, timeoutMs) {
  const controller = new AbortController(), start = performance.now(), hash = createHash('sha256'), chunks = [];
  let reader, closed = false, timer, complete = false, digest;
  const finishHash = () => digest ??= hash.digest('hex');
  const cancel = bodyReader => { try { void bodyReader?.cancel().catch(() => {}); } catch {} };
  const deadline = () => { if (performance.now() - began >= plan.budgets.maxRunSequenceMs) { stopReason = 'CAPTURE_WALL_LIMIT'; throw fail(stopReason); } if (performance.now() - start >= timeoutMs || outerSignal.aborted) throw fail('CAPTURE_TIMEOUT'); };
  entry.responseBytes = 0;
  async function execute() {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([controller.signal, outerSignal]) });
    if (closed) { cancel(response.body?.getReader()); throw fail('CAPTURE_TIMEOUT'); }
    deadline(); entry.httpStatus = response.status; entry.responseHeaders = safeHeaders(response.headers);
    if (!response.body?.getReader) throw fail('CAPTURE_INVALID_RESPONSE'); reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (closed) { cancel(reader); throw fail('CAPTURE_TIMEOUT'); }
      if (done) { deadline(); break; }
      const chunk = Buffer.from(value); hash.update(chunk); entry.responseBytes += chunk.length; recording.summary.responseBytes += chunk.length;
      recording.summary[kind === 'rpc' ? 'rpcResponseBytes' : 'httpResponseBytes'] += chunk.length;
      deadline();
      if (recording.summary.responseBytes > plan.budgets.maxTotalResponseBytes) { stopReason = 'CAPTURE_TOTAL_BYTE_LIMIT'; throw fail(stopReason); }
      if (entry.responseBytes > plan.budgets.maxResponseBytes) throw fail('CAPTURE_BYTE_LIMIT');
      chunks.push(chunk);
    }
    complete = true; const bytes = Buffer.concat(chunks);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); deadline();
    return { text, bytes, status: response.status, headers: response.headers };
  }
  try {
    return await Promise.race([execute(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(performance.now() - began >= plan.budgets.maxRunSequenceMs ? 'CAPTURE_WALL_LIMIT' : 'CAPTURE_TIMEOUT')); }, Math.max(1, Math.min(timeoutMs, plan.budgets.maxRunSequenceMs - (performance.now() - began)))); })]);
  } catch (error) { throw fail(transportCodes.has(error?.code) ? error.code : 'CAPTURE_REDIRECT_OR_CONNECTION'); }
  finally { closed = true; clearTimeout(timer); if (!complete) { controller.abort(); cancel(reader); } entry.bodyComplete = complete; entry.responseSha256 = finishHash(); entry.transportElapsedMs = Math.round(performance.now() - start); }
}

function trackedRpc(run, abort) {
  const entries = new Map(), raw = new Map(), inFlight = new Set();
  const client = new RpcClient({ url: plan.providers[run.provider], timeoutMs: plan.budgets.rpcTimeoutMs, fetchImpl: async (url, options) => {
    assert.equal(String(url), plan.providers[run.provider] + (plan.providers[run.provider].endsWith('.org') ? '/' : ''));
    const wire = JSON.parse(options.body), entry = entries.get(wire.id); assert.ok(entry); assert.deepEqual(wire, entry.request); entry.requestText = options.body;
    const retained = await transport(url, options, entry, 'rpc', abort.signal, plan.budgets.rpcTimeoutMs);
    raw.set(wire.id, retained);
    return new Response(retained.bytes, { status: retained.status, headers: retained.headers });
  } });
  return {
    provider: client.provider,
    get rpcMs() { return client.rpcMs; },
    async verifyChain() { const chain = await this.call('eth_chainId', []); if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 999n) throw new RpcError('The configured RPC is not HyperEVM chain 999.', 'RPC_CHAIN_MISMATCH'); },
    async call(method, params = []) {
      const reason = globalReason();
      if (abort.signal.aborted || reason || run.rpcCalls.length >= plan.budgets.maxRpcCallsPerRun) throw new RpcError('The fixed capture request budget is exhausted.', reason ?? 'CAPTURE_RPC_LIMIT');
      const id = client.nextId, entry = { requestedAt: new Date().toISOString(), request: { jsonrpc: '2.0', id, method, params: structuredClone(params) } };
      entries.set(id, entry); run.rpcCalls.push(entry); recording.summary.rpcCalls++;
      const operation = (async () => {
        try {
          const result = await client.call(method, params), retained = raw.get(id); assert.ok(retained);
          const payload = JSON.parse(retained.text);
          assert.equal(Object.hasOwn(payload, 'error'), false); assertNoProviderErrorResult(method, result); assert.deepEqual(payload.result, result);
          entry.response = payload; entry.responseText = retained.text;
          return structuredClone(result);
        } catch (error) {
          entry.error = { code: error instanceof RpcError ? error.code : transportCodes.has(error?.code) ? error.code : 'CAPTURE_VALIDATION_ERROR', message: 'The planned read-only RPC did not complete validly; arbitrary provider exception text is withheld.', ...(Number.isSafeInteger(error.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
          entry.responseBodyWithheld = true;
          throw new RpcError(entry.error.message, entry.error.code, entry.error.rpcCode === undefined ? null : { rpcCode: entry.error.rpcCode });
        } finally { raw.delete(id); entry.completedAt = new Date().toISOString(); }
      })();
      inFlight.add(operation); try { return await operation; } finally { inFlight.delete(operation); }
    },
    async settle() { while (inFlight.size) await Promise.allSettled([...inFlight]); },
  };
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/api/simulate`;
  for (const specification of plan.cases) {
    const item = { id: specification.id, operation: specification.operation ?? null, request: specification.request, expectedBlockHash: specification.expectedBlockHash, historicalSourceTransactionHash: specification.historicalSourceTransactionHash ?? null, runs: [] }; recording.cases.push(item);
    for (const provider of specification.providers) {
      if (globalReason()) { recording.skipped.push({ caseId: item.id, provider, reason: stopReason }); continue; }
      await confirmFrozen();
      const request = structuredClone(specification.request);
      const run = { provider, request, startedAt: new Date().toISOString(), rpcCalls: [], http: { request: { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: request, bodyText: JSON.stringify(request) } } };
      item.runs.push(run); recording.summary.attempted++;
      const abort = new AbortController(); activeRpc = trackedRpc(run, abort);
      const httpEntry = {};
      try {
        const returned = await transport(url, { method: 'POST', headers: run.http.request.headers, body: run.http.request.bodyText }, httpEntry, 'http', abort.signal, plan.budgets.maxHttpRunMs);
        const body = JSON.parse(returned.text);
        run.http.response = { status: returned.status, headers: httpEntry.responseHeaders, body, bodyText: returned.text, bodySha256: httpEntry.responseSha256, responseBytes: httpEntry.responseBytes };
        if (returned.status === 200) {
          run.response = structuredClone(body); recording.summary.http200++;
          assert.equal(body.implementation.sourceSha256, binding.sourceSha256); assert.equal(body.implementation.version, binding.version); assert.deepEqual(body.implementation.sourceFiles, binding.sourceFiles);
          assert.equal(body.source.mode, 'simulation'); assert.equal(body.source.blockHash, specification.expectedBlockHash);
          assert.equal(BigInt(body.source.blockNumber), BigInt(request.block));
        } else { recording.summary.failedHttp++; run.error = { code: 'LOCAL_API_ERROR', message: 'The planned local API request returned a non-success status; no retry was made.' }; }
      } catch (error) {
        abort.abort(); run.error = { code: transportCodes.has(error?.code) ? error.code : 'CAPTURE_VALIDATION_ERROR', message: 'This planned HTTP attempt did not complete validly. No retry was made.' };
        if (!run.http.response) { recording.summary.failedHttp++; run.http.failure = httpEntry; }
      } finally { await activeRpc.settle(); run.completedAt = new Date().toISOString(); await confirmFrozen(); await save(); }
      console.log(json({ caseId: item.id, provider, status: run.http.response?.status ?? null, rpcCalls: run.rpcCalls.length, balances: run.response?.balanceChanges?.status, allowances: run.response?.allowanceChanges?.status, affected: run.response?.affectedBalanceChanges?.status, error: run.error ?? null }));
    }
  }
  recording.status = recording.skipped.length ? 'stopped_without_retry' : 'complete';
} catch {
  recording.status = 'stopped_without_retry'; recording.error = { code: 'CAPTURE_VALIDATION_OR_SCOPE_STOP', message: 'The capture stopped under its fixed scope or provenance checks; no retry was made.' };
} finally {
  await activeRpc?.settle();
  for (const specification of plan.cases) for (const provider of specification.providers) {
    const attempted = recording.cases.some(item => item.id === specification.id && item.runs.some(run => run.provider === provider));
    if (!attempted && !recording.skipped.some(item => item.caseId === specification.id && item.provider === provider)) recording.skipped.push({ caseId: specification.id, provider, reason: stopReason ?? 'CAPTURE_VALIDATION_OR_SCOPE_STOP' });
  }
  recording.completedAt = new Date().toISOString(); recording.elapsedMs = Math.round(performance.now() - began); await save();
  if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
await writeFile(new URL('manifest.json', DIR), json({ schemaVersion: '1.0', status: recording.status, planSha256, coreBindingSha256, implementation: recording.implementation, summary: recording.summary, files: await Promise.all(['plan.json', 'capture.mjs', 'frozen-core.json', 'capture.json'].map(async file => ({ file, sha256: sha(await readFile(new URL(file, DIR))) }))) }), { flag: 'wx' });
console.log(json({ status: recording.status, captureSha256: sha(await readFile(output)), summary: recording.summary }));
