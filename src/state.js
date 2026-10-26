// Read-only reconstruction of one unsigned call's post-state at a pinned block.
// No methods in this module sign, submit, or persist a blockchain transaction.
export const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const CODE = /^0x(?:[0-9a-f]{2})*$/i;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
export const uint = value => typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? BigInt(value) : (Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null);
export const hex = value => `0x${BigInt(value).toString(16)}`;

export class StateValidationError extends Error {}
export function failState(message) { throw new StateValidationError(message); }
export function stateErrorDescription(error) {
  return error instanceof StateValidationError ? error.message : 'An unexpected state measurement failure occurred.';
}

function publicRpcFailure(error) {
  const descriptions = {
    RPC_TIMEOUT: 'The state measurement provider timed out.',
    RPC_CONNECTION_ERROR: 'The state measurement provider could not be reached.',
    RPC_HTTP_ERROR: 'The state measurement provider returned an HTTP error.',
    RPC_EXECUTION_ERROR: 'The state measurement provider rejected a read-only RPC request.',
    RPC_INVALID_RESPONSE: 'The state measurement provider returned an invalid response.',
    RPC_RESPONSE_TOO_LARGE: 'The state measurement response exceeded its size limit.',
    METHOD_NOT_ALLOWED: 'The state measurement RPC method is not enabled.',
  };
  const code = Object.hasOwn(descriptions, error?.code) ? error.code : 'RPC_ERROR';
  return { code, message: descriptions[code] ?? 'The state measurement RPC request failed.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}

export function buildStateOverrides(diff) {
  if (!isObject(diff?.pre) || !isObject(diff?.post)) failState('Provider returned no valid pre/post state diff.');
  const beforeAccounts = Object.keys(diff.pre);
  const afterAccounts = Object.keys(diff.post);
  if (beforeAccounts.some(account => !Object.hasOwn(diff.post, account)) || afterAccounts.some(account => !Object.hasOwn(diff.pre, account))) failState('Account creation or deletion is outside this state measurement adapter.');
  if (beforeAccounts.length > 100) failState('State diff exceeds the configured 100-account measurement limit.');
  const overrides = {};
  let totalSlots = 0;
  for (const account of beforeAccounts) {
    if (!ADDRESS.test(account)) failState('State diff contains an invalid account address.');
    const pre = diff.pre[account];
    const post = diff.post[account];
    if (!isObject(pre) || !isObject(post)) failState('State diff contains an invalid account record.');
    for (const record of [pre, post]) {
      if (record.code !== undefined && (typeof record.code !== 'string' || !CODE.test(record.code))) failState('State diff contains malformed contract code.');
      for (const field of ['balance', 'nonce']) {
        const maximum = field === 'nonce' ? (1n << 64n) - 1n : UINT256_MAX;
        if (record[field] !== undefined && (uint(record[field]) === null || uint(record[field]) > maximum)) failState(`State diff contains malformed ${field}.`);
      }
      if (record.storage !== undefined && !isObject(record.storage)) failState('State diff contains malformed storage.');
    }
    if (post.code !== undefined && lower(post.code) !== lower(pre.code)) failState('Contract code changes are outside this state measurement adapter.');
    const override = {};
    for (const field of ['balance', 'nonce']) if (post[field] !== undefined) override[field] = hex(post[field]);
    const before = pre.storage ?? {};
    const after = post.storage ?? {};
    const slots = new Set([...Object.keys(before), ...Object.keys(after)]);
    totalSlots += slots.size;
    if (totalSlots > 2000) failState('State diff exceeds the configured 2000-slot measurement limit.');
    if (slots.size) {
      override.stateDiff = {};
      for (const slot of slots) {
        if (!WORD.test(slot) || (before[slot] !== undefined && (typeof before[slot] !== 'string' || !WORD.test(before[slot]))) || (after[slot] !== undefined && (typeof after[slot] !== 'string' || !WORD.test(after[slot])))) failState('State diff contains malformed storage slots.');
        // pre-only slots were cleared; stateDiff preserves all untouched slots.
        override.stateDiff[slot] = after[slot] ?? ZERO_WORD;
      }
    }
    if (Object.keys(override).length) overrides[account] = override;
  }
  // An empty diff is meaningful: an already-current approval may change nothing.
  return overrides;
}

function identityKey(request, block) {
  return JSON.stringify({ chainId: uint(request?.chainId)?.toString() ?? null, from: lower(request?.from), to: lower(request?.to), data: lower(request?.data), value: uint(request?.value)?.toString() ?? null, number: uint(block?.number)?.toString() ?? null, hash: lower(block?.hash), timestamp: uint(block?.timestamp)?.toString() ?? null });
}

/** Lazy, shareable state context. Creating it performs no RPC requests. */
export function createStateContext({ request, block, rpc }) {
  const boundRequest = structuredClone(request);
  const boundBlock = structuredClone(block);
  const key = identityKey(boundRequest, boundBlock);
  const evidence = { request: [], response: [] };
  let preparation;
  let pinned;
  let overrides;
  let executionIdentity;
  let canonicalFailure = null;
  async function call(method, params) {
    const evidenceId = evidence.request.length + 1;
    evidence.request.push({ id: evidenceId, method, params: structuredClone(params) });
    try {
      const result = await rpc.call(method, params);
      evidence.response.push({ id: evidenceId, method, result: structuredClone(result) });
      return result;
    } catch (error) {
      const publicError = publicRpcFailure(error);
      evidence.response.push({ id: evidenceId, method, error: publicError });
      throw new StateValidationError(publicError.message);
    }
  }
  async function prepare() {
    if (!preparation) preparation = (async () => {
      if (!WORD.test(boundBlock?.hash ?? '') || uint(boundBlock?.number) === null || uint(boundBlock?.timestamp) === null) failState('A complete pinned block identity is required for state measurement.');
      if (!ADDRESS.test(boundRequest?.from ?? '') || !ADDRESS.test(boundRequest?.to ?? '') || typeof boundRequest.data !== 'string' || !CODE.test(boundRequest.data) || uint(boundRequest.value) === null || uint(boundRequest.value) > UINT256_MAX) failState('A valid unsigned call is required for state measurement.');
      pinned = { blockHash: boundBlock.hash.toLowerCase(), requireCanonical: true };
      const header = await call('eth_getBlockByHash', [boundBlock.hash, false]);
      if (lower(header?.hash) !== pinned.blockHash || uint(header?.number) !== uint(boundBlock.number) || uint(header?.timestamp) !== uint(boundBlock.timestamp)) failState('Provider block header does not match the pinned execution identity.');
      const tx = { from: lower(boundRequest.from), to: lower(boundRequest.to), data: boundRequest.data, value: hex(boundRequest.value), gas: '0x4c4b40' };
      const diff = await call('debug_traceCall', [tx, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
      overrides = buildStateOverrides(diff);
      executionIdentity = { stateBlockHash: pinned.blockHash, blockNumber: uint(boundBlock.number).toString(), timestamp: uint(boundBlock.timestamp).toString(), stateBinding: 'block_hash', headerContext: 'unchanged', method: 'debug_traceCall/prestateTracer + eth_call/stateDiff' };
    })();
    return preparation;
  }
  return {
    matches(candidate) { return candidate.rpc === rpc && identityKey(candidate.request, candidate.block) === key; },
    prepare,
    async readPair(query) {
      await prepare();
      if (!ADDRESS.test(query?.to ?? '') || typeof query.data !== 'string' || !CODE.test(query.data)) failState('A valid token state query is required.');
      const tx = { from: lower(boundRequest.from), to: lower(query.to), data: query.data, gas: '0x493e0' };
      const before = await call('eth_call', [tx, pinned]);
      const after = await call('eth_call', [tx, pinned, overrides]);
      if (typeof before !== 'string' || typeof after !== 'string' || !WORD.test(before) || !WORD.test(after)) failState('Token state query did not return exactly one uint256 word.');
      return { before: BigInt(before), after: BigInt(after), delta: BigInt(after) - BigInt(before) };
    },
    async verifyCanonical() {
      try {
        await prepare();
        const confirmed = await call('eth_getBlockByNumber', [hex(boundBlock.number), false]);
        if (lower(confirmed?.hash) !== pinned.blockHash || uint(confirmed?.number) !== uint(boundBlock.number) || uint(confirmed?.timestamp) !== uint(boundBlock.timestamp)) failState('The pinned block is no longer canonical; no measured result is returned.');
      } catch (error) {
        // All consumers share this binding. A later successful check cannot
        // erase a failure observed while another consumer was still running.
        canonicalFailure ??= stateErrorDescription(error);
        throw error;
      }
    },
    snapshotEvidence() { return structuredClone(evidence); },
    get canonicalFailure() { return canonicalFailure; },
    get executionIdentity() { return executionIdentity ? structuredClone(executionIdentity) : null; },
  };
}
