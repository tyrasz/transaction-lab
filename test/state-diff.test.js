import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalStateDiff, assertStateDiffMatch } from '../src/state-diff.js';
import { StateValidationError, UINT256_MAX } from '../src/state.js';
import { compareTraces } from '../reports/system-position-diagnostic/frozen/evaluation-comparator.js';

const bytes = await readFile(new URL('../reports/system-position-diagnostic/capture.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b');
const capture = JSON.parse(bytes);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const upper = s => '0x' + s.slice(2).toUpperCase();
const small = () => ({ pre: { [ACCOUNT]: { balance: '0x10', nonce: 2, code: '0x6000', storage: { [word(10)]: word(15) } } }, post: { [ACCOUNT]: { balance: '0x0f', nonce: 3, storage: { [word(10)]: word(16) } } } });
const reject = diff => assert.throws(() => canonicalStateDiff(diff), StateValidationError);

test('diagnostic comparator fixtures retain all original response bytes and RPC identities', () => {
  assert.equal(capture.records.length, 86);
  for (const record of capture.records) {
    assert.equal(createHash('sha256').update(record.responseRaw).digest('hex'), record.responseSha256);
    assert.deepEqual(JSON.parse(record.responseRaw), record.response);
    assert.equal(record.response.id, record.request.id);
    assert.equal(record.response.error, undefined);
  }
});

for (const provider of capture.providers) for (const observed of provider.cases) test(`observed original/replay diff: ${provider.provider}, ordinary position ${observed.ordinaryIndex}`, () => {
  const original = observed.originalDiff.result;
  assert.deepEqual(original, capture.records[observed.originalDiff.rpcId - 1].response.result);
  const wrong = observed.replays.find(replay => replay.position === observed.ordinaryIndex);
  const correct = observed.replays.find(replay => replay.position === observed.extendedIndex);
  for (const replay of [wrong, correct]) {
    const record = capture.records[replay.diff.rpcId - 1];
    assert.equal(record.request.method, 'debug_traceCallMany');
    assert.equal(record.request.params[1].transactionIndex, replay.position);
    assert.deepEqual(replay.diff.result, record.response.result);
  }
  const snapshot = structuredClone(original);
  assertStateDiffMatch(original, correct.diff.result[0][0]);
  assert.throws(() => assertStateDiffMatch(original, wrong.diff.result[0][0]), /Original-position replay state diff does not match/);
  assert.deepEqual(original, snapshot, 'Normalization must not alter captured evidence');
  assert.equal(compareTraces(observed.originalTrace.result, correct.trace.result[0][0]).status, 'matched');
  if ([1, 2].includes(observed.ordinaryIndex)) {
    assert.equal(compareTraces(observed.originalTrace.result, wrong.trace.result[0][0]).status, 'matched', 'This negative is a real full-trace false match');
    const zero = address(0), before = original.pre[zero].balance, wrongBefore = wrong.diff.result[0][0].pre[zero].balance;
    const delta = diff => BigInt(diff.post[zero].balance) - BigInt(diff.pre[zero].balance);
    assert.notEqual(before, wrongBefore);
    assert.equal(delta(original), delta(wrong.diff.result[0][0]), 'Equal native fee deltas do not bind absolute state');
  }
});

test('canonical equality normalizes object order, integer representation and hex case only', () => {
  const original = small();
  const equivalent = {
    post: { [upper(ACCOUNT)]: { storage: { [upper(word(10))]: upper(word(16)) }, nonce: '0x3', balance: 15 } },
    pre: { [upper(ACCOUNT)]: { storage: { [upper(word(10))]: upper(word(15)) }, code: '0x6000', nonce: '2', balance: '16' } },
  };
  assertStateDiffMatch(original, equivalent);
  assert.deepEqual(canonicalStateDiff(original), canonicalStateDiff(equivalent));
  assert.deepEqual(canonicalStateDiff({ pre: {}, post: {} }), { pre: {}, post: {} });
  const maximum = { pre: { [ACCOUNT]: { balance: UINT256_MAX.toString(), nonce: ((1n << 64n) - 1n).toString() } }, post: {} };
  assert.equal(canonicalStateDiff(maximum).pre[ACCOUNT].balance, UINT256_MAX.toString());
});

test('absolute pre and post values matter even when every delta is unchanged', () => {
  const original = small(), shifted = small();
  for (const side of ['pre', 'post']) shifted[side][ACCOUNT].balance = String(BigInt(shifted[side][ACCOUNT].balance) + 100n);
  assert.equal(BigInt(original.post[ACCOUNT].balance) - BigInt(original.pre[ACCOUNT].balance), BigInt(shifted.post[ACCOUNT].balance) - BigInt(shifted.pre[ACCOUNT].balance));
  assert.throws(() => assertStateDiffMatch(original, shifted), StateValidationError);
  const changedPreStorage = small(); changedPreStorage.pre[ACCOUNT].storage[word(10)] = word(14);
  assert.throws(() => assertStateDiffMatch(original, changedPreStorage), StateValidationError);
});

test('omission, zero values, empty storage and code presence remain distinct', () => {
  const absent = { pre: { [ACCOUNT]: {} }, post: { [ACCOUNT]: {} } };
  for (const addition of [{ balance: '0x0' }, { nonce: 0 }, { code: '0x' }, { storage: {} }]) {
    const present = structuredClone(absent); Object.assign(present.pre[ACCOUNT], addition);
    assert.throws(() => assertStateDiffMatch(absent, present), StateValidationError);
  }
  const cleared = { pre: { [ACCOUNT]: { storage: { [word(1)]: word(1) } } }, post: { [ACCOUNT]: { storage: {} } } };
  const explicitZero = structuredClone(cleared); explicitZero.post[ACCOUNT].storage[word(1)] = word(0);
  assert.throws(() => assertStateDiffMatch(cleared, explicitZero), StateValidationError);
  const missingAccount = small(); delete missingAccount.post[ACCOUNT];
  assert.throws(() => assertStateDiffMatch(small(), missingAccount), StateValidationError);
  const missingField = small(); delete missingField.pre[ACCOUNT].code;
  assert.throws(() => assertStateDiffMatch(small(), missingField), StateValidationError);
});

test('unknown fields and malformed shapes are rejected before comparison', () => {
  for (const diff of [null, [], {}, { pre: {}, post: {}, error: 'private detail' }, { pre: null, post: {} }, { pre: [], post: {} }, { pre: {}, post: undefined }, { pre: { [ACCOUNT]: [] }, post: {} }]) reject(diff);
  for (const change of [
    x => { x.pre[ACCOUNT].unknown = 'PRIVATE_PROVIDER_VALUE'; },
    x => { x.pre[ACCOUNT].balance = null; }, x => { x.pre[ACCOUNT].nonce = -1; },
    x => { x.pre[ACCOUNT].nonce = Number.MAX_SAFE_INTEGER + 1; }, x => { x.pre[ACCOUNT].nonce = (1n << 64n).toString(); },
    x => { x.pre[ACCOUNT].balance = (UINT256_MAX + 1n).toString(); }, x => { x.pre[ACCOUNT].balance = [16]; },
    x => { x.pre[ACCOUNT].balance = 1.1; }, x => { x.pre[ACCOUNT].balance = Infinity; },
    x => { x.pre[ACCOUNT].balance = 1n; }, x => { x.pre[ACCOUNT].balance = '0xz'; },
    x => { x.pre[ACCOUNT].code = ['0x6000']; }, x => { x.pre[ACCOUNT].code = '0x0'; },
    x => { x.pre[ACCOUNT].storage = null; }, x => { x.pre[ACCOUNT].storage = []; },
    x => { x.pre[ACCOUNT].storage = { '0x01': word(1) }; },
    x => { x.pre[ACCOUNT].storage[word(10)] = [word(1)]; },
    x => { x.pre[ACCOUNT].storage[word(10)] = '0x1'; },
    x => { x.pre.bad = {}; }, x => { x.post = new Date(); },
  ]) { const invalid = small(); change(invalid); reject(invalid); }
  const poison = small(); poison.pre[ACCOUNT].privateField = 'PRIVATE_PROVIDER_VALUE';
  assert.throws(() => canonicalStateDiff(poison), error => error instanceof StateValidationError && !error.message.includes('PRIVATE_PROVIDER_VALUE'));
});

test('normalized key collisions and non-JSON object behavior fail closed', () => {
  const accountCollision = small(); accountCollision.pre[upper(ACCOUNT)] = {};
  assert.throws(() => canonicalStateDiff(accountCollision), /colliding normalized account/);
  const slotCollision = small(); slotCollision.pre[ACCOUNT].storage[upper(word(10))] = word(15);
  assert.throws(() => canonicalStateDiff(slotCollision), /colliding normalized storage/);
  for (const change of [
    x => { Object.defineProperty(x.pre[ACCOUNT], 'balance', { get() { throw new Error('MUST_NOT_RUN'); }, enumerable: true }); },
    x => { x.pre[ACCOUNT][Symbol('private')] = 1; },
    x => { Object.defineProperty(x.pre[ACCOUNT], 'hidden', { value: 'private', enumerable: false }); },
    x => { Object.setPrototypeOf(x.pre[ACCOUNT], { inherited: true }); },
  ]) { const invalid = small(); change(invalid); assert.throws(() => canonicalStateDiff(invalid), StateValidationError); }
});

test('100-account and 2000-slot bounds count the pre/post union without double counting', () => {
  const accounts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [address(i), {}]));
  const bounded = { pre: accounts, post: structuredClone(accounts) };
  assert.equal(Object.keys(canonicalStateDiff(bounded).pre).length, 100);
  bounded.post[address(100)] = {}; assert.throws(() => canonicalStateDiff(bounded), /100-account/);
  const storage = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [word(i), word(i)]));
  const slots = { pre: { [ACCOUNT]: { storage } }, post: { [ACCOUNT]: { storage: structuredClone(storage) } } };
  assert.equal(Object.keys(canonicalStateDiff(slots).pre[ACCOUNT].storage).length, 2000);
  slots.post[ACCOUNT].storage[word(2000)] = word(0); assert.throws(() => canonicalStateDiff(slots), /2000-slot/);
  delete slots.post[ACCOUNT].storage[word(2000)];
  slots.post[address(1)] = { storage: { [word(1)]: word(0) } };
  assert.throws(() => canonicalStateDiff(slots), /2000-slot/, 'The same slot at a different account is distinct');
});

test('contract code text is bounded independently of transport response limits', () => {
  const oversized = { pre: { [ACCOUNT]: { code: '0x' + '00'.repeat(4 * 1024 * 1024) } }, post: {} };
  assert.throws(() => canonicalStateDiff(oversized), /code evidence exceeds/);
});
