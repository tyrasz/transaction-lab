import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumCall } from '../ethereum-call.js';
import { ethereumStateGasBudget, settleEthereumStateGas } from '../ethereum-state-gas.js';
import { amsterdamExecutionFixture as fixture, compareAmsterdamFullVM, TX_SENDER, TARGET, account, code, slot, word } from './amsterdam-execution-fixture.js';
import { factoryCode, initcode, createdAddress } from './lifecycle-fixture.js';
import { callCode } from './state-gas-fixture.js';
const run = f => executeEthereumCall({ request: f.request, header: f.header, chainId: f.chainId, stateManager: f.stateManager, blockchain: f.inputs.blockchain });

test('Amsterdam transfers distinguish existing, absent, empty and self while preserving exact fees and native logs', async () => {
  for (const priced of [false, true]) for (const [target, value, to, gas] of [
    [{ nonce: 1n, balance: 5n }, '0', TARGET, 15000n], [null, '0', TARGET, 15000n],
    [{ nonce: 1n, balance: 5n }, '17', TARGET, 21000n], [null, '17', TARGET, 204600n],
    [{ nonce: 0n, balance: 0n }, '17', TARGET, 204600n], [{ nonce: 1n }, '17', TX_SENDER, 12000n],
  ]) {
    const f = await fixture({ priced, target, value, to });
    const output = await run(f); assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
    assert.equal(output.gasAccounting.gasUsed, gas.toString());
    assert.equal(output.environment.chainId, 11155111); assert.equal(output.environment.slotNumber, '12345');
    await compareAmsterdamFullVM(f, output);
  }
});

test('SLOTNUM and CHAINID use the explicit Sepolia execution context', async () => {
  const f = await fixture({ target: { nonce: 1n, code: '0x4b6000524660205260406000f3' } });
  const output = await run(f); assert.equal(output.execution.status, 'success');
  assert.equal(output.execution.returnData, word(12345).slice(0) + word(11155111).slice(2));
  await compareAmsterdamFullVM(f, output);
});

test('state allocation, clearing, refund floor and root rollback match signed transaction settlement', async () => {
  for (const [code, storage, data] of [
    ['600160005500', {}, '0x'], ['6001600055600060005500', {}, '0x'],
    ['600060005500', { [word(0)]: 7n }, '0x' + '00'.repeat(256)],
    ['600160005560006000fd', {}, '0x'], ['6001600055fe', {}, '0x'],
  ]) {
    const f = await fixture({ target: { nonce: 1n, code: '0x' + code, storage }, data, gas: '500000' });
    const output = await run(f); assert(['success','reverted','failed'].includes(output.execution.status), JSON.stringify(output.execution));
    await compareAmsterdamFullVM(f, output);
  }
});

test('root creation charges runtime state once and rolls failed constructors back', async () => {
  for (const data of ['0x', '0x600060005360016000f3', '0x600160005560006000fd', '0xfe']) {
    const f = await fixture({ to: null, data, value: '5' });
    const output = await run(f); assert(['success','reverted','failed'].includes(output.execution.status), JSON.stringify(output.execution));
    await compareAmsterdamFullVM(f, output);
  }
});

test('root creation into a prefunded empty address preserves funds without a new-account charge', async () => {
  const destination = createdAddress({ creator: TX_SENDER, nonce: 1n, init: '' });
  const f = await fixture({ to: null, data: '0x', value: '5', accounts: { [destination]: { balance: 7n } } });
  const output = await run(f);
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  assert.equal(output.gasAccounting.gasUsed, '24000');
  assert.equal((await account(f.stateManager, destination)).balance, 12n);
  await compareAmsterdamFullVM(f, output);
});

test('a delegated child clears its caller storage with a signed reservoir refill and exact settlement', async () => {
  const child = '0x' + '33'.repeat(20);
  const f = await fixture({ target: { nonce: 1n, code: '0x6001600055' + callCode(child, { opcode: 'f4' }) + '00' },
    accounts: { [child]: { nonce: 1n, code: '0x600060005500' } } });
  const output = await run(f);
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  assert.equal(await slot(f.stateManager, TARGET, 0), 0n);
  assert.equal(output.stateGasAccounting.settled.stateGasUsed, '0');
  assert(BigInt(output.stateGasAccounting.settled.reservoirDelta) < 0n);
  await compareAmsterdamFullVM(f, output);
});

test('post-target out-of-gas consumes root regular gas but a caught child latch does not consume its caller budget', async () => {
  const leaf = '0x' + '33'.repeat(20), delegated = '0x' + 'aa'.repeat(20), implementation = '0x' + '55'.repeat(20), body = '0x' + '66'.repeat(20);
  const third = '6000600060006000600073' + leaf.slice(2) + '6111945a03f150';
  const failingBody = (first, second) => callCode(leaf, { gas: first }) + callCode(leaf, { gas: second }) + third + callCode(delegated, { gas: 0 }) + '00';
  for (const nested of [false, true]) {
    const f = await fixture({ target: { nonce: 1n, code: '0x' + (nested ? callCode(body, { gas: 1000000 }) + '00' : failingBody(4000000, 600000)) },
      accounts: { [leaf]: { nonce: 1n, code: '0xfe' }, [delegated]: { nonce: 1n, code: '0xef0100' + implementation.slice(2) },
        [implementation]: { nonce: 1n, code: '0x00' }, ...(nested ? { [body]: { nonce: 1n, code: '0x' + failingBody(400000, 400000) } } : {}) } });
    const output = await run(f);
    assert.equal(output.execution.status, nested ? 'success' : 'failed', JSON.stringify(output.execution));
    assert.equal(output.stateGasAccounting.counters.postTargetOutOfGas, !nested);
    if (nested) {
      assert.equal(output.trace.calls[0].error, 'out of gas');
      assert(BigInt(output.gasAccounting.gasUsed) < 5000000n);
    } else {
      assert.equal(output.execution.error, 'out of gas');
      assert.equal(output.gasAccounting.gasUsed, '5000000');
    }
    await compareAmsterdamFullVM(f, output);
  }
});

test('created self-beneficiary clearing preserves endowment and residual prefunding', async () => {
  const init = '602a60005530ff', created = createdAddress({ creator: TARGET, nonce: 1n, init });
  for (const prefunded of [false, true]) {
    const f = await fixture({ target: { nonce: 1n, balance: 1000n, code: factoryCode(init, { value: 7 }) },
      accounts: prefunded ? { [created]: { balance: 17n } } : {} });
    const output = await run(f); assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
    assert.equal(output.lifecycle.finalizedClearings[0].preservedBalance, prefunded ? '0x18' : '0x7');
    assert.equal((await account(f.stateManager, created)).balance, prefunded ? 24n : 7n);
    assert.equal(await code(f.stateManager, created), '0x'); assert.equal(await slot(f.stateManager, created, 0), 0n);
    await compareAmsterdamFullVM(f, output);
  }
});

test('unknown or out-of-range Amsterdam slot does not retain execution state', async () => {
  for (const patch of [{ slotNumber: undefined }, { slotNumber: '-1' }, { slotNumber: (1n << 64n).toString() }]) {
    const f = await fixture(); Object.assign(f.header, patch);
    const output = await run(f); assert.equal(output.execution.status, 'invalid'); assert.equal(f.calls.length, 0);
  }
});

test('raw restored reservoir settles to retained independent Geth outcome and force-drained counters fail', async () => {
  const f = await fixture();
  const b = ethereumStateGasBudget({ gasLimit: 20000000n, intrinsicRegular: 15000n, floor: 15000n }, f.common);
  const c = { messageGasUsed: b.messageGasLimit, authorizationGasUsed: 0n, stateGasReservoir: 3222784n,
    executionStateGasUsed: 0n, messageRefundCounter: 0n, authorizationRefundCounter: 0n, postTargetOutOfGas: true };
  const s = settleEthereumStateGas(b, c); assert.equal(s.gasUsed, 16777216n); assert.equal(s.regularGasUsed, 16777216n);
  assert.throws(() => settleEthereumStateGas(b, { ...c, stateGasReservoir: 0n }), { code: 'LOCAL_ETHEREUM_STATE_GAS_INVALID' });
});
