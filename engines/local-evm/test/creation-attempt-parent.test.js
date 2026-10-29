// Parent consistency controls over real proof-backed worker observations.
// These do not claim independent opcode replay or independent-client evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { validateCreationAttempts } from '../creation-attempt-validation.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { creationAttemptFixture, TARGET, HELPER, IMPLEMENTATION, initcode, factoryCode, reentrantCreation, callBytes } from './amsterdam-creation-attempts-fixture.js';

async function packet(f) {
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager,
    blockchain: f.inputs.blockchain, chainId: 11155111 });
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  const args = { output, inputs: f.inputs.snapshotInputs(), changes: f.stateManager.snapshotChanges(),
    sender: f.request.from, destination: f.request.to, request: f.request, header: f.header, common: f.common };
  validateExecutionChanges(args);
  return args;
}
let repeated;
async function repeatedPacket() {
  repeated ??= creationAttemptFixture({ body: factoryCode(initcode('00', ''), { kind: 'CREATE2', value: 5, repeat: 2 }) }).then(packet);
  const value = await repeated;
  return { ...structuredClone({ ...value, common: undefined }), common: value.common };
}
function rejects(args, mutate) {
  const candidate = { ...structuredClone({ ...args, common: undefined }), common: args.common };
  mutate(candidate);
  assert.throws(() => validateExecutionChanges(candidate));
}

test('parent requires exact canonical attempt and target records without invoking accessors', async () => {
  const args = await repeatedPacket();
  const mutations = [
    a => { a.output.trace.creationAttempts[0].extra = true; },
    a => { delete a.output.trace.creationAttempts[0].salt; },
    a => { a.output.trace.creationAttempts[0].pc = '0x18'; },
    a => { a.output.trace.creationAttempts[0].pc = Number.MAX_SAFE_INTEGER + 1; },
    a => { a.output.trace.creationAttempts[0].position = -1; },
    a => { a.output.trace.creationAttempts[0].nonceBefore = '0x07'; },
    a => { a.output.trace.creationAttempts[0].nonceAfter = '0x10000000000000000'; },
    a => { a.output.trace.creationAttempts[0].result = '0x00'; },
    a => { a.output.trace.creationAttempts[0].value = '0x' + '1'.repeat(65); },
    a => { a.output.trace.creationAttempts[0].input = '0x' + '00'.repeat(32769); },
    a => { a.output.trace.creationAttempts[0].targetBefore.extra = true; },
    a => { a.output.trace.creationAttempts[0].targetBefore.exists = 0; },
    a => { a.output.trace.creationAttempts[0].targetBefore.nonce = '0x00'; },
    a => { delete a.output.trace.creationAttempts[0]; },
    a => { a.output.trace.creationAttempts.extra = true; },
    a => { a.output.trace.creationAttempts[0] = new Proxy(a.output.trace.creationAttempts[0], {}); },
  ];
  for (const mutate of mutations) rejects(args, mutate);
  let accessed = false;
  rejects(args, a => { Object.defineProperty(a.output.trace.creationAttempts[0], 'value', {
    enumerable: true, get() { accessed = true; throw Error('must not execute'); },
  }); });
  assert.equal(accessed, false);
  rejects(args, a => { Object.defineProperty(a.output.trace.calls[0], 'input', {
    enumerable: true, get() { accessed = true; throw Error('must not execute'); },
  }); });
  assert.equal(accessed, false, 'A child must be shape-checked before its entered-attempt join');
});

test('parent binds attempts to opcode, target derivation, current target state and child result', async () => {
  const args = await repeatedPacket();
  for (const mutate of [
    a => { a.output.trace.creationAttempts[0].pc = 0; },
    a => { a.output.trace.creationAttempts[0].salt = '0x' + '00'.repeat(32); },
    a => { a.output.trace.creationAttempts[0].target = HELPER; },
    a => { a.output.trace.creationAttempts[0].input = '0x00'; },
    a => { a.output.trace.creationAttempts[0].result = '0x0'; },
    a => { a.output.trace.creationAttempts[0].disposition = 'collision'; },
    a => { a.output.trace.creationAttempts[1].targetBefore.exists = false; },
    a => { a.output.trace.creationAttempts[1].targetBefore.nonce = '0x0'; },
    a => { a.output.trace.creationAttempts[1].targetBefore.codeHash = a.output.trace.creationAttempts[0].targetBefore.codeHash; },
    a => { a.output.trace.creationAttempts[1].targetBefore.storageRoot = '0x' + '11'.repeat(32); },
    a => { a.output.trace.creationAttempts[1].result = a.output.trace.creationAttempts[0].result; },
    a => { a.output.trace.creationAttempts[1].disposition = 'entered'; },
    a => { a.output.trace.creationAttempts[1].nonceBefore = '0x9'; a.output.trace.creationAttempts[1].nonceAfter = '0xa';
      a.changes.accounts.find(row => row.address === TARGET).nonce.after = '0xa'; },
  ]) rejects(args, mutate);
});

test('each entered creation has one ledger join and every entered frame has an explicit array', async () => {
  const args = await repeatedPacket();
  for (const mutate of [
    a => { a.output.trace.creationAttempts.shift(); },
    a => { a.output.trace.creationAttempts.pop(); },
    a => { a.output.trace.creationAttempts[0].position = 1; },
    a => { a.output.trace.creationAttempts[1].position = 0; },
    a => { a.output.trace.creationAttempts.splice(1, 0, structuredClone(a.output.trace.creationAttempts[0])); },
    a => { delete a.output.trace.calls[0].creationAttempts; },
  ]) rejects(args, mutate);
  const old = ethereumNetworkCommon({ number: '24000000', timestamp: '1764798551' });
  assert.throws(() => validateCreationAttempts({ ...args, common: old }));
});

test('reentrant creation must observe intermediate nonce updates at its declared child position', async () => {
  const { body, helper } = reentrantCreation(initcode('00', ''), TARGET);
  const args = await packet(await creationAttemptFixture({ body, accounts: { [HELPER]: { nonce: 1n, code: helper } } }));
  assert.deepEqual(args.output.trace.creationAttempts.map(a => [a.position, a.nonceBefore]), [[0, '0x7'], [2, '0x9']]);
  rejects(args, a => { a.output.trace.creationAttempts[1].position = 1; });
  rejects(args, a => { a.output.trace.calls[1].calls[0].creationAttempts[0].nonceBefore = '0x7'; });
});

test('delegated creation inherits its parent value as well as caller and execution address', async () => {
  const args = await packet(await amsterdamExecutionFixture({ value: '7',
    target: { nonce: 7n, balance: 1000n, code: '0x' + callBytes(IMPLEMENTATION, { opcode: 'f4' }) + '00' },
    accounts: { [IMPLEMENTATION]: { nonce: 1n, code: factoryCode(initcode('00', ''), { value: 5 }) } } }));
  assert.equal(args.output.trace.calls[0].type, 'DELEGATECALL');
  assert.equal(args.output.trace.value, '0x7');
  assert.equal(args.output.trace.calls[0].value, args.output.trace.value);
  rejects(args, a => { a.output.trace.calls[0].value = '0x1'; });
});

test('CALLCODE requires affordable value without transferring it, including an immediately failed child', async () => {
  for (const implementation of [factoryCode(initcode('00', ''), { value: 5 }), '0xfe']) {
    const args = await packet(await amsterdamExecutionFixture({ value: '7',
      target: { nonce: 7n, balance: 1000n, code: '0x' + callBytes(IMPLEMENTATION, { opcode: 'f2', value: 11 }) + '00' },
      accounts: { [IMPLEMENTATION]: { nonce: 1n, code: implementation } } }));
    const frame = args.output.trace.calls[0];
    assert.equal(frame.type, 'CALLCODE'); assert.equal(frame.value, '0xb');
    assert.equal(frame.executionAddress, TARGET);
    assert.equal(frame.error, implementation === '0xfe' ? 'invalid opcode' : null);
    assert.deepEqual(args.changes.accounts.find(row => row.address === TARGET).balance,
      { before: '0x3e8', after: implementation === '0xfe' ? '0x3ef' : '0x3ea' });
    assert.equal(args.changes.accounts.some(row => row.address === IMPLEMENTATION), false);
    rejects(args, a => { a.output.trace.calls[0].value = '0x3f0'; });
  }
});

test('enclosing rollback discards descendant attempts and inherited static cannot acquire them', async () => {
  const body = factoryCode(initcode('00', ''), { kind: 'CREATE2', repeat: 2, value: 0, tail: '5060006000fd' });
  const args = await packet(await creationAttemptFixture({ body: '0x' + callBytes(HELPER) + '00',
    accounts: { [HELPER]: { nonce: 7n, balance: 1000n, code: body } } }));
  assert.equal(args.output.trace.calls[0].error, 'revert');
  assert.equal(validateCreationAttempts(args).size, 0);
  rejects(args, a => { a.changes.accounts.push({ address: HELPER, nonce: { before: '0x7', after: '0x9' } });
    a.changes.accounts.sort((x, y) => x.address.localeCompare(y.address)); });
  rejects(args, a => { a.output.trace.calls[0].type = 'STATICCALL'; });
});

test('root construction starts target nonce at one without counting outer sender preparation twice', async () => {
  const data = factoryCode(initcode('00', ''), { value: 0, tail: '5060006000f3' });
  const args = await packet(await amsterdamExecutionFixture({ to: null, data, priced: false }));
  assert.equal(args.output.trace.type, 'CREATE');
  assert.equal(args.output.trace.creationAttempts[0].nonceBefore, '0x1');
  const counts = validateCreationAttempts(args);
  assert.equal(counts.get(args.output.trace.to), 1);
  assert.equal(counts.has(args.sender), false);
  assert.throws(() => validateCreationAttempts({ ...args, rootNoncePrepared: true }));
});

test('query chronology starts from carried nonce/code state and separately increments its caller', async () => {
  const f = await amsterdamExecutionFixture({ priced: false,
    target: { nonce: 7n, balance: 1000n, code: factoryCode(initcode('00', ''), { kind: 'CREATE2', repeat: 2, value: 0 }) } });
  const original = await packet(f), startingChanges = original.changes;
  const copy = f.stateManager.shallowCopy();
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: copy,
    blockchain: f.inputs.blockchain, chainId: 11155111 });
  assert.equal(output.execution.status, 'success');
  assert.deepEqual(output.trace.creationAttempts.map(a => [a.position, a.nonceBefore, a.disposition]),
    [[0, '0x9', 'collision'], [0, '0xa', 'collision']]);
  const args = { output, inputs: f.inputs.snapshotInputs(), startingChanges, changes: copy.snapshotChanges(),
    destination: f.request.to, common: f.common };
  assert.equal(validateExecutionLifecycle(args).creationAttempts.get(TARGET), 2);
  assert.throws(() => validateCreationAttempts({ ...args, startingChanges: undefined }));
  assert.deepEqual(f.stateManager.snapshotChanges(), startingChanges);
});

test('actual child target-state forgery is withheld even after recounting trace bytes', async t => {
  const f = await creationAttemptFixture({ body: factoryCode(initcode('00', ''), { kind: 'CREATE2', value: 0, repeat: 2 }) });
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          const output = message.result.output;
          assert.equal(output.execution.status, 'success');
          output.trace.creationAttempts[1].targetBefore.nonce = '0x0'; changed = true;
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
    const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
    assert.equal(changed, true); assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(result.output, null); assert.equal(result.changes, null);
    assert.equal(result.isolation.processClosed, true); assert.equal(result.broker.pendingAtReturn, 0);
  } finally { mock.mock.restore(); }
});
