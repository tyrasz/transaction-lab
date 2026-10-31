import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// New cohort transport: track actual fetch/read/cancel settlement for drainage.
// Count entity bytes delivered by fetch, including error bodies. An oversized
// chunk is counted in full but only the bounded prefix is retained. Abort every
// pending I/O wait; late fetch/read completions cannot mutate a returned record.
export async function captureHttp({ url, body, deadline, requestMs, responseBytes, shared, scope,
  fetchImpl = fetch, signal, track = promise => promise, onUnaccountedData = () => {} }) {
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
    const fetching = track(Promise.resolve().then(() => fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText,
      redirect: 'error', signal: controller.signal,
    })));
    track(fetching.then(async r => {
      if (settled || controller.signal.aborted) await r.body?.cancel();
    }));
    const response = await Promise.race([fetching, pendingLimit]);
    check(); record.httpStatus = response.status; record.headers = Object.fromEntries(response.headers);
    reader = response.body?.getReader(); if (!reader) fail('missing_body');
    for (;;) {
      const late = part => { if (!part.done && (settled || controller.signal.aborted || performance.now() >= expires)) onUnaccountedData(); return part; };
      const part = await Promise.race([track(Promise.resolve(reader.read()).then(late)), pendingLimit]); late(part); check();
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
    track(Promise.resolve().then(() => reader?.cancel()));
    const raw = Buffer.concat(chunks); record.rawBase64 = raw.toString('base64');
    record.transport = { complete: complete && observed === kept, observedBytes: observed, retainedBytes: kept,
      observedSha256: digest.digest('hex'), retainedSha256: sha(raw), durationMs: performance.now() - began };
  }
  return record;
}
