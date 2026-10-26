import { performance } from 'node:perf_hooks';
import { DEFAULT_RPC_URL } from './config.js';

const READ_METHODS = new Set([
  'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call',
  'debug_traceCall', 'debug_traceTransaction', 'debug_traceCallMany', 'eth_simulateV1',
]);

export class RpcError extends Error {
  constructor(message, code = 'RPC_ERROR', detail = null) { super(message); this.code = code; this.detail = detail; }
}

function providerExecutionError(error) {
  // Provider messages/data can echo credential-bearing URLs or request headers.
  // Classify locally, but expose only fixed descriptions and a numeric RPC code.
  const message = typeof error?.message === 'string' ? error.message.slice(0, 2000).toLowerCase() : '';
  const rpcCode = Number.isSafeInteger(error?.code) ? error.code : null;
  let description = 'The tracing provider rejected the RPC request.';
  if (rpcCode === -32601) description = 'The tracing provider does not support the requested RPC method.';
  else if (rpcCode === -32602) description = 'The tracing provider rejected the RPC parameters.';
  else if (/historical state|missing trie|pruned|state unavailable|header not found/.test(message)) description = 'The tracing provider does not have the requested historical state.';
  else if (/rate limit|too many requests/.test(message)) description = 'The tracing provider rate limit was reached.';
  else if (/timeout|timed out/.test(message)) description = 'The tracing provider timed out while executing the request.';
  else if (/insufficient funds/.test(message)) description = 'RPC execution was rejected for insufficient native balance.';
  else if (/execution reverted|revert/.test(message)) description = 'RPC execution reverted before a complete trace was returned.';
  return new RpcError(description, 'RPC_EXECUTION_ERROR', { rpcCode });
}

// Some tracing providers nest RPC errors inside a successful result envelope.
// Reject those before callers can persist raw results. A real EVM call frame's
// string error/revertReason and return data remain public execution evidence.
export function assertNoProviderErrorResult(method, result) {
  const traces = ['debug_traceCall', 'debug_traceTransaction', 'debug_traceCallMany'].includes(method);
  const stack = [{ value: result, arrayDepth: method === 'debug_traceCallMany' ? 2 : 0 }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 20000) throw new RpcError('RPC result exceeds the error-validation limit.', 'RPC_INVALID_RESPONSE');
    const { value, arrayDepth } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (arrayDepth > 0) for (const item of value) stack.push({ value: item, arrayDepth: arrayDepth - 1 });
      continue;
    }
    if (Object.hasOwn(value, 'error') && value.error !== null && value.error !== undefined) {
      const identifiedFrame = traces && typeof value.type === 'string'
        && ['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(value.type)
        && typeof value.from === 'string' && /^0x[0-9a-f]{40}$/i.test(value.from)
        && (value.to === undefined || (typeof value.to === 'string' && /^0x[0-9a-f]{40}$/i.test(value.to)));
      if (typeof value.error !== 'string' || !identifiedFrame) {
        // Error text can contain credentials; only the local classification and
        // bounded numeric code leave this function.
        throw providerExecutionError(typeof value.error === 'object' ? value.error : null);
      }
    }
    if (traces && Array.isArray(value.calls)) for (const child of value.calls) stack.push({ value: child, arrayDepth: 0 });
  }
}

export class RpcClient {
  constructor({ url = process.env.HYPEREVM_RPC_URL || DEFAULT_RPC_URL, fetchImpl = fetch, timeoutMs = 25000 } = {}) {
    try { this.url = new URL(url); }
    catch { throw new RpcError('RPC URL is invalid.', 'INVALID_RPC_URL'); }
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new RpcError('RPC URL must use HTTP or HTTPS.', 'INVALID_RPC_URL');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.rpcMs = 0;
  }
  get provider() { return this.url.hostname; }
  async call(method, params = []) {
    if (!READ_METHODS.has(method)) throw new RpcError('Only configured read-only RPC methods are permitted.', 'METHOD_NOT_ALLOWED');
    const id = this.nextId++;
    const start = performance.now();
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new RpcError(`RPC returned HTTP ${response.status}.`, 'RPC_HTTP_ERROR');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) throw new RpcError('RPC response exceeds the 16 MiB limit.', 'RPC_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RpcError('RPC returned invalid JSON.', 'RPC_INVALID_RESPONSE'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.id !== id || payload.jsonrpc !== '2.0') throw new RpcError('RPC response ID or version is invalid.', 'RPC_INVALID_RESPONSE');
      if (payload.error) throw providerExecutionError(payload.error);
      if (!Object.hasOwn(payload, 'result')) throw new RpcError('RPC response has no result.', 'RPC_INVALID_RESPONSE');
      assertNoProviderErrorResult(method, payload.result);
      return payload.result;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new RpcError('The tracing provider timed out.', 'RPC_TIMEOUT');
      throw new RpcError('Unable to reach the tracing provider.', 'RPC_CONNECTION_ERROR');
    } finally { this.rpcMs += performance.now() - start; }
  }
  async verifyChain() {
    const chain = await this.call('eth_chainId');
    if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 999n) throw new RpcError('The configured RPC is not HyperEVM chain 999.', 'RPC_CHAIN_MISMATCH');
  }
}

export function normalizeBlock(block) {
  if (!block || !/^0x[0-9a-f]{64}$/i.test(block.hash || '') || !/^0x[0-9a-f]+$/i.test(block.number || '') || !/^0x[0-9a-f]+$/i.test(block.timestamp || '')) {
    throw new RpcError('The requested block is unavailable or malformed.', 'BLOCK_UNAVAILABLE');
  }
  return { number: BigInt(block.number).toString(), hash: block.hash.toLowerCase(), timestamp: BigInt(block.timestamp).toString() };
}
