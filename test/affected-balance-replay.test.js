// These are observed development cases with independent balanceOf reads, not
// blind holdouts or an independent provider/client implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { measureAffectedBalances } from '../src/affected-balances.js';
import { createHistoricalStateContext } from '../src/historical-state.js';
import { normalizeBlock, assertNoProviderErrorResult } from '../src/rpc.js';
import { USDC, METADATA } from '../src/config.js';

const directory = new URL('../reports/affected-balance-validation/', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const captureBytes = await readFile(new URL('capture.json', directory));
const oracleBytes = await readFile(new URL('oracle.json', directory));
assert.equal(digest(captureBytes), '78e4013368ccdcd9624be636599ec6ade622c956c96dcd54c1445c5c9ce91e91');
assert.equal(digest(oracleBytes), 'e6d9138e27c0ef3c6db32df810ea1662498cbc66f4b90de4424f7bcb04c3b469');
const capture = JSON.parse(captureBytes), oracle = JSON.parse(oracleBytes);
const currentBytes = await readFile(new URL('../reports/replay-state-comparisons/capture.json', import.meta.url));
assert.equal(digest(currentBytes), '51d7cb6ba049b1cd38da52ba2131b4bc328ac264419c240f132c3b570f8ed610');
const current = JSON.parse(currentBytes);
assert.equal(current.status, 'complete');
const basis = 'historical_transaction_position_balanceOf';
const raw = entries => entries.map(entry => ({ token: entry.asset?.address ?? entry.token, account: entry.account, beforeRaw: entry.beforeRaw, afterRaw: entry.afterRaw, deltaRaw: entry.deltaRaw }));

function recordedTransport(id) {
  const caseId = { router: 'usdc-router-permit-consumed', 'direct-a': 'direct-transferfrom-a' }[id];
  const run = current.cases.find(item => item.id === caseId).runs.find(run => run.provider === 'drpc');
  assert.equal(run.http.response.status, 200);
  assert.equal(run.response.affectedBalanceChanges.status, 'measured');
  const capturedContext = run.response.evidence.affectedBalanceMeasurement;
  const contextRecords = run.rpcCalls.slice(-capturedContext.request.length);
  for (const [index, record] of contextRecords.entries()) {
    const request = capturedContext.request[index], response = capturedContext.response.find(item => item.id === request.id);
    assert.deepEqual([record.request.method, record.request.params, record.response.result], [request.method, request.params, response.result]);
  }
  const canonicals = contextRecords.filter(record => record.request.method === 'eth_getBlockByNumber');
  // This module-only replay consumes a declared subset of the newer full HTTP
  // capture: original preparation, all balance queries and its final check.
  // Allowance queries and their separate final check are not fabricated/replayed.
  const selectedContext = contextRecords.filter(record => {
    if (record.request.method === 'debug_traceCallMany' && record.request.params[0][0].transactions[0].data.startsWith('0xdd62ed3e')) return false;
    return record.request.method !== 'eth_getBlockByNumber' || record === canonicals[0] || record === canonicals.at(-1);
  });
  const records = [run.rpcCalls.find(record => record.request.method === 'eth_chainId'), run.rpcCalls.find(record => record.request.method === 'eth_getTransactionReceipt'), ...selectedContext];
  const range = (start, length) => Array.from({ length }, (_, index) => start + index);
  const expectedSourceIds = id === 'router' ? [1, 3, ...range(7, 8), ...range(24, 20), 44] : [1, 3, ...range(7, 8), ...range(20, 8), 28];
  assert.deepEqual(records.map(record => record.request.id), expectedSourceIds, 'The exact retained raw-record subset is declared independently of runtime requests');
  assert.equal(new Set(records.map(record => record.request.id)).size, records.length);
  const expectedEvidence = {
    request: selectedContext.map((record, index) => ({ id: index + 1, method: record.request.method, params: structuredClone(record.request.params) })),
    response: selectedContext.map((record, index) => ({ id: index + 1, method: record.request.method, result: structuredClone(record.response.result) })),
  };
  let cursor = 0;
  const usedIds = [];
  return {
    async call(method, params) {
      const entry = records[cursor++];
      assert.ok(entry, 'No unrecorded RPC response or fallback is allowed');
      assert.deepEqual({ method, params }, { method: entry.request.method, params: entry.request.params }, 'Recorded method, original position and full parameters must match');
      assert.equal(entry.httpStatus, 200);
      assert.equal(digest(entry.responseText), entry.responseSha256);
      assert.deepEqual(JSON.parse(entry.responseText), entry.response);
      assert.equal(entry.response.id, entry.request.id); assert.equal(entry.response.jsonrpc, '2.0');
      assert.equal(entry.captureError, undefined); assert.equal(entry.response.error, undefined);
      assert.ok(Object.hasOwn(entry.response, 'result'));
      assertNoProviderErrorResult(method, entry.response.result);
      usedIds.push(entry.request.id);
      return structuredClone(entry.response.result);
    },
    get consumed() { return cursor; },
    records, run, expectedEvidence, usedIds,
    assertComplete() {
      assert.equal(cursor, records.length, 'All and only the predeclared real response subset is consumed');
      assert.deepEqual(usedIds, records.map(record => record.request.id), 'Original raw RPC IDs are retained as subset provenance');
      assert.ok(records.length < run.rpcCalls.length, 'Module replay is explicitly a subset, not the complete HTTP run');
    },
  };
}

function assertHistoricalBaseline(result, input) {
  const identity = structuredClone(result.executionIdentity);
  assert.equal(identity.validation.originalReplayState, 'complete_pre_post_diff_match');
  delete identity.validation.originalReplayState;
  assert.deepEqual(identity, input.observed.executionIdentity, 'The original identity is unchanged apart from the newly proven state-diff guard');
  assert.deepEqual(result.executionIdentity, input.rpc.run.response.affectedBalanceChanges.executionIdentity);
  assert.deepEqual(result.evidence, input.rpc.expectedEvidence, 'Every selected observed response is retained with explicit local evidence IDs');
  const oldRequests = result.evidence.request.filter(entry => !(entry.method === 'debug_traceCallMany' && entry.params[2].tracer === 'prestateTracer' && entry.params[0][0].transactions[0].data === input.request.data));
  const oldEvidence = {
    request: oldRequests.map((entry, index) => ({ ...entry, id: index + 1 })),
    response: oldRequests.map((entry, index) => ({ ...result.evidence.response.find(response => response.id === entry.id), id: index + 1 })),
  };
  // These are observed cross-capture size metadata revisions, not a general
  // header-field exclusion. Exact current responses were already checked above.
  const sizeRevisions = input.observed.id === 'router' ? [[2, '0x90d', '0x4ad']] : [[2, '0x14c7', '0x12ae'], [16, '0x12ae', '0x14c7']];
  for (const [id, oldSize, newSize] of sizeRevisions) {
    const original = input.observed.contextEvidence.response.find(entry => entry.id === id), revised = oldEvidence.response.find(entry => entry.id === id);
    assert.equal(original.method, 'eth_getBlockByNumber'); assert.equal(revised.method, original.method);
    assert.equal(original.result.size, oldSize); assert.equal(revised.result.size, newSize);
    revised.result = { ...revised.result, size: oldSize };
  }
  assert.deepEqual(oldEvidence, input.observed.contextEvidence, 'Previously observed requests/results remain exact apart from the added diff query, local IDs and the three explicitly asserted size revisions');
  input.rpc.assertComplete();
}

async function inputFor(id) {
  const observed = capture.cases.find(item => item.id === id);
  assert.equal(observed.status, 'measured');
  const sourceBytes = await readFile(new URL(observed.source.path, directory));
  assert.equal(digest(sourceBytes), observed.source.sha256);
  const source = JSON.parse(sourceBytes), transaction = source.captures.transaction.response.result;
  const receipt = source.captures.receipt.response.result, trace = source.captures.callTrace.response.result;
  const block = normalizeBlock(source.captures.block.response.result);
  const request = { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() };
  const rpc = recordedTransport(id);
  // Two actual captured identity requests precede the derived context subset.
  assert.equal(await rpc.call('eth_chainId', []), '0x3e7');
  const receiptFields = record => Object.fromEntries(['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex', 'status', 'gasUsed', 'effectiveGasPrice', 'from', 'to', 'logs'].map(field => [field, record[field]]));
  assert.deepEqual(receiptFields(await rpc.call('eth_getTransactionReceipt', [transaction.hash])), receiptFields(receipt));
  const input = { request, trace, transaction, receipt, block, rpc, metadata: METADATA };
  return { ...input, stateContext: createHistoricalStateContext(input), observed, expected: oracle.cases.find(item => item.id === id) };
}

test('frozen development oracle retains all source and raw-response fingerprints and exactly seven independently queried pairs', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory)));
  for (const file of manifest.files) assert.equal(digest(await readFile(new URL(file.file, directory))), file.sha256, file.file);
  assert.equal(oracle.captureSha256, digest(captureBytes));
  assert.equal(oracle.sameProvider, true); assert.equal(oracle.independentExecutionEngine, false); assert.equal(oracle.sharedValidationAdapter, true);
  assert.equal(capture.status, 'complete'); assert.equal(capture.calls.length, 48);
  assert.equal(capture.balanceEvidenceCalls, 28); assert.equal(capture.budgets.retries, 0);
  assert.equal(oracle.cases.flatMap(item => item.balances).length, 7);
  for (const entry of capture.calls) {
    assert.equal(digest(entry.responseText), entry.responseSha256);
    assert.deepEqual(JSON.parse(entry.responseText), entry.response);
  }
});

for (const id of ['router', 'direct-a']) test(`observed original-position ${id} balances reproduce every raw oracle amount without unrecorded responses`, async () => {
  const input = await inputFor(id);
  const result = await measureAffectedBalances(input);
  assert.equal(result.status, 'measured', result.warnings.at(-1));
  assert.equal(result.basis, basis); assert.equal(result.candidatePairCount, id === 'router' ? 5 : 2);
  assert.deepEqual(result.reusedPairs, []);
  assert.deepEqual(raw(result.assets), raw(input.expected.balances));
  assertHistoricalBaseline(result, input);
  assert.equal(result.evidence.request.length, result.evidence.response.length);
  assert.equal(result.assets.every(entry => entry.asset.address === USDC && entry.consistency.eventComparison === 'matches_event_net'), true);
  const queries = result.evidence.request.filter(entry => entry.method === 'debug_traceCallMany' && entry.params[0][0].transactions[0].data.startsWith('0x70a08231'));
  assert.equal(queries.length, result.assets.length * 4);
  for (const query of queries) {
    assert.equal(query.params[0][0].transactions[0].to, USDC, 'No unknown-token query is inserted');
    assert.equal(query.params[0][0].transactions[0].gasPrice, input.transaction.gasPrice);
    assert.deepEqual(query.params[1].blockNumber, { blockHash: input.block.hash, requireCanonical: true });
    assert.ok([0, 1].includes(query.params[1].transactionIndex));
  }
  if (id === 'router') {
    const router = result.assets.find(entry => entry.account === input.request.to);
    assert.deepEqual([router.beforeRaw, router.afterRaw, router.deltaRaw], ['0', '0', '0']);
    assert.deepEqual([router.consistency.eventIncomingRaw, router.consistency.eventOutgoingRaw], ['25000000', '25000000']);
    assert.equal(result.warnings.some(warning => warning.includes('unconfigured token')), true);
    assert.equal(result.assets.some(entry => entry.asset.address === '0x53195a1c4e664ac09eb72892516f8f85ec800000'), false);
  } else {
    const owner = result.assets.find(entry => entry.account !== input.request.from);
    assert.equal(owner.account, '0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379');
    assert.deepEqual([owner.beforeRaw, owner.afterRaw, owner.deltaRaw], ['1541542', '264475', '-1277067']);
    assert.equal(owner.candidateEvidence.transferCalls[0].spender, input.request.from);
    assert.equal(owner.candidateEvidence.transferCalls[0].recipient, input.request.from);
  }
});

test('real cached original-position readings prove reused pairs without any additional recorded token requests', async () => {
  const input = await inputFor('direct-a');
  const assets = [];
  // Read the actual observed pair through the actual context; do not construct
  // fabricated responses or use event-derived values as the prior measurement.
  for (const account of input.observed.accounts) {
    const { before, after, delta } = await input.stateContext.readPair({ to: USDC, data: '0x70a08231' + account.slice(2).padStart(64, '0') });
    assets.push({ asset: { address: USDC }, account, beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString() });
  }
  const beforeModule = input.rpc.consumed;
  const result = await measureAffectedBalances({ ...input, existingBalanceChanges: { status: 'measured', basis, assets, executionIdentity: input.stateContext.executionIdentity } });
  assert.equal(result.status, 'measured', result.warnings.at(-1));
  assert.deepEqual(result.assets, []); assert.equal(result.reusedPairs.length, 2);
  assert.deepEqual(raw(assets), raw(input.expected.balances));
  assert.equal(input.rpc.consumed - beforeModule, 1, 'Only the recorded final canonical check remains');
  assertHistoricalBaseline(result, input);
});
