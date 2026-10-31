// Pure ABI encoding/decoding; callers must establish execution and state context.
// Supplied contract/user/market identity and result bytes are unverified input.
// Reference protocol units do not authenticate a particular deployment.
import { keccak_256 } from '@noble/hashes/sha3.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/, WORD = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const SOURCES = Object.freeze({
  aavePool: 'https://aave.com/docs/aave-v3/smart-contracts/pool?language=en#getuseraccountdata',
  aaveOracle: 'https://github.com/aave/aave-v3-core/blob/master/contracts/interfaces/IPriceOracleGetter.sol',
  aavePercentage: 'https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/math/PercentageMath.sol',
  aaveLogic: 'https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/logic/GenericLogic.sol',
  aaveWad: 'https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/math/WadRayMath.sol',
  morphoBlue: 'https://docs.morpho.org/developers/contracts/blue/#position',
  morphoInterface: 'https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol',
});
const baseUnit = { kind: 'oracle_base_units', scale: null, currency: null, references: [SOURCES.aavePool, SOURCES.aaveOracle] };
const percentageUnit = { kind: 'basis_points', scale: '10000', references: [SOURCES.aaveLogic, SOURCES.aavePercentage] };
const schemas = {
  aave_v3_user_account_data: {
    signature: 'getUserAccountData(address)', references: [SOURCES.aavePool],
    fields: [
      { name: 'totalCollateralBase', abiType: 'uint256', bits: 256, unit: baseUnit },
      { name: 'totalDebtBase', abiType: 'uint256', bits: 256, unit: baseUnit },
      { name: 'availableBorrowsBase', abiType: 'uint256', bits: 256, unit: baseUnit },
      { name: 'currentLiquidationThreshold', abiType: 'uint256', bits: 256, unit: percentageUnit },
      { name: 'ltv', abiType: 'uint256', bits: 256, unit: percentageUnit },
      { name: 'healthFactor', abiType: 'uint256', bits: 256, unit: { kind: 'ratio', scale: '1000000000000000000', references: [SOURCES.aaveLogic, SOURCES.aaveWad] } },
    ],
    limitations: [
      'Oracle base currency and its unit have not been queried; no currency conversion is performed.',
      'The healthFactor word, including uint256 maximum, is retained as raw data without a health interpretation.',
    ],
  },
  morpho_blue_position: {
    signature: 'position(bytes32,address)', references: [SOURCES.morphoBlue, SOURCES.morphoInterface],
    fields: [
      { name: 'supplyShares', abiType: 'uint256', bits: 256, unit: { kind: 'supply_shares', scale: null, references: [SOURCES.morphoBlue, SOURCES.morphoInterface] } },
      { name: 'borrowShares', abiType: 'uint128', bits: 128, unit: { kind: 'borrow_shares', scale: null, references: [SOURCES.morphoBlue, SOURCES.morphoInterface] } },
      { name: 'collateral', abiType: 'uint128', bits: 128, unit: { kind: 'collateral_token_raw_units', scale: null, token: null, references: [SOURCES.morphoBlue] } },
    ],
    limitations: [
      'Shares are not converted to assets; market balances, interest accrual and token metadata have not been queried.',
      'The reference getter omits fee-recipient supply shares not yet added by interest accrual.',
    ],
  },
};
const selectors = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind,
  '0x' + Buffer.from(keccak_256(new TextEncoder().encode(schema.signature))).subarray(0, 4).toString('hex')
]));

export class PositionQueryError extends Error {
  constructor(message) { super(message); this.name = 'PositionQueryError'; this.code = 'POSITION_QUERY_INVALID'; }
}
const fail = message => { throw new PositionQueryError(message); };
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('A plain position-query record is required.');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Position-query record has unsupported fields.');
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail('Position-query record is missing required fields.');
}
function address(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail('Position identity requires a 20-byte address.');
  return value.toLowerCase();
}
function chain(value) {
  if (!((Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && value.length <= 78 && /^[1-9][0-9]*$/.test(value)))) fail('Position identity requires a positive exact chain ID.');
  const result = BigInt(value);
  if (result > UINT256_MAX) fail('Position chain ID exceeds uint256.');
  return result.toString();
}
function requestIdentity(request) {
  fields(request, ['kind', 'chainId', 'contract', 'user', 'marketId'], ['kind', 'chainId', 'contract', 'user']);
  if (typeof request.kind !== 'string' || !Object.hasOwn(schemas, request.kind)) fail('Unsupported position-query kind.');
  const result = { kind: request.kind, chainId: chain(request.chainId), contract: address(request.contract), user: address(request.user) };
  if (request.kind === 'morpho_blue_position') {
    if (typeof request.marketId !== 'string' || !WORD.test(request.marketId)) fail('Morpho position requires an explicit 32-byte market ID.');
    result.marketId = request.marketId.toLowerCase();
  } else if (Object.hasOwn(request, 'marketId')) fail('Aave account data does not take a market ID.');
  return result;
}

/** Identity is caller-declared, not discovered or authenticated. Chain ID is
 * normalized to a decimal string. Addresses and market IDs are lowercase;
 * zero addresses/IDs remain valid ABI inputs, not evidence of a real market. */
export function encodePositionQuery(request) {
  const identity = requestIdentity(request), schema = schemas[identity.kind];
  const userWord = identity.user.slice(2).padStart(64, '0');
  return {
    identity,
    query: { to: identity.contract, data: selectors[identity.kind] + (identity.marketId?.slice(2) ?? '') + userWord },
    signature: schema.signature,
    returnBytes: schema.fields.length * 32,
  };
}
function rawValues(encoded, raw) {
  const schema = schemas[encoded.identity.kind];
  if (typeof raw !== 'string' || raw.length !== 2 + encoded.returnBytes * 2 || !/^0x[0-9a-fA-F]+$/.test(raw)) fail('Position result must contain exactly the declared static ABI words.');
  return schema.fields.map((field, index) => {
    const value = BigInt('0x' + raw.slice(2 + index * 64, 2 + (index + 1) * 64));
    if (value >= (1n << BigInt(field.bits))) fail('Position result has noncanonical high bits for its ABI integer type.');
    return value;
  });
}
function common(encoded) {
  const schema = schemas[encoded.identity.kind];
  return {
    basis: 'caller_supplied_ABI_bytes', ...encoded,
    claims: { contractIdentityVerified: false, stateVerified: false, measured: false },
    unitBasis: 'reference_ABI_semantics_not_deployment_attestation',
    references: [...schema.references],
    limitations: [
      'No call success, chain state, contract implementation, query execution or identity provenance is verified by this decoder.',
      ...schema.limitations,
    ],
  };
}
/** Accepts a raw return-data string, never an RPC envelope or an execution
 * result. The integration must establish call success and before/after context. */
export function decodePositionResult(request, raw) {
  const encoded = encodePositionQuery(request), values = rawValues(encoded, raw);
  return {
    status: 'decoded', ...common(encoded),
    fields: schemas[encoded.identity.kind].fields.map((field, index) => ({ name: field.name, abiType: field.abiType, raw: values[index].toString(), unit: structuredClone(field.unit) })),
  };
}
/** Arithmetic differences of supplied words only. Ratios/threshold deltas are
 * not token flows, health assessments, or a proof the two inputs share state. */
export function comparePositionResults(input) {
  fields(input, ['request', 'before', 'after']);
  const encoded = encodePositionQuery(input.request), before = rawValues(encoded, input.before), after = rawValues(encoded, input.after);
  return {
    status: 'decoded_difference', ...common(encoded), deltaBasis: 'raw_integer_subtraction_after_minus_before',
    rows: schemas[encoded.identity.kind].fields.map((field, index) => ({
      name: field.name, abiType: field.abiType,
      beforeRaw: before[index].toString(), afterRaw: after[index].toString(), deltaRaw: (after[index] - before[index]).toString(),
      unit: structuredClone(field.unit),
    })),
  };
}
