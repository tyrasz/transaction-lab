import { isDeepStrictEqual, types } from 'node:util';

const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const UINT256 = (1n << 256n) - 1n, UINT64 = (1n << 64n) - 1n;
const MAX_ACCOUNTS = 128, MAX_SLOTS = 1024, MAX_CODE_BYTES = 24576;
const CREATION_BASES = ['internal_contract_creation', 'top_level_contract_creation'];
const DELETION_BASIS = 'same_invocation_created_contract_deletion';
const SHANGHAI_DELETION_BASIS = 'shanghai_selfdestruct_deletion';
const EMPTY_CLEANUP_BASIS = 'eip161_empty_account_cleanup';
const AUTHORIZATION_BASIS = 'eip7702_authorization_materialization';
const EXISTENCE_BASES = ['unsigned_sender_nonce_materialization', 'positive_native_funding_of_proof_absent_account', AUTHORIZATION_BASIS, ...CREATION_BASES];
const ZERO_WORD = '0x' + '00'.repeat(32);

export class QueryMutationError extends Error {
  constructor() {
    super('Query net changes do not match the isolated nonce-only profile.');
    this.name = 'QueryMutationError'; this.code = 'LOCAL_QUERY_MUTATION_INVALID';
  }
}
const need = value => { if (!value) throw new QueryMutationError(); };
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
function fields(value, required, optional = []) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(required.every(key => keys.includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(typeof key === 'string' && [...required, ...optional].includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function array(value, maximum) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function quantity(value, maximum) {
  need(typeof value === 'string' && value.length <= 66 && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value));
  need(BigInt(value) <= maximum); return value;
}
function delta(value, maximum) {
  fields(value, ['before', 'after']);
  const before = quantity(value.before, maximum), after = quantity(value.after, maximum);
  need(before !== after); return { before, after };
}
function canonical(snapshot) {
  fields(snapshot, ['scope', 'accounts']); need(snapshot.scope === SCOPE); array(snapshot.accounts, MAX_ACCOUNTS);
  const accounts = [], addresses = new Set(); let slots = 0;
  for (const account of snapshot.accounts) {
    fields(account, ['address'], ['existence', 'nonce', 'balance', 'storage', 'code']);
    need(matches(account.address, ADDRESS) && !addresses.has(account.address)); addresses.add(account.address);
    const row = { address: account.address };
    if (Object.hasOwn(account, 'existence')) {
      const value = account.existence; fields(value, ['before', 'after', 'basis']);
      const deletion = value.before === true && value.after === false && [DELETION_BASIS, SHANGHAI_DELETION_BASIS, EMPTY_CLEANUP_BASIS].includes(value.basis);
      need(deletion || (value.before === false && value.after === true && EXISTENCE_BASES.includes(value.basis)));
      row.existence = { before: value.before, after: value.after, basis: value.basis };
    }
    for (const field of ['nonce', 'balance']) if (Object.hasOwn(account, field)) row[field] = delta(account[field], field === 'nonce' ? UINT64 : UINT256);
    if (Object.hasOwn(account, 'code')) {
      const value = account.code; fields(value, ['before', 'after']);
      const designation = code => code === '0x' || (typeof code === 'string' && /^0xef0100[0-9a-f]{40}$/.test(code));
      const delegationChange = value.before !== value.after && designation(value.before) && designation(value.after);
      need(delegationChange || (value.before === '0x' && typeof value.after === 'string' && value.after.length > 2 && value.after.length <= 2 + MAX_CODE_BYTES * 2 && DATA.test(value.after)));
      row.code = { before: value.before, after: value.after };
    }
    if (Object.hasOwn(account, 'storage')) {
      array(account.storage, MAX_SLOTS); need(account.storage.length > 0); const seen = new Set();
      row.storage = account.storage.map(value => {
        fields(value, ['slot', 'before', 'after']);
        need(++slots <= MAX_SLOTS && matches(value.slot, WORD) && matches(value.before, WORD) && matches(value.after, WORD) && value.before !== value.after && !seen.has(value.slot));
        seen.add(value.slot); return { slot: value.slot, before: value.before, after: value.after };
      }).sort((a, b) => a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);
    }
    const creation = CREATION_BASES.includes(row.existence?.basis);
    const authorization = row.existence?.basis === AUTHORIZATION_BASIS;
    const delegationCode = row.code && [row.code.before, row.code.after].every(code => code === '0x' || /^0xef0100[0-9a-f]{40}$/.test(code));
    if (creation || (row.code && !delegationCode)) {
      // Deployment starts from nonce0 and a proven empty code/storage state.
      // A prefunded deployable target already existed, so has no existence row.
      need(row.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
      need(!row.existence || creation);
      need(!row.storage || row.storage.every(value => value.before === ZERO_WORD));
    }
    if (delegationCode || authorization) {
      // Shape only. The parent must independently recover signatures and bind
      // this delta to the ordered prepared state; a designation is not proof.
      need(row.nonce && BigInt(row.nonce.after) > BigInt(row.nonce.before));
      need(!row.existence || authorization);
    }
    if (row.existence?.basis === EMPTY_CLEANUP_BASIS) {
      // The whole initial empty account, including unrequested storage, was
      // removed. Its authenticated prior root is bound by lifecycle evidence.
      // Individual slot deltas would misleadingly imply exhaustive coverage.
      need(!row.nonce && !row.balance && !row.code && !row.storage);
    } else if ([DELETION_BASIS, SHANGHAI_DELETION_BASIS].includes(row.existence?.basis)) {
      // Whole-account finalization subsumes nonce, code and every slot. The
      // fork-specific lifecycle validator binds its authenticated initial root;
      // only Cancun-created deletion requires an initially deployable account.
      need(!row.nonce && !row.code && !row.storage);
      need(!row.balance || (BigInt(row.balance.before) > 0n && row.balance.after === '0x0'));
    } else if (row.existence) {
      need(!row.balance || row.balance.before === '0x0');
      if (authorization) {
        need(row.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
        need(!row.storage || row.storage.every(value => value.before === ZERO_WORD));
      } else if (!creation) {
        need(!row.storage && !row.code);
        if (row.existence.basis === 'unsigned_sender_nonce_materialization') need(row.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
        else need(!row.nonce && row.balance?.before === '0x0' && BigInt(row.balance.after) > 0n);
      }
    }
    need(Object.keys(row).length > 1); accounts.push(row);
  }
  accounts.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return { scope: SCOPE, accounts };
}

/** Validate and detach the bounded local overlay schema. This validates shape,
 * not proof provenance or execution: callers must bind the initial account
 * facts separately. Empty-runtime prefunded creation has no code/existence
 * delta and is intentionally not inferred from a generic nonce delta. */
export function canonicalStateChanges(snapshot) {
  try { return canonical(snapshot); }
  catch { throw new QueryMutationError(); }
}

/** Compare two overlay snapshots from one disposable query fork. These are
 * changes relative to the same immutable proven base, not per-query diffs.
 * The caller independently reads the fork's actual sender nonce/presence before
 * execution. Original overlay changes are retained; only the query's expected
 * nonce increment is normalized. This proves no absence of transient writes,
 * validates no logs/return data and attests no token identity or economics. */
export function validateQueryMutation(options) {
  try {
    fields(options, ['before', 'after', 'sender', 'nonceBefore', 'senderExistedBefore']);
    const { sender, nonceBefore, senderExistedBefore } = options;
    need(matches(sender, ADDRESS) && typeof senderExistedBefore === 'boolean');
    need(typeof nonceBefore === 'string' && nonceBefore.length <= 20 && /^(?:0|[1-9][0-9]*)$/.test(nonceBefore));
    const nonce = BigInt(nonceBefore); need(nonce < UINT64);
    const before = canonicalStateChanges(options.before), after = canonicalStateChanges(options.after);
    const prior = before.accounts.find(row => row.address === sender), next = after.accounts.find(row => row.address === sender);
    const hex = value => '0x' + value.toString(16);
    if (prior?.nonce) need(prior.nonce.after === hex(nonce));
    need(next?.nonce && next.nonce.before === (prior?.nonce?.before ?? hex(nonce)) && next.nonce.after === hex(nonce + 1n));
    if (prior?.nonce) next.nonce = { ...prior.nonce }; else delete next.nonce;
    if (!senderExistedBefore) {
      // No prior overlay row can describe a currently absent account. A proven
      // absent sender can materialize only through this nonce0 -> nonce1.
      need(nonce === 0n && prior === undefined && isDeepStrictEqual(next.existence, { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' }));
      delete next.existence;
    }
    if (Object.keys(next).length === 1) after.accounts = after.accounts.filter(row => row !== next);
    need(isDeepStrictEqual(before, after));
    return { status: 'verified', scope: 'net_changes_except_expected_query_sender_nonce' };
  } catch {
    // Never echo arbitrary getters, proxies or host exception contents.
    throw new QueryMutationError();
  }
}
