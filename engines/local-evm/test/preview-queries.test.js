import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { compilePreviewQueries, decodePreviewValues, PreviewQueryError } from '../preview-queries.js';

const USER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MARKET = '0x' + 'ab'.repeat(32);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const tuple = (...values) => '0x' + values.map(word).join('');
const abiAddress = value => '0'.repeat(24) + value.slice(2).toLowerCase();
const balance = { to: TOKEN, data: '0x70a08231' + abiAddress(USER) };
const allowance = { to: TOKEN, data: '0xdd62ed3e' + abiAddress(USER) + abiAddress(OTHER) };
const aave = { kind: 'aave_v3_user_account_data', contract: POOL, user: USER };
const morpho = { kind: 'morpho_blue_position', contract: BLUE, user: OTHER, marketId: MARKET };
const max256 = (1n << 256n) - 1n, max128 = (1n << 128n) - 1n;
const invalid = fn => assert.throws(fn, e => e instanceof PreviewQueryError && e.code === 'LOCAL_PREVIEW_QUERY_INVALID');
const compiled = query => compilePreviewQueries([query])[0];

test('four independently hashed ABI selectors and full calldata argument order are exact', () => {
  const selector = signature => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(signature))).subarray(0, 4).toString('hex');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('allowance(address,address)'), '0xdd62ed3e');
  assert.equal(selector('getUserAccountData(address)'), '0xbf92857c');
  assert.equal(selector('position(bytes32,address)'), '0x93c52062');
  const [b, p, a, m] = compilePreviewQueries([balance, allowance, aave, morpho]);
  assert.deepEqual(b.query, { to: TOKEN.toLowerCase(), data: selector('balanceOf(address)') + abiAddress(USER) });
  assert.deepEqual(p.query, { to: TOKEN.toLowerCase(), data: selector('allowance(address,address)') + abiAddress(USER) + abiAddress(OTHER) });
  assert.deepEqual(a.query, { to: POOL.toLowerCase(), data: selector('getUserAccountData(address)') + abiAddress(USER) });
  assert.deepEqual(m.query, { to: BLUE.toLowerCase(), data: selector('position(bytes32,address)') + MARKET.slice(2) + abiAddress(OTHER) });
  assert.deepEqual([b.returnBytes, p.returnBytes, a.returnBytes, m.returnBytes], [32, 32, 192, 96]);
});
test('canonical descriptors preserve distinct token accounts, owners, spenders and typed market identities', () => {
  const [b, p, a, m] = compilePreviewQueries([balance, allowance, aave, morpho]);
  assert.deepEqual(b.identity, { kind: 'balanceOf', chainId: '1', token: TOKEN.toLowerCase(), account: USER, contractIdentityVerified: false });
  assert.deepEqual(p.identity, { kind: 'allowance', chainId: '1', token: TOKEN.toLowerCase(), owner: USER, spender: OTHER, contractIdentityVerified: false });
  assert.deepEqual(a.identity, { kind: aave.kind, contract: POOL.toLowerCase(), user: USER, chainId: '1', contractIdentityVerified: false });
  assert.deepEqual(m.identity, { kind: morpho.kind, contract: BLUE.toLowerCase(), user: OTHER, marketId: MARKET, chainId: '1', contractIdentityVerified: false });
  assert.deepEqual(a.descriptor, { ...aave, contract: POOL.toLowerCase() });
  const zero = compiled({ ...morpho, user: '0x' + '0'.repeat(40), marketId: '0x' + '0'.repeat(64) });
  assert.equal(zero.query.data, '0x93c52062' + '0'.repeat(128));
});
test('scalar uint256 zero, above-JS-precision and maximum are exact raw decimal values', () => {
  for (const [query, name] of [[balance, 'balance'], [allowance, 'allowance']]) {
    const c = compiled(query);
    for (const value of [0n, 9007199254740993n, max256]) {
      assert.deepEqual(decodePreviewValues(c, tuple(value)), [{ name, raw: value.toString(), unit: { kind: 'token_raw_units', scale: null } }]);
    }
  }
});
test('Aave six words preserve unknown base currency and raw health sentinel without judgments', () => {
  const c = compiled(aave), values = [9007199254740993n, 9n, 0n, 8250n, 8000n, max256];
  const rows = decodePreviewValues(c, tuple(...values));
  assert.deepEqual(rows.map(r => [r.name, r.raw]), ['totalCollateralBase', 'totalDebtBase', 'availableBorrowsBase', 'currentLiquidationThreshold', 'ltv', 'healthFactor'].map((name, i) => [name, values[i].toString()]));
  assert.deepEqual(rows[0].unit, { kind: 'oracle_base_units', scale: null, currency: null });
  assert.deepEqual(rows[3].unit, { kind: 'basis_points', scale: '10000' });
  assert.deepEqual(rows[5].unit, { kind: 'ratio', scale: '1000000000000000000' });
  assert(!JSON.stringify(rows).includes('Infinity'));
  assert.equal(Object.hasOwn(rows[5], 'healthy'), false); assert.equal(Object.hasOwn(rows[5], 'measured'), false);
});
test('Morpho shares remain raw and both uint128 high-bit violations reject without truncation', () => {
  const c = compiled(morpho), rows = decodePreviewValues(c, tuple(max256, max128, max128));
  assert.deepEqual(rows.map(r => [r.name, r.raw]), [['supplyShares', max256.toString()], ['borrowShares', max128.toString()], ['collateral', max128.toString()]]);
  assert.equal(rows[0].unit.scale, null); assert.equal(rows[2].unit.token, null);
  for (const values of [[0n, 1n << 128n, 0n], [0n, 0n, 1n << 128n]]) invalid(() => decodePreviewValues(c, tuple(...values)));
});
test('exact static return lengths reject packed, trailing, empty, RPC envelopes and malformed bytes', () => {
  for (const input of [balance, allowance, aave, morpho]) {
    const c = compiled(input), raw = '0x' + '00'.repeat(c.returnBytes);
    for (const value of [null, undefined, false, 0n, [], { result: raw }, '0x', raw.slice(0, -2), raw + '00', raw.replace('0x', '0X'), ' ' + raw, '0x' + 'g'.repeat(raw.length - 2), '0x08c379a0' + raw.slice(2)]) invalid(() => decodePreviewValues(c, value));
    assert.equal(decodePreviewValues(c, raw).length, c.fields.length);
  }
});
test('one-to-eight dense queries, normalized duplicates and unsupported scalar ABI reject', () => {
  for (const value of [null, undefined, {}, [], Array(1), Array.from({ length: 9 }, () => balance)]) invalid(() => compilePreviewQueries(value));
  invalid(() => compilePreviewQueries([balance, { to: TOKEN.toLowerCase(), data: balance.data.toUpperCase() }]));
  invalid(() => compilePreviewQueries([morpho, { ...morpho, contract: BLUE.toLowerCase(), marketId: MARKET.toUpperCase() }]));
  const eight = Array.from({ length: 8 }, (_, i) => ({ to: TOKEN, data: '0x70a08231' + '0'.repeat(24) + BigInt(i).toString(16).padStart(40, '0') }));
  assert.equal(compilePreviewQueries(eight).length, 8);
  for (const data of ['0x', '0x095ea7b3' + allowance.data.slice(10), balance.data + '00', balance.data.slice(0, -2), '0x70a08231' + '1' + balance.data.slice(11), '0xdeadbeef' + balance.data.slice(10)]) invalid(() => compiled({ ...balance, data }));
});
test('chain overrides, missing identity and unsupported fields are rejected', () => {
  for (const query of [balance, allowance, aave, morpho]) {
    for (const patch of [{ chainId: 1 }, { chainId: undefined }, { stateOverrides: {} }, { gas: '0' }, { decimals: 6 }, { verified: true }]) invalid(() => compiled({ ...query, ...patch }));
    for (const key of Object.keys(query)) { const missing = { ...query }; delete missing[key]; invalid(() => compiled(missing)); }
  }
  for (const patch of [{ kind: 'unknown' }, { kind: '__proto__' }, { user: [USER] }, { user: '0x' }, { contract: null }, { marketId: MARKET }]) invalid(() => compiled({ ...aave, ...patch }));
  for (const marketId of [null, undefined, [MARKET], MARKET + '00', MARKET.slice(0, -2)]) invalid(() => compiled({ ...morpho, marketId }));
});
test('getters, proxies, symbols and hidden or inherited inputs never execute user code', () => {
  let invoked = 0;
  for (const key of ['kind', 'contract', 'user']) {
    const query = { ...aave }; Object.defineProperty(query, key, { enumerable: true, get() { invoked++; return aave[key]; } }); invalid(() => compiled(query));
  }
  const array = [balance]; Object.defineProperty(array, '0', { enumerable: true, get() { invoked++; return balance; } }); invalid(() => compilePreviewQueries(array));
  const proxy = new Proxy(balance, { getPrototypeOf() { invoked++; return Object.prototype; }, get() { invoked++; } }); invalid(() => compiled(proxy));
  invalid(() => compilePreviewQueries(new Proxy([balance], { get() { invoked++; } })));
  const revoked = Proxy.revocable(balance, {}); revoked.revoke(); invalid(() => compiled(revoked.proxy));
  const symbol = { ...balance, [Symbol('extra')]: 1 }, hidden = { ...balance }; Object.defineProperty(hidden, 'extra', { value: 1 });
  for (const query of [symbol, hidden, Object.create(balance), new Date(), []]) invalid(() => compiled(query));
  const extra = [balance]; extra.other = 1; invalid(() => compilePreviewQueries(extra));
  assert.equal(invoked, 0);
});
test('compiled metadata is immutable; serialized entries decode only after exact schema rederivation', () => {
  const c = compiled(morpho), raw = tuple(1, 2, 3);
  assert(Object.isFrozen(c)); assert(Object.isFrozen(c.fields)); assert(Object.isFrozen(c.fields[0].unit));
  assert.deepEqual(decodePreviewValues(JSON.parse(JSON.stringify(c)), raw), decodePreviewValues(c, raw));
  for (const change of [x => { x.fields[1].bits = 256; }, x => { x.fields[0].name = 'assets'; }, x => { x.identity.user = USER; }, x => { x.query.data = balance.data; }, x => { x.returnBytes = 32; }, x => { x.fields[0].unit.scale = '1000000'; }]) {
    const tampered = structuredClone(c); change(tampered); invalid(() => decodePreviewValues(tampered, raw));
  }
  let invoked = 0; const tampered = structuredClone(c); Object.defineProperty(tampered.identity, 'user', { enumerable: true, get() { invoked++; return OTHER; } });
  invalid(() => decodePreviewValues(tampered, raw)); assert.equal(invoked, 0);
  const rows = decodePreviewValues(c, raw); rows[0].unit.kind = 'changed'; assert.equal(decodePreviewValues(c, raw)[0].unit.kind, 'supply_shares');
});
