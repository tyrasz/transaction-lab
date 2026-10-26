import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { executeUnsignedCall, EXECUTION_LIMITS } from '../execute.js';
import { createRecordedStateManager } from '../recorded-state.js';

// All programs below are synthetic deterministic EVM bytecode. Outputs are
// produced by EthereumJS executing these instructions, not RPC/expected stubs.
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const FROM = address(0x1111), TO = address(0x2222), CHILD = address(0x4444);
const BLOCK = { number: '100', timestamp: '1234', gasLimit: '3000000', baseFeePerGas: '17', mixHash: word(9), miner: address(0x5555), parentHash: word(99), hash: word(100) };
const existing = (code = '0x', storage = {}) => ({ exists: true, nonce: '1', balance: '0', code, storage });
async function fixture(code, childCode = '0x00') {
  const stateManager = await createRecordedStateManager({ accounts: {
    [FROM]: { ...existing(), nonce: '7', balance: '1000' },
    [TO]: existing(code, { [word(0)]: word(7) }),
    [CHILD]: existing(childCode, { [word(0)]: word(8) }),
  } });
  return { stateManager, request: { from: FROM, to: TO, data: '0x', value: '0', gasLimit: '100000' }, block: structuredClone(BLOCK) };
}
const nonce = async manager => (await manager.getAccount(createAddressFromString(FROM))).nonce;
const storage = async (manager, target = TO) => { const value = bytesToHex(await manager.getStorage(createAddressFromString(target), hexToBytes(word(0)))); return value === '0x' ? 0n : BigInt(value); };
const call = (target, opcode = 'f1', gas = 80000) => '6000600060006000' + (['f1', 'f2'].includes(opcode) ? '6000' : '') + '73' + target.slice(2) + '62' + gas.toString(16).padStart(6, '0') + opcode;
const emit = n => '60' + n.toString(16).padStart(2, '0') + '60005260' + n.toString(16).padStart(2, '0') + '60206000a1';
const assertRestored = async f => { assert.equal(await nonce(f.stateManager), 7n); assert.equal(await storage(f.stateManager), 7n); assert.equal(await storage(f.stateManager, CHILD), 8n); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []); };

test('real SSTORE/SLOAD return exact output and retain message state with nonce increment and no gas fee debit', async () => {
  const f = await fixture('0x602a60005560005460005260206000f3'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(42));
  assert.equal(await storage(f.stateManager), 42n); assert.equal(await nonce(f.stateManager), 8n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(FROM))).balance, 1000n);
  assert.ok(BigInt(r.execution.executionGasUsed) > 0n); assert.equal(r.execution.gasRefundCounter, '0');
  assert.equal(r.trace.gas, '0x186a0'); assert.equal(r.trace.gasUsed, '0x' + BigInt(r.execution.executionGasUsed).toString(16));
  assert.equal(r.semantics.kind, 'unsigned_message'); assert.equal(r.semantics.signatureVerification, false); assert.equal(r.semantics.feeSettlement, false);
  assert.match(r.semantics.gasBudget, /intrinsic_transaction_gas_not_subtracted/); assert.equal(r.environment.hardfork, 'cancun');
  assert.equal(r.environment.chainId, 999); assert.equal(r.environment.sourceBlockIdentityVerified, false);
  assert.equal(r.stateDisposition, 'message_result_retained_in_supplied_manager');
});

test('root REVERT returns actual revert bytes and restores storage while retaining the runCall nonce', async () => {
  const f = await fixture('0x602a60005560ab60005260206000fd'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'reverted'); assert.equal(r.execution.error, 'revert'); assert.equal(r.execution.returnData, word(171));
  assert.equal(await storage(f.stateManager), 7n); assert.equal(await nonce(f.stateManager), 8n); assert.deepEqual(r.logs, []);
});

test('caught child revert rolls back its writes and logs while parent executes and commits', async () => {
  const child = '0x602a600055' + emit(2) + '60006000fd';
  const f = await fixture('0x' + call(CHILD) + '506037600055' + emit(3) + '00', child), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(r.trace.calls.length, 1); assert.equal(r.trace.calls[0].error, 'revert');
  assert.equal(r.trace.calls[0].type, 'CALL'); assert.equal(r.trace.calls[0].from, TO); assert.equal(r.trace.calls[0].caller, TO);
  assert.equal(await storage(f.stateManager), 55n); assert.equal(await storage(f.stateManager, CHILD), 8n);
  assert.deepEqual(r.logs, [{ address: TO, topics: [word(3)], data: word(3) }]);
});

test('parent revert discards successful child logs/state and preserves failed root call tree', async () => {
  const f = await fixture('0x' + call(CHILD) + '5060006000fd', '0x602a600055' + emit(2) + '00');
  const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'reverted');
  assert.equal(r.trace.calls[0].error, null); assert.deepEqual(r.logs, []); assert.equal(await storage(f.stateManager, CHILD), 8n);
});

test('committed logs preserve execution order and repeated child emissions without ancestor duplication', async () => {
  const f = await fixture('0x' + emit(1) + call(CHILD) + '50' + call(CHILD) + '50' + emit(3) + '00', '0x' + emit(2) + '00');
  const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'success'); assert.equal(r.trace.calls.length, 2);
  assert.deepEqual(r.logs.map(log => [log.address, log.topics[0], log.data]), [[TO, word(1), word(1)], [CHILD, word(2), word(2)], [CHILD, word(2), word(2)], [TO, word(3), word(3)]]);
  assert.ok(r.trace.calls.every(frame => !Object.hasOwn(frame, 'logs')));
});

for (const [opcode, type] of [['f4', 'DELEGATECALL'], ['f2', 'CALLCODE']]) test(`real ${type} preserves code/execution address distinction and parent storage`, async () => {
  const f = await fixture('0x' + call(CHILD, opcode) + '5000', '0x602a60005500'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(await storage(f.stateManager), 42n); assert.equal(await storage(f.stateManager, CHILD), 8n);
  assert.deepEqual([r.trace.calls[0].type, r.trace.calls[0].from, r.trace.calls[0].to, r.trace.calls[0].executionAddress], [type, TO, CHILD, TO]);
  assert.equal(r.trace.calls[0].caller, opcode === 'f4' ? FROM : TO);
});

test('STATICCALL rejects child state mutation while parent handles failure', async () => {
  const f = await fixture('0x' + call(CHILD, 'fa') + '60005260206000f3', '0x602a60005500'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(0));
  assert.equal(r.trace.calls[0].type, 'STATICCALL'); assert.equal(r.trace.calls[0].error, 'static state change'); assert.equal(await storage(f.stateManager, CHILD), 8n);
});

test('header, sender, origin, value and GASPRICE instructions use the explicit Cancun environment', async () => {
  const f = await fixture('0x43600052426020524560405248606052446080524160a0524660c0523a60e0523361010052326101205234610140526101606000f3');
  f.request.value = '3'; const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'success');
  const values = Array.from({ length: 11 }, (_, i) => BigInt('0x' + r.execution.returnData.slice(2 + i * 64, 66 + i * 64)));
  assert.deepEqual(values, [100n, 1234n, 3000000n, 17n, 9n, BigInt(BLOCK.miner), 999n, 0n, BigInt(FROM), BigInt(FROM), 3n]);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(FROM))).balance, 997n);
  assert.equal((await f.stateManager.getAccount(createAddressFromString(TO))).balance, 3n);
});

test('real Cancun transient storage resets between independent message executions', async () => {
  const f = await fixture('0x3615600a57602a60005d5b60005c60005260206000f3');
  f.request.data = '0x01'; assert.equal((await executeUnsignedCall(f)).execution.returnData, word(42));
  f.request.data = '0x'; assert.equal((await executeUnsignedCall(f)).execution.returnData, word(0));
});

test('original SSTORE cache resets and raw refund counter is exposed without transaction refund settlement', async () => {
  const f = await fixture('0x600060005500');
  const first = await executeUnsignedCall(f), second = await executeUnsignedCall(f);
  assert.equal(first.execution.status, 'success'); assert.equal(first.execution.gasRefundCounter, '4800');
  assert.equal(second.execution.status, 'success'); assert.equal(second.execution.gasRefundCounter, '0');
  assert.ok(BigInt(second.execution.executionGasUsed) < BigInt(first.execution.executionGasUsed));
});

test('unknown slot reads fail closed after real execution and roll back prior writes and nonce', async () => {
  const f = await fixture('0x602a60005560015400'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'unavailable'); assert.equal(r.execution.error.code, 'LOCAL_STATE_MISSING');
  assert.equal(r.execution.returnData, null); assert.equal(r.execution.executionGasUsed, null); assert.equal(r.stateDisposition, 'rolled_back');
  await assertRestored(f);
});

test('unknown nested account input never becomes a successful empty-code call', async () => {
  const f = await fixture('0x' + call(address(0x7777)) + '5000'), r = await executeUnsignedCall(f);
  assert.equal(r.execution.status, 'unavailable'); assert.equal(r.execution.error.code, 'LOCAL_STATE_MISSING'); await assertRestored(f);
});

test('HyperCore reserved reads and CoreWriter are rejected at root and nested call/code forms, never as empty accounts', async () => {
  for (const target of [address(0x800), address(0x801), address(0x8ff), '0x3333333333333333333333333333333333333333']) {
    const f = await fixture('0x00'); f.request.to = target;
    const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'unsupported'); assert.equal(r.stateDisposition, 'unchanged'); await assertRestored(f);
    for (const opcode of ['f1', 'f2', 'f4', 'fa']) {
      const nested = await fixture('0x602a600055' + call(target, opcode) + '5000'), result = await executeUnsignedCall(nested);
      assert.equal(result.execution.status, 'unsupported'); assert.match(result.execution.error.code, /HYPERCORE|COREWRITER/); await assertRestored(nested);
    }
  }
});

test('CREATE, CREATE2 and SELFDESTRUCT are rejected before their lifecycle effects', async () => {
  for (const suffix of ['600060006000f0', '6000600060006000f5', '73' + FROM.slice(2) + 'ff']) {
    const f = await fixture('0x602a600055' + suffix), r = await executeUnsignedCall(f);
    assert.equal(r.execution.status, 'unsupported'); assert.equal(r.execution.error.code, 'LOCAL_LIFECYCLE_UNSUPPORTED'); await assertRestored(f);
  }
});

test('in-range BLOCKHASH requires explicit input and uses supplied hash without a mock-zero fallback', async () => {
  const f = await fixture('0x60634060005260206000f3'), missing = await executeUnsignedCall(f);
  assert.equal(missing.execution.status, 'unsupported'); assert.equal(missing.execution.error.code, 'LOCAL_BLOCKHASH_MISSING'); await assertRestored(f);
  const reads = [], r = await executeUnsignedCall({ ...f, blockchain: { async getBlock(number) { reads.push(number); return { hash: () => hexToBytes(word(99)) }; } } });
  assert.equal(r.execution.status, 'success'); assert.equal(r.execution.returnData, word(99)); assert.deepEqual(reads.map(BigInt), [99n]);
});

test('blob context and unavailable KZG precompile are explicit unsupported scope', async () => {
  for (const code of ['0x60004900', '0x4a00']) { const f = await fixture(code), r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'unsupported'); assert.equal(r.execution.error.code, 'LOCAL_BLOB_UNSUPPORTED'); await assertRestored(f); }
  const f = await fixture('0x00'); f.request.to = address(10);
  assert.equal((await executeUnsignedCall(f)).execution.status, 'unsupported'); await assertRestored(f);
});

test('ordinary EVM OOG remains a completed failed message, while step exhaustion rolls the entire attempt back', async () => {
  const f = await fixture('0x5b600056'); f.request.gasLimit = '1000';
  const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'failed'); assert.equal(r.execution.error, 'out of gas'); assert.equal(r.execution.executionGasUsed, '1000'); assert.equal(await nonce(f.stateManager), 8n);
  const limited = await fixture('0x5b600056'), result = await executeUnsignedCall({ ...limited, limits: { steps: 10 } });
  assert.equal(result.execution.status, 'unavailable'); assert.match(result.execution.error.message, /steps/); await assertRestored(limited);
});

test('frame/depth/log/memory/output/trace limits abort real programs and restore all state', async () => {
  const cases = [
    ['0x602a600055' + call(CHILD) + '5000', '0x00', { frames: 1 }],
    ['0x' + call(CHILD) + '5000', '0x' + call(TO) + '5000', { depth: 1 }],
    ['0x' + emit(1) + emit(2) + '00', '0x00', { logs: 1 }],
    ['0x600160805260006000f3', '0x00', { memoryBytes: 64 }],
    ['0x60206000f3', '0x00', { returnBytes: 16 }],
    ['0x00', '0x00', { traceBytes: 100 }],
  ];
  for (const [code, child, limits] of cases) {
    const f = await fixture(code, child), r = await executeUnsignedCall({ ...f, limits });
    assert.equal(r.execution.status, 'unavailable'); assert.equal(r.execution.error.code, 'LOCAL_RESOURCE_LIMIT'); await assertRestored(f);
    assert.deepEqual(r.logs, []);
  }
});

test('deadline expiration during execution is deterministic and restores nonce/state without sleeping', async () => {
  const f = await fixture('0x602a6000555b600556'); let time = 0;
  const r = await executeUnsignedCall({ ...f, limits: { wallMs: 30 }, now: () => time++ });
  assert.equal(r.execution.status, 'unavailable'); assert.match(r.execution.error.message, /wallMs/); await assertRestored(f);
});

test('trailing memory expansion is bounded even without a following opcode event', async () => {
  for (const child of [false, true]) {
    const trailingStore = '602a600055600161010052';
    const f = child ? await fixture('0x' + call(CHILD) + '5000', '0x' + trailingStore) : await fixture('0x' + trailingStore);
    const r = await executeUnsignedCall({ ...f, limits: { memoryBytes: 64 } });
    assert.equal(r.execution.status, 'unavailable'); assert.equal(r.execution.error.code, 'LOCAL_RESOURCE_LIMIT');
    assert.match(r.execution.error.message, /memoryBytes/); assert.equal(r.stateDisposition, 'rolled_back'); await assertRestored(f);
  }
});

test('final successful atomic commit remains coherently successful if the clock advances during commit', async () => {
  const f = await fixture('0x602a60005500'); let time = 0, commits = 0;
  const commit = f.stateManager.commit.bind(f.stateManager);
  f.stateManager.commit = async () => { await commit(); if (++commits === 2) time = 20000; };
  const r = await executeUnsignedCall({ ...f, now: () => time });
  assert.equal(commits, 2); assert.equal(r.execution.status, 'success'); assert.equal(r.stateDisposition, 'message_result_retained_in_supplied_manager');
  assert.equal(await storage(f.stateManager), 42n); assert.equal(await nonce(f.stateManager), 8n);
});

test('host error messages are sanitized and nested open checkpoints are fully unwound', async () => {
  const f = await fixture('0x602a600055' + call(CHILD) + '5000', '0x60005400');
  const getStorage = f.stateManager.getStorage.bind(f.stateManager);
  f.stateManager.getStorage = async (target, key) => { if (target.toString() === CHILD) throw new Error('PRIVATE_STATE_URL_SECRET'); return getStorage(target, key); };
  const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'unavailable'); assert.equal(r.stateDisposition, 'rolled_back'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_STATE_URL_SECRET/);
  f.stateManager.getStorage = getStorage; await assertRestored(f);
  assert.equal(f.stateManager.accountStack.length, 1);
});

test('validation never raises fixed resource ceilings or silently supplies incomplete environment/default manager', async () => {
  for (const mutate of [
    f => { f.limits = { gas: EXECUTION_LIMITS.gas + 1 }; }, f => { f.limits = { unknown: 1 }; },
    f => { f.request.gasLimit = '5000001'; }, f => { f.request.gasPrice = '0'; },
    f => { delete f.block.baseFeePerGas; }, f => { f.block.mixHash = ['0x00']; }, f => { f.request.data = '0x0'; },
  ]) { const f = await fixture('0x00'); mutate(f); const r = await executeUnsignedCall(f); assert.equal(r.execution.status, 'unavailable'); assert.equal(r.execution.error.code, 'LOCAL_INVALID_INPUT'); await assertRestored(f); }
  const f = await fixture('0x00'); const r = await executeUnsignedCall({ ...f, stateManager: undefined }); assert.equal(r.execution.error.code, 'LOCAL_INVALID_INPUT');
});
