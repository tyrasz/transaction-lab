// Fixed input derivation only. Saved results, account state, RPC and execution
// never enter this module; header freshness/canonicality belongs to the runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { validateLocalSimulation } from '../../src/local-simulation.js';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => structuredClone(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PACKET = 'reports/ordinary-local-coverage-v1';
export const CHANNELS = freeze(['executionStatus', 'returnData', 'committedLogs', 'gasAccounting', 'fullObservedStateChanges']);
export const CURRENT_DENOMINATOR = freeze({ cases: 2, originalPositions: 2, originalChannels: 10, queriesCompared: 0 });
export const TEMPLATE_FILES = freeze([
  { path: `${PACKET}/cases/002/request.json`, bytes: 37521, sha256: '66b4909067567609c99d0efb587eab287457d2322a1fabf0a16f2c7668c771a9', originalCaseId: '002' },
  { path: `${PACKET}/cases/015/request.json`, bytes: 41429, sha256: '91fc4f5e9617921b062a01d16166a877425bd06d265a5a061f25ef34073f2287', originalCaseId: '015' },
]);
export const PROVENANCE_FILES = freeze([
  { path: `${PACKET}/evidence-manifest.json`, bytes: 77853, sha256: 'd1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40' },
  { path: `${PACKET}/plan.json`, bytes: 142557, sha256: '93c819d0c3c00b64c6cf502c28efcae5c54efa02ffccf4341106e62c7b0045b5' },
]);
const FIXED = freeze([
  { id: 'delegated-usdt-002', transactionHash: '0x31cac6ebe975a4ca6666adf9b107fdb291af2cbeecbcf838397034e60daa03b8' },
  { id: 'delegated-usdt-015', transactionHash: '0xcb13cd67f13e57c3cd944c4ede2d9368a7e48c3a6a4aae8179f730c3a2c40314' },
]);

function record(value, keys) {
  assert(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'A plain exact declaration argument record is required.');
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), 'Declaration fields are missing or unsupported.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'Declaration accessors or hidden fields are unsupported.');
  }
}
function pinnedBytes(bytes, row) {
  assert(!types.isProxy(bytes) && (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array), 'Template must be exact byte data.');
  assert.equal(bytes.byteLength, row.bytes, 'Immutable input byte length differs.');
  // Copy before hashing/parsing so the derived value uses the checked bytes.
  const stable = Buffer.from(bytes);
  assert.equal(sha256(stable), row.sha256, 'Immutable input bytes differ.');
  return stable;
}
function verifyHeader(header) {
  assert(header && typeof header === 'object' && !types.isProxy(header) && !Array.isArray(header)
    && [Object.prototype, null].includes(Object.getPrototypeOf(header)), 'A plain selected header is required.');
  const hash = Object.getOwnPropertyDescriptor(header, 'hash');
  assert(hash && Object.hasOwn(hash, 'value'), 'Selected header hash accessors are unsupported.');
  return verifyEthereumHeader({ header, expectedHash: hash.value, chainId: 1 });
}
function regularPinnedBytes(root, row) {
  let current = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const rootStat = lstatSync(current);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Input root must be a real directory.');
  const parts = row.path.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Input ancestors must be real directories.');
  }
  const filename = join(current, parts.at(-1)), stat = lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === row.bytes, 'Pinned input file type or size differs.');
  return pinnedBytes(readFileSync(filename), row);
}

/** root is the repository/archived-runtime root, not the historical packet. */
export function originalTemplateBytes(root) {
  const [manifestBytes, planBytes] = PROVENANCE_FILES.map(row => regularPinnedBytes(root, row));
  const manifest = JSON.parse(manifestBytes), plan = JSON.parse(planBytes);
  assert.equal(manifest.planSha256, PROVENANCE_FILES[1].sha256, 'Historical plan pin differs.');
  assert.equal(plan.policy.chainId, 1, 'Historical plan chain differs.');
  const rows = new Map(manifest.files.map(row => [row.path, row]));
  assert.equal(rows.size, manifest.files.length, 'Historical manifest contains duplicate paths.');
  for (const row of [...TEMPLATE_FILES, PROVENANCE_FILES[1]]) {
    const path = row.path.slice(PACKET.length + 1);
    assert.deepEqual(rows.get(path), { path, bytes: row.bytes, sha256: row.sha256 }, 'Historical manifest input binding differs.');
  }
  const templateBytes = TEMPLATE_FILES.map(row => regularPinnedBytes(root, row));
  readTemplates(templateBytes);
  return templateBytes;
}

/** Hash-pinned raw request records. No historical execution result is read. */
export function readTemplates(templateBytes) {
  assert(!types.isProxy(templateBytes) && Array.isArray(templateBytes) && Object.getPrototypeOf(templateBytes) === Array.prototype
    && templateBytes.length === 2, 'Exactly two immutable templates are required.');
  assert.deepEqual(Reflect.ownKeys(templateBytes).sort(), ['0', '1', 'length'], 'Template list must be dense without extra fields.');
  for (let i = 0; i < 2; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(templateBytes, String(i));
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'Template list accessors are unsupported.');
  }
  return templateBytes.map((raw, index) => {
    const source = JSON.parse(pinnedBytes(raw, TEMPLATE_FILES[index])), projection = source.projection;
    assert.equal(source.transactionHash, FIXED[index].transactionHash);
    assert.equal(projection.transactionHash, FIXED[index].transactionHash);
    assert.equal(projection.status, 'projectable');
    assert.deepEqual(projection.reasons, []);
    assert.deepEqual(source.parentHeader, projection.parentHeader, 'Historical header copies differ.');
    verifyHeader(source.parentHeader);
    record(projection.request, ['from', 'to', 'data', 'value', 'gas', 'accessList']);
    assert.equal(projection.request.to, '0xdac17f958d2ee523a2206206994597c13d831ec7');
    assert.match(projection.request.data, /^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/);
    assert.equal(projection.request.value, '0');
    assert.equal(projection.request.gas, '5000000');
    assert.deepEqual(projection.request.accessList, []);
    assert.equal(projection.simulationGas, '5000000');
    assert.equal(projection.profile, 'local_kernel_unsigned_unpriced_parent_block_end');
    assert.equal(projection.originalTransactionReplay, false);
    assert.equal(projection.signatureVerified, false);
    assert.equal(projection.feeSettlement, false);
    return source;
  });
}

function oneCase(source, index, header) {
  const headerVerification = verifyHeader(header);
  const request = copy(source.projection.request), recipient = '0x' + request.data.slice(34, 74);
  const accounts = [request.from, recipient];
  const localInput = { chainId: 1, ...copy(request), block: header.hash,
    queries: accounts.map(account => ({ to: request.to, data: '0x70a08231' + account.slice(2).padStart(64, '0') })) };
  assert.deepEqual(validateLocalSimulation(copy(localInput)), localInput, 'Local API normalization changes the fixed request.');
  return {
    id: FIXED[index].id, originalCaseId: TEMPLATE_FILES[index].originalCaseId, transactionHash: FIXED[index].transactionHash,
    request, localInput, header: copy(header), headerVerification: copy(headerVerification),
    historicalProvenance: { requestFile: copy(TEMPLATE_FILES[index]), parentHeader: copy(source.parentHeader),
      originalGasLimit: source.projection.originalGasLimit, projectionProfile: source.projection.profile,
      sourceTransactionHash: source.transactionHash, originalTransactionReplay: false,
      sourceFiles: copy(PROVENANCE_FILES), historicalResultsUsedAsExecutionState: false },
    queryRoles: accounts.map((account, queryIndex) => ({ index: queryIndex, role: queryIndex === 0 ? 'sender_usdt_balance' : 'recipient_usdt_balance',
      account, token: request.to, compared: false })),
  };
}
function bundle(sources, headers, mode) {
  return { schemaVersion: '1.0', kind: 'delegated_sender_current_declarations', chainId: 1, mode,
    profile: 'unsigned_unpriced_block_end', denominator: copy(CURRENT_DENOMINATOR), channels: copy(CHANNELS),
    templateFiles: copy(TEMPLATE_FILES), provenanceFiles: copy(PROVENANCE_FILES),
    cases: sources.map((source, index) => oneCase(source, index, headers[index])),
    scope: { targetExecutionPerformedHere: false, currentStateProvidedHere: false, headerFreshnessVerifiedHere: false,
      canonicalityVerifiedHere: false, consensusVerified: false, originalTransactionReplay: false,
      historicalResultsUsedAsExecutionState: false, historicalPacketRepaired: false,
      priorObservationsInformedInputSelection: true, representativeAccuracyClaimed: false,
      explicitLocalQueriesCompared: false, fixedOriginalChannels: 10 } };
}

/** Input-only preparation, each fixed case retaining its own historical header. */
export function deriveTemplates(options) {
  record(options, ['templateBytes']);
  const sources = readTemplates(options.templateBytes);
  return bundle(sources, sources.map(source => source.parentHeader), 'historical_headers_preparation_only');
}

/** The caller must independently bind selection, freshness and canonicality. */
export function deriveDeclarations(options) {
  record(options, ['templateBytes', 'header']);
  const sources = readTemplates(options.templateBytes), header = options.header;
  verifyHeader(header);
  return bundle(sources, [header, header], 'shared_selected_header');
}

export function validateDeclarations(options) {
  record(options, ['declarations', 'templateBytes', 'header']);
  const expected = deriveDeclarations({ templateBytes: options.templateBytes, header: options.header });
  assert.deepEqual(options.declarations, expected, 'Declarations differ from the fixed inputs and selected header.');
  return expected;
}
