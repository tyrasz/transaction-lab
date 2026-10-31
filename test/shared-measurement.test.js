import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { simulate } from '../src/server.js';
import { RpcError } from '../src/rpc.js';
import { USDC, HUSDC } from '../src/config.js';

// Synthetic concurrency/fault controls over immutable capability observations.
// Common sender query/path/diff/header values are genuine recorded responses.
// Missing root eth_getCode, latest-header selection and custody-account queries
// are explicitly synthetic controls; these tests are not additional live runs.
const bytes = await readFile(new URL('../reports/current-query-capability/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '3c11faec39109a330d91428d9ad359ee1601fc3820f5ae17b9971c61e7ddfae2');
const records = JSON.parse(bytes).records.filter(record => record.provider === 'A' && record.caseId === 'supply');
const result = label => records.find(record => record.label === label).response.result;
const header = result('header'), trace = result('original-trace');
const request = { chainId: 999, from: trace.from, to: trace.to, data: trace.input, value: '0' };
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const custodyData = '0x70a08231' + HUSDC.slice(2).padStart(64, '0');

function provider(mode) {
  let releaseFirstCheck;
  const firstCheck = new Promise(resolve => { releaseFirstCheck = resolve; });
  let checks = 0;
  const calls = [];
  return { provider: 'synthetic-current-shared-consumer-control', rpcMs: 0, calls, async verifyChain() {}, async call(method, params) {
    const call = { method, params: structuredClone(params), origin: 'recorded' }; calls.push(call);
    if (method === 'eth_getBlockByNumber') {
      call.origin = 'synthetic_latest_or_canonical_control';
      if (params[0] === 'latest') return structuredClone(header);
      assert.equal(BigInt(params[0]), BigInt(header.number));
      checks++; call.canonicalCheck = checks;
      if (checks === 1) releaseFirstCheck();
      const failureAt = { early_mismatch: 1, middle_mismatch: 2, late_mismatch: 3, late_rpc_error: 3 }[mode];
      if (checks === failureAt) {
        if (mode === 'late_rpc_error') throw new RpcError('Secret upstream URL: https://invalid.example/CANONICAL_TEST_SECRET', 'RPC_CONNECTION_ERROR');
        return { ...structuredClone(header), hash: word(123) };
      }
      return structuredClone(header);
    }
    if (method === 'eth_getCode' && params[0] === request.to) {
      assert.deepEqual(params[1], { blockHash: header.hash, requireCanonical: true });
      call.origin = 'synthetic_root_code_preparation_control';
      return result('original-diff').pre[request.to].code;
    }
    if (method === 'debug_traceCall' && params[0].to === HUSDC) {
      // Deterministic ordering: allowance's check1 completes before the base
      // hUSDC query can finish. Failed cached queries are never retried.
      await firstCheck;
      if (mode === 'balance_query_error') throw new RpcError('Secret upstream URL: https://invalid.example/PAIR_TEST_SECRET', 'RPC_CONNECTION_ERROR');
    }
    if (method === 'debug_traceCall' && params[0].to === USDC && params[0].data === custodyData) {
      call.origin = 'synthetic_custody_query_control';
      const after = Boolean(params[2].stateOverrides), kind = params[2].tracer === 'callTracer' ? 'trace' : 'diff';
      const base = records.find(record => record.label === `usdc-${after ? 'after' : 'before'}-${kind}`);
      const expectedParams = structuredClone(base.request.params); expectedParams[0].data = custodyData;
      assert.deepEqual(params, expectedParams);
      const queryResult = structuredClone(base.response.result);
      if (kind === 'trace') {
        queryResult.input = custodyData; queryResult.calls[0].input = custodyData;
        queryResult.output = word(1000000000000n + (after ? 15066115n : 0n));
        queryResult.calls[0].output = queryResult.output;
      }
      return queryResult;
    }
    const record = records.find(record => record.request.method === method && isDeepStrictEqual(record.request.params, params));
    assert.ok(record, 'Every ordinary query must match a genuine capability request exactly');
    call.recordedLabel = record.label;
    assert.equal(createHash('sha256').update(record.responseRaw).digest('hex'), record.responseSha256);
    assert.deepEqual(JSON.parse(record.responseRaw), record.response);
    return structuredClone(record.response.result);
  } };
}

function completeEvidence(report) {
  const snapshots = [report.evidence.balanceMeasurement, report.evidence.allowanceMeasurement, report.evidence.affectedBalanceMeasurement];
  for (const evidence of snapshots) {
    assert.ok(evidence.request.length > 0);
    assert.deepEqual(evidence.request.map(item => item.id).sort((a,b) => a-b), evidence.response.map(item => item.id).sort((a,b) => a-b), 'Every retained shared request has its settled result');
  }
  assert.deepEqual(snapshots[0], snapshots[1]); assert.deepEqual(snapshots[1], snapshots[2]);
  const native = report.nativeBalanceChanges;
  assert.deepEqual(native.assets, []); assert.deepEqual(native.omittedAccounts, []); assert.equal(native.candidateAccountCount, 0);
  assert.equal(native.executionIdentity, undefined); assert.equal(native.feeScope, 'excluded');
  if (native.status === 'unavailable') {
    assert.deepEqual(report.evidence.nativeBalanceMeasurement, { request: [], response: [] }, 'Failed native validation exposes no provisional measurement evidence');
    const { verification, reason, ...audit } = report.evidence.nativeBalanceAudit;
    assert.equal(verification, 'unverified'); assert.equal(typeof reason, 'string'); assert(reason.length > 0);
    assert.deepEqual(audit, snapshots[0], 'Settled shared diagnostics remain separate from unavailable native measurements');
  } else {
    assert.equal(native.status, 'not_applicable'); assert.match(native.warnings.join(' '), /No native balance candidates/);
    assert.deepEqual(report.evidence.nativeBalanceMeasurement, snapshots[0], 'No-candidate native view reuses complete shared evidence without another RPC');
    assert.equal(Object.hasOwn(report.evidence, 'nativeBalanceAudit'), false);
  }
}

for (const mode of ['early_mismatch', 'middle_mismatch', 'late_mismatch', 'late_rpc_error']) test(`synthetic shared canonical ${mode} withholds all four current consumers after settlement`, async () => {
  const rpc = provider(mode), report = await simulate(request, rpc);
  assert.equal(report.execution.status, 'success');
  assert.equal(report.balanceChanges.status, 'unavailable');
  assert.equal(report.allowanceChanges.status, 'unavailable');
  assert.equal(report.affectedBalanceChanges.status, 'unavailable');
  assert.equal(report.nativeBalanceChanges.status, 'unavailable');
  assert.deepEqual(report.balanceChanges.assets, []); assert.deepEqual(report.allowanceChanges.allowances, []);
  assert.deepEqual(report.affectedBalanceChanges.assets, []); assert.deepEqual(report.affectedBalanceChanges.reusedPairs, []);
  for (const measured of [report.balanceChanges, report.allowanceChanges, report.affectedBalanceChanges, report.nativeBalanceChanges]) assert.equal(measured.executionIdentity, undefined);
  assert.equal(report.permissions.coverage.allowanceStateVerified, false);
  assert.equal(report.accountEffects.summary.measuredBalancePairs, 0); assert.equal(report.accountEffects.summary.measuredAllowancePairs, 0);
  assert.equal(report.outAssets[0].transferOut[0].value, '15.066115', 'Original event evidence remains available');
  // The first canonical failure is latched while the hUSDC pair is pending.
  // Its settled read now checks that latch before a second canonical request.
  const checks = rpc.calls.filter(call => call.canonicalCheck), expectedChecks = mode === 'early_mismatch' ? 1 : mode.startsWith('late') ? 3 : 2;
  assert.equal(checks.length, expectedChecks, 'Finalization adds no RPC calls');
  assert.equal(rpc.calls.length, mode === 'early_mismatch' ? 24 : mode.startsWith('late') ? 30 : 25);
  if (mode.startsWith('late')) assert.equal(rpc.calls.filter(call => call.origin === 'synthetic_custody_query_control').length, 4, 'Third check follows independently completed affected/custody queries');
  assert.doesNotMatch(JSON.stringify(report), /CANONICAL_TEST_SECRET/);
  completeEvidence(report);
});

test('synthetic stable current run retains base, allowance and affected custody measurements with complete shared evidence', async () => {
  const rpc = provider('stable'), report = await simulate(request, rpc);
  assert.equal(report.balanceChanges.status, 'measured'); assert.equal(report.allowanceChanges.status, 'measured');
  assert.equal(report.affectedBalanceChanges.status, 'measured');
  assert.equal(report.allowanceChanges.allowances[0].deltaRaw, '-15066115');
  assert.deepEqual(report.balanceChanges.assets.map(item => [item.asset.address, item.beforeRaw, item.afterRaw]), [[USDC, '344156193', '329090078'], [HUSDC, '3179075937', '3194142051']]);
  assert.equal(report.affectedBalanceChanges.assets.length, 1);
  assert.equal(report.affectedBalanceChanges.assets[0].asset.address, USDC);
  assert.equal(report.affectedBalanceChanges.assets[0].account, HUSDC);
  assert.equal(report.affectedBalanceChanges.assets[0].beforeRaw, '1000000000000', 'Explicit synthetic custody control, not an observed live balance');
  assert.equal(report.affectedBalanceChanges.assets[0].deltaRaw, '15066115');
  assert.equal(report.affectedBalanceChanges.reusedPairs.length, 2);
  assert.equal(report.accountEffects.summary.measuredBalancePairs, 3); assert.equal(report.accountEffects.summary.measuredAllowancePairs, 1);
  assert.equal(rpc.calls.length, 30); assert.equal(rpc.calls.filter(call => call.canonicalCheck).length, 3);
  completeEvidence(report);
});

test('synthetic local hUSDC query failure preserves allowance and withholds the affected consumer sharing the failed pair', async () => {
  const rpc = provider('balance_query_error'), report = await simulate(request, rpc);
  assert.equal(report.balanceChanges.status, 'unavailable'); assert.equal(report.allowanceChanges.status, 'measured');
  assert.equal(report.affectedBalanceChanges.status, 'unavailable');
  assert.deepEqual(report.affectedBalanceChanges.assets, []); assert.deepEqual(report.affectedBalanceChanges.reusedPairs, []);
  assert.equal(report.permissions.coverage.allowanceStateVerified, true);
  assert.equal(report.accountEffects.summary.measuredBalancePairs, 0); assert.equal(report.accountEffects.summary.measuredAllowancePairs, 1);
  assert.equal(rpc.calls.filter(call => call.method === 'debug_traceCall' && call.params[0].to === HUSDC).length, 1, 'The failed pair remains cached when the affected consumer reaches it');
  assert.equal(rpc.calls.filter(call => call.canonicalCheck).length, 1);
  assert.equal(rpc.calls.length, 25);
  assert.doesNotMatch(JSON.stringify(report), /PAIR_TEST_SECRET/);
  completeEvidence(report);
});
