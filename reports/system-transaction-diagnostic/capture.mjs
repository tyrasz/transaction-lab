// Separate diagnostic; never imports, edits, resumes, or retries the failed pilot.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const directory = new URL('./', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const pilot = '../coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/rpc.json';
const pilotSha = 'e4155c2816bdf27761869f7fc7eea8cf84ce59475c89a801a1ee5a7e144379a9';
const blockNumber = '0x2f3fbe6';
const blockHash = '0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4';
const endpoints = { official: 'https://rpc.hyperliquid.xyz/evm', A: 'https://hyperliquid.drpc.org', B: 'https://rpc.hyperlend.finance/archive' };
const limits = { requests: 12, responseBytes: 8 * 1024 * 1024, totalResponseBytes: 32 * 1024 * 1024, requestMs: 25000, retries: 0 };
const pilotBytes = await readFile(new URL(pilot, directory));
assert.equal(sha(pilotBytes), pilotSha);
const prior = JSON.parse(pilotBytes).records;
const a = prior.find(record => record.id === 6), b = prior.find(record => record.id === 7);
for (const entry of [a, b]) {
  assert.equal(entry.request.method, 'eth_getBlockByNumber');
  assert.deepEqual(entry.request.params, [blockNumber, false]);
  assert.equal(entry.response.result.hash, blockHash);
}
const extras = b.response.result.transactions.filter(hash => !a.response.result.transactions.includes(hash));
assert.equal(extras.length, 3);
assert.deepEqual(b.response.result.transactions.slice(3), a.response.result.transactions);
const calls = [
  { endpoint: 'official', method: 'eth_chainId', params: [] },
  { endpoint: 'official', method: 'eth_getBlockByNumber', params: [blockNumber, false] },
  { endpoint: 'official', method: 'eth_getSystemTxsByBlockNumber', params: [blockNumber] },
  { endpoint: 'A', method: 'eth_chainId', params: [] },
  { endpoint: 'B', method: 'eth_chainId', params: [] },
  ...extras.flatMap(hash => ['A', 'B'].map(endpoint => ({ endpoint, method: 'eth_getTransactionByHash', params: [hash] }))),
  { endpoint: 'official', method: 'eth_getTransactionByHash', params: [extras[0]] },
];
assert.equal(calls.length, limits.requests);
const scriptSha256 = sha(await readFile(new URL('capture.mjs', directory)));
const command = process.argv[2];
if (command === '--plan') {
  await writeFile(new URL('plan.json', directory), json({ schemaVersion: '1.0', createdAt: new Date().toISOString(), hypothesis: 'The three additional B hashes are representations of HyperCore system transactions. This remains unproven before this diagnostic.', pilot: { path: pilot, sha256: pilotSha, recordIds: [6, 7], status: 'selection_failed_unchanged' }, blockNumber, blockHash, additionalHashes: extras, endpoints, limits, calls, scriptSha256, rules: ['Exactly the twelve fixed requests in order, without retry, substitution, fallback or new discovery.', 'This is separate from the failed pilot; no denominator, metric or pilot status is changed.', 'Equal block hashes do not establish identical transaction lists or original-position semantics.', 'Successful JSON-RPC bytes are retained and hashed. Error text is omitted; observed bytes are counted and hashed.', 'A cap-crossing stream chunk is counted but not retained as usable evidence; no further calls after the total-byte cap.', 'System-action attribution requires matching explicit fields or a separately evidenced encoding; zero gas price or list position alone is insufficient.'] }), { flag: 'wx' });
  console.log('Wrote preregistered diagnostic plan; no network calls.');
  process.exit(0);
}
const planBytes = await readFile(new URL('plan.json', directory));
const plan = JSON.parse(planBytes);
assert.equal(plan.scriptSha256, scriptSha256);
assert.deepEqual(plan.calls, calls); assert.deepEqual(plan.endpoints, endpoints); assert.deepEqual(plan.limits, limits);
if (command === '--validate') {
  console.log(json({ status: 'valid_no_network', calls: calls.length, scriptSha256, planSha256: sha(planBytes), pilotSha256: pilotSha }));
  process.exit(0);
}
if (command !== '--run') throw new Error('Expected --plan, --validate, or --run.');
const capture = { schemaVersion: '1.0', status: 'running', startedAt: new Date().toISOString(), planSha256: sha(planBytes), scriptSha256, pilotSha256: pilotSha, calls: [], totalResponseBytes: 0, requestsAttempted: 0, stoppedByTotalByteCap: false };
// Exclusive creation prevents this program from silently repeating the run.
await writeFile(new URL('capture.json', directory), json(capture), { flag: 'wx' });
const allowedCodes = new Set(['HTTP_ERROR', 'INVALID_JSON_RPC', 'RPC_ERROR', 'REQUEST_TIMEOUT', 'RESPONSE_BYTE_LIMIT', 'TOTAL_BYTE_LIMIT']);
for (const [index, call] of calls.entries()) {
  if (capture.stoppedByTotalByteCap) break;
  const request = { jsonrpc: '2.0', id: index + 1, method: call.method, params: call.params };
  const record = { endpoint: call.endpoint, url: endpoints[call.endpoint], startedAt: new Date().toISOString(), request, responseBytes: 0 };
  capture.requestsAttempted++; capture.calls.push(record);
  const start = performance.now(), controller = new AbortController(), hash = createHash('sha256'), chunks = [];
  let reader, timer, closed = false, digest, complete = false;
  const finishHash = () => digest ??= hash.digest('hex');
  const fail = code => Object.assign(new Error(code), { code });
  const deadline = () => { if (performance.now() - start >= limits.requestMs) throw fail('REQUEST_TIMEOUT'); };
  const cancel = value => { try { void value?.cancel().catch(() => {}); } catch {} };
  async function operation() {
    const response = await fetch(endpoints[call.endpoint], { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
    if (closed || controller.signal.aborted) { try { cancel(response.body?.getReader()); } catch {} throw fail('REQUEST_TIMEOUT'); }
    deadline(); record.httpStatus = response.status;
    record.responseHeaders = Object.fromEntries(['content-type', 'date', 'server'].flatMap(key => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
    if (!response.body?.getReader) throw fail('INVALID_JSON_RPC');
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (closed || controller.signal.aborted) { cancel(reader); throw fail('REQUEST_TIMEOUT'); }
      if (done) { deadline(); break; }
      const chunk = Buffer.from(value); hash.update(chunk); record.responseBytes += chunk.length; capture.totalResponseBytes += chunk.length;
      if (capture.totalResponseBytes > limits.totalResponseBytes) { capture.stoppedByTotalByteCap = true; throw fail('TOTAL_BYTE_LIMIT'); }
      if (record.responseBytes > limits.responseBytes) throw fail('RESPONSE_BYTE_LIMIT');
      deadline(); chunks.push(chunk);
    }
    complete = true; record.responseSha256 = finishHash();
    if (!response.ok) throw fail('HTTP_ERROR');
    let raw, payload;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); payload = JSON.parse(raw); } catch { throw fail('INVALID_JSON_RPC'); }
    if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || payload.id !== request.id) throw fail('INVALID_JSON_RPC');
    if (Object.hasOwn(payload, 'error')) { if (Number.isSafeInteger(payload.error?.code)) record.rpcErrorCode = payload.error.code; throw fail('RPC_ERROR'); }
    if (!Object.hasOwn(payload, 'result')) throw fail('INVALID_JSON_RPC');
    deadline(); assert.equal(sha(Buffer.from(raw)), record.responseSha256);
    record.responseRaw = raw; record.response = payload; record.bodyComplete = true;
  }
  try {
    await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('REQUEST_TIMEOUT')); }, limits.requestMs); })]);
  } catch (error) {
    record.error = { code: allowedCodes.has(error?.code) ? error.code : 'TRANSPORT_UNAVAILABLE', message: 'The fixed diagnostic request did not complete; arbitrary provider error text is omitted.' };
    record.bodyComplete = complete; record.observedBytesSha256 = finishHash();
  } finally {
    closed = true; clearTimeout(timer); if (record.error) { controller.abort(); cancel(reader); }
    record.completedAt = new Date().toISOString(); record.elapsedMs = Math.round(performance.now() - start);
  }
  await writeFile(new URL('capture.json', directory), json(capture));
  console.log(json({ request: request.id, endpoint: call.endpoint, method: call.method, outcome: record.error?.code ?? 'response', responseBytes: record.responseBytes }));
}
capture.status = capture.stoppedByTotalByteCap ? 'stopped_at_total_byte_cap' : 'complete';
capture.completedAt = new Date().toISOString();
await writeFile(new URL('capture.json', directory), json(capture));
console.log(json({ status: capture.status, requestsAttempted: capture.requestsAttempted, totalResponseBytes: capture.totalResponseBytes, captureSha256: sha(await readFile(new URL('capture.json', directory))) }));
