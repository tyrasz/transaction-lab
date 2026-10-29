// Artifact-only review. No producer imports, VM, cryptographic target, subprocess,
// RPC, or network operation. Expected values are read only from pinned upstream bytes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PREFIX = 'research/bls-precompile-v1';
export const INPUT_PIN = 'b1f6b97fad0c2ed14b182d440d7283fd3efaadc70dcfb553c1491e9d24255095';
export const V1 = Object.freeze({ plan: '4444a446f6d611a624dc14fdfa4f8fdd0e385c2ffb58e73440ec13f87387deae', source: '3299dcd7bd86825ae2a18a672f0791cdd74d00975016c92080400d15c46e8582', manifest: '80af9842a37426970a3cd681b759edafb83dda1cb805a64fa9d8fba764d4a565' });
export const V2 = Object.freeze({ plan: '7cb82bea0fcfec8568581f57cd5b23d162791ae29d58ba62a57f929e575f507f', source: '5ef202ff46c79041589320a6a9a5c12d8a3c208bdb70cdc0d5c08c8f310fa662' });
const FAMILIES = { blsG1Add: '0b', blsG1Mul: '0c', blsG1MultiExp: '0c', blsG2Add: '0d', blsG2Mul: '0e', blsG2MultiExp: '0e', blsMapG1: '10', blsMapG2: '11', blsPairing: '0f' };
const FILES = Object.keys(FAMILIES).flatMap(x => [x + '.json', 'fail-' + x + '.json']).sort();
const FORKS = { prague: '1746612311', osaka: '1764798551' };
const LIMITS = { calldataBytes: 32768, gas: 5000000, caseWallMs: 5000, batchWallMs: 90000, totalWallMs: 600000, closeGraceMs: 1000, stdoutBytes: 33554432, stderrBytes: 1048576, totalOutputBytes: 268435456 };
const FROM = '0x' + '11'.repeat(20), COINBASE = '0x' + '55'.repeat(20);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
const identity = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const finite = (n, max) => assert(Number.isFinite(n) && n >= 0 && n <= max, 'Invalid recorded duration');
const relative = name => assert(typeof name === 'string' && name && !path.isAbsolute(name) && !name.includes('\\') && !name.split('/').some(x => !x || x === '.' || x === '..'), 'Unsafe inventory path');

export function inventory(root, entries, { omit = [], omitRuntime = false } = {}) {
  const found = [];
  function walk(sub = '') {
    for (const item of fs.readdirSync(path.join(root, sub), { withFileTypes: true })) {
      const name = sub ? sub + '/' + item.name : item.name;
      if (omit.includes(name) || (omitRuntime && name === 'runtime')) continue;
      if (item.isDirectory()) walk(name); else found.push(name);
      assert(found.length <= 10000, 'Inventory exceeds bound');
    }
  }
  walk();
  assert.deepEqual(found.sort(), entries.map(x => x.path), 'Inventory is not exact, sorted and unique');
  for (const row of entries) {
    relative(row.path); const file = path.join(root, row.path), stat = fs.lstatSync(file);
    if (row.kind === 'symlink') {
      assert(stat.isSymbolicLink()); assert.equal(fs.readlinkSync(file), row.target); assert(!path.isAbsolute(row.target));
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.target));
      assert(target.startsWith('engines/local-evm/node_modules/')); assert(fs.lstatSync(path.join(root, target)).isFile());
      assert(entries.some(entry => entry.path === target && entry.kind === 'file'));
    } else {
      assert.equal(row.kind, 'file'); assert(stat.isFile()); assert(stat.size <= 64 * 1024 * 1024);
      assert.deepEqual({ path: row.path, kind: 'file', ...identity(fs.readFileSync(file)), mode: stat.mode & 0o777 }, row);
    }
  }
}

export function deriveVector(file, vector, index, fork) {
  assert(FILES.includes(file)); assert(Object.hasOwn(FORKS, fork));
  assert.match(vector.Input, /^(?:[0-9a-fA-F]{2})*$/);
  const data = '0x' + vector.Input.toLowerCase(), input = Buffer.from(vector.Input, 'hex');
  assert(input.length <= 1024 * 1024);
  const failure = file.startsWith('fail-'), family = file.replace(/^fail-/, '').replace(/\.json$/, '');
  let zero = 0; for (const byte of input) if (byte === 0) zero++;
  const nonzero = input.length - zero, intrinsic = 21000 + zero * 4 + nonzero * 16, floor = 21000 + 10 * (zero + nonzero * 4);
  if (failure) { assert.equal(typeof vector.ExpectedError, 'string'); assert(vector.ExpectedError.length); assert.equal(vector.Expected, undefined); }
  else { assert.match(vector.Expected, /^(?:[0-9a-fA-F]{2})*$/); assert(Number.isSafeInteger(vector.Gas) && vector.Gas > 0); assert.equal(vector.ExpectedError, undefined); }
  const gas = Math.max(intrinsic + (failure ? 1000000 : vector.Gas), floor), reasons = [];
  if (input.length > 32768) reasons.push('calldata_over_32768');
  if (gas > 5000000) reasons.push('transaction_gas_over_5000000');
  return { id: fork + '/' + file + '#' + index, file, index, name: vector.Name, family, address: '0x' + FAMILIES[family].padStart(40, '0'), failure,
    inputSha256: sha(input), inputBytes: input.length, expectation: failure ? { kind: 'exception', gethError: vector.ExpectedError } : { kind: 'success', output: '0x' + vector.Expected.toLowerCase(), executionGas: String(vector.Gas) },
    intrinsicGas: String(intrinsic), calldataFloor: String(floor), gas: String(gas), messageGas: String(gas - intrinsic), status: reasons.length ? 'unsupported' : 'admitted', reasons, fork, data };
}
export function expectedInput(row) {
  const account = { exists: true, nonce: '1', balance: '0', code: '0x', storage: {} };
  return { request: { from: FROM, to: row.address, data: row.data, value: '0', gas: row.gas },
    header: { number: '25000000', timestamp: FORKS[row.fork], gasLimit: '60000000', baseFeePerGas: '0', mixHash: word(9), miner: COINBASE, parentHash: word(99), hash: word(100), stateRoot: word(101) },
    accounts: { [FROM]: { ...account, nonce: '7', balance: '1000000000' }, [COINBASE]: account, [row.address]: account } };
}
export function classify(row, record) {
  assert.equal(record.id, row.id); assert.deepEqual(record.input, expectedInput(row)); finite(record.elapsedMs, 90000);
  const out = record.output;
  if (!out || !['success', 'failed', 'reverted'].includes(out.execution?.status)) return { id: row.id, status: 'unavailable', reason: out?.execution?.error ?? 'missing_execution', channels: null };
  const e = out.execution, gas = row.failure ? row.messageGas : row.expectation.executionGas;
  assert.equal(out.trace.type, 'CALL'); assert.equal(out.trace.depth, 0); assert.deepEqual(out.trace.calls, []);
  assert.equal(out.trace.from, FROM); assert.equal(out.trace.caller, FROM); assert.equal(out.trace.to, row.address); assert.equal(out.trace.executionAddress, row.address);
  assert.equal(out.trace.input, row.data); assert.equal(out.trace.value, '0x0'); assert.equal(BigInt(out.trace.gas), BigInt(row.messageGas));
  assert.equal(out.trace.output, e.returnData); assert.equal(out.trace.error, e.error); assert.equal(BigInt(out.trace.gasUsed), BigInt(e.executionGasUsed));
  assert.equal(out.profile.sourceBlockHash, record.input.header.hash); assert.equal(out.profile.sourceStateRoot, record.input.header.stateRoot);
  for (const name of ['sourceBlockIdentityVerified', 'sourceStateProofVerified', 'outerSignatureVerified', 'originalTransactionPosition', 'expectedOutputsUsed']) assert.equal(out.profile[name], false);
  assert.equal(out.profile.chainId, 1); assert.equal(out.profile.declaredGasLimit, row.gas); assert.equal(out.profile.executionBaseFee, '0'); assert.equal(out.profile.gasPrice, '0');
  assert.equal(out.feeAccounting, undefined);
  const beforeFloor = BigInt(row.intrinsicGas) + BigInt(gas), total = beforeFloor > BigInt(row.calldataFloor) ? beforeFloor : BigInt(row.calldataFloor);
  const channels = {
    status: row.failure ? e.status === 'failed' && ['invalid input length', 'input is empty', 'point not on curve', 'fp point not in field'].includes(e.error) : e.status === 'success' && e.error === null,
    output: e.returnData === (row.failure ? '0x' : row.expectation.output),
    gas: e.executionGasUsed === gas && e.gasRefundCounter === '0' && out.gasAccounting?.gasUsed === String(total),
    logs: Array.isArray(out.logs) && out.logs.length === 0,
    state: JSON.stringify(record.changes?.accounts) === JSON.stringify([{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]),
    context: out.profile?.hardfork === row.fork && out.profile?.intrinsicGas === row.intrinsicGas && out.profile?.messageGasLimit === row.messageGas && out.profile?.calldataFloor === row.calldataFloor && out.profile?.feesSettled === false,
  };
  return { id: row.id, status: Object.values(channels).every(Boolean) ? 'matched' : 'mismatched', reason: null, channels, expectedError: row.failure ? row.expectation.gethError : null, actualError: e.error };
}

function upstream(runtime) {
  const input = path.join(runtime, PREFIX, 'inputs'), planBytes = fs.readFileSync(path.join(input, 'plan.json'));
  assert.equal(sha(planBytes), INPUT_PIN); const plan = JSON.parse(planBytes), provenance = json(path.join(input, 'provenance.json'));
  assert.equal(sha(fs.readFileSync(path.join(input, 'provenance.json'))), plan.provenanceSha256);
  assert.equal(provenance.repository, 'https://github.com/ethereum/go-ethereum'); assert.equal(provenance.tag, 'v1.17.10');
  assert.equal(provenance.commit, '1df30b18d9ed35ee9d28ffd4648442c2204554ad');
  assert.equal(provenance.sourceInventorySha256, '36e245fda711de52fe5e0b8c917d4bbbffd840ed7edfc0696f29cbb1f8b24dff');
  assert.equal(provenance.toolchainManifestSha256, '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333');
  for (const [file, pin] of [['source-inventory.json', provenance.sourceInventorySha256], ['toolchain-manifest.json', provenance.toolchainManifestSha256]]) assert.equal(sha(fs.readFileSync(path.join(input, file))), pin);
  const source = json(path.join(input, 'source-inventory.json')), tool = json(path.join(input, 'toolchain-manifest.json'));
  assert.equal(source.commit, provenance.commit); assert.equal(tool.source.commit, provenance.commit); assert.equal(source.tree, tool.source.tree);
  const wanted = [...FILES.map(x => 'core/vm/testdata/precompiles/' + x), 'COPYING', 'COPYING.LESSER', 'core/vm/contracts.go', 'core/vm/contracts_test.go', 'params/protocol_params.go'].sort();
  assert.deepEqual(provenance.files.map(x => x.path).sort(), wanted);
  for (const row of provenance.files) {
    assert.deepEqual(row, source.files.find(x => x.path === row.path));
    const bytes = fs.readFileSync(path.join(input, 'upstream', row.path)); assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 });
    assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex'), row.gitBlob);
  }
  assert.deepEqual(source.files.filter(x => /^core\/vm\/testdata\/precompiles\/(fail-)?bls.*\.json$/.test(x.path)).map(x => path.basename(x.path)).sort(), FILES, 'No upstream BLS vector file omitted');
  const vectors = Object.fromEntries(FILES.map(file => [file, json(path.join(input, 'upstream/core/vm/testdata/precompiles', file))]));
  assert.equal(Object.values(vectors).reduce((n, rows) => n + rows.length, 0), 928);
  const rows = Object.keys(FORKS).flatMap(fork => FILES.flatMap(file => vectors[file].map((v, i) => deriveVector(file, v, i, fork))));
  assert.equal(rows.length, 1856); assert.equal(rows.filter(x => x.failure).length, 118); assert.equal(rows.filter(x => x.status === 'unsupported').length, 18);
  assert.deepEqual(rows.map(({ data, ...row }) => row), plan.rows); assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.forks, FORKS);
  return { rows, plan, provenance };
}

export function verifyCapture(capture, pins, { requireNull = false } = {}) {
  capture = path.resolve(capture);
  for (const [file, pin] of [['manifest.json', pins.manifest], ['plan.json', pins.plan], ['source-manifest.json', pins.source]]) {
    assert.match(pin, /^[a-f0-9]{64}$/); assert.equal(sha(fs.readFileSync(path.join(capture, file))), pin, file + ' pin');
  }
  const manifest = json(path.join(capture, 'manifest.json')), plan = json(path.join(capture, 'plan.json')), source = json(path.join(capture, 'source-manifest.json'));
  assert.equal(manifest.planSha256, pins.plan); assert.equal(plan.sourceManifestSha256, pins.source); assert.equal(plan.inputPlanSha256, INPUT_PIN); assert.deepEqual(plan.limits, LIMITS);
  inventory(capture, manifest.files, { omit: ['manifest.json'], omitRuntime: true });
  const runtime = path.join(capture, 'runtime'); inventory(runtime, source.files);
  assert.equal(sha(fs.readFileSync(fs.realpathSync(process.execPath))), source.node.sha256); assert.equal(process.version, source.node.version);
  assert.equal(process.platform, source.node.platform); assert.equal(process.arch, source.node.arch);
  const { rows, plan: inputPlan } = upstream(runtime);
  assert.deepEqual(plan.rows, rows.map(({ id, status, reasons }) => ({ id, status, reasons }))); assert.deepEqual(plan.scope, inputPlan.scope);
  const started = json(path.join(capture, 'STARTED.json')), result = json(path.join(capture, 'results.json'));
  assert.equal(started.planSha256, pins.plan); assert.deepEqual(started.node, source.node); assert(Date.parse(started.at) >= Date.parse(plan.createdAt));
  assert.equal(result.planSha256, pins.plan); assert.equal(result.sourceManifestSha256, pins.source); assert.equal(result.inputPlanSha256, INPUT_PIN); assert.deepEqual(result.scope, plan.scope);
  assert.equal(result.status, 'complete'); assert.equal(result.fatal, null); assert.equal(result.sourceUnchanged, true); assert.equal(result.artifactsUnchanged, true); assert.equal(result.comparisonsUsable, true);
  finite(result.timing.wallMs, 600000); finite(result.timing.monotonicMs, 600000); assert.equal(result.timing.valid, true);
  const outputs = new Map(), rawRecords = [], batchSummary = []; let outputBytes = 0, index = 0;
  for (const fork of Object.keys(FORKS)) for (const file of FILES) {
    const prefix = 'batches/' + String(++index).padStart(3, '0'), metadata = json(path.join(capture, prefix + '.process.json'));
    assert.equal(metadata.fork, fork); assert.equal(metadata.file, file); assert.equal(metadata.status, 0); assert.equal(metadata.signal, null); assert.equal(metadata.error, null);
    finite(metadata.elapsedMs, 91000); assert(Number.isSafeInteger(metadata.timeoutMs) && metadata.timeoutMs > 0 && metadata.timeoutMs <= 90000);
    // Process arguments bind to the recorded location; reads use this capture,
    // permitting relocation without rewriting any historical argument.
    assert.deepEqual(metadata.args, [path.join(source.sourceRoot, PREFIX, path.basename(capture), 'runtime', PREFIX, 'worker.mjs'), fork, file]);
    const stdout = fs.readFileSync(path.join(capture, prefix + '.stdout')), stderr = fs.readFileSync(path.join(capture, prefix + '.stderr'));
    assert(stdout.length <= LIMITS.stdoutBytes && stderr.length <= LIMITS.stderrBytes); outputBytes += stdout.length + stderr.length;
    assert.deepEqual(identity(stdout), metadata.stdout); assert.deepEqual(identity(stderr), metadata.stderr);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); new TextDecoder('utf-8', { fatal: true }).decode(stderr); assert(text.endsWith('\n'));
    const records = text.slice(0, -1).split('\n').map(line => JSON.parse(line)), selected = rows.filter(row => row.fork === fork && row.file === file && row.status === 'admitted');
    assert.equal(records.length, selected.length);
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; assert(!outputs.has(record.id));
      if (requireNull) { assert.equal(record.output, null); assert.deepEqual(record.error, { name: 'LocalStateError', message: 'A bounded explicit account inventory is required.' }); assert.equal(record.changes, undefined); assert.equal(record.reads, undefined); }
      outputs.set(record.id, classify(selected[i], record)); rawRecords.push(record);
    }
    batchSummary.push({ prefix, ...metadata });
  }
  assert.equal(outputBytes, result.outputBytes); assert(outputBytes <= LIMITS.totalOutputBytes); assert.deepEqual(batchSummary, result.batches);
  const outcomes = rows.map(row => row.status === 'unsupported' ? { id: row.id, status: 'unsupported', reason: row.reasons, channels: null } : outputs.get(row.id));
  assert.equal(outputs.size, 1838); assert.deepEqual(outcomes, result.rows);
  const counts = Object.fromEntries(['matched', 'mismatched', 'unavailable', 'unsupported', 'not_attempted'].map(status => [status, outcomes.filter(row => row.status === status).length]));
  assert.deepEqual(counts, result.counts);
  // Rehash after all artifact consumption; this does not attest original host
  // process internals, only consistency of the retained packet and pinned source.
  inventory(capture, manifest.files, { omit: ['manifest.json'], omitRuntime: true }); inventory(runtime, source.files);
  return { status: 'verified', pins, inputPlanSha256: INPUT_PIN, evidenceFiles: manifest.files.length, sourceFiles: source.files.length,
    sourceBytes: source.files.reduce((sum, row) => sum + (row.bytes ?? 0), 0), upstreamVectorFiles: 18, upstreamVectors: 928, declaredRows: rows.length, rawRecords: rawRecords.length, counts, nullOutputs: rawRecords.filter(row => row.output === null).length,
    timing: result.timing, outputBytes, scope: { artifactOnly: true, targetExecutionsDuringAudit: 0, publicRpcCalls: 0, freshProofVerification: false, fullTransactionConformance: false, populationAccuracy: false, independentRawClassification: true, expectedSource: 'Pinned Geth source vectors; Geth not executed', sourceHeaderAndStateAuthenticated: false } };
}

export function verifyPair(root, secondManifest) {
  const base = path.join(root, PREFIX), prior = verifyCapture(path.join(base, 'capture'), V1, { requireNull: true });
  const current = verifyCapture(path.join(base, 'capture-v2'), { ...V2, manifest: secondManifest });
  const history = path.join(base, 'capture-v2/runtime', PREFIX, 'history');
  assert.equal(sha(fs.readFileSync(path.join(history, 'capture-v1-manifest.json'))), V1.manifest);
  const declaration = json(path.join(history, 'prior-attempt.json'));
  assert.equal(declaration.manifestSha256, V1.manifest); assert.equal(declaration.planSha256, V1.plan); assert.equal(declaration.sourceManifestSha256, V1.source); assert.deepEqual(declaration.counts, prior.counts);
  assert.deepEqual(json(path.join(base, 'capture-v2/plan.json')).priorAttempt, declaration);
  const before = new Map(json(path.join(base, 'capture/source-manifest.json')).files.map(row => [row.path, row]));
  const after = new Map(json(path.join(base, 'capture-v2/source-manifest.json')).files.map(row => [row.path, row]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].sort().filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)));
  assert.deepEqual(changed, ['PLAN.md', 'archive.mjs', 'history/capture-v1-manifest.json', 'history/prior-attempt.json', 'run.test.mjs', 'worker.mjs'].map(name => PREFIX + '/' + name).sort());
  const oldWorker = fs.readFileSync(path.join(base, 'capture/runtime', PREFIX, 'worker.mjs'), 'utf8'), newWorker = fs.readFileSync(path.join(base, 'capture-v2/runtime', PREFIX, 'worker.mjs'), 'utf8');
  assert(oldWorker.includes('createRecordedStateManager(input.accounts)')); assert(newWorker.includes('createRecordedStateManager({accounts:input.accounts})'));
  return { schemaVersion: 1, status: 'verified', firstCapture: prior, correctedCapture: current, sourceChanges: changed,
    productionRuntimeAndInputsUnchangedBetweenAttempts: true, note: 'First attempt retained as unavailable. Corrected attempt is a separate declaration, not new prospective or population evidence.' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pin] = process.argv.slice(2);
  console.log(JSON.stringify(verifyPair(root, pin), null, 2));
}
