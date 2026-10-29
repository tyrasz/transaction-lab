// Authenticated synthetic prestate only. This fixture neither runs a reference
// client nor treats its constructed header as a public Sepolia observation.
import assert from 'node:assert/strict';
import { Common, Sepolia, Hardfork } from '@ethereumjs/common';
import { bytesToHex } from '@ethereumjs/util';
import { createBlock } from '../../fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
export { FACTORY, SENDER, factoryCode, createdAddress, initcode, word } from './lifecycle-fixture.js';
export const BENEFICIARY = '0x' + '44'.repeat(20), DONOR = '0x' + '55'.repeat(20), GETTER = '0x' + '66'.repeat(20);
export const selfdestructCode = target => '73' + target.slice(2) + 'ff';
export const callCode = (target, value = 0) => '600060006000600060' + value.toString(16).padStart(2, '0') + '73' + target.slice(2) + '620f4240f150';

export async function amsterdamClearingFixture(options = {}, { coinbase, priced = false } = {}) {
  const f = await lifecycleFixture(options), common = new Common({ chain: Sepolia, hardfork: Hardfork.Amsterdam });
  const block = createBlock({ header: { stateRoot: f.header.stateRoot, number: 12018196n, timestamp: 1793261160n,
    gasLimit: 60000000n, baseFeePerGas: priced ? 7n : 0n, ...(coinbase ? { coinbase } : {}) }, withdrawals: [] }, { common });
  const h = block.header.toJSON(), mapping = { sha3Uncles: 'uncleHash', miner: 'coinbase', transactionsRoot: 'transactionsTrie', receiptsRoot: 'receiptTrie' };
  for (const key of Object.keys(f.header)) delete f.header[key];
  for (const key of ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash', 'blockAccessListHash', 'slotNumber']) f.header[key] = h[mapping[key] ?? key];
  f.header.hash = bytesToHex(block.hash());
  assert.equal(verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash, chainId: 11155111 }).hardfork, 'amsterdam');
  f.inputs = createRpcStateInputs({ chainId: 11155111, blockHash: f.header.hash, header: f.header, rpc: f.rpc });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  if (priced) Object.assign(f.request, { executionProfile: 'unsigned_eip1559_block_end', fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3' } });
  return { ...f, common, block };
}
