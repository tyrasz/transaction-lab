import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { createRecordedStateManager } from '../recorded-state.js';

// Synthetic bytecode and explicit state controls. These execute the real local
// interpreter; they are not public-chain observations or authenticated headers.
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const FROM = address(0x1111), TO = address(0x2222), CHILD = address(0x3334), IMPLEMENTATION = address(0x4444);
const HEADER = { number: '20000000', timestamp: '1746612311', gasLimit: '30000000', baseFeePerGas: '17', mixHash: word(9), miner: address(0x5555), parentHash: word(99), hash: word(100), stateRoot: word(101) };
const account = (code = '0x', balance = '0', initialStorage = 7n) => ({ exists: true, nonce: '1', balance, code, storage: { [word(0)]: word(initialStorage) } });
async function fixture(code = '0x', additions = {}) {
  const stateManager = await createRecordedStateManager({ accounts: { [FROM]: { ...account('0x', '1000'), nonce: '7' }, [TO]: account(code), ...additions } });
  return { request: { from: FROM, to: TO, data: '0x', value: '0', gas: '200000' }, header: structuredClone(HEADER), stateManager };
}
const getAccount = (f, target) => f.stateManager.getAccount(createAddressFromString(target));
const getStorage = async (f, target) => {
  const bytes = await f.stateManager.getStorage(createAddressFromString(target), hexToBytes(word(0)));
  return bytes.length ? BigInt('0x' + Buffer.from(bytes).toString('hex')) : 0n;
};
const returnedWords = result => {
  assert.match(result.execution.returnData, /^0x(?:[0-9a-f]{64})*$/);
  return result.execution.returnData.slice(2).match(/.{64}/g)?.map(value => BigInt('0x' + value)) ?? [];
};

test('native self-transfer nets zero while incrementing one nonce, and still requires value affordability', async () => {
  const f = await fixture(); f.request.to = FROM; f.request.value = '123'; f.request.gas = '21000';
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.executionGasUsed, '0');
  assert.equal(result.gasAccounting.gasUsed, '21000');
  assert.equal((await getAccount(f, FROM)).balance, 1000n);
  assert.equal((await getAccount(f, FROM)).nonce, 8n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]);
  assert.equal(result.trace.from, FROM); assert.equal(result.trace.to, FROM); assert.equal(result.trace.value, '0x7b');
  assert.equal(result.profile.feesSettled, false);

  const invalid = await fixture(); invalid.request.to = FROM; invalid.request.value = '1001';
  const rejected = await executeEthereumCall(invalid);
  assert.equal(rejected.execution.status, 'invalid');
  assert.equal(rejected.execution.error.code, 'LOCAL_CALL_INSUFFICIENT_BALANCE');
  assert.equal((await getAccount(invalid, FROM)).balance, 1000n);
  assert.equal((await getAccount(invalid, FROM)).nonce, 7n);
  assert.deepEqual(invalid.stateManager.snapshotChanges().accounts, []);
});

test('caught child value revert restores child balance/storage and keeps successful parent native value', async () => {
  const callWith40 = '6000600060006000602873' + CHILD.slice(2) + '61c350f1';
  const returnFlagAndBalances = '6000524760205273' + CHILD.slice(2) + '3160405260606000f3';
  const f = await fixture('0x6037600055' + callWith40 + returnFlagAndBalances, { [CHILD]: account('0x602a60005560006000fd', '20') });
  f.request.value = '100';
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  assert.deepEqual(returnedWords(result), [0n, 100n, 20n]);
  assert.equal((await getAccount(f, FROM)).balance, 900n);
  assert.equal((await getAccount(f, FROM)).nonce, 8n);
  assert.equal((await getAccount(f, TO)).balance, 100n);
  assert.equal((await getAccount(f, CHILD)).balance, 20n);
  assert.equal(await getStorage(f, TO), 55n);
  assert.equal(await getStorage(f, CHILD), 7n);
  assert.equal(result.trace.calls.length, 1);
  assert.deepEqual([result.trace.calls[0].type, result.trace.calls[0].from, result.trace.calls[0].to, result.trace.calls[0].value, result.trace.calls[0].error], ['CALL', TO, CHILD, '0x28', 'revert']);
  assert.deepEqual(result.logs, []);
});

test('existing destination delegation executes in authority storage after Prague and is invalid before activation', async () => {
  const implementationCode = '0x602a60005530600052336020523460405260005460605260806000f3';
  for (const [timestamp, activated] of [['1746612310', false], ['1746612311', true]]) {
    const f = await fixture('0xef0100' + IMPLEMENTATION.slice(2), { [IMPLEMENTATION]: account(implementationCode, '17', 99n) });
    f.header.timestamp = timestamp; f.request.value = '13';
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, activated ? 'success' : 'failed');
    assert.equal((await getAccount(f, FROM)).nonce, 8n);
    assert.equal(await getStorage(f, IMPLEMENTATION), 99n);
    assert.equal((await getAccount(f, IMPLEMENTATION)).balance, 17n);
    assert.equal(result.trace.to, TO);
    if (activated) {
      assert.deepEqual(returnedWords(result), [BigInt(TO), BigInt(FROM), 13n, 42n]);
      assert.equal(await getStorage(f, TO), 42n);
      assert.equal((await getAccount(f, TO)).balance, 13n);
      assert.equal((await getAccount(f, FROM)).balance, 987n);
    } else {
      assert.equal(result.execution.error, 'invalid opcode');
      assert.equal(result.gasAccounting.gasUsed, f.request.gas);
      assert.equal(await getStorage(f, TO), 7n);
      assert.equal((await getAccount(f, TO)).balance, 0n);
      assert.equal((await getAccount(f, FROM)).balance, 1000n);
    }
    assert.equal(result.profile.outerSignatureVerified, false);
  }
});

for (const [offset, inRange] of [[-1n, true], [-256n, true], [0n, false], [1n, false], [-257n, false]]) {
  test(`BLOCKHASH N${offset >= 0n ? '+' : ''}${offset} uses ${inRange ? 'the exact supplied hash' : 'zero without consulting the adapter'}`, async () => {
    const target = BigInt(HEADER.number) + offset;
    const f = await fixture('0x63' + target.toString(16).padStart(8, '0') + '4060005260206000f3');
    const expected = word(123456n + target), reads = [];
    f.blockchain = { async getBlock(number) {
      reads.push(number);
      assert.ok(inRange, 'out-of-range BLOCKHASH must not read an adapter');
      assert.equal(number, Number(target));
      return { hash: () => hexToBytes(expected) };
    } };
    const result = await executeEthereumCall(f);
    assert.equal(result.execution.status, 'success');
    assert.equal(result.execution.returnData, inRange ? expected : word(0));
    assert.deepEqual(reads, inRange ? [Number(target)] : []);
    assert.equal(result.profile.sourceBlockIdentityVerified, false);
  });
}

test('an in-range BLOCKHASH without supplied ancestry remains unsupported and rolls back nonce', async () => {
  const target = BigInt(HEADER.number) - 1n;
  const f = await fixture('0x63' + target.toString(16).padStart(8, '0') + '4060005260206000f3');
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'unsupported');
  assert.equal(result.execution.error.code, 'LOCAL_BLOCKHASH_MISSING');
  assert.equal(result.stateDisposition, 'rolled_back');
  assert.equal((await getAccount(f, FROM)).nonce, 7n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
});
