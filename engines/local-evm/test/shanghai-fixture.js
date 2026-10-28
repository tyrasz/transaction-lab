// Synthetic Shanghai header and authenticated prestate only. No execution
// output or expected poststate is used to produce these proofs.
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { privateToAddress } from '@ethereumjs/util';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { lifecycleFixture, FACTORY, SENDER, bytes, hex } from './lifecycle-fixture.js';
import { integer } from './proof-fixture.js';

export const SHANGHAI_TEST_KEY = '0x' + '01'.repeat(32);
export const SHANGHAI_SENDER = hex(privateToAddress(bytes(SHANGHAI_TEST_KEY)));
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot'];
const numeric = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas']);
const quantity = n => '0x' + BigInt(n).toString(16);

export async function shanghaiFixture({ code = '0x00', accounts = {}, limits } = {}) {
  const supplied = { [SHANGHAI_SENDER]: { nonce:1n, balance:1000000n, code:'0x' }, ...accounts };
  const f = await lifecycleFixture({ code, accounts:supplied, limits });
  Object.assign(f.header, { number:quantity(18000000), timestamp:quantity(1681338455), baseFeePerGas:'0x0', gasUsed:'0x0' });
  for (const key of ['blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash']) delete f.header[key];
  f.header.hash = hex(keccak_256(RLP.encode(order.map(key => numeric.has(key) ? integer(BigInt(f.header[key])) : bytes(f.header[key])))));
  f.headerVerification = verifyEthereumHeader({ header:f.header, expectedHash:f.header.hash });
  if (f.headerVerification.hardfork !== 'shanghai') throw Error('Synthetic Shanghai fixture selected a different fork');
  // The original lifecycleFixture collector captured its old hash. Rebuild it;
  // the proof-only RPC closure reads this same mutated header object.
  f.inputs = createRpcStateInputs({ chainId:1, blockHash:f.header.hash, header:f.header, rpc:f.rpc, ...(limits ? {limits} : {}) });
  f.stateManager = createProofStateManager({ inputs:f.inputs });
  f.request.from = SHANGHAI_SENDER;
  const specifications = { [FACTORY]: {nonce:7n,balance:1000n,code}, [SENDER]: {nonce:1n,balance:1000000n,code:'0x'}, ...supplied };
  // Kept separately before execution for full-state VM controls. Never derive
  // this allocation from product outputs or demanded proof subsets.
  f.allocation = Object.fromEntries(Object.entries(specifications).map(([address,input]) => {
    const a = {nonce:0n,balance:0n,code:'0x',storage:{},...input};
    return [address, {nonce:quantity(a.nonce),balance:quantity(a.balance),code:a.code,storage:Object.fromEntries(Object.entries(a.storage).map(([slot,value]) => [slot,quantity(value)]))}];
  }));
  return f;
}
