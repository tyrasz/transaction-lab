// Read-only, same-state measurements for reconciled Hyperlend USDC lending calls.
import { formatUnits } from './analyze.js';
import { decodeLendingCall, supportsLending } from './lending.js';
import { CHAIN_ID, POOL, USDC, HUSDC, VUSDC } from './config.js';
import { createStateContext, failState, stateErrorDescription, uint, UINT256_MAX } from './state.js';

const TOKENS = [USDC, HUSDC, VUSDC];
const ROLES = { [USDC]: 'underlying_asset', [HUSDC]: 'receipt_token', [VUSDC]: 'liability' };
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const signed = value => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
const key = (account, token) => `${account}:${token}`;

function decodeScope(request, analysis) {
  if (uint(request?.chainId) !== BigInt(CHAIN_ID) || lower(request?.to) !== POOL || uint(request?.value) !== 0n || !ADDRESS.test(request?.from ?? '')) return null;
  if (analysis?.execution?.status !== 'success' || analysis?.coverage?.status !== 'supported' || analysis?.protocol?.reconciliation?.status !== 'reconciled') return null;
  const decoded = decodeLendingCall(request);
  if (!decoded || !supportsLending(decoded)) return null;
  const protocol = analysis.protocol;
  for (const field of ['name', 'operation', 'asset', 'account', 'recipient', 'onBehalfOf', 'amountRaw', 'amountMode', 'positionToken', 'positionAccount', 'interestRateMode', 'referralCode']) {
    if (decoded[field] !== protocol[field]) return null;
  }
  const actual = uint(protocol.actualAmountRaw);
  const positionDelta = signed(protocol.positionDeltaRaw);
  const requested = uint(decoded.amountRaw);
  if (actual === null || actual <= 0n || actual > UINT256_MAX || positionDelta === null || positionDelta < -UINT256_MAX || positionDelta > UINT256_MAX) return null;
  if (decoded.operation === 'borrow' ? positionDelta <= 0n : positionDelta >= 0n) return null;
  if (decoded.operation === 'repay' ? actual > requested : decoded.amountMode !== 'all' && actual !== requested) return null;
  return { ...decoded, actual, positionDelta };
}

/** Measure involved user positions and reserve custody using one shared state diff. */
export async function measureLendingBalances({ request, block, rpc, metadata = {}, analysis, stateContext }) {
  const historical = stateContext?.measurementBasis === 'historical_transaction_position_balanceOf';
  const warnings = [
    historical
      ? 'Balances are queried independently immediately before and after the original transaction, at its exact position in the original block. The original call is validated separately; no balance probes are inserted into that replay.'
      : 'Balances are measured before and after an ephemeral state diff at one pinned block. The provider simulation omits gas-price fields; its execution header is not verified to match the original block.',
    'USDC cash, hUSDC supplied positions and non-transferable USDC debt are reported separately. Reserve custody balances are not user wealth.',
    'This measurement covers only the involved accounts and these three configured tokens; it does not assess transaction security or predict future blocks.',
  ];
  const base = { status: 'not_applicable', basis: historical ? 'historical_transaction_position_balanceOf' : 'prestate_diff_balanceOf', assets: [], warnings, evidence: { request: [], response: [] } };
  const scope = decodeScope(request, analysis);
  if (!scope) return { ...base, warnings: ['Balance measurement requires a successful, reconciled Hyperlend USDC withdrawal, variable-rate borrow or repayment with matching request arguments.'] };
  let context;
  try {
    const candidateContext = stateContext ?? createStateContext({ request, block, rpc });
    if (!candidateContext.matches({ request, block, rpc })) failState('Shared state context does not match this request, block, and provider.');
    context = candidateContext;
    for (const token of TOKENS) if (metadata[token]?.decimals !== 6) failState('Verified six-decimal metadata is required for USDC, hUSDC and variable USDC debt.');

    const accounts = new Set([scope.account, scope.recipient, scope.onBehalfOf, HUSDC]);
    const expected = new Map();
    const addExpected = (account, token, delta) => expected.set(key(account, token), (expected.get(key(account, token)) ?? 0n) + delta);
    const payer = scope.operation === 'repay' ? scope.account : HUSDC;
    const receiver = scope.operation === 'repay' ? HUSDC : scope.recipient;
    addExpected(payer, USDC, -scope.actual);
    addExpected(receiver, USDC, scope.actual);
    addExpected(scope.positionAccount, scope.positionToken, scope.positionDelta);

    const assets = [];
    for (const account of accounts) for (const token of TOKENS) {
      const { before, after, delta } = await context.readPair({ to: token, data: `0x70a08231${account.slice(2).padStart(64, '0')}` });
      const accountRoles = [];
      if (account === scope.account) accountRoles.push('caller');
      if (account === scope.recipient) accountRoles.push('recipient');
      if (account === scope.positionAccount) accountRoles.push('position_owner');
      if (account === HUSDC) accountRoles.push('reserve_custody');
      assets.push({
        asset: { ...metadata[token], address: token, type: 'ERC20', role: ROLES[token], ...(token === VUSDC ? { transferable: false } : {}) },
        account, accountRoles,
        beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString(),
        before: formatUnits(before, 6), after: formatUnits(after, 6), delta: formatUnits(delta, 6),
      });
      const expectedDelta = expected.get(key(account, token)) ?? 0n;
      if (delta !== expectedDelta) {
        if (token === USDC) failState('Measured USDC cash change disagrees with the actual executed amount and its payer/recipient.');
        if (account === scope.positionAccount && token === scope.positionToken) failState('Measured position change disagrees with the trace-reconciled position delta at the pinned context.');
        failState('An unrelated supplied-position or debt balance changed outside the reconciled operation.');
      }
    }
    if (scope.operation === 'repay' && scope.actual < uint(scope.amountRaw)) warnings.push('The measured repayment uses the actual executed payment, which is lower than the requested amount because the protocol caps repayment at outstanding debt.');
    if (scope.positionDelta !== (scope.operation === 'borrow' ? scope.actual : -scope.actual)) warnings.push('The measured position delta differs from the cash amount and exactly matches the trace-reconciled scaled-token rounding and interest accounting.');
    await context.verifyCanonical();
    return { ...base, status: 'measured', assets, executionIdentity: context.executionIdentity, evidence: context.snapshotEvidence() };
  } catch (error) {
    return { ...base, status: 'unavailable', warnings: [...warnings, `Balance measurement unavailable: ${stateErrorDescription(error)}`], evidence: context?.snapshotEvidence?.() ?? base.evidence };
  }
}
