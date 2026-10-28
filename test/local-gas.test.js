import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { validateLocalSimulation, simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { validateStandardSimulation } from '../src/standard-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { InputError } from '../src/validate.js';
import { lifecycleFixture, FACTORY, SENDER, word } from '../engines/local-evm/test/lifecycle-fixture.js';
import { authorizationFixture, AUTHORITY, TARGET, DELEGATE, TX_SENDER, RETURN42, query as authQuery,
  fullVMReference, appliedRoot, compareExecution } from '../engines/local-evm/test/authorization-fixture.js';

const query = { to: FACTORY, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') };
const input = { chainId: 1, from: SENDER, to: FACTORY, data: '0x', value: '0', queries: [query] };
const GAS_RETURN = '0x5a60005260206000f3';
const SLOAD_RETURN = '60005460005260206000f3';
// Empty calldata executes the original write; ABI query calldata reads slot 0.
const writes = '0x3615601057' + SLOAD_RETURN + '5b602a600055600160015500';

// The real transport and child consume only proofs from a synthetic initial MPT.
// No public requests or predicted execution results enter this adapter.
async function api(f, change = {}, { finalHeader } = {}) {
  const wires = []; let headers = 0;
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request);
    let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(request.method)) {
      result = ++headers > 1 && finalHeader ? finalHeader(f.header) : f.header;
    } else result = await f.rpc.call(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  const { gas, ...request } = f.request;
  const report = await simulateLocal({ ...request, chainId: 1, block: f.header.hash, queries: [query], ...change }, rpc);
  return { report, wires };
}
const original = report => report.attempt.preview.original;
function complete(report, status = 'success') {
  assert.equal(report.status, 'complete', JSON.stringify(report.error));
  assert.equal(report.execution.status, status); assert.equal(report.source.canonicalStatus, 'verified');
  assert.equal(report.attempt.isolation.processSeparated, true); assert.equal(report.attempt.broker.pendingAtReturn, 0);
}

test('optional gas has a canonical bounded API value; malformed values never reach transport', async () => {
  assert.equal(validateLocalSimulation(input).gas, '5000000');
  assert.deepEqual(validateLocalSimulation(input), validateLocalSimulation({ ...input, gas: '5000000' }));
  assert.equal(validateLocalSimulation({ ...input, gas: '21000' }).gas, '21000');
  assert.deepEqual(LOCAL_CAPABILITIES.gasSelection, { field: 'gas', encoding: 'canonical_decimal_string', default: '5000000',
    minimum: '21000', maximum: '5000000', scope: 'total_transaction_gas_including_intrinsic', selectedForkMinimumRequired: true, queryGas: '1000000' });
  for (const gas of [undefined, null, 21000, 21000n, true, '', '0', '20999', '5000001', '999999999999999999999999',
    '021000', '+21000', '-21000', '21000.0', '2.1e4', '0x5208', ' 21000', '21000 ', {}, []]) {
    await assert.rejects(simulateLocal({ ...input, gas }, { call() { assert.fail('Invalid gas dispatched'); } }), InputError);
  }
  const accessor = { ...input }; Object.defineProperty(accessor, 'gas', { enumerable: true, get() { assert.fail('Accessor executed'); } });
  assert.throws(() => validateLocalSimulation(accessor), InputError);
  assert.throws(() => validateStandardSimulation({ ...input, gas: '50000' }), InputError);
});

test('omitted and explicit default gas have identical actual execution and measured query values', async () => {
  const a = await api(await lifecycleFixture({ code: GAS_RETURN }));
  const b = await api(await lifecycleFixture({ code: GAS_RETURN }), { gas: '5000000' });
  for (const { report } of [a, b]) {
    complete(report); assert.equal(report.apiRequest.gas, '5000000');
    assert.equal(BigInt(report.execution.returnData), 5000000n - 21000n - 2n);
  }
  assert.deepEqual(a.report.apiRequest, b.report.apiRequest);
  for (const key of ['execution', 'profile', 'trace', 'gasAccounting']) assert.deepEqual(original(a.report).output[key], original(b.report).output[key]);
  assert.deepEqual(original(a.report).changes, original(b.report).changes);
  assert.deepEqual(a.report.measurements, b.report.measurements);
});

test('GAS observes selected original gas while both isolated query invocations retain one million', async () => {
  for (const gas of ['21017', '75000']) {
    const { report } = await api(await lifecycleFixture({ code: GAS_RETURN }), { gas }); complete(report);
    const output = original(report).output;
    assert.equal(BigInt(output.execution.returnData), BigInt(gas) - 21002n);
    assert.equal(output.profile.declaredGasLimit, gas); assert.equal(BigInt(output.trace.gas), BigInt(gas) - 21000n);
    const queryBytes = query.data.slice(2).match(/../g), queryIntrinsic = 21000n + queryBytes.reduce((n, byte) => n + (byte === '00' ? 4n : 16n), 0n);
    const pair = report.attempt.preview.measurements[0];
    for (const side of ['before', 'after']) {
      assert.equal(pair[side].output.profile.declaredGasLimit, '1000000');
      assert.equal(BigInt(pair[side].output.execution.returnData), 1000000n - queryIntrinsic - 2n);
    }
    assert.equal(pair.values[0].deltaRaw, '0');
  }
});

test('the same original writes succeed or genuinely run out of gas, with failed writes rolled back', async () => {
  for (const [gas, status, after] of [['60000', 'success', '42'], ['30000', 'failed', '7']]) {
    const f = await lifecycleFixture({ accounts: { [FACTORY]: { nonce: 7n, balance: 1000n, code: writes, storage: { [word(0)]: 7n } } } });
    const { report } = await api(f, { gas }); complete(report, status);
    assert.equal(report.measurements[0].values[0].beforeRaw, '7'); assert.equal(report.measurements[0].values[0].afterRaw, after);
    if (status === 'failed') {
      assert.equal(report.execution.error, 'out of gas');
      assert.equal(original(report).output.gasAccounting.gasUsed, gas);
      assert.deepEqual(original(report).changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
    }
  }
});

test('selected-gas OOG retains authorization preparation but rolls back message writes, matching a signed full VM', async () => {
  const f = await authorizationFixture({ targetCode: writes, gas: '70000' });
  const { report } = await api(f, { gas: f.request.gas, queries: [authQuery(TARGET)] }); complete(report, 'failed');
  const execution = original(report), authority = execution.changes.accounts.find(row => row.address === AUTHORITY);
  assert.deepEqual(authority.nonce, { before: '0x0', after: '0x1' });
  assert.deepEqual(authority.code, { before: '0x', after: '0xef0100' + DELEGATE.slice(2) });
  assert.equal(execution.changes.accounts.some(row => row.address === TARGET), false);
  assert.equal(execution.output.authorizationProcessing.gasRefundCounter, '12500');
  assert.equal(report.measurements[0].values[0].beforeRaw, '0'); assert.equal(report.measurements[0].values[0].afterRaw, '0');
  const ref = await fullVMReference(f), result = await ref.run(); compareExecution(execution.output, result);
  assert.equal(await appliedRoot(f, execution.changes), bytesToHex(await ref.state.getStateRoot()));
  for (const side of ['before', 'after']) {
    const output = report.attempt.preview.measurements[0][side].output;
    assert.equal(output.profile.declaredGasLimit, '1000000'); assert.equal(output.authorizationProcessing, undefined);
  }
});

test('trusted fork admission enforces exact base, access-list, authorization, CREATE and calldata-floor boundaries', async () => {
  const skipped = { chainId: '0x1', address: DELEGATE, nonce: '0x0', yParity: '0x0', r: '0x0', s: '0x0' };
  const cases = [
    { name: 'base', minimum: 21000, intrinsic: 21000, context: {} },
    { name: 'access list occurrences', minimum: 29600, intrinsic: 29600, context: { accessList: [{ address: TARGET, storageKeys: [word(0), word(0)] }, { address: TARGET, storageKeys: [] }] } },
    { name: 'skipped authorization intrinsic', minimum: 46000, intrinsic: 46000, context: { authorizationList: [skipped] } },
    { name: 'empty CREATE', minimum: 53000, intrinsic: 53000, context: { to: null } },
    { name: 'Prague calldata floor', minimum: 25000, intrinsic: 22600, context: { data: '0x' + 'ff'.repeat(100) } },
  ];
  for (const c of cases) for (const accepted of [false, true]) {
    const f = await authorizationFixture({ prague: true, targetCode: '0x' + RETURN42 }); delete f.request.authorizationList;
    const gas = String(c.minimum - (accepted ? 0 : 1)), request = { to: TX_SENDER, gas, queries: [authQuery(TARGET)], ...c.context };
    if (BigInt(gas) < 21000n) { await assert.rejects(api(f, request), InputError); assert.equal(f.calls.length, 0); continue; }
    const { report, wires } = await api(f, request);
    if (accepted) {
      complete(report); assert.equal(original(report).output.profile.intrinsicGas, String(c.intrinsic), c.name);
      assert.equal(original(report).output.gasAccounting.gasUsed, String(c.minimum), c.name);
      assert.equal(report.measurements[0].values[0].afterRaw, '42');
    } else {
      assert.equal(report.status, 'unavailable', c.name); assert.equal(report.error.code, 'LOCAL_ISOLATED_INPUT');
      assert.equal(report.attempt.isolation, null); assert.equal(report.attempt.broker.calls, 0); assert.deepEqual(report.measurements, []);
      assert.deepEqual(wires.map(row => row.method), ['eth_chainId', 'eth_getBlockByHash']); assert.equal(f.calls.length, 0);
    }
  }
});

test('final-header invalidation with caller gas withholds all measured values', async () => {
  const { report } = await api(await lifecycleFixture({ code: GAS_RETURN }), { gas: '75000' }, { finalHeader: header => ({ ...header, transactions: [] }) });
  assert.equal(report.status, 'unavailable'); assert.equal(report.error.code, 'LOCAL_PREVIEW_CANONICAL');
  assert.equal(report.attempt.preview, null); assert.deepEqual(report.measurements, []); assert.equal(report.execution.status, 'unavailable');
  assert.equal(report.audit.status, 'unverified_not_a_measurement'); assert.equal(report.audit.original.output.profile.declaredGasLimit, '75000');
});
