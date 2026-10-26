// A bounded projection of this response's decoded observations and separately
// validated measurements. It performs no RPC and does not discover silent token
// changes, infer signing intent, or classify accounts as safe or malicious.
import { CHAIN_ID, USDC, HUSDC, VUSDC, METADATA } from './config.js';
import { formatUnits } from './analyze.js';
import { uint, UINT256_MAX } from './state.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO = '0x' + '0'.repeat(40);
const LIMITS = Object.freeze({ maxAccounts: 64, maxTokenAccountPairs: 128, maxMovements: 256, maxPermissionObservations: 256 });
const normalized = value => typeof value === 'string' ? value.toLowerCase() : '';
const accountAddress = value => ADDRESS.test(normalized(value)) && normalized(value) !== ZERO;
const signed = value => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
const amount = value => { const result = uint(value); return result !== null && result <= UINT256_MAX ? result : null; };
const known = token => [USDC, HUSDC, VUSDC].includes(token);
const role = token => token === USDC ? 'underlying_asset' : token === HUSDC ? 'receipt_token' : token === VUSDC ? 'liability' : 'unverified_token';

/** Inputs must be the analysis and state measurements for the same API response. */
export function projectAccountEffects({ request, analysis, permissions, balanceChanges, allowanceChanges, affectedBalanceChanges } = {}) {
  const base = {
    status: 'not_applicable', basis: 'observed_accounts_with_separate_state_measurements',
    coverage: { status: 'limited', reasons: ['Only accounts appearing in decoded transfer events, verified permission observations, or separately measured token balances are listed. Silent balance changes and native assets are outside this view.'] },
    summary: { accountCount: 0, nonSubmitterAccountCount: 0, tokenAccountPairs: 0, measuredBalancePairs: 0, unmeasuredBalancePairs: 0, measuredAllowancePairs: 0 },
    accounts: [], limits: LIMITS,
    warnings: ['Event net amounts are arithmetic over Transfer logs, not measured balance changes. No observed event does not mean no change.', 'An account other than the transaction submitter may be an owner, spender, recipient or contract. These roles do not establish consent, identity, trustworthiness or maliciousness.'],
  };
  if (uint(request?.chainId) !== BigInt(CHAIN_ID) || !accountAddress(request?.from) || analysis?.execution?.status !== 'success') return base;
  const submitter = normalized(request.from);
  const accounts = new Map();
  let pairCount = 0;
  try {
    const movements = analysis.movements;
    const observations = permissions?.observations ?? [];
    if (!Array.isArray(movements) || movements.length > LIMITS.maxMovements || !Array.isArray(observations) || observations.length > LIMITS.maxPermissionObservations) throw new Error('Observation limits were exceeded or observations were malformed.');
    function getToken(account, token) {
      account = normalized(account); token = normalized(token);
      if (!accountAddress(account) || !ADDRESS.test(token) || token === ZERO) throw new Error('An observation contains a malformed account or token address.');
      if (!accounts.has(account)) {
        if (accounts.size >= LIMITS.maxAccounts) throw new Error('Observed accounts exceed the configured limit.');
        accounts.set(account, { address: account, isSubmitter: account === submitter, roles: new Set(account === submitter ? ['transaction_submitter'] : []), tokens: new Map() });
      }
      const holder = accounts.get(account);
      if (!holder.tokens.has(token)) {
        if (++pairCount > LIMITS.maxTokenAccountPairs) throw new Error('Observed token/account pairs exceed the configured limit.');
        holder.tokens.set(token, {
          asset: { ...(known(token) ? METADATA[token] : { address: token, symbol: null, name: null, decimals: null }), type: 'ERC20' },
          tokenVerified: known(token), role: role(token),
          events: { status: 'not_observed', basis: 'transfer_event', incomingRaw: '0', outgoingRaw: '0', netRaw: '0', incoming: null, outgoing: null, net: null, movementIndexes: [] },
          balance: { status: 'not_measured' }, permissionReferences: [], allowanceIndexes: [],
        });
      }
      return { holder, effect: holder.tokens.get(token) };
    }
    for (const [index, movement] of movements.entries()) {
      if (!movement || movement.basis !== 'transfer_event' || !ADDRESS.test(normalized(movement.from)) || !ADDRESS.test(normalized(movement.to)) || amount(movement.amountRaw) === null) throw new Error('Transfer observations contain malformed arguments.');
      for (const [field, direction, accountRole] of [['from', 'outgoingRaw', 'transfer_sender'], ['to', 'incomingRaw', 'transfer_recipient']]) {
        if (normalized(movement[field]) === ZERO) continue;
        const { holder, effect } = getToken(movement[field], movement.address);
        holder.roles.add(accountRole);
        effect.events.status = 'observed';
        effect.events[direction] = (BigInt(effect.events[direction]) + BigInt(movement.amountRaw)).toString();
        if (!effect.events.movementIndexes.includes(index)) effect.events.movementIndexes.push(index);
      }
    }
    for (const observation of observations) {
      if (observation?.tokenVerified !== true || ![USDC, HUSDC].includes(observation.asset?.address) || !['approval_request', 'permit_request', 'approval_event', 'transfer_from_call'].includes(observation.kind)) continue;
      if (typeof observation.id !== 'string' || !accountAddress(observation.owner) || !ADDRESS.test(normalized(observation.spender))) throw new Error('Verified permission observations contain malformed references.');
      const fields = [['owner', 'permission_owner'], ['spender', 'spender']];
      if (observation.kind === 'permit_request') fields.push(['submitter', 'permit_submitter'], ['permitCaller', 'permit_caller']);
      if (observation.kind === 'transfer_from_call') fields.push(['recipient', 'requested_transfer_recipient'], ['submitter', 'transaction_submitter']);
      for (const [field, accountRole] of fields) {
        if (!accountAddress(observation[field])) continue;
        const { holder, effect } = getToken(observation[field], observation.asset.address);
        holder.roles.add(accountRole);
        effect.permissionReferences.push({ observationId: observation.id, role: field === 'permitCaller' ? 'permit_caller' : field });
      }
    }
    // Reuse only the separately verified state result, never an event-inferred
    // delta. The source/index identifies the corresponding state result and its
    // separately retained RPC evidence. Reused pairs are already in the base set.
    for (const [source, measurements] of [['balanceChanges', balanceChanges], ['affectedBalanceChanges', affectedBalanceChanges]]) if (measurements?.status === 'measured') {
      if (!['prestate_diff_balanceOf', 'historical_transaction_position_balanceOf'].includes(measurements.basis) || !Array.isArray(measurements.assets) || measurements.assets.length > LIMITS.maxTokenAccountPairs) throw new Error('Measured balance references are malformed.');
      for (const [index, entry] of measurements.assets.entries()) {
        const token = entry.asset?.address;
        if (!known(token)) throw new Error('Measured balance references contain an unsupported token.');
        const before = amount(entry.beforeRaw), after = amount(entry.afterRaw), delta = signed(entry.deltaRaw);
        if (before === null || after === null || delta !== after - before) throw new Error('Measured balance amounts are inconsistent.');
        const { holder, effect } = getToken(entry.account, token);
        if (effect.balance.status === 'measured') throw new Error('Duplicate measured balance references are ambiguous.');
        holder.roles.add('measured_balance_account');
        effect.balance = { status: 'measured', basis: measurements.basis, beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString(), before: formatUnits(before, 6), after: formatUnits(after, 6), delta: formatUnits(delta, 6), ...(source === 'balanceChanges' ? { balanceChangeIndex: index } : { affectedBalanceChangeIndex: index }) };
      }
    }
    let measuredAllowancePairs = 0;
    if (allowanceChanges?.status === 'measured') {
      if (!Array.isArray(allowanceChanges.allowances) || allowanceChanges.allowances.length > 8) throw new Error('Measured allowance references are malformed.');
      for (const [index, entry] of allowanceChanges.allowances.entries()) {
        if (![USDC, HUSDC].includes(entry.asset?.address) || !accountAddress(entry.owner) || !ADDRESS.test(normalized(entry.spender)) || amount(entry.beforeRaw) === null || amount(entry.afterRaw) === null || signed(entry.deltaRaw) !== BigInt(entry.afterRaw) - BigInt(entry.beforeRaw)) throw new Error('Measured allowance references contain malformed arguments.');
        for (const [field, accountRole] of [['owner', 'permission_owner'], ['spender', 'spender']]) {
          if (!accountAddress(entry[field])) continue;
          const { holder, effect } = getToken(entry[field], entry.asset.address);
          holder.roles.add(accountRole);
          if (!effect.allowanceIndexes.includes(index)) effect.allowanceIndexes.push(index);
        }
        measuredAllowancePairs++;
      }
    }
    for (const holder of accounts.values()) for (const effect of holder.tokens.values()) {
      const events = effect.events;
      events.netRaw = (BigInt(events.incomingRaw) - BigInt(events.outgoingRaw)).toString();
      // Absence stays explicit. A permission-only account has no event total,
      // while an observed zero-amount/self-transfer has an observed zero net.
      if (events.status === 'observed') for (const field of ['incoming', 'outgoing', 'net']) events[field] = formatUnits(events[field + 'Raw'], effect.asset.decimals);
    }
    const serialized = [...accounts.values()].map(holder => ({ ...holder, roles: [...holder.roles], tokens: [...holder.tokens.values()] }));
    const measuredBalancePairs = serialized.flatMap(holder => holder.tokens).filter(effect => effect.balance.status === 'measured').length;
    return { ...base, status: serialized.length ? 'observed' : 'not_applicable', accounts: serialized, summary: { accountCount: serialized.length, nonSubmitterAccountCount: serialized.filter(holder => !holder.isSubmitter).length, tokenAccountPairs: pairCount, measuredBalancePairs, unmeasuredBalancePairs: pairCount - measuredBalancePairs, measuredAllowancePairs } };
  } catch (error) {
    return { ...base, status: 'unavailable', warnings: [...base.warnings, error.message] };
  }
}
