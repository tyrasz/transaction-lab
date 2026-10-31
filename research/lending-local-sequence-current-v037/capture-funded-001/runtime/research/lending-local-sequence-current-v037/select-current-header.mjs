import { performance } from 'node:perf_hooks';
import { captureHttp } from '../standard-evm/cohort-http.mjs';
import { createHeaderSelection, HEADER_SELECTION_POLICY as POLICY, SELECTION_ENDPOINT } from './selection.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const fault = (code, message) => Object.assign(new Error(message), { code });
const defaultClock = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
function sampleClock(clock) {
  const sample = clock();
  if (!sample || !Number.isSafeInteger(sample.wallMs) || sample.wallMs < 0
    || !Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || sample.monotonicMs > Number.MAX_SAFE_INTEGER)
    throw fault('SELECTION_CLOCK_INVALID', 'Selection clock is malformed.');
  return { wallMs: sample.wallMs, monotonicMs: sample.monotonicMs };
}
function elapsed(a, b) {
  if (b.wallMs < a.wallMs || b.monotonicMs < a.monotonicMs)
    throw fault('SELECTION_CLOCK_INVALID', 'Selection clock reversed.');
  return Math.max(b.wallMs - a.wallMs, b.monotonicMs - a.monotonicMs);
}

/** Exactly one three-read selection attempt; no retry, target call or endpoint
 * choice. The caller must invoke this from its externally verified archive and
 * supply an original-write save(path, value). save may be sync or async; pending
 * writes cannot confer usability. Only wire/NNNN.json native records are saved.
 * No source/ledger attestation is inferred from the supplied identity strings. */
export async function captureHeaderSelection({ sourceBinding, save, fetchImpl = fetch, clock = defaultClock }) {
  const nativeStart = performance.now(), io = new Set(), saves = new Set(), controller = new AbortController();
  const budget = { bytes: 0, maxBytes: POLICY.totalBytes }, joins = [];
  let state = null, started = null, last = null, requestStart = null, monitor = null;
  let error = null, calls = 0, retainedBytes = 0, saveFailed = false, cancelFailed = false;
  let unaccountedData = false, clockInvalid = false, timedOut = false, drainNativeMs = 0, drainBudgetMs = 0;
  const track = (set, promise) => {
    const p = Promise.resolve(promise); set.add(p);
    p.then(() => set.delete(p), () => set.delete(p));
    return p;
  };
  const latch = e => {
    const code = typeof e?.code === 'string' ? e.code : 'SELECTION_CAPTURE_FAILED';
    if (!error) error = { code, message: String(e?.message ?? e).slice(0, 1024) };
    if (code === 'SELECTION_CLOCK_INVALID') clockInvalid = true;
    if (code === 'SELECTION_DEADLINE' || code === 'deadline') timedOut = true;
    controller.abort();
  };
  const sample = () => {
    const now = sampleClock(clock);
    if (last) elapsed(last, now);
    last = now;
    return now;
  };
  const phaseElapsed = now => Math.max(elapsed(started, now), performance.now() - nativeStart);
  const check = () => {
    const now = sample();
    if (phaseElapsed(now) > POLICY.phaseMs) throw fault('SELECTION_DEADLINE', 'Selection phase exceeded 60 seconds.');
    if (requestStart && Math.max(elapsed(requestStart.clock, now), performance.now() - requestStart.nativeMs) > POLICY.requestMs)
      throw fault('SELECTION_DEADLINE', 'Selection request exceeded 15 seconds.');
    return now;
  };
  const checkHealthy = () => {
    if (error) throw fault(error.code, error.message);
    return check();
  };
  // Native cleanup is cumulative across the three sequential reads. A pending
  // fetch/read/cancel prevents the next request, and all cleanup uses one 10s
  // allowance inside the 60s phase. A rejected cancellation is never "drained".
  const settleIo = async () => {
    const began = performance.now(); let beganClock;
    try { beganClock = sample(); } catch (e) { latch(e); return; }
    let allowance = Math.max(0, Math.min(POLICY.drainMs - drainBudgetMs, POLICY.phaseMs - phaseElapsed(beganClock)));
    try {
      while (io.size || saves.size) {
        let current;
        try { current = sample(); } catch (e) { latch(e); break; }
        const used = Math.max(elapsed(beganClock, current), performance.now() - began);
        const left = Math.min(allowance - used, POLICY.phaseMs - phaseElapsed(current));
        if (!(left > 0)) { timedOut = true; break; }
        let timer;
        const settled = await Promise.race([
          Promise.allSettled([...io, ...saves]).then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, left)); }),
        ]);
        clearTimeout(timer);
        if (!settled) { timedOut = true; break; }
      }
    } finally {
      const nativeUsed = performance.now() - began;
      drainNativeMs += nativeUsed;
      try { const current = sample(); drainBudgetMs += Math.max(elapsed(beganClock, current), nativeUsed); }
      catch (e) { latch(e); drainBudgetMs += nativeUsed; }
    }
  };
  const cancellation = async fn => {
    try { return await fn(); }
    catch (e) { cancelFailed = true; latch(fault('SELECTION_CANCEL_FAILED', 'Actual body cancellation rejected.')); throw e; }
  };
  const markUnavailable = () => {
    if (state?.snapshot().status === 'selecting') {
      try { state.fail(error?.message ?? 'Selection closure is not verified.', last); }
      catch (e) { latch(e); }
    }
  };

  try {
    if (typeof save !== 'function' || typeof fetchImpl !== 'function' || typeof clock !== 'function')
      throw fault('SELECTION_CAPTURE_INVALID', 'Selection requires save, fetch and clock functions.');
    started = last = sampleClock(clock);
    state = createHeaderSelection({ sourceBinding, started });
    monitor = setInterval(() => { try { check(); } catch (e) { latch(e); } }, 20);
    for (let index = 0; index < POLICY.requests; index++) {
      const requestClock = checkHealthy(), request = state.request(requestClock);
      const body = JSON.parse(request.requestText), id = index + 1;
      const nativeRequestStart = performance.now(); requestStart = { clock: requestClock, nativeMs: nativeRequestStart };
      let dispatched = false, captureFinished = false;
      const bodies = new Set();
      const trackedFetch = async (url, options) => {
        // Revalidate immediately at the actual native dispatch boundary.
        checkHealthy();
        if (url !== SELECTION_ENDPOINT || options.method !== 'POST' || options.redirect !== 'error' || options.body !== request.requestText)
          throw fault('SELECTION_REQUEST_INVALID', 'Unexpected native selection request.');
        calls++; dispatched = true;
        const response = await fetchImpl(url, options);
        const body = response.body;
        let reader, closing;
        const close = () => closing ??= track(io, cancellation(() => Promise.resolve().then(() => reader ? reader.cancel() : body.cancel())));
        if (body) { bodies.add(close); if (captureFinished || options.signal.aborted) close(); }
        try { return { ok: response.ok, status: response.status, headers: response.headers, body: body ? {
          cancel: close,
          getReader() {
            reader = body.getReader();
            return { read: () => reader.read(), cancel: close };
          },
        } : null }; }
        catch (e) { if (body) close(); throw e; }
      };
      const remaining = Math.max(0, POLICY.phaseMs - phaseElapsed(requestClock));
      let native;
      try { native = await captureHttp({ url: SELECTION_ENDPOINT, body,
        deadline: Math.min(nativeStart + POLICY.phaseMs, nativeRequestStart + remaining), requestMs: POLICY.requestMs,
        responseBytes: POLICY.responseBytes, shared: budget, fetchImpl: trackedFetch, signal: controller.signal,
        track: promise => track(io, promise), onUnaccountedData: () => {
          unaccountedData = true; latch(fault('SELECTION_UNACCOUNTED_DATA', 'Late native body data cannot be accounted to a completed record.'));
        } }); }
      finally { captureFinished = true; for (const close of bodies) close(); }
      if (native.error === 'deadline') timedOut = true;
      // Header decoding/getReader failure can precede captureHttp's reader
      // acquisition. Close the acquired body explicitly in that path as well.
      let responseClock;
      try { responseClock = check(); } catch (e) { latch(e); responseClock = last; }
      requestStart = null;
      const { parsed, responseText, ...nativeWire } = native;
      const wire = { id, dispatched, ...nativeWire, requestClock, responseClock };
      const path = `wire/${String(id).padStart(4, '0')}.json`;
      const join = { id, path, dispatched, requestSha256: wire.requestSha256,
        responseSha256: wire.transport.retainedSha256, retainedBytes: wire.transport.retainedBytes,
        observedBytes: wire.transport.observedBytes, saved: false };
      joins.push(join); retainedBytes += wire.transport.retainedBytes;
      try {
        state.accept({ endpoint: wire.url, requestText: wire.requestText, httpStatus: wire.httpStatus ?? null,
          responseBase64: wire.rawBase64, responseBytesObserved: wire.transport.observedBytes,
          complete: wire.transport.complete, error: wire.error ?? null }, responseClock);
      } catch (e) { latch(e); }
      // Persist a native record even after semantic or clock failure. Persistence
      // cannot use an aborted signal as a shortcut, but is still phase-bounded.
      try {
        const saving = track(saves, Promise.resolve().then(() => save(path, copy(wire))));
        let outcome = null;
        saving.then(() => { outcome = { ok: true }; }, e => { outcome = { ok: false, error: e }; });
        while (!outcome) {
          const left = Math.max(0, POLICY.phaseMs - phaseElapsed(last));
          if (left <= 0) throw fault('SELECTION_DEADLINE', 'No persistence budget remains.');
          let timer;
          try { await Promise.race([saving.then(() => {}, () => {}), new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, Math.min(20, left))); })]); }
          finally { clearTimeout(timer); }
          if (!outcome) check();
        }
        if (!outcome.ok) throw outcome.error;
        join.saved = true;
        try { check(); } catch (e) { latch(e); }
      } catch (e) { saveFailed = true; latch(e); }
      await settleIo();
      if (io.size || saves.size || cancelFailed || unaccountedData || saveFailed || timedOut || clockInvalid)
        latch(fault('SELECTION_CLOSURE_UNVERIFIED', 'Selection persistence or actual native I/O closure is unverified.'));
      if (error || state.snapshot().status !== 'selecting') break;
    }
  } catch (e) { latch(e); }
  finally {
    requestStart = null; controller.abort();
    if (started && (io.size || saves.size)) await settleIo();
    clearInterval(monitor);
  }

  let finished = last;
  if (started) {
    try { finished = check(); } catch (e) { latch(e); finished = last; }
  }
  if (io.size || saves.size || cancelFailed || saveFailed || unaccountedData || clockInvalid || timedOut)
    latch(fault('SELECTION_CLOSURE_UNVERIFIED', 'Selection persistence or actual native I/O closure is unverified.'));
  if (state && !error && calls === 3 && joins.every(row => row.saved)) {
    try { state.finish(finished); } catch (e) { latch(e); }
  } else if (state && !error) latch(fault('SELECTION_INCOMPLETE', 'Three successful reads were not completed.'));
  if (error) markUnavailable();
  const nativeMs = performance.now() - nativeStart;
  const result = {
    selection: state?.snapshot() ?? null,
    drain: { complete: io.size === 0 && saves.size === 0 && !unaccountedData && !cancelFailed && !saveFailed && !clockInvalid && !timedOut,
      pendingIo: io.size, pendingSaves: saves.size, unaccountedData, cancelFailed, saveFailed, clockInvalid, timedOut,
      durationMs: drainNativeMs, budgetUsedMs: drainBudgetMs, timeoutMs: POLICY.drainMs },
    usage: { calls, observedBytes: budget.bytes, retainedBytes, savedWires: joins.filter(row => row.saved).length, wireJoins: joins, limits: POLICY },
    elapsed: started ? { started, finished, wallMs: finished.wallMs - started.wallMs,
      monotonicMs: finished.monotonicMs - started.monotonicMs, nativeMs } : null,
    error,
  };
  return copy(result);
}
