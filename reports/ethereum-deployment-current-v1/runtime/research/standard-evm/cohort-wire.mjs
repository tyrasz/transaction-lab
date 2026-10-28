import { createAuthenticatedAncestry } from '../../engines/local-evm/authenticated-ancestry.js';
import { performance } from 'node:perf_hooks';
import { captureHttp } from '../../reports/ethereum-lending-local-reference/wire.mjs';

// One public-wire budget shared by selection, product and independent local
// execution. captureHttp is frozen prior evidence infrastructure; archive it
// with this module when freezing a future run.
export const COHORT_PROVIDERS = Object.freeze({
  drpc: 'https://eth.drpc.org/',
  publicnode: 'https://ethereum-rpc.publicnode.com/',
});
export const COHORT_WIRE_LIMITS = Object.freeze({ calls: 6144, totalBytes: 512 * 1024 * 1024, wallMs: 3600000 });
const profiles = {
  census: { calls: 600, totalBytes: 128 * 1024 * 1024 },
  local: { calls: 256, totalBytes: 32 * 1024 * 1024 },
  product: { calls: 65, totalBytes: 32 * 1024 * 1024 },
};
const states = new WeakMap();
const WORD = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const MAX_REQUEST = 8 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
function snapshotRequest(input) {
  let nodes = 0;
  function copy(value, depth = 0) {
    if (++nodes > 200000 || depth > 32) fail('request_not_allowed');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string') { if (Buffer.byteLength(value) > MAX_REQUEST) fail('request_byte_budget'); return value; }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail('request_not_allowed');
    const keys = Reflect.ownKeys(value), array = Array.isArray(value), out = array ? [] : {};
    if (array && (keys.length !== value.length + 1 || value.length > 200000)) fail('request_not_allowed');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail('request_not_allowed');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail('request_not_allowed');
      out[key] = copy(d.value, depth + 1);
    }
    return out;
  }
  return copy(input);
}
function limitsBelow(defaults, limits) {
  if (!record(limits)) fail('invalid_limits');
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) fail('invalid_limits');
  }
  return Object.freeze({ ...defaults, ...limits });
}
export function createCohortWireBudget({ limits = {} } = {}) {
  const fixed = limitsBelow(COHORT_WIRE_LIMITS, limits), start = performance.now();
  const state = { calls: 0, dispatches: 0, bytes: 0, maxBytes: fixed.totalBytes, deadline: start + fixed.wallMs, saveFailure: false, limits: fixed };
  const budget = Object.freeze({ snapshot: () => ({ calls: state.calls, dispatches: state.dispatches, observedBytes: state.bytes, elapsedMs: performance.now() - start, saveFailure: state.saveFailure, limits: fixed }) });
  states.set(budget, state); return budget;
}

function validParams(profile, method, params, blockHash, nextAncestorHash = null) {
  if (!Array.isArray(params)) return false;
  const pinned = value => exact(value, ['blockHash', 'requireCanonical']) && value.blockHash === blockHash && value.requireCanonical === true;
  if (method === 'eth_chainId') return profile !== 'local' && params.length === 0;
  if (method === 'eth_getBlockByNumber') return profile !== 'local' && params.length === 2 &&
    typeof params[0] === 'string' && (QUANTITY.test(params[0]) || (profile === 'census' && ['latest', 'finalized'].includes(params[0]))) &&
    typeof params[1] === 'boolean' && (profile === 'census' || params[1] === false);
  if (method === 'eth_getBlockByHash' && profile === 'local') return nextAncestorHash !== null && params.length === 2 && params[0] === nextAncestorHash && params[1] === false;
  if (method === 'eth_getBlockByHash') return profile !== 'local' && params.length === 2 && matches(params[0], WORD) &&
    typeof params[1] === 'boolean' && (profile === 'census' || (params[0] === blockHash && params[1] === false));
  if (profile === 'census') return false;
  if (method === 'eth_getProof') return profile === 'local' && params.length === 3 && matches(params[0], ADDRESS) &&
    Array.isArray(params[1]) && params[1].length <= 1024 && params[1].every(slot => typeof slot === 'string' && WORD.test(slot)) && pinned(params[2]);
  if (method === 'eth_getCode' || (profile === 'product' && ['eth_getBalance', 'eth_getTransactionCount'].includes(method))) {
    return params.length === 2 && matches(params[0], ADDRESS) && pinned(params[1]);
  }
  // The frozen product builds and validates these read-only trace options,
  // including isolated poststate overrides. This transport binds the state
  // selector and native tracer; it does not adjudicate execution semantics.
  return profile === 'product' && method === 'debug_traceCall' && params.length === 3 && record(params[0]) && pinned(params[1]) &&
    record(params[2]) && ['callTracer', 'prestateTracer'].includes(params[2].tracer);
}

/** save is an optional synchronous record hook (e.g. atomic writeFileSync).
 * Durability is the caller's responsibility; the default is memory only.
 * No result is returned before the hook succeeds. All error bodies are retained,
 * including bodies the product's own transport deliberately withholds.
 * Limits count observed fetch entity bytes, including oversize chunks; these
 * are not TCP byte or process-memory caps. No retries or provider fallback.
 */
export function createCohortTransport({ budget, provider, profile, blockHash, header, limits = {}, save = () => {}, fetchImpl = fetch }) {
  const shared = states.get(budget);
  if (!shared || !Object.hasOwn(COHORT_PROVIDERS, provider) || !Object.hasOwn(profiles, profile) || typeof save !== 'function' || typeof fetchImpl !== 'function') fail('invalid_transport');
  if (profile === 'census' ? blockHash !== undefined : typeof blockHash !== 'string' || !WORD.test(blockHash)) fail('invalid_state_binding');
  if (header !== undefined && profile !== 'local') fail('invalid_state_binding');
  let ancestry = null;
  if (header !== undefined) {
    try { ancestry = createAuthenticatedAncestry(header); } catch { fail('invalid_state_binding'); }
    if (ancestry.snapshot().anchorBlockHash !== blockHash) fail('invalid_state_binding');
  }
  let ancestryFailure = false;
  const fixed = limitsBelow({ ...profiles[profile], requestMs: 25000, responseBytes: 8 * 1024 * 1024, wallMs: profile === 'census' ? 3600000 : 145000 }, limits);
  const scope = { bytes: 0, maxBytes: fixed.totalBytes }, records = [], denied = [], pending = new Set();
  let calls = 0, dispatches = 0, nextId = 0, busy = false, start = null;
  const url = COHORT_PROVIDERS[provider], ids = new Set();
  function deny(code, method) {
    // Do not retain attacker-sized input or an unbounded denial log.
    if (denied.length < 1024) denied.push({ code, method: typeof method === 'string' ? method.slice(0, 80) : null });
    fail(code);
  }
  async function dispatch(body, signal) {
    const method = body?.method;
    try { body = snapshotRequest(body); } catch (error) { deny(error.code ?? 'request_not_allowed', method); }
    if (!exact(body, ['jsonrpc', 'id', 'method', 'params']) || body.jsonrpc !== '2.0' || !Number.isSafeInteger(body.id) || body.id < 1 ||
      typeof method !== 'string' || !validParams(profile, method, body.params, blockHash, ancestry?.nextHash() ?? null)) deny('request_not_allowed', method);
    const requestText = JSON.stringify(body);
    if (Buffer.byteLength(requestText) > MAX_REQUEST) deny('request_byte_budget', method);
    if (signal?.aborted) deny('cancelled_before_dispatch', method);
    if (busy) deny('concurrent_dispatch', method);
    if (ids.has(body.id)) deny('duplicate_request_id', method);
    if (shared.saveFailure) deny('wire_save_failed', method);
    if (ancestryFailure) deny('ancestor_header_invalid', method);
    const now = performance.now(), deadline = Math.min(shared.deadline, (start ?? now) + fixed.wallMs);
    if (calls >= fixed.calls || shared.calls >= shared.limits.calls || now >= deadline || scope.bytes >= scope.maxBytes || shared.bytes >= shared.maxBytes) deny('attempt_budget', method);
    start ??= now; busy = true; calls++; shared.calls++; ids.add(body.id);
    const globalId = shared.calls, request = structuredClone(body);
    const active = (async () => {
      let dispatched = false;
      const measuredFetch = (input, options) => { dispatched = true; dispatches++; shared.dispatches++; return fetchImpl(input, options); };
      const wire = await captureHttp({ url, body: request, deadline, requestMs: fixed.requestMs, responseBytes: fixed.responseBytes, shared, scope, fetchImpl: measuredFetch, signal });
      wire.id = request.id; wire.globalId = globalId; wire.provider = provider; wire.profile = profile; wire.request = request;
      wire.dispatched = dispatched;
      const p = wire.parsed;
      if (wire.status === 'completed' && (!record(p) || p.jsonrpc !== '2.0' || p.id !== request.id || Object.hasOwn(p, 'result') === Object.hasOwn(p, 'error'))) {
        wire.status = 'failed'; wire.error = 'jsonrpc_envelope';
      }
      if (wire.status === 'completed' && Object.hasOwn(p, 'error')) { wire.status = 'failed'; wire.error = 'rpc_error'; }
      if (profile === 'local' && method === 'eth_getBlockByHash') {
        if (wire.status === 'completed') {
          try { ancestry.accept(p.result, calls); wire.ancestorVerification = 'verified'; }
          catch { wire.status = 'failed'; wire.error = 'ancestor_header_invalid'; wire.ancestorVerification = 'rejected'; }
        }
        if (wire.status !== 'completed') ancestryFailure = true;
      }
      records.push(wire);
      try {
        const saved = save(structuredClone(wire));
        if (saved !== undefined) { if (typeof saved?.catch === 'function') saved.catch(() => {}); fail('synchronous_save_required'); }
      } catch { shared.saveFailure = true; fail('wire_save_failed'); }
      if (shared.saveFailure) fail('wire_save_failed');
      return wire;
    })();
    pending.add(active);
    try { return await active; } finally { busy = false; pending.delete(active); }
  }
  return Object.freeze({
    provider, profile, url,
    records: () => structuredClone(records),
    denied: () => structuredClone(denied),
    usage: () => ({ attempts: calls, dispatches, observedBytes: scope.bytes, shared: budget.snapshot(), limits: fixed }),
    async drain() { await Promise.allSettled([...pending]); if (shared.saveFailure) fail('wire_save_failed'); },
    async call(method, params = [], { signal } = {}) {
      const wire = await dispatch({ jsonrpc: '2.0', id: ++nextId, method, params }, signal);
      if (shared.saveFailure) fail('wire_save_failed');
      if (wire.status !== 'completed') fail(wire.error);
      return structuredClone(wire.parsed.result);
    },
    async fetch(input, options) {
      // Preserve the product's exact request bytes/IDs. Only JSON.stringify's
      // canonical representation is admitted, since captureHttp serializes it.
      if (String(input) !== url || !options || options.method !== 'POST' || options.redirect !== 'error' ||
        !exact(options.headers, ['content-type']) || options.headers['content-type'] !== 'application/json' || typeof options.body !== 'string' ||
        Buffer.byteLength(options.body) > MAX_REQUEST) deny('fetch_not_allowed');
      let body; try { body = JSON.parse(options.body); } catch { deny('fetch_not_allowed'); }
      if (JSON.stringify(body) !== options.body) deny('fetch_not_allowed');
      const wire = await dispatch(body, options.signal);
      if (shared.saveFailure) fail('wire_save_failed');
      // Complete HTTP/RPC/JSON failures are replayed verbatim for the product
      // parser (which also rejects invalid UTF-8). Truncated or timed-out
      // entities never masquerade as a complete response.
      if (profile === 'local' && wire.error === 'ancestor_header_invalid') fail(wire.error);
      if (!wire.transport.complete || wire.error === 'deadline' || !Number.isInteger(wire.httpStatus)) fail(wire.error ?? 'incomplete_transport');
      const raw = Buffer.from(wire.rawBase64, 'base64');
      if ([204, 205, 304].includes(wire.httpStatus)) return new Response(null, { status: wire.httpStatus, headers: wire.headers });
      return new Response(raw, { status: wire.httpStatus, headers: wire.headers });
    },
  });
}
