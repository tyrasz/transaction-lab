import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), H = '0x' + '33'.repeat(32);
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.value = ''; this.hidden = false; this._text = ''; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute() {} removeAttribute() {} focus() {}
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  setCustomValidity() {} reportValidity() { return true; }
  get classList() { return { toggle() {} }; }
}
function ui({ fetchImpl, onTimer } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const document = { getElementById(id) { assert(elements.has(id), id); return elements.get(id); }, createElement: tag => new Element(tag),
    createTextNode(text) { const element = new Element(); element.textContent = text; return element; }, querySelector: () => new Element() };
  const context = vm.createContext({ document, URL, Blob, AbortController, structuredClone, navigator: {},
    setTimeout: (...args) => { onTimer?.(args[1]); return setTimeout(...args).unref(); }, clearTimeout,
    fetch: fetchImpl ?? (() => new Promise(() => {})) });
  vm.runInContext(app, context);
  return { context, elements };
}
function row(account = A, before = '9007199254740993', after = '9007199254740992') {
  return { account, asset: { type: 'native', symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 }, beforeRaw: before, afterRaw: after,
    deltaRaw: (BigInt(after) - BigInt(before)).toString(), before: 'Do not trust formatted input', after: 'Do not trust formatted input', delta: 'Do not trust formatted input' };
}
function report() {
  return { request: { chainId: 999, from: A, to: B }, source: { chainId: 999, mode: 'simulation', blockHash: H }, execution: { status: 'success' }, coverage: { status: 'partial' },
    nativeBalanceChanges: { status: 'measured', basis: 'current_pinned_state_validated_native_balance', feeScope: 'excluded', assets: [row()], candidateAccountCount: 1,
      omittedAccounts: [], warnings: [], executionIdentity: { stateBlockHash: H, stateBinding: 'block_hash', headerContext: 'synthetic_unpriced_basefee_zero' } } };
}

test('HyperEVM result renders exact HYPE and wei without pooling accounts or replacing token views', () => {
  const testUi = ui(), result = report();
  result.nativeBalanceChanges.assets.push(row(B, '1000000000000000000', '2000000000000000000'));
  result.nativeBalanceChanges.candidateAccountCount = 2;
  testUi.context.renderResult(result);
  const text = testUi.elements.get('hype-assets').textContent;
  assert.match(text, /0\.009007199254740993 HYPE/); assert.match(text, /-0\.000000000000000001 HYPE/);
  assert.match(text, /9007199254740993 wei/); assert.match(text, /-1 wei/);
  assert.match(text, /Transaction sender’s balance/); assert.match(text, /ownership not inferred/);
  assert(text.includes(A)); assert(text.includes(B)); assert.equal(testUi.elements.get('hype-assets').children.length, 2);
  assert.doesNotMatch(text, /Do not trust|ETH|USD|\$/);
  assert.match(testUi.elements.get('hype-description').textContent, /Network fees are excluded/);
  assert.equal(testUi.elements.get('balances-section').hidden, true);
  assert.equal(testUi.elements.get('coverage-status').textContent, 'Partial');
  assert.deepEqual(JSON.parse(testUi.elements.get('raw-json').textContent), result);
});

test('partial native results keep only measured rows and visibly retain omitted accounts', () => {
  const testUi = ui(), result = report(), native = result.nativeBalanceChanges;
  native.status = 'partial'; native.candidateAccountCount = 9; native.omittedAccounts = [{ account: B, reason: 'account-limit' }];
  testUi.context.renderResult(result);
  assert.equal(testUi.elements.get('hype-badge').textContent, 'Partial account coverage');
  assert.equal(testUi.elements.get('hype-assets').children.length, 1);
  assert.equal(testUi.elements.get('hype-omitted-section').hidden, false);
  assert.match(testUi.elements.get('hype-omitted').textContent, /eight-account limit.*Balance unknown/);
  assert.match(testUi.elements.get('hype-counts').textContent, /1 measured · 9 observed candidate/);
});

test('all native accounts omitted by the shared budget stay unavailable without a malformed-row warning', () => {
  const testUi = ui(), result = report(), native = result.nativeBalanceChanges;
  native.status = 'partial'; native.assets = []; native.candidateAccountCount = 2;
  native.omittedAccounts = [{ account: A, reason: 'rpc-budget' }, { account: B, reason: 'rpc-budget' }];
  testUi.context.renderResult(result);
  assert.equal(testUi.elements.get('hype-badge').textContent, 'Unavailable');
  assert.equal(testUi.elements.get('hype-assets').children.length, 0);
  assert.match(testUi.elements.get('hype-description').textContent, /Missing values do not imply zero/);
  assert.match(testUi.elements.get('hype-omitted').textContent, /shared request budget.*Balance unknown/);
  assert.match(testUi.elements.get('hype-counts').textContent, /0 measured · 2 observed candidate/);
  assert.doesNotMatch(testUi.elements.get('hype-warnings').textContent, /incomplete or inconsistent/);
  for (const mutate of [n => n.candidateAccountCount = 3, n => n.omittedAccounts[1].account = A,
    n => n.omittedAccounts[0].reason = 'unknown', n => delete n.assets]) {
    const malformed = structuredClone(result); mutate(malformed.nativeBalanceChanges); testUi.context.renderResult(malformed);
    assert.match(testUi.elements.get('hype-warnings').textContent, /incomplete or inconsistent/);
    assert.equal(testUi.elements.get('hype-assets').children.length, 0);
  }
});

test('unavailable, missing, historical and wrong-context native results expose no projected amounts', () => {
  for (const mutate of [r => r.nativeBalanceChanges.status = 'unavailable', r => r.nativeBalanceChanges.status = 'not_applicable',
    r => delete r.nativeBalanceChanges.executionIdentity, r => r.nativeBalanceChanges.executionIdentity.stateBlockHash = '0x' + '44'.repeat(32),
    r => r.nativeBalanceChanges.executionIdentity.stateBlockHash = 1, r => r.nativeBalanceChanges.feeScope = 'included',
    r => r.source.mode = 'historical_trace', r => r.source.chainId = 1]) {
    const testUi = ui(), result = report(); mutate(result); testUi.context.renderResult(result);
    assert.equal(testUi.elements.get('hype-assets').children.length, 0);
    assert.match(testUi.elements.get('hype-description').textContent, /Missing values do not imply zero/);
  }
  const testUi = ui(), result = report(); testUi.context.renderResult(result); delete result.nativeBalanceChanges;
  testUi.context.renderResult(result); assert.equal(testUi.elements.get('hype-section').hidden, true);
  assert.equal(testUi.elements.get('hype-assets').children.length, 0);
});

test('native rows reject missing, malformed, duplicate or contradictory quantities without inferring zero', () => {
  for (const mutate of [r => delete r.beforeRaw, r => r.beforeRaw = '01', r => r.beforeRaw = 1, r => r.afterRaw = '-1',
    r => r.beforeRaw = (1n << 256n).toString(), r => r.deltaRaw = '0', r => r.deltaRaw = '-0', r => r.asset.decimals = 6,
    r => r.account = '<img src=x onerror=alert(1)>']) {
    const testUi = ui(), result = report(); mutate(result.nativeBalanceChanges.assets[0]); testUi.context.renderResult(result);
    assert.equal(testUi.elements.get('hype-assets').children.length, 0);
    assert.match(testUi.elements.get('hype-warnings').textContent, /withheld/);
  }
  const testUi = ui(), result = report(); result.nativeBalanceChanges.assets.push(row()); testUi.context.renderResult(result);
  assert.equal(testUi.elements.get('hype-assets').children.length, 0);
});

test('largest uint256 and zero balances remain exact, and warning text uses text nodes', () => {
  const testUi = ui(), result = report(), max = ((1n << 256n) - 1n).toString();
  result.nativeBalanceChanges.assets = [row(A, max, '0')]; result.nativeBalanceChanges.warnings = ['<script>untrusted text</script>'];
  testUi.context.renderResult(result);
  assert(testUi.elements.get('hype-assets').textContent.includes(max + ' wei'));
  assert(testUi.elements.get('hype-assets').textContent.includes('115792089237316195423570985008687907853269984665640564039457.584007913129639935 HYPE'));
  assert.match(testUi.elements.get('hype-assets').textContent, /0 HYPE0 wei/);
  assert.equal(testUi.elements.get('hype-warnings').children[0].tagName, 'LI');
  assert.equal(testUi.elements.get('hype-warnings').textContent, '<script>untrusted text</script>');
});

test('HyperEVM simulation client allows its bounded state work while other request timeouts stay unchanged', async () => {
  const durations = [], testUi = ui({ onTimer: value => durations.push(value), fetchImpl: url => url === '/api/config'
    ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => ({}) }) });
  durations.length = 0;
  for (const [url, timeout] of [['/api/simulate', 240000], ['/api/replay', 65000], ['/api/evm/simulate-sequence', 300000],
    ['/api/evm/simulate', 180000], ['/api/evm/local-preview', 180000], ['/api/evm/local-sequence', 180000], ['/api/arbitrum/simulate', 180000]]) {
    await testUi.context.request(url, {}); assert.equal(durations.at(-1), timeout, url);
  }
});
