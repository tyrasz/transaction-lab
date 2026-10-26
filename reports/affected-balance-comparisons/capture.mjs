// Predeclared development capture only. No signing, broadcast, retries or fallback.
// --check is offline. --capture requires the approved plan's exact SHA-256.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createAppServer } from '../../src/server.js';
import { RpcClient, RpcError, assertNoProviderErrorResult } from '../../src/rpc.js';

const directory = new URL('./', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const planBytes = await readFile(new URL('plan.json', directory));
const plan = JSON.parse(planBytes), planSha256 = sha(planBytes);
const hash = createHash('sha256');
for (const file of plan.sourceFiles) {
  assert.match(file, /^[a-z-]+\.js$/);
  hash.update(file + '\0').update(await readFile(new URL('../../src/' + file, directory))).update('\0');
}
assert.equal(hash.digest('hex'), plan.sourceSha256, 'Frozen implementation changed; do not capture a replacement silently');
assert.equal(plan.cases.reduce((count, item) => count + item.providers.length, 0), plan.budgets.plannedHttpRequests);
assert.equal(plan.budgets.retries, 0);
assert.deepEqual(Object.values(plan.providers), ['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive']);
for (const item of plan.cases) {
  assert.match(item.transactionHash, /^0x[0-9a-f]{64}$/);
  for (const provider of item.providers) assert.ok(Object.hasOwn(plan.providers, provider));
}
if (process.argv[2] === '--check') {
  console.log(JSON.stringify({ planSha256, implementationSha256: plan.sourceSha256, planned: plan.budgets.plannedHttpRequests, expectedRpc: plan.expectedRpcCallsIfPriorOutcomesPersist, limits: plan.budgets, networkCalls: 0 }));
  process.exit(0);
}
assert.equal(process.argv[2], '--capture', 'Use --check or --capture APPROVED_PLAN_SHA256');
assert.equal(process.argv[3], planSha256, 'Capture requires approval of the exact current plan hash');

const recording = {
  schemaVersion: '1.0', startedAt: new Date().toISOString(), status: 'running',
  planSha256, scriptSha256: sha(await readFile(new URL('capture.mjs', directory))),
  implementation: { version: plan.version, sourceSha256: plan.sourceSha256, sourceFiles: plan.sourceFiles },
  budgets: plan.budgets, executionTransport: { kind: 'ephemeral_local_http', route: 'POST /api/replay' },
  cases: [], summary: { planned: plan.budgets.plannedHttpRequests, attempted: 0, http200: 0, failedHttp: 0, measuredBalances: 0, measuredAllowances: 0, measuredAffectedBalances: 0, unavailableAffectedBalances: 0, rpcCalls: 0, responseBytes: 0 },
  limitations: ['Previously inspected development transactions; not blind holdouts or a security/accuracy score.', 'Every unavailable or provider-failed result is retained without retries or replacement.', 'Two RPC services may share client/validation failure modes; no consensus proof or independent execution engine is claimed.', 'Successful JSON-RPC response text is retained exactly. Rejected provider envelopes are replaced with fixed diagnostics to avoid retaining credential-bearing error text.'],
};
const output = new URL('capture.json', directory);
await writeFile(output, JSON.stringify(recording, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFile(output, JSON.stringify(recording, null, 2) + '\n');
const started = Date.now();
let activeRpc;
const server = createAppServer({ persist: false, rpcFactory: () => {
  assert.ok(activeRpc, 'No request may use an unbound provider'); return activeRpc;
} });

async function boundedBytes(response, abortController) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength; recording.summary.responseBytes += chunk.byteLength;
    if (size > plan.budgets.maxResponseBytes || recording.summary.responseBytes > plan.budgets.maxTotalResponseBytes) {
      abortController.abort(); throw new RpcError('Capture response budget exceeded.', 'RPC_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function trackedRpc(run, runAbort) {
  const entries = new Map(), rawTransports = new Map(), inFlight = new Set();
  const client = new RpcClient({
    url: plan.providers[run.provider], timeoutMs: plan.budgets.rpcTimeoutMs,
    fetchImpl: async (url, options) => {
      const wire = JSON.parse(options.body), entry = entries.get(wire.id);
      assert.ok(entry, 'RPC transport must belong to the current recorded call');
      assert.deepEqual(wire, entry.request);
      const response = await fetch(url, { ...options, signal: AbortSignal.any([options.signal, runAbort.signal]) });
      entry.httpStatus = response.status; entry.responseHeaders = Object.fromEntries(response.headers);
      const bytes = await boundedBytes(response, runAbort);
      rawTransports.set(wire.id, { text: bytes.toString('utf8'), sha256: sha(bytes) });
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  });
  return {
    provider: client.provider,
    get rpcMs() { return client.rpcMs; },
    async verifyChain() { assert.equal(await this.call('eth_chainId', []), '0x3e7'); },
    async call(method, params = []) {
      if (runAbort.signal.aborted || Date.now() - started > plan.budgets.maxRunSequenceMs || recording.summary.rpcCalls >= plan.budgets.maxRpcCalls || run.rpcCalls.length >= plan.budgets.maxRpcCallsPerRun) throw new RpcError('The fixed capture RPC budget was exhausted.', 'CAPTURE_BUDGET_EXHAUSTED');
      const id = client.nextId;
      const entry = { requestedAt: new Date().toISOString(), request: { jsonrpc: '2.0', id, method, params: structuredClone(params) } };
      entries.set(id, entry); run.rpcCalls.push(entry); recording.summary.rpcCalls++;
      const promise = (async () => {
        try {
          const result = await client.call(method, params);
          assertNoProviderErrorResult(method, result);
          const transport = rawTransports.get(id);
          assert.ok(transport, 'A successful result requires captured transport bytes');
          const response = JSON.parse(transport.text);
          assert.deepEqual(response.result, result);
          entry.response = response; entry.responseText = transport.text; entry.responseSha256 = transport.sha256;
          return result;
        } catch (error) {
          entry.error = error instanceof RpcError ? { code: error.code, message: error.message, ...(Number.isSafeInteger(error.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) } : { code: 'CAPTURE_VALIDATION_ERROR', message: 'Captured RPC evidence failed local validation.' };
          entry.responseBodyWithheld = true;
          throw error instanceof RpcError ? error : new RpcError(entry.error.message, entry.error.code);
        } finally { rawTransports.delete(id); entry.completedAt = new Date().toISOString(); }
      })();
      inFlight.add(promise);
      try { return await promise; } finally { inFlight.delete(promise); }
    },
    async settle() { while (inFlight.size) await Promise.allSettled([...inFlight]); },
  };
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/api/replay`;
  for (const specification of plan.cases) {
    const item = { id: specification.id, operation: specification.operation ?? null, transactionHash: specification.transactionHash, runs: [] };
    recording.cases.push(item);
    for (const provider of specification.providers) {
      if (Date.now() - started > plan.budgets.maxRunSequenceMs || recording.summary.responseBytes >= plan.budgets.maxTotalResponseBytes || recording.summary.rpcCalls >= plan.budgets.maxRpcCalls) throw new RpcError('The fixed capture sequence budget was exhausted.', 'CAPTURE_BUDGET_EXHAUSTED');
      const request = { chainId: 999, transactionHash: specification.transactionHash };
      const run = { provider, request, startedAt: new Date().toISOString(), rpcCalls: [], http: { request: { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: request, bodyText: JSON.stringify(request) } } };
      item.runs.push(run); recording.summary.attempted++;
      const abort = new AbortController();
      const remainingSequenceMs = Math.max(1, plan.budgets.maxRunSequenceMs - (Date.now() - started));
      const timeout = setTimeout(() => abort.abort(), Math.min(plan.budgets.maxRunMs, remainingSequenceMs));
      activeRpc = trackedRpc(run, abort);
      try {
        const response = await fetch(url, { method: 'POST', headers: run.http.request.headers, body: run.http.request.bodyText, signal: abort.signal });
        const raw = await boundedBytes(response, abort), body = JSON.parse(raw.toString('utf8'));
        run.http.response = { status: response.status, headers: Object.fromEntries(response.headers), body, bodyText: raw.toString('utf8'), bodySha256: sha(raw) };
        if (response.status === 200) {
          run.response = body; recording.summary.http200++;
          assert.equal(body.implementation.sourceSha256, plan.sourceSha256); assert.equal(body.implementation.version, plan.version);
          assert.deepEqual(body.implementation.sourceFiles, plan.sourceFiles);
          for (const [field, counter] of [['balanceChanges', 'measuredBalances'], ['allowanceChanges', 'measuredAllowances'], ['affectedBalanceChanges', 'measuredAffectedBalances']]) if (body[field]?.status === 'measured') recording.summary[counter]++;
          if (body.affectedBalanceChanges?.status === 'unavailable') recording.summary.unavailableAffectedBalances++;
        } else {
          recording.summary.failedHttp++;
          run.error = { code: body.error?.code ?? 'HTTP_ERROR', message: body.error?.message ?? 'The local API returned an error.' };
        }
      } catch (error) {
        abort.abort();
        run.error = { code: error instanceof RpcError ? error.code : error.name === 'AbortError' ? 'CAPTURE_TIMEOUT' : 'CAPTURE_VALIDATION_ERROR', message: 'This planned HTTP attempt did not complete validly. No retry was made.' };
        if (!run.http.response) recording.summary.failedHttp++;
      } finally {
        clearTimeout(timeout); await activeRpc.settle(); run.completedAt = new Date().toISOString();
        await save();
      }
      console.log(JSON.stringify({ case: item.id, provider, httpStatus: run.http.response?.status ?? null, rpcCalls: run.rpcCalls.length, balances: run.response?.balanceChanges.status, allowances: run.response?.allowanceChanges.status, affected: run.response?.affectedBalanceChanges?.status, additionalPairs: run.response?.affectedBalanceChanges?.assets.length, reusedPairs: run.response?.affectedBalanceChanges?.reusedPairs.length, error: run.error ?? null }));
    }
  }
  recording.status = recording.summary.attempted === plan.budgets.plannedHttpRequests ? 'complete' : 'incomplete';
} catch (error) {
  recording.status = 'stopped_without_retry';
  recording.error = { code: error instanceof RpcError ? error.code : 'CAPTURE_ERROR', message: 'The capture stopped under its fixed scope or validation limits.' };
} finally {
  recording.completedAt = new Date().toISOString(); await save();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
await writeFile(new URL('manifest.json', directory), JSON.stringify({ schemaVersion: '1.0', createdAt: recording.completedAt, planSha256, implementation: recording.implementation, files: await Promise.all(['plan.json', 'capture.mjs', 'capture.json'].map(async file => ({ file, sha256: sha(await readFile(new URL(file, directory))) }))), summary: recording.summary, status: recording.status }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: recording.status, captureSha256: sha(await readFile(output)), summary: recording.summary }));
