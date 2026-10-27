import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const address = '0x' + '11'.repeat(20), contract = '0x' + '22'.repeat(20), market = '0x' + '33'.repeat(32);
const token = { to: contract, data: '0x70a08231' + address.slice(2).padStart(64, '0') };
const aave = { kind: 'aave_v3_user_account_data', contract, user: address };
const morpho = { kind: 'morpho_blue_position', contract, user: address, marketId: market };
const plain = value => JSON.parse(JSON.stringify(value));

// Small DOM surface for the actual UI script. No browser, network, layout or
// semantic rendering claim: assertions inspect generated nodes and handlers.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.className = ''; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.validationMessage = ''; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { for (const item of items) this.children.push(typeof item === 'string' ? Object.assign(new Element('#text'), { textContent: item }) : item); }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn); }
  dispatch(event) { for (const fn of this.events[event] || []) fn({ preventDefault() {} }); }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { return !this.validationMessage; }
  focus() {}
  get classList() { return { toggle: (name, force) => { const names = new Set(this.className.split(' ').filter(Boolean)); const add = force ?? !names.has(name); if (add) names.add(name); else names.delete(name); this.className = [...names].join(' '); return add; } }; }
}
function setup() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('chain').value = '1'; elements.get('ethereum-call-mode').value = 'single';
  const panel = new Element();
  const document = { getElementById(id) { assert.ok(elements.has(id), `Declared HTML element ${id}`); return elements.get(id); },
    createElement(tag) { return new Element(tag); }, createTextNode(text) { const node = new Element('#text'); node.textContent = text; return node; }, querySelector() { return panel; } };
  const context = vm.createContext({ document, URL, Blob, structuredClone, AbortController, setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    navigator: {}, fetch: () => new Promise(() => {}) });
  vm.runInContext(app, context, { filename: 'public/app.js' });
  return { context, elements, state: vm.runInContext('state', context) };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const tagged = (node, tag) => descendants(node).filter(n => n.tagName === tag.toUpperCase());
function position(kind = aave.kind, index = 1) {
  const fields = kind === aave.kind
    ? [['totalCollateralBase', 256, 'oracle_base_units', null], ['totalDebtBase', 256, 'oracle_base_units', null], ['availableBorrowsBase', 256, 'oracle_base_units', null],
      ['currentLiquidationThreshold', 256, 'basis_points', '10000'], ['ltv', 256, 'basis_points', '10000'], ['healthFactor', 256, 'ratio', '1000000000000000000']]
    : [['supplyShares', 256, 'supply_shares', null], ['borrowShares', 128, 'borrow_shares', null], ['collateral', 128, 'collateral_token_raw_units', null]];
  return { index, kind, chainId: '1', contract, user: address, ...(kind === morpho.kind ? { marketId: market } : {}), contractIdentityVerified: false,
    status: 'measured', basis: 'isolated_traced_ABI_queries_with_nonce_only_effects', unitBasis: 'reference_ABI_semantics_not_deployment_attestation',
    rows: fields.map(([name, bits, unit, scale], i) => ({ name, abiType: `uint${bits}`, beforeRaw: String(i + 2), afterRaw: String(i + 1), deltaRaw: '-1', unit: { kind: unit, scale } })),
    limitations: ['Shares and ratios are not a value estimate.'], references: ['https://aave.com/docs/aave-v3/smart-contracts/pool'] };
}
function result(positions = [position()]) {
  return { id: 'synthetic-ui-control', execution: { status: 'success', gasUsed: '30000' }, canonicalStatus: 'verified',
    apiRequest: { chainId: 1, from: address, to: contract, value: '0', block: '0x' + '44'.repeat(32) },
    block: { hash: '0x' + '44'.repeat(32), number: '1', timestamp: '1' }, source: { blockSelection: {} },
    nativeEffects: { status: 'none', candidates: [], selectedAccounts: [], counts: { candidates: 0, selected: 0, omitted: 0, measured: 0 } },
    preview: { scope: 'explicit_queried_accounts', queries: [], nativeBalances: [], positions }, executionIdentity: {} };
}

test('manual list accepts both typed descriptors mixed with token calls without changing identities', () => {
  const { context } = setup(); const input = [token, aave, morpho];
  assert.deepEqual(plain(context.readStandardQueries(JSON.stringify(input))), input);
  assert.equal(context.readStandardQueries(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ ...aave, user: '0x' + (i + 1).toString(16).padStart(40, '0') })))).length, 8);
  assert.throws(() => context.readStandardQueries(JSON.stringify(Array(9).fill(aave))), /one and eight/);
  assert.throws(() => context.readStandardQueries('[]'), /one and eight/);
});
test('manual typed query validation rejects unknown, mixed, missing and malformed fields', () => {
  const { context } = setup();
  for (const bad of [null, [], 'position', { ...aave, chainId: 1 }, { ...aave, marketId: market }, { ...aave, to: contract }, { ...token, kind: aave.kind },
    { ...aave, kind: 'unknown' }, { ...aave, user: 0 }, { ...aave, contract: '0x123' }, { ...morpho, marketId: '0x12' },
    { kind: morpho.kind, contract, user: address }, { kind: aave.kind, contract }, { ...morpho, data: '0x' }]) {
    assert.throws(() => context.readStandardQueries(JSON.stringify([bad])), /query|queries|format/i, JSON.stringify(bad));
  }
  assert.throws(() => context.readStandardQueries('not JSON'), /valid JSON/);
});
test('single-call Aave position shows exact raw words, reference units and original mixed-query index', () => {
  const { context, elements } = setup(); const p = position();
  const max = ((1n << 256n) - 1n).toString(); Object.assign(p.rows[5], { beforeRaw: max, afterRaw: max, deltaRaw: '0' });
  context.renderStandardResult(result([p])); const section = elements.get('standard-positions');
  assert.equal(elements.get('standard-positions-section').hidden, false); assert.equal(elements.get('standard-positions-count').textContent, '1 / 1 measured');
  assert.match(section.textContent, /Manual query2/); assert.match(section.textContent, /Contract identity is not verified/);
  assert.match(section.textContent, /currency and scale not verified/); assert.match(section.textContent, /Basis points · scale 10000/);
  assert.ok(section.textContent.includes(max)); assert.match(section.textContent, /Ratio · scale 1000000000000000000/);
  assert.deepEqual(tagged(section, 'strong').map(n => n.textContent), p.rows.flatMap(r => [r.beforeRaw, r.afterRaw, r.deltaRaw]));
  assert.doesNotMatch(section.textContent, /USD|\$|Healthy|Safe|Low risk|High risk/);
  assert.match(elements.get('coverage-status').textContent, /positions 1\/1/);
});
test('Morpho market identity and shares stay separate from token balances and user ownership', () => {
  const { context, elements } = setup(), p = position(morpho.kind, 3); p.user = '0x' + '55'.repeat(20);
  const r = result([p]); r.preview.queries = [{ index: 0, kind: 'balanceOf', account: address, token: contract, status: 'measured', beforeRaw: '10', afterRaw: '20', deltaRaw: '10' }];
  context.renderStandardResult(r); const section = elements.get('standard-positions');
  assert.ok(section.textContent.includes(market)); assert.ok(section.textContent.includes(p.user)); assert.match(section.textContent, /Manual query4/);
  assert.doesNotMatch(section.textContent, /Transaction sender/); assert.match(section.textContent, /Supply shares · not converted to assets/);
  assert.match(section.textContent, /Borrow shares · not converted to assets/); assert.match(section.textContent, /token and scale not verified/);
  assert.equal(elements.get('standard-balances-count').textContent, '1 / 1 measured'); assert.equal(elements.get('standard-positions-count').textContent, '1 / 1 measured');
  assert.match(elements.get('coverage-status').textContent, /tokens 1\/1 · positions 1\/1/);
});
test('unavailable or malformed position values never render stale amounts or measured counts', () => {
  for (const mutation of [p => p.status = 'unavailable', p => p.rows[0].afterRaw = '01', p => p.rows[0].deltaRaw = '123',
    p => p.rows.pop(), p => p.rows[0].beforeRaw = (1n << 256n).toString(), p => p.rows[1].abiType = 'int256']) {
    const { context, elements } = setup(), p = position(); mutation(p); context.renderStandardResult(result([p]));
    assert.equal(elements.get('standard-positions-count').textContent, '0 / 1 measured');
    assert.equal(tagged(elements.get('standard-positions'), 'table').length, 0);
  }
  const { context, elements } = setup(), p = position(morpho.kind); p.rows[1].afterRaw = (1n << 128n).toString();
  context.renderStandardResult(result([p])); assert.equal(tagged(elements.get('standard-positions'), 'table').length, 0);
});
test('failed execution or unverified single context withholds position values defensively', () => {
  for (const mutation of [r => r.canonicalStatus = 'unverified', r => r.execution.status = 'reverted_or_failed']) {
    const { context, elements } = setup(), r = result(); mutation(r); context.renderStandardResult(r);
    assert.equal(elements.get('standard-positions-count').textContent, '0 / 1 measured'); assert.equal(tagged(elements.get('standard-positions'), 'table').length, 0);
    assert.match(elements.get('standard-positions').textContent, /withheld/);
  }
});
test('sequence invalidation deletes position rows, resets counts and preserves full raw response', () => {
  const { context, elements } = setup(), r = result(), sequence = { ...result([]), canonicalStatus: 'unverified', sequence: { status: 'unavailable', completedSteps: 1 },
    steps: [{ index: 0, status: 'completed', input: { to: contract }, result: r, stateSource: { kind: 'initial_block' } }] };
  const view = context.sequenceStepView(sequence, sequence.steps[0]); assert.equal(view.preview.positions[0].status, 'unavailable');
  assert.equal(Object.hasOwn(view.preview.positions[0], 'rows'), false); assert.ok(r.preview.positions[0].rows.length);
  context.renderSequenceResult(sequence);
  assert.match(elements.get('sequence-step-list').textContent, /position checks: 0\/1 measured/);
  assert.equal(elements.get('standard-positions-count').textContent, '0 / 1 measured'); assert.equal(tagged(elements.get('standard-positions'), 'table').length, 0);
  assert.deepEqual(JSON.parse(elements.get('raw-json').textContent), sequence);
});
test('sequence step selection renders per-step columns and clears positions on later token-only step', () => {
  const { context, elements } = setup();
  const sequence = { ...result([]), sequence: { status: 'completed', completedSteps: 2 }, steps: [
    { index: 0, status: 'completed', input: { to: contract }, result: result(), stateSource: { kind: 'initial_block' } },
    { index: 1, status: 'completed', input: { to: contract }, result: result([]), stateSource: { kind: 'after_step', stepIndex: 0 } },
  ] };
  context.renderSequenceResult(sequence); context.renderSequenceStep(sequence, sequence.steps[0]);
  assert.match(elements.get('standard-positions').textContent, /Before step 1After step 1Step 1 change/);
  context.renderSequenceStep(sequence, sequence.steps[1]); assert.equal(elements.get('standard-positions-section').hidden, true);
  assert.equal(elements.get('standard-positions').children.length, 0); assert.equal(elements.get('standard-positions-count').textContent, '0 / 0 measured');
});
test('sequence editor uses the same mixed-list validator and keeps automatic mode omitted', () => {
  const { context, state, elements } = setup(); elements.get('ethereum-call-mode').value = 'sequence';
  state.config = { standardEvm: { available: true, sequenceCapabilities: { available: true } } };
  state.sequenceDrafts = [context.newSequenceDraft({ to: contract, data: '0x', value: '0' }), context.newSequenceDraft({ to: contract, data: '0x', value: '0' })];
  context.renderSequenceEditor(); let calls = context.readSequenceCalls(); assert.ok(calls.every(call => !Object.hasOwn(call, 'queries')));
  state.sequenceControls[0].manual.checked = true; state.sequenceControls[0].queries.value = JSON.stringify([token, aave]);
  calls = context.readSequenceCalls(); assert.deepEqual(plain(calls[0].queries), [token, aave]); assert.equal(Object.hasOwn(calls[1], 'queries'), false);
  state.sequenceControls[0].queries.value = JSON.stringify([{ ...aave, chainId: 1 }]); assert.equal(context.readSequenceCalls(), null);
  assert.match(state.sequenceControls[0].queries.validationMessage, /Extra fields/);
});
test('position values/references use text nodes and safe links; narrow tables wrap raw integers', () => {
  const { context, elements } = setup(), p = position(); p.reason = '<script>bad</script>'; p.status = 'unavailable';
  p.references = ['javascript:alert(1)', 'data:text/html,bad', 'https://example.com/reference'];
  context.renderStandardResult(result([p])); const section = elements.get('standard-positions');
  assert.ok(section.textContent.includes('<script>bad</script>')); assert.equal(tagged(section, 'script').length, 0);
  assert.deepEqual(tagged(section, 'a').map(a => a.href), ['https://example.com/reference']);
  assert.ok(css.includes('.position-measurement-table')); assert.ok(css.includes('overflow-wrap:anywhere')); assert.ok(css.includes('@media(max-width:420px)'));
});
test('existing automatic token fixture remains token-only without adding position queries or totals', async () => {
  const { context, elements } = setup(); const recorded = JSON.parse(await readFile(new URL('../reports/standard-evm-auto/aave-response.json', import.meta.url)));
  context.renderStandardResult(recorded); assert.equal(elements.get('standard-positions-section').hidden, true);
  assert.equal(elements.get('standard-positions').children.length, 0); assert.doesNotMatch(elements.get('coverage-status').textContent, /positions/);
  assert.equal(Object.hasOwn(recorded.apiRequest, 'queries'), false); assert.equal(elements.get('standard-balances-count').textContent, '3 / 3 measured');
  assert.equal(elements.get('standard-allowances-count').textContent, '1 / 1 measured');
});
