import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { simulateUnsignedCall, simulateUnsignedSequence, compileMeasurementQuery } from '../engines/standard-evm/unsigned-call.js';
import { comparePositionResults } from '../engines/standard-evm/position-queries.js';
import { InputError } from './validate.js';
import { RpcError, assertNoProviderErrorResult } from './rpc.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const NUMBER = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
const RESERVED_WITNESS = '0x000000000000000000000000000000000000ba1a';
const MAX_SELECTION_BYTES = 8 * 1024 * 1024;
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

// These examples and role labels are copied from the frozen recorded packet;
// neither example receipts nor expected amounts are inputs to the engine.
export const STANDARD_EXAMPLES = freeze([
  {
    "id": "aave-usdc-supply-with-permit",
    "title": "Aave V3 Ethereum USDC supplyWithPermit",
    "description": "Recorded example at its historical parent block end. This is an unsigned simulation, not replay at the original transaction position.",
    "input": {
      "chainId": 1,
      "from": "0x48c16c5652add27eddb0f896748a35fc60b8d1b4",
      "to": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
      "data": "0x02c205f0000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000ec351bbd00000000000000000000000048c16c5652add27eddb0f896748a35fc60b8d1b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ade28e5000000000000000000000000000000000000000000000000000000000000001c1fc8457fd931323b0d6826fc26886f225497d878c64a89a6910d343460e195607fbaa6d6119003fd9817e7ca4267763e7ce8663807399d427761dd38b3af48f5",
      "value": "0",
      "block": "0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7",
      "queries": [
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a0823100000000000000000000000048c16c5652add27eddb0f896748a35fc60b8d1b4"
        },
        {
          "to": "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
          "data": "0x70a0823100000000000000000000000048c16c5652add27eddb0f896748a35fc60b8d1b4"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a0823100000000000000000000000098c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0xdd62ed3e00000000000000000000000048c16c5652add27eddb0f896748a35fc60b8d1b400000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
        }
      ]
    },
    "queryRoles": [
      {
        "index": 0,
        "label": "Original sender USDC",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0x48c16c5652add27eddb0f896748a35fc60b8d1b4"
      },
      {
        "index": 1,
        "label": "Beneficiary aEthUSDC position",
        "kind": "balanceOf",
        "token": "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
        "account": "0x48c16c5652add27eddb0f896748a35fc60b8d1b4"
      },
      {
        "index": 2,
        "label": "aEthUSDC reserve USDC custody",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"
      },
      {
        "index": 3,
        "label": "Sender allowance to Aave Pool",
        "kind": "allowance",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "owner": "0x48c16c5652add27eddb0f896748a35fc60b8d1b4",
        "spender": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
      }
    ],
    "reference": {
      "originalTransactionHash": "0x6166280a62cdad28e7b8af05ebb622b42b61deff981b3b6cd83dc03b3bb130b2",
      "stateBlockHash": "0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7",
      "blockNumber": "26270482",
      "profile": "historical_parent_block_end",
      "capture": "reports/standard-evm-deposits-v2/capture.json",
      "captureSha256": "149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e"
    }
  },
  {
    "id": "morpho-kiln-usdc-deposit",
    "title": "Kiln mstkeUSDC wrapper deposit into Morpho V1 Steakhouse USDC vault",
    "description": "Recorded example at its historical parent block end. This is an unsigned simulation, not replay at the original transaction position.",
    "input": {
      "chainId": 1,
      "from": "0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668",
      "to": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b",
      "data": "0x6e553f65000000000000000000000000000000000000000000000000000000517da02c0000000000000000000000000044c3a96181af9e295ce8e188fa8fcdd72d1eb668",
      "value": "0",
      "block": "0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61",
      "queries": [
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a0823100000000000000000000000044c3a96181af9e295ce8e188fa8fcdd72d1eb668"
        },
        {
          "to": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b",
          "data": "0x70a0823100000000000000000000000044c3a96181af9e295ce8e188fa8fcdd72d1eb668"
        },
        {
          "to": "0xbeef01735c132ada46aa9aa4c54623caa92a64cb",
          "data": "0x70a08231000000000000000000000000334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a08231000000000000000000000000334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a08231000000000000000000000000beef01735c132ada46aa9aa4c54623caa92a64cb"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0x70a08231000000000000000000000000bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0xdd62ed3e00000000000000000000000044c3a96181af9e295ce8e188fa8fcdd72d1eb668000000000000000000000000334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
        },
        {
          "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "data": "0xdd62ed3e000000000000000000000000334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b000000000000000000000000beef01735c132ada46aa9aa4c54623caa92a64cb"
        }
      ]
    },
    "queryRoles": [
      {
        "index": 0,
        "label": "Original sender USDC",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668"
      },
      {
        "index": 1,
        "label": "Beneficiary mstkeUSDC wrapper shares",
        "kind": "balanceOf",
        "token": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b",
        "account": "0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668"
      },
      {
        "index": 2,
        "label": "Wrapper-owned steakUSDC vault shares",
        "kind": "balanceOf",
        "token": "0xbeef01735c132ada46aa9aa4c54623caa92a64cb",
        "account": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
      },
      {
        "index": 3,
        "label": "Wrapper USDC custody",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
      },
      {
        "index": 4,
        "label": "Inner vault USDC custody",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0xbeef01735c132ada46aa9aa4c54623caa92a64cb"
      },
      {
        "index": 5,
        "label": "Morpho Blue USDC custody",
        "kind": "balanceOf",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "account": "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
      },
      {
        "index": 6,
        "label": "Sender allowance to wrapper",
        "kind": "allowance",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "owner": "0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668",
        "spender": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b"
      },
      {
        "index": 7,
        "label": "Wrapper allowance to inner vault",
        "kind": "allowance",
        "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "owner": "0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b",
        "spender": "0xbeef01735c132ada46aa9aa4c54623caa92a64cb"
      }
    ],
    "reference": {
      "originalTransactionHash": "0xc46259d8064831c47c68776ca0611af75337adf8c4aee4bee5add0878b8873a7",
      "stateBlockHash": "0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61",
      "blockNumber": "26270562",
      "profile": "historical_parent_block_end",
      "capture": "reports/standard-evm-deposits-v2/capture.json",
      "captureSha256": "149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e"
    }
  }
]);

export const STANDARD_CAPABILITIES = freeze({
  chainId: 1, name: 'Ethereum', status: 'experimental',
  operation: 'unsigned_call_with_token_position_and_native_measurements',
  querySelection: ['automatic_from_observed_trace', 'explicit'],
  blockSelection: ['latest', 'canonical_hex_number', 'block_hash'],
  queryTypes: ['balanceOf', 'allowance', 'aave_v3_user_account_data', 'morpho_blue_position'],
  positionSelection: 'explicit_only',
  limits: { queries: 8, nativeAccounts: 8, calldataBytes: 32768, gas: 5000000, engineRpcCalls: 64, blockSelectionRpcCalls: 1, totalRpcCalls: 65 },
  profile: 'unsigned_unpriced_block_end',
  limitations: [
    'Explicit queried accounts only; other assets and economic effects may be omitted.',
    'Synthetic BASEFEE-zero execution with no outer transaction signature or fee-settlement validation. Contract permit checks still execute.',
    'Native balance measurements exclude outer transaction fees; observed value-flow candidates are not measured balance changes.',
    'Historical block-end state is not the original transaction position.',
    'Token labels and decimals are historical reference metadata, not verified again for the requested state.',
    'Provider codeHash consistency is not independent state or source-code attestation.',
    'Position queries use declared contract, user and market identities. Raw fields do not establish deployment identity, asset value or account health.',
    'No security verdict or comparative detection score is produced.',
  ],
});

export const STANDARD_SEQUENCE_CAPABILITIES = freeze({
  available: true, chainId: 1, status: 'experimental', minCalls: 2, maxCalls: 4,
  profile: 'unsigned_unpriced_sequence', sameSender: true, sameBlock: true,
  atomic: false, stopsOnFailure: true, fees: 'excluded',
  limits: { queriesPerCall: 8, nativeAccountsPerCall: 8, calldataBytesPerCall: 32768, gasPerCall: 5000000,
    engineRpcCalls: 257, blockSelectionRpcCalls: 1, totalRpcCalls: 258, wallMs: 265000, totalBytes: 128 * 1024 * 1024 },
  limitations: [
    'Each call starts from the validated state left by the preceding successful call, at the same block time.',
    'These are separate unsigned calls, not an atomic bundle or a guarantee of transaction inclusion.',
    'A failed call stops later calls; a verified earlier prefix is not rolled back.',
    'Outer signatures and transaction fees are not modeled. Contract permit checks still execute.',
    'Per-call token and native queries are bounded and do not establish complete economic effects or a security verdict.',
  ],
});
export const STANDARD_SEQUENCE_EXAMPLES = freeze([{
  id: 'aave-usdc-approve-then-supply', title: 'Approve USDC, then supply to Aave V3',
  description: 'Constructed unsigned example at a historical block end. The approval feeds the following supply; this is not an original historical transaction pair.',
  input: { chainId: 1, from: STANDARD_EXAMPLES[0].input.from, block: STANDARD_EXAMPLES[0].input.block, calls: [
    { to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      data: '0x095ea7b300000000000000000000000087870bca3f3fd6335c3f4ce8392d69350b4fa4e200000000000000000000000000000000000000000000000000000000ec351bbd',
      value: '0', queries: [STANDARD_EXAMPLES[0].input.queries[3]] },
    { to: STANDARD_EXAMPLES[0].input.to,
      data: '0x617ba037000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000ec351bbd00000000000000000000000048c16c5652add27eddb0f896748a35fc60b8d1b40000000000000000000000000000000000000000000000000000000000000000',
      value: '0', queries: STANDARD_EXAMPLES[0].input.queries },
  ] },
  reference: { profile: 'constructed_sequence_at_historical_block_end', stateBlockHash: STANDARD_EXAMPLES[0].input.block,
    originalTransactionHash: STANDARD_EXAMPLES[0].reference.originalTransactionHash,
    originalOperation: 'supplyWithPermit', syntheticUnsignedSequence: true, exactHistoricalReplay: false,
    derivation: 'The supply keeps the first four ABI arguments from supplyWithPermit. A separate approval is prepended; its permit suffix is not reused.',
    capture: 'reports/standard-evm-sequence-discovery/continuation/capture.json', captureSha256: 'ae31c207aa98e1172cf8112211d981c3abbda559622f74c18af84db72b7443e6' },
}]);

const AAVE_PARENT = '0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7';
const MORPHO_PARENT = '0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61';
function referenceMetadata(symbol, name, decimals, blockHash, blockNumber, records) {
  return { symbol, name, decimals, referenceBlockHash: blockHash, referenceBlockNumber: blockNumber, verifiedForSimulation: false,
    provenance: { kind: 'historical_reference', selection: 'reports/standard-evm-discovery/selected.json', selectionSha256: '4c97e73db7a3884ad08bfa016d5ec35a7903a6c40d544a27ca03af4ccd484bb9', records,
      description: 'Labels and decimals come from the recorded discovery reference; they are not queried or attested for this simulation.' } };
}
const METADATA = freeze({
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': referenceMetadata('USDC', null, 6, AAVE_PARENT, '26270482', ['reports/standard-evm-discovery/raw/031.json']),
  '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c': referenceMetadata('aEthUSDC', 'Aave Ethereum USDC', 6, AAVE_PARENT, '26270482', ['reports/standard-evm-discovery/raw/033.json', 'reports/standard-evm-discovery/raw/034.json', 'reports/standard-evm-discovery/raw/035.json']),
  '0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b': referenceMetadata('mstkeUSDC', 'Yield Bearing Steakhouse Morpho USDC', 6, MORPHO_PARENT, '26270562', ['reports/standard-evm-discovery/raw/037.json', 'reports/standard-evm-discovery/raw/038.json', 'reports/standard-evm-discovery/raw/039.json']),
  '0xbeef01735c132ada46aa9aa4c54623caa92a64cb': referenceMetadata('steakUSDC', 'Steakhouse USDC', 18, MORPHO_PARENT, '26270562', ['reports/standard-evm-discovery/raw/041.json', 'reports/standard-evm-discovery/raw/042.json', 'reports/standard-evm-discovery/raw/043.json']),
});

function fields(value, allowed, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError(`${description} must be a JSON object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new InputError(`Unsupported ${description} field.`);
  }
}
function address(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new InputError(`${name} must be a 20-byte hex address.`);
  return value.toLowerCase();
}

/** Only declarative call inputs are accepted. Provider URLs, state overrides,
 * metadata, gas/fees and transaction-signing fields cannot enter this API. */
export function validateStandardSimulation(input) {
  fields(input, ['chainId', 'from', 'to', 'data', 'value', 'block', 'queries'], 'request');
  if (input.chainId !== 1 && input.chainId !== '1') throw new InputError('Only Ethereum chain 1 is supported by this endpoint.', 'UNSUPPORTED_CHAIN');
  const from = address(input.from, 'from'), to = address(input.to, 'to');
  if (typeof input.data !== 'string' || !DATA.test(input.data) || input.data.length > 65538) throw new InputError('data must be even-length hexadecimal calldata of at most 32 KiB.');
  const value = input.value === undefined ? '0' : input.value;
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > UINT256_MAX) throw new InputError('value must be a canonical decimal uint256 wei string.');
  const block = input.block === undefined ? 'latest' : input.block;
  if (typeof block !== 'string' || !(block === 'latest' || NUMBER.test(block) || HASH.test(block))) throw new InputError('block must be latest, a canonical hexadecimal block number, or a 32-byte block hash.');
  if (!Object.hasOwn(input, 'queries')) return { chainId: 1, from, to, data: input.data.toLowerCase(), value, block: block.toLowerCase() };
  if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 8) throw new InputError('Omit queries for automatic token selection, or supply between one and eight explicit token or position queries.');
  const seen = new Set(), queries = [];
  for (const query of input.queries) {
    fields(query, ['to', 'data', 'kind', 'contract', 'user', 'marketId'], 'query');
    let compiled;
    try { compiled = compileMeasurementQuery(query, 1); }
    catch { throw new InputError('Each query must be a canonical token call or a typed Aave account-data or Morpho Blue position declaration.'); }
    const key = compiled.query.to + compiled.query.data;
    if (seen.has(key)) throw new InputError('Duplicate queries are not supported.');
    if (compiled.query.to === RESERVED_WITNESS) throw new InputError('Query target overlaps the reserved execution witness.');
    seen.add(key); queries.push(compiled.descriptor);
  }
  return { chainId: 1, from, to, data: input.data.toLowerCase(), value, block: block.toLowerCase(), queries };
}

export function validateStandardSequence(input) {
  fields(input, ['chainId', 'from', 'block', 'calls'], 'sequence request');
  if (!Array.isArray(input.calls) || input.calls.length < 2 || input.calls.length > 4) throw new InputError('A sequence requires between two and four calls.');
  let shared;
  const calls = Array.from(input.calls, call => {
    fields(call, ['to', 'data', 'value', 'queries'], 'sequence call');
    const normalized = validateStandardSimulation({ ...call, chainId: input.chainId, from: input.from, ...(Object.hasOwn(input, 'block') ? { block: input.block } : {}) });
    if (normalized.from === RESERVED_WITNESS || normalized.to === RESERVED_WITNESS || normalized.queries?.some(query => compileMeasurementQuery(query, normalized.chainId).query.to === RESERVED_WITNESS)) throw new InputError('Sequence inputs overlap the reserved execution witness.');
    const { chainId, from, block, ...step } = normalized;
    shared = { chainId, from, block };
    return step;
  });
  return { ...shared, calls };
}

function format(raw, decimals) {
  const value = BigInt(raw), negative = value < 0n, absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals), fraction = (absolute % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / base}${fraction ? '.' + fraction : ''}`;
}
function queryIdentity(query, sender) {
  const first = '0x' + query.data.slice(34, 74);
  const identity = query.data.startsWith('0x70a08231')
    ? { kind: 'balanceOf', token: query.to, account: first }
    : { kind: 'allowance', token: query.to, owner: first, spender: '0x' + query.data.slice(98, 138) };
  return { ...identity, accountIsSender: first === sender };
}
function nativePreview(input, result) {
  // Candidate netValueRaw describes traced value flows. Display amounts only
  // from the separately validated native measurement records.
  return (result.nativeEffects?.measurements ?? []).map((measurement, index) => {
    const entry = { index, account: measurement.account, accountIsSender: measurement.account === input.from,
      metadata: { symbol: 'ETH', name: 'Ether', decimals: 18, chainId: 1, type: 'native' }, status: measurement.status };
    for (const key of ['reason', 'basis', 'anchorEvidenceId', 'queryEvidence', 'startingBalance']) if (measurement[key] !== undefined) entry[key] = structuredClone(measurement[key]);
    if (measurement.status === 'measured') {
      const validAmount = raw => typeof raw === 'string' && DECIMAL.test(raw) && BigInt(raw) <= UINT256_MAX;
      if (typeof measurement.account !== 'string' || !ADDRESS.test(measurement.account)
        || !validAmount(measurement.beforeRaw) || !validAmount(measurement.afterRaw)
        || typeof measurement.deltaRaw !== 'string' || !/^(?:0|-?[1-9][0-9]{0,77})$/.test(measurement.deltaRaw)
        || BigInt(measurement.deltaRaw) !== BigInt(measurement.afterRaw) - BigInt(measurement.beforeRaw)) {
        return { ...entry, status: 'unavailable', reason: 'The native balance measurement is malformed or inconsistent.' };
      }
      for (const key of ['before', 'after', 'delta']) { entry[key + 'Raw'] = measurement[key + 'Raw']; entry[key] = format(measurement[key + 'Raw'], 18); }
    }
    return entry;
  });
}
function positionPreview(input, descriptor, measurement, index, result) {
  const compiled = compileMeasurementQuery(descriptor, input.chainId);
  const { identity, signature, returnBytes } = compiled.position;
  const entry = { index, ...identity, userIsSender: identity.user === input.from,
    signature, returnBytes, query: compiled.query, contractIdentityVerified: false,
    status: measurement?.status ?? 'unavailable' };
  if (!measurement || !isDeepStrictEqual(measurement.query, compiled.query) || !isDeepStrictEqual(measurement.position, compiled.position)) {
    return { ...entry, status: 'unavailable', reason: 'The measurement does not match the declared position query.' };
  }
  if (measurement.reason) entry.reason = measurement.reason;
  if (measurement.status !== 'measured') return entry;
  try {
    if (result.canonicalStatus !== 'verified' || result.execution?.status !== 'success'
      || measurement.contractIdentityVerified !== false
      || measurement.basis !== 'isolated_traced_ABI_queries_with_nonce_only_effects') throw new Error();
    const decoded = comparePositionResults({ request: identity, before: measurement.beforeReturnData, after: measurement.afterReturnData });
    if (!isDeepStrictEqual(measurement.rows, decoded.rows)) throw new Error();
    Object.assign(entry, { rows: structuredClone(decoded.rows), basis: measurement.basis,
      queryEvidence: structuredClone(measurement.queryEvidence ?? []),
      unitBasis: decoded.unitBasis, references: decoded.references,
      limitations: decoded.limitations.slice(1) });
  } catch {
    return { ...entry, status: 'unavailable', reason: 'The position measurement is malformed, inconsistent or has unverified execution context.' };
  }
  return entry;
}

export function projectStandardPreview(input, result) {
  const automatic = input.queries === undefined;
  const queries = automatic ? result.request?.queries ?? [] : input.queries;
  const warnings = [...STANDARD_CAPABILITIES.limitations];
  if (automatic) warnings[0] = 'Queries selected from bounded observed token calls and events only; silent, ambiguous, unselected and other economic effects may be omitted.';
  const positions = [];
  const tokenRows = queries.map((query, index) => {
    const measurement = result.measurements[index];
    if (query.kind !== undefined) { positions.push(positionPreview(input, query, measurement, index, result)); return null; }
    const metadata = METADATA[query.to] ? structuredClone(METADATA[query.to]) : null;
    const entry = { index, ...queryIdentity(query, input.from), metadata, status: measurement?.status ?? 'unavailable' };
    if (!measurement || measurement.query?.to !== query.to || measurement.query?.data !== query.data) return { ...entry, status: 'unavailable', reason: 'The measurement does not match the requested token query.' };
    if (measurement?.reason) entry.reason = measurement.reason;
    if (measurement?.status === 'measured') {
      for (const key of ['before', 'after', 'delta']) {
        entry[key + 'Raw'] = measurement[key + 'Raw'];
        if (metadata) entry[key] = format(measurement[key + 'Raw'], metadata.decimals);
      }
    }
    return entry;
  }).filter(Boolean);
  return { scope: automatic ? 'observed_queried_accounts' : 'explicit_queried_accounts', warnings,
    nativeBalances: nativePreview(input, result), queries: tokenRows, ...(positions.length ? { positions } : {}) };
}

/** rpc is supplied by the server's bounded fixed-provider transport. Hash
 * selections add no RPC; latest/numeric selections add exactly one request. */
async function selectBlock(apiRequest, rpc) {
  let blockHash = apiRequest.block;
  const blockSelection = { requested: apiRequest.block, kind: 'pinned_hash', resolvedHash: blockHash, resolvedNumber: null, evidence: null };
  if (!HASH.test(blockHash)) {
    const method = 'eth_getBlockByNumber', params = [apiRequest.block, false];
    let header;
    try {
      const raw = await rpc.call(method, params);
      assertNoProviderErrorResult(method, raw);
      const serialized = JSON.stringify(raw);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_SELECTION_BYTES) throw new Error();
      header = JSON.parse(serialized);
    } catch { throw new RpcError('Unable to resolve a bounded pinned block for the Ethereum simulation.', 'STANDARD_BLOCK_UNAVAILABLE'); }
    if (!header || typeof header !== 'object' || Array.isArray(header) || typeof header.hash !== 'string' || !HASH.test(header.hash) || typeof header.number !== 'string' || !NUMBER.test(header.number)) throw new RpcError('The selected Ethereum block header is unavailable or malformed.', 'STANDARD_BLOCK_INVALID');
    if (apiRequest.block !== 'latest' && BigInt(apiRequest.block) !== BigInt(header.number)) throw new RpcError('Provider returned a different Ethereum block number than requested.', 'STANDARD_BLOCK_MISMATCH');
    blockHash = header.hash.toLowerCase();
    Object.assign(blockSelection, { kind: apiRequest.block === 'latest' ? 'resolved_latest' : 'resolved_number', resolvedHash: blockHash, resolvedNumber: BigInt(header.number).toString(), evidence: { method, params, result: header } });
  }
  return { blockHash, blockSelection };
}
function assertSelectedBlock(result, blockHash, blockSelection) {
  if (result.block && (result.block.hash !== blockHash || (blockSelection.resolvedNumber !== null && result.block.number !== blockSelection.resolvedNumber))) {
    throw new RpcError('The execution header differs from the selected Ethereum block identity.', 'STANDARD_BLOCK_MISMATCH');
  }
  if (result.block && blockSelection.evidence) {
    const fetched = result.evidence.find(entry => entry.method === 'eth_getBlockByHash'
      && isDeepStrictEqual(entry.params, [blockHash, false]));
    if (!fetched || !isDeepStrictEqual(blockSelection.evidence.result, fetched.result)) {
      throw new RpcError('The complete execution header differs from the selected Ethereum block header.', 'STANDARD_BLOCK_MISMATCH');
    }
  }
}
function engineRequest(input) {
  return { from: input.from, to: input.to, data: input.data, value: '0x' + BigInt(input.value).toString(16), gas: '0x4c4b40' };
}
function duration(start, rpcStart, rpc) {
  const timing = { totalMs: performance.now() - start };
  if (rpcStart !== null && Number.isFinite(rpc.rpcMs)) timing.rpcMs = Math.max(0, rpc.rpcMs - rpcStart);
  return timing;
}
export async function simulateStandard(input, rpc) {
  const start = performance.now(), rpcStart = Number.isFinite(rpc?.rpcMs) ? rpc.rpcMs : null;
  const apiRequest = validateStandardSimulation(input);
  const { blockHash, blockSelection } = await selectBlock(apiRequest, rpc);
  const result = await simulateUnsignedCall({ rpc, chainId: apiRequest.chainId, blockHash, request: engineRequest(apiRequest), queries: apiRequest.queries });
  assertSelectedBlock(result, blockHash, blockSelection);
  return { ...result, id: randomUUID(), createdAt: new Date().toISOString(), apiRequest,
    source: { kind: 'standard_evm_unsigned_call', profile: 'unsigned_unpriced_block_end', blockSelection },
    preview: projectStandardPreview(apiRequest, result), timing: duration(start, rpcStart, rpc) };
}

export async function simulateStandardSequence(input, rpc) {
  const start = performance.now(), rpcStart = Number.isFinite(rpc?.rpcMs) ? rpc.rpcMs : null;
  const apiRequest = validateStandardSequence(input);
  const { blockHash, blockSelection } = await selectBlock(apiRequest, rpc);
  const result = await simulateUnsignedSequence({ rpc, chainId: apiRequest.chainId, blockHash,
    calls: apiRequest.calls.map(call => ({ request: engineRequest({ ...call, from: apiRequest.from }), ...(call.queries === undefined ? {} : { queries: call.queries }) })) });
  // The engine's final shared-state validation has finished before any display
  // projection. Failed canonical validation has already removed all amounts.
  for (const step of result.steps) if (step.result) assertSelectedBlock(step.result, blockHash, blockSelection);
  const id = randomUUID(), createdAt = new Date().toISOString();
  return { ...result, id, createdAt, apiRequest,
    source: { kind: 'standard_evm_unsigned_sequence', profile: 'unsigned_unpriced_sequence', blockSelection },
    steps: result.steps.map(step => {
      const call = apiRequest.calls[step.index];
      const normalized = { chainId: apiRequest.chainId, from: apiRequest.from, ...call, block: apiRequest.block };
      return { ...step, input: structuredClone(call), ...(step.result ? { result: { ...step.result,
        apiRequest: normalized,
        source: { kind: 'standard_evm_unsigned_call', profile: step.stateSource.kind === 'initial_block' ? 'unsigned_unpriced_block_end' : 'unsigned_unpriced_after_prior_calls',
          blockSelection: structuredClone(blockSelection), stateSource: structuredClone(step.stateSource) },
        preview: projectStandardPreview(normalized, step.result),
      } } : {}) };
    }), timing: duration(start, rpcStart, rpc) };
}
