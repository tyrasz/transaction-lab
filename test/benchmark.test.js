import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBenchmarkFixtures, runBenchmarks } from '../src/benchmark.js';

test('public evidence corpus and synthetic controls are reported separately', async () => {
  const report = await runBenchmarks({ writeReport: false });
  assert.equal(report.status, 'passed', JSON.stringify(report.cases.filter(item => item.status === 'failed'), null, 2));
  assert.deepEqual(report.summary, { passed: 8, failed: 0, total: 8, observed: 4, synthetic: 4 });
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
