// Actual isolated local execution and parent rejection over synthetic proofs.
// Stock EthereumJS and Geth have known differing storage-only behavior; neither
// is used as an expected-output oracle by these controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { executeIsolatedEthereumCall, executeIsolatedEthereumPreview } from '../isolated-call.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { feeFixture, TX_SENDER, TARGET, word } from './fee-fixture.js';
import { initcode, factoryCode, createdAddress } from './lifecycle-fixture.js';

const GETTER = '0x' + '88'.repeat(20), HELPER = '0x' + '77'.repeat(20);
const BASIS = 'contract_creation_storage_clear';
const INIT = initcode('60025460005260206000f3', '6103df54600155602a600255');
const old = { nonce: 0n, balance: 17n, code: '0x', storage: { [word(0)]: 999n, [word(991)]: 123456n } };
const scalar = to => ({ to, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') });
const getterCode = to => '0x6000600060006000600073' + to.slice(2) + '620f4240f1503d600060003e60005160005260206000f3';
async function fixture({ fork = 'amsterdam', root = false, priced = false, kind = 'CREATE2', init = INIT } = {}) {
  const target = createdAddress({ creator: root ? TX_SENDER : TARGET, nonce: root ? 1n : 7n, kind: root ? 'CREATE' : kind, init });
  const options = { target: { nonce: 7n, balance: 1000n, code: root ? '0x00' : factoryCode(init, { kind, value: 5 }) },
    ...(root ? { to: null, data: '0x' + init, value: '5' } : {}), accounts: { [target]: old, [GETTER]: { nonce: 1n, code: getterCode(target) } } };
  const f = fork === 'amsterdam' ? await amsterdamExecutionFixture({ ...options, priced })
    : await feeFixture({ ...options, fork, ...(!priced ? { baseFee: 0n, maxFee: 0n, priorityFee: 0n } : {}) });
  if (!priced) { delete f.request.executionProfile; delete f.request.fees; }
  return { ...f, chainId: fork === 'amsterdam' ? 11155111 : 1, clearTarget: target };
}
const run = f => executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc, chainId: f.chainId });

test('real isolated parent accepts root/internal cleared creation on five forks with exact funded and storage results', async () => {
  for (const fork of ['shanghai', 'cancun', 'prague', 'osaka', 'amsterdam']) for (const root of [false, true]) {
    const f = await fixture({ fork, root, priced: root }), r = await run(f);
    assert.equal(r.status, 'completed', `${fork}/${root}: ${JSON.stringify(r.error)}`);
    assert.equal(r.output.execution.status, 'success'); assert.equal(r.isolation.processClosed, true);
    const row = r.changes.accounts.find(row => row.address === f.clearTarget);
    const proof = r.inputs.provenance.find(row => row.account === f.clearTarget).accountProof;
    assert.deepEqual(row.reset, { basis: BASIS, initialStorageRoot: proof.storageRoot });
    assert.deepEqual(row.balance, { before: '0x11', after: '0x16' });
    assert.deepEqual(row.nonce, { before: '0x0', after: '0x1' });
    assert.deepEqual(row.storage, [{ slot: word(2), before: word(0), after: word(42) }]);
    assert.deepEqual(r.inputs.accounts[f.clearTarget].storage, {}, 'constructor reads must not fetch old hidden slots');
    if (!root && fork !== 'amsterdam') assert.equal(r.output.trace.calls[0].creationSalt, word(123));
  }
});

test('actual child reset forgery is withheld with no retained completed output', async t => {
  for (const mutate of [
    (r, target) => { delete r.changes.accounts.find(row => row.address === target).reset; },
    (r, target) => { r.changes.accounts.find(row => row.address === target).reset.initialStorageRoot = word(1); },
    (r, target) => { r.changes.accounts.find(row => row.address === target).storage[0].before = word(123456); },
  ]) {
    const f = await fixture(), fork = childProcess.fork; let changed = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), emit = child.emit;
      child.emit = function(event, ...values) {
        if (event === 'message' && typeof values[0] === 'string') {
          const message = JSON.parse(values[0]);
          if (message.type === 'result') { mutate(message.result, f.clearTarget); changed = true; values[0] = JSON.stringify(message); }
        }
        return emit.call(this, event, ...values);
      }; return child;
    });
    try {
      const r = await run(f); assert.equal(changed, true); assert.equal(r.status, 'unavailable');
      assert.equal(r.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(r.output, null);
    } finally { mock.mock.restore(); }
  }
});

test('real native and scalar after-queries carry the original reset without adding a query mutation', async () => {
  const f = await fixture();
  const r = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, chainId: f.chainId,
    queries: [scalar(GETTER), { kind: 'native_balance', account: f.clearTarget }] });
  assert.equal(r.status, 'completed', JSON.stringify(r.error)); assert.equal(r.preview.status, 'complete');
  assert.deepEqual(r.preview.measurements.map(m => m.values.map(v => [v.beforeRaw, v.afterRaw, v.deltaRaw])), [[['0', '42', '42']], [['17', '22', '5']]]);
  const scalarResult = r.preview.measurements[0];
  assert.equal(scalarResult.after.mutationValidation.status, 'verified');
  assert.deepEqual(scalarResult.after.changesBefore.accounts.find(row => row.address === f.clearTarget), r.preview.original.changes.accounts.find(row => row.address === f.clearTarget));
});

test('query creation is neutral only when its ancestor reverts; discarded query state cannot poison later native reads', async () => {
  for (const reverts of [true, false]) {
    const init = initcode('00', ''), target = createdAddress({ creator: HELPER, kind: 'CREATE2', init });
    const f = await amsterdamExecutionFixture({ priced: false, target: { nonce: 1n, code: '0x00' }, accounts: {
      [target]: old,
      [HELPER]: { nonce: 7n, balance: 1000n, code: factoryCode(init, { kind: 'CREATE2', value: 0, tail: '50602a60005260206000' + (reverts ? 'fd' : 'f3') }) },
      [GETTER]: { nonce: 1n, code: getterCode(HELPER) },
    } });
    const r = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, chainId: 11155111,
      queries: [scalar(GETTER), { kind: 'native_balance', account: target }] });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    const [query, native] = r.preview.measurements;
    if (reverts) { assert.equal(query.status, 'measured'); assert.deepEqual(query.values.map(v => [v.beforeRaw, v.afterRaw]), [['42', '42']]); }
    else { assert.equal(query.status, 'unavailable'); assert.equal(query.values, null); }
    assert.equal(native.status, 'measured'); assert.deepEqual(native.values.map(v => [v.beforeRaw, v.afterRaw, v.deltaRaw]), [['17', '17', '0']]);
    assert.equal(r.preview.original.changes.accounts.some(row => row.address === target), false);
  }
});

test('historical nested CREATE derives a newly created creator nonce1 and clears both original namespaces', async () => {
  const outerInit = factoryCode(INIT, { kind: 'CREATE', value: 0, tail: '5060006000f3' }).slice(2);
  const outer = createdAddress({ creator: TARGET, nonce: 7n, init: outerInit });
  const inner = createdAddress({ creator: outer, nonce: 1n, init: INIT });
  const f = await feeFixture({ fork: 'osaka', baseFee: 0n, maxFee: 0n, priorityFee: 0n,
    target: { nonce: 7n, balance: 1000n, code: factoryCode(outerInit, { value: 5 }) }, accounts: { [outer]: old, [inner]: old } });
  delete f.request.executionProfile; delete f.request.fees;
  const r = await run({ ...f, chainId: 1 });
  assert.equal(r.status, 'completed', JSON.stringify(r.error)); assert.equal(r.output.execution.status, 'success');
  assert.equal(r.output.trace.calls[0].to, outer); assert.equal(r.output.trace.calls[0].calls[0].to, inner);
  for (const [address, nonce] of [[outer, '0x2'], [inner, '0x1']]) {
    const row = r.changes.accounts.find(row => row.address === address);
    assert.equal(row.reset.basis, BASIS); assert.equal(row.nonce.after, nonce);
  }
});

test('actual created SELFDESTRUCT finalizers retain the original nonempty root across fork rules', async () => {
  for (const fork of ['shanghai', 'osaka', 'amsterdam']) {
    const f = await fixture({ fork, init: '30ff' }), r = await run(f);
    assert.equal(r.status, 'completed', `${fork}: ${JSON.stringify(r.error)}`); assert.equal(r.output.execution.status, 'success');
    const row = r.changes.accounts.find(row => row.address === f.clearTarget);
    const proof = r.inputs.provenance.find(row => row.account === f.clearTarget).accountProof;
    if (fork === 'amsterdam') {
      assert.deepEqual(row, { address: f.clearTarget, balance: { before: '0x11', after: '0x16' }, reset: { basis: 'same_invocation_created_contract_clearing_eip8246', initialStorageRoot: proof.storageRoot } });
      assert.equal(r.output.lifecycle.finalizedClearings[0].initialStorageRoot, proof.storageRoot);
    } else {
      assert.equal(row.existence.after, false); assert.deepEqual(row.balance, { before: '0x11', after: '0x0' });
      assert.equal(r.output.lifecycle.finalizedDeletions[0].initialStorageRoot, proof.storageRoot);
    }
  }
});
