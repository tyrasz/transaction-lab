import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { kzgFixture, kzgCallerCode, KZG_INPUT, KZG_ADDRESS, TARGET, TX_SENDER } from '../engines/local-evm/test/kzg-fixture.js';

async function api({ invalidProof = false, failFinal = false, failProof = false } = {}) {
  const f = await kzgFixture({ priced: true, to: TARGET, data: '0x',
    code: kzgCallerCode({ input: invalidProof ? '0x' : KZG_INPUT, tail: '60405260206040f3' }) });
  let headers = 0; const wires = [];
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request); let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (request.method.startsWith('eth_getBlock')) result = ++headers > 1 && failFinal ? { ...f.header, transactions: [] } : f.header;
    else {
      if (failProof && request.method === 'eth_getProof' && request.params[0] === KZG_ADDRESS) throw new Error('synthetic missing proof');
      result = await f.rpc.call(request.method, request.params);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  const report = await simulateLocal({ chainId: 1, ...f.request, block: f.header.hash,
    queries: [{ to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }] }, rpc);
  return { report, wires };
}

test('API permits executed point evaluation while preserving caught invalid-proof outcomes', async () => {
  for (const invalidProof of [false, true]) {
    const { report, wires } = await api({ invalidProof });
    assert.equal(report.status, 'complete', JSON.stringify(report.error));
    assert.equal(report.source.canonicalStatus, 'verified'); assert.equal(report.execution.status, 'success');
    const output = report.attempt.preview.original.output;
    assert.equal(output.feeAccounting.kind, 'eip1559'); assert.equal(output.profile.blobVersionedHashes, undefined);
    const nested = output.trace.calls.find(frame => frame.to === KZG_ADDRESS);
    assert.equal(nested.error === null, !invalidProof);
    const m = report.measurements[0]; assert.equal(m.status, 'measured');
    assert.equal(m.values[0].beforeRaw, invalidProof ? '0' : '1'); assert.equal(m.values[0].deltaRaw, '0');
    assert(wires.every(row => ['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getProof', 'eth_getCode'].includes(row.method)));
  }
  assert.equal(LOCAL_CAPABILITIES.pointEvaluation.address, KZG_ADDRESS);
  assert.equal(LOCAL_CAPABILITIES.pointEvaluation.blobSidecarsVerified, false);
  assert.equal(LOCAL_CAPABILITIES.pointEvaluation.wholeBlobValidityVerified, false);
});

test('API withholds KZG-path measurements when final header or starting-state proof is unavailable', async () => {
  for (const options of [{ failFinal: true }, { failProof: true }]) {
    const { report } = await api(options);
    assert.equal(report.status, 'unavailable');
    assert(report.measurements.every(row => row.values === null));
    const output = report.attempt?.preview?.original?.output;
    assert.equal(output?.feeAccounting, undefined);
    if (options.failFinal) { assert.equal(report.source.canonicalStatus, 'unverified'); assert.equal(report.attempt.preview, null); }
  }
});
