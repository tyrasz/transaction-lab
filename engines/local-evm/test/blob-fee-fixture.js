// Synthetic state and headers only; no public-chain or independent-client claim.
// Existing full-VM and product fixtures receive the same initial allocation.
import assert from 'node:assert/strict';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@ethereumjs/util';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createTx, Blob4844Tx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { createProofStateManager } from '../proof-state.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { feeFixture, bytes, qty, TEST_KEY, account, appliedRoot, feeCommon, feeBlock } from './fee-fixture.js';
import { compareExecution } from './authorization-fixture.js';
import { integer } from './proof-fixture.js';
export { TX_SENDER, TARGET, COINBASE, AUTHORITY, DELEGATE, word, bytes, qty, account, balance, appliedRoot, feeCommon, feeBlock, TEST_KEY } from './fee-fixture.js';
export const BLOB_PROFILE = 'unsigned_eip4844_block_end';
export const BLOB_HASH = '0x01' + 'ab'.repeat(31);
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const numeric = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
const bpo = { bpo1: [24100000n, 1765290071n], bpo2: [24500000n, 1767747671n] };

export async function blobFeeFixture({ fork = 'osaka', excessBlobGas = 0n, headerBlobGasUsed = 0n,
  blobCount = 1, blobVersionedHashes, maxBlobFee = 100n, profile = BLOB_PROFILE, ...options } = {}) {
  assert(Number.isSafeInteger(blobCount) && blobCount >= 0 && blobCount <= 32);
  const f = await feeFixture({ ...options, fork: Object.hasOwn(bpo, fork) ? 'osaka' : fork });
  if (Object.hasOwn(bpo, fork)) [f.header.number, f.header.timestamp] = bpo[fork].map(qty);
  if (fork !== 'shanghai') Object.assign(f.header, { excessBlobGas: qty(excessBlobGas), blobGasUsed: qty(headerBlobGasUsed) });
  const fields = order.filter(key => Object.hasOwn(f.header, key));
  f.header.hash = bytesToHex(keccak_256(RLP.encode(fields.map(key => numeric.has(key) ? integer(BigInt(f.header[key])) : bytes(f.header[key])))));
  f.headerVerification = verifyEthereumHeader({ header: f.header, expectedHash: f.header.hash });
  assert.equal(f.headerVerification.hardfork, fork);
  f.request.executionProfile = profile;
  if (profile === BLOB_PROFILE) {
    f.request.fees.maxFeePerBlobGas = String(maxBlobFee);
    f.request.blobVersionedHashes = blobVersionedHashes ?? Array.from({ length: blobCount }, () => BLOB_HASH);
  }
  f.inputs = createRpcStateInputs({ chainId: 1, blockHash: f.header.hash, header: f.header, rpc: f.rpc, ...(options.limits ? { limits: options.limits } : {}) });
  f.stateManager = createProofStateManager({ inputs: f.inputs });
  return f;
}

/** Sign the declared hash-only type-3 body (or its type-2 control). This helper
 * never accepts an expected result or installs KZG/sidecar validation. */
export function signBlobFeeTransaction({ request, common, nonce, privateKey = TEST_KEY }) {
  const blob = request.executionProfile === BLOB_PROFILE;
  assert(blob || request.executionProfile === 'unsigned_eip1559_block_end');
  assert.equal(request.authorizationList, undefined, 'These fixed reference fixtures support type 2/3 only');
  const data = { type: blob ? 3 : 2, chainId: 1n, nonce,
    gasLimit: BigInt(request.gas), to: request.to, value: BigInt(request.value), data: request.data,
    maxFeePerGas: BigInt(request.fees.maxFeePerGas), maxPriorityFeePerGas: BigInt(request.fees.maxPriorityFeePerGas),
    ...(request.accessList ? { accessList: request.accessList } : {}),
    ...(blob ? { maxFeePerBlobGas: BigInt(request.fees.maxFeePerBlobGas), blobVersionedHashes: request.blobVersionedHashes } : {}) };
  // The convenience factory requires a KZG object even for hash-only on-chain
  // bodies. Use its validating class directly and sign the exact typed hash.
  let tx;
  if (blob) {
    const unsigned = new Blob4844Tx(data, { common });
    const signature = secp256k1.Signature.fromBytes(secp256k1.sign(unsigned.getHashedMessageToSign(), bytes(privateKey),
      { prehash: false, format: 'recovered' }), 'recovered');
    tx = new Blob4844Tx({ ...data, v: BigInt(signature.recovery), r: signature.r, s: signature.s }, { common });
  } else tx = createTx(data, { common }).sign(bytes(privateKey));
  assert.equal(tx.getSenderAddress().toString(), request.from);
  assert(tx.verifySignature());
  return tx;
}

/** Separate transaction admission/finalization and full MPT, sharing the pinned
 * opcode library. Both paths start only from the same synthetic prestate. */
export async function blobFeeFullVM(f) {
  const common = feeCommon(f), state = await loadState(f.allocation, common), block = feeBlock(f, common);
  assert.equal(bytesToHex(await state.getStateRoot()), f.header.stateRoot);
  assert.equal(bytesToHex(block.hash()), f.header.hash);
  const vm = await createVM({ common, stateManager: state,
    blockchain: { async getBlock() { throw Error('Undeclared ancestry'); }, shallowCopy() { return this; } } });
  return { state, common, block, async run(request = f.request) {
    const nonce = (await account(state, request.from))?.nonce ?? 0n;
    const tx = signBlobFeeTransaction({ request, common, nonce });
    return { tx, result: await runTx(vm, { tx, block }) };
  } };
}

/** Apply product deltas to a third, initial-state MPT; reference outputs never
 * supply product inputs. Returns the signed body and reference for audit use. */
export async function compareBlobFeeFullVM(f, output, changes = f.stateManager.snapshotChanges()) {
  const reference = await blobFeeFullVM(f), { tx, result } = await reference.run();
  compareExecution(output, result);
  assert.equal(await appliedRoot(f, changes, reference.common), bytesToHex(await reference.state.getStateRoot()));
  if (f.request.executionProfile === BLOB_PROFILE) assert.equal(result.blobGasUsed?.toString(), output.feeAccounting.blobGasUsed);
  return { ...reference, tx, result };
}
