import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compilePreviewQueries } from '../../engines/local-evm/preview-queries.js';
import { composeSequenceOverrides } from '../../engines/standard-evm/sequence-state.js';
import { CONTEXT_VALIDATION_SCOPE, validateLocalOriginalContext, validateLocalQueryContext,
  validateProviderHeaders, validateProviderQueryMutation } from './context-validation.mjs';

// Saved provider records are genuine earlier captures. The local counterparts
// and initial-input trust objects below are explicitly SYNTHETIC controls of
// this validator's shapes, not independently executed output or verified proof.
const saved = JSON.parse(fs.readFileSync(new URL('../../reports/standard-evm-positions-v3/aave-approval-position-sequence-response.json', import.meta.url)));
const FROM = saved.apiRequest.from, PROBE = '0x000000000000000000000000000000000000ba1a';
const HEADER = saved.steps[0].result.evidence.find(row => row.method === 'eth_getBlockByHash').result;
const STATE_SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const clone = value => structuredClone(value);
const hex = value => '0x' + BigInt(value).toString(16);
const initial = () => ({ context: { chainId: 1, blockHash: HEADER.hash, stateRoot: HEADER.stateRoot }, accounts: {
  [FROM]: { exists: true, nonce: '52', balance: '2558093428345938830', code: '0x', storage: {} },
} });
const empty = () => ({ scope: STATE_SCOPE, accounts: [] });
const nonceRow = value => ({ address: FROM, nonce: { before: '0x34', after: hex(value) } });
const token = Object.entries(saved.steps[0].result.stateDiff.post).find(([address]) => address !== FROM);
const [slot, allowance] = Object.entries(token[1].storage)[0];
const tokenRow = () => ({ address: token[0], storage: [{ slot, before: '0x' + '0'.repeat(64), after: allowance }] });

function providerControl(index = 0, query = 0) {
  let previous, contexts = [];
  for (const step of saved.steps) {
    const after = composeSequenceOverrides(previous ?? {}, step.result.stateDiff).overrides;
    contexts.push({ before: previous, after }); previous = after;
  }
  const result = clone(saved.steps[index].result);
  return { result, header: clone(HEADER), from: FROM, expectedOverrides: clone(contexts[index]), initialInputs: initial(), measurement: result.measurements[query] };
}
function localOutput(request, query = false) {
  // Exact field layout was source-reviewed against ethereum-call.js/execute.js.
  // These fixed gas components are for the saved approve and allowance calldata.
  const intrinsic = query ? 21800n : 21608n, floor = query ? '23000' : '22520';
  const message = BigInt(request.gas) - intrinsic, output = query ? '0x' + '0'.repeat(64) : '0x';
  return { execution: { status: 'success', executionGasUsed: '1000', gasRefundCounter: '0', returnData: output, error: null },
    trace: { type: 'CALL', from: FROM, to: request.to, caller: FROM, executionAddress: request.to, value: '0x0', input: request.data,
      gas: hex(message), gasUsed: '0x3e8', output, error: null, depth: 0, calls: [] }, logs: [],
    environment: { chainId: 1, hardfork: 'bpo2', number: '26270482', timestamp: '1792940807', gasLimit: '59941408',
      baseFeePerGas: '0', mixHash: HEADER.mixHash, miner: HEADER.miner, sourceBlockHash: HEADER.hash,
      sourceParentHash: HEADER.parentHash, sourceBlockIdentityVerified: false },
    profile: { name: 'ethereum_unsigned_unpriced_call', chainId: 1, hardfork: 'bpo2', forkSchedule: 'pinned_ethereumjs_common_10.1.3_mainnet',
      sourceBlockHash: HEADER.hash, sourceStateRoot: HEADER.stateRoot, sourceBlockIdentityVerified: false, sourceStateProofVerified: false,
      actualBlockBaseFee: '66700529', executionBaseFee: '0', gasPrice: '0', declaredGasLimit: request.gas,
      intrinsicGas: intrinsic.toString(), calldataFloor: floor, messageGasLimit: message.toString(),
      calldataZeroBytes: query ? '24' : '40', calldataNonzeroBytes: query ? '44' : '28',
      outerSignatureVerified: false, feesSettled: false, originalTransactionPosition: false, expectedOutputsUsed: false },
    gasAccounting: query ? { beforeRefund: '22800', appliedRefund: '0', floorAdjustment: '200', gasUsed: '23000' }
      : { beforeRefund: '22608', appliedRefund: '0', floorAdjustment: '0', gasUsed: '22608' },
    semantics: { gasPrice: '0', feeSettlement: false }, stateDisposition: 'message_result_retained_in_supplied_manager' };
}
function localOriginal() {
  const { queries, ...call } = saved.apiRequest.calls[0], request = { from: FROM, ...call, gas: '5000000' };
  return { request, header: clone(HEADER), step: { status: 'completed', request: clone(request), original: {
    output: localOutput(request), inputs: initial(), startingChanges: empty(), changes: { scope: STATE_SCOPE, accounts: [nonceRow(53), tokenRow()] },
  } } };
}
function localQuery() {
  const source = localOriginal(), compiled = compilePreviewQueries([saved.apiRequest.calls[0].queries[0]], { chainId: 1 })[0];
  const request = { from: FROM, ...compiled.query, value: '0', gas: '1000000' };
  const before = source.step.original.startingChanges, after = source.step.original.changes;
  const half = (snapshot, next) => ({ status: 'measured', changesBefore: clone(snapshot), changesAfter: clone(next),
    output: localOutput(request, true), mutationValidation: { status: 'verified', scope: 'net_changes_except_expected_query_sender_nonce' } });
  return { from: FROM, header: source.header, compiled, initialInputs: initial(), original: source.step.original,
    measurement: { ...clone(compiled), status: 'measured',
      before: half(before, { scope: STATE_SCOPE, accounts: [nonceRow(53)] }),
      after: half(after, { scope: STATE_SCOPE, accounts: [nonceRow(54), tokenRow()] }) } };
}
const witnessRows = c => c.result.evidence.filter(row => row.method === 'debug_traceCall' && row.params[0].to === PROBE && row.params[2].tracer === 'callTracer');
const queryEvidence = (c, field, side = 'before') => c.result.evidence.find(row => row.id === c.measurement.queryEvidence.find(q => q.state === side)[field]);

test('synthetic local original and before/after query contexts validate without execution', () => {
  assert.equal(validateLocalOriginalContext(localOriginal()), true);
  assert.equal(validateLocalQueryContext(localQuery()), true);
  assert.equal(CONTEXT_VALIDATION_SCOPE.providerGasPriceIndependentlyWitnessed, false);
});
test('local original context refuses changed source, fork, gas, fees and root envelope', () => {
  const changes = [
    c => c.step.original.output.environment.timestamp = '1',
    c => c.step.original.output.environment.miner = '0x' + '01'.repeat(20),
    c => c.step.original.output.profile.sourceStateRoot = '0x' + '00'.repeat(32),
    c => c.step.original.output.profile.sourceBlockHash = '0x' + '00'.repeat(32),
    c => c.step.original.output.profile.hardfork = 'shanghai',
    c => c.step.original.output.profile.executionBaseFee = '7',
    c => c.step.original.output.profile.gasPrice = '1',
    c => c.step.original.output.profile.intrinsicGas = '21000',
    c => c.step.original.output.profile.declaredGasLimit = '300000',
    c => c.step.original.output.semantics.feeSettlement = true,
    c => c.step.original.output.trace.gas = '0x4c4b40',
    c => c.step.original.output.trace.caller = c.request.to,
    c => c.request.accessList = [],
  ];
  for (const change of changes) { const c = localOriginal(); change(c); assert.throws(() => validateLocalOriginalContext(c)); }
});
test('local root status, return data and gas use must agree with projected output', () => {
  for (const change of [c => c.step.original.output.execution.status = 'reverted', c => c.step.original.output.trace.error = 'revert',
    c => c.step.original.output.execution.returnData = '0x01', c => c.step.original.output.execution.executionGasUsed = '999',
    c => c.step.original.output.stateDisposition = 'unchanged']) {
    const c = localOriginal(); change(c); assert.throws(() => validateLocalOriginalContext(c));
  }
  for (const error of ['revert', 'out of gas']) {
    const c = localOriginal(), output = c.step.original.output;
    output.trace.error = error; output.execution.error = error; output.execution.status = error === 'revert' ? 'reverted' : 'failed';
    assert.equal(validateLocalOriginalContext(c), true);
  }
});
test('coherent projected gas tampering cannot detach accounting from root gas and refund counter', () => {
  for (const change of [
    o => { o.gasAccounting.beforeRefund = '22708'; o.gasAccounting.gasUsed = '22708'; },
    o => { o.gasAccounting.appliedRefund = '1'; o.gasAccounting.gasUsed = '22607'; },
    o => o.execution.gasRefundCounter = '1',
    o => { o.execution.executionGasUsed = '1001'; o.trace.gasUsed = '0x3e9'; },
    o => o.gasAccounting.singleTransactionBlockGasUsed = o.gasAccounting.gasUsed,
    o => o.execution.executionGasUsed = '0x3e8',
    o => o.execution.gasRefundCounter = '-1',
    o => o.authorizationProcessing = { gasRefundCounter: '1' },
    o => o.feeAccounting = {},
    o => o.stateGasAccounting = {},
    o => o.execution.executionStateGasUsed = '0',
  ]) { const c = localOriginal(); change(c.step.original.output); assert.throws(() => validateLocalOriginalContext(c)); }
  const capped = localOriginal();
  capped.step.original.output.execution.gasRefundCounter = '10000';
  capped.step.original.output.gasAccounting = { beforeRefund: '22608', appliedRefund: '4521', floorAdjustment: '4433', gasUsed: '22520' };
  assert.equal(validateLocalOriginalContext(capped), true, 'One-fifth refund cap and calldata floor remain part of the shared arithmetic');
  const query = localQuery();
  query.measurement.after.output.gasAccounting = { beforeRefund: '22800', appliedRefund: '0', floorAdjustment: '201', gasUsed: '23001' };
  assert.throws(() => validateLocalQueryContext(query));
});
test('local getters must start at the exact original snapshots and use 1M query gas', () => {
  for (const change of [
    c => c.measurement.before.changesBefore = clone(c.original.changes),
    c => c.measurement.after.changesBefore = empty(),
    c => c.measurement.after.output.profile.declaredGasLimit = '5000000',
    c => c.measurement.after.output.profile.gasPrice = '1',
    c => c.measurement.after.output.trace.output = '0x',
    c => c.measurement.after.status = 'unavailable',
    c => c.measurement.query.to = FROM,
  ]) { const c = localQuery(); change(c); assert.throws(() => validateLocalQueryContext(c)); }
});
test('local getters require verified sender anchor and reject extra net writes or logs', () => {
  for (const change of [
    c => c.initialInputs = undefined,
    c => c.initialInputs.accounts[FROM].nonce = '53',
    c => c.original.inputs.accounts[FROM].balance = '0',
    c => c.initialInputs.accounts[FROM].code = '0x00',
    c => c.measurement.before.changesAfter.accounts.push(tokenRow()),
    c => c.measurement.after.changesAfter.accounts[0].nonce.after = '0x35',
    c => c.measurement.after.output.logs = [{ address: FROM, topics: [], data: '0x' }],
    c => c.measurement.after.mutationValidation.scope = 'unchecked',
  ]) { const c = localQuery(); change(c); assert.throws(() => validateLocalQueryContext(c)); }
});
test('saved provider first and carried second original have exact source and synthetic header witnesses', () => {
  for (const index of [0, 1]) assert.equal(validateProviderHeaders(providerControl(index)), true);
});
test('provider source headers and identity must bind chain, source hash and consensus fields', () => {
  for (const change of [
    c => c.result.evidence.find(e => e.method === 'eth_chainId').result = '0x2',
    c => c.result.evidence.find(e => e.method === 'eth_getBlockByHash').result.timestamp = '0x1',
    c => c.result.evidence.find(e => e.method === 'eth_getBlockByNumber').result.transactions = [],
    c => c.result.block.baseFeePerGas = '0',
    c => c.result.executionIdentity.executionBaseFee = '66700529',
    c => c.result.executionIdentity.timestamp = '1',
    c => c.result.request.transaction.gasPrice = '0x0',
    c => c.result.canonicalStatus = 'unverified',
  ]) { const c = providerControl(); change(c); assert.throws(() => validateProviderHeaders(c)); }
});
test('each of the eight provider header words is checked, including synthetic zero BASEFEE', () => {
  for (let i = 0; i < 8; i++) {
    const c = providerControl(), trace = witnessRows(c)[0].result, offset = 2 + i * 64;
    const word = BigInt('0x' + trace.output.slice(offset, offset + 64));
    trace.output = trace.output.slice(0, offset) + (word ^ 1n).toString(16).padStart(64, '0') + trace.output.slice(offset + 64);
    assert.throws(() => validateProviderHeaders(c));
  }
});
test('header witnesses require exact probe code, complete before/after overrides and request envelope', () => {
  for (const change of [
    c => witnessRows(c)[0].params[2].stateOverrides[PROBE].code += '00',
    c => delete witnessRows(c)[1].params[2].stateOverrides[FROM],
    c => witnessRows(c)[0].params[2].stateOverrides[FROM] = { nonce: '0x34' },
    c => witnessRows(c)[0].params[0].gas = '0x493e1',
    c => witnessRows(c)[0].params[0].from = PROBE,
    c => witnessRows(c)[0].params[0].gasPrice = '0x0',
    c => witnessRows(c)[0].params[2].blockOverrides = { time: '0x0' },
    c => witnessRows(c)[0].result.error = 'execution reverted',
    c => witnessRows(c)[0].result.calls = {},
    c => c.result.evidence.push({ ...clone(witnessRows(c)[0]), id: 999 }),
  ]) { const c = providerControl(); change(c); assert.throws(() => validateProviderHeaders(c)); }
});
test('saved scalar and typed provider getters retain nonce-only state under first and carried contexts', () => {
  for (const index of [0, 1]) for (let query = 0; query < saved.steps[index].result.measurements.length; query++) {
    assert.equal(validateProviderQueryMutation(providerControl(index, query)), true);
  }
});
test('provider getter mutations cannot add storage, transfer balance or use a different sender nonce', () => {
  for (const change of [
    c => queryEvidence(c, 'mutationEvidenceId').result.post[FROM].nonce = '0x36',
    c => queryEvidence(c, 'mutationEvidenceId').result.post[FROM].balance = '0x1',
    c => queryEvidence(c, 'mutationEvidenceId').result.post[FROM].storage = { [slot]: allowance },
    c => queryEvidence(c, 'mutationEvidenceId').result.post[token[0]] = { storage: { [slot]: allowance } },
    c => c.initialInputs.accounts[FROM].nonce = '53',
    c => c.initialInputs.accounts[FROM].balance = '0',
  ]) { const c = providerControl(); change(c); assert.throws(() => validateProviderQueryMutation(c)); }
});
test('provider getter raw trace must be successful, log-free and use the exact carried query context', () => {
  for (const change of [
    c => queryEvidence(c, 'traceEvidenceId').result.logs = [{ address: token[0], topics: [], data: '0x', position: 0 }],
    c => queryEvidence(c, 'traceEvidenceId').result.error = 'execution reverted',
    c => queryEvidence(c, 'traceEvidenceId').params[0].gas = '0xf4240',
    c => queryEvidence(c, 'mutationEvidenceId').params[2].stateOverrides = {},
    c => delete queryEvidence(c, 'traceEvidenceId', 'after').params[2].stateOverrides[FROM],
    c => c.measurement.queryEvidence[0].mutationEvidenceId = 99999,
    c => c.measurement.queryEvidence[1].state = 'before',
    c => c.measurement.queryEvidence.push(clone(c.measurement.queryEvidence[0])),
  ]) { const c = providerControl(); change(c); assert.throws(() => validateProviderQueryMutation(c)); }
});

// Explicit opt-in for the one authorized same-engine integration control.
// Ordinary input-only preparation tests do not execute this EVM fixture.
test('offline current-engine integration: fixed approve100 deposit100 withdraw50 with three CALL queries',
  { skip: process.env.LENDING_CONTEXT_OFFLINE_INTEGRATION !== '1' }, async () => {
    const { sequenceFixture, SEQUENCE_SENDER: sender, SEQUENCE_TOKEN: tokenAddress,
      SEQUENCE_VAULT: vaultAddress, encodeSequenceCall } = await import('../../engines/local-evm/test/sequence-fixture.js');
    const { executeEthereumSequence } = await import('../../engines/local-evm/ethereum-sequence.js');
    const { validateInputFacts } = await import('../../engines/local-evm/input-facts.js');
    // The fixture's priced flag builds a nonzero source header. Every call below
    // explicitly removes fees/profile, so this one execution is unpriced.
    const fixture = await sequenceFixture({ fork: 'osaka', priced: true, amount: 100n, withdrawAmount: 50n });
    const requests = Object.freeze(['approve', 'deposit', 'withdraw'].map(name => {
      const { from, to, data, value, gas } = fixture.requests[name];
      return Object.freeze({ from, to, data, value, gas });
    }));
    const queries = Object.freeze([
      Object.freeze({ to: tokenAddress, data: encodeSequenceCall('allowance', [sender, vaultAddress]) }),
      Object.freeze({ to: tokenAddress, data: encodeSequenceCall('balanceOf', [sender]) }),
      Object.freeze({ to: vaultAddress, data: encodeSequenceCall('balanceOf', [sender]) }),
    ]);
    const compiled = compilePreviewQueries(queries, { chainId: 1 });
    assert.equal(fixture.chainId, 1); assert.equal(BigInt(fixture.header.baseFeePerGas), 7n);
    const input = { requests, queries, header: fixture.header, chainId: 1 };
    const result = await executeEthereumSequence({ ...input, rpc: fixture.rpc });
    // Retain the first actual output even if a validation below fails; no repair
    // or repeat execution is hidden behind the test assertion.
    const artifact = process.env.LENDING_CONTEXT_OFFLINE_REPORT;
    if (artifact) {
      assert(artifact.startsWith('/private/tmp/lending-v037-context-'));
      fs.writeFileSync(artifact, JSON.stringify({ scope: 'one_synthetic_current_engine_integration_not_independent_reference_or_public_protocol',
        publicCalls: 0, sequenceExecutions: 1, input, result }, null, 2) + '\n', { flag: 'wx' });
    }
    assert.equal(result.status, 'complete', JSON.stringify({ status: result.status, error: result.error }));
    await validateInputFacts({ inputs: result.inputs, inputEvidence: result.inputEvidence, stateRoot: fixture.header.stateRoot, chainId: 1 });
    for (let i = 0; i < requests.length; i++) {
      const step = result.steps[i];
      assert.equal(validateLocalOriginalContext({ step, request: requests[i], header: fixture.header }), true);
      for (let q = 0; q < compiled.length; q++) assert.equal(validateLocalQueryContext({ measurement: step.measurements[q],
        original: step.original, from: sender, header: fixture.header, compiled: compiled[q], initialInputs: result.inputs }), true);
    }
    assert.equal(result.usage.executions, 21);
    assert.deepEqual(result.steps.map(step => step.measurements.map(m => [m.values[0].beforeRaw, m.values[0].afterRaw])), [
      [['0', '100'], ['1000', '1000'], ['0', '0']],
      [['100', '0'], ['1000', '900'], ['0', '100']],
      [['0', '0'], ['900', '950'], ['100', '50']],
    ]);
  });
