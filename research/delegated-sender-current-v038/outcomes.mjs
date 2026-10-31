// Saved guarded-API evidence only. No API invocation, VM, transport or replay.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { CHANNELS, adjudicateLocalOutcome } from '../ordinary-local-coverage-v1/outcomes.mjs';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { validateInputFacts } from '../../engines/local-evm/input-facts.js';
import { ethereumCommon } from '../../engines/local-evm/ethereum-profile.js';
import { existingDelegationTarget } from '../../engines/local-evm/sender-delegation.js';
import { encode, decode } from '../../engines/local-evm/isolated-protocol.js';
export { CHANNELS };

const SHA = /^[0-9a-f]{64}$/, WORD = /^0x[0-9a-f]{64}$/;
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const MAX_BYTES = 96 * 1024 * 1024;
const sha = x => createHash('sha256').update(x).digest('hex');
const own = (v, k) => Object.hasOwn(v, k);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = v => Number.isSafeInteger(v) && v >= 0;
class EvidenceError extends Error {}
const need = (ok, why) => { if (!ok) throw new EvidenceError(why); };
const same = (a, b, why) => need(equal(a, b), why);
const projection = identity => Object.fromEntries(['name', 'version', 'sourceSha256', 'sourceFiles'].map(k => [k, identity[k]]));
const identityAlgorithm = 'SHA256(JSON.stringify({files:sorted_complete_inventory,runtime:node_executable_identity}))';
const limits = { calls: 260, responseBytes: 8388608, totalBytes: 33554432, wallMs: 145000, requestMs: 25000 };
const SCOPE = Object.freeze({ evaluatedProduct: 'guarded_simulateLocal_API_original', oracle: 'remote_native_trace_and_sparse_diff',
  queryMeasurementsCompared: false, originalTransactionReplay: false, feeSettlement: false,
  authorizationListProcessed: false, fullPoststateRootCompared: false, fullCallTreeEquality: false,
  independentConsensus: false, providerContextExecutionAttested: false, sharedProviderInfrastructure: true,
  rawWireAndArchiveAuthenticity: 'requires_outer_saved_packet_adjudication',
  parentValidationAndProofVerifierSharedWithProduct: true });

function fullIdentity(actual, expected) {
  need(plain(expected) && plain(actual), 'Full guarded API implementation identity is missing');
  same(actual, expected, 'API implementation differs from the frozen guarded loader');
  need(expected.name === 'Transaction Lab isolated proof-backed Ethereum preview' && typeof expected.version === 'string' && expected.version.length > 0,
    'Guarded loader identity has the wrong adapter');
  need(expected.identityAlgorithm === identityAlgorithm && SHA.test(expected.sourceSha256), 'Guarded loader identity algorithm differs');
  need(Array.isArray(expected.inventory) && expected.inventory.length > 0 && expected.inventory.length <= 10000 && plain(expected.runtime), 'Complete source/runtime inventory missing');
  same(expected.sourceFiles, expected.inventory.map(r => r.path), 'Source paths differ from the complete inventory');
  same(expected.sourceFiles, [...new Set(expected.sourceFiles)].sort(), 'Ambiguous source paths');
  for (const row of expected.inventory) {
    need(typeof row.path === 'string' && row.path.length <= 1024 && !row.path.startsWith('/') && !row.path.includes('\\') && !row.path.includes('\0') &&
      row.path.split('/').every(p => p && p !== '.' && p !== '..'), 'Noncanonical source path');
    need(row.kind === 'file' ? integer(row.bytes) && integer(row.mode) && SHA.test(row.sha256) : row.kind === 'symlink' && typeof row.target === 'string', 'Source inventory row missing identity');
  }
  need(SHA.test(expected.runtime.executableSha256) && integer(expected.runtime.executableBytes) && expected.runtime.executableBytes > 0 &&
    typeof expected.runtime.node === 'string' && typeof expected.runtime.v8 === 'string', 'Node runtime identity is missing');
  need(Array.isArray(expected.runtimePatches) && expected.runtimePatches.length > 0 && expected.runtimePatches.every(p => plain(p) && typeof p.id === 'string'), 'Runtime patch identity missing');
  need(sha(JSON.stringify({ files: expected.inventory, runtime: expected.runtime })) === expected.sourceSha256, 'Loader inventory digest differs');
}

function declarationBinding(d) {
  need(plain(d) && ['002', '015'].includes(d.originalCaseId) && d.id === 'delegated-usdt-' + d.originalCaseId && WORD.test(d.transactionHash), 'Fixed declaration identity missing');
  const r = d.request;
  need(plain(r), 'Original request missing');
  same(Object.keys(r).sort(), ['accessList', 'data', 'from', 'gas', 'to', 'value'], 'Original request has extra context or pricing');
  need(/^0x[0-9a-f]{40}$/.test(r.from) && r.to === USDT && /^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/.test(r.data) && r.value === '0' && r.gas === '5000000', 'Original call is outside the fixed USDT profile');
  same(r.accessList, [], 'Original access list differs');
  const recipient = '0x' + r.data.slice(34, 74);
  const queries = [r.from, recipient].map(a => ({ to: USDT, data: '0x70a08231' + a.slice(2).padStart(64, '0') }));
  same(d.localInput, { chainId: 1, ...r, block: d.header.hash, queries }, 'API input/query identities differ from the declared original');
  return verifyEthereumHeader({ header: d.header, expectedHash: d.header.hash, chainId: 1 });
}

function apiClosure(report, header) {
  const d = report.drain, u = report.usage, a = report.attempt, i = a?.isolation;
  need(d?.complete === true && d.pending === 0 && d.adapterPending === 0 && finite(d.durationMs) && finite(d.timeoutMs) && d.timeoutMs > 0 && d.timeoutMs <= 25000 && d.durationMs <= d.timeoutMs, 'API RPC drainage is not complete');
  need(u?.pending === 0 && u.adapterPending === 0 && u.clockValid === true && u.cancelled === true && u.cancellationCode === 'RPC_CANCELLED' && u.pinnedBlockHash === header.hash, 'API RPC terminal state differs');
  need(plain(u.limits) && equal(Object.keys(u.limits).sort(), Object.keys(limits).sort()), 'API RPC limits missing');
  for (const [key, cap] of Object.entries(limits)) need(integer(u.limits[key]) && u.limits[key] > 0 && u.limits[key] <= cap, 'API RPC limits exceed the fixed ceiling');
  need(integer(u.calls) && u.calls <= u.limits.calls && integer(u.dispatched) && u.dispatched <= u.calls &&
    integer(u.observedBytes) && u.observedBytes <= u.limits.totalBytes && integer(u.retainedBytes) && u.retainedBytes <= u.observedBytes &&
    integer(u.successfulResponseBytes) && u.successfulResponseBytes <= u.retainedBytes && finite(u.elapsedMs) && finite(u.remainingWallMs) && u.remainingWallMs > 0 &&
    u.elapsedMs < u.limits.wallMs && Math.abs(u.remainingWallMs - (u.limits.wallMs - u.elapsedMs)) < 0.000001, 'API RPC usage exceeds its fixed budget');
  need(finite(report.timing?.totalMs) && report.timing.totalMs <= 170000, 'API terminal timing is unavailable');
  need(i?.processSeparated === true && i.processClosed === true && Number.isSafeInteger(i.childPid) && i.childPid > 0 && i.exitCode === 0 && i.exitSignal === null &&
    finite(i.durationMs) && finite(i.wallMs) && i.wallMs > 0 && i.wallMs <= 145000 && finite(i.drainMs) && i.drainMs <= 25000 && i.durationMs <= i.wallMs + i.drainMs,
    'Isolated child did not demonstrably complete');
  need(a.broker?.pendingAtReturn === 0 && Array.isArray(a.broker.records) && a.broker.records.length <= 256 && a.broker.calls === a.broker.records.length, 'Input broker did not complete/drain');
}

// The API has chain/header calls outside the broker and a legitimate query
// suffix. Bind the original evidence prefix, not the final query snapshot.
function originalTransport(report, original, header) {
  const wires = report.transportEvidence, broker = report.attempt.broker.records;
  need(Array.isArray(wires) && wires.length === report.usage.calls && wires.length >= 3 && wires.length <= 260, 'API wire inventory differs');
  const parsed = wires.map((w, index) => {
    need(w.id === index + 1 && w.provider === 'eth.drpc.org' && w.request?.id === w.id && w.request.jsonrpc === '2.0' && w.requestText === JSON.stringify(w.request) &&
      w.requestBytes === Buffer.byteLength(w.requestText) && w.requestSha256 === sha(w.requestText), 'API RPC request bytes/identity differ');
    if (w.status !== 'completed') return null;
    need(w.dispatched === true && w.httpStatus >= 200 && w.httpStatus < 300 && w.transport?.complete === true && w.transport.bodyRetained === true && typeof w.responseText === 'string', 'Completed API response is not retained');
    const bytes = Buffer.from(w.responseText);
    need(w.transport.observedBytes === bytes.length && w.transport.retainedPrefixBytes === bytes.length && w.transport.responseSha256 === sha(bytes), 'API response bytes/hash differ');
    const p = JSON.parse(w.responseText);
    need(p.jsonrpc === '2.0' && p.id === w.id && own(p, 'result') && !own(p, 'error'), 'API response envelope differs');
    return p.result;
  });
  const at = (n, method, params, result) => {
    need(wires[n]?.status === 'completed' && wires[n].request.method === method, 'API canonical header bracket is incomplete');
    same(wires[n].request.params, params, 'API canonical request differs'); same(parsed[n], result, 'API canonical response differs');
  };
  at(0, 'eth_chainId', [], '0x1'); at(1, 'eth_getBlockByHash', [header.hash, false], header);
  at(wires.length - 1, 'eth_getBlockByNumber', ['0x' + BigInt(header.number).toString(16), false], header);
  need(Array.isArray(original.inputEvidence) && original.inputEvidence.length <= broker.length, 'Original evidence is not a broker prefix');
  let previous = 1;
  for (const [index, e] of original.inputEvidence.entries()) {
    const b = broker[index];
    need(e.id === index + 1 && b?.id === e.id, 'Original broker evidence order differs');
    same(b.request, e.request, 'Original broker request differs');
    if (e.status !== 'received') { need(b.status !== 'received', 'Original failed read contradicts broker'); continue; }
    const encoded = JSON.stringify(e.result);
    need(b.status === 'received' && b.dispatched === true && e.resultSha256 === sha(encoded) && e.resultBytes === Buffer.byteLength(encoded) && b.resultSha256 === e.resultSha256 && b.resultBytes === e.resultBytes,
      'Original proof result differs from broker bytes');
    const found = wires.findIndex((w, n) => n > previous && n < wires.length - 1 && w.status === 'completed' && w.request.method === e.request.method && equal(w.request.params, e.request.params) && equal(parsed[n], e.result));
    need(found >= 0, 'Original proof result does not join an ordered retained API response'); previous = found;
  }
}

function unavailable(transactionHash, why, delegation) {
  return { delegation, outcome: { transactionHash: WORD.test(transactionHash) ? transactionHash : null, execution: 'provider_unavailable', comparison: 'not_comparable' },
    channels: Object.fromEntries(CHANNELS.map(k => [k, { status: 'unavailable', reason: why }])), reasons: [why], allChannelsComplete: false, evidence: {}, scope: SCOPE };
}

/** The expected implementation is an externally frozen guarded-loader identity.
 * This function does not establish archive/raw-wire authenticity by itself. */
export async function compareCase(options) {
  let declaration, delegation = { status: 'unavailable', target: null, proofVerified: false };
  try {
    // Reject getters/proxies and snapshot all data before asynchronous proof work.
    const snapshot = decode(encode(options, MAX_BYTES), MAX_BYTES);
    ({ declaration } = snapshot);
    const { localReport: report, oracle, expectedImplementation } = snapshot;
    const verified = declarationBinding(declaration), { request, header } = declaration;
    fullIdentity(report?.implementation, expectedImplementation);
    need(report.kind === 'local_proof_preview' && report.schemaVersion === '1.0' && ['complete', 'partial'].includes(report.status), 'Guarded API result is unavailable; audit fallback is excluded');
    same(report.apiRequest, declaration.localInput, 'API report is for a different request');
    need(report.source?.kind === 'proof_backed_owned_execution' && report.source.profile === 'unsigned_unpriced_block_end' && report.source.canonicalStatus === 'verified' &&
      report.source.consensusVerified === false && report.source.originalTransactionReplay === false, 'API source/canonical status is not verified');
    same(report.source.blockSelection, { requested: header.hash, kind: 'pinned_hash', blockHash: header.hash, blockNumber: BigInt(header.number).toString(), headerVerification: verified, header }, 'API selected header differs');
    need(report.attempt?.status === 'completed' && ['complete', 'partial'].includes(report.attempt.preview?.status), 'API did not retain a completed preview');
    same(report.status, report.attempt.preview.status, 'API preview status contradicts its projection');
    same(report.error, report.attempt.preview.error, 'API preview error contradicts its projection');
    need(report.error === null, 'Usable API report retains an integrity error');
    same(report.attempt.headerVerification, verified, 'Isolated header verification differs');
    same(report.attempt.preview.headerVerification, verified, 'Preview header verification differs');
    apiClosure(report, header);
    const original = report.attempt.preview.original;
    need(plain(original) && plain(original.output) && plain(original.inputs), 'Original snapshot is missing');
    same(report.execution, original.output.execution, 'API execution projection differs from the original');
    need(original.inputs.status === 'available' && original.inputs.context?.expectedOutputsUsed === false && original.inputs.context.blockHash === header.hash && original.inputs.context.stateRoot === header.stateRoot,
      'Original initial state is unavailable or for a different header');
    same(original.inputs.context.header, header, 'Original full header differs');
    originalTransport(report, original, header);
    await validateInputFacts({ inputs: original.inputs, inputEvidence: original.inputEvidence, stateRoot: header.stateRoot, chainId: 1 });
    const sender = original.inputs.accounts[request.from];
    need(sender && typeof sender.exists === 'boolean' && (!sender.exists || typeof sender.code === 'string'), 'Proof-verified sender account is missing');
    const code = sender.exists ? sender.code : '0x';
    const common = ethereumCommon(header, 1), target = existingDelegationTarget(code, common);
    delegation = { status: target === null ? 'changed_sender' : 'verified_existing_delegation', sender: request.from, target, code,
      proofVerified: true, blockHash: header.hash, stateRoot: header.stateRoot, authorizationListProcessed: false };
    if (target === null) return unavailable(declaration.transactionHash, 'Current proof-verified sender is outside existing exact EIP-7702 delegation scope', delegation);
    same(original.output.semantics?.senderDelegation, { address: target, authorizationListProcessed: false }, 'Execution delegation metadata differs from the proven sender designation');
    need(original.output.semantics?.callerNonce === 'runCall_increment_and_committed_sender_creation_attempts', 'Execution delegated-sender nonce semantics differ');
    const identity = projection(expectedImplementation);
    const comparison = await adjudicateLocalOutcome({ transactionHash: declaration.transactionHash, request, header, expectedLocalImplementation: identity,
      local: { dispatch: 'completed', implementation: identity, attempt: { status: 'completed', ...original,
        headerVerification: verified, isolation: report.attempt.isolation, broker: report.attempt.broker } }, oracle });
    return { delegation, ...comparison, scope: SCOPE };
  } catch (error) {
    const why = error instanceof EvidenceError ? error.message : 'API evidence is malformed, incomplete, or fails independent binding';
    return unavailable(declaration?.transactionHash, why, delegation);
  }
}
