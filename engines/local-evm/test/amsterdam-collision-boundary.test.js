// Retained unsupported case, not a successful coverage claim. EIP-7928 can
// advance a creator nonce on collision without entering a second child frame.
// The parent must withhold a result until it has an authenticated attempt ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { amsterdamExecutionFixture as fixture, compareAmsterdamFullVM, TARGET } from './amsterdam-execution-fixture.js';
import { factoryCode, initcode } from './lifecycle-fixture.js';

test('repeated Amsterdam CREATE2 collision remains unavailable at the strict parent boundary', async () => {
  const f = await fixture({ target: { nonce: 7n, code: factoryCode(initcode('00', ''), { kind: 'CREATE2', repeat: 2, value: 0, tail: '5000' }) } });
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager,
    blockchain: f.inputs.blockchain, chainId: 11155111 });
  assert.equal(output.execution.status, 'success');
  assert.equal(output.trace.calls.length, 1);
  assert.equal(output.trace.calls[0].type, 'CREATE2');
  assert.deepEqual(f.stateManager.snapshotChanges().accounts.find(row => row.address === TARGET).nonce,
    { before: '0x7', after: '0x9' });
  await compareAmsterdamFullVM(f, output);
  const isolated = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
  assert.equal(isolated.status, 'unavailable');
  assert.equal(isolated.error.code, 'LOCAL_ISOLATED_PROTOCOL');
  assert.equal(isolated.output, null);
  assert.equal(isolated.changes, null);
  assert.equal(isolated.isolation.processClosed, true);
});
