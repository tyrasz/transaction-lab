import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { ethereumBlobContext } from '../engines/local-evm/ethereum-blob-fees.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const A = '0x' + '11'.repeat(20), T = '0x' + '22'.repeat(20), H = '0x' + '33'.repeat(32);
const query = { to: T, data: '0x70a08231' + A.slice(2).padStart(64, '0') };
const plain = value => JSON.parse(JSON.stringify(value));
// Executes the real UI handlers with a small DOM surface. This is a behavior
// test, not a real-browser/layout claim. Every fetch is injected and offline.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.value = ''; this.type = ''; this.checked = false; this.disabled = false; this.hidden = false; this._text = ''; this.validationMessage = ''; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute() {} removeAttribute() {} focus() {}
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.events[name] || []) fn({ preventDefault() {} }); }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { return !this.validationMessage; }
  get classList() { return { toggle() {} }; }
}
function setup(fetchImpl) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const document = { getElementById(id) { assert(elements.has(id), `Declared HTML ID: ${id}`); return elements.get(id); },
    createElement: tag => new Element(tag), createTextNode(text) { const e = new Element('#text'); e.textContent = text; return e; }, querySelector: () => new Element() };
  const requests = [], context = vm.createContext({ document, URL, Blob, structuredClone, AbortController, navigator: {},
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    fetch: (url, options) => { if (url === '/api/config') return new Promise(() => {}); requests.push({ url, options }); return fetchImpl?.(url, options) ?? Promise.resolve({ ok: true, json: async () => sample() }); } });
  vm.runInContext(app, context);
  const state = vm.runInContext('state', context);
  state.config = { standardEvm: { available: true, examples: [], sequenceCapabilities: { available: true } }, localEvm: { available: true } };
  for (const [id, value] of Object.entries({ chain: '1', 'ethereum-engine': 'provider', 'ethereum-call-mode': 'single', from: A, to: T, data: '0x', value: '0', block: H, 'standard-queries': JSON.stringify([query]) })) elements.get(id).value = value;
  elements.get('standard-manual-queries').type = 'checkbox';
  elements.get('local-fees-enabled').type = 'checkbox';
  return { context, state, elements, requests };
}
function sample() {
  return { kind: 'local_proof_preview', id: 'offline-ui', status: 'complete', execution: { status: 'success' },
    apiRequest: { chainId: 1, from: A, to: T, data: '0x', value: '0', block: H, queries: [query] },
    source: { profile: 'unsigned_unpriced_block_end', canonicalStatus: 'verified', blockSelection: { requested: H, blockHash: H, blockNumber: '10' } },
    measurements: [{ index: 0, descriptor: query, identity: { kind: 'balanceOf', token: T, account: A }, status: 'measured', values: [
      { name: 'balance', beforeRaw: '9007199254740993', afterRaw: '9007199254740992', deltaRaw: '-1', unit: { kind: 'token_raw_units', scale: null } },
    ] }], timing: { totalMs: 1 } };
}
const nodes = element => [element, ...element.children.flatMap(nodes)];
function chooseLocal(ui) { ui.elements.get('ethereum-engine').value = 'local'; ui.elements.get('ethereum-engine').dispatch('change'); }

test('provider stays default; config gates local independently and local requires a manual single call', () => {
  const ui = setup(); ui.context.selectNetwork();
  assert.equal(ui.elements.get('ethereum-engine').value, 'provider');
  ui.elements.get('standard-queries').value = JSON.stringify([query]); chooseLocal(ui);
  assert.equal(ui.elements.get('ethereum-call-mode').value, 'single'); assert.equal(ui.elements.get('ethereum-call-mode').disabled, true);
  assert.equal(ui.elements.get('standard-manual-queries').checked, true); assert.equal(ui.elements.get('standard-manual-queries').disabled, true);
  assert.equal(ui.elements.get('standard-queries').required, true); assert.equal(ui.elements.get('standard-queries').disabled, false);
  assert.match(ui.elements.get('query-mode-help').textContent, /no automatic token selection or ETH balance summary/);
  ui.state.config.standardEvm.available = false; ui.context.setBusy(false); assert.equal(ui.elements.get('simulate-button').disabled, false);
  assert.match(ui.elements.get('network-help').textContent, /independent Ethereum preview/);
  assert.equal(ui.elements.get('ethereum-call-mode').disabled, true); assert.equal(ui.elements.get('standard-manual-queries').disabled, true);
  ui.state.config.localEvm.available = false; ui.context.setBusy(false); assert.equal(ui.elements.get('simulate-button').disabled, true);
  assert.match(ui.elements.get('network-help').textContent, /local engine is unavailable/);
});

test('engine switch preserves single-call inputs but clears stale result and download state', () => {
  const ui = setup(); ui.context.renderStandardResult({ execution: {}, source: {}, preview: {} });
  const before = ui.context.requestFingerprint(); chooseLocal(ui);
  assert.notEqual(ui.context.requestFingerprint(), before); assert.equal(ui.elements.get('from').value, A); assert.equal(ui.elements.get('block').value, H);
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true); assert.equal(ui.elements.get('result-content').hidden, true);
  assert.equal(ui.elements.get('result-label').textContent, 'Inputs changed');
});

test('local submission uses only the dedicated endpoint, sends explicit queries and locks all request controls', async () => {
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(ui);
  const running = ui.context.run('simulation');
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].url, '/api/evm/local-preview');
  assert.deepEqual(JSON.parse(ui.requests[0].options.body), sample().apiRequest);
  for (const id of ['chain', 'ethereum-engine', 'ethereum-call-mode', 'from', 'to', 'data', 'value', 'block', 'standard-queries']) assert.equal(ui.elements.get(id).disabled, true, id);
  finish({ ok: true, json: async () => sample() }); await running;
  assert.equal(ui.elements.get('local-result').hidden, false); assert.equal(ui.elements.get('standard-result').hidden, true); assert.equal(ui.elements.get('hyper-result').hidden, true);
  assert.equal(ui.elements.get('ethereum-engine').disabled, false); assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), sample());
});

test('empty manual queries block local dispatch and a changed fingerprint suppresses a pending result', async () => {
  const invalid = setup(); chooseLocal(invalid); invalid.elements.get('standard-queries').value = '[]'; await invalid.context.run('simulation');
  assert.equal(invalid.requests.length, 0); assert.match(invalid.elements.get('standard-queries').validationMessage, /one and eight/);
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(ui); const running = ui.context.run('simulation');
  ui.elements.get('value').value = '1'; finish({ ok: true, json: async () => sample() }); await running;
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('result-content').hidden, true); assert.equal(ui.elements.get('download-json').disabled, true);
});

test('deployment selection sends explicit null only to local execution and restores the call recipient on engine change', async () => {
  const ui = setup(); chooseLocal(ui);
  ui.elements.get('local-operation').value = 'create'; ui.elements.get('local-operation').dispatch('change');
  assert.equal(ui.elements.get('recipient-field').hidden, true);
  assert.equal(ui.elements.get('to').disabled, true); assert.equal(ui.elements.get('to').required, false);
  assert.equal(ui.elements.get('data-label').textContent, 'Deployment bytecode');
  await ui.context.run('simulation');
  assert.equal(ui.requests[0].url, '/api/evm/local-preview');
  assert.equal(JSON.parse(ui.requests[0].options.body).to, null);
  ui.elements.get('ethereum-engine').value = 'provider'; ui.elements.get('ethereum-engine').dispatch('change');
  assert.equal(ui.elements.get('local-operation-field').hidden, true);
  assert.equal(ui.elements.get('recipient-field').hidden, false);
  assert.equal(ui.elements.get('to').disabled, false); assert.equal(ui.elements.get('to').required, true);
  await ui.context.run('simulation');
  assert.equal(ui.requests[1].url, '/api/evm/simulate');
  assert.equal(JSON.parse(ui.requests[1].options.body).to, T);
});

test('deployment rejects blob context before dispatch and changes invalidate pending results', async () => {
  const invalid = setup(); chooseLocal(invalid); invalid.elements.get('local-operation').value = 'create';
  invalid.elements.get('transaction-context').value = JSON.stringify({ blobVersionedHashes: ['0x01' + '11'.repeat(31)] });
  await invalid.context.run('simulation'); assert.equal(invalid.requests.length, 0);
  assert.match(invalid.elements.get('transaction-context').validationMessage, /deployment cannot carry blob hashes/);
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(ui);
  const running = ui.context.run('simulation');
  assert.equal(ui.elements.get('local-operation').disabled, true);
  ui.elements.get('local-operation').value = 'create';
  finish({ ok: true, json: async () => sample() }); await running;
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true);
});

test('local exact values remain raw, identities explicit, full JSON intact, provider summaries hidden', () => {
  const ui = setup(), result = sample(); ui.context.renderLocalResult(result);
  const section = ui.elements.get('local-measurements');
  assert(section.textContent.includes(A)); assert(section.textContent.includes(T)); assert.match(section.textContent, /90071992547409939007199254740992-1/);
  assert.equal(ui.elements.get('coverage-status').textContent, '1 / 1 measured'); assert.match(ui.elements.get('local-report-status').textContent, /Complete/);
  assert.match(ui.elements.get('source-details').textContent, /unsigned_unpriced_block_end/); assert.match(ui.elements.get('result-label').textContent, /experimental/);
  assert.equal(ui.elements.get('standard-result').hidden, true); assert.doesNotMatch(section.textContent, /USD|Healthy|Safe|\$/);
  assert.deepEqual(plain(ui.state.result), result); assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
});

test('unavailable, partial, malformed and unverified rows never turn missing values into zero', () => {
  for (const mutate of [r => r.status = 'unavailable', r => r.source.canonicalStatus = 'unverified', r => r.measurements = [],
    r => r.measurements[0].status = 'unavailable', r => r.measurements[0].values[0].deltaRaw = '0', r => r.measurements[0].values[0].beforeRaw = '01',
    r => r.measurements[0].descriptor = { ...query, to: A }]) {
    const ui = setup(), result = sample(); mutate(result); ui.context.renderLocalResult(result);
    assert.equal(ui.elements.get('coverage-status').textContent, '0 / 1 measured');
    assert.equal(nodes(ui.elements.get('local-measurements')).filter(n => n.tagName === 'TABLE').length, 0);
    assert.match(ui.elements.get('local-measurements').textContent, /Unavailable/);
  }
  const ui = setup(), result = sample(); result.status = 'partial'; ui.context.renderLocalResult(result);
  assert.equal(ui.elements.get('coverage-status').textContent, '1 / 1 measured'); assert.match(ui.elements.get('local-report-status').textContent, /Partial/);
  result.status = 'unavailable'; result.execution = { status: 'unavailable', error: { code: 'STATE_UNAVAILABLE', message: 'Pinned input state is unavailable.' } };
  ui.context.renderLocalResult(result); assert.equal(ui.elements.get('execution-error').hidden, false); assert.equal(ui.elements.get('execution-error').textContent, 'Pinned input state is unavailable.');
});

test('typed identity is separate, unsafe text stays text, and a later provider result hides local rows', () => {
  const ui = setup(), result = sample(), descriptor = { kind: 'morpho_blue_position', contract: T, user: A, marketId: H };
  result.apiRequest.queries = [descriptor]; result.measurements = [{ descriptor, status: 'unavailable', reason: '<script>untrusted</script>' }];
  ui.context.renderLocalResult(result); assert(ui.elements.get('local-measurements').textContent.includes(H));
  assert(ui.elements.get('local-measurements').textContent.includes('<script>untrusted</script>'));
  assert.equal(nodes(ui.elements.get('local-measurements')).filter(n => n.tagName === 'SCRIPT').length, 0);
  ui.context.renderStandardResult({ execution: {}, source: {}, preview: {} }); assert.equal(ui.elements.get('local-result').hidden, true);
});

test('verified same-call deletion is visible without claiming the contract remains deployed', () => {
  const ui = setup(), result = sample();
  result.apiRequest.to = null;
  result.attempt = { status: 'completed', preview: { original: { output: { execution: { status: 'success' }, lifecycle: { finalizedDeletions: [{ address: T, scope: 'entire_account_including_code_and_storage' }] } } } } };
  ui.context.renderLocalResult(result);
  assert.match(ui.elements.get('source-details').textContent, /Contracts removed in this call/);
  assert(ui.elements.get('source-details').textContent.includes(T));
  assert.match(ui.elements.get('warnings-list').textContent, /do not remain deployed/);
  assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
  result.source.canonicalStatus = 'unverified';
  ui.context.renderLocalResult(result);
  assert.doesNotMatch(ui.elements.get('source-details').textContent, /Contracts removed in this call/);
  assert.doesNotMatch(ui.elements.get('warnings-list').textContent, /do not remain deployed/);
});

test('verified empty-account cleanup is visible after a reverted call and hidden when unverified', () => {
  const ui=setup(),result=sample();result.execution.status='reverted';
  result.attempt={status:'completed',preview:{original:{output:{execution:{status:'reverted'},lifecycle:{emptyAccountCleanup:{basis:'eip161_transaction_end',scope:'unsigned_message_touches_no_fee_settlement',deletions:[{address:T,scope:'entire_account_including_code_and_storage',initialStorageRoot:H}]}}}}}};
  ui.context.renderLocalResult(result);
  assert.match(ui.elements.get('source-details').textContent,/Empty accounts removed/);assert(ui.elements.get('source-details').textContent.includes(T));
  assert.doesNotMatch(ui.elements.get('source-details').textContent,/Contracts removed in this call/);
  assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent),result);
  result.source.canonicalStatus='unverified';ui.context.renderLocalResult(result);
  assert.doesNotMatch(ui.elements.get('source-details').textContent,/Empty accounts removed/);
});

test('advanced local gas defaults to omission and forwards exact bounded decimal selections', async () => {
  assert.match(html, /<details id="local-gas-settings"[^>]* hidden>/);
  assert.doesNotMatch(html.match(/<details id="local-gas-settings"[^>]*>/)[0], /\bopen\b/);
  const defaults = setup(); defaults.context.updateQueryMode();
  assert.equal(defaults.elements.get('local-gas-settings').hidden, true); assert.equal(defaults.elements.get('local-gas').disabled, true);
  chooseLocal(defaults);
  assert.equal(defaults.elements.get('local-gas-settings').hidden, false); assert.equal(defaults.elements.get('local-gas').disabled, false);
  assert.match(defaults.elements.get('local-gas-selection').textContent, /default limit: 5,000,000/);
  assert.match(defaults.elements.get('block-help').textContent, /selected gas limit/); assert.doesNotMatch(defaults.elements.get('block-help').textContent, /fixed gas/);
  await defaults.context.run('simulation'); assert.equal(Object.hasOwn(JSON.parse(defaults.requests[0].options.body), 'gas'), false);
  for (const gas of ['21000', '120000', '5000000']) {
    const ui = setup(); chooseLocal(ui); ui.elements.get('local-gas').value = gas; ui.elements.get('local-gas').dispatch('input');
    assert.equal(ui.elements.get('local-gas-selection').textContent, `Selected limit: ${BigInt(gas).toLocaleString('en-US')} gas.`);
    await ui.context.run('simulation'); assert.equal(ui.requests[0].url, '/api/evm/local-preview');
    const body = JSON.parse(ui.requests[0].options.body); assert.equal(body.gas, gas); assert.deepEqual(body.queries, [query]);
  }
  assert.match(html, /Each measurement query keeps a separate 1,000,000 gas limit/);
});

test('malformed or out-of-range local gas blocks dispatch and opens the field', async () => {
  for (const gas of ['0', '20999', '5000001', '021000', '21000.0', '2.1e4', '0x5208', '-21000', '21,000', '9'.repeat(100)]) {
    const ui = setup(); chooseLocal(ui); ui.elements.get('local-gas').value = gas;
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 0, gas);
    assert.equal(ui.elements.get('local-gas-settings').open, true); assert.match(ui.elements.get('local-gas').validationMessage, /21000 to 5000000/);
    ui.elements.get('local-gas').value = ''; ui.elements.get('local-gas').dispatch('input');
    assert.equal(ui.elements.get('local-gas').validationMessage, ''); assert.match(ui.elements.get('local-gas-selection').textContent, /default/);
  }
});

test('gas edits clear stale output, lock during dispatch, and suppress mismatched pending results', async () => {
  const edited = setup(); chooseLocal(edited); edited.context.renderLocalResult(sample());
  edited.elements.get('local-gas').value = '75000'; edited.elements.get('local-gas').dispatch('input');
  assert.equal(edited.state.result, null); assert.equal(edited.elements.get('download-json').disabled, true); assert.equal(edited.elements.get('raw-json').textContent, '');
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(ui);
  ui.elements.get('local-gas').value = '75000'; const running = ui.context.run('simulation');
  assert.equal(ui.elements.get('local-gas').disabled, true); assert.equal(JSON.parse(ui.requests[0].options.body).gas, '75000');
  ui.elements.get('local-gas').value = '76000'; finish({ ok: true, json: async () => sample() }); await running;
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true); assert.equal(ui.elements.get('local-gas').disabled, false);
});

test('gas is hidden and absent from provider, sequence, HyperEVM and historical requests', async () => {
  for (const mode of ['provider', 'sequence', 'hyper', 'historical']) {
    const ui = setup(); ui.elements.get('local-gas').value = 'invalid hidden field';
    if (mode === 'sequence') {
      ui.elements.get('ethereum-call-mode').value = 'sequence';
      ui.state.sequenceDrafts = [ui.context.newSequenceDraft({ to: T }), ui.context.newSequenceDraft({ to: A })]; ui.context.renderSequenceEditor();
    }
    if (mode === 'hyper' || mode === 'historical') ui.elements.get('chain').value = '999';
    if (mode === 'historical') ui.state.example = { transactionHash: H, request: { chainId: 999 } };
    ui.context.updateQueryMode();
    assert.equal(ui.elements.get('local-gas-settings').hidden, true); assert.equal(ui.elements.get('local-gas').disabled, true);
    await ui.context.run(mode === 'historical' ? 'historical_trace' : 'simulation');
    assert.equal(ui.requests.length, 1, mode); const body = JSON.parse(ui.requests[0].options.body);
    assert.equal(Object.hasOwn(body, 'gas'), false); for (const call of body.calls || []) assert.equal(Object.hasOwn(call, 'gas'), false);
  }
});

test('example, reset and network changes restore default gas and clear prior results', () => {
  const ui = setup(); chooseLocal(ui);
  ui.state.config.standardEvm.examples = [{ id: 'bounded', input: { ...sample().apiRequest, gas: '120000' } }, { id: 'default', input: sample().apiRequest }];
  ui.elements.get('example').value = 'bounded'; ui.context.selectExample(); assert.equal(ui.elements.get('local-gas').value, '120000');
  ui.context.renderLocalResult(sample()); ui.elements.get('example').value = 'default'; ui.context.selectExample();
  assert.equal(ui.elements.get('local-gas').value, ''); assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true);
  ui.elements.get('local-gas').value = '100000'; ui.elements.get('local-gas').setCustomValidity('old'); ui.elements.get('local-gas-settings').open = true;
  ui.elements.get('simulation-form').dispatch('reset'); assert.equal(ui.elements.get('local-gas').value, ''); assert.equal(ui.elements.get('local-gas').validationMessage, '');
  assert.equal(ui.elements.get('local-gas-settings').open, false); assert.match(ui.elements.get('local-gas-selection').textContent, /default/);
  ui.elements.get('local-gas').value = '100000'; ui.elements.get('example').value = ''; ui.context.selectExample(); assert.equal(ui.elements.get('local-gas').value, '');
  ui.elements.get('local-gas').value = '100000'; ui.elements.get('chain').value = '999'; ui.context.selectNetwork(); assert.equal(ui.elements.get('local-gas').value, '');
  assert.equal(ui.elements.get('local-gas-settings').hidden, true); assert.equal(ui.elements.get('local-gas').disabled, true);
});

test('local result shows its retained gas limit rather than the current form value', () => {
  const ui = setup(); chooseLocal(ui); ui.elements.get('local-gas').value = '90000';
  const result = sample(); result.apiRequest.gas = '120000'; ui.context.renderLocalResult(result);
  assert.equal(ui.elements.get('gas-used').textContent, 'Gas limit: 120,000 · network fees excluded');
  assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
  delete result.apiRequest.gas; ui.context.renderLocalResult(result); assert.match(ui.elements.get('gas-used').textContent, /5,000,000/);
  result.apiRequest.gas = '0x123'; ui.context.renderLocalResult(result); assert.match(ui.elements.get('gas-used').textContent, /Not available/);
});

const feeProfile = 'unsigned_eip1559_block_end';
function enableFees(ui, max = '100', priority = '2') {
  ui.elements.get('local-fees-enabled').checked = true; ui.elements.get('local-fees-enabled').dispatch('change');
  ui.elements.get('local-max-fee').value = max; ui.elements.get('local-priority-fee').value = priority;
}
function feeSample() {
  const result = sample(); result.apiRequest.gas = '50000'; result.apiRequest.executionProfile = feeProfile;
  result.apiRequest.fees = { maxFeePerGas: '100', maxPriorityFeePerGas: '2' };
  result.source.profile = feeProfile; result.source.blockSelection.header = { baseFeePerGas: '0xa', miner: T };
  result.attempt = { status: 'completed', preview: { original: { output: {
    execution: { status: 'success' }, profile: { executionProfile: feeProfile, fees: { ...result.apiRequest.fees },
      declaredGasLimit: '50000', executionBaseFee: '10', gasPrice: '12', feesSettled: true }, gasAccounting: { gasUsed: '21000' },
    feeAccounting: { kind: 'eip1559', gasLimit: '50000', effectiveGasPrice: '12', baseFeePerGas: '10', priorityFeePerGas: '2',
      maximumRequiredBalance: '5000000', upfrontGasDebit: '600000', chargedGas: '21000', gasCharge: '252000', senderRefund: '348000',
      baseFeeBurn: '210000', coinbaseTip: '42000', coinbase: T },
  } } } };
  return result;
}

test('fees opt in only for local mode and leave default and provider payloads unchanged', async () => {
  assert.match(html, /id="local-fees-enabled" type="checkbox"[^>]*disabled/);
  assert.doesNotMatch(html.match(/<input id="local-fees-enabled"[^>]*>/)[0], /\bchecked\b/);
  const local = setup(); chooseLocal(local);
  assert.equal(local.elements.get('local-fee-settings').hidden, false); assert.equal(local.elements.get('local-fees-enabled').checked, false);
  assert.equal(local.elements.get('local-max-fee').disabled, true); await local.context.run('simulation');
  assert.equal(Object.hasOwn(JSON.parse(local.requests[0].options.body), 'fees'), false);
  const priced = setup(); chooseLocal(priced); enableFees(priced, '9007199254740993', '0');
  assert.equal(priced.elements.get('local-max-fee').required, true); assert.equal(priced.elements.get('local-priority-fee').required, true);
  await priced.context.run('simulation'); const request = JSON.parse(priced.requests[0].options.body);
  assert.equal(request.executionProfile, feeProfile); assert.deepEqual(request.fees, { maxFeePerGas: '9007199254740993', maxPriorityFeePerGas: '0' });
  assert.deepEqual(request.queries, [query]);
  for (const mode of ['provider', 'sequence', 'hyper', 'historical']) {
    const ui = setup(); enableFees(ui, 'invalid hidden field', '');
    ui.elements.get('local-max-blob-fee').value = 'invalid hidden blob cap';
    if (mode === 'sequence') { ui.elements.get('ethereum-call-mode').value = 'sequence'; ui.state.sequenceDrafts = [ui.context.newSequenceDraft({ to: T }), ui.context.newSequenceDraft({ to: A })]; ui.context.renderSequenceEditor(); }
    if (mode === 'hyper' || mode === 'historical') ui.elements.get('chain').value = '999';
    if (mode === 'historical') ui.state.example = { transactionHash: H, request: { chainId: 999 } };
    ui.context.updateQueryMode(); assert.equal(ui.elements.get('local-fee-settings').hidden, true);
    await ui.context.run(mode === 'historical' ? 'historical_trace' : 'simulation');
    const body = JSON.parse(ui.requests[0].options.body);
    for (const row of [body, ...(body.calls || [])]) { assert.equal(Object.hasOwn(row, 'fees'), false); assert.equal(Object.hasOwn(row, 'executionProfile'), false); }
  }
});

test('both canonical fee inputs and their relationship are checked before dispatch, including the required blob cap', async () => {
  for (const pair of [['', ''], ['100', ''], ['', '0'], ['01', '0'], ['100', '101'], ['0x10', '0'], ['1e9', '0'], ['1,000', '0'], [(1n << 256n).toString(), '0'], ['100', '-1']]) {
    const ui = setup(); chooseLocal(ui); enableFees(ui, ...pair); await ui.context.run('simulation');
    assert.equal(ui.requests.length, 0); assert.equal(ui.elements.get('local-fee-settings').open, true); assert.notEqual(ui.elements.get('local-max-fee').validationMessage, '');
    ui.elements.get('local-max-fee').dispatch('input'); assert.equal(ui.elements.get('local-max-fee').validationMessage, '');
  }
  const ui = setup(); chooseLocal(ui); enableFees(ui);
  ui.elements.get('transaction-context').value = JSON.stringify({ blobVersionedHashes: ['0x01' + '11'.repeat(31)] });
  await ui.context.run('simulation'); assert.equal(ui.requests.length, 0); assert.match(ui.elements.get('local-max-fee').validationMessage, /Blob hashes require/);
  ui.elements.get('local-fees-enabled').checked = false; ui.elements.get('local-fees-enabled').dispatch('change');
  assert.equal(ui.elements.get('transaction-context').validationMessage, ''); await ui.context.run('simulation'); assert.equal(ui.requests.length, 1);
});

test('fee toggles and amounts clear stale results, lock while busy and fingerprint pending responses', async () => {
  const edited = setup(); chooseLocal(edited); edited.context.renderLocalResult(feeSample()); enableFees(edited);
  assert.equal(edited.state.result, null); assert.equal(edited.elements.get('download-json').disabled, true);
  edited.context.renderLocalResult(feeSample()); edited.elements.get('local-priority-fee').dispatch('input'); assert.equal(edited.state.result, null);
  let finish; const ui = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(ui); enableFees(ui);
  const pending = ui.context.run('simulation'); for (const id of ['local-fees-enabled', 'local-max-fee', 'local-priority-fee']) assert.equal(ui.elements.get(id).disabled, true);
  ui.elements.get('local-fees-enabled').checked = false; finish({ ok: true, json: async () => feeSample() }); await pending;
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('local-fees-enabled').disabled, false); assert.equal(ui.elements.get('local-max-fee').disabled, true);
});

test('fee example and reset paths restore the explicit mode without leaking into other networks', () => {
  const ui = setup(); chooseLocal(ui);
  ui.state.config.standardEvm.examples = [{ id: 'priced', input: feeSample().apiRequest }, { id: 'plain', input: sample().apiRequest }];
  ui.elements.get('example').value = 'priced'; ui.context.selectExample(); assert.equal(ui.elements.get('local-fees-enabled').checked, true); assert.equal(ui.elements.get('local-max-fee').value, '100');
  ui.context.renderLocalResult(feeSample()); ui.elements.get('example').value = 'plain'; ui.context.selectExample();
  assert.equal(ui.elements.get('local-fees-enabled').checked, false); assert.equal(ui.elements.get('local-max-fee').value, ''); assert.equal(ui.state.result, null);
  enableFees(ui); ui.elements.get('local-max-fee').setCustomValidity('old'); ui.elements.get('local-fee-settings').open = true;
  ui.elements.get('simulation-form').dispatch('reset'); assert.equal(ui.elements.get('local-fees-enabled').checked, false);
  assert.equal(ui.elements.get('local-max-fee').validationMessage, ''); assert.equal(ui.elements.get('local-max-fee').required, false); assert.equal(ui.elements.get('local-fee-settings').open, false);
  enableFees(ui); ui.elements.get('chain').value = '999'; ui.context.selectNetwork(); assert.equal(ui.elements.get('local-fees-enabled').checked, false); assert.equal(ui.elements.get('local-fee-settings').hidden, true);
});

test('fee labels use only complete validated retained accounting, including genuine failed execution', () => {
  const ui = setup(); chooseLocal(ui); enableFees(ui, '999', '999');
  for (const status of ['success', 'reverted', 'failed']) {
    const result = feeSample(); result.execution.status = status; result.attempt.preview.original.output.execution.status = status;
    ui.context.renderLocalResult(result);
    assert.equal(ui.elements.get('gas-used').textContent, 'Gas limit: 50,000 · simulated fee: 252,000 wei');
    assert.match(ui.elements.get('source-details').textContent, /Fee charged in simulation · wei252000/);
    assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
  }
  for (const mutate of [r => { r.status = 'unavailable'; }, r => { r.source.canonicalStatus = 'unverified'; }, r => { r.attempt.status = 'unavailable'; },
    r => { r.attempt.preview.original.output.profile.feesSettled = false; }, r => { r.execution.status = 'unavailable'; },
    r => { r.apiRequest.fees.maxFeePerGas = '99'; }, r => { r.source.blockSelection.header.baseFeePerGas = '0xb'; },
    r => { r.attempt.preview.original.output.feeAccounting.gasCharge = '252001'; }, r => { r.attempt.preview.original.output.feeAccounting.gasCharge = 252000; },
    r => { r.attempt.preview.original.output.feeAccounting.senderRefund = '-1'; }, r => { r.attempt.preview.original.output.feeAccounting.coinbase = A; },
    r => { r.attempt.preview.original.output.feeAccounting.coinbase = { toString: null }; },
    r => { r.attempt.preview.original.output.gasAccounting.gasUsed = '21001'; }, r => { r.attempt.preview.original.output.profile.gasPrice = '0'; }]) {
    const result = feeSample(); mutate(result); ui.context.renderLocalResult(result);
    assert.match(ui.elements.get('gas-used').textContent, /fee result unavailable/); assert.doesNotMatch(ui.elements.get('source-details').textContent, /Fee charged in simulation/);
    assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
  }
  ui.context.renderLocalResult(sample()); assert.match(ui.elements.get('gas-used').textContent, /network fees excluded/);
});

test('priced cleanup is labeled only with its matching completed fee context', () => {
  const ui = setup(), result = feeSample();
  result.attempt.preview.original.output.lifecycle = { emptyAccountCleanup: { basis: 'eip161_transaction_end', scope: 'unsigned_eip1559_transaction_touches',
    deletions: [{ address: T, scope: 'entire_account_including_code_and_storage', initialStorageRoot: H }] } };
  ui.context.renderLocalResult(result); assert.match(ui.elements.get('source-details').textContent, /Empty accounts removed/);
  result.attempt.preview.original.output.feeAccounting.gasCharge = '0'; ui.context.renderLocalResult(result);
  assert.doesNotMatch(ui.elements.get('source-details').textContent, /Empty accounts removed/);
});

const blobProfile = 'unsigned_eip4844_block_end', blobHash = '0x01' + '44'.repeat(31);
const blobForks = { cancun: [1710338135n, 6, 6, 3338477n], prague: [1746612311n, 9, 9, 5007716n],
  osaka: [1764798551n, 9, 6, 5007716n], bpo1: [1765290071n, 15, 6, 8346193n], bpo2: [1767747671n, 21, 6, 11684671n] };
// Synthetic retained response, not a recorded public-chain or browser result.
function blobSample({ fork = 'osaka', excess = 0n, count = 1, used = 0n } = {}) {
  const result = feeSample(), output = result.attempt.preview.original.output, rule = blobForks[fork];
  const header = { hash: H, stateRoot: '0x' + '55'.repeat(32), number: '0x191c9e0', timestamp: '0x' + rule[0].toString(16),
    miner: T, gasLimit: '0x1c9c380', baseFeePerGas: '0xa', excessBlobGas: '0x' + excess.toString(16), blobGasUsed: '0x' + used.toString(16) };
  const blob = ethereumBlobContext(header), blobGas = BigInt(count) * 131072n, burn = blobGas * blob.blobBaseFeePerGas;
  result.apiRequest.executionProfile = result.source.profile = output.profile.executionProfile = blobProfile;
  result.apiRequest.fees.maxFeePerBlobGas = '100'; output.profile.fees = { ...result.apiRequest.fees };
  result.apiRequest.blobVersionedHashes = Array.from({ length: count }, (_, i) => '0x01' + (44 + i).toString(16).repeat(31));
  result.source.blockSelection = { requested: H, blockHash: H, blockNumber: BigInt(header.number).toString(), header,
    headerVerification: { status: 'verified', blockHash: H, stateRoot: header.stateRoot, number: BigInt(header.number).toString(), timestamp: rule[0].toString(), hardfork: fork } };
  Object.assign(output.profile, { name: 'ethereum_unsigned_eip4844_call', chainId: 1, hardfork: fork,
    forkSchedule: 'pinned_ethereumjs_common_10.1.3_mainnet', sourceBlockHash: H, sourceStateRoot: header.stateRoot,
    actualBlockBaseFee: '10', executionBlobBaseFee: blob.blobBaseFeePerGas.toString(), sourceExcessBlobGas: excess.toString(),
    blobVersionedHashes: [...result.apiRequest.blobVersionedHashes] });
  Object.assign(output.feeAccounting, { kind: 'eip4844', maximumRequiredBalance: (5000000n + blobGas * 100n).toString(),
    blobCount: String(count), blobGasUsed: blobGas.toString(), maxFeePerBlobGas: '100', blobBaseFeePerGas: blob.blobBaseFeePerGas.toString(), blobFeeBurn: burn.toString(),
    totalUpfrontDebit: (600000n + burn).toString(), totalFeeCharge: (252000n + burn).toString(), totalFeeBurn: (210000n + burn).toString() });
  return result;
}
function enterBlobFees(ui, cap = '100', hashes = [blobHash]) {
  enableFees(ui); ui.elements.get('local-max-blob-fee').value = cap;
  ui.elements.get('transaction-context').value = JSON.stringify({ blobVersionedHashes: hashes });
}

test('blob pricing selects only the local profile; missing, malformed, stray and excessive blob caps or counts do not dispatch', async () => {
  const ui = setup(); chooseLocal(ui); enterBlobFees(ui, '9007199254740993'); await ui.context.run('simulation');
  const body = JSON.parse(ui.requests[0].options.body); assert.equal(body.executionProfile, blobProfile);
  assert.deepEqual(body.fees, { maxFeePerGas: '100', maxPriorityFeePerGas: '2', maxFeePerBlobGas: '9007199254740993' });
  assert.deepEqual(body.blobVersionedHashes, [blobHash]); assert.deepEqual(body.queries, [query]);
  for (const cap of ['', '01', '-1', '0x1', '1.0', '1e3', (1n << 256n).toString()]) {
    const bad = setup(); chooseLocal(bad); enterBlobFees(bad, cap); await bad.context.run('simulation'); assert.equal(bad.requests.length, 0, cap);
  }
  const stray = setup(); chooseLocal(stray); enableFees(stray); stray.elements.get('local-max-blob-fee').value = '100';
  await stray.context.run('simulation'); assert.equal(stray.requests.length, 0); assert.match(stray.elements.get('local-max-fee').validationMessage, /requires blob versioned hashes/);
  for (const count of [9, 10]) {
    const countUi = setup(); chooseLocal(countUi); enterBlobFees(countUi, '100', Array(count).fill(blobHash)); await countUi.context.run('simulation');
    assert.equal(countUi.requests.length, count === 9 ? 1 : 0);
  }
  const unpriced = setup(); chooseLocal(unpriced); enterBlobFees(unpriced, 'invalid');
  unpriced.elements.get('local-fees-enabled').checked = false; unpriced.elements.get('local-fees-enabled').dispatch('change');
  await unpriced.context.run('simulation'); const plainBody = JSON.parse(unpriced.requests[0].options.body);
  assert.equal(Object.hasOwn(plainBody, 'fees'), false); assert.equal(Object.hasOwn(plainBody, 'executionProfile'), false); assert.deepEqual(plainBody.blobVersionedHashes, [blobHash]);
});

test('blob fee field participates in reset, examples, busy locks, stale invalidation and pending fingerprints', async () => {
  const ui = setup(); chooseLocal(ui); enterBlobFees(ui); ui.context.renderLocalResult(blobSample());
  ui.elements.get('local-max-blob-fee').dispatch('input'); assert.equal(ui.state.result, null); assert.equal(ui.elements.get('download-json').disabled, true);
  ui.state.config.standardEvm.examples = [{ id: 'blob', input: blobSample().apiRequest }, { id: 'plain', input: sample().apiRequest }];
  ui.elements.get('example').value = 'blob'; ui.context.selectExample(); assert.equal(ui.elements.get('local-max-blob-fee').value, '100'); assert.equal(ui.elements.get('local-fees-enabled').checked, true);
  ui.elements.get('example').value = 'plain'; ui.context.selectExample(); assert.equal(ui.elements.get('local-max-blob-fee').value, '');
  enterBlobFees(ui); ui.elements.get('local-max-blob-fee').setCustomValidity('old'); ui.elements.get('simulation-form').dispatch('reset');
  assert.equal(ui.elements.get('local-max-blob-fee').value, ''); assert.equal(ui.elements.get('local-max-blob-fee').validationMessage, ''); assert.equal(ui.elements.get('local-max-blob-fee').disabled, true);
  let finish; const pending = setup(() => new Promise(resolve => { finish = resolve; })); chooseLocal(pending); enterBlobFees(pending);
  const running = pending.context.run('simulation'); assert.equal(pending.elements.get('local-max-blob-fee').disabled, true);
  pending.elements.get('local-max-blob-fee').value = '101'; finish({ ok: true, json: async () => blobSample() }); await running;
  assert.equal(pending.state.result, null); assert.equal(pending.elements.get('local-max-blob-fee').disabled, false);
  pending.elements.get('chain').value = '999'; pending.context.selectNetwork(); assert.equal(pending.elements.get('local-max-blob-fee').value, ''); assert.equal(pending.elements.get('local-max-blob-fee').disabled, true);
});

test('all pinned blob forks use exact integer pricing and retained execution, blob burn and total amounts', () => {
  const ui = setup(); chooseLocal(ui); enterBlobFees(ui, '999999');
  for (const [fork, rule] of Object.entries(blobForks)) for (const [multiple, expectedPrice] of [[0n, 1n], [1n, 2n], [2n, 7n], [3n, 20n]]) {
    const result = blobSample({ fork, excess: rule[3] * multiple, count: rule[2], used: BigInt(rule[1]) * 131072n });
    const fee = result.attempt.preview.original.output.feeAccounting; assert.equal(fee.blobBaseFeePerGas, expectedPrice.toString());
    assert.deepEqual(plain(ui.context.localFeeAccounting(result)), fee, fork);
    ui.context.renderLocalResult(result);
    assert.match(ui.elements.get('gas-used').textContent, /execution fee: 252,000 wei · blob burn: .* wei · total fee:/);
    assert(ui.elements.get('source-details').textContent.includes('Blob fee burned · wei' + fee.blobFeeBurn));
    assert(ui.elements.get('source-details').textContent.includes('Total fee charged · wei' + fee.totalFeeCharge));
    assert.match(ui.elements.get('source-details').textContent, /Block beneficiary tip · wei42000/);
    assert.match(ui.elements.get('warnings-list').textContent, /Sidecars, KZG proofs and inclusion are not checked/);
  }
  for (const status of ['success', 'reverted', 'failed']) {
    const result = blobSample(); result.execution.status = result.attempt.preview.original.output.execution.status = status; result.status = 'partial';
    assert.notEqual(ui.context.localFeeAccounting(result), null); ui.context.renderLocalResult(result); assert.match(ui.elements.get('gas-used').textContent, /blob burn: 131,072 wei/);
  }
});

test('blob fee displays reject malformed arithmetic, identities, fork limits, unbounded price and lost final-header binding', () => {
  const ui = setup(), mutate = [
    r => { r.source.canonicalStatus = 'unverified'; }, r => { r.status = 'unavailable'; }, r => { r.attempt.status = 'unavailable'; },
    r => { r.attempt.preview.original.output.profile.feesSettled = false; }, r => { r.attempt.preview.original.output.execution.status = 'invalid'; },
    r => { r.source.profile = feeProfile; }, r => { r.apiRequest.executionProfile = feeProfile; },
    r => { r.apiRequest.to = null; }, r => { r.apiRequest.authorizationList = []; }, r => { r.apiRequest.fees.extra = '1'; },
    r => { r.apiRequest.fees.maxFeePerBlobGas = '0'; }, r => { r.apiRequest.blobVersionedHashes = []; },
    r => { r.apiRequest.blobVersionedHashes[0] = '0x02' + '44'.repeat(31); }, r => { r.apiRequest.blobVersionedHashes[0] = { toString: null }; },
    r => { r.attempt.preview.original.output.profile.blobVersionedHashes.reverse(); },
    r => { r.source.blockSelection.headerVerification.hardfork = 'prague'; }, r => { r.source.blockSelection.headerVerification.status = 'unverified'; },
    r => { r.attempt.preview.original.output.profile.hardfork = 'shanghai'; }, r => { r.attempt.preview.original.output.profile.forkSchedule = 'other'; },
    r => { r.source.blockSelection.header.hash = '0x' + '66'.repeat(32); }, r => { r.source.blockSelection.headerVerification.stateRoot = H; },
    r => { r.source.blockSelection.headerVerification.number = '1'; }, r => { r.source.blockSelection.headerVerification.timestamp = '1'; },
    r => { r.source.blockSelection.requested = 'latest'; }, r => { r.apiRequest.block = '0x1'; },
    r => { r.source.blockSelection.header.excessBlobGas = '0x1'; }, r => { r.source.blockSelection.header.blobGasUsed = '0x1'; },
    r => { r.source.blockSelection.header.blobGasUsed = '0x140000'; }, r => { r.source.blockSelection.header.excessBlobGas = '0x10000000000000000'; },
    r => { r.source.blockSelection.header.excessBlobGas = '0xffffffffffffffff'; r.attempt.preview.original.output.profile.sourceExcessBlobGas = '18446744073709551615'; },
    r => { r.source.blockSelection.header.gasLimit = '0x5208'; }, r => { r.source.blockSelection.header.baseFeePerGas = '0xb'; },
    r => { r.attempt.preview.original.output.profile.executionBlobBaseFee = '2'; }, r => { r.attempt.preview.original.output.profile.sourceBlockHash = '0x' + '66'.repeat(32); },
    r => { r.attempt.preview.original.output.feeAccounting.coinbase = { toString: null }; }, r => { r.attempt.preview.original.output.feeAccounting.blobFeeBurn = { toString: null }; },
  ];
  for (const key of ['maximumRequiredBalance', 'upfrontGasDebit', 'chargedGas', 'gasCharge', 'senderRefund', 'baseFeeBurn', 'coinbaseTip', 'blobCount', 'blobGasUsed', 'maxFeePerBlobGas', 'blobBaseFeePerGas', 'blobFeeBurn', 'totalUpfrontDebit', 'totalFeeCharge', 'totalFeeBurn']) {
    mutate.push(r => { const f = r.attempt.preview.original.output.feeAccounting; f[key] = (BigInt(f[key]) + 1n).toString(); });
  }
  for (const change of mutate) {
    const result = blobSample({ count: 2 }); change(result); ui.context.renderLocalResult(result);
    assert.match(ui.elements.get('gas-used').textContent, /fee result unavailable/, change.toString());
    assert.doesNotMatch(ui.elements.get('source-details').textContent, /Blob fee burned|Total fee charged|Execution fee charged/);
    assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), result);
  }
  for (const fork of ['cancun', 'osaka', 'bpo1', 'bpo2']) assert.equal(ui.context.localFeeAccounting(blobSample({ fork, count: 7 })), null, fork);
  const early = blobSample(); early.source.blockSelection.header.timestamp = '0x0'; assert.equal(ui.context.localFeeAccounting(early), null);
});

test('blob cleanup requires validated blob fee scope and loses its label when fee evidence fails', () => {
  const ui = setup(), result = blobSample(); result.attempt.preview.original.output.lifecycle = { emptyAccountCleanup: {
    basis: 'eip161_transaction_end', scope: 'unsigned_eip4844_transaction_touches', deletions: [{ address: T, scope: 'entire_account_including_code_and_storage', initialStorageRoot: H }] } };
  ui.context.renderLocalResult(result); assert.match(ui.elements.get('source-details').textContent, /Empty accounts removed/);
  result.attempt.preview.original.output.lifecycle.emptyAccountCleanup.scope = 'unsigned_eip1559_transaction_touches';
  ui.context.renderLocalResult(result); assert.doesNotMatch(ui.elements.get('source-details').textContent, /Empty accounts removed/);
  result.attempt.preview.original.output.lifecycle.emptyAccountCleanup.scope = 'unsigned_eip4844_transaction_touches'; result.attempt.preview.original.output.feeAccounting.blobFeeBurn = '0';
  ui.context.renderLocalResult(result); assert.doesNotMatch(ui.elements.get('source-details').textContent, /Empty accounts removed/);
});

test('actual offline blob API response renders validated totals; canonical recheck failure withholds them', async () => {
  const [{ blobFeeFixture, TARGET, TX_SENDER }, { simulateLocal }, { ProofRpcClient }] = await Promise.all([
    import('../engines/local-evm/test/blob-fee-fixture.js'), import('../src/local-simulation.js'), import('../src/proof-rpc.js'),
  ]);
  for (const failFinal of [false, true]) {
    const f = await blobFeeFixture({ fork: 'bpo2', excessBlobGas: 11684671n, blobCount: 2 }), ui = setup(); let headers = 0;
    const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); let result;
      if (request.method === 'eth_chainId') result = '0x1';
      else if (request.method.startsWith('eth_getBlock')) result = ++headers > 1 && failFinal ? { ...f.header, transactions: [] } : f.header;
      else result = await f.rpc.call(request.method, request.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } });
    const report = await simulateLocal({ chainId: 1, ...f.request, block: f.header.hash,
      queries: [{ to: TARGET, data: '0x70a08231' + TX_SENDER.slice(2).padStart(64, '0') }] }, rpc);
    ui.context.renderLocalResult(report);
    if (failFinal) { assert.equal(report.source.canonicalStatus, 'unverified'); assert.match(ui.elements.get('gas-used').textContent, /fee result unavailable/); assert.equal(ui.elements.get('coverage-status').textContent, '0 / 1 measured'); }
    else { assert.equal(report.source.canonicalStatus, 'verified'); assert.deepEqual(plain(ui.context.localFeeAccounting(report)), report.attempt.preview.original.output.feeAccounting); assert.match(ui.elements.get('gas-used').textContent, /blob burn: 524,288 wei/); }
  }
});
