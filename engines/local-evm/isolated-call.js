import { normalizeEvmContext } from '../evm-context.js';
import { normalizeEthereumFees, ethereumFeePlan } from './ethereum-fees.js';
import { deriveVerifiedFees } from './fee-validation.js';
import { deriveVerifiedGas } from './gas-validation.js';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createAuthenticatedAncestry, validateAncestryEvidence } from './authenticated-ancestry.js';
import { verifyEthereumHeader } from './ethereum-header.js';
import { ETHEREUM_NETWORK_SCHEDULES } from './ethereum-network.js';
import { ethereumQuantity, ethereumCallGas, ethereumCommon, ethereumContextProfile } from './ethereum-profile.js';
import { compilePreviewQueries, decodePreviewValues, nativeBalanceValues } from './preview-queries.js';
import { validateQueryMutation, canonicalStateChanges } from './preview-mutations.js';
import { validateExecutionChanges, validateExecutionLifecycle } from './execution-changes.js';
import { validateInputFacts } from './input-facts.js';
import { existingDelegationTarget } from './sender-delegation.js';
import { normalizeAuthorizationList } from './authorization-list.js';
import { deriveAuthorizationPreparation } from './authorization-validation.js';
import { deriveAmsterdamAuthorizationEntryGas } from './amsterdam-authorization-validation.js';
import { ISOLATED_LIMITS, IsolationError, decode, encode, envelope, fields, need, normalizeLimits, validateRpcRequest } from './isolated-protocol.js';
export { ISOLATED_LIMITS, IsolationError } from './isolated-protocol.js';

const WORKER = fileURLToPath(new URL('./isolated-worker.js', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const EMPTY = { output: null, inputs: null, inputEvidence: null, inputUsage: null, inputReads: null, stateReads: null, changes: null };
const safe = (code, message) => ({ code, message });
const EMPTY_CHANGES = { scope: 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.', accounts: [] };

/** Executes one unsigned call on an explicitly admitted Ethereum network in a fixed Node child. rpc.call is a trusted
 * bounded parent adapter; raw transport evidence remains its responsibility.
 * No endpoint/expected execution/poststate is given to the child. Process/V8
 * bounds are not OS permissions or hard total-memory/network restrictions.
 */
export async function executeIsolatedEthereumCall(options) {
  return executeIsolated(options, false);
}

/** The same fixed process boundary, with explicit declared query identities.
 * A completed worker may return a partial/unavailable preview; only process or
 * protocol failure removes the entire preview. This is not an OS sandbox. */
export async function executeIsolatedEthereumPreview(options) {
  return executeIsolated(options, true);
}

/** Ordered calls share one child, proof collector and bounded state manager. */
export async function executeIsolatedEthereumSequence(options) {
  return executeIsolated(options, true, true);
}

async function executeIsolated(options, previewMode, sequenceMode = false) {
  let request, requests, header, limits, rpc, signal, headerVerification, compiledQueries, previewLimits, startPayload, chainId = 1;
  const startBytes = sequenceMode ? 768 * 1024 : 256 * 1024;
  const emptyResult = sequenceMode ? { sequence: null } : previewMode ? { preview: null } : EMPTY;
  try {
    const requestKey = sequenceMode ? 'requests' : 'request';
    fields(options, [requestKey, 'header', 'rpc', 'limits', 'signal', 'chainId', ...(previewMode ? ['queries'] : [])], [requestKey, 'header', 'rpc', ...(previewMode ? ['queries'] : [])]);
    chainId = options.chainId === undefined ? 1 : options.chainId; need(chainId === 1 || chainId === 11155111);
    ({ rpc, signal } = options); need(typeof rpc?.call === 'function');
    need(signal === undefined || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'));
    limits = normalizeLimits(options.limits);
    if (previewMode) compiledQueries = compilePreviewQueries(options.queries, { chainId });
    header = decode(encode(options.header, 128 * 1024), 128 * 1024);
    headerVerification = verifyEthereumHeader({ header, expectedHash: header.hash, chainId });
    header.hash = header.hash.toLowerCase();
    const admitted = decode(encode(sequenceMode ? options.requests : [options.request], sequenceMode ? 512 * 1024 : 128 * 1024), sequenceMode ? 512 * 1024 : 128 * 1024);
    need(Array.isArray(admitted) && admitted.length >= (sequenceMode ? 2 : 1) && admitted.length <= (sequenceMode ? 4 : 1));
    requests = admitted.map(call => {
      fields(call, ['from', 'to', 'data', 'value', 'gas', 'accessList', 'blobVersionedHashes', 'authorizationList', 'executionProfile', 'fees'], ['from', 'to', 'data', 'value', 'gas']);
      Object.assign(call, normalizeEvmContext(call), normalizeEthereumFees(call));
      const authorizations = normalizeAuthorizationList(call);
      if (authorizations !== undefined) call.authorizationList = authorizations;
      need(typeof call.from === 'string' && /^0x[0-9a-f]{40}$/i.test(call.from));
      need(call.to === null || (typeof call.to === 'string' && /^0x[0-9a-f]{40}$/i.test(call.to)));
      if (sequenceMode) { call.from = call.from.toLowerCase(); call.to = call.to === null ? null : call.to.toLowerCase(); call.data = call.data.toLowerCase(); }
      ethereumQuantity(call.value); const gas = ethereumQuantity(call.gas);
      ethereumContextProfile(call, header, ethereumCommon(header, chainId)); ethereumFeePlan(call, header, chainId);
      need(gas <= 5000000n && gas >= ethereumCallGas(call.data, ethereumCommon(header, chainId), call).minimum);
      return call;
    });
    request = requests[0];
    if (sequenceMode) need(requests.every(call => call.from === request.from));
    if (previewMode) previewLimits = {
      wallMs: Math.min(limits.wallMs, limits.inputs.wallMs, limits.execution.wallMs), requestMs: limits.requestMs,
      calls: limits.calls, responseBytes: limits.responseBytes, totalBytes: limits.totalResponseBytes,
      ...Object.fromEntries(['accounts', 'slots', 'codeBytes', 'reads'].map(key => [key, limits.inputs[key]])),
      ...Object.fromEntries(['steps', 'frames', 'logs', 'traceBytes', 'gas', 'depth', 'memoryBytes', 'calldataBytes'].map(key => [key, limits.execution[key]])),
      rootReturnBytes: limits.execution.returnBytes,
    };
    startPayload = { ...(sequenceMode ? { requests } : { request }), header, limits, ...(chainId === 1 ? {} : { chainId }), ...(previewMode ? { mode: sequenceMode ? 'sequence' : 'preview', queries: compiledQueries.map(row => row.descriptor) } : {}) };
    encode({ v: 1, type: 'start', id: 1, payload: startPayload }, startBytes);
  } catch {
    return { status: 'unavailable', error: safe('LOCAL_ISOLATED_INPUT', previewMode ? 'The fixed call, header, queries or limits are invalid.' : 'The fixed call, header or limits are invalid.'), ...emptyResult, headerVerification: null, isolation: null, broker: { calls: 0, records: [], pendingAtReturn: 0 } };
  }
  const ancestry = createAuthenticatedAncestry(header, chainId);
  const began = performance.now(), records = [], active = new Set(), controllers = new Set();
  let child, closed = false, sealed = false, failure = null, candidate = null, pendingId = null, totalBytes = 0, stdioBytes = 0, dispatches = 0, timer, killTimer;
  let exitCode = null, exitSignal = null, terminateRequested = false, completion;
  const finished = new Promise(resolve => { completion = resolve; });
  function fail(code, message) {
    if (sealed || failure) return;
    failure = safe(code, message); candidate = null;
    for (const controller of controllers) controller.abort();
    if (child && !closed) {
      terminateRequested = true;
      try { child.kill('SIGKILL'); } catch { /* Report unconfirmed termination below. */ }
      killTimer ??= setTimeout(completion, limits.killWaitMs);
    } else completion();
  }
  function expired() { if (performance.now() - began >= limits.wallMs) fail('LOCAL_ISOLATED_TIMEOUT', 'The isolated process exceeded its wall-time budget.'); return failure !== null; }
  function send(message, maxBytes) {
    if (failure || sealed || !child?.connected) return;
    try { child.send(encode(message, maxBytes), error => { if (error && !closed) fail('LOCAL_ISOLATED_IPC', 'The isolated process channel failed.'); }); }
    catch { fail('LOCAL_ISOLATED_IPC', 'The isolated process channel failed.'); }
  }
  async function broker(message) {
    const controller = new AbortController(); controllers.add(controller);
    const entry = { id: message.id, request: { method: message.method, params: structuredClone(message.params) }, status: 'pending', representation: 'parsed_rpc_result_not_wire_bytes' };
    records.push(entry); const started = performance.now(); let requestTimer, abortListener;
    const actual = Promise.resolve().then(() => {
      need(!sealed && !failure && !controller.signal.aborted && !expired(), 'LOCAL_ISOLATED_ABORTED', 'The pinned read was cancelled before dispatch.');
      entry.dispatched = true; dispatches++;
      return rpc.call(message.method, structuredClone(message.params), { signal: controller.signal });
    });
    // Track the underlying adapter separately from the deadline race. A caller
    // that ignores abort is reported as undrained; late data cannot change output.
    active.add(actual); actual.finally(() => active.delete(actual)).catch(() => {});
    try {
      const cancelled = new Promise((_, reject) => { abortListener = () => reject(new IsolationError('LOCAL_ISOLATED_ABORTED', 'The pinned read was cancelled.')); controller.signal.addEventListener('abort', abortListener, { once: true }); });
      const result = await Promise.race([actual, cancelled, new Promise((_, reject) => { requestTimer = setTimeout(() => { reject(new IsolationError('LOCAL_ISOLATED_RPC_TIMEOUT', 'A parent state read timed out.')); controller.abort(); }, Math.max(1, Math.min(limits.requestMs, limits.wallMs - (started - began)))); })]);
      if (sealed || failure || expired()) return;
      const text = encode(result, limits.responseBytes); totalBytes += Buffer.byteLength(text);
      entry.resultBytes = Buffer.byteLength(text); entry.resultSha256 = sha(text);
      need(totalBytes <= limits.totalResponseBytes, 'LOCAL_ISOLATED_SIZE', 'Parent state reads exceeded their total byte limit.');
      if (message.method === 'eth_getBlockByHash') {
        try { ancestry.accept(JSON.parse(text), message.id); }
        catch { throw new IsolationError('LOCAL_ISOLATED_ANCESTRY', 'The ancestor header did not match the authenticated parent chain.'); }
      }
      entry.status = 'received'; pendingId = null;
      send({ v: 1, type: 'rpc_result', id: message.id, result: JSON.parse(text) }, limits.responseBytes + 1024);
    } catch (error) {
      if (sealed || failure) return;
      entry.status = 'unavailable'; entry.error = safe('RPC_UNAVAILABLE', 'The pinned parent read was unavailable.'); pendingId = null;
      if (error instanceof IsolationError) fail(error.code, error.message);
      else send({ v: 1, type: 'rpc_error', id: message.id, code: 'RPC_UNAVAILABLE' }, 1024);
    } finally {
      clearTimeout(requestTimer); controller.signal.removeEventListener('abort', abortListener); controller.abort(); controllers.delete(controller);
      if (!sealed) entry.durationMs = Math.max(0, performance.now() - started);
    }
  }
  function validateInputs(result, count) {
    const context = result.inputs?.context;
    need(context?.chainId === chainId && context.blockHash === header.hash && context.stateRoot === header.stateRoot.toLowerCase() && isDeepStrictEqual(context.header, header));
    need(Array.isArray(result.inputEvidence) && result.inputEvidence.length === count && result.inputUsage?.calls === count);
    validateAncestryEvidence(header, result.inputs.ancestry, result.inputEvidence, chainId);
    for (const [i, entry] of result.inputEvidence.entries()) {
      need(entry.id === i + 1 && isDeepStrictEqual(entry.request, records[i].request));
      if (Object.hasOwn(entry, 'result')) need(sha(encode(entry.result, limits.responseBytes)) === records[i].resultSha256);
      if (previewMode) {
        need(entry.requestText === JSON.stringify(entry.request) && entry.requestSha256 === sha(entry.requestText) && ['received', 'unavailable'].includes(entry.status));
        if (entry.status === 'received') need(records[i].status === 'received');
        if (Object.hasOwn(entry, 'result')) need(entry.status === 'received');
        else need(entry.status === 'unavailable' || entry.verification === 'rejected');
        if (entry.resultSha256 !== undefined) need(entry.resultSha256 === records[i].resultSha256 && entry.resultBytes === records[i].resultBytes);
      }
    }
  }
  function validateReads(reads) {
    fields(reads, ['total', 'distinct', 'reads']);
    need(Number.isSafeInteger(reads.total) && reads.total >= 0 && Number.isSafeInteger(reads.distinct) && reads.distinct >= 0 && reads.distinct <= reads.total && Array.isArray(reads.reads) && reads.reads.length === reads.distinct);
  }
  function executionContext(output, call, complete, inputs, startingChanges) {
    if (output === null) { need(!complete); return; }
    const common = ethereumCommon(header, chainId), costs = ethereumCallGas(call.data, common, call), gas = ethereumQuantity(call.gas);
    const feePlan = ethereumFeePlan(call, header, chainId);
    const initial = inputs?.accounts?.[call.from.toLowerCase()];
    const prior = startingChanges?.accounts?.find(row => row.address === call.from.toLowerCase());
    let code = prior?.existence?.after === false ? '0x' : prior?.code?.after ?? (initial?.exists === true ? initial.code : initial?.exists === false ? '0x' : null);
    const preparation = complete ? deriveAuthorizationPreparation({ request: call, header, inputs, common, startingChanges }) : null;
    if (preparation) {
      need(isDeepStrictEqual(output.authorizationProcessing, preparation.processing));
      code = preparation.accounts.get(call.from.toLowerCase()).current.code;
    } else need(output.authorizationProcessing === undefined);
    const delegation = existingDelegationTarget(code, common), advertised = output.semantics?.senderDelegation;
    if (complete) need(code === '0x' || delegation !== null);
    if (preparation) {
      need(output.semantics?.callerNonce === 'outer_increment_authorizations_and_committed_sender_creation_attempts');
      need(isDeepStrictEqual(advertised, delegation === null ? undefined : { address: delegation, authorizationListProcessed: true }));
    } else if (complete && delegation !== null || advertised !== undefined) {
      need(delegation !== null && isDeepStrictEqual(advertised, { address: delegation, authorizationListProcessed: false }));
      need(output.semantics.callerNonce === 'runCall_increment_and_committed_sender_creation_attempts');
    } else {
      need(advertised === undefined && output.semantics?.callerNonce === 'runCall_increments_once_including_EVM_revert');
    }
    if (Object.hasOwn(output, 'lifecycle') || preparation || output.feeAccounting !== undefined || output.stateGasAccounting !== undefined) {
      need(complete);
      // Lifecycle rules are checked below using the authenticated header's
      // fork, never the worker's claimed environment or deletion basis.
      const traceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs, ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}), ...(preparation ? { authorizationProcessing: output.authorizationProcessing } : {}), ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}), ...(output.stateGasAccounting ? { stateGasAccounting: output.stateGasAccounting } : {}) }));
      need(output.usage?.retainedTraceBytes === traceBytes && traceBytes <= limits.execution.traceBytes);
    }
    const environment = { chainId, hardfork: ethereumCommon(header, chainId).hardfork(),
      number: ethereumQuantity(header.number).toString(), timestamp: ethereumQuantity(header.timestamp).toString(),
      gasLimit: ethereumQuantity(header.gasLimit).toString(), baseFeePerGas: feePlan?.baseFeePerGas.toString() ?? '0', mixHash: header.mixHash.toLowerCase(), miner: header.miner.toLowerCase(),
      sourceBlockHash: header.hash, sourceParentHash: header.parentHash.toLowerCase(), sourceBlockIdentityVerified: false,
      ...(common.isActivatedEIP(7843) ? { slotNumber: ethereumQuantity(header.slotNumber).toString() } : {}),
      ...(feePlan?.blobContext ? { blobBaseFeePerGas: feePlan.blobContext.blobBaseFeePerGas.toString() } : {}) };
    if (complete || output.environment !== null) need(isDeepStrictEqual(output.environment, environment));
    if (complete || output.profile !== null) {
      const profile = {
        name: call.executionProfile === 'unsigned_eip4844_block_end' ? 'ethereum_unsigned_eip4844_call' : feePlan ? 'ethereum_unsigned_eip1559_call' : 'ethereum_unsigned_unpriced_call', chainId, hardfork: environment.hardfork,
        forkSchedule: ETHEREUM_NETWORK_SCHEDULES[chainId], sourceBlockHash: header.hash, sourceStateRoot: header.stateRoot.toLowerCase(),
        sourceBlockIdentityVerified: false, sourceStateProofVerified: false,
        actualBlockBaseFee: ethereumQuantity(header.baseFeePerGas).toString(), executionBaseFee: feePlan?.baseFeePerGas.toString() ?? '0', gasPrice: feePlan?.effectiveGasPrice.toString() ?? '0',
        declaredGasLimit: gas.toString(), intrinsicGas: costs.intrinsic.toString(), calldataFloor: costs.floor.toString(), messageGasLimit: (gas - costs.intrinsic).toString(),
        calldataZeroBytes: costs.zeroBytes.toString(), calldataNonzeroBytes: costs.nonzeroBytes.toString(),
        outerSignatureVerified: false, feesSettled: Boolean(feePlan && complete), originalTransactionPosition: false, expectedOutputsUsed: false,
        ...ethereumContextProfile(call, header, common), ...normalizeEthereumFees(call),
      };
      need(isDeepStrictEqual(output.profile, profile));
    }
    if (complete) {
      need(output.stateDisposition === 'message_result_retained_in_supplied_manager');
      const error = output.execution.error;
      need(error === null || (typeof error === 'string' && error.length > 0));
      need(output.execution.status === (error === null ? 'success' : error === 'revert' ? 'reverted' : 'failed'));
    }
    deriveVerifiedGas({ request: call, header, inputs, output, chainId, startingChanges });
    deriveVerifiedFees({ request: call, header, inputs, output, chainId, startingChanges });
    if (complete || output.semantics !== undefined) {
      need(output.semantics?.gasPrice === (feePlan?.effectiveGasPrice.toString() ?? '0'));
      need(output.semantics?.feeSettlement === Boolean(feePlan && complete));
    }
    const authorizationHalt = preparation?.processing.preparation?.phase === 'authorization_out_of_gas';
    if (authorizationHalt) {
      need(complete && output.trace === null && output.usage?.frames === 0 && output.usage?.steps === 0 && output.usage?.maxDepth === 0 && output.usage?.logOpcodes === 0);
    } else if (complete || output.trace !== null) {
      const trace = output.trace;
      const preparedGas = preparation?.processing.preparation?.authorizationGasUsed ?? '0';
      const entryGas = !complete && call.authorizationList !== undefined && common.isActivatedEIP(8037)
        ? deriveAmsterdamAuthorizationEntryGas({ request: call, header, inputs, common, startingChanges })
        : gas - costs.intrinsic - BigInt(preparedGas);
      need(typeof entryGas === 'bigint');
      need(trace?.type === (call.to === null ? 'CREATE' : 'CALL') && trace.from === call.from.toLowerCase() && trace.caller === call.from.toLowerCase() && trace.input === call.data.toLowerCase() && trace.value === '0x' + ethereumQuantity(call.value).toString(16) && trace.gas === '0x' + entryGas.toString(16));
      if (call.to !== null) need(trace.to === call.to.toLowerCase() && trace.executionAddress === call.to.toLowerCase());
      if (complete) need(trace.output === output.execution.returnData && trace.error === output.execution.error && ethereumQuantity(trace.gasUsed) === ethereumQuantity(output.execution.executionGasUsed));
      if (preparation?.processing.preparation?.phase === 'recipient_out_of_gas') {
        // Recipient setup entered the root but could not execute an opcode.
        // An invented failed descendant must not become execution evidence.
        need(output.usage?.frames === 1 && output.usage?.steps === 0 && output.usage?.maxDepth === 0 && output.usage?.logOpcodes === 0);
        need(Array.isArray(trace.calls) && trace.calls.length === 0 && Array.isArray(trace.creationAttempts) && trace.creationAttempts.length === 0);
        need(trace.selfdestruct === undefined && trace.incomplete === undefined);
      }
    }
  }

  function validateCallResult(result, count = records.length, allowNullOutput = false, call = request, startingChanges) {
    fields(result, Object.keys(EMPTY));
    need((allowNullOutput && result.output === null) || (result.output && ['success', 'reverted', 'failed', 'unsupported', 'unavailable', 'invalid'].includes(result.output.execution?.status)));
    validateInputs(result, count);
    executionContext(result.output, call, ['success', 'reverted', 'failed'].includes(result.output?.execution?.status), result.inputs, startingChanges);
    validateExecutionChanges({ changes: result.changes, inputs: result.inputs, output: result.output, sender: call.from, destination: call.to, selfdestructOnlyCreated: ethereumCommon(header, chainId).isActivatedEIP(6780), common: ethereumCommon(header, chainId), request: call, header, chainId, startingChanges });
    for (const reads of [result.stateReads, result.inputReads]) validateReads(reads);
    return result;
  }
  function validateMeasurements(value, call, startingChanges, evidenceFloor) {
    const originalComplete = ['success', 'reverted', 'failed'].includes(value.original?.output?.execution?.status);
    need(Array.isArray(value.measurements) && value.measurements.length === compiledQueries.length);
    function sideQuery(side, compiled, phase) {
      need(side && ['measured', 'unavailable'].includes(side.status));
      const native = compiled.query === null;
      fields(side, ['status', 'reason', 'output', 'values', 'changesBefore', 'changesAfter', ...(native ? ['readMethod'] : ['mutationValidation']), 'inputEvidenceIds', 'stateReads'], ['status', 'reason', 'output', 'values', ...(native ? ['readMethod'] : [])]);
      if (side.inputEvidenceIds !== undefined) need(Array.isArray(side.inputEvidenceIds) && side.inputEvidenceIds.length <= records.length && side.inputEvidenceIds.every((id, i, ids) => Number.isSafeInteger(id) && id > evidenceFloor && id <= records.length && (i === 0 || id === ids[i - 1] + 1)));
      if (side.stateReads !== undefined) validateReads(side.stateReads);
      if (native) need(side.readMethod === 'proof_state_account_balance' && side.output === null);
      if (side.status === 'unavailable') { need(side.values === null && typeof side.reason === 'string'); return; }
      if (native) {
        need(originalComplete && side.reason === null && Array.isArray(side.inputEvidenceIds));
        const account = compiled.descriptor.account, initial = value.inputs.accounts?.[account];
        need(initial && typeof initial.exists === 'boolean');
        // These facts are independently re-proven against the pinned state root
        // before the broker releases any result. Absence is never a default.
        const before = initial.exists ? BigInt(initial.balance) : 0n;
        const change = (phase === 'after' ? value.original.changes : startingChanges).accounts.find(row => row.address === account);
        // Original deltas were already checked against the complete native
        // transfer/fee/deletion ledger by validateCallResult, including omitted
        // deltas. A fresh read cannot supply or modify that poststate.
        const balance = change?.existence?.after === false ? 0n : change?.balance ? BigInt(change.balance.after) : before;
        need(isDeepStrictEqual(side.values, nativeBalanceValues(compiled, balance, { chainId })));
        need(isDeepStrictEqual(side.changesBefore, side.changesAfter));
        need(isDeepStrictEqual(side.changesBefore, phase === 'before' ? startingChanges : value.original.changes));
        need(isDeepStrictEqual(side.stateReads, { total: 1, distinct: 1, reads: [{ kind: 'account', address: account }] }));
        return;
      }
      need(originalComplete && side.reason === null && side.output?.execution?.status === 'success' && side.output.stateDisposition === 'message_result_retained_in_supplied_manager' && Array.isArray(side.output.logs) && side.output.logs.length === 0);
      const trace = side.output.trace, queryRequest = { from: call.from.toLowerCase(), ...compiled.query, value: '0', gas: '1000000' };
      executionContext(side.output, queryRequest, true, value.inputs, side.changesBefore); need(trace.error === null);
      validateExecutionLifecycle({ output: side.output, inputs: value.inputs, destination: queryRequest.to, changes: side.changesAfter, startingChanges: side.changesBefore, selfdestructOnlyCreated: ethereumCommon(header, chainId).isActivatedEIP(6780), common: ethereumCommon(header, chainId) });
      need(isDeepStrictEqual(side.values, decodePreviewValues(compiled, side.output.execution.returnData, { chainId })));
      need(side.changesBefore && side.changesAfter);
      need(isDeepStrictEqual(side.changesBefore, phase === 'before' ? startingChanges : value.original.changes));
      const current = side.changesBefore.accounts.find(row => row.address === queryRequest.from), initial = value.inputs.accounts?.[queryRequest.from];
      need(initial && typeof initial.exists === 'boolean');
      const nonceBefore = current?.nonce ? BigInt(current.nonce.after).toString() : initial.exists ? initial.nonce : '0';
      const mutation = validateQueryMutation({ before: side.changesBefore, after: side.changesAfter, sender: queryRequest.from, nonceBefore, senderExistedBefore: current?.existence ? current.existence.after : initial.exists });
      need(isDeepStrictEqual(side.mutationValidation, mutation));
    }
    for (let i = 0; i < compiledQueries.length; i++) {
      const row = value.measurements[i], compiled = compiledQueries[i];
      fields(row, [...Object.keys(compiled), 'status', 'reason', 'before', 'after', 'values']);
      for (const key of Object.keys(compiled)) need(isDeepStrictEqual(row[key], compiled[key]));
      need(['measured', 'unavailable', 'not_attempted'].includes(row.status));
      if (row.before !== null) sideQuery(row.before, compiled, 'before');
      if (row.after !== null) sideQuery(row.after, compiled, 'after');
      if (row.status === 'measured') {
        need(row.reason === null && row.before?.status === 'measured' && row.after?.status === 'measured');
        const expected = row.before.values.map((item, j) => ({ name: item.name, beforeRaw: item.raw, afterRaw: row.after.values[j].raw, deltaRaw: (BigInt(row.after.values[j].raw) - BigInt(item.raw)).toString(), unit: item.unit }));
        need(isDeepStrictEqual(row.values, expected));
      } else {
        need(row.values === null && typeof row.reason === 'string');
        if (row.status === 'not_attempted') need(row.before === null && row.after === null);
      }
    }
  }
  function validateUsage(usage, outputs, stateReads) {
    const totals = { executions: 0, steps: 0, frames: 0, logs: 0, rootReturnBytes: 0, traceBytes: 0 };
    for (const output of outputs) {
      totals.executions++;
      for (const [name, field] of [['steps', 'steps'], ['frames', 'frames'], ['logs', 'logOpcodes'], ['traceBytes', 'retainedTraceBytes']]) {
        const count = output.usage?.[field] ?? 0; need(Number.isSafeInteger(count) && count >= 0); totals[name] += count;
      }
      const returned = output.execution?.returnData;
      if (returned !== null) { need(typeof returned === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(returned)); totals.rootReturnBytes += (returned.length - 2) / 2; }
      // A resource failure can retain the first over-limit counter as audit
      // evidence. It cannot be followed by another completed execution, or
      // relabeled as a completed execution within the shared sequence budget.
      if (['success', 'reverted', 'failed'].includes(output.execution?.status)) {
        for (const name of ['steps', 'frames', 'logs', 'rootReturnBytes', 'traceBytes']) need(totals[name] <= previewLimits[name]);
      }
    }
    if (stateReads !== undefined) totals.stateReads = stateReads;
    fields(usage, [...Object.keys(totals), 'wallMs', 'limits']);
    need(isDeepStrictEqual(usage.limits, previewLimits));
    for (const [name, count] of Object.entries(totals)) need(Number.isSafeInteger(count) && Number.isSafeInteger(usage[name]) && usage[name] === count);
    need(typeof usage.wallMs === 'number' && Number.isFinite(usage.wallMs) && usage.wallMs >= 0);
  }
  function validatePreviewResult(result) {
    fields(result, ['preview']); const value = result.preview;
    fields(value, ['status', 'error', 'headerVerification', 'original', 'measurements', 'inputs', 'inputEvidence', 'inputUsage', 'inputReads', 'usage', 'scope']);
    need(['complete', 'partial', 'unavailable'].includes(value.status) && isDeepStrictEqual(value.headerVerification, headerVerification));
    validateInputs(value, records.length); validateReads(value.inputReads);
    need(value.original && Number.isSafeInteger(value.original.inputUsage?.calls) && value.original.inputUsage.calls <= records.length);
    validateCallResult(value.original, value.original.inputUsage.calls, true);
    need(isDeepStrictEqual(value.original.inputEvidence, value.inputEvidence.slice(0, value.original.inputEvidence.length)));
    const hasNative = compiledQueries.some(query => query.query === null);
    need(value.scope?.chainId === chainId && value.scope.queries === (hasNative ? 'explicit_calls_and_native_account_balance_reads' : 'explicit_only_same_sender_zero_value_disposable_CALLs') && value.scope.queryGas === '1000000' && value.scope.processIsolation === false);
    need(['consensusVerified', 'contractIdentityVerified', 'originalTransactionReplay'].every(key => value.scope[key] === false));
    if (hasNative) {
      need(value.scope.nativeBalanceCoverage === 'explicit_accounts_only' && value.scope.queryGasScope === 'CALL_only');
      need(value.scope.queryPurity === 'CALL_net_changes_except_expected_sender_nonce_no_committed_logs_native_reads_no_changes');
    } else need(value.scope.nativeBalanceCoverage === undefined && value.scope.queryGasScope === undefined && value.scope.nativeEffectsMeasured === false);
    need(value.usage && isDeepStrictEqual(value.usage.limits, previewLimits));
    need(Array.isArray(value.measurements) && value.measurements.length === compiledQueries.length);
    const originalComplete = ['success', 'reverted', 'failed'].includes(value.original.output?.execution?.status);
    need(value.scope.execution === (request.executionProfile ?? 'unsigned_unpriced_block_end'));
    need(value.scope.feesSettled === Boolean(request.executionProfile && originalComplete));
    validateMeasurements(value, request, canonicalStateChanges(EMPTY_CHANGES), value.original.inputEvidence.length);
    need(value.scope.nativeEffectsMeasured === value.measurements.some(row => row.query === null && row.status === 'measured'));
    if (value.error !== null) {
      fields(value.error, ['code', 'message']); need(value.error.code === 'LOCAL_PREVIEW_INTEGRITY' && value.status === 'unavailable');
      need(value.measurements.every(row => row.status === 'unavailable' && row.values === null && ['before', 'after'].every(side => row[side] === null || row[side].values === null)));
    } else need(value.status === (!originalComplete ? 'unavailable' : value.measurements.every(row => row.status === 'measured') ? 'complete' : 'partial'));
    validateUsage(value.usage, [value.original.output, ...value.measurements.flatMap(row => ['before', 'after'].map(side => row[side]?.output ?? null))].filter(output => output !== null));
    return result;
  }
  function validateSequenceResult(result) {
    fields(result, ['sequence']); const value = result.sequence;
    fields(value, ['status', 'error', 'headerVerification', 'steps', 'inputs', 'inputEvidence', 'inputUsage', 'inputReads', 'usage', 'scope']);
    need(['complete', 'partial', 'unavailable'].includes(value.status) && isDeepStrictEqual(value.headerVerification, headerVerification));
    validateInputs(value, records.length); validateReads(value.inputReads);
    need(Array.isArray(value.steps) && value.steps.length === requests.length);
    let preceding = canonicalStateChanges(EMPTY_CHANGES), stopped = false, lastInputCount = 0, stateReads = 0;
    const outputs = [], completed = [], feesSettled = [];
    for (const [index, step] of value.steps.entries()) {
      fields(step, ['index', 'request', 'status', 'reason', 'original', 'measurements']);
      need(step.index === index && isDeepStrictEqual(step.request, requests[index]));
      need(['completed', 'unavailable', 'not_attempted'].includes(step.status));
      if (step.original === null) {
        need(step.status === 'not_attempted' && typeof step.reason === 'string');
        stopped = true; completed.push(false); feesSettled.push(false); continue;
      }
      need(!stopped && step.status !== 'not_attempted');
      fields(step.original, [...Object.keys(EMPTY), 'startingChanges']);
      // The accepted preceding result is the only transaction-start overlay.
      // All before-values still refer to the immutable header-bound proofs.
      need(isDeepStrictEqual(step.original.startingChanges, preceding));
      const { startingChanges, ...original } = step.original;
      const count = original.inputUsage?.calls;
      need(Number.isSafeInteger(count) && count >= lastInputCount && count <= records.length);
      validateCallResult(original, count, true, requests[index], preceding);
      need(isDeepStrictEqual(original.inputEvidence, value.inputEvidence.slice(0, count)));
      need(original.stateReads.total >= stateReads);
      lastInputCount = count; stateReads = original.stateReads.total;
      const complete = ['success', 'reverted', 'failed'].includes(original.output?.execution?.status);
      if (complete) need(stateReads <= previewLimits.reads);
      completed.push(complete); feesSettled.push(Boolean(complete && requests[index].executionProfile));
      need(step.status === (complete ? 'completed' : 'unavailable'));
      const success = complete && original.output.execution.status === 'success';
      need(success ? step.reason === null : typeof step.reason === 'string');
      if (!complete) need(isDeepStrictEqual(original.changes, preceding));
      preceding = original.changes;
      if (original.output !== null) outputs.push(original.output);
      if (!success) stopped = true;
    }
    let evidenceCursor = lastInputCount;
    for (const [index, step] of value.steps.entries()) {
      validateMeasurements({ original: step.original, measurements: step.measurements, inputs: value.inputs }, requests[index], step.original?.startingChanges ?? preceding, lastInputCount);
      if (!completed[index]) need(step.measurements.every(row => row.status !== 'measured' && row.before === null && row.after === null));
      for (const row of step.measurements) for (const side of [row.before, row.after]) if (side !== null) {
        // Queries occur only after all originals; every new input read belongs
        // to exactly one query phase in the saved execution order.
        need(Array.isArray(side.inputEvidenceIds) && side.stateReads);
        need(side.inputEvidenceIds.every((id, offset) => id === evidenceCursor + offset + 1));
        evidenceCursor += side.inputEvidenceIds.length;
        stateReads += side.stateReads.total;
        if (side.status === 'measured') need(stateReads <= previewLimits.reads);
        if (side.output !== null) outputs.push(side.output);
      }
    }
    need(evidenceCursor === records.length);
    validateUsage(value.usage, outputs, stateReads);
    if (value.status === 'complete') need(stateReads <= previewLimits.reads);
    const hasNative = compiledQueries.some(query => query.query === null);
    const scope = value.scope;
    need(scope?.chainId === chainId && scope.execution === 'ordered_unsigned_same_header_sequence');
    need(isDeepStrictEqual(scope.executionProfiles, requests.map(call => call.executionProfile ?? 'unsigned_unpriced_block_end')));
    need(isDeepStrictEqual(scope.feesSettled, feesSettled));
    need(scope.sameHeader === true && scope.atomic === false && scope.stopOn === 'first_original_non_success');
    need(scope.ordering === 'all_originals_before_disposable_queries' && scope.stateFeeds === 'originals_only');
    need(scope.initialState === 'verified_proofs_and_code_against_hash_bound_header');
    need(['consensusVerified', 'contractIdentityVerified', 'originalTransactionReplay', 'processIsolation'].every(key => scope[key] === false));
    need(scope.allEffectsCoverage === 'not_established' && scope.security === 'not_assessed');
    need(scope.queryGas === '1000000' && scope.queries === (hasNative ? 'explicit_calls_and_native_account_balance_reads' : 'explicit_only_same_sender_zero_value_disposable_CALLs'));
    need(scope.queryPurity === (hasNative ? 'CALL_net_changes_except_expected_sender_nonce_no_committed_logs_native_reads_no_changes' : 'net_changes_except_expected_sender_nonce_no_committed_logs'));
    if (hasNative) need(scope.nativeBalanceCoverage === 'explicit_accounts_only' && scope.queryGasScope === 'CALL_only');
    else need(scope.nativeBalanceCoverage === undefined && scope.queryGasScope === undefined);
    need(scope.nativeEffectsMeasured === value.steps.some(step => step.measurements.some(row => row.query === null && row.status === 'measured')));
    const everyMeasured = value.steps.every(step => step.measurements.every(row => row.status === 'measured'));
    const everySuccess = value.steps.every(step => step.original?.output?.execution?.status === 'success');
    const expired = value.usage.wallMs >= previewLimits.wallMs;
    if (value.error !== null) {
      fields(value.error, ['code', 'message']); need(typeof value.error.message === 'string');
      need(['LOCAL_SEQUENCE_INTEGRITY', 'LOCAL_SEQUENCE_LIMIT'].includes(value.error.code));
      if (value.error.code === 'LOCAL_SEQUENCE_INTEGRITY') {
        need(value.status === 'unavailable');
        need(value.steps.every(step => step.measurements.every(row => row.status === 'unavailable' && row.values === null && [row.before, row.after].every(side => side === null || side.values === null))));
      } else need(expired && value.status === (completed.some(Boolean) ? 'partial' : 'unavailable'));
    } else need(value.status === (!completed.some(Boolean) ? 'unavailable' : everySuccess && everyMeasured && !expired ? 'complete' : 'partial'));
    return result;
  }
  const cancel = () => fail('LOCAL_ISOLATED_CANCELLED', 'The isolated call was cancelled.');
  try {
    if (signal?.aborted) cancel();
    if (!failure) {
      signal?.addEventListener('abort', cancel, { once: true });
      child = childProcess.fork(WORKER, [], { execPath: process.execPath, execArgv: [`--max-old-space-size=${limits.heapMiB}`],
        cwd: fileURLToPath(new URL('.', import.meta.url)), env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
      child.once('error', () => fail('LOCAL_ISOLATED_PROCESS', 'The isolated process could not run.'));
      child.once('close', (code, sig) => {
        closed = true; exitCode = code; exitSignal = sig;
        if (!failure) expired();
        if (!failure && (!candidate || code !== 0 || sig)) fail('LOCAL_ISOLATED_EXIT', 'The isolated process exited without a complete valid result.');
        completion();
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
        if (sealed) return; stdioBytes += bytes.length;
        if (stdioBytes > limits.stdioBytes) fail('LOCAL_ISOLATED_STDIO', 'The isolated process exceeded its diagnostic output bound.');
      });
      child.on('message', raw => {
        if (sealed || failure || expired()) return;
        try {
          need(candidate === null);
          const message = decode(raw, limits.outputBytes);
          if (message.type === 'rpc') {
            need(pendingId === null && records.length < limits.calls);
            validateRpcRequest(message, header.hash, records.length + 1, ancestry.nextHash()); pendingId = message.id;
            void broker(message);
          } else if (message.type === 'result') {
            envelope(message, 'result', ['result']); need(message.id === 1 && pendingId === null); candidate = sequenceMode ? validateSequenceResult(message.result) : previewMode ? validatePreviewResult(message.result) : validateCallResult(message.result);
          } else if (message.type === 'rpc_cancel') {
            envelope(message, 'rpc_cancel', []); need(message.id === pendingId);
            fail('LOCAL_ISOLATED_RPC_CANCELLED', 'The worker cancelled its required pinned read.');
          } else {
            envelope(message, 'failure', ['code']); need(message.id === 1 && message.code === 'LOCAL_ISOLATED_WORKER_FAILED');
            fail('LOCAL_ISOLATED_WORKER_FAILED', 'The isolated worker could not complete.');
          }
        } catch { fail('LOCAL_ISOLATED_PROTOCOL', 'The isolated worker protocol was invalid.'); }
      });
      timer = setTimeout(() => fail('LOCAL_ISOLATED_TIMEOUT', 'The isolated process exceeded its wall-time budget.'), Math.max(1, limits.wallMs - (performance.now() - began)));
      send({ v: 1, type: 'start', id: 1, payload: startPayload }, startBytes);
    }
    await finished;
    if (!failure && candidate) {
      try {
        const cache = new Map(), check = () => need(!expired() && !signal?.aborted);
        const views = sequenceMode ? [...candidate.sequence.steps.map(step => step.original).filter(Boolean), candidate.sequence] : previewMode ? [candidate.preview.original, candidate.preview] : [candidate];
        for (const view of views) {
          check();
          await validateInputFacts({ inputs: view.inputs, inputEvidence: view.inputEvidence, stateRoot: header.stateRoot.toLowerCase(), cache, check, chainId });
          check();
        }
      } catch { fail('LOCAL_ISOLATED_PROTOCOL', 'The isolated worker input facts did not match verified parent evidence.'); }
    }
  } catch { fail('LOCAL_ISOLATED_PROCESS', 'The isolated process could not run.'); await finished; }
  clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
  for (const controller of controllers) controller.abort();
  if (active.size) {
    let drainTimer;
    try { await Promise.race([Promise.allSettled([...active]), new Promise(resolve => { drainTimer = setTimeout(resolve, limits.drainMs); })]); }
    finally { clearTimeout(drainTimer); }
  }
  // Copy and seal once. Adapter promises that disregard abort may settle later,
  // but cannot alter the result or cause any subsequent dispatch.
  sealed = true;
  for (const entry of records) if (entry.status === 'pending') { entry.status = 'unavailable'; entry.error = safe('RPC_ABORTED', 'The pinned read was not admitted before process completion.'); }
  return {
    status: failure ? 'unavailable' : 'completed', error: failure,
    ...(failure ? emptyResult : candidate), headerVerification,
    isolation: { worker: 'engines/local-evm/isolated-worker.js', processSeparated: true, childPid: child?.pid ?? null,
      node: process.version, v8: process.versions.v8, v8OldSpaceMiB: limits.heapMiB, hardTotalRssCap: false,
      osNetworkSandbox: false, osFilesystemSandbox: false, sourceImplementationBound: false,
      wallMs: limits.wallMs, drainMs: limits.drainMs, durationMs: performance.now() - began,
      terminateRequested, processClosed: closed, exitCode, exitSignal, stdioBytes, limits },
    broker: { calls: records.length, dispatches, accountedParsedResultBytes: totalBytes, records: structuredClone(records), pendingAtReturn: active.size,
      rawWireCaptured: false, inRangeBlockhash: 'authenticated_parent_hash_chain_with_shared_input_limits' },
  };
}
