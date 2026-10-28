// Independent parent-boundary controls using real bytecode and synthetic MPT
// proofs. No provider traces or expected poststate are supplied to execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { validateExecutionChanges } from '../execution-changes.js';
import { lifecycleFixture, createdAddress, factoryCode, initcode, SENDER, RUNTIME, word } from './lifecycle-fixture.js';

const target = createdAddress({ creator: SENDER, nonce: 1n });
async function fixture({ init = initcode(), value = '5', accounts = {} } = {}) {
  const f = await lifecycleFixture({ accounts });
  f.request = { from: SENDER, to: null, data: '0x' + init, value, gas: '5000000' };
  return f;
}
const run = (f, limits) => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, ...(limits ? { limits } : {}) });
async function tampered(t, f, mutate, previewQueries) {
  const fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') { mutate(message.result); changed = true; values[0] = JSON.stringify(message); }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = previewQueries
      ? await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: previewQueries })
      : await run(f);
    assert.equal(changed, true); assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL');
    assert.equal(previewQueries ? result.preview : result.output, null);
  } finally { mock.mock.restore(); }
}
const senderOnly = [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }];

test('parent accepts absent/prefunded top-level CREATE including empty initcode and runtime', async () => {
  for (const [init, prefunded] of [[initcode(), false], [initcode(), true], ['60006000f3', false], ['', true]]) {
    const f = await fixture({ init, accounts: prefunded ? { [target]: { balance: 17n } } : {} }), result = await run(f);
    assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success');
    assert.equal(result.output.trace.type, 'CREATE'); assert.equal(result.output.trace.to, target);
    assert.equal(result.output.trace.executionAddress, target); assert.equal(result.output.trace.caller, SENDER);
    const row = result.changes.accounts.find(row => row.address === target);
    assert.deepEqual(row.nonce, { before: '0x0', after: '0x1' });
    assert.deepEqual(row.balance, { before: prefunded ? '0x11' : '0x0', after: prefunded ? '0x16' : '0x5' });
    if (prefunded) assert.equal(row.existence, undefined);
    else assert.equal(row.existence.basis, 'top_level_contract_creation');
    if (init === initcode()) assert.equal(row.code.after, '0x' + RUNTIME);
    else { assert.equal(row.code, undefined); assert.equal(result.output.execution.returnData, '0x'); }
  }
});

test('root CREATE derivation uses authenticated original nonce with canonical RLP boundary encoding', async () => {
  for (const nonce of [0n, 128n, (1n << 64n) - 2n]) {
    const result = await run(await fixture({ init: '', value: '0', accounts: { [SENDER]: { nonce, balance: 1000000n } } }));
    assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, 'success');
    assert.equal(result.output.trace.to, createdAddress({ creator: SENDER, nonce }));
    assert.deepEqual(result.changes.accounts.find(row => row.address === SENDER).nonce,
      { before: '0x' + nonce.toString(16), after: '0x' + (nonce + 1n).toString(16) });
  }
});

test('nested constructors preserve top-level versus internal origin and discard all creations on root revert', async () => {
  const nested = createdAddress({ creator: target, nonce: 1n });
  for (const revert of [false, true]) {
    const init = factoryCode(initcode(), { value: 0, tail: revert ? '5060006000fd' : '5060006000f3' }).slice(2);
    const result = await run(await fixture({ init }));
    assert.equal(result.status, 'completed'); assert.equal(result.output.execution.status, revert ? 'reverted' : 'success');
    assert.equal(result.output.trace.calls[0].to, nested); assert.equal(result.output.trace.calls[0].error, null);
    if (revert) assert.deepEqual(result.changes.accounts, senderOnly);
    else {
      assert.equal(result.changes.accounts.find(row => row.address === target).existence.basis, 'top_level_contract_creation');
      assert.equal(result.changes.accounts.find(row => row.address === nested).existence.basis, 'internal_contract_creation');
      assert.deepEqual(result.changes.accounts.find(row => row.address === target).nonce, { before: '0x0', after: '0x2' });
    }
  }
});

test('CREATE collision and resource failure retain their distinct rollback semantics', async () => {
  const collision = await run(await fixture({ accounts: { [target]: { balance: 17n, storage: { [word(0)]: word(1) } } } }));
  assert.equal(collision.status, 'completed'); assert.equal(collision.output.execution.status, 'failed');
  assert.equal(collision.output.trace.to, target); assert.deepEqual(collision.changes.accounts, senderOnly);
  const limited = await run(await fixture({ init: '602a6000555b600556' }), { execution: { steps: 100 } });
  assert.equal(limited.status, 'completed'); assert.equal(limited.output.execution.status, 'unavailable');
  assert.equal(limited.output.trace.to, target); assert.equal(limited.output.stateDisposition, 'rolled_back');
  assert.deepEqual(limited.changes.accounts, []);
});

test('root CREATE destination is independently derived even if all creation rows/facts are coherently relabelled', async () => {
  const f = await fixture(), result = await run(f), wrong = createdAddress({ creator: SENDER, nonce: 2n });
  assert.equal(result.status, 'completed');
  // This direct validator control deliberately gives coherent synthetic fact
  // labels; separate broker tests below still bind the real proof provenance.
  result.output.trace.to = wrong; result.output.trace.executionAddress = wrong;
  result.changes.accounts.find(row => row.address === target).address = wrong;
  result.inputs.accounts[wrong] = result.inputs.accounts[target]; delete result.inputs.accounts[target];
  result.inputs.provenance.find(row => row.account === target).account = wrong;
  assert.throws(() => validateExecutionChanges({ changes: result.changes, inputs: result.inputs, output: result.output, sender: SENDER, destination: null }));
});

test('actual parent rejects CREATE identity, runtime, provenance, gas and nonce substitutions', async t => {
  const mutations = [
    r => { r.output.trace.type = 'CREATE2'; },
    r => { r.output.trace.caller = target; },
    r => { r.output.trace.to = null; r.output.trace.executionAddress = null; },
    r => { r.output.trace.input = '0x'; },
    r => { r.output.trace.value = '0x0'; },
    r => { r.output.trace.gas = '0x4c4b40'; },
    r => { r.output.profile.creationIntrinsicGas = '0'; },
    r => { r.changes.accounts.find(row => row.address === target).existence.basis = 'internal_contract_creation'; },
    r => { r.changes.accounts.find(row => row.address === target).code.after = '0x00'; },
    r => { r.changes.accounts.find(row => row.address === target).storage[0].before = word(1); },
    r => { r.changes.accounts.find(row => row.address === SENDER).nonce.after = '0x3'; },
    r => { r.inputs.accounts[SENDER].nonce = '0'; r.changes.accounts.find(row => row.address === SENDER).nonce.before = '0x0'; },
    r => { r.inputs.provenance.find(row => row.account === target).accountProof.exists = true; },
  ];
  for (const mutate of mutations) await tampered(t, await fixture(), mutate);
});

test('a reverted constructor cannot retain fabricated creation effects or successful nested effects', async t => {
  const nestedInit = factoryCode(initcode(), { value: 0, tail: '5060006000fd' }).slice(2);
  await tampered(t, await fixture({ init: nestedInit }), r => {
    r.changes.accounts.push({ address: target, existence: { before: false, after: true, basis: 'top_level_contract_creation' }, nonce: { before: '0x0', after: '0x1' } });
  });
});

test('actual constructor revert, invalid opcode and success cannot be relabelled inconsistently', async t => {
  for (const [init, status] of [['60006000fd', 'success'], ['fe', 'success'], ['', 'failed']]) {
    await tampered(t, await fixture({ init }), r => { r.output.execution.status = status; });
  }
});

test('disposable CALL getters preserve creation origin and original deployment state', async t => {
  const token = '0x3333333333333333333333333333333333333333';
  const accounts = { [token]: { nonce: 1n, code: '0x602a60005260206000f3' } }, queries = [{ to: token, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') }];
  const f = await fixture({ accounts }), result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries });
  assert.equal(result.status, 'completed'); assert.equal(result.preview.status, 'complete');
  const row = result.preview.measurements[0]; assert.equal(row.status, 'measured');
  assert.equal(row.before.output.trace.type, 'CALL'); assert.equal(row.after.output.trace.type, 'CALL');
  assert.equal(Object.hasOwn(row.after.output.profile, 'creationIntrinsicGas'), false);
  assert.deepEqual(row.after.changesBefore, result.preview.original.changes);
  assert.equal(row.after.changesBefore.accounts.find(row => row.address === target).existence.basis, 'top_level_contract_creation');
  await tampered(t, await fixture({ accounts }), r => {
    r.preview.measurements[0].after.changesBefore.accounts.find(row => row.address === target).existence.basis = 'internal_contract_creation';
  }, queries);
});
