import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RpcError, assertNoProviderErrorResult } from './rpc.js';

export const STANDARD_RPC_LIMITS = Object.freeze({ calls: 65, responseBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, wallMs: 145000, requestMs: 25000 });
export const STANDARD_SEQUENCE_RPC_LIMITS = Object.freeze({ calls: 258, responseBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, wallMs: 265000, requestMs: 25000 });
const METHODS = new Set(['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'debug_traceCall']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code, detail = null) => { throw new RpcError(message, code, detail); };

/** Bounded read-only transport. Successful response bytes are retained as
 * strict UTF-8 text; rejected/error bodies retain hashes and sizes only. */
export class StandardRpcClient {
  constructor({ url = process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', fetchImpl = fetch, now = () => performance.now(), limits = {}, profile = 'single' } = {}) {
    try { this.url = new URL(url); } catch { fail('Ethereum RPC URL is invalid.', 'INVALID_RPC_URL'); }
    if (!['http:', 'https:'].includes(this.url.protocol)) fail('Ethereum RPC URL must use HTTP or HTTPS.', 'INVALID_RPC_URL');
    if (!['single', 'sequence'].includes(profile)) fail('Invalid RPC resource profile.', 'INVALID_RPC_PROFILE');
    this.limits = { ...(profile === 'sequence' ? STANDARD_SEQUENCE_RPC_LIMITS : STANDARD_RPC_LIMITS) };
    for (const [key, value] of Object.entries(limits)) {
      if (!Object.hasOwn(this.limits, key) || !Number.isSafeInteger(value) || value < 1 || value > this.limits[key]) fail('Invalid RPC resource limit.', 'INVALID_RPC_LIMIT');
      this.limits[key] = value;
    }
    this.fetchImpl = fetchImpl; this.now = now; this.started = null; this.rpcMs = 0;
    this.evidence = []; this.observedBytes = 0; this.retainedBytes = 0;
    const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
    const sensitive = [this.url.href, this.url.username, this.url.password, ...this.url.searchParams.values(), ...this.url.pathname.split('/')];
    this.secrets = [...new Set(sensitive.flatMap(value => [value, decoded(value)]).filter(value => value.length >= 4))];
  }
  get provider() { return this.url.hostname; }
  snapshotEvidence() { return structuredClone(this.evidence); }
  async call(method, params = []) {
    if (!METHODS.has(method)) fail('Only configured read-only Ethereum RPC methods are permitted.', 'METHOD_NOT_ALLOWED');
    const start = this.now(); this.started ??= start;
    if (this.evidence.length >= this.limits.calls || start - this.started >= this.limits.wallMs || this.observedBytes >= this.limits.totalBytes) fail('Ethereum RPC resource budget was exhausted.', 'RPC_BUDGET');
    const request = { jsonrpc: '2.0', id: this.evidence.length + 1, method, params: structuredClone(params) };
    const requestText = JSON.stringify(request);
    const item = { id: request.id, provider: this.provider, request, requestText, requestBytes: Buffer.byteLength(requestText), requestSha256: hash(requestText) };
    this.evidence.push(item);
    const timeoutMs = Math.max(1, Math.min(this.limits.requestMs, this.limits.wallMs - (start - this.started)));
    const controller = new AbortController();
    let timer;
    // Race every pending read as well as fetch. A transport implementation that
    // ignores AbortSignal must not retain this request or mutate its evidence
    // when a late response eventually arrives.
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RpcError('The Ethereum RPC request timed out.', 'RPC_TIMEOUT')); }, timeoutMs);
    });
    const expired = () => controller.signal.aborted || this.now() - start >= timeoutMs || this.now() - this.started >= this.limits.wallMs;
    let reader, complete = false, received = 0, kept = 0;
    const digest = createHash('sha256'), chunks = [];
    try {
      const fetching = Promise.resolve(this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText, signal: controller.signal, redirect: 'error' }));
      fetching.then(response => {
        if (controller.signal.aborted) { try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {} }
      }).catch(() => {});
      const response = await Promise.race([fetching, deadline]);
      item.httpStatus = response.status;
      if (!response.body) fail('Ethereum RPC returned no response body.', 'RPC_INVALID_RESPONSE');
      reader = response.body.getReader();
      while (true) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next.done) { complete = true; break; }
        const bytes = Buffer.from(next.value); received += bytes.length; this.observedBytes += bytes.length; digest.update(bytes);
        const room = Math.max(0, Math.min(this.limits.responseBytes - kept, this.limits.totalBytes - this.retainedBytes));
        const prefix = bytes.subarray(0, room); chunks.push(prefix); kept += prefix.length; this.retainedBytes += prefix.length;
        if (prefix.length !== bytes.length) fail('Ethereum RPC response exceeded its byte budget.', 'RPC_RESPONSE_TOO_LARGE');
        if (expired()) fail('The Ethereum RPC request timed out.', 'RPC_TIMEOUT');
      }
      if (expired()) fail('The Ethereum RPC request timed out.', 'RPC_TIMEOUT');
      if (!response.ok) fail('Ethereum RPC returned an unsuccessful HTTP status.', 'RPC_HTTP_ERROR', { httpStatus: response.status });
      const bytes = Buffer.concat(chunks);
      let text, payload;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); payload = JSON.parse(text); }
      catch { fail('Ethereum RPC returned invalid UTF-8 JSON.', 'RPC_INVALID_RESPONSE'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.jsonrpc !== '2.0' || payload.id !== request.id || Object.hasOwn(payload, 'result') === Object.hasOwn(payload, 'error')) fail('Ethereum RPC response envelope is invalid.', 'RPC_INVALID_RESPONSE');
      if (Object.hasOwn(payload, 'error')) fail('The Ethereum provider rejected the read-only RPC request.', 'RPC_EXECUTION_ERROR', { rpcCode: Number.isSafeInteger(payload.error?.code) ? payload.error.code : null });
      const canonical = JSON.stringify(payload);
      if (this.secrets.some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)) || canonical.includes(JSON.stringify(secret).slice(1, -1)))) fail('Ethereum RPC response contained private provider configuration.', 'RPC_INVALID_RESPONSE');
      assertNoProviderErrorResult(method, payload.result);
      if (expired()) fail('The Ethereum RPC request timed out.', 'RPC_TIMEOUT');
      item.responseText = text;
      return payload.result;
    } catch (error) {
      const safe = error instanceof RpcError ? error : new RpcError(controller.signal.aborted ? 'The Ethereum RPC request timed out.' : 'Unable to reach the Ethereum tracing provider.', controller.signal.aborted ? 'RPC_TIMEOUT' : 'RPC_CONNECTION_ERROR');
      item.error = { code: safe.code, message: safe.message, ...(safe.detail ? { detail: safe.detail } : {}) };
      throw safe;
    } finally {
      clearTimeout(timer);
      if (!complete) { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }
      const body = Buffer.concat(chunks);
      item.transport = { complete, observedBytes: received, retainedPrefixBytes: kept, observedPrefixSha256: digest.digest('hex'), retainedPrefixSha256: hash(body), timeoutMs, durationMs: Math.max(0, this.now() - start), bodyRetained: item.responseText !== undefined };
      if (complete && received === kept) item.transport.responseSha256 = hash(body);
      this.rpcMs += item.transport.durationMs;
    }
  }
}
