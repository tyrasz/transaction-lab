import test from 'node:test';
import assert from 'node:assert/strict';
import { guardKzgVerifier } from '../kzg-runtime.js';
import { KzgInputError } from '../kzg-point-evaluation.js';

test('KZG adapter distinguishes completed proof results and malformed inputs from host failure', () => {
  for (const result of [true, false]) {
    let checks = 0; const failures = [], args = ['commitment', 'z', 'y', 'proof'];
    const adapter = guardKzgVerifier((...actual) => { assert.deepEqual(actual, args); return result; }, () => checks++, error => failures.push(error));
    assert.equal(adapter.verifyProof(...args), result); assert.equal(checks, 2); assert.deepEqual(failures, []);
  }
  const bad = new KzgInputError(), failures = [];
  const adapter = guardKzgVerifier(() => { throw bad; }, () => {}, error => failures.push(error));
  assert.throws(() => adapter.verifyProof(), error => error === bad); assert.deepEqual(failures, []);
});

test('KZG adapter latches all unexpected thrown values and rejects non-boolean verifiers', () => {
  for (const value of [new Error('host'), null, undefined, 'host']) {
    const failures = [], adapter = guardKzgVerifier(() => { throw value; }, () => {}, error => failures.push(error));
    let threw = false; try { adapter.verifyProof(); } catch (error) { threw = true; assert.equal(error, value); }
    assert.equal(threw, true); assert.equal(failures.length, 1); assert.equal(failures[0], value);
  }
  for (const value of [undefined, null, 0, 1, 'true', Promise.resolve(true)]) {
    const failures = [], adapter = guardKzgVerifier(() => value, () => {}, error => failures.push(error));
    assert.throws(() => adapter.verifyProof(), /non-boolean/); assert.equal(failures.length, 1);
  }
});

test('KZG adapter checks and latches the budget before and after synchronous verification', () => {
  for (const failAt of [1, 2]) {
    let checks = 0, calls = 0; const failure = new Error('budget'), failures = [];
    const adapter = guardKzgVerifier(() => { calls++; return true; }, () => { if (++checks === failAt) throw failure; }, error => failures.push(error));
    assert.throws(() => adapter.verifyProof(), error => error === failure);
    assert.equal(calls, failAt - 1); assert.equal(checks, failAt); assert.deepEqual(failures, [failure]);
  }
});
