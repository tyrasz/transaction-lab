import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulate } from '../src/server.js';
import { RpcError } from '../src/rpc.js';
import { USDC, HUSDC } from '../src/config.js';

// Synthetic provider fault controls over an observed execution. Query amounts
// are controlled test values, never admitted as observed chain state evidence.
const fixture = JSON.parse(await readFile(new URL('../fixtures/hyperlend-observed-supply.json', import.meta.url)));
const header = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x456' };
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
function provider(mode) {
  let releaseFirstCheck;
  const firstCheck = new Promise(resolve => { releaseFirstCheck = resolve; });
  let checks = 0;
  const calls = [];
  return { provider: 'synthetic-canonical-control', rpcMs: 0, calls, async verifyChain() {}, async call(method, params) {
    calls.push({ method, params });
    if (method === 'eth_getBlockByHash') return { ...header };
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') return { ...header };
      checks++;
      if (checks === 1) releaseFirstCheck();
      if ((mode === 'late_mismatch' && checks === 2) || (mode === 'early_mismatch' && checks === 1)) return { ...header, hash: '0x' + 'b'.repeat(64) };
      if (mode === 'late_rpc_error' && checks === 2) throw new RpcError('Secret upstream URL: https://invalid.example/CANONICAL_TEST_SECRET', 'RPC_CONNECTION_ERROR');
      return { ...header };
    }
    if (method === 'debug_traceCall') return params[2].tracer === 'callTracer' ? structuredClone(fixture.input.trace) : { pre: {}, post: {} };
    if (method === 'eth_call') {
      if (params[0].to === HUSDC) {
        // Make the allowance finish its canonical check before the balance
        // consumer finishes. No timers or scheduling guesses are involved.
        await firstCheck;
        if (mode === 'balance_query_error') throw new RpcError('Secret upstream URL: https://invalid.example/PAIR_TEST_SECRET', 'RPC_CONNECTION_ERROR');
      }
      const after = params.length === 3;
      return word(100000000n + (after ? params[0].to === USDC ? -15066115n : 15066115n : 0n));
    }
    throw new Error('Unexpected read-only test method');
  } };
}
function completeEvidence(report) {
  for (const evidence of [report.evidence.balanceMeasurement, report.evidence.allowanceMeasurement]) {
    assert.deepEqual(evidence.request.map(item => item.id).sort((a,b) => a-b), evidence.response.map(item => item.id).sort((a,b) => a-b), 'Every retained shared request has its settled result');
  }
  assert.deepEqual(report.evidence.balanceMeasurement, report.evidence.allowanceMeasurement);
}

for (const mode of ['late_mismatch', 'early_mismatch', 'late_rpc_error']) test(`shared canonical ${mode} withholds both consumers after they settle`, async () => {
  const rpc = provider(mode), report = await simulate(fixture.input.request, rpc);
  assert.equal(report.execution.status, 'success');
  assert.equal(report.balanceChanges.status, 'unavailable');
  assert.equal(report.allowanceChanges.status, 'unavailable');
  assert.deepEqual(report.balanceChanges.assets, []);
  assert.deepEqual(report.allowanceChanges.allowances, []);
  assert.equal(report.balanceChanges.executionIdentity, undefined);
  assert.equal(report.allowanceChanges.executionIdentity, undefined);
  assert.equal(report.permissions.coverage.allowanceStateVerified, false);
  assert.equal(report.accountEffects.summary.measuredBalancePairs, 0);
  assert.equal(report.accountEffects.summary.measuredAllowancePairs, 0);
  assert.equal(report.outAssets[0].transferOut[0].value, '15.066115', 'Original event evidence remains available');
  assert.equal(rpc.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] !== 'latest').length, 2, 'Finalization adds no RPC calls');
  assert.doesNotMatch(JSON.stringify(report), /CANONICAL_TEST_SECRET/);
  completeEvidence(report);
});

test('stable shared checks retain both measurements and complete final evidence', async () => {
  const report = await simulate(fixture.input.request, provider('stable'));
  assert.equal(report.balanceChanges.status, 'measured');
  assert.equal(report.allowanceChanges.status, 'measured');
  assert.equal(report.allowanceChanges.allowances[0].deltaRaw, '-15066115');
  assert.equal(report.accountEffects.summary.measuredBalancePairs, 2);
  assert.equal(report.accountEffects.summary.measuredAllowancePairs, 1);
  completeEvidence(report);
});

test('an unrelated balance-query error does not invalidate an independently completed allowance pair', async () => {
  const report = await simulate(fixture.input.request, provider('balance_query_error'));
  assert.equal(report.balanceChanges.status, 'unavailable');
  assert.equal(report.allowanceChanges.status, 'measured');
  assert.equal(report.permissions.coverage.allowanceStateVerified, true);
  assert.doesNotMatch(JSON.stringify(report), /PAIR_TEST_SECRET/);
  completeEvidence(report);
});
