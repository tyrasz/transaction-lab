import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { normalizeAuthorizationList, recoverAuthorization, authorizationStateDecision } from './authorization-list.js';

// Standalone preparation only: no network admission, sender increment, fee
// payment, checkpoint ownership, message execution or public result schema.
// EIP-2780 runtime authorization rules; EIP-8037 existence/rollback rules.
// Pinned Geth 1df30b18 core/state_transition.go applyAuthorization/GasBudget.
export const AMSTERDAM_AUTHORIZATION_COSTS = Object.freeze({
  accountWrite: 9000n, newAccount: 120n * 1530n, delegationIndicator: 23n * 1530n,
});
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DESIGNATION = /^0xef0100[0-9a-f]{40}$/;
const MAX_GAS = (1n << 32n) - 1n, MAX_NONCE = (1n << 64n) - 1n, MAX_BALANCE = (1n << 256n) - 1n;
function need(ok) {
  if (!ok) throw Object.assign(new Error('Amsterdam authorization preparation is malformed or inconsistent.'), { code: 'LOCAL_AMSTERDAM_AUTHORIZATION_INVALID' });
}
function uint(value, max = MAX_GAS) { need(typeof value === 'bigint' && value >= 0n && value <= max); }
function network(common) {
  need(common?.hardfork() === 'amsterdam' && [7702, 2780, 7928, 8037].every(eip => common.isActivatedEIP(eip)));
  const chainId = common.chainId(); need(chainId === 1n || chainId === 11155111n); return chainId;
}

/** Pure state eligibility/cost decision. The caller folds independently verified
 * facts and its own per-authority tracking; no child overlay is authenticated by
 * this function. A trie leaf with zero balance/nonce/code is EIP-161-empty and
 * incurs new-account gas even if exists=true. The pinned EthereumJS runTx's
 * undefined-only test differs here; do not use its result as this case's oracle.
 * Storage alone does not make an account nonempty. */
export function amsterdamAuthorizationDecision(tuple, facts, tracking, context) {
  const { exists, nonce, balance, code } = facts;
  need(typeof exists === 'boolean'); uint(nonce, MAX_NONCE); uint(balance, MAX_BALANCE);
  need(typeof code === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(code));
  need(exists || (nonce === 0n && balance === 0n && code === '0x'));
  need(typeof tracking?.written === 'boolean' && typeof tracking.indicatorCovered === 'boolean');
  need(ADDRESS.test(context?.authority) && ADDRESS.test(context.sender) && ADDRESS.test(context.to)); uint(context.value, MAX_BALANCE);
  const decision = authorizationStateDecision(tuple, { exists, nonce, code });
  if (decision.reason) return Object.freeze({ reason: decision.reason, executionGas: 0n, stateGas: 0n,
    nonceAfter: null, codeAfter: null, tracking: Object.freeze({ ...tracking }) });
  const indicatorCovered = tracking.indicatorCovered || DESIGNATION.test(code);
  const setIndicator = BigInt(tuple.address) !== 0n;
  const paidWrite = tracking.written || context.authority === context.sender || (context.authority === context.to && context.value > 0n);
  return Object.freeze({ reason: null, nonceAfter: decision.nonceAfter, codeAfter: decision.codeAfter,
    executionGas: paidWrite ? 0n : AMSTERDAM_AUTHORIZATION_COSTS.accountWrite,
    stateGas: (nonce === 0n && balance === 0n && code === '0x' ? AMSTERDAM_AUTHORIZATION_COSTS.newAccount : 0n)
      + (setIndicator && !indicatorCovered ? AMSTERDAM_AUTHORIZATION_COSTS.delegationIndicator : 0n),
    tracking: Object.freeze({ written: true, indicatorCovered: indicatorCovered || setIndicator }) });
}

/** Atomic combined charge: a failed operation leaves all counters untouched.
 * The reservoir pays state first; spill is part of regular-pool consumption,
 * not an additional charge to add again at final settlement. */
export function chargeAmsterdamAuthorizationGas(budget, cost) {
  for (const key of ['gasLimit', 'stateGasReservoir', 'executionStateGasUsed', 'stateGasSpilled']) uint(budget[key]);
  uint(cost.executionGas); uint(cost.stateGas);
  need(budget.gasLimit + budget.stateGasReservoir <= MAX_GAS && budget.stateGasSpilled <= budget.executionStateGasUsed);
  const spill = cost.stateGas > budget.stateGasReservoir ? cost.stateGas - budget.stateGasReservoir : 0n;
  if (cost.executionGas + spill > budget.gasLimit) return Object.freeze({ ...budget, outOfGas: true });
  const stateGasUsed = budget.executionStateGasUsed + cost.stateGas;
  const stateGasSpilled = budget.stateGasSpilled + spill;
  uint(stateGasUsed); uint(stateGasSpilled);
  return Object.freeze({ gasLimit: budget.gasLimit - cost.executionGas - spill,
    stateGasReservoir: budget.stateGasReservoir > cost.stateGas ? budget.stateGasReservoir - cost.stateGas : 0n,
    executionStateGasUsed: stateGasUsed, stateGasSpilled, outOfGas: false });
}

/** Counters AFTER the caller reverts the encompassing preparation checkpoint.
 * Authorization OOG and later recipient-access OOG share rollback arithmetic,
 * but the cause remains explicit. Never use this for an entered-frame fault:
 * that fault retains successful authorizations and their committed state gas.
 * Sender nonce/fee prepayment live outside that checkpoint. */
export function amsterdamPreparationHalt(initialBudget, phase) {
  uint(initialBudget.gasLimit); uint(initialBudget.stateGasReservoir);
  need(initialBudget.gasLimit + initialBudget.stateGasReservoir <= MAX_GAS && ['authorization', 'recipient'].includes(phase));
  return Object.freeze({ phase, retained: false, gasLimit: 0n, authorizationGasUsed: initialBudget.gasLimit,
    stateGasReservoir: initialBudget.stateGasReservoir, executionStateGasUsed: 0n, stateGasSpilled: 0n,
    gasRefundCounter: 0n, senderAuthorizationIncrements: 0n });
}

/** The caller MUST already have incremented sender nonce and opened a nested
 * preparation checkpoint. It commits only after recipient setup succeeds, or
 * reverts on any preparation OOG. Host exceptions propagate unchanged for whole
 * attempt rollback. This helper never owns or silently commits a checkpoint.
 *
 * accesses are ordered recovered-authority reads, including code/nonce skips;
 * replay them into always-warm/BAL address tracking before recipient setup.
 * writes and applied entries describe attempts until the caller commits prep.
 * Revert discards these changes, while BAL address reads remain observable.
 * An OOG tuple is distinct from a protocol-skipped tuple; later tuples are not
 * attempted. All returned counters are internal BigInts, not public JSON.
 */
export async function applyAmsterdamAuthorizations({ request, common, stateManager, gasLimit, stateGasReservoir, check = () => {} }) {
  const chainId = network(common), list = normalizeAuthorizationList(request);
  need(list !== undefined && ADDRESS.test(request.from) && ADDRESS.test(request.to));
  need(typeof request.value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(request.value));
  const value = BigInt(request.value); uint(value, MAX_BALANCE);
  uint(gasLimit); uint(stateGasReservoir); need(gasLimit + stateGasReservoir <= MAX_GAS);
  need(typeof check === 'function' && typeof stateManager?.applyAuthorization === 'function');
  let budget = { gasLimit, stateGasReservoir, executionStateGasUsed: 0n, stateGasSpilled: 0n };
  let senderAuthorizationIncrements = 0n, failedIndex = null;
  const entries = [], accesses = [], writes = [], tracking = new Map();
  for (let index = 0; index < list.length; index++) {
    check();
    const tuple = list[index], recovered = recoverAuthorization(tuple, chainId);
    check();
    if (recovered.reason) {
      entries.push(Object.freeze({ index, authority: null, status: 'skipped', reason: recovered.reason })); continue;
    }
    const authority = recovered.authority, address = createAddressFromString(authority);
    accesses.push(Object.freeze({ index, authority }));
    const account = await stateManager.getAccount(address); check();
    const code = bytesToHex(await stateManager.getCode(address)); check();
    const before = { exists: account !== undefined, nonce: account?.nonce ?? 0n, balance: account?.balance ?? 0n, code };
    const decision = amsterdamAuthorizationDecision(tuple, before,
      tracking.get(authority) ?? { written: false, indicatorCovered: false }, { authority, sender: request.from, to: request.to, value });
    if (decision.reason) {
      entries.push(Object.freeze({ index, authority, status: 'skipped', reason: decision.reason })); continue;
    }
    const charged = chargeAmsterdamAuthorizationGas(budget, decision);
    if (charged.outOfGas) {
      entries.push(Object.freeze({ index, authority, status: 'out_of_gas', reason: 'out_of_gas' }));
      failedIndex = index; break;
    }
    budget = charged;
    await stateManager.applyAuthorization(address, before.nonce, tuple.address); check();
    tracking.set(authority, decision.tracking);
    if (authority === request.from) senderAuthorizationIncrements++;
    writes.push(Object.freeze({ index, authority, nonceBefore: before.nonce, nonceAfter: decision.nonceAfter,
      codeBefore: before.code, codeAfter: decision.codeAfter }));
    entries.push(Object.freeze({ index, authority, status: 'applied', reason: null }));
  }
  check();
  return Object.freeze({ gasLimit: budget.gasLimit, authorizationGasUsed: gasLimit - budget.gasLimit,
    stateGasReservoir: budget.stateGasReservoir, executionStateGasUsed: budget.executionStateGasUsed,
    stateGasSpilled: budget.stateGasSpilled, gasRefundCounter: 0n, senderAuthorizationIncrements,
    outOfGas: failedIndex !== null, failedIndex, entries: Object.freeze(entries),
    accesses: Object.freeze(accesses), writes: Object.freeze(writes) });
}
