import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, readlink } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url)), PACKET = resolve(HERE, '..');
const MANIFEST = '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5';
const PLAN = 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const own = (value, key) => Object.hasOwn(value, key);
const withoutTiming = rows => rows.map(({ durationMs, ...rest }) => rest);
let networkAttempts = 0;
const forbidden = () => { networkAttempts++; throw Error('Offline audit forbids network access'); };
globalThis.fetch = forbidden;
net.Socket.prototype.connect = forbidden;

function within(base, path) {
  assert.equal(typeof path, 'string');
  const target = resolve(base, path), rel = relative(base, target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); return target;
}
async function checkEntry(base, entry) {
  const path = within(base, entry.path);
  if (entry.kind === 'symlink') {
    assert.equal(await readlink(path), entry.target);
    const rel = relative(base, resolve(dirname(path), entry.target));
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
  } else {
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, entry.path + ' bytes');
    assert.equal(sha(bytes), entry.sha256, entry.path + ' hash');
  }
}
async function paths(base, prefix = '') {
  const out = [];
  for (const item of await readdir(base, { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) out.push(...await paths(join(base, item.name), path)); else out.push(path);
  }
  return out.sort();
}
function requestBytes(row) {
  assert.equal(row.requestBytes, Buffer.byteLength(row.requestText));
  assert.equal(row.requestSha256, sha(row.requestText));
  assert.deepEqual(row.request, JSON.parse(row.requestText));
  assert.equal(row.request.jsonrpc, '2.0'); assert.equal(row.request.id, row.id);
}
function envelope(text, id) {
  const e = JSON.parse(text);
  assert.equal(e.jsonrpc, '2.0'); assert.equal(e.id, id);
  assert.notEqual(own(e, 'result'), own(e, 'error')); return e;
}
function summary(actual) {
  return { id: actual.id, executionStatus: actual.output.execution.status, executionError: actual.output.execution.error,
    inputStatus: actual.inputs.status, inputFailure: actual.inputs.failure ?? null,
    stateDisposition: actual.output.stateDisposition, calls: actual.inputUsage.calls,
    provenAccounts: actual.inputUsage.accounts, provenSlots: actual.inputUsage.slots,
    proofReadsVerified: actual.inputEvidence.filter(e => e.request.method === 'eth_getProof' && e.verification === 'verified').length,
    codeReadsVerified: actual.inputEvidence.filter(e => e.request.method === 'eth_getCode' && e.verification === 'verified').length,
    gasAccounting: actual.output.gasAccounting, steps: actual.output.usage.steps, frames: actual.output.usage.frames,
    committedLogs: actual.output.logs.length, changedAccounts: actual.changes.accounts.length,
    outputSha256: sha(JSON.stringify(actual.output)), inputsSha256: sha(JSON.stringify(actual.inputs)),
    stateReadsSha256: sha(JSON.stringify(actual.stateReads)), changesSha256: sha(JSON.stringify(actual.changes)) };
}

async function verify() {
  const bytes = await readFile(join(PACKET, 'manifest.json')); assert.equal(sha(bytes), MANIFEST);
  const manifest = JSON.parse(bytes), planBytes = await readFile(join(PACKET, 'plan.json'));
  assert.equal(sha(planBytes), PLAN); assert.equal(manifest.planSha256, PLAN);
  assert.equal(manifest.filesCount, manifest.files.length);
  assert.equal(new Set(manifest.files.map(e => e.path)).size, manifest.files.length);
  // Output files are hashed as opaque bytes, never parsed into initial inputs.
  for (const entry of manifest.files) await checkEntry(PACKET, entry);
  const plan = JSON.parse(planBytes), runtime = join(PACKET, 'runtime');
  assert.equal(process.version, plan.runtime.node); assert.deepEqual(process.versions, plan.runtime.versions);
  assert.equal(process.platform, plan.runtime.platform); assert.equal(process.arch, plan.runtime.arch);
  for (const entry of plan.sourceFiles) await checkEntry(runtime, entry);
  assert.deepEqual(await paths(runtime), plan.sourceFiles.map(e => e.path).sort());
  for (const entry of [...plan.scripts, ...plan.inputFiles]) await checkEntry(PACKET, entry);
  const mod = name => import(pathToFileURL(join(runtime, 'engines/local-evm', name)));
  const [{ verifyEthereumHeader }, { createRpcStateInputs }, { createProofStateManager }, { executeEthereumCall }] =
    await Promise.all(['ethereum-header.js', 'rpc-state-inputs.js', 'proof-state.js', 'ethereum-call.js'].map(mod));
  const original = await json(join(PACKET, 'inputs/deposit-plan.json'));
  assert.deepEqual(plan.cases.map(c => c.id), ['aave-usdc-supply-with-permit', 'morpho-kiln-usdc-deposit']);
  assert.deepEqual(original.cases.map(c => c.id), plan.cases.map(c => c.id));
  assert.equal(plan.chainId, 1); assert.equal(plan.provider.url, 'https://eth.drpc.org');
  const replayed = [], wireSets = [], headers = []; let sharedBytes = 0;

  for (const [i, c] of plan.cases.entries()) {
    const parent = await json(join(PACKET, c.parentInput)), witness = await readFile(join(HERE, `header-bodies/${i}.body`));
    assert.equal(witness.length, parent.raw.bytes); assert.equal(sha(witness), parent.raw.sha256);
    assert.deepEqual(JSON.parse(witness), parent.response);
    assert.equal(parent.response.id, parent.request.body.id); assert.equal(parent.response.jsonrpc, '2.0');
    assert.deepEqual(parent.request.body.params, [c.header.hash, false]);
    assert.equal(parent.request.body.method, 'eth_getBlockByHash');
    assert.deepEqual(parent.response.result, c.header);
    assert.deepEqual(c.request, original.cases[i].request);
    assert.deepEqual(c.apiInput, { chainId: 1, from: c.request.from, to: c.request.to, data: c.request.data, value: BigInt(c.request.value).toString(), block: c.header.hash });
    assert.equal(c.header.hash, original.cases[i].blockHash);
    assert.equal(BigInt(c.header.number).toString(), original.cases[i].blockNumber);
    assert.equal(BigInt(c.header.timestamp).toString(), original.cases[i].parentTimestamp);
    const headerVerification = verifyEthereumHeader({ header: c.header, expectedHash: c.apiInput.block });
    assert.deepEqual(headerVerification, c.headerVerification); headers.push(headerVerification);
    const names = manifest.files.filter(e => new RegExp(`^raw/${c.id}-[0-9]{3}\\.json$`).test(e.path)).map(e => e.path).sort();
    assert.ok(names.length > 0 && names.length <= plan.limits.proofCodeCallsPerAttempt);
    const wires = []; let caseBytes = 0;
    for (const [n, name] of names.entries()) {
      const row = await json(join(PACKET, name)), raw = await readFile(within(PACKET, row.bodyPath));
      assert.equal(row.id, n + 1); requestBytes(row); assert.equal(row.url, plan.provider.url);
      assert.equal(row.bodyPath, name.replace(/\.json$/, '.body'));
      const { method, params } = row.request;
      assert.ok(['eth_getProof', 'eth_getCode'].includes(method)); assert.equal(params.length, method === 'eth_getProof' ? 3 : 2);
      assert.match(params[0], /^0x[0-9a-f]{40}$/);
      assert.deepEqual(params.at(-1), { blockHash: c.header.hash, requireCanonical: true });
      if (method === 'eth_getProof') { assert.ok(Array.isArray(params[1])); for (const key of params[1]) assert.match(key, /^0x[0-9a-f]{64}$/); }
      assert.equal(row.transport.complete, true, 'Partial evidence requires a separately scoped replay');
      assert.equal(raw.length, row.transport.observedBytes); assert.equal(raw.length, row.transport.retainedBytes);
      assert.equal(sha(raw), row.transport.retainedSha256); assert.equal(sha(raw), row.transport.observedSha256);
      assert.equal(row.responseText, new TextDecoder('utf-8', { fatal: true }).decode(raw)); assert.equal(sha(raw), row.responseSha256);
      assert.ok(raw.length <= plan.limits.bodyBytes); assert.equal(row.httpStatus, 200);
      const e = envelope(row.responseText, row.id); if (own(row, 'parsed')) assert.deepEqual(row.parsed, e);
      if (own(e, 'error')) { assert.equal(row.status, 'failed'); assert.equal(row.error, 'rpc_error'); } else assert.equal(row.status, 'completed');
      caseBytes += raw.length; wires.push({ row, envelope: e });
    }
    assert.ok(caseBytes <= plan.limits.localCaseResponseBytes);
    sharedBytes += caseBytes; assert.ok(sharedBytes <= plan.limits.sharedLocalResponseBytes);
    wireSets.push({ case: c, wires, caseBytes, sharedBytes });
  }

  async function execute(c, wires, control = null) {
    let cursor = 0, altered = false;
    const rpc = { async call(method, params) {
      assert.ok(cursor < wires.length, 'Unrecorded initial-state read');
      const { row, envelope: e } = wires[cursor++];
      assert.equal(JSON.stringify({ jsonrpc: '2.0', id: cursor, method, params }), row.requestText, 'Generated RPC differs byte-for-byte');
      if (own(e, 'error')) throw Object.assign(new Error('rpc_error'), { code: 'rpc_error' });
      let value = structuredClone(e.result);
      // Explicit synthetic controls only, after both genuine replays. Mutated
      // values are never repaired and never replace any saved wire/body.
      if (control && cursor === control.id) { altered = true; value = control.change(value); }
      return value;
    } };
    const inputs = createRpcStateInputs({ chainId: 1, blockHash: c.header.hash, header: c.header, rpc,
      limits: { calls: plan.limits.proofCodeCallsPerAttempt, wallMs: plan.limits.attemptMs, requestMs: plan.limits.requestMs, responseBytes: plan.limits.bodyBytes, totalBytes: plan.limits.localCaseResponseBytes } });
    const state = createProofStateManager({ inputs });
    const output = await executeEthereumCall({ request: c.request, header: c.header, stateManager: state, limits: { wallMs: plan.limits.attemptMs } });
    if (!control) assert.equal(cursor, wires.length, 'Unconsumed initial-state records'); else assert.equal(altered, true);
    return { id: c.id, provider: plan.provider, output, harnessError: null, inputs: inputs.snapshotInputs(),
      inputEvidence: withoutTiming(inputs.snapshotEvidence()), inputUsage: inputs.snapshotUsage(), stateReads: state.snapshotReads(),
      changes: state.snapshotChanges(), headerVerification: c.headerVerification, cursor };
  }
  for (const set of wireSets) replayed.push(await execute(set.case, set.wires));

  // Both genuine local executions have now completed. Saved outputs may be
  // parsed only for exact comparison; they cannot influence any initial state.
  const results = [], phase = await json(join(PACKET, 'LOCAL-PHASE-SAVED.json'));
  assert.deepEqual(phase.cases, plan.cases.map(c => c.id)); assert.equal(phase.productRequestsStarted, 0);
  for (const actual of replayed) {
    const saved = await json(join(PACKET, actual.id + '-local.json')), set = wireSets.find(s => s.case.id === actual.id);
    for (const key of ['id', 'provider', 'output', 'harnessError', 'inputs', 'inputUsage', 'stateReads', 'changes', 'headerVerification']) assert.deepEqual(actual[key], saved[key], actual.id + ' ' + key);
    assert.deepEqual(actual.inputEvidence, withoutTiming(saved.inputEvidence));
    assert.deepEqual(saved.transportDenied, []);
    assert.deepEqual(saved.transportUsage, { dispatches: set.wires.length, observedBytes: set.caseBytes, sharedObservedBytes: set.sharedBytes });
    assert.deepEqual(saved.transport, set.wires.map(w => w.row));
    assert.ok(Date.parse(saved.completedAt) <= Date.parse(phase.completedAt));
    results.push({ ...summary(actual), rawResponseBytes: set.caseBytes, reexecution: 'reproduced' });
  }
  const { compareReference } = await import(pathToFileURL(join(PACKET, 'compare.mjs')));
  const savedResults = await json(join(PACKET, 'results.json')); let productCalls = 0, productBytes = 0;
  for (const set of wireSets) {
    const c = set.case, http = await json(join(PACKET, c.id + '-product-http.json'));
    assert.ok(Date.parse(http.startedAt) >= Date.parse(phase.completedAt));
    assert.equal(http.url, plan.api.url); assert.equal(http.requestText, JSON.stringify(c.apiInput));
    assert.equal(http.requestBytes, Buffer.byteLength(http.requestText)); assert.equal(http.requestSha256, sha(http.requestText));
    const body = await readFile(within(PACKET, http.bodyPath));
    assert.equal(body.length, http.transport.retainedBytes); assert.equal(body.length, http.transport.observedBytes);
    assert.equal(sha(body), http.transport.retainedSha256); assert.equal(sha(body), http.transport.observedSha256);
    assert.equal(sha(body), http.responseSha256); assert.equal(body.toString('utf8'), http.responseText);
    assert.equal(http.transport.complete, true); assert.equal(http.status, 'completed'); assert.equal(http.httpStatus, 200);
    const product = JSON.parse(body); assert.deepEqual(product, await json(join(PACKET, c.id + '-product.json')));
    if (own(http, 'parsed')) assert.deepEqual(product, http.parsed);
    let bytes = 0; assert.ok(product.transportEvidence.length <= plan.limits.apiInternalRpcCallsPerCase);
    for (const [i, row] of product.transportEvidence.entries()) {
      assert.equal(row.id, i + 1); requestBytes(row); assert.equal(row.httpStatus, 200);
      assert.equal(row.transport.complete, true); assert.equal(row.transport.bodyRetained, true);
      assert.equal(Buffer.byteLength(row.responseText), row.transport.observedBytes);
      assert.equal(Buffer.byteLength(row.responseText), row.transport.retainedPrefixBytes);
      for (const key of ['responseSha256', 'retainedPrefixSha256', 'observedPrefixSha256']) assert.equal(sha(row.responseText), row.transport[key]);
      assert.ok(row.transport.observedBytes <= plan.limits.bodyBytes); envelope(row.responseText, row.id); bytes += row.transport.observedBytes;
    }
    assert.ok(bytes <= plan.limits.apiInternalResponseBytesPerCase); productCalls += product.transportEvidence.length; productBytes += bytes;
    const actual = replayed.find(a => a.id === c.id), comparison = compareReference(actual, product, c.request, c.header, plan.api.expectedImplementation);
    assert.deepEqual(comparison, savedResults.cases.find(s => s.id === c.id).comparison);
    Object.assign(results.find(r => r.id === c.id), { productRpcCalls: product.transportEvidence.length, productRpcBytes: bytes, savedComparison: comparison.status, savedComparisonChecks: comparison.checks });
  }

  const set = wireSets[0], firstCode = set.wires.find(w => w.row.request.method === 'eth_getCode' && w.envelope.result !== '0x');
  const firstStorage = set.wires.find(w => w.row.request.method === 'eth_getProof' && w.row.request.params[1].length);
  assert.ok(firstCode && firstStorage);
  const controls = [
    { name: 'missing_first_proof', id: 1, change() { throw new Error('Synthetic missing proof response'); } },
    { name: 'changed_contract_code_hash', id: firstCode.row.id, change(value) { return '0x' + (value.slice(2, 4) === '00' ? '01' : '00') + value.slice(4); } },
    { name: 'storage_claim_disagrees_with_proof', id: firstStorage.row.id, change(value) { value.storageProof[0].value = '0x' + (BigInt(value.storageProof[0].value) ^ 1n).toString(16); return value; } },
  ];
  const negativeControls = [];
  for (const control of controls) {
    const actual = await execute(set.case, set.wires, control);
    assert.equal(actual.output.execution.status, 'unavailable'); assert.equal(actual.inputs.status, 'unavailable');
    assert.deepEqual(actual.changes.accounts, []); assert.deepEqual(actual.output.logs, []);
    assert.ok(['unchanged', 'rolled_back'].includes(actual.output.stateDisposition));
    assert.equal(actual.inputs.failure.code, control.name === 'missing_first_proof' ? 'RPC_STATE_INPUT_UNAVAILABLE' : 'RPC_STATE_INPUT_INVALID_PROOF');
    negativeControls.push({ name: control.name, basis: 'synthetic_offline_fault_control_not_a_live_case', caseId: set.case.id,
      alteredResponseId: control.id, executionStatus: actual.output.execution.status, inputFailure: actual.inputs.failure,
      stateDisposition: actual.output.stateDisposition, consumedReads: actual.cursor, committedChanges: 0 });
  }
  const localCalls = wireSets.reduce((n, s) => n + s.wires.length, 0);
  assert.equal(savedResults.localCalls, localCalls); assert.equal(savedResults.localObservedBytes, sharedBytes);
  assert.equal(savedResults.productRpcCalls, productCalls); assert.equal(savedResults.productObservedRpcBytes, productBytes);
  assert.equal(networkAttempts, 0);
  assert.equal(sha(await readFile(join(PACKET, 'manifest.json'))), MANIFEST);
  for (const entry of manifest.files) await checkEntry(PACKET, entry);
  return { schemaVersion: '1.0', status: 'reproduced', supplemental: true, includedInOriginalManifest: false,
    originalPacketManifestSha256: MANIFEST, planSha256: PLAN,
    source: { manifestEntriesVerified: manifest.files.length, frozenRuntimeEntriesVerified: plan.sourceFiles.length, currentRuntimeUsed: false, archivedDependenciesVerified: true, node: process.version },
    headers, localCalls, localResponseBytes: sharedBytes, productCalls, productResponseBytes: productBytes,
    cases: results, negativeControls, networkAttempts,
    normalization: ['Only inputEvidence[*].durationMs is removed from compared local snapshots. Execution outputs, facts, usage, read sets, changes and failure identities compare exactly. Capture start/end timestamps and transport durations are verified as metadata, not recreated latency.'],
    inputSeparation: 'Both genuine local executions finish before parsing saved local/product outputs. Initial state comes only from matching frozen proof/code wires; output files are initially hashed as opaque bytes. Synthetic faults run afterward and never modify source evidence.',
    limitations: ['Two selected development workloads, not a representative cohort or accuracy/security score.', 'This is independent reexecution procedure using the same frozen EVM and proof verifier, not a second independent local implementation.', 'Proof inputs and remote product executions use dRPC; execution-engine independence does not imply provider-infrastructure independence.', 'Header commitments authenticate demanded initial facts but do not verify consensus, finality, full block body or a recomputed full poststate root.', 'Unsigned unpriced calls at parent-block end; no outer-signature, fee-settlement, time-advancement or original-position replay claim.', 'Both captured cases completed. This fixed audit rejects unsupported partial wire evidence rather than converting failures to zero/success; negative controls are labeled separately.'] };
}

const result = await verify();
if (process.argv[2] === '--write') await writeFile(join(HERE, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
else if (process.argv[2] === '--verify') {
  assert.deepEqual(result, await json(join(HERE, 'verification.json')));
  const ownManifest = await json(join(HERE, 'manifest.json'));
  assert.equal(ownManifest.originalPacketManifestSha256, MANIFEST);
  for (const entry of ownManifest.files) await checkEntry(HERE, entry);
} else throw Error('Use --write once or --verify');
console.log(JSON.stringify(result, null, 2));
