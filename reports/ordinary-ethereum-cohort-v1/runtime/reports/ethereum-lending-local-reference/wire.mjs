import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Count entity bytes delivered by fetch, including error bodies. An oversized
// chunk is counted in full but only the bounded prefix is retained. Abort every
// pending I/O wait; late fetch/read completions cannot mutate a returned record.
export async function captureHttp({ url, body, deadline, requestMs, responseBytes, shared, scope,
  fetchImpl = fetch, signal }) {
  const began = performance.now(), requestText = JSON.stringify(body);
  const record = { url, requestText, requestSha256: sha(requestText), requestBytes: Buffer.byteLength(requestText), startedAt: new Date().toISOString() };
  const budgets = scope && scope !== shared ? [scope, shared] : [shared];
  const chunks = [], digest = createHash('sha256'), controller = new AbortController();
  let reader, timer, onAbort, observed = 0, kept = 0, complete = false, settled = false;
  const expires = Math.min(deadline, began + requestMs);
  const check = () => { if (settled || performance.now() >= expires) fail('deadline'); };
  try {
    check(); if (signal?.aborted) fail('deadline');
    if (budgets.some(b => b.bytes >= b.maxBytes)) fail('byte_budget');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('deadline'), { code: 'deadline' })); }, Math.max(1, expires - performance.now()));
    });
    const canceled = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(Object.assign(new Error('deadline'), { code: 'deadline' })); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const pendingLimit = Promise.race([timeout, canceled]);
    const fetching = Promise.resolve().then(() => fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText,
      redirect: 'error', signal: controller.signal,
    }));
    fetching.then(r => {
      if (settled || controller.signal.aborted) { try { Promise.resolve(r.body?.cancel()).catch(() => {}); } catch {} }
    }).catch(() => {});
    const response = await Promise.race([fetching, pendingLimit]);
    check(); record.httpStatus = response.status; record.headers = Object.fromEntries(response.headers);
    reader = response.body?.getReader(); if (!reader) fail('missing_body');
    for (;;) {
      const part = await Promise.race([reader.read(), pendingLimit]); check();
      if (part.done) { complete = true; break; }
      const bytes = Buffer.from(part.value), room = Math.max(0, Math.min(responseBytes - kept, ...budgets.map(b => b.maxBytes - b.bytes)));
      digest.update(bytes); observed += bytes.length; for (const budget of budgets) budget.bytes += bytes.length;
      const retained = bytes.subarray(0, room); chunks.push(retained); kept += retained.length;
      if (retained.length !== bytes.length) fail('response_byte_budget');
    }
    const raw = Buffer.concat(chunks); record.responseSha256 = sha(raw);
    record.responseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); check();
    if (!response.ok) fail('http_error');
    record.parsed = JSON.parse(record.responseText); check(); record.status = 'completed';
  } catch (error) {
    record.status = 'failed';
    record.error = ['deadline', 'byte_budget', 'response_byte_budget', 'missing_body', 'http_error'].includes(error?.code)
      ? error.code : 'transport_or_encoding_error';
  } finally {
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
    const raw = Buffer.concat(chunks); record.rawBase64 = raw.toString('base64');
    record.transport = { complete: complete && observed === kept, observedBytes: observed, retainedBytes: kept,
      observedSha256: digest.digest('hex'), retainedSha256: sha(raw), durationMs: performance.now() - began };
  }
  return record;
}

export function proofTransport({ provider, header, shared, scope, deadline, save, fetchImpl = fetch,
  maxCalls = 256, requestMs = 25000, responseBytes = 8 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 256) fail('invalid_call_limit');
  const records = [], denied = [], pending = new Set(); let dispatches = 0, busy = false, saveFailure = null;
  return {
    records, denied,
    usage() { return { dispatches, observedBytes: scope.bytes, sharedObservedBytes: shared.bytes }; },
    async drain() { await Promise.allSettled([...pending]); if (saveFailure) fail('wire_save_failed'); },
    call(method, params, { signal } = {}) {
      const block = { blockHash: header.hash, requireCanonical: true };
      let reason;
      if (!['eth_getProof', 'eth_getCode'].includes(method)) reason = 'method_not_allowed';
      else if (!Array.isArray(params) || JSON.stringify(params.at(-1)) !== JSON.stringify(block)) reason = 'state_binding';
      else if (busy) reason = 'concurrent_dispatch';
      else if (dispatches >= maxCalls || performance.now() >= deadline || scope.bytes >= scope.maxBytes || shared.bytes >= shared.maxBytes) reason = 'attempt_budget';
      if (reason) { denied.push({ method, code: reason }); return Promise.reject(Object.assign(new Error(reason), { code: reason })); }
      const id = ++dispatches, request = { jsonrpc: '2.0', id, method, params: structuredClone(params) }; busy = true;
      const active = (async () => {
        const record = await captureHttp({ url: provider.url, body: request, deadline, requestMs, responseBytes, shared, scope, fetchImpl, signal });
        record.id = id; record.request = request; const p = record.parsed;
        if (record.status === 'completed' && (!p || typeof p !== 'object' || Array.isArray(p) || p.jsonrpc !== '2.0' || p.id !== id || Object.hasOwn(p, 'result') === Object.hasOwn(p, 'error'))) {
          record.status = 'failed'; record.error = 'jsonrpc_envelope';
        }
        if (record.status === 'completed' && Object.hasOwn(p, 'error')) { record.status = 'failed'; record.error = 'rpc_error'; }
        records.push(record);
        try { await save(record); } catch { saveFailure = true; fail('wire_save_failed'); }
        if (record.status !== 'completed') fail(record.error);
        return structuredClone(p.result);
      })();
      pending.add(active); active.finally(() => { busy = false; pending.delete(active); }).catch(() => {});
      return active;
    },
  };
}
