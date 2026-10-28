// Post-seal independent audit. No original capture or product source is edited.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAN = '82edf8c8f06d33180ac109f61ed9247da6b596a5c618b9c2fa7ea16937fd1f86';
export const MANIFEST = '299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3';
const SELECTION = 'c801066845304423c82b15ea8de07f991f40b5a1749b3f9b82aa8a337dcd7de5';
const audit = path.dirname(fileURLToPath(import.meta.url));
export const capture = path.resolve(audit, '../evm-lifecycle-differential-v1/capture-v2');
const runtime = path.join(capture, 'runtime');
const sha = raw => createHash('sha256').update(raw).digest('hex');
const read = relative => fs.readFileSync(path.join(capture, relative));
const json = relative => JSON.parse(read(relative));
const serial = value => JSON.stringify(value);
const asBig = value => value === '0x' ? 0n : BigInt(value);
const word = value => '0x' + asBig(value).toString(16).padStart(64, '0');
const indices = Array.from({ length: 16 }, (_, i) => i + 1);
const name = index => 'results/' + String(index).padStart(3, '0');
const importArchive = relative => import(pathToFileURL(path.join(runtime, relative)).href);
const safePath = value => { assert.equal(typeof value, 'string'); assert(value.length && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').some(s => ['', '.', '..'].includes(s))); return value; };
function walk(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return walk(path.join(root, entry.name), relative + '/');
    assert(entry.isFile() || entry.isSymbolicLink()); return [relative];
  }).sort();
}
function boundFile(root, row) {
  const file = path.join(root, safePath(row.path)), stat = fs.lstatSync(file);
  assert(stat.isFile()); const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, row.bytes, row.path); assert.equal(sha(bytes), row.sha256, row.path);
  if (row.mode !== undefined) assert.equal(stat.mode & 0o777, row.mode, row.path);
  return bytes;
}
export function validateManifestShape(plan, manifest) {
  assert.equal(manifest.planSha256, PLAN);
  const expected = ['plan.json', 'FROZEN.json', 'STARTED.json', 'results.json', ...plan.inputs.map(r => r.path), ...plan.cases.map(r => r.path),
    ...indices.flatMap(i => ['-product.json', '-PRODUCT_SEALED.json', '-reference.json', '-comparison.json'].map(s => name(i) + s))].sort();
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(manifest.files.map(r => safePath(r.path)).sort(), expected);
  assert.equal(new Set(manifest.files.map(r => r.path)).size, manifest.files.length);
}
export function validateSeal(row, bytes, seal) {
  assert.deepEqual(seal, { caseIndex: row.index, caseId: row.id, productPath: String(row.index).padStart(3, '0') + '-product.json',
    productSha256: sha(bytes), productBytes: bytes.length, planSha256: PLAN });
}
export function validateReference(reference, declaration) {
  assert.equal(reference.status, 'completed'); assert.equal(reference.reason, null);
  assert.equal(reference.exitCode, 0); assert.equal(reference.signal, null); assert.equal(reference.stderr, '');
  assert.deepEqual(JSON.parse(reference.stdout), reference.result);
  assert.equal(reference.result.status, 'completed');
  assert.equal(reference.result.output.serializedTransaction, declaration.serializedTransaction);
  assert.deepEqual(reference.result.scope, { synthetic: true, fullVmSignedTransaction: true, zeroGasPrice: true, zeroBaseFee: true,
    fullMptFinalization: true, sharedOpcodeLibrary: true, originalOfficialExpectedPostUsed: false });
}
export function validateProofJoins(product, declaration) {
  const a = product.attempt, records = product.proofRecords;
  assert.equal(product.publicRequests, 0); assert.equal(a.status, 'completed'); assert.equal(a.error, null);
  assert.equal(a.broker.pendingAtReturn, 0); assert.equal(a.broker.rawWireCaptured, false);
  assert.equal(a.broker.calls, records.length); assert.equal(a.broker.dispatches, records.length);
  assert.equal(a.inputUsage.calls, records.length); assert.equal(a.inputEvidence.length, records.length); assert.equal(a.broker.records.length, records.length);
  assert(records.length <= 256);
  let bytes = 0;
  for (const [index, record] of records.entries()) {
    const evidence = a.inputEvidence[index], broker = a.broker.records[index];
    assert.equal(record.id, index + 1); assert.equal(record.status, 'received');
    assert.equal(record.representation, 'parsed_in_memory_proof_result_no_network_wire');
    assert(['eth_getProof', 'eth_getCode'].includes(record.request.method));
    assert.deepEqual(record.request.params.at(-1), { blockHash: declaration.header.hash, requireCanonical: true });
    assert.equal(record.request.params.length, record.request.method === 'eth_getProof' ? 3 : 2);
    const encoded = serial(record.result), size = Buffer.byteLength(encoded), hash = sha(encoded);
    assert.equal(record.bytes, size); assert(size <= 8 * 1024 * 1024); bytes += size;
    for (const linked of [evidence, broker]) {
      assert.equal(linked.id, record.id); assert.equal(linked.status, 'received');
      assert.deepEqual(linked.request, record.request); assert.equal(linked.resultBytes, size); assert.equal(linked.resultSha256, hash);
    }
    assert.equal(broker.dispatched, true); assert.deepEqual(evidence.result, record.result);
    assert.equal(evidence.requestText, serial(record.request)); assert.equal(evidence.requestSha256, sha(evidence.requestText));
  }
  assert(bytes <= 32 * 1024 * 1024); assert.equal(a.broker.accountedParsedResultBytes, bytes);
  assert.equal(a.inputUsage.observedResultBytes, bytes); assert.equal(a.inputUsage.retainedResultBytes, bytes);
  return bytes;
}
export function replayRpc(records) {
  let cursor = 0, failure = null;
  return { rpc: { async call(method, params) {
    try {
      const record = records[cursor++]; assert(record, 'Unexpected additional input read');
      assert.deepEqual({ method, params }, record.request, 'Proof input order or identity changed');
      assert.equal(record.status, 'received'); return structuredClone(record.result);
    } catch (error) { failure ??= error; throw error; }
  } }, assertComplete() { if (failure) throw failure; assert.equal(cursor, records.length, 'Unused saved proof inputs'); } };
}
export function normalizeAttempt(attempt) {
  const value = structuredClone(attempt);
  const duration = (object, key) => { assert.equal(typeof object[key], 'number'); assert(Number.isFinite(object[key]) && object[key] >= 0); delete object[key]; };
  assert(Number.isInteger(value.isolation.childPid) && value.isolation.childPid > 0); delete value.isolation.childPid;
  duration(value.isolation, 'durationMs');
  for (const item of [...value.inputEvidence, ...value.broker.records]) duration(item, 'durationMs');
  assert(value.isolation.wallMs > 0 && value.isolation.wallMs <= 10000);
  // All limit values remain exact: replay uses the captured normalized limits.
  return value;
}
export function independentGas(declaration, output) {
  const bytes = Buffer.from(declaration.request.data.slice(2), 'hex');
  const zero = BigInt(bytes.filter(byte => byte === 0).length), nonzero = BigInt(bytes.length) - zero;
  const creation = declaration.request.to === null;
  const intrinsic = 21000n + 4n * zero + 16n * nonzero + (creation ? 32000n + 2n * ((BigInt(bytes.length) + 31n) / 32n) : 0n);
  const floor = 21000n + 10n * (zero + 4n * nonzero), message = BigInt(output.execution.executionGasUsed), refund = BigInt(output.execution.gasRefundCounter);
  assert(message >= 0n && refund >= 0n && message <= BigInt(declaration.request.gas) - intrinsic);
  const beforeRefund = intrinsic + message, appliedRefund = refund < beforeRefund / 5n ? refund : beforeRefund / 5n;
  const floorAdjustment = floor > beforeRefund - appliedRefund ? floor - beforeRefund + appliedRefund : 0n;
  const result = Object.fromEntries(Object.entries({ beforeRefund, appliedRefund, floorAdjustment, gasUsed: beforeRefund - appliedRefund + floorAdjustment }).map(([key, value]) => [key, value.toString()]));
  assert.deepEqual(output.gasAccounting, result); assert.equal(output.profile.intrinsicGas, intrinsic.toString());
  assert.equal(output.profile.calldataFloor, floor.toString()); return result.gasUsed;
}
async function applyChangesIndependently(declaration, attempt, observed, deps) {
  const { loadState, common, util } = deps, state = await loadState(declaration.pre, common());
  assert.equal(util.bytesToHex(await state.getStateRoot()), declaration.initialStateRoot);
  const seen = new Set();
  for (const row of attempt.changes.accounts) {
    assert(!seen.has(row.address)); seen.add(row.address);
    const address = util.createAddressFromString(row.address), prior = await state.getAccount(address);
    if (row.existence) assert.equal(!!prior, row.existence.before);
    for (const field of ['nonce', 'balance']) if (row[field]) assert.equal(prior?.[field] ?? 0n, asBig(row[field].before));
    if (row.code) assert.equal(util.bytesToHex(await state.getCode(address)), row.code.before);
    for (const slot of row.storage ?? []) assert.equal(asBig(util.bytesToHex(await state.getStorage(address, util.hexToBytes(slot.slot)))), asBig(slot.before));
    if (row.existence?.after === false) {
      assert(prior); assert.equal(row.existence.basis, 'same_invocation_created_contract_deletion'); await state.deleteAccount(address);
    } else {
      if (!prior) { assert.equal(row.existence?.after, true); await state.putAccount(address, util.createAccount({ nonce: 0n, balance: 0n })); }
      for (const field of ['nonce', 'balance']) if (row[field]) await state.modifyAccountFields(address, { [field]: asBig(row[field].after) });
      if (row.code) await state.putCode(address, util.hexToBytes(row.code.after));
      for (const slot of row.storage ?? []) await state.putStorage(address, util.hexToBytes(slot.slot), util.bigIntToBytes(asBig(slot.after)));
    }
  }
  const actual = [], addresses = new Set();
  for (const row of observed) {
    assert(!addresses.has(row.address)); addresses.add(row.address);
    const address = util.createAddressFromString(row.address), account = await state.getAccount(address), storage = [], slots = new Set();
    for (const entry of row.storage) { assert(!slots.has(entry.slot)); slots.add(entry.slot); storage.push({ slot: entry.slot, value: word(util.bytesToHex(await state.getStorage(address, util.hexToBytes(entry.slot)))) }); }
    actual.push({ address: row.address, exists: !!account, nonce: (account?.nonce ?? 0n).toString(), balance: (account?.balance ?? 0n).toString(),
      code: account ? util.bytesToHex(await state.getCode(address)) : '0x', storageRoot: account ? util.bytesToHex(account.storageRoot) : null, storage });
  }
  return { stateRoot: util.bytesToHex(await state.getStateRoot()), observedState: actual };
}
export async function verify({ replay = false } = {}) {
  const rawPlan = read('plan.json'); assert.equal(sha(rawPlan), PLAN); const plan = JSON.parse(rawPlan);
  const rawManifest = read('manifest.json'); assert.equal(sha(rawManifest), MANIFEST); const manifest = JSON.parse(rawManifest);
  validateManifestShape(plan, manifest);
  assert.deepEqual(walk(capture).filter(p => !p.startsWith('runtime/') && p !== 'manifest.json'), manifest.files.map(r => r.path).sort());
  for (const row of manifest.files) boundFile(capture, row);
  assert.equal(plan.sources.length, 3879); assert.equal(sha(serial(plan.sources)), plan.sourceInventorySha256);
  assert.deepEqual(walk(runtime), plan.sources.map(r => r.path).sort());
  for (const row of plan.sources) {
    if (row.kind === 'file') boundFile(runtime, row);
    else {
      assert.equal(row.kind, 'symlink'); const file = path.join(runtime, safePath(row.path)); assert(fs.lstatSync(file).isSymbolicLink());
      assert.equal(fs.readlinkSync(file), row.target); assert(!path.isAbsolute(row.target));
      const target = path.resolve(path.dirname(file), row.target); assert(target.startsWith(runtime + path.sep));
      assert(fs.lstatSync(target).isFile()); assert(plan.sources.some(r => r.kind === 'file' && path.join(runtime, r.path) === target));
    }
  }
  assert.deepEqual(json('FROZEN.json'), { planSha256: PLAN, sourceInventorySha256: plan.sourceInventorySha256, cases: 16 });
  const { verifyNodeRuntime } = await importArchive('research/standard-evm/cohort-freeze.mjs'); await verifyNodeRuntime(plan.node);
  const started = json('STARTED.json'), summary = json('results.json');
  assert.equal(started.planSha256, PLAN); assert.equal(started.sourceInventorySha256, plan.sourceInventorySha256); assert.equal(started.caseCount, 16); assert.equal(started.publicRequests, 0);
  assert.equal(summary.planSha256, PLAN); assert.equal(summary.sourceUnchanged, true); assert.equal(summary.fatal, null); assert.equal(summary.validForDifferential, true);
  assert.equal(summary.officialReplay, false); assert.equal(summary.publicRequests, 0); assert.equal(summary.sharedOpcodeLibrary, true); assert.equal(summary.productAccuracyRate, false);
  assert.deepEqual(plan.cases.map(r => r.index), indices); assert.deepEqual(summary.rows.map(r => r.index), indices);
  const selectionBytes = read('inputs/official/selection.json'); assert.equal(sha(selectionBytes), SELECTION); const selection = JSON.parse(selectionBytes);
  assert.deepEqual(plan.cases.map(r => r.id), selection.selected.map(r => r.id));
  const harness = await importArchive('research/evm-lifecycle-differential-v1/runtime.mjs');
  const { dispatchReference } = await importArchive('research/evm-lifecycle-differential-v1/run.mjs');
  const { executeIsolatedEthereumCall } = await importArchive('engines/local-evm/isolated-call.js');
  const { verifyStateProof } = await importArchive('engines/local-evm/verified-state-proof.js');
  const { Common, Mainnet, Hardfork } = await importArchive('engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js');
  const util = await importArchive('engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js');
  const { loadState } = await importArchive('engines/fixture-evm/state-test.js');
  const deps = { util, loadState, common: () => new Common({ chain: Mainnet, hardfork: Hardfork.Osaka }) };
  const report = { schemaVersion: 1, verifiedAt: new Date().toISOString(), planSha256: PLAN, captureManifestSha256: MANIFEST, sourceInventorySha256: plan.sourceInventorySha256,
    sourceFiles: plan.sources.length, evidenceFiles: manifest.files.length, declaredCases: 16, proofCodeReads: 0, proofCodeResultBytes: 0, merkleProofs: 0, committedLogs: 0,
    finalizedDeletions: 0, executionCounts: {}, comparisonCounts: { matched: 0, mismatched: 0, unavailable: 0, not_attempted: 0 }, replayedProductCases: [], replayedReferenceCases: [], rows: [],
    limits: { replayBudgetMs: 360000, eachReferenceMs: 10000, productLimits: 'Exact recorded normalized per-case limits' },
    normalization: ['isolation.childPid', 'isolation.durationMs', 'inputEvidence[].durationMs', 'broker.records[].durationMs'],
    limitations: ['Fixed selected synthetic zero-price/zero-base-fee Osaka counterparts; not original official signed replays or a population accuracy estimate.',
      'Both paths share pinned EthereumJS opcode execution; independent work here checks evidence joins, reexecution and sparse-versus-full-MPT state application.',
      'Saved seals and reviewed program order support product-before-reference ordering; local hashes do not independently timestamp or authenticate chronology.',
      'Proof inputs are parsed in-memory synthetic MPT responses, not public provider wire observations. No public RPC is used.',
      'No OS network/filesystem sandbox, hard total RSS bound, consensus, fees, sidecar/KZG or undeclared-fork claim.'] };
  const begin = performance.now();
  for (const row of plan.cases) {
    const official = selection.selected[row.index - 1], fixtureBytes = read('inputs/official/' + official.file);
    assert.equal(sha(fixtureBytes), official.fileSha256); const fixture = JSON.parse(fixtureBytes)[official.id]; assert.equal(fixture._info.hash, official.fixtureHash);
    const declaration = json(row.path);
    assert.deepEqual(declaration, await harness.declareFixture(fixture, { index: official.index, id: official.id, category: official.category, postIndex: official.postIndex,
      officialFixtureHash: official.fixtureHash, officialFileSha256: official.fileSha256 }));
    assert.equal(declaration.transformations.originalExpectedOutputsUsed, false);
    const prefix = name(row.index), productBytes = read(prefix + '-product.json'), product = JSON.parse(productBytes), seal = json(prefix + '-PRODUCT_SEALED.json');
    validateSeal(row, productBytes, seal); const reference = json(prefix + '-reference.json'), comparison = json(prefix + '-comparison.json');
    validateReference(reference, declaration); report.proofCodeResultBytes += validateProofJoins(product, declaration); report.proofCodeReads += product.proofRecords.length;
    const recreated = await harness.proofSource(declaration);
    for (const record of product.proofRecords) {
      const { method, params } = record.request; assert.deepEqual(await recreated.rpc.call(method, params), record.result);
      if (method === 'eth_getProof') { await verifyStateProof({ stateRoot: declaration.initialStateRoot, address: params[0], storageKeys: params[1], proof: record.result }); report.merkleProofs++; }
    }
    await recreated.assertUnchanged(); recreated.close(); assert.deepEqual(recreated.records, product.proofRecords);
    const applied = await applyChangesIndependently(declaration, product.attempt, reference.result.observedState, deps), output = product.attempt.output;
    const same = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
    const independentChecks = { execution: output.execution.status === reference.result.output.execution,
      returnData: output.execution.returnData === reference.result.output.returnData,
      logs: same(output.logs.map(({ address, topics, data }) => ({ address, topics, data })), reference.result.output.logs),
      gas: independentGas(declaration, output) === reference.result.output.gasUsed,
      stateRoot: applied.stateRoot === reference.result.output.stateRoot && same(applied.observedState, reference.result.observedState) };
    assert.deepEqual(independentChecks, comparison.checks);
    assert.equal(comparison.status, Object.values(independentChecks).every(Boolean) ? 'matched' : 'mismatched');
    assert.deepEqual(await harness.compare(declaration, product.attempt, reference.result), comparison);
    assert.deepEqual(summary.rows[row.index - 1], { index: row.index, id: row.id, category: row.category, status: comparison.status,
      productStatus: product.attempt.status, execution: output.execution.status, referenceStatus: reference.status, checks: comparison.checks,
      productSha256: sha(productBytes), productSealSha256: sha(read(prefix + '-PRODUCT_SEALED.json')) });
    report.executionCounts[output.execution.status] = (report.executionCounts[output.execution.status] ?? 0) + 1;
    report.comparisonCounts[comparison.status]++; report.committedLogs += output.logs.length; report.finalizedDeletions += output.lifecycle?.finalizedDeletions?.length ?? 0;
    if (replay) {
      assert(performance.now() - begin < 360000); const saved = replayRpc(product.proofRecords);
      const actual = await executeIsolatedEthereumCall({ request: declaration.request, header: declaration.header, rpc: saved.rpc, limits: product.attempt.isolation.limits });
      saved.assertComplete(); assert.deepEqual(normalizeAttempt(actual), normalizeAttempt(product.attempt), 'Archived product differs at case ' + row.index); report.replayedProductCases.push(row.index);
      assert(performance.now() - begin < 360000);
      const rerun = await dispatchReference({ file: path.join(capture, row.path), expectedSha256: row.sha256, timeoutMs: Math.min(10000, 360000 - (performance.now() - begin)) });
      assert.deepEqual(rerun, reference, 'Archived full-VM reference differs at case ' + row.index); report.replayedReferenceCases.push(row.index);
    }
    report.rows.push({ index: row.index, id: row.id, category: row.category, execution: output.execution.status, checks: independentChecks,
      initialStateRoot: declaration.initialStateRoot, finalStateRoot: applied.stateRoot, gasUsed: output.gasAccounting.gasUsed, proofCodeReads: product.proofRecords.length });
  }
  assert.deepEqual(summary.counts, { selected: 16, ...report.comparisonCounts });
  // Recheck every captured byte after replay; audit writes live in a sibling.
  for (const row of manifest.files) boundFile(capture, row);
  for (const row of plan.sources.filter(r => r.kind === 'file')) boundFile(runtime, row);
  return report;
}
function auditManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(audit, 'manifest.json')));
  assert.equal(manifest.planSha256, PLAN); assert.equal(manifest.captureManifestSha256, MANIFEST);
  assert.deepEqual(manifest.files.map(r => r.path).sort(), ['NOTES.md', 'verification.json', 'verify.mjs', 'verify.test.mjs']);
  for (const row of manifest.files) boundFile(audit, row); return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--record')) {
    assert(!fs.existsSync(path.join(audit, 'manifest.json')));
    const report = await verify({ replay: true });
    fs.writeFileSync(path.join(audit, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    const files = ['NOTES.md', 'verification.json', 'verify.mjs', 'verify.test.mjs'].map(relative => { const bytes = fs.readFileSync(path.join(audit, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; });
    fs.writeFileSync(path.join(audit, 'manifest.json'), JSON.stringify({ schemaVersion: 1, planSha256: PLAN, captureManifestSha256: MANIFEST, files }, null, 2) + '\n', { flag: 'wx' });
    auditManifest(); console.log(JSON.stringify({ counts: report.comparisonCounts, replayedProducts: report.replayedProductCases.length, replayedReferences: report.replayedReferenceCases.length, auditManifestSha256: sha(fs.readFileSync(path.join(audit, 'manifest.json'))) }));
  } else {
    auditManifest(); const result = await verify({ replay: process.argv.includes('--replay') });
    console.log(JSON.stringify(result, null, 2));
  }
}
