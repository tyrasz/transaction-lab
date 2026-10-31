// Offline synthetic proof fixtures only: real isolated worker and direct host
// failure controls. No public RPC, provider replay or independent-client claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIsolatedEthereumSequence } from '../isolated-call.js';
import { executeEthereumCall } from '../ethereum-call.js';
import { RpcStateInputError } from '../rpc-state-inputs.js';
import { sequenceFixture, SEQUENCE_SENDER, SEQUENCE_TOKEN, SEQUENCE_VAULT,
  encodeSequenceCall, balanceSlot } from './sequence-fixture.js';

const PRIVATE = 'private-provider-detail https://private.invalid/token=do-not-retain';
const MESSAGE = 'Required pinned input state is unavailable; no execution result can be reported.';
const LIMITS = { wallMs: 30000, requestMs: 2000, drainMs: 1000, killWaitMs: 1000, execution: { wallMs: 20000 } };
const queries = [{ to: SEQUENCE_TOKEN, data: encodeSequenceCall('allowance', [SEQUENCE_SENDER, SEQUENCE_VAULT]) }];
const run = (f, rpc, requests) => executeIsolatedEthereumSequence({ requests, header: f.header, chainId: f.chainId, rpc, queries, limits: LIMITS });
function unavailable(output, code = 'LOCAL_INPUT_UNAVAILABLE', disposition = 'rolled_back') {
  assert.equal(output.execution.status, 'unavailable');
  assert.equal(output.execution.error.code, code);
  if (code === 'LOCAL_INPUT_UNAVAILABLE') assert.equal(output.execution.error.message, MESSAGE);
  assert.equal(output.execution.executionGasUsed, null);
  assert.equal(output.execution.returnData, null);
  assert.equal(output.gasAccounting, null);
  assert.equal(output.feeAccounting, undefined);
  assert.equal(output.stateDisposition, disposition);
  assert.deepEqual(output.logs, []);
  assert(!JSON.stringify(output).includes(PRIVATE));
}
function closed(result) {
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.error, null);
  assert.equal(result.isolation.processSeparated, true);
  assert.equal(result.isolation.processClosed, true);
  assert.equal(result.broker.pendingAtReturn, 0);
  assert(!JSON.stringify(result).includes(PRIVATE));
}

test('isolated first proof failure preserves typed input unavailability without remote details or measurements', async () => {
  const f = await sequenceFixture(); let denied = 0;
  const rpc = { async call() { denied++; throw Object.assign(Error(PRIVATE), { code: -32000 }); } };
  const result = await run(f, rpc, [f.requests.approve, f.requests.deposit]); closed(result);
  assert.equal(denied, 1); assert.equal(result.sequence.status, 'unavailable');
  const [first, skipped] = result.sequence.steps;
  unavailable(first.original.output, 'LOCAL_INPUT_UNAVAILABLE', 'unchanged');
  assert.deepEqual(first.original.changes.accounts, []);
  assert.equal(first.original.inputUsage.failure.code, 'RPC_STATE_INPUT_UNAVAILABLE');
  assert.equal(result.broker.records[0].error.code, 'RPC_UNAVAILABLE');
  assert.equal(skipped.status, 'not_attempted'); assert.equal(skipped.original, null);
  assert(result.sequence.steps.every(step => step.measurements.every(m => m.values === null)));
});

test('isolated later proof failure rolls back only the failed invocation and preserves the validated priced prefix', async () => {
  const f = await sequenceFixture({ priced: true }); let denied = 0;
  const rpc = { async call(method, params, options) {
    if (method === 'eth_getProof' && params[0] === SEQUENCE_TOKEN && params[1].includes(balanceSlot(SEQUENCE_VAULT))) {
      denied++; throw Error(PRIVATE);
    }
    return f.rpc.call(method, params, options);
  } };
  const result = await run(f, rpc, [f.requests.approve, f.requests.deposit, f.requests.withdraw]); closed(result);
  assert.equal(result.sequence.status, 'partial'); assert.equal(denied, 1);
  const [first, failed, skipped] = result.sequence.steps;
  assert.equal(first.original.output.execution.status, 'success');
  unavailable(failed.original.output);
  assert.deepEqual(failed.original.startingChanges, first.original.changes);
  assert.deepEqual(failed.original.changes, first.original.changes);
  const sender = failed.original.changes.accounts.find(a => a.address === SEQUENCE_SENDER);
  assert.equal(BigInt(sender.nonce.after), 2n);
  assert.equal(BigInt(sender.balance.after), BigInt(f.allocation[SEQUENCE_SENDER].balance) - BigInt(first.original.output.feeAccounting.gasCharge));
  assert.equal(failed.original.inputUsage.failure.code, 'RPC_STATE_INPUT_UNAVAILABLE');
  assert.equal(skipped.status, 'not_attempted'); assert.equal(skipped.original, null);
  assert(result.sequence.steps.every(step => step.measurements.every(m => m.values === null)));
});

test('only the real allowlisted input error is classified; spoofed, invalid-proof and unknown host errors remain withheld', async () => {
  const failures = [
    [new RpcStateInputError('RPC_STATE_INPUT_UNAVAILABLE', PRIVATE), 'LOCAL_INPUT_UNAVAILABLE'],
    [Error(PRIVATE), 'LOCAL_EXECUTION_FAILED'],
    [Object.assign(Error(PRIVATE), { name: 'RpcStateInputError', code: 'RPC_STATE_INPUT_UNAVAILABLE' }), 'LOCAL_EXECUTION_FAILED'],
    [{ name: 'RpcStateInputError', code: 'RPC_STATE_INPUT_UNAVAILABLE', message: PRIVATE }, 'LOCAL_EXECUTION_FAILED'],
    [new RpcStateInputError('RPC_STATE_INPUT_INVALID_PROOF', PRIVATE), 'LOCAL_EXECUTION_FAILED'],
    [new RpcStateInputError('UNRECOGNIZED_INPUT_FAILURE', PRIVATE), 'LOCAL_EXECUTION_FAILED'],
  ];
  for (const [error, code] of failures) {
    const f = await sequenceFixture();
    f.stateManager.getAccount = async () => { throw error; };
    const output = await executeEthereumCall({ request: f.requests.approve, header: f.header, stateManager: f.stateManager, blockchain: f.inputs.blockchain, chainId: f.chainId });
    unavailable(output, code, 'unchanged');
    assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
    assert.equal(f.inputs.snapshotUsage().calls, 0);
  }
});
