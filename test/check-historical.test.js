import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTrace } from '../src/analyze.js';
import { METADATA, USDC, VUSDC } from '../src/config.js';
import { RpcError } from '../src/rpc.js';
import { validateReplay } from '../src/validate.js';
import { compareHistoricalReports, loadHistoricalCases, runHistoricalChecks } from '../src/check-historical.js';

const cases = await loadHistoricalCases();

test('historical supply resolves to a byte-exact committed capture without an ignored live-report dependency', async () => {
  const supply = cases.find(item => item.operation === 'supply');
  const path = 'fixtures/source-evidence/hyperlend-live-2026-10-23T14-21-41-661Z.json';
  assert.equal(supply.evidence.sourceArtifact, 'reports/live/2026-10-23T14-21-41-661Z.json');
  assert.equal(supply.evidence.sourceReadArtifact, path);
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, 'c56d1f509ce94a86c3229da52459ec58e6d084775b122c64239225733137a6ef');
  assert.equal(digest, supply.evidence.sourceSha256);
  const original = JSON.parse(bytes).results.find(row => row.id === 'hyperlend-historical-supply').response.evidence;
  assert.deepEqual(supply.evidence.receipt, original.receipt);
  assert.deepEqual(supply.evidence.trace, original.traceResponse);
});
// Original execution is captured public evidence; these balance pairs are
// explicitly synthetic so helper tests do not invent historical RPC evidence.
function responseFor(item, positionAdjustment = 0n) {
  const { expected } = item;
  const analysis = analyzeTrace({ request: item.originalRequest, block: expected.block, trace: item.evidence.trace, metadata: METADATA, mode: 'historical_trace' });
  const balance = (address, delta) => ({ asset: { ...METADATA[address], role: address === VUSDC ? 'liability' : address === USDC ? 'underlying_asset' : 'receipt_token' }, account: expected.account, beforeRaw: '10000000000', afterRaw: (10000000000n + delta).toString(), deltaRaw: delta.toString() });
  return {
    id: 'synthetic-test-run', createdAt: '2000-01-01T00:00:00Z', timing: { totalMs: 1 },
    request: item.originalRequest,
    source: { provider: 'one', chainId: 999, transactionHash: expected.transactionHash, transactionIndex: expected.transactionIndex, blockNumber: expected.block.number, blockHash: expected.block.hash, timestamp: expected.block.timestamp, mode: 'historical_trace', blockBinding: 'transaction_hash' },
    ...analysis,
    balanceChanges: { status: 'measured', basis: 'historical_transaction_position_balanceOf', assets: [balance(USDC, BigInt(expected.cash)), balance(expected.positionToken, BigInt(expected.eventPositionDelta) + positionAdjustment)], executionIdentity: {
      transactionHash: expected.transactionHash, transactionIndex: expected.transactionIndex, postTransactionIndex: (BigInt(expected.transactionIndex) + 1n).toString(),
      stateBlockHash: expected.block.hash, blockNumber: expected.block.number, timestamp: expected.block.timestamp,
      stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', method: 'debug_traceCallMany',
    } },
    evidence: { receipt: structuredClone(item.evidence.receipt), traceResponse: structuredClone(item.evidence.trace) },
  };
}

test('four original cases are fixed to verified hashes, original indexes and known amounts', () => {
  assert.deepEqual(cases.map(item => item.operation), ['supply', 'withdraw', 'borrow', 'repay']);
  assert.deepEqual(cases.map(item => item.expected.transactionIndex), ['1', '4', '0', '12']);
  assert.deepEqual(cases.map(item => item.expected.cash), ['-15066115', '503900226', '835474410', '-199626280']);
  for (const item of cases) {
    assert.deepEqual(validateReplay(item.request), item.request);
    assert.match(item.evidence.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(item.request.transactionHash, item.evidence.receipt.transactionHash);
    assert.equal(item.expected.block.hash, item.evidence.receipt.blockHash);
  }
});

test('comparison ignores run timing and IDs but compares original executions and exact balances', () => {
  for (const item of cases) {
    const first = responseFor(item), second = structuredClone(first);
    second.id = 'another-run'; second.createdAt = '2026-01-01T00:00:00Z'; second.timing.totalMs = 9999; second.source.provider = 'two';
    second.balanceChanges.executionIdentity.additionalVerification = 'allowed-extra-field';
    second.balanceChanges.assets.reverse();
    const comparison = compareHistoricalReports(first, second, item);
    assert.equal(comparison.status, 'matched', JSON.stringify(comparison.checks.filter(check => !check.equal)));
    assert.ok(comparison.checks.some(check => check.name === 'cross-provider original receipt'));
    assert.ok(comparison.checks.some(check => check.name === 'cross-provider original call trace'));
  }
});

test('supply measured delta disagreement with event-implied value is highlighted without substituting events', () => {
  const item = cases[0];
  const first = responseFor(item, 1n), second = responseFor(item, 1n);
  const comparison = compareHistoricalReports(first, second, item);
  assert.equal(comparison.status, 'matched');
  assert.deepEqual(comparison.observations[0].map(observation => [observation.measuredDeltaRaw, observation.eventImpliedDeltaRaw, observation.differenceRaw, observation.differs]), [['15066115', '15066114', '1', true]]);
});

test('receipt, trace, event, identity and exact before/after differences are detected', () => {
  const item = cases[2];
  const mutations = [
    report => { report.evidence.receipt.gasUsed = '0x1'; },
    report => { report.evidence.traceResponse.gasUsed = '0x1'; },
    report => { report.movements[0].amountRaw = '835476149'; },
    report => { report.balanceChanges.executionIdentity.transactionIndex = '1'; },
    report => { report.balanceChanges.executionIdentity.postTransactionIndex = '0'; },
    report => { report.balanceChanges.executionIdentity.stateBlockHash = `0x${'f'.repeat(64)}`; },
    report => { report.balanceChanges.executionIdentity.headerContext = 'end_of_block'; },
    report => { report.balanceChanges.assets[0].beforeRaw = '10000000001'; report.balanceChanges.assets[0].afterRaw = (BigInt(report.balanceChanges.assets[0].afterRaw) + 1n).toString(); },
  ];
  for (const mutate of mutations) {
    const first = responseFor(item), second = structuredClone(first); mutate(second);
    assert.equal(compareHistoricalReports(first, second, item).status, 'mismatched');
  }
});

test('both providers agreeing on incorrect original identity, cash or debt classification still fails', () => {
  const item = cases[3];
  const mutations = [
    report => { report.source.transactionIndex = '0'; },
    report => { report.balanceChanges.assets[0].deltaRaw = '-2'; report.balanceChanges.assets[0].afterRaw = '9999999998'; },
    report => { report.balanceChanges.assets[1].asset.role = 'spendable'; },
    report => { report.inAssets.push({ asset: { address: VUSDC }, transferIn: [] }); },
    report => { report.protocol.positionDeltaRaw = '-199626280'; },
    report => { report.protocol.actualAmountRaw = '2'; },
    report => { report.movements.find(movement => movement.address === USDC).from = '0x1111111111111111111111111111111111111111'; },
  ];
  for (const mutate of mutations) {
    const first = responseFor(item); mutate(first);
    assert.equal(compareHistoricalReports(first, structuredClone(first), item).status, 'mismatched');
  }
});

test('unavailable, malformed and duplicate balances cannot produce a successful comparison', () => {
  const item = cases[0];
  for (const mutate of [
    report => { report.balanceChanges.status = 'unavailable'; },
    report => { report.balanceChanges.assets = []; },
    report => { report.balanceChanges.assets[0].deltaRaw = '1.1'; },
    report => { report.balanceChanges.assets[0].afterRaw = '1'; },
    report => { report.balanceChanges.assets.push(report.balanceChanges.assets[0]); },
    report => { report.evidence.traceResponse = null; },
  ]) {
    const first = responseFor(item); mutate(first);
    assert.equal(compareHistoricalReports(first, structuredClone(first), item).status, 'incomplete');
  }
  assert.equal(compareHistoricalReports(null, responseFor(item), item).status, 'incomplete');
});

test('runner is bounded to eight original replays and persists complete public requests/results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'historical-check-'));
  const replays = [], urls = [];
  try {
    const report = await runHistoricalChecks({ outputDirectory: directory,
      rpcFactory: ({ url }) => { urls.push(url); return { nextId: 1, async call() { this.nextId++; return '0x3e7'; } }; },
      replayImpl: async (request, rpc) => { replays.push(request); await rpc.call('eth_chainId', []); return responseFor(cases.find(item => item.request.transactionHash === request.transactionHash)); },
    });
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.summary, { matched: 4, mismatched: 0, incomplete: 0, total: 4 });
    assert.equal(replays.length, 8);
    assert.equal(new Set(urls).size, 2);
    for (const item of report.cases) for (const run of item.runs) {
      assert.equal(run.rpcCalls.length, 1);
      assert.deepEqual(run.rpcCalls[0].request, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
      assert.deepEqual(run.rpcCalls[0].response, { jsonrpc: '2.0', id: 1, result: '0x3e7' });
      assert.ok(run.response.evidence.receipt);
    }
    assert.deepEqual(JSON.parse(await readFile(report.outputPath, 'utf8')), report);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider failures remain bounded, sanitized and incomplete rather than successful empty output', async () => {
  const secret = 'https://secret:credential@example.invalid/private-token';
  let calls = 0;
  const report = await runHistoricalChecks({ writeReport: false,
    rpcFactory: () => ({ nextId: 1, async call() { calls++; throw new RpcError(secret, 'RPC_EXECUTION_ERROR', { rpcCode: -32602, url: secret }); } }),
    replayImpl: async (_request, rpc) => { await rpc.call('debug_traceCallMany', [{ secretFree: true }]); },
  });
  assert.equal(calls, 8);
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.incomplete, 4);
  assert.equal(JSON.stringify(report).includes(secret), false);
  for (const item of report.cases) for (const run of item.runs) {
    assert.equal(run.error.code, 'RPC_EXECUTION_ERROR');
    assert.equal(run.rpcCalls[0].error.rpcCode, -32602);
    assert.equal(run.response, undefined);
  }
});

test('nested provider error objects from injected clients are rejected before raw retention', async () => {
  const secret = 'https://secret:credential@example.invalid/provider-metadata';
  const report = await runHistoricalChecks({ writeReport: false,
    rpcFactory: () => ({ nextId: 1, async call() { return [[{ error: { code: -32602, message: secret, data: { endpoint: secret } } }]]; } }),
    replayImpl: async (_request, rpc) => { await rpc.call('debug_traceCallMany', []); },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.incomplete, 4);
  assert.equal(JSON.stringify(report).includes(secret), false);
  for (const item of report.cases) for (const run of item.runs) {
    assert.equal(run.rpcCalls[0].response, undefined);
    assert.ok(run.rpcCalls[0].error);
  }
});
