import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { kzgFixture, kzgCallerCode, KZG_INPUT, KZG_OUTPUT, KZG_ADDRESS, TARGET, TX_SENDER } from './kzg-fixture.js';

const query = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') };
const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });

test('actual isolated children execute point evaluation with no declared blob hashes or sidecars', async () => {
  for (const fork of ['cancun', 'osaka']) for (const priced of [false, true]) {
    const f = await kzgFixture({ fork, priced }), result = await run(f);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(result.output.execution.status, 'success');
    assert.equal(result.output.execution.returnData, KZG_OUTPUT);
    assert.equal(result.output.execution.executionGasUsed, '50000');
    assert.equal(result.output.profile.blobVersionedHashes, undefined);
    assert.equal(result.output.profile.feesSettled, priced);
    assert.equal(result.output.feeAccounting?.kind, priced ? 'eip1559' : undefined);
    assert.equal(result.broker.pendingAtReturn, 0);
    assert(f.calls.some(row => row.method === 'eth_getProof' && row.params[0] === KZG_ADDRESS));
  }
});

test('parent retains completed invalid-proof failure fees and rejects its message value transfer', async () => {
  const f = await kzgFixture({ priced: true, value: '17', data: '0x' }), result = await run(f);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.output.execution.status, 'failed');
  assert.equal(result.output.execution.returnData, '0x');
  assert.equal(result.output.gasAccounting.gasUsed, f.request.gas);
  assert.equal(result.output.feeAccounting.gasCharge, (BigInt(f.request.gas) * 10n).toString());
  const recipient = result.changes.accounts.find(row => row.address === KZG_ADDRESS);
  assert.equal(recipient?.balance, undefined);
  const sender = result.changes.accounts.find(row => row.address === TX_SENDER);
  assert.equal(BigInt(sender.balance.before) - BigInt(sender.balance.after), BigInt(result.output.feeAccounting.gasCharge));
});

test('fresh before/after query children may verify embedded proofs without repeating fees', async () => {
  const f = await kzgFixture({ priced: true, to: TARGET, data: '0x',
    code: kzgCallerCode({ input: KZG_INPUT, tail: '5060206000f3' }) });
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [query] });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.preview.status, 'complete');
  const m = result.preview.measurements[0];
  assert.equal(m.status, 'measured');
  assert.equal(m.values[0].beforeRaw, '4096'); assert.equal(m.values[0].afterRaw, '4096'); assert.equal(m.values[0].deltaRaw, '0');
  for (const side of ['before', 'after']) {
    const output = m[side].output;
    assert.equal(output.feeAccounting, undefined); assert.equal(output.profile.feesSettled, false);
    assert.equal(output.profile.declaredGasLimit, '1000000'); assert.equal(output.profile.blobVersionedHashes, undefined);
    assert.equal(output.execution.returnData, '0x' + (4096n).toString(16).padStart(64, '0'));
    assert(output.trace.calls.some(frame => frame.to === KZG_ADDRESS && frame.error === null));
  }
});

test('missing authenticated precompile account input withholds execution and settlement', async () => {
  const f = await kzgFixture({ priced: true, to: TARGET, code: kzgCallerCode({ prefix: '602a600055' }) });
  const rpc = { async call(method, params, options) {
    if (method === 'eth_getProof' && params[0] === KZG_ADDRESS) throw new Error('synthetic missing precompile account proof');
    return f.rpc.call(method, params, options);
  } };
  const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc });
  assert.notEqual(result.output?.execution.status, 'success');
  assert.equal(result.output?.feeAccounting, undefined);
  assert.equal(result.broker.pendingAtReturn, 0);
  if (result.changes) assert.deepEqual(result.changes.accounts, []);
});
