// Parent-side fee derivation uses authenticated initial facts and the admitted
// envelope. Child fee amounts never supply the affordability or settlement math.
import { isDeepStrictEqual } from 'node:util';
import { ethereumFeePlan, settleEthereumFees } from './ethereum-fees.js';
import { ethereumCallGas, ethereumCommon, ethereumUsedGas, ethereumQuantity } from './ethereum-profile.js';

const need = value => { if (!value) throw new Error('Fee settlement does not match the verified transaction context.'); };
const hex = value => '0x' + value.toString(16);

export function deriveVerifiedFees({ request, header, inputs, output }) {
  const plan = ethereumFeePlan(request, header);
  const complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  if (!plan || !complete) { need(output?.feeAccounting === undefined); return null; }
  const sender = request.from.toLowerCase(), fact = inputs?.accounts?.[sender];
  need(fact && typeof fact.exists === 'boolean');
  const balance = fact.exists ? BigInt(fact.balance) : 0n;
  need(balance >= plan.maximumRequiredBalance);
  const costs = ethereumCallGas(request.data, ethereumCommon(header), request);
  const gas = ethereumUsedGas({ messageGasUsed: ethereumQuantity(output.execution.executionGasUsed),
    refundCounter: ethereumQuantity(output.execution.gasRefundCounter) + BigInt(output.authorizationProcessing?.gasRefundCounter ?? '0'),
    intrinsic: costs.intrinsic, floor: costs.floor });
  const accounting = settleEthereumFees(plan, { gasUsed: gas.gasUsed });
  need(isDeepStrictEqual(output.feeAccounting, accounting));
  need(inputs.accounts[plan.coinbase] && typeof inputs.accounts[plan.coinbase].exists === 'boolean');
  return { plan, accounting, sender };
}

/** Exact nonce/authorization preparation plus fee-only balance changes after a
 * reverted message. Lifecycle cleanup is added separately by its validator. */
export function revertedFeeRows({ baseRows, fees, inputs }) {
  if (!fees) return baseRows;
  const rows = new Map(baseRows.map(row => [row.address, structuredClone(row)]));
  const deltas = new Map([[fees.sender, -BigInt(fees.accounting.totalFeeCharge ?? fees.accounting.gasCharge)]]);
  const coinbase = fees.plan.coinbase;
  deltas.set(coinbase, (deltas.get(coinbase) ?? 0n) + BigInt(fees.accounting.coinbaseTip));
  for (const [address, delta] of deltas) {
    if (delta === 0n) continue;
    const fact = inputs.accounts[address], before = fact.exists ? BigInt(fact.balance) : 0n, after = before + delta;
    need(after >= 0n && after < (1n << 256n));
    const row = rows.get(address) ?? { address };
    row.balance = { before: hex(before), after: hex(after) };
    if (!fact.exists && !row.existence) row.existence = { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' };
    rows.set(address, row);
  }
  return [...rows.values()].sort((a, b) => a.address.localeCompare(b.address));
}
