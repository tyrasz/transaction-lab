import { Common, Mainnet } from '@ethereumjs/common';

const SUPPORTED = new Set(['shanghai', 'cancun', 'prague', 'osaka', 'bpo1', 'bpo2']);
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const MAX = (1n << 256n) - 1n;
export function profileError(code, message) { return Object.assign(new Error(message), { code }); }
export function ethereumQuantity(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/i.test(value)) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Expected a canonical unsigned quantity string.');
  const n = BigInt(value);
  if (n > MAX) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Input quantity exceeds uint256.');
  return n;
}

/** Fork rules are the explicitly pinned EthereumJS mainnet schedule. Header
 * authenticity and finality must be established by the caller, not this helper. */
export function ethereumCommon(header) {
  const common = new Common({ chain: Mainnet });
  const hardfork = common.setHardforkBy({ blockNumber: ethereumQuantity(header?.number), timestamp: ethereumQuantity(header?.timestamp) });
  if (!SUPPORTED.has(hardfork)) throw profileError('LOCAL_ETHEREUM_FORK_UNSUPPORTED', 'This execution reference supports the pinned Shanghai through BPO2 mainnet schedule.');
  return common;
}

export function ethereumCallGas(data, common) {
  if (typeof data !== 'string' || !BYTES.test(data) || data.length > 65538) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Expected bounded even-length calldata.');
  let zeroBytes = 0n, nonzeroBytes = 0n;
  for (let i = 2; i < data.length; i += 2) data.slice(i, i + 2) === '00' ? zeroBytes++ : nonzeroBytes++;
  const tokens = zeroBytes + nonzeroBytes * 4n;
  const intrinsic = 21000n + tokens * 4n;
  const floor = common.isActivatedEIP(7623) ? 21000n + tokens * 10n : 0n;
  return { intrinsic, floor, minimum: intrinsic > floor ? intrinsic : floor, zeroBytes, nonzeroBytes };
}

export function ethereumUsedGas({ messageGasUsed, refundCounter, intrinsic, floor }) {
  const beforeRefund = intrinsic + messageGasUsed;
  const appliedRefund = refundCounter < beforeRefund / 5n ? refundCounter : beforeRefund / 5n;
  const afterRefund = beforeRefund - appliedRefund;
  return { beforeRefund, appliedRefund, floorAdjustment: floor > afterRefund ? floor - afterRefund : 0n, gasUsed: floor > afterRefund ? floor : afterRefund };
}
