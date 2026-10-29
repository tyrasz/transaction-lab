import test from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '../engines/local-evm/node_modules/@noble/curves/nist.js';
import { simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { feeFixture, TX_SENDER, TARGET, COINBASE, word } from '../engines/local-evm/test/fee-fixture.js';

// Synthetic initial MPT and signatures only. The real isolated worker receives
// authenticated proof/code responses; no expected execution output enters it.
const address = n => '0x' + n.toString(16).padStart(40, '0');
const BLS = address(15), P256 = address(256), BLS_INPUT = '0x' + '00'.repeat(384);
const bytes = value => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
const hash = bytes(word(42)), key = bytes(word(7));
const P256_INPUT = '0x' + Buffer.from(Uint8Array.from([
  ...hash, ...p256.sign(hash, key, { lowS: false, prehash: false }), ...p256.getPublicKey(key, false).subarray(1),
])).toString('hex');
const P256_INVALID = word(43) + P256_INPUT.slice(66);
const query = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') };
const hex = (n, width) => n.toString(16).padStart(width * 2, '0');

function getter(to, input) {
  const size = '61' + hex((input.length - 2) / 2, 2);
  // Keep output at 0x200, outside the embedded input. Empty verification output
  // therefore remains an explicit zero word from this getter, not stale input.
  const invoke = '6020610200' + size + '600073' + to.slice(2) + '62030d40fa506020610200f3';
  return '0x' + size + '61' + hex(9 + invoke.length / 2, 2) + '600039' + invoke + input.slice(2);
}

async function api({ to, data, queryData = data, fork = 'osaka', beforeActivation = false, failFinal = false }) {
  const f = await feeFixture({ fork, to, data, gas: '300000',
    target: { nonce: 1n, balance: 100n, code: getter(to, queryData) },
    accounts: { [COINBASE]: { nonce: 1n, balance: 1n, code: '0x' },
      ...(beforeActivation ? { [to]: { nonce: 1n, code: '0x602a60005260206000f3' } } : {}) } });
  const wires = []; let headers = 0;
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request); let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(request.method))
      result = ++headers > 1 && failFinal ? { ...f.header, transactions: [] } : f.header;
    else result = await f.rpc.call(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  const report = await simulateLocal({ chainId: 1, ...f.request, block: f.header.hash, queries: [query] }, rpc);
  return { report, f, wires, evidence: rpc.snapshotEvidence() };
}

function retained({ report, f, wires, evidence }, expected) {
  assert.equal(report.status, 'complete', JSON.stringify(report.error));
  assert.equal(report.source.canonicalStatus, 'verified');
  assert.equal(report.execution.status, expected.status);
  assert.equal(report.attempt.isolation.processSeparated, true);
  assert.equal(report.attempt.broker.pendingAtReturn, 0);
  const original = report.attempt.preview.original.output;
  assert.equal(original.execution.returnData, expected.output);
  assert.equal(original.trace.to, f.request.to);
  assert.equal(original.trace.input, f.request.data);
  assert.equal(original.profile.feesSettled, true);
  assert.equal(original.feeAccounting.kind, 'eip1559');
  if (expected.gas !== undefined) assert.equal(original.execution.executionGasUsed, expected.gas);
  assert.equal(report.measurements[0].status, 'measured');
  const value = report.measurements[0].values[0];
  assert.equal(value.beforeRaw, expected.queryRaw); assert.equal(value.afterRaw, expected.queryRaw); assert.equal(value.deltaRaw, '0');
  for (const side of ['before', 'after']) {
    const probe = report.attempt.preview.measurements[0][side];
    assert.equal(probe.mutationValidation.status, 'verified');
    assert.equal(probe.output.execution.returnData, word(BigInt(expected.queryRaw)));
    assert.equal(probe.output.profile.declaredGasLimit, '1000000');
    assert.equal(probe.output.profile.feesSettled, false);
    assert.equal(probe.output.profile.executionProfile, undefined);
    assert.equal(probe.output.feeAccounting, undefined);
    const frame = probe.output.trace.calls[0];
    assert.equal(frame.type, 'STATICCALL'); assert.equal(frame.to, f.request.to);
    assert.equal(frame.input, expected.queryInput); assert.equal(frame.output, expected.queryOutput);
    if (expected.queryFailed) assert.notEqual(frame.error, null); else assert.equal(frame.error, null);
  }
  assert.equal(wires.at(-1).method, 'eth_getBlockByNumber');
  assert.deepEqual(wires.at(-1).params, [f.header.number, false]);
  assert(evidence.every(row => row.status === 'completed'));
  assert(wires.every(row => ['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getProof', 'eth_getCode'].includes(row.method)));
}

test('BLS original and disposable query calls survive the actual API and isolated parent on Prague', async () => {
  retained(await api({ to: BLS, data: BLS_INPUT, fork: 'prague' }), {
    status: 'success', output: word(1), gas: '70300', queryRaw: '1', queryInput: BLS_INPUT, queryOutput: word(1),
  });
});

test('BLS invalid input stays failed execution and a caught query failure remains an exact measured zero', async () => {
  retained(await api({ to: BLS, data: '0x' }), {
    status: 'failed', output: '0x', queryRaw: '0', queryInput: '0x', queryOutput: '0x', queryFailed: true,
  });
});

test('P256 valid and invalid signatures preserve distinct original and fresh query outcomes through the parent', async () => {
  for (const [data, output, queryRaw] of [[P256_INPUT, word(1), '1'], [P256_INVALID, '0x', '0']]) {
    retained(await api({ to: P256, data }), {
      status: 'success', output, gas: '6900', queryRaw, queryInput: data, queryOutput: output,
    });
  }
  // The original's successful signature must not stand in for fresh queries.
  retained(await api({ to: P256, data: P256_INPUT, queryData: P256_INVALID }), {
    status: 'success', output: word(1), gas: '6900', queryRaw: '0', queryInput: P256_INVALID, queryOutput: '0x',
  });
});

test('advertised activation forks match actual ordinary-account behavior before BLS and P256 activation', async () => {
  for (const [to, data, fork, capability] of [[BLS, BLS_INPUT, 'cancun', 'bls12_381'], [P256, P256_INPUT, 'prague', 'p256']]) {
    const result = await api({ to, data, fork, beforeActivation: true });
    retained(result, { status: 'success', output: word(42), queryRaw: '42', queryInput: data, queryOutput: word(42) });
    assert.equal(LOCAL_CAPABILITIES.cryptographicPrecompiles[capability].supportedForks.includes(fork), false);
  }
  assert.equal(LOCAL_CAPABILITIES.cryptographicPrecompiles.bls12_381.activationFork, 'prague');
  assert.equal(LOCAL_CAPABILITIES.cryptographicPrecompiles.p256.activationFork, 'osaka');
  assert.equal(LOCAL_CAPABILITIES.cryptographicPrecompiles.p256.address, P256);
});

test('successful BLS and P256 work cannot retain measurements after the final header changes', async () => {
  for (const [to, data] of [[BLS, BLS_INPUT], [P256, P256_INPUT]]) {
    const { report } = await api({ to, data, failFinal: true });
    assert.equal(report.status, 'unavailable'); assert.equal(report.source.canonicalStatus, 'unverified');
    assert.equal(report.execution.status, 'unavailable'); assert.deepEqual(report.measurements, []);
    assert.equal(report.attempt.preview, null);
  }
});
