// V2 inherits v1 reservations/counters/caps, with a separately frozen client.
// All three endpoints require lossless UTF-8; v1 source/artifacts stay unchanged.
// Collection/cancellation otherwise follows the reviewed v1 client, while the
// official endpoint has a narrower enumeration-only method allowlist.
import { createHash } from 'node:crypto';
import { assertNoProviderErrorResult } from './rpc.js';
import { EvaluationBudget, EvaluationError, EVALUATION_PROVIDERS, safeEvaluationError } from './evaluation-budget.js';
export const V2_PROVIDERS = Object.freeze({ ...EVALUATION_PROVIDERS, official: 'https://rpc.hyperliquid.xyz/evm' });
const OFFICIAL_METHODS = new Set(['eth_chainId', 'eth_getBlockByHash', 'eth_getSystemTxsByBlockHash']);
const ENGINE_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'debug_traceCall', 'debug_traceTransaction', 'debug_traceCallMany', 'eth_simulateV1']);
export class EvaluationBudgetV2 extends EvaluationBudget {
  client(providerId, { phase, caseId = null } = {}) {
    if (!Object.hasOwn(V2_PROVIDERS, providerId)) throw new TypeError('Only the three frozen v2 endpoints are permitted.');
    const methods = providerId === 'official' ? OFFICIAL_METHODS : ENGINE_METHODS;
    const budget = this;
    return {
      provider: new URL(V2_PROVIDERS[providerId]).hostname, rpcMs: 0,
      async verifyChain() {
        const chain = await this.call('eth_chainId', []);
        if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 999n) throw new EvaluationError('RPC_CHAIN_MISMATCH');
      },
      async call(method, params = []) {
        if (!methods.has(method)) throw new EvaluationError('METHOD_NOT_ALLOWED');
        budget.reserve(caseId);
        const id = budget.rpcCount, start = budget.now(), controller = new AbortController();
        const record = { id, provider: providerId, endpoint: V2_PROVIDERS[providerId], phase, caseId, startedAt: new Date(start).toISOString(), request: { jsonrpc: '2.0', id, method, params: structuredClone(params) }, responseBytes: 0 };
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
          const response = await budget.fetchImpl(V2_PROVIDERS[providerId], { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record.request), signal: controller.signal });
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
          record.responseSha256 = finishHash();
          let raw;
          try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
          catch { throw new EvaluationError('RPC_INVALID_RESPONSE'); }
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
