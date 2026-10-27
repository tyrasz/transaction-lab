import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readlink, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

// Supplemental, offline-only audit. No current engine imports or network path.
const HERE = dirname(fileURLToPath(import.meta.url)), PACKET = resolve(HERE, '..');
const MANIFEST = 'dd8973dd8e50447d38bf9609a078acb126e4061a939a9c7b803892073ec6c463';
const PLAN = 'ffa5f14e267e3fb4ec2eb53aa3bb2da241ace700368a244cde9042f2b7f1a220';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const own = (o, key) => Object.hasOwn(o, key);
let networkAttempts = 0;
const forbidden = () => { networkAttempts++; throw Error('Offline audit forbids network access'); };
globalThis.fetch = forbidden;
net.Socket.prototype.connect = forbidden;

function within(base, path) {
  assert.equal(typeof path, 'string');
  const target = resolve(base, path), rel = relative(base, target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Unsafe inventory path');
  return target;
}
async function checkEntry(base, entry) {
  const path = within(base, entry.path);
  if (entry.kind === 'symlink') {
    assert.equal(await readlink(path), entry.target);
    const target = resolve(dirname(path), entry.target), rel = relative(base, target);
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Dependency symlink escapes archive');
  } else {
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, entry.path + ' bytes');
    assert.equal(sha(bytes), entry.sha256, entry.path + ' hash');
  }
}
async function paths(dir, prefix = '') {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) result.push(...await paths(join(dir, item.name), path));
    else result.push(path);
  }
  return result.sort();
}
function exactJsonBytes(text, bytes, digest, parsed) {
  assert.equal(Buffer.byteLength(text), bytes);
  assert.equal(sha(text), digest);
  if (parsed !== undefined) assert.deepEqual(JSON.parse(text), parsed);
}
function withoutEvidenceTiming(rows) {
  return rows.map(({ durationMs, ...rest }) => rest);
}

async function verify() {
  const manifestBytes = await readFile(join(PACKET, 'manifest.json'));
  assert.equal(sha(manifestBytes), MANIFEST);
  const manifest = JSON.parse(manifestBytes), planBytes = await readFile(join(PACKET, 'plan.json'));
  assert.equal(sha(planBytes), PLAN);
  assert.equal(manifest.planSha256, PLAN);
  assert.equal(manifest.filesCount, manifest.files.length);
  assert.equal(new Set(manifest.files.map(x => x.path)).size, manifest.files.length);
  // Hash output files as opaque bytes here; they never become execution inputs.
  for (const entry of manifest.files) await checkEntry(PACKET, entry);
  const plan = JSON.parse(planBytes), runtime = join(PACKET, 'runtime');
  assert.equal(process.version, plan.runtime.node);
  assert.equal(process.platform, plan.runtime.platform);
  assert.equal(process.arch, plan.runtime.arch);
  assert.deepEqual(process.versions, plan.runtime.versions);
  for (const entry of plan.sourceFiles) await checkEntry(runtime, entry);
  assert.deepEqual(await paths(runtime), plan.sourceFiles.map(x => x.path).sort());
  for (const entry of [...plan.inputFiles, ...plan.scripts]) await checkEntry(PACKET, entry);

  const mod = name => import(pathToFileURL(join(runtime, 'engines/local-evm', name)));
  const [{ verifyEthereumHeader }, { createRpcStateInputs }, { createProofStateManager }, { executeEthereumCall }] =
    await Promise.all(['ethereum-header.js', 'rpc-state-inputs.js', 'proof-state.js', 'ethereum-call.js'].map(mod));
  const headerVerification = verifyEthereumHeader({ header: plan.header, expectedHash: plan.api.input.block });
  const capability = await json(join(PACKET, 'inputs/capture.json'));
  assert.deepEqual(capability.selectedHeader, plan.header);
  const headerRecords = [];
  for (const row of capability.records) {
    exactJsonBytes(row.request.bodyText, row.request.bytes, row.request.sha256, row.request.body);
    const r = row.response;
    if (r?.complete && r.bodyText !== undefined) {
      exactJsonBytes(r.bodyText, r.retainedBytes, r.retainedSha256, r.parsed);
      assert.equal(r.retainedBytes, r.observedBytes);
      assert.equal(r.retainedSha256, r.observedSha256);
    }
    if (r?.parsed?.result?.hash === plan.header.hash && row.request.body.method.startsWith('eth_getBlock')) {
      assert.equal(r.parsed.id, row.request.body.id);
      assert.deepEqual(r.parsed.result, plan.header);
      headerRecords.push({ id: row.id, provider: row.provider, method: row.request.body.method, params: row.request.body.params });
    }
  }
  assert.equal(headerRecords.length, 4);
  assert.deepEqual(plan.providers.map(p => p.id), ['publicnode', 'drpc']);
  const replayed = [], wireSummaries = [];
  let totalBytes = 0;
  for (const provider of plan.providers) {
    const names = manifest.files.filter(e => new RegExp(`^raw/${provider.id}-[0-9]{3}\\.json$`).test(e.path)).map(e => e.path).sort();
    assert.ok(names.length > 0 && names.length <= plan.limits.proofCodeCallsPerAttempt);
    const wires = [];
    for (const [index, name] of names.entries()) {
      const row = await json(join(PACKET, name)), raw = await readFile(join(PACKET, name.replace(/\.json$/, '.body')));
      assert.equal(row.url, provider.url);
      assert.equal(row.id, index + 1);
      assert.deepEqual(row.request, JSON.parse(row.requestText));
      exactJsonBytes(row.requestText, row.requestBytes, row.requestSha256, row.request);
      assert.equal(row.request.jsonrpc, '2.0');
      assert.equal(row.request.id, row.id);
      assert.ok(['eth_getProof', 'eth_getCode'].includes(row.request.method));
      assert.equal(row.request.params.length, row.request.method === 'eth_getProof' ? 3 : 2);
      assert.match(row.request.params[0], /^0x[0-9a-f]{40}$/);
      assert.deepEqual(row.request.params.at(-1), { blockHash: plan.header.hash, requireCanonical: true });
      if (row.request.method === 'eth_getProof') {
        assert.ok(Array.isArray(row.request.params[1]));
        for (const key of row.request.params[1]) assert.match(key, /^0x[0-9a-f]{64}$/);
      }
      assert.equal(raw.length, row.transport.retainedBytes);
      assert.equal(sha(raw), row.transport.retainedSha256);
      // This fixed packet contains complete bodies; unsupported partial bodies
      // fail this audit instead of being converted to an empty successful result.
      assert.equal(row.transport.complete, true);
      assert.equal(row.transport.observedBytes, raw.length);
      assert.equal(row.transport.observedSha256, sha(raw));
      assert.ok(raw.length <= plan.limits.bodyBytes);
      assert.equal(row.responseText, new TextDecoder('utf-8', { fatal: true }).decode(raw));
      assert.equal(row.responseSha256, sha(raw));
      assert.equal(row.httpStatus, 200);
      const envelope = JSON.parse(raw);
      assert.equal(envelope.jsonrpc, '2.0');
      assert.equal(envelope.id, row.id);
      assert.notEqual(own(envelope, 'result'), own(envelope, 'error'));
      if (own(row, 'parsed')) assert.deepEqual(row.parsed, envelope);
      if (own(envelope, 'error')) {
        assert.equal(row.status, 'failed');
        assert.equal(row.error, 'rpc_error');
      } else assert.equal(row.status, 'completed');
      totalBytes += raw.length;
      wires.push({ row, envelope });
    }
    let cursor = 0;
    const rpc = { async call(method, params) {
      assert.ok(cursor < wires.length, 'Unrecorded input-state read');
      const { row, envelope } = wires[cursor++];
      const request = { jsonrpc: '2.0', id: cursor, method, params };
      assert.equal(JSON.stringify(request), row.requestText, 'Generated request differs byte-for-byte');
      if (own(envelope, 'error')) throw Object.assign(new Error('rpc_error'), { code: 'rpc_error' });
      return structuredClone(envelope.result);
    } };
    const inputs = createRpcStateInputs({ chainId: 1, blockHash: plan.header.hash, header: plan.header, rpc, limits: { calls: 64, wallMs: 120000 } });
    const state = createProofStateManager({ inputs });
    const output = await executeEthereumCall({ request: plan.request, header: plan.header, stateManager: state, limits: { wallMs: 120000 } });
    assert.equal(cursor, wires.length, 'Unconsumed recorded reads');
    replayed.push({ provider, output, inputs: inputs.snapshotInputs(), inputEvidence: withoutEvidenceTiming(inputs.snapshotEvidence()), inputUsage: inputs.snapshotUsage(), stateReads: state.snapshotReads(), changes: state.snapshotChanges(), headerVerification });
    wireSummaries.push({ provider: provider.id, calls: cursor, responseBytes: wires.reduce((n, { row }) => n + row.transport.observedBytes, 0),
      methods: wires.map(({ row }) => row.request.method), failures: wires.filter(({ row }) => row.status !== 'completed').map(({ row, envelope }) => ({ id: row.id, kind: row.error, rpcError: envelope.error, transportComplete: row.transport.complete, timeout: row.error === 'deadline' })) });
  }
  assert.ok(totalBytes <= plan.limits.sharedLocalResponseBytes);

  // Both execution attempts have ended. Only now parse saved expected outputs.
  const comparisons = [];
  for (const actual of replayed) {
    const saved = await json(join(PACKET, actual.provider.id + '-local.json'));
    for (const key of ['provider', 'output', 'inputs', 'inputUsage', 'stateReads', 'changes', 'headerVerification']) assert.deepEqual(actual[key], saved[key], actual.provider.id + ' ' + key);
    assert.deepEqual(actual.inputEvidence, withoutEvidenceTiming(saved.inputEvidence));
    const wire = wireSummaries.find(w => w.provider === actual.provider.id);
    assert.equal(saved.transport.length, wire.calls);
    for (const entry of saved.transport) assert.deepEqual(entry, await json(join(PACKET, `raw/${actual.provider.id}-${String(entry.id).padStart(3, '0')}.json`)));
    comparisons.push({ provider: actual.provider.id, reexecution: 'reproduced', executionStatus: actual.output.execution.status,
      executionError: actual.output.execution.error, inputStatus: actual.inputs.status, inputFailure: actual.inputs.failure ?? null,
      stateDisposition: actual.output.stateDisposition, calls: wire.calls, responseBytes: wire.responseBytes,
      provenAccounts: actual.inputUsage.accounts, provenSlots: actual.inputUsage.slots,
      proofReadsVerified: actual.inputEvidence.filter(e => e.request.method === 'eth_getProof' && e.verification === 'verified').length,
      codeReadsVerified: actual.inputEvidence.filter(e => e.request.method === 'eth_getCode' && e.verification === 'verified').length,
      gasAccounting: actual.output.gasAccounting, outputSha256: sha(JSON.stringify(actual.output)),
      inputsSha256: sha(JSON.stringify(actual.inputs)), changesSha256: sha(JSON.stringify(actual.changes)),
      wireFailures: wire.failures });
  }
  assert.equal(comparisons[0].executionStatus, 'unavailable');
  assert.equal(comparisons[0].wireFailures[0].rpcError.code, -32000);
  assert.equal(comparisons[0].wireFailures[0].timeout, false);
  assert.equal(comparisons[1].executionStatus, 'success');
  const productHttp = await json(join(PACKET, 'product-http.json')), productBytes = await readFile(join(PACKET, 'product-response.body'));
  exactJsonBytes(productHttp.requestText, productHttp.requestBytes, productHttp.requestSha256, plan.api.input);
  assert.equal(productHttp.url, plan.api.url);
  assert.equal(productBytes.length, productHttp.transport.retainedBytes);
  assert.equal(sha(productBytes), productHttp.transport.retainedSha256);
  assert.equal(productHttp.responseText, productBytes.toString('utf8'));
  assert.equal(productHttp.transport.complete, true);
  assert.equal(productHttp.status, 'completed');
  assert.equal(productHttp.httpStatus, 200);
  const product = JSON.parse(productBytes);
  assert.deepEqual(product, await json(join(PACKET, 'product-response.json')));
  const { compareReference } = await import(pathToFileURL(join(PACKET, 'compare.mjs')));
  const savedResults = await json(join(PACKET, 'results.json'));
  for (const actual of replayed) {
    const comparison = compareReference(actual, product, plan.request, plan.header, plan.api.expectedImplementation);
    assert.deepEqual(comparison, savedResults.attempts.find(a => a.provider === actual.provider.id).comparison);
    comparisons.find(a => a.provider === actual.provider.id).savedProductComparison = comparison.status;
  }
  assert.equal(savedResults.localCalls, wireSummaries.reduce((n, w) => n + w.calls, 0));
  assert.equal(savedResults.localObservedBytes, totalBytes);
  assert.equal(networkAttempts, 0);
  assert.equal(sha(await readFile(join(PACKET, 'manifest.json'))), MANIFEST);
  for (const entry of manifest.files) await checkEntry(PACKET, entry);
  return { schemaVersion: '1.0', status: 'reproduced', packetManifestSha256: MANIFEST, planSha256: PLAN,
    supplemental: true, includedInOriginalManifest: false, source: { frozenEntriesVerified: plan.sourceFiles.length, packetEntriesVerified: manifest.files.length, currentSourceUsed: false, installedArchiveDependenciesVerified: true, node: process.version },
    headerVerification, headerWitnesses: headerRecords, localCalls: wireSummaries.reduce((n, w) => n + w.calls, 0), localWireBytes: totalBytes,
    attempts: comparisons, normalization: ['Per-input-evidence durationMs only; execution output, facts, reads, changes, usage and failure identities compared exactly.'],
    inputSeparation: 'Both local executions consume only frozen plan/header and matching recorded eth_getProof/eth_getCode wires. Saved local/product outputs are parsed for comparison only after both executions finish.',
    networkAttempts, limitations: ['One constructed development workload, two provider input attempts; no population accuracy or coverage score.', 'PublicNode historical-state RPC failure remains unavailable/incomplete, not an execution match.', 'Reexecution uses the same frozen local engine and proof verifier, not a second independent implementation.', 'Header hash and state proofs do not authenticate consensus, finality, chain membership or block-body correctness.', 'No timeout occurred in this packet. Complete recorded RPC errors remain distinct from timeout or invalid-proof errors; partial/unsupported transport evidence would fail this fixed audit.', 'Original latency is not reproduced; no state or response fallback and no output-derived input repair.'] };
}

const result = await verify();
if (process.argv[2] === '--write') await writeFile(join(HERE, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
else if (process.argv[2] === '--verify') {
  assert.deepEqual(result, await json(join(HERE, 'verification.json')));
  const supplementalManifest = await json(join(HERE, 'manifest.json'));
  assert.equal(supplementalManifest.originalPacketManifestSha256, MANIFEST);
  for (const entry of supplementalManifest.files) await checkEntry(HERE, entry);
}
else throw Error('Use --write once or --verify');
console.log(JSON.stringify(result, null, 2));
