// Pure delta representation controls. Hypothetical deltas are not EVM results;
// a representable result may still disagree with the independent observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {declaration} from './cases.mjs';
import {applyCandidateDelta} from './delta.mjs';
import {allocationRoot, normalizeAllocation, word} from '../amsterdam-storage-creation-v033/observations.mjs';

const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const BASIS = 'contract_creation_storage_clear', ZERO = word(0);
const EMPTY = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const snapshot = (...accounts) => ({scope: SCOPE, accounts});
let prepared;
const inputs = () => prepared ??= Promise.all([declaration(0), declaration(5)]);

function creation(input, {balance = true, storage = true} = {}) {
  return {
    address: input.target,
    reset: {basis: BASIS, initialStorageRoot: input.initialTargetStorageRoot},
    nonce: {before: '0x0', after: '0x1'},
    code: {before: '0x', after: '0x00'},
    ...(balance ? {balance: {before: '0x11', after: '0x16'}} : {}),
    ...(storage ? {storage: [
      {slot: word(0), before: ZERO, after: word(999)},
      {slot: word(2), before: ZERO, after: word(42)},
    ]} : {}),
  };
}

async function rejects(input, changes, mutate) {
  const candidate = structuredClone(input), delta = structuredClone(changes);
  await mutate(candidate, delta);
  await assert.rejects(applyCandidateDelta(candidate, delta));
}

test('full prestate and target storage roots are independently bound before applying deltas', async () => {
  for (const input of await inputs()) {
    for (const mutate of [
      i => {i.initialStateRoot = word(1); i.header.stateRoot = word(1);},
      i => {i.header.stateRoot = word(1);},
      i => {i.initialTargetStorageRoot = EMPTY;},
      i => {i.allocation[i.target].storage[word(991)] = word(55);},
      async i => {
        i.allocation[i.target].storage[word(991)] = word(55);
        i.initialStateRoot = await allocationRoot(i.allocation);
        i.header.stateRoot = i.initialStateRoot;
      },
    ]) await rejects(input, snapshot(), mutate);
  }
});

test('reset authenticates the old full storage root and deployment cannot omit it', async () => {
  const [input] = await inputs(), changes = snapshot(creation(input));
  for (const mutate of [
    (_i, d) => {d.accounts[0].reset.initialStorageRoot = EMPTY;},
    (_i, d) => {d.accounts[0].reset.initialStorageRoot = word(9);},
    (_i, d) => {delete d.accounts[0].reset;},
    (_i, d) => {delete d.accounts[0].nonce;},
    (_i, d) => {d.accounts[0].reset.extra = true;},
  ]) await rejects(input, changes, mutate);
});

test('a fresh namespace retains old-equal 999, removes hidden 991, and preserves omitted prefunding', async () => {
  const [input] = await inputs(), prior = structuredClone(input);
  const changes = snapshot(creation(input, {balance: false})), saved = structuredClone(changes);
  const out = await applyCandidateDelta(input, changes);
  assert.deepEqual(out[input.target], {
    nonce: '0x1', balance: '0x11', code: '0x00',
    storage: {[word(0)]: word(999), [word(2)]: word(42)},
  });
  assert.equal(Object.hasOwn(out[input.target].storage, word(991)), false);
  for (const [address, account] of Object.entries(normalizeAllocation(input.allocation))) {
    if (address !== input.target) assert.deepEqual(out[address], account);
  }
  assert.deepEqual(input, prior);
  assert.deepEqual(changes, saved);
  const cleared = await applyCandidateDelta(input, snapshot(creation(input, {storage: false})));
  assert.deepEqual(cleared[input.target].storage, {});
  assert.equal(cleared[input.target].balance, '0x16');
});

test('reset storage before-values are zero while account fields retain their actual prestate', async () => {
  const [input] = await inputs(), changes = snapshot(creation(input));
  for (const mutate of [
    (_i, d) => {d.accounts[0].storage[0].before = word(999);},
    (_i, d) => {d.accounts[0].storage[0].after = ZERO;},
    (_i, d) => {d.accounts[0].balance.before = '0x0';},
    (_i, d) => {d.accounts[0].nonce.before = '0x1';},
    (_i, d) => {d.accounts[0].code.before = '0x00';},
    (_i, d) => {d.accounts[0].storage.push(structuredClone(d.accounts[0].storage[0]));},
  ]) await rejects(input, changes, mutate);
});

test('whole-account deletion, foreign reset families, and arbitrary-account resets are rejected', async () => {
  for (const input of await inputs()) {
    for (const basis of [
      'same_invocation_created_contract_deletion',
      'shanghai_selfdestruct_deletion',
      'same_invocation_created_contract_clearing_eip8246',
      'eip161_empty_account_cleanup',
    ]) {
      await assert.rejects(applyCandidateDelta(input, snapshot({
        address: input.target, existence: {before: true, after: false, basis},
      })));
      const row = creation(input);
      row.reset.basis = basis;
      await assert.rejects(applyCandidateDelta(input, snapshot(row)));
    }
    const sender = input.allocation[input.request.from];
    await assert.rejects(applyCandidateDelta(input, snapshot({
      address: input.request.from,
      nonce: {before: sender.nonce, after: '0x' + (BigInt(sender.nonce) + 1n).toString(16)},
      reset: {basis: BASIS, initialStorageRoot: input.initialTargetStorageRoot},
    })));
  }
});

test('a rollback declaration can represent an unchanged target alongside independent account deltas', async () => {
  const [, input] = await inputs();
  assert.equal(input.scenario, 'ancestor_revert');
  assert.deepEqual(await applyCandidateDelta(input, snapshot()), normalizeAllocation(input.allocation));
  const sender = input.allocation[input.request.from];
  const changes = snapshot({
    address: input.request.from,
    nonce: {before: sender.nonce, after: '0x2'},
    balance: {before: sender.balance, after: '0x' + (BigInt(sender.balance) - 10n).toString(16)},
  });
  const out = await applyCandidateDelta(input, changes);
  assert.deepEqual(out[input.target], normalizeAllocation(input.allocation)[input.target]);
  assert.equal(out[input.request.from].nonce, '0x2');
  assert.equal(BigInt(out[input.request.from].balance), BigInt(sender.balance) - 10n);
});

test('scenario labels do not force outcomes: a retained reset on rollback remains representable', async () => {
  const [, input] = await inputs();
  const out = await applyCandidateDelta(input, snapshot(creation(input)));
  assert.equal(input.scenario, 'ancestor_revert');
  assert.equal(out[input.target].nonce, '0x1');
  assert.equal(out[input.target].storage[word(0)], word(999));
  assert.equal(Object.hasOwn(out[input.target].storage, word(991)), false);
  assert.notDeepEqual(out[input.target], normalizeAllocation(input.allocation)[input.target]);
  // The comparator must report any disagreement with independent execution;
  // reconstruction must not erase or reject a structurally valid observation.
});
