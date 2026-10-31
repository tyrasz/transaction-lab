// Pure arithmetic and retained-payload controls. No EVM, RPC or target runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import { normalizeStatePair, STATE_COMPARISON_SCOPE } from './state-observations.mjs';
import { validateQueryMutation } from '../../engines/local-evm/preview-mutations.js';

const S = '0x' + '11'.repeat(20), A = '0x' + '22'.repeat(20), B = '0x' + '33'.repeat(20);
const w = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), h = n => '0x' + BigInt(n).toString(16);
const EMPTY = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const hashCode = code => '0x' + Buffer.from(keccak_256(Buffer.from(code.slice(2), 'hex'))).toString('hex');
const snapshot = accounts => ({ accounts });
const delta = (before, after) => ({ before: h(before), after: h(after) });
const slot = (key, before, after) => ({ slot: w(key), before: w(before), after: w(after) });
function inputs(accounts) {
  // These metadata rows are synthetic unit-test anchors, never proof evidence.
  return { accounts, provenance: Object.entries(accounts).map(([account, a]) => ({ account,
    accountProof: { exists: a.exists, nonceRaw: a.nonce, balanceRaw: a.balance, codeHash: hashCode(a.code),
      storageRoot: Object.keys(a.storage).length ? w(999) : EMPTY },
    proofEvidenceId: 1, codeEvidenceId: 2,
    storage: Object.entries(a.storage).map(([key, value]) => ({ key, value, exists: value !== w(0), evidenceId: 3 })) })) };
}
function fixture() {
  const initialInputs = inputs({
    [S]: { exists: true, nonce: '5', balance: '1000', code: '0x', storage: {} },
    [A]: { exists: true, nonce: '1', balance: '100', code: '0x00', storage: { [w(0)]: w(5), [w(1)]: w(7), [w(2)]: w(0) } },
  });
  const first = snapshot([{ address: S, nonce: delta(5, 6) },
    { address: A, balance: delta(100, 99), storage: [slot(0, 5, 9), slot(2, 0, 42)] }]);
  const last = snapshot([{ address: S, nonce: delta(5, 7) },
    { address: A, balance: delta(100, 99), storage: [slot(1, 7, 8)] }]);
  return { initialInputs,
    localSteps: [first, last].map((changes, index) => ({ index, status: 'completed', original: {
      startingChanges: structuredClone(index ? first : snapshot([])), changes } })),
    providerSteps: [
      { index: 0, status: 'completed', result: { stateDiff: {
        pre: { [S]: { nonce: 5, balance: '0x3e8' }, [A]: { balance: '100', code: '0x00', storage: { [w(0)]: w(5) } } },
        post: { [S]: { nonce: '0x6' }, [A]: { balance: '99', storage: { [w(0)]: w(9), [w(2)]: w(42) } } },
      } } },
      { index: 1, status: 'completed', result: { stateDiff: {
        pre: { [S]: { nonce: '6', balance: '1000' }, [A]: { balance: '99', storage: { [w(0)]: w(9), [w(1)]: w(7), [w(2)]: w(42) } } },
        post: { [S]: { nonce: 7 }, [A]: { storage: { [w(0)]: w(5), [w(1)]: w(8) } } },
      } } },
    ] };
}
const unavailable = (f, index = 0, side = 'provider') => {
  const r = normalizeStatePair(f); assert.equal(r.steps[index].status, 'unavailable'); assert.equal(r.steps[index].matches, null);
  assert(r.steps[index].reason[side]); return r;
};

test('nonce carry and cumulative writes preserve different later fields and remove writes returned to initial', () => {
  const f = fixture(), bytes = JSON.stringify(f), r = normalizeStatePair(f);
  assert.equal(r.scope, STATE_COMPARISON_SCOPE); assert.equal(r.proofVerification, 'required_externally_not_performed_here');
  assert.deepEqual(r.steps.map(s => s.matches), [true, true]);
  const end = r.steps[1].providerChanges.accounts.find(r => r.address === A);
  assert.deepEqual(end, { address: A, balance: delta(100, 99), storage: [slot(1, 7, 8)] });
  assert.deepEqual(r.steps[1].providerChanges.accounts.find(r => r.address === S).nonce, delta(5, 7));
  assert.equal(JSON.stringify(f), bytes, 'Inputs remain unchanged');
});

test('provider carry uses its own prior values even after an observed disagreement', () => {
  const f = fixture(); f.providerSteps[0].result.stateDiff.post[A].storage[w(0)] = w(10);
  f.providerSteps[1].result.stateDiff.pre[A].storage[w(0)] = w(10);
  const r = normalizeStatePair(f); assert.deepEqual(r.steps.map(s => s.matches), [false, true]);
  f.providerSteps[1].result.stateDiff.pre[A].storage[w(0)] = w(9);
  unavailable(f, 1);
});

test('omitted post storage clears pre-only slots; omitted basic fields remain unchanged', () => {
  const f = fixture(); f.providerSteps[1].result.stateDiff.pre[A].storage = { [w(0)]: w(9), [w(2)]: w(42) };
  delete f.providerSteps[1].result.stateDiff.post[A].storage;
  f.localSteps[1].original.changes.accounts[1].storage = [slot(0, 5, 0)];
  const r = normalizeStatePair(f); assert.equal(r.steps[1].matches, true);
  assert.deepEqual(r.steps[1].providerChanges.accounts.find(r => r.address === A).balance, delta(100, 99));
});

test('changed basic values require matching prevalues except authenticated zero omissions', () => {
  for (const change of [f => { delete f.providerSteps[0].result.stateDiff.pre[S].nonce; },
    f => { f.providerSteps[1].result.stateDiff.pre[S].nonce = 5; },
    f => { f.providerSteps[1].result.stateDiff.pre[A].balance = 100; }]) {
    const f = fixture(); change(f); unavailable(f, change.toString().includes('[1]') ? 1 : 0);
  }
  const f = fixture(); f.initialInputs.accounts[S].balance = '0'; f.initialInputs.provenance[0].accountProof.balanceRaw = '0';
  delete f.providerSteps[0].result.stateDiff.pre[S].balance; f.providerSteps[0].result.stateDiff.post[S].balance = 2;
  f.localSteps[0].original.changes.accounts[0].balance = delta(0, 2);
  assert.equal(normalizeStatePair(f).steps[0].matches, true);
});

test('missing initial slot/account anchors stay unavailable, with empty-root zero inference explicit', () => {
  const f = fixture(); f.providerSteps[0].result.stateDiff.post[A].storage[w(3)] = w(8); unavailable(f);
  const g = fixture(); g.providerSteps[0].result.stateDiff.pre[B] = {}; g.providerSteps[0].result.stateDiff.post[B] = {}; unavailable(g);
  const z = fixture(); z.initialInputs.accounts[B] = { exists: true, nonce: '0', balance: '0', code: '0x', storage: {} };
  z.initialInputs = inputs(z.initialInputs.accounts); z.providerSteps[0].result.stateDiff.pre[B] = {};
  z.providerSteps[0].result.stateDiff.post[B] = { storage: { [w(3)]: w(8) } };
  z.localSteps[0].original.changes.accounts.push({ address: B, storage: [slot(3, 0, 8)] });
  assert.equal(normalizeStatePair(z).steps[0].matches, true);
});

test('real absent-input shape is retained when unused and cannot authorize materialization', () => {
  const f = fixture(); f.initialInputs.accounts[B] = { exists: false };
  f.initialInputs.provenance.push({ account: B, accountProof: { exists: false, nonceRaw: '0', balanceRaw: '0',
    codeHash: hashCode('0x'), storageRoot: EMPTY }, proofEvidenceId: 4, codeEvidenceId: null,
    codeDerivation: 'verified_account_absence', storage: [] });
  assert.deepEqual(normalizeStatePair(f).steps.map(s => s.matches), [true, true]);
  f.providerSteps[0].result.stateDiff.pre[B] = {}; f.providerSteps[0].result.stateDiff.post[B] = { balance: '1' };
  unavailable(f);
});

test('lifecycle/reset/code transitions and absent-account normalizations are never dropped', () => {
  for (const mutate of [f => { f.providerSteps[0].result.stateDiff.post[A].code = '0x6000'; },
    f => { delete f.providerSteps[0].result.stateDiff.post[A]; },
    f => { f.providerSteps[0].result.nativeEffects = { stateNormalization: [{ account: A }] }; },
    f => { f.providerSteps[0].result.stateDiff.pre[A].codeHash = w(1); }]) {
    const f = fixture(); mutate(f); unavailable(f);
  }
  for (const extra of [{ reset: { basis: 'invented' } }, { existence: { before: true, after: false } },
    { code: { before: '0x00', after: '0x' } }]) {
    const f = fixture(); Object.assign(f.localSteps[0].original.changes.accounts[1], extra); unavailable(f, 0, 'local');
  }
});

test('duplicate accounts/slots/provenance, unknown fields and malformed explicit storage reject', () => {
  const a = fixture(); a.localSteps[0].original.changes.accounts.push(structuredClone(a.localSteps[0].original.changes.accounts[0])); unavailable(a, 0, 'local');
  const b = fixture(); b.localSteps[0].original.changes.accounts[1].storage.push(slot(0, 5, 9)); unavailable(b, 0, 'local');
  for (const mutate of [f => { f.providerSteps[0].result.stateDiff.post[A].storage = null; },
    f => { f.providerSteps[0].result.stateDiff.post[A].storage = []; },
    f => { f.providerSteps[0].result.stateDiff.post[A].extra = 'ignored?'; },
    f => { f.providerSteps[0].result.stateDiff.post[A].storage['0x' + 'A'.repeat(64)] = w(1); },
    f => { f.providerSteps[0].result.stateDiff.post[S].nonce = '0x10000000000000000'; }]) { const f = fixture(); mutate(f); unavailable(f); }
  const c = fixture(); c.initialInputs.provenance.push(structuredClone(c.initialInputs.provenance[0])); assert.throws(() => normalizeStatePair(c), /Duplicate account provenance/);
  const d = fixture(); d.initialInputs.provenance[1].storage.push(structuredClone(d.initialInputs.provenance[1].storage[0])); assert.throws(() => normalizeStatePair(d), /Duplicate storage provenance/);
  const e = fixture(); e.initialInputs.accounts[A].storage[w(1)] = w(88); assert.throws(() => normalizeStatePair(e), /proof metadata/);
});

test('wrong local global before/starting overlay and step ordering cannot produce a match', () => {
  const a = fixture(); a.localSteps[1].original.changes.accounts[0].nonce.before = h(6); unavailable(a, 1, 'local');
  const b = fixture(); b.localSteps[1].original.startingChanges.accounts.pop(); unavailable(b, 1, 'local');
  const c = fixture(); c.providerSteps.reverse(); assert.throws(() => normalizeStatePair(c), /index\/order/);
  const d = fixture(); let invoked = false; Object.defineProperty(d.providerSteps[0].result.stateDiff.post[A], 'storage', { enumerable: true, get() { invoked = true; return {}; } });
  unavailable(d); assert.equal(invoked, false);
});

test('coherent original and nonce-only query snapshots cannot rescue a false global storage before-value', () => {
  const f = fixture(), scope = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
  for (const step of f.localSteps) for (const name of ['startingChanges', 'changes']) step.original[name].scope = scope;
  const original = f.localSteps[0].original;
  original.changes.accounts.find(row => row.address === A).storage[0].before = w(6); // Proven initial value is 5.
  f.localSteps[1].original.startingChanges = structuredClone(original.changes);
  const before = structuredClone(original.changes), after = structuredClone(before);
  after.accounts.find(row => row.address === S).nonce.after = h(7);
  const mutationValidation = validateQueryMutation({ before, after, sender: S, nonceBefore: '6', senderExistedBefore: true });
  assert.equal(mutationValidation.status, 'verified', 'Nonce-only mutation checking alone cannot authenticate the shared storage preimage');
  f.localSteps[0].measurements = [{ status: 'measured', after: { changesBefore: before, changesAfter: after, mutationValidation } }];
  assert.deepEqual(f.localSteps[0].measurements[0].after.changesBefore, original.changes);
  const result = normalizeStatePair(f);
  assert(result.steps.every(row => row.status === 'unavailable' && row.matches === null && row.localChanges === null));
  assert.match(result.steps[0].reason.local, /storage before differs from immutable initial/);
  assert(result.steps.every(row => row.providerChanges !== null), 'The independently anchored provider prefix remains available');
});

test('unavailable and stopped positions retain null comparisons; other side is not poisoned', () => {
  const f = fixture(); f.localSteps[0].status = 'unavailable';
  const r = unavailable(f, 0, 'local'); assert.deepEqual(r.steps.map(s => s.matches), [null, null]);
  assert(r.steps.every(s => s.providerChanges !== null));
  const g = fixture(); g.localSteps[1].status = 'not_attempted'; g.providerSteps[1].status = 'skipped';
  const x = normalizeStatePair(g); assert.equal(x.steps[0].matches, true); assert.equal(x.steps[1].matches, null);
  const z = fixture(); z.providerSteps[1].status = 'reverted_or_failed'; assert.equal(normalizeStatePair(z).steps[1].matches, true);
});

test('pinned saved Aave approval/supply diffs exercise real sparse shapes with synthetic anchors only', () => {
  // Saved provider bytes are real; metadata assembled below is deliberately a
  // synthetic arithmetic fixture, not authenticated proof or a new execution.
  function saved(name, pin, role) {
    const raw = fs.readFileSync(new URL('../../reports/standard-evm-sequence-discovery/' + name, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), pin);
    return JSON.parse(raw).requests.find(r => r.role === role).response.result;
  }
  const approval = saved('capture.json', 'e3e4e36d1433b8eb29467cdc172b0ea7efa6f3f3ca526a478aa6e42d89b99c03', 'approve_pre_post_diff');
  const supply = saved('continuation/capture.json', 'ae31c207aa98e1172cf8112211d981c3abbda559622f74c18af84db72b7443e6', 'supply_after_approval_diff');
  const accounts = {}, known = new Set();
  for (const diff of [approval, supply]) for (const [key, pre] of Object.entries(diff.pre)) {
    accounts[key] ??= { exists: true, nonce: BigInt(pre.nonce ?? 0).toString(), balance: BigInt(pre.balance ?? 0).toString(), code: pre.code ?? '0x', storage: {} };
    for (const slot of new Set([...Object.keys(pre.storage ?? {}), ...Object.keys(diff.post[key]?.storage ?? {})])) {
      if (!known.has(key + slot)) { accounts[key].storage[slot] = pre.storage?.[slot] ?? w(0); known.add(key + slot); }
    }
  }
  const f = { initialInputs: inputs(accounts), localSteps: [0, 1].map(index => ({ index, status: 'completed', original: { startingChanges: snapshot([]), changes: snapshot([]) } })),
    providerSteps: [approval, supply].map((stateDiff, index) => ({ index, status: 'completed', result: { stateDiff } })) };
  const r = normalizeStatePair(f); assert(r.steps.every(s => s.providerChanges !== null)); assert.deepEqual(r.steps.map(s => s.matches), [false, false]);
  const sender = '0x48c16c5652add27eddb0f896748a35fc60b8d1b4', usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  assert.deepEqual(r.steps[0].providerChanges.accounts.find(a => a.address === sender).nonce, delta(52, 53));
  assert.deepEqual(r.steps[1].providerChanges.accounts.find(a => a.address === sender).nonce, delta(52, 54));
  const allowance = '0x26336f21a63aacd3574e840a3278fccb16fd789e8d3e700e5b9587a87e8da134';
  assert(r.steps[0].providerChanges.accounts.find(a => a.address === usdc).storage.some(s => s.slot === allowance));
  assert(!r.steps[1].providerChanges.accounts.find(a => a.address === usdc).storage.some(s => s.slot === allowance));
});
