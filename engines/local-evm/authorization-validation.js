// Parent-side preparation over independently verified starting facts. No child
// state overlay, claimed authority, after-code or refund supplies these inputs.
import { normalizeAuthorizationList, recoverAuthorization, authorizationStateDecision } from './authorization-list.js';
import { existingDelegationTarget } from './sender-delegation.js';

const need = value => { if (!value) throw new Error('Authorization preparation does not match verified starting facts.'); };
const hex = value => '0x' + value.toString(16);
const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';

export function deriveAuthorizationPreparation({ request, inputs, common }) {
  const list = normalizeAuthorizationList(request);
  if (list === undefined) return null;
  need(common?.chainId() === 1n && common.isActivatedEIP(7702) && !common.isActivatedEIP(7928) && request.to !== null && request.blobVersionedHashes === undefined);
  const accounts = new Map(), applied = new Set(), entries = [];
  const sender = request.from.toLowerCase();
  function account(address) {
    if (!accounts.has(address)) {
      const fact = inputs?.accounts?.[address]; need(fact && typeof fact.exists === 'boolean');
      const current = fact.exists ? { exists: true, nonce: BigInt(fact.nonce), code: fact.code } : { exists: false, nonce: 0n, code: '0x' };
      accounts.set(address, { initial: { ...current }, current });
    }
    return accounts.get(address).current;
  }
  const caller = account(sender);
  need(caller.code === '0x' || existingDelegationTarget(caller.code, common) !== null);
  need(caller.nonce < (1n << 64n) - 1n);
  caller.exists = true; caller.nonce++;
  let gasRefund = 0n;
  for (const [index, tuple] of list.entries()) {
    const recovered = recoverAuthorization(tuple, common.chainId());
    if (recovered.reason !== null) {
      entries.push({ index, authority: null, status: 'skipped', reason: recovered.reason }); continue;
    }
    const current = account(recovered.authority), decision = authorizationStateDecision(tuple, current);
    entries.push({ index, authority: recovered.authority, status: decision.reason === null ? 'applied' : 'skipped', reason: decision.reason });
    if (decision.reason !== null) continue;
    gasRefund += decision.gasRefund;
    current.exists = true; current.nonce = decision.nonceAfter; current.code = decision.codeAfter;
    applied.add(recovered.authority);
  }
  const rows = [];
  for (const [address, { initial, current }] of accounts) {
    const row = { address };
    if (!initial.exists && current.exists) row.existence = { before: false, after: true,
      basis: applied.has(address) ? 'eip7702_authorization_materialization' : 'unsigned_sender_nonce_materialization' };
    if (initial.nonce !== current.nonce) row.nonce = { before: hex(initial.nonce), after: hex(current.nonce) };
    if (initial.code !== current.code) row.code = { before: initial.code, after: current.code };
    if (Object.keys(row).length > 1) rows.push(row);
  }
  rows.sort((a, b) => a.address.localeCompare(b.address));
  return { accounts, applied, snapshot: { scope: SCOPE, accounts: rows },
    processing: { entries, gasRefundCounter: gasRefund.toString() } };
}
