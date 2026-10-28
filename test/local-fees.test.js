import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalSimulation, simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { validateStandardSimulation, validateStandardSequence } from '../src/standard-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { InputError } from '../src/validate.js';
import { lifecycleFixture, FACTORY, SENDER } from '../engines/local-evm/test/lifecycle-fixture.js';

const PROFILE = 'unsigned_eip1559_block_end', MAX = (1n << 256n) - 1n;
const query = { to: FACTORY, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') };
const input = () => ({ chainId: 1, from: SENDER, to: FACTORY, data: '0x', value: '0', queries: [query] });
const priced = (fees = { maxFeePerGas: '100000000000', maxPriorityFeePerGas: '2' }) => ({ executionProfile: PROFILE, fees });

test('local fees are explicit, detached and conditional; provider admission stays unchanged', () => {
  const baseline = validateLocalSimulation(input());
  assert.equal(Object.hasOwn(baseline, 'fees'), false); assert.equal(Object.hasOwn(baseline, 'executionProfile'), false);
  const request = { ...input(), ...priced() }, normalized = validateLocalSimulation(request);
  assert.deepEqual(normalized.fees, request.fees); assert.equal(normalized.executionProfile, PROFILE);
  assert.notEqual(normalized.fees, request.fees); request.fees.maxFeePerGas = '1';
  assert.equal(normalized.fees.maxFeePerGas, '100000000000');
  assert.deepEqual(validateLocalSimulation({ ...input(), ...priced({ maxFeePerGas: MAX.toString(), maxPriorityFeePerGas: MAX.toString() }) }).fees,
    { maxFeePerGas: MAX.toString(), maxPriorityFeePerGas: MAX.toString() });
  assert.deepEqual(validateLocalSimulation({ ...input(), ...priced({ maxFeePerGas: '0', maxPriorityFeePerGas: '0' }) }).fees,
    { maxFeePerGas: '0', maxPriorityFeePerGas: '0' });
  assert.equal(LOCAL_CAPABILITIES.feeSelection.executionProfile, PROFILE);
  assert.equal(LOCAL_CAPABILITIES.feeSelection.queryProfile, 'unsigned_unpriced_block_end');
  assert.throws(() => validateStandardSimulation({ ...input(), ...priced() }), InputError);
  const sequence = { chainId: 1, from: SENDER, block: 'latest', calls: [{ to: FACTORY, data: '0x', value: '0' }] };
  assert.throws(() => validateStandardSequence({ ...sequence, ...priced() }), InputError);
  assert.throws(() => validateStandardSequence({ ...sequence, calls: [{ ...sequence.calls[0], ...priced() }] }), InputError);
});

test('partial, malformed, hostile and blob-combined fee requests reject before transport', async () => {
  const changes = [{ executionProfile: PROFILE }, { fees: priced().fees }, { executionProfile: undefined, fees: priced().fees },
    { ...priced(), executionProfile: 'unsigned_unpriced_block_end' }, { ...priced(), executionProfile: 'unknown' },
    { ...priced(), fees: undefined }, { ...priced(), fees: null }, { ...priced(), fees: [] },
    { ...priced(), fees: { maxFeePerGas: '1' } }, { ...priced(), fees: { ...priced().fees, gasPrice: '0' } },
    { ...priced({ maxFeePerGas: '1', maxPriorityFeePerGas: '2' }) },
    { ...priced(), blobVersionedHashes: ['0x01' + 'ab'.repeat(31)] }];
  for (const bad of [undefined, null, 1, 1n, true, '', '01', '+1', '-1', '1.0', '1e9', '0x1', ' 1', '1 ', (MAX + 1n).toString(), {}, []]) {
    for (const field of ['maxFeePerGas', 'maxPriorityFeePerGas']) changes.push(priced({ ...priced().fees, [field]: bad }));
  }
  const hostile = priced().fees; Object.defineProperty(hostile, 'maxFeePerGas', { enumerable: true, get() { assert.fail('Fee accessor invoked'); } });
  changes.push({ ...priced(), fees: hostile }, { ...priced(), fees: new Proxy({}, { ownKeys() { assert.fail('Proxy reflected'); } }) });
  const hidden = priced().fees; Object.defineProperty(hidden, 'extra', { value: '1' }); changes.push({ ...priced(), fees: hidden });
  for (const change of changes) await assert.rejects(simulateLocal({ ...input(), ...change }, { call() { assert.fail('Invalid fees dispatched'); } }), InputError);
  const getter = input(); Object.defineProperty(getter, 'executionProfile', { enumerable: true, get() { assert.fail('Profile accessor invoked'); } });
  assert.throws(() => validateLocalSimulation(getter), InputError);
});

// All inputs come from a synthetic initial MPT. The real transport and isolated
// child execute the request; no public network or expected VM output is supplied.
async function api({ code = '0x3a60005260206000f3', balance = 10n ** 24n, gas = '5000000', change = {}, finalHeader } = {}) {
  const f = await lifecycleFixture({ code, accounts: { [SENDER]: { nonce: 1n, balance, code: '0x' } } });
  const wires = []; let headers = 0;
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request);
    let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(request.method)) result = ++headers > 1 && finalHeader ? finalHeader(f.header) : f.header;
    else result = await f.rpc.call(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  const report = await simulateLocal({ ...input(), block: f.header.hash, gas, ...priced(), ...change }, rpc);
  return { report, f, wires };
}

test('actual API prices only the original and retains fresh unpriced measurement queries', async () => {
  const { report, f } = await api();
  assert.equal(report.status, 'complete', JSON.stringify(report.error)); assert.equal(report.execution.status, 'success');
  assert.equal(report.source.profile, PROFILE); assert.equal(report.source.canonicalStatus, 'verified');
  assert.deepEqual(report.apiRequest.fees, priced().fees);
  const original = report.attempt.preview.original.output;
  assert.equal(original.profile.executionProfile, PROFILE); assert.deepEqual(original.profile.fees, priced().fees);
  assert.equal(BigInt(original.execution.returnData), BigInt(f.header.baseFeePerGas) + 2n);
  assert.equal(original.profile.feesSettled, true); assert.equal(original.feeAccounting.kind, 'eip1559');
  assert.equal(original.feeAccounting.chargedGas, original.gasAccounting.gasUsed);
  assert.equal(BigInt(original.feeAccounting.gasCharge), BigInt(original.gasAccounting.gasUsed) * (BigInt(f.header.baseFeePerGas) + 2n));
  assert.equal(report.measurements[0].status, 'measured'); assert.equal(report.measurements[0].values[0].beforeRaw, '0');
  assert.equal(report.measurements[0].values[0].afterRaw, '0');
  for (const side of ['before', 'after']) {
    const probe = report.attempt.preview.measurements[0][side].output;
    assert.equal(probe.feeAccounting, undefined); assert.equal(Object.hasOwn(probe.profile, 'fees'), false);
    assert.equal(probe.profile.feesSettled, false); assert.equal(probe.profile.declaredGasLimit, '1000000');
    assert.equal(BigInt(probe.execution.returnData), 0n);
  }
});

test('completed revert and out-of-gas retain validated fee accounting without turning execution into success', async () => {
  // Nonempty query calldata returns one word; empty original calldata reverts.
  const reverted = await api({ code: '0x3615600f57600060005260206000f35b60006000fd' });
  const failed = await api({ code: '0x3a60005260206000f3', gas: '21000' });
  for (const [expected, { report }] of [['reverted', reverted], ['failed', failed]]) {
    assert.equal(report.execution.status, expected, JSON.stringify(report.error));
    assert.equal(report.source.canonicalStatus, 'verified');
    assert.equal(report.attempt.preview.original.output.profile.feesSettled, true);
    assert.equal(report.attempt.preview.original.output.feeAccounting.chargedGas, report.attempt.preview.original.output.gasAccounting.gasUsed);
  }
});

test('fee admission or canonical-check failures withhold all measurements and settlement claims', async () => {
  const insufficient = (await api({ balance: 1n })).report;
  assert.equal(insufficient.status, 'unavailable'); assert.equal(insufficient.execution.status, 'invalid');
  assert.equal(insufficient.execution.error.code, 'LOCAL_CALL_INSUFFICIENT_BALANCE');
  const rejected = insufficient.attempt.preview.original.output;
  assert.equal(rejected.feeAccounting, undefined); assert.equal(rejected.profile.feesSettled, false); assert.equal(rejected.stateDisposition, 'unchanged');
  assert(insufficient.measurements.every(row => row.status === 'not_attempted' && row.values === null));
  for (const args of [{ change: priced({ maxFeePerGas: '0', maxPriorityFeePerGas: '0' }) },
    { finalHeader: header => ({ ...header, transactions: [] }) }]) {
    const { report } = await api(args);
    assert.equal(report.status, 'unavailable'); assert.equal(report.execution.status, 'unavailable');
    assert.deepEqual(report.measurements, []); assert.equal(report.attempt?.preview, null);
    assert.equal(report.source.profile, PROFILE); assert.equal(report.source.canonicalStatus, 'unverified');
  }
});
