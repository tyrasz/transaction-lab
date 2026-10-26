import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { replay } from '../src/server.js';
import { RpcError } from '../src/rpc.js';
import { USDC, HUSDC } from '../src/config.js';

// Fault controls over a retained observed run. Mutated replies exist only in
// memory and are never presented or persisted as actual provider observations.
const bytes = await readFile(new URL('../reports/replay-state-comparisons/capture.json', import.meta.url));
const capture = JSON.parse(bytes);
const digest = value => createHash('sha256').update(value).digest('hex');
const CAPTURE_SHA256 = '51d7cb6ba049b1cd38da52ba2131b4bc328ac264419c240f132c3b570f8ed610';
assert.equal(digest(bytes), CAPTURE_SHA256, 'The observed reference capture must remain immutable');
assert.equal(capture.status, 'complete');
const previousBytes = await readFile(new URL('../reports/affected-balance-comparisons/capture.json', import.meta.url));
assert.equal(digest(previousBytes), '53eec210304f3f3ff749bc4a4cdbd4fe55f57e87a2cd0b94983574bd0942de34', 'The original capture is preserved');
const previous = JSON.parse(previousBytes);

function observedRun(operation) {
  const item = capture.cases.find(item => item.id === `hyperlend-usdc-${operation}`);
  const run = item?.runs.find(run => run.provider === 'drpc');
  assert.ok(run, `The declared dRPC ${operation} run is required; no provider substitution`);
  assert.equal(run.http.response.status, 200);
  for (const field of ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges']) assert.equal(run.response[field].status, 'measured', `Observed ${operation}/${field} must be measured before fault injection`);
  const old = previous.cases.find(item => item.id === `hyperlend-usdc-${operation}`).runs.find(run => run.provider === 'drpc');
  for (const field of ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges']) {
    const unchanged = structuredClone(run.response[field]);
    assert.equal(unchanged.executionIdentity.validation.originalReplayState, 'complete_pre_post_diff_match');
    delete unchanged.executionIdentity.validation.originalReplayState;
    assert.deepEqual(unchanged, old.response[field], `${field} amounts and semantics remain unchanged from the original observed run`);
  }
  assert.ok(run.response.affectedBalanceChanges.reusedPairs.length > 0, 'The third consumer must reuse established state');
  for (const record of run.rpcCalls) {
    assert.equal(record.error, undefined); assert.ok(record.response); assert.equal(Object.hasOwn(record.response, 'error'), false);
    assert.equal(digest(record.responseText), record.responseSha256);
    assert.deepEqual(JSON.parse(record.responseText), record.response);
  }
  return run;
}

function faultTransport(run, fault) {
  const records = structuredClone(run.rpcCalls), used = new Set(), unexpected = [], mutations = [];
  const canonicalIndexes = records.map((record, index) => record.request.method === 'eth_getBlockByNumber' ? index : -1).filter(index => index >= 0);
  const lastCanonical = canonicalIndexes.at(-1);
  assert.ok(canonicalIndexes.length >= 4, 'Preparation and all three consumer canonical checks must be recorded');
  assert.equal(lastCanonical, records.length - 1, 'The affected consumer canonical check is the final recorded request');
  const custodyQueryData = '0x70a08231' + HUSDC.slice(2).padStart(64, '0');
  const extraQuery = records.findIndex(record => record.request.method === 'debug_traceCallMany'
    && record.request.params[0][0].transactions[0].to === USDC
    && record.request.params[0][0].transactions[0].data === custodyQueryData
    && record.request.params[2].tracer === 'callTracer');
  let earlierCanonicalReplies = 0;
  return {
    provider: run.response.source.provider, rpcMs: 0,
    async verifyChain() { assert.equal(await this.call('eth_chainId', []), '0x3e7'); },
    async call(method, params = []) {
      // Initial balance/allowance consumers run concurrently. Match identical
      // recorded requests once each without imposing an invented latency order.
      const index = records.findIndex((record, index) => !used.has(index) && isDeepStrictEqual([method, params], [record.request.method, record.request.params]));
      if (index < 0) {
        unexpected.push({ method, params });
        throw new Error('The test requested an unrecorded provider response');
      }
      used.add(index);
      const record = records[index];
      assert.equal(record.response.id, record.request.id);
      const result = structuredClone(record.response.result);
      if (fault === 'late_canonical' && index === lastCanonical) {
        assert.equal(earlierCanonicalReplies, canonicalIndexes.length - 1, 'Earlier consumer checks succeeded before the synthetic late fault');
        mutations.push({ kind: fault, index });
        result.hash = '0x' + 'f'.repeat(64);
        return result;
      }
      if (fault === 'extra_query_unavailable' && index === extraQuery) {
        assert.ok(earlierCanonicalReplies >= 3, 'The unrelated extra query starts only after both original consumers have completed');
        mutations.push({ kind: fault, index });
        throw new RpcError('Synthetic additional-balance query failure.', 'RPC_EXECUTION_ERROR', { rpcCode: -32000 });
      }
      if (method === 'eth_getBlockByNumber') earlierCanonicalReplies++;
      return result;
    },
    assertComplete() {
      assert.deepEqual(unexpected, [], 'No fallback, fabricated successful reply, or live RPC is allowed');
      assert.equal(mutations.length, 1, 'Exactly one predeclared synthetic failure is injected');
      assert.ok(used.size > 0);
      if (fault === 'late_canonical') assert.equal(used.size, records.length, 'The late fault occurs after every prior recorded request');
      else {
        assert.ok(extraQuery >= 0, 'An independently recorded extra reserve-custody balance query must exist');
        assert.equal(used.size, extraQuery + 1, 'Only requests through the failing extra query are consumed');
        assert.equal(used.has(lastCanonical), false, 'A failed additional measurement does not reach its final canonical check');
      }
    },
  };
}

function assertOriginalExecution(result, run) {
  assert.equal(result.execution.status, 'success');
  assert.deepEqual(result.execution, run.response.execution);
  assert.deepEqual(result.evidence.traceResponse, run.response.evidence.traceResponse);
  assert.deepEqual(result.evidence.receipt, run.response.evidence.receipt);
  assert.deepEqual(result.movements, run.response.movements);
  assert.deepEqual(result.security, { status: 'not_assessed', findings: [] });
}

function assertSettledSharedEvidence(result) {
  const evidence = result.evidence.balanceMeasurement;
  assert.deepEqual(evidence, result.evidence.allowanceMeasurement);
  assert.deepEqual(evidence, result.evidence.affectedBalanceMeasurement);
  assert.equal(evidence.request.length, evidence.response.length, 'No pending shared request is retained without a result');
  assert.deepEqual(evidence.request.map(item => item.id).sort((a,b) => a-b), evidence.response.map(item => item.id).sort((a,b) => a-b));
}

for (const operation of ['supply', 'repay']) test(`synthetic late affected-consumer canonical failure invalidates earlier ${operation} balances, allowances and reuse`, async () => {
  const run = observedRun(operation), original = JSON.stringify(run);
  const rpc = faultTransport(run, 'late_canonical');
  const result = await replay(structuredClone(run.request), rpc);
  rpc.assertComplete();
  assert.equal(JSON.stringify(run), original, 'Observed inputs/replies remain untouched by the synthetic mutation');
  assertOriginalExecution(result, run);
  for (const field of ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges']) {
    assert.equal(result[field].status, 'unavailable', `${field} cannot retain a measured result after shared canonical failure`);
    assert.equal(result[field].executionIdentity, undefined);
  }
  assert.deepEqual(result.balanceChanges.assets, []);
  assert.deepEqual(result.allowanceChanges.allowances, []);
  assert.deepEqual(result.affectedBalanceChanges.assets, []);
  assert.deepEqual(result.affectedBalanceChanges.reusedPairs, []);
  assert.equal(result.permissions.coverage.allowanceStateVerified, false);
  assert.equal(result.accountEffects.summary.measuredBalancePairs, 0);
  assert.equal(result.accountEffects.summary.measuredAllowancePairs, 0);
  for (const account of result.accountEffects.accounts) for (const token of account.tokens) {
    assert.equal(token.balance.status, 'not_measured');
    assert.deepEqual(token.allowanceIndexes, []);
  }
  assert.match(result.balanceChanges.warnings.at(-1), /Shared block verification failed/);
  assert.match(result.allowanceChanges.warnings.at(-1), /Shared block verification failed/);
  assertSettledSharedEvidence(result);
});

test('synthetic failure of the additional supply custody query preserves already-proven balances and allowance', async () => {
  const run = observedRun('supply'), original = JSON.stringify(run);
  assert.equal(run.response.balanceChanges.assets.some(entry => entry.asset.address === USDC && entry.account === HUSDC), false, 'The injected failure targets an additional pair, not a reused base measurement');
  assert.equal(run.response.affectedBalanceChanges.assets.some(entry => entry.asset.address === USDC && entry.account === HUSDC), true);
  const rpc = faultTransport(run, 'extra_query_unavailable');
  const result = await replay(structuredClone(run.request), rpc);
  rpc.assertComplete();
  assert.equal(JSON.stringify(run), original);
  assertOriginalExecution(result, run);
  assert.equal(result.balanceChanges.status, 'measured');
  assert.equal(result.allowanceChanges.status, 'measured');
  assert.deepEqual(result.balanceChanges, run.response.balanceChanges, 'All established balances, identities and semantics remain unchanged');
  assert.deepEqual(result.allowanceChanges, run.response.allowanceChanges, 'All established allowance state and semantics remain unchanged');
  assert.equal(result.affectedBalanceChanges.status, 'unavailable');
  assert.deepEqual(result.affectedBalanceChanges.assets, []);
  assert.deepEqual(result.affectedBalanceChanges.reusedPairs, []);
  assert.equal(result.affectedBalanceChanges.executionIdentity, undefined);
  assert.equal(result.permissions.coverage.allowanceStateVerified, true);
  assert.equal(result.accountEffects.summary.measuredBalancePairs, result.balanceChanges.assets.length);
  assert.equal(result.accountEffects.summary.measuredAllowancePairs, result.allowanceChanges.allowances.length);
  const custody = result.accountEffects.accounts.find(account => account.address === HUSDC).tokens.find(token => token.asset.address === USDC);
  assert.equal(custody.balance.status, 'not_measured');
  assert.equal(custody.events.status, 'observed', 'Available events are preserved without becoming a substitute balance');
  assertSettledSharedEvidence(result);
  const failures = result.evidence.affectedBalanceMeasurement.response.filter(entry => entry.error);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.rpcCode, -32000);
});
