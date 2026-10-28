import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bytesToHex, createAccountFromRLP, hexToBytes } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { isRpcStateInputs } from './rpc-state-inputs.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from './verified-state-proof.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_UINT = (1n << 256n) - 1n, MAX_NONCE = (1n << 64n) - 1n;
const LIMITS = Object.freeze({ reads: 200000, checkpoints: 128 });
const copyAccount = account => account === undefined ? undefined : createAccountFromRLP(account.serialize());
const quantity = value => '0x' + value.toString(16);
const padded = bytes => '0x' + bytesToHex(bytes).slice(2).padStart(64, '0');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** A mutable execution overlay over immutable proof-verified input facts.
 * Lazy facts are seeded into every existing checkpoint: discovering an input
 * inside a reverted child never turns that input into an invented zero. */
class ProofStateManager extends SimpleStateManager {
  constructor(inputs) { super(); this.inputs = inputs; this.base = new Map(); this.loading = new Map(); this.slotLoading = new Map(); this.reads = new Map(); this.readCount = 0; this.creationStack = [new Map()]; }
  created(key) { return this.creationStack.at(-1).has(key); }
  addressKey(address) {
    const value = address?.toString();
    if (typeof value !== 'string' || !ADDRESS.test(value)) fail('LOCAL_STATE_INVALID', 'A full state address is required.');
    return value.toLowerCase();
  }
  slotKey(key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) fail('LOCAL_STATE_INVALID', 'Storage keys must contain exactly 32 bytes.');
    return bytesToHex(key);
  }
  read(kind, address, slot) {
    if (++this.readCount > LIMITS.reads) fail('LOCAL_STATE_LIMIT', 'Proof-backed state read limit exceeded.');
    const id = `${kind}:${address}:${slot ?? ''}`;
    if (!this.reads.has(id)) this.reads.set(id, { kind, address, ...(slot ? { slot } : {}) });
  }
  async loadAccount(key) {
    if (this.inputs.snapshotUsage().status === 'unavailable') fail('LOCAL_STATE_MISSING', 'The input collector is unavailable; partial facts cannot continue execution.');
    if (this.base.has(key)) return this.base.get(key);
    if (!this.loading.has(key)) this.loading.set(key, (async () => {
      const proven = await this.inputs.getAccount(key), code = await this.inputs.getCode(key);
      if (proven.exists && proven.nonceRaw === '0' && proven.balanceRaw === '0' && code === '0x') fail('LOCAL_STATE_UNSUPPORTED', 'Proven existing empty-account cleanup is outside this unsigned-message profile.');
      const account = proven.exists ? new Account(BigInt(proven.nonceRaw), BigInt(proven.balanceRaw), hexToBytes(proven.storageRoot), hexToBytes(proven.codeHash)) : undefined;
      const entry = { ...proven, code, storage: new Map() };
      for (const frame of this.accountStack) if (!frame.has(key)) frame.set(key, copyAccount(account));
      for (const frame of this.codeStack) if (!frame.has(key)) frame.set(key, hexToBytes(code));
      this.base.set(key, entry); return entry;
    })());
    return this.loading.get(key);
  }
  async loadSlot(key, slot) {
    const account = await this.loadAccount(key);
    if (account.storage.has(slot)) return;
    const id = key + '_' + slot;
    if (!this.slotLoading.has(id)) this.slotLoading.set(id, (async () => {
      const value = await this.inputs.getStorage(key, slot);
      account.storage.set(slot, value);
      for (const frame of this.storageStack) if (!frame.has(id)) frame.set(id, hexToBytes(value));
    })());
    await this.slotLoading.get(id);
  }
  async getAccount(address) {
    const key = this.addressKey(address); this.read('account', key); await this.loadAccount(key);
    return copyAccount(this.topAccountStack().get(key));
  }
  async getCode(address) {
    const key = this.addressKey(address); this.read('code', key); await this.loadAccount(key);
    return new Uint8Array(this.topCodeStack().get(key));
  }
  async getStorage(address, key) {
    const account = this.addressKey(address), slot = this.slotKey(key); this.read('storage', account, slot); await this.loadSlot(account, slot);
    return new Uint8Array(this.topStorageStack().get(account + '_' + slot));
  }
  async putAccount(address, account) {
    const key = this.addressKey(address), base = await this.loadAccount(key);
    if (!(account instanceof Account) || account.nonce < 0n || account.nonce > MAX_NONCE || account.balance < 0n || account.balance > MAX_UINT) fail('LOCAL_STATE_INVALID', 'Written account quantities are invalid.');
    const current = this.topAccountStack().get(key);
    const emptyRoots = bytesToHex(account.codeHash) === EMPTY_CODE_HASH && bytesToHex(account.storageRoot) === EMPTY_STORAGE_ROOT;
    // Cancun EIP-161/EIP-1052 empty-account semantics: a zero-value CALL
    // touching a proven absent empty account cannot create persistent state.
    if (!base.exists && account.nonce === 0n && account.balance === 0n && emptyRoots) { this.topAccountStack().set(key, undefined); return; }
    if (current === undefined) {
      if (base.exists || account.nonce > 1n || !emptyRoots) {
        fail('LOCAL_STATE_UNSUPPORTED', 'Only native funding or the unsigned sender nonce may materialize a proof-absent account.');
      }
    } else if (bytesToHex(account.codeHash) !== bytesToHex(current.codeHash) || bytesToHex(account.storageRoot) !== bytesToHex(current.storageRoot)) {
      fail('LOCAL_STATE_UNSUPPORTED', 'Runtime code or storage-root replacement is unsupported.');
    }
    this.topAccountStack().set(key, copyAccount(account));
  }
  async putStorage(address, key, value) {
    const account = this.addressKey(address), slot = this.slotKey(key), base = await this.loadAccount(account);
    if (!base.exists && !this.created(account)) fail('LOCAL_STATE_UNSUPPORTED', 'Storage writes require an existing account or an authenticated creation target.');
    if (!(value instanceof Uint8Array) || value.length > 32) fail('LOCAL_STATE_INVALID', 'Storage values cannot exceed 32 bytes.');
    await this.loadSlot(account, slot);
    this.topStorageStack().set(account + '_' + slot, new Uint8Array(value));
  }
  async clearStorage(address) {
    const key = this.addressKey(address); await this.loadAccount(key); this.assertDeployable(key);
  }
  assertDeployable(key) {
    const base = this.base.get(key), current = this.topAccountStack().get(key);
    // CREATE first checks collisions, then clears storage before newContract.
    // A sparse manager cannot clear an unknown trie. A proven empty initial
    // root plus a still-deployable current account makes this an exact no-op.
    if (!base || base.storageRoot !== EMPTY_STORAGE_ROOT || base.code !== '0x' || base.nonceRaw !== '0' ||
        (current && (current.nonce !== 0n || bytesToHex(current.codeHash) !== EMPTY_CODE_HASH)) || this.created(key)) {
      fail('LOCAL_STATE_UNSUPPORTED', 'Storage clearing requires a proven empty deployable creation target.');
    }
    for (const [slot, value] of this.topStorageStack()) if (slot.startsWith(key + '_') && value.some(byte => byte !== 0)) {
      fail('LOCAL_STATE_UNSUPPORTED', 'Creation cannot clear an existing storage overlay.');
    }
  }
  beginContractCreation(address, basis = 'internal_contract_creation') {
    if (!['internal_contract_creation', 'top_level_contract_creation'].includes(basis)) fail('LOCAL_STATE_INVALID', 'Contract creation origin is invalid.');
    if (this.accountStack.length < 2) fail('LOCAL_STATE_INVALID', 'Contract creation requires an active rollback checkpoint.');
    const key = this.addressKey(address); this.assertDeployable(key);
    this.creationStack.at(-1).set(key, basis);
  }
  async putCode(address, value) {
    const key = this.addressKey(address), base = await this.loadAccount(key), current = this.topAccountStack().get(key);
    if (!this.created(key) || base.code !== '0x' || !current || current.nonce === 0n || bytesToHex(current.codeHash) !== EMPTY_CODE_HASH) {
      fail('LOCAL_STATE_UNSUPPORTED', 'Code installation requires a new authenticated contract creation.');
    }
    if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 24576) fail('LOCAL_STATE_INVALID', 'Created runtime code exceeds the supported contract-code bound.');
    const copy = copyAccount(current); copy.codeHash = keccak_256(value);
    this.topCodeStack().set(key, new Uint8Array(value)); this.topAccountStack().set(key, copy);
  }
  async deleteAccount() { fail('LOCAL_STATE_UNSUPPORTED', 'Account deletion is unsupported.'); }
  async consumeBAL() { fail('LOCAL_STATE_UNSUPPORTED', 'External state changes cannot be imported into the proof-backed overlay.'); }
  async checkpoint() {
    if (this.accountStack.length >= LIMITS.checkpoints) fail('LOCAL_STATE_LIMIT', 'State checkpoint limit exceeded.');
    await super.checkpoint();
    this.creationStack.push(new Map(this.creationStack.at(-1)));
  }
  async commit() { if (this.accountStack.length < 2) fail('LOCAL_STATE_INVALID', 'No state checkpoint exists to commit.'); await super.commit(); this.creationStack.splice(-2, 1); }
  async revert() { if (this.accountStack.length < 2) fail('LOCAL_STATE_INVALID', 'No state checkpoint exists to revert.'); await super.revert(); this.creationStack.pop(); }
  shallowCopy() {
    if (this.accountStack.length !== 1 || [...this.loading.keys()].some(key => !this.base.has(key)) || [...this.slotLoading.keys()].some(id => !this.topStorageStack().has(id))) fail('LOCAL_STATE_UNSUPPORTED', 'Copy only a settled state manager outside active checkpoints.');
    const copy = new ProofStateManager(this.inputs);
    copy.base = new Map([...this.base].map(([key, value]) => [key, { ...value, storage: new Map(value.storage) }]));
    copy.accountStack = this.accountStack.map(frame => new Map([...frame].map(([key, value]) => [key, copyAccount(value)])));
    copy.codeStack = this.codeStack.map(frame => new Map([...frame].map(([key, value]) => [key, new Uint8Array(value)])));
    copy.storageStack = this.storageStack.map(frame => new Map([...frame].map(([key, value]) => [key, new Uint8Array(value)])));
    copy.creationStack = this.creationStack.map(frame => new Map(frame));
    return copy;
  }
  snapshotReads() { return { total: this.readCount, distinct: this.reads.size, reads: structuredClone([...this.reads.values()]) }; }
  snapshotInputs() { return this.inputs.snapshotInputs(); }
  snapshotInputEvidence() { return this.inputs.snapshotEvidence(); }
  snapshotInputUsage() { return this.inputs.snapshotUsage(); }
  snapshotChanges() {
    const accounts = [];
    for (const [address, base] of this.base) {
      const current = this.topAccountStack().get(address), changes = {};
      if (!base.exists) {
        if (current !== undefined) changes.existence = { before: false, after: true, basis: this.creationStack.at(-1).get(address) ?? (current.nonce > 0n ? 'unsigned_sender_nonce_materialization' : 'positive_native_funding_of_proof_absent_account') };
      }
      if (current !== undefined) for (const field of ['nonce', 'balance']) {
        const before = BigInt(base[field + 'Raw']);
        if (before !== current[field]) changes[field] = { before: quantity(before), after: quantity(current[field]) };
      }
      const storage = [];
      for (const [slot, before] of base.storage) {
        const after = padded(this.topStorageStack().get(address + '_' + slot));
        if (before !== after) storage.push({ slot, before, after });
      }
      if (storage.length) changes.storage = storage;
      const code = bytesToHex(this.topCodeStack().get(address));
      if (code !== base.code) changes.code = { before: base.code, after: code };
      if (Object.keys(changes).length) accounts.push({ address, ...changes });
    }
    return { scope: 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.', accounts };
  }
}

export function createProofStateManager({ inputs }) {
  if (!isRpcStateInputs(inputs)) fail('LOCAL_STATE_INVALID', 'A verified RPC input collector is required.');
  return new ProofStateManager(inputs);
}
