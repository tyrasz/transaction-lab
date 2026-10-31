// Saved-output validation only. The caller verifies the immutable input proofs,
// joins every referenced evidence row to retained transport, and validates the
// preceding original overlays before invoking these checks. No VM or RPC runs.
import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { ethereumCallGas, ethereumCommon, ethereumUsedGas } from '../../engines/local-evm/ethereum-profile.js';
import { ETHEREUM_NETWORK_SCHEDULES } from '../../engines/local-evm/ethereum-network.js';
import { canonicalStateChanges, validateQueryMutation } from '../../engines/local-evm/preview-mutations.js';
import { validateQueryDiff, validateQueryTrace, validatePositionTrace } from '../../engines/standard-evm/unsigned-call.js';
import { committedLogs, providerOutput } from '../../reports/ethereum-lending-local-reference/compare.mjs';

export const CONTEXT_VALIDATION_SCOPE = Object.freeze({
  mode: 'saved_only_no_execution', chainId: 1, originalGas: '5000000', localQueryGas: '1000000', providerQueryGas: '300000',
  providerGasPriceIndependentlyWitnessed: false,
  providerHeaderWitness: 'NUMBER_TIMESTAMP_GASLIMIT_BASEFEE_PREVRANDAO_COINBASE_CHAINID_parent_BLOCKHASH',
  sharedValidation: ['execution_header_hash', 'fork_and_intrinsic_gas_selection', 'historical_scalar_gas_arithmetic', 'local_nonce_only_query_mutation',
    'provider_nonce_only_query_diff_and_read_trace'],
  gasValidation: 'accounting_bound_to_root_message_gas_and_reported_refund_counter_not_independent_refund_eligibility',
  initialProofsAndTransportJoin: 'required_externally',
  queryPurity: 'no_committed_logs_and_net_changes_except_expected_sender_nonce_not_no_transient_writes',
});
const PROBE = '0x000000000000000000000000000000000000ba1a';
const ADDRESS = /^0x[0-9a-f]{40}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const own = (value, key) => Object.hasOwn(value, key);
const eq = (a, b, why) => assert(same(a, b), why);
const hex = value => '0x' + value.toString(16);
function quantity(value, bits = 256) {
  assert(typeof value === 'string' && /^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-f][0-9a-f]*))$/.test(value) && value.length <= 80, 'Invalid exact quantity');
  const n = BigInt(value); assert(n < (1n << BigInt(bits)), 'Quantity overflow'); return n;
}
function data(value) { assert(typeof value === 'string' && DATA.test(value) && value.length <= 8 * 1024 * 1024); return value; }
function address(value) { assert(typeof value === 'string' && ADDRESS.test(value)); return value; }
function record(value) { assert(value && typeof value === 'object' && !Array.isArray(value)); return value; }
function pair(value) {
  record(value); eq(Object.keys(value).sort(), ['after', 'before'], 'Expected explicit before/after state pair');
  assert(value.before === undefined || (value.before && typeof value.before === 'object' && !Array.isArray(value.before)));
  record(value.after); return value;
}
function source(header) {
  verifyEthereumHeader({ header, expectedHash: header.hash, chainId: 1 });
  return ethereumCommon(header, 1);
}
function localOutput(output, request, header, gas) {
  record(output); eq(Object.keys(request).sort(), ['data', 'from', 'gas', 'to', 'value'], 'Unsupported local context');
  address(request.from); address(request.to); data(request.data);
  assert(request.gas === gas && request.value === '0');
  const common = source(header), costs = ethereumCallGas(request.data, common, request), total = quantity(gas);
  assert(total >= costs.minimum);
  const environment = { chainId: 1, hardfork: common.hardfork(), number: quantity(header.number).toString(),
    timestamp: quantity(header.timestamp).toString(), gasLimit: quantity(header.gasLimit).toString(), baseFeePerGas: '0',
    mixHash: header.mixHash, miner: header.miner, sourceBlockHash: header.hash, sourceParentHash: header.parentHash,
    sourceBlockIdentityVerified: false };
  eq(output.environment, environment, 'Local execution environment differs from source header/unpriced profile');
  eq(output.profile, { name: 'ethereum_unsigned_unpriced_call', chainId: 1, hardfork: common.hardfork(),
    forkSchedule: ETHEREUM_NETWORK_SCHEDULES[1], sourceBlockHash: header.hash, sourceStateRoot: header.stateRoot,
    sourceBlockIdentityVerified: false, sourceStateProofVerified: false,
    actualBlockBaseFee: quantity(header.baseFeePerGas).toString(), executionBaseFee: '0', gasPrice: '0',
    declaredGasLimit: gas, intrinsicGas: costs.intrinsic.toString(), calldataFloor: costs.floor.toString(),
    messageGasLimit: (total - costs.intrinsic).toString(), calldataZeroBytes: costs.zeroBytes.toString(),
    calldataNonzeroBytes: costs.nonzeroBytes.toString(), outerSignatureVerified: false, feesSettled: false,
    originalTransactionPosition: false, expectedOutputsUsed: false }, 'Local declared execution profile differs');
  assert(output.semantics?.gasPrice === '0' && output.semantics?.feeSettlement === false, 'Local fee semantics differ');
  assert(output.stateDisposition === 'message_result_retained_in_supplied_manager');
  const trace = record(output.trace), execution = record(output.execution);
  eq([trace.type, trace.from, trace.to, trace.caller, trace.executionAddress, trace.input, trace.depth],
    ['CALL', request.from, request.to, request.from, request.to, request.data, 0], 'Local root call differs');
  assert(trace.value === '0x0' && trace.gas === hex(total - costs.intrinsic), 'Local root message gas/value differs');
  assert(quantity(trace.gasUsed) <= total - costs.intrinsic && quantity(trace.gasUsed) === quantity(execution.executionGasUsed));
  assert(trace.error === null || (typeof trace.error === 'string' && trace.error.length > 0 && trace.error.length <= 2000));
  assert(execution.error === trace.error, 'Local projected error differs from root trace');
  assert(execution.status === (trace.error === null ? 'success' : trace.error === 'revert' ? 'reverted' : 'failed'), 'Local projected status differs from root trace');
  assert(data(trace.output) === data(execution.returnData), 'Local projected return differs from root trace');
  assert(!common.isActivatedEIP(8037) && !own(output, 'stateGasAccounting') && !own(execution, 'executionStateGasUsed'), 'State-gas dimensions are outside this historical declaration');
  assert(!own(output, 'authorizationProcessing') && !own(output, 'feeAccounting'), 'Authorization or priced accounting is outside this declaration');
  const messageGasUsed = quantity(execution.executionGasUsed), refundCounter = quantity(execution.gasRefundCounter);
  assert(execution.executionGasUsed === messageGasUsed.toString() && execution.gasRefundCounter === refundCounter.toString(), 'Execution gas counters must be canonical decimal strings');
  // Shared arithmetic binds all four accounting fields to the retained root
  // consumption, fixed intrinsic/floor and reported refund counter. It does not
  // independently prove that execution earned the reported refund counter.
  const accounting = ethereumUsedGas({ messageGasUsed, refundCounter, intrinsic: costs.intrinsic, floor: costs.floor });
  assert(accounting.gasUsed <= total);
  eq(output.gasAccounting, Object.fromEntries(Object.entries(accounting).map(([key, value]) => [key, value.toString()])),
    'Local gas accounting differs from root consumption and declared intrinsic/refund/floor');
  assert(Array.isArray(output.logs) && output.logs.length <= 2000);
  return true;
}

export function validateLocalOriginalContext({ step, request, header }) {
  assert(step?.status === 'completed'); eq(step.request, request, 'Local step request differs');
  return localOutput(step.original?.output, request, header, '5000000');
}

function initialSender(initialInputs, from, blockHash, stateRoot) {
  assert(initialInputs?.context?.chainId === 1 && initialInputs.context.blockHash === blockHash);
  if (stateRoot !== undefined) assert(initialInputs.context.stateRoot === stateRoot);
  const a = record(initialInputs.accounts?.[address(from)]);
  assert(a.exists === true && a.code === '0x', 'Only authenticated existing code-free senders are supported');
  quantity(a.nonce, 64); quantity(a.balance);
  return a;
}
function localSenderAt(initial, snapshot, from) {
  const canonical = canonicalStateChanges(snapshot), rows = canonical.accounts.filter(row => row.address === from);
  assert(rows.length <= 1); const row = rows[0];
  if (row) {
    assert(Object.keys(row).every(key => ['address', 'nonce', 'balance'].includes(key)), 'Unsupported sender lifecycle/storage context');
    for (const field of ['nonce', 'balance']) if (row[field]) assert(quantity(row[field].before) === quantity(initial[field]));
  }
  return { nonce: quantity(row?.nonce?.after ?? initial.nonce, 64), balance: quantity(row?.balance?.after ?? initial.balance) };
}

export function validateLocalQueryContext({ measurement, original, from, header, compiled, initialInputs }) {
  assert(measurement?.status === 'measured' && compiled?.query !== null);
  eq(measurement.descriptor, compiled.descriptor); eq(measurement.query, compiled.query); eq(measurement.identity, compiled.identity);
  const initial = initialSender(initialInputs, from, header.hash, header.stateRoot);
  if (original.inputs) {
    assert(original.inputs.context?.blockHash === header.hash && original.inputs.context?.stateRoot === header.stateRoot);
    const reported = record(original.inputs.accounts?.[from]);
    for (const field of ['exists', 'nonce', 'balance', 'code']) eq(reported[field], initial[field], 'Per-step sender facts differ from verified initial facts');
  }
  for (const side of ['before', 'after']) {
    const half = measurement[side], expected = side === 'before' ? original.startingChanges : original.changes;
    assert(half?.status === 'measured'); eq(half.changesBefore, expected, 'Local getter used the wrong original snapshot');
    const sender = localSenderAt(initial, expected, from);
    localOutput(half.output, { from, ...compiled.query, value: '0', gas: '1000000' }, header, '1000000');
    assert(half.output.execution.status === 'success' && half.output.logs.length === 0, 'Local getter failed or committed logs');
    const validation = validateQueryMutation({ before: half.changesBefore, after: half.changesAfter, sender: from,
      nonceBefore: sender.nonce.toString(), senderExistedBefore: true });
    eq(half.mutationValidation, validation, 'Local getter mutation claim differs from checked changes');
  }
  return true;
}

function evidence(result) {
  assert(Array.isArray(result?.evidence) && result.evidence.length <= 64);
  const ids = new Set();
  for (const row of result.evidence) {
    assert(Number.isSafeInteger(row.id) && row.id > 0 && !ids.has(row.id)); ids.add(row.id);
    assert(typeof row.method === 'string' && Array.isArray(row.params));
  }
  return result.evidence;
}
function one(rows, test, why) {
  const found = rows.filter(test); assert(found.length === 1, why);
  assert(own(found[0], 'result') && !own(found[0], 'error'), 'Evidence result unavailable'); return found[0];
}
function providerOptions(options, overrides, diff = false) {
  eq(options, { tracer: diff ? 'prestateTracer' : 'callTracer', timeout: '15s',
    tracerConfig: diff ? { diffMode: true } : { withLog: true },
    ...(overrides === undefined ? {} : { stateOverrides: overrides }) }, 'Unexpected provider tracer context');
}
function providerRoot(trace, call) {
  eq([trace.type, trace.from, trace.to, trace.input], ['CALL', call.from, call.to, call.data], 'Provider root call differs');
  assert(quantity(trace.value ?? '0x0') === 0n && quantity(trace.gas) === quantity(call.gas));
  assert(quantity(trace.gasUsed) > 0n && quantity(trace.gasUsed) <= quantity(call.gas));
  assert(!own(trace, 'error') && !own(trace, 'revertReason'), 'Provider getter/witness failed');
  return data(providerOutput(trace));
}

export function validateProviderHeaders({ result, header, from, expectedOverrides }) {
  source(header); address(from); pair(expectedOverrides);
  assert(result.canonicalStatus === 'verified'); const rows = evidence(result);
  const chain = one(rows, e => e.method === 'eth_chainId' && same(e.params, []), 'Missing or ambiguous chain identity');
  assert(quantity(chain.result) === 1n);
  const first = one(rows, e => e.method === 'eth_getBlockByHash' && same(e.params, [header.hash, false]), 'Missing source header');
  const last = one(rows, e => e.method === 'eth_getBlockByNumber' && same(e.params, [hex(quantity(header.number)), false]), 'Missing final header');
  verifyEthereumHeader({ header: first.result, expectedHash: header.hash, chainId: 1 });
  verifyEthereumHeader({ header: last.result, expectedHash: header.hash, chainId: 1 });
  eq(last.result, first.result, 'Provider canonical header/body metadata changed');
  assert(first.id < last.id);
  const identity = { hash: header.hash, parentHash: header.parentHash, mixHash: header.mixHash, miner: header.miner,
    ...Object.fromEntries(['number', 'timestamp', 'gasLimit', 'baseFeePerGas'].map(key => [key, quantity(header[key]).toString()])) };
  eq(result.block, identity, 'Provider source header projection differs');
  const execution = result.executionIdentity;
  eq([execution?.chainId, execution?.stateBlockHash, execution?.blockNumber, execution?.timestamp, execution?.actualBlockBaseFee, execution?.executionBaseFee],
    ['1', header.hash, identity.number, identity.timestamp, identity.baseFeePerGas, '0'], 'Provider execution context differs');
  assert(result.request?.transaction && result.request.transaction.from === from);
  assert(Object.keys(result.request.transaction).every(key => ['from', 'to', 'data', 'value', 'gas'].includes(key)), 'Optional provider contexts are outside this declaration');
  const native = result.nativeEffects?.measurements; assert(Array.isArray(native) && native.length <= 8);
  const accounts = native.map(row => address(row.account)); assert(new Set(accounts).size === accounts.length && !accounts.includes(PROBE));
  let code = '0x43600052426020524560405248606052446080524160a0524660c0527f'
    + (quantity(header.number) - 1n).toString(16).padStart(64, '0') + '4060e052';
  for (const [i, account] of accounts.entries()) code += '73' + account.slice(2) + '3161' + (256 + 32 * i).toString(16).padStart(4, '0') + '52';
  code += '61' + (256 + 32 * native.length).toString(16).padStart(4, '0') + '6000f3';
  const witnesses = rows.filter(e => e.method === 'debug_traceCall' && e.params[0]?.to === PROBE && e.params[2]?.tracer === 'callTracer');
  assert(witnesses.length === 2 && witnesses[0].id < witnesses[1].id, 'Missing or ambiguous header witnesses');
  const words = [header.number, header.timestamp, header.gasLimit, '0', header.mixHash, header.miner, '1', header.parentHash].map(BigInt);
  const call = { from, to: PROBE, data: '0x', value: '0x0', gas: '0x493e0' };
  for (const [i, side] of ['before', 'after'].entries()) {
    const row = witnesses[i]; assert(own(row, 'result') && !own(row, 'error'));
    assert(row.params.length === 3, 'Unexpected header witness RPC arguments');
    eq(row.params.slice(0, 2), [call, { blockHash: header.hash, requireCanonical: true }]);
    assert(!own(expectedOverrides[side] ?? {}, PROBE));
    providerOptions(row.params[2], { ...(expectedOverrides[side] ?? {}), [PROBE]: { code } });
    const output = providerRoot(row.result, call);
    assert((row.result.calls ?? []).length === 0 && Array.isArray(row.result.calls ?? []));
    assert((row.result.logs ?? []).length === 0 && Array.isArray(row.result.logs ?? []));
    assert(output.length === 2 + 64 * (8 + native.length), 'Header witness output length differs');
    for (const [j, expected] of words.entries()) assert(BigInt('0x' + output.slice(2 + j * 64, 66 + j * 64)) === expected, 'Header witness word differs');
    for (const [j, measurement] of native.entries()) {
      assert(quantity(measurement[side + 'Raw']) === BigInt('0x' + output.slice(514 + j * 64, 578 + j * 64)), 'Native witness projection differs');
    }
  }
  // GASPRICE is absent from the stock probe; zero follows the no-fee envelope
  // and provider implementation contract, not an independently observed word.
  return true;
}

export function validateProviderQueryMutation({ result, measurement, from, expectedOverrides, initialInputs }) {
  pair(expectedOverrides); assert(measurement?.status === 'measured'); const rows = evidence(result);
  const blockHash = initialInputs?.context?.blockHash;
  assert(result.executionIdentity?.stateBlockHash === blockHash && result.canonicalStatus === 'verified');
  const initial = initialSender(initialInputs, from, blockHash);
  assert(Array.isArray(measurement.queryEvidence) && measurement.queryEvidence.length === 2);
  for (const side of ['before', 'after']) {
    const refs = measurement.queryEvidence.filter(row => row.state === side); assert(refs.length === 1);
    const reference = refs[0]; assert(reference.traceEvidenceId !== reference.mutationEvidenceId);
    const trace = one(rows, e => e.id === reference.traceEvidenceId, 'Missing query trace');
    const mutation = one(rows, e => e.id === reference.mutationEvidenceId, 'Missing query mutation');
    const call = { from, ...measurement.query, value: '0x0', gas: '0x493e0' }, pinned = { blockHash, requireCanonical: true };
    assert(trace.method === 'debug_traceCall' && mutation.method === 'debug_traceCall');
    assert(trace.params.length === 3 && mutation.params.length === 3, 'Unexpected getter RPC arguments');
    eq(trace.params.slice(0, 2), [call, pinned]); eq(mutation.params.slice(0, 2), [call, pinned]);
    providerOptions(trace.params[2], expectedOverrides[side]); providerOptions(mutation.params[2], expectedOverrides[side], true);
    providerRoot(trace.result, call); assert(committedLogs(trace.result).length === 0, 'Getter committed logs');
    if (measurement.position) validatePositionTrace(trace.result, call, measurement.position);
    else validateQueryTrace(trace.result, call);
    const carried = expectedOverrides[side]?.[from];
    if (carried) assert(Object.keys(carried).every(key => ['nonce', 'balance'].includes(key)), 'Unsupported provider sender overlay');
    const nonce = quantity(carried?.nonce ?? initial.nonce, 64), balance = quantity(carried?.balance ?? initial.balance);
    validateQueryDiff(mutation.result, { sender: from, nonce, balance });
  }
  return true;
}
