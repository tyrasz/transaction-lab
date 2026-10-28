import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EvaluationBudget, boundedLimits } from '../src/evaluation-budget.js';
import { compareTraces, compareTransactionEnvelopes, compareOriginalReplay, compareStateDiffs, strictStateDiffProjection, independentInventory, validateHistoricalEvidence, COMPARISON_RULES } from '../src/evaluation-comparator.js';
import { runCoverageEvaluation, selectProspectiveCohort, coverageMetrics, validateProductProvenance, compareObservedPairs } from '../src/evaluate-coverage.js';

// Fixtures are hand-constructed controls except the explicitly pinned public
// position-diagnostic regression below. Modified packets remain negative controls.
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), TOKEN = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const topicAddress = a => '0x' + a.slice(2).padStart(64, '0');
const traceFixture = () => ({ type: 'CALL', from: A, to: B, input: '0x', value: '0x0', gas: '0x186a0', gasUsed: '0x5208', output: '0x' });
const rowFixture = () => ({ id: '101:0', transactionHash: hash(1), blockHash: hash(101), blockNumber: '101', timestamp: '1793000061', transactionIndex: '0' });
function evidenceFixture() {
  const row = rowFixture();
  return { row, transaction: { hash: row.transactionHash, blockHash: row.blockHash, blockNumber: '0x65', transactionIndex: '0x0', chainId: '0x3e7', type: '0x0', from: A, to: B, input: '0x', value: '0x0', gas: '0x186a0', nonce: '0x3', gasPrice: '0x1' },
    receipt: { transactionHash: row.transactionHash, blockHash: row.blockHash, blockNumber: '0x65', transactionIndex: '0x0', from: A, to: B, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] }, trace: traceFixture(),
    block: { number: '0x65', hash: row.blockHash, timestamp: '0x6adf7dbd', transactions: [row.transactionHash] } };
}
function responseFor(request, result) { return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function mockBudget(fetchImpl, limits = {}, now = Date.now) { return new EvaluationBudget({ t0: now(), fetchImpl, limits, now }); }

test('transport reserves concurrent calls before fetching and limits both providers together', async () => {
  let fetched = 0;
  const budget = mockBudget(async (_, options) => { fetched++; await delay(2); return responseFor(JSON.parse(options.body), '0x3e7'); }, { totalRpc: 2, perTransactionRpc: 1 });
  const one = budget.client('A', { phase: 'product', caseId: 'one' }), two = budget.client('B', { phase: 'comparator', caseId: 'one' });
  const results = await Promise.allSettled([one.call('eth_chainId'), two.call('eth_chainId')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'BUDGET_TRANSACTION_RPC'); assert.equal(fetched, 1);
  await budget.client('B', { phase: 'selection' }).call('eth_chainId');
  await assert.rejects(one.call('eth_chainId'), { code: 'BUDGET_TOTAL_RPC' });
  assert.equal(fetched, 2); assert.equal(budget.rpcCount, 2);
});

test('transport counts HTTP error bodies but retains no arbitrary secret-bearing error text', async () => {
  const secret = 'https://provider.test/?key=TOP_SECRET';
  const budget = mockBudget(async () => new Response(secret, { status: 500 }));
  await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'RPC_HTTP_ERROR' });
  assert.equal(budget.responseBytes, Buffer.byteLength(secret));
  assert.equal(budget.records[0].responseSha256, createHash('sha256').update(secret).digest('hex'));
  assert.equal(JSON.stringify(budget.records).includes(secret), false);
  assert.equal(budget.records[0].bodyComplete, true);
});

test('oversized HTTP error body is canceled, charged and never retained as a usable response', async () => {
  let canceled = 0;
  const budget = mockBudget(async () => ({ status: 500, ok: false, body: { getReader() { return { async read() { return { done: false, value: new Uint8Array(40) }; }, async cancel() { canceled++; } }; } } }), { responseBytes: 32 });
  await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'BUDGET_RESPONSE_BYTES' });
  assert.equal(budget.responseBytes, 40); assert.ok(canceled); assert.equal(budget.records[0].response, undefined); assert.equal(budget.records[0].bodyComplete, false);
});

test('global byte cap includes simultaneous bodies and blocks subsequent requests', async () => {
  const budget = mockBudget(async (_, options) => responseFor(JSON.parse(options.body), '0x3e7'), { totalResponseBytes: 70 });
  const result = await Promise.allSettled([budget.client('A', { phase: 'selection' }).call('eth_chainId'), budget.client('B', { phase: 'selection' }).call('eth_chainId')]);
  assert.ok(result.some(item => item.status === 'rejected' && item.reason.code === 'BUDGET_TOTAL_BYTES'));
  assert.ok(budget.responseBytes > 70);
  await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'BUDGET_TOTAL_BYTES' });
});

test('late fetch ignoring AbortSignal cannot mutate a closed record and its body is canceled', async () => {
  let release, canceled = 0;
  const budget = mockBudget(() => new Promise(resolve => { release = resolve; }), { requestMs: 5 });
  await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'RPC_TIMEOUT' });
  const sealed = JSON.stringify(budget.records), snapshot = budget.snapshot();
  release({ status: 200, ok: true, body: { getReader() { return { async read() { return { done: false, value: new Uint8Array(100) }; }, async cancel() { canceled++; } }; } } });
  await delay(5);
  assert.equal(JSON.stringify(budget.records), sealed); assert.equal(budget.responseBytes, snapshot.responseBytes); assert.equal(canceled, 1);
});

test('late reader ignoring cancellation cannot mutate or hash a closed record twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, reading, lateCanceled, canceled = 0, now = 1000;
  const readerStarted = new Promise(resolve => { reading = resolve; });
  const lateReadCanceled = new Promise(resolve => { lateCanceled = resolve; });
  const budget = mockBudget(async () => ({ status: 200, ok: true, body: { getReader() { return {
    read() { return new Promise(resolve => { release = resolve; reading(); }); },
    async cancel() { if (++canceled === 2) lateCanceled(); },
  }; } } }), { requestMs: 5 }, () => now);
  const timedOut = assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'RPC_TIMEOUT' });
  // Start the body read before firing its deadline. Real scheduling delays
  // must not turn this into a test of timing out before read() was entered.
  await readerStarted;
  now += 5; t.mock.timers.tick(5);
  await timedOut;
  assert.equal(canceled, 1);
  const sealed = JSON.stringify(budget.records);
  release({ done: false, value: new Uint8Array(100) });
  await lateReadCanceled;
  assert.equal(JSON.stringify(budget.records), sealed); assert.equal(budget.responseBytes, 0); assert.equal(canceled, 2);
});

test('stream wall limit is checked even if the injected clock jumps before the timer fires', async () => {
  let now = 1000;
  const budget = mockBudget(async () => ({ status: 200, ok: true, body: { getReader() { return { async read() { now = 2000; return { done: false, value: new Uint8Array(4) }; }, async cancel() {} }; } } }), { wallMs: 500 }, () => now);
  await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'BUDGET_WALL' });
  assert.equal(budget.responseBytes, 4);
});

test('frozen endpoint transport disables redirects, clones results and rejects writes', async () => {
  let redirect;
  const budget = mockBudget(async (_, options) => { redirect = options.redirect; return responseFor(JSON.parse(options.body), { nested: { value: 1 } }); });
  const rpc = budget.client('A', { phase: 'product' });
  const value = await rpc.call('eth_call'); value.nested.value = 99;
  assert.equal(redirect, 'error'); assert.equal(budget.records[0].response.result.nested.value, 1);
  await assert.rejects(rpc.call('eth_sendRawTransaction', ['0x']), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(budget.rpcCount, 1);
  assert.throws(() => boundedLimits({ attempts: 17 }));
});

test('nested provider errors are scrubbed before raw response retention', async () => {
  const budget = mockBudget(async (_, options) => responseFor(JSON.parse(options.body), [[{ error: { message: 'PASSWORD', code: -1 } }]]));
  await assert.rejects(budget.client('A', { phase: 'product' }).call('debug_traceCallMany'), { code: 'RPC_EXECUTION_ERROR' });
  assert.equal(JSON.stringify(budget.records).includes('PASSWORD'), false); assert.ok(budget.records[0].responseSha256);
});

test('strict full-tree comparisons retain failed branches, ordering, gas and missing-versus-zero', () => {
  const a = traceFixture(); a.calls = [{ ...traceFixture(), error: 'execution reverted' }, { ...traceFixture(), input: '0x01' }];
  const b = structuredClone(a); b.calls[0].error = 'provider-specific failure prose';
  assert.equal(compareTraces(a, b).status, 'matched');
  b.calls.reverse(); assert.equal(compareTraces(a, b).status, 'mismatched');
  b.calls.reverse(); b.calls[0].gas = '1'; assert.equal(compareTraces(a, b).status, 'mismatched');
  const missing = traceFixture(); delete missing.value; assert.equal(compareTraces(traceFixture(), missing).status, 'mismatched');
  delete missing.gas; assert.equal(compareTraces(traceFixture(), missing).status, 'incomplete');
  const malformed = traceFixture(); malformed.error = { message: 'bad' }; assert.equal(compareTraces(traceFixture(), malformed).status, 'incomplete');
});

test('trace retrieval availability requires receipt event content, not merely matching roots', () => {
  const fixture = evidenceFixture();
  assert.equal(validateHistoricalEvidence(fixture).status, 'complete');
  const event = { address: TOKEN, topics: [hash(20)], data: '0x', transactionHash: fixture.row.transactionHash, blockHash: fixture.row.blockHash, transactionIndex: '0x0', blockNumber: '0x65', logIndex: '0x0', removed: false };
  fixture.receipt.logs = [event];
  assert.equal(validateHistoricalEvidence(fixture).status, 'incomplete');
  fixture.trace.logs = [{ address: TOKEN, topics: [hash(20)], data: '0x', position: 0 }];
  assert.equal(validateHistoricalEvidence(fixture).status, 'complete');
  fixture.trace.logs[0].data = '0x01'; assert.equal(validateHistoricalEvidence(fixture).status, 'mismatched');
  fixture.trace.logs[0].data = '0x'; fixture.trace.error = 'reverted'; fixture.receipt.status = '0x0';
  assert.equal(validateHistoricalEvidence(fixture).status, 'incomplete');
});

test('original transaction fee and nonce disagreements are independent of call-tree equality', () => {
  const { transaction } = evidenceFixture(), b = structuredClone(transaction);
  assert.equal(compareTransactionEnvelopes(transaction, b).status, 'matched');
  b.nonce = '0x4'; assert.equal(compareTransactionEnvelopes(transaction, b).status, 'mismatched');
  b.nonce = '0x3'; b.maxFeePerGas = '0x1'; assert.equal(compareTransactionEnvelopes(transaction, b).status, 'mismatched');
  delete b.gasPrice; assert.equal(compareTransactionEnvelopes(transaction, b).status, 'incomplete');
});

test('candidate inventory includes unknown tokens and owner distinct from submitter, excludes failed calls', () => {
  const fixture = evidenceFixture(), owner = '0x' + '33'.repeat(20), unknown = '0x' + '44'.repeat(20);
  const transfer = { address: unknown, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddress(owner), topicAddress(B)], data: hash(25), logIndex: '0x0' };
  fixture.receipt.logs = [transfer];
  fixture.trace.calls = [{ ...traceFixture(), from: B, to: TOKEN, input: '0x23b872dd' + owner.slice(2).padStart(64, '0') + A.slice(2).padStart(64, '0') + '19'.padStart(64, '0') }];
  const inventory = independentInventory(fixture);
  assert.equal(inventory.completeness, 'inconclusive');
  assert.equal(inventory.assets.filter(pair => pair.token === unknown).length, 2);
  assert.equal(inventory.allowances[0].owner, owner); assert.equal(inventory.allowances[0].spender, B);
  fixture.trace.calls[0].error = 'reverted'; assert.equal(independentInventory(fixture).allowances.length, 0);
});

const stateDiffFixture = () => ({ pre: { [A]: { balance: '100000', nonce: 3 }, [B]: { balance: '1000' } }, post: { [A]: { balance: '79000', nonce: 4 }, [B]: { balance: '22000' } } });
function replayEvidence(transaction, row, trace, diff = stateDiffFixture()) {
  const call = { from: transaction.from, to: transaction.to, data: transaction.input, value: transaction.value, gas: transaction.gas, gasPrice: transaction.gasPrice, nonce: transaction.nonce };
  const context = { blockNumber: { blockHash: row.blockHash, requireCanonical: true }, transactionIndex: Number(row.transactionIndex) };
  const diffTracer = { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } };
  return { request: [
    { id: 8, method: 'debug_traceCallMany', params: [[{ transactions: [call] }], context, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }] },
    { id: 9, method: 'debug_traceTransaction', params: [transaction.hash, structuredClone(diffTracer)] },
    { id: 10, method: 'debug_traceCallMany', params: [[{ transactions: [structuredClone(call)] }], structuredClone(context), structuredClone(diffTracer)] },
  ], response: [{ id: 8, method: 'debug_traceCallMany', result: [[trace]] }, { id: 9, method: 'debug_traceTransaction', result: structuredClone(diff) }, { id: 10, method: 'debug_traceCallMany', result: [[structuredClone(diff)]] }] };
}
const executionIdentity = row => ({ transactionHash: row.transactionHash, transactionIndex: row.transactionIndex, postTransactionIndex: String(BigInt(row.transactionIndex) + 1n), stateBlockHash: row.blockHash, blockNumber: row.blockNumber, timestamp: row.timestamp, method: 'debug_traceCallMany', stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', validation: { originalReplay: 'semantic_trace_and_receipt_match', originalReplayState: 'complete_pre_post_diff_match', feeRepresentation: 'original_effective_gas_price', headerFields: ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'] } });
test('exact replay requires original-position evidence and full legacy envelope; typed fee substitution remains incomplete', () => {
  const { transaction, row, trace } = evidenceFixture(), evidence = replayEvidence(transaction, row, trace);
  const identity = executionIdentity(row);
  const args = { transaction, row, originalTrace: trace, productEvidence: evidence, oracleEvidence: structuredClone(evidence), productIdentity: identity, oracleIdentity: identity };
  assert.equal(compareOriginalReplay(args).status, 'matched');
  assert.equal(compareOriginalReplay({ ...args, oracleEvidence: null }).status, 'incomplete');
  assert.equal(compareOriginalReplay({ ...args, transaction: { ...transaction, type: '0x2', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1' } }).status, 'incomplete');
  args.oracleEvidence.response[0].result[0][0].gas = '0x1'; assert.equal(compareOriginalReplay(args).status, 'mismatched');
});

function originalReplayFixture(diff) {
  const { transaction, row, trace } = evidenceFixture(), evidence = replayEvidence(transaction, row, trace, diff);
  return { transaction, row, originalTrace: trace, productEvidence: evidence, oracleEvidence: structuredClone(evidence), productIdentity: executionIdentity(row), oracleIdentity: executionIdentity(row) };
}
test('exact replay independently requires both original and replay diffs, plus the completed state-validation identity', () => {
  assert.equal(COMPARISON_RULES.version, 'prospective-2');
  for (const side of ['productEvidence', 'oracleEvidence']) for (const id of [9, 10]) {
    const args = originalReplayFixture();
    args[side].request = args[side].request.filter(record => record.id !== id);
    args[side].response = args[side].response.filter(record => record.id !== id);
    assert.equal(compareOriginalReplay(args).status, 'incomplete', side + ':' + id);
  }
  for (const side of ['productIdentity', 'oracleIdentity']) {
    const args = originalReplayFixture(); delete args[side].validation.originalReplayState;
    assert.equal(compareOriginalReplay(args).status, 'incomplete');
  }
  const args = originalReplayFixture(), snapshot = structuredClone(args);
  const result = compareOriginalReplay(args);
  assert.equal(result.status, 'matched');
  assert.deepEqual(Object.values(result.comparisons.state).map(item => item.status), ['matched', 'matched', 'matched', 'matched']);
  assert.deepEqual(args, snapshot, 'comparison must not mutate raw evidence');
});

test('replay state requests bind the original hash and exact trace envelope/context, without ambiguity or overrides', () => {
  const mutations = [
    e => { e.request[1].params[0] = hash(999); },
    e => { e.request[1].params[1].stateOverrides = {}; },
    e => { e.request[2].params[0][0].transactions[0].gas = '0x1'; },
    e => { e.request[2].params[0][0].transactions[0].nonce = '0x4'; },
    e => { e.request[2].params[1].transactionIndex = 1; },
    e => { e.request[2].params[1].blockNumber.blockHash = hash(999); },
    e => { e.request[2].params[2].stateOverrides = {}; },
    e => { e.request[2].params[0][0].blockOverride = { time: '0x1' }; },
    e => { e.request[2].params[2].tracerConfig.diffMode = false; },
    e => { e.response[2].result = [e.response[2].result[0], e.response[2].result[0]]; },
    e => { e.response[2].error = null; },
    e => { e.response[2].method = 'debug_traceTransaction'; },
    e => { e.request.push(structuredClone(e.request[1])); },
    e => { e.response.push(structuredClone(e.response[2])); },
    e => { e.request.push({ ...structuredClone(e.request[1]), id: 11 }); e.response.push({ ...structuredClone(e.response[1]), id: 11 }); },
    e => { e.request.push({ ...structuredClone(e.request[2]), id: 11 }); e.response.push({ ...structuredClone(e.response[2]), id: 11 }); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const args = originalReplayFixture(); mutate(args.oracleEvidence);
    assert.equal(compareOriginalReplay(args).status, 'incomplete', 'mutation ' + index);
  }
  const args = originalReplayFixture(); args.transaction.transactionIndex = '0x1';
  assert.equal(compareOriginalReplay(args).status, 'mismatched');
});

test('state comparison preserves absolute native balances, missing fields and every storage slot', () => {
  const diff = stateDiffFixture(), encoded = structuredClone(diff);
  encoded.pre[A].balance = '0x186a0'; encoded.pre[A].nonce = '0x3';
  assert.equal(compareStateDiffs(diff, encoded).status, 'matched');
  const shifted = structuredClone(diff);
  shifted.pre[B].balance = '2000'; shifted.post[B].balance = '23000';
  assert.equal(BigInt(shifted.post[B].balance) - BigInt(shifted.pre[B].balance), BigInt(diff.post[B].balance) - BigInt(diff.pre[B].balance));
  assert.equal(compareStateDiffs(diff, shifted).status, 'mismatched', 'equal deltas do not establish the original position');
  const args = originalReplayFixture(); args.oracleEvidence.response[2].result = [[shifted]];
  assert.equal(compareOriginalReplay(args).status, 'mismatched');
  args.oracleEvidence.response[1].result = structuredClone(shifted);
  assert.equal(compareOriginalReplay(args).status, 'mismatched', 'two internally matching providers must still agree on absolute state');
  for (const extra of [{ balance: '0' }, { storage: {} }, { code: '0x' }]) {
    const empty = { pre: { [A]: {} }, post: { [A]: {} } }, explicit = structuredClone(empty);
    Object.assign(explicit.post[A], extra);
    assert.equal(compareStateDiffs(empty, explicit).status, 'mismatched');
  }
  const stored = stateDiffFixture(); stored.pre[B].storage = { [hash(1)]: hash(25) }; stored.post[B].storage = {};
  const omitted = structuredClone(stored); delete omitted.pre[B].storage[hash(1)];
  assert.equal(compareStateDiffs(stored, omitted).status, 'mismatched', 'pre-only cleared slots remain evidence');
});

test('equal malformed state maps and normalized-key collisions never become exact replay proof', () => {
  const malformed = [null, {}, { pre: {}, post: {}, extra: true }, { pre: [], post: {} },
    { pre: { bad: {} }, post: {} }, { pre: { [A]: { balance: '-1' } }, post: {} },
    { pre: { [A]: { balance: (1n << 256n).toString() } }, post: {} }, { pre: { [A]: { nonce: (1n << 64n).toString() } }, post: {} },
    { pre: { [A]: { nonce: Number.MAX_SAFE_INTEGER + 1 } }, post: {} }, { pre: { [A]: { balance: '0'.repeat(81) } }, post: {} },
    { pre: { [A]: { code: '0x0' } }, post: {} }, { pre: { [A]: { storage: [] } }, post: {} },
    { pre: { [A]: { storage: { '0x1': hash(1) } } }, post: {} }, { pre: { [A]: { storage: { [hash(1)]: [hash(1)] } } }, post: {} },
    { pre: { [A]: { unexpected: 0 } }, post: {} },
    { pre: { [TOKEN]: {}, [TOKEN.toUpperCase()]: {} }, post: {} },
    { pre: { [A]: { storage: { ['0x' + 'ab'.repeat(32)]: hash(1), ['0x' + 'AB'.repeat(32)]: hash(1) } } }, post: {} },
  ];
  for (const [index, diff] of malformed.entries()) {
    assert.equal(compareStateDiffs(diff, diff).status, 'incomplete', 'schema control ' + index);
    assert.equal(compareOriginalReplay(originalReplayFixture(diff)).status, 'incomplete', 'exact proof control ' + index);
  }
  let invoked = false; const diff = stateDiffFixture();
  Object.defineProperty(diff.pre[A], 'balance', { enumerable: true, get() { invoked = true; return '100000'; } });
  assert.equal(compareStateDiffs(diff, diff).status, 'incomplete'); assert.equal(invoked, false);
  const inherited = stateDiffFixture(); inherited.pre[A] = Object.create({ nonce: 3 });
  assert.equal(compareStateDiffs(inherited, inherited).status, 'incomplete');
});

test('state evidence bounds cover the union and identical empty evidence cannot replace original sender nonce proof', () => {
  const addressAt = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
  const tooManyAccounts = { pre: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [addressAt(i + 1), {}])), post: { [addressAt(101)]: {} } };
  const tooManySlots = { pre: { [A]: { storage: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [hash(i), hash(0)])) } }, post: { [B]: { storage: { [hash(0)]: hash(0) } } } };
  const tooMuchCode = { pre: { [A]: { code: '0x' + '00'.repeat(4 * 1024 * 1024) } }, post: {} };
  for (const diff of [tooManyAccounts, tooManySlots, tooMuchCode]) assert.equal(compareStateDiffs(diff, diff).status, 'incomplete');
  for (const diff of [{ pre: {}, post: {} }, { pre: { [A]: { balance: '1' } }, post: { [A]: { balance: '0' } } }, { pre: { [A]: { nonce: 3 } }, post: { [A]: {} } }]) {
    assert.equal(compareStateDiffs(diff, diff).status, 'matched', 'generic schema can represent empty maps');
    assert.equal(compareOriginalReplay(originalReplayFixture(diff)).status, 'incomplete', 'transaction proof requires its nonce transition');
  }
  for (const diff of [{ pre: { [A]: { nonce: 2 } }, post: { [A]: { nonce: 3 } } }, { pre: { [A]: { nonce: 3 } }, post: { [A]: { nonce: 5 } } }]) assert.equal(compareOriginalReplay(originalReplayFixture(diff)).status, 'mismatched');
});

test('recorded trace-equal wrong positions differ in absolute fee-recipient state; typed positives remain incomplete', async () => {
  const raw = await readFile(new URL('../reports/system-position-diagnostic/capture.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b');
  const capture = JSON.parse(raw), zero = '0x' + '0'.repeat(40);
  let traceOnlyFalseMatches = 0, correctlyPositioned = 0;
  for (const provider of capture.providers) for (const item of provider.cases) {
    const transaction = item.transaction.result, correct = item.replays.find(replay => replay.position === Number(BigInt(transaction.transactionIndex)));
    const row = { transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: String(BigInt(transaction.blockNumber)), transactionIndex: String(BigInt(transaction.transactionIndex)), timestamp: String(BigInt(provider.block.result.timestamp)) };
    const records = [correct.trace.rpcId, item.originalDiff.rpcId, correct.diff.rpcId].map(id => capture.records.find(record => record.request.id === id));
    for (const record of records) assert.equal(createHash('sha256').update(record.responseRaw).digest('hex'), record.responseSha256);
    const evidence = { request: records.map(record => structuredClone(record.request)), response: records.map(record => ({ id: record.request.id, method: record.request.method, result: structuredClone(record.response.result) })) };
    const args = { transaction, row, originalTrace: item.originalTrace.result, productEvidence: evidence, oracleEvidence: structuredClone(evidence), productIdentity: executionIdentity(row), oracleIdentity: executionIdentity(row) };
    const result = compareOriginalReplay(args);
    assert.equal(result.status, 'incomplete'); assert.match(result.reason, /typed transaction envelope/);
    assert.ok(Object.values(result.comparisons.state).every(comparison => comparison.status === 'matched')); correctlyPositioned++;
    if (![1, 2].includes(item.ordinaryIndex)) continue;
    const wrong = item.replays.find(replay => replay.position === item.ordinaryIndex), originalDiff = item.originalDiff.result, wrongDiff = wrong.diff.result[0][0];
    assert.equal(compareTraces(item.originalTrace.result, wrong.trace.result[0][0]).status, 'matched');
    assert.equal(compareStateDiffs(originalDiff, wrongDiff).status, 'mismatched');
    assert.equal(BigInt(originalDiff.post[zero].balance) - BigInt(originalDiff.pre[zero].balance), BigInt(wrongDiff.post[zero].balance) - BigInt(wrongDiff.pre[zero].balance));
    const withoutFeeRecipient = diff => { const copy = strictStateDiffProjection(diff); delete copy.pre[zero]; delete copy.post[zero]; return copy; };
    assert.deepEqual(withoutFeeRecipient(originalDiff), withoutFeeRecipient(wrongDiff));
    // Deliberately mispair an observed wrong-position result with the correct
    // request as an adversarial fixture; this is not an additional chain result.
    args.oracleEvidence.response.find(record => record.id === correct.diff.rpcId).result = structuredClone(wrong.diff.result);
    const negative = compareOriginalReplay(args);
    assert.equal(negative.status, 'mismatched'); assert.equal(negative.comparisons.state.oracleVsOriginal.status, 'mismatched');
    traceOnlyFalseMatches++;
  }
  assert.equal(correctlyPositioned, 10); assert.equal(traceOnlyFalseMatches, 4);
});

function cohortMock({ empty = false, mismatch = false, parentMismatch = false, prestateFails = false, beforeComparator, transfers = false } = {}) {
  let time = 1793000000000, finalized = 0;
  const fixture = evidenceFixture();
  const blocks = [101, 102].map((number, index) => ({ number: '0x' + number.toString(16), hash: hash(number), parentHash: hash(parentMismatch ? 900 : number - 1), timestamp: '0x' + (1793000061 + index).toString(16), transactions: empty ? [] : index ? [hash(3)] : [hash(1), hash(2)] }));
  const byHash = new Map(blocks.flatMap(block => block.transactions.map((txHash, index) => [txHash, { block, index }])));
  return { now: () => time, sleep: async ms => { time += ms; }, fixture, blocks,
    async fetchImpl(url, options) {
      const request = JSON.parse(options.body), providerB = url.includes('hyperlend.finance'), { method, params } = request;
      let result;
      if (method === 'eth_chainId') result = '0x3e7';
      else if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') { result = { number: finalized++ === 0 ? '0x64' : '0x68', hash: hash(100) }; }
        else { result = structuredClone(blocks.find(block => block.number === params[0])); if (mismatch && providerB) result.transactions.reverse(); }
      } else if (method === 'eth_getBlockByHash') result = blocks.find(block => block.hash === params[0]);
      else {
        if (providerB) await beforeComparator?.();
        const { block, index } = byHash.get(params[0]);
        if (method === 'eth_getTransactionByHash') result = { ...fixture.transaction, hash: params[0], blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x' + index.toString(16) };
        else if (method === 'eth_getTransactionReceipt') {
          result = { ...fixture.receipt, transactionHash: params[0], blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x' + index.toString(16) };
          if (transfers) result.logs = [{ address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddress(A), topicAddress(B)], data: hash(25), transactionHash: params[0], blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x' + index.toString(16), logIndex: '0x0', removed: false }];
        }
        else if (method === 'debug_traceTransaction') {
          if (params[1].tracer === 'prestateTracer') {
            if (prestateFails) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'UNSUPPORTED_SECRET' } }), { status: 200 });
            result = { [B]: { code: '0x6000' } };
          } else { result = structuredClone(fixture.trace); if (transfers) result.logs = [{ address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddress(A), topicAddress(B)], data: hash(25), position: 0 }]; }
        } else throw new Error('Unexpected synthetic RPC method.');
      }
      return responseFor(request, result);
    } };
}

test('selection uses exactly two future finalized blocks, keeps complete all-N lists and reports lateness', async () => {
  const mock = cohortMock(), budget = new EvaluationBudget({ t0: mock.now(), fetchImpl: mock.fetchImpl, now: mock.now });
  const result = await selectProspectiveCohort({ budget, now: mock.now, sleep: mock.sleep, t0: mock.now() });
  assert.equal(result.status, 'selected'); assert.equal(result.N, 3); assert.equal(budget.rpcCount, 9);
  assert.deepEqual(result.ledger.map(row => row.id), ['101:0', '101:1', '102:0']);
  assert.deepEqual(result.schedule.map(event => event.lateByMs), [0, 0]);
  assert.equal(budget.records.some(record => record.request.method === 'eth_getTransactionByHash'), false);
  assert.equal(JSON.stringify(budget.records).includes('latest'), false);
});

test('selection disagreement and empty blocks never trigger replacements', async () => {
  for (const [options, status] of [[{ mismatch: true }, 'selection_failed'], [{ parentMismatch: true }, 'selection_failed'], [{ empty: true }, 'empty']]) {
    const mock = cohortMock(options), budget = new EvaluationBudget({ t0: mock.now(), fetchImpl: mock.fetchImpl, now: mock.now });
    const result = await selectProspectiveCohort({ budget, now: mock.now, sleep: mock.sleep, t0: mock.now() });
    assert.equal(result.status, status); assert.equal(budget.rpcCount, 9);
    assert.equal(result.N, status === 'empty' ? 0 : null);
  }
});

test('pilot seals all product outputs before B adjudication, retains unattempted N, and separates optional oracle failure', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coverage-evaluation-')), directory = path.join(parent, 'run');
  let comparatorCalls = 0;
  const mock = cohortMock({ prestateFails: true, beforeComparator: async () => {
    const seal = JSON.parse(await readFile(path.join(directory, 'product-seal.json'), 'utf8'));
    assert.equal(seal.products.length, 2); assert.equal(seal.comparatorHasStarted, false); comparatorCalls++;
  } });
  const productImpl = async (input, rpc) => {
    await rpc.verifyChain();
    const transaction = await rpc.call('eth_getTransactionByHash', [input.transactionHash]);
    const receipt = await rpc.call('eth_getTransactionReceipt', [input.transactionHash]);
    const trace = await rpc.call('debug_traceTransaction', [input.transactionHash, { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const block = mock.blocks.find(block => block.hash === transaction.blockHash);
    return { implementation: manifest.implementation.engine, source: { chainId: 999, mode: 'historical_trace', blockBinding: 'transaction_hash', transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: String(BigInt(transaction.blockNumber)), timestamp: String(BigInt(block.timestamp)), transactionIndex: String(BigInt(transaction.transactionIndex)) }, coverage: { status: 'partial' }, evidence: { receipt, traceResponse: trace }, request: { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: '0' }, execution: { status: 'success', gasUsed: '21000' } };
  };
  const stateContextFactory = () => ({ async prepare() { throw new Error('UNSUPPORTED_SECRET'); }, snapshotEvidence() { return { request: [], response: [] }; } });
  try {
    const report = await runCoverageEvaluation({ outputDirectory: directory, ...mock, productImpl, stateContextFactory, limits: { attempts: 2 } });
    assert.equal(report.metrics.N, 3); assert.equal(report.metrics.attempted, 2); assert.equal(report.metrics.budgetUnattempted, 1);
    assert.equal(report.metrics.executionAvailability.passed, 2); assert.equal(report.metrics.retrievalAgreement.matched, 2);
    assert.equal(report.metrics.exactReplayAgreement.matched, 0); assert.equal(report.metrics.exactReplayAgreement.incomplete, 3);
    assert.equal(report.metrics.measuredAssetCoverage.passed, 0); assert.equal(report.metrics.measuredAssetCoverage.inconclusive, 3);
    assert.equal(comparatorCalls, 8); assert.equal(report.budget.rpcCount, 25);
    const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
    assert.equal(ledger.rows[2].status, 'budget_unattempted'); assert.equal(ledger.rows[0].comparison.retrievalFailures[0].field, 'prestate');
    const raw = await readFile(path.join(directory, 'rpc.json'), 'utf8'); assert.equal(raw.includes('UNSUPPORTED_SECRET'), false);
    const files = await readdir(directory); assert.ok(files.includes('artifact-index.json'));
    const index = JSON.parse(await readFile(path.join(directory, 'artifact-index.json'), 'utf8'));
    for (const artifact of index.artifacts) assert.equal(createHash('sha256').update(await readFile(path.join(directory, artifact.file))).digest('hex'), artifact.sha256);
    await assert.rejects(runCoverageEvaluation({ outputDirectory: directory, ...mock, productImpl, stateContextFactory }), { code: 'EEXIST' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('metrics never count missing oracle inventory or empty event sets as all-effects passes', () => {
  const metrics = coverageMetrics([{ attempted: true, status: 'attempted', comparison: { retrieval: { status: 'matched' }, exactReplay: { status: 'incomplete' }, assetPairs: [], allowancePairs: [] } }, { attempted: false, status: 'budget_unattempted' }]);
  assert.equal(metrics.N, 2); assert.equal(metrics.retrievalAgreement.fraction, 0.5); assert.equal(metrics.exactReplayAgreement.incomplete, 2);
  assert.equal(metrics.measuredAssetCoverage.passed, 0); assert.equal(metrics.observedAssetPairs.denominator, 0); assert.equal(metrics.observedAssetPairs.inventoryCompleteness, 'inconclusive');
});

test('successful envelopes with error:null are rejected and EOF rechecks both deadlines', async () => {
  const erroneous = mockBudget(async (_, options) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0x3e7', error: null })));
  await assert.rejects(erroneous.client('A', { phase: 'selection' }).call('eth_chainId'), { code: 'RPC_EXECUTION_ERROR' });
  for (const [limits, expected] of [[{ wallMs: 100 }, 'BUDGET_WALL'], [{ requestMs: 100 }, 'RPC_TIMEOUT']]) {
    let now = 1000, read = 0;
    const budget = mockBudget(async (_, options) => ({ ok: true, status: 200, body: { getReader() { return { async read() {
      if (!read++) return { done: false, value: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0x3e7' })) };
      now = 1200; return { done: true };
    }, async cancel() {} }; } } }), limits, () => now);
    await assert.rejects(budget.client('A', { phase: 'selection' }).call('eth_chainId'), { code: expected });
    assert.equal(budget.records[0].response, undefined);
  }
});

test('missing nested CALL destination and mandatory typed-envelope fields never compare complete', () => {
  const root = traceFixture(), child = traceFixture(); delete child.to; root.calls = [child];
  assert.equal(compareTraces(root, structuredClone(root)).status, 'incomplete');
  const tx = { ...evidenceFixture().transaction, type: '0x2' };
  assert.equal(compareTransactionEnvelopes(tx, structuredClone(tx)).status, 'incomplete');
  tx.maxFeePerGas = '0x2'; tx.maxPriorityFeePerGas = '0x1'; tx.accessList = [];
  assert.equal(compareTransactionEnvelopes(tx, structuredClone(tx)).status, 'matched');
});

test('original-position comparisons reject bundle, state, header and tracer overrides', () => {
  const { transaction, row, trace } = evidenceFixture(), identity = executionIdentity(row);
  for (const mutate of [e => { e.request[0].params[0][0].blockOverride = { time: '0xdeadbeef' }; }, e => { e.request[0].params[1].blockOverrides = { number: '0x1' }; }, e => { e.request[0].params[2].stateOverrides = {}; }, e => { e.request[0].params[2].tracerConfig.onlyTopCall = true; }]) {
    const evidence = replayEvidence(transaction, row, trace), altered = structuredClone(evidence); mutate(altered);
    assert.equal(compareOriginalReplay({ transaction, row, originalTrace: trace, productEvidence: evidence, oracleEvidence: altered, productIdentity: identity, oracleIdentity: identity }).status, 'incomplete');
  }
});

test('duplicate product pair identity disagreement and malformed measured collections remain mismatches', () => {
  const row = rowFixture(), key = `${TOKEN}:${A}`, candidate = { key, kind: 'balance', token: TOKEN, account: A };
  const values = { beforeRaw: '100', afterRaw: '75', deltaRaw: '-25' }, measurements = new Map([[key, values]]);
  const group = { status: 'measured', basis: 'historical_transaction_position_balanceOf', executionIdentity: executionIdentity(row), assets: [{ asset: { address: TOKEN }, account: A, ...values }] };
  const product = { balanceChanges: structuredClone(group), affectedBalanceChanges: structuredClone(group) };
  let result = compareObservedPairs({ candidates: [candidate], measurements, product, row, kind: 'balance' }); assert.equal(result[0].status, 'matched');
  product.balanceChanges.executionIdentity.stateBlockHash = hash(999);
  result = compareObservedPairs({ candidates: [candidate], measurements, product, row, kind: 'balance' }); assert.equal(result[0].status, 'mismatched');
  product.balanceChanges = { status: 'measured', assets: {} };
  result = compareObservedPairs({ candidates: [candidate], measurements, product, row, kind: 'balance' }); assert.equal(result.length, 1); assert.equal(result[0].status, 'mismatched');
});

test('provenance requires version, exact engine source list and frozen SHA; mismatched reverts are not genuine', () => {
  const frozen = { name: 'Transaction Lab', version: '0.test', sourceSha256: 'a'.repeat(64), sourceFiles: ['server.js', 'rpc.js'] };
  assert.equal(validateProductProvenance({ implementation: structuredClone(frozen) }, frozen).status, 'matched');
  for (const implementation of [{ ...frozen, sourceSha256: 'b'.repeat(64) }, { ...frozen, version: 'old' }, { ...frozen, sourceFiles: ['server.js'] }]) assert.equal(validateProductProvenance({ implementation }, frozen).status, 'mismatched');
  const metrics = coverageMetrics([{ attempted: true, executionAvailability: { status: 'mismatched', outcome: 'revert' } }]);
  assert.equal(metrics.reasonMatrix.genuineRevert, 0); assert.equal(metrics.reasonMatrix.mismatch, 1);
});

test('a post-inventory failure cannot erase independently observed candidate denominators', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'coverage-inventory-')), directory = path.join(parent, 'run'), mock = cohortMock({ transfers: true });
  try {
    const report = await runCoverageEvaluation({ outputDirectory: directory, ...mock, limits: { attempts: 1 }, productImpl: async () => { throw new Error('unsupported product'); }, stateContextFactory: () => { throw new Error('unsupported oracle adapter'); } });
    assert.equal(report.metrics.observedAssetPairs.denominator, 2); assert.equal(report.metrics.observedAssetPairs.oracle_unavailable, 2);
    assert.equal(report.metrics.N, 3); assert.equal(report.metrics.budgetUnattempted, 2);
    const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
    assert.equal(ledger.rows[0].comparison.oracleIdentity.status, 'complete'); assert.equal(ledger.rows[0].comparison.inventory.assets.length, 2);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
