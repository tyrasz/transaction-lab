// Independently queried state for a bounded set of observed token participants.
// Transfer logs select accounts; their amounts never substitute for balanceOf.
import { isDeepStrictEqual } from 'node:util';
import { formatUnits } from './analyze.js';
import { analyzePermissions } from './permissions.js';
import { CHAIN_ID, USDC, HUSDC, VUSDC, METADATA } from './config.js';
import { failState, stateErrorDescription, uint, UINT256_MAX } from './state.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x' + '0'.repeat(40);
const IMPLEMENTATIONS = {
  [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',
  [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3',
  [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed',
};
const LIMITS = Object.freeze({ maxCandidatePairs: 8, candidateLimitIncludesReusedPairs: true, maxFrames: 1000, maxDepth: 32, maxLogs: 2000, maxTransferEvents: 256, maxPermissionObservations: 256 });
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const bytes = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const word = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const wordAddress = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value) ? address('0x' + value.slice(-40)) : null;
const failed = frame => Boolean(frame?.error || frame?.revertReason);
const known = token => Object.hasOwn(IMPLEMENTATIONS, token ?? '');
const pairKey = (token, account) => `${token}:${account}`;
const rawUnsigned = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= UINT256_MAX ? BigInt(value) : null;
const rawSigned = value => typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;

function deriveCandidates(request, trace, block, metadata) {
  if (trace.type !== 'CALL' || address(trace.from) !== address(request.from) || address(trace.to) !== address(request.to) || !bytes(trace.input) || lower(trace.input) !== lower(request.data) || uint(trace.value === undefined ? '0x0' : trace.value) !== uint(request.value) || uint(trace.gasUsed) === null) failState('Affected-account trace identity does not match the unsigned request.');
  const pairs = new Map(), frames = [], seen = new WeakSet(), active = new WeakSet();
  let frameCount = 0, logCount = 0, unknownTransfers = 0, transferEvents = 0;
  function pair(token, account) {
    if (account === ZERO) return null;
    const key = pairKey(token, account);
    if (!pairs.has(key)) {
      if (pairs.size >= LIMITS.maxCandidatePairs) failState('Affected-account evidence exceeds the eight-pair limit, including already measured pairs.');
      pairs.set(key, { token, account, incoming: 0n, outgoing: 0n, transferEvents: [], transferCalls: [] });
    }
    return pairs.get(key);
  }
  // Scan even excluded branches: temporary lifecycle operations may disappear
  // from a final state diff and remain outside this reconstruction's scope.
  function scan(frame, path = '0', parent = null, executionAddress = null, excluded = false, depth = 0) {
    if (!object(frame) || depth > LIMITS.maxDepth) failState('Affected-account trace contains a malformed frame or exceeds the depth limit.');
    if (active.has(frame)) failState('Affected-account trace contains a cyclic call tree.');
    if (seen.has(frame)) return;
    seen.add(frame); active.add(frame);
    if (++frameCount > LIMITS.maxFrames) failState('Affected-account trace exceeds the 1000-frame limit.');
    if (['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type)) failState('Contract creation or destruction, including reverted subtrees, is outside affected-account measurement scope.');
    if (!['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(frame.type) || !address(frame.from) || !address(frame.to) || !bytes(frame.input === undefined ? '0x' : frame.input) || !bytes(frame.output === undefined ? '0x' : frame.output) || uint(frame.value === undefined ? '0x0' : frame.value) === null || uint(frame.value ?? '0x0') > UINT256_MAX || (frame.error !== undefined && typeof frame.error !== 'string') || (frame.revertReason !== undefined && typeof frame.revertReason !== 'string') || (frame.calls !== undefined && !Array.isArray(frame.calls)) || (frame.logs !== undefined && !Array.isArray(frame.logs))) failState('Affected-account trace contains malformed execution fields.');
    if (parent && address(frame.from) !== executionAddress) failState('Affected-account trace contains inconsistent immediate caller provenance.');
    const execution = ['DELEGATECALL', 'CALLCODE'].includes(frame.type) ? executionAddress : address(frame.to);
    const discarded = excluded || failed(frame) || frame.type === 'STATICCALL';
    logCount += frame.logs?.length ?? 0;
    if (logCount > LIMITS.maxLogs) failState('Affected-account trace exceeds the 2000-log limit.');
    frames.push({ frame, path, parent, execution, discarded });
    (frame.calls ?? []).forEach((child, index) => scan(child, `${path}.${index}`, frame, execution, discarded, depth + 1));
    active.delete(frame);
  }
  scan(trace);
  const indexedLogs = new Map(), seenLogs = new WeakSet();
  for (const { frame, path, parent, execution, discarded } of frames) {
    if (discarded) continue;
    for (const [logOffset, log] of (frame.logs ?? []).entries()) {
      if (!object(log)) failState('Affected-account trace contains a malformed log.');
      if (seenLogs.has(log) || log.removed === true) continue;
      seenLogs.add(log);
      const token = address(log.address);
      if (lower(log.topics?.[0]) !== TRANSFER) continue;
      if (!known(token)) { unknownTransfers++; continue; }
      // Only the observed, configured implementation executing in its proxy's
      // storage context can establish a configured-token Transfer candidate.
      if (execution !== token || frame.type !== 'DELEGATECALL' || address(frame.to) !== IMPLEMENTATIONS[token] || !parent || parent.type !== 'CALL' || address(parent.to) !== token || parent.calls.length !== 1 || parent.calls[0] !== frame || lower(parent.input) !== lower(frame.input) || uint(parent.value ?? '0x0') !== 0n || uint(frame.value ?? '0x0') !== 0n || lower(parent.output ?? '0x') !== lower(frame.output ?? '0x')) failState('Configured Transfer evidence lacks the verified token proxy implementation provenance.');
      const from = wordAddress(log.topics?.[1]), to = wordAddress(log.topics?.[2]);
      if (!Array.isArray(log.topics) || log.topics.length !== 3 || !from || !to || !word(log.data)) failState('Configured Transfer evidence contains noncanonical ABI fields.');
      if (log.logIndex !== undefined && uint(log.logIndex) === null || log.index !== undefined && uint(log.index) === null || log.logIndex !== undefined && log.index !== undefined && uint(log.logIndex) !== uint(log.index)) failState('Configured Transfer evidence contains malformed or conflicting log indexes.');
      const index = uint(log.logIndex ?? log.index), fingerprint = JSON.stringify([token, from, to, lower(log.data)]);
      if (index !== null) {
        const prior = indexedLogs.get(index.toString());
        if (prior !== undefined && prior !== fingerprint) failState('Configured Transfer evidence contains conflicting global log indexes.');
        if (prior === fingerprint) continue;
        indexedLogs.set(index.toString(), fingerprint);
      }
      if (++transferEvents > LIMITS.maxTransferEvents) failState('Affected-account evidence exceeds the 256-Transfer-event limit.');
      const amount = BigInt(log.data), reference = { framePath: path, logOffset, logIndex: index?.toString() ?? null, from, to, amountRaw: amount.toString(), implementation: IMPLEMENTATIONS[token] };
      for (const [account, direction] of [[from, 'outgoing'], [to, 'incoming']]) {
        const candidate = pair(token, account);
        if (candidate) {
          candidate[direction] += amount;
          if (!candidate.transferEvents.includes(reference)) candidate.transferEvents.push(reference);
        }
      }
    }
  }
  // Supplied analysis/permissions are intentionally not inputs to derivation.
  // This rechecks successful branches, ABI, proxy identity and immediate caller.
  const permissions = analyzePermissions({ request, trace, block, metadata });
  if (permissions.observations.length > LIMITS.maxPermissionObservations) failState('Affected-account evidence exceeds the 256-permission-observation limit.');
  for (const observation of permissions.observations) {
    if (observation.kind !== 'transfer_from_call' || observation.tokenVerified !== true || ![USDC, HUSDC].includes(observation.asset?.address)) continue;
    const reference = { observationId: observation.id, framePath: observation.framePath, owner: observation.owner, spender: observation.spender, recipient: observation.recipient, submitter: observation.submitter, amountRaw: observation.amountRaw, amountMeaning: 'requested_transfer_amount', returnStatus: observation.returnStatus, implementation: observation.implementation };
    for (const account of new Set([observation.owner, observation.recipient])) {
      const candidate = pair(observation.asset.address, account);
      if (candidate) candidate.transferCalls.push(reference);
    }
  }
  return { pairs, unknownTransfers };
}

function existingPairs(result, basis, identity) {
  const pairs = new Map();
  if (result?.status !== 'measured') return pairs;
  if (result.basis !== basis || !isDeepStrictEqual(result.executionIdentity, identity) || !Array.isArray(result.assets) || result.assets.length > 12) failState('Existing balance measurements do not match the shared execution identity and basis.');
  for (const [index, entry] of result.assets.entries()) {
    const token = address(entry?.asset?.address), account = address(entry?.account);
    const before = rawUnsigned(entry?.beforeRaw), after = rawUnsigned(entry?.afterRaw), delta = rawSigned(entry?.deltaRaw);
    if (!known(token) || !account || account === ZERO || before === null || after === null || delta !== after - before) failState('Existing balance measurements contain malformed amounts or unsupported pairs.');
    const key = pairKey(token, account);
    if (pairs.has(key)) failState('Existing balance measurements contain duplicate token/account pairs.');
    pairs.set(key, { index, before, after, delta });
  }
  return pairs;
}

/** All candidate pairs count toward the cap, including independently proven reuse. */
export async function measureAffectedBalances({ request, trace, block, rpc, metadata = {}, existingBalanceChanges, stateContext }) {
  const historical = stateContext?.measurementBasis === 'historical_transaction_position_balanceOf';
  const verifiedCurrent = stateContext?.measurementBasis === 'current_pinned_state_validated_query';
  const basis = historical ? 'historical_transaction_position_balanceOf' : verifiedCurrent ? 'current_pinned_state_validated_query' : 'prestate_diff_balanceOf';
  const base = { status: 'not_applicable', basis, assets: [], reusedPairs: [], candidatePairCount: 0, limits: LIMITS, warnings: [], evidence: { request: [], response: [] } };
  const nativeValue = uint(request?.value);
  if (uint(request?.chainId) !== BigInt(CHAIN_ID) || !address(request?.from) || !address(request?.to) || !bytes(request?.data) || nativeValue === null || nativeValue > UINT256_MAX || (!verifiedCurrent && nativeValue !== 0n) || !object(trace) || failed(trace)) return { ...base, warnings: [nativeValue === 0n
    ? 'Affected-account measurements require a successful zero-value HyperEVM contract call.'
    : 'Affected-account measurements require a successful HyperEVM contract call. Native value is supported only by the validated current-state context; historical and legacy contexts require zero value.'] };
  let context;
  const warnings = [
    historical ? 'Configured-token balances are queried independently immediately before and after the original transaction at its exact position in the original block.' : verifiedCurrent
      ? 'Configured-token balances are queried independently before and after the whole unsigned call, with validated query paths and nonce-only query effects. BASEFEE is synthetic zero; other execution header fields are checked against the pinned block.'
      : 'Configured-token balances are queried before and after the whole simulated transaction at one pinned block hash and timestamp.',
    'Only observed Transfer participants and verified transferFrom owners/recipients are candidates. Silent changes, unknown tokens and native assets are outside this view.',
    'Event net amounts and requested transfers are evidence, not state measurements, intent verification or a security verdict. Receipt-token and debt events may differ from measured changes because of interest or rounding.',
  ];
  try {
    const { pairs, unknownTransfers } = deriveCandidates(request, trace, block, metadata);
    base.candidatePairCount = pairs.size;
    if (unknownTransfers) warnings.push(`${unknownTransfers} Transfer-signature log(s) at unconfigured token addresses were excluded from balance candidates.`);
    if (!pairs.size) return { ...base, warnings: [...warnings, 'No eligible configured-token balance candidates were observed.'] };
    // An original trace can prove an event's implementation without proving a
    // later balanceOf implementation. A generic call may upgrade a proxy via
    // storage alone; a final code diff or slot denylist is insufficient. Accept
    // only contexts which validate both isolated query paths and their effects.
    if (!historical && !verifiedCurrent) return { ...base, status: 'unavailable', warnings: [...warnings, 'Current affected-account balance query implementation provenance is not validated before and after the simulated call. Additional current-state measurements are withheld; no balance queries were performed.'] };
    for (const { token } of pairs.values()) if (metadata[token]?.decimals !== 6 || metadata[token].address !== undefined && address(metadata[token].address) !== token) failState('Configured six-decimal token metadata is required for affected-account measurements.');
    const candidateContext = stateContext;
    if (!candidateContext.matches({ request, block, rpc })) failState('Shared state context does not match this request, block, and provider.');
    context = candidateContext;
    await context.prepare();
    if (context.canonicalFailure) failState('The shared block verification has failed; affected-account measurements were withheld.');
    const identity = context.executionIdentity;
    if (!object(identity) || lower(identity.stateBlockHash) !== lower(block?.hash) || uint(identity.blockNumber) !== uint(block?.number) || uint(identity.timestamp) !== uint(block?.timestamp)) failState('Affected-account measurement has no matching pinned execution identity.');
    if (verifiedCurrent && (identity.stateBinding !== 'block_hash' || identity.headerContext !== 'synthetic_unpriced_basefee_zero' || identity.method !== 'debug_traceCall' || identity.feePolicy !== 'gas_price_omitted_no_query_native_debit' || identity.validation?.queryImplementation !== 'configured_address_paths_before_and_after_no_runtime_code_attestation' || identity.validation?.queryMutation !== 'sender_nonce_increment_only_with_unchanged_native_balance')) failState('Affected-account measurements require the validated current query and environment profile.');
    const existing = existingPairs(existingBalanceChanges, basis, identity), assets = [], reusedPairs = [];
    for (const candidate of pairs.values()) {
      const { token, account } = candidate;
      const measured = await context.readPair({ to: token, data: `0x70a08231${account.slice(2).padStart(64, '0')}` });
      const { before, after, delta } = measured;
      if (typeof before !== 'bigint' || typeof after !== 'bigint' || before < 0n || before > UINT256_MAX || after < 0n || after > UINT256_MAX || delta !== after - before) failState('Affected-account query returned malformed uint256 balance measurements.');
      const eventNet = candidate.incoming - candidate.outgoing;
      const proof = {
        candidateEvidence: { transferEvents: candidate.transferEvents, transferCalls: candidate.transferCalls },
        consistency: { eventComparison: candidate.transferEvents.length ? delta === eventNet ? 'matches_event_net' : 'differs_from_event_net' : 'no_event', eventIncomingRaw: candidate.transferEvents.length ? candidate.incoming.toString() : null, eventOutgoingRaw: candidate.transferEvents.length ? candidate.outgoing.toString() : null, eventNetRaw: candidate.transferEvents.length ? eventNet.toString() : null, explanation: 'Event totals are compared with independently queried state. A difference is preserved without assigning its cause or inferring maliciousness; transferFrom requested amounts are not substituted for balance changes.' },
      };
      const prior = existing.get(pairKey(token, account));
      if (prior) {
        if (prior.before !== before || prior.after !== after || prior.delta !== delta) failState('An existing balance measurement disagrees with the shared context query result.');
        reusedPairs.push({ token, account, balanceChangeIndex: prior.index, basis, ...proof });
      } else assets.push({
        asset: { ...METADATA[token], type: 'ERC20', role: token === USDC ? 'underlying_asset' : token === HUSDC ? 'receipt_token' : 'liability', ...(token === VUSDC ? { transferable: false } : {}) }, account,
        beforeRaw: before.toString(), afterRaw: after.toString(), deltaRaw: delta.toString(), before: formatUnits(before, 6), after: formatUnits(after, 6), delta: formatUnits(delta, 6), ...proof,
      });
    }
    await context.verifyCanonical();
    if (context.canonicalFailure) failState('The shared block verification has failed; affected-account measurements were withheld.');
    return { ...base, status: 'measured', assets, reusedPairs, executionIdentity: identity, warnings, evidence: context.snapshotEvidence() };
  } catch (error) {
    return { ...base, status: 'unavailable', warnings: [...warnings, `Affected-account measurement unavailable: ${stateErrorDescription(error)}`], evidence: context?.snapshotEvidence?.() ?? base.evidence };
  }
}
