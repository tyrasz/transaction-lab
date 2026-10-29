// Regression for the previously unsupported EIP-7928 collision boundary.
// One entered constructor plus one no-child collision now needs two exact
// observed increments. This is shared-EthereumJS development evidence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { amsterdamExecutionFixture as fixture, compareAmsterdamFullVM, TARGET } from './amsterdam-execution-fixture.js';
import { factoryCode, initcode } from './lifecycle-fixture.js';

test('repeated Amsterdam CREATE2 collision completes with its explicit two-attempt ledger', async () => {
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
  assert.equal(isolated.status, 'completed', JSON.stringify(isolated.error));
  assert.deepEqual(isolated.output.trace.creationAttempts.map(row => [row.position, row.disposition, row.nonceBefore, row.nonceAfter]),
    [[0, 'entered', '0x7', '0x8'], [1, 'collision', '0x8', '0x9']]);
  assert.deepEqual(isolated.changes, f.stateManager.snapshotChanges());
  assert.equal(isolated.isolation.processClosed, true);
});


test('omitting the no-child collision evidence still withholds all completed parent output', async t => {
  const f = await fixture({ target: { nonce: 7n, code: factoryCode(initcode('00', ''), { kind: 'CREATE2', repeat: 2, value: 0, tail: '5000' }) } });
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          const output = message.result.output;
          assert.equal(output.execution.status, 'success');
          assert.equal(output.trace.creationAttempts.length, 2);
          assert.equal(output.trace.creationAttempts[1].disposition, 'collision');
          output.trace.creationAttempts.pop(); changed = true;
          output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
            ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}),
            ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}),
            ...(output.stateGasAccounting ? { stateGasAccounting: output.stateGasAccounting } : {}) }));
          values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const isolated = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
    assert.equal(changed, true);
    assert.equal(isolated.status, 'unavailable');
    assert.equal(isolated.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(isolated.output, null);
    assert.equal(isolated.changes, null);
    assert.equal(isolated.isolation.processClosed, true);
    assert.equal(isolated.broker.pendingAtReturn, 0);
  } finally { mock.mock.restore(); }
});
