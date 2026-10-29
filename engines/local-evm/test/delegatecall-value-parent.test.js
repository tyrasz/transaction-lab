// Real historical-fork bytecode and proof-backed children. The adversarial
// mutations change only trace context, not balances or measured return bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { validateExecutionChanges } from '../execution-changes.js';
import { feeFixture, feeCommon, TARGET, word } from './fee-fixture.js';

const IMPLEMENTATION = '0x7777777777777777777777777777777777777777';
const proxy = '0x602060006000600073' + IMPLEMENTATION.slice(2) + '620f4240f45060206000f3';
const implementation = '0x3460005260206000f3';
const fixture = (fork, value) => feeFixture({ fork, value: String(value), target: { nonce: 1n, balance: 1000n, code: proxy },
  accounts: { [IMPLEMENTATION]: { nonce: 1n, code: implementation } } });
async function packet(f) {
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager, blockchain: f.inputs.blockchain });
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  const args = { output, inputs: f.inputs.snapshotInputs(), changes: f.stateManager.snapshotChanges(), sender: f.request.from,
    destination: f.request.to, request: f.request, header: f.header, common: feeCommon(f) };
  validateExecutionChanges(args);
  return args;
}

test('Prague and Osaka DELEGATECALL inherit zero and nonzero parent value without another native transfer', async () => {
  for (const fork of ['prague', 'osaka']) for (const value of [0n, 7n]) {
    const f = await fixture(fork, value), args = await packet(f), child = args.output.trace.calls[0];
    assert.equal(child.type, 'DELEGATECALL'); assert.equal(child.value, args.output.trace.value);
    assert.equal(child.value, '0x' + value.toString(16)); assert.equal(child.output, word(value));
    assert.equal(args.output.execution.returnData, word(value)); assert.equal(child.executionAddress, TARGET);
    assert.equal(args.changes.accounts.some(row => row.address === IMPLEMENTATION), false);
    assert.deepEqual(args.changes.accounts.find(row => row.address === TARGET)?.balance,
      value === 0n ? undefined : { before: '0x3e8', after: '0x3ef' });
    const isolated = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
    assert.equal(isolated.status, 'completed', JSON.stringify(isolated.error));
    assert.deepEqual(isolated.output.trace, args.output.trace); assert.deepEqual(isolated.changes, args.changes);
  }
});

test('historical parent rejects contradictory DELEGATECALL value even with unchanged return and state', async () => {
  for (const fork of ['prague', 'osaka']) for (const value of [0n, 7n]) {
    const args = await packet(await fixture(fork, value));
    const before = structuredClone({ changes: args.changes, returnData: args.output.execution.returnData });
    args.output.trace.calls[0].value = value === 0n ? '0x1' : '0x0';
    assert.deepEqual({ changes: args.changes, returnData: args.output.execution.returnData }, before);
    assert.throws(() => validateExecutionChanges(args));
  }
});

test('actual isolated historical parent withholds forged delegated value after exact trace-byte recount', async t => {
  for (const forkName of ['prague', 'osaka']) {
    const f = await fixture(forkName, 7n), fork = childProcess.fork; let changed = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), emit = child.emit;
      child.emit = function(event, ...values) {
        if (event === 'message' && typeof values[0] === 'string') {
          const message = JSON.parse(values[0]);
          if (message.type === 'result') {
            const output = message.result.output;
            assert.equal(output.trace.value, '0x7'); assert.equal(output.trace.calls[0].value, '0x7');
            output.trace.calls[0].value = '0x0'; changed = true;
            output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
              ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}),
              ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}) }));
            values[0] = JSON.stringify(message);
          }
        }
        return emit.call(this, event, ...values);
      };
      return child;
    });
    try {
      const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
      assert(changed); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
      assert.equal(result.output, null); assert.equal(result.changes, null);
      assert.equal(result.isolation.processClosed, true); assert.equal(result.broker.pendingAtReturn, 0);
    } finally { mock.mock.restore(); }
  }
});

test('historical retained successful CALLCODE binds affordability without transferring its nominal value', async () => {
  for (const fork of ['prague', 'osaka']) {
    const f = await feeFixture({ fork, value: '7', target: { nonce: 1n, balance: 1000n,
      code: '0x6020600060006000600b73' + IMPLEMENTATION.slice(2) + '620f4240f25060206000f3' },
      accounts: { [IMPLEMENTATION]: { nonce: 1n, code: implementation } } });
    const args = await packet(f), child = args.output.trace.calls[0];
    assert.equal(child.type, 'CALLCODE'); assert.equal(child.value, '0xb');
    assert.equal(child.output, word(11)); assert.equal(args.output.execution.returnData, word(11));
    assert.deepEqual(args.changes.accounts.find(row => row.address === TARGET).balance, { before: '0x3e8', after: '0x3ef' });
    assert.equal(args.changes.accounts.some(row => row.address === IMPLEMENTATION), false);
    const isolated = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
    assert.equal(isolated.status, 'completed', JSON.stringify(isolated.error));
    assert.deepEqual(isolated.changes, args.changes);
    child.value = '0x3f0'; // 1008 exceeds its actual entry balance 1000 + 7.
    assert.throws(() => validateExecutionChanges(args));
  }
});
