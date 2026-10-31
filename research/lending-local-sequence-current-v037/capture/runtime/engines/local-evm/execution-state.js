// A transaction-start view over immutable verified facts and a preceding overlay
// already accepted by the enclosing parent. This is not a new proof snapshot:
// cumulative `before` values and reset roots always refer to inputs.
import { canonicalStateChanges } from './preview-mutations.js';
import { EMPTY_STORAGE_ROOT } from './verified-state-proof.js';

const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const ZERO = '0x' + '00'.repeat(32);
const need = value => { if (!value) throw new Error('Execution starting state does not match its immutable input facts.'); };
const hex = value => '0x' + BigInt(value).toString(16);
const creation = basis => ['internal_contract_creation', 'top_level_contract_creation'].includes(basis);

export function createExecutionState(inputs, startingChanges) {
  const changes = canonicalStateChanges(startingChanges ?? { scope: SCOPE, accounts: [] });
  const rows = new Map(changes.accounts.map(row => [row.address, row]));
  function initial(address) {
    const fact = inputs?.accounts?.[address]; need(fact && typeof fact.exists === 'boolean');
    return { exists: fact.exists, nonce: fact.exists ? fact.nonce : '0', balance: fact.exists ? fact.balance : '0', code: fact.exists ? fact.code : '0x' };
  }
  function account(address) {
    const base = initial(address), row = rows.get(address);
    if (row?.existence?.after === false) return { exists: false, nonce: '0', balance: '0', code: '0x' };
    return { exists: row?.existence?.after ?? base.exists,
      nonce: row?.nonce ? BigInt(row.nonce.after).toString() : base.nonce,
      balance: row?.balance ? BigInt(row.balance.after).toString() : base.balance,
      code: row?.code?.after ?? base.code };
  }
  function storage(address, slot) {
    const base = initial(address), row = rows.get(address);
    if (row?.existence?.after === false) return ZERO;
    const value = row?.storage?.find(item => item.slot === slot)?.after;
    if (value !== undefined) return value;
    if (row?.reset || !base.exists) return ZERO;
    const proven = inputs.accounts[address].storage?.[slot]; need(proven !== undefined); return proven;
  }
  for (const row of rows.values()) {
    const base = initial(row.address);
    for (const name of ['nonce', 'balance']) if (row[name]) need(row[name].before === hex(base[name]));
    if (row.code) need(row.code.before === base.code);
    if (row.existence) need(row.existence.before === base.exists);
    if (row.reset) need(row.reset.initialStorageRoot === inputs.provenance?.find(item => item.account === row.address)?.accountProof?.storageRoot);
    for (const slot of row.storage ?? []) need(slot.before === (row.reset || !base.exists ? ZERO : inputs.accounts[row.address].storage?.[slot.slot]));
  }
  return { changes, rows, initial, account, storage };
}

/** Compose parent-derived scalar preparation into the cumulative snapshot.
 * Updates use current values, while omitted fields preserve preceding writes.
 * Only callers which independently derive the transition may use this helper. */
export function updateExecutionAccounts(inputs, startingChanges, updates) {
  const state = createExecutionState(inputs, startingChanges);
  const rows = new Map(state.changes.accounts.map(row => [row.address, structuredClone(row)]));
  for (const [address, update] of updates) {
    const base = state.initial(address), prior = state.rows.get(address), row = rows.get(address) ?? { address };
    const current = state.account(address), exists = update.exists ?? current.exists;
    need(exists); // Deletion requires the separate lifecycle validator.
    if (prior?.existence?.after === false) {
      delete row.existence;
      const proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
      need(proof && proof.exists === base.exists);
      if (base.nonce !== '0' || base.code !== '0x' || proof.storageRoot !== EMPTY_STORAGE_ROOT) row.reset = { basis: prior.existence.basis, initialStorageRoot: proof.storageRoot };
    }
    for (const name of ['nonce', 'balance']) if (update[name] !== undefined) {
      const after = hex(update[name]);
      if (after === hex(base[name])) delete row[name];
      else row[name] = { before: hex(base[name]), after };
    }
    if (update.code !== undefined) {
      if (update.code === base.code) delete row.code;
      else row.code = { before: base.code, after: update.code };
    }
    if (!base.exists) {
      let basis = prior?.existence?.basis;
      const requested = update.existenceBasis;
      if (!creation(basis) && basis !== 'eip7702_authorization_materialization' && requested) basis = requested;
      if (!basis) basis = BigInt(update.nonce ?? current.nonce) > 0n ? 'unsigned_sender_nonce_materialization' : 'positive_native_funding_of_proof_absent_account';
      row.existence = { before: false, after: true, basis };
    }
    if (Object.keys(row).length === 1) rows.delete(address); else rows.set(address, row);
  }
  return canonicalStateChanges({ scope: SCOPE, accounts: [...rows.values()] });
}
