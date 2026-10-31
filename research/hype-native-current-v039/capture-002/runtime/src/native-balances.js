// HYPE measurements from the shared validated current-state context. Observed
// CALL flow selects accounts; only context-validated reads supply amounts.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { formatUnits } from './analyze.js';
import { uint, UINT256_MAX } from './state.js';
import { NATIVE_EFFECT_LIMITS } from './native-effects.js';

const BASIS = 'current_pinned_state_validated_native_balance';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const SIGNED = /^(?:0|-?[1-9][0-9]*)$/;
const LIMITS = Object.freeze({ maxAccounts: 8 });
const ASSET = Object.freeze({ type: 'native', symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 });
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const need = (condition, message) => { if (!condition) throw new Error(message); };
const emptyEvidence = () => ({ request: [], response: [] });
const unsigned = value => typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX;
const quantity = value => { const n = uint(value); return n !== null && n <= UINT256_MAX ? n : null; };
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function plain(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const allowed = new Set([...required, ...optional]), keys = Reflect.ownKeys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && allowed.has(key) && d.enumerable && Object.hasOwn(d, 'value');
  });
}
function dense(value, max) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).every(d => d?.enumerable && Object.hasOwn(d, 'value'));
}
function assertIdentity(identity, request, block) {
  need(identity && typeof identity === 'object' && !Array.isArray(identity), 'Missing native execution identity.');
  need(WORD.test(lower(block?.hash)) && lower(identity.stateBlockHash) === lower(block.hash) && quantity(identity.blockNumber) === quantity(block.number) && quantity(block.number) !== null &&
    quantity(identity.timestamp) === quantity(block.timestamp) && quantity(block.timestamp) !== null, 'Native execution identity differs from the pinned block.');
  need(identity.stateBinding === 'block_hash' && identity.headerContext === 'synthetic_unpriced_basefee_zero' && identity.method === 'debug_traceCall' &&
    identity.feePolicy === 'gas_price_omitted_no_query_native_debit' && identity.validation?.queryMutation === 'sender_nonce_increment_only_with_unchanged_native_balance', 'Native measurement lacks the validated unpriced query profile.');
  const envelope = { from: lower(request.from), to: lower(request.to), data: lower(request.data), value: '0x' + quantity(request.value).toString(16), gas: '0x4c4b40' };
  need(identity.originalEnvelopeSha256 === sha(envelope) && typeof identity.stateOverridesSha256 === 'string' && /^[0-9a-f]{64}$/.test(identity.stateOverridesSha256), 'Native execution identity does not bind the original envelope and state overlay.');
}
function validatedMeasurements(result) {
  need(plain(result, ['feeScope', 'maxAccounts', 'candidates', 'counts', 'measurements'], ['stateNormalization']) && result.feeScope === 'excluded' && result.maxAccounts === LIMITS.maxAccounts, 'Malformed native measurement result.');
  need(dense(result.candidates, NATIVE_EFFECT_LIMITS.maxCandidates) && dense(result.measurements, LIMITS.maxAccounts) && plain(result.counts, ['candidates', 'selected', 'omitted']), 'Malformed native candidate counts.');
  const selected = [], omitted = [], seen = new Set();
  for (const candidate of result.candidates) {
    need(plain(candidate, ['account', 'netValueRaw', 'selected', 'reason']) && ADDRESS.test(candidate.account) && !seen.has(candidate.account), 'Malformed or duplicate native candidate.');
    seen.add(candidate.account);
    need(typeof candidate.netValueRaw === 'string' && candidate.netValueRaw.length <= 79 && SIGNED.test(candidate.netValueRaw) && BigInt(candidate.netValueRaw) >= -UINT256_MAX && BigInt(candidate.netValueRaw) <= UINT256_MAX, 'Malformed native flow quantity.');
    need(typeof candidate.selected === 'boolean' && (candidate.selected ? candidate.reason === 'selected' : ['account-limit', 'rpc-budget'].includes(candidate.reason)), 'Native candidate selection is inconsistent.');
    (candidate.selected ? selected : omitted).push(candidate);
  }
  need(selected.length <= LIMITS.maxAccounts && result.counts.candidates === seen.size && result.counts.selected === selected.length && result.counts.omitted === omitted.length && result.measurements.length === selected.length, 'Native selected, omitted and measured counts disagree.');
  const assets = result.measurements.map((measurement, index) => {
    need(plain(measurement, ['account', 'before', 'after', 'delta', 'anchorEvidenceId', 'queryEvidence']) && measurement.account === selected[index].account, 'Native measurement does not match its selected account.');
    need(unsigned(measurement.before) && unsigned(measurement.after) && typeof measurement.delta === 'bigint' && measurement.delta === measurement.after - measurement.before, 'Malformed native balance arithmetic.');
    need(Number.isSafeInteger(measurement.anchorEvidenceId) && measurement.anchorEvidenceId > 0 && dense(measurement.queryEvidence, 2) && measurement.queryEvidence.length === 2, 'Native measurement lacks bounded read evidence.');
    const evidenceIds = new Set();
    for (const [side, query] of measurement.queryEvidence.entries()) {
      need(plain(query, ['state', 'traceEvidenceId', 'mutationEvidenceId', 'wordIndex']) && query.state === (side ? 'after' : 'before') && query.wordIndex === 8 + index, 'Native query evidence does not bind its before/after witness word.');
      for (const field of ['traceEvidenceId', 'mutationEvidenceId']) {
        need(Number.isSafeInteger(query[field]) && query[field] > 0 && !evidenceIds.has(query[field]), 'Malformed or duplicate native query evidence identifier.');
        evidenceIds.add(query[field]);
      }
    }
    return { account: measurement.account, asset: { ...ASSET }, beforeRaw: measurement.before.toString(), afterRaw: measurement.after.toString(), deltaRaw: measurement.delta.toString(),
      before: formatUnits(measurement.before, 18), after: formatUnits(measurement.after, 18), delta: formatUnits(measurement.delta, 18),
      anchorEvidenceId: measurement.anchorEvidenceId, queryEvidence: structuredClone(measurement.queryEvidence) };
  });
  if (Object.hasOwn(result, 'stateNormalization')) need(dense(result.stateNormalization, NATIVE_EFFECT_LIMITS.maxCandidates), 'Malformed native state normalization evidence.');
  return { assets, candidateAccountCount: seen.size, omittedAccounts: omitted.map(({ account, reason }) => ({ account, reason })) };
}

export async function measureNativeBalances({ request, trace, block, rpc, stateContext }) {
  const base = { status: 'not_applicable', basis: BASIS, assets: [], candidateAccountCount: 0, omittedAccounts: [], feeScope: 'excluded', limits: { ...LIMITS }, warnings: [], evidence: emptyEvidence() };
  if (uint(request?.chainId) !== 999n) return { ...base, warnings: ['Native HYPE measurement is limited to HyperEVM chain 999.'] };
  if (trace?.error || trace?.revertReason) return { ...base, warnings: ['The original call failed; no native balance reads were performed. Fees are excluded.'] };
  const warnings = ['Native HYPE balances are independently read around the unsigned call in the validated, pinned current state. Gas fees are excluded.',
    'Only observed native-flow and explicit balance-change candidates are measured, up to eight accounts. This is not a complete asset inventory or a transaction security assessment.'];
  try {
    need(stateContext?.measurementBasis === 'current_pinned_state_validated_query', 'Native measurements require a validated current context.');
    need(ADDRESS.test(lower(request.from)) && ADDRESS.test(lower(request.to)) && typeof request.data === 'string' && BYTES.test(request.data) && quantity(request.value) !== null, 'Malformed native request.');
    need(trace?.type === 'CALL' && lower(trace.from) === lower(request.from) && lower(trace.to) === lower(request.to) && lower(trace.input ?? '0x') === lower(request.data) && quantity(trace.value ?? '0x0') === quantity(request.value) && quantity(trace.gas) === 5000000n && quantity(trace.gasUsed) > 0n && quantity(trace.gasUsed) <= 5000000n, 'Native trace differs from the fixed original call.');
    need(stateContext.matches({ request, block, rpc }) && !stateContext.canonicalFailure, 'Shared native context is not valid.');
    const result = await stateContext.readNativeBalances();
    need(!stateContext.canonicalFailure, 'Shared native context failed.');
    const identity = structuredClone(stateContext.executionIdentity); assertIdentity(identity, request, block);
    const measured = validatedMeasurements(result);
    if (!measured.candidateAccountCount) return { ...base, warnings: [...warnings, 'No native balance candidates were observed.'], evidence: structuredClone(stateContext.snapshotEvidence()) };
    await stateContext.verifyCanonical();
    need(!stateContext.canonicalFailure && isDeepStrictEqual(identity, stateContext.executionIdentity), 'Shared native context changed during verification.');
    return { ...base, ...measured, status: measured.omittedAccounts.length ? 'partial' : 'measured', warnings,
      evidence: structuredClone(stateContext.snapshotEvidence()), executionIdentity: identity };
  } catch {
    // The shared context owns diagnostic evidence. Withhold all provisional
    // amounts and its execution identity if any part of measurement fails.
    return { ...base, status: 'unavailable', warnings: [...warnings, 'Native balance measurement is unavailable because its current-state validation did not complete.'] };
  }
}
