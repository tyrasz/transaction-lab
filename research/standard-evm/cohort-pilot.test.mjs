import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createArtifactWriter, sealEvidence, freezePilot, loadPilotPlan } from './cohort-pilot.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temp = t => { const dir = mkdtempSync('/tmp/cohort-pilot-test-'); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('artifact writer syncs an exclusive valid JSON file and refuses overwrite', t => {
  const dir = temp(t), writer = createArtifactWriter(dir);
  writer.write('cases/001/value.json', { value: '100000000' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cases/001/value.json'))), { value: '100000000' });
  assert.throws(() => writer.write('cases/001/value.json', { different: true }), { code: 'artifact_save_failed' });
  assert.equal(writer.failed, true); assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cases/001/value.json'))), { value: '100000000' });
});

test('artifact path traversal, symlink parents and non-JSON output are rejected', t => {
  const dir = temp(t); mkdirSync(join(dir, 'outside')); symlinkSync(join(dir, 'outside'), join(dir, 'link'));
  for (const [path, value] of [['../escaped.json', {}], ['link/escaped.json', {}], ['bad.json', undefined]]) {
    const writer = createArtifactWriter(dir); assert.throws(() => writer.write(path, value), { code: 'artifact_save_failed' }); assert.equal(writer.failed, true);
  }
});

test('evidence manifest seals every non-runtime artifact once and rejects links', t => {
  const dir = temp(t), writer = createArtifactWriter(dir); mkdirSync(join(dir, 'runtime')); writeFileSync(join(dir, 'runtime/source.js'), 'source');
  writer.write('results.json', { status: 'selection_failed' }); writer.write('wire/000001.json', { result: null });
  const sealed = sealEvidence(dir, 'a'.repeat(64), 'b'.repeat(64)), bytes = readFileSync(join(dir, 'evidence-manifest.json'));
  assert.equal(sealed.manifestSha256, sha(bytes)); assert.deepEqual(JSON.parse(bytes).files.map(f => f.path), ['results.json', 'wire/000001.json']);
  assert.throws(() => sealEvidence(dir, 'a'.repeat(64), 'b'.repeat(64)), { code: 'artifact_save_failed' });
  const other = temp(t); symlinkSync(join(dir, 'results.json'), join(other, 'foreign.json'));
  assert.throws(() => sealEvidence(other, 'a'.repeat(64), 'b'.repeat(64)), { code: 'evidence_symlink' });
});

// Synthetic collector blocks and clock, with an existing real parent state and
// recorded proof/code/trace answers. This is OFFLINE integration evidence only.
// No request reaches any URL, and no new chain observation is claimed.
test('frozen full pilot executes a recorded Aave call through fake wire, seals every stage and forbids restart', async t => {
  const dir = temp(t), outputDirectory = join(dir, 'capture');
  const source = new URL('../../reports/ethereum-lending-local-reference/', import.meta.url);
  const manifestBytes = readFileSync(new URL('manifest.json', source));
  assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
  const manifest = JSON.parse(manifestBytes);
  const read = path => { const bytes = readFileSync(new URL(path, source)); assert.equal(sha(bytes), manifest.files.find(e => e.path === path).sha256); return JSON.parse(bytes); };
  const original = read('plan.json').cases[0], local = read(original.id + '-local.json'), product = read(original.id + '-product.json');
  const require = createRequire(new URL('../../engines/local-evm/package.json', import.meta.url));
  const { RLP } = await import(require.resolve('@ethereumjs/rlp')), { keccak_256 } = await import(require.resolve('@noble/hashes/sha3.js'));
  const q = n => '0x' + BigInt(n).toString(16), emptyRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
  const order = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
  const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
  const headers = [structuredClone(original.header)];
  for (let i = 1; i <= 3; i++) {
    const h = { ...structuredClone(original.header), parentHash: headers.at(-1).hash, number: q(BigInt(original.header.number) + BigInt(i)), timestamp: q(BigInt(original.header.timestamp) + BigInt(i * 12)),
      transactions: [], transactionsRoot: i === 1 ? original.header.transactionsRoot : emptyRoot, gasUsed: i === 1 ? '0x2e54f' : '0x0', blobGasUsed: '0x0' };
    const values = order.map(key => { let value = h[key].slice(2); if (integers.has(key)) { value = BigInt(h[key]) === 0n ? '' : BigInt(h[key]).toString(16); if (value.length % 2) value = '0' + value; } return Buffer.from(value, 'hex'); });
    h.hash = '0x' + Buffer.from(keccak_256(RLP.encode(values))).toString('hex'); headers.push(h);
  }
  const h1 = headers[1];
  h1.transactions = [{ hash: original.originalTransactionHash, from: original.request.from, to: original.request.to, input: original.request.data, value: '0x0', gas: '0x4c4b40', nonce: '0x1', blockHash: h1.hash, blockNumber: h1.number, transactionIndex: '0x0', type: '0x2', chainId: '0x1', maxFeePerGas: '0x38d7ea4c68000', maxPriorityFeePerGas: '0x1', accessList: [], v: '0x0', r: '0x1', s: '0x2' }];
  const frozen = await freezePilot({ repoRoot: ROOT, outputDirectory });
  const loaded = await loadPilotPlan({ outputDirectory, expectedPlanSha256: frozen.planSha256 });
  assert.equal(loaded.plan.policy.sampleSize, 16); assert.equal(loaded.plan.sourceManifestSha256, frozen.sourceManifestSha256);
  const archived = await import(pathToFileURL(join(outputDirectory, 'runtime/research/standard-evm/cohort-pilot.mjs')));
  const RealDate = globalThis.Date, realFetch = globalThis.fetch; let clock = RealDate.now(), calls = 0, unknown = null;
  class SyntheticDate extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { clock += 60001; return clock; } }
  const answers = [...local.transport.map(r => ({ request: r.request, result: r.parsed.result })), ...product.transportEvidence.map(r => ({ request: r.request, result: JSON.parse(r.responseText).result }))];
  globalThis.Date = SyntheticDate;
  globalThis.fetch = async (_url, options) => {
    calls++; const request = JSON.parse(options.body); let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest') result = headers[0];
    else if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'finalized') result = headers[3];
    else if (request.method === 'eth_getBlockByHash' && headers.some(h => h.hash === request.params[0])) {
      const h = headers.find(h => h.hash === request.params[0]); result = request.params[1] ? h : { ...h, transactions: h.transactions.map(tx => typeof tx === 'string' ? tx : tx.hash) };
    } else {
      const answer = answers.find(a => a.request.method === request.method && JSON.stringify(a.request.params) === JSON.stringify(request.params));
      if (!answer) { unknown = { method: request.method, params: request.params }; throw new Error('Unrecorded fake request'); }
      result = answer.result;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  let result;
  try {
    result = await archived.runFrozenPilot({ outputDirectory, expectedPlanSha256: frozen.planSha256 });
    assert.equal(unknown, null, JSON.stringify(unknown));
    assert.equal(result.status, 'complete', JSON.stringify({ failures: result.failures, selection: JSON.parse(readFileSync(join(outputDirectory, 'selection.json'))).artifacts.failure }));
    assert.equal(result.caseRun.accounting.counts.selected, 1); assert.equal(result.caseRun.accounting.counts.comparison.match, 1, JSON.stringify(result.caseRun.rows));
    const before = calls;
    await assert.rejects(archived.runFrozenPilot({ outputDirectory, expectedPlanSha256: frozen.planSha256 }), { code: 'artifact_save_failed' });
    assert.equal(calls, before, 'Restart cannot dispatch any request');
  } finally { globalThis.Date = RealDate; globalThis.fetch = realFetch; }
  assert(result.evidence.manifestSha256); assert.equal(result.budget.dispatches, calls);
  // The verifier performs no transport. A throwing global fetch additionally
  // guards against an accidental online validation path.
  globalThis.fetch = async () => { throw new Error('Network forbidden in verifier'); };
  try {
    const { verifyCohortEvidence } = await import(pathToFileURL(join(outputDirectory, 'runtime/research/standard-evm/cohort-verify.mjs')));
    const verified = await verifyCohortEvidence({ outputDirectory, expectedManifestSha256: result.evidence.manifestSha256 });
    assert.equal(verified.status, 'verified');
  } finally { globalThis.fetch = realFetch; }
});
