// Real local bytecode over a retained proof-backed manager, checked after each
// transaction by the parent validator. Fixtures supply authenticated synthetic
// initial state only; no network or independent-client agreement is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumCall } from '../ethereum-call.js';
import { validateExecutionChanges } from '../execution-changes.js';
import { canonicalStateChanges } from '../preview-mutations.js';
import { validateInputFacts } from '../input-facts.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { feeFixture } from './fee-fixture.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { factoryCode, initcode, createdAddress } from './lifecycle-fixture.js';
import { resetFixture, request, account, storage, FACTORY, FUNDER, INSPECTOR, OLD_SLOT, UNREAD_SLOT, word } from './sequential-reset-fixture.js';
import { authorizationFixture, AUTHORITY, ZERO, signAuthorization } from './authorization-fixture.js';

async function step(f, transaction = f.request) {
  const startingChanges = canonicalStateChanges(f.stateManager.snapshotChanges());
  const chainId = f.chainId ?? 1, common = f.common ?? ethereumNetworkCommon(f.header, chainId);
  const output = await executeEthereumCall({ ...f, request: transaction, chainId });
  const inputs = f.inputs.snapshotInputs(), inputEvidence = f.inputs.snapshotEvidence();
  await validateInputFacts({ inputs, inputEvidence, stateRoot: f.header.stateRoot, chainId });
  const packet = { changes: f.stateManager.snapshotChanges(), startingChanges, inputs, output,
    sender: transaction.from, destination: transaction.to, request: transaction, header: f.header, common,
    selfdestructOnlyCreated: common.isActivatedEIP(6780) };
  assert.doesNotThrow(() => validateExecutionChanges(packet), `${common.hardfork()}: ${transaction.to} ${output.execution.status}`);
  return packet;
}

test('retained creation then later writes keep durable provenance and fresh transaction storage baselines', async () => {
  const runtime = '6000546001018060005560005260206000f3', init = initcode(runtime);
  const target = createdAddress({ init });
  for (const fork of ['osaka', 'amsterdam']) {
    const options = { to: FACTORY, accounts: { [FACTORY]: { nonce: 7n, balance: 1000n, code: factoryCode(init) } } };
    const f = fork === 'amsterdam' ? await amsterdamExecutionFixture({ ...options, priced: false })
      : await feeFixture({ ...options, fork, baseFee: 0n, maxFee: 0n, priorityFee: 0n });
    const creation = await step(f); assert.equal(creation.output.execution.status, 'success');
    const laterGas = [];
    for (const value of [43, 44]) {
      const later = await step(f, request(f, target)); assert.equal(later.output.execution.returnData, word(value));
      laterGas.push(later.output.execution.executionGasUsed);
      const row = later.changes.accounts.find(item => item.address === target);
      assert.equal(row.existence.basis, 'internal_contract_creation'); assert.equal(row.storage[0].before, word(0));
      assert.equal(row.storage[0].after, word(value));
    }
    // Both calls start with their own nonzero original value. A stale original
    // storage cache would misclassify the second SSTORE as an already-dirty slot.
    assert.equal(laterGas[0], laterGas[1]);
  }
});

test('retained Shanghai deletion then direct or nested funding preserves the cleared namespace', async () => {
  for (const nested of [false, true]) {
    const f = await resetFixture(); await step(f);
    const funded = await step(f, request(f, nested ? FUNDER : f.victim, nested ? {} : { value: '7' }));
    const row = funded.changes.accounts.find(item => item.address === f.victim);
    assert.equal(row.reset.basis, 'shanghai_selfdestruct_deletion'); assert.equal(row.nonce.after, '0x0'); assert.equal(row.code.after, '0x');
    const inspector = await step(f, request(f, INSPECTOR)); assert.equal(inspector.output.execution.status, 'success');
    assert.equal(await storage(f.stateManager, f.victim, OLD_SLOT), 0n); assert.equal(await storage(f.stateManager, f.victim, UNREAD_SLOT), 0n);
    const forged = { ...funded, changes: structuredClone(funded.changes) }; delete forged.changes.accounts.find(item => item.address === f.victim).reset;
    assert.throws(() => validateExecutionChanges(forged));
  }
});

test('retained Shanghai delete/recreate/getter/delete/recreate binds each new incarnation', async () => {
  const f = await resetFixture(); await step(f);
  for (let incarnation = 0; incarnation < 2; incarnation++) {
    const creation = await step(f, request(f, FACTORY)); assert.equal(creation.output.execution.returnData, '0x' + f.victim.slice(2).padStart(64, '0'));
    const row = creation.changes.accounts.find(item => item.address === f.victim);
    assert.equal(row.reset.basis, 'shanghai_selfdestruct_deletion'); assert.deepEqual(row.storage, [{ slot: word(0), before: word(0), after: word(42) }]);
    const getter = await step(f, request(f, f.victim)); assert.equal(getter.output.execution.returnData, word(42));
    assert.equal(await storage(f.stateManager, f.victim, UNREAD_SLOT), 0n);
    if (incarnation === 0) { await step(f, request(f, f.victim, { data: '0x01' })); assert.equal(await account(f.stateManager, f.victim), undefined); }
  }
});

test('retained deleted namespace survives constructor and ancestor message rollback', async () => {
  const constructor = await resetFixture({ constructorReverts: true }); await step(constructor);
  const attempted = await step(constructor, request(constructor, FACTORY)); assert.equal(attempted.output.execution.returnData, word(0));
  assert.equal(await account(constructor.stateManager, constructor.victim), undefined);
  const ancestor = await resetFixture({ ancestorReverts: true }); await step(ancestor);
  const reverted = await step(ancestor, request(ancestor, FUNDER)); assert.equal(reverted.output.execution.status, 'reverted');
  assert.equal(await account(ancestor.stateManager, ancestor.victim), undefined);
});

test('host failure while rematerializing preserves the complete validated prefix', async () => {
  const f = await resetFixture(); await step(f);
  const prior = canonicalStateChanges(f.stateManager.snapshotChanges()), put = f.stateManager.putAccount.bind(f.stateManager);
  let injected = 0;
  f.stateManager.putAccount = async (address, value) => {
    await put(address, value);
    if (address.toString() === f.victim && value.balance === 7n) { injected++; throw Error('Declared sequence host-failure control'); }
  };
  try {
    const failed = await step(f, request(f, f.victim, { value: '7' }));
    assert.equal(injected, 1); assert.equal(failed.output.execution.status, 'unavailable');
    assert.equal(failed.output.stateDisposition, 'rolled_back'); assert.deepEqual(canonicalStateChanges(failed.changes), prior);
  } finally { f.stateManager.putAccount = put; }
});

test('retained authority creation then later call and authorization clear use current nonce/code/storage', async () => {
  const f = await authorizationFixture({ authority: null, to: AUTHORITY, delegateCode: '0x6000546001018060005560005260206000f3' });
  const first = await step(f); assert.equal(first.output.execution.returnData, word(1));
  const laterRequest = request(f, AUTHORITY); delete laterRequest.authorizationList;
  const second = await step(f, laterRequest); assert.equal(second.output.execution.returnData, word(2));
  const third = await step(f, { ...laterRequest, authorizationList: [signAuthorization({ nonce: 1n, address: ZERO })] });
  assert.equal(third.output.execution.status, 'success');
  const row = third.changes.accounts.find(item => item.address === AUTHORITY);
  assert.equal(row.existence.basis, 'eip7702_authorization_materialization'); assert.equal(row.nonce.after, '0x2'); assert.equal(row.code, undefined);
  assert.equal(row.storage[0].after, word(2));
});
