import { formatUnits } from './analyze.js';
import { analyzePermissions } from './permissions.js';
import { createStateContext, failState, stateErrorDescription, uint, UINT256_MAX } from './state.js';
import { CHAIN_ID, USDC, HUSDC } from './config.js';

const VERIFIED_TOKENS = new Set([USDC, HUSDC]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_PAIRS = 8;
const MAX_OBSERVATIONS = 256;
const allowanceKind = amount => amount === 0n ? 'zero' : amount === UINT256_MAX ? 'uint256_max' : 'bounded';
const observationKey = observation => JSON.stringify([observation.id, observation.kind, observation.asset?.address, observation.owner, observation.spender, observation.amountRaw, observation.framePath, observation.logIndex ?? null, observation.returnStatus ?? null, observation.deadlineRaw ?? null, observation.submitter ?? null, observation.permitCaller ?? null]);

function compareEvidence(observations, finalValue) {
  const events = observations.filter(o => o.kind === 'approval_event');
  const requests = observations.filter(o => ['approval_request', 'permit_request'].includes(o.kind));
  let lastEvent;
  let eventComparison = 'no_event';
  if (events.length === 1) lastEvent = events[0];
  else if (events.length > 1) {
    const indexes = events.map(event => uint(event.logIndex));
    if (indexes.every(index => index !== null) && new Set(indexes.map(String)).size === indexes.length) {
      lastEvent = events.reduce((last, event) => BigInt(event.logIndex) > BigInt(last.logIndex) ? event : last);
    } else eventComparison = 'ambiguous_event_order';
  }
  if (lastEvent) eventComparison = BigInt(lastEvent.amountRaw) === finalValue ? 'matches_last_observed_event' : 'differs_from_last_observed_event';
  const requestComparison = requests.length === 0 ? 'no_request' : requests.length > 1 ? 'multiple_requests_not_individually_compared' : BigInt(requests[0].amountRaw) === finalValue ? 'matches_requested_amount' : 'differs_from_requested_amount';
  return {
    eventComparison,
    lastEventObservationId: lastEvent?.id ?? null,
    lastEventAmountRaw: lastEvent?.amountRaw ?? null,
    requestComparison,
    falseReturnObservationIds: requests.filter(request => request.returnStatus === 'returned_false').map(request => request.id),
    explanation: 'The measured value is the final allowance after the whole transaction. Earlier approvals may be superseded or consumed later; an evidence difference is not a maliciousness verdict.',
  };
}

/** Measure final allowance state for verified permission pairs in one successful EVM call. */
export async function measureAllowances({ request, trace, block, rpc, metadata = {}, analysis, permissions, stateContext }) {
  const historical = stateContext?.allowanceMeasurementBasis === 'historical_transaction_position_allowance';
  const base = {
    status: 'not_applicable', basis: historical ? 'historical_transaction_position_allowance' : 'prestate_diff_allowance', allowances: [],
    warnings: [], evidence: { request: [], response: [] },
    limits: { maxPairs: MAX_PAIRS, maxPermissionObservations: MAX_OBSERVATIONS },
  };
  if (uint(request?.chainId) !== BigInt(CHAIN_ID) || analysis?.execution?.status !== 'success' || !trace || typeof trace !== 'object' || Array.isArray(trace) || typeof trace.type !== 'string' || trace.error || trace.revertReason) {
    return { ...base, warnings: ['Final allowance measurement requires a successful HyperEVM execution and verified token permission observations.'] };
  }
  let context;
  const warnings = [
    historical
      ? 'Allowances are queried independently immediately before and after the original transaction at its exact position in the original block. They are not inferred from individual Approval events or permit requests.'
      : 'Allowances are queried before and after the entire simulated transaction at one pinned block hash. They are not inferred from individual Approval events.',
    'Maximum allowance describes spending permission, not spender trustworthiness. No transaction security verdict is provided.',
  ];
  try {
    if (trace.value !== undefined && uint(trace.value) !== uint(request.value)) failState('Trace value differs from the unsigned call; allowance candidates were withheld.');
    // Re-derive candidates from the trace so stale or forged observations cannot
    // reintroduce failed subtrees, selector collisions, or unknown token contracts.
    const checked = analyzePermissions({ request, trace, block, metadata });
    if (checked.observations.length > MAX_OBSERVATIONS) failState('Permission evidence exceeds the configured 256-observation measurement limit.');
    const observations = checked.observations.filter(o => o.tokenVerified === true && VERIFIED_TOKENS.has(o.asset?.address) && ['approval_request', 'permit_request', 'approval_event'].includes(o.kind));
    if (!observations.length) return { ...base, warnings: ['No successful, verified USDC or hUSDC permission pairs were observed in this trace.'] };
    if (permissions !== undefined) {
      if (!Array.isArray(permissions?.observations)) failState('Supplied permission observations are malformed.');
      const supplied = new Set(permissions.observations.map(observationKey));
      if (observations.some(observation => !supplied.has(observationKey(observation)))) failState('Supplied permission observations do not match the successful trace.');
    }
    const pairs = new Map();
    for (const observation of observations) {
      const amount = uint(observation.amountRaw);
      if (!ADDRESS.test(observation.owner) || !ADDRESS.test(observation.spender) || amount === null || amount > UINT256_MAX) failState('Verified permission evidence contains malformed allowance arguments.');
      const token = observation.asset.address;
      if (metadata[token]?.decimals !== 6) failState('Verified six-decimal token metadata is required for allowance measurement.');
      const key = `${token}:${observation.owner}:${observation.spender}`;
      if (!pairs.has(key)) pairs.set(key, { token, owner: observation.owner, spender: observation.spender, observations: [] });
      pairs.get(key).observations.push(observation);
    }
    if (pairs.size > MAX_PAIRS) failState('Permission evidence exceeds the configured eight-pair measurement limit.');
    const candidateContext = stateContext ?? createStateContext({ request, block, rpc });
    if (!candidateContext.matches({ request, block, rpc })) failState('Shared state context does not match this request, block, and provider.');
    context = candidateContext;
    const allowances = [];
    for (const pair of pairs.values()) {
      const data = `0xdd62ed3e${pair.owner.slice(2).padStart(64, '0')}${pair.spender.slice(2).padStart(64, '0')}`;
      const { before, after, delta } = await context.readPair({ to: pair.token, data });
      allowances.push({
        asset: { ...metadata[pair.token], address: pair.token, type: 'ERC20' }, owner: pair.owner, spender: pair.spender,
        beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString(),
        before: formatUnits(before, 6), after: formatUnits(after, 6), delta: formatUnits(delta, 6),
        beforeKind: allowanceKind(before), afterKind: allowanceKind(after), changed: before !== after,
        observationIds: pair.observations.map(o => o.id), consistency: compareEvidence(pair.observations, after),
      });
    }
    await context.verifyCanonical();
    return { ...base, status: 'measured', allowances, executionIdentity: context.executionIdentity, warnings, evidence: context.snapshotEvidence() };
  } catch (error) {
    return { ...base, status: 'unavailable', warnings: [...warnings, `Allowance measurement unavailable: ${stateErrorDescription(error)}`], evidence: context?.snapshotEvidence?.() ?? base.evidence };
  }
}
