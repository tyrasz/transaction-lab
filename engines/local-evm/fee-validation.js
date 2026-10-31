// Parent-side fee derivation uses authenticated initial facts and the admitted
// envelope. Child fee amounts never supply the affordability or settlement math.
import { isDeepStrictEqual } from 'node:util';
import { ethereumFeePlan, settleEthereumFees } from './ethereum-fees.js';
import { deriveVerifiedGas } from './gas-validation.js';
import { createExecutionState, updateExecutionAccounts } from './execution-state.js';

const need = value => { if (!value) throw new Error('Fee settlement does not match the verified transaction context.'); };
const hex = value => '0x' + value.toString(16);

export function deriveVerifiedFees({ request, header, inputs, output, chainId = 1, startingChanges }) {
  const plan = ethereumFeePlan(request, header, chainId);
  const complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  if (!plan || !complete) { need(output?.feeAccounting === undefined); return null; }
  const sender = request.from.toLowerCase(), fact = createExecutionState(inputs, startingChanges).account(sender);
  need(fact && typeof fact.exists === 'boolean');
  const balance = fact.exists ? BigInt(fact.balance) : 0n;
  need(balance >= plan.maximumRequiredBalance);
  const gas = deriveVerifiedGas({ request, header, inputs, output, chainId, startingChanges });
  const accounting = settleEthereumFees(plan, { gasUsed: gas.gasUsed });
  need(isDeepStrictEqual(output.feeAccounting, accounting));
  need(inputs.accounts[plan.coinbase] && typeof inputs.accounts[plan.coinbase].exists === 'boolean');
  return { plan, accounting, sender };
}

/** Exact nonce/authorization preparation plus fee-only balance changes after a
 * reverted message. Lifecycle cleanup is added separately by its validator. */
export function revertedFeeRows({ baseRows, fees, inputs, startingChanges }) {
  if (!fees) return baseRows;
  const state = createExecutionState(inputs, startingChanges), updates = [];
  const deltas = new Map([[fees.sender, -BigInt(fees.accounting.totalFeeCharge ?? fees.accounting.gasCharge)]]);
  const coinbase = fees.plan.coinbase;
  deltas.set(coinbase, (deltas.get(coinbase) ?? 0n) + BigInt(fees.accounting.coinbaseTip));
  for (const [address, delta] of deltas) {
    if (delta === 0n) continue;
    const fact = state.account(address), after = BigInt(fact.balance) + delta;
    need(after >= 0n && after < (1n << 256n));
    updates.push([address, { exists: true, balance: after }]);
  }
  return updateExecutionAccounts(inputs, { scope: state.changes.scope, accounts: baseRows }, updates).accounts;
}
