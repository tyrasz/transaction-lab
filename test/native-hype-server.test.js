import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { simulate, replay } from '../src/server.js';
import { CAPABILITIES, EXAMPLES } from '../src/config.js';

test('current failed call exposes explicit native no-measurement and inventories both native sources', async () => {
  const calls = [], request = EXAMPLES[0].request, hash = '0x' + 'aa'.repeat(32);
  const rpc = { provider: 'offline', rpcMs: 0, async verifyChain() {}, async call(method, params) {
    calls.push({ method, params });
    if (method === 'eth_getBlockByNumber') return { number: '0x123', hash, timestamp: '0x456' };
    if (method === 'debug_traceCall') return { type: 'CALL', from: request.from, to: request.to, input: request.data, value: '0x0', gasUsed: '0x5208', error: 'execution reverted', logs: [] };
    assert.fail('Unexpected RPC call: ' + method);
  } };
  const result = await simulate(request, rpc);
  assert.equal(calls.length, 2); assert.equal(result.nativeBalanceChanges.status, 'not_applicable');
  assert.deepEqual(result.nativeBalanceChanges.assets, []); assert.equal(result.nativeBalanceChanges.feeScope, 'excluded');
  assert.equal(result.nativeBalanceChanges.executionIdentity, undefined);
  assert.deepEqual(result.evidence.nativeBalanceMeasurement, { request: [], response: [] });
  assert(result.implementation.sourceFiles.includes('native-balances.js')); assert(result.implementation.sourceFiles.includes('native-effects.js'));
  assert.deepEqual(CAPABILITIES.nativeBalanceMeasurement.modes, ['simulation']);
  assert.equal(CAPABILITIES.nativeBalanceMeasurement.maxAccounts, 8);
});

test('historical replay has explicit unsupported native view and dispatches no native read', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/corewriter-observed-history.json', import.meta.url)));
  const { request, trace, block } = fixture.input, transactionHash = fixture.provenance.transactionHash;
  const header = { hash: block.hash, number: '0x' + BigInt(block.number).toString(16), timestamp: '0x' + BigInt(block.timestamp).toString(16) };
  const tx = { hash: transactionHash, from: request.from, to: request.to, input: request.data, value: '0x0', chainId: '0x3e7', blockHash: header.hash, blockNumber: header.number, transactionIndex: '0x1' };
  const receipt = { transactionHash, from: request.from, to: request.to, blockHash: header.hash, blockNumber: header.number, transactionIndex: '0x1', gasUsed: trace.gasUsed, status: '0x1' };
  const calls = [], rpc = { provider: 'offline', rpcMs: 0, async verifyChain() {}, async call(method) {
    calls.push(method);
    if (method === 'eth_getTransactionByHash') return tx;
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getBlockByHash') return header;
    if (method === 'debug_traceTransaction') return structuredClone(trace);
    assert.fail('Unexpected historical state read: ' + method);
  } };
  const result = await replay({ chainId: 999, transactionHash }, rpc);
  assert.equal(result.nativeBalanceChanges.status, 'not_applicable'); assert.deepEqual(result.nativeBalanceChanges.assets, []);
  assert.match(result.nativeBalanceChanges.warnings[0], /not supported for historical replay/);
  assert.equal(result.nativeBalanceChanges.executionIdentity, undefined);
  assert.deepEqual(result.evidence.nativeBalanceMeasurement, { request: [], response: [] });
  assert.equal(calls.length, 5);
});

test('shared finalization withholds measured and partial amounts and identities after late canonical failure', async () => {
  // Exercise the actual internal finalizer, without a public test-only API or
  // fabricated successful provider replies. Full consumer integration is separate.
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function finalizeMeasurements('), end = source.indexOf('\nfunction validateRootTrace', start);
  assert(start >= 0 && end > start);
  const finalize = vm.runInNewContext(source.slice(start, end) + '; finalizeMeasurements', { structuredClone });
  const evidence = { request: [{ id: 1 }], response: [{ id: 1, result: 'retained' }] };
  const stateContext = { canonicalFailure: 'final header changed', snapshotEvidence: () => evidence };
  const rows = ['measured', 'measured', 'measured', 'partial'].map(status => ({ status, assets: [{ beforeRaw: '100', afterRaw: '99' }],
    allowances: [{}], reusedPairs: [{}], executionIdentity: { stateBlockHash: 'old' }, warnings: [], evidence: { request: [{ id: 1 }], response: [] } }));
  const output = finalize(stateContext, rows);
  for (const row of output) {
    assert.equal(row.status, 'unavailable'); assert.equal(row.executionIdentity, undefined);
    assert.equal(row.assets.length, 0); assert.equal(row.allowances.length, 0); assert.equal(row.reusedPairs.length, 0);
    assert.deepEqual(row.evidence, evidence); assert.match(row.warnings[0], /Shared block verification failed/);
  }
  assert.equal(rows[3].status, 'partial'); assert.equal(rows[3].assets.length, 1, 'Finalization must not mutate the retained consumer result');
});

test('native failure preserves shared failed-read diagnostics only as explicitly unverified audit evidence', async () => {
  const request = { chainId: 999, from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x', value: '1' };
  const trace = { type: 'CALL', from: request.from, to: request.to, input: request.data, value: '0x1', gas: '0x4c4b40', gasUsed: '0x5208', output: '0x', logs: [], calls: [] };
  // Synthetic failed-transport control: no state or native amount is established.
  const header = { hash: '0x' + '55'.repeat(32), number: '0x123', timestamp: '0x456' };
  const rpc = { provider: 'offline', rpcMs: 0, async verifyChain() {}, async call(method) {
    if (method === 'eth_getBlockByNumber') return header;
    if (method === 'eth_getBlockByHash') throw new Error('UNTRUSTED_PROVIDER_MESSAGE_MUST_NOT_ESCAPE');
    if (method === 'debug_traceCall') return structuredClone(trace);
    assert.fail('Unexpected RPC: ' + method);
  } };
  const result = await simulate(request, rpc);
  assert.equal(result.nativeBalanceChanges.status, 'unavailable'); assert.deepEqual(result.nativeBalanceChanges.assets, []);
  assert.equal(result.nativeBalanceChanges.executionIdentity, undefined);
  assert.deepEqual(result.evidence.nativeBalanceMeasurement, { request: [], response: [] });
  const audit = result.evidence.nativeBalanceAudit;
  assert.equal(audit.verification, 'unverified'); assert(audit.request.length > 0); assert(audit.response.some(row => row.error));
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED_PROVIDER_MESSAGE_MUST_NOT_ESCAPE/);
  assert.equal(result.execution.status, 'success', 'Original trace remains separate from withheld measurements');
});

// Entirely synthetic provider transport, passed through the real current-state
// context and native consumer. No live observations or execution-client accuracy
// claim: fixed reads independently declare the expected 10-wei transfer.
function nativeTransport({ badWitness = false, changedHeader = false } = {}) {
  const from = '0x' + '11'.repeat(20), to = '0x' + '22'.repeat(20), probe = '0x000000000000000000000000000000000000ba1a';
  const request = { chainId: 999, from, to, data: '0x', value: '10' };
  const header = { number: '0x123', hash: '0x' + '44'.repeat(32), parentHash: '0x' + '55'.repeat(32), timestamp: '0x456',
    gasLimit: '0x1c9c380', baseFeePerGas: '0x7', mixHash: '0x' + '66'.repeat(32), miner: '0x' + '77'.repeat(20) };
  const trace = { type: 'CALL', from, to, input: '0x', value: '0xa', gas: '0x4c4b40', gasUsed: '0x5208', output: '0x', calls: [], logs: [] };
  const diff = { pre: { [from]: { balance: '0x64', nonce: 1 }, [to]: { balance: '0x3' } },
    post: { [from]: { balance: '0x5a', nonce: 2 }, [to]: { balance: '0xd' } } };
  const calls = [], word = value => BigInt(value).toString(16).padStart(64, '0');
  let numericHeaders = 0;
  const rpc = { provider: 'offline-synthetic-native', rpcMs: 0, async verifyChain() {}, async call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'eth_getBlockByNumber') return changedHeader && ++numericHeaders > 1 ? { ...header, hash: '0x' + '88'.repeat(32) } : structuredClone(header);
    if (method === 'eth_getBlockByHash') { assert.equal(params[0], header.hash); return structuredClone(header); }
    assert.deepEqual(params[1], { blockHash: header.hash, requireCanonical: true });
    if (method === 'eth_getCode') { assert([from, to, probe].includes(params[0])); return '0x'; }
    if (method === 'eth_getTransactionCount') { assert.equal(params[0], from); return '0x1'; }
    if (method === 'eth_getBalance') { assert([from, to].includes(params[0])); return params[0] === from ? '0x64' : '0x3'; }
    assert.equal(method, 'debug_traceCall');
    const [call, , options] = params;
    if (call.to === to) {
      assert.deepEqual(call, { from, to, data: '0x', value: '0xa', gas: '0x4c4b40' });
      assert.equal(options.stateOverrides, undefined);
      return structuredClone(options.tracer === 'callTracer' ? trace : diff);
    }
    assert.equal(call.to, probe);
    const after = Object.hasOwn(options.stateOverrides, from), balance = after ? 90 : 100, nonce = after ? 2 : 1;
    if (options.tracer === 'prestateTracer') return { pre: { [from]: { balance: '0x' + balance.toString(16), nonce } }, post: { [from]: { nonce: nonce + 1 } } };
    const code = options.stateOverrides[probe].code;
    const accounts = [...code.matchAll(/73([0-9a-f]{40})3161[0-9a-f]{4}52/g)].map(match => '0x' + match[1]);
    const balances = accounts.map(account => { assert([from, to].includes(account)); return account === from ? balance : after ? 13 : 3; });
    if (badWitness && after && balances.length) balances[0]++;
    return { type: 'CALL', from, to: probe, input: '0x', value: '0x0', gas: '0x493e0', gasUsed: '0x500', output: '0x' +
      [header.number, header.timestamp, header.gasLimit, 0, header.mixHash, header.miner, 999, header.parentHash, ...balances].map(word).join(''), calls: [], logs: [] };
  } };
  return { request, rpc, calls, from, to };
}

test('real simulate pipeline measures synthetic native balances through shared validation and separate evidence', async () => {
  const fixture = nativeTransport(), result = await simulate(fixture.request, fixture.rpc);
  assert.equal(result.nativeBalanceChanges.status, 'measured');
  assert.deepEqual(result.nativeBalanceChanges.assets.map(row => [row.account, row.beforeRaw, row.afterRaw, row.deltaRaw]),
    [[fixture.from, '100', '90', '-10'], [fixture.to, '3', '13', '10']]);
  assert.equal(result.nativeBalanceChanges.feeScope, 'excluded');
  assert.equal(result.nativeBalanceChanges.executionIdentity.stateBlockHash, result.source.blockHash);
  assert.equal(result.evidence.nativeBalanceAudit, undefined);
  assert(result.evidence.nativeBalanceMeasurement.request.length > 0);
  assert.equal(result.evidence.nativeBalanceMeasurement.request.length, result.evidence.nativeBalanceMeasurement.response.length);
  assert.equal(result.balanceChanges.status, 'not_applicable');
  assert.equal(result.coverage.status, 'unsupported', 'Native measurement does not upgrade protocol coverage');
});

for (const fault of ['badWitness', 'changedHeader']) test(`real simulate pipeline withholds native amounts after ${fault}`, async () => {
  const fixture = nativeTransport({ [fault]: true }), result = await simulate(fixture.request, fixture.rpc);
  assert.equal(result.nativeBalanceChanges.status, 'unavailable'); assert.deepEqual(result.nativeBalanceChanges.assets, []);
  assert.equal(result.nativeBalanceChanges.executionIdentity, undefined);
  assert.deepEqual(result.evidence.nativeBalanceMeasurement, { request: [], response: [] });
  assert.equal(result.evidence.nativeBalanceAudit.verification, 'unverified');
  assert(result.evidence.nativeBalanceAudit.request.length > 0);
  assert.equal(result.execution.status, 'success');
});
