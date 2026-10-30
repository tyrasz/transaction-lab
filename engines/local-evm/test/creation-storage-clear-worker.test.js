// Real proof-backed worker execution. These controls do not compare a shared
// EthereumJS implementation or claim independent-client agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { feeFixture } from './fee-fixture.js';
import { amsterdamExecutionFixture, amsterdamStorageCollisionFixture,
  TX_SENDER, TARGET, HELPER,
  STORAGE_SENTINEL_INIT, STORAGE_SENTINEL_RUNTIME, storageOnlyAccount,
  initcode, factoryCode, createdAddress, callBytes, account, code, slot, word,
} from './amsterdam-storage-collision-fixture.js';

const BASIS = 'contract_creation_storage_clear';
const REVERT = '60006000fd';
const raw = (f, options = {}) => executeEthereumCall({ request: f.request, header: f.header,
  chainId: f.chainId ?? 1, stateManager: f.stateManager, blockchain: f.inputs.blockchain, ...options });
function trackClear(f) {
  const calls = [], clear = f.stateManager.clearStorageForContractCreation.bind(f.stateManager);
  f.stateManager.clearStorageForContractCreation = async (address, options) => {
    calls.push({ address: address.toString(), options });
    return clear(address, options);
  };
  return calls;
}
async function fixture({ fork = 'amsterdam', kind = 'CREATE2', root = false,
  init = STORAGE_SENTINEL_INIT, collision = 'storage', targetOverride = {}, tail, ...options } = {}) {
  const creator = root ? TX_SENDER : TARGET, nonce = root ? 1n : 7n;
  const target = createdAddress({ creator, nonce, kind: root ? 'CREATE' : kind, init });
  const initial = collision === 'absent' ? null : {
    ...storageOnlyAccount(), ...(collision === 'empty' ? { storage: {} } : {}), ...targetOverride,
  };
  const base = fork === 'amsterdam' ? amsterdamExecutionFixture : feeFixture;
  const f = await base({ ...(fork === 'amsterdam' ? {} : { fork }),
    ...(root ? { to: null, data: '0x' + init, value: '5' }
      : { target: { nonce: 7n, balance: 1000n, code: factoryCode(init, { kind, value: 5, ...(tail ? { tail } : {}) }) } }),
    ...options, accounts: { ...(initial ? { [target]: initial } : {}), ...options.accounts },
  });
  return { ...f, creationTarget: target, creator, initial };
}
async function unchangedTarget(f) {
  const a = await account(f.stateManager, f.creationTarget);
  assert.equal(a.nonce, f.initial.nonce); assert.equal(a.balance, f.initial.balance);
  assert.equal(await code(f.stateManager, f.creationTarget), f.initial.code);
  for (const [key, value] of Object.entries(f.initial.storage)) assert.equal(await slot(f.stateManager, f.creationTarget, BigInt(key)), value);
  assert.equal(f.stateManager.snapshotChanges().accounts.some(row => row.address === f.creationTarget), false);
}

test('Amsterdam root CREATE and internal CREATE/CREATE2 clear authenticated storage and preserve prefunding', async () => {
  for (const priced of [false, true]) for (const mode of ['root', 'CREATE', 'CREATE2']) {
    const f = await fixture({ root: mode === 'root', kind: mode === 'CREATE2' ? mode : 'CREATE', priced });
    // A previously cached old value must not become the constructor's SSTORE
    // original value, and hidden slot991 must never need an old storage proof.
    await f.stateManager.originalStorageCache.get(createAddressFromString(f.creationTarget), Uint8Array.from(Buffer.from(word(0).slice(2), 'hex')));
    const initialRoot = bytesToHex((await account(f.stateManager, f.creationTarget)).storageRoot), reads = f.calls.length;
    const clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
    assert.deepEqual(clear, [{ address: f.creationTarget, options: { mode: 'ethereum_nonce_code_collision' } }]);
    assert.equal((await account(f.stateManager, f.creationTarget)).nonce, 1n);
    assert.equal((await account(f.stateManager, f.creationTarget)).balance, 22n);
    assert.equal(await code(f.stateManager, f.creationTarget), '0x' + STORAGE_SENTINEL_RUNTIME);
    for (const key of [0, 1, 991]) assert.equal(await slot(f.stateManager, f.creationTarget, key), 0n);
    assert.equal(await slot(f.stateManager, f.creationTarget, 2), 42n);
    assert(f.calls.slice(reads).filter(c => c.params[0] === f.creationTarget).every(c => c.method === 'eth_getProof' && c.params[1].length === 0));
    const row = f.stateManager.snapshotChanges().accounts.find(row => row.address === f.creationTarget);
    assert.deepEqual(row.reset, { basis: BASIS, initialStorageRoot: initialRoot });
    assert.deepEqual(row.storage, [{ slot: word(2), before: word(0), after: word(42) }]);
    assert.equal(output.feeAccounting !== undefined, priced);
    if (mode !== 'root') {
      const entry = output.trace.creationAttempts[0];
      assert.equal(entry.disposition, 'entered'); assert.equal(entry.targetBefore.storageRoot, initialRoot);
      assert.equal(entry.result, '0x' + BigInt(f.creationTarget).toString(16));
      assert.equal(Object.hasOwn(output.trace.calls[0], 'creationSalt'), false);
    }
  }
});

test('Shanghai through Osaka use the same clear route and bind historical CREATE2 salt only to its frame', async () => {
  for (const fork of ['shanghai', 'cancun', 'prague', 'osaka']) for (const mode of ['root', 'CREATE', 'CREATE2']) {
    const f = await fixture({ fork, root: mode === 'root', kind: mode === 'CREATE2' ? mode : 'CREATE' });
    const clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, 'success', JSON.stringify(output.execution)); assert.equal(clear.length, 1);
    assert.equal(await slot(f.stateManager, f.creationTarget, 991), 0n);
    assert.equal(await slot(f.stateManager, f.creationTarget, 1), 0n);
    assert.equal(await slot(f.stateManager, f.creationTarget, 2), 42n);
    const frame = mode === 'root' ? output.trace : output.trace.calls[0];
    assert.equal(frame.to, f.creationTarget); assert.equal(Object.hasOwn(output.trace, 'creationSalt'), false);
    if (mode === 'CREATE2') assert.equal(frame.creationSalt, word(123));
    else assert.equal(Object.hasOwn(frame, 'creationSalt'), false);
    assert.equal(Object.hasOwn(frame, 'creationAttempts'), false);
  }
});

test('empty and absent targets keep the ordinary clear method without reset provenance', async () => {
  for (const root of [false, true]) for (const collision of ['absent', 'empty']) {
    const f = await fixture({ root, collision }), clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, 'success', JSON.stringify(output.execution)); assert.equal(clear.length, 0);
    assert.equal((await account(f.stateManager, f.creationTarget)).balance, collision === 'empty' ? 22n : 5n);
    assert.equal(f.stateManager.snapshotChanges().accounts.find(row => row.address === f.creationTarget).reset, undefined);
    assert.equal(await slot(f.stateManager, f.creationTarget, 2), 42n);
  }
});

test('a previously deleted target keeps its authenticated reset namespace and uses the ordinary clear route', async () => {
  const f = await fixture({ fork: 'shanghai', targetOverride: { code: '0x73' + HELPER.slice(2) + 'ff' } });
  const clear = trackClear(f), initialRoot = bytesToHex((await account(f.stateManager, f.creationTarget)).storageRoot);
  const deletion = await raw(f, { request: { ...f.request, to: f.creationTarget, data: '0x', value: '0' } });
  assert.equal(deletion.execution.status, 'success', JSON.stringify(deletion.execution));
  assert.equal(await account(f.stateManager, f.creationTarget), undefined);
  const output = await raw(f);
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution)); assert.equal(clear.length, 0);
  assert.equal((await account(f.stateManager, f.creationTarget)).balance, 5n);
  assert.equal(await slot(f.stateManager, f.creationTarget, 991), 0n);
  assert.equal(await slot(f.stateManager, f.creationTarget, 2), 42n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(row => row.address === f.creationTarget).reset,
    { basis: 'shanghai_selfdestruct_deletion', initialStorageRoot: initialRoot });
});

test('constructor failure restores the old namespace while retaining only the caller creation increment', async () => {
  for (const mode of ['root', 'CREATE', 'CREATE2']) for (const failure of [REVERT, 'fe']) {
    const f = await fixture({ root: mode === 'root', kind: mode === 'CREATE2' ? mode : 'CREATE', init: '602a600255' + failure });
    const clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, mode === 'root' ? (failure === REVERT ? 'reverted' : 'failed') : 'success', JSON.stringify(output.execution));
    assert.equal(clear.length, 1); await unchangedTarget(f);
    assert.equal((await account(f.stateManager, f.creator)).nonce, mode === 'root' ? 2n : 8n);
    const frame = mode === 'root' ? output.trace : output.trace.calls[0];
    assert.equal(frame.error, failure === REVERT ? 'revert' : 'invalid opcode');
    if (mode !== 'root') assert.equal(output.trace.creationAttempts[0].result, '0x0');
  }
});

test('an enclosing REVERT restores cleared storage, code, endowment and creator nonce even when caught', async () => {
  for (const caught of [false, true]) {
    const creator = caught ? HELPER : TARGET;
    const f = await amsterdamStorageCollisionFixture({ creator, init: STORAGE_SENTINEL_INIT,
      tail: '50' + REVERT, ...(caught ? { accounts: { [TARGET]: { nonce: 7n, balance: 1000n, code: '0x' + callBytes(HELPER) + '00' } } } : {}) });
    f.creationTarget = f.collisionAddress; f.initial = storageOnlyAccount();
    const clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, caught ? 'success' : 'reverted', JSON.stringify(output.execution));
    assert.equal(clear.length, 1); await unchangedTarget(f);
    assert.equal((await account(f.stateManager, creator)).nonce, 7n);
    assert.equal((await account(f.stateManager, creator)).balance, 1000n);
    assert.equal((caught ? output.trace.calls[0] : output.trace).error, 'revert');
  }
});

test('nonce and code collisions still fail before clear, without transferring endowment', async () => {
  for (const mode of ['root', 'CREATE', 'CREATE2']) for (const collision of ['nonce', 'code']) {
    const f = await fixture({ root: mode === 'root', kind: mode === 'CREATE2' ? mode : 'CREATE',
      targetOverride: collision === 'nonce' ? { nonce: 3n } : { code: '0x00' } });
    const clear = trackClear(f), output = await raw(f);
    assert.equal(output.execution.status, mode === 'root' ? 'failed' : 'success', JSON.stringify(output.execution));
    assert.equal(clear.length, 0); await unchangedTarget(f);
    if (mode === 'root') assert.equal(output.trace.error, 'create collision');
    else {
      assert.equal(output.trace.calls.length, 0); assert.equal(output.trace.creationAttempts[0].disposition, 'collision');
      assert.equal(output.trace.creationAttempts[0].result, '0x0');
    }
  }
});

test('proof/code host failure before or after clear is uncatchable and rolls back nonce, fees and namespace', async () => {
  for (const phase of ['target_proof', 'constructor_code']) {
    const init = initcode('00', '602a600255' + callBytes(HELPER));
    const f = await fixture({ init, accounts: { [HELPER]: { nonce: 1n, balance: 0n, code: '0x00' } } });
    const clear = trackClear(f), originalCall = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if ((phase === 'target_proof' && method === 'eth_getProof' && params[0] === f.creationTarget)
        || (phase === 'constructor_code' && method === 'eth_getCode' && params[0] === HELPER)) throw Error('synthetic unavailable proof input');
      return originalCall(method, params);
    };
    const output = await raw(f);
    assert.equal(output.execution.status, 'unavailable', JSON.stringify(output.execution));
    assert.equal(output.stateDisposition, 'rolled_back'); assert.equal(output.feeAccounting, undefined);
    assert.equal(output.execution.executionGasUsed, null); assert.equal(output.execution.returnData, null);
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
    assert.equal(clear.length, phase === 'target_proof' ? 0 : 1);
    // The failed collector intentionally refuses even cached public reads.
    // Inspect the restored in-memory checkpoint, without reviving that input
    // attempt or fetching new proof facts after an infrastructure failure.
    const current = f.stateManager.topAccountStack();
    assert.equal(current.get(TX_SENDER).nonce, 1n);
    assert.equal(current.get(TX_SENDER).balance, 1000000000000n);
    assert.equal(current.get(TARGET).nonce, 7n);
    if (phase === 'constructor_code') {
      assert.equal(current.get(f.creationTarget).nonce, 0n);
      assert.equal(current.get(f.creationTarget).balance, 17n);
      assert.equal(bytesToHex(current.get(f.creationTarget).storageRoot), f.stateManager.base.get(f.creationTarget).storageRoot);
      assert.equal(bytesToHex(f.stateManager.topCodeStack().get(f.creationTarget)), '0x');
      assert.equal([...f.stateManager.topStorageStack().keys()].some(key => key.startsWith(f.creationTarget + '_')), false);
    }
  }
});

test('adapter rejection after a completed clear is latched and unwinds the pending creation binding', async () => {
  const f = await fixture(), clear = f.stateManager.clearStorageForContractCreation.bind(f.stateManager);
  let reached = false;
  f.stateManager.clearStorageForContractCreation = async (...args) => {
    await clear(...args); reached = true; throw Error('synthetic host failure after namespace clear');
  };
  const output = await raw(f);
  assert.equal(reached, true); assert.equal(output.execution.status, 'unavailable');
  assert.equal(output.stateDisposition, 'rolled_back'); assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  assert.equal(output.feeAccounting, undefined); await unchangedTarget(f);
  assert.equal((await account(f.stateManager, TX_SENDER)).nonce, 1n);
  assert.equal((await account(f.stateManager, TARGET)).nonce, 7n);
});
