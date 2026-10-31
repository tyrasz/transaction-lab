// Output-only comparison. No network, execution, state repair or product
// normalization helper is used. This compares five result channels, not the
// complete entered call tree or all possible effects outside observed state.
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const MAX = (1n << 256n) - 1n, ZERO = '0x' + '0'.repeat(64);
const LIMITS = { frames: 1000, depth: 32, logs: 2000, accounts: 128, slots: 8192, bytes: 8 * 1024 * 1024, wireBytes: 64 * 1024 * 1024, records: 256, index: 0xffffffffn };
class Incomplete extends Error {}
const need = (condition, message) => { if (!condition) throw new Incomplete(message); };
const textMatches = (value, pattern) => typeof value === 'string' && pattern.test(value);
function quantity(value, max = MAX) {
  need((typeof value === 'string' && value.length <= 80 && /^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/.test(value)) ||
    (Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)), 'Malformed canonical quantity');
  const result = BigInt(value); need(result <= max, 'Quantity exceeds comparison bound'); return result;
}
const hex = value => '0x' + quantity(value).toString(16);
function ordinal(value, max) {
  need(typeof value === 'number' || (typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)), 'Log ordinal must be an integer or canonical hex quantity');
  return quantity(value, max);
}
function bounded(value, max = LIMITS.bytes) {
  let serialized; try { serialized = JSON.stringify(value); } catch { throw new Incomplete('Comparison evidence is not bounded JSON'); }
  need(typeof serialized === 'string' && Buffer.byteLength(serialized) <= max, 'Comparison evidence exceeds byte bound');
}
function failure(frame) {
  if (own(frame, 'error')) need(typeof frame.error === 'string' && frame.error.length > 0 && frame.error.length <= 2000, 'Malformed trace error');
  if (own(frame, 'revertReason')) need(typeof frame.revertReason === 'string' && frame.revertReason.length <= 2000 && (!frame.revertReason || own(frame, 'error')), 'Malformed or contradictory trace revert reason');
  return own(frame, 'error') ? frame.error : null;
}
export function providerOutput(frame) {
  need(record(frame), 'Missing trace frame');
  // Geth native callTracer declares Output with json omitempty. Only actual
  // omission means empty bytes; explicit null/undefined or malformed bytes do not.
  if (!own(frame, 'output')) return '0x';
  need(textMatches(frame.output, DATA), 'Malformed trace output'); return frame.output;
}
const sortChanges = rows => rows.sort((a, b) => a.address.localeCompare(b.address)).map(row => ({ ...row, ...(row.storage ? { storage: row.storage.sort((a, b) => a.slot.localeCompare(b.slot)) } : {}) }));

// Sparse Geth diff interpretation, independently anchored to proven inputs.
// Omitted post basic fields are unchanged; a pre-only slot is cleared. A
// post-only slot requires an explicit, independently proven zero input value.
export function providerChanges(raw, inputs) {
  bounded(raw); need(record(raw) && equal(Object.keys(raw).sort(), ['post', 'pre']), 'Raw diff requires exactly pre/post');
  need(record(raw.pre) && record(raw.post), 'Diff maps missing');
  const addresses = Object.keys(raw.pre).sort();
  need(equal(addresses, Object.keys(raw.post).sort()), 'Whole-account creation/deletion is outside this comparison');
  need(addresses.length <= LIMITS.accounts && record(inputs?.accounts) && Array.isArray(inputs.provenance), 'Malformed or excessive input accounts');
  let slots = 0; const out = [];
  for (const address of addresses) {
    need(textMatches(address, ADDRESS), 'Malformed/case-ambiguous address');
    const before = inputs.accounts[address], proofs = inputs.provenance.filter(p => p.account === address);
    need(before?.exists === true && proofs.length === 1 && record(proofs[0].accountProof), 'Unknown or unsupported account lifecycle');
    const proof = proofs[0].accountProof, pre = raw.pre[address], post = raw.post[address];
    need(record(pre) && record(post) && record(before.storage), 'Malformed account');
    need(textMatches(before.code, DATA) && textMatches(proof.codeHash, WORD), 'Malformed proven account');
    for (const phase of [pre, post]) need(Object.keys(phase).every(k => ['balance', 'nonce', 'code', 'codeHash', 'storage'].includes(k)), 'Unknown account field');
    for (const key of ['balance', 'nonce']) if (own(pre, key)) need(quantity(pre[key]) === quantity(before[key]), 'Raw prior basic state differs from proof');
    if (own(pre, 'code')) need(textMatches(pre.code, DATA) && pre.code === before.code, 'Raw prior code differs from proof');
    if (own(pre, 'codeHash')) need(textMatches(pre.codeHash, WORD) && pre.codeHash === proof.codeHash, 'Raw prior code hash differs from proof');
    if (own(post, 'code')) need(textMatches(post.code, DATA) && post.code === before.code, 'Runtime code mutation unsupported');
    if (own(post, 'codeHash')) need(textMatches(post.codeHash, WORD) && post.codeHash === proof.codeHash, 'Runtime code hash mutation unsupported');
    const changes = { address };
    for (const key of ['balance', 'nonce']) if (own(post, key)) {
      const old = quantity(before[key]), next = quantity(post[key]);
      // Nonzero old basic state cannot disappear from a changed field's preimage.
      need(own(pre, key) || old === 0n, 'Omitted nonzero prior basic state');
      if (old !== next) changes[key] = { before: hex(old.toString()), after: hex(next.toString()) };
    }
    const ps = own(pre, 'storage') ? pre.storage : {}, ns = own(post, 'storage') ? post.storage : {};
    need(record(ps) && record(ns), 'Malformed storage'); const storage = [];
    for (const slot of [...new Set([...Object.keys(ps), ...Object.keys(ns)])].sort()) {
      need(++slots <= LIMITS.slots && textMatches(slot, WORD) && textMatches(before.storage[slot], WORD), 'Unknown, excessive or malformed prior storage');
      const old = before.storage[slot];
      if (own(ps, slot)) need(textMatches(ps[slot], WORD) && ps[slot] === old, 'Raw prior storage differs from proof');
      else need(BigInt(old) === 0n, 'Omitted nonzero prior storage');
      const next = own(ns, slot) ? ns[slot] : ZERO; need(textMatches(next, WORD), 'Malformed next storage');
      if (old !== next) storage.push({ slot, before: old, after: next });
    }
    if (storage.length) changes.storage = storage;
    if (Object.keys(changes).length > 1) out.push(changes);
  }
  return sortChanges(out);
}

function logPayload(log) {
  need(record(log) && textMatches(log.address, ADDRESS) && Array.isArray(log.topics) && log.topics.length <= 4 && log.topics.every(t => textMatches(t, WORD)) && textMatches(log.data, DATA), 'Malformed log');
  if (own(log, 'removed')) need(log.removed === false, 'Removed or malformed log');
  return { address: log.address, topics: log.topics, data: log.data };
}
export function committedLogs(trace) {
  bounded(trace); let frames = 0, logs = 0; const found = [];
  function scan(frame, ancestorFailed = false, depth = 0) {
    need(record(frame) && ++frames <= LIMITS.frames && depth <= LIMITS.depth, 'Malformed or excessive log call tree');
    need(['CALL', 'DELEGATECALL', 'STATICCALL', 'CALLCODE'].includes(frame.type), 'Unknown or lifecycle frame is outside comparison scope');
    need(textMatches(frame.from, ADDRESS) && textMatches(frame.to, ADDRESS) && textMatches(frame.input, DATA), 'Malformed frame identity or input');
    need(quantity(frame.gasUsed, 5000000n) <= quantity(frame.gas, 5000000n), 'Frame gas use exceeds budget');
    const value = frame.type === 'STATICCALL' && !own(frame, 'value') ? 0n : quantity(frame.value);
    need(frame.type !== 'STATICCALL' || value === 0n, 'Nonzero static-call value');
    const error = failure(frame), failed = ancestorFailed || !!error; providerOutput(frame);
    const calls = own(frame, 'calls') ? frame.calls : [], ownLogs = own(frame, 'logs') ? frame.logs : [];
    need(Array.isArray(calls) && Array.isArray(ownLogs), 'Malformed trace children');
    const entries = []; let lastPosition = -1, lastIndex = null;
    for (const log of ownLogs) {
      need(++logs <= LIMITS.logs, 'Excessive trace logs'); const payload = logPayload(log);
      const position = own(log, 'position') ? Number(ordinal(log.position, BigInt(calls.length))) : null;
      const hasIndex = own(log, 'index'), hasAlias = own(log, 'logIndex');
      const index = hasIndex || hasAlias ? ordinal(hasIndex ? log.index : log.logIndex, LIMITS.index) : null;
      if (hasIndex && hasAlias) need(index === ordinal(log.logIndex, LIMITS.index), 'Conflicting log index aliases');
      if (position !== null) { need(position >= lastPosition, 'Log positions decrease within a frame'); lastPosition = position; }
      if (index !== null) { need(lastIndex === null || index > lastIndex, 'Log indices decrease or repeat within a frame'); lastIndex = index; }
      const entry = { payload, position, index }; if (!failed) { entries.push(entry); found.push(entry); }
    }
    return { entries, children: calls.map(child => scan(child, failed, depth + 1)) };
  }
  const tree = scan(trace), indexed = found.filter(x => x.index !== null).length;
  need(indexed === 0 || indexed === found.length, 'Partial log indices leave ambiguous ordering');
  if (indexed) {
    need(new Set(found.map(x => x.index.toString())).size === found.length, 'Duplicate committed log index');
    const byIndex = (a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
    function ordered(node) {
      const children = node.children.map(ordered); let previousMax = null;
      for (const child of children) if (child.length) {
        need(previousMax === null || previousMax < child[0].index, 'Log indices contradict sibling-call ordering'); previousMax = child.at(-1).index;
      }
      for (const entry of node.entries) for (let i = 0; i < children.length; i++) {
        const child = children[i]; if (!child.length) continue;
        need(entry.index < child[0].index || entry.index > child.at(-1).index, 'Parent log index interrupts an executing child subtree');
        if (entry.position !== null) need(i < entry.position ? child.at(-1).index < entry.index : entry.index < child[0].index, 'Log position contradicts descendant indices');
      }
      return [...node.entries, ...children.flat()].sort(byIndex);
    }
    return ordered(tree).map(x => x.payload);
  }
  function positioned(node) {
    const children = node.children.map(positioned);
    if (!children.some(x => x.length)) return node.entries.map(x => x.payload);
    if (!node.entries.length) return children.flat();
    need(node.entries.every(x => x.position !== null), 'Ambiguous cross-frame log order');
    const result = [];
    for (let i = 0; i <= children.length; i++) {
      result.push(...node.entries.filter(x => x.position === i).map(x => x.payload));
      if (i < children.length) result.push(...children[i]);
    }
    return result;
  }
  return positioned(tree);
}

function successful(row) {
  need(typeof row.responseText === 'string', 'Successful wire response missing');
  const value = JSON.parse(row.responseText);
  need(record(value) && value.id === row.id && value.jsonrpc === '2.0' && own(value, 'result') && !own(value, 'error'), 'Invalid successful wire envelope'); return value.result;
}
function originalRecords(product, request, header) {
  need(Array.isArray(product.transportEvidence) && product.transportEvidence.length <= LIMITS.records, 'Raw provider wire evidence missing or excessive');
  let bytes = 0; const ids = new Set();
  for (const row of product.transportEvidence) {
    need(record(row) && Number.isSafeInteger(row.id) && row.id > 0 && !ids.has(row.id), 'Duplicate or malformed provider evidence id'); ids.add(row.id);
    need(typeof row.requestText === 'string' && equal(JSON.parse(row.requestText), row.request) && row.request.id === row.id && row.request.jsonrpc === '2.0' && Array.isArray(row.request.params) && sha(row.requestText) === row.requestSha256 && Buffer.byteLength(row.requestText) === row.requestBytes, 'Provider request hash mismatch');
    bytes += Buffer.byteLength(row.requestText);
    if (own(row, 'responseText')) {
      need(typeof row.responseText === 'string' && row.transport?.complete === true && sha(row.responseText) === row.transport.responseSha256 && Buffer.byteLength(row.responseText) === row.transport.observedBytes && Buffer.byteLength(row.responseText) <= LIMITS.bytes, 'Provider response hash mismatch'); bytes += Buffer.byteLength(row.responseText);
    }
    need(bytes <= LIMITS.wireBytes, 'Provider wire evidence exceeds byte bound');
  }
  const records = product.transportEvidence.filter(r => r.request.method === 'debug_traceCall').filter(r => {
    const [call, selector, options] = r.request.params;
    return call?.from === request.from && call?.to === request.to && call?.data === request.data && selector?.blockHash === header.hash && !own(options ?? {}, 'stateOverrides');
  });
  const selected = {};
  for (const row of records) {
    const [call, selector, options] = row.request.params;
    need(row.request.params.length === 3 && equal(selector, { blockHash: header.hash, requireCanonical: true }), 'Original block selector differs');
    need(quantity(call.value) === 0n && quantity(call.gas) === 5000000n, 'Original value/gas differs');
    need(Object.keys(call).every(k => ['from', 'to', 'data', 'value', 'gas', 'nonce'].includes(k)), 'Original envelope differs');
    need(record(options) && Object.keys(options).every(k => ['tracer', 'tracerConfig', 'timeout'].includes(k)), 'Unexpected original override');
    const key = options.tracer === 'callTracer' ? 'trace' : options.tracer === 'prestateTracer' ? 'diff' : null;
    if (!key) continue;
    need(equal(options.tracerConfig, key === 'trace' ? { withLog: true } : { diffMode: true }), 'Original tracer configuration differs');
    need(!selected[key], 'Original evidence ambiguous'); selected[key] = { id: row.id, call, result: successful(row) };
  }
  need(selected.trace && selected.diff && equal(selected.trace.call, selected.diff.call), 'Original trace/diff missing or envelopes differ');
  const match = (method, params) => product.transportEvidence.filter(r => r.request.method === method && equal(r.request.params, params));
  const nonce = match('eth_getTransactionCount', [request.from, { blockHash: header.hash, requireCanonical: true }]);
  need(nonce.length === 1, 'Pinned sender nonce read missing or ambiguous'); selected.nonce = { id: nonce[0].id, value: quantity(successful(nonce[0])) };
  const before = match('eth_getBlockByHash', [header.hash, false]), after = match('eth_getBlockByNumber', [header.number, false]);
  need(before.length === 1 && after.length === 1 && before[0].id < selected.trace.id && after[0].id > selected.diff.id, 'Original/final pinned header evidence missing or ambiguous');
  need(equal(successful(before[0]), header) && equal(successful(after[0]), header), 'Provider full header differs from declared context');
  selected.headers = [before[0].id, after[0].id]; return selected;
}
function localBinding(local, request, header) {
  need(record(request) && equal(Object.keys(request).sort(), ['data', 'from', 'gas', 'to', 'value']) && textMatches(request.from, ADDRESS) && textMatches(request.to, ADDRESS) && textMatches(request.data, DATA) && quantity(request.value) === 0n && quantity(request.gas) === 5000000n, 'Unsupported fixed request envelope');
  const context = local.inputs.context, env = local.output.environment, profile = local.output.profile;
  need(context?.chainId === 1 && context.blockHash === header.hash && context.stateRoot === header.stateRoot && equal(context.header, header) && equal(context.selector, { blockHash: header.hash, requireCanonical: true }) && context.expectedOutputsUsed === false, 'Local proven input context differs from declared header');
  need(env?.chainId === 1 && env.sourceBlockHash === header.hash && env.sourceParentHash === header.parentHash && env.mixHash === header.mixHash && env.miner === header.miner && quantity(env.baseFeePerGas) === 0n, 'Local execution header differs');
  for (const field of ['number', 'timestamp', 'gasLimit']) need(quantity(env[field]) === quantity(header[field]), 'Local execution header differs');
  need(profile?.sourceBlockHash === header.hash && profile.sourceStateRoot === header.stateRoot && profile.expectedOutputsUsed === false && profile.feesSettled === false && quantity(profile.executionBaseFee) === 0n && quantity(profile.gasPrice) === 0n && quantity(profile.declaredGasLimit) === 5000000n, 'Local execution profile differs');
  need(local.output.stateDisposition === 'message_result_retained_in_supplied_manager' && local.output.semantics?.feeSettlement === false, 'Local result is not a retained unsigned unpriced execution');
  const trace = local.output.trace;
  need(trace?.type === 'CALL' && trace.from === request.from && trace.to === request.to && trace.input === request.data && quantity(trace.value) === 0n, 'Local root differs from fixed request');
}
export function compareReference(local, product, request, header, expectedImplementation) {
  const result = {
    status: 'incomplete', checks: {},
    channels: ['executionStatus', 'returnData', 'committedLogs', 'fullObservedStateChanges', 'gasAccounting'],
    normalization: { omittedProviderOutput: 'empty_bytes_only_when_output_property_absent_Geth_callTracer_omitempty', logOrdering: 'distinct_bounded_indices_with_topology_checks_or_unambiguous_positions', logIndexGaps: 'permitted' },
    limitations: ['Selected development workload; no population score or independent consensus/finality.', 'Unsigned unpriced calls; no outer signature validation, fee settlement or original transaction-position claim.', 'Five result channels only; full call-tree equality is not claimed.', 'Observed state is limited to demanded proof-verified inputs and local writes; no recomputed post-state root or complete-effect proof.']
  };
  try {
    need(['success', 'reverted', 'failed'].includes(local.output?.execution?.status), 'Local execution unavailable');
    need(local.inputs.status === 'available', 'Local input collection unavailable'); localBinding(local, request, header);
    if (expectedImplementation) need(equal(product.implementation, expectedImplementation), 'Product implementation differs from frozen declaration');
    need(product.canonicalStatus === 'verified', 'Product canonical state unavailable');
    const raw = originalRecords(product, request, header); result.providerEvidenceIds = { trace: raw.trace.id, diff: raw.diff.id, nonce: raw.nonce.id, headers: raw.headers };
    const nonce = quantity(local.inputs.accounts[request.from]?.nonce);
    need(raw.nonce.value === nonce, 'Pinned provider nonce differs from independently proven sender');
    if (own(raw.trace.call, 'nonce')) need(quantity(raw.trace.call.nonce) === nonce, 'Explicit call nonce differs from independently proven sender');
    need(quantity(raw.diff.result.pre?.[request.from]?.nonce) === nonce && quantity(raw.diff.result.post?.[request.from]?.nonce) === nonce + 1n, 'Original diff nonce transition is not the proven starting nonce plus one');
    const trace = raw.trace.result;
    need(trace?.type === 'CALL' && trace.from === request.from && trace.to === request.to && trace.input === request.data && quantity(trace.gas) === 5000000n && quantity(trace.value) === 0n, 'Trace root identity differs');
    const error = failure(trace), status = error ? (error === 'execution reverted' ? 'reverted' : 'failed') : 'success';
    result.checks.executionStatus = local.output.execution.status === status;
    result.checks.returnData = local.output.execution.returnData === providerOutput(trace);
    result.providerLogs = committedLogs(trace);
    need(Array.isArray(local.output.logs) && local.output.logs.length <= LIMITS.logs, 'Malformed local committed logs');
    result.checks.committedLogs = equal(local.output.logs.map(logPayload), result.providerLogs);
    result.providerChanges = providerChanges(raw.diff.result, local.inputs);
    bounded(local.changes.accounts); need(Array.isArray(local.changes.accounts), 'Missing local observed state changes');
    result.localChanges = sortChanges(structuredClone(local.changes.accounts));
    result.checks.fullObservedStateChanges = equal(result.localChanges, result.providerChanges);
    result.providerRootGas = quantity(trace.gasUsed, 5000000n).toString();
    result.localTransactionStyleGas = quantity(local.output.gasAccounting?.gasUsed, 5000000n).toString();
    result.checks.gasAccounting = result.providerRootGas === result.localTransactionStyleGas;
    result.status = Object.values(result.checks).every(Boolean) ? 'matched' : 'mismatched';
  } catch (error) {
    result.status = Object.values(result.checks).includes(false) ? 'mismatched' : 'incomplete';
    result.reason = error instanceof Incomplete ? error.message : 'Evidence malformed or unsupported';
  }
  return result;
}
