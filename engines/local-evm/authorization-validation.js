// Parent-side preparation over verified facts and a preceding overlay already
// accepted by the parent. Current child claims never supply the starting state.
import { normalizeAuthorizationList, recoverAuthorization, authorizationStateDecision } from './authorization-list.js';
import { existingDelegationTarget } from './sender-delegation.js';
import { deriveAmsterdamAuthorizationPreparation } from './amsterdam-authorization-validation.js';
import { createExecutionState, updateExecutionAccounts } from './execution-state.js';

const need = value => { if (!value) throw new Error('Authorization preparation does not match verified starting facts.'); };
export function deriveAuthorizationPreparation({ request, header, inputs, common, startingChanges }) {
  const list = normalizeAuthorizationList(request);
  if (list === undefined) return null;
  if (common?.isActivatedEIP(8037)) return deriveAmsterdamAuthorizationPreparation({ request, header, inputs, common, startingChanges });
  need([1n, 11155111n].includes(common?.chainId()) && common.isActivatedEIP(7702) && !common.isActivatedEIP(7928) && request.to !== null && request.blobVersionedHashes === undefined);
  const accounts = new Map(), applied = new Set(), entries = [];
  const state = createExecutionState(inputs, startingChanges);
  const sender = request.from.toLowerCase();
  const values = fact => ({ exists: fact.exists, nonce: BigInt(fact.nonce), code: fact.code });
  function account(address) {
    if (!accounts.has(address)) {
      const initial = values(state.initial(address)), starting = values(state.account(address));
      accounts.set(address, { initial, starting, current: { ...starting } });
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
  const updates = [...accounts].filter(([, row]) => row.current.exists).map(([address, { current }]) => [address, {
    exists: true, nonce: current.nonce, code: current.code,
    ...(applied.has(address) ? { existenceBasis: 'eip7702_authorization_materialization' }
      : address === sender ? { existenceBasis: 'unsigned_sender_nonce_materialization' } : {}),
  }]);
  return { accounts, applied, snapshot: updateExecutionAccounts(inputs, state.changes, updates),
    processing: { entries, gasRefundCounter: gasRefund.toString() } };
}
