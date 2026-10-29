import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { executeEthereumCall } from '../ethereum-call.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, RUNTIME, FACTORY, SENDER, bytes, word } from './lifecycle-fixture.js';

// These are synthetic authenticated inputs executed as real EVM bytecode.
// Expected addresses use the independent RLP/Keccak fixture derivation.
const address = createAddressFromString;
const storage = async (f, account, slot = 0) => BigInt(bytesToHex(await f.stateManager.getStorage(address(account), bytes(word(slot)))));
const account = (f, value) => f.stateManager.getAccount(address(value));

test('a constructor can create a second contract while preserving both initial absence proofs', async () => {
  const innerInit = initcode();
  const outerInit = factoryCode(innerInit, { value: 0, tail: '60005560006000f3' }).slice(2);
  const outer = createdAddress({ init: outerInit });
  const inner = createdAddress({ creator: outer, nonce: 1n, init: innerInit });
  const f = await lifecycleFixture({ code: factoryCode(outerInit) });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  const outerFrame = result.trace.calls[0], innerFrame = outerFrame.calls[0];
  assert.equal(outerFrame.type, 'CREATE');
  assert.equal(outerFrame.executionAddress, outer);
  assert.equal(innerFrame.type, 'CREATE');
  assert.equal(innerFrame.from, outer);
  assert.equal(innerFrame.executionAddress, inner);
  assert.equal(innerFrame.error, null);
  assert.equal((await account(f, FACTORY)).nonce, 8n);
  assert.equal((await account(f, outer)).nonce, 2n);
  assert.equal((await account(f, outer)).balance, 5n);
  assert.equal((await account(f, inner)).nonce, 1n);
  assert.equal((await account(f, inner)).balance, 0n);
  assert.equal(await storage(f, outer), BigInt(inner));
  assert.equal(await storage(f, inner), 42n);
  assert.equal(bytesToHex(await f.stateManager.getCode(address(outer))), '0x');
  assert.equal(bytesToHex(await f.stateManager.getCode(address(inner))), '0x' + RUNTIME);
  const inputs = f.stateManager.snapshotInputs(), changes = f.stateManager.snapshotChanges();
  for (const value of [outer, inner]) {
    assert.deepEqual(inputs.accounts[value], { exists: false });
    assert.deepEqual(changes.accounts.find(row => row.address === value).existence,
      { before: false, after: true, basis: 'internal_contract_creation' });
  }
});

test('a constructor executes the freshly deployed child runtime and reads its constructor storage', async () => {
  const innerInit = initcode();
  // Save CREATE's address, CALL it into memory[32:64], store its returned word.
  const tail = '6000526020602060006000600060005161fffff15060205160005560006000f3';
  const outerInit = factoryCode(innerInit, { value: 0, tail }).slice(2);
  const outer = createdAddress({ init: outerInit });
  const inner = createdAddress({ creator: outer, nonce: 1n, init: innerInit });
  const f = await lifecycleFixture({ code: factoryCode(outerInit) });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  const children = result.trace.calls[0].calls;
  assert.deepEqual(children.map(frame => frame.type), ['CREATE', 'CALL']);
  assert.equal(children[0].to, inner);
  assert.equal(children[1].to, inner);
  assert.equal(children[1].from, outer);
  assert.equal(children[1].error, null);
  assert.equal(children[1].output, word(42));
  assert.equal(await storage(f, outer), 42n);
  assert.equal(await storage(f, inner), 42n);
  assert.deepEqual(f.stateManager.snapshotInputs().accounts[inner], { exists: false });
  assert.equal(f.calls.filter(call => call.method === 'eth_getCode' && call.params[0] === inner).length, 0);
  const provenance = f.stateManager.snapshotInputs().provenance.find(row => row.account === inner);
  assert.equal(provenance.codeEvidenceId, null);
  assert.equal(provenance.codeDerivation, 'verified_account_absence');
});

test('an outer step limit removes a previously committed child deployment and all outer nonce changes', async () => {
  // CREATE ends at offset 17; POP then JUMPDEST(18), PUSH1 18, JUMP loops.
  const f = await lifecycleFixture({ code: factoryCode(initcode(), { tail: '505b601256' }) });
  const result = await executeEthereumCall({ ...f, limits: { steps: 100 } });
  assert.equal(result.execution.status, 'unavailable');
  assert.equal(result.execution.error.code, 'LOCAL_RESOURCE_LIMIT');
  assert.equal(result.trace.calls[0].error, null);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  assert.equal((await account(f, FACTORY)).nonce, 7n);
  assert.equal((await account(f, FACTORY)).balance, 1000n);
  assert.equal((await account(f, SENDER)).nonce, 1n);
  const target = createdAddress();
  assert.equal(await account(f, target), undefined);
  assert.equal(bytesToHex(await f.stateManager.getCode(address(target))), '0x');
  assert.equal(await storage(f, target), 0n);
  await assert.rejects(f.stateManager.putCode(address(target), bytes('0x00')), { code: 'LOCAL_STATE_UNSUPPORTED' });
});

test('CREATE2 collision with a nonempty initial storage root is an EVM failure without clearing that state', async () => {
  const init = initcode(), target = createdAddress({ kind: 'CREATE2', init });
  const f = await lifecycleFixture({
    code: factoryCode(init, { kind: 'CREATE2' }),
    accounts: { [target]: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(0)]: 9n } } },
  });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.returnData, word(0));
  assert.equal(result.trace.calls[0].error, 'create collision');
  assert.equal(result.trace.calls[0].to, target);
  assert.equal((await account(f, FACTORY)).nonce, 8n);
  assert.equal((await account(f, FACTORY)).balance, 1000n);
  assert.equal((await account(f, target)).nonce, 0n);
  assert.equal((await account(f, target)).balance, 17n);
  assert.equal(await storage(f, target), 9n);
  assert.equal(bytesToHex(await f.stateManager.getCode(address(target))), '0x');
  assert.equal(f.stateManager.snapshotChanges().accounts.some(row => row.address === target), false);
});

test('CREATE reached in STATICCALL remains an ordinary child fault with no creation or creator nonce change', async () => {
  const callee = '0x' + '44'.repeat(20);
  const code = '0x600060006000600073' + callee.slice(2) + '61fffffa60005260206000f3';
  const f = await lifecycleFixture({ code, accounts: { [callee]: { nonce: 1n, balance: 1000n, code: factoryCode(initcode()) } } });
  const result = await executeEthereumCall(f);
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.returnData, word(0));
  assert.equal(result.trace.calls.length, 1);
  assert.equal(result.trace.calls[0].type, 'STATICCALL');
  assert.equal(result.trace.calls[0].error, 'static state change');
  assert.deepEqual(result.trace.calls[0].calls, []);
  assert.equal((await account(f, callee)).nonce, 1n);
  assert.equal((await account(f, callee)).balance, 1000n);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
});
