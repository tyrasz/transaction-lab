// Actual local bytecode over synthetic authenticated proofs, followed by
// independent parent consistency checks. No public RPC or client oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { executeEthereumCall } from '../ethereum-call.js';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { amsterdamClearingFixture, FACTORY, SENDER, BENEFICIARY, DONOR, GETTER, factoryCode, createdAddress, initcode, word, selfdestructCode as sd, callCode as call } from './amsterdam-clearing-fixture.js';

const BASIS = 'same_invocation_created_contract_clearing_eip8246';
const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const hex = n => '0x' + BigInt(n).toString(16);
async function run(f) {
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager, blockchain: f.inputs.blockchain, chainId: 11155111 });
  assert.equal(output.execution.status, 'success', JSON.stringify(output.execution));
  const args = { output, changes: f.stateManager.snapshotChanges(), inputs: f.inputs.snapshotInputs(), sender: f.request.from, destination: f.request.to, common: f.common, request: f.request, header: f.header };
  validateExecutionChanges(args); return args;
}
async function constructorCase({ prefunded = false, value = 7, self = true, tail, priced = false, coinbaseTarget = false } = {}) {
  const init = '602a600055' + (self ? '30ff' : sd(BENEFICIARY)), target = createdAddress({ init });
  const f = await amsterdamClearingFixture({ code: factoryCode(init, { value, ...(tail ? { tail } : {}) }), accounts: {
    ...(prefunded ? { [target]: { nonce: 0n, balance: 17n, code: '0x' } } : {}),
    ...(priced ? { [SENDER]: { nonce: 1n, balance: 10n ** 20n, code: '0x' } } : {}),
  } }, { priced, ...(coinbaseTarget ? { coinbase: target } : {}) });
  return { f, target };
}
function rejectChanges(args, mutate) { const copy = structuredClone({ output: args.output, inputs: args.inputs, changes: args.changes }); mutate(copy); assert.throws(() => validateExecutionChanges({ ...args, ...copy })); }

test('Amsterdam clearing binds created/selfdestruct intersection and preserves absent or prefunded native balances', async () => {
  for (const prefunded of [false, true]) {
    const { f, target } = await constructorCase({ prefunded }), r = await run(f), balance = prefunded ? 24n : 7n;
    assert.deepEqual(r.output.lifecycle.finalizedClearings, [{ address: target, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: EMPTY_STORAGE_ROOT, preservedBalance: hex(balance) }]);
    assert.equal(r.output.lifecycle.finalizedDeletions, undefined);
    assert.deepEqual(r.changes.accounts.find(row => row.address === target), { address: target,
      ...(!prefunded ? { existence: { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' } } : {}), balance: { before: prefunded ? '0x11' : '0x0', after: hex(balance) } });
  }
});

test('zero residual clearing has exact whole-account removal only for an originally existing target', async () => {
  for (const prefunded of [false, true]) {
    const { f, target } = await constructorCase({ prefunded, self: false }), r = await run(f);
    assert.equal(r.output.lifecycle.finalizedClearings[0].preservedBalance, '0x0');
    assert.deepEqual(r.changes.accounts.find(row => row.address === target), prefunded ? { address: target,
      existence: { before: true, after: false, basis: BASIS }, balance: { before: '0x11', after: '0x0' } } : undefined);
  }
});

test('SELFDESTRUCT followed by a later refill preserves only the reconstructed residual balance', async () => {
  const init = initcode(sd(BENEFICIARY), '602a600055'), target = createdAddress({ init });
  const f = await amsterdamClearingFixture({ code: factoryCode(init, { value: 5, tail: '50' + call(target) + call(DONOR) + '00' }),
    accounts: { [DONOR]: { nonce: 1n, balance: 7n, code: '0x' + sd(target) } } });
  const r = await run(f); assert.equal(r.output.lifecycle.finalizedClearings[0].preservedBalance, '0x7');
  assert.deepEqual(r.changes.accounts.find(row => row.address === BENEFICIARY).balance, { before: '0x0', after: '0x5' });
  assert.equal(r.changes.accounts.find(row => row.address === target).balance.after, '0x7');
  assert.equal(r.output.lifecycle.finalizedClearings.some(row => row.address === DONOR), false);
});

test('preexisting self-beneficiary has no burn or clearing and cannot borrow a creation marker', async () => {
  const f = await amsterdamClearingFixture({ code: '0x30ff' }), r = await run(f);
  assert.equal(r.output.lifecycle, undefined); assert.equal(r.changes.accounts.some(row => row.address === FACTORY), false);
  rejectChanges(r, x => { x.output.lifecycle = { finalizedClearings: [{ address: FACTORY, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: EMPTY_STORAGE_ROOT, preservedBalance: '0x3e8' }] }; });
});

test('a pending cleared coinbase retains its fee credit after all native transfers and settlement', async () => {
  for (const self of [false, true]) {
    const { f, target } = await constructorCase({ prefunded: true, self, priced: true, coinbaseTarget: true }), r = await run(f);
    const tip = BigInt(r.output.feeAccounting.coinbaseTip), expected = tip + (self ? 24n : 0n);
    assert(tip > 0n); assert.equal(r.output.lifecycle.finalizedClearings[0].preservedBalance, hex(expected));
    assert.equal(r.changes.accounts.find(row => row.address === target).balance.after, hex(expected));
    rejectChanges(r, x => { x.output.lifecycle.finalizedClearings[0].preservedBalance = hex(expected - tip); x.changes.accounts.find(row => row.address === target).balance.after = hex(expected - tip); });
  }
});

test('missing, duplicated, fabricated or old-fork clearing evidence and surviving namespace fields fail closed', async () => {
  const { f, target } = await constructorCase({ prefunded: true }), r = await run(f);
  for (const mutate of [
    x => { delete x.output.lifecycle; },
    x => { x.output.lifecycle.finalizedClearings = []; },
    x => { x.output.lifecycle.finalizedClearings.push({ ...x.output.lifecycle.finalizedClearings[0] }); },
    x => { x.output.lifecycle.finalizedClearings[0].preservedBalance = '0x0'; },
    x => { x.output.lifecycle.finalizedClearings[0].preservedBalance = '0x018'; },
    x => { x.output.lifecycle.finalizedClearings[0].initialStorageRoot = word(1); },
    x => { x.output.lifecycle.finalizedClearings[0].address = FACTORY; },
    x => { x.output.lifecycle.finalizedClearings[0].scope = 'entire_account_including_code_and_storage'; },
    x => { x.output.lifecycle.finalizedClearings[0].extra = true; },
    x => { delete x.output.trace.calls[0].selfdestruct; },
    x => { x.output.trace.calls[0].error = 'revert'; },
    x => { x.changes.accounts.find(row => row.address === target).balance.after = '0x17'; },
    x => { x.changes.accounts.find(row => row.address === target).nonce = { before: '0x0', after: '0x1' }; },
    x => { x.changes.accounts.find(row => row.address === target).code = { before: '0x', after: '0x00' }; },
    x => { x.changes.accounts.find(row => row.address === target).storage = [{ slot: word(0), before: word(0), after: word(42) }]; },
  ]) rejectChanges(r, mutate);
  assert.throws(() => validateExecutionChanges({ ...r, common: undefined }));
  assert.throws(() => validateExecutionChanges({ ...r, common: new Common({ chain: Mainnet, hardfork: Hardfork.Osaka }) }));
});

test('root revert retains observed SELFDESTRUCT but cannot fabricate committed clearing', async () => {
  const { f } = await constructorCase({ tail: '5060006000fd' });
  const output = await executeEthereumCall({ request: f.request, header: f.header, stateManager: f.stateManager, blockchain: f.inputs.blockchain, chainId: 11155111 });
  assert.equal(output.execution.status, 'reverted'); assert.equal(output.lifecycle, undefined);
  const args = { output, changes: f.stateManager.snapshotChanges(), inputs: f.inputs.snapshotInputs(), sender: SENDER, destination: FACTORY, common: f.common };
  assert.doesNotThrow(() => validateExecutionChanges(args));
  const child = output.trace.calls[0]; assert(child.selfdestruct);
  rejectChanges(args, x => { x.output.lifecycle = { finalizedClearings: [{ address: child.to, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: EMPTY_STORAGE_ROOT, preservedBalance: '0x7' }] }; });
});

test('balance-only and zero-empty clearing rows carry through neutral query copies without new lifecycle claims', async () => {
  for (const self of [false, true]) {
    const { f } = await constructorCase({ prefunded: true, self }), r = await run(f), before = r.changes, after = structuredClone(before);
    after.accounts.find(row => row.address === SENDER).nonce.after = '0x3';
    assert.equal(validateQueryMutation({ before, after, sender: SENDER, nonceBefore: '2', senderExistedBefore: true }).status, 'verified');
    const output = { execution: { status: 'success' }, trace: { type: 'CALL', from: SENDER, caller: SENDER, to: FACTORY, executionAddress: FACTORY, depth: 0, value: '0x0', output: '0x', error: null, calls: [] } };
    assert.doesNotThrow(() => validateExecutionLifecycle({ output, inputs: r.inputs, destination: FACTORY, changes: after, startingChanges: before, common: f.common }));
    if (!self) assert.throws(() => validateExecutionLifecycle({ output, inputs: r.inputs, destination: FACTORY, changes: after, common: f.common }));
  }
});

test('reset namespace shapes preserve immutable roots and remain neutral only when carried unchanged', () => {
  const base = { scope: SCOPE, accounts: [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }, { address: BENEFICIARY,
    nonce: { before: '0x7', after: '0x0' }, reset: { basis: BASIS, initialStorageRoot: word(9) }, code: { before: '0x600000', after: '0x' } }] };
  canonicalStateChanges(base); const after = structuredClone(base); after.accounts[0].nonce.after = '0x3';
  assert.equal(validateQueryMutation({ before: base, after, sender: SENDER, nonceBefore: '2', senderExistedBefore: true }).status, 'verified');
  after.accounts[1].reset.initialStorageRoot = word(10);
  assert.throws(() => validateQueryMutation({ before: base, after, sender: SENDER, nonceBefore: '2', senderExistedBefore: true }));
});

test('actual isolated parent admits clearing and native queries observe preserved balance with no query mutation', async () => {
  const { f, target } = await constructorCase({ prefunded: true });
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111,
    queries: [{ kind: 'native_balance', account: target }] });
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.preview.status, 'complete');
  assert.deepEqual(result.preview.measurements[0].values.map(v => [v.beforeRaw, v.afterRaw, v.deltaRaw]), [['17', '24', '7']]);
  const callResult = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
  assert.equal(callResult.status, 'completed', JSON.stringify(callResult.error));
});

test('an original creation is not newly created by a disposable query, even when it selfdestructs there', async () => {
  const init = initcode('30ff', ''), target = createdAddress({ init });
  const getter = '0x' + call(target) + '73' + target.slice(2) + '3160005260206000f3';
  const f = await amsterdamClearingFixture({ code: factoryCode(init, { value: 5 }), accounts: { [GETTER]: { nonce: 1n, code: getter } } });
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111,
    queries: [{ to: GETTER, data: '0x70a08231' + SENDER.slice(2).padStart(64, '0') }, { kind: 'native_balance', account: target }] });
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.preview.status, 'complete');
  const m = result.preview.measurements[0]; assert.equal(m.values[0].beforeRaw, '0'); assert.equal(m.values[0].afterRaw, '5');
  assert.equal(m.after.output.lifecycle, undefined); assert.deepEqual(m.after.output.trace.calls[0].selfdestruct, { beneficiary: target });
  assert.equal(result.preview.measurements[1].values[0].afterRaw, '5');
  assert.equal(result.preview.original.changes.accounts.find(row => row.address === target).code.after, '0x30ff');
});

test('actual worker reply cannot erase the clearing or replace its residual with a mutually forged balance', async t => {
  for (const mutate of [
    r => { delete r.output.lifecycle; },
    r => { const clear = r.output.lifecycle.finalizedClearings[0]; clear.preservedBalance = '0x1'; r.changes.accounts.find(row => row.address === clear.address).balance.after = '0x1'; },
  ]) {
    const { f } = await constructorCase(), fork = childProcess.fork; let changed = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), emit = child.emit;
      child.emit = function(event, ...values) {
        if (event === 'message' && typeof values[0] === 'string') {
          const message = JSON.parse(values[0]);
          if (message.type === 'result') {
            mutate(message.result); changed = true; const o = message.result.output;
            o.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: o.trace, logs: o.logs,
              ...(o.lifecycle ? { lifecycle: o.lifecycle } : {}), ...(o.feeAccounting ? { feeAccounting: o.feeAccounting } : {}), ...(o.stateGasAccounting ? { stateGasAccounting: o.stateGasAccounting } : {}) }));
            values[0] = JSON.stringify(message);
          }
        }
        return emit.call(this, event, ...values);
      }; return child;
    });
    try {
      const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
      assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.output, null);
    } finally { mock.mock.restore(); }
  }
});

test('inherited static mode rejects the reproduced delegated SELFDESTRUCT clearing forgery in an actual worker reply', async t => {
  const impl = '0x' + '77'.repeat(20);
  const runtime = '600060006000600073' + impl.slice(2) + '62030d40f45000';
  const init = initcode(runtime, ''), target = createdAddress({ init });
  const staticcall = '600060006000600073' + target.slice(2) + '620f4240fa5000';
  const make = () => amsterdamClearingFixture({ code: factoryCode(init, { value: 5, tail: '50' + staticcall }),
    accounts: { [impl]: { nonce: 1n, code: '0x30ff' } } });
  const honest = await run(await make());
  assert.equal(honest.output.trace.calls[1].type, 'STATICCALL');
  assert.equal(honest.output.trace.calls[1].calls[0].type, 'DELEGATECALL');
  assert.equal(honest.output.trace.calls[1].calls[0].error, 'static state change');
  assert.equal(honest.output.lifecycle, undefined);
  const f = await make(), fork = childProcess.fork; let changed = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          const r = message.result, o = r.output, delegate = o.trace.calls[1].calls[0];
          assert.equal(delegate.error, 'static state change'); delegate.error = null; delegate.selfdestruct = { beneficiary: target };
          o.lifecycle = { finalizedClearings: [{ address: target, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: EMPTY_STORAGE_ROOT, preservedBalance: '0x5' }] };
          const index = r.changes.accounts.findIndex(row => row.address === target); assert(index >= 0);
          r.changes.accounts[index] = { address: target, existence: { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' }, balance: { before: '0x0', after: '0x5' } };
          o.usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: o.trace, logs: o.logs, lifecycle: o.lifecycle, stateGasAccounting: o.stateGasAccounting }));
          changed = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    }; return child;
  });
  try {
    const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111 });
    assert.equal(changed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.output, null);
  } finally { mock.mock.restore(); }
});

test('static ancestry cannot acquire entered CREATE/CREATE2 or a value-bearing CALL by relabeling a normal ancestor', async () => {
  for (const kind of ['CREATE', 'CREATE2']) {
    const init = initcode('00', ''), f = await amsterdamClearingFixture({ code: '0x' + call(DONOR) + '00',
      accounts: { [DONOR]: { nonce: 1n, balance: 17n, code: factoryCode(init, { kind, value: 0 }) } } });
    const r = await run(f); assert.equal(r.output.trace.calls[0].type, 'CALL'); assert.equal(r.output.trace.calls[0].calls[0].type, kind);
    rejectChanges(r, x => { x.output.trace.calls[0].type = 'STATICCALL'; });
  }
  const f = await amsterdamClearingFixture({ code: '0x' + call(DONOR) + '00',
    accounts: { [DONOR]: { nonce: 1n, balance: 17n, code: '0x' + call(BENEFICIARY, 7) + '00' } } });
  const r = await run(f); assert.equal(r.output.trace.calls[0].calls[0].value, '0x7');
  rejectChanges(r, x => { x.output.trace.calls[0].type = 'STATICCALL'; });
});

test('inherited static mode still permits zero-value CALL and nonzero CALLCODE without balance transfer', async () => {
  const impl = '0x' + '77'.repeat(20), staticcall = '600060006000600073' + DONOR.slice(2) + '620f4240fa5000';
  for (const inner of [call(impl), '6000600060006000600773' + impl.slice(2) + '620f4240f250']) {
    const f = await amsterdamClearingFixture({ code: '0x' + staticcall,
      accounts: { [DONOR]: { nonce: 1n, balance: 17n, code: '0x' + inner + '00' }, [impl]: { nonce: 1n, code: '0x00' } } });
    const r = await run(f), descendant = r.output.trace.calls[0].calls[0];
    assert.equal(r.output.trace.calls[0].type, 'STATICCALL'); assert.equal(descendant.error, null);
    assert.equal(descendant.value, descendant.type === 'CALLCODE' ? '0x7' : '0x0');
    assert.equal(r.changes.accounts.some(row => row.address === DONOR || row.address === impl), false);
  }
});
