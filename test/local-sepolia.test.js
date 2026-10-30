// Synthetic authenticated initial state, real transport parsing, API/loader and
// isolated worker. No public RPC, expected poststate input or wallet action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simulateLocal, validateLocalSimulation, LOCAL_CAPABILITIES, LOCAL_EXAMPLES } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { createAppServer } from '../src/server.js';
import { loadLocalApi } from '../src/local-loader.js';
import { InputError } from '../src/validate.js';
import { TX_SENDER, TARGET, COINBASE, word, signAuthorization } from '../engines/local-evm/test/amsterdam-execution-fixture.js';
import { factoryCode, initcode, createdAddress } from '../engines/local-evm/test/lifecycle-fixture.js';
import { TEST_KEY } from '../engines/local-evm/test/authorization-fixture.js';

import { CHAIN, native, sepoliaApiInput as inputFor, sepoliaApiFixture as fixture, sepoliaApiTransport as transport } from './local-sepolia-fixture.js';

const UNIT = { kind: 'native_wei', scale: '1000000000000000000' };
function amount(row, account, before, after) {
  assert.equal(row.status, 'measured'); assert.equal(row.query, null); assert.equal(row.returnBytes, 0);
  assert.deepEqual(row.identity, { kind: 'native_balance', account, chainId: String(CHAIN) });
  assert.deepEqual(row.values, [{ name: 'balance', beforeRaw: String(before), afterRaw: String(after), deltaRaw: String(after - before), unit: UNIT }]);
}
function complete(report, f) {
  assert.equal(report.status, 'complete', JSON.stringify(report.error)); assert.equal(report.execution.status, 'success');
  assert.equal(report.apiRequest.chainId, CHAIN); assert.equal(report.source.chainId, CHAIN);
  assert.equal(report.source.canonicalStatus, 'verified'); assert.equal(report.source.consensusVerified, false);
  assert.equal(report.source.blockSelection.blockHash, f.header.hash);
  assert.equal(report.source.blockSelection.headerVerification.chainId, CHAIN);
  assert.equal(report.source.blockSelection.headerVerification.hardfork, 'amsterdam');
  assert.equal(report.attempt.preview.scope.chainId, CHAIN);
  assert.equal(report.attempt.preview.original.output.environment.chainId, CHAIN);
  assert.equal(report.attempt.preview.original.output.profile.chainId, CHAIN);
  assert.equal(report.attempt.isolation.processClosed, true); assert.notEqual(report.attempt.isolation.childPid, process.pid);
  assert.equal(report.attempt.broker.pendingAtReturn, 0);
}

test('local chain selection is finite and detached, with explicit current Sepolia example queries', async () => {
  const f = await fixture();
  for (const chainId of [1, '1', CHAIN, String(CHAIN)]) assert.equal(validateLocalSimulation(inputFor(f, { chainId })).chainId, Number(chainId));
  for (const chainId of [undefined, null, 0, 999, 42161, '0xaa36a7', '011155111', CHAIN + 1, {}, 11155111n]) {
    await assert.rejects(simulateLocal(inputFor(f, { chainId }), { call() { assert.fail('Invalid chain reached transport'); } }), InputError);
  }
  assert.throws(() => validateLocalSimulation(inputFor(f, { queries: [{ ...native(TARGET), chainId: '1' }] })), InputError);
  assert.deepEqual(LOCAL_CAPABILITIES.chainIds, [1, CHAIN]);
  assert(LOCAL_CAPABILITIES.networks[CHAIN].supportedForks.includes('amsterdam'));
  assert(!LOCAL_CAPABILITIES.networks[1].supportedForks.includes('amsterdam'));
  const example = validateLocalSimulation(LOCAL_EXAMPLES[0].request);
  assert.equal(example.chainId, CHAIN); assert.equal(example.block, 'latest');
  assert.equal(example.value, '1000000000000000'); assert.equal(example.gas, '21000');
  assert.deepEqual(example.queries, [native(example.from), native(example.to)]);
});

test('latest, exact number and exact hash produce proof-bound Sepolia native measurements through real children', async () => {
  for (const selector of ['latest', 'number', 'hash']) {
    const f = await fixture(), block = selector === 'latest' ? 'latest' : selector === 'number' ? f.header.number : f.header.hash;
    const p = transport(f), report = await simulateLocal(inputFor(f, { block }), p.rpc); p.check(report); complete(report, f);
    amount(report.measurements[0], TX_SENDER, 1000000000000n, 999999999983n); amount(report.measurements[1], TARGET, 9n, 26n);
    assert.equal(report.attempt.preview.usage.executions, 1); assert.equal(report.attempt.preview.original.output.feeAccounting, undefined);
    assert.deepEqual(p.wires[1], { jsonrpc: '2.0', id: 2, method: selector === 'hash' ? 'eth_getBlockByHash' : 'eth_getBlockByNumber', params: [block, false] });
    assert.deepEqual(p.wires.slice(2, -1).map(q => q.method), ['eth_getProof', 'eth_getProof']);
    assert.equal(report.attempt.preview.inputs.provenance.every(row => row.codeEvidenceId === null), true);
  }
});

test('wrong endpoint chain, selected number, hash and Amsterdam header suffix fail before any child state read', async () => {
  for (const options of [{ rpcChain: '0x1' }, { rpcChain: '0xAA36A7' }, { block: '0x1' },
    { block: '0x' + '11'.repeat(32) }, { initialHeader: h => { const value = { ...h }; delete value.slotNumber; return value; } },
    { initialHeader: h => ({ ...h, slotNumber: '0x1' }) }]) {
    const f = await fixture(), p = transport(f, options), report = await simulateLocal(inputFor(f, { ...(options.block ? { block: options.block } : {}) }), p.rpc);
    p.check(report); assert.equal(report.status, 'unavailable'); assert.equal(report.error.code, 'LOCAL_PREVIEW_PREPARATION');
    assert.equal(report.attempt, null); assert.deepEqual(report.measurements, []);
    assert.equal(p.wires.length, options.rpcChain ? 1 : 2); assert(!p.wires.some(q => q.method === 'eth_getProof'));
  }
});

test('a changed final header withholds all native amounts while retaining labeled execution evidence', async () => {
  for (const finalHeader of [h => ({ ...h, slotNumber: '0x1' }), h => ({ ...h, unrelatedUnboundField: true })]) {
    const f = await fixture(), p = transport(f, { finalHeader }), report = await simulateLocal(inputFor(f), p.rpc); p.check(report);
    assert.equal(report.status, 'unavailable'); assert.equal(report.error.code, 'LOCAL_PREVIEW_CANONICAL');
    assert.equal(report.source.chainId, CHAIN); assert.equal(report.source.canonicalStatus, 'unverified');
    assert.deepEqual(report.measurements, []); assert.equal(report.attempt.preview, null);
    assert.equal(report.audit.original.output.execution.status, 'success'); assert.equal(report.audit.status, 'unverified_not_a_measurement');
  }
});

test('priced Sepolia execution and unpriced disposable CHAINID queries keep their distinct chain-bound accounting', async () => {
  const f = await fixture({ priced: true, gas: '5000000', target: { nonce: 1n, balance: 9n, code: '0x4660005260206000f3' } });
  const scalar = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }, p = transport(f);
  const report = await simulateLocal(inputFor(f, { queries: [native(TX_SENDER), native(TARGET), native(COINBASE), scalar] }), p.rpc); p.check(report); complete(report, f);
  const core = report.attempt.preview, original = core.original.output, fees = original.feeAccounting;
  assert.equal(original.execution.returnData, word(CHAIN)); assert.equal(original.profile.feesSettled, true);
  assert.equal(original.stateGasAccounting.settled.gasUsed, original.gasAccounting.gasUsed);
  amount(report.measurements[0], TX_SENDER, 1000000000000n, 1000000000000n - 17n - BigInt(fees.gasCharge));
  amount(report.measurements[1], TARGET, 9n, 26n); amount(report.measurements[2], COINBASE, 0n, BigInt(fees.coinbaseTip));
  const row = core.measurements[3]; assert.equal(row.identity.chainId, String(CHAIN)); assert.equal(row.status, 'measured');
  assert.deepEqual(row.values.map(v => [v.beforeRaw, v.afterRaw, v.deltaRaw]), [[String(CHAIN), String(CHAIN), '0']]);
  for (const side of ['before', 'after']) {
    assert.equal(row[side].output.environment.chainId, CHAIN); assert.equal(row[side].output.profile.feesSettled, false);
    assert.equal(row[side].output.feeAccounting, undefined); assert.equal(row[side].mutationValidation.status, 'verified');
  }
});

test('Amsterdam self-authorization reaches the API with retained delegation and exact native measurements', async () => {
  assert.equal(LOCAL_CAPABILITIES.amsterdam.authorizationList, true);
  const authorizationList = [signAuthorization({ chainId: BigInt(CHAIN), key: TEST_KEY, nonce: 2n, address: TARGET })];
  for (const priced of [false, true]) {
    const f = await fixture({ priced, gas: '5000000', authorizationList });
    const p = transport(f), report = await simulateLocal(inputFor(f), p.rpc); p.check(report); complete(report, f);
    const original = report.attempt.preview.original, output = original.output;
    assert.equal(output.authorizationProcessing.preparation.phase, 'message');
    assert.equal(output.authorizationProcessing.preparation.retained, true);
    assert.equal(output.authorizationProcessing.preparation.senderAuthorizationIncrements, '1');
    assert.deepEqual(original.changes.accounts.find(row => row.address === TX_SENDER).nonce, { before: '0x1', after: '0x3' });
    assert.equal(original.changes.accounts.find(row => row.address === TX_SENDER).code.after, '0xef0100' + TARGET.slice(2));
    amount(report.measurements[0], TX_SENDER, 1000000000000n, 1000000000000n - 17n - BigInt(output.feeAccounting?.gasCharge ?? '0'));
    amount(report.measurements[1], TARGET, 9n, 26n);
  }
});

test('authorization preparation OOG is a completed failed simulation with no call frame or value transfer', async () => {
  const authorizationList = [signAuthorization({ chainId: BigInt(CHAIN), key: TEST_KEY, nonce: 2n, address: TARGET })];
  const f = await fixture({ gas: '64005', authorizationList });
  // A value-bearing root pays an extra6000 intrinsic; the remaining35189 is
  // one gas short of the new delegation indicator, before any message enters.
  const p = transport(f), report = await simulateLocal(inputFor(f), p.rpc); p.check(report);
  assert.equal(report.status, 'complete'); assert.equal(report.execution.status, 'failed');
  const original = report.attempt.preview.original, output = original.output;
  assert.equal(output.execution.error, 'out of gas'); assert.equal(output.trace, null);
  assert.equal(output.authorizationProcessing.preparation.phase, 'authorization_out_of_gas');
  assert.equal(output.authorizationProcessing.preparation.retained, false);
  assert.deepEqual(original.changes.accounts, [{ address: TX_SENDER, nonce: { before: '0x1', after: '0x2' } }]);
  amount(report.measurements[0], TX_SENDER, 1000000000000n, 1000000000000n);
  amount(report.measurements[1], TARGET, 9n, 9n);
});

test('existing Amsterdam sender delegation survives API admission, self-call and disposable query validation', async () => {
  assert.equal(LOCAL_CAPABILITIES.amsterdam.delegatedSenders, true);
  for (const priced of [false, true]) {
    const f = await fixture({ priced, gas: '5000000', sender: { code: '0xef0100' + TARGET.slice(2) },
      target: { nonce: 1n, balance: 9n, code: '0x4660005260206000f3' } });
    const scalar = { to: TX_SENDER, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }, p = transport(f);
    const report = await simulateLocal(inputFor(f, { to: TX_SENDER, queries: [native(TX_SENDER), native(TARGET), scalar] }), p.rpc);
    p.check(report); complete(report, f);
    const original = report.attempt.preview.original, output = original.output;
    assert.equal(output.execution.returnData, word(CHAIN));
    assert.deepEqual(output.semantics.senderDelegation, { address: TARGET, authorizationListProcessed: false });
    assert.deepEqual(original.changes.accounts.find(row => row.address === TX_SENDER).nonce, { before: '0x1', after: '0x2' });
    assert.equal(original.changes.accounts.find(row => row.address === TX_SENDER).code, undefined);
    amount(report.measurements[0], TX_SENDER, 1000000000000n, 1000000000000n - BigInt(output.feeAccounting?.gasCharge ?? '0'));
    amount(report.measurements[1], TARGET, 9n, 9n);
    assert.deepEqual(report.measurements[2].values.map(value => [value.beforeRaw, value.afterRaw, value.deltaRaw]), [[String(CHAIN), String(CHAIN), '0']]);
    for (const side of ['before', 'after']) {
      const measured = report.attempt.preview.measurements[2][side];
      assert.equal(measured.mutationValidation.status, 'verified'); assert.equal(measured.output.feeAccounting, undefined);
      assert.deepEqual(measured.output.semantics.senderDelegation, { address: TARGET, authorizationListProcessed: false });
    }
  }
});

test('an Amsterdam storage-only creation result is explicitly unsupported with retained proof evidence', async () => {
  const init = initcode('00', ''), target = createdAddress({ creator: TARGET, nonce: 7n, init });
  const f = await fixture({ gas: '5000000', value: '0', target: { nonce: 7n, balance: 1000n, code: factoryCode(init, { value: 0 }) },
    accounts: { [target]: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(0)]: 7n } } } });
  const p = transport(f), report = await simulateLocal(inputFor(f), p.rpc); p.check(report);
  assert.equal(LOCAL_CAPABILITIES.amsterdam.storageOnlyCreationCollision, false);
  assert.equal(report.status, 'unavailable'); assert.equal(report.error, null);
  assert.equal(report.execution.status, 'unsupported'); assert.equal(report.execution.error.code, 'LOCAL_CREATION_STORAGE_UNSUPPORTED');
  assert.equal(report.measurements.length, inputFor(f).queries.length);
  assert(report.measurements.every(row => row.status === 'not_attempted' && row.values === null));
  assert.equal(report.attempt.preview.original.output.stateDisposition, 'rolled_back');
  assert.deepEqual(report.attempt.preview.original.changes.accounts, []);
  assert.equal(report.source.canonicalStatus, 'verified');
  assert.equal(report.attempt.isolation.processClosed, true); assert.equal(report.attempt.broker.pendingAtReturn, 0);
});

test('real HTTP route/loader selects normalized Sepolia transport, persists exact results and leaves provider routes closed', async t => {
  const f = await fixture(), p = transport(f), factories = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sepolia-local-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await loadLocalApi(); assert(api);
  const server = createAppServer({ persist: true, reportDir: directory, localLoader: async () => api,
    proofRpcFactory(options) { factories.push(options); return new ProofRpcClient({ ...options, url: 'https://synthetic.invalid', fetchImpl: p.fetchImpl }); },
    standardRpcFactory() { assert.fail('Sepolia cannot reach provider execution'); }, rpcFactory() { assert.fail('Sepolia cannot reach legacy execution'); } });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(base + '/api/config')).json(); assert.deepEqual(config.localEvm.capabilities.chainIds, [1, CHAIN]);
  assert.deepEqual(config.localEvm.examples, LOCAL_EXAMPLES); assert.equal(config.chains.find(row => row.chainId === CHAIN).localOnly, true);
  assert.equal(factories.length, 0);
  const post = (route, request) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const input = inputFor(f, { chainId: String(CHAIN) });
  for (const route of ['/api/evm/simulate', '/api/simulate']) {
    const providerInput = { chainId: CHAIN, from: TX_SENDER, to: TARGET, data: '0x', value: '0', block: 'latest',
      ...(route === '/api/evm/simulate' ? { queries: [{ to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }] } : {}) };
    const response = await post(route, providerInput); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'UNSUPPORTED_CHAIN');
  }
  assert.equal(factories.length, 0);
  const response = await post('/api/evm/local-preview', input); assert.equal(response.status, 200);
  const report = await response.json(); p.check(report); complete(report, f);
  assert.deepEqual(factories, [{ chainId: CHAIN }]);
  assert.equal(report.implementation.sourceFiles.includes('src/proof-rpc.js'), true);
  assert.equal(report.implementation.sourceFiles.includes('engines/local-evm/creation-attempt-validation.js'), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'simulations', report.id + '.json'), 'utf8')), report);
});
