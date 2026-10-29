// Real bytecode over independently constructed authenticated prestate. The
// adversarial controls change only retained result deltas, never input proofs.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeEthereumCall } from '../ethereum-call.js';
import { ethereumCommon } from '../ethereum-profile.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { canonicalStateChanges } from '../preview-mutations.js';
import { lifecycleFixture, factoryCode, createdAddress, FACTORY, SENDER } from './lifecycle-fixture.js';
import { shanghaiFixture } from './shanghai-fixture.js';

const CHILD = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x5555555555555555555555555555555555555555';
const GETTER = '0x6666666666666666666666666666666666666666';
const hex = value => '0x' + BigInt(value).toString(16);
const sd = address => '73' + address.slice(2) + 'ff';
const call = (address, value = 0, kind = 'CALL') =>
  '6000600060006000' + (['CALL', 'CALLCODE'].includes(kind) ? '60' + value.toString(16).padStart(2, '0') : '') +
  '73' + address.slice(2) + '62030d40' + ({ CALL: 'f1', CALLCODE: 'f2', DELEGATECALL: 'f4', STATICCALL: 'fa' })[kind];
const row = (changes, address) => changes.accounts.find(item => item.address === address);
const account = (balance, code = '0x00') => ({ nonce: 1n, balance: BigInt(balance), code });
const setBalance = (changes, address, before, after) => {
  let entry = row(changes, address);
  if (!entry) { entry = { address }; changes.accounts.push(entry); changes.accounts.sort((a, b) => a.address.localeCompare(b.address)); }
  entry.balance = { before: hex(before), after: hex(after) };
};
function omitBalances(changes) {
  for (const entry of changes.accounts) delete entry.balance;
  changes.accounts = changes.accounts.filter(entry => Object.keys(entry).length > 1);
}
async function execute(f) {
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager });
  assert.ok(['success', 'reverted', 'failed'].includes(output.execution.status), JSON.stringify(output.execution));
  const args = { output, changes: f.stateManager.snapshotChanges(), inputs: f.inputs.snapshotInputs(),
    sender: f.request.from, destination: f.request.to, request: f.request, header: f.header,
    common: ethereumCommon(f.header), selfdestructOnlyCreated: ethereumCommon(f.header).isActivatedEIP(6780) };
  assert.doesNotThrow(() => validateExecutionChanges(args));
  return args;
}
function rejectChanges(args, mutate) {
  const changes = structuredClone(args.changes); mutate(changes);
  // Mutations must pass structural validation, so rejection exercises the
  // semantic ledger rather than malformed or empty snapshot rows.
  assert.doesNotThrow(() => canonicalStateChanges(changes));
  assert.throws(() => validateExecutionChanges({ ...args, changes }), /input facts and completed trace/);
}

test('unpriced actual transfers reject omitted, invented and conserved-but-wrong balance deltas', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(CHILD, 5) + '5073' + RECIPIENT.slice(2) + '315000',
    accounts: { [CHILD]: account(17), [RECIPIENT]: account(31) } });
  f.request.value = '19';
  const r = await execute(f);
  assert.equal(r.output.execution.status, 'success');
  assert.deepEqual(row(r.changes, SENDER).balance, { before: hex(1000000), after: hex(999981) });
  assert.deepEqual(row(r.changes, FACTORY).balance, { before: hex(1000), after: hex(1014) });
  assert.deepEqual(row(r.changes, CHILD).balance, { before: hex(17), after: hex(22) });
  assert.equal(row(r.changes, RECIPIENT), undefined);
  assert.equal(r.inputs.accounts[RECIPIENT].balance, '31');
  rejectChanges(r, omitBalances);
  rejectChanges(r, changes => { changes.accounts = changes.accounts.filter(entry => entry.address !== CHILD); });
  rejectChanges(r, changes => { setBalance(changes, FACTORY, 1000, 1013); setBalance(changes, CHILD, 17, 23); });
  rejectChanges(r, changes => { setBalance(changes, FACTORY, 1000, 1013); setBalance(changes, RECIPIENT, 31, 32); });
});

test('actual parent rejects unpriced balance-only IPC forgery with authentic proofs and unchanged trace', async t => {
  const f = await lifecycleFixture({ code: '0x00' }); f.request.value = '19';
  const fork = childProcess.fork; let intercepted = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          assert.equal(message.result.output.execution.status, 'success');
          omitBalances(message.result.changes); intercepted = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const r = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
    assert.equal(intercepted, true); assert.equal(r.status, 'unavailable');
    assert.equal(r.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(r.output, null);
  } finally { mock.mock.restore(); }
});

test('successful descendants of a reverted child never credit the committed native ledger', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(CHILD, 5) + '5000', accounts: {
    [CHILD]: account(17, '0x' + call(RECIPIENT, 3) + '5060006000fd'), [RECIPIENT]: account(31),
  } }); f.request.value = '19';
  const r = await execute(f);
  assert.equal(r.output.execution.status, 'success'); assert.equal(r.output.trace.calls[0].error, 'revert');
  assert.equal(r.output.trace.calls[0].calls[0].error, null);
  assert.deepEqual(row(r.changes, FACTORY).balance, { before: hex(1000), after: hex(1019) });
  assert.equal(row(r.changes, CHILD), undefined); assert.equal(row(r.changes, RECIPIENT), undefined);
  rejectChanges(r, changes => { setBalance(changes, FACTORY, 1000, 1014); setBalance(changes, CHILD, 17, 19); setBalance(changes, RECIPIENT, 31, 34); });
});

test('CALLCODE and DELEGATECALL inherit execution context without transferring to the code account', async () => {
  for (const kind of ['CALLCODE', 'DELEGATECALL']) {
    const f = await lifecycleFixture({ code: '0x' + call(CHILD, 5, kind) + '5000', accounts: { [CHILD]: account(17) } });
    f.request.value = '19'; const r = await execute(f), frame = r.output.trace.calls[0];
    assert.equal(frame.type, kind); assert.equal(frame.executionAddress, FACTORY); assert.equal(frame.to, CHILD);
    assert.equal(frame.value, kind === 'CALLCODE' ? '0x5' : '0x13');
    assert.equal(row(r.changes, CHILD), undefined);
    assert.deepEqual(row(r.changes, FACTORY).balance, { before: hex(1000), after: hex(1019) });
    rejectChanges(r, changes => { setBalance(changes, FACTORY, 1000, 1018); setBalance(changes, CHILD, 17, 18); });
  }
});

test('SELFDESTRUCT binds beneficiary credits across retained Cancun and deleted Shanghai accounts', async () => {
  for (const make of [lifecycleFixture, shanghaiFixture]) {
    const f = await make({ code: '0x' + sd(RECIPIENT), accounts: { [RECIPIENT]: account(31) } });
    f.request.value = '19'; const r = await execute(f);
    assert.deepEqual(row(r.changes, RECIPIENT).balance, { before: hex(31), after: hex(1050) });
    assert.deepEqual(row(r.changes, FACTORY).balance, { before: hex(1000), after: '0x0' });
    assert.equal(Boolean(row(r.changes, FACTORY).existence), r.common.hardfork() === 'shanghai');
    rejectChanges(r, changes => { changes.accounts = changes.accounts.filter(entry => entry.address !== RECIPIENT); });
    rejectChanges(r, changes => { row(changes, RECIPIENT).balance.after = hex(1049); });
  }
});

test('created-then-deleted accounts bind prefunded balance and end-of-transaction refill burn', async () => {
  const init = sd(RECIPIENT), target = createdAddress({ init });
  // First construction sends its prefund plus endowment to the beneficiary;
  // a later CALL refills it, runs the retained constructor-empty code, and the
  // final deletion burns that refill. The whole-account row stays base-relative.
  const code = factoryCode(init, { value: 5, tail: '50' + call(target, 7) + '5000' });
  const f = await lifecycleFixture({ code, accounts: { [target]: { nonce: 0n, balance: 17n, code: '0x' }, [RECIPIENT]: account(31) } });
  const r = await execute(f);
  assert.equal(r.output.lifecycle.finalizedDeletions[0].address, target);
  assert.deepEqual(row(r.changes, target).balance, { before: hex(17), after: '0x0' });
  assert.deepEqual(row(r.changes, FACTORY).balance, { before: hex(1000), after: hex(988) });
  assert.deepEqual(row(r.changes, RECIPIENT).balance, { before: hex(31), after: hex(53) });
  rejectChanges(r, changes => { row(changes, RECIPIENT).balance.after = hex(60); });
});

test('disposable queries retain unvisited prior balance rows and reject their omission or reinvention', async () => {
  const f = await lifecycleFixture({ code: '0x00', accounts: { [GETTER]: account(0, '0x602a60005260206000f3') } });
  f.request.value = '19';
  const queries = [{ to: GETTER, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') }];
  const r = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries });
  assert.equal(r.status, 'completed', JSON.stringify(r.error)); assert.equal(r.preview.status, 'complete');
  const measurement = r.preview.measurements[0]; assert.equal(measurement.values[0].beforeRaw, '42'); assert.equal(measurement.values[0].afterRaw, '42');
  const side = measurement.after, args = { output: side.output, inputs: r.preview.inputs, destination: GETTER,
    changes: side.changesAfter, startingChanges: side.changesBefore };
  assert.deepEqual(side.changesBefore, r.preview.original.changes);
  assert.equal(side.output.trace.calls.length, 0); assert.notEqual(side.output.trace.to, FACTORY);
  assert.doesNotThrow(() => validateExecutionLifecycle(args));
  for (const mutate of [
    changes => { changes.accounts = changes.accounts.filter(entry => entry.address !== FACTORY); },
    changes => { row(changes, FACTORY).balance.after = hex(1020); },
  ]) {
    const changes = structuredClone(side.changesAfter); mutate(changes);
    assert.doesNotThrow(() => canonicalStateChanges(changes));
    assert.throws(() => validateExecutionLifecycle({ ...args, changes }), /input facts and completed trace/);
  }
});

test('root REVERT retains only nonce and cannot resurrect a successful descendant transfer', async () => {
  const f = await lifecycleFixture({ code: '0x' + call(CHILD, 5) + '5060006000fd', accounts: { [CHILD]: account(17) } });
  f.request.value = '19'; const r = await execute(f);
  assert.equal(r.output.execution.status, 'reverted'); assert.equal(r.output.trace.calls[0].error, null);
  assert.deepEqual(r.changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
  rejectChanges(r, changes => { setBalance(changes, FACTORY, 1000, 995); setBalance(changes, CHILD, 17, 22); });
});
