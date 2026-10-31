// Saved-input/ABI/provenance controls only; no RPC, API execution or EVM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FUNDED_PROFILE, FUNDED_PROVENANCE_FILES, deriveFundedTemplates } from './funded-profile.mjs';
import { compilePreviewQueries } from '../../engines/local-evm/preview-queries.js';

const root = new URL('../../', import.meta.url);
const originalBytes = ['001', '002'].map(n => readFileSync(new URL(`research/lending-local-sequence-v037/capture/inputs/${n}.json`, root)));
const bases = () => originalBytes.map(b => JSON.parse(b));
const S = '0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668', OLD = '0x48c16c5652add27eddb0f896748a35fc60b8d1b4';
const U = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', P = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const A = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', K = '0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b';
const V = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb', B = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const EXPECTED = [
  [[U, '0x095ea7b3', [P, 100000000n]], [P, '0x617ba037', [U, 100000000n, S, 0n]], [P, '0x69328dec', [U, 50000000n, S]]],
  [[U, '0x095ea7b3', [K, 100000000n]], [K, '0x6e553f65', [100000000n, S]], [K, '0xb460af94', [50000000n, S, S]]],
];
function decode(input, selector, values) {
  assert.equal(input.slice(0, 10), selector); assert.equal(input.length, 10 + 64 * values.length);
  assert.match(input, /^0x[0-9a-f]+$/);
  values.forEach((expected, i) => {
    const raw = input.slice(10 + i * 64, 74 + i * 64);
    if (typeof expected === 'bigint') assert.equal(BigInt('0x' + raw), expected);
    else { assert.equal(raw.slice(0, 24), '0'.repeat(24)); assert.equal('0x' + raw.slice(24), expected); }
  });
}

test('six calldata decodings independently bind exact selectors, ordered ABI words and envelopes', () => {
  const out = deriveFundedTemplates(bases()); assert.equal(FUNDED_PROFILE, 'selected_100_usdc_v1'); assert.equal(out.profile, FUNDED_PROFILE);
  assert.deepEqual(out.cases.map(c => c.id), ['aave-usdc-selected-100-supply-50-withdraw', 'kiln-usdc-selected-100-deposit-50-withdraw']);
  out.cases.forEach((c, index) => {
    assert.equal(c.chainId, 1); assert.equal(c.from, S); assert.equal(c.localInput.from, S); assert.equal(c.providerInput.from, S);
    assert.equal(c.amounts.depositRaw, '100000000'); assert.equal(c.amounts.withdrawRaw, '50000000'); assert.equal(c.amounts.decimals, 6);
    EXPECTED[index].forEach(([to, selector, values], position) => {
      const local = c.localInput.calls[position], provider = c.providerInput.calls[position], step = c.steps[position];
      assert.equal(local.to, to); assert.equal(local.value, '0'); assert.equal(local.gas, '5000000'); decode(local.data, selector, values);
      assert.deepEqual(Object.keys(local).sort(), ['data', 'gas', 'to', 'value']);
      assert.deepEqual(provider, { to, data: local.data, value: '0', queries: c.localInput.queries });
      assert.deepEqual(step.request, { to, data: local.data, value: '0' }); assert.equal(step.selector, selector);
      assert.equal(step.index, position); assert.equal(step.previouslyCaptured, false); assert.equal(step.construction, FUNDED_PROFILE);
    });
  });
});

test('Aave sender queries, subjects and compiled identities change together; reserves and Blue user do not', () => {
  const out = deriveFundedTemplates(bases()), [aave, kiln] = out.cases;
  const targets = [[U, A, U, U], [U, K, V, U, U, U, U]];
  const args = [[[S], [S], [A], [S, P]], [[S], [S], [K], [K], [V], [B], [S, K]]];
  out.cases.forEach((c, index) => {
    const compiled = compilePreviewQueries(c.localInput.queries, { chainId: 1 });
    assert.equal(compiled.length, index === 0 ? 5 : 8);
    c.queryRoles.forEach((role, q) => {
      assert.equal(role.index, q); assert.deepEqual(role.descriptor, c.localInput.queries[q]);
      assert.deepEqual(compiled[q].descriptor, role.descriptor);
      assert.equal(role.subject.account, compiled[q].identity.account ?? compiled[q].identity.owner ?? compiled[q].identity.user);
      if (q < args[index].length) {
        assert.equal(role.descriptor.to, targets[index][q]);
        decode(role.descriptor.data, args[index][q].length === 2 ? '0xdd62ed3e' : '0x70a08231', args[index][q]);
      }
    });
    for (const call of c.providerInput.calls) assert.deepEqual(call.queries, c.localInput.queries);
  });
  assert.deepEqual(aave.localInput.queries[4], { kind: 'aave_v3_user_account_data', contract: P, user: S });
  assert.deepEqual(aave.localInput.queries[2], bases()[0].localInput.queries[2]);
  assert.deepEqual(kiln.localInput.queries, bases()[1].localInput.queries);
  assert.equal(kiln.localInput.queries[7].user, V); assert.notEqual(kiln.localInput.queries[7].user, S);
  assert.equal(kiln.localInput.queries[7].marketId, '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64');
  assert(!JSON.stringify(aave.localInput).includes(OLD)); assert(!JSON.stringify(aave.queryRoles.map(r => r.subject)).includes(OLD));
});

test('machine-readable amendment exactly reconstructs changes while preserving headers and all unlisted fields', () => {
  const before = bases(), out = deriveFundedTemplates(before), reconstructed = structuredClone(before), reversed = structuredClone(out.cases);
  const allowed = ['id', 'from', 'amounts', 'localInput', 'providerInput', 'steps', 'queryRoles', 'provenance', 'limitations'];
  const expectedPaths = [0, 1].flatMap(i => allowed.filter(f => !(i === 1 && f === 'from')).map(f => `/cases/${i}/${f}`));
  assert.deepEqual(out.amendment.changes.map(c => c.path), expectedPaths);
  for (const row of out.amendment.changes) {
    const [, , index, field] = row.path.split('/'); assert.equal(row.op, 'replace');
    assert.deepEqual(row.before, before[index][field]); assert.deepEqual(row.after, out.cases[index][field]);
    reconstructed[index][field] = structuredClone(row.after); reversed[index][field] = structuredClone(row.before);
  }
  assert.deepEqual(reconstructed, out.cases); assert.deepEqual(reversed, before);
  out.cases.forEach((c, i) => { assert.deepEqual(c.header, before[i].header); assert.equal(c.localInput.block, before[i].header.hash); assert.equal(c.providerInput.block, before[i].header.hash); });
  assert.deepEqual(before, bases()); assert.equal(out.amendment.scope.freshHeaderRequired, true);
});

test('changed old sender, receiver, owner, spender, amount, referral or query identity is refused even if representations agree', () => {
  const replaceWord = (s, position, raw) => s.slice(0, 10 + position * 64) + raw.padStart(64, '0') + s.slice(74 + position * 64);
  for (const [caseIndex, position, wordIndex, value] of [[0, 0, 0, K.slice(2)], [0, 1, 1, '5f5e100'], [0, 1, 2, S.slice(2)], [0, 1, 3, '1'], [0, 2, 2, S.slice(2)], [1, 2, 1, OLD.slice(2)], [1, 2, 2, OLD.slice(2)]]) {
    const b = bases(), c = b[caseIndex], changed = replaceWord(c.localInput.calls[position].data, wordIndex, value);
    c.localInput.calls[position].data = changed; c.providerInput.calls[position].data = changed; c.steps[position].request.data = changed;
    assert.throws(() => deriveFundedTemplates(b), /Original base case JSON differs/);
  }
  for (const mutate of [
    b => { b[0].from = S; b[0].localInput.from = S; b[0].providerInput.from = S; },
    b => { b[0].localInput.queries[4].user = S; b[0].queryRoles[4].descriptor.user = S; b[0].queryRoles[4].subject.account = S; for (const c of b[0].providerInput.calls) c.queries[4].user = S; },
    b => { b[1].localInput.queries[7].user = S; }, b => { b[0].queryRoles[3].subject.spender = K; },
    b => { b[0].localInput.queries.reverse(); }, b => { b[1].id = 'other-case'; },
  ]) { const b = bases(); mutate(b); assert.throws(() => deriveFundedTemplates(b)); }
});

test('old result/state facts, overrides, changed provenance, selected headers and malformed bases are not admitted', () => {
  for (const mutate of [
    b => { b[0].result = { status: 'success' }; }, b => { b[0].localInput.stateOverrides = { [S]: { balance: '0xffff' } }; },
    b => { b[1].providerInput.calls[0].stateOverrides = {}; }, b => { b[0].header.hash = '0x' + '1'.repeat(64); },
    b => { b[0].provenance.request.path = 'invented'; }, b => { b[0].steps[0].previouslyCaptured = false; },
    b => { b[0].localInput.calls[0].authorizationList = []; }, b => { b[1].localInput.calls[1].gas = '5000001'; },
  ]) { const b = bases(); mutate(b); assert.throws(() => deriveFundedTemplates(b)); }
  assert.throws(() => deriveFundedTemplates(bases().reverse())); assert.throws(() => deriveFundedTemplates([...bases(), bases()[0]]));
  const extra = bases(); extra.result = { status: 'success' }; assert.throws(() => deriveFundedTemplates(extra));
  let read = false; const b = bases(); Object.defineProperty(b[0], 'id', { enumerable: true, get() { read = true; return 'fake'; } });
  assert.throws(() => deriveFundedTemplates(b), /accessors/); assert.equal(read, false);
});

test('new cases do not claim old historical transactions or consume observed balances or expected state', () => {
  const out = deriveFundedTemplates(bases()), text = JSON.stringify(out.cases);
  for (const c of out.cases) {
    assert.equal(c.provenance.selectedSequenceIsOriginalHistory, false); assert.equal(c.provenance.priorResultsInstalledAsState, false);
    assert.equal(c.provenance.templateHeaderIsHistorical, true); assert.equal(c.provenance.freshHeaderSelectionRequiredForExecution, true);
    assert(!Object.hasOwn(c.provenance, 'headerPendingFreshSelection'));
    assert(!Object.hasOwn(c.provenance, 'originalHistoricalTransactionHash')); assert(!Object.hasOwn(c.provenance, 'originalHistoricalOperation'));
    for (const step of c.steps) { assert.equal(step.previouslyCaptured, false); assert(step.abiProvenance.every(p => !Object.hasOwn(p, 'detail'))); }
  }
  assert(!text.includes('112952478562')); assert(!text.includes('350000000000')); assert(!text.includes('3962903485'));
  assert.equal(out.amendment.scope.selectionInformedByPriorObservation, true); assert.equal(out.amendment.scope.expectedPoststateConsumed, false);
  assert.equal(out.amendment.scope.priorResultsInstalledAsState, false); assert.equal(out.amendment.scope.representativeAccuracyClaimed, false);
  assert.deepEqual(Object.keys(out.amendment.selectionRationale).sort(), ['kind', 'pointers', 'sourcePath', 'sourceSha256']);
});

test('derivation is independent of object key order, does not mutate frozen bases, and shares no mutable result objects', () => {
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  function reorder(v) { return Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v; }
  const input = freeze(bases()), out = deriveFundedTemplates(input), other = deriveFundedTemplates(reorder(bases()));
  assert.deepEqual(out, other); out.cases[0].localInput.calls[0].data = 'changed'; out.cases[0].queryRoles[0].subject.account = 'changed';
  out.amendment.baseTemplateProvenance[0].sha256 = 'changed';
  assert.deepEqual(deriveFundedTemplates(input), other); assert.deepEqual(input, bases());
  assert.notEqual(out.cases[0].providerInput.calls[0].data, 'changed');
});

test('all declared ABI and rationale provenance bytes match their pins without executing or loading results as state', () => {
  const out = deriveFundedTemplates(bases()), pins = new Map(FUNDED_PROVENANCE_FILES.map(row => [row.path, row]));
  assert.equal(pins.size, 9); assert(Object.isFrozen(FUNDED_PROVENANCE_FILES));
  for (const row of FUNDED_PROVENANCE_FILES) {
    const bytes = readFileSync(new URL(row.path, root)); assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256); assert(Object.isFrozen(row));
  }
  for (const c of out.cases) for (const row of [...c.steps, ...c.queryRoles]) for (const p of row.abiProvenance) assert.equal(pins.get(p.path)?.sha256, p.sha256);
  assert.equal(pins.get(out.amendment.selectionRationale.sourcePath).sha256, out.amendment.selectionRationale.sourceSha256);
  const source = readFileSync(new URL('./funded-profile.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]), ['node:assert/strict', 'node:crypto']);
});
