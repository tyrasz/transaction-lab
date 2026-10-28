import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { feeFixture, TX_SENDER, TARGET, COINBASE, balance, account, slot } from './fee-fixture.js';

const funded = 1000000000000n;
const sender = createAddressFromString(TX_SENDER), target = createAddressFromString(TARGET);
const execute = (f, extra = {}) => executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager, blockchain: f.inputs.blockchain, ...extra });
const writeFixture = () => feeFixture({ gas: '100000', target: { nonce: 1n, balance: 0n, code: '0x602a60005500' } });
function withheld(output) {
  assert.equal(output.execution.status, 'unavailable'); assert.equal(output.feeAccounting, undefined);
  assert.equal(output.profile.feesSettled, false); assert.equal(output.semantics.feeSettlement, false);
  assert.equal(output.profile.gasPrice, '10'); assert.equal(output.semantics.gasPrice, '10');
  assert.equal(output.stateDisposition, 'rolled_back');
}

test('actual fee opcodes and sender balance observe the effective-price prepayment before the message', async () => {
  const f = await feeFixture({ gas: '100000', value: '11', target: { nonce: 1n, code: '0x3a60005248602052333160405260606000f3' } });
  const output = await execute(f); assert.equal(output.execution.status, 'success');
  const words = Array.from({ length: 3 }, (_, i) => BigInt('0x' + output.execution.returnData.slice(2 + i * 64, 66 + i * 64)));
  assert.deepEqual(words, [10n, 7n, funded - 100000n * 10n - 11n]);
  assert.equal(output.profile.name, 'ethereum_unsigned_eip1559_call'); assert.equal(output.profile.executionBaseFee, '7');
  assert.equal(output.profile.feesSettled, true); assert.equal(output.semantics.feeSettlement, true);
  const fees = output.feeAccounting;
  assert.equal(fees.maximumRequiredBalance, '1300011'); assert.equal(fees.upfrontGasDebit, '1000000');
  assert.equal(fees.chargedGas, output.gasAccounting.gasUsed);
  assert.equal(await balance(f.stateManager, TX_SENDER), funded - BigInt(fees.gasCharge) - 11n);
  assert.equal(await balance(f.stateManager, COINBASE), BigInt(fees.coinbaseTip));
  assert.equal(await balance(f.stateManager, TARGET), 11n);
});

test('host failures after prepayment, sender refund or coinbase credit roll back the entire priced attempt', async () => {
  for (const phase of ['prepayment', 'sender_refund', 'coinbase_credit', 'cleanup']) {
    const f = await writeFixture(), before = f.stateManager.snapshotChanges(), put = f.stateManager.putAccount.bind(f.stateManager);
    let injected = false;
    f.stateManager.putAccount = async (address, value) => {
      await put(address, value);
      if (!injected && ((phase === 'prepayment' && address.toString() === TX_SENDER && value.nonce === 1n && value.balance === funded - 1000000n) ||
        (phase === 'sender_refund' && address.toString() === TX_SENDER && value.nonce === 2n && value.balance > funded - 1000000n) ||
        (phase === 'coinbase_credit' && address.toString() === COINBASE && value.balance > 0n))) {
        injected = true; throw Error('private injected settlement failure');
      }
    };
    if (phase === 'cleanup') {
      const end = f.stateManager.endEmptyAccountCleanup.bind(f.stateManager);
      f.stateManager.endEmptyAccountCleanup = () => { end(); injected = true; throw Error('private injected cleanup failure'); };
    }
    const output = await execute(f); assert(injected, phase); withheld(output);
    assert.equal(JSON.stringify(output).includes('private injected'), false);
    assert.deepEqual(f.stateManager.snapshotChanges(), before, phase);
    assert.equal((await account(f.stateManager, TX_SENDER)).nonce, 1n); assert.equal(await balance(f.stateManager, TX_SENDER), funded);
    assert.equal(await account(f.stateManager, COINBASE), undefined); assert.equal(await slot(f.stateManager, TARGET, 0), 0n);
  }
});

test('deadline exhaustion after both credits still rolls back all fees, nonce and message storage', async () => {
  const f = await writeFixture(), put = f.stateManager.putAccount.bind(f.stateManager); let time = 0, credited = false;
  f.stateManager.putAccount = async (address, value) => {
    await put(address, value);
    if (address.toString() === COINBASE) { credited = true; time = 120000; }
  };
  const output = await execute(f, { now: () => time }); assert(credited); withheld(output);
  assert.equal(output.execution.error.code, 'LOCAL_RESOURCE_LIMIT'); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  assert.equal(await balance(f.stateManager, TX_SENDER), funded); assert.equal(await account(f.stateManager, COINBASE), undefined);
  assert.equal(await slot(f.stateManager, TARGET, 0), 0n);
});

test('failed fee settlement respects a caller-owned checkpoint and retains only its previous overlay', async () => {
  const f = await writeFixture(); await f.stateManager.checkpoint();
  const existing = await f.stateManager.getAccount(target); existing.balance = 17n; await f.stateManager.putAccount(target, existing);
  const before = f.stateManager.snapshotChanges(), depth = f.stateManager.accountStack.length;
  const put = f.stateManager.putAccount.bind(f.stateManager); let injected = false;
  f.stateManager.putAccount = async (address, value) => { await put(address, value); if (address.toString() === COINBASE) { injected = true; throw Error('private outer checkpoint failure'); } };
  const output = await execute(f); assert(injected); withheld(output);
  assert.equal(f.stateManager.accountStack.length, depth); assert.deepEqual(f.stateManager.snapshotChanges(), before);
  assert.equal((await f.stateManager.getAccount(sender)).nonce, 1n); assert.equal(await balance(f.stateManager, TARGET), 17n);
  await f.stateManager.revert(); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
});
