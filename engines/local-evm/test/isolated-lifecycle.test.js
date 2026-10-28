import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, RUNTIME, SENDER, word } from './lifecycle-fixture.js';

const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
for (const kind of ['CREATE', 'CREATE2']) test(`actual isolated worker retains authenticated ${kind} code, storage and balances`, async () => {
  const f = await lifecycleFixture({ code: factoryCode(initcode(), { kind }) }), result = await run(f);
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success');
  const target = createdAddress({ kind }), row = result.changes.accounts.find(row => row.address === target);
  assert.deepEqual(row.code, { before: '0x', after: '0x' + RUNTIME });
  assert.deepEqual(row.storage, [{ slot: word(0), before: word(0), after: word(42) }]);
  assert.deepEqual(row.balance, { before: '0x0', after: '0x5' });
  assert.equal(row.existence.basis, 'internal_contract_creation');
  assert.equal(result.broker.pendingAtReturn, 0); assert.equal(result.isolation.processClosed, true);
});

test('actual isolated worker retains only the sender nonce after creation then root revert', async () => {
  const f = await lifecycleFixture({ code: factoryCode(initcode(), { tail: '5060006000fd' }) }), result = await run(f);
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'reverted');
  assert.deepEqual(result.changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
});

test('disposable preview queries preserve original deployments and do not invent an absent pre-deployment balance', async () => {
  const token = '0x3333333333333333333333333333333333333333';
  const f = await lifecycleFixture({ accounts: { [token]: { nonce: 1n, code: '0x602a60005260206000f3' } } });
  const target = createdAddress(), data = '0x70a08231' + SENDER.slice(2).padStart(64, '0');
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [{ to: token, data }, { to: target, data }] });
  assert.equal(result.status, 'completed'); assert.equal(result.preview.status, 'partial');
  const [existing, created] = result.preview.measurements;
  assert.equal(existing.status, 'measured'); assert.equal(existing.values[0].deltaRaw, '0');
  assert.deepEqual(existing.after.changesBefore, result.preview.original.changes);
  assert.equal(existing.after.mutationValidation.status, 'verified');
  assert.equal(created.status, 'unavailable'); assert.equal(created.before.values, null);
  assert.equal(created.after, null); // A failed before-query withholds the entire pair.
  assert.equal(result.preview.original.changes.accounts.find(row => row.address === target).code.after, '0x' + RUNTIME);
});

test('parent rejects substituted code, initial values, creation ancestry and missing deployment rows', async t => {
  const fork = childProcess.fork, target = createdAddress();
  const mutations = [
    r => { r.changes.accounts.find(row => row.address === target).code.after = '0x00'; },
    r => { r.changes.accounts.find(row => row.address === target).storage[0].before = word(1); },
    r => { r.changes.accounts.find(row => row.address === SENDER).nonce.before = '0x0'; },
    r => { r.output.trace.calls[0].error = 'revert'; },
    r => { r.output.trace.calls = []; },
    r => { r.changes.accounts = r.changes.accounts.filter(row => row.address !== target); },
    r => { r.inputs.provenance.find(row => row.account === target).accountProof.storageRoot = word(1); },
  ];
  for (const mutate of mutations) {
    let altered = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), emit = child.emit;
      child.emit = function(event, ...values) {
        if (event === 'message' && typeof values[0] === 'string') {
          const message = JSON.parse(values[0]);
          if (message.type === 'result') { mutate(message.result); altered = true; values[0] = JSON.stringify(message); }
        }
        return emit.call(this, event, ...values);
      };
      return child;
    });
    const result = await run(await lifecycleFixture()); mock.mock.restore();
    assert.equal(altered, true); assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.output, null);
  }
});
