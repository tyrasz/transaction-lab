import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { feeFixture, TX_SENDER, TARGET, COINBASE, AUTHORITY, DELEGATE, signAuthorization, word } from './fee-fixture.js';

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

test('parent independently binds fee amounts, declared profile, actual base fee and effective gas price', async t => {
  const positive = await run(await feeFixture());
  assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
  assert.equal(positive.output.feeAccounting.gasCharge, '210000');
  for (const change of [
    r => { delete r.output.feeAccounting; },
    r => { r.output.feeAccounting.gasCharge = '1'; },
    r => { r.output.feeAccounting.senderRefund = '0'; },
    r => { r.output.feeAccounting.coinbaseTip = '0'; },
    r => { r.output.feeAccounting.baseFeeBurn = '0'; },
    r => { r.output.feeAccounting.coinbase = TARGET; },
    r => { r.output.feeAccounting.unverified = true; },
    r => { r.output.profile.feesSettled = false; },
    r => { r.output.profile.fees.maxFeePerGas = '14'; },
    r => { r.output.environment.baseFeePerGas = '0'; },
    r => { r.output.semantics.gasPrice = '0'; },
  ]) await tamper(t, await feeFixture(), change);
});

test('exact balance ledger rejects omitted fees, missing credits and fabricated unrelated funding', async t => {
  for (const change of [
    r => { delete r.changes.accounts.find(row => row.address === TX_SENDER).balance; },
    r => { r.changes.accounts = r.changes.accounts.filter(row => row.address !== COINBASE); },
    r => { r.changes.accounts.find(row => row.address === TX_SENDER).balance.after = '0x' + (1000000000000n - 1n).toString(16); },
    r => { r.changes.accounts.find(row => row.address === COINBASE).balance.after = '0x1'; },
    r => { r.changes.accounts.push({ address: TARGET, balance: { before: '0x0', after: '0x1' } }); },
  ]) await tamper(t, await feeFixture(), change);
});

test('reverted priced messages retain exact authorization and fee effects only', async t => {
  const make = () => feeFixture({ authorizationList: [signAuthorization()], target: { nonce: 1n, code: '0x602a60005560006000fd' },
    accounts: { [AUTHORITY]: { nonce: 0n, balance: 7n, code: '0x' }, [DELEGATE]: { nonce: 1n, code: '0x00' } } });
  const positive = await run(await make());
  assert.equal(positive.status, 'completed', JSON.stringify(positive.error));
  assert.equal(positive.output.execution.status, 'reverted');
  for (const change of [
    r => { r.changes.accounts = r.changes.accounts.filter(row => row.address !== AUTHORITY); },
    r => { r.changes.accounts.push({ address: TARGET, storage: [{ slot: word(0), before: word(0), after: word(42) }] }); },
    r => { r.changes.accounts.find(row => row.address === TX_SENDER).balance.after = r.changes.accounts.find(row => row.address === TX_SENDER).balance.before; },
  ]) await tamper(t, await make(), change);
});

test('priced original queries remain fresh unpriced contexts with neutral query-only nonces', async () => {
  const f = await feeFixture({ target: { nonce: 1n, code: '0x3a60005260206000f3' } });
  const query = { to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') };
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [query] });
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.preview.status, 'complete');
  assert.equal(BigInt(result.preview.original.output.execution.returnData), 10n);
  assert.equal(result.preview.scope.feesSettled, true);
  const measurement = result.preview.measurements[0];
  for (const side of [measurement.before, measurement.after]) {
    assert.equal(side.output.feeAccounting, undefined); assert.equal(side.output.profile.feesSettled, false);
    assert.equal(side.output.profile.declaredGasLimit, '1000000'); assert.equal(side.output.profile.executionBaseFee, '0');
    assert.equal(BigInt(side.output.execution.returnData), 0n);
  }
  assert.equal(measurement.values[0].deltaRaw, '0');
});
