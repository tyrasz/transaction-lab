// Pure fixed-input amendment. No filesystem, transport, execution or state lookup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const FUNDED_PROFILE = 'selected_100_usdc_v1';
// Archived for audit provenance only. Derivation never reads these files.
export const FUNDED_PROVENANCE_FILES = Object.freeze([
  { path: 'reports/standard-evm-positions-v3/aave-approval-position-sequence-response.json', bytes: 852108, sha256: '3aa4be56a2f97ef115b2dd2f90e158e57442be39808ef3503d38391a957c41af' },
  { path: 'reports/standard-evm-discovery/raw/028.body', bytes: 382510, sha256: '1fb51175d15fe55c0bf13e446cb079bc4af84302c7356684fca573a093209870' },
  { path: 'reports/standard-evm-discovery/raw/028.json', bytes: 1792, sha256: '2f436f5d4c8125c2c9582d9bab508976e4c9e041cbaad9b07b2db4f7fed6f8e4' },
  { path: 'reports/standard-evm-deposits-v2/plan.json', bytes: 31120, sha256: 'd458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f' },
  { path: 'reports/standard-evm-positions-v3/plan.json', bytes: 48296, sha256: '5f08851552e8210ab8ad88493feb40f11de46d64b18207b87880d21811e04c86' },
  { path: 'reports/ethereum-lending-local-reference/plan.json', bytes: 449126, sha256: 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288' },
  { path: 'reports/standard-evm-discovery/raw/027.body', bytes: 8820, sha256: 'e335351dc80f49372b08d1870528963e34cb55a7956d876b47835a0770ed8501' },
  { path: 'reports/standard-evm-discovery/raw/027.json', bytes: 1774, sha256: 'c55fbe2799e282c7df55d0dcc3a73e6ee2823ce587fe9d6071234eccd9fbf9ab' },
  { path: 'research/lending-local-sequence-current-v037/capture/local/002/report.json', bytes: 15121636, sha256: '85410cd1267711f4d11937672fc63cf1629e20de46666923617a219d5927d2e2' },
].map(Object.freeze));
const S = '0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668';
const OLD_AAVE = '0x48c16c5652add27eddb0f896748a35fc60b8d1b4';
const U = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const P = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const A = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const K = '0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b';
const V = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
const B = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const MARKET = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
const OLD_IDS = ['aave-usdc-approve-supply-withdraw-half', 'morpho-kiln-usdc-approve-deposit-withdraw-half'];
const NEW_IDS = ['aave-usdc-selected-100-supply-50-withdraw', 'kiln-usdc-selected-100-deposit-50-withdraw'];
const BASES = [
  { path: 'research/lending-local-sequence-v037/capture/inputs/001.json', sha256: 'c50936237fed1d59740521b1928f2a4bef74e496ec308f5f65d02281164e3f5c',
    canonicalJsonSha256: 'fa435e96301c62b70f239c2029ad3c0f57d2bf9f54a3fc6c31264824f6310a7d' },
  { path: 'research/lending-local-sequence-v037/capture/inputs/002.json', sha256: '3b09b2898f5b5c7b1d9f758b793f5e6f3246ca0f241cc20b71cc89637171737c',
    canonicalJsonSha256: 'd2f451ad675983f3669af5b55b193d72b68e5b59ef01a91ea34ec30472a119d4' },
];
const copy = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const word = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)
  ? value.slice(2).padStart(64, '0') : BigInt(value).toString(16).padStart(64, '0');
const data = (selector, values) => selector + values.map(word).join('');
const balance = (token, owner) => ({ to: token, data: data('0x70a08231', [owner]) });
const allowance = (owner, spender) => ({ to: U, data: data('0xdd62ed3e', [owner, spender]) });
const abiRef = source => Object.fromEntries(Object.entries(source).filter(([key]) => ['path', 'sha256', 'pointer'].includes(key)));

// The caller pins raw bytes; this second, order-independent value pin prevents
// accidental use of selected-header cases, extra facts, or amended templates.
function canonicalJson(value) {
  let nodes = 0;
  function visit(v, depth) {
    assert(++nodes <= 20000 && depth <= 32, 'Base input exceeds structural bounds');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { assert(v.length <= 2 * 1024 * 1024); return v; }
    if (typeof v === 'number') { assert(Number.isSafeInteger(v)); return v; }
    assert(v && typeof v === 'object', 'Base input must contain JSON values only');
    assert(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null || Array.isArray(v));
    const descriptors = Object.getOwnPropertyDescriptors(v);
    assert.equal(Object.getOwnPropertySymbols(v).length, 0);
    for (const [key, desc] of Object.entries(descriptors)) if (!(Array.isArray(v) && key === 'length')) {
      assert('value' in desc && desc.enumerable, 'Base input accessors/hidden fields are forbidden');
    }
    if (Array.isArray(v)) {
      assert.deepEqual(Object.keys(v), Array.from({ length: v.length }, (_, index) => String(index)));
      return v.map(item => visit(item, depth + 1));
    }
    return Object.fromEntries(Object.keys(v).sort().map(key => [key, visit(v[key], depth + 1)]));
  }
  const serialized = JSON.stringify(visit(value, 0));
  assert(Buffer.byteLength(serialized) <= 2 * 1024 * 1024);
  return serialized;
}

function queries(index, sender) {
  return index === 0 ? [balance(U, sender), balance(A, sender), balance(U, A), allowance(sender, P),
    { kind: 'aave_v3_user_account_data', contract: P, user: sender }]
    : [balance(U, sender), balance(K, sender), balance(V, K), balance(U, K), balance(U, V), balance(U, B), allowance(sender, K),
      { kind: 'morpho_blue_position', contract: B, user: V, marketId: MARKET }];
}
function callSpecs(index, sender, deposit, withdraw) {
  return index === 0 ? [
    ['approve', 'approve(address,uint256)', U, '0x095ea7b3', [P, deposit]],
    ['supply', 'supply(address,uint256,address,uint16)', P, '0x617ba037', [U, deposit, sender, 0]],
    ['withdraw', 'withdraw(address,uint256,address)', P, '0x69328dec', [U, withdraw, sender]],
  ] : [
    ['approve', 'approve(address,uint256)', U, '0x095ea7b3', [K, deposit]],
    ['deposit', 'deposit(uint256,address)', K, '0x6e553f65', [deposit, sender]],
    ['withdraw', 'withdraw(uint256,address,address)', K, '0xb460af94', [withdraw, sender, sender]],
  ];
}
function assertBase(c, index) {
  const sender = index === 0 ? OLD_AAVE : S, deposit = index === 0 ? '3962903485' : '350000000000';
  const withdraw = index === 0 ? '1981451742' : '175000000000';
  assert.equal(c.id, OLD_IDS[index]); assert.equal(c.chainId, 1); assert.equal(c.from, sender);
  assert.equal(c.amounts.depositRaw, deposit); assert.equal(c.amounts.withdrawRaw, withdraw); assert.equal(c.amounts.decimals, 6);
  assert.equal(c.localInput.from, sender); assert.equal(c.providerInput.from, sender);
  assert.equal(c.localInput.block, c.header.hash); assert.equal(c.providerInput.block, c.header.hash);
  const q = queries(index, sender), specs = callSpecs(index, sender, deposit, withdraw);
  assert.deepEqual(c.localInput.queries, q); assert.deepEqual(c.queryRoles.map(row => row.descriptor), q);
  assert.equal(c.localInput.calls.length, 3); assert.equal(c.providerInput.calls.length, 3); assert.equal(c.steps.length, 3);
  specs.forEach(([operation, signature, to, selector, values], i) => {
    const request = { to, data: data(selector, values), value: '0' };
    assert.deepEqual(c.localInput.calls[i], { ...request, gas: '5000000' });
    assert.deepEqual(c.providerInput.calls[i], { ...request, queries: q });
    assert.equal(c.steps[i].operation, operation); assert.equal(c.steps[i].signature, signature);
    assert.equal(c.steps[i].selector, selector); assert.deepEqual(c.steps[i].request, request);
  });
}

export function deriveFundedTemplates(baseCases) {
  assert(Array.isArray(baseCases) && baseCases.length === 2, 'Exactly two original base cases are required');
  // Validate descriptors before reading any caller-provided fields.
  canonicalJson(baseCases);
  baseCases.forEach((c, i) => {
    assert.equal(sha(canonicalJson(c)), BASES[i].canonicalJsonSha256, 'Original base case JSON differs');
    assertBase(c, i);
  });
  const cases = baseCases.map((base, index) => {
    const c = copy(base), q = queries(index, S), specs = callSpecs(index, S, '100000000', '50000000');
    c.id = NEW_IDS[index]; c.from = S;
    c.amounts = { depositRaw: '100000000', withdrawRaw: '50000000', decimals: 6,
      withdrawRule: 'fixed 50000000 raw underlying USDC assets; not receipt, wrapper or inner-vault shares' };
    const calls = specs.map(([, , to, selector, values]) => ({ to, data: data(selector, values), value: '0' }));
    c.localInput = { chainId: 1, from: S, block: base.header.hash, calls: calls.map(call => ({ ...call, gas: '5000000' })), queries: copy(q) };
    c.providerInput = { chainId: 1, from: S, block: base.header.hash, calls: calls.map(call => ({ ...call, queries: copy(q) })) };
    c.steps = specs.map(([operation, signature, , selector], i) => ({ index: i, operation, signature, selector,
      request: copy(calls[i]), previouslyCaptured: false, construction: FUNDED_PROFILE,
      provenance: [{ ...BASES[index], pointer: `/steps/${i}`, purpose: 'historical_input_shape_only' }],
      abiProvenance: base.steps[i].provenance.map(abiRef) }));
    c.queryRoles = base.queryRoles.map((role, i) => ({ ...copy(role), descriptor: copy(q[i]),
      subject: { ...copy(role.subject), ...(index === 0 && [0, 1, 3, 4].includes(i) ? { account: S } : {}) },
      label: role.label.replace('Original sender', 'Selected sender'),
      provenance: [{ ...BASES[index], pointer: `/queryRoles/${i}`, purpose: 'historical_query_schema_only' }],
      abiProvenance: role.provenance.map(abiRef) }));
    c.provenance = { profile: FUNDED_PROFILE, baseTemplate: { ...BASES[index], caseId: base.id },
      selectedSequenceIsOriginalHistory: false, newlyConstructedCalls: true, abiAndQuerySourcesAreHistorical: true,
      templateHeaderIsHistorical: true, freshHeaderSelectionRequiredForExecution: true, priorResultsInstalledAsState: false };
    c.limitations = [
      'Deliberately selected smaller calls after earlier insufficient-balance reverts; not a representative accuracy sample.',
      'Sender funding and code were observed only at an earlier header; no current funding or successful outcome is assumed.',
      'All originals are unsigned and unpriced; no transaction broadcast, funding or allowance override.',
      'Both sequences independently start at one newly selected header; only originals within each sequence carry state.',
      'Approval necessity and attribution of withdrawal to newly minted shares are not established.',
      'Withdrawals depend on actual liquidity, collateral, fees and protocol restrictions; share conversion is not precomputed.',
      ...(index === 1 ? ['Kiln is the outer wrapper; the Blue query belongs to its inner vault, not the sender.',
        'The eight queries omit wrapper-to-vault allowance, fee-recipient/self shares, other Blue markets and debt positions.'] : []),
    ];
    return c;
  });
  // Exact top-level replacements preserve all unlisted fields, including the old
  // headers which the caller must replace only after fresh-header selection.
  const fields = ['id', 'from', 'amounts', 'localInput', 'providerInput', 'steps', 'queryRoles', 'provenance', 'limitations'];
  const changes = cases.flatMap((c, index) => fields.filter(field => JSON.stringify(c[field]) !== JSON.stringify(baseCases[index][field]))
    .map(field => ({ op: 'replace', path: `/cases/${index}/${field}`, before: copy(baseCases[index][field]), after: copy(c[field]) })));
  return { profile: FUNDED_PROFILE, amendment: { schemaVersion: 1, kind: 'fixed_input_amendment', profile: FUNDED_PROFILE,
    baseCaseIds: [...OLD_IDS], newCaseIds: [...NEW_IDS], sender: S, depositRaw: '100000000', withdrawRaw: '50000000', decimals: 6,
    baseTemplateProvenance: copy(BASES), changes,
    selectionRationale: { kind: 'previous_observation_only', sourcePath: 'research/lending-local-sequence-current-v037/capture/local/002/report.json',
      sourceSha256: '85410cd1267711f4d11937672fc63cf1629e20de46666923617a219d5927d2e2',
      pointers: ['/report/steps/0/measurements/0/values/0/beforeRaw', '/report/attempt/sequence/inputEvidence/0/result/codeHash'] },
    scope: { selectionInformedByPriorObservation: true, newConstructedInputs: true, freshHeaderRequired: true,
      expectedPoststateConsumed: false, priorResultsInstalledAsState: false, fundingOrAllowanceOverrides: false,
      representativeAccuracyClaimed: false, independentInitialStatePerSequence: true } }, cases };
}
