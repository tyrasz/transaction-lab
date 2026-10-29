import { types } from 'node:util';
import { normalizeEvmContext } from '../evm-context.js';
import { ethereumBlobContext } from './ethereum-blob-fees.js';

export const ETHEREUM_FEE_PROFILE = 'unsigned_eip1559_block_end';
export const ETHEREUM_BLOB_FEE_PROFILE = 'unsigned_eip4844_block_end';
const MAX = (1n << 256n) - 1n;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const QUANTITY = /^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/i;
function need(ok) {
  if (!ok) throw Object.assign(new Error('The explicit EIP-1559 fee profile is malformed or inconsistent.'), { code: 'LOCAL_ETHEREUM_INPUT_INVALID' });
}
function plain(value) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function own(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  need(d?.enumerable && Object.hasOwn(d, 'value')); return d.value;
}
function quantity(value, decimal = false) {
  need(typeof value === 'string' && value.length <= 80 && (decimal ? DECIMAL : QUANTITY).test(value));
  const n = BigInt(value); need(n <= MAX); return n;
}
function bounded(n) { need(n >= 0n && n <= MAX); return n; }

/** Explicit opt-in only. This is unsigned pricing, not outer signature,
 * transaction-position, sidecar or inclusion validation. Default adds no fields. */
export function normalizeEthereumFees(request) {
  plain(request);
  const profile = Object.getOwnPropertyDescriptor(request, 'executionProfile'), fees = Object.getOwnPropertyDescriptor(request, 'fees');
  if (profile === undefined && fees === undefined) return {};
  const executionProfile = own(request, 'executionProfile'), blob = executionProfile === ETHEREUM_BLOB_FEE_PROFILE;
  need(blob || executionProfile === ETHEREUM_FEE_PROFILE);
  const input = own(request, 'fees'); plain(input);
  need(Reflect.ownKeys(input).length === (blob ? 3 : 2));
  const maxFeePerGas = own(input, 'maxFeePerGas'), maxPriorityFeePerGas = own(input, 'maxPriorityFeePerGas');
  const cap = quantity(maxFeePerGas, true), priority = quantity(maxPriorityFeePerGas, true);
  need(priority <= cap);
  let extra = {};
  if (blob) {
    const maxFeePerBlobGas = own(input, 'maxFeePerBlobGas'); quantity(maxFeePerBlobGas, true);
    const to = own(request, 'to'); need(typeof to === 'string' && /^0x[0-9a-f]{40}$/i.test(to) && !Object.hasOwn(request, 'authorizationList'));
    let hashes; try { hashes = normalizeEvmContext({ blobVersionedHashes: own(request, 'blobVersionedHashes') }).blobVersionedHashes; } catch { need(false); }
    // Prague's nine is the largest admitted count; the selected fork can
    // tighten this before state reads. Do not inherit the unpriced32-hash cap.
    need(hashes.length <= 9); extra = { maxFeePerBlobGas };
  } else need(!Object.hasOwn(request, 'blobVersionedHashes'));
  return Object.freeze({ executionProfile, fees: Object.freeze({ maxFeePerGas, maxPriorityFeePerGas, ...extra }) });
}

/** Derive admission and prepayment from a total-gas envelope and header. No
 * state or claimed execution outcome enters this calculation. */
export function ethereumFeePlan(request, header, chainId = 1) {
  if (chainId !== 1 && chainId !== 11155111) throw Object.assign(new Error('Fee planning requires a trusted mainnet or Sepolia chain selector.'), { code: 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED' });
  const normalized = normalizeEthereumFees(request);
  if (!normalized.executionProfile) return null;
  plain(header);
  const gasLimit = quantity(own(request, 'gas')), value = quantity(own(request, 'value'));
  const baseFeePerGas = quantity(own(header, 'baseFeePerGas')), blockGasLimit = quantity(own(header, 'gasLimit'));
  const coinbase = own(header, 'miner'); need(typeof coinbase === 'string' && /^0x[0-9a-f]{40}$/i.test(coinbase));
  const maxFeePerGas = BigInt(normalized.fees.maxFeePerGas), maxPriorityFeePerGas = BigInt(normalized.fees.maxPriorityFeePerGas);
  const blobContext = ethereumBlobContext(header, chainId), blob = normalized.executionProfile === ETHEREUM_BLOB_FEE_PROFILE;
  // This is only the envelope's preliminary base bound. The call layer must
  // independently enforce max(intrinsic, calldata floor) for the exact request;
  // Amsterdam's recipient/value/data/access/auth charges can raise it further.
  const minimumBaseGas = blobContext?.hardfork === 'amsterdam' ? 12000n : 21000n;
  need(maxFeePerGas >= baseFeePerGas && gasLimit >= minimumBaseGas && gasLimit <= 5000000n && gasLimit <= blockGasLimit);
  // Avoid an overflowing base+tip intermediate: cap-base bounds the tip first.
  const priorityFeePerGas = maxPriorityFeePerGas < maxFeePerGas - baseFeePerGas ? maxPriorityFeePerGas : maxFeePerGas - baseFeePerGas;
  const effectiveGasPrice = baseFeePerGas + priorityFeePerGas;
  let extra = {}, maximumRequiredBalance = bounded(gasLimit * maxFeePerGas + value);
  const upfrontGasDebit = bounded(gasLimit * effectiveGasPrice);
  if (blob) {
    need(blobContext !== null);
    const blobCount = BigInt(own(request, 'blobVersionedHashes').length), maxFeePerBlobGas = BigInt(normalized.fees.maxFeePerBlobGas);
    need(blobCount <= blobContext.maxBlobsPerTransaction && maxFeePerBlobGas >= blobContext.blobBaseFeePerGas);
    const blobGasUsed = blobCount * blobContext.gasPerBlob, blobFeeBurn = bounded(blobGasUsed * blobContext.blobBaseFeePerGas);
    maximumRequiredBalance = bounded(maximumRequiredBalance + blobGasUsed * maxFeePerBlobGas);
    extra = { blobCount, maxFeePerBlobGas, blobGasUsed, blobBaseFeePerGas: blobContext.blobBaseFeePerGas, blobFeeBurn,
      totalUpfrontDebit: bounded(upfrontGasDebit + blobFeeBurn) };
  }
  return Object.freeze({ gasLimit, maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, effectiveGasPrice, priorityFeePerGas,
    maximumRequiredBalance, upfrontGasDebit, coinbase: coinbase.toLowerCase(), ...(blobContext ? { blobContext } : {}), ...extra });
}

/** gasUsed is the final charged gas AFTER the refund cap and calldata floor.
 * Coinbase credit may subsequently burn during account deletion; this record
 * describes settlement operations, not a guaranteed surviving balance delta. */
export function settleEthereumFees(plan, { gasUsed }) {
  plain(plan); need(typeof gasUsed === 'bigint' && gasUsed >= 0n && gasUsed <= plan.gasLimit);
  const gasCharge = bounded(gasUsed * plan.effectiveGasPrice), senderRefund = bounded(plan.upfrontGasDebit - gasCharge);
  const baseFeeBurn = bounded(gasUsed * plan.baseFeePerGas), coinbaseTip = bounded(gasUsed * plan.priorityFeePerGas);
  need(gasCharge === baseFeeBurn + coinbaseTip);
  const blob = Object.hasOwn(plan, 'blobGasUsed'), extra = blob ? { blobCount: plan.blobCount, blobGasUsed: plan.blobGasUsed,
    maxFeePerBlobGas: plan.maxFeePerBlobGas, blobBaseFeePerGas: plan.blobBaseFeePerGas, blobFeeBurn: plan.blobFeeBurn,
    totalUpfrontDebit: plan.totalUpfrontDebit, totalFeeCharge: bounded(gasCharge + plan.blobFeeBurn), totalFeeBurn: bounded(baseFeeBurn + plan.blobFeeBurn) } : {};
  return Object.freeze({ kind: blob ? 'eip4844' : 'eip1559', ...Object.fromEntries(Object.entries({ gasLimit: plan.gasLimit, effectiveGasPrice: plan.effectiveGasPrice,
    baseFeePerGas: plan.baseFeePerGas, priorityFeePerGas: plan.priorityFeePerGas, maximumRequiredBalance: plan.maximumRequiredBalance,
    upfrontGasDebit: plan.upfrontGasDebit, chargedGas: gasUsed, gasCharge, senderRefund, baseFeeBurn, coinbaseTip, ...extra }).map(([key, value]) => [key, value.toString()])), coinbase: plan.coinbase });
}
