import { normalizeEvmContext } from '../evm-context.js';
// Owned execution and explicit queries over verified initial state. No provider
// execution trace, override, expected result or poststate enters this module.
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { createAddressFromString } from '@ethereumjs/util';
import { createRpcStateInputs } from './rpc-state-inputs.js';
import { createProofStateManager } from './proof-state.js';
import { executeEthereumCall } from './ethereum-call.js';
import { verifyEthereumHeader } from './ethereum-header.js';
import { ethereumCallGas, ethereumCommon, ethereumContextProfile, ethereumQuantity } from './ethereum-profile.js';
import { encode, decode, fields, need } from './isolated-protocol.js';
import { compilePreviewQueries, decodePreviewValues } from './preview-queries.js';
import { validateQueryMutation } from './preview-mutations.js';

export const ETHEREUM_PREVIEW_LIMITS = Object.freeze({ wallMs: 145000, requestMs: 25000, calls: 256,
  responseBytes: 8388608, totalBytes: 33554432, steps: 1000000, frames: 1000,
  logs: 2000, rootReturnBytes: 1048576, traceBytes: 8388608,
  accounts: 128, slots: 1024, codeBytes: 131072, reads: 200000,
  gas: 5000000, depth: 32, memoryBytes: 1048576, calldataBytes: 32768 });
const EXECUTION_COUNTS = ['steps', 'frames', 'logs', 'rootReturnBytes', 'traceBytes'];
const COMPLETE = ['success', 'reverted', 'failed'];
const QUERY_GAS = '1000000';
const SCOPE = Object.freeze({ chainId: 1, execution: 'unsigned_unpriced_block_end', originalTransactionReplay: false,
  initialState: 'verified_proofs_and_code_against_hash_bound_header', consensusVerified: false,
  queries: 'explicit_only_same_sender_zero_value_disposable_CALLs', queryGas: QUERY_GAS,
  queryPurity: 'net_changes_except_expected_sender_nonce_no_committed_logs',
  contractIdentityVerified: false, allEffectsCoverage: 'not_established', security: 'not_assessed',
  processIsolation: false, deadline: 'cooperative_requires_isolated_host_for_forced_termination',
  outputBudget: 'shared_root_return_bytes_and_shared_retained_trace_bytes_including_descendant_outputs',
  feesSettled: false, nativeEffectsMeasured: false });
const unavailable = (reason, output = null) => ({ status: 'unavailable', reason, output, values: null });
const error = code => ({ code, message: code === 'LOCAL_PREVIEW_INPUT' ? 'The fixed call, header, query declarations or limits are invalid.' : 'The owned preview could not retain a complete valid result.' });

/** Internal core. A production host must supply the fixed isolated worker and
 * bounded wire transport; this function alone is not a process/network sandbox.
 * Each query pair preserves its own status. A later input failure cannot change
 * an already retained original execution or previously completed query pair. */
export async function executeEthereumPreview(options) {
  let request, header, rpc, queries, limits, now, headerVerification;
  try {
    fields(options, ['request', 'header', 'rpc', 'queries', 'limits', 'now'], ['request', 'header', 'rpc', 'queries']);
    rpc = options.rpc; need(typeof rpc?.call === 'function');
    now = options.now ?? (() => performance.now()); need(typeof now === 'function');
    queries = compilePreviewQueries(options.queries);
    request = decode(encode(options.request, 128 * 1024), 128 * 1024);
    fields(request, ['from', 'to', 'data', 'value', 'gas', 'accessList', 'blobVersionedHashes'], ['from', 'to', 'data', 'value', 'gas']);
    Object.assign(request, normalizeEvmContext(request));
    need(['from', 'to'].every(key => typeof request[key] === 'string' && /^0x[0-9a-f]{40}$/i.test(request[key])));
    request.from = request.from.toLowerCase(); request.to = request.to.toLowerCase();
    ethereumQuantity(request.value); const gas = ethereumQuantity(request.gas);
    header = decode(encode(options.header, 128 * 1024), 128 * 1024);
    headerVerification = verifyEthereumHeader({ header, expectedHash: header.hash });
    ethereumContextProfile(request, header);
    need(gas <= 5000000n && gas >= ethereumCallGas(request.data, ethereumCommon(header), request).minimum);
    header.hash = header.hash.toLowerCase();
    const supplied = options.limits ?? {}; fields(supplied, Object.keys(ETHEREUM_PREVIEW_LIMITS), []);
    limits = { ...ETHEREUM_PREVIEW_LIMITS };
    for (const [key, value] of Object.entries(supplied)) {
      need(Number.isSafeInteger(value) && value > 0 && value <= limits[key]); limits[key] = value;
    }
  } catch {
    return { status: 'unavailable', error: error('LOCAL_PREVIEW_INPUT'), headerVerification: null,
      original: null, measurements: [], inputs: null, inputEvidence: [], inputUsage: null, inputReads: null, usage: null, scope: SCOPE };
  }
  const began = now(), counters = { executions: 0, steps: 0, frames: 0, logs: 0, rootReturnBytes: 0, traceBytes: 0 };
  const measurements = queries.map(compiled => ({ ...compiled, status: 'not_attempted', reason: 'Original execution has no complete retained state.', before: null, after: null, values: null }));
  let inputs, state, original = null, sharedFailure = null;
  const elapsed = () => Math.max(0, now() - began);
  function available() {
    return elapsed() < limits.wallMs && EXECUTION_COUNTS.every(key => counters[key] < limits[key]) && inputs.snapshotUsage().status === 'available';
  }
  async function execute(call, manager) {
    if (!available()) return null;
    const remaining = Object.fromEntries(EXECUTION_COUNTS.map(key => [key, limits[key] - counters[key]]));
    const { rootReturnBytes, ...executionRemaining } = remaining;
    const output = await executeEthereumCall({ request: call, header, stateManager: manager, now,
      limits: { ...executionRemaining, gas: limits.gas, depth: limits.depth, memoryBytes: limits.memoryBytes, calldataBytes: limits.calldataBytes,
        returnBytes: rootReturnBytes, wallMs: Math.max(1, Math.min(120000, Math.floor(limits.wallMs - elapsed()))) } });
    counters.executions++;
    counters.steps += output.usage?.steps ?? 0; counters.frames += output.usage?.frames ?? 0;
    counters.logs += output.usage?.logOpcodes ?? 0;
    counters.rootReturnBytes += typeof output.execution.returnData === 'string' ? (output.execution.returnData.length - 2) / 2 : 0;
    counters.traceBytes += output.usage?.retainedTraceBytes ?? 0;
    return output;
  }
  async function probe(compiled, manager) {
    const firstInput = inputs.snapshotUsage().calls;
    let output = null, before = null, after = null;
    try {
      if (!available()) return unavailable('Shared preview budget or verified input collection is unavailable.');
      const account = await manager.getAccount(createAddressFromString(request.from));
      const nonceBefore = (account?.nonce ?? 0n).toString();
      before = manager.snapshotChanges();
      output = await execute({ from: request.from, ...compiled.query, value: '0', gas: QUERY_GAS }, manager);
      after = manager.snapshotChanges();
      if (!output) return unavailable('Shared preview budget or verified input collection is unavailable.');
      if (output.execution.status !== 'success') return unavailable('The declared query did not complete successfully.', output);
      need(output.stateDisposition === 'message_result_retained_in_supplied_manager' && output.logs.length === 0);
      const mutationValidation = validateQueryMutation({ before, after, sender: request.from, nonceBefore, senderExistedBefore: account !== undefined });
      const values = decodePreviewValues(compiled, output.execution.returnData);
      return { status: 'measured', reason: null, values, output, changesBefore: before, changesAfter: after, mutationValidation,
        inputEvidenceIds: Array.from({ length: inputs.snapshotUsage().calls - firstInput }, (_, i) => firstInput + i + 1), stateReads: manager.snapshotReads() };
    } catch {
      return { ...unavailable('The query return, net mutations or required state could not be verified.', output), changesBefore: before, changesAfter: after,
        inputEvidenceIds: Array.from({ length: inputs.snapshotUsage().calls - firstInput }, (_, i) => firstInput + i + 1), stateReads: manager.snapshotReads() };
    }
  }
  try {
    inputs = createRpcStateInputs({ chainId: 1, blockHash: header.hash, header, rpc, now, limits: {
      wallMs: limits.wallMs, calls: limits.calls, requestMs: limits.requestMs, responseBytes: limits.responseBytes, totalBytes: limits.totalBytes,
      accounts: limits.accounts, slots: limits.slots, codeBytes: limits.codeBytes, reads: limits.reads,
    } });
    state = createProofStateManager({ inputs });
    const output = await execute(request, state);
    original = { output, changes: state.snapshotChanges(), inputs: inputs.snapshotInputs(), inputEvidence: inputs.snapshotEvidence(),
      inputUsage: inputs.snapshotUsage(), inputReads: inputs.snapshotReads(), stateReads: state.snapshotReads() };
    if (output && COMPLETE.includes(output.execution.status) && output.stateDisposition === 'message_result_retained_in_supplied_manager') {
      for (let index = 0; index < measurements.length; index++) {
        const measurement = measurements[index], compiled = queries[index];
        if (!available()) { measurement.reason = 'Shared preview budget or verified input collection is unavailable.'; continue; }
        // Before probes use only immutable proven initial facts. After probes
        // copy the entire original overlay; no changed slot is reconstructed
        // from events, expected values or a provider-supplied state diff.
        measurement.before = await probe(compiled, createProofStateManager({ inputs }));
        if (measurement.before.status !== 'measured') {
          measurement.status = 'unavailable'; measurement.reason = 'Before-state query unavailable; no before/after amount is reported.';
        } else {
          measurement.after = await probe(compiled, state.shallowCopy());
          if (measurement.after.status !== 'measured') {
            measurement.status = 'unavailable'; measurement.reason = 'After-state query unavailable; no before/after amount is reported.';
          } else {
            measurement.values = measurement.before.values.map((value, index) => {
              const after = measurement.after.values[index]; need(value.name === after.name && equal(value.unit, after.unit));
              return { name: value.name, beforeRaw: value.raw, afterRaw: after.raw, deltaRaw: (BigInt(after.raw) - BigInt(value.raw)).toString(), unit: value.unit };
            });
            measurement.status = 'measured'; measurement.reason = null;
          }
        }
        need(equal(state.snapshotChanges(), original.changes), 'LOCAL_PREVIEW_STATE_CHANGED');
      }
    }
  } catch {
    sharedFailure = error('LOCAL_PREVIEW_INTEGRITY');
    for (const measurement of measurements) {
      measurement.status = 'unavailable'; measurement.reason = 'Shared preview integrity failed; all measurements withheld.'; measurement.values = null;
      for (const side of ['before', 'after']) if (measurement[side]) {
        measurement[side].status = 'unavailable'; measurement[side].reason = measurement.reason; measurement[side].values = null;
      }
    }
  }
  const completeOriginal = original?.output && COMPLETE.includes(original.output.execution.status);
  const result = { status: sharedFailure || !completeOriginal ? 'unavailable' : measurements.every(row => row.status === 'measured') ? 'complete' : 'partial',
    error: sharedFailure, headerVerification, original, measurements,
    inputs: inputs?.snapshotInputs() ?? null, inputEvidence: inputs?.snapshotEvidence() ?? [], inputUsage: inputs?.snapshotUsage() ?? null,
    inputReads: inputs?.snapshotReads() ?? null, usage: { ...counters, wallMs: elapsed(), limits }, scope: SCOPE };
  // The isolated host applies the same bound to IPC. The internal core also
  // refuses a result too large to retain, without presenting a partial success.
  try { encode(result, 64 * 1024 * 1024); return result; }
  catch { return { status: 'unavailable', error: error('LOCAL_PREVIEW_OUTPUT'), headerVerification, original: null, measurements: [],
    inputs: null, inputEvidence: [], inputUsage: null, inputReads: null, usage: { ...counters, wallMs: elapsed(), limits }, scope: SCOPE }; }
}
