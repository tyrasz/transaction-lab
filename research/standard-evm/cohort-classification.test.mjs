import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { classifyCohortIntents, DEPLOYMENT_METADATA as M, DEPLOYMENT_METADATA_SHA256, INTENT_CATEGORIES, CLASSIFICATION_LIMITS, CohortClassificationError } from './cohort-classification.mjs';
const require = createRequire(new URL('../../engines/local-evm/package.json', import.meta.url));
const { keccak_256 } = await import(require.resolve('@noble/hashes/sha3.js'));
const clone = structuredClone, h = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), a = n => '0x' + BigInt(n).toString(16).padStart(40, '0'), w = n => BigInt(n).toString(16).padStart(64, '0');
const deployment = id => M.deployments.find(x => x.id === id).address;
const USDC = deployment('ethereum_usdc'), AAVE = deployment('ethereum_aave_v3_pool'), MORPHO = deployment('ethereum_morpho_blue'), VAULT = deployment('ethereum_steakhouse_usdc_vault'), ROUTER = deployment('ethereum_uniswap_swaprouter02'), UNIVERSAL = deployment('ethereum_uniswap_universal_router');
const signatureSelector = signature => '0x' + Buffer.from(keccak_256(Buffer.from(signature))).subarray(0, 4).toString('hex');
const data = (signature, words = []) => signatureSelector(signature) + words.map(w).join('');
const supply = () => data('supply(address,uint256,address,uint16)', [BigInt(USDC), 100, 1, 0]);
const transfer = () => data('transfer(address,uint256)', [2, 100]);
function fixture(calls) {
  const census = calls.map((_, i) => ({ transactionHash: h(i + 1), blockHash: h(900), blockNumber: '99', transactionIndex: String(i) }));
  return { chainId: 1, census, envelopes: calls.map((call, i) => ({ ...census[i], from: a(1), to: a(2), input: '0x', value: '0', ...call })) };
}
const classify = calls => classifyCohortIntents(fixture(calls));
const bad = input => assert.throws(() => classifyCohortIntents(input), CohortClassificationError);

test('frozen primary-source map and every method selector are independently bound', () => {
  const raw = readFileSync(new URL('./cohort-deployments.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), DEPLOYMENT_METADATA_SHA256);
  assert.equal(DEPLOYMENT_METADATA_SHA256, '06e0d693cdf0321579c3169ad2f9009defac791f2430b5d0072d73d9d73f6e28');
  for (const m of [...M.methods, ...M.batchSelectorHints]) assert.equal(m.selector, signatureSelector(m.signature));
  assert.equal(M.deployments.length, 6); assert.equal(M.reviewedOn, '2026-10-27');
  for (const item of [...M.methods, ...M.deployments]) for (const id of item.sourceIds) assert.match(M.sources[id].url, /^https:\/\//);
  assert.match(M.sourceSnapshot, /not archived or cryptographically authenticated/);
  assert.ok(Object.isFrozen(M.deployments[0].methods));
});

test('all N rows get one primary intent category without execution or selection input', () => {
  const result = classify([
    { value: '1' }, { to: USDC, input: transfer() },
    { to: USDC, input: data('approve(address,uint256)', [3, 100]) },
    { to: AAVE, input: supply() },
    { to: ROUTER, input: data('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [1, 2, 3000, 3, 100, 0, 0]) },
    { to: VAULT, input: data('deposit(uint256,address)', [100, 1]) },
    { input: transfer() }, { to: null, input: supply() },
  ]);
  assert.equal(result.censusSize, 8); assert.equal(result.classifiedRows, 8);
  assert.deepEqual(result.counts, { transfer: 2, approval_permit: 1, swap: 1, lending: 1, vault_wrapper: 1, other_unknown: 2 });
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), 8);
  assert.ok(result.rows.every(r => INTENT_CATEGORIES.includes(r.category) && !r.economicEffectsVerified && !r.executionSuccessKnown));
  assert.equal(result.rows[0].confidence, 'envelope_form_only');
  assert.ok(result.rows.slice(1, 6).every(r => r.confidence === 'declared_address_and_abi_shape' && !r.declaration.identityAtStateVerified));
});

test('generic ERC20 and ERC4626-looking calls remain unknown with selector-only hints', () => {
  const calls = [transfer(), data('transferFrom(address,address,uint256)', [1, 2, 100]), data('approve(address,uint256)', [3, 1]), data('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', [1, 2, 1, 100, 27, 1, 2]), data('deposit(uint256,address)', [100, 1])];
  const out = classify(calls.map(input => ({ input })));
  assert.ok(out.rows.every(r => r.category === 'other_unknown' && r.reason === 'selector_without_declared_destination' && r.confidence === 'unknown' && r.hints[0].confidence === 'selector_only'));
  assert.equal(out.rows[0].hints[0].abiShape.status, 'canonical_shape');
  assert.equal(out.rows[4].hints[0].category, 'vault_wrapper');
});

test('known destination alone cannot classify an unknown, colliding or malformed method', () => {
  const out = classify([{ to: AAVE, input: transfer() }, { to: USDC, input: '0xdeadbeef' }, { to: AAVE, input: supply().slice(0, -2) }, { to: USDC, input: transfer() + w(1) }]);
  assert.ok(out.rows.every(r => r.category === 'other_unknown'));
  assert.equal(out.rows[0].reason, 'declared_destination_method_unknown');
  assert.equal(out.rows[2].reason, 'abi_length_mismatch');
  assert.equal(out.rows[3].reason, 'abi_length_mismatch');
});

test('address/narrow-integer ABI high bits and nonpayable value cannot produce declared match', () => {
  const out = classify([
    { to: USDC, input: data('transfer(address,uint256)', [1n << 160n, 1]) },
    { to: AAVE, input: data('supply(address,uint256,address,uint16)', [1, 2, 3, 65536]) },
    { to: ROUTER, input: data('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [1, 2, 1n << 24n, 3, 100, 0, 0]) },
    { to: USDC, input: transfer(), value: '1' },
  ]);
  assert.ok(out.rows.every(r => r.category === 'other_unknown'));
  assert.ok(out.rows.slice(0, 3).every(r => r.reason === 'abi_noncanonical_word'));
  assert.equal(out.rows[3].reason, 'value_attached_to_declared_nonpayable_method');
});

test('canonical Morpho dynamic bytes shape supports intent but does not infer callback effects', () => {
  const sig = 'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)';
  const head = [1, 2, 3, 4, 5, 100, 0, 1, 9 * 32];
  const empty = data(sig, [...head, 0]);
  const callback = data(sig, [...head, 1]) + 'aa' + '00'.repeat(31);
  const out = classify([{ to: MORPHO, input: empty }, { to: MORPHO, input: callback }]);
  assert.ok(out.rows.every(r => r.category === 'lending'));
  assert.equal(out.rows[0].abiShape.tailBytes, 0); assert.equal(out.rows[1].abiShape.tailBytes, 1);
  assert.ok(out.rows[1].tags.includes('callback_data_present'));
  for (const malformed of [data(sig, [...head.slice(0, -1), 0, 0]), callback.slice(0, -2) + '01', callback + w(0), data(sig, [...head, 1000000])]) assert.equal(classify([{ to: MORPHO, input: malformed }]).rows[0].category, 'other_unknown');
});

test('router execute and batch calls stay unknown; opaque contents are never called swaps', () => {
  const batch = data('multicall(bytes[])', [32, 0]);
  const execute = signatureSelector('execute(bytes,bytes[],uint256)') + 'abcd';
  const out = classify([{ to: ROUTER, input: batch }, { to: UNIVERSAL, input: execute }, { input: batch }]);
  assert.ok(out.rows.every(r => r.category === 'other_unknown' && r.reason === 'batch_or_router_contents_unknown' && r.tags.includes('nested_actions_unexamined')));
  assert.ok(out.rows[0].tags.includes('declared_router_destination'));
  assert.ok(!out.rows[2].tags.includes('declared_router_destination'));
  assert.equal(out.rows[1].hints[0].abiShape.status, 'unexamined');
});

test('native and empty/short/creation forms remain explicit without EOA or effect claims', () => {
  const out = classify([{ to: USDC, value: '1' }, {}, { input: '0xab', value: '1' }, { to: null, value: '1', input: transfer() }]);
  assert.equal(out.rows[0].category, 'transfer'); assert.ok(out.rows[0].tags.includes('recipient_code_unknown'));
  assert.equal(out.rows[1].reason, 'empty_calldata_zero_value'); assert.equal(out.rows[2].reason, 'short_calldata');
  assert.ok(out.rows[2].tags.includes('mixed_effects_possible')); assert.equal(out.rows[3].reason, 'contract_creation'); assert.deepEqual(out.rows[3].hints, []);
});

test('actual preserved Aave input classifies by declaration while unnamed Morpho wrapper stays unknown', () => {
  const raw = readFileSync(new URL('../../reports/ethereum-lending-local-reference/plan.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288');
  const p = JSON.parse(raw), out = classify(p.cases.map(c => ({ from: c.request.from, to: c.request.to, input: c.request.data, value: BigInt(c.request.value).toString() })));
  assert.equal(out.rows[0].category, 'lending'); assert.equal(out.rows[0].method.id, 'aave_supply_permit'); assert.ok(out.rows[0].tags.includes('mixed_intent'));
  assert.equal(out.rows[1].category, 'other_unknown'); assert.equal(out.rows[1].hints[0].category, 'vault_wrapper'); assert.equal(out.rows[1].declaration, null);
  // No local output, provider output, success marker or observed balance is read.
});

test('canonical order and byte case produce stable classification identity without mutating callers', () => {
  const input = fixture([{ to: USDC, input: transfer() }, { to: AAVE, input: supply() }]), before = clone(input), a = classifyCohortIntents(input);
  input.census.reverse(); input.envelopes.reverse();
  for (const e of input.envelopes) for (const k of ['from', 'to', 'input']) e[k] = '0x' + e[k].slice(2).toUpperCase();
  const b = classifyCohortIntents(input); assert.deepEqual(a, b); assert.deepEqual(before.envelopes[0].input, transfer());
  assert.ok(Object.isFrozen(a.rows[0].envelope)); assert.throws(() => { a.rows[0].category = 'swap'; });
});

test('missing, duplicate, foreign and conflicting envelope identities reject the whole input', () => {
  const mutate = [i => i.envelopes.pop(), i => { i.envelopes[1] = clone(i.envelopes[0]); }, i => { i.envelopes[0].transactionHash = h(99); }, i => { i.envelopes[0].blockHash = h(99); }, i => { i.envelopes[0].transactionIndex = '8'; }, i => { i.census[1] = clone(i.census[0]); }, i => { i.census[1].transactionIndex = '0'; }, i => { i.census[1].blockHash = h(99); }, i => { i.census[1].blockNumber = '98'; }];
  for (const fn of mutate) { const input = fixture([{}, {}]); fn(input); bad(input); }
});

test('outcome/selection fields and exotic object access are rejected before consumption', () => {
  for (const extra of ['outcomes', 'selected', 'product', 'success', 'metadata']) { const i = fixture([{}]); i[extra] = []; bad(i); }
  let calls = 0; const input = fixture([{}]); Object.defineProperty(input.envelopes[0], 'input', { enumerable: true, get() { calls++; return '0x'; } }); bad(input); assert.equal(calls, 0);
  const sparse = fixture([{}]); delete sparse.envelopes[0]; bad(sparse);
  const symbolic = fixture([{}]); symbolic.envelopes[0][Symbol('x')] = 1; bad(symbolic);
  const wrong = fixture([{}]); wrong.envelopes[0] = Object.create(wrong.envelopes[0]); bad(wrong);
});

test('invalid values and oversized input fail closed; bounded ABI unknown rows remain in N', () => {
  for (const value of ['01', '-1', '0x1', (1n << 256n).toString(), 1, ['1']]) { const i = fixture([{ value }]); bad(i); }
  for (const input of ['0x1', '0xGG', '0x' + '00'.repeat(CLASSIFICATION_LIMITS.calldataBytes + 1)]) bad(fixture([{ input }]));
  const out = classify([{ to: USDC, input: transfer() + '00'.repeat(CLASSIFICATION_LIMITS.abiDecodeBytes) }]);
  assert.equal(out.censusSize, 1); assert.equal(out.rows[0].category, 'other_unknown'); assert.equal(out.rows[0].reason, 'abi_decode_bound');
});

test('zero population and unsupported chain retain clear denominator and no fabricated confidence', () => {
  const out = classify([]); assert.equal(out.censusSize, 0); assert.equal(out.classifiedRows, 0); assert.deepEqual(out.rows, []); assert.ok(Object.values(out.counts).every(n => n === 0));
  const i = fixture([{}]); i.chainId = 999; bad(i);
  assert.equal(out.limitations.destinationIdentityAtStateVerified, false); assert.equal(out.limitations.economicEffectsVerified, false);
  assert.equal(out.limitations.selectionOrOutcomeUsed, false); assert.equal(out.limitations.metadataPredeclarationChronologyVerified, false);
  assert.equal(out.limitations.securityAssessment, 'not_assessed');
});
