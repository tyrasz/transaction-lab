import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EvaluationBudget, EVALUATION_PROVIDERS } from '../src/evaluation-budget.js';
import { selectProspectiveCohort } from '../src/evaluate-coverage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRECTORY = path.join(ROOT, 'reports/coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336');
const FROZEN_COMMIT = '1842375';
const ENGINE_SHA = '7658ae0d03d6b17f72045905d231e9803b6ab38d57b4cac3a88d2eec19b5ff10';
const INDEX_SHA = '1a70f0c3dcd7dc086a8a42bdf85808287d99f1c6f8acf1516569dd1e3a448b7d';
const RPC_SHA = 'e4155c2816bdf27761869f7fc7eea8cf84ce59475c89a801a1ee5a7e144379a9';
const REPORT_SHA = '7ce63653f1ed48de26da881266b256f1238156d42a85b68b7fc7b47a71c2edb7';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => readFile(path.join(DIRECTORY, file));
const parse = async file => JSON.parse(await read(file));

test('first prospective pilot preserves every artifact and its actual frozen source provenance', async () => {
  const indexBytes = await read('artifact-index.json');
  assert.equal(sha(indexBytes), INDEX_SHA);
  const index = JSON.parse(indexBytes);
  assert.equal(index.reportSha256, REPORT_SHA);
  assert.deepEqual(index.artifacts.map(artifact => artifact.file), ['manifest.json', 'cohort.json', 'product-seal.json', 'rpc.json', 'ledger.json', 'report.json']);
  for (const artifact of index.artifacts) {
    const bytes = await read(artifact.file);
    assert.equal(bytes.length, artifact.bytes, artifact.file);
    assert.equal(sha(bytes), artifact.sha256, artifact.file);
  }
  assert.equal(sha(await read('rpc.json')), RPC_SHA);
  const manifest = await parse('manifest.json');
  assert.equal(manifest.T0, '2026-10-26T04:23:53.888Z');
  assert.equal(manifest.implementation.engine.version, '0.7.0');
  assert.equal(manifest.implementation.engine.sourceSha256, ENGINE_SHA);
  assert.equal(manifest.implementation.sha256, '43e5ff1a0c7d06f916980af669502a1d7b3e586102769c48cff65ba8e6aa32bd');
  assert.equal(sha(JSON.stringify(manifest.implementation.files, null, 2) + '\n'), manifest.implementation.sha256);

  // Check the immutable committed sources used for this observation. Future
  // implementation changes do not require re-recording the chain responses.
  const frozen = new Map();
  for (const source of manifest.implementation.files) {
    const bytes = execFileSync('git', ['show', `${FROZEN_COMMIT}:${source.file}`], { cwd: ROOT });
    assert.equal(sha(bytes), source.sha256, source.file);
    frozen.set(source.file, bytes);
  }
  const sourceList = [...frozen.get('src/server.js').toString('utf8').match(/const engineFiles = (\[[^\n]+\]);/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(sourceList, manifest.implementation.engine.sourceFiles);
  const engine = createHash('sha256');
  for (const file of sourceList) engine.update(file + '\0').update(frozen.get(`src/${file}`)).update('\0');
  assert.equal(engine.digest('hex'), ENGINE_SHA);
  assert.equal(JSON.parse(frozen.get('package.json')).version, '0.7.0');

  const report = await parse('report.json');
  assert.equal(report.status, 'selection_failed'); assert.equal(report.evaluationValid, false);
  assert.equal(report.sourceUnchanged, true); assert.equal(report.metrics, null);
  assert.deepEqual(report.budget.transactionRpc, {}); assert.equal(report.budget.rpcCount, 9);
  assert.equal(report.budget.responseBytes, 13512); assert.equal(report.noRetries, true);
  assert.deepEqual(await parse('ledger.json'), { N: null, rows: [] });
  const seal = await parse('product-seal.json');
  assert.deepEqual(seal.products, []); assert.deepEqual(seal.productRpc, []); assert.equal(seal.comparatorHasStarted, false);
});

test('recorded headers isolate the first selected block transaction-list disagreement without attributing correctness', async () => {
  const { records } = await parse('rpc.json'), manifest = await parse('manifest.json');
  const [f, finalizedA, finalizedB, selectedA, selectedB, secondA, secondB] = records.slice(2).map(record => record.response.result);
  assert.equal(BigInt(f.number), 49544165n);
  assert.equal(BigInt(finalizedA.number), 49544287n); assert.equal(finalizedB.number, finalizedA.number);
  assert.ok(BigInt(finalizedA.number) >= BigInt(f.number) + 2n);
  assert.equal(BigInt(selectedA.number), 49544166n);
  assert.equal(selectedA.hash, '0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4');
  assert.equal(selectedA.hash, selectedB.hash); assert.equal(selectedA.parentHash, f.hash);
  assert.equal(secondA.parentHash, selectedA.hash);
  assert.ok(Number(BigInt(selectedA.timestamp)) * 1000 > Date.parse(manifest.T0));
  assert.ok(Number(BigInt(secondA.timestamp)) * 1000 > Date.parse(manifest.T0));
  assert.equal(selectedA.transactions.length, 5); assert.equal(selectedB.transactions.length, 8);
  assert.deepEqual(selectedB.transactions.slice(3), selectedA.transactions);
  assert.deepEqual(selectedB.transactions.slice(0, 3), [
    '0xc9d5e5dfb1b07ed8d7bb0373618767191bd7ad9bcc11d9185bff886ba7ab088a',
    '0x14f094947b7c9ca7d83baad145e0e26e3c770a884709e7dc4b3e539d222664d8',
    '0x395725735b69f19ffcb48893a82942e932bfd719ef10faf666ae739d2a510939',
  ]);
  const differingFields = [...new Set([...Object.keys(selectedA), ...Object.keys(selectedB)])].filter(key => JSON.stringify(selectedA[key]) !== JSON.stringify(selectedB[key]));
  assert.deepEqual(differingFields, ['size', 'transactions']);
  assert.equal(BigInt(selectedA.size), 2736n); assert.equal(BigInt(selectedB.size), 3949n);
  assert.deepEqual(secondA, secondB); assert.equal(secondA.transactions.length, 5);
  // These observations alone do not identify the correct provider, canonical
  // transaction indices, or whether any additional hash denotes a system call.
});

test('exact nine-request offline replay fails selection with no cohort, transaction inspection or fallback', async () => {
  const capture = await parse('rpc.json'), manifest = await parse('manifest.json'), originalCohort = await parse('cohort.json');
  const t0 = Date.parse(manifest.T0);
  let now = t0 + 1, next = 0;
  const budget = new EvaluationBudget({ t0, now: () => now, limits: manifest.limits,
    async fetchImpl(url, options) {
      assert.ok(next < capture.records.length, 'The replay must not perform an additional request.');
      const recorded = capture.records[next++];
      assert.equal(url, recorded.endpoint); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), recorded.request);
      assert.equal(recorded.endpoint, EVALUATION_PROVIDERS[recorded.provider]);
      assert.equal(recorded.phase, 'selection'); assert.equal(recorded.caseId, null);
      assert.equal(sha(recorded.responseRaw), recorded.responseSha256);
      assert.deepEqual(JSON.parse(recorded.responseRaw), recorded.response);
      assert.equal(Buffer.byteLength(recorded.responseRaw), recorded.responseBytes);
      return new Response(recorded.responseRaw, { status: recorded.httpStatus });
    },
  });
  const result = await selectProspectiveCohort({ budget, t0, now: () => now, sleep: async milliseconds => {
    now += milliseconds;
    // Reproduce the observed one-millisecond scheduling lateness. Transport
    // latency and generated timing metadata are intentionally not replayed.
    if ([t0 + 60000, t0 + 180000].includes(now)) now++;
  } });
  assert.deepEqual(result, originalCohort);
  assert.equal(result.status, 'selection_failed'); assert.equal(result.N, null); assert.deepEqual(result.ledger, []);
  assert.equal(next, 9); assert.equal(budget.rpcCount, 9); assert.equal(budget.responseBytes, 13512);
  assert.deepEqual(budget.snapshot().transactionRpc, {}); assert.equal(budget.snapshot().exhaustion, null);
  assert.deepEqual(budget.records.map(record => ({ endpoint: record.endpoint, request: record.request, response: record.response, responseRaw: record.responseRaw, responseBytes: record.responseBytes, responseSha256: record.responseSha256 })),
    capture.records.map(record => ({ endpoint: record.endpoint, request: record.request, response: record.response, responseRaw: record.responseRaw, responseBytes: record.responseBytes, responseSha256: record.responseSha256 })));
  assert.deepEqual(budget.records.map(record => record.request.method), ['eth_chainId', 'eth_chainId', ...Array(7).fill('eth_getBlockByNumber')]);
  assert.equal(budget.records.some(record => record.request.params.includes('latest')), false);
  assert.equal(budget.records.some(record => record.phase !== 'selection'), false);
});
