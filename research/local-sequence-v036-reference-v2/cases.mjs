// Initial-only synthetic sequence declarations. No product, VM or reference
// execution occurs when this module is imported or declaration() is called.
import assert from 'node:assert/strict';
import {createTx, createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {getCalldataFloorGas} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {bytesToHex, hexToBytes} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {sequenceFixture, SEQUENCE_SCOPE} from '../../engines/local-evm/test/sequence-fixture.js';
import {feeFixture, feeCommon, TEST_KEY} from '../../engines/local-evm/test/fee-fixture.js';
import {amsterdamExecutionFixture} from '../../engines/local-evm/test/amsterdam-execution-fixture.js';
import {allocationRoot, normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';

export const CASES = Object.freeze([
  {id:'osaka_approve_deposit_withdraw', fork:'Osaka', methods:['approve','deposit','withdraw']},
  {id:'amsterdam_approve_deposit_withdraw', fork:'Amsterdam', methods:['approve','deposit','withdraw']},
  {id:'osaka_approve_deposit_revert_stop', fork:'Osaka', methods:['approve','depositThenRevert','withdraw']},
  {id:'amsterdam_approve_deposit_revert_stop', fork:'Amsterdam', methods:['approve','depositThenRevert','withdraw']},
].map(c => Object.freeze({...c, methods:Object.freeze(c.methods)})));
export const SYSTEMS = Object.freeze([
  '0x00000961ef480eb55e80d19ad83579a64c007002',
  '0x0000bbddc7ce488642fb579f8b00f3a590007251',
  '0x0000bff46984e3725691fa540a8c7589300d8282',
  '0x000064d678505ad48f8ccb093bc65613800e8282',
]);
export const SCOPE = Object.freeze({
  fixture:SEQUENCE_SCOPE, execution:'three_ordered_priced_unsigned_calls_vs_signed_type2_transactions',
  sameHeader:true, atomic:false, stopOn:'first_original_non_success',
  initialState:'synthetic_complete_allocation_with_initial_only_product_proofs',
  referenceStateFeeds:'preceding_eels_full_allocation_only',
  referenceContext:'fresh_single_transaction_apply_body_per_step_same_declared_environment',
  realProtocol:false, publicChainReplay:false, consensusVerified:false,
  comparedQueries:false, measuredNativeBalances:false,
});

const specification = allocation => Object.fromEntries(Object.entries(allocation).map(([address, row]) => [address, {
  nonce:BigInt(row.nonce), balance:BigInt(row.balance), code:row.code,
  storage:Object.fromEntries(Object.entries(row.storage).map(([slot, value]) => [slot, BigInt(value)])),
}]));

export async function fixture(index, scaffold = true) {
  assert(Number.isSafeInteger(index) && index >= 0 && index < CASES.length);
  assert.equal(typeof scaffold, 'boolean');
  const c = CASES[index], original = await sequenceFixture({fork:c.fork.toLowerCase(), priced:true});
  let f = original;
  if (scaffold) {
    const accounts = specification(original.allocation);
    for (const address of SYSTEMS) {
      assert(!Object.hasOwn(accounts, address));
      accounts[address] = {nonce:1n, balance:0n, code:'0x00', storage:{}};
    }
    const options = {baseFee:7n, maxFee:13n, priorityFee:3n, target:null,
      to:original.request.to, data:original.request.data, gas:'5000000', accounts};
    const amended = c.fork === 'Amsterdam' ? await amsterdamExecutionFixture(options)
      : await feeFixture({...options, fork:'osaka'});
    f = {...original, ...amended};
  }
  return {...f, common:f.common ?? feeCommon(f), chainId:c.fork === 'Amsterdam' ? 11155111 : 1,
    requests:c.methods.map(method => structuredClone(original.requests[method])),
    // The current product API requires at least one disposable query. Its result
    // is retained by a future product worker but is outside this comparison.
    queries:[{kind:'native_balance', account:original.addresses.sender}]};
}

export async function declaration(index) {
  const c = CASES[index]; assert(c);
  const f = await fixture(index), original = await fixture(index, false), h = f.header;
  const allocation = normalizeAllocation(f.allocation), originalAllocation = normalizeAllocation(original.allocation);
  assert.equal(await allocationRoot(allocation), h.stateRoot);
  assert.equal(await allocationRoot(originalAllocation), original.header.stateRoot);
  const nonce = BigInt(allocation[f.addresses.sender].nonce);
  const steps = f.requests.map((request, position) => {
    const tx = createTx({type:2, chainId:BigInt(f.chainId), nonce:nonce + BigInt(position),
      gasLimit:BigInt(request.gas), to:request.to, value:BigInt(request.value), data:request.data,
      maxFeePerGas:13n, maxPriorityFeePerGas:3n}, {common:f.common}).sign(hexToBytes(TEST_KEY));
    const signedBytes = bytesToHex(tx.serialize()), decoded = createTxFromRLP(hexToBytes(signedBytes), {common:f.common});
    assert(decoded.verifySignature()); assert.equal(decoded.getSenderAddress().toString(), request.from);
    assert.equal(bytesToHex(decoded.serialize()), signedBytes);
    return {position, method:c.methods[position], request, transaction:tx.toJSON(), signedBytes,
      transactionHash:bytesToHex(tx.hash()), transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
      inputGas:{intrinsic:tx.getIntrinsicGas().toString(), calldataFloor:getCalldataFloorGas(tx).toString()}};
  });
  const environment = {currentCoinbase:h.miner, currentGasLimit:h.gasLimit, currentNumber:h.number,
    currentTimestamp:h.timestamp, currentRandom:h.mixHash, currentDifficulty:h.difficulty,
    currentBaseFee:h.baseFeePerGas, currentExcessBlobGas:h.excessBlobGas,
    parentBeaconBlockRoot:h.parentBeaconBlockRoot, withdrawals:[],
    ...(c.fork === 'Amsterdam' ? {slotNumber:h.slotNumber} : {})};
  return JSON.parse(JSON.stringify({index, id:c.id, fork:c.fork, chainId:f.chainId, scope:SCOPE,
    sender:f.addresses.sender, addresses:f.addresses, slots:f.slots, amounts:{approve:'100', deposit:'100', withdraw:'40'},
    originalAllocation, originalStateRoot:original.header.stateRoot, allocation, initialStateRoot:h.stateRoot,
    header:h, headerHash:h.hash, environment, steps, productQueries:f.queries,
    amendment:{kind:'identical_inert_system_STOP_accounts', addresses:SYSTEMS,
      originalAccountRowsChanged:false, actualDeployedChainState:false}}));
}
