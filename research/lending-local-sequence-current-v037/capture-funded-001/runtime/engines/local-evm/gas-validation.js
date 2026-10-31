// Parent-side arithmetic binding only. Reconstructing these dimensions does not
// independently prove the worker's state-gas/refund eligibility or execution.
import { isDeepStrictEqual, types } from 'node:util';
import { ethereumCallGas, ethereumCommon, ethereumQuantity, ethereumUsedGas } from './ethereum-profile.js';
import { ethereumStateGasBudget, settleEthereumStateGas } from './ethereum-state-gas.js';
import { deriveAuthorizationPreparation } from './authorization-validation.js';

const BUDGET = ['gasLimit', 'intrinsicRegular', 'floor', 'intrinsicState', 'regularGasLimit', 'messageGasLimit', 'stateGasReservoirInitial'];
const COUNTERS = ['messageGasUsed', 'authorizationGasUsed', 'stateGasReservoir', 'executionStateGasUsed', 'messageRefundCounter', 'authorizationRefundCounter', 'postTargetOutOfGas'];
const SETTLED = ['beforeRefund', 'refundCounter', 'appliedRefund', 'floorAdjustment', 'gasUsed', 'reportedRefundCounter', 'reservoirDelta', 'stateGasUsedRaw', 'executionRegularGasUsed', 'stateGasUsed', 'regularGasUsed', 'preRefundGasWithFloor', 'singleTransactionBlockGasUsed'];
const MAX = (1n << 256n) - 1n;
const need = value => { if (!value) throw new Error('Gas accounting does not match the verified transaction context.'); };
const strings = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));

function record(value, keys) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value));
  need([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  need(own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)));
  return Object.fromEntries(keys.map(key => {
    const d = descriptors[key]; need(d?.enumerable && Object.hasOwn(d, 'value'));
    return [key, d.value];
  }));
}
function decimal(value, signed = false) {
  need(typeof value === 'string' && value.length <= 79 && (signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value));
  const n = BigInt(value); need(n >= (signed ? -MAX : 0n) && n <= MAX); return n;
}
function quantities(value, keys, signed = [], boolean = []) {
  const copy = record(value, keys);
  return Object.fromEntries(keys.map(key => {
    if (boolean.includes(key)) { need(typeof copy[key] === 'boolean'); return [key, copy[key]]; }
    return [key, decimal(copy[key], signed.includes(key))];
  }));
}

/** Bind fork-selected gas accounting to the admitted total gas and retained
 * execution fields. Old forks retain their existing scalar output shape. */
export function deriveVerifiedGas({ request, header, inputs, output, chainId = 1, startingChanges }) {
  const common = ethereumCommon(header, chainId), amsterdam = common.isActivatedEIP(8037);
  const complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  if (!complete) {
    need(output?.stateGasAccounting === undefined && output?.execution?.executionStateGasUsed === undefined);
    return null;
  }
  const costs = ethereumCallGas(request.data, common, request), gasLimit = ethereumQuantity(request.gas);
  if (!amsterdam) {
    need(output.stateGasAccounting === undefined && output.execution.executionStateGasUsed === undefined);
    const messageGasUsed = ethereumQuantity(output.execution.executionGasUsed);
    need(messageGasUsed <= gasLimit - costs.intrinsic);
    const settled = ethereumUsedGas({ messageGasUsed,
      refundCounter: ethereumQuantity(output.execution.gasRefundCounter) + BigInt(output.authorizationProcessing?.gasRefundCounter ?? '0'),
      intrinsic: costs.intrinsic, floor: costs.floor });
    need(isDeepStrictEqual(output.gasAccounting, strings(settled)));
    return settled;
  }
  const authorization = deriveAuthorizationPreparation({ request, header, inputs, common, startingChanges });
  need(isDeepStrictEqual(output.authorizationProcessing, authorization?.processing));
  const accounting = record(output.stateGasAccounting, ['budget', 'counters', 'settled']);
  const budget = quantities(accounting.budget, BUDGET);
  const expectedBudget = ethereumStateGasBudget({ gasLimit, intrinsicRegular: costs.intrinsic, floor: costs.floor }, common);
  need(isDeepStrictEqual(budget, expectedBudget));
  const counters = quantities(accounting.counters, COUNTERS, ['executionStateGasUsed'], ['postTargetOutOfGas']);
  need(counters.messageGasUsed === decimal(output.execution.executionGasUsed));
  need(counters.executionStateGasUsed === decimal(output.execution.executionStateGasUsed, true));
  need(counters.messageRefundCounter === decimal(output.execution.gasRefundCounter));
  const preparation = authorization?.processing.preparation;
  need(counters.authorizationGasUsed === BigInt(preparation?.authorizationGasUsed ?? '0') && counters.authorizationRefundCounter === 0n);
  if (preparation && preparation.phase !== 'message') {
    need(output.execution.status === 'failed' && output.execution.error === 'out of gas' && output.execution.returnData === '0x');
    need(counters.messageRefundCounter === 0n && counters.executionStateGasUsed === 0n && counters.stateGasReservoir === expectedBudget.stateGasReservoirInitial && !counters.postTargetOutOfGas);
    need(counters.messageGasUsed === (preparation.phase === 'authorization_out_of_gas' ? 0n : expectedBudget.messageGasLimit - counters.authorizationGasUsed));
    need(Array.isArray(output.logs) && output.logs.length === 0);
  } else if (preparation && output.execution.status !== 'success') {
    // An entered-message failure restores its post-authorization snapshot.
    need(counters.executionStateGasUsed === BigInt(preparation.executionStateGasUsed) && counters.stateGasReservoir === BigInt(preparation.stateGasReservoir));
  }
  if (counters.postTargetOutOfGas) need(output.execution.status === 'failed' && output.execution.error === 'out of gas');
  const settled = settleEthereumStateGas(expectedBudget, counters);
  need(isDeepStrictEqual(quantities(accounting.settled, SETTLED, ['reservoirDelta', 'stateGasUsedRaw']), settled));
  need(isDeepStrictEqual(output.gasAccounting, strings(settled)));
  return settled;
}
