import { performance } from 'node:perf_hooks';
import { sha, safeError } from './artifacts.mjs';
import { ENDPOINT, LIMITS, validateRequest } from './policy.mjs';

export function createRecordingTransport({ scenario, save, fetchImpl = fetch, now = () => performance.now(), wall = () => Date.now() }) {
  const startedMono = now(), startedWall = wall(); let phase = 'selection', generation = 0, selected = null, sequence = Promise.resolve(), nextId = 0;
  let lastMono = startedMono, lastWall = startedWall, clockReversed = false;
  let observedBytes = 0, retainedBytes = 0, active = null, activeOperations = 0, closed = false, hardFailure = null, viemStopped = null, deniedCount = 0;
  const exchanges = [], denials = [], overrides = [], discarded = []; let discardedCount = 0, queued = 0;
  const elapsed = () => { const m = now(), w = wall(); clockReversed ||= !Number.isFinite(m) || !Number.isFinite(w) || m < lastMono || w < lastWall; lastMono = m; lastWall = w; return Math.max(0, m - startedMono, w - startedWall); };
  function check() { if (elapsed() >= LIMITS.overallMs || closed || hardFailure || clockReversed) throw new Error(hardFailure ?? 'Transport closed or global deadline exceeded.'); }
  async function bounded(promise, signal) {
    activeOperations++;
    const tracked = Promise.resolve(promise).finally(() => { activeOperations--; });
    let abort; const cancelled = new Promise((_, reject) => { abort = () => reject(new Error('Request cancelled or deadline exceeded.')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try { return await Promise.race([tracked, cancelled]); } finally { signal.removeEventListener('abort', abort); }
  }
  function deny(method, reason, global = true) { deniedCount++; if (denials.length < 64) denials.push({ method, phase, reason }); if (global) hardFailure ??= reason; else viemStopped ??= reason; throw new Error(reason); }
  async function perform({ method, params, admissionPhase, admissionGeneration }) {
    try { check(); if (admissionGeneration !== generation) throw new Error('Discarded queued request from an ended phase.'); }
    catch (error) { discardedCount++; if (discarded.length < LIMITS.calls) discarded.push({ method, phase: admissionPhase, paramsSha256: sha(JSON.stringify(params)), reason: error.message }); throw error; }
    if (admissionPhase === 'viem' && (viemStopped || elapsed() >= LIMITS.viemDispatchMs)) return deny(method, viemStopped ?? 'Viem phase exceeded its reserved dispatch window.', false);
    if (nextId >= (admissionPhase === 'viem' ? LIMITS.calls - LIMITS.finalReserveCalls : LIMITS.calls)) return deny(method, 'Fixed total request budget exhausted.', admissionPhase !== 'viem');
    const found = validateRequest({ method, params, phase: admissionPhase, selected, scenario });
    const id = nextId + 1, requestText = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(requestText) > LIMITS.requestBytes) return deny(method, 'Request byte bound exceeded.');
    nextId = id;
    const prefix = 'wire/' + String(id).padStart(3, '0'), requestArtifact = save(prefix + '-request.json', requestText);
    const controller = new AbortController(); active = controller; const begin = now();
    const row = { id, phase: admissionPhase, method, request: requestArtifact, startedAt: new Date(wall()).toISOString(), status: 'unavailable', dispatched: false, httpStatus: null,
      responseComplete: false, observedBytes: 0, response: null, rpcError: null, error: null, durationMs: null };
    const requestDeadline = admissionPhase === 'viem' ? LIMITS.viemDispatchMs : LIMITS.overallMs;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(LIMITS.requestMs, requestDeadline - elapsed())));
    const chunks = []; let reader, value;
    try {
      check();
      row.dispatched = true;
      const response = await bounded(fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: requestText, redirect: 'error', signal: controller.signal }), controller.signal);
      row.httpStatus = response.status; row.headers = { contentType: response.headers.get('content-type'), contentEncoding: response.headers.get('content-encoding') };
      if (!response.body) throw new Error('Missing response body.'); reader = response.body.getReader();
      while (true) {
        const part = await bounded(reader.read(), controller.signal);
        if (part.done) { row.responseComplete = true; break; }
        row.observedBytes += part.value.byteLength; observedBytes += part.value.byteLength;
        const allowance = Math.min(LIMITS.responseBytes - chunks.reduce((n, b) => n + b.length, 0), LIMITS.totalBytes - retainedBytes);
        if (allowance > 0) { const b = Buffer.from(part.value.subarray(0, allowance)); chunks.push(b); retainedBytes += b.length; }
        if (row.observedBytes > LIMITS.responseBytes || observedBytes > LIMITS.totalBytes) { hardFailure = 'Response byte budget exceeded.'; throw new Error(hardFailure); }
      }
      check(); if (controller.signal.aborted || now() - begin > LIMITS.requestMs || elapsed() > requestDeadline) throw new Error('Request timing bound exceeded.');
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (parsed?.jsonrpc !== '2.0' || parsed.id !== id || Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')) throw new Error('Malformed JSON-RPC envelope.');
      if (!response.ok) { row.status = 'http_error'; throw new Error('HTTP ' + response.status); }
      if (Object.hasOwn(parsed, 'error')) {
        row.status = 'rpc_error'; row.rpcError = parsed.error;
        const error = new Error(typeof parsed.error?.message === 'string' ? parsed.error.message : 'RPC error');
        if (Number.isInteger(parsed.error?.code)) error.code = parsed.error.code;
        if (parsed.error?.data !== undefined) error.data = parsed.error.data;
        throw error;
      }
      row.status = 'rpc_result'; value = parsed.result;
    } catch (error) { row.error = safeError(error); throw error; }
    finally {
      clearTimeout(timer); controller.abort(); active = null;
      if (reader) { activeOperations++; try { Promise.resolve(reader.cancel()).catch(() => {}).finally(() => { activeOperations--; }); } catch { activeOperations--; } }
      row.durationMs = now() - begin; row.finishedAt = new Date(wall()).toISOString();
      row.response = save(prefix + '-response.body', Buffer.concat(chunks)); save(prefix + '-exchange.json', row); exchanges.push(row);
      for (const item of found) overrides.push({ wireId: id, address: item.address, codeSha256: sha(Buffer.from(item.code.slice(2), 'hex')), fields: ['code'] });
    }
    return value;
  }
  return {
    request({ method, params = [] }) {
      const admissionPhase = phase, admissionGeneration = generation;
      if (phase === 'viem' && (viemStopped || queued >= LIMITS.calls)) { try { deny(method, viemStopped ?? 'Queued viem work limit exceeded.', false); } catch (error) { return Promise.reject(error); } }
      let copy; try { copy = JSON.parse(JSON.stringify(params)); validateRequest({ method, params: copy, phase, selected, scenario }); check(); }
      catch (error) { const reason = 'Request denied before dispatch: ' + (error?.message ?? 'invalid request'); deniedCount++; if (denials.length < 64) denials.push({ method, phase, reason }); hardFailure ??= reason; return Promise.reject(new Error(reason)); }
      queued++; const work = sequence.then(() => perform({ method, params: copy, admissionPhase, admissionGeneration })).finally(() => { queued--; });
      sequence = work.catch(() => {}); return work;
    },
    setPhase(name) { phase = name; generation++; },
    pin(header) { if (selected) throw new Error('Block already pinned.'); selected = { number: header.number, hash: header.hash }; },
    endPhase() { generation++; active?.abort(); },
    async drain() { await sequence; return { complete: activeOperations === 0, pendingAdapterOperations: activeOperations }; },
    finish() { closed = true; generation++; active?.abort(); },
    snapshot() { const elapsedMs = elapsed(); return structuredClone({ calls: exchanges.filter(row => row.dispatched).length, requestAttempts: nextId, observedBytes, retainedBytes, elapsedMs, wallMs: lastWall - startedWall, monotonicMs: lastMono - startedMono,
      withinBounds: elapsedMs <= LIMITS.overallMs && !clockReversed, clockReversed, hardFailure, viemStopped, deniedCount, denials, discardedCount, discarded, pendingAdapterOperations: activeOperations, exchanges, measurementOverrides: overrides }); },
  };
}
