// Fixed provider-capability diagnostic, not an owned-engine accuracy trial.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCohortTransport, createCohortWireBudget } from './cohort-wire.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.argv[2]);
const sha = x => createHash('sha256').update(x).digest('hex');
const source = readFileSync(fileURLToPath(import.meta.url));
const inputBytes = readFileSync(join(root, 'reports/ordinary-ethereum-unresolved-v4/cases/007/product.json'));
const input = JSON.parse(inputBytes).report;
const original = input.evidence.find(r => r.method === 'debug_traceCall').params[0];
const pinned = { blockHash: input.block.hash, requireCanonical: true };
const probe = '0x000000000000000000000000000000000000ba1a';
// BLOBHASH(0), BLOBHASH(1), BLOBBASEFEE: three exact 32-byte words.
const code = '0x6000496000526001496020524a60405260606000f3';
const witness = { ...original, to: probe, gas: '0x493e0' };
const requests = [
  [original, pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true }, blockOverrides: { blobBaseFee: '0x0' } }],
  [original, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true }, blockOverrides: { blobBaseFee: '0x0' } }],
  [witness, pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true }, blockOverrides: { blobBaseFee: '0x0' }, stateOverrides: { [probe]: { code } } }],
  [witness, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true }, blockOverrides: { blobBaseFee: '0x0' }, stateOverrides: { [probe]: { code } } }],
];
mkdirSync(out);
const save = (path, object) => writeFileSync(join(out, path), JSON.stringify(object, null, 2) + '\n', { flag: 'wx' });
const plan = { createdAt: new Date().toISOString(), provider: 'https://eth.drpc.org/', purpose: 'explicit_zero_blob_base_fee_provider_capability_only',
  sourceSha256: sha(source), inputSha256: sha(inputBytes), requests, retries: 0, replacements: 0,
  limitations: ['No original-transaction replay or proof-backed independent comparison', 'Explicit synthetic zero blob base fee; no fee settlement or KZG validation'],
  expectedWitnessOutput: '0x' + original.blobVersionedHashes[0].slice(2) + '00'.repeat(64) };
save('plan.json', plan); writeFileSync(join(out, 'runner.mjs'), source, { flag: 'wx' });
const budget = createCohortWireBudget({ limits: { calls: 4, totalBytes: 4 * 1024 * 1024, wallMs: 120000 } });
const rpc = createCohortTransport({ budget, provider: 'drpc', profile: 'product', blockHash: pinned.blockHash,
  limits: { calls: 4, totalBytes: 4 * 1024 * 1024, wallMs: 120000 }, save: wire => save(`wire-${wire.globalId}.json`, wire) });
const results = [];
for (const [i, params] of requests.entries()) {
  try { results.push({ index: i, result: await rpc.call('debug_traceCall', params) }); }
  catch (e) { results.push({ index: i, error: e.code }); }
}
await rpc.drain();
const summary = { results, usage: rpc.usage(), sourceUnchanged: sha(readFileSync(fileURLToPath(import.meta.url))) === plan.sourceSha256,
  witnessMatches: results[2]?.result?.output === plan.expectedWitnessOutput };
save('results.json', summary);
console.log(JSON.stringify({ calls: budget.snapshot().calls, statuses: results.map(r => r.error ?? 'completed'), witnessMatches: summary.witnessMatches }, null, 2));
