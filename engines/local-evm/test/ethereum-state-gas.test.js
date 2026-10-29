import test from 'node:test';
import assert from 'node:assert/strict';
import { Common, Sepolia, Hardfork } from '@ethereumjs/common';
import { bytesToHex, createAddressFromString, createContractAddress } from '@ethereumjs/util';
import { ethereumStateGasBudget, settleEthereumStateGas, ETHEREUM_STATE_GAS_LIMITS } from '../ethereum-state-gas.js';
import { signAuthorization, AUTHORITY, DELEGATE } from './authorization-fixture.js';
import { signedStateGasCase, commonForStateGas, accountAt, storageAt, callCode, SENDER, TARGET, CHILD, FUNDS } from './state-gas-fixture.js';

const budget = (extra = {}) => ethereumStateGasBudget({ gasLimit: 5000000n, intrinsicRegular: 15000n, floor: 15000n, ...extra }, commonForStateGas());
const counters = (extra = {}) => ({ messageGasUsed: 100000n, authorizationGasUsed: 0n, stateGasReservoir: 0n,
  executionStateGasUsed: 0n, messageRefundCounter: 0n, authorizationRefundCounter: 0n, postTargetOutOfGas: false, ...extra });

test('Amsterdam budget split has exact regular/total boundaries and does not enable older forks', () => {
  assert.equal(budget().stateGasReservoirInitial, 0n);
  const big = budget({ gasLimit: 20000000n });
  assert.equal(big.messageGasLimit, 16762216n); assert.equal(big.stateGasReservoirInitial, 3222784n);
  const cap = budget({ gasLimit: ETHEREUM_STATE_GAS_LIMITS.total });
  assert.equal(cap.messageGasLimit + cap.stateGasReservoirInitial + cap.intrinsicRegular, cap.gasLimit);
  assert.throws(() => budget({ gasLimit: ETHEREUM_STATE_GAS_LIMITS.total + 1n }));
  assert.throws(() => budget({ gasLimit: 14999n }));
  assert.throws(() => budget({ intrinsicRegular: 16777217n, gasLimit: 20000000n }));
  assert.throws(() => budget({ floor: 16777217n, gasLimit: 20000000n }));
  assert.throws(() => ethereumStateGasBudget({ gasLimit: 5000000n, intrinsicRegular: 21000n, floor: 21000n }, new Common({ chain: Sepolia, hardfork: Hardfork.Osaka })));
});

test('signed state/refill counters retain negative values; ordinary refunds and floor remain separate', () => {
  const s = settleEthereumStateGas(budget(), counters({ stateGasReservoir: 500n, executionStateGasUsed: -200n,
    messageRefundCounter: 30000n, authorizationRefundCounter: 1n }));
  assert.equal(s.reservoirDelta, -500n); assert.equal(s.stateGasUsedRaw, -200n); assert.equal(s.stateGasUsed, 0n);
  assert.equal(s.beforeRefund, 114500n); assert.equal(s.executionRegularGasUsed, 99700n);
  assert.equal(s.appliedRefund, 22900n); assert.equal(s.gasUsed, 91600n);
  assert.equal(s.regularGasUsed, 114500n); assert.equal(s.blockGasUsed, 114500n);
  const floor = settleEthereumStateGas(budget({ floor: 120000n }), counters({ messageRefundCounter: 1n }));
  assert.equal(floor.gasUsed, 120000n); assert.equal(floor.floorAdjustment, 5001n); assert.equal(floor.reportedRefundCounter, 0n);
});

test('arithmetic rejects impossible budget/counter combinations and hostile records without invoking accessors', () => {
  for (const patch of [{ messageGasUsed: -1n }, { authorizationGasUsed: 5000000n }, { stateGasReservoir: -1n },
    { executionStateGasUsed: 100001n }, { executionStateGasUsed: -(1n << 40n) }, { stateGasReservoir: 200000n },
    { messageRefundCounter: -1n }, { messageRefundCounter: 1n << 256n }, { messageGasUsed: '100000' }, { extra: 0n },
    { postTargetOutOfGas: true }, { postTargetOutOfGas: 0n }]) {
    assert.throws(() => settleEthereumStateGas(budget(), counters(patch)), /malformed or inconsistent/);
  }
  assert.throws(() => settleEthereumStateGas({ ...budget(), messageGasLimit: 5000000n }, counters()));
  let read = false;
  const getter = counters(); Object.defineProperty(getter, 'messageGasUsed', { enumerable: true, get() { read = true; return 1n; } });
  assert.throws(() => settleEthereumStateGas(budget(), getter)); assert.equal(read, false);
  const proxy = new Proxy(counters(), { ownKeys() { read = true; throw Error('trap'); } });
  assert.throws(() => settleEthereumStateGas(budget(), proxy)); assert.equal(read, false);
  const hidden = counters(); Object.defineProperty(hidden, 'messageGasUsed', { value: 1n, enumerable: false });
  assert.throws(() => settleEthereumStateGas(budget(), hidden));
  assert.throws(() => settleEthereumStateGas(budget(), { ...counters(), [Symbol('hidden')]: 1n }));
});

test('signed native transfers distinguish existing, absent and self recipients at transaction-level setup', async () => {
  for (const exists of [true, false]) for (const value of [0n, 17n]) {
    const f = await signedStateGasCase({ target: exists ? { nonce: 1n, balance: 5n } : null, value });
    assert.equal(f.result.execResult.exceptionError, undefined);
    assert.equal(f.settled.stateGasUsed, !exists && value > 0n ? 120n * 1530n : 0n);
    assert.equal((await accountAt(f.state, SENDER)).balance, FUNDS - value - f.settled.gasUsed * 10n);
    assert.equal((await accountAt(f.state, TARGET))?.balance ?? 0n, (exists ? 5n : 0n) + value);
  }
  for (const value of [0n, 17n]) {
    const f = await signedStateGasCase({ to: SENDER, value });
    assert.equal(f.costs.intrinsic, 12000n); assert.equal(f.settled.stateGasUsed, 0n);
    assert.equal((await accountAt(f.state, SENDER)).balance, FUNDS - f.settled.gasUsed * 10n);
  }
});

test('signed root creation pays account/code state gas only when committed and preserves prefunding distinction', async () => {
  const address = createContractAddress(createAddressFromString(SENDER), 1n).toString();
  // Initcode returns one STOP byte. A prefunded target has an existing leaf.
  for (const prefunded of [false, true]) {
    const f = await signedStateGasCase({ to: null, data: '0x600060005360016000f3',
      accounts: prefunded ? { [address]: { balance: 7n } } : {} });
    assert.equal(f.result.execResult.exceptionError, undefined);
    assert.equal(bytesToHex(await f.state.getCode(createAddressFromString(address))), '0x00');
    assert.equal(f.settled.stateGasUsed, (prefunded ? 1n : 121n) * 1530n);
  }
  const reverted = await signedStateGasCase({ to: null, data: '0x600160005560006000fd' });
  assert.equal(reverted.result.execResult.exceptionError.error, 'revert');
  assert.equal(reverted.settled.stateGasUsed, 0n); assert.equal(await accountAt(reverted.state, address), undefined);
  assert.equal((await accountAt(reverted.state, SENDER)).nonce, 2n);
});

test('signed SSTORE allocation/clear and original-slot refund separate state refills from the refund cap', async () => {
  const cases = [
    ['600160005500', {}, 1n, 64n * 1530n],
    ['6001600055600060005500', {}, 0n, 0n],
    ['600060005500', { '0': 7n }, 0n, 0n],
    ['6000600055600760005500', { '0': 7n }, 7n, 0n],
  ];
  for (const [code, storage, after, stateGas] of cases) {
    const f = await signedStateGasCase({ target: { nonce: 1n, code: '0x' + code, storage } });
    assert.equal(f.result.execResult.exceptionError, undefined); assert.equal(await storageAt(f.state, TARGET, 0), after);
    assert.equal(f.settled.stateGasUsed, stateGas);
    if (storage['0'] && after === 0n) {
      assert(f.settled.refundCounter > 0n); assert(f.settled.appliedRefund > 0n);
      assert(f.settled.blockGasUsed > f.settled.gasUsed);
    }
  }
});

test('signed frame revert and exceptional halt roll state gas back but preserve their distinct regular charges', async () => {
  for (const suffix of ['60006000fd', 'fe']) {
    const f = await signedStateGasCase({ target: { nonce: 1n, code: '0x6001600055' + suffix }, gasLimit: 500000n });
    assert(f.result.execResult.exceptionError); assert.equal(await storageAt(f.state, TARGET, 0), 0n);
    assert.equal(f.settled.stateGasUsed, 0n);
    if (suffix === 'fe') assert.equal(f.settled.gasUsed, 500000n);
    else assert(f.settled.gasUsed < 500000n - 64n * 1530n);
  }
});

test('signed transactions use a nonzero reservoir for state while returning unused reservoir on revert', async () => {
  for (const revert of [false, true]) {
    const f = await signedStateGasCase({ gasLimit: 20000000n,
      target: { nonce: 1n, code: '0x6001600055' + (revert ? '60006000fd' : '00') } });
    assert(f.budget.stateGasReservoirInitial > 0n);
    assert.equal(f.settled.reservoirDelta, revert ? 0n : 64n * 1530n);
    assert.equal(f.settled.stateGasUsed, revert ? 0n : 64n * 1530n);
    assert(f.counters.messageGasUsed < 64n * 1530n);
  }
  const spill = await signedStateGasCase({ gasLimit: 16777216n + 50000n, target: { nonce: 1n, code: '0x600160005500' } });
  assert.equal(spill.settled.reservoirDelta, 50000n); assert.equal(spill.settled.stateGasUsed, 97920n);
  assert.equal(spill.counters.messageGasUsed - spill.settled.executionRegularGasUsed, 47920n, 'Only the remaining state charge spills into regular gas_left');
});

test('signed nested calls preserve successful state and discard reverted allocation/refill across frames', async () => {
  for (const revert of [false, true]) {
    const f = await signedStateGasCase({ target: { nonce: 1n, code: '0x' + callCode(CHILD) + '00' },
      accounts: { [CHILD]: { nonce: 1n, code: '0x6001600055' + (revert ? '60006000fd' : '00') } } });
    assert.equal(f.result.execResult.exceptionError, undefined);
    assert.equal(await storageAt(f.state, CHILD, 0), revert ? 0n : 1n);
    assert.equal(f.settled.stateGasUsed, revert ? 0n : 64n * 1530n);
  }
  // Parent allocates, delegate child clears the same transaction-original-zero
  // slot. The refill may go to a different frame/pool than the original debit.
  const f = await signedStateGasCase({ target: { nonce: 1n, code: '0x6001600055' + callCode(CHILD, { opcode: 'f4' }) + '00' },
    accounts: { [CHILD]: { nonce: 1n, code: '0x600060005500' } } });
  assert.equal(f.result.execResult.exceptionError, undefined); assert.equal(await storageAt(f.state, TARGET, 0), 0n);
  assert.equal(f.settled.stateGasUsed, 0n);
  assert(f.counters.stateGasReservoir > f.budget.stateGasReservoirInitial, 'A real cross-frame refill can exceed initial reservoir');
  assert(f.settled.reservoirDelta < 0n);
});

test('signed type-4 preparation debits are counted once and survive only ordinary message rollback', async () => {
  for (const revert of [false, true]) {
    const f = await signedStateGasCase({ authorizationList: [signAuthorization({ chainId: 11155111n })],
      target: { nonce: 1n, code: revert ? '0x60006000fd' : '0x00' },
      accounts: { [AUTHORITY]: { nonce: 0n, balance: 7n }, [DELEGATE]: { nonce: 1n, code: '0x00' } } });
    assert(f.counters.authorizationGasUsed > 0n); assert.equal(f.counters.authorizationRefundCounter, 0n);
    assert.equal(f.settled.stateGasUsed, 23n * 1530n);
    assert.equal(bytesToHex(await f.state.getCode(createAddressFromString(AUTHORITY))), '0xef0100' + DELEGATE.slice(2));
    assert.equal(f.result.execResult.exceptionError?.error, revert ? 'revert' : undefined);
  }
});

test('signed preparation OOG rolls authorization state back while retaining sender nonce and spent regular gas', async () => {
  // The first stops in authorization processing; the second finishes the auth
  // and then fails delegated top-frame access before entering its bytecode.
  for (const gasLimit of [64006n, 68000n]) {
    const f = await signedStateGasCase({ gasLimit, to: AUTHORITY,
      authorizationList: [signAuthorization({ chainId: 11155111n })],
      accounts: { [AUTHORITY]: { nonce: 0n, balance: 7n }, [DELEGATE]: { nonce: 1n, code: '0x00' } } });
    assert.equal(f.result.execResult.exceptionError.error, 'out of gas'); assert.equal(f.settled.gasUsed, gasLimit);
    assert.equal(f.settled.stateGasUsed, 0n); assert.equal((await accountAt(f.state, SENDER)).nonce, 2n);
    assert.equal((await accountAt(f.state, AUTHORITY)).nonce, 0n);
    assert.equal(bytesToHex(await f.state.getCode(createAddressFromString(AUTHORITY))), '0x');
    assert.equal(f.rootEntry === undefined, gasLimit === 64006n);
    assert(f.counters.authorizationGasUsed > 0n);
  }
});

test('signed calldata floor changes sender gas and refund reporting without erasing raw message refund', async () => {
  const f = await signedStateGasCase({ data: '0x' + '00'.repeat(256), target: { nonce: 1n, code: '0x600060005500', storage: { '0': 7n } } });
  assert(f.settled.floorAdjustment > 0n); assert(f.counters.messageRefundCounter > 0n);
  assert.equal(f.settled.gasUsed, f.costs.floor); assert.equal(f.settled.reportedRefundCounter, 0n);
  assert.equal(f.settled.stateGasUsed, 0n);
});

test('observed pinned post-target CALL OOG drains reservoir; its above-cap regular dimension is explicitly exceptional', async () => {
  const delegated = '0x' + '44'.repeat(20), implementation = '0x' + '55'.repeat(20);
  // Three caught INVALID child calls consume regular gas cheaply. The final
  // delegated target passes its first address check then OOGs resolving code.
  // No reservoir-consuming state changes survive. No public execution enabled.
  const third = '6000600060006000600073' + CHILD.slice(2) + '6111945a03f150';
  const bytecode = '0x' + callCode(CHILD, { gas: 16000000 }) + callCode(CHILD, { gas: 600000 })
    + third + callCode(delegated, { gas: 0 }) + '00';
  const f = await signedStateGasCase({ gasLimit: 20000000n, target: { nonce: 1n, code: bytecode }, accounts: {
    [CHILD]: { nonce: 1n, code: '0xfe' }, [delegated]: { nonce: 1n, code: '0xef0100' + implementation.slice(2) },
    [implementation]: { nonce: 1n, code: '0x00' },
  } });
  assert.equal(f.result.execResult.exceptionError.error, 'out of gas'); assert.equal(f.counters.postTargetOutOfGas, true);
  assert.equal(f.counters.messageGasUsed, 16762216n); assert.equal(f.counters.stateGasReservoir, 0n);
  assert.equal(f.settled.stateGasUsed, 0n); assert.equal(f.settled.gasUsed, 20000000n);
  assert.equal(f.settled.regularGasUsed, 20000000n); assert.equal(f.settled.blockGasUsed, 20000000n);
  assert.throws(() => settleEthereumStateGas(f.budget, { ...f.counters, postTargetOutOfGas: false }));
  assert.throws(() => settleEthereumStateGas(f.budget, { ...f.counters, messageGasUsed: f.counters.messageGasUsed - 1n }));
  assert.throws(() => settleEthereumStateGas(f.budget, { ...f.counters, stateGasReservoir: 1n }));
});
