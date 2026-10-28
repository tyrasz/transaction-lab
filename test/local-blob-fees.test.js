import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalSimulation, simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { validateStandardSimulation } from '../src/standard-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { InputError } from '../src/validate.js';
import { blobFeeFixture, TX_SENDER, TARGET, BLOB_PROFILE } from '../engines/local-evm/test/blob-fee-fixture.js';
const query = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') };
const apiRequest = f => ({ chainId: 1, ...f.request, block: f.header.hash, queries: [query] });

async function api(options = {}, finalHeader) {
  const f = await blobFeeFixture(options), wires = []; let headers = 0;
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wires.push(request); let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(request.method)) result = ++headers > 1 && finalHeader ? finalHeader(f.header) : f.header;
    else result = await f.rpc.call(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  return { report: await simulateLocal(apiRequest(f), rpc), f, wires };
}

test('blob API admission binds the explicit profile, caps and hashes without changing provider support', async () => {
  const f = await blobFeeFixture(), input = apiRequest(f), normalized = validateLocalSimulation(input);
  assert.equal(normalized.executionProfile, BLOB_PROFILE); assert.deepEqual(normalized.fees, input.fees);
  assert.notEqual(normalized.fees, input.fees); assert.notEqual(normalized.blobVersionedHashes, input.blobVersionedHashes);
  assert.equal(LOCAL_CAPABILITIES.feeSelection.blobProfile.executionProfile, BLOB_PROFILE);
  assert.throws(() => validateStandardSimulation(input), InputError);
  const missing = structuredClone(input); delete missing.fees.maxFeePerBlobGas;
  for (const bad of [missing, { ...input, blobVersionedHashes: [] }, { ...input, to: null },
    { ...input, executionProfile: 'unsigned_eip1559_block_end' },
    { ...input, fees: { ...input.fees, maxFeePerBlobGas: '01' } },
    { ...input, fees: { ...input.fees, maxFeePerBlobGas: ((1n << 256n)).toString() } }]) {
    await assert.rejects(simulateLocal(bad, { call() { assert.fail('Malformed blob fee request dispatched'); } }), InputError);
  }
});

test('blob API settles execution and blob charges separately and keeps measurements unpriced', async () => {
  const { report, f } = await api({ target: { nonce: 1n, code: '0x60004960005260206000f3' } });
  assert.equal(report.status, 'complete', JSON.stringify(report.error)); assert.equal(report.source.canonicalStatus, 'verified');
  assert.equal(report.source.profile, BLOB_PROFILE); assert.equal(report.execution.status, 'success');
  const output = report.attempt.preview.original.output, fees = output.feeAccounting;
  assert.equal(output.execution.returnData, f.request.blobVersionedHashes[0]);
  assert.equal(fees.kind, 'eip4844'); assert.equal(fees.blobFeeBurn, '131072');
  assert.equal(BigInt(fees.totalFeeCharge), BigInt(fees.gasCharge) + 131072n);
  assert.equal(BigInt(fees.totalFeeBurn), BigInt(fees.baseFeeBurn) + 131072n);
  assert.equal(report.measurements[0].status, 'measured'); assert.equal(report.measurements[0].values[0].deltaRaw, '0');
  for (const side of ['before', 'after']) {
    const probe = report.attempt.preview.measurements[0][side].output;
    assert.equal(probe.feeAccounting, undefined); assert.equal(probe.profile.blobVersionedHashes, undefined);
    assert.equal(BigInt(probe.execution.returnData), 0n);
  }
});

test('blob API preserves charged fees on message failures and withholds all amounts on final-header failure', async () => {
  for (const options of [
    { target: { nonce: 1n, code: '0x3615600f57600060005260206000f35b60006000fd' } },
    { gas: '21000', target: { nonce: 1n, code: '0x60004960005260206000f3' } },
  ]) {
    const { report } = await api(options);
    assert(['reverted', 'failed'].includes(report.execution.status), JSON.stringify(report.error));
    assert.equal(report.source.canonicalStatus, 'verified');
    assert.equal(report.attempt.preview.original.output.feeAccounting.blobFeeBurn, '131072');
  }
  const { report } = await api({}, header => ({ ...header, transactions: [] }));
  assert.equal(report.status, 'unavailable'); assert.equal(report.source.canonicalStatus, 'unverified');
  assert.equal(report.attempt.preview, null); assert.deepEqual(report.measurements, []);
});

test('blob API refuses unaffordable or underpriced envelopes without retaining settlement', async () => {
  for (const options of [{ sender: { balance: 1n } }, { maxBlobFee: 0n }, { fork: 'bpo2', blobCount: 7 }]) {
    const { report } = await api(options);
    assert.equal(report.status, 'unavailable');
    assert.notEqual(report.execution.status, 'success');
    const output = report.attempt?.preview?.original?.output;
    assert.equal(output?.feeAccounting, undefined); assert.notEqual(output?.profile?.feesSettled, true);
    assert(report.measurements.every(row => row.values === null));
  }
});
