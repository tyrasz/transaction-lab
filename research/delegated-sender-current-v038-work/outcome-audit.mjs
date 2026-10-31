// Independent saved-outcome audit. Imports only RLP and Keccak primitives from
// the hash-checked archive. No product comparator, proof verifier, VM or RPC.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
const work = path.dirname(fileURLToPath(import.meta.url));
const capture = path.resolve(process.argv[2] ?? path.join(work, '../delegated-sender-current-v038/capture-001'));
const pins = {
  manifest: '3c845b025d9a722e5afa00406d87763656cd38fb6c4ca2bede6ba1918d9115e9',
  intent: 'f89ace8fabaea373b0226cb7cefb68ea6c4b59531cf317eae1da24a5ac8fdb54',
  plan: 'fe7c07a064761f387b6ac6fab30b3d425ce322febd56979355bfd217a75abb84',
  source: 'c8fca41fdf87f8d367908a487955720a09d4403293e776666df2b0638d6a0469',
};
const sha = v => createHash('sha256').update(v).digest('hex');
const read = p => fs.readFileSync(path.join(capture, p));
const json = p => JSON.parse(read(p));
const same = (a, b, message) => assert.deepEqual(a, b, message);
const hex = b => '0x' + Buffer.from(b).toString('hex');
const bytes = h => Buffer.from(h.slice(2), 'hex');
const integer = n => n === 0n ? Buffer.alloc(0) : bytes('0x' + n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'));
const uint = b => b.length ? BigInt(hex(b)) : 0n;
const qty = n => '0x' + BigInt(n).toString(16);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const zero = word(0);
function walk(dir) {
  return fs.readdirSync(path.join(capture, dir), { withFileTypes: true }).flatMap(e => {
    const p = path.posix.join(dir, e.name); return e.isDirectory() ? walk(p) : [p];
  }).sort();
}
function checkEntry(e, prefix = '') {
  const p = path.posix.join(prefix, e.path), s = fs.lstatSync(path.join(capture, p));
  if (e.kind === 'symlink') {
    assert(s.isSymbolicLink()); assert.equal(fs.readlinkSync(path.join(capture, p)), e.target);
    assert.equal(sha(read(p)), e.resolvedSha256); return 0;
  }
  assert(s.isFile() && !s.isSymbolicLink()); const b = read(p);
  assert.equal(b.length, e.bytes, p); assert.equal(sha(b), e.sha256, p); assert.equal(s.mode & 0o777, e.mode, p); return b.length;
}
function checkManifest(prefix, expectedPin) {
  const p = path.posix.join(prefix, 'manifest.json'); assert.equal(sha(read(p)), expectedPin);
  const m = json(p); same(walk(prefix).map(p => path.posix.relative(prefix || '.', p)), [...m.files.map(r => r.path), 'manifest.json'].sort());
  let size = 0; for (const e of m.files) size += checkEntry(e, prefix);
  const ledger = json(path.posix.join(prefix, 'write-ledger.json'));
  same(ledger.files.map(({ origin, ...r }) => r), m.files.filter(r => r.path !== 'write-ledger.json'));
  assert(ledger.files.every(r => ['written', 'preexisting', 'worker_original_write_ledger'].includes(r.origin)));
  return { entries: m.files.length, bytes: size };
}
const inventory = checkManifest('', pins.manifest);
for (const [name, file] of [['intent', 'intent.json'], ['plan', 'plan.json'], ['source', 'source-manifest.json']]) assert.equal(sha(read(file)), pins[name]);
const plan = json('plan.json'), intent = json('intent.json'), source = json('source-manifest.json'), results = json('results.json');
same(plan.files, intent.files); same(source.files, plan.files); same(source.node, plan.node); assert.equal(plan.sourceManifestSha256, pins.source);
same(walk('runtime').map(p => p.slice(8)), plan.files.map(r => r.path));
for (const e of plan.files) checkEntry(e, 'runtime');
assert.equal(results.evidenceUsable, true); assert.equal(results.fatal, null); assert.equal(results.sourceUnchanged, true);
same(results.denominator, { cases: 2, originalPositions: 2, originalChannels: 10, queriesCompared: 0 });
same(results.rows.map(r => [r.kind, r.index]), [['local', 0], ['local', 1], ['oracle', 0], ['oracle', 1]]);
assert.equal(results.planSha256, pins.plan); assert.equal(results.intentSha256, pins.intent);
const { RLP } = await import(pathToFileURL(path.join(capture, 'runtime/engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js')));
const { keccak_256 } = await import(pathToFileURL(path.join(capture, 'runtime/engines/local-evm/node_modules/@noble/hashes/sha3.js')));
const keccak = v => Buffer.from(keccak_256(v));
const nibbles = b => [...b].flatMap(v => [v >> 4, v & 15]);
const EMPTY_ROOT = hex(keccak(RLP.encode(new Uint8Array())));
let proofWalks = 0;
// Standalone branch/extension/leaf walker over the supplied hashed key. A null
// value requires authenticated branch emptiness or compact-path divergence.
function proofValue(root, key, proof) {
  proofWalks++; assert(Array.isArray(proof));
  if (root === EMPTY_ROOT) { assert.equal(proof.length, 0); return null; }
  const nodes = new Map(proof.map(h => { const b = bytes(h); return [hex(keccak(b)), b]; }));
  assert.equal(nodes.size, proof.length); let ref = bytes(root), at = 0; const route = nibbles(keccak(key));
  for (let step = 0; step < 128; step++) {
    let node;
    if (Array.isArray(ref)) node = ref;
    else {
      if (ref.length === 0) return null;
      const encoded = ref.length === 32 ? nodes.get(hex(ref)) : Buffer.from(ref);
      assert(encoded, 'Proof omits a referenced node'); node = RLP.decode(encoded);
    }
    assert(Array.isArray(node));
    if (node.length === 17) { if (at === route.length) return node[16].length ? Buffer.from(node[16]) : null; ref = node[route[at++]]; continue; }
    assert.equal(node.length, 2); const compact = nibbles(node[0]), flag = compact[0]; assert(flag >= 0 && flag <= 3);
    if (!(flag & 1)) assert.equal(compact[1], 0); const suffix = compact.slice(flag & 1 ? 1 : 2);
    if (suffix.some((v, i) => route[at + i] !== v)) return null;
    at += suffix.length;
    if (flag & 2) return at === route.length ? Buffer.from(node[1]) : null;
    assert(suffix.length > 0); ref = node[1];
  }
  throw Error('Excessive proof path');
}
function accountProof(header, response) {
  const raw = proofValue(header.stateRoot, bytes(response.address), response.accountProof);
  assert(raw, 'This observed audit expects existing sender/token accounts');
  const leaf = RLP.decode(raw); assert.equal(leaf.length, 4);
  const value = { nonce: uint(leaf[0]), balance: uint(leaf[1]), storageRoot: hex(leaf[2]), codeHash: hex(leaf[3]) };
  assert.equal(value.nonce, BigInt(response.nonce)); assert.equal(value.balance, BigInt(response.balance));
  assert.equal(value.storageRoot, response.storageHash); assert.equal(value.codeHash, response.codeHash);
  for (const s of response.storageProof) {
    const stored = proofValue(value.storageRoot, bytes(word(s.key)), s.proof), n = stored === null ? 0n : uint(RLP.decode(stored));
    assert.equal(n, BigInt(s.value));
  }
  return value;
}
const HEADER = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const NUMERIC = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
function headerHash(h) {
  const hash = hex(keccak(RLP.encode(HEADER.map(k => NUMERIC.has(k) ? integer(BigInt(h[k])) : bytes(h[k])))));
  assert.equal(hash, h.hash); return hash;
}
let nativeCalls = 0, nativeBytes = 0;
function nativeRows(prefix) {
  return walk(prefix + '/wire').map((p, i) => {
    const w = json(p), raw = Buffer.from(w.rawBase64, 'base64'); assert.equal(w.id, i + 1);
    assert.equal(new URL(w.url).href, 'https://eth.drpc.org/'); assert.equal(raw.toString('base64'), w.rawBase64);
    assert.equal(w.transport.complete, true); assert.equal(w.transport.retainedBytes, raw.length); assert.equal(w.transport.observedBytes, raw.length); assert.equal(w.transport.retainedSha256, sha(raw));
    assert.equal(w.requestBytes, Buffer.byteLength(w.requestText)); assert.equal(w.requestSha256, sha(w.requestText));
    const request = JSON.parse(w.requestText), response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    assert.equal(response.id, request.id); assert.equal(response.jsonrpc, '2.0'); assert(Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error'));
    nativeCalls++; nativeBytes += raw.length; return { path: p, wire: w, request, response, raw };
  });
}
const selection = nativeRows('selection'); same(selection.map(r => r.request.method), ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
assert.equal(selection[0].response.result, '0x1'); const header = selection[1].response.result; same(selection[2].response.result, header); headerHash(header);
same(selection.map(r => r.request.params), [[], ['latest', false], [header.number, false]]);
const processSummary = [];
for (const row of results.rows) {
  const p = json(row.process), seal = json(row.seal), prefix = `${row.kind}/${String(row.index + 1).padStart(3, '0')}`;
  assert.equal(sha(read(row.process)), seal.processSha256); assert.equal(seal.workerSealed, true); assert.equal(seal.workerManifestSha256, row.workerManifestSha256);
  checkManifest(prefix, row.workerManifestSha256); assert.equal(p.status, 0); assert.equal(p.signal, null); assert.equal(p.closed, true); assert.equal(p.error, null); assert.equal(p.limitFailure, null);
  assert(Number.isSafeInteger(p.pid) && p.pid > 0); assert(p.wallMs >= 0 && p.wallMs <= p.timeoutMs && p.monotonicMs >= 0 && p.monotonicMs <= p.timeoutMs);
  for (const k of ['stdout', 'stderr']) { same(p[k], seal[k]); assert.equal(read(p[k].path).length, p[k].bytes); assert.equal(sha(read(p[k].path)), p[k].sha256); }
  assert.equal(p.stderr.bytes, 0); same(JSON.parse(read(p.stdout.path)), { status: 'captured', manifestSha256: row.workerManifestSha256 });
  const report = json(prefix + '/report.json'); assert.equal(report.workerPid, p.pid); assert.equal(report.sourceUnchanged, true); assert.equal(report.status, 'returned'); assert.equal(report.error, null);
  assert.equal(report.drain.capture.complete, true); assert.equal(report.drain.childClosure, true); assert.equal(report.drain[row.kind === 'local' ? 'rpc' : 'cohort'].complete, true);
  processSummary.push({ kind: row.kind, index: row.index, pid: p.pid, wallMs: p.wallMs, monotonicMs: p.monotonicMs, closed: p.closed, sealed: true });
}
function normalizedLocal(changes, initial) {
  return changes.accounts.map(row => {
    assert(!row.reset && !row.existence); const a = initial.accounts[row.address]; assert(a?.exists);
    const out = { address: row.address };
    for (const k of ['nonce', 'balance', 'code']) if (row[k]) { assert.equal(row[k].before, k === 'code' ? a.code : qty(a[k])); out[k] = row[k]; }
    if (row.storage) out.storage = row.storage.map(s => { assert.equal(s.before, a.storage[s.slot]); return s; }).sort((a, b) => a.slot.localeCompare(b.slot));
    return out;
  }).sort((a, b) => a.address.localeCompare(b.address));
}
function normalizedOracle(diff, initial) {
  const out = [];
  for (const address of [...new Set([...Object.keys(diff.pre), ...Object.keys(diff.post)])].sort()) {
    const before = diff.pre[address], after = diff.post[address], a = initial.accounts[address]; assert(a?.exists && before && after, 'Unobserved lifecycle form');
    for (const k of ['nonce', 'balance']) if (Object.hasOwn(before, k)) assert.equal(BigInt(before[k]), BigInt(a[k]));
    if (before.code !== undefined) assert.equal(before.code, a.code); if (before.codeHash !== undefined) assert.equal(before.codeHash, hex(keccak(bytes(a.code))));
    const row = { address };
    for (const k of ['nonce', 'balance']) if (Object.hasOwn(after, k) && BigInt(after[k]) !== BigInt(a[k])) row[k] = { before: qty(a[k]), after: qty(after[k]) };
    if (after.code !== undefined && after.code !== a.code) row.code = { before: a.code, after: after.code };
    const storage = [];
    for (const slot of [...new Set([...Object.keys(before.storage ?? {}), ...Object.keys(after.storage ?? {})])].sort()) {
      const known = a.storage[slot]; assert(known !== undefined, 'Sparse diff lacks independent slot proof');
      assert.equal(before.storage?.[slot] ?? zero, known); const next = after.storage?.[slot] ?? zero;
      if (known !== next) storage.push({ slot, before: known, after: next });
    }
    if (storage.length) row.storage = storage; if (Object.keys(row).length > 1) out.push(row);
  }
  return out;
}
const cases = [];
for (const n of ['001', '002']) {
  const d = json(`inputs/${n}.json`), localWorker = json(`local/${n}/report.json`), oracleWorker = json(`oracle/${n}/report.json`);
  const report = localWorker.report, original = report.attempt.preview.original, output = original.output, initial = original.inputs;
  same(localWorker.implementation, report.implementation);
  const implementation = report.implementation;
  same(implementation.sourceFiles, implementation.inventory.map(r => r.path));
  assert.equal(sha(JSON.stringify({ files: implementation.inventory, runtime: implementation.runtime })), implementation.sourceSha256);
  for (const entry of implementation.inventory) {
    const captured = plan.files.find(r => r.path === entry.path);
    if (entry.kind === 'symlink') { const { resolvedSha256, ...identityEntry } = captured; same(entry, identityEntry); }
    else same(entry, captured);
  }
  same([implementation.runtime.node, implementation.runtime.v8, implementation.runtime.platform, implementation.runtime.arch, implementation.runtime.executableSha256],
    [plan.node.version, plan.node.v8, plan.node.platform, plan.node.arch, plan.node.sha256]);
  assert.equal(report.attempt.isolation.processClosed, true);
  same(d.header, header); assert.equal(sha(read(`inputs/${n}.json`)), plan.inputs[Number(n) - 1].sha256);
  const originalInput = json(`original-templates/${n}.json`); same(d.request, originalInput.projection.request); assert.equal(d.transactionHash, originalInput.transactionHash);
  same(report.apiRequest, d.localInput); same(report.transportEvidence, localWorker.rpcEvidence); assert.equal(report.source.canonicalStatus, 'verified'); assert.equal(report.status, 'complete');
  same(report.source.blockSelection.header, header); same(initial.context.header, header); assert.equal(initial.context.stateRoot, header.stateRoot);
  const localWires = nativeRows(`local/${n}`), oracleWires = nativeRows(`oracle/${n}`);
  assert.equal(localWires.length, report.transportEvidence.length); assert.equal(oracleWires.length, 4);
  for (const [i, w] of localWires.entries()) { const e = report.transportEvidence[i]; assert.equal(e.requestText, w.wire.requestText); assert.equal(e.responseText, w.raw.toString()); assert.equal(e.transport.responseSha256, sha(w.raw)); }
  same(localWires[0].response.result, '0x1'); same(localWires[1].response.result, header); same(localWires.at(-1).response.result, header);
  same(oracleWires[0].response.result, header); same(oracleWires[3].response.result, header);
  const selector = { blockHash: header.hash, requireCanonical: true }, call = { from: d.request.from, to: d.request.to, data: d.request.data, value: '0x0', gas: '0x4c4b40', gasPrice: '0x0', accessList: [] };
  same(oracleWires.map(w => [w.request.method, w.request.params]), [
    ['eth_getBlockByHash', [header.hash, false]],
    ['debug_traceCall', [call, selector, { tracer: 'callTracer', tracerConfig: { withLog: true }, blockOverrides: { baseFeePerGas: '0x0' } }]],
    ['debug_traceCall', [call, selector, { tracer: 'prestateTracer', tracerConfig: { diffMode: true }, blockOverrides: { baseFeePerGas: '0x0' } }]],
    ['eth_getBlockByNumber', [header.number, false]],
  ]);
  for (const [i, row] of oracleWorker.oracle.records.entries()) { assert.equal(row.rawBase64, oracleWires[i].raw.toString('base64')); same(row.parsed, oracleWires[i].response); }
  const accountLeaves = new Map();
  for (const [i, e] of original.inputEvidence.entries()) {
    const b = report.attempt.broker.records[i]; same(b.request, e.request); assert.equal(e.id, i + 1); assert.equal(b.id, e.id);
    assert.equal(e.status, 'received'); assert.equal(e.verification, 'verified'); assert.equal(sha(JSON.stringify(e.result)), e.resultSha256); assert.equal(b.resultSha256, e.resultSha256);
    const found = localWires.filter(w => w.request.method === e.request.method && JSON.stringify(w.request.params) === JSON.stringify(e.request.params));
    assert(found.some(w => JSON.stringify(w.response.result) === JSON.stringify(e.result)), 'Initial fact is absent from actual retained response');
    same(e.request.params.at(-1), selector);
    if (e.request.method === 'eth_getProof') { const leaf = accountProof(header, e.result); accountLeaves.set(e.result.address, leaf); }
  }
  for (const p of initial.provenance) {
    const a = initial.accounts[p.account], leaf = accountLeaves.get(p.account); assert(a.exists && leaf);
    assert.equal(BigInt(a.nonce), leaf.nonce); assert.equal(BigInt(a.balance), leaf.balance); assert.equal(hex(keccak(bytes(a.code))), leaf.codeHash);
    assert.equal(p.accountProof.codeHash, leaf.codeHash); assert.equal(p.accountProof.storageRoot, leaf.storageRoot);
    const codeRow = original.inputEvidence[p.codeEvidenceId - 1]; assert.equal(codeRow.result, a.code);
    for (const s of p.storage) {
      const e = original.inputEvidence[s.evidenceId - 1], proven = e.result.storageProof.find(r => word(r.key) === s.key); assert(proven);
      assert.equal(word(proven.value), a.storage[s.key]); assert.equal(s.value, a.storage[s.key]);
    }
  }
  const sender = initial.accounts[d.request.from]; assert.match(sender.code, /^0xef0100[0-9a-f]{40}$/);
  const delegation = '0x' + sender.code.slice(8); same(output.semantics.senderDelegation, { address: delegation, authorizationListProcessed: false });
  const trace = oracleWires[1].response.result, diff = oracleWires[2].response.result;
  same([trace.from, trace.to, trace.input, trace.value, trace.gas], [d.request.from, d.request.to, d.request.data, '0x0', '0x4c4b40']); assert(!trace.calls?.length);
  assert(!output.trace.calls.length); same([output.trace.from, output.trace.to, output.trace.input], [d.request.from, d.request.to, d.request.data]);
  const status = trace.error === undefined ? 'success' : trace.error === 'invalid opcode: INVALID' ? 'failed' : null; assert(status, 'Unreviewed exception');
  if (status === 'failed') assert.equal(output.execution.error, 'invalid opcode'); else assert.equal(output.execution.error, null);
  const localLogs = output.logs.map(({ address, topics, data }) => ({ address, topics, data }));
  const referenceLogs = (trace.logs ?? []).map(({ address, topics, data, position, index }, i) => { assert.equal(BigInt(position), 0n); assert.equal(BigInt(index), BigInt(i)); return { address, topics, data }; });
  const data = bytes(d.request.data), zeros = [...data].filter(b => b === 0).length, nonzeros = data.length - zeros;
  const intrinsic = 21000n + 4n * BigInt(zeros) + 16n * BigInt(nonzeros), floor = 21000n + 10n * BigInt(zeros + 4 * nonzeros);
  const before = intrinsic + BigInt(output.execution.executionGasUsed), counter = BigInt(output.execution.gasRefundCounter), refund = counter < before / 5n ? counter : before / 5n;
  const paid = before - refund > floor ? before - refund : floor;
  same(output.gasAccounting, { beforeRefund: String(before), appliedRefund: String(refund), floorAdjustment: String(paid - (before - refund)), gasUsed: String(paid) });
  assert.equal(BigInt(output.trace.gas), 5000000n - intrinsic); assert.equal(BigInt(output.trace.gasUsed), BigInt(output.execution.executionGasUsed));
  const localState = normalizedLocal(original.changes, initial), oracleState = normalizedOracle(diff, initial);
  const channels = { executionStatus: output.execution.status === status, returnData: output.execution.returnData === (trace.output ?? '0x'),
    committedLogs: JSON.stringify(localLogs) === JSON.stringify(referenceLogs), gasAccounting: paid === BigInt(trace.gasUsed), fullObservedStateChanges: JSON.stringify(localState) === JSON.stringify(oracleState) };
  assert(Object.values(channels).every(Boolean));
  const queries = report.measurements.map(q => ({ account: q.identity.account, status: q.status, ...q.values[0], independentlyCompared: false }));
  cases.push({ id: d.id, transactionHashProvenanceOnly: d.transactionHash, sender: d.request.from, delegation, senderNonceBefore: sender.nonce,
    requestedTokenRaw: BigInt('0x' + d.request.data.slice(-64)).toString(), localStatus: output.execution.status, providerError: trace.error ?? null, localError: output.execution.error,
    returnData: output.execution.returnData, calldataBytes: data.length, intrinsic: String(intrinsic), floor: String(floor), messageGas: output.execution.executionGasUsed, refundCounter: String(counter), chargedGas: String(paid),
    channels, logCount: localLogs.length, logs: localLogs, state: localState, inputEvidence: original.inputEvidence.length, provenAccounts: initial.provenance.length,
    localQueriesOnly: queries, frozenStatusAliasCovered: trace.error !== 'invalid opcode: INVALID' });
}
assert.equal(nativeCalls, results.totalNetworkCalls); assert.equal(nativeBytes, results.totalNetworkBytes);
const comparisonFile = path.join(work, 'comparison-first.json'), frozenComparison = JSON.parse(fs.readFileSync(comparisonFile));
assert.equal(sha(fs.readFileSync(comparisonFile)), '17e888ea19e0d158986b5728a12e49ef4c11113257cc2e033a1505f90226edf6');
same(frozenComparison.counts, { matched: 9, mismatched: 0, unavailable: 1 });
same(checkManifest('', pins.manifest), inventory);
const output = { status: 'pass', checkerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), pins, inventory, runtimeEntries: plan.files.length,
  selectedHeader: { number: BigInt(header.number).toString(), hash: header.hash, stateRoot: header.stateRoot, timestamp: BigInt(header.timestamp).toString(), independentlyRehashed: true },
  processSummary, nativeCalls, nativeBytes, proofWalks, cases, independentlyAgreedChannels: 10,
  frozenComparison: { path: 'comparison-first.json', sha256: sha(fs.readFileSync(comparisonFile)), summary: frozenComparison.summary ?? frozenComparison.counts ?? null },
  interpretation: 'Both retained observations agree semantically on these ten channels. The frozen comparator does not recognize invalid opcode: INVALID; its original unavailable classification is not replaced by this audit.',
  limitations: ['Selected two-call experiment, not a random accuracy estimate.', 'No VM, RPC or reference rerun; independent arithmetic/shape/proof checks do not independently execute bytecode.',
    'RLP and Keccak primitives are shared libraries; the MPT walk, gas arithmetic and sparse-state normalization here do not import product/comparator helpers.',
    'Sparse observed net state only, no complete final state root or complete asset inventory.', 'Local balance queries have no independent reference queries and are excluded from ten channels.',
    'The two execution paths share dRPC infrastructure; authenticated state roots do not establish consensus/finality or provider execution attestation.',
    'Unsigned unpriced 5M-gas calls at one selected block end; historical transaction hashes are provenance, not exact signed transaction replay.',
    'API/outer-worker implementation inventory matches the frozen source; nested isolation explicitly reports sourceImplementationBound:false, so this is not per-process code attestation.',
    'Direct worker closure and recorded cleanup signalling are observed, not independent OS process-tree attestation.'] };
console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message, stack: error.stack } }, null, 2));
  process.exitCode = 1;
}
