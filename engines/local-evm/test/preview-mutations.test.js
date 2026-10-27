import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueryMutation } from '../preview-mutations.js';

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
