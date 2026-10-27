import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

export const PROOF_RPC_LIMITS = Object.freeze({ calls: 260, responseBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, wallMs: 145000, requestMs: 25000 });
const MAX_DRAIN_MS = 25000, MAX_REQUEST_BYTES = 128 * 1024;
const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getProof', 'eth_getCode']);
const MESSAGES = {
  INVALID_RPC_URL: 'Proof RPC URL must be a valid HTTP or HTTPS URL.',
  INVALID_RPC_LIMIT: 'Proof RPC limits may only tighten the fixed ceilings.',
  RPC_INVALID_INPUT: 'Proof RPC input is malformed or unsupported.',
  METHOD_NOT_ALLOWED: 'Only configured read-only proof RPC methods are permitted.',
  RPC_UNPINNED: 'State reads require an explicitly pinned block hash.',
  RPC_PIN_CHANGED: 'The proof RPC block hash cannot be changed.',
  RPC_BUDGET: 'The shared proof RPC resource budget is exhausted.',
  RPC_CANCELLED: 'The proof RPC request was cancelled.',
  RPC_TIMEOUT: 'The proof RPC request timed out.',
  RPC_CLOCK: 'The proof RPC clock is invalid.',
  RPC_RESPONSE_TOO_LARGE: 'The proof RPC response exceeded its byte budget.',
  RPC_HTTP_ERROR: 'The proof provider returned an unsuccessful HTTP status.',
  RPC_INVALID_RESPONSE: 'The proof provider returned an invalid response.',
  RPC_EXECUTION_ERROR: 'The proof provider rejected the read-only RPC request.',
  RPC_CONNECTION_ERROR: 'Unable to reach the proof provider.',
};
export class ProofRpcError extends Error {
  constructor(code, detail = null) { super(MESSAGES[code] ?? MESSAGES.RPC_INVALID_RESPONSE); this.name = 'ProofRpcError'; this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new ProofRpcError(code, detail); };
const need = (ok, code = 'RPC_INVALID_INPUT') => { if (!ok) fail(code); };
const own = (o, k) => Object.hasOwn(o, k);
const hash = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function safeError(error) {
  // Even a same-class exception from an injected adapter is untrusted. Retain
  // only fixed codes and the optional numeric RPC code, never its text/detail.
  let code = 'RPC_CONNECTION_ERROR', detail = null;
  if (error && typeof error === 'object' && !types.isProxy(error) && Object.getPrototypeOf(error) === ProofRpcError.prototype) {
    const candidate = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (typeof candidate === 'string' && own(MESSAGES, candidate)) code = candidate;
    if (code === 'RPC_EXECUTION_ERROR') {
      const supplied = Object.getOwnPropertyDescriptor(error, 'detail')?.value;
      const rpcCode = supplied && typeof supplied === 'object' && !types.isProxy(supplied)
        ? Object.getOwnPropertyDescriptor(supplied, 'rpcCode')?.value : null;
      detail = { rpcCode: Number.isSafeInteger(rpcCode) ? rpcCode : null };
    }
  }
  return new ProofRpcError(code, detail);
}
function fields(value, allowed, required = allowed, code = 'RPC_INVALID_INPUT') {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value), code);
  need([Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const keys = Reflect.ownKeys(value);
  need(required.every(key => own(value, key)), code);
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); need(typeof key === 'string' && allowed.includes(key) && d.enumerable && own(d, 'value'), code); }
}
function array(value, maximum) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  need(length <= maximum && Reflect.ownKeys(value).length === length + 1);
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d?.enumerable && own(d, 'value')); }
}
const isHash = value => typeof value === 'string' && HASH.test(value);
const signalAborted = signal => signal === undefined ? false : Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal);
const addAbort = (signal, listener) => EventTarget.prototype.addEventListener.call(signal, 'abort', listener, { once: true });
const removeAbort = (signal, listener) => EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
function validateParams(method, params, pinned) {
  need(typeof method === 'string' && METHODS.has(method), 'METHOD_NOT_ALLOWED'); array(params, 3);
  if (method === 'eth_chainId') need(params.length === 0);
  else if (method === 'eth_getBlockByNumber') {
    need(params.length === 2 && params[1] === false);
    const block = params[0]; need(block === 'latest' || (typeof block === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(block) && block.length <= 18 && BigInt(block) < (1n << 64n)));
  } else if (method === 'eth_getBlockByHash') need(params.length === 2 && isHash(params[0]) && params[1] === false);
  else {
    need(pinned !== null, 'RPC_UNPINNED');
    need(params.length === (method === 'eth_getProof' ? 3 : 2) && typeof params[0] === 'string' && ADDRESS.test(params[0]));
    const selector = params[params.length - 1]; fields(selector, ['blockHash', 'requireCanonical']);
    need(selector.blockHash === pinned && selector.requireCanonical === true);
    if (method === 'eth_getProof') { array(params[1], 1024); need(params[1].every(isHash) && new Set(params[1]).size === params[1].length); }
  }
  return structuredClone(params);
}
function nestedError(result) {
  const stack = [result]; let nodes = 0;
  while (stack.length) {
    need(++nodes <= 2000000, 'RPC_INVALID_RESPONSE'); const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (own(value, 'error') && value.error !== null) fail('RPC_EXECUTION_ERROR', { rpcCode: Number.isSafeInteger(value.error?.code) ? value.error.code : null });
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
}

/** Read-only transport only; proof, header and chain authenticity are established
 * by the caller. No retry, provider fallback, redirect or moving-state read.
 * Successful UTF-8 bodies are exact; rejected bodies retain sizes/hashes only.
 * A settled managed request may leave an ignored-signal adapter pending. Drain
 * reports that distinction and never waits beyond its explicit finite ceiling. */
export class ProofRpcClient {
  #href; #provider; #fetch; #now; #started; #last; #limits; #secrets; #shortSecrets;
  #pin = null; #closed = null; #evidence = []; #pending = new Set(); #adapters = new Set(); #stops = new Set();
  #observed = 0; #retained = 0; #successful = 0; #dispatched = 0; #rpcMs = 0; #clockValid = true;
  constructor(options = {}) {
    fields(options, ['url', 'fetchImpl', 'now', 'limits'], []);
    const { url = process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', fetchImpl = fetch, now = () => performance.now(), limits = {} } = options;
    need(typeof url === 'string', 'INVALID_RPC_URL'); let endpoint;
    try { endpoint = new URL(url); } catch { fail('INVALID_RPC_URL'); }
    need(['http:', 'https:'].includes(endpoint.protocol), 'INVALID_RPC_URL');
    need(typeof fetchImpl === 'function' && typeof now === 'function');
    fields(limits, Object.keys(PROOF_RPC_LIMITS), [], 'INVALID_RPC_LIMIT'); const fixed = { ...PROOF_RPC_LIMITS };
    for (const [key, value] of Object.entries(limits)) { need(Number.isSafeInteger(value) && value >= 1 && value <= fixed[key], 'INVALID_RPC_LIMIT'); fixed[key] = value; }
    this.#limits = Object.freeze(fixed); this.#href = endpoint.href; this.#provider = endpoint.hostname; this.#fetch = fetchImpl; this.#now = now;
    let start; try { start = now(); } catch { fail('RPC_CLOCK'); } need(finite(start), 'RPC_CLOCK'); this.#started = this.#last = start;
    const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
    this.#secrets = [...new Set([endpoint.href, endpoint.username, endpoint.password, ...endpoint.searchParams.values(), ...endpoint.pathname.split('/')].flatMap(value => [value, decoded(value)]).filter(value => value.length >= 4))];
    // Short explicit credentials still count as secrets. Match whole JSON
    // strings so a one-character credential does not reject every body.
    this.#shortSecrets = [...new Set([endpoint.username, endpoint.password, ...endpoint.searchParams.values()].flatMap(value => [value, decoded(value)]).filter(value => value.length > 0 && value.length < 4))];
  }
  get provider() { return this.#provider; }
  get url() { return new URL(this.#href); }
  get limits() { return this.#limits; }
  get rpcMs() { return this.#rpcMs; }
  #clock() {
    let value; try { value = this.#now(); } catch { /* fixed safe failure below */ }
    if (!finite(value) || value < this.#last) { this.#clockValid = false; this.#stopAll('RPC_CLOCK'); fail('RPC_CLOCK'); }
    this.#last = value; return value;
  }
  #stopAll(code) { this.#closed ??= code; for (const stop of this.#stops) stop(new ProofRpcError(this.#closed)); }
  cancel() { this.#stopAll('RPC_CANCELLED'); }
  pinBlockHash(value) {
    need(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
    const lower = value.toLowerCase(); need(this.#pin === null || this.#pin === lower, 'RPC_PIN_CHANGED'); this.#pin = lower;
  }
  snapshotEvidence() { return structuredClone(this.#evidence); }
  usage() {
    try { this.#clock(); } catch { /* Invalid clock closes dispatch; report the last valid value. */ }
    const elapsedMs = this.#last - this.#started;
    return { calls: this.#evidence.length, dispatched: this.#dispatched, observedBytes: this.#observed, retainedBytes: this.#retained,
      successfulResponseBytes: this.#successful, rpcMs: this.#rpcMs, elapsedMs, remainingWallMs: Math.max(0, this.#limits.wallMs - elapsedMs),
      pending: this.#pending.size, adapterPending: this.#adapters.size, cancelled: this.#closed !== null, cancellationCode: this.#closed,
      clockValid: this.#clockValid, pinnedBlockHash: this.#pin, limits: { ...this.#limits } };
  }
  #track(promise) {
    const tracked = Promise.resolve(promise); this.#adapters.add(tracked);
    tracked.then(() => this.#adapters.delete(tracked), () => this.#adapters.delete(tracked)); return tracked;
  }
  #discard(body) { try { if (typeof body?.cancel === 'function') this.#track(Promise.resolve().then(() => body.cancel())).catch(() => {}); } catch { /* discard is best effort */ } }
  async drain(options = {}) {
    fields(options, ['timeoutMs'], []); const timeoutMs = options.timeoutMs ?? MAX_DRAIN_MS;
    need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_DRAIN_MS, 'INVALID_RPC_LIMIT');
    const start = performance.now(); let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      while (this.#pending.size || this.#adapters.size) {
        const settled = Promise.allSettled([...this.#pending, ...this.#adapters]).then(() => true);
        if (!(await Promise.race([settled, expired])) || performance.now() - start >= timeoutMs) break;
      }
      return { complete: this.#pending.size === 0 && this.#adapters.size === 0, pending: this.#pending.size, adapterPending: this.#adapters.size, durationMs: performance.now() - start, timeoutMs };
    } finally { clearTimeout(timer); }
  }
  async call(method, params = [], options = {}) {
    fields(options, ['signal'], []); const signal = options.signal;
    if (signal !== undefined) { need(signal !== null && typeof signal === 'object' && !types.isProxy(signal) && signal instanceof AbortSignal); try { signalAborted(signal); } catch { fail('RPC_INVALID_INPUT'); } }
    const copied = validateParams(method, params, this.#pin);
    need(!signalAborted(signal), 'RPC_CANCELLED'); if (this.#closed) fail(this.#closed);
    const start = this.#clock();
    need(this.#evidence.length < this.#limits.calls && start - this.#started < this.#limits.wallMs && this.#observed < this.#limits.totalBytes, 'RPC_BUDGET');
    const request = { jsonrpc: '2.0', id: this.#evidence.length + 1, method, params: copied }, requestText = JSON.stringify(request);
    need(Buffer.byteLength(requestText) <= MAX_REQUEST_BYTES);
    const item = { id: request.id, provider: this.#provider, request, requestText, requestBytes: Buffer.byteLength(requestText), requestSha256: hash(requestText), status: 'pending', dispatched: false };
    this.#evidence.push(item);
    const task = this.#perform(item, start, signal); this.#pending.add(task);
    task.then(() => this.#pending.delete(task), () => this.#pending.delete(task)); return task;
  }
  async #perform(item, start, signal) {
    const realStart = performance.now();
    const timeoutMs = Math.max(1, Math.floor(Math.min(this.#limits.requestMs, this.#limits.wallMs - (start - this.#started))));
    const controller = new AbortController(), digest = createHash('sha256'), chunks = [];
    let reader, complete = false, received = 0, kept = 0, sealed = false, stopError = null, rejectStop, timer, externalAbort;
    const stopped = new Promise((_, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    const stop = error => {
      if (sealed || stopError) return; stopError = error; controller.abort(); rejectStop(error);
      if (reader) this.#discard(reader);
    };
    const check = () => {
      if (stopError) throw stopError;
      if (this.#closed) { stop(new ProofRpcError(this.#closed)); throw stopError; }
      const time = this.#clock();
      if (signalAborted(signal)) stop(new ProofRpcError('RPC_CANCELLED'));
      else if (time - start >= timeoutMs || time - this.#started >= this.#limits.wallMs) stop(new ProofRpcError('RPC_TIMEOUT'));
      if (stopError) throw stopError;
    };
    this.#stops.add(stop);
    timer = setTimeout(() => stop(new ProofRpcError('RPC_TIMEOUT')), timeoutMs);
    if (signal !== undefined) { externalAbort = () => stop(new ProofRpcError('RPC_CANCELLED')); addAbort(signal, externalAbort); }
    try {
      check();
      const fetching = this.#track(Promise.resolve().then(() => {
        check(); item.dispatched = true; this.#dispatched++;
        return this.#fetch(new URL(this.#href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: item.requestText, signal: controller.signal, redirect: 'error' });
      }));
      fetching.then(response => { if (sealed || stopError) this.#discard(response?.body); }, () => {}).catch(() => {});
      const response = await Promise.race([fetching, stopped]); check();
      need(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599, 'RPC_INVALID_RESPONSE'); item.httpStatus = response.status;
      need(response.body && typeof response.body.getReader === 'function', 'RPC_INVALID_RESPONSE'); reader = response.body.getReader();
      while (true) {
        check(); const next = await Promise.race([this.#track(Promise.resolve().then(() => reader.read())), stopped]); check();
        need(next && typeof next.done === 'boolean', 'RPC_INVALID_RESPONSE');
        if (next.done) { complete = true; break; }
        need(next.value instanceof Uint8Array, 'RPC_INVALID_RESPONSE');
        const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        received += bytes.length; this.#observed += bytes.length; digest.update(bytes);
        const room = Math.max(0, Math.min(this.#limits.responseBytes - kept, this.#limits.totalBytes - this.#retained));
        const prefix = Buffer.from(bytes.subarray(0, room)); chunks.push(prefix); kept += prefix.length; this.#retained += prefix.length;
        if (received > this.#limits.responseBytes || this.#observed > this.#limits.totalBytes || prefix.length !== bytes.length) {
          stop(new ProofRpcError('RPC_RESPONSE_TOO_LARGE'));
          if (this.#observed > this.#limits.totalBytes) this.#stopAll('RPC_BUDGET');
          throw stopError;
        }
      }
      check(); need(item.httpStatus >= 200 && item.httpStatus < 300, 'RPC_HTTP_ERROR');
      const bytes = Buffer.concat(chunks); let text, payload;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); payload = JSON.parse(text); } catch { fail('RPC_INVALID_RESPONSE'); }
      need(payload && typeof payload === 'object' && !Array.isArray(payload) && payload.jsonrpc === '2.0' && payload.id === item.id && own(payload, 'result') !== own(payload, 'error'), 'RPC_INVALID_RESPONSE');
      if (own(payload, 'error')) fail('RPC_EXECUTION_ERROR', { rpcCode: Number.isSafeInteger(payload.error?.code) ? payload.error.code : null });
      const canonical = JSON.stringify(payload);
      need(!this.#secrets.some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)) || canonical.includes(JSON.stringify(secret).slice(1, -1))), 'RPC_INVALID_RESPONSE');
      need(!this.#shortSecrets.some(secret => canonical.includes(JSON.stringify(secret))), 'RPC_INVALID_RESPONSE');
      nestedError(payload.result); check();
      item.responseText = text; item.status = 'completed'; this.#successful += bytes.length;
      return structuredClone(payload.result);
    } catch (error) {
      const safe = safeError(stopError ?? error);
      item.status = 'failed'; item.error = { code: safe.code, message: safe.message, ...(safe.detail ? { detail: structuredClone(safe.detail) } : {}) }; throw safe;
    } finally {
      sealed = true; clearTimeout(timer); this.#stops.delete(stop);
      if (signal !== undefined) removeAbort(signal, externalAbort);
      if (!complete) { controller.abort(); if (reader && !stopError) this.#discard(reader); }
      const body = Buffer.concat(chunks), durationMs = Math.max(0, this.#last - start, performance.now() - realStart);
      item.transport = { complete, observedBytes: received, retainedPrefixBytes: kept, observedPrefixSha256: digest.digest('hex'), retainedPrefixSha256: hash(body), timeoutMs, durationMs, bodyRetained: own(item, 'responseText') };
      if (complete && received === kept) item.transport.responseSha256 = hash(body);
      this.#rpcMs += durationMs;
    }
  }
}
