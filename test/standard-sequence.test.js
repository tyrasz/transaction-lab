import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
import { StandardRpcClient } from '../src/standard-rpc.js';
import { validateStandardSequence, simulateStandardSequence, STANDARD_SEQUENCE_EXAMPLES } from '../src/standard-simulation.js';
import { InputError } from '../src/validate.js';

const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const S = addr(11), R = addr(12), PROBE = addr(0xba1a), BLOCK = word(90);
const HEADER = { hash: BLOCK, parentHash: word(89), mixHash: word(91), miner: addr(92), number: hex(9000001), timestamp: hex(1700000000), gasLimit: hex(30000000), baseFeePerGas: hex(17000000000) };
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const query = { to: USDC, data: '0x70a08231' + word(S).slice(2) };
const input = () => ({ chainId: 1, from: S, block: BLOCK, calls: [{ to: R, data: '0x', value: '60' }, { to: R, data: '0x', value: '40', queries: [query] }] });

// Synthetic provider control, not chain evidence. Every trace starts from
// the same pinned baseline plus only the submitted state overrides.
function fixture({ revertSecond = false, changeFinal = false } = {}) {
  const records = []; let canonicalReads = 0;
  const rpc = { async call(method, params) {
    records.push({ method, params: structuredClone(params) });
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByHash') return structuredClone(HEADER);
    if (method === 'eth_getBlockByNumber') {
      const header = structuredClone(HEADER);
      if (params[0] !== 'latest' && ++canonicalReads === 3 && changeFinal) header.hash = word(999);
      return header;
    }
    if (method === 'eth_getTransactionCount') return params[0] === S ? '0x7' : '0x0';
    if (method === 'eth_getBalance') return params[0] === S ? '0xf4240' : '0x0';
    if (method === 'eth_getCode') return params[0] === USDC ? '0x60006000f3' : '0x';
    assert.equal(method, 'debug_traceCall');
    const [call, pinned, options] = params;
    assert.deepEqual(pinned, { blockHash: BLOCK, requireCanonical: true });
    const overrides = options.stateOverrides ?? {}, diff = options.tracer === 'prestateTracer';
    const nonce = BigInt(overrides[S]?.nonce ?? 7), sender = BigInt(overrides[S]?.balance ?? 1000000), receiver = BigInt(overrides[R]?.balance ?? 0);
    const frame = { type: 'CALL', from: call.from, to: call.to, input: call.data, value: call.value, gas: call.gas, gasUsed: '0x5208', output: '0x' };
    const mutation = { pre: { [S]: { nonce: Number(nonce), balance: hex(sender) } }, post: { [S]: { nonce: Number(nonce + 1n) } } };
    if (call.to === PROBE) {
      const accounts = [...overrides[PROBE].code.matchAll(/73([0-9a-f]{40})3161/g)].map(match => '0x' + match[1]);
      const values = [9000001, 1700000000, 30000000, 0, HEADER.mixHash, HEADER.miner, 1, HEADER.parentHash, ...accounts.map(a => a === S ? sender : a === R ? receiver : 0)];
      return diff ? mutation : { ...frame, output: '0x' + values.map(value => word(value).slice(2)).join('') };
    }
    if (call.to === USDC) return diff ? mutation : { ...frame, output: word(7) };
    assert.equal(call.to, R);
    if (revertSecond && nonce > 7n) return diff ? mutation : { ...frame, error: 'execution reverted' };
    if (!diff) return frame;
    mutation.post[S].balance = hex(sender - BigInt(call.value));
    mutation.pre[R] = { balance: hex(receiver) }; mutation.post[R] = { balance: hex(receiver + BigInt(call.value)) };
    return mutation;
  } };
  return { rpc, records };
}

test('sequence validation normalizes all calls together without accepting per-step sender, block or overrides', async () => {
  const normalized = validateStandardSequence(input());
  assert.deepEqual(normalized, input());
  assert.equal(Object.hasOwn(normalized.calls[0], 'queries'), false);
  assert.equal(validateStandardSequence({ ...input(), block: undefined }).block, 'latest');
  const changes = [
    x => x.calls.pop(), x => x.calls.push(x.calls[0], x.calls[0], x.calls[0]), x => { x.calls = new Array(2); },
    x => { x.chainId = 999; }, x => { x.from = 'invalid'; }, x => { x.block = 'pending'; },
    x => { x.queries = [query]; }, x => { x.previous = {}; }, x => { x.stateOverrides = {}; },
    ...['from', 'block', 'gas', 'gasPrice', 'nonce', 'previous', 'stateOverrides', 'signature'].map(key => x => { x.calls[1][key] = '0'; }),
    x => { x.calls[1].value = '0x0'; }, x => { x.calls[1].value = (1n << 256n).toString(); },
    x => { x.calls[1].queries = []; }, x => { x.calls[1].queries = null; }, x => { x.calls[1].queries = [query, query]; },
    x => { x.calls[1].to = 'invalid'; }, x => { x.calls[1].data = '0x0'; },
    x => { x.block = 'latest'; x.calls[1].to = PROBE; }, x => { x.block = 'latest'; x.from = PROBE; },
    x => { x.block = 'latest'; x.calls[1].queries = [{ ...query, to: PROBE }]; },
  ];
  let requests = 0;
  for (const change of changes) {
    const body = input(); change(body);
    await assert.rejects(simulateStandardSequence(body, { async call() { requests++; } }), InputError);
  }
  const accessor = input(); let getters = 0;
  Object.defineProperty(accessor.calls[1], 'to', { enumerable: true, get() { getters++; return R; } });
  assert.throws(() => validateStandardSequence(accessor), InputError);
  assert.equal(requests, 0); assert.equal(getters, 0);
});

test('constructed Aave example preserves the fixed discovery envelopes and labels their nonhistorical sequence', async () => {
  const fixed = JSON.parse(await readFile(new URL('../reports/standard-evm-sequence-discovery/continuation/index.json', import.meta.url)));
  const example = STANDARD_SEQUENCE_EXAMPLES[0], normalized = validateStandardSequence(example.input);
  assert.equal(normalized.block, fixed.blockHash); assert.equal(normalized.from, fixed.sender);
  for (const [i, key] of ['approval', 'supply'].entries()) {
    const { queries, ...call } = normalized.calls[i];
    const original = fixed.sequenceInputs[key];
    assert.deepEqual(call, { to: original.to, data: original.data, value: BigInt(original.value).toString() });
    assert.ok(queries.length >= 1 && queries.length <= 8);
  }
  assert.equal(example.reference.syntheticUnsignedSequence, true);
  assert.equal(example.reference.exactHistoricalReplay, false);
  assert.match(example.description, /not an original historical transaction pair/);
});

test('API projects independent step balances after carried state, preserving mixed auto/manual scope and raw evidence', async () => {
  const h = fixture(), body = input(), report = await simulateStandardSequence(body, h.rpc);
  assert.equal(report.sequence.status, 'completed'); assert.equal(report.canonicalStatus, 'verified');
  assert.deepEqual(report.apiRequest, body); assert.equal(report.security.status, 'not_assessed');
  assert.deepEqual(report.steps.map(step => step.input), body.calls);
  assert.deepEqual(report.steps.map(step => step.stateSource), [{ kind: 'initial_block' }, { kind: 'after_step', stepIndex: 0 }]);
  const [first, second] = report.steps.map(step => step.result);
  assert.equal(first.source.profile, 'unsigned_unpriced_block_end');
  assert.equal(second.source.profile, 'unsigned_unpriced_after_prior_calls');
  assert.deepEqual(second.source.stateSource, report.steps[1].stateSource);
  assert.equal(first.preview.scope, 'observed_queried_accounts'); assert.equal(second.preview.scope, 'explicit_queried_accounts');
  assert.deepEqual(first.preview.nativeBalances.find(row => row.account === S).deltaRaw, '-60');
  const sender = second.preview.nativeBalances.find(row => row.account === S);
  assert.deepEqual([sender.beforeRaw, sender.afterRaw, sender.deltaRaw], ['999940', '999900', '-40']);
  assert.equal(sender.delta, '-0.00000000000000004');
  assert.deepEqual(sender.startingBalance, second.nativeEffects.measurements.find(row => row.account === S).startingBalance);
  assert.equal(sender.startingBalance.pinnedRaw, '1000000'); assert.equal(sender.startingBalance.startingRaw, '999940');
  assert.equal(second.preview.queries[0].before, '0.000007'); assert.equal(second.preview.queries[0].accountIsSender, true);
  assert.equal(second.apiRequest.value, '40'); assert.equal(second.request.transaction.value, '0x28');
  assert.equal(second.startingState.priorCalls, 1); assert.ok(second.evidence.length > 0);
  assert.equal(report.accounting.rpcCalls, h.records.length);
});

test('sequence resolves latest once, keeps each step pinned and binds the complete selection header', async () => {
  const h = fixture(), report = await simulateStandardSequence({ ...input(), block: 'latest' }, h.rpc);
  assert.equal(report.sequence.status, 'completed');
  assert.equal(h.records.filter(row => row.method === 'eth_getBlockByNumber' && row.params[0] === 'latest').length, 1);
  assert.equal(report.source.blockSelection.resolvedHash, BLOCK);
  for (const step of report.steps) assert.deepEqual(step.result.source.blockSelection, report.source.blockSelection);
  const changed = fixture(); let first = true;
  const rpc = { async call(method, params) {
    const value = await changed.rpc.call(method, params);
    if (first) { first = false; value.extraSelectedContent = 'must match'; }
    return value;
  } };
  await assert.rejects(simulateStandardSequence({ ...input(), block: 'latest' }, rpc), { code: 'STANDARD_BLOCK_MISMATCH' });
});

test('a reverted later call preserves the verified prefix and explicitly skips subsequent calls', async () => {
  const h = fixture({ revertSecond: true }), body = input(); body.calls.push(body.calls[0]);
  const report = await simulateStandardSequence(body, h.rpc);
  assert.equal(report.sequence.status, 'stopped'); assert.equal(report.canonicalStatus, 'verified');
  assert.deepEqual(report.steps.map(step => step.status), ['completed', 'reverted_or_failed', 'skipped']);
  assert.equal(report.steps[0].result.preview.nativeBalances[0].status, 'measured');
  assert.deepEqual(report.steps[2].input, body.calls[2]); assert.equal(report.steps[2].result, undefined);
});

test('a final canonical failure is projected only after all prior token and native amounts are invalidated', async () => {
  const h = fixture({ changeFinal: true }), report = await simulateStandardSequence(input(), h.rpc);
  assert.equal(report.sequence.status, 'unavailable'); assert.equal(report.canonicalStatus, 'unverified');
  for (const step of report.steps) for (const row of [...step.result.preview.nativeBalances, ...step.result.preview.queries]) {
    assert.equal(row.status, 'unavailable');
    for (const key of ['beforeRaw', 'afterRaw', 'deltaRaw', 'before', 'after', 'delta']) assert.equal(row[key], undefined);
  }
});

async function server(t, options) {
  const server = createAppServer({ persist: false, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
const post = (base, body, route = '/api/evm/simulate-sequence', headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('sequence HTTP uses one bounded sequence transport and retains complete exact wire evidence', async t => {
  const h = fixture(), profiles = [];
  const base = await server(t, { standardRpcFactory(options) {
    profiles.push(options);
    return new StandardRpcClient({ ...options, fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body), result = await h.rpc.call(request.method, request.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } });
  } });
  const response = await post(base, input()); assert.equal(response.status, 200);
  const report = await response.json(); assert.equal(report.sequence.status, 'completed');
  assert.deepEqual(profiles, [{ profile: 'sequence' }]);
  assert.equal(report.transportEvidence.length, h.records.length);
  assert.ok(report.transportEvidence.every(row => row.responseText && row.transport.complete));
  assert.ok(report.implementation.sourceFiles.includes('engines/standard-evm/sequence-state.js'));
});

test('sequence HTTP rejects invalid later calls and external controls before provider creation', async t => {
  let factories = 0;
  const base = await server(t, { standardRpcFactory() { factories++; throw new Error('No provider is permitted.'); } });
  const invalid = input(); invalid.calls[1].from = R;
  assert.equal((await post(base, invalid)).status, 400);
  assert.equal((await post(base, input(), '/api/evm/simulate-sequence', { origin: 'https://external.invalid' })).status, 403);
  assert.equal((await post(base, input(), '/api/evm/simulate-sequence', { 'content-type': 'text/plain' })).status, 400);
  assert.equal(factories, 0);
});

test('sequence absence is explicit and cannot fall back to a single-call engine', async t => {
  const base = await server(t, { standardLoader: async () => null, standardRpcFactory() { assert.fail('No transport permitted.'); } });
  const response = await post(base, input()); assert.equal(response.status, 503);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.standardEvm.sequenceCapabilities.available, false); assert.deepEqual(config.standardEvm.sequenceExamples, []);
});

test('sequence body cap admits four full-size calls without raising the existing single-call body cap', async t => {
  let factories = 0, requests = 0;
  const base = await server(t, { standardRpcFactory() { factories++; return { async call() { requests++; return '0x2'; } }; } });
  const maximum = input(); maximum.calls = Array.from({ length: 4 }, () => ({ to: R, data: '0x' + '00'.repeat(32768), value: '0' }));
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) > 128 * 1024);
  const accepted = await post(base, maximum); assert.equal(accepted.status, 200);
  const report = await accepted.json(); assert.equal(report.sequence.status, 'unavailable');
  assert.equal(report.steps.length, 4); assert.equal(factories, 1); assert.equal(requests, 1);
  const previous = factories;
  const tooBig = await post(base, { ...input(), padding: 'x'.repeat(384 * 1024) });
  assert.equal(tooBig.status, 400); assert.equal((await tooBig.json()).error.code, 'REQUEST_TOO_LARGE');
  const single = await post(base, maximum, '/api/evm/simulate');
  assert.equal(single.status, 400); assert.equal((await single.json()).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(factories, previous);
});
