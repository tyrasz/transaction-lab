// Artifact-only review: no process spawning, EVM execution, fetch or RPC.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IDS, sha, relative, parsePhase, nativeRow, feeAccounting, applyChanges } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const PINS = Object.freeze({
  manifest: 'ff3fc44eb75b62cbc787a75beee23a9b7e256220d83b79d258e2d8c6f8b33b18',
  plan: '3dd48496b5388bece2ac5130f8a0f6ceb560ade61048eaa079613049f1e27b92',
  source: '6ea577ca6785966b830de594b34e2c3e2c120c4c2400a127ed3aa5da274bf6ae',
});
function walk(root, sub = '') {
  return fs.readdirSync(path.join(root, sub), { withFileTypes: true }).flatMap(entry => {
    const p = relative(sub ? sub + '/' + entry.name : entry.name);
    return entry.isDirectory() ? walk(root, p) : [p];
  }).sort();
}
function bytes(root, p) { relative(p); const file = path.join(root, p); assert(fs.lstatSync(file).isFile()); return fs.readFileSync(file); }
function matchFile(root, item) {
  relative(item.path); const file = path.join(root, item.path), stat = fs.lstatSync(file);
  if (item.kind === 'symlink') {
    assert(stat.isSymbolicLink()); assert.equal(fs.readlinkSync(file), item.target); assert(!path.isAbsolute(item.target));
    const target = relative(path.posix.normalize(path.posix.join(path.posix.dirname(item.path), item.target)));
    assert(target.startsWith(item.path.split('/node_modules/')[0] + '/node_modules/'));
    assert.equal(fs.realpathSync(file), path.join(root, target)); assert(fs.lstatSync(path.join(root, target)).isFile()); return 0;
  }
  assert.equal(item.kind, 'file'); assert(stat.isFile() && !stat.isSymbolicLink());
  const b = bytes(root, item.path); assert.equal(b.length, item.bytes); assert.equal(sha(b), item.sha256); assert.equal(stat.mode & 0o777, item.mode); return b.length;
}
function binding(input, lib, common) {
  const r = input.request, raw = lib.hexToBytes(input.signedCounterpart), blob = r.executionProfile === 'unsigned_eip4844_block_end';
  assert.equal(raw[0], blob ? 3 : 2); const fields = lib.RLP.decode(raw.subarray(1));
  assert.equal(fields.length, blob ? 14 : 12);
  const scalar = b => { assert(b.length === 0 || b[0] !== 0); return b.length ? BigInt(lib.bytesToHex(b)) : 0n; };
  const tx = blob ? new lib.Blob4844Tx({ chainId: scalar(fields[0]), nonce: fields[1], maxPriorityFeePerGas: fields[2], maxFeePerGas: fields[3], gasLimit: fields[4], to: fields[5], value: fields[6], data: fields[7], accessList: fields[8], maxFeePerBlobGas: fields[9], blobVersionedHashes: fields[10], v: scalar(fields[11]), r: scalar(fields[12]), s: scalar(fields[13]) }, { common }) : lib.createTxFromRLP(raw, { common });
  assert.equal(tx.chainId, 1n); assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(), r.from);
  assert.equal(tx.to.toString(), r.to); assert.equal(tx.nonce, BigInt(input.allocation[r.from].nonce));
  for (const [key, value] of [['gasLimit', r.gas], ['value', r.value], ['maxFeePerGas', r.fees.maxFeePerGas], ['maxPriorityFeePerGas', r.fees.maxPriorityFeePerGas]]) assert.equal(tx[key], BigInt(value));
  assert.equal(lib.bytesToHex(tx.data), r.data); assert.deepEqual(tx.accessList, []); assert.equal(lib.bytesToHex(tx.serialize()), input.signedCounterpart);
  if (blob) { assert.equal(tx.maxFeePerBlobGas, BigInt(r.fees.maxFeePerBlobGas)); assert.deepEqual(tx.blobVersionedHashes, r.blobVersionedHashes); }
  return tx.type;
}
function expectedBalances(input, fees) {
  const b = new Map(Object.entries(input.allocation).map(([a, value]) => [a, BigInt(value.balance)]));
  const get = a => b.get(a) ?? 0n, add = (a, n) => { const value = get(a) + n; assert(value >= 0n); b.set(a, value); };
  const r = input.request, beneficiary = '0x' + '88'.repeat(20), success = ![2, 3].includes(input.index);
  add(r.from, -BigInt(fees.totalFeeCharge ?? fees.gasCharge));
  if (success) { add(r.from, -BigInt(r.value)); add(r.to, BigInt(r.value)); }
  if (input.index === 4) { const value = get(r.to); add(r.to, -value); add(beneficiary, value); }
  if (input.index === 5) { add(r.to, -5n); add(beneficiary, 5n); }
  add(input.header.miner, BigInt(fees.coinbaseTip));
  if (input.index === 4) b.set(r.to, 0n); // Tip credited before Shanghai deletion, then burned.
  return b;
}
export async function verify({ root = ROOT, capture = path.join(root, 'research/native-balance-v029/capture') } = {}) {
  const read = p => bytes(capture, p), json = p => JSON.parse(read(p));
  for (const [p, pin] of [['manifest.json', PINS.manifest], ['plan.json', PINS.plan], ['source-manifest.json', PINS.source]]) assert.equal(sha(read(p)), pin);
  const manifest = json('manifest.json'), plan = json('plan.json'), source = json('source-manifest.json'), results = json('results.json'), started = json('STARTED.json');
  assert.equal(manifest.planSha256, PINS.plan); assert.equal(plan.sourceManifestSha256, PINS.source);
  assert.deepEqual(manifest.files.map(f => f.path), walk(capture).filter(p => p !== 'manifest.json'));
  for (const item of manifest.files) matchFile(capture, item);
  assert.deepEqual(plan.declarations.map(c => c.id), IDS); assert.deepEqual(results.rows.map(c => c.id), IDS);
  assert.equal(results.planSha256, PINS.plan); assert.equal(results.sourceManifestSha256, PINS.source); assert.deepEqual(results.scope, plan.scope);
  assert.equal(started.planSha256, PINS.plan); assert(Date.parse(plan.at) <= Date.parse(started.at));
  assert.deepEqual(plan.limits, { totalMs: 120000, phaseMs: 15000, phaseBytes: 8388608, totalBytes: 67108864 });
  assert.equal(plan.scope.sharedEthereumJS, true); assert.equal(plan.scope.independentClient, false); assert.equal(plan.scope.populationAccuracy, false); assert.equal(plan.scope.publicRpc, false); assert.equal(plan.scope.sourceBytesArchived, false);
  assert.equal(results.status, 'complete'); assert.equal(results.comparisonsUsable, true); assert.equal(results.fatal, null); assert.equal(results.sourceUnchanged, true); assert.equal(results.artifactsUnchanged, true);
  assert(results.timing.wallMs >= 0 && results.timing.wallMs <= 120000 && results.timing.monotonicMs >= 0 && results.timing.monotonicMs <= 120000 && results.timing.valid === true);
  assert.deepEqual(source.files.map(f => f.path), [...new Set(source.files.map(f => f.path))].sort());
  let runtimeBytes = 0; for (const item of source.files) runtimeBytes += matchFile(root, item);
  for (const engine of ['local-evm', 'fixture-evm']) assert.deepEqual(walk(root, `engines/${engine}/node_modules`), source.files.filter(f => f.path.startsWith(`engines/${engine}/node_modules/`)).map(f => f.path));
  assert.equal(sha(fs.readFileSync(process.execPath)), source.node.sha256); assert.equal(process.version, source.node.version); assert.equal(process.platform, source.node.platform); assert.equal(process.arch, source.node.arch);
  const load = p => import(pathToFileURL(path.join(root, p)).href), prefix = 'engines/fixture-evm/node_modules/';
  const lib = Object.assign({}, ...await Promise.all(['@ethereumjs/common/dist/esm/index.js', '@ethereumjs/tx/dist/esm/index.js', '@ethereumjs/util/dist/esm/index.js', '@ethereumjs/rlp/dist/esm/index.js'].map(p => load(prefix + p))),
    await load('engines/fixture-evm/state-test.js'), await load('engines/local-evm/ethereum-header.js'), await load('engines/local-evm/input-facts.js'), await load('engines/local-evm/verified-state-proof.js'));
  // Fixture construction is prestate/signature only; no execution entry point.
  const cases = await load('research/native-balance-v029/cases.mjs'); assert.deepEqual(cases.IDS, IDS);
  const rows = []; let proofCalls = 0, inputRecords = 0, inputResultBytes = 0, phaseBytes = 0, nativePairs = 0;
  for (let index = 0; index < IDS.length; index++) {
    const id = String(index + 1).padStart(3, '0'), decl = plan.declarations[index], input = json(decl.path);
    assert.equal(input.index, index); assert.equal(input.id, IDS[index]); assert.equal(decl.path, `inputs/${id}.json`);
    assert.equal(read(decl.path).length, decl.bytes); assert.equal(sha(read(decl.path)), decl.sha256);
    const fixture = await cases.fixtureAt(index); assert.deepEqual(cases.declaration(fixture), input); assert.deepEqual(fixture.calls, []);
    const common = new lib.Common({ chain: lib.Mainnet }); common.setHardforkBy({ blockNumber: BigInt(input.header.number), timestamp: BigInt(input.header.timestamp) });
    const header = lib.verifyEthereumHeader({ header: input.header, expectedHash: input.header.hash }), signedType = binding(input, lib, common);
    const state = await lib.loadState(input.allocation, common); assert.equal(lib.bytesToHex(await state.getStateRoot()), input.header.stateRoot);
    const productPath = `results/${id}-product.json`, referencePath = `results/${id}-reference.json`;
    const productPhase = json(productPath), referencePhase = json(referencePath), seal = json(productPath + '.seal.json');
    assert.equal(seal.bytes, read(productPath).length); assert.equal(seal.sha256, sha(read(productPath))); assert(Date.parse(seal.at) >= Date.parse(started.at));
    for (const [mode, phase] of [['product', productPhase], ['reference', referencePhase]]) {
      const originalCapture = path.join(source.sourceRoot, 'research/native-balance-v029/capture');
      assert.deepEqual(phase.process.args, ['--max-old-space-size=256', path.join(source.sourceRoot, 'research/native-balance-v029/worker.mjs'), mode, path.join(originalCapture, decl.path), ...(mode === 'reference' ? [path.join(originalCapture, productPath)] : [])]);
      assert(phase.process.elapsedMs >= 0 && phase.process.elapsedMs <= phase.process.timeoutMs && phase.process.timeoutMs <= 15000);
      assert(phase.stdout.bytes + phase.stderr.bytes <= 8388608); phaseBytes += phase.stdout.bytes + phase.stderr.bytes;
    }
    const product = parsePhase(productPhase), reference = parsePhase(referencePhase); assert(product && reference);
    assert.equal(product.id, input.id); assert.equal(reference.id, input.id); assert.equal(reference.signedCounterpart, input.signedCounterpart);
    assert.equal(product.scope.publicRpc, false); assert.equal(product.scope.expectedOutputsUsed, false); assert.equal(reference.scope.independentClient, false); assert.equal(reference.scope.referenceInputProductOutputs, false);
    const attempt = product.attempt, p = attempt.preview, original = p.original, output = original.output, ref = reference.output;
    assert.equal(attempt.status, 'completed'); assert.equal(attempt.error, null); assert.equal(p.status, 'complete'); assert.equal(p.error, null); assert.deepEqual(attempt.headerVerification, header); assert.deepEqual(p.headerVerification, header);
    assert.equal(attempt.isolation.processClosed, true); assert.equal(attempt.isolation.exitCode, 0); assert.equal(attempt.isolation.exitSignal, null); assert.equal(attempt.broker.pendingAtReturn, 0);
    assert.deepEqual(p.inputs.context.header, input.header); assert.deepEqual(original.inputs.context.header, input.header);
    assert.equal(product.proofRecords.length, p.inputEvidence.length); assert.equal(attempt.broker.records.length, p.inputEvidence.length); assert.equal(attempt.broker.calls, p.inputEvidence.length);
    const codes = new Map(product.proofRecords.filter(r => r.method === 'eth_getCode').map(r => [r.params[0], r.result]));
    for (const [i, record] of product.proofRecords.entries()) {
      const evidence = p.inputEvidence[i], broker = attempt.broker.records[i], request = { method: record.method, params: record.params };
      assert.equal(record.id, i + 1); assert.equal(record.status, 'completed'); assert(['eth_getProof', 'eth_getCode'].includes(record.method));
      assert.deepEqual(record.params.at(-1), { blockHash: input.header.hash, requireCanonical: true });
      assert.deepEqual(evidence.request, request); assert.deepEqual(broker.request, request); assert.equal(evidence.requestText, JSON.stringify(request)); assert.equal(evidence.requestSha256, sha(evidence.requestText));
      assert.deepEqual(evidence.result, record.result); const raw = Buffer.from(JSON.stringify(record.result));
      for (const target of [evidence, broker]) { assert.equal(target.resultSha256, sha(raw)); assert.equal(target.resultBytes, raw.length); assert.equal(target.status, 'received'); }
      inputRecords++; inputResultBytes += raw.length;
      if (record.method === 'eth_getProof') { await lib.verifyStateProof({ stateRoot: input.header.stateRoot, address: record.params[0], storageKeys: record.params[1], proof: record.result, code: codes.get(record.params[0]) }); proofCalls++; }
    }
    for (const view of [original, p]) await lib.validateInputFacts({ inputs: view.inputs, inputEvidence: view.inputEvidence, stateRoot: input.header.stateRoot });
    assert.deepEqual(original.inputEvidence, p.inputEvidence.slice(0, original.inputEvidence.length));
    assert.deepEqual(output.execution, ref.execution); assert.equal(output.gasAccounting.gasUsed, ref.gasUsed); assert.deepEqual(output.logs, ref.logs);
    const fees = feeAccounting(input, output), expected = expectedBalances(input, fees);
    if (index === 4 || index === 5) {
      const deleted = index === 4 ? input.request.to : input.queries[2].account;
      assert.equal(output.lifecycle.finalizedDeletions.length, 1);
      assert.equal(output.lifecycle.finalizedDeletions[0].address, deleted);
      assert.equal(output.lifecycle.finalizedDeletions[0].scope, 'entire_account_including_code_and_storage');
      assert.equal(ref.accounts.find(a => a.account === deleted).exists, false);
      const delta = original.changes.accounts.find(a => a.address === deleted);
      if (index === 4) assert.deepEqual(delta.existence, { before: true, after: false, basis: 'shanghai_selfdestruct_deletion' });
      else assert.equal(delta, undefined); // Proven absent -> created -> deleted has no net row.
    }
    const postRoot = await applyChanges(state, original.changes, lib); assert.equal(postRoot, ref.stateRoot); assert.equal(postRoot, reference.productAppliedStateRoot); assert.equal(reference.productApplicationError, null);
    assert.equal(p.measurements.length, input.queries.length); assert.equal(ref.accounts.length, input.queries.length); assert.equal(p.usage.executions, 1);
    assert.equal(p.scope.nativeEffectsMeasured, true); assert.equal(p.scope.nativeBalanceCoverage, 'explicit_accounts_only'); assert.equal(p.scope.queryGasScope, 'CALL_only');
    const amounts = [];
    for (const [i, q] of input.queries.entries()) {
      const before = BigInt(input.allocation[q.account]?.balance ?? 0), afterAccount = await state.getAccount(lib.createAddressFromString(q.account)), after = afterAccount?.balance ?? 0n;
      assert.equal(after, expected.get(q.account) ?? 0n); assert.deepEqual(ref.accounts[i], { account: q.account, exists: afterAccount !== undefined, nonce: String(afterAccount?.nonce ?? 0n), balance: String(after) });
      nativeRow(p.measurements[i], q, before, after, original.changes); nativePairs++;
      amounts.push({ account: q.account, before: String(before), after: String(after), delta: String(after - before), unit: 'wei' });
    }
    const comparison = json(`results/${id}-comparison.json`); assert.deepEqual(comparison, results.rows[index]);
    assert.deepEqual(comparison, { id: input.id, status: 'matched', channels: { execution: true, gas: true, logs: true, fullStateRoot: true, measurements: true, nativeNoVm: true } });
    rows.push({ id: input.id, status: comparison.status, fork: header.hardfork, signedType, execution: output.execution.status, gasUsed: ref.gasUsed, feeAccounting: fees, amounts, stateRoot: postRoot });
  }
  assert(phaseBytes <= 67108864); assert.deepEqual(results.counts, { matched: 6, mismatched: 0, unavailable: 0, not_attempted: 0 });
  return { status: 'verified_artifact_only', pins: PINS, cases: rows.length, nativePairs, inputRecords, proofCalls, inputResultBytes, evidenceFiles: manifest.files.length,
    runtimeEntries: source.files.length, runtimeSymlinks: source.files.filter(f => f.kind === 'symlink').length, runtimeBytes, phaseBytes, originalTiming: results.timing,
    runtimeIdentity: { sourceRoot: source.sourceRoot, recordedGitHead: source.gitCommit, node: source.node, sourceBytesArchived: false },
    scope: { captureReexecuted: false, evmExecuted: false, rpc: false, independentClient: false, sharedEthereumJS: true, proofVerification: true, freshMptDeltaApplication: true,
      populationAccuracy: false, phaseInputIdTimingIndependentlyAuthenticated: false }, rows };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verify(), null, 2));
