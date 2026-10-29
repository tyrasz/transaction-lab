import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const scenario = JSON.parse(await readFile(new URL('../research/arbitrum-viem-deposit-v1/scenario.json', import.meta.url), 'utf8'));
const protocol = JSON.parse(await readFile(new URL('../research/arbitrum-deposit-v1/decoded-scenario.json', import.meta.url), 'utf8'));
const A = scenario.from, T = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', H = '0x' + '33'.repeat(32);
const plain = value => JSON.parse(JSON.stringify(value));
// Real UI handlers with an offline DOM surface. This is not a layout or live RPC test.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.value = ''; this.type = ''; this.checked = false; this.disabled = false; this.hidden = false; this._text = ''; this.validationMessage = ''; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute() {} removeAttribute() {} focus() {} click() {}
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.events[name] || []) fn({ preventDefault() {} }); }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { return !this.validationMessage; }
  get classList() { return { toggle() {} }; }
}
function sample() {
  return { id: 'arb-offline', status: 'completed', source: { chainId: 42161, provider: 'https://arb1.arbitrum.io/rpc', blockNumber: '519233880', blockHash: H, requestedBlock: 'latest', headerConfirmed: true, twoPassConsistent: true, blockBinding: 'number_with_header_reread' },
    execution: { status: 'success', data: '0x', gasUsed: '58256', logs: [], error: null },
    assetChanges: [{ owner: A, token: { address: T, symbol: 'USDC', decimals: 6, metadataTrust: 'untrusted_provider' }, status: 'measured', beforeRaw: '900719925474099300', afterRaw: '900719925374099300', deltaRaw: '-100000000', reason: null }],
    coverage: { inventoryComplete: false, destinationCreditVerified: false, feesVerified: false, securityAssessed: false }, protocol: structuredClone(protocol), timing: { totalMs: 3 }, rawViem: { retained: true } };
}
function setup(fetchImpl) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const document = { getElementById(id) { assert(elements.has(id), `Declared HTML ID: ${id}`); return elements.get(id); }, createElement: tag => new Element(tag), createTextNode(text) { const e = new Element('#text'); e.textContent = text; return e; }, querySelector: () => new Element() };
  const requests = [], context = vm.createContext({ document, URL, Blob, structuredClone, AbortController, navigator: {}, setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    fetch: (url, options) => { if (url === '/api/config') return new Promise(() => {}); requests.push({ url, options }); return fetchImpl?.(url, options) ?? Promise.resolve({ ok: true, json: async () => sample() }); } });
  vm.runInContext(app, context); const state = vm.runInContext('state', context);
  state.config = { examples: [], standardEvm: { available: true, examples: [], sequenceCapabilities: { available: true } }, localEvm: { available: true },
    arbitrumEvm: { available: true, examples: [{ id: 'cctp-original', title: 'Original public USDC CCTP request', description: 'Previously reverted with zero USDC; a fresh result is required.', request: { ...scenario, chainId: 42161, block: '0x1' } }] } };
  elements.get('chain').value = '42161'; elements.get('local-fees-enabled').type = 'checkbox'; elements.get('standard-manual-queries').type = 'checkbox';
  context.selectNetwork(); return { context, state, elements, requests };
}
const nodes = element => [element, ...element.children.flatMap(nodes)];

test('Arbitrum uses its original public example at latest and hides Ethereum-only controls', () => {
  const ui = setup();
  assert.equal(ui.elements.get('from').value, scenario.from); assert.equal(ui.elements.get('to').value, scenario.to); assert.equal(ui.elements.get('data').value, scenario.data);
  assert.equal(ui.elements.get('block').value, 'latest'); assert.match(ui.elements.get('example-description').textContent, /zero USDC/); assert.equal(ui.state.result, null);
  for (const id of ['ethereum-engine-field', 'ethereum-call-mode-field', 'local-operation-field', 'local-gas-settings', 'local-fee-settings', 'transaction-context-settings', 'standard-query-settings', 'sequence-editor', 'replay-button']) assert.equal(ui.elements.get(id).hidden, true, id);
  assert.equal(ui.elements.get('arbitrum-gas-settings').hidden, false); assert.equal(ui.elements.get('arbitrum-gas').disabled, false);
  assert.match(ui.elements.get('network-heading').textContent, /ARBITRUM ONE/); assert.match(ui.elements.get('arbitrum-help').textContent || html, /incomplete asset coverage/);
  ui.state.config.arbitrumEvm.available = false; ui.state.config.arbitrumEvm.reason = 'Provider unavailable'; ui.context.setBusy(false);
  assert.equal(ui.elements.get('simulate-button').disabled, true); assert.equal(ui.elements.get('network-help').textContent, 'Provider unavailable');
});

test('dedicated payload excludes hidden query/context/fee controls and locks fields during the call', async () => {
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; }));
  ui.elements.get('standard-queries').value = 'not JSON'; ui.elements.get('transaction-context').value = 'not JSON'; ui.elements.get('local-fees-enabled').checked = true;
  ui.elements.get('local-gas').value = 'invalid'; ui.elements.get('arbitrum-gas').value = '125000';
  const pending = ui.context.run('simulation'); assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].url, '/api/arbitrum/simulate');
  assert.deepEqual(JSON.parse(ui.requests[0].options.body), { ...scenario, chainId: 42161, block: 'latest', gas: '125000' });
  for (const id of ['chain', 'example', 'from', 'to', 'data', 'value', 'block', 'arbitrum-gas', 'ethereum-engine']) assert.equal(ui.elements.get(id).disabled, true, id);
  finish({ ok: true, json: async () => sample() }); await pending;
  assert.equal(ui.elements.get('arbitrum-result').hidden, false); for (const id of ['hyper-result', 'standard-result', 'local-result']) assert.equal(ui.elements.get(id).hidden, true);
  assert.equal(ui.elements.get('arbitrum-gas').disabled, false); assert.equal(ui.elements.get('ethereum-engine').disabled, true);
  assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), sample()); assert.equal(ui.elements.get('download-json').disabled, false);
});

test('Arbitrum gas defaults to omission, validates canonical bounds and never enters another network payload', async () => {
  const ui = setup(); await ui.context.run('simulation'); assert.equal(Object.hasOwn(JSON.parse(ui.requests[0].options.body), 'gas'), false);
  for (const gas of ['20999', '5000001', '021000', '0x5208', '2e6', '20,000', '-1']) {
    const invalid = setup(); invalid.elements.get('arbitrum-gas').value = gas; await invalid.context.run('simulation'); assert.equal(invalid.requests.length, 0); assert.match(invalid.elements.get('arbitrum-gas').validationMessage, /21000 to 5000000/);
  }
  for (const chain of ['1', '999']) {
    const other = setup(); other.elements.get('chain').value = chain; other.context.selectNetwork(); other.elements.get('arbitrum-gas').value = 'bad hidden value';
    other.elements.get('from').value = A; other.elements.get('to').value = T; await other.context.run('simulation');
    assert.equal(other.requests.length, 1); assert.equal(Object.hasOwn(JSON.parse(other.requests[0].options.body), 'gas'), false); assert.notEqual(other.requests[0].url, '/api/arbitrum/simulate');
    assert.equal(other.elements.get('arbitrum-gas').disabled, true);
  }
});

test('input/gas/network/example/reset edits invalidate old and pending Arbitrum results', async () => {
  for (const id of ['from', 'to', 'data', 'value', 'block', 'arbitrum-gas']) {
    const ui = setup(); ui.context.renderArbitrumResult(sample()); ui.elements.get(id).value += '1'; ui.elements.get(id).dispatch('input');
    assert.equal(ui.state.result, null, id); assert.equal(ui.elements.get('download-json').disabled, true); assert.equal(ui.elements.get('raw-json').textContent, '');
  }
  const reset = setup(); reset.elements.get('arbitrum-gas').value = '300000'; reset.context.renderArbitrumResult(sample()); reset.elements.get('simulation-form').dispatch('reset');
  assert.equal(reset.elements.get('arbitrum-gas').value, ''); assert.equal(reset.state.result, null);
  reset.elements.get('arbitrum-gas').value = '300000'; reset.elements.get('example').dispatch('change'); assert.equal(reset.elements.get('arbitrum-gas').value, '');
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); const pending = ui.context.run('simulation'); ui.elements.get('arbitrum-gas').value = '21000';
  finish({ ok: true, json: async () => sample() }); await pending; assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true);
  const switcher = setup(); switcher.context.renderArbitrumResult(sample()); switcher.elements.get('chain').value = '999'; switcher.elements.get('chain').dispatch('change'); assert.equal(switcher.state.result, null);
});

test('execution success is separate from exact balances, incomplete coverage and CCTP intent', () => {
  const ui = setup(), result = sample(); ui.context.renderArbitrumResult(result);
  assert.equal(ui.elements.get('execution-status').textContent, 'Success'); assert.equal(ui.elements.get('coverage-status').textContent, 'Incomplete');
  const assets = ui.elements.get('arbitrum-assets').textContent;
  assert.match(assets, /900719925474099300 raw units/); assert.match(assets, /900719925474\.0993 USDC/); assert.match(assets, /-100 USDC/);
  assert.match(ui.elements.get('arbitrum-routing').textContent, /Requested perps routing/); assert.match(ui.elements.get('arbitrum-routing').textContent, /spot/);
  const intent = ui.elements.get('arbitrum-protocol-details').textContent;
  assert.match(intent, /Requested burn100 USDC/); assert.match(intent, /cap, not quote0\.2 USDC/); assert.match(intent, /Measured outgoing amountNot established/); assert.match(intent, /Destination creditUnverified/);
  assert.deepEqual(plain(ui.state.result), result); assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
});

test('revert and unavailable remain explicit; missing probes never become zero rows or successful deposits', () => {
  const ui = setup(), result = sample(); result.execution = { status: 'reverted', gasUsed: '58256', error: { message: 'ERC20: transfer amount exceeds balance' } };
  result.assetChanges = [{ owner: A, token: { address: T }, status: 'unverified', beforeRaw: '0', afterRaw: '0', deltaRaw: '0', reason: 'After probe failed' }];
  ui.context.renderArbitrumResult(result); assert.equal(ui.elements.get('execution-status').textContent, 'Reverted'); assert.match(ui.elements.get('execution-error').textContent, /exceeds balance/);
  assert.equal(nodes(ui.elements.get('arbitrum-assets')).filter(n => n.tagName === 'TABLE').length, 0); assert.match(ui.elements.get('arbitrum-assets').textContent, /After probe failed/); assert.doesNotMatch(ui.elements.get('arbitrum-assets').textContent, /0 raw units/);
  assert.match(ui.elements.get('arbitrum-protocol-details').textContent, /Requested burn100 USDC/);
  ui.context.renderArbitrumResult({ id: 'unavailable', status: 'unavailable', execution: { status: 'unavailable' }, assetChanges: [] });
  assert.equal(ui.elements.get('execution-status').textContent, 'Unavailable'); assert.match(ui.elements.get('arbitrum-assets').textContent, /unknown coverage, not proof/); assert.equal(ui.elements.get('arbitrum-protocol').hidden, true);
});

test('malformed amounts, wrong chain and unconfirmed headers withhold amounts; unsafe strings stay literal text', () => {
  for (const mutate of [r => r.source.headerConfirmed = false, r => r.source.chainId = 1, r => r.source.twoPassConsistent = false, r => delete r.source.twoPassConsistent, r => r.status = 'unavailable', r => r.execution.status = 'unavailable',
    r => r.assetChanges[0].deltaRaw = '0', r => r.assetChanges[0].beforeRaw = '01', r => r.assetChanges[0].afterRaw = null, r => r.assetChanges[0].deltaRaw = '-0']) {
    const ui = setup(), result = sample(); mutate(result); ui.context.renderArbitrumResult(result); assert.equal(nodes(ui.elements.get('arbitrum-assets')).filter(n => n.tagName === 'TABLE').length, 0);
  }
  const ui = setup(), result = sample(), hostile = '<img src=x onerror=alert(1)><script>bad</script>';
  result.assetChanges[0].token.symbol = hostile; result.source.provider = hostile; result.execution.error = { message: hostile }; result.coverage.limitations = [hostile];
  result.protocol.intent.limitations = [hostile]; ui.context.renderArbitrumResult(result);
  assert(ui.elements.get('arbitrum-assets').textContent.includes(hostile)); assert.equal(ui.elements.get('execution-error').textContent, hostile);
  for (const id of ['arbitrum-assets', 'arbitrum-state-details', 'arbitrum-protocol-limits', 'warnings-list', 'execution-error']) assert.equal(nodes(ui.elements.get(id)).some(n => ['SCRIPT', 'IMG', 'IFRAME'].includes(n.tagName)), false);
  result.assetChanges[0].token = { address: T, symbol: null, decimals: null }; ui.context.renderArbitrumResult(result); assert.match(ui.elements.get('arbitrum-assets').textContent, /900719925474099300 raw units/);
  ui.context.renderLocalResult({ execution: {}, source: {}, measurements: [] }); assert.equal(ui.elements.get('arbitrum-result').hidden, true);
  ui.context.renderArbitrumResult(result); ui.context.renderStandardResult({ execution: {}, source: {}, preview: {} }); assert.equal(ui.elements.get('arbitrum-result').hidden, true);
});
