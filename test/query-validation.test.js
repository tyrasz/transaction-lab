import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeTokenQuery, semanticTrace, validateTokenQueryTrace, QUERY_IMPLEMENTATIONS } from '../src/query-validation.js';
import { StateValidationError, UINT256_MAX } from '../src/state.js';
import { USDC, HUSDC, VUSDC, POOL } from '../src/config.js';

// Only saved public query responses are positive fixtures. Mutations below are
// synthetic fault controls; they are not independent execution observations.
const sources = [
  ['../reports/affected-balance-comparisons/capture.json', '53eec210304f3f3ff749bc4a4cdbd4fe55f57e87a2cd0b94983574bd0942de34', 120],
  ['../reports/permission-comparisons/2026-10-25T15-26-52-549Z-http.json', 'e305f6b98a5c3ef3deee207d5b463c2f1ad8bb0cbc30577d9336084805a7f824', 14],
];
const observed = [];
for (const [file, sha256, expectedCount] of sources) {
  const bytes = await readFile(new URL(file, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  const capture = JSON.parse(bytes), queries = [];
  for (const item of capture.cases) for (const run of item.runs) for (const entry of run.rpcCalls) {
    const { method, params } = entry.request;
    if (method !== 'debug_traceCallMany' || params[2].tracer !== 'callTracer') continue;
    const call = params[0][0].transactions[0];
    if (!/^0x(?:70a08231|dd62ed3e)/.test(call.data)) continue;
    assert.equal(params[0].length, 1); assert.equal(params[0][0].transactions.length, 1);
    assert.equal(entry.response.error, undefined);
    const result = entry.response.result;
    assert.equal(result.length, 1); assert.equal(result[0].length, 1);
    queries.push({ call, trace: result[0][0], source: file, caseId: item.id, provider: run.provider });
  }
  assert.equal(queries.length, expectedCount);
  observed.push(...queries);
}

const fixture = (token = USDC, selector = '0x70a08231') => {
  const match = observed.find(item => item.call.to === token && item.call.data.startsWith(selector));
  assert.ok(match, 'Fixture must be an actual saved query');
  return structuredClone(match);
};
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const upper = hex => '0x' + hex.slice(2).toUpperCase();
const validate = ({ trace, call }) => validateTokenQueryTrace(trace, call, call.from);
const rejectMutation = (change, token = USDC, selector) => {
  const input = fixture(token, selector); change(input);
  assert.throws(() => validate(input), StateValidationError);
};

test('134 saved balance/allowance query traces preserve exact raw amounts and traced gas', () => {
  const branches = new Set();
  for (const input of observed) {
    const snapshot = structuredClone(input);
    assert.deepEqual(validate(input), { amount: BigInt(input.trace.output), gasUsed: BigInt(input.trace.gasUsed) });
    assert.deepEqual(input, snapshot, 'Pure validation must not mutate raw evidence');
    branches.add(input.call.to + ':' + input.call.data.slice(0, 10));
  }
  assert.deepEqual([...branches].sort(), [USDC + ':0x70a08231', USDC + ':0xdd62ed3e', HUSDC + ':0x70a08231', HUSDC + ':0xdd62ed3e', VUSDC + ':0x70a08231'].sort());
  assert.ok(observed.some(input => BigInt(input.trace.output) === 0n));
  assert.ok(observed.some(input => BigInt(input.trace.output) === UINT256_MAX));
});

test('query normalization accepts only canonical configured ABI and preserves case-insensitive behavior', () => {
  for (const [token, selector] of [[USDC, '0x70a08231'], [HUSDC, '0x70a08231'], [VUSDC, '0x70a08231'], [USDC, '0xdd62ed3e'], [HUSDC, '0xdd62ed3e']]) {
    const { call } = fixture(token, selector);
    assert.deepEqual(normalizeTokenQuery({ ...call, to: upper(call.to), data: upper(call.data) }), { to: call.to, data: call.data });
    const padded = call.data.slice(10);
    for (const bad of [
      null, [], { to: [call.to], data: call.data }, { to: call.to, data: [call.data] },
      { to: address(1), data: call.data }, { to: call.to, data: call.data + '00' },
      { to: call.to, data: call.data.slice(0, -2) }, { to: call.to, data: '0x095ea7b3' + padded },
      { to: call.to, data: selector + '1' + padded.slice(1) },
      { to: call.to, data: selector + padded.slice(24) },
    ]) assert.throws(() => normalizeTokenQuery(bad), StateValidationError);
    if (selector === '0xdd62ed3e') {
      assert.throws(() => normalizeTokenQuery({ to: VUSDC, data: call.data }), StateValidationError);
      assert.throws(() => normalizeTokenQuery({ to: token, data: call.data.slice(0, 74) + '1' + call.data.slice(75) }), StateValidationError);
    }
  }
  assert.throws(() => { QUERY_IMPLEMENTATIONS[USDC] = address(1); }, TypeError);
});

test('one trace object is required and envelope handling cannot be mistaken for query validation', () => {
  const input = fixture();
  for (const trace of [null, [], [input.trace], [[input.trace]], { result: input.trace }, { error: { code: -32603, message: 'provider failure' } }]) {
    assert.throws(() => validateTokenQueryTrace(trace, input.call, input.call.from), StateValidationError);
  }
  assert.throws(() => validateTokenQueryTrace(input.trace, { to: address(1), data: input.call.data }, input.call.from), StateValidationError);
});

test('external query sender remains distinct from balance account and allowance owner', () => {
  for (const selector of ['0x70a08231', '0xdd62ed3e']) {
    const input = observed.find(item => item.call.data.startsWith(selector) && '0x' + item.call.data.slice(34, 74) !== item.call.from);
    assert.ok(input, 'Saved evidence must contain a query for another owner');
    validate(input);
    assert.throws(() => validateTokenQueryTrace(input.trace, input.call, '0x' + input.call.data.slice(34, 74)), StateValidationError);
    assert.throws(() => validateTokenQueryTrace(input.trace, input.call, [input.call.from]), StateValidationError);
  }
});

test('root and delegate callers, value, ABI, implementation and exact child counts are bound', () => {
  const mutations = [
    x => { x.trace.from = address(1); }, x => { x.trace.to = HUSDC; },
    x => { x.trace.type = 'STATICCALL'; }, x => { x.trace.value = '0x1'; },
    x => { x.trace.input += '00'; }, x => { x.trace.calls = []; },
    x => { x.trace.calls.push(structuredClone(x.trace.calls[0])); },
    x => { x.trace.calls[0].from = x.call.from; }, x => { x.trace.calls[0].to = address(2); },
    x => { x.trace.calls[0].type = 'CALL'; }, x => { x.trace.calls[0].value = '0x1'; },
    x => { x.trace.calls[0].input = x.trace.calls[0].input.slice(0, -2) + 'ff'; },
    x => { x.trace.calls[0].calls = [structuredClone(x.trace.calls[0])]; },
  ];
  for (const change of mutations) rejectMutation(change);
});

test('successful uint256 output cannot override failure, event, lifecycle or malformed evidence', () => {
  const mutations = [
    x => { x.trace.error = 'execution reverted'; }, x => { x.trace.calls[0].revertReason = 'query failed'; },
    x => { x.trace.output = '0x01'; }, x => { x.trace.output = word(1) + '00'; },
    x => { x.trace.output = [x.trace.output]; }, x => { x.trace.calls[0].output = word(999); },
    x => { x.trace.logs = [{ address: USDC, topics: [], data: '0x' }]; },
    x => { x.trace.calls[0].logs = [{ address: USDC, topics: [], data: '0x' }]; },
    x => { x.trace.calls[0].type = 'SELFDESTRUCT'; }, x => { x.trace.calls[0].type = 'CREATE2'; },
    x => { x.trace.error = { message: 'bad' }; }, x => { x.trace.calls = {}; },
    x => { x.trace.logs = {}; }, x => { x.trace.calls[0].from = [USDC]; },
    x => { delete x.trace.calls[0].gasUsed; }, x => { x.trace.gasUsed = '-1'; },
    x => { x.trace.gas = '0xwrong'; }, x => { x.trace.calls[0].gasUsed = UINT256_MAX + 1n; },
    x => { x.trace.extra = true; }, x => { x.trace.calls[0].extra = true; },
  ];
  for (const change of mutations) rejectMutation(change);
});

for (const token of [HUSDC, VUSDC]) test(`${token === HUSDC ? 'receipt' : 'debt'} balance requires the precise reserve-index and Pool implementation path`, () => {
  const mutations = [
    x => { x.trace.calls[0].calls = []; },
    x => { x.trace.calls[0].calls[0].type = 'CALL'; },
    x => { x.trace.calls[0].calls[0].from = USDC; },
    x => { x.trace.calls[0].calls[0].to = address(9); },
    x => { const pool = x.trace.calls[0].calls[0]; pool.input = (token === HUSDC ? '0x386497fd' : '0xd15e0053') + pool.input.slice(10); },
    x => { x.trace.calls[0].calls[0].input = x.trace.calls[0].calls[0].input.slice(0, -40) + HUSDC.slice(2); },
    x => { x.trace.calls[0].calls[0].output = word(0); },
    x => { x.trace.calls[0].calls[0].output = '0x01'; },
    x => { x.trace.calls[0].calls[0].calls[0].output = word(1); },
    x => { x.trace.calls[0].calls[0].calls[0].to = address(2); },
    x => { x.trace.calls[0].calls[0].calls[0].from = token; },
    x => { x.trace.calls[0].calls[0].calls[0].type = 'CALL'; },
    x => { x.trace.calls[0].calls[0].calls[0].input = '0x'; },
    x => { const impl = x.trace.calls[0].calls[0].calls[0]; impl.calls = [structuredClone(impl)]; },
    x => { x.trace.calls[0].calls[0].logs = [{ address: POOL, topics: [], data: '0x' }]; },
    x => { x.trace.calls[0].calls[0].calls[0].error = 'execution reverted'; },
  ];
  for (const change of mutations) rejectMutation(change, token);
});

test('allowance owner/spender words are bound at root and implementation, with no Pool child', () => {
  for (const token of [USDC, HUSDC]) for (const change of [
    x => { x.trace.input = x.call.data.slice(0, 10) + x.call.data.slice(74) + x.call.data.slice(10, 74); },
    x => { x.trace.calls[0].input = x.trace.calls[0].input.slice(0, -40) + address(9).slice(2); },
    x => { x.trace.calls[0].calls = structuredClone(fixture(HUSDC).trace.calls[0].calls); },
  ]) rejectMutation(change, token, '0xdd62ed3e');
});

test('semantic normalization preserves historical gas, failure and event comparison rules', () => {
  const { trace } = fixture(HUSDC);
  const baseline = semanticTrace(trace), changed = structuredClone(trace);
  function annotate(frame) {
    frame.gas = '0x1'; frame.from = upper(frame.from); frame.to = upper(frame.to);
    frame.input = upper(frame.input); frame.output = upper(frame.output);
    for (const child of frame.calls ?? []) annotate(child);
  }
  annotate(changed);
  assert.deepEqual(semanticTrace(changed), baseline, 'Input gas annotations and hex case are normalized exactly as before');
  changed.calls[0].gasUsed = '0x1';
  assert.notDeepEqual(semanticTrace(changed), baseline, 'Used gas remains semantic evidence');
  const failed = { ...structuredClone(trace), error: 'execution reverted', revertReason: 'saved explanation', logs: [{ address: HUSDC, topics: [word(1)], data: word(2), position: '0x3', index: 4, logIndex: '5' }] };
  const normalized = semanticTrace(failed);
  assert.equal(normalized.error, failed.error); assert.equal(normalized.revertReason, failed.revertReason);
  assert.deepEqual(normalized.logs[0], { address: HUSDC, topics: [word(1)], data: word(2), position: '3', index: '4', logIndex: '5' });
  for (const change of [
    x => { x.logs[0].address = [HUSDC]; }, x => { x.logs[0].topics = [1]; },
    x => { x.logs[0].topics = [[word(1)]]; }, x => { x.logs[0].removed = true; },
    x => { x.logs[0].extra = true; }, x => { x.logs[0].position = 'bad'; },
  ]) { const invalid = structuredClone(failed); change(invalid); assert.throws(() => semanticTrace(invalid), StateValidationError); }
});

test('semantic normalization retains frame, depth and event resource bounds', () => {
  const frame = { type: 'CALL', from: address(1), to: address(2), input: '0x', output: '0x', value: '0x0', gasUsed: '0x1' };
  const wide = { ...frame, calls: Array.from({ length: 999 }, () => ({ ...frame })) };
  assert.equal(semanticTrace(wide).calls.length, 999);
  wide.calls.push({ ...frame }); assert.throws(() => semanticTrace(wide), /frame or depth limit/);
  const deep = { ...frame }; let tip = deep;
  for (let i = 0; i < 32; i++) { tip.calls = [{ ...frame }]; tip = tip.calls[0]; }
  semanticTrace(deep); tip.calls = [{ ...frame }]; assert.throws(() => semanticTrace(deep), /frame or depth limit/);
  const logged = { ...frame, logs: Array.from({ length: 2000 }, () => ({ address: USDC, topics: [], data: '0x' })) };
  assert.equal(semanticTrace(logged).logs.length, 2000);
  logged.logs.push({ address: USDC, topics: [], data: '0x' }); assert.throws(() => semanticTrace(logged), /excessive event evidence/);
});
