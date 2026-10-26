// Offline evidence verification. No network or product-state changes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { compareTraces, strictTraceProjection, compareTransactionEnvelopes, validateHistoricalEvidence } from './frozen/evaluation-comparator.js';
import { EVALUATION_PROVIDERS } from './frozen/evaluation-budget.js';
const directory = new URL('./', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const bytes = await readFile(new URL('capture.json', directory));
assert.equal(sha(bytes), 'be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b');
const capture = JSON.parse(bytes);
const planBytes = await readFile(new URL('plan.json', directory)), plan = JSON.parse(planBytes);
assert.equal(sha(planBytes), capture.planSha256);
assert.equal(sha(await readFile(new URL('capture.mjs', directory))), plan.scriptSha256);
for (const dependency of plan.dependencies) assert.equal(sha(await readFile(new URL(dependency.path, directory))), dependency.sha256);
const sourceBytes = await readFile(new URL(plan.sourceEvidence.path, directory));
assert.equal(sha(sourceBytes), plan.sourceEvidence.sha256);
const source = JSON.parse(sourceBytes);
assert.deepEqual(plan.users, source.lists.officialOrdinary);
assert.equal(capture.status, 'completed_fixed_matrix');
assert.equal(capture.records.length, 86); assert.equal(capture.budget.rpcCount, 86);
let totalBytes = 0;
const perCaseCounts = {};
for (const [index, record] of capture.records.entries()) {
  assert.equal(record.id, index + 1); assert.equal(record.request.id, record.id);
  assert.equal(record.endpoint, EVALUATION_PROVIDERS[record.provider]);
  assert.equal(record.phase, 'system_position_diagnostic');
  if (record.caseId !== null) {
    assert.ok(plan.users.some(hash => record.caseId === record.provider + ':' + hash));
    perCaseCounts[record.caseId] = (perCaseCounts[record.caseId] ?? 0) + 1;
  }
  assert.equal(record.httpStatus, 200); assert.equal(record.error, undefined);
  assert.equal(record.responseBytes, Buffer.byteLength(record.responseRaw));
  assert.equal(sha(record.responseRaw), record.responseSha256);
  assert.deepEqual(JSON.parse(record.responseRaw), record.response);
  assert.equal(record.response.id, record.id); assert.equal(record.response.jsonrpc, '2.0');
  assert.equal(Object.hasOwn(record.response, 'error'), false);
  assert.ok(record.responseBytes <= plan.limits.responseBytes);
  assert.ok(record.elapsedMs < plan.limits.requestMs);
  totalBytes += record.responseBytes;
}
assert.equal(totalBytes, 3908425); assert.equal(totalBytes, capture.budget.responseBytes);
assert.ok(totalBytes < plan.limits.totalResponseBytes); assert.ok(capture.budget.elapsedMs < plan.limits.wallMs);
assert.equal(Object.keys(perCaseCounts).length, 10);
assert.ok(Object.values(perCaseCounts).every(count => count === 8));
assert.deepEqual(perCaseCounts, capture.budget.transactionRpc);
const seen = new Set();
function check(observation, provider, method, params, caseHash = null) {
  assert.ok(!seen.has(observation.rpcId)); seen.add(observation.rpcId);
  const record = capture.records[observation.rpcId - 1];
  assert.equal(record.provider, provider);
  const boundHash = ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'debug_traceTransaction'].includes(method) ? params[0] : caseHash;
  assert.equal(record.caseId, boundHash === null ? null : provider + ':' + boundHash);
  assert.deepEqual(record.request, { jsonrpc: '2.0', id: record.id, method, params });
  assert.deepEqual(observation.result, record.response.result);
  return observation.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result) && result.length === 1 && Array.isArray(result[0]) && result[0].length === 1);
  assert.ok(result[0][0] && typeof result[0][0] === 'object' && !Array.isArray(result[0][0]));
  return result[0][0];
}
function withoutInputGas(trace) {
  const frame = strictTraceProjection(trace);
  function strip(item) { delete item.gas; if (item.calls.present) item.calls.value.forEach(strip); }
  strip(frame); return frame;
}
function differencePaths(left, right, prefix = '', output = []) {
  if (isDeepStrictEqual(left, right)) return output;
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) differencePaths(left[key], right[key], prefix + '/' + key, output);
  } else output.push(prefix);
  return output;
}
function validateDiff(diff) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const quantity = (value, bits) => {
    assert.ok((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)));
    assert.ok(BigInt(value) >= 0n && BigInt(value) < (1n << BigInt(bits)));
  };
  assert.ok(object(diff)); assert.deepEqual(Object.keys(diff).sort(), ['post', 'pre']);
  let slots = 0;
  for (const phase of ['pre', 'post']) {
    assert.ok(object(diff[phase])); const accounts = Object.entries(diff[phase]);
    // These priced ordinary calls have sender fee/nonce effects even on revert.
    assert.ok(accounts.length > 0 && accounts.length <= 1000);
    assert.equal(new Set(accounts.map(([address]) => address.toLowerCase())).size, accounts.length);
    for (const [address, account] of accounts) {
      assert.match(address, /^0x[0-9a-f]{40}$/i); assert.ok(object(account));
      assert.ok(Object.keys(account).length > 0);
      assert.ok(Object.keys(account).every(field => ['balance', 'nonce', 'code', 'storage'].includes(field)));
      if (Object.hasOwn(account, 'balance')) quantity(account.balance, 256);
      if (Object.hasOwn(account, 'nonce')) quantity(account.nonce, 64);
      if (Object.hasOwn(account, 'code')) { assert.equal(typeof account.code, 'string'); assert.match(account.code, /^0x(?:[0-9a-f]{2})*$/i); }
      if (Object.hasOwn(account, 'storage')) {
        assert.ok(object(account.storage));
        const entries = Object.entries(account.storage); slots += entries.length; assert.ok(slots <= 10000);
        assert.equal(new Set(entries.map(([slot]) => slot.toLowerCase())).size, entries.length);
        for (const [slot, value] of entries) { assert.match(slot, /^0x[0-9a-f]{64}$/i); assert.equal(typeof value, 'string'); assert.match(value, /^0x[0-9a-f]{64}$/i); }
      }
    }
  }
}
// Equal missing/malformed objects must not become evidence of state agreement.
for (const malformed of [{}, { pre: {}, post: {} }, { pre: [], post: [] }, { pre: { bad: { nonce: 1 } }, post: {} }]) assert.throws(() => validateDiff(malformed));
const tracers = { call: { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }, diff: { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } } };
const comparisons = [], blockViews = [];
for (const observed of capture.providers) {
  const provider = observed.provider;
  assert.equal(check(observed.chain, provider, 'eth_chainId', []), '0x3e7');
  const block = check(observed.block, provider, 'eth_getBlockByNumber', [plan.blockNumber, false]);
  assert.equal(block.hash, plan.blockHash); assert.equal(block.number, plan.blockNumber);
  // Both endpoints returned the inclusive list in this later capture. A's
  // earlier ordinary-only list remains evidence, not a permanent provider rule.
  assert.deepEqual(block.transactions, source.lists.pilotBAll);
  const earlier = provider === 'A' ? source.lists.pilotAOrdinary : source.lists.pilotBAll;
  blockViews.push({ provider, earlierCount: earlier.length, currentCount: block.transactions.length, differsFromEarlierCapture: !isDeepStrictEqual(earlier, block.transactions), currentView: 'system_inclusive', stableDuringCapture: isDeepStrictEqual(block, observed.canonicalAfter.result) });
  assert.equal(observed.cases.length, 5);
  for (const [ordinaryIndex, item] of observed.cases.entries()) {
    assert.equal(item.transactionHash, plan.users[ordinaryIndex]); assert.equal(item.ordinaryIndex, ordinaryIndex);
    assert.equal(item.extendedIndex, ordinaryIndex + 3); assert.equal(item.skipped, undefined);
    const tx = check(item.transaction, provider, 'eth_getTransactionByHash', [item.transactionHash]);
    const receipt = check(item.receipt, provider, 'eth_getTransactionReceipt', [item.transactionHash]);
    const original = check(item.originalTrace, provider, 'debug_traceTransaction', [item.transactionHash, tracers.call]);
    const originalDiff = check(item.originalDiff, provider, 'debug_traceTransaction', [item.transactionHash, tracers.diff]);
    validateDiff(originalDiff);
    assert.equal(tx.hash, item.transactionHash);
    assert.equal(tx.blockHash, plan.blockHash); assert.equal(tx.blockNumber, plan.blockNumber); assert.equal(tx.chainId, '0x3e7');
    assert.equal(tx.type, '0x2'); assert.equal(Number(BigInt(tx.transactionIndex)), ordinaryIndex + 3);
    assert.equal(receipt.transactionIndex, tx.transactionIndex); assert.equal(receipt.blockHash, plan.blockHash);
    assert.equal(receipt.transactionHash, tx.hash); assert.equal(receipt.effectiveGasPrice, tx.gasPrice);
    assert.equal(BigInt(original.gasUsed), BigInt(receipt.gasUsed));
    assert.equal(original.from, tx.from); assert.equal(original.to, tx.to); assert.equal(original.input, tx.input);
    assert.equal(BigInt(original.value), BigInt(tx.value));
    assert.equal(Boolean(original.error || original.revertReason), BigInt(receipt.status) === 0n);
    assert.equal(validateHistoricalEvidence({ transaction: tx, receipt, trace: original, block, row: { transactionHash: item.transactionHash, blockHash: plan.blockHash, blockNumber: BigInt(plan.blockNumber).toString(), transactionIndex: String(ordinaryIndex + 3) } }).status, 'complete');
    const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, gasPrice: tx.gasPrice, nonce: tx.nonce, ...(tx.accessList === undefined ? {} : { accessList: tx.accessList }) };
    assert.equal(item.envelopeProfile, 'unsigned_original_nonce_effective_gas_price');
    assert.deepEqual(item.replays.map(replay => replay.position), [ordinaryIndex, ordinaryIndex + 3]);
    const variants = item.replays.map(replay => {
      const params = config => [[{ transactions: [call] }], { blockNumber: { blockHash: plan.blockHash, requireCanonical: true }, transactionIndex: replay.position }, config];
      const actual = unwrap(check(replay.trace, provider, 'debug_traceCallMany', params(tracers.call), item.transactionHash));
      const diff = unwrap(check(replay.diff, provider, 'debug_traceCallMany', params(tracers.diff), item.transactionHash));
      validateDiff(diff);
      const strict = compareTraces(original, actual);
      const semantic = isDeepStrictEqual(withoutInputGas(original), withoutInputGas(actual));
      const equalDiff = isDeepStrictEqual(originalDiff, diff);
      return { position: replay.position, trace: strict.status, inputGasExcludedTrace: semantic ? 'matched' : 'mismatched', completeDiff: equalDiff ? 'matched' : 'mismatched', differingStatePaths: differencePaths(originalDiff, diff), matchedTraceAndDiff: strict.status === 'matched' && equalDiff, evidenceRpcIds: { trace: replay.trace.rpcId, diff: replay.diff.rpcId } };
    });
    assert.equal(variants[0].completeDiff, 'mismatched');
    assert.equal(variants[1].matchedTraceAndDiff, true);
    comparisons.push({ provider, transactionHash: tx.hash, ordinaryIndex, reportedIndex: Number(BigInt(tx.transactionIndex)), type: tx.type, originalStatus: receipt.status, envelopeProfile: item.envelopeProfile, exactSignedReplay: false, variants, matchingPositionsWithinTestedSet: variants.filter(variant => variant.matchedTraceAndDiff).map(variant => variant.position) });
  }
  const after = check(observed.canonicalAfter, provider, 'eth_getBlockByNumber', [plan.blockNumber, false]);
  assert.deepEqual(after, block);
}
assert.equal(seen.size, capture.records.length);
const providerAgreement = plan.users.map((transactionHash, index) => {
  const a = capture.providers[0].cases[index], b = capture.providers[1].cases[index];
  const envelope = compareTransactionEnvelopes(a.transaction.result, b.transaction.result);
  const trace = compareTraces(a.originalTrace.result, b.originalTrace.result);
  const receipt = isDeepStrictEqual(a.receipt.result, b.receipt.result), diff = isDeepStrictEqual(a.originalDiff.result, b.originalDiff.result);
  assert.equal(envelope.status, 'matched'); assert.equal(trace.status, 'matched'); assert.equal(receipt, true); assert.equal(diff, true);
  return { transactionHash, envelope: envelope.status, originalTrace: trace.status, originalReceipt: 'matched', originalDiff: 'matched' };
});
const traceOnlyFalseMatches = comparisons.flatMap(item => item.variants.filter(variant => variant.trace === 'matched' && variant.completeDiff === 'mismatched').map(variant => ({ provider: item.provider, ordinaryIndex: item.ordinaryIndex, testedPosition: variant.position, reportedPosition: item.reportedIndex, differingStatePaths: variant.differingStatePaths })));
assert.deepEqual(traceOnlyFalseMatches.map(item => [item.provider, item.ordinaryIndex]), [['A', 1], ['A', 2], ['B', 1], ['B', 2]]);
const comparison = { schemaVersion: '1.0', captureSha256: sha(bytes), planSha256: sha(planBytes), blockNumber: '49544166', blockHash: plan.blockHash, blockViews, comparisons, providerAgreement, traceOnlyFalseMatches, budget: { requests: 86, responseBytes: totalBytes, failures: 0, retries: 0 }, limits: ['One fixed block, five selected ordinary transactions, two tested positions each; no universal offset or future provider guarantee.', 'Provider A changed list representation between separate captures, though both initial/final lists were stable within this diagnostic. Endpoint identity does not fix its response view.', 'All five transactions are type 2, reconstructed with original nonce and effective gas price. No exact typed or signed replay claim.', 'Strict trace and full touched-account pre/post diff equality are provider corroboration, not an independent engine or a proof of full state equality.', 'The three system actions were not themselves replayed by this diagnostic.', 'Failed prospective pilot, denominator and metrics remain unchanged.'] };
if (process.argv[2] === '--write') await writeFile(new URL('comparison.json', directory), json(comparison), { flag: 'wx' });
else assert.deepEqual(JSON.parse(await readFile(new URL('comparison.json', directory))), comparison);
console.log(json({ status: 'verified_offline', requests: 86, responseBytes: totalBytes, uniqueMatchesWithinTestedPositions: comparisons.length, misleadingTraceOnlyMatches: traceOnlyFalseMatches.length }));
