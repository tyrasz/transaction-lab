import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, types } from 'node:util';
import { InputError } from './validate.js';
import { LOCAL_CAPABILITIES, validateLocalSimulation } from './local-simulation.js';
import { executeIsolatedEthereumSequence } from '../engines/local-evm/isolated-call.js';
import { verifyEthereumHeader } from '../engines/local-evm/ethereum-header.js';

const HASH = /^0x[0-9a-f]{64}$/i;
const WALL = 145000, DRAIN = 25000, FINAL_RESERVE = 25000, RESPONSE = 96 * 1024 * 1024;
const CALL_FIELDS = ['to', 'data', 'value', 'gas', 'accessList', 'blobVersionedHashes', 'authorizationList', 'executionProfile', 'fees'];
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
// Retain the established source/budget error codes for the loader and service.
const failure = code => ({ code, message: ({
  LOCAL_PREVIEW_SOURCE_CHANGED: 'Execution sources changed; all sequence measurements were withheld. Restart the service.',
  LOCAL_PREVIEW_CANONICAL: 'The complete selected header could not be confirmed; all sequence measurements were withheld.',
  LOCAL_PREVIEW_CANCELLED: 'The local sequence was cancelled; all measurements were withheld.',
  LOCAL_PREVIEW_BUDGET: 'The shared local sequence budget was exhausted.',
  LOCAL_PREVIEW_DRAIN: 'Pending state reads could not be confirmed stopped; all sequence measurements were withheld.',
  LOCAL_PREVIEW_OUTPUT: 'The complete sequence API result exceeded its retained-output limit.',
  LOCAL_PREVIEW_PREPARATION: 'The selected Ethereum header or required pinned state was unavailable.',
})[code] ?? 'The local sequence could not complete a valid result.' });
const stop = code => { throw Object.assign(new Error(code), { localCode: code }); };

export const LOCAL_SEQUENCE_CAPABILITIES = freeze({
  ...LOCAL_CAPABILITIES, operation: 'isolated_proof_backed_unsigned_sequence', profile: 'ordered_unsigned_same_header_sequence',
  calls: { minimum: 2, maximum: 4, sameSender: true, sameHeader: true, atomic: false,
    ordering: 'all_originals_before_disposable_queries', stopOn: 'first_original_non_success',
    completedFailure: 'retain_prior_steps_and_fork_selected_preparation_and_fee_effects',
    unavailableInvocation: 'restore_starting_overlay', queryStateFeedsOriginals: false },
  querySelection: 'one_shared_explicit_list_measured_before_and_after_each_completed_original',
  nativeBalances: { ...LOCAL_CAPABILITIES.nativeBalances,
    reads: 'verified_initial_accounts_and_validated_cumulative_original_overlays' },
  feeSelection: { ...LOCAL_CAPABILITIES.feeSelection, scope: 'each_original_execution_only' },
  limits: { ...LOCAL_CAPABILITIES.limits, calls: 4, minimumCalls: 2, queries: 8, scope: 'shared_across_all_originals_and_queries',
    finalHeaderReserveMs: FINAL_RESERVE },
  limitations: [
    'Two to four unsigned calls share one sender, selected header, proof collector and cumulative local state. They are ordered and non-atomic. Every original is attempted before disposable query observations begin.',
    'A completed revert or EVM failure stops later originals while preserving earlier steps and the failed invocation’s retained nonce, authorization and applicable fee effects. An unavailable invocation must restore its starting overlay.',
    'One shared list of explicit token, position or native-account queries is measured around each completed original. Query state never feeds an original or another query. Missing measurements remain unknown; automatic discovery and complete economic-effect coverage are not established.',
    'Each original may explicitly select a supported priced profile. Default originals and all CALL queries use zero gas price and BASEFEE without fee settlement. No outer transaction signature, transaction inclusion or original block position is validated.',
    'Proofs and runtime code are checked against the selected hash-bound header and its final full-header confirmation. Chain selection comes from the configured endpoint’s chain ID; consensus, finality and contract identity are not independently established.',
    'The fixed time, proof, byte, execution, state-read and output budgets are shared across the sequence. Per-call gas and depth limits remain invocation limits. Process separation and a V8 heap bound are not an OS sandbox or hard total-RSS cap.',
    'Existing trusted-network fork, authorization, creation, lifecycle and cryptographic-precompile boundaries still apply. No security verdict, representative accuracy percentage or complete-effects claim is established.',
  ],
});

function record(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError('A plain local-sequence record is required.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new InputError('Unsupported local-sequence field.');
  }
}
function callsList(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new InputError('calls must be a plain list of two to four calls.');
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (length < 2 || length > 4 || Reflect.ownKeys(value).length !== length + 1) throw new InputError('Supply two to four calls without extra list fields.');
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new InputError('Call lists cannot contain holes or accessors.');
    record(descriptor.value, CALL_FIELDS);
  }
}
/** Validate the whole declaration before transport or worker activity. Each
 * call inherits the sole sender, block and query list; it cannot override them. */
export function validateLocalSequence(input) {
  record(input, ['chainId', 'from', 'block', 'calls', 'queries']);
  if (input.chainId !== 1 && input.chainId !== 11155111) throw new InputError('Local sequences require numeric Ethereum chain 1 or Sepolia chain 11155111.', 'UNSUPPORTED_CHAIN');
  callsList(input.calls);
  const normalized = input.calls.map(call => validateLocalSimulation({ ...call, chainId: input.chainId,
    from: input.from, block: input.block, queries: input.queries }));
  const { chainId, from, block, queries } = normalized[0];
  return { chainId, from, block, calls: normalized.map(({ chainId, from, block, queries, ...call }) => call), queries };
}

const requestsFor = input => input.calls.map(call => ({ from: input.from, ...call }));
const measurements = core => (core?.measurements ?? []).map((row, index) => ({ index, descriptor: row.descriptor,
  query: row.query, identity: row.identity, returnBytes: row.returnBytes, status: row.status, reason: row.reason, values: row.values }));
const pendingSteps = input => requestsFor(input).map((request, index) => ({ index, request, status: 'not_attempted',
  reason: 'No verified original execution is available.', execution: { status: 'not_attempted' }, measurements: [] }));

/** Retain originals only as explicitly unverified audit records. Query sides
 * and measured values must not survive anywhere in a withheld response. */
export function withholdLocalSequence(report, code) {
  const core = report.attempt?.sequence;
  if (core) report.audit = { status: 'unverified_not_a_measurement',
    originals: core.steps.map(step => ({ index: step.index, request: step.request, original: step.original })),
    inputs: core.inputs, inputEvidence: core.inputEvidence, inputUsage: core.inputUsage, inputReads: core.inputReads };
  if (report.attempt) report.attempt = { ...report.attempt, status: 'unavailable', error: failure(code), sequence: null };
  report.status = 'unavailable'; report.error = failure(code);
  report.steps = report.steps.map(step => ({ index: step.index, request: step.request, status: 'unavailable',
    reason: 'Final verification failed; no execution or measurement is presented as verified.', execution: { status: 'unavailable' }, measurements: [] }));
  report.source.canonicalStatus = 'unverified';
  return report;
}

/** rpc is the server-selected bounded/cancellable ProofRpcClient. No endpoint,
 * state override, expected result or provider execution trace is accepted. */
export async function simulateLocalSequence(input, rpc, { signal } = {}) {
  const apiRequest = validateLocalSequence(input), started = performance.now();
  const report = { kind: 'local_proof_sequence', schemaVersion: '1.0', id: randomUUID(), createdAt: new Date().toISOString(),
    apiRequest, status: 'unavailable', error: null, steps: pendingSteps(apiRequest), attempt: null,
    source: { kind: 'proof_backed_owned_execution', profile: 'ordered_unsigned_same_header_sequence', chainId: apiRequest.chainId,
      executionProfiles: apiRequest.calls.map(call => call.executionProfile ?? 'unsigned_unpriced_block_end'), canonicalStatus: 'unverified',
      consensusVerified: false, originalTransactionReplay: false, blockSelection: { requested: apiRequest.block } },
    transportEvidence: [], usage: null, timing: null };
  const controller = new AbortController();
  const cancel = () => { controller.abort(); try { rpc.cancel(); } catch {} };
  const remaining = () => Math.min(WALL - (performance.now() - started), rpc.usage().remainingWallMs);
  let timer, cause = null;
  try {
    if (!rpc || !['call', 'pinBlockHash', 'snapshotEvidence', 'usage', 'cancel', 'drain'].every(name => typeof rpc[name] === 'function')) stop('LOCAL_PREVIEW_PREPARATION');
    if (signal?.aborted) stop('LOCAL_PREVIEW_CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    const initialRemaining = remaining();
    if (!Number.isFinite(initialRemaining) || initialRemaining <= 0) stop('LOCAL_PREVIEW_BUDGET');
    timer = setTimeout(cancel, Math.max(1, Math.floor(initialRemaining)));
    const call = async (method, params) => {
      if (controller.signal.aborted || remaining() <= 0) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
      const result = await rpc.call(method, params, { signal: controller.signal });
      if (controller.signal.aborted || remaining() <= 0) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
      return result;
    };
    if (await call('eth_chainId', []) !== '0x' + apiRequest.chainId.toString(16)) stop('LOCAL_PREVIEW_PREPARATION');
    const byHash = HASH.test(apiRequest.block), method = byHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber';
    const header = await call(method, [apiRequest.block, false]);
    const verified = verifyEthereumHeader({ header, expectedHash: byHash ? apiRequest.block : header?.hash, chainId: apiRequest.chainId });
    if (!byHash && apiRequest.block !== 'latest' && BigInt(header.number) !== BigInt(apiRequest.block)) stop('LOCAL_PREVIEW_PREPARATION');
    const blockHash = header.hash.toLowerCase();
    report.source.blockSelection = { requested: apiRequest.block, kind: byHash ? 'pinned_hash' : apiRequest.block === 'latest' ? 'resolved_latest' : 'resolved_number',
      blockHash, blockNumber: BigInt(header.number).toString(), headerVerification: verified, header };
    rpc.pinBlockHash(blockHash, header);
    const usage = rpc.usage(), wallMs = Math.floor(remaining() - FINAL_RESERVE);
    const calls = Math.min(256, usage.limits.calls - usage.calls - 1), totalResponseBytes = Math.min(32 * 1024 * 1024, usage.limits.totalBytes - usage.observedBytes);
    if (wallMs <= 0 || calls <= 0 || totalResponseBytes <= 0) stop('LOCAL_PREVIEW_BUDGET');
    report.attempt = await executeIsolatedEthereumSequence({ requests: requestsFor(apiRequest), header, chainId: apiRequest.chainId,
      queries: apiRequest.queries, rpc, signal: controller.signal, limits: { wallMs, calls, totalResponseBytes } });
    if (controller.signal.aborted || signal?.aborted) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
    if (report.attempt.status !== 'completed') cause = report.attempt.error?.code ?? 'LOCAL_PREVIEW_PREPARATION';
    else {
      const confirmed = await call('eth_getBlockByNumber', ['0x' + BigInt(header.number).toString(16), false]);
      try {
        verifyEthereumHeader({ header: confirmed, expectedHash: blockHash, chainId: apiRequest.chainId });
        if (!isDeepStrictEqual(confirmed, header)) stop('LOCAL_PREVIEW_CANONICAL');
      } catch { stop('LOCAL_PREVIEW_CANONICAL'); }
      report.source.canonicalStatus = 'verified';
      const core = report.attempt.sequence;
      report.status = core.status; report.error = core.error;
      report.steps = core.steps.map(step => ({ index: step.index, request: step.request, status: step.status, reason: step.reason,
        execution: step.original?.output?.execution ?? { status: step.status === 'not_attempted' ? 'not_attempted' : 'unavailable' }, measurements: measurements(step) }));
    }
  } catch (error) {
    cause = error?.localCode ?? (signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : controller.signal.aborted ? 'LOCAL_PREVIEW_BUDGET' : 'LOCAL_PREVIEW_PREPARATION');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel();
    try {
      const timeoutMs = Math.max(1, Math.min(DRAIN, Math.floor(WALL + DRAIN - (performance.now() - started))));
      report.drain = await rpc.drain({ timeoutMs });
      if (!report.drain.complete || report.attempt?.broker.pendingAtReturn > 0) cause = 'LOCAL_PREVIEW_DRAIN';
    } catch { cause = 'LOCAL_PREVIEW_DRAIN'; }
    try {
      report.transportEvidence = rpc.snapshotEvidence(); report.usage = rpc.usage();
      if (signal?.aborted) cause = 'LOCAL_PREVIEW_CANCELLED';
      else if (!Number.isFinite(report.usage.remainingWallMs) || remaining() <= 0) cause ??= 'LOCAL_PREVIEW_BUDGET';
    } catch { cause = 'LOCAL_PREVIEW_PREPARATION'; }
  }
  if (cause) withholdLocalSequence(report, cause);
  report.timing = { totalMs: Math.max(0, performance.now() - started) };
  if (Buffer.byteLength(JSON.stringify(report)) > RESPONSE) {
    withholdLocalSequence(report, 'LOCAL_PREVIEW_OUTPUT'); delete report.audit; report.attempt = null;
  }
  return report;
}
