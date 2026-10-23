import { formatUnits } from './analyze.js';
import { createStateContext, failState, stateErrorDescription, uint } from './state.js';

const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';

function decodeScope(request, analysis) {
  if (uint(request?.chainId) !== 999n || lower(request?.to) !== POOL || uint(request?.value) !== 0n || !ADDRESS.test(request?.from ?? '')) return null;
  if (analysis?.protocol?.name !== 'Hyperlend' || analysis.protocol.operation !== 'supply' || analysis.protocol.asset !== USDC || analysis.coverage?.status !== 'supported' || analysis.execution?.status !== 'success') return null;
  if (!/^0x617ba037[0-9a-f]{256}$/i.test(request.data ?? '')) return null;
  const args = request.data.slice(10);
  if (args.slice(0, 64).toLowerCase() !== USDC.slice(2).padStart(64, '0')) return null;
  const amount = BigInt(`0x${args.slice(64, 128)}`);
  if (!/^0{24}/i.test(args.slice(128, 192))) return null;
  const beneficiary = `0x${args.slice(152, 192)}`.toLowerCase();
  if (beneficiary !== analysis.protocol.onBehalfOf || amount.toString() !== analysis.protocol.amountRaw || BigInt(`0x${args.slice(192)}`) > 65535n) return null;
  return { sender: request.from.toLowerCase(), beneficiary, amount };
}

/** Read token balances on the same pinned state, then its traced ephemeral post-state. */
export async function measureBalances({ request, block, rpc, metadata = {}, analysis, stateContext }) {
  const warnings = [
    'Balances are measured by calling the configured USDC and hUSDC contracts before and after an ephemeral state diff at the same block hash and timestamp.',
    'This measurement covers the submitting account and deposit beneficiary for these two tokens. It does not assess transaction security or predict future blocks.',
  ];
  const base = { status: 'not_applicable', basis: 'prestate_diff_balanceOf', assets: [], warnings, evidence: { request: [], response: [] } };
  const scope = decodeScope(request, analysis);
  if (!scope) return { ...base, warnings: ['Balance measurement is limited to successful, reconciled Hyperlend USDC supply simulations.'] };
  let context;
  try {
    const candidateContext = stateContext ?? createStateContext({ request, block, rpc });
    if (!candidateContext.matches({ request, block, rpc })) failState('Shared state context does not match this request, block, and provider.');
    context = candidateContext;
    for (const token of [USDC, HUSDC]) if (metadata[token]?.decimals !== 6) failState('Verified six-decimal metadata is required for USDC and hUSDC.');
    const assets = [];
    for (const account of new Set([scope.sender, scope.beneficiary])) for (const token of [USDC, HUSDC]) {
      const { before, after, delta } = await context.readPair({ to: token, data: `0x70a08231${account.slice(2).padStart(64, '0')}` });
      assets.push({
        asset: { ...metadata[token], address: token, type: 'ERC20' }, account,
        beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString(),
        before: formatUnits(before, 6), after: formatUnits(after, 6), delta: formatUnits(delta, 6),
      });
    }
    const senderUSDC = assets.find(item => item.account === scope.sender && item.asset.address === USDC);
    const beneficiaryHUSDC = assets.find(item => item.account === scope.beneficiary && item.asset.address === HUSDC);
    if (BigInt(senderUSDC.deltaRaw) !== -scope.amount) failState('Measured USDC balance change disagrees with the successful supply principal.');
    const impliedPrincipal = uint(analysis.protocol.mintEventImpliedPrincipalRaw);
    if (impliedPrincipal === null || BigInt(beneficiaryHUSDC.deltaRaw) !== impliedPrincipal) failState('Measured hUSDC change disagrees with the traced Mint value minus accrued interest at the pinned context.');
    if (impliedPrincipal !== scope.amount) warnings.push('The measured hUSDC change differs from the requested USDC deposit and exactly matches the trace-reconciled Mint value minus accrued interest. The measured delta is preserved.');
    await context.verifyCanonical();
    return { ...base, status: 'measured', assets, executionIdentity: context.executionIdentity, evidence: context.snapshotEvidence() };
  } catch (error) {
    return { ...base, status: 'unavailable', warnings: [...warnings, `Balance measurement unavailable: ${stateErrorDescription(error)}`], evidence: context?.snapshotEvidence?.() ?? base.evidence };
  }
}
