import { createHash } from 'node:crypto';
import { assertNoProviderErrorResult } from './rpc.js';

export const EVALUATION_PROVIDERS = Object.freeze({ A: 'https://hyperliquid.drpc.org', B: 'https://rpc.hyperlend.finance/archive' });
export const EVALUATION_LIMITS = Object.freeze({ attempts: 16, perTransactionRpc: 128, totalRpc: 2048, totalResponseBytes: 128 * 1024 * 1024, responseBytes: 8 * 1024 * 1024, requestMs: 25000, wallMs: 20 * 60 * 1000, oraclePairs: 8 });
const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'debug_traceCall', 'debug_traceTransaction', 'debug_traceCallMany', 'eth_simulateV1']);
const SAFE_CODES = new Set(['METHOD_NOT_ALLOWED', 'RPC_CHAIN_MISMATCH', 'RPC_EXECUTION_ERROR', 'RPC_INVALID_RESPONSE', 'RPC_HTTP_ERROR', 'RPC_CONNECTION_ERROR', 'RPC_TIMEOUT', 'BUDGET_WALL', 'BUDGET_TOTAL_RPC', 'BUDGET_TRANSACTION_RPC', 'BUDGET_TOTAL_BYTES', 'BUDGET_RESPONSE_BYTES']);
export class EvaluationError extends Error {
  constructor(code) { super(`Evaluation request did not complete (${code}).`); this.code = code; }
}
export function safeEvaluationError(error) {
  return { code: SAFE_CODES.has(error?.code) ? error.code : 'UNAVAILABLE', message: 'The bounded evaluation operation did not complete; provider exception text is not retained.' };
}
export function boundedLimits(overrides = {}) {
  const limits = { ...EVALUATION_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new TypeError('Evaluation limits may only be reduced from the preregistered limits.');
    limits[name] = value;
  }
  return Object.freeze(limits);
}

/** One shared transport covers selection, every engine-internal call, and the comparator. */
export class EvaluationBudget {
  constructor({ t0, limits = {}, fetchImpl = fetch, now = Date.now } = {}) {
    if (!Number.isFinite(t0)) throw new TypeError('A frozen T0 is required.');
    this.t0 = t0; this.limits = boundedLimits(limits); this.fetchImpl = fetchImpl; this.now = now;
    this.records = []; this.rpcCount = 0; this.responseBytes = 0; this.transactionCounts = new Map();
    this.active = new Set(); this.exhaustion = null; this.idleWaiters = [];
  }
  snapshot() {
    return { rpcCount: this.rpcCount, responseBytes: this.responseBytes, elapsedMs: Math.max(0, this.now() - this.t0), transactionRpc: Object.fromEntries(this.transactionCounts), exhaustion: this.exhaustion, limits: this.limits };
  }
  exhausted() {
    if (this.now() - this.t0 >= this.limits.wallMs) return 'BUDGET_WALL';
    if (this.exhaustion) return this.exhaustion;
    if (this.rpcCount >= this.limits.totalRpc) return 'BUDGET_TOTAL_RPC';
    if (this.responseBytes >= this.limits.totalResponseBytes) return 'BUDGET_TOTAL_BYTES';
    return null;
  }
  reserve(caseId) {
    const exhausted = this.exhausted();
    if (exhausted) throw new EvaluationError(exhausted);
    const count = this.transactionCounts.get(caseId) ?? 0;
    if (caseId && count >= this.limits.perTransactionRpc) throw new EvaluationError('BUDGET_TRANSACTION_RPC');
    // This reservation happens synchronously, before the first await: concurrent
    // product calls cannot each spend the same final RPC slot.
    this.rpcCount++;
    if (caseId) this.transactionCounts.set(caseId, count + 1);
  }
  cancelAll(code) {
    this.exhaustion ??= code;
    for (const controller of this.active) controller.abort(new EvaluationError(code));
  }
  async waitForIdle() {
    if (this.active.size) await new Promise(resolve => this.idleWaiters.push(resolve));
  }
  client(providerId, { phase, caseId = null } = {}) {
    if (!Object.hasOwn(EVALUATION_PROVIDERS, providerId)) throw new TypeError('Only the two frozen public endpoints are permitted.');
    const budget = this;
    return {
      provider: new URL(EVALUATION_PROVIDERS[providerId]).hostname, rpcMs: 0,
      async verifyChain() {
        const chain = await this.call('eth_chainId', []);
        if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 999n) throw new EvaluationError('RPC_CHAIN_MISMATCH');
      },
      async call(method, params = []) {
        if (!METHODS.has(method)) throw new EvaluationError('METHOD_NOT_ALLOWED');
        budget.reserve(caseId);
        const id = budget.rpcCount, start = budget.now(), controller = new AbortController();
        const record = { id, provider: providerId, endpoint: EVALUATION_PROVIDERS[providerId], phase, caseId, startedAt: new Date(start).toISOString(), request: { jsonrpc: '2.0', id, method, params: structuredClone(params) }, responseBytes: 0 };
        budget.records.push(record); budget.active.add(controller);
        let reader, timer, rawHash = createHash('sha256'), complete = false, closed = false, digest;
        const finishHash = () => digest ??= rawHash.digest('hex');
        const cancelReader = candidate => { try { void candidate?.cancel().catch(() => {}); } catch {} };
        const timeout = Math.max(1, Math.min(budget.limits.requestMs, budget.t0 + budget.limits.wallMs - start));
        const checkDeadline = () => {
          if (budget.now() >= budget.t0 + budget.limits.wallMs) { budget.cancelAll('BUDGET_WALL'); throw new EvaluationError('BUDGET_WALL'); }
          if (budget.now() >= start + budget.limits.requestMs) { controller.abort(new EvaluationError('RPC_TIMEOUT')); throw new EvaluationError('RPC_TIMEOUT'); }
        };
        const operation = async () => {
          const response = await budget.fetchImpl(EVALUATION_PROVIDERS[providerId], { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record.request), signal: controller.signal });
          if (closed || controller.signal.aborted) {
            // A custom fetch may ignore AbortSignal and finish after timeout.
            // It must not mutate already sealed records or retain a body.
            try { cancelReader(response.body?.getReader()); } catch {}
            throw new EvaluationError('RPC_TIMEOUT');
          }
          record.httpStatus = response.status;
          if (!response.body?.getReader) throw new EvaluationError('RPC_INVALID_RESPONSE');
          reader = response.body.getReader();
          checkDeadline();
          const chunks = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (closed || controller.signal.aborted) { cancelReader(reader); throw new EvaluationError('RPC_TIMEOUT'); }
            if (done) { checkDeadline(); break; }
            const chunk = Buffer.from(value);
            record.responseBytes += chunk.length; budget.responseBytes += chunk.length; rawHash.update(chunk);
            checkDeadline();
            if (budget.responseBytes > budget.limits.totalResponseBytes) {
              budget.cancelAll('BUDGET_TOTAL_BYTES'); throw new EvaluationError('BUDGET_TOTAL_BYTES');
            }
            if (record.responseBytes > budget.limits.responseBytes) {
              controller.abort(new EvaluationError('BUDGET_RESPONSE_BYTES')); throw new EvaluationError('BUDGET_RESPONSE_BYTES');
            }
            chunks.push(chunk);
          }
          complete = true;
          const raw = Buffer.concat(chunks).toString('utf8');
          record.responseSha256 = finishHash();
          if (!response.ok) throw new EvaluationError('RPC_HTTP_ERROR');
          let payload;
          try { payload = JSON.parse(raw); } catch { throw new EvaluationError('RPC_INVALID_RESPONSE'); }
          if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || payload.id !== id || !Object.hasOwn(payload, 'result')) throw new EvaluationError(payload?.error ? 'RPC_EXECUTION_ERROR' : 'RPC_INVALID_RESPONSE');
          if (Object.hasOwn(payload, 'error')) throw new EvaluationError('RPC_EXECUTION_ERROR');
          assertNoProviderErrorResult(method, payload.result);
          // Only validated successful JSON-RPC bodies are retained verbatim.
          // HTTP and provider error bodies are budgeted and hashed, but their
          // arbitrary text may contain credentials and is deliberately omitted.
          const result = structuredClone(payload.result);
          checkDeadline();
          record.responseRaw = raw; record.response = payload;
          return result;
        };
        try {
          return await Promise.race([operation(), new Promise((_, reject) => {
            timer = setTimeout(() => { const code = budget.now() >= budget.t0 + budget.limits.wallMs ? 'BUDGET_WALL' : 'RPC_TIMEOUT'; controller.abort(new EvaluationError(code)); reject(new EvaluationError(code)); }, timeout);
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new EvaluationError('RPC_TIMEOUT')), { once: true });
          })]);
        } catch (error) {
          record.error = safeEvaluationError(error);
          record.bodyRetained = false;
          if (!complete) { record.observedPrefixSha256 = finishHash(); record.bodyComplete = false; }
          else record.bodyComplete = true;
          throw new EvaluationError(record.error.code);
        } finally {
          closed = true;
          clearTimeout(timer); budget.active.delete(controller);
          // Cancel collection without awaiting a misbehaving provider stream.
          if (record.error) { controller.abort(); cancelReader(reader); }
          const end = budget.now(); this.rpcMs += Math.max(0, end - start);
          record.completedAt = new Date(end).toISOString(); record.elapsedMs = Math.max(0, end - start);
          if (!budget.active.size) for (const resolve of budget.idleWaiters.splice(0)) resolve();
        }
      },
    };
  }
}
