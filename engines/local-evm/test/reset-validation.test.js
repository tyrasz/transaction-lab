import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { feeFixture, TX_SENDER, TARGET, word } from './fee-fixture.js';

const scope = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const root = '0x' + 'ab'.repeat(32), zero = word(0);
const reset = () => ({ basis: 'shanghai_selfdestruct_deletion', initialStorageRoot: root });
const snapshot = row => ({ scope, accounts: [row] });

test('live reset shape retains cleared namespace and exact old-to-new account fields', () => {
  const row = { address: TARGET, reset: reset(), nonce: { before: '0x3', after: '0x1' },
    code: { before: '0x6000ff', after: '0x600100' }, storage: [{ slot: word(991), before: zero, after: word(19) }] };
  const actual = canonicalStateChanges(snapshot(row));
  assert.deepEqual(actual, snapshot(row)); assert.notEqual(actual.accounts[0].reset, row.reset);
  row.reset.initialStorageRoot = zero; assert.equal(actual.accounts[0].reset.initialStorageRoot, root);
  // The replacement can have exactly the old nonce/code, so a reset marker and
  // nonzero post-reset writes remain meaningful without scalar deltas.
  assert.deepEqual(canonicalStateChanges(snapshot({ address: TARGET, reset: reset(), storage: [{ slot: word(3), before: zero, after: word(9) }] })).accounts[0].storage[0].after, word(9));
});

test('reset representation cannot masquerade as sparse old-storage differences or an existence transition', () => {
  const row = { address: TARGET, reset: reset(), code: { before: '0x6000ff', after: '0x' } };
  assert.deepEqual(canonicalStateChanges(snapshot(row)), snapshot(row));
  for (const alter of [
    r => r.reset.basis = 'arbitrary_state_override', r => r.reset.initialStorageRoot = '0x1',
    r => r.reset.expectedRoot = root, r => r.existence = { before: false, after: true, basis: 'internal_contract_creation' },
    r => r.storage = [{ slot: word(1), before: word(7), after: word(9) }],
    r => r.storage = [{ slot: word(1), before: zero, after: zero }],
    r => { delete r.reset; },
  ]) { const value = structuredClone(row); alter(value); assert.throws(() => canonicalStateChanges(snapshot(value))); }
  let accessed = false; const getter = { address: TARGET };
  Object.defineProperty(getter, 'reset', { enumerable: true, get() { accessed = true; return reset(); } });
  assert.throws(() => canonicalStateChanges(snapshot(getter))); assert.equal(accessed, false);
});

test('query purity preserves inherited reset state but rejects introducing or dropping it', () => {
  const before = { scope, accounts: [{ address: TX_SENDER, nonce: { before: '0x0', after: '0x1' } }, { address: TARGET, reset: reset() }] };
  const after = structuredClone(before); after.accounts[0].nonce.after = '0x2';
  const options = { before, after, sender: TX_SENDER, nonceBefore: '1', senderExistedBefore: true };
  assert.equal(validateQueryMutation(options).status, 'verified');
  for (const mutate of [v => v.before.accounts.pop(), v => v.after.accounts.pop(), v => v.after.accounts[1].reset.initialStorageRoot = zero]) {
    const value = structuredClone(options); mutate(value); assert.throws(() => validateQueryMutation(value));
  }
});

test('actual isolated parent rejects invented namespace reset even with authentic initial root and unchanged scalars', async t => {
  const f = await feeFixture({ value: '1', target: { nonce: 1n, balance: 9n, code: '0x', storage: { [word(991)]: 19n } } });
  const fork = childProcess.fork; let intercepted = false;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function (event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          const p = message.result.preview; assert.equal(p.status, 'complete');
          const fact = p.original.inputs.provenance.find(r => r.account === TARGET);
          const row = p.original.changes.accounts.find(r => r.address === TARGET);
          row.reset = { basis: 'shanghai_selfdestruct_deletion', initialStorageRoot: fact.accountProof.storageRoot };
          canonicalStateChanges(p.original.changes); // Shape is valid; provenance is not.
          for (const m of p.measurements) {
            m.after.changesBefore = structuredClone(p.original.changes);
            m.after.changesAfter = structuredClone(p.original.changes);
          }
          values[0] = JSON.stringify(message); intercepted = true;
        }
      }
      return emit.call(this, event, ...values);
    }; return child;
  });
  const result = await executeIsolatedEthereumPreview({ request: f.request, header: f.header, rpc: f.rpc, queries: [{ kind: 'native_balance', account: TARGET }] });
  assert(intercepted); assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.preview, null);
});
