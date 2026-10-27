// Offline cohort adjudication. Adapted from the independently reviewed lending
// output comparator; original sealed comparator/captures remain unchanged.
// No product normalizers, execution, network or state repair are imported.
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const MAX = (1n << 256n) - 1n, ZERO = '0x' + '0'.repeat(64);
const LIMITS = { frames: 1000, depth: 32, logs: 2000, accounts: 128, slots: 8192, bytes: 8 * 1024 * 1024, wireBytes: 64 * 1024 * 1024, records: 65, index: 0xffffffffn };
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

export class CohortAdjudicationError extends Error {
  constructor(message) { super(message); this.name = 'CohortAdjudicationError'; }
}
const CHANNELS = ['executionStatus', 'returnData', 'committedLogs', 'fullObservedStateChanges', 'gasAccounting'];
const ownKeys = value => Object.keys(value).sort();
const exactKeys = (value, required, optional = []) => record(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).every(k => typeof k === 'string' && [...required, ...optional].includes(k) && Object.getOwnPropertyDescriptor(value, k)?.enumerable && own(Object.getOwnPropertyDescriptor(value, k), 'value')) && required.every(k => own(value, k));
const safeReason = error => error instanceof Incomplete ? error.message : 'Malformed retained evidence';
function implementation(value) {
  need(exactKeys(value, ['name', 'version', 'sourceSha256', 'sourceFiles']), 'Concrete implementation identity missing');
  need(typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200 && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 80 && textMatches(value.sourceSha256, /^[0-9a-f]{64}$/), 'Implementation identity is malformed');
  need(Array.isArray(value.sourceFiles) && value.sourceFiles.length > 0 && value.sourceFiles.length <= 20000 && value.sourceFiles.every(x => typeof x === 'string' && x.length > 0 && x.length <= 1024) && new Set(value.sourceFiles).size === value.sourceFiles.length, 'Implementation source inventory is malformed');
}
function boundImplementation(actual, expected) { implementation(expected); implementation(actual); need(equal(actual, expected), 'Implementation differs from the frozen expected source identity'); }
function exceptionClass(error, local = false) {
  if (error === null) return { status: 'success', exception: null };
  if (error === (local ? 'revert' : 'execution reverted')) return { status: 'reverted', exception: 'revert' };
  const known = [
    [/^out of gas$/, 'out_of_gas'], [/^invalid opcode(?:: opcode 0x[0-9a-f]{2} not defined)?$/, 'invalid_opcode'],
    [/^invalid (?:JUMP|jump)(?: destination)?$/, 'invalid_jump'], [/^stack underflow(?: \([0-9]+ <=> [0-9]+\))?$/, 'stack_underflow'],
    [/^stack (?:limit reached|overflow)(?: \([0-9]+\))?$/, 'stack_overflow'], [/^gas uint64 overflow$/, 'gas_overflow'],
    [/^(?:write protection|static state change)$/, 'write_protection'], [/^return data out of bounds$/, 'return_data_bounds'],
  ];
  for (const [pattern, exception] of known) if (typeof error === 'string' && pattern.test(error)) return { status: 'failed', exception };
  throw new Incomplete('Unrecognized execution error is not evidence of a completed EVM fault');
}
function requestProfile(request) {
  need(exactKeys(request, ['from', 'to', 'data', 'value', 'gas']), 'Projected request requires exactly from/to/data/value/gas');
  need(textMatches(request.from, ADDRESS) && (request.to === null || textMatches(request.to, ADDRESS)) && textMatches(request.data, DATA), 'Projected request identity or calldata is malformed');
  const value = quantity(request.value), gas = quantity(request.gas);
  if (request.to === null) return { supported: false, reason: 'Contract creation is outside the ordinary call profile' };
  if (request.data.length > 65538 || gas !== 5000000n) return { supported: false, reason: 'Projected input exceeds the fixed calldata or gas profile' };
  if (['from', 'to'].some(k => request[k] === '0x000000000000000000000000000000000000ba1a')) return { supported: false, reason: 'Input overlaps the reserved execution witness' };
  return { supported: true, call: { from: request.from, to: request.to, data: request.data, value: hex(value.toString()), gas: hex(gas.toString()) } };
}
function successful(row) {
  need(typeof row.responseText === 'string', 'Successful wire response missing');
  const wire = JSON.parse(row.responseText);
  need(record(wire) && wire.jsonrpc === '2.0' && wire.id === row.id && own(wire, 'result') && !own(wire, 'error'), 'Invalid successful wire response');
  return wire.result;
}
function wireRecords(product) {
  need(Array.isArray(product.transportEvidence) && product.transportEvidence.length <= LIMITS.records, 'Raw provider wire evidence missing or excessive');
  let bytes = 0; const ids = new Set();
  for (const row of product.transportEvidence) {
    need(record(row) && Number.isSafeInteger(row.id) && row.id > 0 && !ids.has(row.id), 'Duplicate or malformed provider evidence id'); ids.add(row.id);
    need(typeof row.requestText === 'string' && record(row.request) && equal(JSON.parse(row.requestText), row.request) && row.request.id === row.id && row.request.jsonrpc === '2.0' && typeof row.request.method === 'string' && Array.isArray(row.request.params) && sha(row.requestText) === row.requestSha256 && Buffer.byteLength(row.requestText) === row.requestBytes, 'Provider request hash mismatch');
    bytes += Buffer.byteLength(row.requestText);
    if (own(row, 'responseText')) {
      need(typeof row.responseText === 'string' && row.transport?.complete === true && sha(row.responseText) === row.transport.responseSha256 && Buffer.byteLength(row.responseText) === row.transport.observedBytes && Buffer.byteLength(row.responseText) <= LIMITS.bytes, 'Provider response hash mismatch');
      bytes += Buffer.byteLength(row.responseText);
    }
    need(bytes <= LIMITS.wireBytes, 'Provider evidence exceeds byte bound');
  }
  return product.transportEvidence;
}
function originalEvidence(product, call, header) {
  const records = wireRecords(product), pinned = { blockHash: header.hash, requireCanonical: true };
  const match = (method, params) => records.filter(r => r.request.method === method && equal(r.request.params, params));
  const one = (method, params) => { const found = match(method, params); need(found.length === 1, 'Missing or ambiguous ' + method + ' evidence'); return found[0]; };
  const chain = one('eth_chainId', []); need(quantity(successful(chain)) === 1n, 'Provider chain differs');
  const before = one('eth_getBlockByHash', [header.hash, false]), after = one('eth_getBlockByNumber', [hex(header.number), false]);
  need(equal(successful(before), header) && equal(successful(after), header), 'Provider full header differs from the declared context');
  const nonce = one('eth_getTransactionCount', [call.from, pinned]), senderCode = one('eth_getCode', [call.from, pinned]);
  need(successful(senderCode) === '0x', 'Coded sender is outside the supported profile');
  const selected = {};
  for (const row of records.filter(r => r.request.method === 'debug_traceCall')) {
    const [envelope, selector, options] = row.request.params;
    if (!record(envelope) || envelope.from !== call.from || envelope.to !== call.to || envelope.data !== call.data || !equal(selector, pinned) || own(options ?? {}, 'stateOverrides')) continue;
    if (quantity(envelope.gas) !== quantity(call.gas) || quantity(envelope.value) !== quantity(call.value)) continue;
    need(row.request.params.length === 3 && exactKeys(envelope, ['from', 'to', 'data', 'gas', 'value'], ['nonce']), 'Original call envelope has unrecognized fields');
    need(exactKeys(options, ['tracer', 'tracerConfig', 'timeout']), 'Original execution options differ');
    need(options.timeout === '15s', 'Original tracer timeout differs');
    const key = options.tracer === 'callTracer' ? 'trace' : options.tracer === 'prestateTracer' ? 'diff' : null;
    if (!key) continue;
    need(equal(options.tracerConfig, key === 'trace' ? { withLog: true } : { diffMode: true }), 'Original tracer configuration differs');
    need(!selected[key], 'Original evidence is ambiguous'); selected[key] = { id: row.id, call: envelope, result: successful(row) };
  }
  need(selected.trace, 'Original call trace missing');
  if (selected.diff) need(equal(selected.trace.call, selected.diff.call), 'Original trace/diff envelopes differ');
  need(before.id < selected.trace.id && after.id > Math.max(selected.trace.id, selected.diff?.id ?? 0), 'Original/final header evidence order differs');
  const value = quantity(successful(nonce));
  if (own(selected.trace.call, 'nonce')) need(quantity(selected.trace.call.nonce) === value, 'Explicit original nonce differs from pinned read');
  return { ...selected, nonce: { id: nonce.id, value }, headerIds: [before.id, after.id], chainId: chain.id, senderCodeId: senderCode.id };
}
function productBinding(product, call, header, expected) {
  boundImplementation(product.implementation, expected);
  need(product.kind === 'experimental_standard_evm_unsigned_call' && product.scope?.state === 'pinned_block_end' && product.scope.fees === 'gas_price_omitted_no_fee_settlement' && product.scope.signedTransactionValidation === false, 'Product execution profile is unsupported or incomplete');
  need(product.canonicalStatus === 'verified', 'Product canonical context is unavailable');
  need(product.request?.chainId === '1' && equal(product.request.block, { blockHash: header.hash, requireCanonical: true }) && equal(product.request.transaction, call), 'Product request differs from the declared context');
  const raw = originalEvidence(product, call, header), trace = raw.trace.result;
  need(trace?.type === 'CALL' && trace.from === call.from && trace.to === call.to && trace.input === call.data && quantity(trace.gas) === quantity(call.gas) && quantity(trace.value ?? '0x0') === quantity(call.value), 'Product root trace differs from the projected request');
  const classified = exceptionClass(failure(trace)), output = providerOutput(trace);
  need(product.execution?.status === (classified.status === 'success' ? 'success' : 'reverted_or_failed') && product.execution.returnData === output && product.execution.error === (trace.error ?? null) && product.execution.revertReason === (trace.revertReason ?? null) && quantity(product.execution.gasUsed) === quantity(trace.gasUsed) && equal(product.execution.trace, trace), 'Product summary contradicts its raw original trace');
  // Execution availability does not require every comparison channel. For
  // example, a valid reverted trace can contain a lifecycle branch that the
  // independent local profile does not execute. Keep it in the denominator.
  let count = 0, logCount = 0;
  function validateTree(frame, depth = 0) {
    need(record(frame) && ++count <= LIMITS.frames && depth <= LIMITS.depth && ['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type), 'Malformed or excessive original execution tree');
    need(textMatches(frame.from, ADDRESS) && textMatches(frame.to, ADDRESS) && textMatches(frame.input, DATA), 'Malformed original frame identity');
    need(quantity(frame.gasUsed, 5000000n) <= quantity(frame.gas, 5000000n), 'Malformed original frame gas');
    quantity(frame.value ?? '0x0'); failure(frame); providerOutput(frame);
    need(Array.isArray(frame.calls ?? []) && Array.isArray(frame.logs ?? []), 'Malformed original frame children or logs');
    for (const log of frame.logs ?? []) { need(++logCount <= LIMITS.logs, 'Excessive original logs'); logPayload(log); }
    for (const child of frame.calls ?? []) validateTree(child, depth + 1);
  }
  validateTree(trace); need(quantity(trace.gasUsed) > 0n, 'Original root gas use is absent');
  return { raw, classified, output, gas: quantity(trace.gasUsed, 5000000n).toString() };
}
function unsupportedProduct(product, call, header, expected) {
  // Capability rejection is a non-pass. Admit only the current bounded
  // engine's explicit reason plus corresponding raw source-bound evidence;
  // arbitrary provider errors must not be reclassified as unsupported input.
  if (product.canonicalStatus !== 'unverified') return null;
  boundImplementation(product.implementation, expected);
  need(product.request?.chainId === '1' && equal(product.request.block, { blockHash: header.hash, requireCanonical: true }) && equal(product.request.transaction, call), 'Unsupported product request differs');
  const records = wireRecords(product), pinned = { blockHash: header.hash, requireCanonical: true };
  const headers = records.filter(r => r.request.method === 'eth_getBlockByHash' && equal(r.request.params, [header.hash, false]));
  need(headers.length === 1 && equal(successful(headers[0]), header), 'Unsupported product source header is unbound');
  if (product.measurementFailure === 'Only code-free senders are supported.') {
    const code = records.filter(r => r.request.method === 'eth_getCode' && equal(r.request.params, [call.from, pinned]));
    need(code.length === 1, 'Unsupported sender code evidence missing');
    const bytes = successful(code[0]); need(textMatches(bytes, DATA) && bytes !== '0x', 'Unsupported sender code evidence contradicts rejection');
    return 'Product explicitly rejected the source-bound coded sender';
  }
  if (product.measurementFailure === 'Original execution contains unsupported lifecycle or witness-address behavior.') {
    const traces = records.filter(r => r.request.method === 'debug_traceCall' && equal(r.request.params, [call, pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]));
    need(traces.length === 1, 'Unsupported original trace evidence missing');
    const trace = successful(traces[0]); need(trace?.type === 'CALL' && trace.from === call.from && trace.to === call.to && trace.input === call.data && quantity(trace.value ?? '0x0') === quantity(call.value), 'Unsupported original root differs');
    let count = 0, found = false;
    function walk(frame, depth = 0) { need(record(frame) && ++count <= LIMITS.frames && depth <= LIMITS.depth && (!own(frame, 'calls') || Array.isArray(frame.calls)), 'Unsupported original trace malformed'); if (['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) || frame.from === '0x000000000000000000000000000000000000ba1a' || frame.to === '0x000000000000000000000000000000000000ba1a') found = true; for (const child of frame.calls ?? []) walk(child, depth + 1); }
    walk(trace); need(found, 'Unsupported lifecycle evidence contradicts rejection'); return 'Product explicitly rejected observed lifecycle or reserved witness behavior';
  }
  return null;
}
function localBinding(local, call, header, expected) {
  boundImplementation(local.implementation, expected);
  const attempt = local.attempt; need(record(attempt), 'Local attempt is missing');
  need(attempt.inputs?.status === 'available', 'Local proof input collection is unavailable');
  bounded(attempt.inputs, 32 * 1024 * 1024);
  need(record(attempt.inputs.accounts) && Object.keys(attempt.inputs.accounts).length <= LIMITS.accounts && Array.isArray(attempt.inputs.provenance) && attempt.inputs.provenance.length <= LIMITS.accounts, 'Local proof inventory is missing or excessive');
  const output = attempt.output, context = attempt.inputs.context, env = output?.environment, profile = output?.profile;
  need(['success', 'reverted', 'failed'].includes(output?.execution?.status), 'Local execution did not complete');
  need(context?.chainId === 1 && context.blockHash === header.hash && context.stateRoot === header.stateRoot && equal(context.header, header) && equal(context.selector, { blockHash: header.hash, requireCanonical: true }) && context.expectedOutputsUsed === false, 'Local input context differs from the declared state');
  need(env?.chainId === 1 && env.sourceBlockHash === header.hash && env.sourceParentHash === header.parentHash && env.mixHash === header.mixHash && env.miner === header.miner && quantity(env.baseFeePerGas) === 0n, 'Local execution environment differs');
  for (const f of ['number', 'timestamp', 'gasLimit']) need(quantity(env[f]) === quantity(header[f]), 'Local header field differs');
  need(profile?.name === 'ethereum_unsigned_unpriced_call' && profile.chainId === 1 && profile.sourceBlockHash === header.hash && profile.sourceStateRoot === header.stateRoot && profile.expectedOutputsUsed === false && profile.feesSettled === false && profile.originalTransactionPosition === false && quantity(profile.executionBaseFee) === 0n && quantity(profile.gasPrice) === 0n && quantity(profile.actualBlockBaseFee) === quantity(header.baseFeePerGas) && quantity(profile.declaredGasLimit) === quantity(call.gas), 'Local unsigned execution profile differs');
  need(output.stateDisposition === 'message_result_retained_in_supplied_manager' && output.semantics?.feeSettlement === false, 'Local state is not a retained execution result');
  const trace = output.trace;
  need(trace?.type === 'CALL' && trace.from === call.from && trace.to === call.to && trace.input === call.data && quantity(trace.value) === quantity(call.value) && quantity(trace.gas) === quantity(profile.messageGasLimit), 'Local root differs from the projected request');
  const classified = exceptionClass(output.execution.error, true);
  need(classified.status === output.execution.status && trace.error === output.execution.error && trace.output === output.execution.returnData, 'Local execution summary contradicts its root');
  const sender = attempt.inputs.accounts?.[call.from];
  need(sender?.exists === true && sender.code === '0x', 'Local sender account is not a proven code-free account');
  return { attempt, output, classified, nonce: quantity(sender.nonce) };
}
function canonicalLocalChanges(attempt) {
  bounded(attempt.changes?.accounts); need(Array.isArray(attempt.changes?.accounts) && attempt.changes.accounts.length <= LIMITS.accounts, 'Local full observed changes missing');
  const addresses = new Set(); let slots = 0;
  const changes = attempt.changes.accounts.map(row => {
    need(exactKeys(row, ['address'], ['nonce', 'balance', 'storage']) && textMatches(row.address, ADDRESS) && !addresses.has(row.address), 'Malformed or duplicate local changed account'); addresses.add(row.address);
    const prior = attempt.inputs.accounts[row.address]; need(prior?.exists === true, 'Unsupported local account lifecycle'); const result = { address: row.address };
    for (const f of ['nonce', 'balance']) if (own(row, f)) { need(exactKeys(row[f], ['before', 'after']) && quantity(row[f].before) === quantity(prior[f]), 'Local prior basic state differs from proven input'); result[f] = { before: hex(row[f].before), after: hex(row[f].after) }; need(result[f].before !== result[f].after, 'Unchanged local basic field is not a change'); }
    if (own(row, 'storage')) {
      need(Array.isArray(row.storage) && row.storage.length > 0, 'Local storage changes missing'); const seen = new Set();
      result.storage = row.storage.map(slot => { need(exactKeys(slot, ['slot', 'before', 'after']) && textMatches(slot.slot, WORD) && textMatches(slot.before, WORD) && textMatches(slot.after, WORD) && !seen.has(slot.slot) && ++slots <= LIMITS.slots, 'Malformed or duplicate local storage change'); seen.add(slot.slot); need(prior.storage?.[slot.slot] === slot.before && slot.before !== slot.after, 'Local prior storage differs from proven input'); return { ...slot }; });
    }
    need(Object.keys(result).length > 1, 'Empty local changed account'); return result;
  });
  return sortChanges(changes);
}
function localGas(output) {
  const p = output.profile, g = output.gasAccounting;
  const intrinsic = quantity(p.intrinsicGas), message = quantity(output.execution.executionGasUsed), refund = quantity(output.execution.gasRefundCounter), floor = quantity(p.calldataFloor);
  need(quantity(output.trace.gasUsed) === message && intrinsic + quantity(p.messageGasLimit) === quantity(p.declaredGasLimit), 'Local message gas does not bind to its declared profile');
  const beforeRefund = intrinsic + message, applied = refund < beforeRefund / 5n ? refund : beforeRefund / 5n, after = beforeRefund - applied, adjustment = floor > after ? floor - after : 0n;
  for (const [k, n] of Object.entries({ beforeRefund, appliedRefund: applied, floorAdjustment: adjustment, gasUsed: after + adjustment })) need(quantity(g?.[k], 5000000n) === n, 'Local unsigned gas accounting is incomplete or inconsistent');
  return (after + adjustment).toString();
}

/** Output-only accounting adapter. A future runner must freeze/bind the complete
 * implementation inventories and retained artifact hashes BEFORE dispatch. This
 * module compares the supplied concrete identities, not their provenance.
 * Product report is the API JSON, local attempt is the isolated wrapper result.
 * Missing raw revert diffs remain incomplete; no synthetic state is invented.
 */
export function adjudicateCohortOutcome(input) {
  if (!exactKeys(input, ['transactionHash', 'request', 'header', 'expectedProductImplementation', 'expectedLocalImplementation', 'product', 'local']) || !textMatches(input.transactionHash, WORD)) throw new CohortAdjudicationError('A complete declared cohort case is required.');
  const result = {
    outcome: { transactionHash: input.transactionHash, execution: 'provider_unavailable', comparison: 'not_comparable' },
    channels: Object.fromEntries(CHANNELS.map(name => [name, { status: 'unavailable', reason: 'Comparison not reached' }])),
    reasons: [], evidence: {}, allChannelsComplete: false,
    limitations: { artifactHashesBound: false, sourceIdentityAuthenticityVerified: false, independentProofsReverified: false, headerConsensusOrFinalityVerified: false, originalTransactionPosition: false, feeSettlement: false, fullCallTreeEquality: false, completeEconomicInventory: false, tokenOrEventInventoryAccuracy: false, securityScore: false },
  };
  const stop = (execution, comparison, reason) => { Object.assign(result.outcome, { execution, comparison }); result.reasons.push(reason); return result; };
  let profile;
  const product = input.product;
  if (product?.dispatch === 'budget_unattempted') return stop('budget_unattempted', 'budget_unattempted', 'Selected product slot was not attempted within its frozen budget');
  try { profile = requestProfile(input.request); } catch (error) { return stop('unsupported', 'not_comparable', safeReason(error)); }
  if (!profile.supported) return stop('unsupported', 'not_comparable', profile.reason);
  if (product?.dispatch !== 'completed' || product.httpStatus !== 200 || !record(product.report)) return stop('provider_unavailable', 'not_comparable', 'Product HTTP/transport result is unavailable');
  let p;
  try {
    need(textMatches(input.header?.hash, WORD) && textMatches(input.header.stateRoot, WORD), 'Declared state header is incomplete');
    const unsupported = unsupportedProduct(product.report, profile.call, input.header, input.expectedProductImplementation);
    if (unsupported) return stop('unsupported', 'not_comparable', unsupported);
    p = productBinding(product.report, profile.call, input.header, input.expectedProductImplementation);
  } catch (error) {
    return stop('provider_unavailable', 'not_comparable', safeReason(error));
  }
  result.outcome.execution = p.classified.status;
  result.evidence.product = { trace: p.raw.trace.id, diff: p.raw.diff?.id ?? null, nonce: p.raw.nonce.id, headers: p.raw.headerIds, chain: p.raw.chainId, senderCode: p.raw.senderCodeId, rawExecutionError: p.raw.trace.result.error ?? null };
  let l;
  if (input.local?.dispatch === 'budget_unattempted') return stop(p.classified.status, 'budget_unattempted', 'Independent local attempt was not reached within its frozen budget');
  try {
    need(input.local?.dispatch === 'completed', 'Independent local execution is unavailable');
    l = localBinding(input.local, profile.call, input.header, input.expectedLocalImplementation);
    need(l.nonce === p.raw.nonce.value, 'Product starting nonce differs from the independently proven local sender');
  } catch (error) { return stop(p.classified.status, 'oracle_unavailable', safeReason(error)); }
  result.evidence.local = { sourceSha256: input.local.implementation.sourceSha256, stateBlockHash: l.attempt.inputs.context.blockHash, stateRoot: l.attempt.inputs.context.stateRoot, rawExecutionError: l.output.execution.error };
  const channel = (name, compare) => {
    try { const [productValue, localValue] = compare(); result.channels[name] = { status: equal(productValue, localValue) ? 'match' : 'mismatch', product: productValue, local: localValue }; }
    catch (error) { result.channels[name] = { status: 'unavailable', reason: safeReason(error) }; }
  };
  channel('executionStatus', () => [p.classified, l.classified]);
  channel('returnData', () => { need(textMatches(l.output.execution.returnData, DATA), 'Local return bytes missing'); return [p.output, l.output.execution.returnData]; });
  channel('committedLogs', () => { need(Array.isArray(l.output.logs) && l.output.logs.length <= LIMITS.logs, 'Local committed logs missing'); return [committedLogs(p.raw.trace.result), l.output.logs.map(logPayload)]; });
  channel('fullObservedStateChanges', () => {
    need(p.raw.diff, 'Original provider pre/post diff missing; no state channel inferred from revert status');
    const raw = p.raw.diff.result, sender = profile.call.from;
    const priorNonce = raw.pre?.[sender]?.nonce === undefined && l.nonce === 0n ? 0n : quantity(raw.pre?.[sender]?.nonce);
    need(priorNonce === l.nonce && quantity(raw.post?.[sender]?.nonce) === l.nonce + 1n, 'Original provider nonce diff does not bind the proven local nonce transition');
    return [providerChanges(raw, l.attempt.inputs), canonicalLocalChanges(l.attempt)];
  });
  channel('gasAccounting', () => [p.gas, localGas(l.output)]);
  const statuses = Object.values(result.channels).map(x => x.status);
  result.outcome.comparison = statuses.includes('mismatch') ? 'mismatch' : statuses.every(x => x === 'match') ? 'match' : 'not_comparable';
  result.allChannelsComplete = statuses.every(x => x !== 'unavailable');
  if (!result.allChannelsComplete) result.reasons.push('At least one requested comparison channel lacks valid complete evidence');
  return result;
}
