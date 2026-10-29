import { normalizeEvmContext } from '../evm-context.js';
import { normalizeAuthorizationList } from './authorization-list.js';
import { normalizeEthereumFees } from './ethereum-fees.js';
import { ethereumBlobContext } from './ethereum-blob-fees.js';
import { ethereumNetworkCommon } from './ethereum-network.js';

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

/** Execution admission is deliberately separate from header/network support.
 * Only the reviewed mainnet fork set is currently admitted. A valid Sepolia
 * header or query identity cannot enable execution; the trusted caller must
 * pass chainId explicitly when it differs from the legacy mainnet default.
 * Header authenticity and finality remain the caller's responsibility. */
export function ethereumCommon(header, chainId = 1) {
  const unavailable = () => profileError('LOCAL_ETHEREUM_FORK_UNSUPPORTED', 'This execution reference supports the pinned Shanghai through BPO2 mainnet schedule.');
  let common;
  try { common = ethereumNetworkCommon(header, chainId); }
  catch (error) { if (error?.code === 'LOCAL_ETHEREUM_FORK_UNSUPPORTED') throw unavailable(); throw error; }
  if (chainId !== 1 || !SUPPORTED.has(common.hardfork())) throw unavailable();
  return common;
}

export function ethereumCallGas(data, common, request = {}) {
  const context = normalizeEvmContext(request), authorizationList = normalizeAuthorizationList(request);
  if (authorizationList && (!common.isActivatedEIP(7702) || request.to === null || context.blobVersionedHashes)) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Authorization lists require a Prague-or-later call without blob context.');
  if (typeof data !== 'string' || !BYTES.test(data) || data.length > 65538) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Expected bounded even-length calldata.');
  const creation = request.to === null;
  if (creation && context.blobVersionedHashes) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Unsigned creation does not accept blob transaction context.');
  // EIP-2780 replaces the flat transaction base with state-independent
  // components. Runtime account/delegation charges belong to execution, not
  // this admission calculation. Public execution remains fork-gated above.
  const decomposed = common.isActivatedEIP(2780);
  let recipientIntrinsic = 0n, valueIntrinsic = 0n;
  if (decomposed) {
    if (typeof request.from !== 'string' || !/^0x[0-9a-f]{40}$/i.test(request.from)
      || (!creation && (typeof request.to !== 'string' || !/^0x[0-9a-f]{40}$/i.test(request.to)))) {
      throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Amsterdam intrinsic gas requires an explicit sender and destination.');
    }
    const value = ethereumQuantity(request.value);
    const self = !creation && request.from.toLowerCase() === request.to.toLowerCase();
    recipientIntrinsic = !creation && !self ? 3000n : 0n;
    valueIntrinsic = !creation && !self && value > 0n ? 6000n : 0n;
  }
  let zeroBytes = 0n, nonzeroBytes = 0n;
  for (let i = 2; i < data.length; i += 2) data.slice(i, i + 2) === '00' ? zeroBytes++ : nonzeroBytes++;
  const tokens = zeroBytes + nonzeroBytes * 4n;
  const addressCount = BigInt(context.accessList?.length ?? 0), storageKeyCount = BigInt(context.accessList?.reduce((n, row) => n + row.storageKeys.length, 0) ?? 0);
  // EIP-8038's access-minus-warm charges and EIP-7981's data surcharge
  // are distinct: the latter also enters the calldata floor.
  const accessListAccessGas = common.isActivatedEIP(8038)
    ? 2900n * addressCount + 2000n * storageKeyCount
    : 2400n * addressCount + 1900n * storageKeyCount;
  const accessListDataGas = common.isActivatedEIP(7981) ? 64n * (20n * addressCount + 32n * storageKeyCount) : 0n;
  const accessListGas = accessListAccessGas + accessListDataGas;
  // The declared root envelope pays these charges once. Internal CREATE and
  // CREATE2 pay their own opcode/initcode charges inside the EVM instead.
  const creationCosts = creation ? { creationIntrinsic: decomposed ? 12000n : 32000n, initcodeBytes: zeroBytes + nonzeroBytes,
    initcodeWordGas: common.isActivatedEIP(3860) ? 2n * ((zeroBytes + nonzeroBytes + 31n) / 32n) : 0n } : {};
  const authorizationCosts = authorizationList ? { authorizationCount: BigInt(authorizationList.length), authorizationIntrinsic: (common.isActivatedEIP(8037) ? 7816n : 25000n) * BigInt(authorizationList.length) } : {};
  const base = decomposed ? 12000n : 21000n;
  const shape = base + recipientIntrinsic + valueIntrinsic;
  const intrinsic = shape + tokens * 4n + accessListGas + (creationCosts.creationIntrinsic ?? 0n) + (creationCosts.initcodeWordGas ?? 0n) + (authorizationCosts.authorizationIntrinsic ?? 0n);
  const floor = common.isActivatedEIP(7623)
    ? shape + (decomposed ? creationCosts.creationIntrinsic ?? 0n : 0n)
      + (common.isActivatedEIP(7976) ? 64n * (zeroBytes + nonzeroBytes) : tokens * 10n) + accessListDataGas : 0n;
  return { intrinsic, floor, minimum: intrinsic > floor ? intrinsic : floor, zeroBytes, nonzeroBytes, ...creationCosts, ...authorizationCosts,
    ...(decomposed ? { intrinsicBase: base, recipientIntrinsic, valueIntrinsic, accessListAccessGas, accessListDataGas } : {}) };
}

export function ethereumUsedGas({ messageGasUsed, refundCounter, intrinsic, floor }) {
  const beforeRefund = intrinsic + messageGasUsed;
  const appliedRefund = refundCounter < beforeRefund / 5n ? refundCounter : beforeRefund / 5n;
  const afterRefund = beforeRefund - appliedRefund;
  return { beforeRefund, appliedRefund, floorAdjustment: floor > afterRefund ? floor - afterRefund : 0n, gasUsed: floor > afterRefund ? floor : afterRefund };
}

/** Optional context metadata is conditional so the unpriced response identity
 * stays unchanged. Priced block context does not establish KZG/sidecar validity. */
export function ethereumContextProfile(request, header, common = ethereumCommon(header)) {
  const context = normalizeEvmContext(request), authorizationList = normalizeAuthorizationList(request), profile = { ...context, ...normalizeEthereumFees(request) };
  if (authorizationList) {
    const costs = ethereumCallGas(request.data, common, request);
    Object.assign(profile, { authorizationList, authorizationCount: costs.authorizationCount.toString(), authorizationIntrinsicGas: costs.authorizationIntrinsic.toString() });
  }
  if (request.to === null) {
    const costs = ethereumCallGas(request.data, common, request);
    Object.assign(profile, { operation: 'create', initcodeBytes: costs.initcodeBytes.toString(),
      creationIntrinsicGas: costs.creationIntrinsic.toString(), initcodeWordGas: costs.initcodeWordGas.toString() });
  }
  if (context.accessList) {
    const addresses = BigInt(context.accessList.length), slots = BigInt(context.accessList.reduce((n, item) => n + item.storageKeys.length, 0));
    const costs = common.isActivatedEIP(2780) ? ethereumCallGas(request.data, common, request) : null;
    Object.assign(profile, { accessListAddressCount: addresses.toString(), accessListStorageKeyCount: slots.toString(),
      accessListIntrinsicGas: (costs ? costs.accessListAccessGas + costs.accessListDataGas : addresses * 2400n + slots * 1900n).toString(),
      ...(costs ? { accessListDataGas: costs.accessListDataGas.toString() } : {}) });
  }
  if (context.blobVersionedHashes) {
    if (!common.isActivatedEIP(4844)) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Declared blob context requires Cancun or later.');
    const excess = ethereumQuantity(header.excessBlobGas);
    if (excess >= 1n << 64n) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', 'Source excess blob gas exceeds uint64.');
    Object.assign(profile, { executionBlobBaseFee: '0', sourceExcessBlobGas: excess.toString() });
  }
  if (profile.executionProfile) {
    const blobContext = ethereumBlobContext(header);
    if (blobContext) Object.assign(profile, { executionBlobBaseFee: blobContext.blobBaseFeePerGas.toString(), sourceExcessBlobGas: blobContext.excessBlobGas.toString() });
  }
  return profile;
}
