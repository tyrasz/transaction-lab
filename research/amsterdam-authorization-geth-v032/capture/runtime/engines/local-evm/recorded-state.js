import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bytesToHex, createAccountFromRLP, createAddressFromString, hexToBytes } from '@ethereumjs/util';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const LIMITS = Object.freeze({ accounts: 128, slots: 8192, codeBytes: 262144, totalBytes: 8 * 1024 * 1024, reads: 200000, checkpoints: 128 });
const MAX_UINT = (1n << 256n) - 1n, MAX_NONCE = (1n << 64n) - 1n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => '0x' + value.toString(16);
const word = bytes => bytesToHex(bytes).slice(2).padStart(64, '0');
const cloneAccount = account => account === undefined ? undefined : createAccountFromRLP(account.serialize());

export class LocalStateError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'LocalStateError'; this.code = code; this.detail = detail; }
}
function invalid(message) { throw new LocalStateError('LOCAL_STATE_INVALID', message); }
function boundedUint(value, max) {
  if (typeof value !== 'string' || value.length > 80 || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) invalid('State quantities must be unsigned integer strings.');
  const parsed = BigInt(value); if (parsed > max) invalid('State quantity exceeds its supported width.'); return parsed;
}

function normalizeAccounts(accounts) {
  if (!object(accounts) || Object.keys(accounts).length > LIMITS.accounts) invalid('A bounded explicit account inventory is required.');
  const result = new Map(); let slotCount = 0, byteCount = 0;
  for (const [rawAddress, value] of Object.entries(accounts)) {
    if (!ADDRESS.test(rawAddress) || result.has(rawAddress.toLowerCase()) || !object(value)) invalid('Malformed or duplicate state account.');
    const address = rawAddress.toLowerCase();
    if (value.exists === false) {
      if (Object.keys(value).length !== 1) invalid('Absent accounts cannot contain invented state values.');
      result.set(address, { exists: false }); continue;
    }
    if (value.exists !== true || Object.keys(value).sort().join() !== 'balance,code,exists,nonce,storage') invalid('Existing accounts require explicit nonce, balance, code and sparse storage.');
    const nonce = boundedUint(value.nonce, MAX_NONCE), balance = boundedUint(value.balance, MAX_UINT);
    if (typeof value.code !== 'string' || !BYTES.test(value.code) || value.code.length > LIMITS.codeBytes * 2 + 2 || !object(value.storage)) invalid('Malformed or excessive account code/storage.');
    const storage = new Map(); byteCount += (value.code.length - 2) / 2;
    for (const [rawKey, rawValue] of Object.entries(value.storage)) {
      if (!WORD.test(rawKey) || typeof rawValue !== 'string' || !WORD.test(rawValue) || storage.has(rawKey.toLowerCase())) invalid('Storage requires distinct full-word keys and values.');
      if (++slotCount > LIMITS.slots) invalid('State slot inventory exceeds its bound.');
      byteCount += 64; storage.set(rawKey.toLowerCase(), rawValue.toLowerCase());
    }
    if (byteCount > LIMITS.totalBytes) invalid('State input exceeds its byte bound.');
    result.set(address, { exists: true, nonce, balance, code: value.code.toLowerCase(), storage });
  }
  return result;
}

/** Sparse recorded inputs, never a zero-filled fork. The caller must establish
 * the source and block binding of these facts; this module supplies no proof. */
class RecordedStateManager extends SimpleStateManager {
  constructor(base) { super(); this.base = base; this.reads = new Map(); this.readCount = 0; this.seeding = true; }
  addressKey(address) {
    const key = address?.toString();
    if (typeof key !== 'string' || !ADDRESS.test(key)) invalid('Invalid state address.');
    return key.toLowerCase();
  }
  known(address, kind = 'account') {
    const key = this.addressKey(address), entry = this.base.get(key);
    if (!entry) throw new LocalStateError('LOCAL_STATE_MISSING', 'The recorded state does not include this account.', { kind, address: key });
    return [key, entry];
  }
  read(kind, address, slot) {
    if (this.seeding) return;
    if (++this.readCount > LIMITS.reads) throw new LocalStateError('LOCAL_STATE_LIMIT', 'State read limit exceeded.');
    const key = [kind, address, slot ?? ''].join(':');
    if (!this.reads.has(key)) this.reads.set(key, { kind, address, ...(slot ? { slot } : {}) });
  }
  slotKey(key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) invalid('Storage keys must contain exactly 32 bytes.');
    return bytesToHex(key);
  }
  async getAccount(address) {
    const [key] = this.known(address); this.read('account', key);
    return cloneAccount(await super.getAccount(address));
  }
  async putAccount(address, account) {
    const [key, base] = this.known(address);
    if (!base.exists || !(account instanceof Account)) throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Account creation/deletion is outside the recorded-state profile.');
    if (!this.seeding) {
      if (account.nonce < 0n || account.nonce > MAX_NONCE || account.balance < 0n || account.balance > MAX_UINT) invalid('Written account fields exceed supported widths.');
      const old = this.topAccountStack().get(key);
      if (bytesToHex(account.codeHash) !== bytesToHex(old.codeHash) || bytesToHex(account.storageRoot) !== bytesToHex(old.storageRoot)) throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Direct code/root replacement is outside the recorded-state profile.');
    }
    await super.putAccount(address, cloneAccount(account));
  }
  async getCode(address) {
    const [key] = this.known(address, 'code'); this.read('code', key);
    return new Uint8Array(await super.getCode(address));
  }
  async putCode(address, value) {
    if (!this.seeding) throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Runtime code changes are outside the recorded-state profile.');
    await super.putCode(address, new Uint8Array(value));
  }
  async getStorage(address, key) {
    const [addressKey, base] = this.known(address, 'storage'), slot = this.slotKey(key);
    this.read('storage', addressKey, slot);
    if (base.exists && !base.storage.has(slot)) throw new LocalStateError('LOCAL_STATE_MISSING', 'The recorded state does not include this storage slot.', { kind: 'storage', address: addressKey, slot });
    return new Uint8Array(await super.getStorage(address, key));
  }
  async putStorage(address, key, value) {
    const [addressKey, base] = this.known(address, 'storage'), slot = this.slotKey(key);
    if (!base.exists || !base.storage.has(slot)) throw new LocalStateError('LOCAL_STATE_MISSING', 'A storage write requires its recorded prior value.', { kind: 'storage', address: addressKey, slot });
    if (!(value instanceof Uint8Array) || value.length > 32) invalid('Storage values cannot exceed 32 bytes.');
    await super.putStorage(address, key, new Uint8Array(value));
  }
  async clearStorage() { throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Storage clearing is outside the recorded-state profile.'); }
  async deleteAccount() { throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Account deletion is outside the recorded-state profile.'); }
  async checkpoint() {
    if (this.accountStack.length >= LIMITS.checkpoints) throw new LocalStateError('LOCAL_STATE_LIMIT', 'State checkpoint limit exceeded.');
    await super.checkpoint();
  }
  async commit() { if (this.accountStack.length < 2) invalid('No state checkpoint exists to commit.'); await super.commit(); }
  async revert() { if (this.accountStack.length < 2) invalid('No state checkpoint exists to revert.'); await super.revert(); }
  shallowCopy() { throw new LocalStateError('LOCAL_STATE_UNSUPPORTED', 'Create a fresh state manager for each independent execution.'); }
  snapshotReads() { return { total: this.readCount, distinct: this.reads.size, reads: structuredClone([...this.reads.values()]) }; }
  snapshotChanges() {
    const accounts = [];
    for (const [address, base] of this.base) {
      if (!base.exists) continue;
      const current = this.topAccountStack().get(address), changes = {};
      for (const field of ['nonce', 'balance']) if (base[field] !== current[field]) changes[field] = { before: hex(base[field]), after: hex(current[field]) };
      const storage = [];
      for (const [slot, before] of base.storage) {
        const after = '0x' + word(this.topStorageStack().get(address + '_' + slot) ?? new Uint8Array());
        if (before !== after) storage.push({ slot, before, after });
      }
      if (storage.length) changes.storage = storage;
      if (Object.keys(changes).length) accounts.push({ address, ...changes });
    }
    return { scope: 'Recorded accounts and slots only; no state-root or complete-effect proof.', accounts };
  }
}

export async function createRecordedStateManager({ accounts }) {
  const base = normalizeAccounts(accounts), manager = new RecordedStateManager(base);
  for (const [key, entry] of base) {
    if (!entry.exists) continue;
    const address = createAddressFromString(key);
    await manager.putAccount(address, new Account(entry.nonce, entry.balance));
    await manager.putCode(address, hexToBytes(entry.code));
    for (const [slot, value] of entry.storage) await manager.putStorage(address, hexToBytes(slot), hexToBytes(value));
  }
  manager.seeding = false;
  return manager;
}
