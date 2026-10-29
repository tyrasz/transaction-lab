import { types } from 'node:util';

// Standalone Amsterdam arithmetic only. This module does not enable a network,
// execute state transitions, or authenticate counters supplied by a worker.
// Pinned reference: EthereumJS 10.1.3 runTx (8037 split and 7778 settlement).
// Specifications: https://eips.ethereum.org/EIPS/eip-8037 and /EIPS/eip-7778.
export const ETHEREUM_STATE_GAS_LIMITS = Object.freeze({
  regular: 16777216n,
  // The current 8037 spec is stricter than the pinned tx constructor's uint64
  // total-gas check. This independent admission bound does not raise the local
  // product's separate 5M ceiling.
  total: (1n << 32n) - 1n,
  refundQuotient: 5n,
});
const MAX_UINT256 = (1n << 256n) - 1n;
const INPUT_KEYS = ['gasLimit', 'intrinsicRegular', 'floor'];
const BUDGET_KEYS = [...INPUT_KEYS, 'intrinsicState', 'regularGasLimit', 'messageGasLimit', 'stateGasReservoirInitial'];
const COUNTER_KEYS = ['messageGasUsed', 'authorizationGasUsed', 'stateGasReservoir', 'executionStateGasUsed', 'messageRefundCounter', 'authorizationRefundCounter', 'postTargetOutOfGas'];

function need(ok) {
  if (!ok) throw Object.assign(new Error('Amsterdam state-gas accounting is malformed or inconsistent.'), { code: 'LOCAL_ETHEREUM_STATE_GAS_INVALID' });
}
function record(value, keys, booleanKeys = []) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value));
  need([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), ownKeys = Reflect.ownKeys(descriptors);
  need(ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key)));
  const copy = {};
  for (const key of keys) {
    const d = descriptors[key]; need(d?.enumerable && Object.hasOwn(d, 'value'));
    need(typeof d.value === (booleanKeys.includes(key) ? 'boolean' : 'bigint')); copy[key] = d.value;
  }
  return copy;
}
function unsigned(n, max = ETHEREUM_STATE_GAS_LIMITS.total) { need(n >= 0n && n <= max); return n; }
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;

function split(input) {
  const { gasLimit, intrinsicRegular, floor } = record(input, INPUT_KEYS);
  unsigned(gasLimit); unsigned(intrinsicRegular); unsigned(floor);
  const regularGasLimit = ETHEREUM_STATE_GAS_LIMITS.regular;
  need(max(intrinsicRegular, floor) <= regularGasLimit && gasLimit >= max(intrinsicRegular, floor));
  // Under the pinned EIP-2780/8037 revision every intrinsic charge is regular;
  // account/delegation creation is charged later against state at access time.
  const intrinsicState = 0n, executionGas = gasLimit - intrinsicRegular;
  const messageGasLimit = min(executionGas, regularGasLimit - intrinsicRegular);
  return Object.freeze({ gasLimit, intrinsicRegular, floor, intrinsicState, regularGasLimit,
    messageGasLimit, stateGasReservoirInitial: executionGas - messageGasLimit });
}

/** Split a total-gas envelope after separately validated intrinsic calculation.
 * The caller supplies a trusted fork selection; no header or chain claim is
 * inferred here. Existing pre-Amsterdam accounting must keep its old path. */
export function ethereumStateGasBudget(input, common) {
  need(common?.hardfork() === 'amsterdam' && common.isActivatedEIP(8037) && common.isActivatedEIP(7778));
  return split(input);
}

/** Settle FINAL transaction counters after frame rollback/preparation rollback
 * and any EIP-7928 post-target-OOG force-drain. authorizationGasUsed is the
 * regular-pool debit before runCall, including spilled authorization state gas;
 * it is not intrinsic gas and must not be included in messageGasUsed again.
 * executionStateGasUsed and reservoirDelta are signed. In particular a refill
 * can make the remaining reservoir exceed its initial size. Clamping either
 * before computing the paid total would overcharge legitimate refills.
 *
 * postTargetOutOfGas must be the conjunction of the final root OUT_OF_GAS error
 * and the EVM's eip7928CallPostTargetOog latch, retained before runTx clears it.
 * Pinned runTx force-drains the reservoir in this case. Its regular dimension
 * can then exceed the 16M regular cap. This is an observed pinned behavior, NOT
 * a claim that this exceptional rule is independently established as canonical.
 *
 * These are arithmetic consistency checks, not proof of the execution or of
 * authorization/refund eligibility. A parent must bind the counters separately.
 * No complete/incomplete or success/revert conclusion is inferred here. */
export function settleEthereumStateGas(budget, counters) {
  const plan = record(budget, BUDGET_KEYS);
  const recomputed = split(Object.fromEntries(INPUT_KEYS.map(key => [key, plan[key]])));
  for (const key of BUDGET_KEYS) need(plan[key] === recomputed[key]);
  const c = record(counters, COUNTER_KEYS, ['postTargetOutOfGas']);
  unsigned(c.messageGasUsed); unsigned(c.authorizationGasUsed); unsigned(c.stateGasReservoir);
  unsigned(c.messageRefundCounter, MAX_UINT256); unsigned(c.authorizationRefundCounter, MAX_UINT256);
  need(c.executionStateGasUsed >= -ETHEREUM_STATE_GAS_LIMITS.total && c.executionStateGasUsed <= ETHEREUM_STATE_GAS_LIMITS.total);
  const regularPoolUsed = c.messageGasUsed + c.authorizationGasUsed;
  need(regularPoolUsed <= plan.messageGasLimit);
  const reservoirDelta = plan.stateGasReservoirInitial - c.stateGasReservoir;
  const beforeRefund = plan.intrinsicRegular + regularPoolUsed + reservoirDelta;
  need(beforeRefund >= 0n && beforeRefund <= plan.gasLimit);
  if (c.postTargetOutOfGas) need(regularPoolUsed === plan.messageGasLimit && c.stateGasReservoir === 0n && beforeRefund === plan.gasLimit);
  // State drawn from gas_left is already included in regularPoolUsed. Remove
  // it once to recover actual non-state work; do not charge that spill twice.
  const executionRegularGasUsed = regularPoolUsed + reservoirDelta - c.executionStateGasUsed;
  const regularCounterBound = plan.messageGasLimit + (c.postTargetOutOfGas ? plan.stateGasReservoirInitial : 0n);
  need(executionRegularGasUsed >= 0n && executionRegularGasUsed <= regularCounterBound);
  const refundCounter = c.messageRefundCounter + c.authorizationRefundCounter;
  need(refundCounter <= MAX_UINT256);
  const appliedRefund = min(refundCounter, beforeRefund / ETHEREUM_STATE_GAS_LIMITS.refundQuotient);
  const afterRefund = beforeRefund - appliedRefund;
  const floorAdjustment = max(plan.floor - afterRefund, 0n);
  const gasUsed = afterRefund + floorAdjustment;
  need(gasUsed <= plan.gasLimit);
  const stateGasUsedRaw = c.executionStateGasUsed, stateGasUsed = max(stateGasUsedRaw, 0n);
  // Block dimensions intentionally do not subtract the ordinary refund. Their
  // sum need not equal sender-charged gas, nor the scalar 7778 blockGasUsed.
  return Object.freeze({ beforeRefund, refundCounter, appliedRefund, floorAdjustment, gasUsed,
    reportedRefundCounter: floorAdjustment > 0n ? 0n : refundCounter,
    reservoirDelta, stateGasUsedRaw, executionRegularGasUsed, stateGasUsed,
    regularGasUsed: max(beforeRefund - stateGasUsed, plan.floor),
    blockGasUsed: max(beforeRefund, plan.floor) });
}
