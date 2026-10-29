// New observer seams must not turn host failures into catchable EVM faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumCall } from '../ethereum-call.js';
import { creationAttemptFixture, TARGET, initcode, factoryCode, createdAddress } from './amsterdam-creation-attempts-fixture.js';

const run = f => executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager,
  blockchain: f.inputs.blockchain, chainId: 11155111 });
function rolledBack(f, output) {
  assert.equal(output.execution.status, 'unavailable');
  assert.equal(output.stateDisposition, 'rolled_back');
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
  assert.deepEqual(output.logs, []);
  assert.equal(output.feeAccounting, undefined);
  assert.equal(output.semantics.feeSettlement, false);
  assert.equal(JSON.stringify(output).includes('PRIVATE_CREATION_HOST_FAILURE'), false);
}

test('failed creator writes before and after mutation roll back nonce, upfront fees and value', async () => {
  for (const afterWrite of [false, true]) {
    const f = await creationAttemptFixture({ body: factoryCode(initcode('00', ''), { value: 5 }) });
    const put = f.stateManager.putAccount.bind(f.stateManager); let injected = false;
    f.stateManager.putAccount = async (address, account) => {
      if (!injected && address.toString() === TARGET && account.nonce === 8n) {
        injected = true;
        if (afterWrite) await put(address, account);
        throw Error('PRIVATE_CREATION_HOST_FAILURE');
      }
      return put(address, account);
    };
    const output = await run(f); assert.equal(injected, true); rolledBack(f, output);
  }
});

test('failed post-increment collision-state read cannot retain a creator write', async () => {
  const init = initcode('00', ''), target = createdAddress({ creator: TARGET, kind: 'CREATE2', init });
  const f = await creationAttemptFixture({ body: factoryCode(init, { kind: 'CREATE2', value: 5 }),
    accounts: { [target]: { nonce: 1n, balance: 17n, code: '0x' } } });
  const put = f.stateManager.putAccount.bind(f.stateManager), get = f.stateManager.getAccount.bind(f.stateManager);
  let incremented = false, injected = false;
  f.stateManager.putAccount = async (address, account) => {
    const result = await put(address, account);
    if (address.toString() === TARGET && account.nonce === 8n) incremented = true;
    return result;
  };
  f.stateManager.getAccount = async address => {
    if (incremented && !injected && address.toString() === target) {
      injected = true; throw Error('PRIVATE_CREATION_HOST_FAILURE');
    }
    return get(address);
  };
  const output = await run(f); assert.equal(incremented, true); assert.equal(injected, true); rolledBack(f, output);
});

test('no-child attempts consume the existing frame evidence budget and roll back on exhaustion', async () => {
  const init = initcode('00', ''), target = createdAddress({ creator: TARGET, kind: 'CREATE2', init });
  const f = await creationAttemptFixture({ body: factoryCode(init, { kind: 'CREATE2', repeat: 2, value: 0, tail: '5000' }),
    accounts: { [target]: { nonce: 1n, code: '0x' } } });
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager,
    blockchain: f.inputs.blockchain, chainId: 11155111, limits: { frames: 1 } });
  assert.equal(output.execution.status, 'unavailable');
  assert.equal(output.execution.error.code, 'LOCAL_RESOURCE_LIMIT');
  assert.equal(output.usage.frames, 1); // No constructor frame was entered.
  assert.equal(output.stateDisposition, 'rolled_back');
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
});
