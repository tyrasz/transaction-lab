// Frozen independently of the product's decoders. This module never imports
// analyze.js, permissions.js, lending.js or their observations.
import { isDeepStrictEqual } from 'node:util';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const ZERO = '0x' + '0'.repeat(40);
export const ORACLE_TOKENS = Object.freeze({
  '0xb88339cb7199b77e23db6e890353e22632ba630f': { implementation: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8', role: 'asset', allowance: true },
  '0x744e4f26ee30213989216e1632d9be3547c4885b': { implementation: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3', role: 'receipt_token', allowance: true },
  '0xd612513cb3b2c52abcd6d4b338374c09ada4657d': { implementation: '0x8158e5569475a443a5723ccac462930f590449ed', role: 'liability', allowance: false },
});
export const COMPARISON_RULES = Object.freeze({
  version: 'prospective-2',
  trace: 'Ordered full call tree, including failed descendants; type/from/to/input/value/gas/gasUsed/output/outcome and ordered per-frame logs including position. Missing optional values differ from zero or empty bytes. Absent calls/logs differ from explicit empty arrays. Provider failure prose is ignored, failure presence is retained.',
  requiredFrameFields: ['type', 'from', 'input', 'gas', 'gasUsed'],
  normalization: 'Address and byte-string case, integer representation only. Object property order is irrelevant; all array order is significant. No gas annotation exclusions or log sorting.',
  exactReplay: 'Unsigned legacy type-0 envelope fields must be present and unchanged, with original block hash/index, completed shared header/nonce/isolation checks and strict full trace equality. Each provider must also supply the original transaction pre/post diff and a CallMany diff for exactly the same replay envelope and context. Independently validated complete maps, absolute account/slot values and field presence must match within and across providers, including the sender original nonce and increment; a product validation flag alone is insufficient. Type-1/2 effective-gas-price substitution is incomplete, never exact. This is endpoint agreement using a shared state adapter, not independent-engine or signed-transaction validation.',
  stateDiff: 'Independent schema: exactly pre/post maps, at most 100 distinct accounts and 2000 distinct account/storage-slot pairs across both maps; uint256 balances, uint64 nonces, exact 32-byte slots and values, at most 8 MiB bytecode text. Only balance/nonce/code/storage account fields are accepted. Normalize representation and object order only; reject duplicate normalized keys, unknown fields, accessors and malformed objects. Empty equal maps cannot prove a transaction nonce transition.',
  inventory: 'Candidate balance pairs from all ERC20-shaped receipt Transfer logs; candidate allowances from all ERC20-shaped Approval logs and successful CALL transferFrom/approve/permit arguments. Unknown token candidates remain in the inventory and unavailable. Only the separately listed verified token implementations can be queried. No observed candidates never establishes no effects.',
  oracleQueryOrder: 'Lexicographic balance token:account first, then allowance token:owner:spender; at most eight combined candidates queried, including unsupported candidates in the ordering. No replacements after query failure.',
  completeness: 'All-effects asset and permission inventory completeness remains inconclusive: native fees, NFTs, silent changes, nonstandard permissions, rebases and deferred HyperCore effects are not fully enumerated. Observed-pair corroboration is a separately named metric.',
  sources: ['https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers', 'https://docs.erigon.tech/interacting-with-erigon/debug', 'https://eips.ethereum.org/EIPS/eip-20', 'https://eips.ethereum.org/EIPS/eip-2612', 'https://hyperevmscan.io/address/0x003f73f58ca78880da3642c5cb71d7459b3fe4f8#code', 'https://hyperevmscan.io/address/0x410aa1ab680b886c875e99a7a4bfaf188508a7a3#code', 'https://hyperevmscan.io/address/0x8158e5569475a443a5723ccac462930f590449ed#code'],
});
export const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
export function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return BigInt(value).toString();
  throw new TypeError('Missing or invalid integer evidence.');
}
function address(value) { if (!ADDRESS.test(value ?? '')) throw new TypeError('Missing address.'); return lower(value); }
function bytes(value) { if (typeof value !== 'string' || !BYTES.test(value)) throw new TypeError('Missing bytes.'); return lower(value); }
function word(value) { if (!WORD.test(value ?? '')) throw new TypeError('Missing hash.'); return lower(value); }
const optional = (object, key, parse) => Object.hasOwn(object, key) ? { present: true, value: parse(object[key]) } : { present: false };
const failed = frame => Boolean(frame?.error || frame?.revertReason);
function logProjection(log, receipt = false) {
  if (!log || !Array.isArray(log.topics) || log.topics.length > 4) throw new TypeError('Missing log.');
  const out = { address: address(log.address), topics: log.topics.map(word), data: bytes(log.data) };
  if (receipt) {
    for (const key of ['blockHash', 'transactionHash']) out[key] = word(log[key]);
    for (const key of ['blockNumber', 'transactionIndex', 'logIndex']) out[key] = integer(log[key]);
    out.removed = optional(log, 'removed', value => { if (typeof value !== 'boolean') throw new TypeError('Invalid removed flag.'); return value; });
  } else out.position = optional(log, 'position', integer);
  return out;
}
export function strictTraceProjection(trace) {
  let frames = 0;
  function walk(frame, depth) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || ++frames > 20000 || depth > 256 || !['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type)) throw new TypeError('Incomplete or excessive trace.');
    for (const field of ['error', 'revertReason']) if (Object.hasOwn(frame, field) && (typeof frame[field] !== 'string' || !frame[field].length)) throw new TypeError('Malformed failure metadata.');
    const out = { type: frame.type, from: address(frame.from), input: bytes(frame.input), gas: integer(frame.gas), gasUsed: integer(frame.gasUsed), failed: failed(frame) };
    if (['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'SELFDESTRUCT'].includes(frame.type)) address(frame.to);
    out.to = optional(frame, 'to', address); out.value = optional(frame, 'value', integer); out.output = optional(frame, 'output', bytes);
    for (const key of ['calls', 'logs']) out[key] = optional(frame, key, values => {
      if (!Array.isArray(values)) throw new TypeError('Invalid trace array.');
      return values.map(item => key === 'calls' ? walk(item, depth + 1) : logProjection(item));
    });
    return out;
  }
  return walk(trace, 0);
}
export function compareTraces(left, right) {
  try { return { status: isDeepStrictEqual(strictTraceProjection(left), strictTraceProjection(right)) ? 'matched' : 'mismatched', basis: 'strict_ordered_full_call_tree' }; }
  catch { return { status: 'incomplete', reason: 'Required call-frame or log evidence is absent, malformed or exceeds the frozen comparator limits.' }; }
}
function receiptProjection(receipt) {
  const out = {};
  for (const key of ['transactionHash', 'blockHash']) out[key] = word(receipt[key]);
  for (const key of ['blockNumber', 'transactionIndex', 'status', 'gasUsed', 'cumulativeGasUsed', 'effectiveGasPrice']) out[key] = integer(receipt[key]);
  out.from = address(receipt.from);
  out.to = receipt.to === null ? null : address(receipt.to);
  out.contractAddress = optional(receipt, 'contractAddress', value => value === null ? null : address(value));
  out.type = optional(receipt, 'type', integer);
  if (!Array.isArray(receipt.logs)) throw new TypeError('Missing receipt logs.');
  out.logs = receipt.logs.map(log => logProjection(log, true));
  return out;
}
function committedLogInventory(frame, ancestorFailed = false, output = []) {
  const reverted = ancestorFailed || failed(frame);
  if (!reverted) for (const log of frame.logs ?? []) output.push({ address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) });
  for (const child of frame.calls ?? []) committedLogInventory(child, reverted, output);
  return output;
}
export function compareTransactionEnvelopes(left, right) {
  function project(tx) {
    const out = { hash: word(tx.hash), blockHash: word(tx.blockHash), from: address(tx.from), to: tx.to === null ? null : address(tx.to), input: bytes(tx.input) };
    for (const field of ['chainId', 'blockNumber', 'transactionIndex', 'type', 'nonce', 'gas', 'gasPrice', 'value']) out[field] = integer(tx[field]);
    for (const field of ['maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'v', 'r', 's', 'yParity']) out[field] = optional(tx, field, integer);
    out.accessList = optional(tx, 'accessList', entries => {
      if (!Array.isArray(entries)) throw new TypeError();
      return entries.map(entry => ({ address: address(entry.address), storageKeys: entry.storageKeys.map(word) }));
    });
    out.blobVersionedHashes = optional(tx, 'blobVersionedHashes', hashes => hashes.map(word));
    out.authorizationList = optional(tx, 'authorizationList', entries => {
      if (!Array.isArray(entries)) throw new TypeError();
      return entries.map(entry => ({ address: address(entry.address), ...Object.fromEntries(['chainId', 'nonce', 'yParity', 'r', 's'].map(key => [key, integer(entry[key])])) }));
    });
    if (out.type === '1' && !out.accessList.present) throw new TypeError();
    if (['2', '3', '4'].includes(out.type) && (!out.accessList.present || !out.maxFeePerGas.present || !out.maxPriorityFeePerGas.present)) throw new TypeError();
    if (out.type === '3' && (!out.maxFeePerBlobGas.present || !out.blobVersionedHashes.present)) throw new TypeError();
    if (out.type === '4' && !out.authorizationList.present) throw new TypeError();
    if (!['0', '1', '2', '3', '4'].includes(out.type)) throw new TypeError();
    return out;
  }
  try { return { status: isDeepStrictEqual(project(left), project(right)) ? 'matched' : 'mismatched', basis: 'original_transaction_envelope' }; }
  catch { return { status: 'incomplete', reason: 'Original transaction envelope evidence is missing or malformed.' }; }
}
export function validateHistoricalEvidence({ transaction: tx, receipt, trace, row, block }) {
  try {
    const checks = [word(tx.hash) === row.transactionHash, word(tx.blockHash) === row.blockHash, integer(tx.blockNumber) === row.blockNumber,
      integer(tx.transactionIndex) === row.transactionIndex, integer(tx.chainId) === '999', word(block.hash) === row.blockHash,
      integer(block.number) === row.blockNumber, lower(block.transactions?.[Number(row.transactionIndex)]) === row.transactionHash,
      word(receipt.transactionHash) === row.transactionHash, word(receipt.blockHash) === row.blockHash,
      integer(receipt.blockNumber) === row.blockNumber, integer(receipt.transactionIndex) === row.transactionIndex,
      address(receipt.from) === address(tx.from), (receipt.to === null ? null : address(receipt.to)) === (tx.to === null ? null : address(tx.to)),
      address(trace.from) === address(tx.from), bytes(trace.input) === bytes(tx.input), integer(trace.value) === integer(tx.value),
      integer(trace.gasUsed) === integer(receipt.gasUsed), ['0', '1'].includes(integer(receipt.status)), failed(trace) === (integer(receipt.status) === '0')];
    if (tx.to === null) checks.push(['CREATE', 'CREATE2'].includes(trace.type));
    else checks.push(trace.type === 'CALL', address(trace.to) === address(tx.to));
    const projected = receiptProjection(receipt); strictTraceProjection(trace);
    // Receipt/event content is a separate completeness gate. Canonicalizing a
    // multiset here does not reorder or relax the strict full-tree comparison.
    const traceEvents = committedLogInventory(trace).map(event => JSON.stringify(event)).sort();
    const receiptEvents = projected.logs.map(log => JSON.stringify({ address: log.address, topics: log.topics, data: log.data })).sort();
    if (traceEvents.length < receiptEvents.length) return { status: 'incomplete', reason: 'Committed trace logs are missing receipt event content.' };
    checks.push(isDeepStrictEqual(traceEvents, receiptEvents));
    let lastIndex = -1n;
    for (const log of projected.logs) {
      checks.push(log.transactionHash === row.transactionHash, log.blockHash === row.blockHash, log.blockNumber === row.blockNumber, log.transactionIndex === row.transactionIndex,
        !log.removed.present || log.removed.value === false, BigInt(log.logIndex) > lastIndex);
      lastIndex = BigInt(log.logIndex);
    }
    return { status: checks.every(Boolean) ? 'complete' : 'mismatched', outcome: integer(receipt.status) === '1' ? 'success' : 'revert' };
  } catch { return { status: 'incomplete', reason: 'Transaction, receipt, full trace or canonical identity is missing required evidence.' }; }
}
export function compareRetrieval({ product, oracle, row, block, productTransaction }) {
  if (!product) return { status: 'incomplete', reason: 'No complete product output.' };
  const a = validateHistoricalEvidence({ transaction: productTransaction, receipt: product.evidence?.receipt, trace: product.evidence?.traceResponse, row, block });
  const b = validateHistoricalEvidence({ ...oracle, row, block });
  const envelope = compareTransactionEnvelopes(productTransaction, oracle.transaction);
  if (a.status === 'mismatched' || b.status === 'mismatched' || envelope.status === 'mismatched') return { status: 'mismatched', productIdentity: a, oracleIdentity: b, envelope };
  if (a.status !== 'complete' || b.status !== 'complete' || envelope.status !== 'matched') return { status: 'incomplete', productIdentity: a, oracleIdentity: b, envelope };
  const trace = compareTraces(product.evidence.traceResponse, oracle.trace);
  if (trace.status !== 'matched') return { ...trace, productIdentity: a, oracleIdentity: b, envelope };
  return { status: isDeepStrictEqual(receiptProjection(product.evidence.receipt), receiptProjection(oracle.receipt)) ? 'matched' : 'mismatched', trace, productIdentity: a, oracleIdentity: b, envelope };
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
function wordAddress(value) { if (!/^0x0{24}[0-9a-f]{40}$/i.test(value ?? '')) return null; return lower('0x' + value.slice(-40)); }
export function independentInventory({ receipt, trace, transaction, prestate }) {
  const assets = new Map(), allowances = new Map(), unknown = [];
  function asset(token, account, basis) {
    if (!account || account === ZERO) return;
    const key = `${token}:${account}`;
    if (!assets.has(key)) assets.set(key, { key, kind: 'balance', token, account, role: ORACLE_TOKENS[token]?.role ?? 'unknown', semanticSupport: ORACLE_TOKENS[token] ? 'verified_token_query' : 'unknown_token_candidate', bases: [] });
    assets.get(key).bases.push(basis);
  }
  function allowance(token, owner, spender, basis, verified = false) {
    if (!owner || !spender) return;
    const key = `${token}:${owner}:${spender}`;
    if (!allowances.has(key)) allowances.set(key, { key, kind: 'allowance', token, owner, spender, semanticSupport: ORACLE_TOKENS[token]?.allowance ? 'verified_token_query' : 'unknown_permission_candidate', bases: [] });
    allowances.get(key).bases.push({ ...basis, implementationVerified: verified });
  }
  for (const log of receipt?.logs ?? []) {
    if (!ADDRESS.test(log.address ?? '')) continue;
    const token = lower(log.address), topic = lower(log.topics?.[0]);
    if (![TRANSFER, APPROVAL].includes(topic)) { unknown.push({ kind: 'uninterpreted_event', token, topic: topic ?? null }); continue; }
    if (log.topics?.length !== 3 || !WORD.test(log.data ?? '')) { unknown.push({ kind: 'non_erc20_event_shape', token, topic }); continue; }
    const from = wordAddress(log.topics[1]), to = wordAddress(log.topics[2]);
    const basis = { kind: topic === TRANSFER ? 'receipt_transfer_candidate' : 'receipt_approval_candidate', logIndex: integer(log.logIndex), amountRaw: BigInt(log.data).toString() };
    if (topic === TRANSFER) { asset(token, from, basis); asset(token, to, basis); }
    else allowance(token, from, to, basis);
  }
  let frameCount = 0;
  function walk(frame, path, ancestorFailed, depth) {
    if (!frame || ++frameCount > 20000 || depth > 256) return;
    const reverted = ancestorFailed || failed(frame), token = lower(frame.to), data = lower(frame.input);
    if (!reverted && frame.type === 'CALL' && ADDRESS.test(token ?? '') && ADDRESS.test(frame.from ?? '') && typeof data === 'string') {
      const selector = data.slice(0, 10), expectedWords = { '0x095ea7b3': 2, '0x23b872dd': 3, '0xd505accf': 7 }[selector];
      if (expectedWords && data.length === 10 + 64 * expectedWords && BYTES.test(data)) {
        const words = Array.from({ length: expectedWords }, (_, i) => '0x' + data.slice(10 + 64 * i, 74 + 64 * i));
        const delegated = frame.calls?.[0], verified = frame.calls?.length === 1 && delegated?.type === 'DELEGATECALL' && lower(delegated.from) === token && lower(delegated.to) === ORACLE_TOKENS[token]?.implementation && lower(delegated.input) === data && !failed(delegated);
        const owner = selector === '0x095ea7b3' ? lower(frame.from) : wordAddress(words[0]);
        const spender = selector === '0x23b872dd' ? lower(frame.from) : wordAddress(words[selector === '0x095ea7b3' ? 0 : 1]);
        allowance(token, owner, spender, { kind: 'successful_call_candidate', selector, framePath: path }, verified);
        if (selector === '0x23b872dd') { asset(token, owner, { kind: 'successful_transfer_from_candidate', framePath: path }); asset(token, wordAddress(words[1]), { kind: 'successful_transfer_from_candidate', framePath: path }); }
      }
    }
    for (const [i, child] of (frame.calls ?? []).entries()) walk(child, `${path}.${i}`, reverted, depth + 1);
  }
  walk(trace, '0', false, 0);
  const code = prestate?.[lower(transaction?.to)]?.code;
  const rootKind = transaction?.to === null ? 'creation' : typeof code === 'string' && BYTES.test(code) ? code === '0x' ? 'no_runtime_code_observed' : ORACLE_TOKENS[lower(transaction.to)] ? 'configured_token_contract' : 'deployed_contract_protocol_unknown' : 'runtime_code_unavailable';
  return { assets: [...assets.values()].sort((a, b) => a.key.localeCompare(b.key)), allowances: [...allowances.values()].sort((a, b) => a.key.localeCompare(b.key)), unknown,
    rootKind, completeness: 'inconclusive', reasons: ['Observed events and selectors do not enumerate all token, native, fee, nonce, NFT, silent-state, nonstandard-permission or deferred cross-domain effects.', 'Queries use the product historical state adapter on a second provider; they are corroboration, not an independently implemented execution oracle.'] };
}

// Deliberately independent of the product's state-diff/state-override validators.
// Projection preserves every reported field, including absent versus zero.
function ownDataKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid evidence record.');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Unsupported evidence property.');
  }
  return keys;
}
const exactKeys = (value, names) => isDeepStrictEqual(ownDataKeys(value).sort(), [...names].sort());
function stateQuantity(value, bits) {
  // Bound before BigInt parsing, including noncanonical leading-zero input.
  if (typeof value === 'string' && value.length > 80) throw new TypeError('Excessive state quantity.');
  const normalized = integer(value);
  if (BigInt(normalized) >= 1n << BigInt(bits)) throw new TypeError('Out-of-range state quantity.');
  return normalized;
}
export function strictStateDiffProjection(diff) {
  if (!exactKeys(diff, ['pre', 'post'])) throw new TypeError('Missing complete pre/post maps.');
  const accounts = new Set(), slots = new Set();
  let codeBytes = 0;
  return Object.fromEntries(['pre', 'post'].map(side => {
    const names = ownDataKeys(diff[side]);
    if (names.length > 100) throw new TypeError('Excessive diff accounts.');
    const normalized = new Map();
    for (const name of names) {
      const account = address(name), data = diff[side][name];
      if (normalized.has(account)) throw new TypeError('Colliding normalized account addresses.');
      accounts.add(account);
      if (accounts.size > 100) throw new TypeError('Excessive diff account union.');
      const record = {};
      for (const field of ownDataKeys(data).sort()) {
        const value = data[field];
        if (field === 'balance' || field === 'nonce') record[field] = stateQuantity(value, field === 'balance' ? 256 : 64);
        else if (field === 'code') {
          if (typeof value !== 'string') throw new TypeError('Invalid bytecode.');
          codeBytes += Buffer.byteLength(value);
          if (codeBytes > 8 * 1024 * 1024) throw new TypeError('Excessive bytecode evidence.');
          record.code = bytes(value);
        } else if (field === 'storage') {
          const storageNames = ownDataKeys(value), storage = new Map();
          if (storageNames.length > 2000) throw new TypeError('Excessive diff slots.');
          for (const storageName of storageNames) {
            const slot = word(storageName);
            if (storage.has(slot)) throw new TypeError('Colliding normalized storage slots.');
            if (typeof value[storageName] !== 'string') throw new TypeError('Invalid storage value.');
            storage.set(slot, word(value[storageName])); slots.add(account + ':' + slot);
            if (slots.size > 2000) throw new TypeError('Excessive diff slot union.');
          }
          record.storage = Object.fromEntries([...storage].sort(([a], [b]) => a.localeCompare(b)));
        } else throw new TypeError('Unsupported diff account field.');
      }
      normalized.set(account, record);
    }
    return [side, Object.fromEntries([...normalized].sort(([a], [b]) => a.localeCompare(b)))];
  }));
}
export function compareStateDiffs(left, right) {
  try { return { status: isDeepStrictEqual(strictStateDiffProjection(left), strictStateDiffProjection(right)) ? 'matched' : 'mismatched', basis: 'complete_absolute_pre_post_state_diff' }; }
  catch { return { status: 'incomplete', reason: 'Complete pre/post state evidence is absent, malformed or exceeds the independent comparator limits.' }; }
}
function indexedEvidence(evidence) {
  if (!Array.isArray(evidence?.request) || !Array.isArray(evidence?.response) || evidence.request.length > 256 || evidence.response.length > 256) throw new TypeError('Missing or excessive RPC evidence.');
  const requests = new Map(), responses = new Map();
  for (const request of evidence.request) {
    if (!request || !Number.isSafeInteger(request.id) || request.id < 1 || requests.has(request.id) || typeof request.method !== 'string' || !Array.isArray(request.params)) throw new TypeError('Ambiguous request identity.');
    requests.set(request.id, request);
  }
  for (const response of evidence.response) {
    const request = requests.get(response?.id);
    if (!request || request.method !== response.method || responses.has(response.id)) throw new TypeError('Ambiguous response identity.');
    responses.set(response.id, response);
  }
  return { requests: [...requests.values()], result(request) {
    const response = responses.get(request.id);
    if (!response || Object.hasOwn(response, 'error') || !Object.hasOwn(response, 'result')) throw new TypeError('Missing successful response.');
    return response.result;
  } };
}
function tracerOptions(options, tracer) {
  return exactKeys(options, ['tracer', 'timeout', 'tracerConfig']) && options.tracer === tracer && options.timeout === '15s' &&
    (tracer === 'callTracer' ? exactKeys(options.tracerConfig, ['withLog']) && options.tracerConfig.withLog === true : exactKeys(options.tracerConfig, ['diffMode']) && options.tracerConfig.diffMode === true);
}
function callManyShape(request, tracer) {
  const [bundles, context, options] = request.params;
  return request.method === 'debug_traceCallMany' && request.params.length === 3 && Array.isArray(bundles) && bundles.length === 1 && exactKeys(bundles[0], ['transactions']) &&
    Array.isArray(bundles[0].transactions) && bundles[0].transactions.length === 1 && exactKeys(context, ['blockNumber', 'transactionIndex']) && exactKeys(context.blockNumber, ['blockHash', 'requireCanonical']) && tracerOptions(options, tracer);
}
function singleBundleResult(result) {
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]) || result[0].length !== 1) throw new TypeError('Missing single replay result.');
  return result[0][0];
}
function replayCandidate(indexed, transaction, row) {
  const candidates = [];
  for (const request of indexed.requests) {
    if (request.method !== 'debug_traceCallMany' || request.params[2]?.tracer !== 'callTracer') continue;
    if (!callManyShape(request, 'callTracer')) continue;
    const [bundles, context] = request.params, call = bundles[0].transactions[0];
    if (lower(call?.from) !== lower(transaction.from) || lower(call?.to) !== lower(transaction.to) || lower(call?.data) !== lower(transaction.input) || call?.nonce === undefined) continue;
    if (word(context.blockNumber.blockHash) !== row.blockHash || context.blockNumber.requireCanonical !== true || integer(context.transactionIndex) !== row.transactionIndex) continue;
    candidates.push({ call, trace: singleBundleResult(indexed.result(request)), requestId: request.id, request });
  }
  if (candidates.length !== 1) throw new TypeError('Missing or ambiguous original replay.');
  return candidates[0];
}
export function findOriginalReplay(evidence, transaction, row) {
  try { return replayCandidate(indexedEvidence(evidence), transaction, row); }
  catch { return null; }
}
function replayStateEvidence(evidence, transaction, candidate) {
  const indexed = indexedEvidence(evidence), originals = [], replays = [];
  for (const request of indexed.requests) {
    if (request.method === 'debug_traceTransaction' && request.params[1]?.tracer === 'prestateTracer' && request.params[1]?.tracerConfig?.diffMode === true && lower(request.params[0]) === lower(transaction.hash)) {
      if (request.params.length !== 2 || !tracerOptions(request.params[1], 'prestateTracer')) throw new TypeError('Malformed original diff request.');
      originals.push(indexed.result(request));
    }
    if (request.method === 'debug_traceCallMany' && request.params[2]?.tracer === 'prestateTracer' && request.params[2]?.tracerConfig?.diffMode === true &&
      isDeepStrictEqual(request.params.slice(0, 2), candidate.request.params.slice(0, 2))) {
      if (!callManyShape(request, 'prestateTracer')) throw new TypeError('Malformed replay diff request.');
      replays.push(singleBundleResult(indexed.result(request)));
    }
  }
  if (originals.length !== 1 || replays.length !== 1) throw new TypeError('Missing or ambiguous paired state evidence.');
  return { original: originals[0], replay: replays[0] };
}
export function compareOriginalReplay({ transaction, originalTrace, row, productEvidence, oracleEvidence, productIdentity, oracleIdentity }) {
  const a = findOriginalReplay(productEvidence, transaction, row), b = findOriginalReplay(oracleEvidence, transaction, row);
  if (!a || !b) return { status: 'incomplete', reason: 'A complete original-position replay is not present on both providers.' };
  const comparisons = { productVsOriginal: compareTraces(originalTrace, a.trace), oracleVsOriginal: compareTraces(originalTrace, b.trace), providers: compareTraces(a.trace, b.trace) };
  if (Object.values(comparisons).some(value => value.status === 'mismatched')) return { status: 'mismatched', comparisons, reason: 'Strict original-position call-tree evidence differs.' };
  if (Object.values(comparisons).some(value => value.status !== 'matched')) return { status: 'incomplete', comparisons, reason: 'Required original-position trace fields are incomplete.' };
  try {
    if (word(transaction.hash) !== row.transactionHash || word(transaction.blockHash) !== row.blockHash || integer(transaction.blockNumber) !== row.blockNumber || integer(transaction.transactionIndex) !== row.transactionIndex || integer(transaction.chainId) !== '999') return { status: 'mismatched', comparisons, reason: 'Original transaction identity differs from the replay position.' };
    const productState = replayStateEvidence(productEvidence, transaction, a), oracleState = replayStateEvidence(oracleEvidence, transaction, b);
    comparisons.state = {
      productVsOriginal: compareStateDiffs(productState.original, productState.replay),
      oracleVsOriginal: compareStateDiffs(oracleState.original, oracleState.replay),
      originalProviders: compareStateDiffs(productState.original, oracleState.original),
      replayProviders: compareStateDiffs(productState.replay, oracleState.replay),
    };
    if (Object.values(comparisons.state).some(value => value.status === 'mismatched')) return { status: 'mismatched', comparisons, reason: 'Complete original-position pre/post state evidence differs, including absolute values and field presence.' };
    if (Object.values(comparisons.state).some(value => value.status !== 'matched')) return { status: 'incomplete', comparisons, reason: 'Required original-position pre/post state evidence is malformed or incomplete.' };
    const sender = address(transaction.from), originalNonce = stateQuantity(transaction.nonce, 64);
    for (const diff of [productState.original, productState.replay, oracleState.original, oracleState.replay]) {
      const normalized = strictStateDiffProjection(diff);
      if (!Object.hasOwn(normalized.pre[sender] ?? {}, 'nonce') || !Object.hasOwn(normalized.post[sender] ?? {}, 'nonce')) return { status: 'incomplete', comparisons, reason: 'Original state evidence does not report the sender nonce transition.' };
      if (normalized.pre[sender].nonce !== originalNonce || normalized.post[sender].nonce !== String(BigInt(originalNonce) + 1n)) return { status: 'mismatched', comparisons, reason: 'Original state evidence does not reproduce the transaction sender nonce and increment.' };
    }
    if (integer(transaction.type) !== '0' || transaction.accessList !== undefined || ['authorizationList', 'blobVersionedHashes', 'maxFeePerBlobGas'].some(key => transaction[key] !== undefined)) return { status: 'incomplete', comparisons, reason: 'The shared adapter does not reproduce the complete typed transaction envelope; effective gas price alone is insufficient.' };
    const expected = { from: lower(transaction.from), to: lower(transaction.to), data: lower(transaction.input), value: integer(transaction.value), gas: integer(transaction.gas), gasPrice: integer(transaction.gasPrice), nonce: integer(transaction.nonce) };
    for (const candidate of [a, b]) {
      if (Object.keys(candidate.call).sort().join() !== Object.keys(expected).sort().join()) throw new TypeError();
      const normalized = { from: address(candidate.call.from), to: address(candidate.call.to), data: bytes(candidate.call.data), value: integer(candidate.call.value), gas: integer(candidate.call.gas), gasPrice: integer(candidate.call.gasPrice), nonce: integer(candidate.call.nonce) };
      if (!isDeepStrictEqual(normalized, expected)) return { status: 'mismatched', comparisons, reason: 'Original envelope fields differ.' };
    }
    for (const identity of [productIdentity, oracleIdentity]) {
      if (!identity || identity.stateBinding !== 'block_hash_and_transaction_index' || identity.headerContext !== 'original_block' || identity.method !== 'debug_traceCallMany' || identity.transactionHash !== row.transactionHash || identity.stateBlockHash !== row.blockHash || integer(identity.blockNumber) !== row.blockNumber || integer(identity.timestamp) !== row.timestamp || integer(identity.transactionIndex) !== row.transactionIndex || integer(identity.postTransactionIndex) !== String(BigInt(row.transactionIndex) + 1n) || identity.validation?.originalReplay !== 'semantic_trace_and_receipt_match' || identity.validation?.originalReplayState !== 'complete_pre_post_diff_match' || identity.validation?.feeRepresentation !== 'original_effective_gas_price' || !isDeepStrictEqual(identity.validation.headerFields, ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'])) throw new TypeError();
    }
    return { status: 'matched', comparisons, scope: 'Complete unsigned legacy-call envelope, strict original-position trace and complete pre/post state-diff endpoint agreement; shared adapter, no signature, cryptographic state proof or independent-engine proof.' };
  } catch { return { status: 'incomplete', comparisons, reason: 'Complete original envelope, bound original/replay state evidence or original-position validation identity is unavailable.' }; }
}
