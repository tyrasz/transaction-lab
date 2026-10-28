// Original-position Hyperlend balance and configured-token allowance reads. Every execution is ephemeral;
// this module never signs, submits, or persists a transaction.
import { CHAIN_ID, POOL, USDC, HUSDC } from './config.js';
import { StateValidationError, failState, stateErrorDescription, uint, hex, UINT256_MAX, buildStateOverrides } from './state.js';
import { assertNoProviderErrorResult } from './rpc.js';
import { QUERY_IMPLEMENTATIONS as IMPLEMENTATIONS, normalizeTokenQuery, semanticTrace, assertReadOnlyFrame as assertFrame, validateTokenQueryTrace } from './query-validation.js';
import { canonicalStateDiff, assertStateDiffMatch } from './state-diff.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const PROBE = '0x000000000000000000000000000000000000ba1a';
const MAX_PAIRS = 12;
const MAX_CALLS = 64;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const isAddress = value => typeof value === 'string' && ADDRESS.test(value);
const isWord = value => typeof value === 'string' && WORD.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const quantity = (value, max = UINT256_MAX) => { const n = uint(value); return n !== null && n <= max ? n : null; };
const bytes = value => typeof value === 'string' && BYTES.test(value);
const failed = frame => Boolean(frame?.error || frame?.revertReason);
const identityKey = (request, block) => JSON.stringify({ chainId: uint(request?.chainId)?.toString(), from: lower(request?.from), to: lower(request?.to), data: lower(request?.data), value: uint(request?.value)?.toString(), hash: lower(block?.hash), number: uint(block?.number)?.toString(), timestamp: uint(block?.timestamp)?.toString() });

function rootScope(request) {
  if (!bytes(request?.data)) return null;
  const data = lower(request.data), target = lower(request.to), selector = data.slice(0, 10);
  const fields = count => data.length === 10 + count * 64 ? Array.from({ length: count }, (_, i) => '0x' + data.slice(10 + i * 64, 74 + i * 64)) : null;
  const paddedAddress = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(value);
  const generic = () => isAddress(target) ? { operation: 'confirmed_contract_call', token: null, requiresCodeProof: true } : null;
  if ([USDC, HUSDC].includes(target) && ['0x095ea7b3', '0xd505accf'].includes(selector)) {
    const args = fields(selector === '0x095ea7b3' ? 2 : selector === '0xd505accf' ? 7 : -1);
    if (!args || !paddedAddress(args[0]) || (selector === '0xd505accf' && (!paddedAddress(args[1]) || BigInt(args[4]) > 255n))) return null;
    return { operation: selector === '0x095ea7b3' ? 'approve' : 'permit', token: target };
  }
  if (target !== POOL) return generic();
  const operation = { '0x617ba037': 'supply', '0x69328dec': 'withdraw', '0xa415bcad': 'borrow', '0x573ade81': 'repay' }[selector];
  if (!operation) return generic();
  const args = fields({ supply: 4, withdraw: 3, borrow: 5, repay: 4 }[operation]);
  if (!args || args[0] !== '0x' + USDC.slice(2).padStart(64, '0')) return null;
  if (operation === 'supply' && (!paddedAddress(args[2]) || BigInt(args[3]) > 65535n)) return null;
  if (operation === 'withdraw' && !paddedAddress(args[2])) return null;
  if (operation === 'borrow' && (BigInt(args[2]) !== 2n || BigInt(args[3]) > 65535n || !paddedAddress(args[4]))) return null;
  if (operation === 'repay' && (BigInt(args[2]) !== 2n || !paddedAddress(args[3]))) return null;
  return { operation, token: null };
}

function rpcFailure(error) {
  const known = new Set(['RPC_TIMEOUT', 'RPC_CONNECTION_ERROR', 'RPC_HTTP_ERROR', 'RPC_EXECUTION_ERROR', 'RPC_INVALID_RESPONSE', 'RPC_RESPONSE_TOO_LARGE', 'METHOD_NOT_ALLOWED']);
  return { code: known.has(error?.code) ? error.code : 'RPC_ERROR', message: 'The historical state provider failed a read-only RPC request.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}

function allLogs(trace) { return failed(trace) ? [] : [...trace.logs, ...trace.calls.flatMap(allLogs)]; }
function hasContractLifecycle(trace) {
  return ['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(trace.type) || trace.calls.some(hasContractLifecycle);
}
function sortedEventContent(logs) {
  return logs.map(log => JSON.stringify({ address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) })).sort();
}
function oneTrace(result) {
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]) || result[0].length !== 1 || !object(result[0][0])) failState('Historical RPC must return exactly one bundle containing one result.');
  return result[0][0];
}
function validateQuery(result, query, sender) {
  return validateTokenQueryTrace(oneTrace(result), query, sender);
}
function validateReadDiff(result, { sender, miner, nonce, gasUsed, gasPrice, baseFee }) {
  const diff = oneTrace(result);
  buildStateOverrides(diff); // Includes bounded storage/account/code validation.
  const normalized = Object.fromEntries(Object.entries(diff.pre).map(([address, record]) => [lower(address), { before: record, after: diff.post[address] }]));
  if (sender === miner || !normalized[sender] || gasUsed <= 0n || gasUsed > 300000n) failState('Historical state query fee context is outside the verified scope.');
  for (const [address, before] of Object.entries(diff.pre)) {
    const after = diff.post[address];
    if (![sender, miner].includes(lower(address)) || Object.keys(before.storage ?? {}).length || Object.keys(after.storage ?? {}).length || before.code !== undefined || after.code !== undefined) failState('Historical state query changed contract state outside permitted fee and nonce effects.');
    if (lower(address) !== sender && (before.nonce !== undefined || after.nonce !== undefined)) failState('Historical state query changed an unrelated account nonce.');
    if (before.nonce !== undefined || after.nonce !== undefined) {
      if (quantity(before.nonce) === null || quantity(after.nonce) !== quantity(before.nonce) + 1n) failState('Historical state query returned unexpected sender nonce effects.');
    }
  }
  const senderState = normalized[sender];
  if (quantity(senderState.before.nonce) !== nonce || quantity(senderState.after.nonce) !== nonce + 1n) failState('Historical state query did not execute at the original transaction position.');
  if (quantity(senderState.before.balance) === null || quantity(senderState.after.balance) === null || quantity(senderState.before.balance) - quantity(senderState.after.balance) !== gasUsed * gasPrice) failState('Historical state query returned unexpected native fee effects.');
  const tip = gasUsed * (gasPrice - baseFee), minerState = normalized[miner];
  if (tip === 0n ? Boolean(minerState) : !minerState || quantity(minerState.before.balance) === null || quantity(minerState.after.balance) === null || quantity(minerState.after.balance) - quantity(minerState.before.balance) !== tip) failState('Historical state query returned unexpected beneficiary fee effects.');
}

/** Lazy context compatible with createStateContext consumers, for verified tokens only. */
export function createHistoricalStateContext({ request, block, rpc, transaction, receipt, trace }) {
  const req = structuredClone(request), pinnedBlock = structuredClone(block), tx = structuredClone(transaction), txReceipt = structuredClone(receipt), originalTrace = structuredClone(trace);
  const key = identityKey(req, pinnedBlock);
  const evidence = { request: [], response: [] };
  const pairs = new Map();
  let preparation, header, pinned, index, gasPrice, originalCall, executionIdentity;
  let evidenceBytes = 0;
  let canonicalFailure = null;
  async function call(method, params) {
    if (evidence.request.length >= MAX_CALLS) failState('Historical state measurement exceeds its 64-RPC limit.');
    const id = evidence.request.length + 1;
    evidence.request.push({ id, method, params: structuredClone(params) });
    let result;
    try {
      result = await rpc.call(method, params);
      // Also validate injected clients before evidence retention. RpcClient
      // performs this check itself so external capture wrappers stay safe too.
      assertNoProviderErrorResult(method, result);
    }
    catch (error) {
      const publicError = rpcFailure(error);
      evidence.response.push({ id, method, error: publicError });
      throw new StateValidationError(publicError.message);
    }
    let size;
    try { size = Buffer.byteLength(JSON.stringify(result), 'utf8'); }
    catch {
      const message = 'Historical RPC returned non-JSON evidence.';
      evidence.response.push({ id, method, error: { code: 'STATE_INVALID_EVIDENCE', message } });
      failState(message);
    }
    if (size > MAX_RESPONSE_BYTES || evidenceBytes + size > MAX_EVIDENCE_BYTES) {
      const message = 'Historical RPC evidence exceeds its configured size limit.';
      evidence.response.push({ id, method, error: { code: 'STATE_EVIDENCE_LIMIT', message } });
      failState(message);
    }
    evidenceBytes += size;
    evidence.response.push({ id, method, result: structuredClone(result) });
    return result;
  }
  function assertHeader(candidate) {
    if (!object(candidate) || lower(candidate.hash) !== lower(pinnedBlock.hash) || uint(candidate.number) !== uint(pinnedBlock.number) || uint(candidate.timestamp) !== uint(pinnedBlock.timestamp) || !isWord(candidate.parentHash) || !isWord(candidate.mixHash) || !isAddress(candidate.miner) || quantity(candidate.gasLimit) === null || quantity(candidate.baseFeePerGas) === null || !Array.isArray(candidate.transactions) || candidate.transactions.length > 5000 || candidate.transactions.some(hash => !isWord(hash)) || new Set(candidate.transactions.map(lower)).size !== candidate.transactions.length || index >= candidate.transactions.length || lower(candidate.transactions[index]) !== lower(tx.hash)) failState('Canonical block identity or original transaction position does not match.');
    if (header && (['parentHash', 'mixHash', 'miner', 'gasLimit', 'baseFeePerGas'].some(field => lower(String(candidate[field])) !== lower(String(header[field]))) || JSON.stringify(candidate.transactions.map(lower)) !== JSON.stringify(header.transactions.map(lower)))) failState('Historical block header fields changed during measurement.');
  }
  function paramsAt(position, calls, options = {}) {
    return [[{ transactions: calls }], { blockNumber: pinned, transactionIndex: position }, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true }, ...options }];
  }
  function assertOriginalNonce(diff) {
    const sender = lower(tx.from), nonce = uint(tx.nonce);
    if (quantity(diff.pre[sender]?.nonce) !== nonce || quantity(diff.post[sender]?.nonce) !== nonce + 1n) failState('Original transaction state diff does not contain the expected sender nonce transition.');
  }
  async function headerWitness(position) {
    const code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + (uint(pinnedBlock.number) - 1n).toString(16).padStart(64, '0') + '4060e0526101006000f3';
    const witness = semanticTrace(oneTrace(await call('debug_traceCallMany', paramsAt(position, [{ from: lower(req.from), to: PROBE, data: '0x', value: '0x0', gas: '0x493e0', gasPrice }], { stateOverrides: { [PROBE]: { code } } }))));
    assertFrame(witness, { type: 'CALL', from: req.from, to: PROBE, input: '0x', childCount: 0 });
    if (witness.output.length !== 514) failState('Historical header witness returned malformed data.');
    const actual = Array.from({ length: 8 }, (_, i) => BigInt('0x' + witness.output.slice(2 + i * 64, 66 + i * 64)));
    const expected = [header.number, header.timestamp, header.gasLimit, header.baseFeePerGas, header.mixHash, header.miner, CHAIN_ID, header.parentHash].map(BigInt);
    if (actual.some((value, i) => value !== expected[i])) failState('Historical query execution header differs from the original block.');
  }
  async function prepare() {
    if (!preparation) preparation = (async () => {
      const scope = rootScope(req);
      if (uint(req?.chainId) !== BigInt(CHAIN_ID) || !isAddress(req?.from) || !scope || quantity(req?.value) !== 0n || !isWord(pinnedBlock?.hash) || uint(pinnedBlock?.number) === null || uint(pinnedBlock.number) === 0n || uint(pinnedBlock?.timestamp) === null) failState('Historical measurement requires a supported zero-value contract request and pinned block.');
      if (!object(tx) || !object(txReceipt) || !isWord(tx.hash) || lower(tx.blockHash) !== lower(pinnedBlock.hash) || uint(tx.blockNumber) !== uint(pinnedBlock.number) || lower(tx.from) !== lower(req.from) || lower(tx.to) !== lower(req.to) || lower(tx.input) !== lower(req.data) || uint(tx.value) !== uint(req.value) || uint(tx.chainId) !== BigInt(CHAIN_ID) || quantity(tx.nonce, (1n << 64n) - 1n) === null || quantity(tx.gas, 30000000n) === null || uint(tx.gas) === 0n || quantity(tx.transactionIndex, 4999n) === null || !['0x0', '0x1', '0x2'].includes(lower(tx.type ?? '0x0'))) failState('Historical transaction does not match the bound unsigned request.');
      if (['authorizationList', 'blobVersionedHashes', 'maxFeePerBlobGas', 'blobs', 'sidecar'].some(field => tx[field] !== undefined && tx[field] !== null)) failState('Blob or authorization-list transaction semantics are outside historical measurement scope.');
      index = Number(uint(tx.transactionIndex));
      if (lower(txReceipt.transactionHash) !== lower(tx.hash) || lower(txReceipt.blockHash) !== lower(pinnedBlock.hash) || uint(txReceipt.blockNumber) !== uint(pinnedBlock.number) || uint(txReceipt.transactionIndex) !== BigInt(index) || uint(txReceipt.status) !== 1n || lower(txReceipt.from) !== lower(req.from) || lower(txReceipt.to) !== lower(req.to) || quantity(txReceipt.gasUsed) === null || quantity(txReceipt.effectiveGasPrice) === null || quantity(tx.gasPrice) !== quantity(txReceipt.effectiveGasPrice) || !Array.isArray(txReceipt.logs) || txReceipt.logs.length > 2000) failState('Successful historical receipt does not match the bound transaction.');
      const expectedTrace = semanticTrace(originalTrace);
      if (failed(expectedTrace) || expectedTrace.type !== 'CALL' || expectedTrace.from !== lower(req.from) || expectedTrace.to !== lower(req.to) || expectedTrace.input !== lower(req.data) || expectedTrace.value !== '0' || BigInt(expectedTrace.gasUsed) !== uint(txReceipt.gasUsed)) failState('Original historical trace does not match the transaction and receipt.');
      // Final diffs can omit temporary creations/destructions and reverted
      // lifecycle operations. Check every normalized frame before any RPC.
      if (hasContractLifecycle(expectedTrace)) failState('Contract creation or destruction, including reverted subtrees, is outside historical measurement scope.');
      if (scope.token) {
        const implementation = expectedTrace.calls[0];
        if (expectedTrace.calls.length !== 1 || !implementation || failed(implementation) || implementation.type !== 'DELEGATECALL' || implementation.from !== scope.token || implementation.to !== IMPLEMENTATIONS[scope.token] || implementation.input !== expectedTrace.input || implementation.value !== '0') failState('Historical permission execution does not use the verified token implementation.');
      }
      const receiptLogs = txReceipt.logs.map(log => {
        if (!object(log) || !isAddress(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some(topic => !isWord(topic)) || !bytes(log.data) || log.removed || lower(log.transactionHash) !== lower(tx.hash) || lower(log.blockHash) !== lower(pinnedBlock.hash) || uint(log.blockNumber) !== uint(pinnedBlock.number) || uint(log.transactionIndex) !== BigInt(index) || quantity(log.logIndex) === null) failState('Historical receipt contains malformed event identity.');
        return log;
      });
      if (JSON.stringify(sortedEventContent(allLogs(expectedTrace))) !== JSON.stringify(sortedEventContent(receiptLogs))) failState('Original historical events do not match the receipt.');
      pinned = { blockHash: lower(pinnedBlock.hash), requireCanonical: true };
      const candidate = await call('eth_getBlockByHash', [pinned.blockHash, false]);
      assertHeader(candidate); header = structuredClone(candidate);
      const canonical = await call('eth_getBlockByNumber', [hex(pinnedBlock.number), false]); assertHeader(canonical);
      if (quantity(tx.gasPrice) < quantity(header.baseFeePerGas)) failState('Original effective gas price is below the historical block base fee.');
      if (lower(tx.type) === '0x2') {
        const maxFee = quantity(tx.maxFeePerGas), priority = quantity(tx.maxPriorityFeePerGas);
        if (maxFee === null || priority === null || priority > maxFee || maxFee < quantity(header.baseFeePerGas) || quantity(tx.gasPrice) !== (maxFee < quantity(header.baseFeePerGas) + priority ? maxFee : quantity(header.baseFeePerGas) + priority)) failState('Historical fee caps do not reproduce the original effective gas price.');
      }
      gasPrice = hex(tx.gasPrice);
      originalCall = { from: lower(tx.from), to: lower(tx.to), data: lower(tx.input), value: hex(tx.value), gas: hex(tx.gas), gasPrice, nonce: hex(tx.nonce) };
      if (tx.accessList !== undefined) {
        if (!Array.isArray(tx.accessList) || tx.accessList.length > 100 || tx.accessList.some(item => !object(item) || !isAddress(item.address) || !Array.isArray(item.storageKeys) || item.storageKeys.length > 100 || item.storageKeys.some(slot => !isWord(slot)))) failState('Historical transaction access list is malformed or excessive.');
        originalCall.accessList = structuredClone(tx.accessList);
      }
      const replay = semanticTrace(oneTrace(await call('debug_traceCallMany', paramsAt(index, [originalCall]))));
      if (JSON.stringify(replay) !== JSON.stringify(expectedTrace)) failState('Original-position replay does not match the historical execution trace.');
      const diff = await call('debug_traceTransaction', [tx.hash, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
      const originalState = canonicalStateDiff(diff);
      buildStateOverrides(originalState); // Reject original account creation/deletion/code changes.
      assertOriginalNonce(originalState);
      const replayDiff = oneTrace(await call('debug_traceCallMany', paramsAt(index, [originalCall], { tracer: 'prestateTracer', tracerConfig: { diffMode: true } })));
      const replayState = canonicalStateDiff(replayDiff);
      buildStateOverrides(replayState);
      assertOriginalNonce(replayState);
      // Matching execution alone can hide the wrong absolute prestate, including
      // a fee recipient whose balance differs while its transaction delta agrees.
      assertStateDiffMatch(originalState, replayState);
      if (scope.requiresCodeProof) {
        const prestate = await call('debug_traceTransaction', [tx.hash, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { disableStorage: true } }]);
        if (!object(prestate) || Object.keys(prestate).length > 1000 || Object.keys(prestate).some(account => !isAddress(account)) || !object(prestate[lower(req.to)]) || !bytes(prestate[lower(req.to)].code) || prestate[lower(req.to)].code === '0x') failState('Historical root runtime code is unavailable or outside the confirmed-contract scope.');
      }
      await headerWitness(index);
      await headerWitness(index + 1);
      executionIdentity = { transactionHash: lower(tx.hash), transactionIndex: String(index), postTransactionIndex: String(index + 1), stateBlockHash: pinned.blockHash, blockNumber: uint(pinnedBlock.number).toString(), timestamp: uint(pinnedBlock.timestamp).toString(), stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', method: 'debug_traceCallMany', validation: { originalReplay: 'semantic_trace_and_receipt_match', originalReplayState: 'complete_pre_post_diff_match', inputGasAnnotations: 'excluded_from_comparison', headerFields: ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'], feeRepresentation: 'original_effective_gas_price', queryScope: 'configured_USDC_hUSDC_variable_debt_balanceOf_and_USDC_hUSDC_allowance', maxPairs: MAX_PAIRS, maxRpcCalls: MAX_CALLS } };
    })();
    return preparation;
  }
  return Object.freeze({
    measurementBasis: 'historical_transaction_position_balanceOf',
    allowanceMeasurementBasis: 'historical_transaction_position_allowance',
    matches(candidate) { return candidate.rpc === rpc && identityKey(candidate.request, candidate.block) === key; },
    prepare,
    async readPair(query) {
      const q = normalizeTokenQuery(query), pairKey = q.to + ':' + q.data;
      if (!pairs.has(pairKey)) {
        if (pairs.size >= MAX_PAIRS) failState('Historical measurement exceeds its 12 token/account pair limit.');
        pairs.set(pairKey, (async () => {
          await prepare();
          const queryCall = { from: lower(req.from), ...q, value: '0x0', gas: '0x493e0', gasPrice };
          const amounts = [];
          for (const position of [index, index + 1]) {
            const observed = validateQuery(await call('debug_traceCallMany', paramsAt(position, [queryCall])), q, req.from);
            const stateResult = await call('debug_traceCallMany', paramsAt(position, [queryCall], { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }));
            validateReadDiff(stateResult, { sender: lower(req.from), miner: lower(header.miner), nonce: uint(tx.nonce) + BigInt(position - index), gasUsed: observed.gasUsed, gasPrice: BigInt(gasPrice), baseFee: quantity(header.baseFeePerGas) });
            amounts.push(observed.amount);
          }
          return { before: amounts[0], after: amounts[1], delta: amounts[1] - amounts[0] };
        })());
      }
      return { ...await pairs.get(pairKey) };
    },
    async verifyCanonical() {
      try {
        await prepare();
        assertHeader(await call('eth_getBlockByNumber', [hex(pinnedBlock.number), false]));
      } catch (error) {
        // Preserve the first failed shared binding even if a concurrent
        // consumer's canonical check later succeeds.
        canonicalFailure ??= stateErrorDescription(error);
        throw error;
      }
    },
    snapshotEvidence() { return structuredClone(evidence); },
    get canonicalFailure() { return canonicalFailure; },
    get executionIdentity() { return executionIdentity ? structuredClone(executionIdentity) : null; },
  });
}
