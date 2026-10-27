// Offline supplementary audit only. Never alters the frozen prospective result.
import assert from 'node:assert/strict';
import { readFile, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKET = resolve(ROOT, 'reports/ordinary-ethereum-cohort-v1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const here = path => fileURLToPath(new URL(path, import.meta.url));
const auditBytes = await readFile(here('audit-corrected.json'));
assert.equal(sha(auditBytes), '5b16c94a954b4b328bfcd15a8a1a7c6909f867117d6fea1a3a961b2aff93e960');
const audit = JSON.parse(auditBytes), development = await read(here('development-reclassification.json'));
assert.equal(sha(await readFile(here('development-reclassification.json'))), 'a6ea62cdfa229b969a7da8fa4f90495b31ead271e75b1393089601cfdab9b1aa');
assert.equal(sha(await readFile(here('audit.json'))), audit.supersedes.sha256);
for (const [name, expected] of Object.entries(audit.sourceArtifacts)) {
  const bytes = await readFile(resolve(PACKET, name));
  assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
}
// Check the complete hash-bound runtime bytes before importing archived code.
// The original verifier then checks its full inventory/link/mode rules too.
const sourceManifest = await read(resolve(PACKET, 'source-manifest.json'));
for (const entry of sourceManifest.files) {
  const file = resolve(PACKET, 'runtime', entry.path);
  if (entry.kind === 'symlink') assert.equal(await readlink(file), entry.target);
  else {
    const bytes = await readFile(file);
    assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  }
}
const archived = path => import(pathToFileURL(resolve(PACKET, 'runtime', path)));
const [{ verifyCohortEvidence }, { CENSUS_LIMITS }, { verifyEthereumHeader }] = await Promise.all([
  archived('research/standard-evm/cohort-verify.mjs'), archived('research/standard-evm/cohort-census.mjs'), archived('engines/local-evm/ethereum-header.js'),
]);
const verified = await verifyCohortEvidence({ outputDirectory: PACKET, expectedManifestSha256: 'fdb96c50015b6854f63d28d1d84dd715b36db19146d04086aa824ce55edbf50b' });
assert.deepEqual(verified, audit.offlineVerification);
assert.equal(CENSUS_LIMITS.simulationCalldataBytes, 32768);
assert.equal(CENSUS_LIMITS.simulationGas, 5000000);
assert.equal(sha(await readFile(resolve(ROOT, audit.projectionCriteria.source))), audit.projectionCriteria.sourceSha256);
const s = await read(resolve(PACKET, 'selection.json'));
const selected = new Set(s.census.selected.map(row => row.transactionHash));
const known = new Set(['hash', 'from', 'to', 'input', 'value', 'gas', 'nonce', 'blockHash', 'blockNumber', 'transactionIndex', 'type', 'chainId', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'blobVersionedHashes', 'accessList', 'authorizationList', 'v', 'r', 's', 'yParity']);
const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const reasonCounts = {}, types = {}, selectedTypes = {}, ext = {}, selectedExt = {};
function reasons(e) {
  const out = [];
  if (e.to === null) out.push('contract_creation');
  if (e.type === '1' || e.accessList?.length) out.push('access_list_context_unsupported');
  if (e.type === '3') out.push('blob_context_unsupported');
  if (e.type === '4') out.push('authorization_context_unsupported');
  if (!['0', '1', '2', '3', '4'].includes(e.type)) out.push('unknown_transaction_type');
  if (Object.keys(e.extensions).length) out.push('unrecognized_envelope_fields');
  if (BigInt(e.gas) > BigInt(CENSUS_LIMITS.simulationGas)) out.push('original_gas_limit_exceeds_profile');
  if ((e.input.length - 2) / 2 > CENSUS_LIMITS.simulationCalldataBytes) out.push('calldata_exceeds_profile');
  if ([e.from, e.to].includes('0x000000000000000000000000000000000000ba1a')) out.push('reserved_profile_witness_address');
  return out;
}
const rows = s.census.envelopes.map(row => {
  const e = row.normalizedEnvelope, isSelected = selected.has(row.transactionHash), unsupported = reasons(e);
  increment(types, e.type); if (isSelected) increment(selectedTypes, e.type);
  for (const key of Object.keys(e.extensions)) { increment(ext, key); if (isSelected) increment(selectedExt, key); }
  for (const reason of unsupported) increment(reasonCounts, reason);
  return { transactionHash: row.transactionHash, blockNumber: row.blockNumber, transactionIndex: row.transactionIndex, type: e.type, selected: isSelected,
    reasons: unsupported, calldataBytes: (e.input.length - 2) / 2, otherReasons: unsupported.filter(reason => reason !== 'unrecognized_envelope_fields') };
});
assert.deepEqual(rows.filter(row => row.selected), audit.selectedRows);
assert.deepEqual(rows.filter(row => row.otherReasons.length), audit.additionalBlockerRows);
assert.deepEqual(reasonCounts, audit.population.reasonOccurrencesAll);
assert.deepEqual(types, audit.population.transactionTypes); assert.deepEqual(selectedTypes, audit.population.selectedTransactionTypes);
assert.deepEqual(ext, { blockTimestamp: 436 }); assert.deepEqual(selectedExt, { blockTimestamp: 16 });
assert.equal(rows.length, 436); assert.equal(selected.size, 16);
assert.equal(rows.filter(row => row.otherReasons.length === 0).length, 420);
assert.equal(rows.filter(row => row.otherReasons.length).length, 16);
for (const observation of s.artifacts.observations) {
  let all = 0, chosen = 0;
  for (const number of s.census.targetBlockNumbers) {
    const header = observation.headers.find(row => BigInt(row.number).toString() === number);
    assert.equal(verifyEthereumHeader({ header, expectedHash: header.hash }).status, 'verified');
    for (const [index, tx] of header.transactions.entries()) {
      const envelope = s.census.envelopes.find(row => row.transactionHash === tx.hash);
      assert.deepEqual(envelope.providerEnvelopes.find(row => row.provider === observation.provider).envelope, tx);
      assert.equal(envelope.blockHash, header.hash); assert.equal(envelope.transactionIndex, String(index));
      assert.deepEqual(Object.keys(tx).filter(key => !known.has(key)), ['blockTimestamp']);
      assert.match(tx.blockTimestamp, /^0x(?:0|[1-9a-f][0-9a-f]*)$/);
      assert.ok(BigInt(tx.blockTimestamp) < 1n << 64n);
      assert.equal(BigInt(tx.blockTimestamp), BigInt(header.timestamp)); assert.equal(tx.blockTimestamp, header.timestamp);
      all++; if (selected.has(tx.hash)) chosen++;
    }
  }
  assert.equal(all, 436); assert.equal(chosen, 16);
}
// Deliberately post-inspection validation. These admissions are not executions.
const normalizerPath = resolve(ROOT, development.basis.normalizerPath);
const normalizerBytes = await readFile(normalizerPath);
assert.equal(sha(normalizerBytes), development.basis.normalizerSha256);
const { validateCohortCensus } = await import(pathToFileURL(normalizerPath));
const d = s.artifacts.anchorDeclaration;
const current = validateCohortCensus({ chainId: 1, anchor: d.anchor, targetBlockNumbers: d.targetBlockNumbers, anchorObservedAt: d.anchorObservedAt, seed: d.seed, sampleSize: d.sampleSize, observations: s.artifacts.observations });
assert.deepEqual(current.census, s.census.census); assert.deepEqual(current.selection, s.census.selection);
assert.deepEqual(current.envelopes.map(row => row.providerEnvelopes), s.census.envelopes.map(row => row.providerEnvelopes));
for (let i = 0; i < current.envelopes.length; i++) {
  const expected = structuredClone(s.census.envelopes[i].normalizedEnvelope); delete expected.extensions.blockTimestamp;
  assert.deepEqual(current.envelopes[i].normalizedEnvelope, expected);
}
assert.equal(current.selected.filter(row => row.projection.status === 'projectable').length, 15);
assert.deepEqual(current.selected.filter(row => row.projection.status === 'unsupported').map(row => row.projection.reasons), [['original_gas_limit_exceeds_profile']]);
assert.deepEqual(await readFile(normalizerPath), normalizerBytes);
console.log(JSON.stringify({ status: 'verified', N: 436, S: 16, timestampHeaderMatches: 872, otherUnknownFields: [], frozenSelectedUnsupported: 16,
  timestampOnlyPopulationRows: 420, populationRowsWithOtherBlockers: 16, developmentSelectedProjectable: 15, developmentSelectedUnsupported: 1,
  executionsOrNetworkRequests: 0, originalPacketChanged: false }, null, 2));
