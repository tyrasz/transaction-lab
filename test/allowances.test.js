import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAllowances } from '../src/allowances.js';
import { analyzePermissions } from '../src/permissions.js';
import { createStateContext } from '../src/state.js';
import { USDC, HUSDC, METADATA } from '../src/config.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x4444444444444444444444444444444444444444';
const DEBT_TOKEN = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const MAX = (1n << 256n) - 1n;
const word = amount => `0x${BigInt(amount).toString(16).padStart(64, '0')}`;
const addressWord = address => address.slice(2).padStart(64, '0');
const data = (amount, spender = SPENDER) => `0x095ea7b3${addressWord(spender)}${word(amount).slice(2)}`;
const block = { number: '42', hash: word(42n), timestamp: '2000' };
const header = { number: '0x2a', hash: block.hash, timestamp: '0x7d0' };
const event = (amount, index = 0, spender = SPENDER, token = USDC, owner = OWNER) => ({ address: token, topics: [APPROVAL, `0x${addressWord(owner)}`, `0x${addressWord(spender)}`], data: word(amount), ...(index === null ? {} : { index: `0x${index.toString(16)}` }) });

function setup({ amount = 100000000n, before = 0n, after = amount, token = USDC, diff = { pre: {}, post: {} }, output = word(1n), mutate, rpcOverride } = {}) {
  const calls = [];
  const request = { chainId: 999, from: OWNER, to: token, data: data(amount), value: '0' };
  const trace = { type: 'CALL', from: OWNER, to: token, input: request.data, output, gasUsed: '0x10000', logs: [event(amount, 0, SPENDER, token)] };
  const input = { request, trace, block: { ...block }, metadata: METADATA, analysis: { execution: { status: 'success' } } };
  input.rpc = { async call(method, params) {
    calls.push({ method, params });
    const custom = await rpcOverride?.(method, params);
    if (custom !== undefined) return custom;
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') return { ...header };
    if (method === 'debug_traceCall') return structuredClone(diff);
    if (method === 'eth_call') return word(params.length === 3 ? after : before);
    throw new Error('Unexpected RPC method');
  } };
  mutate?.(input);
  input.permissions = analyzePermissions(input);
  return { input, calls };
}

test('bounded allowance is measured once per pair with whole-transaction state and exact units', async () => {
  const { input, calls } = setup({ amount: 123456789012345678901234567890n, before: 1n });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.basis, 'prestate_diff_allowance');
  assert.equal(result.allowances.length, 1);
  assert.equal(result.allowances[0].after, '123456789012345678901234.56789');
  assert.equal(result.allowances[0].deltaRaw, '123456789012345678901234567889');
  assert.equal(result.allowances[0].beforeKind, 'bounded');
  assert.equal(result.allowances[0].afterKind, 'bounded');
  assert.equal(result.allowances[0].changed, true);
  assert.equal(result.allowances[0].consistency.eventComparison, 'matches_last_observed_event');
  assert.equal(result.allowances[0].observationIds.length, 2);
  assert.equal(calls.filter(call => call.method === 'eth_call').length, 2);
  for (const call of calls.filter(call => ['eth_call', 'debug_traceCall'].includes(call.method))) assert.deepEqual(call.params[1], { blockHash: block.hash, requireCanonical: true });
});

test('an already-maximum approval with empty or nonce-only diff is a measured unchanged permission', async () => {
  for (const diff of [{ pre: {}, post: {} }, { pre: { [OWNER]: { nonce: 8 } }, post: { [OWNER]: { nonce: 9 } } }]) {
    const { input } = setup({ amount: MAX, before: MAX, after: MAX, diff });
    const result = await measureAllowances(input);
    assert.equal(result.status, 'measured');
    assert.equal(result.allowances[0].beforeRaw, MAX.toString());
    assert.equal(result.allowances[0].afterKind, 'uint256_max');
    assert.equal(result.allowances[0].deltaRaw, '0');
    assert.equal(result.allowances[0].changed, false);
  }
});

test('revoke clears a pre-only storage slot and preserves unrelated storage', async () => {
  const slot = word(123n);
  const diff = { pre: { [USDC]: { storage: { [slot]: word(MAX) } } }, post: { [USDC]: { storage: {} } } };
  const { input, calls } = setup({ amount: 0n, before: MAX, after: 0n, diff });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances[0].afterKind, 'zero');
  assert.equal(result.allowances[0].deltaRaw, (-MAX).toString());
  const override = calls.find(call => call.method === 'eth_call' && call.params.length === 3).params[2];
  assert.deepEqual(override, { [USDC]: { stateDiff: { [slot]: word(0n) } } });
});

test('approve returning false measures actual unchanged allowance without claiming activation', async () => {
  const { input } = setup({ amount: MAX, before: 5n, after: 5n, output: word(0n), mutate: input => { input.trace.logs = []; } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances[0].changed, false);
  assert.equal(result.allowances[0].consistency.requestComparison, 'differs_from_requested_amount');
  assert.equal(result.allowances[0].consistency.eventComparison, 'no_event');
  assert.deepEqual(result.allowances[0].consistency.falseReturnObservationIds, ['permission-1']);
});

test('sequential approve then revoke measures final zero once and compares only last ordered event', async () => {
  const { input, calls } = setup({ before: 50n, after: 0n, mutate: input => {
    input.request.to = ROUTER; input.request.data = '0x12345678';
    input.trace = { type: 'CALL', from: OWNER, to: ROUTER, input: input.request.data, calls: [
      { type: 'CALL', from: ROUTER, to: USDC, input: data(MAX), output: word(1n), logs: [event(MAX, 5, SPENDER, USDC, ROUTER)] },
      { type: 'CALL', from: ROUTER, to: USDC, input: data(0n), output: word(1n), logs: [event(0n, 6, SPENDER, USDC, ROUTER)] },
    ] };
  } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances.length, 1);
  assert.equal(result.allowances[0].owner, ROUTER);
  assert.equal(result.allowances[0].afterRaw, '0');
  assert.equal(result.allowances[0].observationIds.length, 4);
  assert.equal(result.allowances[0].consistency.eventComparison, 'matches_last_observed_event');
  assert.equal(result.allowances[0].consistency.lastEventAmountRaw, '0');
  assert.equal(result.allowances[0].consistency.requestComparison, 'multiple_requests_not_individually_compared');
  assert.equal(calls.filter(call => call.method === 'eth_call').length, 2);
});

test('a final allowance differing from event evidence remains a measured result with a separate difference', async () => {
  const { input } = setup({ amount: 100n, before: 1n, after: 70n });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances[0].afterRaw, '70');
  assert.equal(result.allowances[0].consistency.eventComparison, 'differs_from_last_observed_event');
});

test('multiple events without global indexes do not invent a final event order', async () => {
  const { input } = setup({ after: 7n, mutate: input => { input.trace.logs = [event(5n, null), event(7n, null)]; } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances[0].consistency.eventComparison, 'ambiguous_event_order');
  assert.equal(result.allowances[0].consistency.lastEventObservationId, null);
});

test('failed roots and subtrees, unknown contracts and debt tokens yield no allowance targets', async () => {
  for (const options of [
    { mutate: input => { input.trace.error = 'execution reverted'; } },
    { token: ROUTER },
    { token: DEBT_TOKEN },
    { mutate: input => {
      input.request.to = ROUTER; input.request.data = '0x';
      input.trace = { type: 'CALL', from: OWNER, to: ROUTER, input: '0x', calls: [{ ...input.trace, error: 'execution reverted' }] };
    } },
  ]) {
    const { input, calls } = setup(options);
    const result = await measureAllowances(input);
    assert.equal(result.status, 'not_applicable');
    assert.deepEqual(result.allowances, []);
    assert.equal(calls.length, 0);
  }
});

test('hUSDC is measurable, but stale supplied permission evidence is rejected', async () => {
  const { input } = setup({ token: HUSDC });
  assert.equal((await measureAllowances(input)).status, 'measured');
  input.permissions.observations[0].spender = ROUTER;
  const result = await measureAllowances(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.allowances, []);
});

test('successful sibling approval is measured while a reverted sibling pair is excluded', async () => {
  const otherSpender = '0x3333333333333333333333333333333333333333';
  const { input } = setup({ mutate: input => {
    input.request.to = ROUTER; input.request.data = '0x';
    input.trace = { type: 'CALL', from: OWNER, to: ROUTER, input: '0x', calls: [
      { type: 'CALL', from: ROUTER, to: USDC, input: data(MAX, otherSpender), error: 'execution reverted', logs: [event(MAX, 0, otherSpender, USDC, ROUTER)] },
      { type: 'CALL', from: ROUTER, to: USDC, input: data(100000000n), output: word(1n), logs: [event(100000000n, 1, SPENDER, USDC, ROUTER)] },
    ] };
  } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances.length, 1);
  assert.equal(result.allowances[0].spender, SPENDER);
});

test('nine distinct pairs exceed the explicit resource cap before any RPC request', async () => {
  const { input, calls } = setup({ mutate: input => {
    input.trace.logs = Array.from({ length: 9 }, (_, index) => event(1n, index, `0x${(index + 100).toString(16).padStart(40, '0')}`));
  } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.limits.maxPairs, 8);
  assert.equal(calls.length, 0);
  assert.ok(result.warnings.some(w => w.includes('eight-pair')));
});

test('malformed uint256 return, unsupported account/code changes and reorg fail closed', async () => {
  for (const options of [
    { rpcOverride: method => method === 'eth_call' ? '0x1' : undefined },
    { diff: { pre: {}, post: { [USDC]: { code: '0x00' } } } },
    { diff: { pre: { [USDC]: { code: '0x11' } }, post: { [USDC]: { code: '0x22' } } } },
    { rpcOverride: method => method === 'eth_getBlockByNumber' ? { ...header, hash: word(1n) } : undefined },
  ]) {
    const { input } = setup(options);
    const result = await measureAllowances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.allowances, []);
  }
});

test('provider exception messages and arbitrary details never reach output', async () => {
  const secret = 'provider-credential-url-do-not-expose';
  const { input } = setup({ rpcOverride: () => { throw Object.assign(new Error(secret), { code: secret, detail: { secret, rpcCode: -32602 } }); } });
  const result = await measureAllowances(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.evidence.response[0].error.rpcCode, -32602);
});

test('a shared context is lazy and performs one state trace across repeated measurements', async () => {
  const { input, calls } = setup();
  const stateContext = createStateContext(input);
  assert.equal(calls.length, 0);
  const first = await measureAllowances({ ...input, stateContext });
  const firstEvidenceCount = first.evidence.request.length;
  const second = await measureAllowances({ ...input, stateContext });
  assert.equal(first.status, 'measured');
  assert.equal(second.status, 'measured');
  assert.equal(calls.filter(call => call.method === 'debug_traceCall').length, 1);
  assert.equal(first.evidence.request.length, firstEvidenceCount, 'earlier evidence is a snapshot');
  const mismatch = await measureAllowances({ ...input, block: { ...block, timestamp: '2001' }, stateContext });
  assert.equal(mismatch.status, 'unavailable');
});
