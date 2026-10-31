import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { measureNativeBalances } from '../src/native-balances.js';
import { collectNativeEffects, NATIVE_EFFECT_LIMITS } from '../src/native-effects.js';
import * as compatible from '../engines/standard-evm/native-effects.js';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const S = address(1), T = address(2), MAX = (1n << 256n) - 1n;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidate = (account, index, net = 0n) => ({ account, netValueRaw: net.toString(), selected: index < 8, reason: index < 8 ? 'selected' : 'account-limit' });
function fixture({ count = 2, values = [[2n * 10n ** 18n, 10n ** 18n - 1n], [0n, 10n ** 18n + 1n]] } = {}) {
  const request = { chainId: 999, from: S, to: T, data: '0x', value: '1000000000000000001' };
  const block = { hash: '0x' + 'a'.repeat(64), number: '0x7', timestamp: '0x64' }, rpc = {};
  const trace = { type: 'CALL', from: S, to: T, input: '0x', output: '0x', value: '0xde0b6b3a7640001', gas: '0x4c4b40', gasUsed: '0x5208', calls: [] };
  const candidates = Array.from({ length: count }, (_, i) => candidate(address(i + 1), i, i < values.length ? values[i][1] - values[i][0] : 0n));
  const measured = candidates.filter(c => c.selected).map((c, i) => {
    const [before, after] = values[i] ?? [0n, 0n];
    return { account: c.account, before, after, delta: after - before, anchorEvidenceId: i + 1, queryEvidence: [
      { state: 'before', traceEvidenceId: 20, mutationEvidenceId: 21, wordIndex: 8 + i },
      { state: 'after', traceEvidenceId: 22, mutationEvidenceId: 23, wordIndex: 8 + i }] };
  });
  const result = { feeScope: 'excluded', maxAccounts: 8, candidates, counts: { candidates: count, selected: measured.length, omitted: count - measured.length }, measurements: measured };
  const identity = { stateBlockHash: block.hash, blockNumber: '7', timestamp: '100', stateBinding: 'block_hash', headerContext: 'synthetic_unpriced_basefee_zero',
    method: 'debug_traceCall', feePolicy: 'gas_price_omitted_no_query_native_debit',
    originalEnvelopeSha256: hash({ from: S, to: T, data: '0x', value: trace.value, gas: '0x4c4b40' }), stateOverridesSha256: 'b'.repeat(64),
    validation: { queryMutation: 'sender_nonce_increment_only_with_unchanged_native_balance' } };
  const evidence = { request: [{ id: 1, method: 'eth_getBalance' }], response: [{ id: 1, result: '0x1' }] }, calls = [];
  const context = { measurementBasis: 'current_pinned_state_validated_query', canonicalFailure: null, executionIdentity: identity,
    matches(input) { calls.push('matches'); return input.rpc === rpc && input.request === request && input.block === block; },
    async readNativeBalances() { calls.push('read'); return result; }, async verifyCanonical() { calls.push('canonical'); }, snapshotEvidence() { calls.push('evidence'); return evidence; } };
  return { request, trace, block, rpc, stateContext: context, context, calls, result, identity, evidence };
}
const run = f => measureNativeBalances(f);
function unavailable(result) {
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.assets, []); assert.deepEqual(result.evidence, { request: [], response: [] });
  assert.equal(Object.hasOwn(result, 'executionIdentity'), false); assert(!JSON.stringify(result).includes('PRIVATE_PROVIDER_MARKER'));
  assert.equal(Object.hasOwn(result, 'beforeRaw'), false);
}

test('standard compatibility entry point preserves the shared collector function and limits', async () => {
  assert.equal(compatible.collectNativeEffects, collectNativeEffects); assert.equal(compatible.NATIVE_EFFECT_LIMITS, NATIVE_EFFECT_LIMITS);
  const source = await readFile(new URL('../src/native-effects.js', import.meta.url), 'utf8');
  assert(source.includes("from './state-diff.js'")); assert(source.includes("from './state.js'"));
});

test('native amounts use exact 18-decimal rendering and do not change supplied snapshots', async () => {
  const f = fixture(), original = structuredClone(f.result), r = await run(f);
  assert.equal(r.status, 'measured'); assert.equal(r.basis, 'current_pinned_state_validated_native_balance'); assert.equal(r.feeScope, 'excluded');
  assert.deepEqual(r.limits, { maxAccounts: 8 }); assert.equal(r.candidateAccountCount, 2); assert.deepEqual(r.omittedAccounts, []);
  assert.deepEqual(r.assets.map(a => [a.before, a.after, a.delta]), [['2', '0.999999999999999999', '-1.000000000000000001'], ['0', '1.000000000000000001', '1.000000000000000001']]);
  assert.deepEqual(r.assets[0].asset, { type: 'native', symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 });
  assert.deepEqual(f.calls, ['matches', 'read', 'canonical', 'evidence']); assert.deepEqual(f.result, original);
  f.result.measurements[0].queryEvidence[0].traceEvidenceId = 999; f.evidence.response[0].result = 'PRIVATE_PROVIDER_MARKER'; f.identity.validation.queryMutation = 'changed';
  assert.equal(r.assets[0].queryEvidence[0].traceEvidenceId, 20); assert.equal(r.evidence.response[0].result, '0x1');
  assert.equal(r.executionIdentity.validation.queryMutation, 'sender_nonce_increment_only_with_unchanged_native_balance');
});

test('zero and uint256 endpoint balances preserve exact signed deltas', async () => {
  const f = fixture({ values: [[MAX, 0n], [0n, MAX]] }), r = await run(f);
  assert.equal(r.status, 'measured'); assert.equal(r.assets[0].beforeRaw, MAX.toString()); assert.equal(r.assets[0].deltaRaw, (-MAX).toString());
  assert.equal(r.assets[1].deltaRaw, MAX.toString()); assert.equal(r.assets[1].after, '115792089237316195423570985008687907853269984665640564039457.584007913129639935');
  const unchanged = await run(fixture({ values: [[7n, 7n], [0n, 0n]] })); assert.deepEqual(unchanged.assets.map(a => a.delta), ['0', '0']);
});

test('first eight candidates are measured and omitted candidates retain explicit partial coverage', async () => {
  const f = fixture({ count: 11 }), r = await run(f);
  assert.equal(r.status, 'partial'); assert.equal(r.assets.length, 8); assert.equal(r.candidateAccountCount, 11);
  assert.deepEqual(r.omittedAccounts, [9, 10, 11].map(n => ({ account: address(n), reason: 'account-limit' })));
  assert(!JSON.stringify(r.omittedAccounts).includes('Raw'));
});

test('remaining RPC budget can omit candidates within the account cap without inventing measurements', async () => {
  const f = fixture({ count: 3 });
  f.result.candidates[1].selected = false; f.result.candidates[1].reason = 'rpc-budget'; f.result.measurements.splice(1, 1);
  f.result.measurements[1].queryEvidence.forEach(q => { q.wordIndex = 9; });
  f.result.counts.selected = 2; f.result.counts.omitted = 1;
  const r = await run(f); assert.equal(r.status, 'partial'); assert.deepEqual(r.assets.map(a => a.account), [S, address(3)]);
  assert.deepEqual(r.omittedAccounts, [{ account: T, reason: 'rpc-budget' }]);
  const none = fixture({ count: 2 }); none.result.candidates.forEach(c => { c.selected = false; c.reason = 'rpc-budget'; });
  none.result.measurements = []; none.result.counts.selected = 0; none.result.counts.omitted = 2;
  const empty = await run(none); assert.equal(empty.status, 'partial'); assert.deepEqual(empty.assets, []); assert.equal(empty.omittedAccounts.length, 2);
});

test('empty candidates and failed originals are distinct not-applicable outcomes', async () => {
  const empty = fixture({ count: 0 }), zero = await run(empty); assert.equal(zero.status, 'not_applicable'); assert.match(zero.warnings.join(' '), /No native balance candidates/);
  assert.deepEqual(empty.calls, ['matches', 'read', 'evidence']); assert(!Object.hasOwn(zero, 'executionIdentity'));
  for (const field of ['error', 'revertReason']) { const f = fixture(); f.trace[field] = 'execution reverted'; const r = await run(f); assert.equal(r.status, 'not_applicable'); assert.deepEqual(f.calls, []); }
  const other = fixture(); other.request.chainId = 1; assert.equal((await run(other)).status, 'not_applicable'); assert.deepEqual(other.calls, []);
});

test('historical, missing, mismatched or already failed contexts never perform reads', async () => {
  for (const change of [f => { f.stateContext = undefined; }, f => { f.context.measurementBasis = 'historical_transaction_position_balanceOf'; },
    f => { f.context.matches = () => false; }, f => { f.context.canonicalFailure = 'PRIVATE_PROVIDER_MARKER'; }]) {
    const f = fixture(); change(f); unavailable(await run(f)); assert(!f.calls.includes('read'));
  }
});

test('wrong original trace and pinned execution identities fail closed', async () => {
  for (const change of [f => { f.trace.from = T; }, f => { f.trace.to = S; }, f => { f.trace.input = '0x01'; }, f => { f.trace.value = '0x0'; },
    f => { delete f.trace.gas; }, f => { f.trace.gasUsed = '0x0'; }, f => { f.trace.gasUsed = '0x4c4b41'; }, f => { f.trace.type = 'CREATE'; },
    f => { f.identity.stateBlockHash = '0x' + 'c'.repeat(64); }, f => { f.identity.blockNumber = '8'; }, f => { f.identity.timestamp = '101'; },
    f => { f.identity.method = 'eth_call'; }, f => { f.identity.feePolicy = 'priced'; }, f => { f.identity.headerContext = 'unknown'; },
    f => { f.identity.validation.queryMutation = 'unchecked'; }, f => { f.identity.originalEnvelopeSha256 = 'c'.repeat(64); }, f => { f.identity.stateOverridesSha256 = null; }]) {
    const f = fixture(); change(f); unavailable(await run(f));
  }
});

test('candidate selection and count mutations cannot publish partial invented amounts', async () => {
  for (const change of [r => { r.maxAccounts = 7; }, r => { r.feeScope = 'included'; }, r => { r.counts.candidates++; }, r => { r.counts.selected--; },
    r => { r.counts.omitted++; }, r => { r.candidates[0].selected = false; }, r => { r.candidates[0].reason = 'arbitrary'; },
    r => { r.candidates[1].account = r.candidates[0].account; }, r => { r.candidates[0].account = '0x1'; }, r => { r.candidates[0].netValueRaw = '-0'; },
    r => { r.candidates[0].netValueRaw = (MAX + 1n).toString(); }, r => { r.measurements.pop(); }, r => { r.measurements.reverse(); },
    r => { r.candidates.length = 129; }, r => { r.extra = 'PRIVATE_PROVIDER_MARKER'; }]) {
    const f = fixture(); change(f.result); unavailable(await run(f));
  }
});

test('measurement uint ranges, exact delta, evidence and accessor shapes are validated', async () => {
  for (const change of [m => { m.before = -1n; }, m => { m.after = MAX + 1n; }, m => { m.before = '1'; }, m => { m.delta = 0n; },
    m => { m.delta = '0'; }, m => { m.account = address(99); }, m => { m.anchorEvidenceId = 0; }, m => { m.anchorEvidenceId = 1.5; },
    m => { m.queryEvidence = []; }, m => { m.queryEvidence = {}; }, m => { delete m.queryEvidence[1]; },
    m => { m.queryEvidence.reverse(); }, m => { m.queryEvidence[0].traceEvidenceId = 0; }, m => { m.queryEvidence[0].mutationEvidenceId = 20; },
    m => { m.queryEvidence[1].traceEvidenceId = 20; }, m => { m.queryEvidence[0].wordIndex = 9; }, m => { m.queryEvidence[1].state = 'before'; },
    m => { Object.defineProperty(m, 'before', { enumerable: true, get() { assert.fail('Accessor must not run'); } }); }]) {
    const f = fixture(); change(f.result.measurements[0]); unavailable(await run(f));
  }
});

test('shared failures before and after reads withhold all amounts, evidence and identity', async () => {
  for (const change of [f => { f.context.readNativeBalances = async () => { throw new Error('PRIVATE_PROVIDER_MARKER'); }; },
    f => { f.context.readNativeBalances = async () => { f.context.canonicalFailure = 'PRIVATE_PROVIDER_MARKER'; return f.result; }; },
    f => { f.context.verifyCanonical = async () => { throw new Error('PRIVATE_PROVIDER_MARKER'); }; },
    f => { f.context.verifyCanonical = async () => { f.context.canonicalFailure = 'PRIVATE_PROVIDER_MARKER'; }; },
    f => { f.context.verifyCanonical = async () => { f.identity.stateOverridesSha256 = 'c'.repeat(64); }; },
    f => { f.context.snapshotEvidence = () => { throw new Error('PRIVATE_PROVIDER_MARKER'); }; }]) {
    const f = fixture(); change(f); unavailable(await run(f));
  }
});
