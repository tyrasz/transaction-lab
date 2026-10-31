import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { compilePreviewQueries } from '../engines/local-evm/preview-queries.js';

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

const native = { kind: 'native_balance', account: A };
const feeProfile = 'unsigned_eip1559_block_end';
const clone = value => structuredClone(value);
function sample({ chainId = 1, priced = false } = {}) {
  const calls = [T, A].map(to => ({ to, data: '0x', value: '0', gas: '50000', ...(priced ? { executionProfile: feeProfile, fees: { maxFeePerGas: '100', maxPriorityFeePerGas: '2' } } : {}) }));
  const profileName = priced ? feeProfile : 'unsigned_unpriced_block_end';
  const fork = chainId === 1 ? 'osaka' : 'amsterdam', schedule = chainId === 1 ? 'pinned_ethereumjs_common_10.1.3_mainnet' : 'pinned_ethereumjs_common_10.1.3_sepolia_amsterdam_1791294816';
  const raw = calls.map((call, index) => {
    const beforeRaw = index === 0 ? '9007199254740993000000000' : '9007199254740992999748000';
    const afterRaw = (BigInt(beforeRaw) - (priced ? 252000n : BigInt(index + 1))).toString();
    const measurement = { ...clone(compilePreviewQueries([native], { chainId })[0]), status: 'measured', reason: null,
      values: [{ name: 'balance', beforeRaw, afterRaw, deltaRaw: (BigInt(afterRaw) - BigInt(beforeRaw)).toString(), unit: { kind: 'native_wei', scale: '1000000000000000000' } }] };
    const output = { execution: { status: 'success', gasUsed: '21000' }, profile: { chainId, hardfork: fork, forkSchedule: schedule, executionProfile: profileName,
      declaredGasLimit: '50000', ...(priced ? { fees: clone(call.fees), executionBaseFee: '10', gasPrice: '12', feesSettled: true } : {}) }, gasAccounting: { gasUsed: '21000' } };
    if (priced) output.feeAccounting = { kind: 'eip1559', gasLimit: '50000', effectiveGasPrice: '12', baseFeePerGas: '10', priorityFeePerGas: '2',
      maximumRequiredBalance: '5000000', upfrontGasDebit: '600000', chargedGas: '21000', gasCharge: '252000', senderRefund: '348000', baseFeeBurn: '210000', coinbaseTip: '42000', coinbase: T };
    return { index, request: { from: A, ...call }, status: 'completed', reason: null, original: { output }, measurements: [measurement] };
  });
  return { kind: 'local_proof_sequence', schemaVersion: '1.0', id: 'offline-sequence-ui', status: 'complete', error: null,
    apiRequest: { chainId, from: A, block: H, calls, queries: [native] },
    source: { kind: 'proof_backed_owned_execution', chainId, profile: 'ordered_unsigned_same_header_sequence', executionProfiles: [profileName, profileName], canonicalStatus: 'verified',
      blockSelection: { requested: H, blockHash: H, blockNumber: '10', header: { hash: H, miner: T, baseFeePerGas: '0xa' }, headerVerification: { status: 'verified', chainId, hardfork: fork, forkSchedule: schedule } } },
    steps: raw.map(step => ({ index: step.index, request: clone(step.request), status: step.status, reason: step.reason, execution: clone(step.original.output.execution),
      measurements: step.measurements.map((row, index) => ({ index, ...Object.fromEntries(['descriptor', 'query', 'identity', 'returnBytes', 'status', 'reason', 'values'].map(key => [key, clone(row[key])])) })) })),
    attempt: { status: 'completed', sequence: { status: 'complete', steps: raw } }, timing: { totalMs: 10 } };
}
function ordered(ui, { chainId = 1, calls = [{ to: T }, { to: A }] } = {}) {
  ui.state.config.localEvm.capabilities = { chainIds: [1, 11155111] };
  ui.state.config.localEvm.sequenceCapabilities = { available: true };
  ui.elements.get('chain').value = String(chainId); ui.elements.get('ethereum-engine').value = 'local';
  ui.elements.get('ethereum-call-mode').value = 'sequence';
  ui.elements.get('standard-queries').value = JSON.stringify([native]);
  ui.state.sequenceDrafts = calls.map(call => ui.context.newSequenceDraft(call));
  ui.context.renderSequenceEditor(); ui.context.updateQueryMode();
}
const tables = ui => ui.elements.get('local-measurements').children.flatMap(card => card.children.filter(child => child.tagName === 'TABLE'));
const render = (ui, report) => { ui.context.report = report; vm.runInContext('renderLocalSequenceResult(report)', ui.context); };

test('local ordered mode is capability gated on both trusted networks and shares explicit queries', async () => {
  for (const chainId of [1, 11155111]) {
    const ui = setup(); ordered(ui, { chainId });
    assert.equal(ui.elements.get('ethereum-call-mode').disabled, false); assert.equal(ui.elements.get('standard-query-settings').hidden, false);
    assert.equal(ui.elements.get('local-gas-settings').hidden, true); assert.equal(ui.elements.get('local-fee-settings').hidden, true);
    assert(ui.state.sequenceControls.every(row => row.advanced.hidden && row.queries.disabled));
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].url, '/api/evm/local-sequence');
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), { chainId, from: A, block: H, calls: [{ to: T, data: '0x', value: '0' }, { to: A, data: '0x', value: '0' }], queries: [native] });
    ui.state.config.localEvm.sequenceCapabilities.available = false; ui.context.updateQueryMode();
    assert.equal(ui.elements.get('sequence-mode-option').disabled, true); await ui.context.run('simulation'); assert.equal(ui.requests.length, 1);
  }
});

test('per-step gas, fees, ordered access lists, blobs and authorizations are not dropped or pooled', async () => {
  const tuple = { chainId: '0x0', address: T, nonce: '0x0', yParity: '0x0', r: '0x1', s: '0x1' };
  const accessList = [{ address: T, storageKeys: [H, H] }, { address: T, storageKeys: [] }];
  const calls = [{ to: T, gas: '60000', accessList, authorizationList: [tuple, tuple], executionProfile: feeProfile, fees: { maxFeePerGas: '100', maxPriorityFeePerGas: '2' } },
    { to: A, gas: '70000', blobVersionedHashes: ['0x01' + '55'.repeat(31)], executionProfile: 'unsigned_eip4844_block_end', fees: { maxFeePerGas: '110', maxPriorityFeePerGas: '3', maxFeePerBlobGas: '4' } },
    { to: null, gas: '80000', data: '0x6000' }];
  const ui = setup(); ordered(ui, { calls }); await ui.context.run('simulation');
  assert.deepEqual(JSON.parse(ui.requests[0].options.body).calls, calls.map(call => ({ data: '0x', value: '0', ...call })));
  assert.equal(Object.hasOwn(JSON.parse(ui.requests[0].options.body), 'fees'), false);
});

test('invalid per-step or shared input fails before dispatch without silently stripping fields', async () => {
  for (const context of [{ from: A }, { block: 'latest' }, { queries: [native] }, { gas: 21000 }, { gas: '020000' }, { gas: '' },
    { executionProfile: feeProfile }, { fees: {} }, { authorizationList: [{}] }, { executionProfile: feeProfile, fees: { maxFeePerGas: '1', maxPriorityFeePerGas: '2' } }]) {
    const ui = setup(); ordered(ui); ui.state.sequenceControls[0].context.value = JSON.stringify(context);
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 0, JSON.stringify(context)); assert(ui.state.sequenceControls[0].context.validationMessage);
  }
  for (const queries of [[], Array(9).fill(native), [native, native]]) {
    const ui = setup(); ordered(ui); ui.elements.get('standard-queries').value = JSON.stringify(queries);
    await ui.context.run('simulation'); assert.equal(ui.requests.length, 0);
  }
});

test('each step renders exact native values separately and keeps the full raw sequence on selection', () => {
  for (const chainId of [1, 11155111]) {
    const ui = setup(), report = sample({ chainId }); ordered(ui, { chainId }); render(ui, report);
    assert.equal(tables(ui).length, 1); assert.match(ui.elements.get('local-measurements').textContent, /9007199254740993000000000 wei/);
    assert.match(ui.elements.get('local-measurements').textContent, chainId === 1 ? /9007199.254740993 ETH/ : /9007199.254740993 test ETH/);
    assert.doesNotMatch(ui.elements.get('sequence-step-list').textContent, /9007199/);
    ui.state.sequenceStepButtons[1].button.dispatch('click'); assert.equal(tables(ui).length, 1);
    assert.match(ui.elements.get('local-measurements').textContent, /9007199254740992999748000 wei/);
    assert.equal(ui.elements.get('sequence-result').hidden, false); assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), report);
    assert.deepEqual(plain(ui.state.result), report); assert.match(ui.elements.get('sequence-step-notice').textContent, /not combined/);
  }
});

test('priced step accounting uses that step only; revert measurements remain distinct from skipped calls', () => {
  const ui = setup(), report = sample({ priced: true }); ordered(ui); render(ui, report);
  assert.match(ui.elements.get('gas-used').textContent, /simulated fee: 252,000 wei/);
  assert.match(ui.elements.get('local-measurements').textContent, /include the simulated transaction fees/);
  report.status = report.attempt.sequence.status = 'partial';
  report.steps[0].execution.status = report.attempt.sequence.steps[0].original.output.execution.status = 'reverted';
  report.steps[1].status = report.attempt.sequence.steps[1].status = 'not_attempted'; report.steps[1].execution = { status: 'not_attempted' };
  report.steps[1].reason = 'Earlier call reverted'; report.attempt.sequence.steps[1].original = null;
  render(ui, report); assert.equal(ui.elements.get('execution-status').textContent, 'Reverted'); assert.equal(tables(ui).length, 1);
  ui.state.sequenceStepButtons[1].button.dispatch('click'); assert.equal(tables(ui).length, 0); assert.equal(ui.elements.get('execution-status').textContent, 'Not attempted');
  assert.doesNotMatch(ui.elements.get('gas-used').textContent, /252,000/);
});

test('unavailable, forged context, changed projection, bad unit and failed query never expose measured amounts', () => {
  const mutations = [r => { r.status = 'unavailable'; }, r => { r.source.canonicalStatus = 'unverified'; },
    r => { r.attempt.status = 'unavailable'; r.attempt.sequence = null; }, r => { r.source.chainId = 11155111; },
    r => { r.steps[0].index = 1; }, r => { r.steps[0].request.from = T; }, r => { r.steps[0].measurements[0].values[0].beforeRaw = '1'; },
    r => { for (const row of [r.steps[0].measurements[0], r.attempt.sequence.steps[0].measurements[0]]) row.values[0].unit.scale = '1'; },
    r => { for (const row of [r.steps[0].measurements[0], r.attempt.sequence.steps[0].measurements[0]]) { row.status = 'unavailable'; row.reason = '<img onerror=alert(1)>'; } },
    r => { for (const row of [r.steps[0].measurements[0], r.attempt.sequence.steps[0].measurements[0]]) row.identity.chainId = '11155111'; }];
  for (const mutate of mutations) { const ui = setup(), report = sample(); ordered(ui); mutate(report); render(ui, report); assert.equal(tables(ui).length, 0, String(mutate)); }
});

test('late sequence response and per-step edits invalidate the displayed result', async () => {
  let resolve; const ui = setup(() => new Promise(done => { resolve = done; })); ordered(ui);
  const running = ui.context.run('simulation'); ui.state.sequenceControls[1].context.value = '{"gas":"60000"}';
  resolve({ ok: true, json: async () => sample() }); await running; assert.equal(ui.state.result, null); assert.match(ui.elements.get('run-status').textContent, /Inputs changed/);
  render(ui, sample()); ui.state.sequenceControls[0].value.value = '3'; ui.state.sequenceControls[0].value.dispatch('input');
  assert.equal(ui.state.result, null); assert.equal(ui.elements.get('copy-json').disabled, true);
});

test('provider ordered calls keep per-step queries and the existing endpoint', async () => {
  const ui = setup(); ui.elements.get('ethereum-call-mode').value = 'sequence';
  ui.state.sequenceDrafts = [ui.context.newSequenceDraft({ to: T, queries: [query] }), ui.context.newSequenceDraft({ to: A })];
  ui.state.sequenceDrafts[0].manual = true; ui.context.renderSequenceEditor(); ui.context.updateQueryMode();
  await ui.context.run('simulation'); assert.equal(ui.requests[0].url, '/api/evm/simulate-sequence');
  const body = JSON.parse(ui.requests[0].options.body); assert.deepEqual(body.calls[0].queries, [query]); assert.equal(Object.hasOwn(body, 'queries'), false);
});


test('real Sepolia adapter and isolated child render approve then deposit at their own baselines', async () => {
  const [{ simulateLocalSequence }, { ProofRpcClient }, fixture] = await Promise.all([
    import('../src/local-sequence.js'), import('../src/proof-rpc.js'), import('../engines/local-evm/test/sequence-fixture.js'),
  ]);
  const { sequenceFixture, SEQUENCE_SENDER: sender, SEQUENCE_TOKEN: token, SEQUENCE_VAULT: vault, encodeSequenceCall } = fixture;
  const f = await sequenceFixture({ fork: 'amsterdam', priced: true }), wires = [], errors = [];
  const rpc = new ProofRpcClient({ chainId: f.chainId, url: 'https://synthetic.invalid', fetchImpl: async (_url, options) => {
    try {
      const wire = JSON.parse(options.body); wires.push(wire); assert.equal(wire.id, wires.length);
      let result;
      if (wire.method === 'eth_chainId') { assert.equal(wires.length, 1); result = '0xaa36a7'; }
      else if (wire.method === 'eth_getBlockByNumber') result = f.header;
      else { assert(['eth_getProof', 'eth_getCode'].includes(wire.method)); assert.deepEqual(wire.params.at(-1), { blockHash: f.header.hash, requireCanonical: true }); result = await f.rpc.call(wire.method, wire.params); }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result }));
    } catch (error) { errors.push(error.message); throw error; }
  } });
  const queries = [
    { to: token, data: encodeSequenceCall('allowance', [sender, vault]) },
    { to: token, data: encodeSequenceCall('balanceOf', [sender]) },
    { to: vault, data: encodeSequenceCall('balanceOf', [sender]) }, { kind: 'native_balance', account: sender },
  ];
  const calls = ['approve', 'deposit'].map(name => { const { from, ...call } = f.requests[name]; return call; });
  let report;
  const ui = setup(async (url, options) => { assert.equal(url, '/api/evm/local-sequence'); report = await simulateLocalSequence(JSON.parse(options.body), rpc); return { ok: true, json: async () => JSON.parse(JSON.stringify(report)) }; });
  ordered(ui, { chainId: f.chainId, calls }); ui.elements.get('from').value = sender; ui.elements.get('block').value = 'latest'; ui.elements.get('standard-queries').value = JSON.stringify(queries);
  await ui.context.run('simulation');
  assert.deepEqual(errors, []); assert.equal(report.status, 'complete', JSON.stringify(report.error)); assert.equal(report.attempt.status, 'completed');
  assert.equal(report.usage.pending, 0); assert.equal(report.drain.complete, true);
  assert.equal(ui.requests.length, 1); assert.equal(wires.filter(wire => wire.method === 'eth_getBlockByNumber').length, 2);
  assert.deepEqual(wires.at(-1).params, [f.header.number, false]);
  assert.equal(ui.elements.get('coverage-status').textContent, '4 / 4 measured'); assert.equal(tables(ui).length, 4);
  assert.deepEqual(plain(ui.context.localMeasurementRows(ui.context.localSequenceStepView(report, 0))).map(row => row.values.map(v => [v.beforeRaw, v.afterRaw])),
    report.steps[0].measurements.map(row => row.values.map(v => [v.beforeRaw, v.afterRaw])));
  assert.deepEqual(report.steps[0].measurements.slice(0, 3).map(row => row.values.map(v => [v.beforeRaw, v.afterRaw])), [[['0', '100']], [['1000', '1000']], [['0', '0']]]);
  const firstAmounts = ui.elements.get('local-measurements').textContent;
  assert.match(firstAmounts, /test ETH/); assert.match(ui.elements.get('gas-used').textContent, /simulated fee/);
  ui.state.sequenceStepButtons[1].button.dispatch('click');
  assert.equal(ui.elements.get('coverage-status').textContent, '4 / 4 measured'); assert.equal(tables(ui).length, 4);
  assert.deepEqual(report.steps[1].measurements.slice(0, 3).map(row => row.values.map(v => [v.beforeRaw, v.afterRaw])), [[['100', '0']], [['1000', '900']], [['0', '100']]]);
  assert.equal(report.steps[1].measurements[3].values[0].beforeRaw, report.steps[0].measurements[3].values[0].afterRaw);
  assert.notEqual(ui.elements.get('local-measurements').textContent, firstAmounts);
  assert.deepEqual(JSON.parse(ui.elements.get('raw-json').textContent), report); assert.deepEqual(plain(ui.state.result), report);
  // A retained response can still be withheld after the final header or loader
  // check. Display validation must not recover amounts from its audit payload.
  const withheld = clone(report); withheld.status = 'unavailable'; withheld.source.canonicalStatus = 'unverified';
  withheld.audit = { status: 'unverified_not_a_measurement', originals: withheld.attempt.sequence.steps.map(step => step.original) };
  withheld.attempt.status = 'unavailable'; withheld.attempt.sequence = null; render(ui, withheld);
  assert.equal(tables(ui).length, 0); ui.state.sequenceStepButtons[1].button.dispatch('click'); assert.equal(tables(ui).length, 0);
});


test('switching the real mode controls updates local per-step help and preserves ordering controls', () => {
  const ui = setup(); ui.state.config.localEvm.sequenceCapabilities = { available: true };
  ui.state.sequenceDrafts = [ui.context.newSequenceDraft({ to: T }), ui.context.newSequenceDraft({ to: A })];
  ui.context.renderSequenceEditor(); ui.elements.get('ethereum-engine').value = 'local'; ui.elements.get('ethereum-engine').dispatch('change');
  ui.elements.get('ethereum-call-mode').value = 'sequence'; ui.elements.get('ethereum-call-mode').dispatch('change');
  assert.match(ui.state.sequenceControls[0].contextSettings.textContent, /gas, fees/);
  assert.match(ui.state.sequenceControls[0].card.textContent, /null for deployment/);
  assert.match(ui.elements.get('sequence-editor-help').textContent, /failure stops later calls/);
  const first = ui.state.sequenceControls[0]; first.context.value = '{"gas":"60000"}'; first.context.dispatch('input');
  first.down.dispatch('click'); assert.equal(ui.state.sequenceControls[1].to.value, T); assert.equal(ui.state.sequenceControls[1].context.value, '{"gas":"60000"}');
  ui.elements.get('add-sequence-call').dispatch('click'); ui.elements.get('add-sequence-call').dispatch('click'); assert.equal(ui.state.sequenceControls.length, 4);
  assert.equal(ui.elements.get('add-sequence-call').disabled, true); ui.elements.get('add-sequence-call').dispatch('click'); assert.equal(ui.state.sequenceControls.length, 4);
  ui.state.sequenceControls[3].remove.dispatch('click'); ui.state.sequenceControls[2].remove.dispatch('click'); assert.equal(ui.state.sequenceControls.length, 2);
  assert(ui.state.sequenceControls.every(row => row.remove.disabled));
});
