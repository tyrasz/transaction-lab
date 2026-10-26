// Offline audit only. No imports from the product, runner, or network clients.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = name => readFile(path.join(here, name));
const read = async name => JSON.parse(await bytes(name));
const [manifest, index, report, raw, selection, cohort, finalLedger, seal] = await Promise.all(['manifest.json','artifact-index.json','report.json','rpc.json','selection-rpc.json','cohort.json','ledger.json','product-seal.json'].map(read));
const checks = [];
assert.equal(sha(await bytes('report.json')), '37472003b8fcdb55fe29e9ac8026572cbf375bd0297773bb92b53b010145f73e');
assert.equal(sha(await bytes('rpc.json')), '864f909e8dae63593bcc7b4f1b53f5e812dff9ee53307a4aa3647c519b6c60df');
assert.equal(manifest.implementation.sha256, '37dfa8d10226b144da8895ac7860171aad5fe686a8d630326bd22fe18f042e72');
for (const item of index.artifacts) { const value = await bytes(item.file); assert.equal(value.length, item.bytes); assert.equal(sha(value), item.sha256); }
checks.push('Every runner artifact has its indexed exact bytes and SHA-256.');
for (const item of manifest.implementation.files) assert.equal(sha(await readFile(path.join(root, item.file))), item.sha256);
assert.equal(sha(JSON.stringify(manifest.implementation.files, null, 2) + '\n'), manifest.implementation.sha256);
const engineHash = createHash('sha256');
for (const file of manifest.implementation.engine.sourceFiles) engineHash.update(file + '\0').update(await readFile(path.join(root, 'src', file))).update('\0');
assert.equal(engineHash.digest('hex'), manifest.implementation.engine.sourceSha256); assert.equal(report.sourceUnchanged, true);
checks.push('Current complete source closure and engine identity match the pre-network manifest.');
assert.deepEqual(raw.records.filter(record => record.phase === 'selection'), selection.records);
assert.equal(sha(await bytes('selection-rpc.json')), cohort.selectionRpcSha256);
let successfulBodies = 0, errorRecords = 0, summedBytes = 0; const phaseCounts = {}, providerCounts = {};
const caseCounts = {}, labelMap = new Map();
for (const row of finalLedger.rows) for (const label of row.discoveryBudgetLabels ?? []) { assert.equal(labelMap.has(label), false); labelMap.set(label, row.id); }
for (const [ordinal, record] of raw.records.entries()) {
  assert.equal(record.id, ordinal + 1); assert.equal(record.request.id, record.id); assert.equal(record.request.jsonrpc, '2.0');
  assert.equal(record.endpoint, manifest.providers[record.provider].url); assert.ok(Number.isSafeInteger(record.responseBytes) && record.responseBytes >= 0);
  summedBytes += record.responseBytes; phaseCounts[record.phase] = (phaseCounts[record.phase] ?? 0) + 1; providerCounts[record.provider] = (providerCounts[record.provider] ?? 0) + 1;
  if (record.caseId) { const owner = labelMap.get(record.caseId) ?? record.caseId; caseCounts[owner] = (caseCounts[owner] ?? 0) + 1; }
  assert.ok(Date.parse(record.startedAt) >= Date.parse(manifest.T0)); assert.ok(Date.parse(record.completedAt) >= Date.parse(record.startedAt));
  assert.equal(record.elapsedMs, Date.parse(record.completedAt) - Date.parse(record.startedAt));
  if (record.response) {
    successfulBodies++; assert.equal(record.error, undefined); assert.equal(Buffer.byteLength(record.responseRaw), record.responseBytes); assert.equal(sha(record.responseRaw), record.responseSha256);
    assert.deepEqual(JSON.parse(record.responseRaw), record.response); assert.equal(record.response.id, record.id); assert.equal(record.response.jsonrpc, '2.0'); assert.equal(Object.hasOwn(record.response, 'error'), false);
  } else { errorRecords++; assert.ok(record.error); assert.equal(record.responseRaw, undefined); assert.equal(record.bodyRetained, false); }
}
assert.equal(raw.records.length, raw.accounting.rpcCount); assert.equal(raw.records.length, report.budget.rpcCount); assert.equal(summedBytes, raw.accounting.responseBytes); assert.equal(summedBytes, report.budget.responseBytes);
assert.deepEqual(caseCounts, report.budget.transactionRpc); assert.deepEqual(report.budget.limits, manifest.limits); assert.deepEqual(manifest.limits, manifest.policyLimits);
assert.ok(raw.records.length <= manifest.limits.totalRpc); assert.ok(Object.values(caseCounts).every(count => count <= manifest.limits.perTransactionRpc));
if (summedBytes > manifest.limits.totalResponseBytes) assert.ok(raw.records.some(record => record.error?.code === 'BUDGET_TOTAL_BYTES'));
checks.push('Every retained successful RPC body, sequential request identity, exact byte/hash and shared counter is independently checked; withheld error bytes are counted but cannot be reconstructed.');
assert.equal(finalLedger.rows.length, cohort.ledger.length);
for (const [i, row] of finalLedger.rows.entries()) {
  const original = cohort.ledger[i]; for (const key of Object.keys(original).filter(key => key !== 'reason')) assert.deepEqual(row[key], original[key]);
  // The runner replaces the display reason when assigning attempt status; the
  // original normalization reason remains immutable in cohort.json.
  if (original.reason && row.status === 'identity_unresolved') assert.equal(row.reason, 'No unambiguous provider representation; no input was invented.');
  assert.equal(row.attemptOrdinal, i); assert.equal(row.replayBoundary, 'unknown'); assert.equal(row.executionOrder, 'unknown');
  if (row.attempted) assert.ok(i < manifest.limits.attempts);
  if (row.productInvoked) { assert.equal(row.identityStatus, 'resolved'); assert.notEqual(row.kind, 'unresolved'); }
}
const references = finalLedger.rows.filter(row => row.kind !== 'unresolved'), unresolved = finalLedger.rows.filter(row => row.kind === 'unresolved');
const observedReferences = cohort.blocks.flatMap(block => block.normalization?.referenceActions ?? []);
assert.deepEqual(references.map(row => row.id).sort(), observedReferences.map(row => row.id).sort());
assert.equal(references.length, report.metrics.population.knownReferenceRows); assert.equal(unresolved.length, report.metrics.population.unresolvedOccurrenceRows);
if (report.metrics.population.N_enumerated !== null) { assert.equal(report.metrics.population.N_enumerated, references.length); assert.equal(cohort.blocks.length, 2); for (const block of cohort.blocks) { assert.notEqual(block.normalization.denominator.N_enumerated, null); assert.equal(block.viewStability.status, 'stable'); assert.equal(block.envelopeDiscovery.status, 'complete'); } }
else for (const metric of ['executionAvailability','retrievalAgreement','exactReplayAgreement']) assert.equal(report.metrics.combined[metric].fraction, null);
assert.equal(finalLedger.rows.filter(row => row.attempted).length <= manifest.limits.attempts, true);
checks.push('All cohort rows and reference occurrences remain in the final ledger; attempt cap, unknown replay boundaries and null-denominator fractions are preserved.');
for (const block of cohort.blocks) for (const packet of [block.input.official.ordinary, block.input.official.system, ...block.input.providers.flatMap(provider => [provider.block, ...provider.transactions]), ...block.viewStability.observations.map(value => value.anchor)]) {
  const record = selection.records.find(value => value.id === packet.request.id); assert.ok(record); assert.deepEqual(packet.request, record.request); assert.deepEqual(packet.result, record.response.result);
  assert.equal(packet.provenance.responseSha256, record.responseSha256); assert.equal(packet.provenance.endpoint, record.endpoint); assert.equal(packet.provenance.captureSha256, cohort.selectionRpcSha256);
}
assert.deepEqual(cohort.blocks.map(block => block.number), ['49556878','49556879']);
const systemBlock = cohort.blocks[0], officialSystem = systemBlock.input.official.system.result[0], aliasA = systemBlock.input.providers[0].transactions[0].result, aliasB = systemBlock.input.providers[1].block.result.transactions[0];
assert.deepEqual(aliasA, aliasB); assert.deepEqual(systemBlock.input.providers[0].block.result.transactions, []); assert.equal(systemBlock.input.providers[1].block.result.transactions.length, 1);
for (const field of ['type','chainId','nonce','gasPrice','gas','from','to','value','input','blockHash','blockNumber','transactionIndex']) assert.equal(officialSystem[field], aliasA[field]);
assert.deepEqual(Object.keys(officialSystem).filter(field => officialSystem[field] !== aliasA[field]).sort(), ['hash','r','s','v']);
assert.equal(officialSystem.r, '0x0'); assert.equal(officialSystem.s, '0x0'); assert.equal(officialSystem.v, '0x7f1');
assert.equal(aliasA.r, '0x1'); assert.equal(aliasA.s, '0x1'); assert.equal(aliasA.v, '0x7f2'); assert.notEqual(BigInt(aliasA.s), BigInt(aliasA.from));
assert.equal(references.length, 2); assert.equal(unresolved.length, 3); assert.equal(finalLedger.rows.filter(row => row.status === 'identity_unresolved').length, 4);
assert.equal(report.metrics.population.N_enumerated, null); assert.equal(report.evaluationValid, false);
checks.push('Every normalization packet binds to its exact saved selection request/response; the newly observed s=1 system form is retained unresolved, with two reference rows and three occurrence rows.');
assert.deepEqual(seal.productRpc, raw.records.filter(record => record.phase === 'product')); assert.equal(seal.comparatorHasStarted, false);
for (const record of raw.records.filter(record => record.phase === 'comparator')) assert.ok(Date.parse(record.startedAt) >= Date.parse(seal.sealedAt));
for (const item of seal.products) assert.equal(sha(await bytes(item.file)), item.sha256);
assert.equal(seal.products.length, finalLedger.rows.filter(row => row.productInvoked).length);
assert.equal(report.security.status, 'not_assessed'); assert.deepEqual(report.security.findings, []); assert.equal(report.noRetries, true);
checks.push('All invoked product outputs and product RPCs were sealed before any comparator request; security remains unassessed.');
const result = { audit: 'offline_no_network', runId: report.runId, status: 'passed', reportStatus: report.status, sourceSha256: manifest.implementation.sha256, engine: manifest.implementation.engine,
  reportSha256: sha(await bytes('report.json')), rpcSha256: sha(await bytes('rpc.json')), counts: { rpc: raw.records.length, responseBytes: summedBytes, successfulBodies, errorRecords, phaseCounts, providerCounts, referenceRows: references.length, unresolvedRows: unresolved.length, attemptedSlots: finalLedger.rows.filter(row => row.attempted).length, productInvocations: seal.products.length }, checks,
  limitations: ['Artifact consistency and accounting audit, not a second execution engine or proof of provider truth.', 'Withheld provider error bodies cannot be reconstructed from their retained hash/count.', 'No retry claim is checked against the single fixed process and captured phase/request sequence; repeated legitimate context queries are not reclassified as retries.'] };
if (process.argv.includes('--write')) await writeFile(path.join(here, 'audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
