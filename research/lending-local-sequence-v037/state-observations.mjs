// Pure saved-state arithmetic. The caller must separately verify the immutable
// input proofs, their evidence/header binding, and each execution disposition.
// This does not execute either client or compute a complete post-state root.
import { isDeepStrictEqual, types } from 'node:util';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';

const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const ZERO = '0x' + '0'.repeat(64), EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const MAX = (1n << 256n) - 1n, NONCE = (1n << 64n) - 1n;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const own = (x, key) => Object.hasOwn(x, key);
const hex = x => '0x' + x.toString(16);
const hashCode = code => '0x' + Buffer.from(keccak_256(Buffer.from(code.slice(2), 'hex'))).toString('hex');
export const STATE_COMPARISON_SCOPE = 'complete_observed_cumulative_net_changes_not_state_root';

function record(x, allowed, required = []) {
  need(x && typeof x === 'object' && !types.isProxy(x) && !Array.isArray(x)
    && [Object.prototype, null].includes(Object.getPrototypeOf(x)), 'Expected a plain state record');
  for (const key of Reflect.ownKeys(x)) {
    const d = Object.getOwnPropertyDescriptor(x, key);
    need(typeof key === 'string' && d.enumerable && own(d, 'value') && (!allowed || allowed.includes(key)), 'Unexpected state field or accessor');
  }
  need(required.every(key => own(x, key)), 'Missing state field');
  return x;
}
function list(x, min, max) {
  need(Array.isArray(x) && !types.isProxy(x) && Object.getPrototypeOf(x) === Array.prototype, 'Expected a plain state list');
  need(x.length >= min && x.length <= max && Reflect.ownKeys(x).length === x.length + 1, 'State list bound or extra field');
  for (let i = 0; i < x.length; i++) {
    const d = Object.getOwnPropertyDescriptor(x, String(i));
    need(d?.enumerable && own(d, 'value'), 'State list hole or accessor');
  }
  return x;
}
function quantity(x, max = MAX) {
  need((typeof x === 'string' && x.length <= 80 && /^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-f][0-9a-f]*))$/.test(x))
    || (Number.isSafeInteger(x) && x >= 0), 'Invalid exact state quantity');
  const n = BigInt(x); need(n <= max, 'State quantity overflow'); return n;
}
function word(x) { need(typeof x === 'string' && WORD.test(x), 'Noncanonical storage word'); return x; }
function code(x) { need(typeof x === 'string' && x.length <= 131074 && DATA.test(x), 'Invalid runtime code'); return x; }
function address(x) { need(typeof x === 'string' && ADDRESS.test(x), 'Noncanonical account address'); return x; }

function initialFacts(inputs) {
  record(inputs); record(inputs.accounts); list(inputs.provenance, 0, 256);
  need(Object.keys(inputs.accounts).length <= 256, 'Initial account bound');
  const provenance = new Map();
  for (const p of inputs.provenance) {
    record(p); address(p.account); need(!provenance.has(p.account), 'Duplicate account provenance'); provenance.set(p.account, p);
  }
  const facts = new Map(); let slots = 0;
  for (const [key, a] of Object.entries(inputs.accounts)) {
    address(key); record(a); need(typeof a.exists === 'boolean', 'Account existence must be explicit');
    const accountFields = a.exists ? ['exists', 'nonce', 'balance', 'code', 'storage'] : ['exists'];
    record(a, accountFields, accountFields);
    const p = provenance.get(key); need(p, 'Initial account lacks proof metadata'); record(p.accountProof);
    const proof = p.accountProof;
    need(typeof a.exists === 'boolean' && proof.exists === a.exists, 'Account existence/proof mismatch');
    const nonce = a.exists ? quantity(a.nonce, NONCE) : 0n, balance = a.exists ? quantity(a.balance) : 0n, runtime = a.exists ? code(a.code) : '0x';
    need(quantity(proof.nonceRaw, NONCE) === nonce && quantity(proof.balanceRaw) === balance, 'Account scalar/proof mismatch');
    word(proof.storageRoot); need(word(proof.codeHash) === hashCode(runtime), 'Account code/proof mismatch');
    const sourceStorage = a.exists ? record(a.storage) : {}; list(p.storage, 0, 2000); const proven = new Map();
    for (const s of p.storage) {
      record(s); word(s.key); word(s.value); need(!proven.has(s.key), 'Duplicate storage provenance'); proven.set(s.key, s.value);
    }
    const storage = {};
    for (const [slot, value] of Object.entries(sourceStorage)) {
      word(slot); word(value); need(++slots <= 2000, 'Initial storage bound');
      need(proven.get(slot) === value, 'Initial slot lacks matching proof metadata'); storage[slot] = value;
    }
    if (a.exists) need(proven.size === Object.keys(storage).length, 'Unjoined storage proof metadata');
    else need([...proven.values()].every(v => v === ZERO), 'Nonzero absent-account slot metadata');
    if (!a.exists) need(nonce === 0n && balance === 0n && runtime === '0x' && proof.storageRoot === EMPTY_ROOT
      && Object.values(storage).every(v => v === ZERO), 'Nonempty absent account facts');
    if (proof.storageRoot === EMPTY_ROOT) need(Object.values(storage).every(v => v === ZERO), 'Empty root contradicts slot facts');
    facts.set(key, { exists: a.exists, nonce, balance, code: runtime, codeHash: proof.codeHash, storageRoot: proof.storageRoot, storage });
  }
  need(provenance.size === facts.size, 'Unjoined account proof metadata'); return facts;
}
function account(facts, key) {
  const a = facts.get(address(key)); need(a, 'Changed account lacks authenticated initial anchor');
  need(a.exists, 'Account materialization is outside this state comparator'); return a;
}
function initialSlot(a, key) {
  word(key); if (own(a.storage, key)) return a.storage[key];
  need(a.storageRoot === EMPTY_ROOT, 'Changed slot lacks authenticated initial anchor'); return ZERO;
}
function cloneOverlay(overlay) { return new Map([...overlay].map(([a, s]) => [a, { ...s, storage: { ...s.storage } }])); }
function current(facts, overlay, key) {
  const a = account(facts, key); return overlay.get(key) ?? { nonce: a.nonce, balance: a.balance, storage: {} };
}
function currentSlot(facts, state, key, slot) { return own(state.storage, slot) ? state.storage[slot] : initialSlot(account(facts, key), slot); }
function normalized(facts, overlay) {
  const rows = []; let slots = 0;
  for (const [key, s] of [...overlay].sort(([a], [b]) => a.localeCompare(b))) {
    const a = account(facts, key), row = { address: key };
    for (const field of ['nonce', 'balance']) if (s[field] !== a[field]) row[field] = { before: hex(a[field]), after: hex(s[field]) };
    const storage = Object.entries(s.storage).sort(([a], [b]) => a.localeCompare(b)).flatMap(([slot, after]) => {
      need(++slots <= 2000, 'Cumulative storage bound');
      const before = initialSlot(a, slot); return before === after ? [] : [{ slot, before, after }];
    });
    if (storage.length) row.storage = storage;
    if (Object.keys(row).length > 1) rows.push(row);
  }
  return { accounts: rows };
}
function localOverlay(changes, facts) {
  record(changes, ['scope', 'accounts'], ['accounts']); if (own(changes, 'scope')) need(typeof changes.scope === 'string', 'Invalid scope');
  list(changes.accounts, 0, 256); const overlay = new Map(); let slots = 0;
  for (const row of changes.accounts) {
    record(row, ['address', 'nonce', 'balance', 'storage'], ['address']);
    const a = account(facts, row.address); need(!overlay.has(row.address), 'Duplicate local account');
    const s = { nonce: a.nonce, balance: a.balance, storage: {} };
    for (const field of ['nonce', 'balance']) if (own(row, field)) {
      record(row[field], ['before', 'after'], ['before', 'after']); const max = field === 'nonce' ? NONCE : MAX;
      need(quantity(row[field].before, max) === a[field], 'Local before value differs from immutable initial facts');
      s[field] = quantity(row[field].after, max);
    }
    if (own(row, 'storage')) for (const item of list(row.storage, 0, 2000)) {
      record(item, ['slot', 'before', 'after'], ['slot', 'before', 'after']); word(item.slot); word(item.before); word(item.after);
      need(++slots <= 2000 && !own(s.storage, item.slot), 'Duplicate or excessive local slot');
      need(item.before === initialSlot(a, item.slot), 'Local storage before differs from immutable initial facts'); s.storage[item.slot] = item.after;
    }
    overlay.set(row.address, s);
  }
  return overlay;
}
function providerOverlay(diff, facts, previous) {
  record(diff, ['pre', 'post'], ['pre', 'post']); record(diff.pre); record(diff.post);
  const keys = Object.keys(diff.pre).sort(); need(keys.length <= 100, 'Provider account bound');
  need(isDeepStrictEqual(keys, Object.keys(diff.post).sort()), 'Provider account lifecycle is outside this comparator');
  const overlay = cloneOverlay(previous); let slots = 0;
  for (const key of keys) {
    const a = account(facts, key), s = { ...current(facts, overlay, key), storage: { ...current(facts, overlay, key).storage } };
    const pre = record(diff.pre[key], ['nonce', 'balance', 'code', 'codeHash', 'storage']);
    const post = record(diff.post[key], ['nonce', 'balance', 'code', 'codeHash', 'storage']);
    for (const field of ['nonce', 'balance']) {
      const max = field === 'nonce' ? NONCE : MAX;
      if (own(pre, field)) need(quantity(pre[field], max) === s[field], 'Provider prevalue differs from its anchored prior overlay');
      if (own(post, field)) {
        need(own(pre, field) || s[field] === 0n, 'Provider omitted nonzero basic prevalue'); s[field] = quantity(post[field], max);
      }
      // An omitted post basic field is unchanged, unlike a pre-only slot.
    }
    for (const side of [pre, post]) {
      if (own(side, 'code')) need(code(side.code) === a.code, 'Runtime code transition is outside this comparator');
      if (own(side, 'codeHash')) need(word(side.codeHash) === a.codeHash, 'Provider codeHash differs from initial code');
      if (own(side, 'storage')) record(side.storage);
    }
    const ps = pre.storage ?? {}, ns = post.storage ?? {};
    for (const slot of [...new Set([...Object.keys(ps), ...Object.keys(ns)])]) {
      word(slot); need(++slots <= 2000, 'Provider storage bound'); const before = currentSlot(facts, s, key, slot);
      if (own(ps, slot)) need(word(ps[slot]) === before, 'Provider slot prevalue differs from its anchored prior overlay');
      else need(before === ZERO, 'Provider omitted nonzero slot prevalue');
      s.storage[slot] = own(ns, slot) ? word(ns[slot]) : ZERO;
    }
    overlay.set(key, s);
  }
  return overlay;
}

/** Canonical cumulative states on both sides stay relative to initialInputs.
 * The provider is advanced from only its own prior overlay, never local output.
 * A malformed/unavailable prefix blocks only that side's subsequent projection.
 * Unsupported lifecycle/reset/code transitions are unavailable, never dropped.
 * Header/proof verification and execution/status/log checks belong to the caller.
 */
export function normalizeStatePair({ localSteps, providerSteps, initialInputs }) {
  list(localSteps, 2, 4); list(providerSteps, localSteps.length, localSteps.length);
  const facts = initialFacts(initialInputs), steps = [];
  let localPrior = { accounts: [] }, providerPrior = new Map(), localFailure = null, providerFailure = null;
  for (let index = 0; index < localSteps.length; index++) {
    const l = record(localSteps[index]), p = record(providerSteps[index]);
    need(l.index === index && p.index === index, 'State step index/order differs');
    let localChanges = null, providerChanges = null;
    try {
      need(!localFailure, 'Local prior state unavailable: ' + localFailure);
      need(l.status === 'completed' && l.original, 'Local original is not completed'); record(l.original);
      const before = normalized(facts, localOverlay(l.original.startingChanges, facts));
      need(isDeepStrictEqual(before, localPrior), 'Local starting changes differ from preceding cumulative changes');
      localChanges = normalized(facts, localOverlay(l.original.changes, facts)); localPrior = localChanges;
    } catch (error) { localFailure ??= error.message; }
    try {
      need(!providerFailure, 'Provider prior state unavailable: ' + providerFailure);
      need(['completed', 'reverted_or_failed'].includes(p.status) && p.result, 'Provider original is not completed'); record(p.result);
      // The standard API retains the complete normalized raw diff here. Its
      // optional absent-account normalization is deliberately not admitted.
      if (own(p.result, 'nativeEffects')) {
        const native = record(p.result.nativeEffects);
        if (own(native, 'stateNormalization')) need(list(native.stateNormalization, 0, 100).length === 0, 'Provider account materialization normalization is unsupported');
      }
      const next = providerOverlay(p.result.stateDiff, facts, providerPrior);
      providerChanges = normalized(facts, next); providerPrior = next;
    } catch (error) { providerFailure ??= error.message; }
    const comparable = localChanges !== null && providerChanges !== null;
    steps.push({ index, status: comparable ? 'comparable' : 'unavailable', localChanges, providerChanges,
      matches: comparable ? isDeepStrictEqual(localChanges, providerChanges) : null,
      reason: comparable ? null : { local: localChanges === null ? localFailure : null, provider: providerChanges === null ? providerFailure : null } });
  }
  return { scope: STATE_COMPARISON_SCOPE, proofVerification: 'required_externally_not_performed_here', steps };
}
