import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileMeasurementQuery, normalizeMeasurementQuery, normalizeQuery, simulateUnsignedCall, simulateUnsignedSequence, validatePositionTrace, validateQueryTrace } from '../unsigned-call.js';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const tuple = values => '0x' + values.map(n => word(n).slice(2)).join('');
const S = address(11), USER = address(12), TARGET = address(13), TOKEN = address(21), AAVE = address(31), MORPHO = address(41), IMPL = address(51), PROBE = address(0xba1a);
const MARKET = word(100), BLOCK = word(90), MAX = (1n << 256n) - 1n;
const HEADER = { hash: BLOCK, parentHash: word(89), mixHash: word(91), miner: address(92), number: hex(9000001), timestamp: hex(1700000000), gasLimit: hex(30000000), baseFeePerGas: hex(17000000000) };
const REQUEST = { from: S, to: TARGET, data: '0x11111111', value: '0x0', gas: '0x4c4b40' };
const QUERIES = [
  { to: TOKEN, data: '0x70a08231' + word(S).slice(2) },
  { kind: 'aave_v3_user_account_data', contract: AAVE, user: USER },
  { kind: 'morpho_blue_position', contract: MORPHO, user: USER, marketId: MARKET },
];
const initial = () => ({
  [S]: { nonce: 7n, balance: 1000000n },
  [TOKEN]: { storage: { [word(1)]: 100n } },
  [AAVE]: { storage: { [word(1)]: 9007199254740993n, [word(2)]: 19n, [word(3)]: 23n, [word(4)]: 8250n, [word(5)]: 8000n, [word(6)]: MAX } },
  [MORPHO]: { storage: { [word(1)]: (1n << 128n) + 9n, [word(2)]: 7n, [word(3)]: 123n } },
});
const amountKeys = ['beforeRaw', 'afterRaw', 'deltaRaw', 'beforeReturnData', 'afterReturnData', 'rows', 'basis'];
function assertNoAmounts(row) { for (const key of amountKeys) assert.equal(row[key], undefined, key); }

// Synthetic isolated state controls, not live protocol evidence. Every request
// starts from the same baseline plus only its actual supplied overrides. Query
// values are read from that state; query nonce changes never become global state.
function harness({ mutate, originalFailed = false } = {}) {
  const records = [];
  function state(overrides = {}) {
    const result = initial();
    for (const [account, changes] of Object.entries(overrides)) {
      if (account === PROBE) continue;
      assert(result[account], 'No undeclared account override');
      for (const key of ['nonce', 'balance']) if (changes[key] !== undefined) result[account][key] = BigInt(changes[key]);
      for (const [slot, value] of Object.entries(changes.stateDiff ?? {})) result[account].storage[slot] = BigInt(value);
      assert.equal(changes.state, undefined, 'No complete storage replacement');
    }
    return result;
  }
  const rpc = { async call(method, params) {
    const record = { method, params: structuredClone(params) }; records.push(record);
    let result, stage = method;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') result = structuredClone(HEADER);
    else if (method === 'eth_getTransactionCount') result = '0x7';
    else if (method === 'eth_getBalance') result = hex(1000000);
    else if (method === 'eth_getCode') result = [S, PROBE].includes(params[0]) ? '0x' : '0x60006000f3';
    else if (method === 'debug_traceCall') {
      const [call, selector, options] = params, diff = options.tracer === 'prestateTracer', st = state(options.stateOverrides);
      assert.deepEqual(selector, { blockHash: BLOCK, requireCanonical: true });
      assert.deepEqual(Object.keys(call).sort(), ['data', 'from', 'gas', 'to', 'value'], 'Descriptors never leak into RPC envelopes');
      const frame = { type: 'CALL', from: call.from, to: call.to, input: call.data, value: call.value, gas: call.gas, gasUsed: '0x5208', output: '0x' };
      const nonceDiff = () => ({ pre: { [S]: { nonce: hex(st[S].nonce), balance: hex(st[S].balance) } }, post: { [S]: { nonce: hex(st[S].nonce + 1n) } } });
      if (call.to === PROBE) {
        stage = 'witness'; result = { ...frame, output: tuple([9000001, 1700000000, 30000000, 0, HEADER.mixHash, HEADER.miner, 1, HEADER.parentHash]) };
      } else if (call.to === TARGET && call.data === REQUEST.data) {
        stage = diff ? 'original_diff' : 'original_trace';
        if (originalFailed) result = diff ? nonceDiff() : { ...frame, error: 'execution reverted', output: '0xdead' };
        else if (!diff) result = frame;
        else {
          result = nonceDiff();
          const next = structuredClone(st);
          next[TOKEN].storage[word(1)] -= 5n;
          next[AAVE].storage[word(1)] += 5n; next[AAVE].storage[word(3)] += 3n; next[AAVE].storage[word(6)] -= 2n;
          next[MORPHO].storage[word(1)] -= 7n; next[MORPHO].storage[word(2)] += 2n; next[MORPHO].storage[word(3)] = 0n;
          for (const account of [TOKEN, AAVE, MORPHO]) {
            const before = {}, after = {};
            for (const [slot, value] of Object.entries(st[account].storage)) if (value !== next[account].storage[slot]) {
              before[slot] = word(value);
              if (next[account].storage[slot] !== 0n) after[slot] = word(next[account].storage[slot]);
            }
            result.pre[account] = { storage: before }; result.post[account] = { storage: after };
          }
        }
      } else {
        stage = (call.to === TOKEN ? 'token' : call.to === AAVE ? 'aave' : 'morpho') + (diff ? '_diff' : '_trace');
        assert.equal(call.gas, '0x493e0'); assert.equal(call.from, S); assert.equal(call.value, '0x0');
        if (diff) result = nonceDiff();
        else {
          if (call.to === TOKEN) { assert.equal(call.data, QUERIES[0].data); frame.output = word(st[TOKEN].storage[word(1)]); }
          else {
            assert([AAVE, MORPHO].includes(call.to));
            assert(call.data.startsWith(call.to === AAVE ? '0xbf92857c' : '0x93c52062'));
            if (call.to === MORPHO) assert.equal('0x' + call.data.slice(10, 74), MARKET);
            frame.output = tuple(Object.values(st[call.to].storage));
          }
          result = frame;
          if (call.to === AAVE) result.calls = [{ ...frame, type: 'DELEGATECALL', from: AAVE, to: IMPL, gas: '0x40000', gasUsed: '0x4000' }];
        }
      }
    } else assert.fail('Unexpected method: ' + method);
    const changed = mutate?.({ method, params, result, stage, records }); if (changed !== undefined) result = changed;
    record.result = structuredClone(result); return result;
  } };
  return { rpc, records, chainId: 1, blockHash: BLOCK, request: structuredClone(REQUEST), queries: structuredClone(QUERIES) };
}
const run = h => simulateUnsignedCall(h);
const sequence = (h, count = 2) => simulateUnsignedSequence({ ...h, calls: Array.from({ length: count }, () => ({ request: structuredClone(REQUEST), queries: structuredClone(h.queries) })) });

test('mixed compiler preserves legacy queries and binds typed identities to the outer chain only', () => {
  assert.deepEqual(normalizeMeasurementQuery(QUERIES[0], 1), normalizeQuery(QUERIES[0]));
  assert.deepEqual(compileMeasurementQuery(QUERIES[0], 1), { descriptor: QUERIES[0], query: QUERIES[0] });
  const result = compileMeasurementQuery({ ...QUERIES[1], contract: AAVE.toUpperCase().replace('0X', '0x') }, 8453);
  assert.deepEqual(result.descriptor, QUERIES[1]); assert.equal(result.position.identity.chainId, '8453');
  assert.equal(result.position.identity.user, USER); assert.notEqual(result.position.identity.user, S);
  assert.deepEqual(Object.keys(result.query).sort(), ['data', 'to']); assert.equal(result.position.returnBytes, 192);
  assert.throws(() => normalizeQuery(result.query), /Only canonical ERC-20/);
  for (const change of [{ chainId: 1 }, { data: result.query.data }, { to: AAVE }, { metadata: {} }, { kind: 'unknown' }]) assert.throws(() => compileMeasurementQuery({ ...QUERIES[1], ...change }, 1));
  let called = false; const getter = { ...QUERIES[1] }; Object.defineProperty(getter, 'user', { enumerable: true, get() { called = true; return USER; } });
  assert.throws(() => compileMeasurementQuery(getter, 1)); assert.equal(called, false);
});
test('mixed synthetic measurements keep stable indexes and all exact tuple rows, using four RPCs per tuple', async () => {
  const h = harness(), result = await run(h);
  assert.equal(result.execution.status, 'success'); assert.equal(result.canonicalStatus, 'verified');
  assert.deepEqual(result.request.queries, QUERIES); assert.deepEqual(result.measurements.map(r => r.status), ['measured', 'measured', 'measured']);
  assert.deepEqual([result.measurements[0].beforeRaw, result.measurements[0].afterRaw, result.measurements[0].deltaRaw], ['100', '95', '-5']);
  assert.deepEqual(result.measurements[1].rows.map(r => r.deltaRaw), ['5', '0', '3', '0', '0', '-2']);
  assert.equal(result.measurements[1].rows[0].beforeRaw, '9007199254740993'); assert.equal(result.measurements[1].rows[5].beforeRaw, MAX.toString());
  assert.deepEqual(result.measurements[2].rows.map(r => r.deltaRaw), ['-7', '2', '-123']);
  for (const [i, row] of result.measurements.entries()) {
    assert.deepEqual(row.query, compileMeasurementQuery(QUERIES[i], 1).query);
    if (i > 0) { assert.equal(row.position.identity.user, USER); assert.equal(row.contractIdentityVerified, false); assert.equal(row.beforeRaw, undefined); assert.equal(row.beforeReturnData.length, 2 + row.position.returnBytes * 2); }
    const calls = h.records.filter(r => r.method === 'debug_traceCall' && r.params[0].to === row.query.to && r.params[0].data === row.query.data);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].params[2].stateOverrides, undefined); assert.equal(calls[1].params[2].stateOverrides, undefined);
    assert.deepEqual(calls[2].params[2].stateOverrides, calls[3].params[2].stateOverrides);
    assert.equal(calls[2].params[2].stateOverrides[MORPHO].stateDiff[word(3)], word(0));
    assert.equal(calls[2].params[2].stateOverrides[S].nonce, '0x8');
  }
  assert.equal(result.accounting.rpcCalls, 27); assert.equal(result.accounting.limits.queries, 8);
});
test('wrong tuple widths, uint128 overflow and failed mutation proofs stay unavailable locally without partial amounts', async () => {
  const changes = [
    x => { if (x.stage === 'morpho_trace') x.result.output = word(1); },
    x => { if (x.stage === 'morpho_trace' && x.params[2].stateOverrides) x.result.output = tuple([1n, 1n << 128n, 1n]); },
    x => { if (x.stage === 'morpho_diff') x.result.post[MORPHO] = { storage: { [word(1)]: word(99) } }; },
    x => { if (x.stage === 'morpho_diff') x.result.post[S].balance = hex(999999); },
    x => { if (x.stage === 'morpho_diff') x.result.post[S].nonce = '0x99'; },
  ];
  for (const mutate of changes) {
    const result = await run(harness({ mutate }));
    assert.equal(result.canonicalStatus, 'verified'); assert.equal(result.measurements[0].status, 'measured'); assert.equal(result.measurements[1].status, 'measured');
    const row = result.measurements[2]; assert.equal(row.status, 'unavailable'); assertNoAmounts(row); assert.equal(row.position.identity.marketId, MARKET);
  }
});
test('tuple query paths retain bounded context, type, value, event and failure guards', async () => {
  for (const change of [
    t => { t.calls[0].input = '0x0'; }, t => { t.calls[0].output = '0x0'; }, t => { t.calls[0].from = S; },
    t => { t.calls[0].type = 'CALL'; }, t => { t.calls[0].value = '0x1'; }, t => { t.calls[0].error = 'execution reverted'; },
    t => { t.calls[0].logs = [{ address: AAVE, topics: [], data: '0x' }]; }, t => { t.input = '0xbf92857c' + word(S).slice(2); },
    t => { t.gas = '0x493df'; }, t => { t.error = []; },
  ]) {
    const result = await run(harness({ mutate: x => { if (x.stage === 'aave_trace') change(x.result); } }));
    assert.equal(result.canonicalStatus, 'verified'); assert.equal(result.measurements[1].status, 'unavailable'); assertNoAmounts(result.measurements[1]); assert.equal(result.measurements[2].status, 'measured');
  }
});
test('global canonical failure clears scalar and tuple payloads but keeps identities and raw evidence', async () => {
  const result = await run(harness({ mutate: x => { if (x.method === 'eth_getBlockByNumber') x.result.hash = word(999); } }));
  assert.equal(result.canonicalStatus, 'unverified');
  for (const row of result.measurements) { assert.equal(row.status, 'unavailable'); assertNoAmounts(row); }
  assert.equal(result.measurements[1].position.identity.user, USER);
  const evidenceId = result.measurements[1].queryEvidence[1].traceEvidenceId;
  assert.equal(result.evidence[evidenceId - 1].result.output.length, 386);
});
test('original revert leaves every typed query not applicable and makes no tuple execution calls', async () => {
  const h = harness({ originalFailed: true }), result = await run(h);
  assert.equal(result.execution.status, 'reverted_or_failed'); assert.equal(result.canonicalStatus, 'verified');
  assert.deepEqual(result.measurements.map(r => r.status), ['not_applicable', 'not_applicable', 'not_applicable']);
  for (const row of result.measurements) assertNoAmounts(row);
  assert.equal(h.records.filter(r => r.method === 'debug_traceCall').length, 4);
  assert.equal(result.revertStateValidation.status, 'verified');
  assert.equal(h.records.some(r => r.method === 'debug_traceCall' && [TOKEN,AAVE,MORPHO].includes(r.params[0].to)), false);
});
test('eight mixed/typed descriptors share the unchanged query budget, while duplicates or a ninth reject before RPC', async () => {
  const h = harness(); h.queries = Array.from({ length: 8 }, (_, i) => ({ ...QUERIES[1], user: address(100 + i) }));
  const result = await run(h); assert.equal(result.canonicalStatus, 'verified'); assert.equal(result.measurements.filter(r => r.status === 'measured').length, 8);
  assert.equal(h.records.filter(r => r.method === 'debug_traceCall' && r.params[0].data.startsWith('0xbf92857c')).length, 32);
  assert(result.accounting.rpcCalls <= 64);
  for (const queries of [[...h.queries, { ...QUERIES[1], user: address(200) }], [QUERIES[1], { ...QUERIES[1] }], [{ ...QUERIES[2], contract: PROBE }], [{ ...QUERIES[2], chainId: 2 }]]) {
    const invalid = harness(); invalid.queries = queries; const rejected = await run(invalid);
    assert.equal(rejected.canonicalStatus, 'unverified'); assert.equal(invalid.records.length, 0);
  }
});
test('typed before queries in a sequence use the preceding full state; query nonces are discarded', async () => {
  const h = harness(), result = await sequence(h);
  assert.equal(result.sequence.status, 'completed'); assert.equal(result.canonicalStatus, 'verified');
  const first = result.steps[0].result, second = result.steps[1].result;
  assert.equal(second.startingState.overrides[S].nonce, '0x8');
  for (const index of [1, 2]) {
    assert.equal(second.measurements[index].beforeReturnData, first.measurements[index].afterReturnData);
    for (const observation of second.measurements[index].queryEvidence) {
      const trace = second.evidence[observation.traceEvidenceId - 1], mutation = second.evidence[observation.mutationEvidenceId - 1];
      assert.deepEqual(trace.params[2].stateOverrides, mutation.params[2].stateOverrides);
      if (observation.state === 'before') assert.deepEqual(trace.params[2].stateOverrides, second.startingState.overrides);
      assert.equal(BigInt(mutation.result.pre[S].nonce), observation.state === 'before' ? 8n : 9n);
    }
  }
  assert.equal(second.measurements[1].rows[0].afterRaw, '9007199254741003');
  assert.deepEqual(second.measurements[2].rows.map(r => r.deltaRaw), ['-7', '2', '0']);
});
test('sequence final shared failure removes every tuple/scalar value from all steps', async () => {
  let canonical = 0;
  const result = await sequence(harness({ mutate: x => { if (x.method === 'eth_getBlockByNumber' && ++canonical === 3) x.result.stateRoot = word(999); } }));
  assert.equal(result.sequence.status, 'unavailable'); assert.equal(result.canonicalStatus, 'unverified');
  for (const step of result.steps) for (const row of step.result.measurements) { assert.equal(row.status, 'unavailable'); assertNoAmounts(row); }
  assert(result.steps[0].result.evidence.some(e => e.method === 'debug_traceCall' && e.result?.output?.length === 386));
});
test('all later typed sequence inputs validate before the first provider call', async () => {
  for (const query of [{ ...QUERIES[2], marketId: word(1).slice(0, -2) }, { ...QUERIES[1], kind: 'unknown' }, { ...QUERIES[1], contract: PROBE }, { ...QUERIES[1], chainId: 1 }]) {
    const h = harness();
    await assert.rejects(simulateUnsignedSequence({ ...h, calls: [{ request: REQUEST, queries: QUERIES }, { request: REQUEST, queries: [query] }] }));
    assert.equal(h.records.length, 0);
  }
});
test('a query-local tuple failure does not alter the validated sequence continuation', async () => {
  let broken = false;
  const result = await sequence(harness({ mutate: x => { if (!broken && x.stage === 'morpho_trace') { broken = true; x.result.output = '0x'; } } }));
  assert.equal(result.sequence.status, 'completed'); assert.equal(result.canonicalStatus, 'verified');
  assert.equal(result.steps[0].result.measurements[2].status, 'unavailable'); assertNoAmounts(result.steps[0].result.measurements[2]);
  assert.equal(result.steps[1].result.measurements[2].rows[0].beforeRaw, ((1n << 128n) + 2n).toString());
});

function recordedAaveBeforeTrace() {
  // Real v0.13.0 evidence stopped at this before-state callTracer result. It
  // contains NO mutation proof or after-state query for this position. This
  // fixture validates trace admission only, never a completed measurement.
  const directory = new URL('../../../reports/standard-evm-positions-v2/', import.meta.url);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = readFileSync(new URL('manifest.json', directory));
  assert.equal(sha(manifestBytes), '834962759a7629aabaedc4b778b828f4df92b11b4c8e548ad7b3648ff95d2f13');
  const bytes = readFileSync(new URL('aave-position-response.json', directory));
  assert.equal(sha(bytes), '7ab1e6e063ae9f023ea16935736f19b27994b503c325fe09f8b2c09df94c7571');
  const report = JSON.parse(bytes), manifest = JSON.parse(manifestBytes);
  assert.deepEqual(manifest.files.find(x => x.path === 'aave-position-response.json'), { path: 'aave-position-response.json', bytes: bytes.length, sha256: sha(bytes) });
  const row = report.measurements[4];
  assert.equal(row.status, 'unavailable'); assert.equal(row.reason, 'Query delegate does not preserve its input and output.');
  assert.deepEqual(row.queryEvidence, [{ state: 'before', traceEvidenceId: 30 }]); assertNoAmounts(row);
  const evidence = report.evidence[29], wire = report.transportEvidence[29];
  assert.equal(wire.id, 30); assert.equal(wire.requestText, JSON.stringify(wire.request));
  assert.equal(sha(wire.requestText), wire.requestSha256);
  assert.equal(sha(wire.responseText), '61599329ed7d6fad86df5502b7412b73b350d3408a4172bf297fba3702bf8828');
  assert.equal(wire.transport.responseSha256, sha(wire.responseText));
  assert.deepEqual(wire.request.params, evidence.params); assert.deepEqual(JSON.parse(wire.responseText).result, evidence.result);
  assert.equal(evidence.params[2].tracer, 'callTracer'); assert.equal(evidence.params[2].stateOverrides, undefined);
  return { raw: evidence.result, call: evidence.params[0], position: row.position };
}

test('real sealed Aave before-trace admits its internal library ABI without inventing a measurement', () => {
  const { raw, call, position } = recordedAaveBeforeTrace();
  const proxy = raw.calls[0], library = proxy.calls[1];
  assert.equal(proxy.to, '0x728a138a4823392c2efa55e028d434f526fe03cf');
  assert.equal(library.type, 'DELEGATECALL'); assert.equal(library.to, '0xd70593841c57cbaa04957cc3eace95708e48853b');
  assert.equal(library.from, call.to); assert.equal(proxy.input.slice(0, 10), '0xbf92857c'); assert.equal(library.input.slice(0, 10), '0x26ec273f');
  assert.notEqual(library.input, proxy.input);
  assert.equal(validatePositionTrace(raw, call, position), raw.output);
  assert.equal(raw.output.length, 386);
});

test('mutations of the real Aave trace still reject context, type, value, events, failures and wrong root tuples', () => {
  const recorded = recordedAaveBeforeTrace();
  for (const change of [
    t => { t.calls[0].calls[1].from = t.calls[0].to; },
    t => { t.calls[0].calls[1].type = 'CALL'; },
    t => { t.calls[0].calls[1].type = 'CALLCODE'; },
    t => { t.calls[0].calls[1].value = '0x1'; },
    t => { t.calls[0].calls[1].logs = [{ address: t.to, topics: [], data: '0x' }]; },
    t => { t.calls[0].calls[1].error = 'execution reverted'; },
    t => { t.calls[0].calls[1].revertReason = 'reverted internal query'; },
    t => { t.calls[0].calls[1].input = '0x0'; },
    t => { t.calls[0].calls[1].output = '0x0'; },
    t => { t.calls[0].calls[1].gasUsed = '0x100000'; },
    t => { t.output = word(1); },
    t => { t.input = '0xbf92857c' + word(0).slice(2); },
    t => { t.gas = '0x493df'; },
  ]) {
    const raw = structuredClone(recorded.raw); change(raw);
    assert.throws(() => validatePositionTrace(raw, recorded.call, recorded.position));
  }
  for (const change of [{ signature: 'fake(address)' }, { returnBytes: 32 }, { identity: { ...recorded.position.identity, user: USER } }]) {
    assert.throws(() => validatePositionTrace(recorded.raw, recorded.call, { ...recorded.position, ...change }));
  }
});

const libraryAbi = trace => {
  // Synthetic valid bytes deliberately differ in selector AND return length:
  // no selector-specific exception or equal-size assumption is permitted.
  const delegate = trace.calls[0]; delegate.input = '0x1234'; delegate.output = '0xaabbcc';
};
test('synthetic typed library ABI differences remain subject to both state proofs and complete overrides', async () => {
  const valid = harness({ mutate: x => { if (x.stage === 'aave_trace') libraryAbi(x.result); } });
  const report = await run(valid); assert.equal(report.measurements[1].status, 'measured');
  const evidence = report.measurements[1].queryEvidence;
  assert.equal(evidence.length, 2);
  for (const proof of evidence) {
    const trace = report.evidence[proof.traceEvidenceId - 1], diff = report.evidence[proof.mutationEvidenceId - 1];
    assert.deepEqual(trace.params[2].stateOverrides, diff.params[2].stateOverrides);
    assert.equal(diff.params[2].tracer, 'prestateTracer');
  }
  for (const corrupt of [
    d => { d.post[AAVE] = { storage: { [word(2)]: word(100) } }; },
    d => { d.post[S].balance = hex(999999); },
    d => { d.post[S].nonce = '0x20'; },
    d => { d.post[S].code = '0x6000'; },
  ]) {
    const result = await run(harness({ mutate: x => {
      if (x.stage === 'aave_trace') libraryAbi(x.result);
      if (x.stage === 'aave_diff' && x.params[2].stateOverrides) corrupt(x.result);
    } }));
    assert.equal(result.canonicalStatus, 'verified'); assert.equal(result.measurements[1].status, 'unavailable');
    assertNoAmounts(result.measurements[1]); assert.equal(result.measurements[0].status, 'measured');
  }
});

test('legacy scalar token delegates still require exact forwarding of input and output', () => {
  const call = { from: S, to: TOKEN, data: QUERIES[0].data, value: '0x0', gas: '0x493e0' };
  const raw = { type: 'CALL', from: S, to: TOKEN, input: call.data, output: word(17), value: '0x0', gas: call.gas, gasUsed: '0x1000' };
  raw.calls = [{ ...raw, type: 'DELEGATECALL', from: TOKEN, to: IMPL, gas: '0x40000', gasUsed: '0x800' }];
  assert.equal(validateQueryTrace(raw, call).amountRaw, '17');
  for (const change of [c => { c.input = '0x1234'; }, c => { c.output = '0xaabbcc'; }, c => { c.output = word(18); }]) {
    const changed = structuredClone(raw); change(changed.calls[0]);
    assert.throws(() => validateQueryTrace(changed, call), /does not preserve/);
  }
});

test('typed library paths cannot retain amounts after single or sequence canonical failure', async () => {
  for (const ordered of [false, true]) {
    let canonical = 0;
    const h = harness({ mutate: x => {
      if (x.stage === 'aave_trace') libraryAbi(x.result);
      if (x.method === 'eth_getBlockByNumber' && ++canonical === (ordered ? 3 : 1)) x.result.hash = word(999);
    } });
    const output = ordered ? await sequence(h) : await run(h);
    assert.equal(output.canonicalStatus, 'unverified');
    const reports = ordered ? output.steps.map(step => step.result) : [output];
    for (const report of reports) {
      for (const row of report.measurements) { assert.equal(row.status, 'unavailable'); assertNoAmounts(row); }
      assert(report.evidence.some(e => e.result?.calls?.[0]?.input === '0x1234'));
    }
  }
});
