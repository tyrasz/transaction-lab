// Canonicalize the complete reported pre/post diff without discarding presence,
// initial values, native accounts, or cleared slots. This is not a state proof.
import { failState, uint, UINT256_MAX } from './state.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const MAX_NONCE = (1n << 64n) - 1n;
const MAX_ACCOUNTS = 100;
const MAX_SLOTS = 2000;
const MAX_CODE_TEXT_BYTES = 8 * 1024 * 1024;

function fields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) failState('State diff contains an invalid object record.');
  const names = Reflect.ownKeys(record);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (typeof name !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failState('State diff contains unsupported object fields.');
  }
  return names;
}

function quantity(value, maximum, name) {
  const parsed = uint(value);
  if (parsed === null || parsed > maximum) failState(`State diff contains malformed ${name}.`);
  return parsed.toString();
}

/** Representation-only normalization. Missing fields and explicit zero differ. */
export function canonicalStateDiff(diff) {
  const rootFields = fields(diff);
  if (rootFields.length !== 2 || !rootFields.includes('pre') || !rootFields.includes('post')) failState('State diff requires only complete pre and post maps.');
  const accounts = new Set(), slotsByAccount = new Map();
  let totalSlots = 0, codeTextBytes = 0;
  const result = {};
  for (const side of ['pre', 'post']) {
    const accountKeys = fields(diff[side]);
    if (accountKeys.length > MAX_ACCOUNTS) failState('State diff exceeds the configured 100-account measurement limit.');
    const normalizedAccounts = {};
    for (const accountKey of accountKeys) {
      if (!ADDRESS.test(accountKey)) failState('State diff contains an invalid account address.');
      const account = accountKey.toLowerCase();
      if (Object.hasOwn(normalizedAccounts, account)) failState('State diff contains colliding normalized account addresses.');
      accounts.add(account);
      if (accounts.size > MAX_ACCOUNTS) failState('State diff exceeds the configured 100-account measurement limit.');
      const record = diff[side][accountKey], recordFields = fields(record);
      if (recordFields.some(name => !['balance', 'nonce', 'code', 'storage'].includes(name))) failState('State diff contains unsupported account fields.');
      const normalized = {};
      for (const name of recordFields.sort()) {
        const value = record[name];
        if (name === 'balance' || name === 'nonce') normalized[name] = quantity(value, name === 'nonce' ? MAX_NONCE : UINT256_MAX, name);
        else if (name === 'code') {
          if (typeof value !== 'string') failState('State diff contains malformed contract code.');
          codeTextBytes += Buffer.byteLength(value, 'utf8');
          if (codeTextBytes > MAX_CODE_TEXT_BYTES) failState('State diff code evidence exceeds its configured size limit.');
          if (!BYTES.test(value)) failState('State diff contains malformed contract code.');
          normalized.code = value.toLowerCase();
        } else {
          const slotKeys = fields(value);
          if (slotKeys.length > MAX_SLOTS) failState('State diff exceeds the configured 2000-slot measurement limit.');
          const storage = {};
          if (!slotsByAccount.has(account)) slotsByAccount.set(account, new Set());
          const accountSlots = slotsByAccount.get(account);
          for (const slotKey of slotKeys) {
            if (!WORD.test(slotKey) || typeof value[slotKey] !== 'string' || !WORD.test(value[slotKey])) failState('State diff contains malformed storage slots.');
            const slot = slotKey.toLowerCase();
            if (Object.hasOwn(storage, slot)) failState('State diff contains colliding normalized storage slots.');
            if (!accountSlots.has(slot)) {
              accountSlots.add(slot);
              if (++totalSlots > MAX_SLOTS) failState('State diff exceeds the configured 2000-slot measurement limit.');
            }
            storage[slot] = value[slotKey].toLowerCase();
          }
          normalized.storage = Object.fromEntries(Object.keys(storage).sort().map(slot => [slot, storage[slot]]));
        }
      }
      normalizedAccounts[account] = normalized;
    }
    result[side] = Object.fromEntries(Object.keys(normalizedAccounts).sort().map(account => [account, normalizedAccounts[account]]));
  }
  return result;
}

/** Compare all reported values after strict validation; never compare deltas alone. */
export function assertStateDiffMatch(original, replay) {
  if (JSON.stringify(canonicalStateDiff(original)) !== JSON.stringify(canonicalStateDiff(replay))) failState('Original-position replay state diff does not match the historical transaction.');
}
