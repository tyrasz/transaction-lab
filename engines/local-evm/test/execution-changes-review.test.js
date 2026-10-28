import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, FACTORY, SENDER, word } from './lifecycle-fixture.js';

const run = (f, limits) => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, ...(limits ? { limits } : {}) });
async function alteredResult(t, f, mutate) {
  const fork = childProcess.fork; let altered = false;
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
  try { const result = await run(f); assert.equal(altered, true); return result; }
  finally { mock.mock.restore(); }
}
function rejected(result) {
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
  assert.equal(result.output, null);
}

test('broker accepts prefunded runtime and empty-runtime deployments without inventing existence changes', async () => {
  for (const init of [initcode(), '60006000f3']) {
    const target = createdAddress({ init });
    const f = await lifecycleFixture({ code: factoryCode(init), accounts: { [target]: { balance: 17n } } });
    const result = await run(f);
    assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success');
    const row = result.changes.accounts.find(row => row.address === target);
    assert.equal(Object.hasOwn(row, 'existence'), false);
    assert.deepEqual(row.nonce, { before: '0x0', after: '0x1' });
    assert.deepEqual(row.balance, { before: '0x11', after: '0x16' });
    assert.equal(Object.hasOwn(row, 'code'), init !== '60006000f3');
  }
});

test('broker accepts nested constructor deployment and removes nested deployments when their constructor reverts', async () => {
  for (const reverted of [false, true]) {
    const innerInit = initcode();
    const outerInit = factoryCode(innerInit, { value: 0, tail: reverted ? '5060006000fd' : '60005560006000f3' }).slice(2);
    const outer = createdAddress({ init: outerInit }), inner = createdAddress({ creator: outer, nonce: 1n, init: innerInit });
    const result = await run(await lifecycleFixture({ code: factoryCode(outerInit) }));
    assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success');
    assert.equal(result.output.trace.calls[0].calls[0].to, inner);
    assert.equal(result.output.trace.calls[0].calls[0].error, null);
    assert.equal(result.output.trace.calls[0].error, reverted ? 'revert' : null);
    for (const target of [outer, inner]) {
      const row = result.changes.accounts.find(row => row.address === target);
      if (reverted) assert.equal(row, undefined);
      else assert.equal(row.existence.basis, 'internal_contract_creation');
    }
    assert.deepEqual(result.changes.accounts.find(row => row.address === FACTORY).nonce, { before: '0x7', after: '0x8' });
    assert.deepEqual(result.inputs.accounts[outer], { exists: false });
    assert.deepEqual(result.inputs.accounts[inner], { exists: false });
  }
});

test('broker retains an honest partial trace after an outer limit while requiring all deployment changes rolled back', async () => {
  const f = await lifecycleFixture({ code: factoryCode(initcode(), { tail: '505b601256' }) });
  const result = await run(f, { execution: { steps: 100 } });
  assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'unavailable');
  assert.equal(result.output.execution.error.code, 'LOCAL_RESOURCE_LIMIT');
  assert.equal(result.output.trace.calls[0].error, null);
  assert.equal(result.output.stateDisposition, 'rolled_back');
  assert.deepEqual(result.changes.accounts, []);
});

test('broker rejects coordinated nonce-before and immutable input nonce substitution', async t => {
  rejected(await alteredResult(t, await lifecycleFixture(), result => {
    result.inputs.accounts[SENDER].nonce = '0';
    result.changes.accounts.find(row => row.address === SENDER).nonce.before = '0x0';
  }));
});

test('broker rejects fabricated initial existence despite retaining the actual exclusion proof', async t => {
  const target = createdAddress();
  rejected(await alteredResult(t, await lifecycleFixture(), result => {
    result.inputs.accounts[target] = { exists: true, nonce: '0', balance: '0', code: '0x', storage: { [word(0)]: word(0) } };
    delete result.changes.accounts.find(row => row.address === target).existence;
  }));
});

test('broker rejects non-sender effects retained after an actual root revert', async t => {
  const f = await lifecycleFixture({ code: factoryCode(initcode(), { tail: '5060006000fd' }) });
  rejected(await alteredResult(t, f, result => {
    result.changes.accounts.push({ address: FACTORY, balance: { before: '0x3e8', after: '0x3e7' } });
  }));
});

test('broker rejects an extra sender nonce increment even when immutable inputs and all other output remain valid', async t => {
  rejected(await alteredResult(t, await lifecycleFixture(), result => {
    result.changes.accounts.find(row => row.address === SENDER).nonce.after = '0x3';
  }));
});
