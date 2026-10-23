import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateFixture, loadBenchmarkFixtures, runBenchmarks } from '../src/benchmark.js';
import { analyzeTrace } from '../src/analyze.js';

test('public evidence corpus and synthetic controls are reported separately', async () => {
  const report = await runBenchmarks({ writeReport: false });
  assert.equal(report.status, 'passed', JSON.stringify(report.cases.filter(item => item.status === 'failed'), null, 2));
  assert.equal(report.summary.passed, report.cases.length);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.total, report.cases.length);
  assert.equal(report.summary.observed, report.cases.filter(item => item.kind === 'observed_rpc_trace').length);
  assert.equal(report.summary.synthetic, report.cases.filter(item => item.kind === 'synthetic_adversarial_fixture').length);
  assert.ok(report.summary.observed > 0 && report.summary.synthetic > 0);
  assert.equal(report.comparison.aggregateVendorScore, null);
  assert.equal(report.comparison.sameBlock, false);
  assert.equal(report.comparison.principal.agreement, true);
  assert.equal(report.comparison.security.status, 'not_evaluated');
  assert.equal(report.comparison.receiptTokenMint.status, 'not_a_same_block_accuracy_test');
  for (const item of report.cases) {
    if (item.kind === 'synthetic_adversarial_fixture') assert.equal(item.provenance.isRealTransaction, false);
    else assert.match(item.provenance.sourceSha256, /^[a-f0-9]{64}$/);
  }
  const historical = report.cases.find(item => item.id === 'hyperlend-observed-historical-supply');
  const rejected = report.cases.find(item => item.id === 'hyperlend-observed-insufficient-balance');
  assert.equal(historical.provenance.isExecutedTransaction, true);
  assert.equal(historical.provenance.blockBinding, 'transaction_hash');
  assert.equal(rejected.provenance.isExecutedTransaction, false);
  assert.equal(rejected.provenance.blockBinding, 'explicit_block_hash');
  assert.match(rejected.provenance.traceCanonicalJsonSha256, /^[a-f0-9]{64}$/);
});

test('six lending regression cases preserve source hashes, exact amounts and block provenance', async () => {
  const { fixtures } = await loadBenchmarkFixtures();
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const amounts = {
    'historical-withdraw': ['503900226', '503900226', '-503900226'],
    'current-withdraw': ['503900226', '503900226', '-503900226'],
    'historical-borrow': ['835474410', '835474410', '835474410'],
    'current-borrow': ['835474410', '835474410', '835474410'],
    'historical-repay': ['199626280', '199626280', '-199626279'],
    'current-repay': ['199626280', '2', '-2'],
  };
  for (const [suffix, expected] of Object.entries(amounts)) {
    const fixture = fixtures.find(item => item.id === `hyperlend-observed-${suffix}`);
    assert.ok(fixture, suffix);
    const sourceBytes = await readFile(new URL(`../${fixture.provenance.sourceArtifact}`, import.meta.url));
    const source = JSON.parse(sourceBytes);
    assert.equal(sha(sourceBytes), fixture.provenance.sourceSha256);
    assert.equal(sha(JSON.stringify(fixture.input.trace)), fixture.provenance.traceCanonicalJsonSha256);
    assert.deepEqual(fixture.input.trace, source.captures[fixture.provenance.sourceResultId].response.result);
    assert.equal(sha(await readFile(new URL(`../${fixture.provenance.expectedEvidence.artifact}`, import.meta.url))), fixture.provenance.expectedEvidence.sha256);
    assert.deepEqual(fixture.input.block, fixture.provenance.block);
    assert.deepEqual([fixture.expected.protocol.amountRaw, fixture.expected.protocol.actualAmountRaw, fixture.expected.protocol.positionDeltaRaw], expected);
    assert.equal(fixture.expected.positionChanges.length, 1);
    assert.ok(fixture.provenance.limitations.some(text => text.includes('not blind or held-out')));
    const historical = suffix.startsWith('historical');
    assert.equal(fixture.provenance.isExecutedTransaction, historical);
    assert.equal(fixture.provenance.blockBinding, historical ? 'transaction_hash' : 'explicit_block_hash');
    if (historical) {
      assert.equal(source.captures.receipt.response.result.status, '0x1');
      assert.equal(source.captures.receipt.response.result.blockHash, fixture.input.block.hash);
    } else {
      assert.equal(fixture.provenance.rpcRequest.params[1], fixture.input.block.hash);
      assert.equal(fixture.input.block.number, '49318777');
    }
  }
});

test('lending checks catch requested/actual confusion, position errors and liabilities in either asset direction', async () => {
  const { fixtures } = await loadBenchmarkFixtures();
  const fixture = fixtures.find(item => item.id === 'hyperlend-observed-current-repay');
  const original = analyzeTrace(fixture.input);
  const mutations = [
    analysis => { analysis.protocol.actualAmountRaw = analysis.protocol.amountRaw; },
    analysis => { analysis.positionChanges[0].deltaRaw = '-199626280'; },
    analysis => { analysis.positionChanges[0].role = 'receipt_token'; },
    analysis => { analysis.inAssets.push({ asset: { address: fixture.expected.positionChanges[0].token }, transferIn: [] }); },
    analysis => { analysis.outAssets.push({ asset: { address: fixture.expected.positionChanges[0].token }, transferOut: [] }); },
  ];
  for (const mutate of mutations) {
    const analysis = structuredClone(original);
    mutate(analysis);
    assert.ok(evaluateFixture(fixture, analysis).some(check => !check.passed));
  }
});

test('a broken analyzer cannot produce a passing report; failures are persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transaction-lab-benchmark-'));
  try {
    const { fixtures } = await loadBenchmarkFixtures();
    const outputPath = join(directory, 'result.json');
    const report = await runBenchmarks({ fixtures: fixtures.slice(0, 1), outputPath,
      analyzer: () => { throw new Error('controlled decoder failure'); } });
    assert.equal(report.status, 'failed');
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.passed, 0);
    assert.equal(report.cases[0].checks[0].actual, 'controlled decoder failure');
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved reference contains public payload and no authentication or environment fields', async () => {
  const { reference } = await loadBenchmarkFixtures();
  assert.equal(reference.provenance.httpStatus, 200);
  assert.equal(reference.provenance.block, null);
  assert.equal(reference.provenance.blockBinding, 'not_exposed_by_response');
  assert.doesNotMatch(JSON.stringify(reference), /"(?:authorization|cookie|environmentId|jwt|verificationToken)"\s*:/i);
});
