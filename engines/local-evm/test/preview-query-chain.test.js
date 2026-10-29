import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compilePreviewQueries, decodePreviewValues, nativeBalanceValues, PreviewQueryError } from '../preview-queries.js';

const ACCOUNT = '0x' + '11'.repeat(20), CONTRACT = '0x' + '22'.repeat(20), SPENDER = '0x' + '33'.repeat(20);
const QUERIES = [
  { to: CONTRACT, data: '0x70a08231' + ACCOUNT.slice(2).padStart(64, '0') },
  { to: CONTRACT, data: '0xdd62ed3e' + ACCOUNT.slice(2).padStart(64, '0') + SPENDER.slice(2).padStart(64, '0') },
  { kind: 'aave_v3_user_account_data', contract: CONTRACT, user: ACCOUNT },
  { kind: 'morpho_blue_position', contract: CONTRACT, user: ACCOUNT, marketId: '0x' + 'ab'.repeat(32) },
  { kind: 'native_balance', account: ACCOUNT },
];
const MAINNET = { chainId: 1 }, SEPOLIA = { chainId: 11155111 };
const invalid = fn => assert.throws(fn, e => e instanceof PreviewQueryError && e.code === 'LOCAL_PREVIEW_QUERY_INVALID');
const bytes = c => '0x' + '00'.repeat(c.returnBytes);
const decode = (c, options) => c.query === null ? nativeBalanceValues(c, 7n, options) : decodePreviewValues(c, bytes(c), options);

test('omitted, empty and explicit mainnet options preserve pre-change serialized identities and field order', () => {
  const legacy = JSON.stringify(compilePreviewQueries(QUERIES));
  // Captured from the unmodified chain1 compiler before this feature.
  assert.equal(createHash('sha256').update(legacy).digest('hex'), '06b485d8e28133b08a0eb4350b276570807bd50ca7036bad50902aa2f1e6a6bc');
  for (const options of [undefined, {}, MAINNET, Object.create(null)]) {
    const compiled = compilePreviewQueries(QUERIES, options);
    assert.equal(JSON.stringify(compiled), legacy);
    for (const c of compiled) assert.deepEqual(decode(c, options), decode(c));
  }
});

test('trusted Sepolia chain labels every declared identity without changing addresses calldata units or deployment claims', () => {
  const before = compilePreviewQueries(QUERIES), after = compilePreviewQueries(QUERIES, SEPOLIA);
  for (let i = 0; i < before.length; i++) {
    const expected = structuredClone(before[i]); expected.identity.chainId = '11155111';
    assert.deepEqual(after[i], expected);
    assert(Object.isFrozen(after[i]) && Object.isFrozen(after[i].identity) && Object.isFrozen(after[i].fields[0].unit));
    assert.deepEqual(decode(JSON.parse(JSON.stringify(after[i])), SEPOLIA), decode(before[i], MAINNET));
    if (after[i].query !== null) assert.equal(after[i].identity.contractIdentityVerified, false);
  }
  assert.deepEqual(after[2].fields[0].unit, { kind: 'oracle_base_units', scale: null, currency: null });
  assert.deepEqual(after[3].fields[2].unit, { kind: 'collateral_token_raw_units', scale: null, token: null });
  assert.deepEqual(after[4].identity, { kind: 'native_balance', account: ACCOUNT, chainId: '11155111' });
  const options = Object.assign(Object.create(null), SEPOLIA);
  assert.deepEqual(compilePreviewQueries(QUERIES, options), after);
});

test('redecoders reject whole compiled-entry substitution across chains including serialized typed and native identities', () => {
  const mainnet = compilePreviewQueries(QUERIES, MAINNET), sepolia = compilePreviewQueries(QUERIES, SEPOLIA);
  for (let i = 0; i < mainnet.length; i++) {
    invalid(() => decode(mainnet[i], SEPOLIA));
    invalid(() => decode(sepolia[i], MAINNET));
    invalid(() => decode(sepolia[i]));
    invalid(() => decode(JSON.parse(JSON.stringify(sepolia[i])), {}));
    const changed = structuredClone(mainnet[i]); changed.identity.chainId = '11155111'; invalid(() => decode(changed, MAINNET));
    changed.identity.chainId = 1; invalid(() => decode(changed, MAINNET));
    const unknown = structuredClone(sepolia[i]); unknown.identity.chainId = '42161'; invalid(() => decode(unknown, SEPOLIA));
  }
});

test('typed identity address user and market cannot be borrowed from another query on the same trusted chain', () => {
  for (const descriptor of QUERIES.slice(2, 4)) {
    const original = compilePreviewQueries([descriptor], SEPOLIA)[0];
    const patches = [{ contract: SPENDER }, { user: SPENDER }, ...(descriptor.marketId ? [{ marketId: '0x' + 'cd'.repeat(32) }] : [])];
    for (const patch of patches) {
      const other = compilePreviewQueries([{ ...descriptor, ...patch }], SEPOLIA)[0];
      const changed = structuredClone(original); changed.identity = structuredClone(other.identity);
      invalid(() => decode(changed, SEPOLIA));
    }
  }
});

test('query descriptors cannot select their own chain even when it matches the trusted parent', () => {
  for (const descriptor of QUERIES) for (const options of [undefined, MAINNET, SEPOLIA]) {
    for (const chainId of [1, 11155111, '11155111', undefined]) invalid(() => compilePreviewQueries([{ ...descriptor, chainId }], options));
  }
  const duplicate = { ...QUERIES[2], contract: CONTRACT.toUpperCase() };
  invalid(() => compilePreviewQueries([QUERIES[2], duplicate], SEPOLIA));
});

test('unsupported or noncanonical trusted options reject consistently in compiler and both redecoders', () => {
  const entries = compilePreviewQueries(QUERIES);
  const bad = [null, 1, 11155111, '11155111', [], true,
    ...[0, 999, 42161, '1', '11155111', '0xaa36a7', 1n, 11155111n, undefined, null, NaN, Infinity, {}, []].map(chainId => ({ chainId })),
    { network: 'sepolia' }, { chainId: 1, extra: true }, Object.create({ chainId: 11155111 })];
  for (const options of bad) {
    invalid(() => compilePreviewQueries(QUERIES, options));
    invalid(() => decodePreviewValues(entries[0], bytes(entries[0]), options));
    invalid(() => nativeBalanceValues(entries[4], 0n, options));
  }
});

test('trusted options accessors proxies symbols and hidden chain properties never execute supplied code', () => {
  let calls = 0;
  const getter = {}; Object.defineProperty(getter, 'chainId', { enumerable: true, get() { calls++; return 11155111; } });
  const proxy = new Proxy(SEPOLIA, { get() { calls++; }, getOwnPropertyDescriptor() { calls++; }, ownKeys() { calls++; }, getPrototypeOf() { calls++; } });
  const revoked = Proxy.revocable(SEPOLIA, {}); revoked.revoke();
  const hidden = {}; Object.defineProperty(hidden, 'chainId', { value: 11155111 });
  const symbol = { ...SEPOLIA, [Symbol('network')]: 11155111 };
  const entries = compilePreviewQueries(QUERIES);
  for (const options of [getter, proxy, revoked.proxy, hidden, symbol]) {
    invalid(() => compilePreviewQueries(QUERIES, options));
    invalid(() => decodePreviewValues(entries[0], bytes(entries[0]), options));
    invalid(() => nativeBalanceValues(entries[4], 0n, options));
  }
  assert.equal(calls, 0);
});
