import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStandardSimulation, validateStandardSequence, simulateStandardSequence, projectStandardPreview, STANDARD_EXAMPLES } from '../src/standard-simulation.js';
import { compileMeasurementQuery } from '../engines/standard-evm/unsigned-call.js';
import { comparePositionResults } from '../engines/standard-evm/position-queries.js';
import { InputError } from '../src/validate.js';

const example = STANDARD_EXAMPLES[0].input;
const aave = { kind: 'aave_v3_user_account_data', contract: example.to, user: example.from };
const morpho = { kind: 'morpho_blue_position', contract: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', user: '0xbeef01735c132ada46aa9aa4c54623caa92a64cb', marketId: '0x' + 'ab'.repeat(32) };
const tuple = (...values) => '0x' + values.map(n => BigInt(n).toString(16).padStart(64, '0')).join('');
function measurement(descriptor, beforeReturnData, afterReturnData) {
  const { query, position } = compileMeasurementQuery(descriptor, 1);
  const decoded = comparePositionResults({ request: position.identity, before: beforeReturnData, after: afterReturnData });
  return { query, position, status: 'measured', beforeReturnData, afterReturnData, rows: decoded.rows,
    basis: 'isolated_traced_ABI_queries_with_nonce_only_effects', contractIdentityVerified: false,
    queryEvidence: [{ state: 'before', traceEvidenceId: 1, mutationEvidenceId: 2 }, { state: 'after', traceEvidenceId: 3, mutationEvidenceId: 4 }] };
}
function projectionInput() {
  const input = { ...example, queries: [aave, example.queries[0], morpho] };
  const result = { canonicalStatus: 'verified', execution: { status: 'success' }, measurements: [
    measurement(aave, tuple(0, 0, 0, 0, 0, (1n << 256n) - 1n), tuple(396290348500, 0, 317032278800, 8250, 8000, (1n << 256n) - 1n)),
    { query: example.queries[0], status: 'measured', beforeRaw: '3962903485', afterRaw: '0', deltaRaw: '-3962903485' },
    measurement(morpho, tuple(123, 12, 4), tuple(200, 8, 4)),
  ] };
  return { input, result };
}

test('mixed query API accepts exact declarations and normalizes without caller chain or metadata', () => {
  const input = { ...example, queries: [aave, example.queries[0], { ...morpho, contract: morpho.contract.toUpperCase().replace('0X', '0x') }] };
  assert.deepEqual(validateStandardSimulation(input).queries, [aave, example.queries[0], morpho]);
  for (const change of [{ chainId: 1 }, { data: '0x' }, { to: aave.contract }, { decimals: 8 }, { marketId: morpho.marketId }]) {
    assert.throws(() => validateStandardSimulation({ ...example, queries: [{ ...aave, ...change }] }), InputError);
  }
  for (const bad of [{ ...morpho, marketId: '0x12' }, { ...aave, kind: 'constructor' }, { ...aave, contract: '0x000000000000000000000000000000000000ba1a' }]) {
    assert.throws(() => validateStandardSimulation({ ...example, queries: [bad] }), InputError);
  }
  assert.throws(() => validateStandardSimulation({ ...example, queries: [aave, { ...aave, user: aave.user.toUpperCase().replace('0X', '0x') }] }), /Duplicate/);
  assert.throws(() => validateStandardSimulation({ ...example, queries: Array(9).fill(aave) }), /one and eight/);
});

test('position projection preserves mixed indexes, queried owner, exact tuple fields and units', () => {
  const { input, result } = projectionInput(), preview = projectStandardPreview(input, result);
  assert.deepEqual(preview.queries.map(row => row.index), [1]);
  assert.deepEqual(preview.positions.map(row => row.index), [0, 2]);
  assert.equal(preview.positions[0].userIsSender, true); assert.equal(preview.positions[1].userIsSender, false);
  assert.equal(preview.positions[1].marketId, morpho.marketId);
  assert.deepEqual(preview.positions[1].rows.map(row => row.deltaRaw), ['77', '-4', '0']);
  assert.equal(preview.positions[0].rows[0].unit.currency, null);
  assert.equal(preview.positions[0].rows[0].unit.scale, null);
  assert.equal(preview.positions[0].rows[5].afterRaw, ((1n << 256n) - 1n).toString());
  assert.equal(preview.positions[0].rows[5].deltaRaw, '0');
  assert.equal(preview.positions[1].rows[2].unit.token, null);
  assert.ok(preview.positions.every(row => row.contractIdentityVerified === false && !('deltaRaw' in row)));
  assert.equal(preview.queries[0].delta, '-3962.903485');
});

test('position preview withholds tuples on identity, ABI, arithmetic or context inconsistency', () => {
  const mutations = [
    result => { result.measurements[0].position.identity.user = morpho.user; },
    result => { result.measurements[0].query.data = '0x'; },
    result => { result.measurements[0].position.returnBytes = 32; },
    result => { result.measurements[0].rows[0].deltaRaw = '1'; },
    result => { result.measurements[0].rows[0].unit.scale = '100000000'; },
    result => { result.measurements[0].beforeReturnData = '0x'; },
    result => { result.measurements[0].contractIdentityVerified = true; },
    result => { result.measurements[0].basis = 'event_amount'; },
    result => { result.canonicalStatus = 'unverified'; },
    result => { result.execution.status = 'reverted_or_failed'; },
  ];
  for (const mutate of mutations) {
    const { input, result } = projectionInput(); mutate(result);
    const row = projectStandardPreview(input, result).positions[0];
    assert.equal(row.status, 'unavailable'); assert.equal(row.rows, undefined);
    assert.equal(row.beforeReturnData, undefined); assert.equal(row.afterReturnData, undefined);
  }
});

test('unavailable positions keep identity and reason without exposing stale amounts', () => {
  const { input, result } = projectionInput();
  result.measurements[0].status = 'unavailable'; result.measurements[0].reason = 'Query failed.';
  const row = projectStandardPreview(input, result).positions[0];
  assert.equal(row.user, aave.user); assert.equal(row.reason, 'Query failed.'); assert.equal(row.rows, undefined);
  assert.equal(row.beforeReturnData, undefined); assert.equal(row.afterReturnData, undefined);
});

test('sequence typed inputs are validated completely before provider work', async () => {
  const call = { to: example.to, data: example.data, value: '0', queries: [aave, morpho] };
  const input = { chainId: 1, from: example.from, block: example.block, calls: [call, call] };
  assert.deepEqual(validateStandardSequence(input), input);
  let reads = 0;
  const invalid = structuredClone(input); invalid.calls[1].queries[1].marketId = '0x';
  await assert.rejects(simulateStandardSequence(invalid, { async call() { reads++; throw Error('must not read'); } }), InputError);
  assert.equal(reads, 0);
});
