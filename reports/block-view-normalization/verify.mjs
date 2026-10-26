// Offline generation/verification only. No network libraries or product server.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeBlockViews } from './frozen/block-views.js';

const dir = new URL('./', import.meta.url), root = new URL('../../', dir);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const inventory = [
  { id: 'pilot', path: 'reports/coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/rpc.json', sha256: 'e4155c2816bdf27761869f7fc7eea8cf84ce59475c89a801a1ee5a7e144379a9' },
  { id: 'system', path: 'reports/system-transaction-diagnostic/capture.json', sha256: 'e7a2811020a5970f5a665d9948b543fc6d6155673ae823e8c86bff4f752f362c' },
  { id: 'position', path: 'reports/system-position-diagnostic/capture.json', sha256: 'be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b' },
];
const sources = {};
for (const source of inventory) {
  const bytes = await readFile(new URL(source.path, root)); assert.equal(sha(bytes), source.sha256);
  sources[source.id] = { ...source, data: JSON.parse(bytes) };
}
function packet(record, source) {
  assert.ok(record); assert.equal(record.httpStatus, 200); assert.equal(record.response.id, record.request.id); assert.equal(record.response.jsonrpc, '2.0');
  assert.equal(Object.hasOwn(record.response, 'error'), false); assert.equal(sha(record.responseRaw), record.responseSha256); assert.deepEqual(JSON.parse(record.responseRaw), record.response);
  return { status: 'available', request: structuredClone(record.request), result: structuredClone(record.response.result), provenance: {
    endpoint: record.url ?? record.endpoint, artifact: source.path, captureSha256: source.sha256, responseSha256: record.responseSha256, observedAt: record.completedAt,
  } };
}
const block = { chainId: 999, number: '49544166', hash: '0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4' };
const official = {
  ordinary: packet(sources.system.data.calls.find(record => record.request.id === 2), sources.system),
  system: packet(sources.system.data.calls.find(record => record.request.id === 3), sources.system),
};
function inputs(later, includeOrdinaryLookups) {
  return { block, official, providers: ['A', 'B'].map(id => {
    const source = later ? sources.position : sources.pilot;
    const blockRecord = source.data.records.find(record => record.provider === id && record.request.method === 'eth_getBlockByNumber' && record.response.result?.hash === block.hash);
    const transactions = sources.system.data.calls.filter(record => record.endpoint === id && record.request.method === 'eth_getTransactionByHash').map(record => packet(record, sources.system));
    if (includeOrdinaryLookups) transactions.push(...sources.position.data.records.filter(record => record.provider === id && record.request.method === 'eth_getTransactionByHash').map(record => packet(record, sources.position)));
    return { id, block: packet(blockRecord, source), transactions };
  }) };
}
const variants = [
  { id: 'earlier_lists_without_ordinary_envelopes', kind: 'saved_initial_evidence_only', input: inputs(false, false) },
  { id: 'earlier_lists_with_later_ordinary_envelopes', kind: 'composite_development_evidence_across_capture_times', input: inputs(false, true) },
  { id: 'later_lists_with_saved_system_envelopes', kind: 'composite_development_evidence_across_capture_times', input: inputs(true, true) },
];
const sourceBytes = await readFile(new URL('frozen/block-views.js', dir));
const report = {
  schemaVersion: '1.0', status: 'offline_development_normalization', networkCalls: 0, source: { path: 'frozen/block-views.js', sha256: sha(sourceBytes) }, sources: inventory,
  cases: variants.map(variant => ({ ...variant, output: normalizeBlockViews(variant.input) })),
  limitations: [
    'The first case intentionally lacks ordinary envelopes and remains partial. The other two combine explicitly timestamped saved observations; neither is a simultaneous prospective cohort.',
    'The official ordinary reference contains hashes only. Full ordinary envelopes come from A/B historical lookups; there is no unseen official-envelope assertion.',
    'Eight RPC-enumerated reference actions and eleven observed hashes are identity bookkeeping, not a transaction accuracy result. Replay boundaries and execution order remain unknown.',
    'No v1 pilot, evaluator protocol, product core inventory or live request was changed. Future admission requires separately frozen v2 rules and position/execution proof.',
  ],
};
const summaries = report.cases.map(({ id, output }) => ({ id, mapping: output.identityMapping.status, classifications: output.views.map(view => view.classification), referenceRows: output.referenceActions.length,
  N_enumerated: output.denominator.N_enumerated, occurrences: output.occurrences.length, unresolved: output.unresolvedOccurrences.length, distinctHashes: output.denominator.distinctObservedHashes }));
assert.deepEqual(summaries, [
  { id: variants[0].id, mapping: 'partial', classifications: ['unresolved', 'unresolved'], referenceRows: 8, N_enumerated: null, occurrences: 27, unresolved: 10, distinctHashes: 11 },
  { id: variants[1].id, mapping: 'complete', classifications: ['ordinary_only', 'system_inclusive'], referenceRows: 8, N_enumerated: 8, occurrences: 37, unresolved: 0, distinctHashes: 11 },
  { id: variants[2].id, mapping: 'complete', classifications: ['system_inclusive', 'system_inclusive'], referenceRows: 8, N_enumerated: 8, occurrences: 40, unresolved: 0, distinctHashes: 11 },
]);
for (const { output } of report.cases) {
  assert.ok(output.occurrences.every(item => item.replayBoundary === 'unknown'));
  assert.ok(output.referenceActions.every(item => item.replayBoundary === 'unknown' && item.executionOrder === 'unknown' && item.execution === 'not_assessed'));
  assert.equal(output.denominator.fraction, null);
}
const files = ['verify.mjs', 'frozen/block-views.js', 'NOTES.md', 'report.json', 'summary.json'];
if (process.argv.length === 3 && process.argv[2] === '--write') {
  await writeFile(new URL('report.json', dir), json(report), { flag: 'wx' });
  await writeFile(new URL('summary.json', dir), json({ status: report.status, networkCalls: 0, cases: summaries }), { flag: 'wx' });
  const manifest = { schemaVersion: '1.0', status: report.status, networkCalls: 0, sources: inventory, files: [] };
  for (const file of files) { const bytes = await readFile(new URL(file, dir)); manifest.files.push({ file, bytes: bytes.length, sha256: sha(bytes) }); }
  await writeFile(new URL('manifest.json', dir), json(manifest), { flag: 'wx' });
} else {
  assert.equal(process.argv.length, 2, 'No network or arbitrary command mode is supported.');
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir)));
  assert.deepEqual({ schemaVersion: manifest.schemaVersion, status: manifest.status, networkCalls: manifest.networkCalls, sources: manifest.sources }, { schemaVersion: '1.0', status: report.status, networkCalls: 0, sources: inventory });
  for (const entry of manifest.files) { assert.ok(files.includes(entry.file)); const bytes = await readFile(new URL(entry.file, dir)); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); }
  assert.deepEqual(manifest.files.map(entry => entry.file), files);
  assert.deepEqual(JSON.parse(await readFile(new URL('report.json', dir))), report);
  assert.deepEqual(JSON.parse(await readFile(new URL('summary.json', dir))), { status: report.status, networkCalls: 0, cases: summaries });
}
console.log(json({ status: 'verified_offline', networkCalls: 0, cases: summaries }));
