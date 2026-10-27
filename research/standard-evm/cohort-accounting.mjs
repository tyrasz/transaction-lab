// Offline accounting only. The caller must separately authenticate and freeze the
// census, seed, implementation, comparator and outcome evidence before evaluation.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MAX_CENSUS = 100_000;
export class CohortAccountingError extends Error {
  constructor(message) { super(message); this.name = 'CohortAccountingError'; }
}
const need = (condition, message) => { if (!condition) throw new CohortAccountingError(message); };
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ROW_KEYS = ['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex'];
const EXECUTIONS = ['success', 'reverted', 'unsupported', 'provider_unavailable', 'budget_unattempted'];
const COMPARISONS = ['match', 'mismatch', 'oracle_unavailable', 'not_comparable', 'budget_unattempted'];
const UNKNOWN = ['oracle_unavailable', 'not_comparable', 'budget_unattempted'];
const ALGORITHM = 'SHA256(seed_32_bytes || transaction_hash_32_bytes); ascending digest, then transaction hash';
const LIMITS = {
  censusAuthenticationEstablished: false,
  finalityEstablished: false,
  censusCompletenessEstablished: false,
  envelopeCompletenessEstablished: false,
  predeclarationChronologyEstablished: false,
  outcomeEvidenceVerified: false,
  economicCompletenessEstablished: false,
  securityScoreEstablished: false,
};
function record(value, keys, label) {
  need(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain record.`);
  const own = Reflect.ownKeys(value);
  need(own.length === keys.length && own.every(key => keys.includes(key)), `${label} has missing or unsupported fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, `${label} must contain enumerable data fields.`);
  }
  return value;
}
function list(value, max, label) {
  need(Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1, `${label} must be a bounded dense array.`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, `${label} must contain data entries.`);
  }
  return value;
}
function hash(value, label) {
  need(typeof value === 'string' && HASH.test(value), `${label} must be a 32-byte hex value.`);
  return value.toLowerCase();
}
function integer(value, label) {
  need(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) < (1n << 64n), `${label} must be a canonical uint64 decimal string.`);
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const fraction = (numerator, denominator) => ({ numerator, denominator, fraction: denominator === 0 ? null : `${numerator}/${denominator}` });

/** No outcomes, exclusions or replacements are accepted by this selection API.
 * Hashes identify supplied records; their authenticity and chronology are not proven.
 * The full ledger is canonical block/index order; sampling uses raw-byte hash rank.
 */
export function createCohortSelection(input) {
  record(input, ['chainId', 'census', 'seed', 'sampleSize'], 'Selection input');
  need(input.chainId === 1, 'Only chainId 1 is supported.');
  const seed = hash(input.seed, 'Seed');
  need(Number.isSafeInteger(input.sampleSize) && input.sampleSize >= 0 && input.sampleSize <= MAX_CENSUS, 'sampleSize is outside the supported bound.');
  const hashes = new Set(), positions = new Set(), numbers = new Map(), blocks = new Map();
  const rows = list(input.census, MAX_CENSUS, 'Census').map(value => {
    record(value, ROW_KEYS, 'Census row');
    const row = { transactionHash: hash(value.transactionHash, 'Transaction hash'), blockHash: hash(value.blockHash, 'Block hash'), blockNumber: integer(value.blockNumber, 'Block number'), transactionIndex: integer(value.transactionIndex, 'Transaction index') };
    need(!hashes.has(row.transactionHash), 'Duplicate transaction hash.'); hashes.add(row.transactionHash);
    const position = `${row.blockHash}:${row.transactionIndex}`;
    need(!positions.has(position), 'Duplicate block transaction position.'); positions.add(position);
    need(!numbers.has(row.blockNumber) || numbers.get(row.blockNumber) === row.blockHash, 'Conflicting block identity for a block number.'); numbers.set(row.blockNumber, row.blockHash);
    need(!blocks.has(row.blockHash) || blocks.get(row.blockHash) === row.blockNumber, 'Conflicting block number for a block hash.'); blocks.set(row.blockHash, row.blockNumber);
    return { ...row, rank: digest(Buffer.concat([Buffer.from(seed.slice(2), 'hex'), Buffer.from(row.transactionHash.slice(2), 'hex')])) };
  });
  const sampleSize = Math.min(input.sampleSize, rows.length);
  const selected = new Set([...rows].sort((a, b) => lexical(a.rank, b.rank) || lexical(a.transactionHash, b.transactionHash)).slice(0, sampleSize).map(row => row.transactionHash));
  rows.sort((a, b) => numeric(a.blockNumber, b.blockNumber) || numeric(a.transactionIndex, b.transactionIndex) || lexical(a.transactionHash, b.transactionHash));
  const selection = {
    schemaVersion: '1.0', chainId: 1, seed, requestedSampleSize: input.sampleSize,
    censusSize: rows.length, sampleSize, algorithm: ALGORITHM,
    rows: rows.map(row => ({ ...row, selected: selected.has(row.transactionHash) })),
    limitations: { ...LIMITS },
  };
  return freeze({ ...selection, selectionId: digest(JSON.stringify(selection)) });
}

function validateSelection(selection) {
  record(selection, ['schemaVersion', 'chainId', 'seed', 'requestedSampleSize', 'censusSize', 'sampleSize', 'algorithm', 'rows', 'limitations', 'selectionId'], 'Selection');
  record(selection.limitations, Object.keys(LIMITS), 'Selection limitations');
  const census = list(selection.rows, MAX_CENSUS, 'Selection rows').map(row => {
    record(row, [...ROW_KEYS, 'rank', 'selected'], 'Selection row');
    return Object.fromEntries(ROW_KEYS.map(key => [key, row[key]]));
  });
  const expected = createCohortSelection({ chainId: selection.chainId, census, seed: selection.seed, sampleSize: selection.requestedSampleSize });
  need(isDeepStrictEqual(selection, expected), 'Selection drift: canonical census, ranks, sample, limitations or digest changed.');
  return expected;
}

/** Every selected hash needs exactly one outcome. Unselected hashes cannot have
 * outcomes. Statuses are caller reports, not an independent evidence verifier.
 * Nonexecutions are not comparable; an exhausted execution budget also exhausts
 * its comparison. Completed executions may still lack an oracle/comparison budget.
 */
export function accountCohortOutcomes(selection, outcomes) {
  const fixed = validateSelection(selection), selected = new Set(fixed.rows.filter(row => row.selected).map(row => row.transactionHash));
  const byHash = new Map();
  for (const outcome of list(outcomes, MAX_CENSUS, 'Outcomes')) {
    record(outcome, ['transactionHash', 'execution', 'comparison'], 'Outcome');
    const transactionHash = hash(outcome.transactionHash, 'Outcome transaction hash');
    need(selected.has(transactionHash), 'Foreign or not-sampled outcome.');
    need(!byHash.has(transactionHash), 'Duplicate selected outcome.');
    need(EXECUTIONS.includes(outcome.execution) && COMPARISONS.includes(outcome.comparison), 'Unsupported outcome status.');
    if (outcome.execution === 'budget_unattempted') need(outcome.comparison === 'budget_unattempted', 'An unattempted execution cannot have a comparison result.');
    else if (outcome.execution !== 'success' && outcome.execution !== 'reverted') need(outcome.comparison === 'not_comparable', 'An unavailable or unsupported execution is not comparable.');
    byHash.set(transactionHash, { transactionHash, execution: outcome.execution, comparison: outcome.comparison });
  }
  need(byHash.size === fixed.sampleSize, 'Missing selected outcomes; retain every selected slot.');
  const execution = Object.fromEntries(EXECUTIONS.map(status => [status, 0]));
  const comparison = Object.fromEntries(COMPARISONS.map(status => [status, 0]));
  const ledger = fixed.rows.map(row => {
    const outcome = byHash.get(row.transactionHash);
    if (!outcome) return { ...row, execution: 'not_sampled', comparison: 'not_sampled' };
    execution[outcome.execution]++; comparison[outcome.comparison]++;
    return { ...row, execution: outcome.execution, comparison: outcome.comparison };
  });
  const completed = execution.success + execution.reverted, comparable = comparison.match + comparison.mismatch;
  return freeze({
    schemaVersion: '1.0', selectionId: fixed.selectionId, chainId: 1,
    counts: { census: fixed.censusSize, selected: fixed.sampleSize, notSampled: fixed.censusSize - fixed.sampleSize, execution, comparison: { ...comparison, unknown: UNKNOWN.reduce((sum, key) => sum + comparison[key], 0) } },
    metrics: {
      samplingFraction: fraction(fixed.sampleSize, fixed.censusSize),
      executionAvailability: fraction(completed, fixed.sampleSize),
      exactComparatorAgreement: fraction(comparison.match, fixed.sampleSize),
      exactComparatorAgreementAmongComparable: fraction(comparison.match, comparable),
    },
    metricBasis: 'Caller-reported execution and exact-comparator statuses; this module verifies accounting, not their evidence.',
    limitations: { ...LIMITS }, ledger,
  });
}
