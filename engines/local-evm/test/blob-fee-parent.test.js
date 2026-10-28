import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { blobFeeFixture, TX_SENDER, TARGET, COINBASE, word } from './blob-fee-fixture.js';
const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
function recount(output) {
  output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
    ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}),
    ...(output.authorizationProcessing ? { authorizationProcessing: output.authorizationProcessing } : {}),
    ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}) }));
}
async function tamper(t, f, change) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          change(message.result); changed = true; recount(message.result.output);
          values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await run(f); assert.equal(changed, true);
    assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.output, null); assert.equal(result.broker.pendingAtReturn, 0);
  } finally { mock.mock.restore(); }
}

test('blob parent binds complete fee accounting, authenticated price and declared hashes', async t => {
  const positive = await run(await blobFeeFixture());
  assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
  assert.equal(positive.output.feeAccounting.blobFeeBurn, '131072');
  assert.equal(positive.output.feeAccounting.totalFeeCharge, '341072');
  for (const change of [
    r => { delete r.output.feeAccounting.blobFeeBurn; },
    r => { r.output.feeAccounting.totalFeeCharge = r.output.feeAccounting.gasCharge; },
    r => { r.output.feeAccounting.totalFeeBurn = r.output.feeAccounting.baseFeeBurn; },
    r => { r.output.feeAccounting.totalUpfrontDebit = r.output.feeAccounting.upfrontGasDebit; },
    r => { r.output.feeAccounting.blobBaseFeePerGas = '0'; },
    r => { r.output.feeAccounting.blobCount = '2'; },
    r => { r.output.feeAccounting.maxFeePerBlobGas = '101'; },
    r => { r.output.environment.blobBaseFeePerGas = '0'; },
    r => { r.output.profile.executionBlobBaseFee = '0'; },
    r => { r.output.profile.sourceExcessBlobGas = '1'; },
    r => { r.output.profile.blobVersionedHashes[0] = '0x01' + 'cd'.repeat(31); },
    r => { r.output.profile.name = 'ethereum_unsigned_eip1559_call'; },
  ]) await tamper(t, await blobFeeFixture(), change);
});

test('blob parent rejects omitted burn and invented beneficiary blob credits, including sender alias', async t => {
  for (const coinbase of [COINBASE, TX_SENDER]) {
    const positive = await run(await blobFeeFixture({ coinbase }));
    assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
    for (const change of [
      r => { const row = r.changes.accounts.find(row => row.address === TX_SENDER); row.balance.after = '0x' + (BigInt(row.balance.after) + 131072n).toString(16); },
      r => { const row = r.changes.accounts.find(row => row.address === coinbase); row.balance.after = '0x' + (BigInt(row.balance.after) + 131072n).toString(16); },
    ]) await tamper(t, await blobFeeFixture({ coinbase }), change);
  }
});

test('blob parent validates burn and rollback on REVERT and out of gas', async t => {
  for (const code of ['0x602a60005560006000fd', '0x602a6000555b600556']) {
    const make = () => blobFeeFixture({ gas: '100000', target: { nonce: 1n, code } });
    const positive = await run(await make());
    assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
    assert(['reverted', 'failed'].includes(positive.output.execution.status));
    assert.equal(positive.output.feeAccounting.blobFeeBurn, '131072');
    assert(!positive.changes.accounts.some(row => row.address === TARGET));
    await tamper(t, await make(), r => {
      const row = r.changes.accounts.find(row => row.address === TX_SENDER);
      row.balance.after = '0x' + (BigInt(row.balance.after) + 131072n).toString(16);
    });
    await tamper(t, await make(), r => { r.changes.accounts.push({ address: TARGET, storage: [{ slot: word(0), before: word(0), after: word(42) }] }); });
  }
});

test('blob before/after measurements receive no hashes or charges and retain explicit opcode limitations', async () => {
  const query = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') };
  const f = await blobFeeFixture({ target: { nonce: 1n, code: '0x60004960005260206000f3' } });
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [query] });
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.preview.status, 'complete');
  assert.equal(result.preview.original.output.execution.returnData, f.request.blobVersionedHashes[0]);
  for (const side of ['before', 'after']) {
    const output = result.preview.measurements[0][side].output;
    assert.equal(output.feeAccounting, undefined); assert.equal(output.profile.blobVersionedHashes, undefined);
    assert.equal(output.profile.declaredGasLimit, '1000000'); assert.equal(BigInt(output.execution.returnData), 0n);
  }
  assert.equal(result.preview.measurements[0].values[0].deltaRaw, '0');
  const unsupported = await blobFeeFixture({ target: { nonce: 1n, code: '0x4a60005260206000f3' } });
  const limited = await executeIsolatedEthereumPreview({ request: unsupported.request, header: unsupported.header, rpc: unsupported.rpc, queries: [query] });
  assert.equal(limited.status, 'completed', JSON.stringify(limited.error));
  assert.equal(limited.preview.original.output.execution.status, 'success');
  assert.equal(limited.preview.status, 'partial');
  const measurement = limited.preview.measurements[0];
  assert.equal(measurement.before.output.execution.status, 'unsupported');
  assert.equal(measurement.after, null); assert.equal(measurement.status, 'unavailable');
  assert.equal(measurement.values, null);
});

test('blob count and cap admission happen before proof I/O', async () => {
  for (const options of [{ maxBlobFee: 0n }, { fork: 'osaka', blobCount: 7 }, { fork: 'cancun', blobCount: 7 }]) {
    const f = await blobFeeFixture(options), result = await run(f);
    assert.equal(result.status, 'unavailable'); assert.equal(f.calls.length, 0);
    assert.equal(result.output, null);
  }
});
