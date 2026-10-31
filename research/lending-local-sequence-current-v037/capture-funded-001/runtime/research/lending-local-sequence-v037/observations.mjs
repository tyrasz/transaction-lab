// Saved-output comparison only. No RPC, VM execution, state repair or retry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { compilePreviewQueries } from '../../engines/local-evm/preview-queries.js';
import { validateInputFacts } from '../../engines/local-evm/input-facts.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { committedLogs, providerOutput } from '../../reports/ethereum-lending-local-reference/compare.mjs';
import { normalizeProviderStateDiff } from '../../engines/standard-evm/provider-state-diff.js';
import { composeSequenceOverrides } from '../../engines/standard-evm/sequence-state.js';
import { normalizeStatePair } from './state-observations.mjs';
import { validateLocalOriginalContext, validateLocalQueryContext, validateProviderHeaders,
  validateProviderQueryMutation, CONTEXT_VALIDATION_SCOPE } from './context-validation.mjs';

export const ORIGINAL_CHANNELS = Object.freeze(['executionStatus', 'returnData', 'chargedGas', 'orderedLogs', 'observedNetState']);
export const QUERY_CHANNELS = Object.freeze(['beforeReturnData', 'afterReturnData', 'rawValues']);
// Getter snapshots are meaningful only after each side's original overlay has
// been anchored independently. Valid but different overlays remain comparable.
export function requireQueryState(state) {
  assert(state?.status === 'comparable' && state.localChanges && state.providerChanges,
    'One or both original state overlays are unavailable; getter state is not validated');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uint = value => { assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)); const n = BigInt(value); assert(n < 2n ** 256n); return n; };
const bytes = value => { assert(typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(value) && value.length <= 8 * 1024 * 1024); return value; };
const nil = names => Object.fromEntries(names.map(name => [name, null]));
const message = error => String(error?.message ?? error).slice(0, 500);
const equal = (a, b, why) => assert(same(a, b), why);

function traceBinding(trace, request, gas) {
  assert(trace?.type === 'CALL');
  equal([trace.from, trace.to, trace.input], [request.from, request.to, request.data], 'Trace call differs from declaration');
  assert(BigInt(trace.value ?? '0x0') === BigInt(request.value ?? '0'));
  assert(BigInt(trace.gas) === BigInt(gas));
  providerOutput(trace);
}
function wireJoin(evidence, transport) {
  assert(Array.isArray(evidence) && Array.isArray(transport) && transport.length <= 260);
  for (const row of evidence) {
    if (row.status !== undefined && row.status !== 'received') continue;
    const request = row.request ?? { method: row.method, params: row.params };
    const candidates = transport.filter(w => w.request?.method === request.method && same(w.request?.params, request.params));
    assert(candidates.some(w => {
      if (!w.transport?.complete || typeof w.responseText !== 'string') return false;
      const response = Buffer.from(w.responseText);
      if (w.transport.responseSha256 !== sha(response) || w.transport.observedBytes !== response.length) return false;
      if (w.requestText !== JSON.stringify(w.request) || w.requestSha256 !== sha(w.requestText)) return false;
      let parsed; try { parsed = JSON.parse(w.responseText); } catch { return false; }
      return parsed.id === w.request.id && parsed.jsonrpc === '2.0' && !Object.hasOwn(parsed, 'error') && same(parsed.result, row.result);
    }), 'Execution evidence does not join a complete retained RPC response');
  }
}
function rawFields(compiled, value) {
  bytes(value); assert(value.length === 2 + compiled.returnBytes * 2, 'Getter return length differs');
  return compiled.fields.map((field, index) => {
    const raw = BigInt('0x' + value.slice(2 + index * 64, 66 + index * 64));
    assert(raw < 2n ** BigInt(field.bits), 'Noncanonical ABI integer padding');
    return { name: field.name, raw: raw.toString() };
  });
}
function expectedValues(compiled, before, after) {
  const a = rawFields(compiled, before), b = rawFields(compiled, after);
  return a.map((field, i) => ({ name: field.name, beforeRaw: field.raw, afterRaw: b[i].raw, deltaRaw: (BigInt(b[i].raw) - BigInt(field.raw)).toString() }));
}
function projectedValues(rows) {
  assert(Array.isArray(rows));
  return rows.map(({ name, beforeRaw, afterRaw, deltaRaw }) => {
    assert(typeof name === 'string'); assert((uint(afterRaw) - uint(beforeRaw)).toString() === deltaRaw);
    return { name, beforeRaw, afterRaw, deltaRaw };
  });
}
function providerQueryBytes(result, measurement, side, compiled, from, blockHash, expectedOverrides) {
  assert(Array.isArray(measurement.queryEvidence));
  const matches = measurement.queryEvidence.filter(q => q.state === side); assert(matches.length === 1);
  const reference = matches[0];
  const traces = result.evidence.filter(e => e.id === reference.traceEvidenceId);
  const mutations = result.evidence.filter(e => e.id === reference.mutationEvidenceId);
  assert(traces.length === 1 && mutations.length === 1, 'Missing or duplicate getter evidence');
  const trace = traces[0], mutation = mutations[0];
  assert(trace.method === 'debug_traceCall' && mutation.method === trace.method);
  const request = { from, ...compiled.query, value: '0x0', gas: '0x493e0' };
  equal(trace.params[0], request, 'Provider getter request differs');
  equal(trace.params[1], { blockHash, requireCanonical: true });
  assert(trace.params[2]?.tracer === 'callTracer' && mutation.params[2]?.tracer === 'prestateTracer');
  equal(mutation.params.slice(0, 2), trace.params.slice(0, 2));
  equal(mutation.params[2]?.stateOverrides, trace.params[2]?.stateOverrides);
  equal(mutation.params[2]?.blockOverrides, trace.params[2]?.blockOverrides);
  equal(trace.params[2]?.stateOverrides, expectedOverrides, 'Getter queried the wrong sequence state');
  assert(!Object.hasOwn(trace.params[2], 'blockOverrides'), 'Unexpected getter block overrides');
  traceBinding(trace.result, { from, ...compiled.query, value: '0' }, '300000');
  assert(!Object.hasOwn(trace.result, 'error'));
  return bytes(providerOutput(trace.result));
}

/** Query amounts are agreement under DIFFERENT getter gas limits, not an
 * exact-context differential execution test. Missing/unmeasured is always null. */
export function compareQueryObservation({ compiled, local, provider, providerResult, from, blockHash, expectedOverrides }) {
  const result = { identity: compiled.identity, channels: nil(QUERY_CHANNELS), error: null,
    scope: 'corresponding_sequence_snapshots_different_getter_gas_limits', localGas: '1000000', providerGas: '300000' };
  try {
    assert(local?.status === 'measured' && provider?.status === 'measured', 'One or both getter measurements are unavailable');
    equal(local.descriptor, compiled.descriptor); equal(local.query, compiled.query); equal(local.identity, compiled.identity);
    assert(local.returnBytes === compiled.returnBytes); equal(provider.query, compiled.query);
    for (const side of ['before', 'after']) {
      assert(local[side]?.status === 'measured' && local[side]?.output?.execution?.status === 'success');
      const trace = local[side].output.trace;
      equal([trace?.from, trace?.to, trace?.input], [from, compiled.query.to, compiled.query.data], 'Local getter trace differs');
      assert(BigInt(trace.value ?? '0') === 0n);
    }
    const lb = bytes(local.before.output.execution.returnData), la = bytes(local.after.output.execution.returnData);
    assert(expectedOverrides && Object.hasOwn(expectedOverrides, 'before') && Object.hasOwn(expectedOverrides, 'after'));
    const pb = providerQueryBytes(providerResult, provider, 'before', compiled, from, blockHash, expectedOverrides.before);
    const pa = providerQueryBytes(providerResult, provider, 'after', compiled, from, blockHash, expectedOverrides.after);
    const lv = expectedValues(compiled, lb, la), pv = expectedValues(compiled, pb, pa);
    equal(projectedValues(local.values), lv, 'Local projected amounts differ from returned ABI words');
    if (provider.position) {
      const { contractIdentityVerified, ...identity } = compiled.identity;
      equal(provider.position.identity, identity); assert(provider.position.returnBytes === compiled.returnBytes);
      equal([provider.beforeReturnData, provider.afterReturnData], [pb, pa]);
      equal(projectedValues(provider.rows), pv, 'Provider position amounts differ from ABI words');
    } else {
      assert(compiled.fields.length === 1);
      equal(projectedValues([{ name: compiled.fields[0].name, ...provider }]), pv, 'Provider token amounts differ from ABI words');
    }
    result.channels = { beforeReturnData: lb === pb, afterReturnData: la === pa, rawValues: same(lv, pv) };
    result.localValues = lv; result.providerValues = pv;
  } catch (error) { result.error = message(error); }
  return result;
}

/** Join every projected diff to its retained raw prestate result and verify
 * exact carried overrides on original and query requests. These two canonical
 * normalization/composition helpers are shared with production; the separate
 * state module independently checks arithmetic against initial proof facts. */
export function providerSequenceContexts({ steps, calls, from, blockHash }) {
  assert(steps.length === calls.length);
  let previous;
  return steps.map((step, index) => {
    if (!step.result) { assert(step.status === 'skipped'); return null; }
    const result = step.result, call = calls[index];
    const request = { from, to: call.to, data: call.data, value: '0x' + BigInt(call.value).toString(16), gas: '0x4c4b40' };
    const records = result.evidence.filter(e => e.method === 'debug_traceCall' && same(e.params[0], request)
      && same(e.params[1], { blockHash, requireCanonical: true }));
    const traces = records.filter(e => e.params[2]?.tracer === 'callTracer');
    const diffs = records.filter(e => e.params[2]?.tracer === 'prestateTracer');
    assert(traces.length === 1 && diffs.length === 1, 'Original trace/diff evidence missing or ambiguous');
    equal(traces[0].result, result.execution.trace);
    for (const e of [traces[0], diffs[0]]) {
      assert(e.params.length === 3, 'Unexpected original RPC arguments');
      equal(e.params[2].stateOverrides, previous, 'Original uses the wrong preceding state');
      const isDiff = e === diffs[0];
      equal(e.params[2], { tracer: isDiff ? 'prestateTracer' : 'callTracer', timeout: '15s',
        tracerConfig: isDiff ? { diffMode: true } : { withLog: true },
        ...(previous === undefined ? {} : { stateOverrides: previous }) }, 'Unexpected original tracer context');
    }
    assert(diffs[0].params[2].tracerConfig?.diffMode === true);
    const diff = normalizeProviderStateDiff(diffs[0].result).diff;
    equal(result.stateDiff, diff, 'Projected state diff differs from retained raw evidence');
    assert(!result.nativeEffects?.stateNormalization?.length, 'Absent-account normalization is outside this comparator');
    const after = composeSequenceOverrides(previous ?? {}, diff).overrides;
    const context = { before: previous, after }; previous = after; return context;
  });
}

export function compareOriginalObservation({ localStep, providerStep, request, blockHash }) {
  const result = { channels: nil(ORIGINAL_CHANNELS), error: null };
  try {
    assert(localStep?.status === 'completed' && ['completed', 'reverted_or_failed'].includes(providerStep?.status), 'One or both original executions are unavailable or skipped');
    const local = localStep.original.output, provider = providerStep.result;
    equal(localStep.request, request, 'Local original request differs');
    assert(provider.canonicalStatus === 'verified');
    assert(['success', 'reverted', 'failed'].includes(local.execution.status));
    assert(['success', 'reverted_or_failed'].includes(provider.execution.status));
    assert(provider.execution.status === (Object.hasOwn(provider.execution.trace, 'error') ? 'reverted_or_failed' : 'success'), 'Projected provider execution status contradicts its trace');
    equal(provider.executionIdentity.stateBlockHash, blockHash);
    assert(provider.executionIdentity.executionBaseFee === '0');
    traceBinding(provider.execution.trace, request, '5000000');
    assert(provider.evidence.some(e => e.method === 'debug_traceCall' && same(e.result, provider.execution.trace)
      && same(e.params[1], { blockHash, requireCanonical: true })
      && same(e.params[0], { from: request.from, to: request.to, data: request.data, value: '0x' + BigInt(request.value).toString(16), gas: '0x4c4b40' })), 'Original trace is not joined to its declared request');
    equal(provider.execution.returnData, providerOutput(provider.execution.trace));
    const accounting = local.gasAccounting;
    const charged = uint(accounting.beforeRefund) - uint(accounting.appliedRefund) + uint(accounting.floorAdjustment);
    assert(charged >= 0n && charged <= 5000000n && charged === uint(accounting.gasUsed));
    assert(uint(provider.execution.gasUsed) === BigInt(provider.execution.trace.gasUsed));
    const localLogs = local.logs.map(({ address, topics, data }) => ({ address, topics, data }));
    const providerLogs = committedLogs(provider.execution.trace);
    const status = local.execution.status === 'success' ? 'success' : 'reverted_or_failed';
    result.channels = { ...result.channels, executionStatus: status === provider.execution.status,
      returnData: bytes(local.execution.returnData) === bytes(provider.execution.returnData),
      chargedGas: charged.toString() === provider.execution.gasUsed, orderedLogs: same(localLogs, providerLogs) };
    result.localStatus = local.execution.status; result.providerStatus = provider.execution.status;
    result.localGas = charged.toString(); result.providerGas = provider.execution.gasUsed;
  } catch (error) { result.error = message(error); }
  return result;
}

export async function compareLendingSequence({ declaration, localRecord, providerRecord }) {
  const compiled = compilePreviewQueries(declaration.localInput.queries, { chainId: 1 });
  const result = { id: declaration.id, declaredPositions: declaration.localInput.calls.length, gateError: null,
    scope: { originals: 'unsigned_unpriced_same_header_5M_call', state: 'observed_cumulative_net_changes_not_complete_chain_state_root',
      queries: 'observational_agreement_under_1M_local_and_300k_provider_gas', providerGasPriceIndependentlyWitnessed: false,
      protocolIdentityIndependentlyAttested: false, allEffectsCovered: false,
      transportGate: 'requires_complete_successful_evidence_error_rows_withhold_sequence',
      sharedValidation: ['initial_proof_verifier', 'query_descriptor_compiler', 'provider_diff_canonicalizer_and_override_composer'] }, steps: [] };
  result.contextValidationScope = CONTEXT_VALIDATION_SCOPE;
  let core, reference, states, providerContexts, header;
  try {
    assert(localRecord?.status === 'returned' && providerRecord?.status === 'returned');
    assert(localRecord.sourceUnchanged === true && providerRecord.sourceUnchanged === true);
    const local = localRecord.report; reference = providerRecord.report;
    equal(local.apiRequest, declaration.localInput); equal(reference.apiRequest, declaration.providerInput);
    assert(local.source.canonicalStatus === 'verified' && reference.canonicalStatus === 'verified');
    assert(local.attempt?.status === 'completed'); core = local.attempt.sequence;
    assert(core.steps.length === result.declaredPositions && reference.steps.length === result.declaredPositions);
    for (let i = 0; i < result.declaredPositions; i++) {
      assert(core.steps[i].index === i && reference.steps[i].index === i);
      equal(core.steps[i].request, { from: declaration.from, ...declaration.localInput.calls[i] }, 'Core request differs from declared call');
    }
    header = local.source.blockSelection.header;
    verifyEthereumHeader({ header, expectedHash: declaration.header.hash, chainId: 1 });
    equal(core.inputs.context.blockHash, declaration.header.hash);
    equal(core.headerVerification.blockHash, declaration.header.hash);
    wireJoin(core.inputEvidence, localRecord.rpcEvidence);
    await validateInputFacts({ inputs: core.inputs, inputEvidence: core.inputEvidence, stateRoot: header.stateRoot, chainId: 1 });
    for (const step of reference.steps) if (step.result) wireJoin(step.result.evidence, providerRecord.rpcEvidence);
    providerContexts = providerSequenceContexts({ steps: reference.steps, calls: declaration.localInput.calls, from: declaration.from, blockHash: declaration.header.hash });
    for (let i = 0; i < result.declaredPositions; i++) {
      if (core.steps[i].status === 'completed') validateLocalOriginalContext({ step: core.steps[i], request: { from: declaration.from, ...declaration.localInput.calls[i] }, header });
      if (reference.steps[i].result) validateProviderHeaders({ result: reference.steps[i].result, header, from: declaration.from, expectedOverrides: providerContexts[i] });
    }
    states = normalizeStatePair({ localSteps: core.steps, providerSteps: reference.steps, initialInputs: core.inputs });
  } catch (error) { result.gateError = message(error); }
  for (let index = 0; index < result.declaredPositions; index++) {
    const unavailable = reason => ({ channels: nil(ORIGINAL_CHANNELS), error: reason });
    const row = { index, operation: declaration.steps[index].operation,
      original: result.gateError ? unavailable(result.gateError) : compareOriginalObservation({ localStep: core.steps[index], providerStep: reference.steps[index],
        request: { from: declaration.from, ...declaration.localInput.calls[index] }, blockHash: declaration.header.hash }), queries: [] };
    if (!result.gateError) { row.state = states.steps[index]; row.original.channels.observedNetState = row.original.error ? null : row.state?.matches ?? null; }
    for (let q = 0; q < compiled.length; q++) {
      const unavailable = error => ({ identity: compiled[q].identity, channels: nil(QUERY_CHANNELS), error });
      if (result.gateError) { row.queries.push(unavailable(result.gateError)); continue; }
      try {
        requireQueryState(row.state);
        const local = core.steps[index]?.measurements[q], provider = reference.steps[index]?.result?.measurements[q];
        assert(local?.status === 'measured' && provider?.status === 'measured', 'One or both getter measurements are unavailable');
        validateLocalQueryContext({ measurement: local, original: core.steps[index].original, from: declaration.from, header,
          compiled: compiled[q], initialInputs: core.inputs });
        validateProviderQueryMutation({ result: reference.steps[index].result, measurement: provider, from: declaration.from,
          expectedOverrides: providerContexts[index], initialInputs: core.inputs });
        row.queries.push(compareQueryObservation({ compiled: compiled[q], local, provider, providerResult: reference.steps[index].result,
          from: declaration.from, blockHash: declaration.header.hash, expectedOverrides: providerContexts[index] }));
      } catch (error) { row.queries.push(unavailable(message(error))); }
    }
    result.steps.push(row);
  }
  const count = values => ({ matched: values.filter(x => x === true).length, mismatched: values.filter(x => x === false).length, unavailable: values.filter(x => x === null).length });
  result.counts = { originalChannels: count(result.steps.flatMap(s => Object.values(s.original.channels))),
    queryChannels: count(result.steps.flatMap(s => s.queries.flatMap(q => Object.values(q.channels)))) };
  return result;
}
