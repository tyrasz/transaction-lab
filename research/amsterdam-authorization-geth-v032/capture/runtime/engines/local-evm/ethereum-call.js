import { executeUnsignedCall } from './execute.js';
import { ethereumCallGas, ethereumCommon, ethereumQuantity, ethereumUsedGas, ethereumContextProfile, profileError } from './ethereum-profile.js';

import { normalizeEvmContext } from '../evm-context.js';
import { normalizeAuthorizationList } from './authorization-list.js';
import { normalizeEthereumFees, ethereumFeePlan, ETHEREUM_BLOB_FEE_PROFILE } from './ethereum-fees.js';
import { ETHEREUM_NETWORK_SCHEDULES } from './ethereum-network.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i;
const input = (condition, message) => { if (!condition) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', message); };

/** A trusted-network unsigned call reference with optional explicit EIP-1559 pricing,
 * not an original signed replay.
 * Input state and BLOCKHASH ancestry must be supplied independently. This
 * module never accepts a provider trace, poststate, or expected result. */
export async function executeEthereumCall({ request, header, stateManager, blockchain, limits, now, chainId = 1 } = {}) {
  let common, costs, totalGas, normalized, block, profile, feePlan;
  try {
    const evmContext = normalizeEvmContext(request), authorizationList = normalizeAuthorizationList(request);
    const context = { ...evmContext, ...(authorizationList ? { authorizationList } : {}), ...normalizeEthereumFees(request) };
    input(['data', 'from', 'gas', 'to', 'value'].every(key => Object.hasOwn(request, key)) && Object.keys(request).every(key => ['data', 'from', 'gas', 'to', 'value', 'accessList', 'blobVersionedHashes', 'authorizationList', 'executionProfile', 'fees'].includes(key)), 'Only the unsigned envelope and declared local transaction context are accepted.');
    input(typeof request.from === 'string' && ADDRESS.test(request.from) && (request.to === null || (typeof request.to === 'string' && ADDRESS.test(request.to))), 'An explicit sender and recipient address or null creation destination are required.');
    common = ethereumCommon(header, chainId);
    input(header && WORD.test(header.hash) && WORD.test(header.parentHash) && WORD.test(header.stateRoot) && WORD.test(header.mixHash) && ADDRESS.test(header.miner), 'A source header with block hashes, state root, randomness and coinbase is required.');
    for (const field of ['number', 'timestamp', 'gasLimit']) input(ethereumQuantity(header[field]) < 1n << 64n, 'Header quantities exceed uint64.');
    input(ethereumQuantity(header.gasLimit) > 0n, 'A nonzero block gas limit is required.');
    const sourceBaseFee = ethereumQuantity(header.baseFeePerGas), value = ethereumQuantity(request.value);
    totalGas = ethereumQuantity(request.gas);
    if (common.isActivatedEIP(7843)) input(ethereumQuantity(header.slotNumber) < 1n << 64n, 'Amsterdam slot number must be uint64.');
    const contextProfile = ethereumContextProfile(request, header, common);
    costs = ethereumCallGas(request.data, common, request);
    input(totalGas >= costs.minimum && totalGas <= 5000000n, 'The bounded gas limit must cover both intrinsic gas and the fork calldata floor.');
    feePlan = ethereumFeePlan(request, header, chainId);
    normalized = { from: request.from.toLowerCase(), to: request.to === null ? null : request.to.toLowerCase(), data: request.data.toLowerCase(), value: value.toString(), gasLimit: (totalGas - costs.intrinsic).toString(), ...context };
    block = { ...(common.isActivatedEIP(7843) ? { slotNumber: header.slotNumber } : {}), ...Object.fromEntries(['number', 'timestamp', 'gasLimit', 'mixHash', 'miner', 'parentHash', 'hash'].map(k => [k, header[k]])), baseFeePerGas: feePlan ? sourceBaseFee.toString() : '0', ...(context.blobVersionedHashes ? { excessBlobGas: header.excessBlobGas } : {}), ...(feePlan?.blobContext ? { excessBlobGas: header.excessBlobGas, blobGasUsed: header.blobGasUsed } : {}) };
    profile = {
      name: context.executionProfile === ETHEREUM_BLOB_FEE_PROFILE ? 'ethereum_unsigned_eip4844_call' : feePlan ? 'ethereum_unsigned_eip1559_call' : 'ethereum_unsigned_unpriced_call', chainId, hardfork: common.hardfork(),
      forkSchedule: ETHEREUM_NETWORK_SCHEDULES[chainId], sourceBlockHash: header.hash.toLowerCase(), sourceStateRoot: header.stateRoot.toLowerCase(),
      sourceBlockIdentityVerified: false, sourceStateProofVerified: false,
      actualBlockBaseFee: sourceBaseFee.toString(), executionBaseFee: feePlan ? sourceBaseFee.toString() : '0', gasPrice: feePlan ? feePlan.effectiveGasPrice.toString() : '0',
      declaredGasLimit: totalGas.toString(), intrinsicGas: costs.intrinsic.toString(), calldataFloor: costs.floor.toString(), messageGasLimit: normalized.gasLimit,
      calldataZeroBytes: costs.zeroBytes.toString(), calldataNonzeroBytes: costs.nonzeroBytes.toString(),
      outerSignatureVerified: false, feesSettled: false, originalTransactionPosition: false, expectedOutputsUsed: false,
      ...contextProfile,
    };
  } catch (error) {
    const unsupported = ['LOCAL_ETHEREUM_CHAIN_UNSUPPORTED', 'LOCAL_ETHEREUM_FORK_UNSUPPORTED', 'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT'].includes(error?.code);
    const known = unsupported || error?.code === 'LOCAL_ETHEREUM_INPUT_INVALID';
    return { execution: { status: unsupported ? 'unsupported' : 'invalid', error: { code: known ? error.code : 'LOCAL_ETHEREUM_INPUT_INVALID', message: known ? error.message : 'The Ethereum call input is incomplete or malformed.' }, executionGasUsed: null, returnData: null }, trace: null, logs: [], profile: null, stateDisposition: 'unchanged' };
  }
  const result = await executeUnsignedCall({ request: normalized, block, chainId, stateManager, blockchain, limits, now });
  const complete = ['success', 'reverted', 'failed'].includes(result.execution.status);
  return {
    ...result, profile: feePlan ? { ...profile, feesSettled: complete } : profile,
    gasAccounting: complete ? result.stateGasAccounting?.settled ?? Object.fromEntries(Object.entries(ethereumUsedGas({ messageGasUsed: BigInt(result.execution.executionGasUsed), refundCounter: BigInt(result.execution.gasRefundCounter) + (normalized.authorizationList ? BigInt(result.authorizationProcessing.gasRefundCounter) : 0n), intrinsic: costs.intrinsic, floor: costs.floor })).map(([k, v]) => [k, v.toString()])) : null,
    gasAccountingScope: normalized.executionProfile === ETHEREUM_BLOB_FEE_PROFILE ? 'Unsigned EIP-4844 execution gas including intrinsic, one-fifth refund cap and active calldata floor; execution and blob fees settled only on completed execution, without outer signature, sidecar or inclusion validation.' : feePlan ? 'Unsigned EIP-1559 gas including intrinsic, one-fifth refund cap and active calldata floor; fees settled only on completed execution, without an outer signed-transaction validity claim.' : 'Unsigned call gas including intrinsic, one-fifth refund cap and active calldata floor; no fee settlement or signed-transaction validity claim.',
  };
}
