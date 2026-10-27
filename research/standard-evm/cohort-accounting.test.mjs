import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCohortOutcomes, createCohortSelection, CohortAccountingError, MAX_CENSUS } from './cohort-accounting.mjs';

const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const census = Array.from({ length: 6 }, (_, i) => ({ transactionHash: hash(i + 10), blockHash: hash(100 + Math.floor(i / 3)), blockNumber: String(200 + Math.floor(i / 3)), transactionIndex: String(i % 3) }));
const input = (changes = {}) => ({ chainId: 1, census: structuredClone(census), seed: hash(99), sampleSize: 3, ...changes });
const clone = value => structuredClone(value);
const outcomes = selection => selection.rows.filter(row => row.selected).map(row => ({ transactionHash: row.transactionHash, execution: 'success', comparison: 'match' }));

test('fixed raw-byte seed/hash ranking and input-order-independent full ledger', () => {
  const a = createCohortSelection(input()), b = createCohortSelection(input({ census: [...census].reverse() }));
  assert.deepEqual(a, b); assert.equal(a.rows.length, 6); assert.equal(a.rows.filter(row => row.selected).length, 3);
  const vector = createCohortSelection(input({ census: [{ ...census[0], transactionHash: hash(0) }], seed: hash(0) }));
  assert.equal(vector.rows[0].rank, 'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b');
  const upper = census.map(row => ({ ...row, transactionHash: row.transactionHash.toUpperCase().replace('0X', '0x'), blockHash: row.blockHash.toUpperCase().replace('0X', '0x') }));
  assert.deepEqual(a, createCohortSelection(input({ census: upper, seed: hash(99).toUpperCase().replace('0X', '0x') })));
  assert.deepEqual(a.rows.map(row => row.transactionHash), census.map(row => row.transactionHash));
});

test('selection is deeply immutable, JSON roundtrippable, independent of outcomes and never replenished', () => {
  const selection = createCohortSelection(input()), fixed = JSON.stringify(selection), good = outcomes(selection);
  assert.throws(() => { selection.rows[0].selected = !selection.rows[0].selected; }, TypeError);
  assert.throws(() => selection.rows.pop(), TypeError);
  const failed = good.map(row => ({ ...row, execution: 'provider_unavailable', comparison: 'not_comparable' }));
  const a = accountCohortOutcomes(selection, good), b = accountCohortOutcomes(JSON.parse(fixed), failed.reverse());
  assert.equal(JSON.stringify(selection), fixed); assert.equal(a.selectionId, b.selectionId);
  assert.deepEqual(a.ledger.map(row => [row.transactionHash, row.selected]), b.ledger.map(row => [row.transactionHash, row.selected]));
  assert.equal(b.counts.selected, 3); assert.equal(b.counts.execution.provider_unavailable, 3);
  assert.equal(b.ledger.filter(row => row.execution === 'not_sampled').length, 3);
  assert.deepEqual(b.metrics.samplingFraction, { numerator: 3, denominator: 6, fraction: '3/6' });
  assert.deepEqual(b.metrics.executionAvailability, { numerator: 0, denominator: 3, fraction: '0/3' });
  assert.throws(() => createCohortSelection({ ...input(), outcomes: good }), /unsupported fields/);
});

test('reverts execute; oracle absence is unknown, not a pass or a mismatch; denominators stay separate', () => {
  const selection = createCohortSelection(input({ sampleSize: 6 })), rows = outcomes(selection);
  const statuses = [
    ['success', 'match'], ['reverted', 'match'], ['success', 'mismatch'],
    ['reverted', 'oracle_unavailable'], ['unsupported', 'not_comparable'], ['budget_unattempted', 'budget_unattempted'],
  ];
  rows.forEach((row, i) => { [row.execution, row.comparison] = statuses[i]; });
  const report = accountCohortOutcomes(selection, rows);
  assert.deepEqual(report.metrics.executionAvailability, { numerator: 4, denominator: 6, fraction: '4/6' });
  assert.deepEqual(report.metrics.exactComparatorAgreement, { numerator: 2, denominator: 6, fraction: '2/6' });
  assert.deepEqual(report.metrics.exactComparatorAgreementAmongComparable, { numerator: 2, denominator: 3, fraction: '2/3' });
  assert.equal(report.counts.comparison.unknown, 3); assert.equal(report.counts.comparison.mismatch, 1);
  assert.equal(report.ledger.filter(row => row.execution === 'budget_unattempted').length, 1);
  assert.equal(report.counts.selected, 6);
});

test('no comparison denominator when every oracle is unavailable', () => {
  const selection = createCohortSelection(input());
  const report = accountCohortOutcomes(selection, outcomes(selection).map(row => ({ ...row, comparison: 'oracle_unavailable' })));
  assert.equal(report.counts.comparison.match, 0); assert.equal(report.counts.comparison.mismatch, 0); assert.equal(report.counts.comparison.unknown, 3);
  assert.equal(report.metrics.executionAvailability.fraction, '3/3');
  assert.equal(report.metrics.exactComparatorAgreement.fraction, '0/3');
  assert.deepEqual(report.metrics.exactComparatorAgreementAmongComparable, { numerator: 0, denominator: 0, fraction: null });
});

test('completed EVM faults are distinct from REVERT and provider failures', () => {
  const selection = createCohortSelection(input()), rows = outcomes(selection);
  rows[0] = { ...rows[0], execution: 'failed', comparison: 'match' };
  rows[1] = { ...rows[1], execution: 'reverted', comparison: 'not_comparable' };
  rows[2] = { ...rows[2], execution: 'provider_unavailable', comparison: 'not_comparable' };
  const report = accountCohortOutcomes(selection, rows);
  assert.equal(report.counts.execution.failed, 1);
  assert.equal(report.counts.execution.reverted, 1);
  assert.equal(report.counts.execution.provider_unavailable, 1);
  assert.deepEqual(report.metrics.executionAvailability, { numerator: 2, denominator: 3, fraction: '2/3' });
  assert.deepEqual(report.metrics.exactComparatorAgreement, { numerator: 1, denominator: 3, fraction: '1/3' });
});

test('empty census and zero sample produce no empty-denominator percentage; oversize requests clamp to N', () => {
  for (const sampleSize of [0, 3]) {
    const empty = createCohortSelection(input({ census: [], sampleSize }));
    const report = accountCohortOutcomes(empty, []);
    for (const metric of Object.values(report.metrics)) assert.deepEqual(metric, { numerator: 0, denominator: 0, fraction: null });
    assert.deepEqual(report.ledger, []);
  }
  const zero = accountCohortOutcomes(createCohortSelection(input({ sampleSize: 0 })), []);
  assert.equal(zero.metrics.samplingFraction.fraction, '0/6'); assert.equal(zero.metrics.executionAvailability.fraction, null);
  assert.equal(zero.ledger.filter(row => row.execution === 'not_sampled').length, 6);
  const all = createCohortSelection(input({ sampleSize: 100 }));
  assert.equal(all.sampleSize, 6); assert.equal(all.requestedSampleSize, 100);
});

test('duplicate, missing, foreign and unselected outcomes fail instead of dropping denominator rows', () => {
  const selection = createCohortSelection(input()), rows = outcomes(selection);
  assert.throws(() => accountCohortOutcomes(selection, rows.slice(1)), /Missing selected/);
  assert.throws(() => accountCohortOutcomes(selection, [...rows, rows[0]]), /Duplicate/);
  for (const transactionHash of [hash(999), selection.rows.find(row => !row.selected).transactionHash]) {
    assert.throws(() => accountCohortOutcomes(selection, [...rows.slice(1), { ...rows[0], transactionHash }]), /Foreign or not-sampled/);
  }
  assert.throws(() => accountCohortOutcomes(selection, [...rows, { ...rows[0], transactionHash: rows[0].transactionHash.toUpperCase().replace('0X', '0x') }]), /Duplicate/);
});

test('selection drift, including plausible census edits and replaced ranks, is rejected', () => {
  const original = createCohortSelection(input()), rows = outcomes(original);
  for (const edit of [
    value => value.censusSize++, value => value.sampleSize--, value => value.requestedSampleSize++,
    value => { value.rows[0].transactionHash = hash(900); }, value => { value.rows[0].blockHash = hash(500); },
    value => { value.rows[0].transactionIndex = '900'; }, value => { value.rows[0].rank = '0'.repeat(64); },
    value => { value.rows[0].selected = !value.rows[0].selected; }, value => value.rows.pop(),
    value => value.rows.reverse(), value => { value.selectionId = '0'.repeat(64); },
    value => { value.limitations.finalityEstablished = true; },
  ]) { const changed = clone(original); edit(changed); assert.throws(() => accountCohortOutcomes(changed, rows), CohortAccountingError); }
});

test('census collision checks include normalized hashes, block positions and block identities', () => {
  for (const row of [
    { ...census[0], transactionHash: census[0].transactionHash.toUpperCase().replace('0X', '0x'), transactionIndex: '5' },
    { ...census[0], transactionHash: hash(999) },
    { ...census[0], transactionHash: hash(999), blockHash: hash(999), transactionIndex: '5' },
    { ...census[0], transactionHash: hash(999), blockNumber: '999', transactionIndex: '5' },
  ]) assert.throws(() => createCohortSelection(input({ census: [...census, row] })), CohortAccountingError);
  const gaps = census.map(row => ({ ...row, transactionIndex: String(Number(row.transactionIndex) + 10) }));
  assert.doesNotThrow(() => createCohortSelection(input({ census: gaps }))); // Completeness is deliberately not asserted.
});

test('unsupported statuses and impossible execution/comparator combinations reject', () => {
  const selection = createCohortSelection(input()), rows = outcomes(selection);
  for (const change of [
    { execution: 'not_sampled' }, { execution: 'oracle_unavailable' }, { comparison: 'pass' },
    { execution: 'unsupported', comparison: 'match' }, { execution: 'provider_unavailable', comparison: 'mismatch' },
    { execution: 'budget_unattempted', comparison: 'oracle_unavailable' }, { note: 'success' },
  ]) assert.throws(() => accountCohortOutcomes(selection, [{ ...rows[0], ...change }, ...rows.slice(1)]), CohortAccountingError);
});

test('strict bounds, chain, canonical quantities and data-only inputs reject silently altered declarations', () => {
  for (const change of [
    { chainId: '1' }, { chainId: 999 }, { sampleSize: -1 }, { sampleSize: 0.5 }, { sampleSize: MAX_CENSUS + 1 },
    { seed: 'seed' }, { seed: [hash(99)] }, { census: Array(MAX_CENSUS + 1) }, { census: Array(2) }, { filter: 'successful' },
  ]) assert.throws(() => createCohortSelection(input(change)), CohortAccountingError);
  for (const change of [{ blockNumber: 200 }, { blockNumber: '0200' }, { blockNumber: '18446744073709551616' }, { transactionIndex: '-1' }, { transactionHash: hash(1) + '00' }]) {
    assert.throws(() => createCohortSelection(input({ census: [{ ...census[0], ...change }] })), CohortAccountingError);
  }
  let called = false; const getter = input(); Object.defineProperty(getter, 'seed', { get() { called = true; return hash(99); }, enumerable: true });
  assert.throws(() => createCohortSelection(getter), CohortAccountingError); assert.equal(called, false);
  const arrayGetter = input(); Object.defineProperty(arrayGetter.census, '0', { get() { called = true; return census[0]; }, enumerable: true });
  assert.throws(() => createCohortSelection(arrayGetter), CohortAccountingError); assert.equal(called, false);
});

test('outputs disclaim authentication, chronology and outcome verification and make no coverage/security claim', () => {
  const selection = createCohortSelection(input()), report = accountCohortOutcomes(selection, outcomes(selection));
  for (const value of [selection, report]) {
    assert.equal(Object.values(value.limitations).every(flag => flag === false), true);
    for (const key of ['censusAuthenticationEstablished', 'finalityEstablished', 'censusCompletenessEstablished', 'envelopeCompletenessEstablished', 'predeclarationChronologyEstablished', 'outcomeEvidenceVerified', 'economicCompletenessEstablished', 'securityScoreEstablished']) assert.equal(value.limitations[key], false);
  }
  assert.match(report.metricBasis, /Caller-reported/); assert.match(report.metricBasis, /not their evidence/);
  assert.throws(() => { report.ledger[0].comparison = 'match'; }, TypeError);
  assert.doesNotThrow(() => JSON.stringify(report));
});
