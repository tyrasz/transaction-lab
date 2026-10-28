import test from 'node:test';
import assert from 'node:assert/strict';
import { ethereumCallGas, ethereumCommon, ethereumContextProfile, ethereumUsedGas } from '../ethereum-profile.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeEthereumPreview } from '../ethereum-preview.js';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const header = { number: '20000000', timestamp: '1746612311', gasLimit: '30000000', baseFeePerGas: '17', mixHash: word(9), miner: address(5555), parentHash: word(99), hash: word(100), stateRoot: word(101) };
const tuple = () => ({ chainId: '0x1', address: address(3333), nonce: '0x0', yParity: '0x0', r: '0x0', s: '0x0' });
const request = () => ({ from: address(1111), to: address(2222), data: '0x00010200', value: '0', gas: '5000000' });

test('absent authorization context preserves legacy cost and profile shape', () => {
  const common = ethereumCommon(header), call = request();
  assert.deepEqual(ethereumCallGas(call.data, common, call), { intrinsic: 21040n, floor: 21100n, minimum: 21100n, zeroBytes: 2n, nonzeroBytes: 2n });
  assert.deepEqual(ethereumContextProfile(call, header, common), {});
});

test('every declared tuple occurrence pays 25000 intrinsic even when protocol-skippable', () => {
  const common = ethereumCommon(header), call = request();
  call.authorizationList = Array.from({ length: 16 }, (_, i) => ({ ...tuple(), ...(i % 3 === 0 ? { chainId: '0x2' } : i % 3 === 1 ? { nonce: '0xffffffffffffffff' } : { yParity: '0xff' }) }));
  call.accessList = [{ address: call.to, storageKeys: [word(0), word(0)] }, { address: call.to, storageKeys: [] }];
  const costs = ethereumCallGas(call.data, common, call), profile = ethereumContextProfile(call, header, common);
  assert.equal(costs.authorizationCount, 16n); assert.equal(costs.authorizationIntrinsic, 400000n);
  assert.equal(costs.intrinsic, 429640n); assert.equal(costs.floor, 21100n); assert.equal(costs.minimum, costs.intrinsic);
  assert.deepEqual(profile.authorizationList, call.authorizationList); assert.equal(profile.authorizationCount, '16'); assert.equal(profile.authorizationIntrinsicGas, '400000');
  assert.equal(profile.accessListIntrinsicGas, '8600'); assert(Object.isFrozen(profile.authorizationList));
  assert(Object.isFrozen(profile.authorizationList[0])); assert.notEqual(profile.authorizationList, call.authorizationList);
});

test('authorization admission starts at Prague and excludes creation and blob context', () => {
  for (const timestamp of ['1681338455', '1710338135', '1746612310']) {
    const block = { ...header, timestamp }, call = { ...request(), authorizationList: [tuple()] };
    assert.throws(() => ethereumCallGas(call.data, ethereumCommon(block), call), /Prague/);
    assert.throws(() => ethereumContextProfile(call, block), /Prague/);
  }
  for (const timestamp of ['1746612311', '1764798551', '1765290071', '1767747671']) {
    const block = { ...header, timestamp }, call = { ...request(), authorizationList: [tuple()] };
    assert.equal(ethereumCallGas(call.data, ethereumCommon(block), call).intrinsic, 46040n);
    assert.equal(ethereumContextProfile(call, block).authorizationCount, '1');
  }
  for (const change of [{ to: null }, { blobVersionedHashes: ['0x01' + 'ab'.repeat(31)] }]) {
    const call = { ...request(), authorizationList: [tuple()], ...change };
    assert.throws(() => ethereumContextProfile(call, header), /without blob context/);
  }
});

test('authorization intrinsic participates in admission, refund cap and unchanged calldata floor', async () => {
  const call = { ...request(), data: '0x', gas: '45999', authorizationList: [tuple()] };
  let reads = 0;
  const stateManager = { getAccount() { reads++; throw Error('Invalid envelope reached state'); } };
  const rejected = await executeEthereumCall({ request: call, header, stateManager });
  assert.equal(rejected.execution.status, 'invalid'); assert.equal(reads, 0);
  const costs = ethereumCallGas('0x' + '01'.repeat(2000), ethereumCommon(header), call);
  assert.equal(costs.intrinsic, 78000n); assert.equal(costs.floor, 101000n); assert.equal(costs.minimum, 101000n);
  assert.deepEqual(ethereumUsedGas({ messageGasUsed: 0n, refundCounter: 12500n, intrinsic: 46000n, floor: 21000n }), { beforeRefund: 46000n, appliedRefund: 9200n, floorAdjustment: 0n, gasUsed: 36800n });
  assert.deepEqual(ethereumUsedGas({ messageGasUsed: 20000n, refundCounter: 12500n + 4800n, intrinsic: 46000n, floor: 21000n }), { beforeRefund: 66000n, appliedRefund: 13200n, floorAdjustment: 0n, gasUsed: 52800n });
});

test('malformed authorization structures fail before any state or query input read', async () => {
  const query = { to: address(2222), data: '0x70a08231' + address(1111).slice(2).padStart(64, '0') };
  const lists = [[], null, undefined, Array.from({ length: 17 }, tuple), [{ ...tuple(), nonce: '0x00' }], [{ ...tuple(), authority: address(1) }]];
  const accessor = { ...tuple() }; Object.defineProperty(accessor, 'r', { enumerable: true, get() { assert.fail('Authorization getter executed'); } }); lists.push([accessor]);
  for (const authorizationList of lists) {
    const call = { ...request(), authorizationList };
    const result = await executeEthereumCall({ request: call, header, stateManager: { getAccount() { assert.fail('Malformed authorization reached state'); } } });
    assert.equal(result.execution.status, 'invalid');
    const preview = await executeEthereumPreview({ request: call, header, queries: [query], rpc: { call() { assert.fail('Malformed authorization reached RPC'); } } });
    assert.equal(preview.status, 'unavailable'); assert.equal(preview.error.code, 'LOCAL_PREVIEW_INPUT'); assert.equal(preview.original, null);
  }
});
