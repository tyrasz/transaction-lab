// Input-only preparation. Loading this module performs no I/O. Calling the
// exported loader reads hash-bound saved files and encodes ABI words; it never
// creates a transport, executes an EVM, signs a transaction, or writes a file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const clone = value => structuredClone(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const keccak = bytes => '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
const selector = signature => keccak(Buffer.from(signature)).slice(0, 10);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const GAS = '5000000';

export const SOURCE_FILES = freeze([
  { id: 'positionsPlan', path: 'reports/standard-evm-positions-v3/plan.json', bytes: 48296, sha256: '5f08851552e8210ab8ad88493feb40f11de46d64b18207b87880d21811e04c86' },
  { id: 'aaveSequence', path: 'reports/standard-evm-positions-v3/aave-approval-position-sequence-response.json', bytes: 852108, sha256: '3aa4be56a2f97ef115b2dd2f90e158e57442be39808ef3503d38391a957c41af' },
  { id: 'lendingPlan', path: 'reports/ethereum-lending-local-reference/plan.json', bytes: 449126, sha256: 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288' },
  { id: 'aaveParent', path: 'reports/ethereum-lending-local-reference/inputs/aave-parent.json', bytes: 26692, sha256: 'e07dce6ae8d184dac5a8fe4739034d30535b0283e96f655ca248bca99302cda9' },
  { id: 'morphoParent', path: 'reports/ethereum-lending-local-reference/inputs/morpho-parent.json', bytes: 28704, sha256: '6abaf67305776d021e27544f63de446c79b6e779e21d6bcf8e77dbe0bd3541c4' },
  { id: 'depositPlan', path: 'reports/standard-evm-deposits-v2/plan.json', bytes: 31120, sha256: 'd458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f' },
  { id: 'aaveDocsMetadata', path: 'reports/standard-evm-discovery/raw/028.json', bytes: 1792, sha256: '2f436f5d4c8125c2c9582d9bab508976e4c9e041cbaad9b07b2db4f7fed6f8e4' },
  { id: 'aaveDocs', path: 'reports/standard-evm-discovery/raw/028.body', bytes: 382510, sha256: '1fb51175d15fe55c0bf13e446cb079bc4af84302c7356684fca573a093209870' },
  { id: 'kilnDocsMetadata', path: 'reports/standard-evm-discovery/raw/027.json', bytes: 1774, sha256: 'c55fbe2799e282c7df55d0dcc3a73e6ee2823ce587fe9d6071234eccd9fbf9ab' },
  { id: 'kilnDocs', path: 'reports/standard-evm-discovery/raw/027.body', bytes: 8820, sha256: 'e335351dc80f49372b08d1870528963e34cb55a7956d876b47835a0770ed8501' },
]);

// The freeze must retain these exact imported dependency files/package scope,
// in addition to this module and SOURCE_FILES. The runner owns that inventory.
export const MODULE_DEPENDENCIES = freeze([
  'engines/local-evm/node_modules/@noble/hashes/sha3.js',
  'engines/local-evm/node_modules/@noble/hashes/_u64.js',
  'engines/local-evm/node_modules/@noble/hashes/utils.js',
  'engines/local-evm/node_modules/@noble/hashes/package.json',
  'engines/local-evm/node_modules/@noble/hashes/LICENSE',
]);

export const ALIGNMENT = freeze({
  chainId: 1, originalGas: GAS, originalValue: '0', senderPolicy: 'one_saved_sender_per_case',
  state: 'same_exact_saved_header_block_end_plus_prior_successful_originals',
  originalProfile: 'unsigned_unpriced_block_end', executionBaseFee: '0', gasPrice: '0',
  sourceBaseFee: 'retained_in_unmodified_saved_header', feesSettled: false,
  outerSignatures: false, exactHistoricalTransactionReplay: false, timeAdvancement: false,
  atomic: false, stopOn: 'first_original_non_success',
  localQueryGas: '1000000', providerQueryGas: '300000',
  queryComparison: 'same_state_observed_returned_values_under_different_gas_budgets',
  identicalQueryExecutionContext: false, queryGasComparison: 'excluded',
  queryState: 'disposable_before_and_after_each_step_never_carried',
  queryScheduling: 'local_all_originals_first_provider_queries_interleaved_between_originals',
  failedOriginalQueries: 'provider_skips_local_may_measure_retained_failed_invocation_state',
  missingChannels: 'retain_as_unavailable_or_unattempted_never_zero_or_success',
  noApprovalOrFundingOverrides: true,
});

const ref = (id, pointer = null, detail = null) => {
  const source = SOURCE_FILES.find(row => row.id === id); assert(source);
  return { path: source.path, sha256: source.sha256, ...(pointer ? { pointer } : {}), ...(detail ? { detail } : {}) };
};
function addressWord(address) {
  assert.match(address, /^0x[0-9a-f]{40}$/); return address.slice(2).padStart(64, '0');
}
function uintWord(value) {
  const number = BigInt(value); assert(number >= 0n && number < (1n << 256n));
  return number.toString(16).padStart(64, '0');
}
function calldata(signature, words, expectedSelector) {
  const actual = selector(signature); assert.equal(actual, expectedSelector);
  for (const word of words) assert.match(word, /^[0-9a-f]{64}$/);
  return actual + words.join('');
}
function words(data, signature, count) {
  assert.equal(data.slice(0, 10), selector(signature)); assert.equal(data.length, 10 + count * 64);
  assert.match(data, /^0x[0-9a-f]+$/);
  return Array.from({ length: count }, (_, index) => data.slice(10 + index * 64, 74 + index * 64));
}
function step(index, operation, signature, request, provenance, previouslyCaptured) {
  return { index, operation, signature, selector: selector(signature), request: { to: request.to, data: request.data, value: request.value },
    previouslyCaptured, provenance };
}
function inputs(from, header, calls, queries) {
  const localInput = { chainId: 1, from, block: header.hash,
    calls: calls.map(call => ({ to: call.to, data: call.data, value: '0', gas: GAS })), queries: clone(queries) };
  const providerInput = { chainId: 1, from, block: header.hash,
    calls: calls.map(call => ({ to: call.to, data: call.data, value: '0', queries: clone(queries) })) };
  assert.equal(calls.length, 3); assert(queries.length >= 5 && queries.length <= 8);
  assert.equal(new Set(queries.map(query => JSON.stringify(query))).size, queries.length);
  return { localInput, providerInput };
}
function tokenRole(row, index, caseIndex, sourceIndex) {
  return { index, id: row.id, label: row.label, descriptor: clone(row.call),
    subject: { asset: row.token, account: row.account ?? row.owner,
      ...(row.spender ? { spender: row.spender } : {}), kind: row.kind, decimals: row.decimals },
    provenance: [ref('depositPlan', `/cases/${caseIndex}/queries/${sourceIndex}`)] };
}

/** Build fixed declarations from saved inputs only. No prior output/state-diff
 * value is installed as state; the one saved response is read only for its
 * exact apiRequest and consistency with the separately frozen input plan. */
export async function loadLendingSequenceDeclarations({ root = DEFAULT_ROOT } = {}) {
  const documents = new Map();
  for (const entry of SOURCE_FILES) {
    const file = resolve(root, entry.path), stat = await lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Source must be a regular file: ${entry.path}`);
    assert.equal(stat.size, entry.bytes, `Source byte count changed: ${entry.path}`);
    const bytes = await readFile(file);
    assert.equal(bytes.length, entry.bytes); assert.equal(sha256(bytes), entry.sha256, `Source hash changed: ${entry.path}`);
    documents.set(entry.id, entry.path.endsWith('.json') ? JSON.parse(bytes) : bytes.toString('utf8'));
  }
  const positions = documents.get('positionsPlan'), lending = documents.get('lendingPlan'), deposits = documents.get('depositPlan');
  const aave = lending.cases[0], morpho = lending.cases[1];
  assert.equal(aave.id, 'aave-usdc-supply-with-permit'); assert.equal(morpho.id, 'morpho-kiln-usdc-deposit');
  assert.equal(positions.cases[2].id, 'aave-approval-position-sequence');
  assert.equal(positions.cases[1].id, 'morpho-vault-position');
  assert.equal(deposits.cases[0].id, aave.id); assert.equal(deposits.cases[1].id, morpho.id);
  const aaveInput = documents.get('aaveSequence').apiRequest;
  assert.deepEqual(aaveInput, positions.cases[2].input);
  for (const [c, parentId] of [[aave, 'aaveParent'], [morpho, 'morphoParent']]) {
    const parent = documents.get(parentId);
    assert.deepEqual(parent.response.result, c.header);
    assert.deepEqual(parent.request.body.params, [c.header.hash, false]);
    assert.equal(c.request.gas, '0x4c4b40'); assert.equal(c.request.value, '0x0');
  }
  for (const [metadataId, bodyId, expectedUrl] of [
    ['aaveDocsMetadata', 'aaveDocs', 'https://aave.com/docs/aave-v3/smart-contracts/pool'],
    ['kilnDocsMetadata', 'kilnDocs', 'https://raw.githubusercontent.com/kilnfi/app-plugin-kiln-v2/develop/PLUGIN_SPECIFICATION.md'],
  ]) {
    const metadata = documents.get(metadataId), source = SOURCE_FILES.find(row => row.id === bodyId);
    assert.equal(metadata.request.url, expectedUrl); assert.equal(metadata.http.status, 200);
    assert.equal(metadata.raw.sha256, source.sha256); assert.equal(metadata.raw.bytes, source.bytes);
  }
  const aaveText = documents.get('aaveDocs').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
  assert(aaveText.includes('withdraw(address asset, uint256 amount, address to)'));
  const kilnText = documents.get('kilnDocs');
  assert(kilnText.toLowerCase().includes(morpho.request.to));
  assert(kilnText.includes('0xb460af94') && kilnText.includes('uint256 assets') && kilnText.includes('address receiver') && kilnText.includes('address owner'));

  // Preserve the observed Aave approve/supply bytes. Only the withdrawal is new.
  const aaveFrom = aaveInput.from, pool = aave.request.to;
  assert.equal(aaveInput.chainId, 1); assert.equal(aaveInput.block, aave.header.hash); assert.equal(aaveFrom, aave.request.from);
  const [approval, supply] = aaveInput.calls;
  assert.equal(approval.to, USDC); assert.equal(supply.to, pool); assert.equal(approval.value, '0'); assert.equal(supply.value, '0');
  const supplyWords = words(supply.data, 'supply(address,uint256,address,uint16)', 4);
  assert.equal(supplyWords[0], addressWord(USDC)); assert.equal(supplyWords[2], addressWord(aaveFrom)); assert.equal(supplyWords[3], uintWord(0));
  const aaveAmount = BigInt('0x' + supplyWords[1]); assert.equal(aaveAmount, 3962903485n);
  assert.equal(approval.data, calldata('approve(address,uint256)', [addressWord(pool), uintWord(aaveAmount)], '0x095ea7b3'));
  const aaveHalf = aaveAmount / 2n;
  const aaveWithdraw = { to: pool, data: calldata('withdraw(address,uint256,address)',
    [addressWord(USDC), uintWord(aaveHalf), addressWord(aaveFrom)], '0x69328dec'), value: '0' };
  const aaveQueries = clone(supply.queries);
  assert.equal(aaveQueries.length, 5);
  assert.deepEqual(aaveQueries.slice(0, 4), deposits.cases[0].queries.map(row => row.call));
  assert.deepEqual(aaveQueries[4], { kind: 'aave_v3_user_account_data', contract: pool, user: aaveFrom });
  const aaveRoles = deposits.cases[0].queries.map((row, index) => tokenRole(row, index, 0, index));
  aaveRoles.push({ index: 4, id: 'aave-account-data', label: 'Sender Aave account data', descriptor: clone(aaveQueries[4]),
    subject: { account: aaveFrom, contract: pool, kind: 'aave_v3_user_account_data', units: 'oracle_base_units_unknown_currency_and_scale_plus_bps_and_1e18_health_factor' },
    provenance: [ref('positionsPlan', '/cases/2/input/calls/1/queries/4')] });

  // Preserve Morpho's deposit bytes; add ordinary USDC approval and an assets-
  // denominated wrapper withdrawal. Receiver and owner remain the same sender.
  const morphoFrom = morpho.request.from, wrapper = morpho.request.to;
  const depositWords = words(morpho.request.data, 'deposit(uint256,address)', 2);
  const morphoAmount = BigInt('0x' + depositWords[0]); assert.equal(morphoAmount, 350000000000n);
  assert.equal(depositWords[1], addressWord(morphoFrom));
  assert.equal(positions.cases[1].input.block, morpho.header.hash);
  assert.equal(positions.cases[1].input.from, morphoFrom); assert.equal(positions.cases[1].input.data, morpho.request.data);
  const morphoHalf = morphoAmount / 2n;
  const morphoApproval = { to: USDC, data: calldata('approve(address,uint256)',
    [addressWord(wrapper), uintWord(morphoAmount)], '0x095ea7b3'), value: '0' };
  const morphoDeposit = { to: wrapper, data: morpho.request.data, value: '0' };
  const morphoWithdraw = { to: wrapper, data: calldata('withdraw(uint256,address,address)',
    [uintWord(morphoHalf), addressWord(morphoFrom), addressWord(morphoFrom)], '0xb460af94'), value: '0' };
  const morphoRows = deposits.cases[1].queries.slice(0, 7);
  assert.deepEqual(morphoRows.map(row => row.id), ['owner-usdc', 'beneficiary-wrapper-shares', 'wrapper-vault-shares',
    'wrapper-usdc', 'vault-usdc', 'blue-usdc', 'owner-wrapper-usdc']);
  const blueQuery = positions.cases[1].input.queries[3], blueBinding = positions.cases[1].provenance.morphoBinding;
  assert.equal(blueQuery.kind, 'morpho_blue_position'); assert.equal(blueQuery.user, blueBinding.onBehalfOf);
  assert.equal(blueQuery.contract, blueBinding.event.address); assert.equal(blueQuery.marketId, blueBinding.marketId);
  assert.equal(keccak(Buffer.from(blueBinding.marketParams.slice(2), 'hex')), blueQuery.marketId);
  assert.equal(blueQuery.user, morphoRows[2].token); assert.notEqual(blueQuery.user, morphoFrom);
  const morphoQueries = [...morphoRows.map(row => clone(row.call)), clone(blueQuery)];
  const morphoRoles = morphoRows.map((row, index) => tokenRole(row, index, 1, index));
  morphoRoles.push({ index: 7, id: 'inner-vault-blue-position', label: 'Inner vault Morpho Blue position; not sender ownership',
    descriptor: clone(blueQuery), subject: { account: blueQuery.user, contract: blueQuery.contract, marketId: blueQuery.marketId,
      kind: 'morpho_blue_position', units: 'raw_supply_shares_borrow_shares_and_collateral_without_asset_conversion' },
    provenance: [ref('positionsPlan', '/cases/1/input/queries/3'), ref('positionsPlan', '/cases/1/provenance/morphoBinding')] });

  const cases = [
    { id: 'aave-usdc-approve-supply-withdraw-half', chainId: 1, from: aaveFrom, header: clone(aave.header),
      amounts: { depositRaw: aaveAmount.toString(), withdrawRaw: aaveHalf.toString(), decimals: 6,
        withdrawRule: 'floor(original_supply_amount_raw / 2); underlying units, not receipt-token shares' },
      ...inputs(aaveFrom, aave.header, [approval, supply, aaveWithdraw], aaveQueries),
      steps: [step(0, 'approve', 'approve(address,uint256)', approval, [ref('aaveSequence', '/apiRequest/calls/0')], true),
        step(1, 'supply', 'supply(address,uint256,address,uint16)', supply, [ref('aaveSequence', '/apiRequest/calls/1')], true),
        step(2, 'withdraw', 'withdraw(address,uint256,address)', aaveWithdraw,
          [ref('aaveDocs', null, 'Saved Pool withdrawal ABI; amount is floor half of retained supply input.'), ref('aaveDocsMetadata', '/request/url')], false)],
      queryRoles: aaveRoles,
      provenance: { request: ref('aaveSequence', '/apiRequest'), header: ref('aaveParent', '/response/result'),
        originalHistoricalTransactionHash: aave.originalTransactionHash, originalHistoricalOperation: 'supplyWithPermit',
        selectedSequenceIsOriginalHistory: false, withdrawalHasPriorCapture: false },
      limitations: ['The first two calls were provider-observed as a constructed sequence; this three-step extension is unexecuted.',
        'Half means 1981451742 raw USDC, rounded down by half a raw unit from the odd supply amount.',
        'Prior supply proofs lack at least the sender aEthUSDC balance-query slot61. No missing proof or withdrawal outcome is invented.',
        'Withdrawal availability depends on actual protocol state and collateral checks; no success expectation is inserted.'] },
    { id: 'morpho-kiln-usdc-approve-deposit-withdraw-half', chainId: 1, from: morphoFrom, header: clone(morpho.header),
      amounts: { depositRaw: morphoAmount.toString(), withdrawRaw: morphoHalf.toString(), decimals: 6,
        withdrawRule: 'floor(original_deposit_assets_raw / 2); underlying units, not wrapper or inner-vault shares' },
      ...inputs(morphoFrom, morpho.header, [morphoApproval, morphoDeposit, morphoWithdraw], morphoQueries),
      steps: [step(0, 'approve', 'approve(address,uint256)', morphoApproval,
        [ref('aaveSequence', '/apiRequest/calls/0', 'Same USDC approve ABI; sender, spender and amount are explicitly replaced for this new declaration.')], false),
      step(1, 'deposit', 'deposit(uint256,address)', morphoDeposit, [ref('lendingPlan', '/cases/1/request')], true),
      step(2, 'withdraw', 'withdraw(uint256,address,address)', morphoWithdraw,
        [ref('kilnDocs', null, 'Lines21/54 bind wrapper and assets,receiver,owner ABI; half the retained deposit assets, receiver=owner=sender.'), ref('kilnDocsMetadata', '/request/url')], false)],
      queryRoles: morphoRoles,
      provenance: { request: ref('lendingPlan', '/cases/1/request'), header: ref('morphoParent', '/response/result'),
        originalHistoricalTransactionHash: morpho.originalTransactionHash, originalHistoricalOperation: 'deposit',
        selectedSequenceIsOriginalHistory: false, withdrawalHasPriorCapture: false,
        bluePositionBinding: ref('positionsPlan', '/cases/1/provenance/morphoBinding') },
      limitations: ['The target is the Kiln outer wrapper, not a direct Morpho Blue deposit. Only the standalone deposit was previously captured.',
        'A prior deposit capture already had sufficient allowance; this prepended approval does not establish that approval is necessary.',
        'This fixed eight-query list omits wrapper-to-vault allowance, fee-recipient/self shares, other Blue markets and debt positions.',
        'Prior standalone deposit needed 230 proof/code calls. Withdrawal and additional queries may exhaust the unchanged shared 256-proof-call cap.',
        'Withdrawal liquidity, fees and shares burned remain unobserved. No full economic coverage or expected result is declared.'] },
  ];
  for (const c of cases) {
    assert.deepEqual(c.localInput.queries, c.queryRoles.map(row => row.descriptor));
    for (let i = 0; i < 3; i++) {
      const { gas, ...local } = c.localInput.calls[i], { queries, ...provider } = c.providerInput.calls[i];
      assert.equal(gas, GAS); assert.deepEqual(local, provider); assert.deepEqual(queries, c.localInput.queries);
    }
  }
  return freeze({ schemaVersion: '1.0', scope: { status: 'input_only_preparation', cases: 2, originalCallsPerCase: 3,
    newWithdrawalsExecuted: 0, originalProfile: ALIGNMENT.originalProfile, expectedOutputsSupplied: false,
    initialState: 'must_be_obtained_and_verified_by_each_candidate_transport_at_the_fixed_header',
    previousTracesOrDiffsUsedAsInitialState: false, noPublicDispatchInDeclarationLoader: true },
  alignment: clone(ALIGNMENT), sourceFiles: clone(SOURCE_FILES), moduleDependencies: clone(MODULE_DEPENDENCIES), cases });
}
