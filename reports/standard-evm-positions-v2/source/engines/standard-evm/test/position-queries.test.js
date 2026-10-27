import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePositionQuery, decodePositionResult, comparePositionResults, PositionQueryError } from '../position-queries.js';

const AAVE = { kind: 'aave_v3_user_account_data', chainId: 1, contract: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', user: '0x1111111111111111111111111111111111111111' };
const MORPHO = { kind: 'morpho_blue_position', chainId: '1', contract: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', user: AAVE.user, marketId: '0x' + 'ab'.repeat(32) };
const MAX256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const MAX128 = '340282366920938463463374607431768211455';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const tuple = (...values) => '0x' + values.map(word).join('');
const zerosAave = tuple(0, 0, 0, 0, 0, 0), zerosMorpho = tuple(0, 0, 0);

test('known ABI selectors, exact argument word order and explicit identities', () => {
  const a = encodePositionQuery(AAVE);
  assert.deepEqual(a.query, { to: AAVE.contract.toLowerCase(), data: '0xbf92857c0000000000000000000000001111111111111111111111111111111111111111' });
  assert.equal(a.returnBytes, 192); assert.equal(a.identity.chainId, '1'); assert.equal(a.signature, 'getUserAccountData(address)');
  const m = encodePositionQuery(MORPHO);
  assert.equal(m.query.data, '0x93c52062' + 'ab'.repeat(32) + '0'.repeat(24) + '1'.repeat(40));
  assert.equal(m.query.to, MORPHO.contract.toLowerCase()); assert.equal(m.returnBytes, 96); assert.equal(m.identity.marketId, MORPHO.marketId);
  assert.equal(m.signature, 'position(bytes32,address)');
});
test('declaration identity retains chain, contract, user and market without merging', () => {
  const one = encodePositionQuery(MORPHO), other = encodePositionQuery({ ...MORPHO, chainId: '999', user: '0x' + '22'.repeat(20), marketId: '0x' + 'cd'.repeat(32) });
  assert.notDeepEqual(one.identity, other.identity); assert.notEqual(one.query.data, other.query.data);
  const zero = encodePositionQuery({ ...MORPHO, user: '0x' + '0'.repeat(40), marketId: '0x' + '0'.repeat(64) });
  assert.equal(zero.query.data, '0x93c52062' + '0'.repeat(128));
  assert.equal(encodePositionQuery({ ...AAVE, chainId: MAX256 }).identity.chainId, MAX256);
});
test('Aave six fields preserve exact integers beyond JS precision and uint256 maximum', () => {
  const decoded = decodePositionResult(AAVE, tuple('9007199254740993', 0, 7, 8250, 8000, MAX256));
  assert.deepEqual(decoded.fields.map(f => [f.name, f.raw]), [
    ['totalCollateralBase', '9007199254740993'], ['totalDebtBase', '0'], ['availableBorrowsBase', '7'],
    ['currentLiquidationThreshold', '8250'], ['ltv', '8000'], ['healthFactor', MAX256],
  ]);
  assert.equal(decoded.fields[0].unit.currency, null); assert.equal(decoded.fields[0].unit.scale, null);
  assert.equal(decoded.fields[3].unit.kind, 'basis_points'); assert.equal(decoded.fields[3].unit.scale, '10000');
  assert.equal(decoded.fields[5].unit.scale, '1000000000000000000');
  assert.equal(decoded.status, 'decoded'); assert.deepEqual(decoded.claims, { contractIdentityVerified: false, stateVerified: false, measured: false });
  assert.equal(JSON.stringify(decoded).includes('Infinity'), false);
});
test('Morpho uint256 and uint128 endpoints decode without narrowing or asset conversion', () => {
  const decoded = decodePositionResult(MORPHO, '0x' + 'f'.repeat(64) + '0'.repeat(32) + 'f'.repeat(32) + '0'.repeat(63) + '1');
  assert.deepEqual(decoded.fields.map(f => f.raw), [MAX256, MAX128, '1']);
  assert.deepEqual(decoded.fields.map(f => f.abiType), ['uint256', 'uint128', 'uint128']);
  assert.deepEqual(decoded.fields.map(f => f.unit.kind), ['supply_shares', 'borrow_shares', 'collateral_token_raw_units']);
  assert.equal(decoded.fields[2].unit.token, null); assert.equal(decoded.fields[2].unit.scale, null);
});
test('noncanonical high bits in either uint128 field fail, not truncate', () => {
  const overflow = '0x' + '0'.repeat(31) + '1' + '0'.repeat(32);
  for (const index of [1, 2]) {
    const words = [word(0), word(0), word(0)]; words[index] = overflow.slice(2);
    assert.throws(() => decodePositionResult(MORPHO, '0x' + words.join('')), /noncanonical high bits/);
  }
  assert.throws(() => comparePositionResults({ request: MORPHO, before: zerosMorpho, after: tuple(0, 1n << 128n, 0) }), PositionQueryError);
});
test('deltas are signed exact raw arithmetic, including ratio/sentinel transitions', () => {
  const result = comparePositionResults({ request: AAVE, before: tuple(MAX256, 10, 0, 8250, 8000, MAX256), after: tuple(0, 7, 11, 8000, 8050, 1) });
  assert.deepEqual(result.rows.map(r => r.deltaRaw), ['-' + MAX256, '-3', '11', '-250', '50', (1n - BigInt(MAX256)).toString()]);
  assert.equal(result.deltaBasis, 'raw_integer_subtraction_after_minus_before'); assert.equal(result.status, 'decoded_difference');
  const reverse = comparePositionResults({ request: MORPHO, before: zerosMorpho, after: tuple(MAX256, MAX128, MAX128) });
  assert.deepEqual(reverse.rows.map(r => r.deltaRaw), [MAX256, MAX128, MAX128]);
  assert.deepEqual(comparePositionResults({ request: AAVE, before: zerosAave, after: zerosAave }).rows.map(r => r.deltaRaw), Array(6).fill('0'));
});
test('return length is exactly static ABI words: no error, empty, offset, packed or extra bytes', () => {
  for (const [request, raw] of [[AAVE, zerosAave], [MORPHO, zerosMorpho]]) {
    for (const malformed of [null, undefined, [], { result: raw }, '0x', raw.slice(0, -2), raw + '00', '0x20' + raw.slice(2), raw.replace('0x', '0X'), raw + ' ', 0]) {
      assert.throws(() => decodePositionResult(request, malformed), PositionQueryError);
    }
    assert.throws(() => decodePositionResult(request, '0x08c379a0' + '0'.repeat(128)), PositionQueryError);
  }
  assert.throws(() => decodePositionResult(MORPHO, '0x' + '0'.repeat(128)), PositionQueryError);
  assert.throws(() => decodePositionResult(AAVE, '0x' + 'g'.repeat(384)), PositionQueryError);
});
test('malformed identity, unknown keys and noncanonical chain declarations reject', () => {
  for (const change of [
    { kind: 'unknown' }, { kind: '__proto__' }, { chainId: 0 }, { chainId: -1 }, { chainId: 1.5 }, { chainId: true },
    { chainId: '0x1' }, { chainId: '01' }, { chainId: ' 1' }, { chainId: Number.MAX_SAFE_INTEGER + 1 }, { chainId: (1n << 256n).toString() },
    { user: [AAVE.user] }, { user: '0x' + '1'.repeat(39) }, { contract: null }, { contract: '0x' + '2'.repeat(41) },
    { marketId: undefined }, { decimals: 18 }, { data: '0x' }, { stateOverrides: {} },
  ]) assert.throws(() => encodePositionQuery({ ...AAVE, ...change }), PositionQueryError);
  for (const marketId of [undefined, null, ['0x' + '0'.repeat(64)], '0x' + '0'.repeat(63), '0x' + '0'.repeat(66)]) assert.throws(() => encodePositionQuery({ ...MORPHO, marketId }), PositionQueryError);
  for (const key of ['kind', 'chainId', 'contract', 'user']) { const bad = { ...AAVE }; delete bad[key]; assert.throws(() => encodePositionQuery(bad), PositionQueryError); }
});
test('records cannot execute getters or conceal extra/symbol/inherited fields', () => {
  let called = false; const getter = { ...AAVE }; Object.defineProperty(getter, 'user', { enumerable: true, get() { called = true; return AAVE.user; } });
  assert.throws(() => encodePositionQuery(getter), PositionQueryError); assert.equal(called, false);
  const symbol = { ...AAVE, [Symbol('hidden')]: 1 }, hidden = { ...AAVE }; Object.defineProperty(hidden, 'secret', { value: 1 });
  for (const value of [symbol, hidden, Object.create(AAVE), [], new Date(), null]) assert.throws(() => encodePositionQuery(value), PositionQueryError);
  assert.throws(() => comparePositionResults({ request: AAVE, before: zerosAave, after: zerosAave, verified: true }), PositionQueryError);
});
test('normalization and output edits never mutate the request or future metadata', () => {
  const input = Object.freeze({ ...MORPHO, marketId: MORPHO.marketId.toUpperCase().replace('0X', '0x') });
  const result = decodePositionResult(input, zerosMorpho); result.fields[0].unit.references.length = 0; result.identity.user = 'changed';
  const again = decodePositionResult(input, zerosMorpho); assert(again.fields[0].unit.references.length > 0); assert.equal(again.identity.user, MORPHO.user);
  assert.equal(input.marketId, MORPHO.marketId.toUpperCase().replace('0X', '0x'));
  assert.doesNotThrow(() => JSON.stringify(comparePositionResults({ request: AAVE, before: zerosAave, after: tuple(MAX256, 0, 0, 0, 0, MAX256) })));
});
