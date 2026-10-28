import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueryMutation, canonicalStateChanges } from '../preview-mutations.js';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), C = '0x' + '33'.repeat(20);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const snapshot = accounts => ({ scope: 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.', accounts });
const changed = (slot, before, after) => ({ slot: word(slot), before: word(before), after: word(after) });
const check = (before, after, rest = {}) => validateQueryMutation({ before: snapshot(before), after: snapshot(after), sender: A, nonceBefore: '7', senderExistedBefore: true, ...rest });
const valid = { status: 'verified', scope: 'net_changes_except_expected_query_sender_nonce' };
const rejected = fn => assert.throws(fn, { name: 'QueryMutationError', code: 'LOCAL_QUERY_MUTATION_INVALID', message: 'Query net changes do not match the isolated nonce-only profile.' });
const nonce = { before: '0x7', after: '0x8' };

test('a clean before-state query admits only the exact caller nonce increment and does not alter inputs', () => {
  const before = [], after = [{ address: A, nonce }], saved = structuredClone(after);
  assert.deepEqual(check(before, after), valid); assert.deepEqual(after, saved);
  for (const value of [{ before: '0x6', after: '0x8' }, { before: '0x7', after: '0x9' }, { before: '0x7', after: '0x7' }]) rejected(() => check([], [{ address: A, nonce: value }]));
  rejected(() => check([], []));
});

test('after-state query preserves original nonce, native balances and storage clears across account/slot reorder', () => {
  const before = [{ address: B, storage: [changed(2, 5, 0), changed(1, 7, 9)] }, { address: A, nonce: { before: '0x6', after: '0x7' }, balance: { before: '0x64', after: '0x32' } }];
  const after = [{ address: A, balance: { before: '0x64', after: '0x32' }, nonce: { before: '0x6', after: '0x8' } }, { address: B, storage: [changed(1, 7, 9), changed(2, 5, 0)] }];
  assert.deepEqual(check(before, after), valid);
});

test('query cannot clear an original write, restore its base value, change a cleared slot, or introduce another write', () => {
  const before = [{ address: B, storage: [changed(1, 7, 9), changed(2, 5, 0)] }];
  for (const storage of [[changed(1, 7, 0), changed(2, 5, 0)], [changed(2, 5, 0)], [changed(1, 7, 9), changed(2, 5, 5)], [changed(1, 7, 9), changed(2, 5, 1)], [changed(1, 7, 9), changed(2, 5, 0), changed(3, 0, 1)]]) rejected(() => check(before, [{ address: A, nonce }, { address: B, storage }]));
  rejected(() => check(before, [{ address: A, nonce }]));
});

test('native changes on sender or other accounts are rejected while original unrelated changes remain valid', () => {
  const original = { address: C, balance: { before: '0x1', after: '0x2' } };
  assert.deepEqual(check([original], [{ address: A, nonce }, original]), valid);
  for (const account of [A, B]) rejected(() => check([], account === A ? [{ address: A, nonce, balance: { before: '0x1', after: '0x0' } }] : [{ address: A, nonce }, { address: B, balance: { before: '0x0', after: '0x1' } }]));
});

test('proven absent sender admits only nonce materialization; fabricated presence and other changes are not normalized', () => {
  const materialized = { address: A, existence: { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' }, nonce: { before: '0x0', after: '0x1' } };
  const options = { nonceBefore: '0', senderExistedBefore: false };
  assert.deepEqual(check([], [materialized], options), valid);
  rejected(() => check([], [materialized], { nonceBefore: '0' }));
  rejected(() => check([], [{ address: A, nonce: materialized.nonce }], options));
  rejected(() => check([], [{ ...materialized, balance: { before: '0x0', after: '0x1' } }], options));
  rejected(() => check([], [{ ...materialized, existence: { ...materialized.existence, basis: 'positive_native_funding_of_proof_absent_account' } }], options));
  rejected(() => check([], [materialized], { nonceBefore: '1', senderExistedBefore: false }));
});

test('sender materialized by original execution preserves that existence change through the query', () => {
  const original = { address: A, existence: { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' }, nonce: { before: '0x0', after: '0x1' } };
  const after = { ...original, nonce: { before: '0x0', after: '0x2' } };
  assert.deepEqual(check([original], [after], { nonceBefore: '1' }), valid);
  rejected(() => check([original], [after], { nonceBefore: '1', senderExistedBefore: false }));
  rejected(() => check([original], [{ address: A, nonce: after.nonce }], { nonceBefore: '1' }));
});

test('current sender nonce must agree with the prior overlay, and other nonce changes cannot be hidden', () => {
  rejected(() => check([{ address: A, nonce: { before: '0x5', after: '0x6' } }], [{ address: A, nonce: { before: '0x5', after: '0x8' } }]));
  rejected(() => check([], [{ address: A, nonce }, { address: B, nonce: { before: '0x1', after: '0x2' } }]));
  for (const nonceBefore of ['07', '-1', '0x7', 7, '18446744073709551615', '18446744073709551616']) rejected(() => check([], [{ address: A, nonce }], { nonceBefore }));
  assert.deepEqual(check([], [{ address: A, nonce: { before: '0xfffffffffffffffe', after: '0xffffffffffffffff' } }], { nonceBefore: '18446744073709551614' }), valid);
});

test('existence changes must describe supported materialization, with zero prior native state and no new storage', () => {
  const existence = { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' };
  const original = { address: B, existence, balance: { before: '0x0', after: '0x10' } };
  assert.deepEqual(check([original], [original, { address: A, nonce }]), valid);
  for (const row of [{ address: B, existence }, { ...original, balance: { before: '0x1', after: '0x10' } }, { ...original, storage: [changed(1, 0, 1)] }, { ...original, nonce: { before: '0x0', after: '0x1' } }]) rejected(() => check([row], [row, { address: A, nonce }]));
});

test('malformed deltas, duplicate accounts/slots and unknown fields fail even when repeated on both snapshots', () => {
  const invalid = [
    [{ address: B }], [{ address: B, storage: [] }], [{ address: B, balance: { before: '0x0', after: '0x0' } }],
    [{ address: B, nonce: { before: '0x0', after: '0x10000000000000000' } }],
    [{ address: B, balance: { before: '0x00', after: '0x1' } }], [{ address: B, balance: { before: '0x0', after: '0x' + '1' + '0'.repeat(64) } }],
    [{ address: B, storage: [changed(1, 0, 1), changed(1, 0, 1)] }],
    [{ address: B, storage: [changed(1, 0, 1)] }, { address: B, storage: [changed(2, 0, 1)] }],
    [{ address: B, code: '0x00' }], [{ address: B, balance: { before: '0x0', after: '0x1', ignored: true } }],
    [{ address: B, storage: [{ ...changed(1, 0, 1), after: '0x1' }] }],
  ];
  for (const rows of invalid) rejected(() => check(rows, [...rows, { address: A, nonce }]));
  rejected(() => check([], [{ address: A, nonce }], { before: { ...snapshot([]), extra: true } }));
  rejected(() => check([], [{ address: A, nonce }], { sender: [A] }));
});

test('bounded snapshots reject excessive accounts/slots and do not execute supplied getters', () => {
  const accounts = Array.from({ length: 129 }, (_, i) => ({ address: '0x' + BigInt(i + 100).toString(16).padStart(40, '0'), balance: { before: '0x0', after: '0x1' } }));
  rejected(() => check(accounts, accounts));
  const storage = Array.from({ length: 1025 }, (_, i) => changed(i, 0, 1)); rejected(() => check([{ address: B, storage }], [{ address: A, nonce }]));
  let calls = 0; const row = { address: B }; Object.defineProperty(row, 'balance', { enumerable: true, get() { calls++; throw new Error('PRIVATE_MARKER'); } });
  rejected(() => check([row], [{ address: A, nonce }])); assert.equal(calls, 0);
  const trap = new Proxy(snapshot([]), { getPrototypeOf() { calls++; throw new Error('PRIVATE_MARKER'); } });
  rejected(() => check([], [{ address: A, nonce }], { before: trap })); assert.equal(calls, 0);
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  rejected(() => check([], [{ address: A, nonce }], { before: { ...snapshot([]), accounts: revoked.proxy } }));
  const inherited = []; Object.setPrototypeOf(inherited, { [Symbol.iterator]() { calls++; throw new Error('PRIVATE_MARKER'); } });
  rejected(() => check([], [{ address: A, nonce }], { before: { ...snapshot([]), accounts: inherited } })); assert.equal(calls, 0);
});

test('identical net snapshots do not claim to rule out transient writes', () => {
  // Synthetic snapshots only: a write followed by its restoration is absent
  // from a net diff. Opcode/log restrictions belong to the query executor.
  assert.deepEqual(check([], [{ address: A, nonce }]), valid);
  assert.equal(Object.hasOwn(valid, 'pureView'), false);
});

const created = (address = B) => ({ address, existence: { before: false, after: true, basis: 'internal_contract_creation' }, nonce: { before: '0x0', after: '0x1' }, code: { before: '0x', after: '0x60005460005260206000f3' }, storage: [changed(0, 0, 42)] });

test('nested creation-shaped original rows and prefunded deployment carry unchanged through a disposable query', () => {
  // Synthetic output shapes from nested CREATE/CREATE2, not claimed execution
  // evidence: the outer created contract also creates a child (nonce1 ->2).
  const outer = { ...created(B), nonce: { before: '0x0', after: '0x2' }, storage: [changed(2, 0, 8), changed(1, 0, 7)] };
  const inner = created(C), prefunded = { ...created('0x' + '44'.repeat(20)), balance: { before: '0x10', after: '0x5' } };
  delete prefunded.existence;
  const before = [outer, inner, prefunded, { address: A, nonce: { before: '0x6', after: '0x7' } }];
  const after = [prefunded, { address: A, nonce: { before: '0x6', after: '0x8' } }, inner, { ...outer, storage: [...outer.storage].reverse() }];
  const saved = structuredClone({ before, after });
  assert.deepEqual(check(before, after), valid); assert.deepEqual({ before, after }, saved);
  const normalized = canonicalStateChanges(snapshot(before));
  normalized.accounts.find(row => row.address === B).code.after = '0x00';
  normalized.accounts.find(row => row.address === C).storage[0].after = word(9);
  assert.deepEqual({ before, after }, saved, 'Canonical output must be detached');
});

test('empty-runtime creation and prefunded empty-runtime nonce/storage changes remain explicit deltas', () => {
  const empty = created(); delete empty.code;
  assert.deepEqual(check([empty], [{ address: A, nonce }, empty]), valid);
  const prefunded = { address: C, nonce: { before: '0x0', after: '0x1' }, storage: [changed(0, 0, 3)] };
  assert.deepEqual(check([prefunded], [prefunded, { address: A, nonce }]), valid);
  // No lifecycle label is invented where the delta cannot identify creation.
  assert.equal(Object.hasOwn(canonicalStateChanges(snapshot([prefunded])).accounts[0], 'existence'), false);
});

test('queries cannot introduce creation, change/remove deployed code or mutate carried creation state', () => {
  const prior = created();
  rejected(() => check([], [{ address: A, nonce }, prior]));
  for (const mutate of [
    row => { row.code.after = '0x00'; }, row => { delete row.code; },
    row => { row.nonce.after = '0x2'; }, row => { row.storage[0].after = word(43); },
    row => { delete row.existence; }, row => { row.balance = { before: '0x0', after: '0x1' }; },
  ]) {
    const next = structuredClone(prior); mutate(next);
    rejected(() => check([prior], [{ address: A, nonce }, next]));
  }
  rejected(() => check([prior], [{ address: A, nonce }]));
  rejected(() => check([prior], [{ address: A, nonce }, prior, created(C)]));
  rejected(() => check([], [{ ...created(A), nonce: { before: '0x0', after: '0x1' } }], { nonceBefore: '0', senderExistedBefore: false }));
});

test('deployment schema rejects unsupported replacement, impossible origin and nonzero initial storage', () => {
  const mutations = [
    row => { row.code.before = '0x00'; }, row => { row.code.after = '0x'; },
    row => { row.code.after = '0x0'; }, row => { row.code.after = '0xAA'; },
    row => { row.code.hash = word(1); }, row => { row.nonce.before = '0x1'; row.nonce.after = '0x2'; },
    row => { delete row.nonce; }, row => { row.storage[0].before = word(1); },
    row => { row.balance = { before: '0x1', after: '0x2' }; },
    row => { row.existence.basis = 'unsigned_sender_nonce_materialization'; },
    row => { row.existence.before = true; }, row => { row.existence.after = false; },
  ];
  for (const mutate of mutations) {
    const row = created(); mutate(row);
    rejected(() => canonicalStateChanges(snapshot([row])));
    rejected(() => check([row], [{ address: A, nonce }, row]));
  }
  const prefunded = created(); delete prefunded.existence; prefunded.storage[0].before = word(2);
  rejected(() => canonicalStateChanges(snapshot([prefunded])));
});

test('creation code and aggregate output slots obey fixed bounds without weakening duplicate checks', () => {
  const maximum = created(); maximum.code.after = '0x' + '00'.repeat(24576);
  assert.deepEqual(check([maximum], [maximum, { address: A, nonce }]), valid);
  const excess = structuredClone(maximum); excess.code.after += '00'; rejected(() => canonicalStateChanges(snapshot([excess])));
  const first = created(), second = created(C);
  first.storage = Array.from({ length: 512 }, (_, i) => changed(i, 0, 1));
  second.storage = Array.from({ length: 512 }, (_, i) => changed(i, 0, 1));
  assert.deepEqual(check([first, second], [second, { address: A, nonce }, first]), valid);
  second.storage.push(changed(512, 0, 1)); rejected(() => canonicalStateChanges(snapshot([first, second])));
  rejected(() => canonicalStateChanges(snapshot([created(), created()])));
  const duplicate = created(); duplicate.storage.push({ ...duplicate.storage[0] }); rejected(() => canonicalStateChanges(snapshot([duplicate])));
});

test('new code and existence fields reject hostile nested descriptors without evaluating them', () => {
  let calls = 0;
  const row = created(); Object.defineProperty(row.code, 'after', { enumerable: true, get() { calls++; throw new Error('PRIVATE'); } });
  rejected(() => canonicalStateChanges(snapshot([row])));
  const proxy = created(); proxy.code = new Proxy(proxy.code, { ownKeys() { calls++; throw new Error('PRIVATE'); } });
  rejected(() => canonicalStateChanges(snapshot([proxy])));
  const existence = created(); Object.defineProperty(existence.existence, 'basis', { enumerable: true, get() { calls++; return 'internal_contract_creation'; } });
  rejected(() => canonicalStateChanges(snapshot([existence])));
  const hidden = created(); Object.defineProperty(hidden.code, 'ignored', { value: true }); rejected(() => canonicalStateChanges(snapshot([hidden])));
  const symbolic = created(); symbolic.code[Symbol('ignored')] = true; rejected(() => canonicalStateChanges(snapshot([symbolic])));
  const inherited = created(); Object.setPrototypeOf(inherited.code, { after: '0x00' }); rejected(() => canonicalStateChanges(snapshot([inherited])));
  assert.equal(calls, 0);
});
