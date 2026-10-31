// Ordered unsigned originals over one authenticated overlay. Disposable query
// invocations are delayed until every attempted original has finished.
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { createAddressFromString } from '@ethereumjs/util';
import { normalizeEvmContext } from '../evm-context.js';
import { normalizeEthereumFees, ethereumFeePlan } from './ethereum-fees.js';
import { normalizeAuthorizationList } from './authorization-list.js';
import { createRpcStateInputs } from './rpc-state-inputs.js';
import { createProofStateManager } from './proof-state.js';
import { executeEthereumCall } from './ethereum-call.js';
import { verifyEthereumHeader } from './ethereum-header.js';
import { ethereumCallGas, ethereumCommon, ethereumContextProfile, ethereumQuantity } from './ethereum-profile.js';
import { ETHEREUM_PREVIEW_LIMITS } from './ethereum-preview.js';
import { encode, decode, fields, need } from './isolated-protocol.js';
import { compilePreviewQueries, decodePreviewValues, nativeBalanceValues } from './preview-queries.js';
import { validateQueryMutation } from './preview-mutations.js';

// These are one sequence's ceilings, never a per-original multiplier.
export const ETHEREUM_SEQUENCE_LIMITS = ETHEREUM_PREVIEW_LIMITS;
const EXECUTION_COUNTS = ['steps', 'frames', 'logs', 'rootReturnBytes', 'traceBytes'];
const COMPLETE = ['success', 'reverted', 'failed'];
const QUERY_GAS = '1000000';
const SCOPE = Object.freeze({ chainId: 1, execution: 'ordered_unsigned_same_header_sequence',
  sameHeader: true, atomic: false, stopOn: 'first_original_non_success',
  ordering: 'all_originals_before_disposable_queries', stateFeeds: 'originals_only',
  originalTransactionReplay: false, initialState: 'verified_proofs_and_code_against_hash_bound_header', consensusVerified: false,
  queries: 'explicit_only_same_sender_zero_value_disposable_CALLs', queryGas: QUERY_GAS,
  queryPurity: 'net_changes_except_expected_sender_nonce_no_committed_logs',
  contractIdentityVerified: false, allEffectsCoverage: 'not_established', security: 'not_assessed',
  processIsolation: false, deadline: 'cooperative_requires_isolated_host_for_forced_termination',
  outputBudget: 'shared_root_return_bytes_and_shared_retained_trace_bytes_including_descendant_outputs',
  nativeEffectsMeasured: false });
const unavailable = (reason, output = null) => ({ status: 'unavailable', reason, output, values: null });
const failure = code => ({ code, message: code === 'LOCAL_SEQUENCE_INPUT'
  ? 'The fixed sequence, shared sender, header, queries or limits are invalid.'
  : code === 'LOCAL_SEQUENCE_LIMIT' ? 'The shared sequence budget was exhausted.'
    : 'The owned sequence could not retain a complete valid result.' });
const pendingMeasurements = queries => queries.map(compiled => ({ ...compiled, status: 'not_attempted',
  reason: 'This original has no complete retained state.', before: null, after: null, values: null }));

/** Internal core, not a process/network sandbox. Original snapshots and all
 * changes remain relative to the same immutable proven input namespace. A
 * completed EVM failure retains transaction preparation/fees and stops later
 * originals; an unavailable invocation must restore its starting overlay. */
export async function executeEthereumSequence(options) {
  let requests = [], queries = [], header, headerVerification = null, rpc, now, limits, chainId = 1;
  let scope = { ...SCOPE, executionProfiles: [], feesSettled: [] };
  try {
    fields(options, ['requests', 'header', 'rpc', 'queries', 'limits', 'now', 'chainId'], ['requests', 'header', 'rpc', 'queries']);
    chainId = options.chainId === undefined ? 1 : options.chainId; need(chainId === 1 || chainId === 11155111);
    scope.chainId = chainId;
    requests = decode(encode(options.requests, 4 * 128 * 1024), 4 * 128 * 1024);
    need(Array.isArray(requests) && requests.length >= 2 && requests.length <= 4);
    queries = compilePreviewQueries(options.queries, { chainId });
    rpc = options.rpc; need(typeof rpc?.call === 'function');
    now = options.now ?? (() => performance.now()); need(typeof now === 'function');
    header = decode(encode(options.header, 128 * 1024), 128 * 1024);
    headerVerification = verifyEthereumHeader({ header, expectedHash: header.hash, chainId });
    const common = ethereumCommon(header, chainId);
    for (const request of requests) {
      encode(request, 128 * 1024);
      fields(request, ['from', 'to', 'data', 'value', 'gas', 'accessList', 'blobVersionedHashes', 'authorizationList', 'executionProfile', 'fees'], ['from', 'to', 'data', 'value', 'gas']);
      Object.assign(request, normalizeEvmContext(request), normalizeEthereumFees(request));
      const authorizationList = normalizeAuthorizationList(request);
      if (authorizationList) request.authorizationList = authorizationList;
      need(typeof request.from === 'string' && /^0x[0-9a-f]{40}$/i.test(request.from));
      need(request.to === null || (typeof request.to === 'string' && /^0x[0-9a-f]{40}$/i.test(request.to)));
      request.from = request.from.toLowerCase(); request.to = request.to === null ? null : request.to.toLowerCase();
      ethereumQuantity(request.value); const gas = ethereumQuantity(request.gas);
      ethereumContextProfile(request, header, common); ethereumFeePlan(request, header, chainId);
      need(gas <= 5000000n && gas >= ethereumCallGas(request.data, common, request).minimum);
      request.data = request.data.toLowerCase();
      need(request.from === requests[0].from);
    }
    header.hash = header.hash.toLowerCase();
    scope.executionProfiles = requests.map(request => request.executionProfile ?? 'unsigned_unpriced_block_end');
    scope.feesSettled = requests.map(() => false);
    const supplied = options.limits ?? {}; fields(supplied, Object.keys(ETHEREUM_SEQUENCE_LIMITS), []);
    limits = { ...ETHEREUM_SEQUENCE_LIMITS };
    for (const [key, value] of Object.entries(supplied)) {
      need(Number.isSafeInteger(value) && value > 0 && value <= limits[key]); limits[key] = value;
    }
  } catch {
    return { status: 'unavailable', error: failure('LOCAL_SEQUENCE_INPUT'), headerVerification: null,
      steps: Array.isArray(requests) && requests.length <= 4 ? requests.map((request, index) => ({ index, request,
        status: 'not_attempted', reason: 'Sequence input validation failed before execution.', original: null, measurements: pendingMeasurements(queries) })) : [],
      inputs: null, inputEvidence: [], inputUsage: null, inputReads: null, usage: null, scope };
  }

  const counters = { executions: 0, steps: 0, frames: 0, logs: 0, rootReturnBytes: 0, traceBytes: 0, stateReads: 0 };
  const steps = requests.map((request, index) => ({ index, request, status: 'not_attempted',
    reason: 'A previous original did not succeed or the shared budget is unavailable.', original: null, measurements: pendingMeasurements(queries) }));
  const snapshots = new Map(), guardedManagers = new WeakSet();
  let inputs, state, sharedFailure = null, began = null, lastTime = null, clockFailed = false;
  function elapsed() {
    try {
      need(!clockFailed, 'LOCAL_SEQUENCE_INTEGRITY');
      const value = now();
      need(Number.isFinite(value) && (lastTime === null || value >= lastTime), 'LOCAL_SEQUENCE_INTEGRITY');
      began ??= value; lastTime = value; return value - began;
    } catch (error) { clockFailed = true; throw error; }
  }
  function available(execution = true) {
    return elapsed() < limits.wallMs && counters.stateReads < limits.reads
      && (!execution || EXECUTION_COUNTS.every(key => counters[key] < limits[key]))
      && inputs.snapshotUsage().status === 'available';
  }
  function trackReads(manager) {
    if (!guardedManagers.has(manager)) {
      const read = manager.read.bind(manager);
      manager.read = (...args) => {
        counters.stateReads++;
        read(...args);
        need(counters.stateReads <= limits.reads, 'LOCAL_SEQUENCE_LIMIT');
      };
      guardedManagers.add(manager);
    }
    return manager;
  }
  async function execute(call, manager) {
    if (!available()) return null;
    const remaining = Object.fromEntries(EXECUTION_COUNTS.map(key => [key, limits[key] - counters[key]]));
    const { rootReturnBytes, ...executionRemaining } = remaining;
    const output = await executeEthereumCall({ request: call, header, chainId, stateManager: manager, blockchain: inputs.blockchain, now,
      limits: { ...executionRemaining, gas: limits.gas, depth: limits.depth, memoryBytes: limits.memoryBytes, calldataBytes: limits.calldataBytes,
        returnBytes: rootReturnBytes, wallMs: Math.max(1, Math.min(120000, Math.floor(limits.wallMs - elapsed()))) } });
    counters.executions++;
    counters.steps += output.usage?.steps ?? 0; counters.frames += output.usage?.frames ?? 0;
    counters.logs += output.usage?.logOpcodes ?? 0;
    counters.rootReturnBytes += typeof output.execution.returnData === 'string' ? (output.execution.returnData.length - 2) / 2 : 0;
    counters.traceBytes += output.usage?.retainedTraceBytes ?? 0;
    return output;
  }
  const evidenceIds = first => Array.from({ length: inputs.snapshotUsage().calls - first }, (_, i) => first + i + 1);
  async function probe(compiled, manager, sender) {
    const firstInput = inputs.snapshotUsage().calls;
    let output = null, before = null, after = null;
    const retained = result => ({ ...result, changesBefore: before, changesAfter: after,
      inputEvidenceIds: evidenceIds(firstInput), stateReads: manager.snapshotReads() });
    try {
      if (!available()) return retained(unavailable('Shared sequence budget or verified input collection is unavailable.'));
      const account = await manager.getAccount(createAddressFromString(sender));
      const nonceBefore = (account?.nonce ?? 0n).toString();
      before = manager.snapshotChanges();
      output = await execute({ from: sender, ...compiled.query, value: '0', gas: QUERY_GAS }, manager);
      after = manager.snapshotChanges();
      if (!output) return retained(unavailable('Shared sequence budget or verified input collection is unavailable.'));
      if (output.execution.status !== 'success') return retained(unavailable('The declared query did not complete successfully.', output));
      need(elapsed() < limits.wallMs && inputs.snapshotUsage().status === 'available');
      need(output.stateDisposition === 'message_result_retained_in_supplied_manager' && output.logs.length === 0);
      const mutationValidation = validateQueryMutation({ before, after, sender, nonceBefore, senderExistedBefore: account !== undefined });
      const values = decodePreviewValues(compiled, output.execution.returnData, { chainId });
      return retained({ status: 'measured', reason: null, values, output, mutationValidation });
    } catch {
      return retained(unavailable('The query return, net mutations or required state could not be verified.', output));
    }
  }
  async function nativeProbe(compiled, manager) {
    const firstInput = inputs.snapshotUsage().calls;
    let before = null, after = null, result;
    try {
      need(available(false));
      before = manager.snapshotChanges();
      const account = await manager.getAccount(createAddressFromString(compiled.descriptor.account));
      after = manager.snapshotChanges();
      need(elapsed() < limits.wallMs && inputs.snapshotUsage().status === 'available' && equal(before, after));
      result = { status: 'measured', reason: null, output: null, values: nativeBalanceValues(compiled, account?.balance ?? 0n, { chainId }) };
    } catch { result = unavailable('The native balance or its verified input state could not be established.'); }
    return { ...result, readMethod: 'proof_state_account_balance', changesBefore: before, changesAfter: after,
      inputEvidenceIds: evidenceIds(firstInput), stateReads: manager.snapshotReads() };
  }

  try {
    elapsed();
    inputs = createRpcStateInputs({ chainId, blockHash: header.hash, header, rpc, now, limits: {
      wallMs: limits.wallMs, calls: limits.calls, requestMs: limits.requestMs, responseBytes: limits.responseBytes, totalBytes: limits.totalBytes,
      accounts: limits.accounts, slots: limits.slots, codeBytes: limits.codeBytes, reads: limits.reads,
    } });
    state = trackReads(createProofStateManager({ inputs }));
    // No query is allowed to populate the input collector before this loop ends.
    for (const step of steps) {
      if (!available()) break;
      const before = state.shallowCopy(), startingChanges = state.snapshotChanges();
      step.status = 'unavailable'; step.reason = 'Original execution could not be retained; subsequent originals were not attempted.';
      let output = null;
      try { output = await execute(step.request, state); }
      finally {
        step.original = { output, startingChanges, changes: state.snapshotChanges(), inputs: inputs.snapshotInputs(),
          inputEvidence: inputs.snapshotEvidence(), inputUsage: inputs.snapshotUsage(), inputReads: inputs.snapshotReads(), stateReads: state.snapshotReads() };
      }
      if (output && COMPLETE.includes(output.execution.status)) {
        need(output.stateDisposition === 'message_result_retained_in_supplied_manager', 'LOCAL_SEQUENCE_INTEGRITY');
        step.status = 'completed'; step.reason = output.execution.status === 'success' ? null : 'Original execution completed without success; subsequent originals were not attempted.';
        scope.feesSettled[step.index] = Boolean(step.request.executionProfile);
        snapshots.set(step.index, { before, after: state.shallowCopy() });
      } else {
        need(!output || ['unchanged', 'rolled_back'].includes(output.stateDisposition), 'LOCAL_SEQUENCE_INTEGRITY');
        need(equal(startingChanges, step.original.changes), 'LOCAL_SEQUENCE_INTEGRITY');
      }
      if (step.status !== 'completed' || output.execution.status !== 'success') break;
    }
    const retainedChanges = state.snapshotChanges();
    for (const step of steps) {
      if (step.status !== 'completed') continue;
      const saved = snapshots.get(step.index);
      for (let index = 0; index < queries.length; index++) {
        const compiled = queries[index], measurement = step.measurements[index];
        const native = compiled.query === null, measure = native ? nativeProbe : probe;
        if (!available(!native)) { measurement.reason = 'Shared sequence budget or verified input collection is unavailable.'; continue; }
        measurement.before = await measure(compiled, trackReads(saved.before.shallowCopy()), step.request.from);
        if (measurement.before.status !== 'measured') {
          measurement.status = 'unavailable'; measurement.reason = 'Before-state query unavailable; no before/after amount is reported.';
        } else {
          measurement.after = await measure(compiled, trackReads(saved.after.shallowCopy()), step.request.from);
          if (measurement.after.status !== 'measured') {
            measurement.status = 'unavailable'; measurement.reason = 'After-state query unavailable; no before/after amount is reported.';
          } else {
            measurement.values = measurement.before.values.map((value, i) => {
              const after = measurement.after.values[i]; need(value.name === after.name && equal(value.unit, after.unit));
              return { name: value.name, beforeRaw: value.raw, afterRaw: after.raw, deltaRaw: (BigInt(after.raw) - BigInt(value.raw)).toString(), unit: value.unit };
            });
            measurement.status = 'measured'; measurement.reason = null;
          }
        }
        need(equal(state.snapshotChanges(), retainedChanges)
          && equal(saved.before.snapshotChanges(), step.original.startingChanges)
          && equal(saved.after.snapshotChanges(), step.original.changes), 'LOCAL_SEQUENCE_INTEGRITY');
      }
    }
    elapsed();
  } catch {
    sharedFailure = failure('LOCAL_SEQUENCE_INTEGRITY');
    for (const step of steps) for (const measurement of step.measurements) {
      measurement.status = 'unavailable'; measurement.reason = 'Shared sequence integrity failed; all measurements withheld.'; measurement.values = null;
      for (const side of ['before', 'after']) if (measurement[side]) {
        measurement[side].status = 'unavailable'; measurement[side].reason = measurement.reason; measurement[side].values = null;
      }
    }
  }
  const completeOriginal = steps.some(step => step.status === 'completed');
  const allSuccessful = steps.every(step => step.status === 'completed' && step.original.output.execution.status === 'success');
  const wallMs = lastTime === null || began === null ? 0 : lastTime - began;
  const budgetExpired = wallMs >= limits.wallMs;
  const nativeScope = queries.some(query => query.query === null) ? {
    queries: 'explicit_calls_and_native_account_balance_reads', queryGasScope: 'CALL_only',
    queryPurity: 'CALL_net_changes_except_expected_sender_nonce_no_committed_logs_native_reads_no_changes',
    nativeBalanceCoverage: 'explicit_accounts_only',
    nativeEffectsMeasured: !sharedFailure && steps.some(step => step.measurements.some(row => row.query === null && row.status === 'measured')),
  } : {};
  const result = { status: sharedFailure || !completeOriginal ? 'unavailable'
    : allSuccessful && !budgetExpired && steps.every(step => step.measurements.every(row => row.status === 'measured')) ? 'complete' : 'partial',
    error: sharedFailure ?? (budgetExpired ? failure('LOCAL_SEQUENCE_LIMIT') : null), headerVerification, steps,
    inputs: inputs?.snapshotInputs() ?? null, inputEvidence: inputs?.snapshotEvidence() ?? [], inputUsage: inputs?.snapshotUsage() ?? null,
    inputReads: inputs?.snapshotReads() ?? null, usage: { ...counters, wallMs, limits }, scope: { ...scope, ...nativeScope } };
  try { encode(result, 64 * 1024 * 1024); return result; }
  catch {
    return { status: 'unavailable', error: failure('LOCAL_SEQUENCE_OUTPUT'), headerVerification,
      steps: steps.map(step => ({ index: step.index, request: step.request, status: 'unavailable',
        reason: 'Shared output budget exceeded; original outputs and measurements withheld.', original: null, measurements: [] })),
      inputs: null, inputEvidence: [], inputUsage: null, inputReads: null, usage: { ...counters, wallMs, limits },
      scope: { ...scope, feesSettled: requests.map(() => false), ...nativeScope, nativeEffectsMeasured: false } };
  }
}
