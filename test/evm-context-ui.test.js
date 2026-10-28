import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeEvmContext } from '../engines/evm-context.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const A = '0x' + '11'.repeat(20), T = '0x' + 'ab'.repeat(20), H = '0x' + '33'.repeat(32);
const K = '0x' + 'cd'.repeat(32), B = '0x01' + 'ef'.repeat(31);
const query = { to: T, data: '0x70a08231' + A.slice(2).padStart(64, '0') };
const contextValue = { accessList: [{ address: T, storageKeys: [K, K] }, { address: T, storageKeys: [H] }], blobVersionedHashes: [B, B] };
const plain = value => JSON.parse(JSON.stringify(value));

// Runs the actual UI event handlers with an offline DOM surface. These controls
// establish request/validation behavior, not a browser layout or live result.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.attributes = {}; this.value = ''; this.type = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this._text = ''; this.validationMessage = ''; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); } removeAttribute(key) { delete this.attributes[key]; } focus() {}
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.events[name] || []) fn({ preventDefault() {} }); }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { return !this.validationMessage; }
  get classList() { return { toggle() {} }; }
}
function setup(fetchImpl) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const document = { getElementById(id) { assert(elements.has(id), `Declared HTML ID: ${id}`); return elements.get(id); }, createElement: tag => new Element(tag),
    createTextNode(text) { const e = new Element('#text'); e.textContent = text; return e; }, querySelector: () => new Element() };
  const requests = [], context = vm.createContext({ document, URL, Blob, structuredClone, AbortController, navigator: {},
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    fetch: (url, options) => { if (url === '/api/config') return new Promise(() => {}); requests.push({ url, options }); return fetchImpl?.(url, options) ?? Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { message: 'Offline request captured.' } }) }); } });
  vm.runInContext(app, context);
  const state = vm.runInContext('state', context);
  state.config = { standardEvm: { available: true, examples: [], sequenceExamples: [], sequenceCapabilities: { available: true } }, localEvm: { available: true }, examples: [] };
  for (const [id, value] of Object.entries({ chain: '1', 'ethereum-engine': 'provider', 'ethereum-call-mode': 'single', from: A, to: T, data: '0x', value: '0', block: H, 'standard-queries': JSON.stringify([query]) })) elements.get(id).value = value;
  elements.get('standard-manual-queries').type = 'checkbox'; context.updateQueryMode();
  return { context, state, elements, requests };
}
function setContext(ui, value) { ui.elements.get('transaction-context').value = typeof value === 'string' ? value : JSON.stringify(value); ui.elements.get('transaction-context').dispatch('input'); }
function sequence(ui) {
  ui.elements.get('ethereum-call-mode').value = 'sequence';
  ui.state.sequenceDrafts = [ui.context.newSequenceDraft({ to: T, data: '0x', value: '0' }), ui.context.newSequenceDraft({ to: A, data: '0x', value: '1' })];
  ui.context.renderSequenceEditor(); ui.context.updateQueryMode();
}
function stepContext(row, value) { row.context.value = JSON.stringify(value); row.context.dispatch('input'); }

// Pure form feedback is intentionally independent of the Node helper; compare
// accepted normalized values so both surfaces preserve the same declared data.
test('optional context is collapsed, Ethereum-only, and blank or empty object omits both fields', () => {
  assert.match(html, /<details id="transaction-context-settings"[^>]* hidden>/);
  assert.doesNotMatch(html.match(/<details id="transaction-context-settings"[^>]*>/)[0], /\bopen\b/);
  const ui = setup(); assert.equal(ui.elements.get('transaction-context-settings').open, false);
  assert.equal(ui.elements.get('transaction-context-settings').hidden, false);
  assert.equal(ui.elements.get('transaction-context').disabled, false);
  assert.deepEqual(plain(ui.context.readTransactionContext(' \n ')), {}); assert.deepEqual(plain(ui.context.readTransactionContext('{}')), {});
  assert.match(ui.elements.get('transaction-context-help').textContent, /zero blob fee/);
  assert.match(ui.elements.get('transaction-context-help').textContent, /sidecar validity are not checked/);
  assert.match(css, /\.transaction-context-help pre\{[^}]*overflow-wrap:anywhere/);
  ui.elements.get('chain').value = '999'; ui.context.updateQueryMode();
  assert.equal(ui.elements.get('transaction-context-settings').hidden, true); assert.equal(ui.elements.get('transaction-context').disabled, true);
});

test('context parser preserves list order, duplicate occurrences and user bytes; backend normalization agrees', () => {
  const ui = setup();
  for (const value of [contextValue, { accessList: [] }, { accessList: contextValue.accessList }, { blobVersionedHashes: [B] },
    { accessList: [{ address: T.toUpperCase(), storageKeys: [K.toUpperCase(), K] }] }]) {
    const parsed = plain(ui.context.readTransactionContext(JSON.stringify(value)));
    assert.deepEqual(parsed, value); assert.deepEqual(normalizeEvmContext(parsed), normalizeEvmContext(value));
  }
});

test('malformed JSON, unknown fields and bounded list violations block dispatch in either single engine', async () => {
  const bad = ['{', 'null', '[]', '"text"', JSON.stringify({ maxFeePerBlobGas: '0x0' }), JSON.stringify({ __proto__: null, unexpected: [] }),
    JSON.stringify({ accessList: null }), JSON.stringify({ accessList: [null] }), JSON.stringify({ accessList: [{ address: T, storageKeys: [], extra: true }] }),
    JSON.stringify({ accessList: [{ address: T, storageKeys: ['0x1'] }] }), JSON.stringify({ accessList: [{ address: '0x1', storageKeys: [] }] }),
    JSON.stringify({ accessList: Array(129).fill({ address: T, storageKeys: [] }) }), JSON.stringify({ accessList: [{ address: T, storageKeys: Array(1025).fill(K) }] }),
    ...[null, [], Array(33).fill(B), ['0x02' + 'ef'.repeat(31)], ['0x01'], [null]].map(blobVersionedHashes => JSON.stringify({ blobVersionedHashes }))];
  for (const engine of ['provider', 'local']) for (const value of bad) {
    const ui = setup(); ui.elements.get('ethereum-engine').value = engine; ui.context.updateQueryMode(); setContext(ui, value);
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 0, `${engine}: ${value.slice(0, 60)}`);
    assert.equal(ui.elements.get('transaction-context-settings').open, true); assert.ok(ui.elements.get('transaction-context').validationMessage);
  }
});

test('provider and local submission forward exact optional context while manual queries remain unchanged', async () => {
  for (const engine of ['provider', 'local']) {
    const ui = setup(); ui.elements.get('ethereum-engine').value = engine; ui.elements.get('standard-manual-queries').checked = true; ui.context.updateQueryMode(); setContext(ui, contextValue);
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].url, engine === 'provider' ? '/api/evm/simulate' : '/api/evm/local-preview');
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), { chainId: 1, from: A, to: T, data: '0x', value: '0', block: H, queries: [query], ...contextValue });
    assert.equal(ui.elements.get('transaction-context').disabled, false);
  }
});

test('blank context has no payload keys, and hidden HyperEVM context is never forwarded or parsed', async () => {
  for (const chain of ['1', '999']) {
    const ui = setup(); ui.elements.get('chain').value = chain; ui.context.updateQueryMode();
    setContext(ui, chain === '999' ? '{invalid JSON' : ''); await ui.context.run('simulation');
    assert.equal(ui.requests.length, 1); const body = JSON.parse(ui.requests[0].options.body);
    assert.equal(Object.hasOwn(body, 'accessList'), false); assert.equal(Object.hasOwn(body, 'blobVersionedHashes'), false);
    assert.equal(ui.requests[0].url, chain === '1' ? '/api/evm/simulate' : '/api/simulate');
  }
});

test('sequence context belongs to its step, follows reordering, and never leaks into a new step or top-level request', async () => {
  const ui = setup(); setContext(ui, contextValue); sequence(ui);
  const first = ui.state.sequenceControls[0]; stepContext(first, contextValue); first.manual.checked = true; first.manual.dispatch('change'); first.queries.value = JSON.stringify([query]); first.queries.dispatch('input');
  first.down.dispatch('click'); let calls = plain(ui.context.readSequenceCalls());
  assert.equal(Object.hasOwn(calls[0], 'accessList'), false); assert.deepEqual(calls[1], { to: T, data: '0x', value: '0', queries: [query], ...contextValue });
  ui.elements.get('add-sequence-call').dispatch('click'); assert.equal(ui.state.sequenceControls[2].context.value, '');
  ui.state.sequenceControls[2].to.value = T;
  await ui.context.run('simulation'); assert.equal(ui.requests.length, 1); const body = JSON.parse(ui.requests[0].options.body);
  assert.equal(ui.requests[0].url, '/api/evm/simulate-sequence'); assert.equal(Object.hasOwn(body, 'accessList'), false); assert.equal(Object.hasOwn(body, 'blobVersionedHashes'), false);
  assert.equal(Object.hasOwn(body.calls[0], 'accessList'), false); assert.deepEqual(body.calls[1].accessList, contextValue.accessList); assert.equal(Object.hasOwn(body.calls[2], 'blobVersionedHashes'), false);
  assert.deepEqual(body.calls[1].queries, [query]);
});

test('malformed per-step context opens the affected panel and blocks the whole sequence before fetch', async () => {
  const ui = setup(); sequence(ui); stepContext(ui.state.sequenceControls[1], { blobVersionedHashes: [] });
  await ui.context.run('simulation'); assert.equal(ui.requests.length, 0); assert.equal(ui.state.sequenceControls[1].contextSettings.open, true);
  assert.match(ui.state.sequenceControls[1].context.validationMessage, /one to 32/);
});

test('example, custom-selection, network and reset paths clear prior context including stored sequence drafts', () => {
  const ui = setup(); sequence(ui); stepContext(ui.state.sequenceControls[0], contextValue); setContext(ui, contextValue);
  ui.elements.get('simulation-form').dispatch('reset'); assert.equal(ui.elements.get('transaction-context').value, '');
  assert.ok(ui.state.sequenceDrafts.every(draft => draft.contextText === '')); ui.context.renderSequenceEditor(); assert.ok(ui.state.sequenceControls.every(row => row.context.value === ''));
  stepContext(ui.state.sequenceControls[0], contextValue); ui.context.selectExample(); assert.ok(ui.state.sequenceControls.every(row => row.context.value === ''));
  ui.elements.get('ethereum-call-mode').value = 'single'; setContext(ui, contextValue);
  ui.state.config.standardEvm.examples = [{ id: 'fixed', input: { from: A, to: T, data: '0x', value: '0', block: H } }];
  ui.elements.get('example').value = 'fixed'; ui.context.selectExample(); assert.equal(ui.elements.get('transaction-context').value, '');
  setContext(ui, contextValue); ui.elements.get('example').value = ''; ui.context.selectExample(); assert.equal(ui.elements.get('transaction-context').value, '');
  setContext(ui, contextValue); ui.elements.get('chain').value = '999'; ui.elements.get('chain').dispatch('change'); assert.equal(ui.elements.get('transaction-context').value, '');
  assert.equal(ui.elements.get('transaction-context-settings').hidden, true); assert.equal(ui.elements.get('transaction-context').disabled, true);
  ui.elements.get('chain').value = '1'; ui.elements.get('chain').dispatch('change'); assert.equal(ui.elements.get('transaction-context').value, '');
});

test('pending requests lock context editing and changed context invalidates a late result for single and sequence modes', async () => {
  for (const mode of ['single', 'sequence']) {
    let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; }));
    if (mode === 'sequence') { sequence(ui); stepContext(ui.state.sequenceControls[0], contextValue); } else setContext(ui, contextValue);
    const target = mode === 'sequence' ? ui.state.sequenceControls[0].context : ui.elements.get('transaction-context');
    const running = ui.context.run('simulation'); assert.equal(ui.requests.length, 1); assert.equal(target.disabled, true);
    target.value = '{}'; finish({ ok: true, json: async () => ({ id: 'stale-result' }) }); await running;
    assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true); assert.equal(target.disabled, false);
  }
});
