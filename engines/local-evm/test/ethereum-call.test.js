import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { ethereumCommon, ethereumCallGas, ethereumUsedGas } from '../ethereum-profile.js';
import { createRecordedStateManager } from '../recorded-state.js';

const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const FROM = addr(0x1111), TO = addr(0x2222);
const HEADER = { number: '20000000', timestamp: '1746612311', gasLimit: '30000000', baseFeePerGas: '17', mixHash: word(9), miner: addr(0x5555), parentHash: word(99), hash: word(100), stateRoot: word(101) };
const account = (code = '0x', balance = '0') => ({ exists: true, nonce: '1', balance, code, storage: { [word(0)]: word(7), [word(1)]: word(8) } });
async function fixture(code = '0x00', additions = {}) {
  return { request: { from: FROM, to: TO, data: '0x', value: '0', gas: '100000' }, header: structuredClone(HEADER), stateManager: await createRecordedStateManager({ accounts: { [FROM]: { ...account('0x', '1000'), nonce: '7' }, [TO]: account(code), ...additions } }) };
}
const current = (f, address = FROM) => f.stateManager.getAccount(createAddressFromString(address));

test('fork selection uses activation timestamps, never the library default', () => {
  for (const [timestamp, hardfork] of [['1681338455', 'shanghai'], ['1710338134', 'shanghai'], ['1710338135', 'cancun'], ['1746612310', 'cancun'], ['1746612311', 'prague'], ['1764798551', 'osaka'], ['1765290071', 'bpo1'], ['1767747671', 'bpo2']]) assert.equal(ethereumCommon({ ...HEADER, timestamp }).hardfork(), hardfork);
  assert.throws(() => ethereumCommon({ number: '17000000', timestamp: '1681338454' }), /Shanghai through BPO2/);
});

test('zero message gas permits an ordinary 21000-gas ETH transfer without a root CALL surcharge', async () => {
  const f = await fixture('0x'); f.request.gas = '21000'; f.request.value = '123';
  const r = await executeEthereumCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(r.execution.executionGasUsed, '0'); assert.equal(r.gasAccounting.gasUsed, '21000');
  assert.equal((await current(f)).balance, 877n); assert.equal((await current(f, TO)).balance, 123n); assert.equal((await current(f)).nonce, 8n);
  assert.equal(r.profile.feesSettled, false); assert.equal(r.profile.sourceStateProofVerified, false); assert.equal(r.profile.sourceBlockIdentityVerified, false);
});

test('Prague calldata floor changes envelope admission and reported gas, not the message gas subtraction', async () => {
  const data = '0x' + '01'.repeat(10), f = await fixture(); f.request.data = data; f.request.gas = '21400';
  const r = await executeEthereumCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(r.profile.intrinsicGas, '21160'); assert.equal(r.profile.calldataFloor, '21400'); assert.equal(r.profile.messageGasLimit, '240');
  assert.equal(r.gasAccounting.gasUsed, '21400'); assert.equal(r.gasAccounting.floorAdjustment, '240');
  const rejected = await fixture(); rejected.request.data = data; rejected.request.gas = '21399';
  assert.equal((await executeEthereumCall(rejected)).execution.status, 'invalid'); assert.equal((await current(rejected)).nonce, 7n);
  const old = await fixture(); old.header.timestamp = '1710338135'; old.request.data = data; old.request.gas = '21160';
  const previous = await executeEthereumCall(old); assert.equal(previous.execution.status, 'success'); assert.equal(previous.gasAccounting.gasUsed, '21160'); assert.equal(previous.profile.calldataFloor, '0');
});

test('actual SSTORE refunds are capped at one fifth and the calldata floor is applied afterward', async () => {
  const f = await fixture('0x6000600055600060015500'); f.request.data = '0x' + '01'.repeat(100);
  const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'success'); assert.equal(r.execution.executionGasUsed, '10012'); assert.equal(r.execution.gasRefundCounter, '9600');
  // 22600 intrinsic + 10012 execution =32612; floor(32612/5)=6522.
  assert.deepEqual(r.gasAccounting, { beforeRefund: '32612', appliedRefund: '6522', floorAdjustment: '0', gasUsed: '26090' });
  const floor = await fixture('0x600060005500'); floor.request.data = '0x' + '01'.repeat(100);
  const floorResult = await executeEthereumCall(floor);
  assert.equal(floorResult.execution.gasRefundCounter, '4800'); assert.equal(floorResult.gasAccounting.gasUsed, '25000'); assert.equal(floorResult.gasAccounting.floorAdjustment, '2194');
});

test('insufficient native balance and max nonce are invalid before nonce or storage mutation', async () => {
  const f = await fixture('0x602a60005500'); f.request.value = '1001';
  const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'invalid'); assert.equal(r.execution.error.code, 'LOCAL_CALL_INSUFFICIENT_BALANCE'); assert.equal(r.stateDisposition, 'unchanged'); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  const max = await fixture('0x00', { [FROM]: { ...account('0x', '1000'), nonce: ((1n << 64n) - 1n).toString() } });
  const overflow = await executeEthereumCall(max); assert.equal(overflow.execution.status, 'invalid'); assert.equal(overflow.execution.error.code, 'LOCAL_CALL_NONCE_OVERFLOW'); assert.deepEqual(max.stateManager.snapshotChanges().accounts, []);
});

test('value and SSTORE roll back on real REVERT, while the completed call retains one nonce increment', async () => {
  const f = await fixture('0x602a60005560006000fd'); f.request.value = '100';
  const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'reverted'); assert.equal((await current(f)).balance, 1000n); assert.equal((await current(f, TO)).balance, 0n); assert.equal((await current(f)).nonce, 8n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]); assert.equal(r.gasAccounting.appliedRefund, '0');
});

test('CHAINID and header opcodes reflect mainnet and explicit unpriced context', async () => {
  const f = await fixture('0x46600052486020523a604052426060524460805260a06000f3');
  const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'success');
  const values = Array.from({ length: 5 }, (_, i) => BigInt('0x' + r.execution.returnData.slice(2 + i * 64, 66 + i * 64)));
  assert.deepEqual(values, [1n, 0n, 0n, 1746612311n, 9n]); assert.equal(r.profile.actualBlockBaseFee, '17'); assert.equal(r.environment.hardfork, 'prague');
});

test('new fork precompiles are warm only after their activation', async () => {
  for (const [target, oldTime, newTime] of [[addr(11), '1710338135', '1746612311'], [addr(256), '1746612311', '1764798551']]) {
    const values = [];
    for (const timestamp of [oldTime, newTime]) {
      const f = await fixture('0x73' + target.slice(2) + '315000', { [target]: account() }); f.header.timestamp = timestamp;
      const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'success'); values.push(r.execution.executionGasUsed);
    }
    assert.deepEqual(values, ['2605', '105']);
  }
});

test('HyperEVM reserved addresses are ordinary mainnet addresses', async () => {
  const target = addr(0x800), f = await fixture('0x', { [target]: account('0x602a60005260206000f3') }); f.request.to = target;
  const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(42));
});

test('Osaka CLZ executes only after the fork and a pre-fork invalid opcode consumes message gas', async () => {
  for (const [timestamp, success] of [['1746612311', false], ['1764798551', true]]) {
    const f = await fixture('0x60011e60005260206000f3'); f.header.timestamp = timestamp;
    const r = await executeEthereumCall(f);
    assert.equal(r.execution.status, success ? 'success' : 'failed');
    if (success) assert.equal(r.execution.returnData, word(255)); else assert.equal(r.gasAccounting.gasUsed, '100000');
  }
});

test('code-bearing sender and lifecycle operations remain explicit unsupported outcomes with no retained writes', async () => {
  const sender = await fixture('0x00', { [FROM]: account('0xef0100' + TO.slice(2), '1000') });
  const r = await executeEthereumCall(sender); assert.equal(r.execution.status, 'unsupported'); assert.equal(r.execution.error.code, 'LOCAL_SENDER_CODE_UNSUPPORTED'); assert.deepEqual(sender.stateManager.snapshotChanges().accounts, []);
  const lifecycle = await fixture('0x600060006000f0'); const failed = await executeEthereumCall(lifecycle); assert.equal(failed.execution.status, 'unsupported'); assert.deepEqual(lifecycle.stateManager.snapshotChanges().accounts, []);
});

test('unsupported transaction extras and malformed inputs are rejected before state reads', async () => {
  for (const change of [f => { f.request.accessList = [{ address: TO, storageKeys: ['0x1'] }]; }, f => { f.request.authorizationList = []; }, f => { f.request.blobVersionedHashes = []; }, f => { f.request.value = '-1'; }, f => { f.request.gas = '0x00'; }, f => { delete f.header.stateRoot; }, f => { f.request.to = null; }]) {
    const f = await fixture(); change(f); const r = await executeEthereumCall(f); assert.equal(r.execution.status, 'invalid'); assert.equal(f.stateManager.snapshotReads().total, 0); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  }
});

test('gas rules preserve byte classes and refund/floor boundary exactly without floating point', () => {
  const costs = ethereumCallGas('0x00010200', ethereumCommon(HEADER)); assert.deepEqual(costs, { zeroBytes: 2n, nonzeroBytes: 2n, intrinsic: 21040n, floor: 21100n, minimum: 21100n });
  assert.deepEqual(ethereumUsedGas({ messageGasUsed: 100n, refundCounter: 100000n, intrinsic: 21040n, floor: 21100n }), { beforeRefund: 21140n, appliedRefund: 4228n, floorAdjustment: 4188n, gasUsed: 21100n });
});

test('access-list occurrences charge intrinsic gas while warming deduplicates and never prefetches unused facts', async () => {
  const cold=await fixture('0x60005400'),warm=await fixture('0x60005400');
  warm.request.accessList=[{address:TO,storageKeys:[word(0),word(0)]},{address:TO,storageKeys:[word(0)]},{address:addr(0x7777),storageKeys:[]}];
  const a=await executeEthereumCall(cold),b=await executeEthereumCall(warm);
  assert.equal(a.execution.executionGasUsed,'2103');assert.equal(b.execution.executionGasUsed,'103');
  assert.equal(b.profile.accessListAddressCount,'3');assert.equal(b.profile.accessListStorageKeyCount,'3');assert.equal(b.profile.accessListIntrinsicGas,'12900');assert.equal(b.profile.intrinsicGas,'33900');
  assert.deepEqual(b.profile.accessList,warm.request.accessList);assert.equal(b.gasAccounting.gasUsed,'34003');
  assert.equal(warm.stateManager.snapshotReads().reads.some(x=>x.address===addr(0x7777)),false);
  delete warm.request.accessList;const again=await executeEthereumCall(warm);assert.equal(again.execution.executionGasUsed,'2103');assert.equal(Object.hasOwn(again.profile,'accessList'),false);
});

test('declared warming survives nested REVERT and is scoped to each new execution', async()=>{
 const target=addr(0x3333),invoke='6000600060006000600073'+target.slice(2)+'61fffff150';
 const results=[];for(const warm of [false,true]){
  const f=await fixture('0x'+invoke+invoke+'00',{[target]:account('0x6000545060006000fd')});
  if(warm)f.request.accessList=[{address:target,storageKeys:[word(0)]}];
  const r=await executeEthereumCall(f);assert.equal(r.execution.status,'success');assert.equal(r.trace.calls.length,2);
  assert(r.trace.calls.every(x=>x.error==='revert'));results.push(r.trace.calls.map(x=>BigInt(x.gasUsed)));
 }
 assert.equal(results[0][0],results[0][1]);assert.equal(results[1][0],results[1][1]);assert.equal(results[0][0]-results[1][0],2000n);
});

test('declared blob context exposes ordered hashes, bounded index zero and synthetic blob base fee',async()=>{
 const hashes=Array.from({length:32},(_,i)=>'0x01'+BigInt(i+1).toString(16).padStart(62,'0'));
 const f=await fixture('0x600049600052601f49602052602049604052607f496060524a60805260a06000f3');
 f.header.excessBlobGas='173922672';f.request.blobVersionedHashes=hashes;
 const r=await executeEthereumCall(f);assert.equal(r.execution.status,'success');
 assert.equal(r.execution.returnData,'0x'+[hashes[0],hashes[31],word(0),word(0),word(0)].map(x=>x.slice(2)).join(''));
 assert.deepEqual(r.profile.blobVersionedHashes,hashes);assert.equal(r.profile.executionBlobBaseFee,'0');assert.equal(r.profile.sourceExcessBlobGas,'173922672');assert.equal(r.profile.intrinsicGas,'21000');
 assert.equal(r.profile.feesSettled,false);assert.equal(Object.hasOwn(r.profile,'accessList'),false);
});

test('blob transaction context propagates through nested calls without enabling KZG or implicit BLOBBASEFEE',async()=>{
 const target=addr(0x3333),hash='0x01'+'ab'.repeat(31),invoke='6020600060006000600073'+target.slice(2)+'61fffff15060206000f3';
 const f=await fixture('0x'+invoke,{[target]:account('0x60004960005260206000f3')});f.header.excessBlobGas='0';f.request.blobVersionedHashes=[hash];
 const r=await executeEthereumCall(f);assert.equal(r.execution.status,'success');assert.equal(r.execution.returnData,hash);assert.equal(r.trace.calls[0].output,hash);
 const missing=await fixture('0x4a00');const noFee=await executeEthereumCall(missing);assert.equal(noFee.execution.status,'unsupported');assert.equal(noFee.execution.error.code,'LOCAL_BLOB_UNSUPPORTED');assert.deepEqual(missing.stateManager.snapshotChanges().accounts,[]);
 const kzg=await fixture('0x00');kzg.request.to=addr(10);kzg.request.blobVersionedHashes=[hash];kzg.header.excessBlobGas='0';const bad=await executeEthereumCall(kzg);assert.equal(bad.execution.status,'unsupported');assert.deepEqual(kzg.stateManager.snapshotChanges().accounts,[]);
});

test('access intrinsic and blob fork/header validity reject before state reads',async()=>{
 for(const change of [f=>{f.request.accessList=[{address:TO,storageKeys:[word(0)]}];f.request.gas='25299';},f=>{f.request.blobVersionedHashes=['0x01'+'00'.repeat(31)];},f=>{f.request.blobVersionedHashes=['0x01'+'00'.repeat(31)];f.header.excessBlobGas='0';f.header.timestamp='1681338455';},f=>{f.request.blobVersionedHashes=['0x01'+'00'.repeat(31)];f.header.excessBlobGas=(1n<<64n).toString();}]){
  const f=await fixture();change(f);const r=await executeEthereumCall(f);assert.equal(r.execution.status,'invalid');assert.equal(f.stateManager.snapshotReads().total,0);assert.deepEqual(f.stateManager.snapshotChanges().accounts,[]);
 }
});


test('Ethereum BLOBHASH without declared blobs returns zero for all tested uint256 indexes at three opcode gas', async () => {
  for (const index of ['6000', '6001', '7f' + 'ff'.repeat(32)]) {
    const f = await fixture('0x' + index + '4960005260206000f3');
    const r = await executeEthereumCall(f);
    assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(0));
    // PUSH index + BLOBHASH + PUSH offset + MSTORE + memory expansion + two PUSHes.
    assert.equal(r.execution.executionGasUsed, '21'); assert.equal(r.gasAccounting.gasUsed, '21021');
    assert.equal(Object.hasOwn(r.profile, 'blobVersionedHashes'), false);
    assert.equal(Object.hasOwn(r.profile, 'executionBlobBaseFee'), false);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]);
  }
});

test('non-blob BLOBHASH obeys Cancun activation rather than enabling a pre-fork opcode', async () => {
  for (const [timestamp, status] of [['1710338134', 'failed'], ['1710338135', 'success']]) {
    const f = await fixture('0x60004960005260206000f3'); f.header.timestamp = timestamp;
    const r = await executeEthereumCall(f); assert.equal(r.execution.status, status);
    if (status === 'success') assert.equal(r.execution.returnData, word(0));
    else { assert.equal(r.execution.error, 'invalid opcode'); assert.equal(r.gasAccounting.gasUsed, f.request.gas); }
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]);
  }
});

test('CALL, DELEGATECALL and STATICCALL inherit an empty blob-hash list without extra input state', async () => {
  const target = addr(0x3333), code = '0x60004960005260206000f3';
  for (const [opcode, type] of [['f1', 'CALL'], ['f4', 'DELEGATECALL'], ['fa', 'STATICCALL']]) {
    const invoke = '6020600060006000' + (opcode === 'f1' ? '6000' : '') + '73' + target.slice(2) + '61ffff' + opcode;
    const f = await fixture('0x' + invoke + '5060206000f3', { [target]: account(code) });
    const r = await executeEthereumCall(f);
    assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(0));
    assert.equal(r.trace.calls.length, 1); assert.equal(r.trace.calls[0].type, type);
    assert.equal(r.trace.calls[0].output, word(0)); assert.equal(r.trace.calls[0].gasUsed, '0x15');
    assert.equal(r.trace.calls[0].error, null);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]);
  }
});

test('non-blob BLOBHASH preserves ordinary REVERT and stack-fault rollback including transferred value', async () => {
  for (const [code, status, error] of [['0x60004960005560006000fd', 'reverted', 'revert'], ['0x602a60005549', 'failed', 'stack underflow']]) {
    const f = await fixture(code); f.request.value = '100';
    const r = await executeEthereumCall(f);
    assert.equal(r.execution.status, status); assert.equal(r.execution.error, error);
    assert.equal((await current(f)).balance, 1000n); assert.equal((await current(f, TO)).balance, 0n);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: FROM, nonce: { before: '0x7', after: '0x8' } }]);
    if (status === 'failed') assert.equal(r.gasAccounting.gasUsed, f.request.gas);
  }
});

test('unsupported non-blob BLOBBASEFEE after successful BLOBHASH rolls back storage, value and nonce', async () => {
  const f = await fixture('0x6000496000554a00'); f.request.value = '100';
  const r = await executeEthereumCall(f);
  assert.equal(r.execution.status, 'unsupported'); assert.equal(r.execution.error.code, 'LOCAL_BLOB_UNSUPPORTED');
  assert.equal(r.stateDisposition, 'rolled_back'); assert.equal(r.execution.returnData, null);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  assert.equal((await current(f)).balance, 1000n); assert.equal((await current(f)).nonce, 7n);
});
