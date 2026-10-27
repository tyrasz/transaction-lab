import { executeUnsignedCall } from './execute.js';
import { ethereumCallGas, ethereumCommon, ethereumQuantity, ethereumUsedGas, profileError } from './ethereum-profile.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i;
const input = (condition, message) => { if (!condition) throw profileError('LOCAL_ETHEREUM_INPUT_INVALID', message); };

/** A chain-1 unsigned/unpriced call reference, not an original signed replay.
 * Input state and BLOCKHASH ancestry must be supplied independently. This
 * module never accepts a provider trace, poststate, or expected result. */
export async function executeEthereumCall({ request, header, stateManager, blockchain, limits, now } = {}) {
  let common, costs, totalGas, normalized, block, profile;
  try {
    input(request && Object.keys(request).sort().join() === 'data,from,gas,to,value', 'Only from/to/data/value/gas are accepted; signatures, access lists and authorization/blob fields are outside this profile.');
    input(ADDRESS.test(request.from) && ADDRESS.test(request.to), 'Explicit sender and recipient addresses are required.');
    common = ethereumCommon(header);
    input(header && WORD.test(header.hash) && WORD.test(header.parentHash) && WORD.test(header.stateRoot) && WORD.test(header.mixHash) && ADDRESS.test(header.miner), 'A source header with block hashes, state root, randomness and coinbase is required.');
    for (const field of ['number', 'timestamp', 'gasLimit']) input(ethereumQuantity(header[field]) < 1n << 64n, 'Header quantities exceed uint64.');
    input(ethereumQuantity(header.gasLimit) > 0n, 'A nonzero block gas limit is required.');
    const sourceBaseFee = ethereumQuantity(header.baseFeePerGas), value = ethereumQuantity(request.value);
    totalGas = ethereumQuantity(request.gas);
    costs = ethereumCallGas(request.data, common);
    input(totalGas >= costs.minimum && totalGas <= 5000000n, 'The bounded gas limit must cover both intrinsic gas and the fork calldata floor.');
    normalized = { from: request.from.toLowerCase(), to: request.to.toLowerCase(), data: request.data.toLowerCase(), value: value.toString(), gasLimit: (totalGas - costs.intrinsic).toString() };
    block = { ...Object.fromEntries(['number', 'timestamp', 'gasLimit', 'mixHash', 'miner', 'parentHash', 'hash'].map(k => [k, header[k]])), baseFeePerGas: '0' };
    profile = {
      name: 'ethereum_unsigned_unpriced_call', chainId: 1, hardfork: common.hardfork(),
      forkSchedule: 'pinned_ethereumjs_common_10.1.3_mainnet', sourceBlockHash: header.hash.toLowerCase(), sourceStateRoot: header.stateRoot.toLowerCase(),
      sourceBlockIdentityVerified: false, sourceStateProofVerified: false,
      actualBlockBaseFee: sourceBaseFee.toString(), executionBaseFee: '0', gasPrice: '0',
      declaredGasLimit: totalGas.toString(), intrinsicGas: costs.intrinsic.toString(), calldataFloor: costs.floor.toString(), messageGasLimit: normalized.gasLimit,
      calldataZeroBytes: costs.zeroBytes.toString(), calldataNonzeroBytes: costs.nonzeroBytes.toString(),
      outerSignatureVerified: false, feesSettled: false, originalTransactionPosition: false, expectedOutputsUsed: false,
    };
  } catch (error) {
    const known = ['LOCAL_ETHEREUM_INPUT_INVALID', 'LOCAL_ETHEREUM_FORK_UNSUPPORTED'].includes(error?.code);
    return { execution: { status: error?.code === 'LOCAL_ETHEREUM_FORK_UNSUPPORTED' ? 'unsupported' : 'invalid', error: { code: known ? error.code : 'LOCAL_ETHEREUM_INPUT_INVALID', message: known ? error.message : 'The Ethereum call input is incomplete or malformed.' }, executionGasUsed: null, returnData: null }, trace: null, logs: [], profile: null, stateDisposition: 'unchanged' };
  }
  const result = await executeUnsignedCall({ request: normalized, block, chainId: 1, stateManager, blockchain, limits, now });
  const complete = ['success', 'reverted', 'failed'].includes(result.execution.status);
  return {
    ...result, profile,
    gasAccounting: complete ? Object.fromEntries(Object.entries(ethereumUsedGas({ messageGasUsed: BigInt(result.execution.executionGasUsed), refundCounter: BigInt(result.execution.gasRefundCounter), intrinsic: costs.intrinsic, floor: costs.floor })).map(([k, v]) => [k, v.toString()])) : null,
    gasAccountingScope: 'Unsigned call gas including intrinsic, one-fifth refund cap and active calldata floor; no fee settlement or signed-transaction validity claim.',
  };
}
