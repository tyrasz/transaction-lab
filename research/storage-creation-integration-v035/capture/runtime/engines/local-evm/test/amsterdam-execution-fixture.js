// Authenticated synthetic prestate; the signed reference shares EthereumJS.
// This is transaction-wrapper comparison, not independent-client evidence.
import assert from 'node:assert/strict';
import { bytesToHex } from '@ethereumjs/util';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { feeFixture, feeBlock, TEST_KEY, TX_SENDER, TARGET, COINBASE, bytes, appliedRoot } from './fee-fixture.js';
import { compareExecution } from './authorization-fixture.js';
export { TX_SENDER, TARGET, COINBASE, bytes, appliedRoot };
export { account, code, slot, call, word, signAuthorization, AUTHORITY, DELEGATE } from './authorization-fixture.js';

export async function amsterdamExecutionFixture({ priced = true, slotNumber = 12345n, ...options } = {}) {
  const f = await feeFixture({ ...(!priced ? { baseFee: 0n, maxFee: 0n, priorityFee: 0n } : {}), ...options });
  const common = ethereumNetworkCommon({ number: '12018196', timestamp: '1793261160' }, 11155111);
  const block = createBlock({ header: { ...feeBlock(f, common).header.toJSON(), number: 12018196n,
    timestamp: 1793261160n, slotNumber }, withdrawals: [] }, { common });
  const json = block.header.toJSON(), aliases = { sha3Uncles: 'uncleHash', miner: 'coinbase', transactionsRoot: 'transactionsTrie', receiptsRoot: 'receiptTrie' };
  for (const key of Object.keys(f.header)) delete f.header[key];
  for (const key of ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber']) f.header[key] = json[aliases[key] ?? key];
  f.header.hash = bytesToHex(block.hash());
  f.headerVerification = verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: 11155111 });
  assert.equal(f.headerVerification.hardfork, 'amsterdam');
  if (!priced) { delete f.request.executionProfile; delete f.request.fees; }
  f.inputs = createRpcStateInputs({ chainId: 11155111, blockHash: f.header.hash, header: f.header, rpc: f.rpc });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  return { ...f, common, block, chainId: 11155111 };
}

export async function compareAmsterdamFullVM(f, output, changes = f.stateManager.snapshotChanges()) {
  const state = await loadState(f.allocation, f.common);
  assert.equal(bytesToHex(await state.getStateRoot()), f.header.stateRoot);
  const vm = await createVM({ common: f.common, stateManager: state, blockchain: {
    async getBlock() { throw Error('No ancestry supplied by synthetic fixture'); }, shallowCopy() { return this; },
  } });
  const r = f.request;
  const tx = createTx({ type: 2, chainId: 11155111n, nonce: 1n, gasLimit: BigInt(r.gas), to: r.to ?? undefined,
    value: BigInt(r.value), data: r.data, maxFeePerGas: BigInt(r.fees?.maxFeePerGas ?? '0'),
    maxPriorityFeePerGas: BigInt(r.fees?.maxPriorityFeePerGas ?? '0'), ...(r.accessList ? { accessList: r.accessList } : {}) }, { common: f.common }).sign(bytes(TEST_KEY));
  assert(tx.verifySignature()); assert.equal(tx.getSenderAddress().toString(), TX_SENDER);
  const result = await runTx(vm, { tx, block: f.block });
  compareExecution(output, result);
  assert.equal(output.stateGasAccounting.settled.regularGasUsed, result.txRegularGas.toString());
  assert.equal(output.stateGasAccounting.settled.stateGasUsed, result.txStateGas.toString());
  assert.equal(await appliedRoot(f, changes, f.common), bytesToHex(await state.getStateRoot()));
  return { state, tx, result };
}
