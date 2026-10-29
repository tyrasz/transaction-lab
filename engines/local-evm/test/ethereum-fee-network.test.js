// Pure admission/arithmetic controls. No VM, RPC or public execution enablement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ethereumBlobContext } from '../ethereum-blob-fees.js';
import { ethereumFeePlan, settleEthereumFees, ETHEREUM_FEE_PROFILE, ETHEREUM_BLOB_FEE_PROFILE } from '../ethereum-fees.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { verifyEthereumHeader } from '../ethereum-header.js';
import { ethereumCallGas } from '../ethereum-profile.js';

const file = name => readFileSync(new URL('./fixtures/sepolia-network/' + name, import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const raw = file('header-12018196.json');
const saved = JSON.parse(raw), scheduleBytes = file('geth-sepolia.json'), schedule = JSON.parse(scheduleBytes);
const FROM = '0x' + '11'.repeat(20), TO = '0x' + '22'.repeat(20), HASH = '0x01' + '33'.repeat(31), MAX = (1n << 256n) - 1n;
const mainnet = [
  ['shanghai',1681338455n], ['cancun',1710338135n,3n,6n,6n,3338477n], ['prague',1746612311n,6n,9n,9n,5007716n],
  ['osaka',1764798551n,6n,9n,6n,5007716n], ['bpo1',1765290071n,10n,15n,6n,8346193n], ['bpo2',1767747671n,14n,21n,6n,11684671n],
];
const sepolia = [
  ['shanghai',1677557088n], ['cancun',1706655072n,3n,6n,6n,3338477n], ['prague',1741159776n,6n,9n,9n,5007716n],
  ['osaka',1760427360n,6n,9n,6n,5007716n], ['bpo1',1761017184n,10n,15n,6n,8346193n], ['bpo2',1761607008n,14n,21n,6n,11684671n],
  ['amsterdam',1791294816n,14n,21n,6n,11684671n],
];
const header = (time = sepolia.at(-1)[1], patch = {}) => ({ number: '30000000', timestamp: time.toString(),
  excessBlobGas: '0', blobGasUsed: '0', baseFeePerGas: '7', gasLimit: '30000000', miner: TO, ...patch });
const request = (patch = {}) => ({ from: FROM, to: TO, value: '0', data: '0x', gas: '100000', executionProfile: ETHEREUM_FEE_PROFILE,
  fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3' }, ...patch });
const blobRequest = (count = 1, patch = {}) => request({ executionProfile: ETHEREUM_BLOB_FEE_PROFILE,
  fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3', maxFeePerBlobGas: '100' }, blobVersionedHashes: Array(count).fill(HASH), ...patch });
const invalid = fn => assert.throws(fn, { code: 'LOCAL_ETHEREUM_INPUT_INVALID' });
function expectedContext(row, excess = 0n, price = 1n) {
  return { hardfork: row[0], excessBlobGas: excess, blobBaseFeePerGas: price, gasPerBlob: 131072n,
    targetBlobsPerBlock: row[2], maxBlobsPerBlock: row[3], maxBlobsPerTransaction: row[4], baseFeeUpdateFraction: row[5] };
}

test('retained authenticated Sepolia header uses Amsterdam inherited BPO2 prices and a six-blob transaction cap', () => {
  assert.equal(sha(raw), 'dd7eb647ef6be190561896eb8bcef58750cc08ed940081d539fdc592708faceb');
  assert.equal(sha(scheduleBytes), 'a5917e237e111dc392018ca6a2221ae67fd31b2745a1f55137a3586543705807');
  const verified = verifyEthereumHeader({ header: saved, expectedHash: saved.hash, chainId: 11155111 });
  assert.equal(verified.hardfork, 'amsterdam'); assert.equal(verified.headerFields, 23);
  assert.deepEqual(ethereumBlobContext(saved, 11155111), expectedContext(sepolia.at(-1), 131072n));
  const plan = ethereumFeePlan(blobRequest(6, { fees: { maxFeePerGas: '30', maxPriorityFeePerGas: '3', maxFeePerBlobGas: '1' } }), saved, 11155111);
  assert.equal(plan.blobCount, 6n); assert.equal(plan.blobFeeBurn, 786432n); assert.equal(plan.effectiveGasPrice, 18n);
  assert.equal(plan.maximumRequiredBalance, 3786432n); assert.equal(plan.totalUpfrontDebit, 2586432n);
  // A saved header is not a chain selector; mainnet's block/timestamp rules
  // reject this exact Sepolia number, independently of fee computation.
  assert.throws(() => ethereumBlobContext(saved));
});

test('every pinned network boundary selects the exact finite schedule before, at and after activation', () => {
  for (const [chainId, rows] of [[1, mainnet], [11155111, sepolia]]) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], [fork, time] = row;
      if (chainId === 11155111) assert.equal(BigInt(schedule[fork + 'Time']), time);
      if (i === 0) assert.throws(() => ethereumBlobContext(header(time - 1n), chainId), { code: 'LOCAL_ETHEREUM_FORK_UNSUPPORTED' });
      else assert.equal(ethereumBlobContext(header(time - 1n), chainId)?.hardfork ?? 'shanghai', rows[i - 1][0]);
      for (const t of [time, time + 1n]) {
        const context = ethereumBlobContext(header(t), chainId);
        if (fork === 'shanghai') assert.equal(context, null);
        else { assert.deepEqual(context, expectedContext(row)); assert(Object.isFrozen(context)); }
      }
    }
  }
  const time = sepolia.find(row => row[0] === 'bpo2')[1];
  assert.equal(ethereumBlobContext(header(time), 11155111).hardfork, 'bpo2');
  assert.equal(ethereumBlobContext(header(time), 1).hardfork, 'prague');
});

test('trusted numeric selector is independent of request/header claims and rejects without coercion', () => {
  let calls = 0;
  const hostile = new Proxy({}, { get() { calls++; throw Error('coercion'); }, getPrototypeOf() { calls++; throw Error('reflection'); } });
  for (const chainId of [0, 999, 42161, '1', '11155111', 1n, 11155111n, null, {}, NaN, Infinity, hostile]) {
    assert.throws(() => ethereumBlobContext(saved, chainId), { code: 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED' });
    assert.throws(() => ethereumFeePlan(request(), saved, chainId), { code: 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED' });
    assert.throws(() => ethereumFeePlan({}, null, chainId), { code: 'LOCAL_ETHEREUM_CHAIN_UNSUPPORTED' });
  }
  const h = header(), r = request();
  for (const value of [h, r]) Object.defineProperty(value, 'chainId', { enumerable: true, get() { calls++; throw Error('untrusted claim'); } });
  assert.equal(ethereumBlobContext(h, 11155111).hardfork, 'amsterdam');
  assert.equal(ethereumFeePlan(r, h, 11155111).blobContext.hardfork, 'amsterdam');
  assert.equal(ethereumFeePlan({}, null), null); assert.equal(ethereumFeePlan({}, null, 11155111), null); assert.equal(calls, 0);
});

test('block blob capacity never raises the transaction cap and header/resource bounds remain strict', () => {
  for (const [chainId, rows] of [[1, mainnet], [11155111, sepolia]]) for (const row of rows.slice(1)) {
    const h = header(row[1], { blobGasUsed: String(row[3] * 131072n) });
    assert.equal(ethereumFeePlan(blobRequest(Number(row[4])), h, chainId).blobCount, row[4]);
    invalid(() => ethereumFeePlan(blobRequest(Number(row[4] + 1n)), h, chainId));
    invalid(() => ethereumBlobContext({ ...h, blobGasUsed: String((row[3] + 1n) * 131072n) }, chainId));
  }
  for (const count of [0, 7, 9]) invalid(() => ethereumFeePlan(blobRequest(count), header(), 11155111));
  for (const key of ['number', 'timestamp', 'blobGasUsed', 'excessBlobGas']) {
    for (const value of ['01', '0x00', (1n << 64n).toString(), '-1', 1n, 1, undefined]) invalid(() => ethereumBlobContext(header(undefined, { [key]: value }), 11155111));
    const h = header(); Object.defineProperty(h, key, { enumerable: true, get() { assert.fail('Accessor called'); } });
    invalid(() => ethereumBlobContext(h, 11155111));
  }
  invalid(() => ethereumBlobContext(header(undefined, { blobGasUsed: '1' }), 11155111));
  assert.throws(() => ethereumBlobContext(header(undefined, { excessBlobGas: ((1n << 64n) - 1n).toString() }), 11155111), { code: 'LOCAL_ETHEREUM_BLOB_PRICE_LIMIT' });
});

test('Amsterdam blob burn, cap affordability, execution refunds and tips remain distinct exact integers', () => {
  const h = header(undefined, { excessBlobGas: String(11684671n * 2n) });
  const plan = ethereumFeePlan(blobRequest(2, { value: '11' }), h, 11155111), result = settleEthereumFees(plan, { gasUsed: 15000n });
  assert.equal(plan.blobBaseFeePerGas, 7n); assert.equal(plan.blobFeeBurn, 1835008n);
  assert.equal(plan.maximumRequiredBalance, 27514411n); assert.equal(plan.totalUpfrontDebit, 2835008n);
  assert.equal(result.gasCharge, '150000'); assert.equal(result.senderRefund, '850000'); assert.equal(result.coinbaseTip, '45000');
  assert.equal(result.blobFeeBurn, '1835008'); assert.equal(result.totalFeeCharge, '1985008'); assert.equal(result.totalFeeBurn, '1940008');
  assert.equal(BigInt(result.totalUpfrontDebit) - BigInt(result.senderRefund), BigInt(result.totalFeeCharge));
  invalid(() => ethereumFeePlan(blobRequest(1, { fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3', maxFeePerBlobGas: '6' } }), h, 11155111));
  invalid(() => ethereumFeePlan(blobRequest(1, { fees: { maxFeePerGas: '13', maxPriorityFeePerGas: '3', maxFeePerBlobGas: MAX.toString() } }), h, 11155111));
  invalid(() => ethereumFeePlan(request(), { ...h, baseFeePerGas: '14' }, 11155111));
  for (const [multiple, expected] of [[0n,1n],[1n,2n],[2n,7n],[5n,148n]]) {
    assert.equal(ethereumBlobContext(header(undefined, { excessBlobGas: String(11684671n * multiple), baseFeePerGas: MAX.toString() }), 11155111).blobBaseFeePerGas, expected);
  }
});

test('Amsterdam 12k fee base is preliminary; full request intrinsic/floor and public 5M bound are separate', () => {
  const h = header(), common = ethereumNetworkCommon(h, 11155111);
  for (const [patch, minimum] of [[{ to: FROM }, 12000n], [{}, 15000n], [{ value: '1' }, 21000n], [{ to: null }, 24000n], [{ data: '0x00' }, 15064n]]) {
    const r = request({ ...patch, gas: minimum.toString() });
    assert.equal(ethereumCallGas(r.data, common, r).minimum, minimum);
    assert.equal(ethereumFeePlan(r, h, 11155111).gasLimit, minimum);
  }
  // FeePlan deliberately does not duplicate call-layer full intrinsic logic.
  const preliminary = request({ gas: '12000' });
  assert.equal(ethereumFeePlan(preliminary, h, 11155111).gasLimit, 12000n);
  assert.equal(ethereumCallGas(preliminary.data, common, preliminary).minimum, 15000n);
  for (const gas of ['0','11999','5000001']) invalid(() => ethereumFeePlan(request({ gas }), h, 11155111));
  invalid(() => ethereumFeePlan(request({ gas: '12000' }), header(sepolia.at(-1)[1] - 1n), 11155111));
  invalid(() => ethereumFeePlan(request({ gas: '12000' }), h));
  invalid(() => ethereumFeePlan(request({ gas: '12000' }), { ...h, gasLimit: '11999' }, 11155111));
  assert.equal(ethereumFeePlan(request({ gas: '5000000' }), h, 11155111).gasLimit, 5000000n);
});

test('default mainnet plans and context retain their complete prior output shape', () => {
  for (const row of mainnet) {
    const h = header(row[1]), context = row[0] === 'shanghai' ? null : expectedContext(row);
    assert.deepEqual(ethereumBlobContext(h), context); assert.deepEqual(ethereumBlobContext(h, 1), context);
    const expected = { gasLimit: 100000n, maxFeePerGas: 13n, maxPriorityFeePerGas: 3n, baseFeePerGas: 7n, effectiveGasPrice: 10n,
      priorityFeePerGas: 3n, maximumRequiredBalance: 1300000n, upfrontGasDebit: 1000000n, coinbase: TO, ...(context ? { blobContext: context } : {}) };
    assert.deepEqual(ethereumFeePlan(request(), h), expected); assert.deepEqual(ethereumFeePlan(request(), h, 1), expected);
    assert.equal(Object.hasOwn(expected, 'chainId'), false);
  }
});
