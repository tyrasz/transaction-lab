// Actual isolated-worker failure controls plus pure parent derivation over
// independently reverified synthetic proofs. No public RPC or client oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { validateInputFacts } from '../input-facts.js';
import { deriveAmsterdamAuthorizationEntryGas as entryGas,
  deriveAmsterdamAuthorizationPreparation as preparation } from '../amsterdam-authorization-validation.js';
import { ethereumFeePlan, settleEthereumFees } from '../ethereum-fees.js';
import { amsterdamAuthorizationExecutionFixture as fixture, authorization, signedAuthorizationTransaction,
  TX_SENDER, TEST_KEY, AUTHORITY, TARGET, factoryCode, initcode, createdAddress, word } from './amsterdam-authorization-execution-fixture.js';

const CHAIN = 11155111, INDICATOR = 35190n, WRITE = 9000n;
const hex = n => '0x' + BigInt(n).toString(16);
const intrinsic = f => signedAuthorizationTransaction(f).getIntrinsicGas();
const preauthGas = f => BigInt(f.request.gas) - intrinsic(f);
const run = (f, rpc = f.rpc) => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc, chainId: CHAIN });
const args = (f, inputs) => ({ request: f.request, header: f.header, common: f.common, inputs });
function recount(output) {
  output.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: output.trace, logs: output.logs,
    ...(output.lifecycle ? { lifecycle: output.lifecycle } : {}),
    ...(output.authorizationProcessing ? { authorizationProcessing: output.authorizationProcessing } : {}),
    ...(output.feeAccounting ? { feeAccounting: output.feeAccounting } : {}),
    ...(output.stateGasAccounting ? { stateGasAccounting: output.stateGasAccounting } : {}) }));
}
async function storageSelfAuthorization() {
  const init = initcode('00', ''), target = createdAddress({ creator: TX_SENDER, kind: 'CREATE2', init });
  return fixture({ to: TX_SENDER, gas: '500000',
    authorizationList: [authorization({ key: TEST_KEY, nonce: 2n })],
    delegateCode: factoryCode(init, { kind: 'CREATE2', value: 0 }),
    accounts: { [target]: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(991)]: 11n } } } });
}
function rolledBack(result, status, gas) {
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.output.execution.status, status, JSON.stringify(result.output.execution));
  assert.equal(result.output.trace.gas, hex(gas));
  assert.equal(result.output.stateDisposition, 'rolled_back');
  assert.deepEqual(result.changes.accounts, []);
  assert.equal(result.output.authorizationProcessing, undefined);
  assert.equal(result.output.feeAccounting, undefined);
  assert.equal(result.output.stateGasAccounting, undefined);
  assert.equal(result.output.profile.feesSettled, false);
  assert.equal(result.output.semantics.feeSettlement, false);
  assert.equal(result.output.semantics.senderDelegation, undefined);
  assert.equal(result.output.semantics.callerNonce, 'runCall_increments_once_including_EVM_revert');
  assert.equal(result.isolation.processClosed, true);
  assert.equal(result.broker.pendingAtReturn, 0);
}
async function tamper(t, f, mutate) {
  const original = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...arguments_) => {
    const child = original(...arguments_), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          assert.equal(message.result.output.execution.status, 'unsupported');
          assert.equal(message.result.output.execution.error.code, 'LOCAL_CREATION_STORAGE_UNSUPPORTED');
          mutate(message.result); recount(message.result.output); changed = true;
          values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await run(f);
    assert(changed, 'Mutation must intercept a genuine incomplete worker result');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.output, null); assert.equal(result.changes, null);
    assert.equal(result.isolation.processClosed, true); assert.equal(result.broker.pendingAtReturn, 0);
  } finally { mock.mock.restore(); }
}

test('unsupported self-authorized creation retains independently derived root entry gas but no preparation or settlement', async () => {
  const f = await storageSelfAuthorization(), result = await run(f);
  const expected = preauthGas(f) - INDICATOR;
  rolledBack(result, 'unsupported', expected);
  assert.equal(result.output.execution.error.code, 'LOCAL_CREATION_STORAGE_UNSUPPORTED');
  assert(result.output.usage.steps > 0);
  assert.equal(result.inputs.accounts[TX_SENDER].nonce, '1');
  assert.equal(result.inputs.accounts[TX_SENDER].code, '0x');
  assert.equal(entryGas(args(f, result.inputs)), expected);
  assert.deepEqual(f.stateManager.snapshotChanges().accounts, []);
});

test('actual incomplete child cannot substitute preauthorization gas or either adjacent gas value', async t => {
  const f = await storageSelfAuthorization(), expected = preauthGas(f) - INDICATOR;
  for (const gas of [preauthGas(f), expected - 1n, expected + 1n]) {
    await tamper(t, f, result => { result.output.trace.gas = hex(gas); });
  }
});

test('actual incomplete child cannot retain authorization, fee, lifecycle or state-change claims', async t => {
  const f = await storageSelfAuthorization();
  for (const mutate of [
    result => { result.output.authorizationProcessing = preparation(args(f, result.inputs)).processing; },
    result => { result.output.feeAccounting = settleEthereumFees(ethereumFeePlan(f.request, f.header, CHAIN), { gasUsed: 21000n }); },
    result => { result.output.profile.feesSettled = true; result.output.semantics.feeSettlement = true; },
    result => { result.output.lifecycle = { finalizedDeletions: [] }; },
    result => { result.changes.accounts = [{ address: TX_SENDER, nonce: { before: '0x1', after: '0x2' } }]; },
  ]) await tamper(t, f, mutate);
});

test('missing recipient proof after valid preparation preserves unavailable output and its postauthorization root gas', async () => {
  const f = await fixture({ gas: '500000', to: TARGET }), failed = [];
  const rpc = { async call(method, params) {
    if (method === 'eth_getProof' && params[0] === TARGET) {
      failed.push(structuredClone(params)); throw Error('Synthetic recipient proof unavailable');
    }
    return f.rpc.call(method, params);
  } };
  const result = await run(f, rpc), expected = preauthGas(f) - WRITE - INDICATOR;
  rolledBack(result, 'unavailable', expected);
  assert.equal(failed.length, 1);
  assert.equal(result.inputs.accounts[TARGET], undefined);
  assert.equal(result.inputs.accounts[AUTHORITY].nonce, '0');
  assert.equal(result.inputs.accounts[AUTHORITY].code, '0x');
  assert.equal(result.output.usage.steps, 0);
  assert.equal(result.output.usage.frames, 1);
  assert.equal(entryGas(args(f, result.inputs)), expected);
  assert.throws(() => preparation(args(f, result.inputs)), 'Complete preparation still requires recipient evidence');
});

test('pure entry derivation needs every reached authority proof but not recipient-only facts, and rejects preparation OOG', async () => {
  const f = await fixture({ gas: '500000', to: TARGET });
  await f.inputs.getAccount(TX_SENDER); await f.inputs.getAccount(AUTHORITY);
  const inputs = f.inputs.snapshotInputs(), inputEvidence = f.inputs.snapshotEvidence();
  await validateInputFacts({ inputs, inputEvidence, stateRoot: f.header.stateRoot, chainId: CHAIN });
  assert.equal(inputs.accounts[TARGET], undefined);
  const original = structuredClone(inputs), expected = preauthGas(f) - WRITE - INDICATOR;
  assert.equal(entryGas(args(f, inputs)), expected);
  assert.deepEqual(inputs, original, 'The parent fold must not mutate its verified facts');
  assert.throws(() => preparation(args(f, inputs)));
  const missing = structuredClone(inputs); delete missing.accounts[AUTHORITY];
  assert.throws(() => entryGas(args(f, missing)));
  const tooSmall = { ...args(f, inputs), request: { ...f.request, gas: (intrinsic(f) + WRITE + INDICATOR - 1n).toString() } };
  assert.equal(preparation(tooSmall).processing.preparation.phase, 'authorization_out_of_gas');
  assert.throws(() => entryGas(tooSmall), 'An entered root cannot follow authorization preparation OOG');
  const broke = structuredClone(inputs); broke.accounts[TX_SENDER].balance = '0';
  assert.throws(() => entryGas(args(f, broke)), 'Upfront fee affordability is still required');
});
