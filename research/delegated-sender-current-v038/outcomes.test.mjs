// Fabricated adapter observations over real synthetic MPT proofs. These tests
// execute no EVM, API or network and are not client-agreement evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createMPT, createMerkleProof } from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { createRpcStateInputs } from '../../engines/local-evm/rpc-state-inputs.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { costs, oracleRequests } from '../ordinary-local-coverage-v1/outcomes.mjs';
import { compareCase, CHANNELS } from './outcomes.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const hex = x => '0x' + Buffer.from(x).toString('hex');
const bytes = x => Uint8Array.from(Buffer.from(x.slice(2), 'hex'));
const integer = n => n === 0n ? new Uint8Array() : bytes('0x' + n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'));
const qty = n => '0x' + BigInt(n).toString(16);
const clone = x => structuredClone(x);
const DELEGATE = '0x' + '77'.repeat(20), DESIGNATION = '0xef0100' + DELEGATE.slice(2);
const ORDER = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const NUMERIC = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
const limits = { calls: 260, responseBytes: 8388608, totalBytes: 33554432, wallMs: 145000, requestMs: 25000 };
const identity = () => {
  const inventory = [{ path: 'synthetic-adapter-control.js', kind: 'file', bytes: 0, mode: 420, sha256: sha('') }];
  const runtime = { node: 'v22.synthetic', v8: 'synthetic', platform: 'synthetic', arch: 'synthetic', executableBytes: 1, executableSha256: 'b'.repeat(64) };
  return { name: 'Transaction Lab isolated proof-backed Ethereum preview', version: 'synthetic-control', sourceSha256: sha(JSON.stringify({ files: inventory, runtime })),
    sourceFiles: inventory.map(r => r.path), inventory, runtime, runtimePatches: [{ id: 'synthetic-control-not-an-actual-runtime' }],
    identityAlgorithm: 'SHA256(JSON.stringify({files:sorted_complete_inventory,runtime:node_executable_identity}))' };
};
function apiWire(id, method, params, result) {
  const request = { jsonrpc: '2.0', id, method, params }, requestText = JSON.stringify(request), responseText = JSON.stringify({ jsonrpc: '2.0', id, result });
  return { id, provider: 'eth.drpc.org', request, requestText, requestBytes: Buffer.byteLength(requestText), requestSha256: sha(requestText), status: 'completed', dispatched: true, httpStatus: 200, responseText,
    transport: { complete: true, bodyRetained: true, observedBytes: Buffer.byteLength(responseText), retainedPrefixBytes: Buffer.byteLength(responseText), responseSha256: sha(responseText) } };
}
function oracleWire(id, p, result) {
  const w = apiWire(id, p.method, p.params, result), raw = Buffer.from(w.responseText);
  return { ...w, globalId: id, provider: 'drpc', profile: 'product', url: 'https://eth.drpc.org/', startedAt: '2026-01-01T00:00:00.000Z', rawBase64: raw.toString('base64'), parsed: JSON.parse(w.responseText),
    transport: { complete: true, observedBytes: raw.length, retainedBytes: raw.length, observedSha256: sha(raw), retainedSha256: sha(raw), durationMs: 1 } };
}
function reviseOracle(f, index, edit) {
  const w = f.oracle.records[index], response = clone(w.parsed.result); edit(response);
  f.oracle.records[index] = oracleWire(w.id, w.request, response);
}
async function specimen({ index = '002', code = DESIGNATION, absent = false } = {}) {
  const saved = JSON.parse(readFileSync(new URL(`../../reports/ordinary-local-coverage-v1/cases/${index}/request.json`, import.meta.url)));
  const request = clone(saved.projection.request), header = clone(saved.parentHeader);
  const trie = await createMPT({ useKeyHashing: true }), empty = (await createMPT({ useKeyHashing: true })).root();
  const accounts = new Map([[request.to, { nonce: 1n, balance: 0n, code: '0x00' }]]);
  if (!absent) accounts.set(request.from, { nonce: 1n, balance: 1000000n, code });
  for (const [address, a] of accounts) await trie.put(bytes(address), RLP.encode([integer(a.nonce), integer(a.balance), empty, keccak_256(bytes(a.code))]));
  header.stateRoot = hex(trie.root());
  header.hash = hex(keccak_256(RLP.encode(ORDER.filter(k => header[k] !== undefined).map(k => NUMERIC.has(k) ? integer(BigInt(header[k])) : bytes(header[k])))));
  const verified = verifyEthereumHeader({ header, expectedHash: header.hash });
  const inputs = createRpcStateInputs({ chainId: 1, blockHash: header.hash, header, rpc: { async call(method, params) {
    const [address] = params, a = accounts.get(address);
    if (method === 'eth_getCode') return a?.code ?? '0x';
    assert.equal(method, 'eth_getProof'); assert.deepEqual(params[1], []);
    return { address, accountProof: (await createMerkleProof(trie, bytes(address))).filter((n, i) => i === 0 || n.length >= 32).map(hex),
      nonce: qty(a?.nonce ?? 0n), balance: qty(a?.balance ?? 0n), codeHash: hex(keccak_256(bytes(a?.code ?? '0x'))), storageHash: hex(empty), storageProof: [] };
  } } });
  await inputs.getAccount(request.from); await inputs.getAccount(request.to);
  const c = costs(request, header), charged = c.floor > c.intrinsic ? c.floor : c.intrinsic;
  const output = { execution: { status: 'success', executionGasUsed: '0', gasRefundCounter: '0', returnData: '0x', error: null },
    trace: { type: 'CALL', from: request.from, caller: request.from, to: request.to, executionAddress: request.to, input: request.data, value: '0x0', gas: qty(5000000n - c.intrinsic), gasUsed: '0x0', output: '0x', error: null, depth: 0, calls: [] },
    logs: [], semantics: { senderDelegation: { address: DELEGATE, authorizationListProcessed: false }, callerNonce: 'runCall_increment_and_committed_sender_creation_attempts' },
    stateDisposition: 'message_result_retained_in_supplied_manager',
    environment: { chainId: 1, hardfork: c.hardfork, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString(), gasLimit: BigInt(header.gasLimit).toString(), baseFeePerGas: '0', mixHash: header.mixHash, miner: header.miner, sourceBlockHash: header.hash, sourceParentHash: header.parentHash, sourceBlockIdentityVerified: false },
    profile: { name: 'ethereum_unsigned_unpriced_call', chainId: 1, hardfork: c.hardfork, forkSchedule: 'pinned_ethereumjs_common_10.1.3_mainnet', sourceBlockHash: header.hash, sourceStateRoot: header.stateRoot,
      sourceBlockIdentityVerified: false, sourceStateProofVerified: false, actualBlockBaseFee: BigInt(header.baseFeePerGas).toString(), executionBaseFee: '0', gasPrice: '0', declaredGasLimit: '5000000', intrinsicGas: c.intrinsic.toString(), calldataFloor: c.floor.toString(), messageGasLimit: (5000000n - c.intrinsic).toString(),
      calldataZeroBytes: c.zero.toString(), calldataNonzeroBytes: c.nonzero.toString(), outerSignatureVerified: false, feesSettled: false, originalTransactionPosition: false, expectedOutputsUsed: false,
      accessList: [], accessListAddressCount: '0', accessListStorageKeyCount: '0', accessListIntrinsicGas: '0' },
    gasAccounting: { beforeRefund: c.intrinsic.toString(), appliedRefund: '0', floorAdjustment: (charged - c.intrinsic).toString(), gasUsed: charged.toString() } };
  const original = { output, changes: { scope: 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.', accounts: [{ address: request.from, nonce: { before: '0x1', after: '0x2' } }] }, inputs: inputs.snapshotInputs(), inputEvidence: inputs.snapshotEvidence() };
  const broker = { calls: original.inputEvidence.length, records: original.inputEvidence.map(e => ({ id: e.id, request: e.request, status: 'received', dispatched: true, resultBytes: e.resultBytes, resultSha256: e.resultSha256 })), pendingAtReturn: 0 };
  const transportEvidence = [apiWire(1, 'eth_chainId', [], '0x1'), apiWire(2, 'eth_getBlockByHash', [header.hash, false], header),
    ...original.inputEvidence.map((e, i) => apiWire(i + 3, e.request.method, e.request.params, e.result))];
  transportEvidence.push(apiWire(transportEvidence.length + 1, 'eth_getBlockByNumber', [qty(header.number), false], header));
  const recipient = '0x' + request.data.slice(34, 74), queries = [request.from, recipient].map(a => ({ to: request.to, data: '0x70a08231' + a.slice(2).padStart(64, '0') }));
  const localInput = { chainId: 1, ...request, block: header.hash, queries };
  const expectedImplementation = identity();
  const localReport = { kind: 'local_proof_preview', schemaVersion: '1.0', apiRequest: localInput, status: 'partial', error: null, execution: output.execution, measurements: [],
    source: { kind: 'proof_backed_owned_execution', profile: 'unsigned_unpriced_block_end', canonicalStatus: 'verified', consensusVerified: false, originalTransactionReplay: false,
      blockSelection: { requested: header.hash, kind: 'pinned_hash', blockHash: header.hash, blockNumber: BigInt(header.number).toString(), headerVerification: verified, header } },
    implementation: expectedImplementation, transportEvidence,
    attempt: { status: 'completed', headerVerification: verified, preview: { status: 'partial', error: null, headerVerification: verified, original, inputs: { deliberately: 'not used for original comparison' }, inputEvidence: [] }, broker,
      isolation: { processSeparated: true, processClosed: true, childPid: 123, exitCode: 0, exitSignal: null, durationMs: 1, wallMs: 10000, drainMs: 1000 } },
    drain: { complete: true, pending: 0, adapterPending: 0, durationMs: 0, timeoutMs: 25000 },
    usage: { calls: transportEvidence.length, dispatched: transportEvidence.length, observedBytes: 100000, retainedBytes: 100000, successfulResponseBytes: 100000, elapsedMs: 100, remainingWallMs: 144900, pending: 0, adapterPending: 0, clockValid: true, cancelled: true, cancellationCode: 'RPC_CANCELLED', pinnedBlockHash: header.hash, limits }, timing: { totalMs: 100 } };
  const p = oracleRequests({ request, header });
  const values = [header, { type: 'CALL', from: request.from, to: request.to, input: request.data, value: '0x0', gas: '0x4c4b40', gasUsed: qty(charged), output: '0x' },
    { pre: { [request.from]: { nonce: 1 } }, post: { [request.from]: { nonce: 2 } } }, header];
  return { declaration: { id: 'delegated-usdt-' + index, originalCaseId: index, transactionHash: saved.transactionHash, request, header, localInput }, localReport,
    expectedImplementation, oracle: { dispatch: 'completed', records: p.map((v, i) => oracleWire(i + 1, v, values[i])) } };
}
const unavailable = r => { assert.equal(r.allChannelsComplete, false); assert.equal(r.outcome.comparison, 'not_comparable'); assert.deepEqual(Object.keys(r.channels), CHANNELS); assert(Object.values(r.channels).every(c => c.status === 'unavailable'), JSON.stringify(r)); };

test('two synthetic proof-bound API originals retain exactly five channels each, without invoking execution', async () => {
  for (const index of ['002', '015']) {
    const f = await specimen({ index }), before = clone(f), r = await compareCase(f);
    assert.equal(r.delegation.status, 'verified_existing_delegation'); assert.equal(r.delegation.target, DELEGATE);
    assert.equal(r.outcome.comparison, 'match', JSON.stringify(r)); assert.equal(r.allChannelsComplete, true);
    assert.equal(Object.values(r.channels).filter(c => c.status === 'match').length, 5); assert.deepEqual(f, before);
    assert.equal(r.scope.queryMeasurementsCompared, false); assert.equal(r.scope.fullPoststateRootCompared, false);
  }
});

test('valid raw disagreements remain mismatches in each applicable original channel', async () => {
  const base = await specimen();
  for (const [channel, change] of [
    ['executionStatus', r => { r.error = 'execution reverted'; }],
    ['returnData', r => { r.output = '0x01'; }],
    ['gasAccounting', r => { r.gasUsed = qty(BigInt(r.gasUsed) + 1n); }],
    ['committedLogs', r => { r.logs = [{ address: base.declaration.request.to, topics: [], data: '0x01' }]; }],
  ]) {
    const f = clone(base); reviseOracle(f, 1, change); const r = await compareCase(f);
    assert.equal(r.channels[channel].status, 'mismatch', JSON.stringify(r)); assert.equal(r.outcome.comparison, 'mismatch');
  }
  const f = clone(base); reviseOracle(f, 2, r => { r.post[f.declaration.request.from].nonce = 3; });
  assert.equal((await compareCase(f)).channels.fullObservedStateChanges.status, 'mismatch');
});

test('proof-verified empty, absent and non-designation senders are changed_sender, never delegated coverage', async () => {
  for (const args of [{ code: '0x' }, { absent: true }, { code: '0x00' }, { code: '0xef0100' }, { code: DESIGNATION + '00' }]) {
    const r = await compareCase(await specimen(args)); unavailable(r); assert.equal(r.delegation.status, 'changed_sender'); assert.equal(r.delegation.proofVerified, true);
  }
});

test('forged delegation metadata, nonce changes and invalid sender proofs cannot become matches', async () => {
  const base = await specimen();
  for (const mutate of [
    f => { f.localReport.attempt.preview.original.output.semantics.senderDelegation.address = '0x' + '99'.repeat(20); },
    f => { f.localReport.attempt.preview.original.output.semantics.senderDelegation.authorizationListProcessed = true; },
    f => { f.localReport.attempt.preview.original.output.semantics.callerNonce = 'runCall_increments_once_including_EVM_revert'; },
    f => { f.localReport.attempt.preview.original.changes.accounts[0].nonce.after = '0x3'; },
    f => { f.localReport.attempt.preview.original.inputs.accounts[f.declaration.request.from].code = '0x'; },
    f => { f.localReport.attempt.preview.original.inputs.provenance[0].accountProof.codeHash = '0x' + '00'.repeat(32); },
  ]) { const f = clone(base); mutate(f); unavailable(await compareCase(f)); }
});

test('canonical API/source/drain/child gates reject withheld and contradictory reports without audit fallback', async () => {
  const base = await specimen();
  for (const mutate of [
    f => { f.localReport.status = 'unavailable'; f.localReport.audit = { original: f.localReport.attempt.preview.original }; },
    f => { f.localReport.attempt.preview = null; f.localReport.audit = base.localReport.attempt.preview; },
    f => { f.localReport.source.canonicalStatus = 'unverified'; },
    f => { f.localReport.source.blockSelection.blockNumber = '1'; },
    f => { f.localReport.drain.complete = false; },
    f => { f.localReport.usage.adapterPending = 1; },
    f => { f.localReport.attempt.broker.pendingAtReturn = 1; },
    f => { f.localReport.attempt.isolation.childPid = null; },
    f => { f.localReport.attempt.isolation.processClosed = false; },
    f => { f.localReport.implementation = { ...f.localReport.implementation, runtimePatches: [] }; },
    f => { f.expectedImplementation = { ...f.expectedImplementation, sourceSha256: '0'.repeat(64) }; f.localReport.implementation = f.expectedImplementation; },
    f => { f.localReport.execution = { status: 'success' }; },
    f => { f.localReport.error = { code: 'LOCAL_PREVIEW_INTEGRITY' }; f.localReport.attempt.preview.error = f.localReport.error; },
  ]) { const f = clone(base); mutate(f); unavailable(await compareCase(f)); }
});

test('API requests, query identities and original broker/raw response prefix are bound exactly', async () => {
  const base = await specimen();
  for (const mutate of [
    f => { f.localReport.apiRequest = { ...f.localReport.apiRequest, gas: '4999999' }; },
    f => { f.declaration.localInput.queries[1].data = f.declaration.localInput.queries[0].data; },
    f => { f.declaration.request.authorizationList = []; },
    f => { f.localReport.attempt.broker.records[0].resultSha256 = '0'.repeat(64); },
    f => { f.localReport.transportEvidence[2].responseText += ' '; },
    f => { f.localReport.transportEvidence.at(-1).responseText = '{}'; },
    f => { f.localReport.attempt.preview.original.inputEvidence = []; },
  ]) { const f = clone(base); mutate(f); unavailable(await compareCase(f)); }
});

test('query failure and additional query input suffix do not replace the original snapshot or add comparison channels', async () => {
  const f = await specimen(), report = f.localReport, wires = report.transportEvidence, last = wires.pop();
  const p = { method: 'eth_getCode', params: [DELEGATE, { blockHash: f.declaration.header.hash, requireCanonical: true }] };
  wires.push(apiWire(wires.length + 1, p.method, p.params, '0x00'));
  wires.push(apiWire(wires.length + 1, last.request.method, last.request.params, f.declaration.header));
  report.usage.calls++; report.usage.dispatched++; report.attempt.broker.calls++;
  report.attempt.broker.records.push({ id: report.attempt.broker.calls, request: p, status: 'received', dispatched: true, resultSha256: sha(JSON.stringify('0x00')), resultBytes: 6 });
  report.attempt.preview.inputs = { status: 'unavailable', accounts: { [f.declaration.request.from]: { code: '0x' } } };
  report.attempt.preview.measurements = [{ status: 'unavailable' }]; report.measurements = [{ status: 'unavailable' }];
  const r = await compareCase(f); assert.equal(r.outcome.comparison, 'match', JSON.stringify(r)); assert.equal(Object.keys(r.channels).length, 5);
});

test('missing and wrong-context raw oracle evidence preserve the five-channel unavailable denominator', async () => {
  const base = await specimen();
  for (const oracle of [{ dispatch: 'budget_unattempted', records: [] }, { dispatch: 'unavailable', records: [] }]) {
    const r = await compareCase({ ...clone(base), oracle }); assert.equal(r.delegation.status, 'verified_existing_delegation');
    assert.equal(Object.values(r.channels).filter(c => c.status === 'unavailable').length, 5); assert.equal(r.allChannelsComplete, false);
  }
  const f = clone(base), w = f.oracle.records[1], p = clone(w.request); p.params[0].gas = '0x1'; f.oracle.records[1] = oracleWire(w.id, p, w.parsed.result);
  const r = await compareCase(f); assert.equal(r.outcome.comparison, 'oracle_unavailable');
  assert.equal(Object.values(r.channels).filter(c => c.status === 'unavailable').length, 5); assert.equal(r.allChannelsComplete, false);
});

test('accessors are rejected without execution or mutation of caller-owned evidence', async () => {
  const f = await specimen(); let reads = 0;
  Object.defineProperty(f.localReport, 'status', { enumerable: true, get() { reads++; return 'partial'; } });
  unavailable(await compareCase(f)); assert.equal(reads, 0);
});
