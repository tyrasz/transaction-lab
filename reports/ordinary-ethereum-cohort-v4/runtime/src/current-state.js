// Validated, isolated token reads around one unsigned call. This is an explicitly
// synthetic unpriced environment (BASEFEE=0), not a signed-transaction replay.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CHAIN_ID } from './config.js';
import { assertNoProviderErrorResult } from './rpc.js';
import { buildStateOverrides, failState, hex, StateValidationError, stateErrorDescription, uint, UINT256_MAX } from './state.js';
import { canonicalStateDiff } from './state-diff.js';
import { assertReadOnlyFrame, normalizeTokenQuery, semanticTrace, validateTokenQueryTrace } from './query-validation.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const PROBE = '0x000000000000000000000000000000000000ba1a';
const MAX_NONCE = (1n << 64n) - 1n;
const MAX_PAIRS = 12, MAX_CALLS = 64, CANONICAL_RESERVE = 3;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024, MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_MS = 120000, MAX_INFLIGHT_RPC_MS = 25000;
const DEADLINE_MESSAGE = 'Current state measurement exceeded its 120-second context deadline.';
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const isAddress = value => typeof value === 'string' && ADDRESS.test(value);
const isWord = value => typeof value === 'string' && WORD.test(value);
const bytes = value => typeof value === 'string' && BYTES.test(value);
const quantity = (value, maximum = UINT256_MAX) => { const parsed = uint(value); return parsed !== null && parsed <= maximum ? parsed : null; };
const failed = frame => Boolean(frame.error || frame.revertReason);
const hasLifecycle = frame => ['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) || frame.calls.some(hasLifecycle);
const usesProbe = frame => frame.from === PROBE || frame.to === PROBE || frame.calls.some(usesProbe);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tracer = kind => ({ tracer: kind === 'trace' ? 'callTracer' : 'prestateTracer', timeout: '15s', tracerConfig: kind === 'trace' ? { withLog: true } : { diffMode: true } });
function identityKey(request, block) {
  return JSON.stringify({ chainId: uint(request?.chainId)?.toString() ?? null, from: lower(request?.from), to: lower(request?.to), data: lower(request?.data), value: uint(request?.value)?.toString() ?? null, number: uint(block?.number)?.toString() ?? null, hash: lower(block?.hash), timestamp: uint(block?.timestamp)?.toString() ?? null });
}
function rpcFailure(error) {
  const known = new Set(['RPC_TIMEOUT', 'RPC_CONNECTION_ERROR', 'RPC_HTTP_ERROR', 'RPC_EXECUTION_ERROR', 'RPC_INVALID_RESPONSE', 'RPC_RESPONSE_TOO_LARGE', 'METHOD_NOT_ALLOWED']);
  return { code: known.has(error?.code) ? error.code : 'RPC_ERROR', message: 'The current state provider failed a read-only RPC request.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}
function headerIdentity(header) {
  if (!header || !isWord(header.hash) || !isWord(header.parentHash) || !isWord(header.mixHash) || !isAddress(header.miner) || ['number', 'timestamp', 'gasLimit', 'baseFeePerGas'].some(field => quantity(header[field]) === null) || uint(header.gasLimit) === 0n) failState('Current state header is incomplete or malformed.');
  return { hash: lower(header.hash), parentHash: lower(header.parentHash), mixHash: lower(header.mixHash), miner: lower(header.miner), ...Object.fromEntries(['number', 'timestamp', 'gasLimit', 'baseFeePerGas'].map(field => [field, uint(header[field]).toString()])) };
}

function assertQueryDiff(raw, sender, nonce, balance) {
  const diff = canonicalStateDiff(raw);
  // Require the observed nonce-only profile, including its absolute starting
  // balance. Missing post.balance is the tracer's unchanged-basic-field form.
  if (Object.keys(diff.pre).length !== 1 || Object.keys(diff.post).length !== 1 || !diff.pre[sender] || !diff.post[sender]) failState('Current state query changed accounts outside its sender nonce.');
  const pre = diff.pre[sender], post = diff.post[sender];
  if (Object.keys(pre).some(field => !['balance', 'nonce'].includes(field)) || Object.keys(post).some(field => !['balance', 'nonce'].includes(field))) failState('Current state query changed code or storage outside its sender nonce.');
  if (quantity(pre.nonce, MAX_NONCE) !== nonce || quantity(post.nonce, MAX_NONCE) !== nonce + 1n) failState('Current state query returned unexpected sender nonce effects.');
  if (quantity(pre.balance) !== balance || (post.balance !== undefined && quantity(post.balance) !== balance)) failState('Current state query returned unexpected native balance effects.');
}

/** Lazy shared context. The caller must obtain trace using this exact original
 * envelope and canonical EIP-1898 hash; a trace object contains no block selector.
 * Address/path validation is not runtime bytecode or source-code attestation. */
export function createVerifiedCurrentStateContext({ request, block, rpc, trace, now = () => performance.now() }) {
  const req = structuredClone(request), boundBlock = structuredClone(block), originalTrace = structuredClone(trace);
  const key = identityKey(req, boundBlock), evidence = { request: [], response: [] }, pairs = new Map();
  let preparation, pinned, header, overrides, senderNonce, senderBalance, afterNonce, afterBalance, executionIdentity;
  let evidenceBytes = 0, canonicalFailure = null, startedAt, deadlineFailure = false;
  function checkDeadline() {
    const current = now();
    startedAt ??= current;
    if (deadlineFailure || current - startedAt >= MAX_CONTEXT_MS) {
      deadlineFailure = true;
      canonicalFailure ??= DEADLINE_MESSAGE;
      failState(DEADLINE_MESSAGE);
    }
  }
  function afterAwaitDeadline(id, method) {
    try { checkDeadline(); }
    catch (error) {
      evidence.response.push({ id, method, error: { code: 'STATE_CONTEXT_TIMEOUT', message: DEADLINE_MESSAGE } });
      throw error;
    }
  }
  async function call(method, params, canonical = false) {
    checkDeadline();
    // Normal reads cannot consume the final slots needed by three consumers.
    if (evidence.request.length >= MAX_CALLS - (canonical ? 0 : CANONICAL_RESERVE)) failState('Current state measurement exceeds its reserved 64-RPC budget.');
    const id = evidence.request.length + 1;
    evidence.request.push({ id, method, params: structuredClone(params) });
    let result, rpcError;
    try { result = await rpc.call(method, structuredClone(params)); }
    catch (error) { rpcError = error; }
    // No Promise.race: late promises must settle before final evidence exists.
    // With the standard RpcClient's <=25s call timeout, a final in-flight call
    // can extend the 120s scheduling window by at most25s. Custom transports
    // must provide the same bound; the context cannot cancel arbitrary promises.
    afterAwaitDeadline(id, method);
    try { if (rpcError) throw rpcError; assertNoProviderErrorResult(method, result); }
    catch (error) {
      const publicError = rpcFailure(error);
      evidence.response.push({ id, method, error: publicError });
      throw new StateValidationError(publicError.message);
    }
    let serialized, size;
    try { serialized = JSON.stringify(result); size = Buffer.byteLength(serialized, 'utf8'); }
    catch {
      const message = 'Current state RPC returned non-JSON evidence.';
      evidence.response.push({ id, method, error: { code: 'STATE_INVALID_EVIDENCE', message } }); failState(message);
    }
    if (size > MAX_RESPONSE_BYTES || evidenceBytes + size > MAX_EVIDENCE_BYTES) {
      const message = 'Current state RPC evidence exceeds its configured size limit.';
      evidence.response.push({ id, method, error: { code: 'STATE_EVIDENCE_LIMIT', message } }); failState(message);
    }
    afterAwaitDeadline(id, method);
    evidenceBytes += size;
    const retained = JSON.parse(serialized);
    evidence.response.push({ id, method, result: retained });
    return structuredClone(retained);
  }
  function assertHeader(candidate) {
    const identity = headerIdentity(candidate);
    if (identity.hash !== lower(boundBlock.hash) || uint(identity.number) !== uint(boundBlock.number) || uint(identity.timestamp) !== uint(boundBlock.timestamp)) failState('Current provider block header does not match the pinned identity.');
    if (header && JSON.stringify(identity) !== JSON.stringify(headerIdentity(header))) failState('Current block header fields changed during measurement.');
  }
  async function headerWitness(after) {
    const code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + (uint(boundBlock.number) - 1n).toString(16).padStart(64, '0') + '4060e0526101006000f3';
    const witness = { from: lower(req.from), to: PROBE, data: '0x', value: '0x0', gas: '0x493e0' };
    const raw = await call('debug_traceCall', [witness, pinned, { ...tracer('trace'), stateOverrides: { ...(after ? overrides : {}), [PROBE]: { code } } }]);
    if (uint(raw?.gas) !== 300000n) failState('Current header witness does not match its fixed 300000-gas envelope.');
    const frame = semanticTrace(raw);
    assertReadOnlyFrame(frame, { type: 'CALL', from: req.from, to: PROBE, input: '0x', childCount: 0 });
    if (frame.output.length !== 514 || BigInt(frame.gasUsed) === 0n || BigInt(frame.gasUsed) > 300000n) failState('Current header witness returned malformed data.');
    const expected = [header.number, header.timestamp, header.gasLimit, 0, header.mixHash, header.miner, CHAIN_ID, header.parentHash].map(BigInt);
    if (expected.some((value, i) => BigInt('0x' + frame.output.slice(2 + i * 64, 66 + i * 64)) !== value)) failState('Current query header does not match the synthetic unpriced BASEFEE-zero profile.');
  }
  async function prepare() {
    checkDeadline();
    if (!preparation) preparation = (async () => {
      if (uint(req?.chainId) !== BigInt(CHAIN_ID) || !isAddress(req?.from) || !isAddress(req?.to) || !bytes(req?.data) || quantity(req?.value) !== 0n || !isWord(boundBlock?.hash) || quantity(boundBlock?.number) === null || uint(boundBlock.number) === 0n || quantity(boundBlock?.timestamp) === null) failState('Current measurement requires a zero-value chain-999 contract request and pinned block.');
      if (['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'accessList', 'authorizationList', 'type', 'blobVersionedHashes', 'maxFeePerBlobGas'].some(field => req[field] !== undefined)) failState('Current measurement accepts only its fixed unpriced unsigned envelope.');
      const expected = semanticTrace(originalTrace);
      if (failed(expected) || expected.type !== 'CALL' || expected.from !== lower(req.from) || expected.to !== lower(req.to) || expected.input !== lower(req.data) || expected.value !== '0' || uint(originalTrace.gas) !== 5000000n || BigInt(expected.gasUsed) === 0n || BigInt(expected.gasUsed) > 5000000n) failState('Original current trace does not match the fixed unsigned call.');
      // Even reverted temporary lifecycle operations can disappear from a diff.
      if (hasLifecycle(expected)) failState('Contract creation or destruction, including reverted subtrees, is outside current measurement scope.');
      if (usesProbe(expected)) failState('The reserved current header witness address is not disjoint.');
      pinned = { blockHash: lower(boundBlock.hash), requireCanonical: true };
      header = await call('eth_getBlockByHash', [pinned.blockHash, false]); assertHeader(header);
      senderNonce = quantity(await call('eth_getTransactionCount', [lower(req.from), pinned]), MAX_NONCE - 2n);
      senderBalance = quantity(await call('eth_getBalance', [lower(req.from), pinned]));
      if (senderNonce === null || senderBalance === null) failState('Current sender nonce or native balance is malformed or outside the supported range.');
      const senderCode = await call('eth_getCode', [lower(req.from), pinned]);
      if (senderCode !== '0x') failState('Current state queries require an EOA sender with empty runtime code.');
      const rootCode = await call('eth_getCode', [lower(req.to), pinned]);
      if (!bytes(rootCode) || rootCode === '0x') failState('Current root is not a confirmed contract with runtime code.');
      if (await call('eth_getCode', [PROBE, pinned]) !== '0x') failState('The reserved current header witness address is not empty.');
      const originalCall = { from: lower(req.from), to: lower(req.to), data: lower(req.data), value: '0x0', gas: '0x4c4b40' };
      const diff = canonicalStateDiff(await call('debug_traceCall', [originalCall, pinned, tracer('diff')]));
      overrides = buildStateOverrides(diff);
      if (diff.pre[lower(req.to)]?.code !== undefined && diff.pre[lower(req.to)].code !== lower(rootCode)) failState('Original current diff root code differs from the pinned contract classification.');
      if (Object.hasOwn(diff.pre, PROBE) || Object.hasOwn(diff.post, PROBE)) failState('Original state changes overlap the reserved current header witness address.');
      const pre = diff.pre[lower(req.from)], post = diff.post[lower(req.from)];
      if (!pre || !post || quantity(pre.nonce) !== senderNonce || quantity(post.nonce) !== senderNonce + 1n || quantity(pre.balance) !== senderBalance || Object.keys(pre).some(field => !['balance', 'nonce'].includes(field)) || Object.keys(post).some(field => !['balance', 'nonce'].includes(field))) failState('Original current diff does not match the pinned EOA sender state and nonce transition.');
      afterNonce = quantity(overrides[lower(req.from)]?.nonce, MAX_NONCE - 1n);
      afterBalance = overrides[lower(req.from)]?.balance === undefined ? senderBalance : quantity(overrides[lower(req.from)].balance);
      if (afterNonce !== senderNonce + 1n || afterBalance === null) failState('Original current overrides do not preserve the supported sender context.');
      await headerWitness(false); await headerWitness(true);
      executionIdentity = { stateBlockHash: pinned.blockHash, blockNumber: uint(boundBlock.number).toString(), timestamp: uint(boundBlock.timestamp).toString(), stateBinding: 'block_hash', headerContext: 'synthetic_unpriced_basefee_zero', feePolicy: 'gas_price_omitted_no_query_native_debit', method: 'debug_traceCall', originalEnvelopeSha256: sha(originalCall), stateOverridesSha256: sha(overrides), validation: { originalTraceBinding: 'caller_supplied_pinned_trace_with_matching_fixed_envelope', headerFields: ['number', 'timestamp', 'gasLimit', 'baseFee_zero', 'prevRandao', 'coinbase', 'chainId', 'parentHash'], actualBlockBaseFeeRaw: uint(header.baseFeePerGas).toString(), queryScope: 'configured_USDC_hUSDC_variable_debt_balanceOf_and_USDC_hUSDC_allowance', queryImplementation: 'configured_address_paths_before_and_after_no_runtime_code_attestation', queryMutation: 'sender_nonce_increment_only_with_unchanged_native_balance', maxPairs: MAX_PAIRS, maxRpcCalls: MAX_CALLS, reservedCanonicalCalls: CANONICAL_RESERVE, maxContextMs: MAX_CONTEXT_MS, maxInFlightRpcMs: MAX_INFLIGHT_RPC_MS, inFlightRpcBound: 'conditional_on_transport_timeout_at_most_25000ms' } };
    })().catch(error => {
      // Preparation is shared by every consumer; an unavailable identity must
      // invalidate the whole context, while an individual query failure does not.
      canonicalFailure ??= stateErrorDescription(error);
      throw error;
    });
    return preparation;
  }
  return Object.freeze({
    measurementBasis: 'current_pinned_state_validated_query',
    allowanceMeasurementBasis: 'current_pinned_state_validated_allowance',
    matches(candidate) { return candidate.rpc === rpc && identityKey(candidate.request, candidate.block) === key; },
    prepare,
    async readPair(query) {
      const q = normalizeTokenQuery(query), pairKey = q.to + ':' + q.data;
      if (!pairs.has(pairKey)) {
        if (pairs.size >= MAX_PAIRS) failState('Current measurement exceeds its 12 token/account pair limit.');
        pairs.set(pairKey, (async () => {
          await prepare();
          const queryCall = { from: lower(req.from), ...q, value: '0x0', gas: '0x493e0' }, amounts = [];
          for (const after of [false, true]) {
            const stateOverrides = after ? { stateOverrides: overrides } : {};
            const raw = await call('debug_traceCall', [queryCall, pinned, { ...tracer('trace'), ...stateOverrides }]);
            if (uint(raw?.gas) !== 300000n) failState('Current token query does not match its fixed 300000-gas envelope.');
            const observed = validateTokenQueryTrace(raw, q, req.from);
            if (observed.gasUsed === 0n || observed.gasUsed > 300000n) failState('Current token query gas use is outside its fixed envelope.');
            const diff = await call('debug_traceCall', [queryCall, pinned, { ...tracer('diff'), ...stateOverrides }]);
            assertQueryDiff(diff, lower(req.from), after ? afterNonce : senderNonce, after ? afterBalance : senderBalance);
            amounts.push(observed.amount);
          }
          return { before: amounts[0], after: amounts[1], delta: amounts[1] - amounts[0] };
        })());
      }
      const result = await pairs.get(pairKey);
      checkDeadline();
      return { ...result };
    },
    async verifyCanonical() {
      try { await prepare(); assertHeader(await call('eth_getBlockByNumber', [hex(boundBlock.number), false], true)); }
      catch (error) { canonicalFailure ??= stateErrorDescription(error); throw error; }
    },
    snapshotEvidence() { return structuredClone(evidence); },
    get canonicalFailure() { return canonicalFailure; },
    get executionIdentity() { return executionIdentity ? structuredClone(executionIdentity) : null; },
  });
}
