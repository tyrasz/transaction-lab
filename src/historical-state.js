// Original-position Hyperlend balance reads. Every execution is ephemeral;
// this module never signs, submits, or persists a transaction.
import { CHAIN_ID, POOL, USDC, HUSDC, VUSDC } from './config.js';
import { StateValidationError, failState, uint, hex, UINT256_MAX, buildStateOverrides } from './state.js';
import { assertNoProviderErrorResult } from './rpc.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const BALANCE = /^0x70a082310{24}[0-9a-f]{40}$/i;
const IMPLEMENTATIONS = {
  [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',
  [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3',
  [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed',
};
const POOL_IMPLEMENTATION = '0xbebb62c7ff8b96db4325d9481c44e09a92d49b06';
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

function rpcFailure(error) {
  const known = new Set(['RPC_TIMEOUT', 'RPC_CONNECTION_ERROR', 'RPC_HTTP_ERROR', 'RPC_EXECUTION_ERROR', 'RPC_INVALID_RESPONSE', 'RPC_RESPONSE_TOO_LARGE', 'METHOD_NOT_ALLOWED']);
  return { code: known.has(error?.code) ? error.code : 'RPC_ERROR', message: 'The historical state provider failed a read-only RPC request.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}

// Normalize semantic callTracer fields. Input-gas annotations may differ between
// RPC execution wrappers; gasUsed is mandatory and compared at every frame.
function semanticTrace(trace) {
  let frames = 0, logs = 0;
  function visit(frame, depth = 0) {
    if (++frames > 1000 || depth > 32) failState('Historical trace exceeds its frame or depth limit.');
    if (!object(frame) || !['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) || !isAddress(frame.from) || !isAddress(frame.to) || !bytes(frame.input ?? '0x') || !bytes(frame.output ?? '0x') || quantity(frame.gasUsed) === null || (frame.gas !== undefined && quantity(frame.gas) === null) || (frame.value !== undefined && quantity(frame.value) === null)) failState('Historical call trace contains malformed execution fields.');
    if (Object.keys(frame).some(field => !['type', 'from', 'to', 'input', 'output', 'value', 'gas', 'gasUsed', 'error', 'revertReason', 'logs', 'calls'].includes(field))) failState('Historical call trace contains unsupported execution fields.');
    if (frame.calls !== undefined && !Array.isArray(frame.calls)) failState('Historical call trace contains malformed child calls.');
    if (frame.logs !== undefined && !Array.isArray(frame.logs)) failState('Historical call trace contains malformed logs.');
    for (const field of ['error', 'revertReason']) if (frame[field] !== undefined && (typeof frame[field] !== 'string' || frame[field].length > 2000)) failState('Historical call trace contains malformed failure data.');
    const normalized = { type: frame.type, from: lower(frame.from), to: lower(frame.to), input: lower(frame.input ?? '0x'), output: lower(frame.output ?? '0x'), value: (quantity(frame.value ?? '0x0')).toString(), gasUsed: quantity(frame.gasUsed).toString(), error: frame.error ?? null, revertReason: frame.revertReason ?? null, logs: [], calls: [] };
    for (const log of frame.logs ?? []) {
      if (++logs > 2000 || !object(log) || !isAddress(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some(topic => !isWord(topic)) || !bytes(log.data)) failState('Historical trace contains malformed or excessive event evidence.');
      if (Object.keys(log).some(field => !['address', 'topics', 'data', 'position', 'index', 'logIndex', 'removed'].includes(field))) failState('Historical call trace contains unsupported event fields.');
      const item = { address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) };
      for (const field of ['position', 'index', 'logIndex']) if (log[field] !== undefined) {
        if (quantity(log[field]) === null) failState('Historical event position is malformed.');
        item[field] = quantity(log[field]).toString();
      }
      if (log.removed) failState('Historical trace contains removed event evidence.');
      normalized.logs.push(item);
    }
    normalized.calls = (frame.calls ?? []).map(child => visit(child, depth + 1));
    return normalized;
  }
  return visit(trace);
}

function allLogs(trace) { return failed(trace) ? [] : [...trace.logs, ...trace.calls.flatMap(allLogs)]; }
function sortedEventContent(logs) {
  return logs.map(log => JSON.stringify({ address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) })).sort();
}
function oneTrace(result) {
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]) || result[0].length !== 1 || !object(result[0][0])) failState('Historical RPC must return exactly one bundle containing one result.');
  return result[0][0];
}
function assertFrame(frame, { type, from, to, input, output, childCount }) {
  if (failed(frame) || frame.type !== type || frame.from !== lower(from) || frame.to !== lower(to) || frame.input !== lower(input) || (output !== undefined && frame.output !== lower(output)) || frame.value !== '0' || frame.logs.length || frame.calls.length !== childCount) failState('Historical balance query does not match the verified token call behavior.');
}
function validateQuery(result, query, sender) {
  const root = semanticTrace(oneTrace(result));
  if (!isWord(root.output)) failState('Historical balance query did not return exactly one uint256 word.');
  assertFrame(root, { type: 'CALL', from: sender, to: query.to, input: query.data, childCount: 1 });
  const implementation = root.calls[0];
  assertFrame(implementation, { type: 'DELEGATECALL', from: query.to, to: IMPLEMENTATIONS[query.to], input: query.data, output: root.output, childCount: query.to === USDC ? 0 : 1 });
  if (query.to !== USDC) {
    const indexInput = (query.to === HUSDC ? '0xd15e0053' : '0x386497fd') + USDC.slice(2).padStart(64, '0');
    const pool = implementation.calls[0];
    assertFrame(pool, { type: 'STATICCALL', from: query.to, to: POOL, input: indexInput, childCount: 1 });
    if (!isWord(pool.output) || BigInt(pool.output) === 0n) failState('Historical position query returned an invalid reserve index.');
    assertFrame(pool.calls[0], { type: 'DELEGATECALL', from: POOL, to: POOL_IMPLEMENTATION, input: indexInput, output: pool.output, childCount: 0 });
  }
  return { amount: BigInt(root.output), gasUsed: BigInt(root.gasUsed) };
}
function validateReadDiff(result, { sender, miner, nonce, gasUsed, gasPrice, baseFee }) {
  const diff = oneTrace(result);
  buildStateOverrides(diff); // Includes bounded storage/account/code validation.
  const normalized = Object.fromEntries(Object.entries(diff.pre).map(([address, record]) => [lower(address), { before: record, after: diff.post[address] }]));
  if (sender === miner || !normalized[sender] || gasUsed <= 0n || gasUsed > 300000n) failState('Historical balance query fee context is outside the verified scope.');
  for (const [address, before] of Object.entries(diff.pre)) {
    const after = diff.post[address];
    if (![sender, miner].includes(lower(address)) || Object.keys(before.storage ?? {}).length || Object.keys(after.storage ?? {}).length || before.code !== undefined || after.code !== undefined) failState('Historical balance query changed contract state outside permitted fee and nonce effects.');
    if (lower(address) !== sender && (before.nonce !== undefined || after.nonce !== undefined)) failState('Historical balance query changed an unrelated account nonce.');
    if (before.nonce !== undefined || after.nonce !== undefined) {
      if (quantity(before.nonce) === null || quantity(after.nonce) !== quantity(before.nonce) + 1n) failState('Historical balance query returned unexpected sender nonce effects.');
    }
  }
  const senderState = normalized[sender];
  if (quantity(senderState.before.nonce) !== nonce || quantity(senderState.after.nonce) !== nonce + 1n) failState('Historical balance query did not execute at the original transaction position.');
  if (quantity(senderState.before.balance) === null || quantity(senderState.after.balance) === null || quantity(senderState.before.balance) - quantity(senderState.after.balance) !== gasUsed * gasPrice) failState('Historical balance query returned unexpected native fee effects.');
  const tip = gasUsed * (gasPrice - baseFee), minerState = normalized[miner];
  if (tip === 0n ? Boolean(minerState) : !minerState || quantity(minerState.before.balance) === null || quantity(minerState.after.balance) === null || quantity(minerState.after.balance) - quantity(minerState.before.balance) !== tip) failState('Historical balance query returned unexpected beneficiary fee effects.');
}

/** Lazy context compatible with createStateContext consumers, for verified tokens only. */
export function createHistoricalStateContext({ request, block, rpc, transaction, receipt, trace }) {
  const req = structuredClone(request), pinnedBlock = structuredClone(block), tx = structuredClone(transaction), txReceipt = structuredClone(receipt), originalTrace = structuredClone(trace);
  const key = identityKey(req, pinnedBlock);
  const evidence = { request: [], response: [] };
  const pairs = new Map();
  let preparation, header, pinned, index, gasPrice, originalCall, executionIdentity;
  let evidenceBytes = 0;
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
    catch { failState('Historical RPC returned non-JSON evidence.'); }
    if (size > MAX_RESPONSE_BYTES || evidenceBytes + size > MAX_EVIDENCE_BYTES) failState('Historical RPC evidence exceeds its configured size limit.');
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
      if (uint(req?.chainId) !== BigInt(CHAIN_ID) || !isAddress(req?.from) || lower(req?.to) !== POOL || !bytes(req?.data) || quantity(req?.value) !== 0n || !isWord(pinnedBlock?.hash) || uint(pinnedBlock?.number) === null || uint(pinnedBlock.number) === 0n || uint(pinnedBlock?.timestamp) === null) failState('Historical measurement requires a valid Hyperlend request and pinned block.');
      if (!object(tx) || !object(txReceipt) || !isWord(tx.hash) || lower(tx.blockHash) !== lower(pinnedBlock.hash) || uint(tx.blockNumber) !== uint(pinnedBlock.number) || lower(tx.from) !== lower(req.from) || lower(tx.to) !== lower(req.to) || lower(tx.input) !== lower(req.data) || uint(tx.value) !== uint(req.value) || uint(tx.chainId) !== BigInt(CHAIN_ID) || quantity(tx.nonce, (1n << 64n) - 1n) === null || quantity(tx.gas, 30000000n) === null || uint(tx.gas) === 0n || quantity(tx.transactionIndex, 4999n) === null || !['0x0', '0x1', '0x2'].includes(lower(tx.type ?? '0x0'))) failState('Historical transaction does not match the bound unsigned request.');
      if (['authorizationList', 'blobVersionedHashes', 'maxFeePerBlobGas', 'blobs', 'sidecar'].some(field => tx[field] !== undefined && tx[field] !== null)) failState('Blob or authorization-list transaction semantics are outside historical measurement scope.');
      index = Number(uint(tx.transactionIndex));
      if (lower(txReceipt.transactionHash) !== lower(tx.hash) || lower(txReceipt.blockHash) !== lower(pinnedBlock.hash) || uint(txReceipt.blockNumber) !== uint(pinnedBlock.number) || uint(txReceipt.transactionIndex) !== BigInt(index) || uint(txReceipt.status) !== 1n || lower(txReceipt.from) !== lower(req.from) || lower(txReceipt.to) !== lower(req.to) || quantity(txReceipt.gasUsed) === null || quantity(txReceipt.effectiveGasPrice) === null || quantity(tx.gasPrice) !== quantity(txReceipt.effectiveGasPrice) || !Array.isArray(txReceipt.logs) || txReceipt.logs.length > 2000) failState('Successful historical receipt does not match the bound transaction.');
      const expectedTrace = semanticTrace(originalTrace);
      if (failed(expectedTrace) || expectedTrace.type !== 'CALL' || expectedTrace.from !== lower(req.from) || expectedTrace.to !== lower(req.to) || expectedTrace.input !== lower(req.data) || expectedTrace.value !== '0' || BigInt(expectedTrace.gasUsed) !== uint(txReceipt.gasUsed)) failState('Original historical trace does not match the transaction and receipt.');
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
      buildStateOverrides(diff); // Reject original account creation/deletion/code changes.
      await headerWitness(index);
      await headerWitness(index + 1);
      executionIdentity = { transactionHash: lower(tx.hash), transactionIndex: String(index), postTransactionIndex: String(index + 1), stateBlockHash: pinned.blockHash, blockNumber: uint(pinnedBlock.number).toString(), timestamp: uint(pinnedBlock.timestamp).toString(), stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', method: 'debug_traceCallMany', validation: { originalReplay: 'semantic_trace_and_receipt_match', inputGasAnnotations: 'excluded_from_comparison', headerFields: ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'], feeRepresentation: 'original_effective_gas_price', queryScope: 'configured_USDC_hUSDC_variable_debt_balanceOf', maxPairs: MAX_PAIRS, maxRpcCalls: MAX_CALLS } };
    })();
    return preparation;
  }
  return Object.freeze({
    measurementBasis: 'historical_transaction_position_balanceOf',
    matches(candidate) { return candidate.rpc === rpc && identityKey(candidate.request, candidate.block) === key; },
    prepare,
    async readPair(query) {
      if (!object(query) || !Object.hasOwn(IMPLEMENTATIONS, lower(query.to)) || typeof query.data !== 'string' || !BALANCE.test(query.data)) failState('Historical balance queries are restricted to configured token balanceOf calls.');
      const q = { to: lower(query.to), data: lower(query.data) }, pairKey = q.to + ':' + q.data;
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
      await prepare();
      assertHeader(await call('eth_getBlockByNumber', [hex(pinnedBlock.number), false]));
    },
    snapshotEvidence() { return structuredClone(evidence); },
    get executionIdentity() { return executionIdentity ? structuredClone(executionIdentity) : null; },
  });
}
