// Synthetic signed transaction controls. runTx and the local engine share
// EthereumJS; this is NOT independent-client evidence or public-chain data.
import assert from 'node:assert/strict';
import { Common, Sepolia, Hardfork } from '../../fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { getCalldataFloorGas } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { bytesToHex, hexToBytes, privateToAddress, createAddressFromString } from '@ethereumjs/util';
import { loadState } from '../../fixture-evm/state-test.js';
import { ethereumCallGas } from '../ethereum-profile.js';
import { ethereumStateGasBudget, settleEthereumStateGas } from '../ethereum-state-gas.js';

export const KEY = hexToBytes('0x' + '01'.repeat(32));
export const SENDER = bytesToHex(privateToAddress(KEY));
export const TARGET = '0x' + '22'.repeat(20), CHILD = '0x' + '33'.repeat(20), COINBASE = '0x' + '99'.repeat(20);
export const FUNDS = 10n ** 20n;
export const commonForStateGas = () => new Common({ chain: Sepolia, hardfork: Hardfork.Amsterdam });
const quantity = n => '0x' + BigInt(n).toString(16);
const integer = n => n === 0n ? new Uint8Array() : hexToBytes('0x' + n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'));
export const accountAt = (state, address) => state.getAccount(createAddressFromString(address));
export const storageAt = async (state, address, n) => {
  const value = await state.getStorage(createAddressFromString(address), hexToBytes('0x' + BigInt(n).toString(16).padStart(64, '0')));
  return value.length ? BigInt(bytesToHex(value)) : 0n;
};
export function callCode(address, { value = 0, gas = 1000000, opcode = 'f1', suffix = '50' } = {}) {
  return '6000600060006000' + (opcode === 'f1' || opcode === 'f2' ? '60' + value.toString(16).padStart(2, '0') : '')
    + '73' + address.slice(2) + '63' + gas.toString(16).padStart(8, '0') + opcode + suffix;
}

export async function signedStateGasCase({ target = { nonce: 1n, code: '0x00' }, accounts = {}, to = TARGET,
  value = 0n, data = '0x', gasLimit = 5000000n, authorizationList, accessList, expectedSettlementError = null } = {}) {
  const common = commonForStateGas();
  const supplied = { [SENDER]: { nonce: 1n, balance: FUNDS }, ...(target === null ? {} : { [TARGET]: target }), ...accounts };
  const allocation = Object.fromEntries(Object.entries(supplied).map(([address, input]) => {
    const row = { nonce: 0n, balance: 0n, code: '0x', storage: {}, ...input };
    return [address, { nonce: quantity(row.nonce), balance: quantity(row.balance), code: row.code,
      storage: Object.fromEntries(Object.entries(row.storage).map(([key, v]) => [quantity(key), quantity(v)])) }];
  }));
  const state = await loadState(allocation, common);
  const block = createBlock({ header: { number: 12018196n, timestamp: 1793261160n, gasLimit: 60000000n,
    baseFeePerGas: 7n, coinbase: COINBASE, stateRoot: await state.getStateRoot() }, withdrawals: [] }, { common });
  const vm = await createVM({ common, stateManager: state, blockchain: {
    async getBlock() { throw Error('No ancestry supplied by this synthetic fixture'); }, shallowCopy() { return this; },
  } });
  const request = { from: SENDER, to, value: value.toString(), data, gas: gasLimit.toString(),
    ...(accessList ? { accessList } : {}), ...(authorizationList ? { authorizationList } : {}) };
  const costs = ethereumCallGas(data, common, request);
  const tx = createTx({ type: authorizationList ? 4 : 2, chainId: 11155111n, nonce: 1n, gasLimit,
    to: to ?? undefined, value, data, maxFeePerGas: 13n, maxPriorityFeePerGas: 3n,
    ...(accessList ? { accessList } : {}), ...(authorizationList ? { authorizationList: authorizationList.map(t =>
      ['chainId', 'address', 'nonce', 'yParity', 'r', 's'].map(key => key === 'address' ? hexToBytes(t[key]) : integer(BigInt(t[key])))) } : {}),
  }, { common }).sign(KEY);
  assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(), SENDER);
  assert.equal(tx.getIntrinsicGas(), costs.intrinsic); assert.equal(getCalldataFloorGas(tx), costs.floor);
  const budget = ethereumStateGasBudget({ gasLimit, intrinsicRegular: costs.intrinsic, floor: costs.floor }, common);
  let rootEntry, postTargetOutOfGas = false;
  const runCall = vm.evm.runCall.bind(vm.evm);
  vm.evm.runCall = async opts => {
    if (opts.message === undefined) {
      assert.equal(rootEntry, undefined);
      rootEntry = { gasLimit: opts.gasLimit, reservoir: vm.evm.stateGasReservoir, stateUsed: vm.evm.executionStateGasUsed };
    }
    const result = await runCall(opts);
    if (opts.message === undefined) postTargetOutOfGas = result.execResult.exceptionError?.error === 'out of gas' && vm.evm.eip7928CallPostTargetOog === true;
    return result;
  };
  const result = await runTx(vm, { tx, block });
  const counters = {
    messageGasUsed: result.execResult.executionGasUsed,
    authorizationGasUsed: budget.messageGasLimit - (rootEntry?.gasLimit ?? result.execResult.executionGasUsed),
    stateGasReservoir: vm.evm.stateGasReservoir, executionStateGasUsed: vm.evm.executionStateGasUsed,
    messageRefundCounter: result.execResult.gasRefund ?? 0n, authorizationRefundCounter: 0n, postTargetOutOfGas,
  };
  if (expectedSettlementError) {
    assert.throws(() => settleEthereumStateGas(budget, counters), { code: expectedSettlementError });
    return { state, vm, tx, block, request, result, costs, budget, counters, settled: null, rootEntry };
  }
  const settled = settleEthereumStateGas(budget, counters);
  assert.equal(settled.gasUsed, result.totalGasSpent, 'sender/receipt gas');
  // Pinned EthereumJS calls this scalar blockGasSpent. It is not Amsterdam's
  // max of cumulative regular/state dimensions; keep its meaning explicit.
  assert.equal(settled.preRefundGasWithFloor, result.blockGasSpent, 'pre-refund scalar with floor');
  assert.equal(settled.singleTransactionBlockGasUsed, result.txRegularGas > result.txStateGas ? result.txRegularGas : result.txStateGas);
  assert.equal(settled.regularGasUsed, result.txRegularGas, '8037 regular block dimension');
  assert.equal(settled.stateGasUsed, result.txStateGas, '8037 state block dimension');
  assert.equal(settled.reportedRefundCounter, result.gasRefund, 'pinned refund reporting after floor');
  assert.equal(result.receipt.cumulativeBlockGasUsed, settled.gasUsed);
  assert.equal(result.amountSpent, settled.gasUsed * 10n);
  return { state, vm, tx, block, request, result, costs, budget, counters, settled, rootEntry };
}
