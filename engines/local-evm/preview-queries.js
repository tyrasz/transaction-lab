// Explicit ABI/native-read compilation only. Query identities are declarations, not verified
// deployments. Raw words establish neither call success nor state provenance.
// Reference interfaces: EIP-20 balanceOf/allowance; Aave V3 IPool.getUserAccountData;
// Morpho Blue IMorpho.position. No provider/standard-engine imports or I/O.
import { types } from 'node:util';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BALANCE = /^0x70a082310{24}[0-9a-f]{40}$/i;
const ALLOWANCE = /^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/i;
const SCHEMAS = {
  aave_v3_user_account_data: {
    selector: '0xbf92857c',
    fields: [
      { name: 'totalCollateralBase', bits: 256, unit: { kind: 'oracle_base_units', scale: null, currency: null } },
      { name: 'totalDebtBase', bits: 256, unit: { kind: 'oracle_base_units', scale: null, currency: null } },
      { name: 'availableBorrowsBase', bits: 256, unit: { kind: 'oracle_base_units', scale: null, currency: null } },
      { name: 'currentLiquidationThreshold', bits: 256, unit: { kind: 'basis_points', scale: '10000' } },
      { name: 'ltv', bits: 256, unit: { kind: 'basis_points', scale: '10000' } },
      { name: 'healthFactor', bits: 256, unit: { kind: 'ratio', scale: '1000000000000000000' } },
    ],
  },
  morpho_blue_position: {
    selector: '0x93c52062',
    fields: [
      { name: 'supplyShares', bits: 256, unit: { kind: 'supply_shares', scale: null } },
      { name: 'borrowShares', bits: 128, unit: { kind: 'borrow_shares', scale: null } },
      { name: 'collateral', bits: 128, unit: { kind: 'collateral_token_raw_units', scale: null, token: null } },
    ],
  },
};

export class PreviewQueryError extends Error {
  constructor(message) { super(message); this.name = 'PreviewQueryError'; this.code = 'LOCAL_PREVIEW_QUERY_INVALID'; }
}
const need = (condition, message) => { if (!condition) throw new PreviewQueryError(message); };
const own = (value, key) => Object.hasOwn(value, key);
function record(value, keys) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value), 'A plain query record is required.');
  need([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Query record prototype is unsupported.');
  const actual = Reflect.ownKeys(value);
  need(actual.length === keys.length && keys.every(key => own(value, key)), 'Query fields are missing or unsupported.');
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(typeof key === 'string' && keys.includes(key) && descriptor.enumerable && own(descriptor, 'value'), 'Query accessors and hidden fields are unsupported.');
  }
  return value;
}
function list(value, min, max) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'A plain query list is required.');
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  need(Number.isSafeInteger(length) && length >= min && length <= max, 'A preview requires one to eight declared queries.');
  const keys = Reflect.ownKeys(value);
  need(keys.length === length + 1 && keys.includes('length'), 'Query list must be dense without extra properties.');
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    need(descriptor && descriptor.enumerable && own(descriptor, 'value'), 'Query list accessors and missing entries are unsupported.');
  }
  return value;
}
function address(value) { need(typeof value === 'string' && value.length === 42 && ADDRESS.test(value), 'Query identity requires a 20-byte address.'); return value.toLowerCase(); }
function freeze(value) { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function compileOne(input) {
  // Inspect descriptors before reading even the discriminator.
  need(input !== null && typeof input === 'object' && !types.isProxy(input) && !Array.isArray(input), 'A plain query record is required.');
  const typed = own(input, 'kind');
  let descriptor, query, identity, fields;
  if (!typed) {
    record(input, ['to', 'data']);
    const to = address(input.to), data = input.data;
    need(typeof data === 'string' && data.length <= 138 && (BALANCE.test(data) || ALLOWANCE.test(data)), 'Only canonical balanceOf and allowance calldata is supported.');
    descriptor = { to, data: data.toLowerCase() }; query = { ...descriptor };
    const account = '0x' + descriptor.data.slice(34, 74), balance = BALANCE.test(descriptor.data);
    identity = { kind: balance ? 'balanceOf' : 'allowance', chainId: '1', token: to,
      ...(balance ? { account } : { owner: account, spender: '0x' + descriptor.data.slice(98, 138) }), contractIdentityVerified: false };
    fields = [{ name: balance ? 'balance' : 'allowance', bits: 256, unit: { kind: 'token_raw_units', scale: null } }];
  } else {
    const kindDescriptor = Object.getOwnPropertyDescriptor(input, 'kind');
    need(kindDescriptor && kindDescriptor.enumerable && own(kindDescriptor, 'value') && typeof kindDescriptor.value === 'string' && (own(SCHEMAS, kindDescriptor.value) || kindDescriptor.value === 'native_balance'), 'Unsupported preview query kind.');
    const kind = kindDescriptor.value;
    if (kind === 'native_balance') {
      record(input, ['kind', 'account']);
      descriptor = { kind, account: address(input.account) };
      return freeze({ descriptor, query: null, identity: { ...descriptor, chainId: '1' }, returnBytes: 0,
        fields: [{ name: 'balance', bits: 256, unit: { kind: 'native_wei', scale: '1000000000000000000' } }] });
    }
    record(input, kind === 'morpho_blue_position' ? ['kind', 'contract', 'user', 'marketId'] : ['kind', 'contract', 'user']);
    descriptor = { kind, contract: address(input.contract), user: address(input.user) };
    if (kind === 'morpho_blue_position') {
      need(typeof input.marketId === 'string' && input.marketId.length === 66 && WORD.test(input.marketId), 'Morpho position requires an explicit 32-byte market ID.');
      descriptor.marketId = input.marketId.toLowerCase();
    }
    identity = { ...descriptor, chainId: '1', contractIdentityVerified: false };
    query = { to: descriptor.contract, data: SCHEMAS[kind].selector + (descriptor.marketId?.slice(2) ?? '') + '0'.repeat(24) + descriptor.user.slice(2) };
    fields = structuredClone(SCHEMAS[kind].fields);
  }
  return freeze({ descriptor, query, identity, returnBytes: fields.length * 32, fields });
}

/** Fixed Ethereum chain1. Zero addresses/market IDs are valid ABI words, not
 * evidence that an account or market exists. Every list is validated fully
 * before its compiled output is returned. Duplicate canonical calls reject. */
export function compilePreviewQueries(queries) {
  list(queries, 1, 8);
  const compiled = [], seen = new Set();
  for (const input of queries) {
    const entry = compileOne(input), key = entry.query === null ? 'native:' + entry.descriptor.account : entry.query.to + ':' + entry.query.data;
    need(!seen.has(key), 'Duplicate canonical preview query.'); seen.add(key); compiled.push(entry);
  }
  return freeze(compiled);
}

// Accept a serialized compiled entry as well as the original immutable object,
// but rederive every ABI field from its descriptor. Never trust caller-edited
// bit widths, field names, identities or return lengths; never execute getters.
function sameTree(actual, expected) {
  if (expected === null || typeof expected !== 'object') { need(actual === expected, 'Compiled query differs from its descriptor.'); return; }
  if (Array.isArray(expected)) { list(actual, expected.length, expected.length); for (let i = 0; i < expected.length; i++) sameTree(actual[i], expected[i]); return; }
  record(actual, Object.keys(expected)); for (const key of Object.keys(expected)) sameTree(actual[key], expected[key]);
}

/** Decode one compiled query's raw return bytes. This is not an RPC envelope,
 * call-success assertion or measurement. Unit labels describe the declared ABI
 * only. No decimals, prices, share conversions or health judgment are inferred. */
export function decodePreviewValues(compiled, returnData) {
  record(compiled, ['descriptor', 'query', 'identity', 'returnBytes', 'fields']);
  const canonical = compileOne(compiled.descriptor); sameTree(compiled, canonical);
  need(canonical.query !== null, 'A native balance is an account-state read, not ABI return data.');
  need(typeof returnData === 'string' && returnData.length === 2 + canonical.returnBytes * 2 && /^0x[0-9a-fA-F]+$/.test(returnData), 'Return data must contain exactly the declared static ABI words.');
  return canonical.fields.map((field, index) => {
    const value = BigInt('0x' + returnData.slice(2 + index * 64, 2 + (index + 1) * 64));
    need(value < (1n << BigInt(field.bits)), 'Return data has noncanonical high bits for its integer type.');
    return { name: field.name, raw: value.toString(), unit: structuredClone(field.unit) };
  });
}

/** Format only an explicitly observed native account balance. Provenance,
 * execution completion and state immutability are checked by the core/parent.
 * This helper accepts no ABI bytes or Number conversion. */
export function nativeBalanceValues(compiled, balance) {
  record(compiled, ['descriptor', 'query', 'identity', 'returnBytes', 'fields']);
  const canonical = compileOne(compiled.descriptor); sameTree(compiled, canonical);
  need(canonical.query === null && typeof balance === 'bigint' && balance >= 0n && balance < (1n << 256n), 'A native read requires an exact uint256 balance.');
  return [{ name: 'balance', raw: balance.toString(), unit: structuredClone(canonical.fields[0].unit) }];
}
