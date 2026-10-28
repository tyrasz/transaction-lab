import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEthereumFees, ethereumFeePlan, settleEthereumFees, ETHEREUM_FEE_PROFILE } from '../ethereum-fees.js';

const miner = '0x' + 'ab'.repeat(20), max = (1n << 256n) - 1n;
const header = { baseFeePerGas: '17', gasLimit: '30000000', miner };
const request = (changes = {}) => ({ executionProfile: ETHEREUM_FEE_PROFILE, fees: { maxFeePerGas: '30', maxPriorityFeePerGas: '5' }, gas: '100000', value: '7', ...changes });
const invalid = fn => assert.throws(fn, { code: 'LOCAL_ETHEREUM_INPUT_INVALID' });

test('fee admission is explicit, detached and canonical while the default adds nothing', () => {
  assert.deepEqual(normalizeEthereumFees({}), {}); assert.equal(ethereumFeePlan({}, null), null);
  const input = request(), normalized = normalizeEthereumFees(input);
  assert.deepEqual(normalized, { executionProfile: ETHEREUM_FEE_PROFILE, fees: input.fees });
  assert(Object.isFrozen(normalized) && Object.isFrozen(normalized.fees)); input.fees.maxFeePerGas = '1'; assert.equal(normalized.fees.maxFeePerGas, '30');
  for (const change of [{ executionProfile: undefined }, { executionProfile: 'unsigned_unpriced_block_end' }, { fees: undefined }, { fees: null },
    { fees: { maxFeePerGas: '30' } }, { fees: { maxFeePerGas: '30', maxPriorityFeePerGas: '5', gasPrice: '1' } }, { blobVersionedHashes: undefined }]) invalid(() => normalizeEthereumFees(request(change)));
  invalid(() => normalizeEthereumFees({ fees: request().fees })); invalid(() => normalizeEthereumFees({ executionProfile: ETHEREUM_FEE_PROFILE }));
  for (const bad of [30, 30n, '-1', '+1', '01', '0x1', '1.0', '1e2', '', ' 1', (max + 1n).toString()]) {
    for (const field of ['maxFeePerGas', 'maxPriorityFeePerGas']) invalid(() => normalizeEthereumFees(request({ fees: { ...request().fees, [field]: bad } })));
  }
  invalid(() => normalizeEthereumFees(request({ fees: { maxFeePerGas: '4', maxPriorityFeePerGas: '5' } })));
});

test('normalization and plan reads never invoke proxy or accessor code', () => {
  const fail = () => assert.fail('Unexpected reflection/accessor invocation');
  invalid(() => normalizeEthereumFees(new Proxy({}, { getPrototypeOf: fail, getOwnPropertyDescriptor: fail })));
  invalid(() => normalizeEthereumFees(request({ fees: new Proxy({}, { getPrototypeOf: fail, ownKeys: fail }) })));
  const accessor = request(); Object.defineProperty(accessor, 'fees', { enumerable: true, get: fail }); invalid(() => normalizeEthereumFees(accessor));
  const cap = {}; Object.defineProperty(cap, 'maxFeePerGas', { enumerable: true, get: fail }); cap.maxPriorityFeePerGas = '5'; invalid(() => normalizeEthereumFees(request({ fees: cap })));
  const gas = request(); Object.defineProperty(gas, 'gas', { enumerable: true, get: fail }); invalid(() => ethereumFeePlan(gas, header));
  const h = { ...header }; Object.defineProperty(h, 'baseFeePerGas', { enumerable: true, get: fail }); invalid(() => ethereumFeePlan(request(), h));
});

test('cap affordability differs from actual prepayment and final settlement remains exact', () => {
  const plan = ethereumFeePlan(request(), header);
  assert.equal(plan.effectiveGasPrice, 22n); assert.equal(plan.priorityFeePerGas, 5n);
  assert.equal(plan.maximumRequiredBalance, 3000007n); assert.equal(plan.upfrontGasDebit, 2200000n);
  assert.deepEqual(settleEthereumFees(plan, { gasUsed: 21000n }), { kind: 'eip1559', gasLimit: '100000', effectiveGasPrice: '22', baseFeePerGas: '17', priorityFeePerGas: '5',
    maximumRequiredBalance: '3000007', upfrontGasDebit: '2200000', chargedGas: '21000', gasCharge: '462000', senderRefund: '1738000', baseFeeBurn: '357000', coinbaseTip: '105000', coinbase: miner });
  const capped = ethereumFeePlan(request({ fees: { maxFeePerGas: '19', maxPriorityFeePerGas: '5' } }), header);
  assert.equal(capped.effectiveGasPrice, 19n); assert.equal(capped.priorityFeePerGas, 2n);
  const zero = ethereumFeePlan(request({ fees: { maxFeePerGas: '17', maxPriorityFeePerGas: '0' } }), header);
  assert.equal(settleEthereumFees(zero, { gasUsed: 100000n }).coinbaseTip, '0');
  invalid(() => settleEthereumFees(plan, { gasUsed: 100001n })); invalid(() => settleEthereumFees(plan, { gasUsed: -1n }));
});

test('header cap, block gas and uint256 affordability overflow fail before any state is supplied', () => {
  invalid(() => ethereumFeePlan(request(), { ...header, baseFeePerGas: '31' }));
  invalid(() => ethereumFeePlan(request(), { ...header, gasLimit: '99999' }));
  for (const gas of ['0', '20999', '5000001']) invalid(() => ethereumFeePlan(request({ gas }), header));
  invalid(() => ethereumFeePlan(request({ fees: { maxFeePerGas: max.toString(), maxPriorityFeePerGas: '0' } }), header));
  const price = max / 21000n, value = max - 21000n * price;
  const fitting = request({ gas: '21000', value: value.toString(), fees: { maxFeePerGas: price.toString(), maxPriorityFeePerGas: '0' } });
  assert.equal(ethereumFeePlan(fitting, header).maximumRequiredBalance, max);
  invalid(() => ethereumFeePlan({ ...fitting, value: (value + 1n).toString() }, header));
});
