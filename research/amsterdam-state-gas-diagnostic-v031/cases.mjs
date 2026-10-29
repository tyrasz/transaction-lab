// Two fixed synthetic inputs. This file never spawns Geth or performs RPC.
// EthereumJS results are an observed pinned implementation, not an expected
// canonical answer. The future runner must persist them before any Geth call.
import assert from 'node:assert/strict';
import { Common, Sepolia, Hardfork } from '../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../engines/fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx, createTxFromRLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { getCalldataFloorGas } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import { createVM, runTx } from '../../engines/fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { bytesToHex, hexToBytes, privateToAddress } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { ethereumStateGasBudget, settleEthereumStateGas } from '../../engines/local-evm/ethereum-state-gas.js';

export const IDS = Object.freeze(['stop_baseline', 'post_target_call_oog']);
// Geth's Amsterdam t8n PostExecution requires these request contracts to have
// code. This preparation amendment supplies identical inert synthetic rows to
// both paths; it is not deployed-chain state. The original fixture is retained.
export const SYSTEM_SCAFFOLDING = Object.freeze([
  '0x00000961ef480eb55e80d19ad83579a64c007002',
  '0x0000bbddc7ce488642fb579f8b00f3a590007251',
  '0x0000bff46984e3725691fa540a8c7589300d8282',
  '0x000064d678505ad48f8ccb093bc65613800e8282',
]);
const KEY = hexToBytes('0x' + '01'.repeat(32));
const SENDER = bytesToHex(privateToAddress(KEY)), TARGET = '0x' + '22'.repeat(20), CHILD = '0x' + '33'.repeat(20);
const DELEGATED = '0x' + '44'.repeat(20), IMPLEMENTATION = '0x' + '55'.repeat(20), COINBASE = '0x' + '99'.repeat(20);
const ZERO32 = '0x' + '00'.repeat(32);
const common = () => new Common({ chain: Sepolia, hardfork: Hardfork.Amsterdam });
const q = n => '0x' + BigInt(n).toString(16);
const stringify = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const row = (code = '0x', balance = 0n) => ({ nonce: '0x1', balance: q(balance), code, storage: {} });
const call = (address, gas) => '6000600060006000600073' + address.slice(2) + '63' + gas.toString(16).padStart(8, '0') + 'f150';
const third = '6000600060006000600073' + CHILD.slice(2) + '6111945a03f150';
const exceptionalCode = '0x' + call(CHILD, 16000000) + call(CHILD, 600000) + third + call(DELEGATED, 0) + '00';

function fixed(index) {
  assert(Number.isSafeInteger(index) && index >= 0 && index < IDS.length);
  const originalAllocation = { [SENDER]: row('0x', 10n ** 20n), [TARGET]: row(index === 0 ? '0x00' : exceptionalCode),
    ...(index === 0 ? {} : { [CHILD]: row('0xfe'), [DELEGATED]: row('0xef0100' + IMPLEMENTATION.slice(2)), [IMPLEMENTATION]: row('0x00') }) };
  const allocation = { ...originalAllocation, ...Object.fromEntries(SYSTEM_SCAFFOLDING.map(address => [address, row('0x00')])) };
  const environment = { currentCoinbase: COINBASE, currentGasLimit: q(60000000n), currentNumber: q(12018196n),
    currentTimestamp: q(1793261160n), currentRandom: ZERO32, currentDifficulty: '0x0', currentBaseFee: '0x7',
    withdrawals: [], parentExcessBlobGas: '0x0', parentBlobGasUsed: '0x0', parentBeaconBlockRoot: ZERO32 };
  return { index, id: IDS[index], originalAllocation, allocation, environment,
    amendment: { kind: 'pre_execution_inert_system_scaffolding', addresses: [...SYSTEM_SCAFFOLDING],
      originalCasesSha256: 'c614027edfd8915b8c7c8e0275bf2ad19fa0a173a1651d4794850aca330f6d45',
      userTransactionChanged: false, originalAccountRowsChanged: false, appliedIdenticallyToBothClients: true,
      gethSystemProcessingPresent: true, actualDeployedSystemContractsClaimed: false } };
}

/** Input construction only: signing and MPT/header hashing, no transaction run. */
export async function declaration(index) {
  const input = fixed(index), c = common(), state = await loadState(input.allocation, c);
  const originalState = await loadState(input.originalAllocation, c);
  const block = createBlock({ header: { number: 12018196n, timestamp: 1793261160n, gasLimit: 60000000n,
    baseFeePerGas: 7n, coinbase: COINBASE, stateRoot: await state.getStateRoot() }, withdrawals: [] }, { common: c });
  const tx = createTx({ type: 2, chainId: 11155111n, nonce: 1n, gasLimit: 20000000n, to: TARGET,
    value: 0n, data: '0x', maxFeePerGas: 13n, maxPriorityFeePerGas: 3n }, { common: c }).sign(KEY);
  const signedBytes = bytesToHex(tx.serialize()), decoded = createTxFromRLP(hexToBytes(signedBytes), { common: c });
  assert(decoded.verifySignature()); assert.equal(decoded.getSenderAddress().toString(), SENDER);
  assert.equal(decoded.chainId, 11155111n);
  return { ...input, chainId: 11155111, fork: 'Amsterdam', sender: SENDER,
    transaction: stringify(tx.toJSON()), signedBytes, transactionHash: bytesToHex(tx.hash()),
    transactionBody: bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
    header: stringify(block.header.toJSON()), headerHash: bytesToHex(block.hash()), initialStateRoot: bytesToHex(await state.getStateRoot()),
    originalStateRoot: bytesToHex(await originalState.getStateRoot()),
    scope: { syntheticKnownDevelopmentCases: true, signedType2: true, publicRpc: false, publicApiEnabled: false,
      originalTransactionReplay: false, populationAccuracy: false, stateGasHelperStandalone: true,
      exceptionalCanonicalValidityEstablished: false, finalNegativeStateGasReachabilityEstablished: false } };
}

/** Pinned full-VM observation. Input must match the fixed declaration exactly;
 * neither Geth output nor expected post-state is accepted as an argument. */
export async function ethereumjsObservation(input) {
  assert.deepEqual(input, await declaration(input.index));
  const c = common(), state = await loadState(input.allocation, c), h = input.header;
  const block = createBlock({ header: h, withdrawals: [] }, { common: c });
  assert.equal(bytesToHex(block.hash()), input.headerHash); assert.equal(bytesToHex(await state.getStateRoot()), input.initialStateRoot);
  const tx = createTxFromRLP(hexToBytes(input.signedBytes), { common: c });
  assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(), input.sender);
  const vm = await createVM({ common: c, stateManager: state, blockchain: {
    async getBlock() { throw Error('Synthetic diagnostic supplies no ancestry'); }, shallowCopy() { return this; },
  } });
  const budget = ethereumStateGasBudget({ gasLimit: tx.gasLimit, intrinsicRegular: tx.getIntrinsicGas(), floor: getCalldataFloorGas(tx) }, c);
  const call = vm.evm.runCall.bind(vm.evm); let entry, rootExit;
  vm.evm.runCall = async options => {
    const root = options.message === undefined;
    if (root) { assert.equal(entry, undefined); entry = { gasLimit: options.gasLimit, reservoir: vm.evm.stateGasReservoir, stateGasUsed: vm.evm.executionStateGasUsed }; }
    const result = await call(options);
    if (root) rootExit = { error: result.execResult.exceptionError?.error ?? null, reservoir: vm.evm.stateGasReservoir,
      stateGasUsed: vm.evm.executionStateGasUsed, postTargetLatch: vm.evm.eip7928CallPostTargetOog };
    return result;
  };
  const result = await runTx(vm, { tx, block });
  assert(entry && rootExit);
  const counters = { messageGasUsed: result.execResult.executionGasUsed, authorizationGasUsed: budget.messageGasLimit - entry.gasLimit,
    stateGasReservoir: vm.evm.stateGasReservoir, executionStateGasUsed: vm.evm.executionStateGasUsed,
    messageRefundCounter: result.execResult.gasRefund ?? 0n, authorizationRefundCounter: 0n,
    postTargetOutOfGas: rootExit.error === 'out of gas' && rootExit.postTargetLatch === true };
  const settled = settleEthereumStateGas(budget, counters);
  assert.equal(settled.gasUsed, result.totalGasSpent); assert.equal(settled.regularGasUsed, result.txRegularGas);
  assert.equal(settled.stateGasUsed, result.txStateGas); assert.equal(settled.blockGasUsed, result.blockGasSpent);
  const logs = result.execResult.logs ?? [];
  return stringify({ id: input.id, transactionHash: input.transactionHash, initialStateRoot: input.initialStateRoot,
    budget, entry, rootExit, counters, settled, stateRoot: bytesToHex(await state.getStateRoot()),
    execution: { status: rootExit.error === null ? 'success' : rootExit.error === 'revert' ? 'reverted' : 'failed',
      error: rootExit.error, returnData: bytesToHex(result.execResult.returnValue),
      logs: logs.map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(bytesToHex), data: bytesToHex(data) })),
      logsHash: bytesToHex(keccak_256(RLP.encode(logs))) },
    receipt: { status: result.receipt.status, cumulativeBlockGasUsed: result.receipt.cumulativeBlockGasUsed,
      logsBloom: bytesToHex(result.receipt.bitvector), logsHash: bytesToHex(keccak_256(RLP.encode(result.receipt.logs))) },
    gas: { totalGasSpent: result.totalGasSpent, blockGasSpent: result.blockGasSpent,
      txRegularGas: result.txRegularGas, txStateGas: result.txStateGas, gasRefund: result.gasRefund, amountSpent: result.amountSpent },
    scope: { producer: 'pinned_ethereumjs_10.1.3_signed_full_vm', independentClientEvidence: false,
      expectedPoststateConsumed: false, gethResultsConsumed: false } });
}
