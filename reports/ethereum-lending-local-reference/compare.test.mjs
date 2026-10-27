import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { providerChanges, providerOutput, committedLogs, compareReference } from './compare.mjs';

const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), C = '0x' + 'cc'.repeat(32);
const Z = '0x' + '0'.repeat(64), W = '0x' + '0'.repeat(63) + '1';
const frame = (extra = {}) => ({ type: 'CALL', from: A, to: B, input: '0x', value: '0x0', gas: '0x10000', gasUsed: '0x10', ...extra });
const log = (extra = {}) => ({ address: B, topics: [C], data: '0x', ...extra });
const payload = ({ address, topics, data }) => ({ address, topics, data });
const inputs = { accounts: { [A]: { exists: true, nonce: '3', balance: '4', code: '0x', storage: { [Z]: Z } } }, provenance: [{ account: A, accountProof: { codeHash: C } }] };
const original = {
  plan: read('../ethereum-local-reference/plan.json'), local: read('../ethereum-local-reference/drpc-local.json'),
  product: read('../ethereum-local-reference/product-response.json')
};
function full({ local = original.local, product = original.product, request = original.plan.request, header = original.plan.header, implementation = original.plan.api.expectedImplementation } = {}) {
  return compareReference(local, product, request, header, implementation);
}
function mutateWire(product, id, mutate) {
  const row = product.transportEvidence.find(r => r.id === id), envelope = JSON.parse(row.responseText);
  mutate(envelope.result, row); row.responseText = JSON.stringify(envelope);
  row.transport.responseSha256 = sha(row.responseText); row.transport.observedBytes = Buffer.byteLength(row.responseText);
  row.requestText = JSON.stringify(row.request); row.requestBytes = Buffer.byteLength(row.requestText); row.requestSha256 = sha(row.requestText);
}
function rawTrace(name) {
  const product = read(`../standard-evm-auto/${name}-response.json`);
  const row = product.transportEvidence.find(r => r.request.method === 'debug_traceCall' && r.request.params[2].tracer === 'callTracer' && !r.request.params[2].stateOverrides);
  assert.equal(sha(row.responseText), row.transport.responseSha256);
  return JSON.parse(row.responseText).result;
}

test('genuine sealed transfer independently retains all five matching channels', () => {
  const result = full(); assert.equal(result.status, 'matched'); assert.equal(Object.keys(result.checks).length, 5);
  assert.equal(result.providerRootGas, '62224'); assert.equal(result.localTransactionStyleGas, '62224');
  assert.match(result.limitations.join(' '), /full call-tree equality is not claimed/);
});
for (const [name, count] of [['aave', 7], ['morpho', 16]]) test(`saved ${name} lending trace: actual hex ordering fields and omitted outputs`, () => {
  const trace = rawTrace(name), all = []; let omissions = 0;
  function walk(node) { if (!Object.hasOwn(node, 'output')) { omissions++; assert.equal(providerOutput(node), '0x'); } all.push(...(node.logs ?? [])); for (const c of node.calls ?? []) walk(c); }
  walk(trace); assert(omissions > 0); assert.equal(all.length, count);
  // This fixture has no failed frames: expected order comes from the saved
  // unique ordinal values, not the module's recursive ordering algorithm.
  all.sort((a, b) => Number(BigInt(a.index) - BigInt(b.index)));
  assert.deepEqual(all.map(x => Number(BigInt(x.index))), Array.from({ length: count }, (_, i) => i));
  assert.deepEqual(committedLogs(trace), all.map(payload));
  const numeric = structuredClone(trace);
  function convert(node) { for (const l of node.logs ?? []) { l.index = Number(BigInt(l.index)); l.position = Number(BigInt(l.position)); } for (const c of node.calls ?? []) convert(c); }
  convert(numeric); assert.deepEqual(committedLogs(numeric), all.map(payload));
});
test('output omission alone is empty; explicit malformed optional output and failure fields reject', () => {
  assert.equal(providerOutput(frame()), '0x'); assert.equal(providerOutput(frame({ output: '0x' })), '0x');
  for (const output of [undefined, null, [], ['0x'], 0, '', '0x0', '0X00']) assert.throws(() => providerOutput(frame({ output })));
  for (const error of ['', null, [], {}, 0, undefined]) assert.throws(() => committedLogs(frame({ error })));
  for (const revertReason of [null, [], {}, 0, undefined, 'revert without error']) assert.throws(() => committedLogs(frame({ revertReason })));
  assert.deepEqual(committedLogs(frame({ error: 'execution reverted', revertReason: 'known revert' })), []);
});
test('full comparison uses the declared omitted-empty output convention, never null coalescing', () => {
  // Explicit counterfactual unit control, not another live execution.
  const local = structuredClone(original.local), product = structuredClone(original.product);
  local.output.execution.returnData = '0x'; mutateWire(product, 8, trace => { delete trace.output; });
  assert.equal(full({ local, product }).status, 'matched');
  mutateWire(product, 8, trace => { trace.output = null; }); assert.equal(full({ local, product }).status, 'incomplete');
});
test('position-only logs merge around direct calls including reverted calls', () => {
  const first = log({ data: '0x01', position: '0x0' }), last = log({ data: '0x02', position: 2 }), child = log({ data: '0x03' });
  const t = frame({ logs: [first, last], calls: [frame({ error: 'execution reverted', logs: [log()] }), frame({ logs: [child] })] });
  assert.deepEqual(committedLogs(t), [first, child, last].map(payload));
  delete t.logs[0].position; assert.throws(() => committedLogs(t), /Ambiguous/);
});
test('indices with gaps and aliases are valid, duplicate/partial/conflicting indices are not', () => {
  const t = frame({ logs: [log({ index: '0x2', logIndex: 2 }), log({ index: 9, position: '0x0' })] });
  assert.equal(committedLogs(t).length, 2);
  for (const mutate of [x => { x.logs[1].index = 2; }, x => { delete x.logs[1].index; }, x => { x.logs[0].logIndex = 3; }]) {
    const bad = structuredClone(t); mutate(bad); assert.throws(() => committedLogs(bad));
  }
});
test('identical payloads cannot conceal reversed/interleaved sibling ranges or ancestor-position contradictions', () => {
  const same = n => log({ index: n });
  for (const t of [
    frame({ calls: [frame({ logs: [same(2)] }), frame({ logs: [same(1)] })] }),
    frame({ calls: [frame({ logs: [same(0), same(3)] }), frame({ logs: [same(1), same(2)] })] }),
    frame({ logs: [log({ index: 2, position: 0 })], calls: [frame({ logs: [same(1)] })] }),
    frame({ logs: [log({ index: 0, position: 1 })], calls: [frame({ logs: [same(1)] })] }),
    frame({ logs: [same(1)], calls: [frame({ logs: [same(0), same(2)] })] }),
    frame({ logs: [same(2), same(1)] })
  ]) assert.throws(() => committedLogs(t));
});
test('saved lending index/position mutation rejects even if payloads stay unchanged', () => {
  for (const name of ['aave', 'morpho']) {
    const t = rawTrace(name); let chosen;
    function descendantLogs(n) { return [...(n.logs ?? []), ...(n.calls ?? []).flatMap(descendantLogs)]; }
    function walk(n) {
      const descendants = (n.calls ?? []).flatMap(descendantLogs);
      if (!chosen && n.logs?.length && descendants.length) chosen = { node: n, log: n.logs[0], descendants };
      for (const c of n.calls ?? []) walk(c);
    }
    walk(t); assert(chosen);
    chosen.log.position = chosen.descendants.some(l => BigInt(l.index) < BigInt(chosen.log.index)) ? 0 : chosen.node.calls.length;
    assert.throws(() => committedLogs(t));
  }
});
test('failed ancestors exclude all descendant effects but never bypass structural validation', () => {
  const child = frame({ error: 'execution reverted', logs: [log({ index: 0 })], calls: [frame({ logs: [log({ index: 1 })] })] });
  assert.deepEqual(committedLogs(frame({ calls: [child, frame({ logs: [log({ index: 2 })] })] })), [payload(log())]);
  for (const mutate of [x => { x.calls[0].error = []; }, x => { x.calls[0].output = null; }, x => { x.calls[0].logs[0].topics = [[C]]; }, x => { x.calls[0].calls = null; }]) {
    const bad = structuredClone(child); mutate(bad); assert.throws(() => committedLogs(bad));
  }
});
test('canonical quantity and payload limits reject coercion, overflow, impossible positions and removed logs', () => {
  for (const value of ['0x00', '01', '0', '12', '0xA', -1, -0, 1.5, [], '0x100000000', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => committedLogs(frame({ logs: [log({ index: value })] })));
  for (const position of ['0', '1']) assert.throws(() => committedLogs(frame({ logs: [log({ position })] })));
  for (const change of [{ position: 1 }, { position: null }, { address: [B] }, { topics: [[C]] }, { topics: Array(5).fill(C) }, { data: ['0x'] }, { removed: true }, { removed: 0 }]) assert.throws(() => committedLogs(frame({ logs: [log(change)] })));
  for (const change of [{ calls: null }, { logs: null }, { type: 'CREATE2' }, { input: null }, { gasUsed: '0x10001' }, { type: 'STATICCALL', value: '0x1' }]) assert.throws(() => committedLogs(frame(change)));
});
test('frame, depth, log and byte bounds are explicit rather than truncating evidence', () => {
  assert.throws(() => committedLogs(frame({ calls: Array.from({ length: 1000 }, () => frame()) })), /excessive/i);
  let deep = frame(); for (let i = 0; i < 33; i++) deep = frame({ calls: [deep] }); assert.throws(() => committedLogs(deep), /excessive/i);
  assert.throws(() => committedLogs(frame({ logs: Array.from({ length: 2001 }, () => log()) })), /Excessive/);
  assert.throws(() => committedLogs(frame({ output: '0x' + '00'.repeat(4 * 1024 * 1024) })), /byte bound/);
});
test('sparse state changes require proven zero omissions and preserve clears', () => {
  assert.deepEqual(providerChanges({ pre: { [A]: { nonce: 3 } }, post: { [A]: { nonce: 4, storage: { [Z]: W } } } }, inputs), [{ address: A, nonce: { before: '0x3', after: '0x4' }, storage: [{ slot: Z, before: Z, after: W }] }]);
  const nonzero = structuredClone(inputs); nonzero.accounts[A].storage[Z] = W;
  assert.deepEqual(providerChanges({ pre: { [A]: { storage: { [Z]: W } } }, post: { [A]: {} } }, nonzero), [{ address: A, storage: [{ slot: Z, before: W, after: Z }] }]);
  assert.throws(() => providerChanges({ pre: { [A]: {} }, post: { [A]: { storage: { [Z]: Z } } } }, nonzero), /Omitted nonzero/);
  assert.throws(() => providerChanges({ pre: { [A]: {} }, post: { [A]: { nonce: 4 } } }, inputs), /Omitted nonzero/);
});
test('state lifecycle, unknown fields, coercion, code mutation and duplicate proof bindings reject', () => {
  for (const diff of [
    { pre: { [A]: {} }, post: {} }, { pre: {}, post: { [A]: {} } },
    { pre: { [A]: { surprise: 1 } }, post: { [A]: {} } }, { pre: { [A]: {} }, post: { [A]: { code: '0x01' } } },
    { pre: { [A]: { storage: { [Z]: [Z] } } }, post: { [A]: {} } }, { pre: { [A]: {} }, post: { [A]: { storage: { [W]: W } } } }
  ]) assert.throws(() => providerChanges(diff, inputs));
  const duplicate = structuredClone(inputs); duplicate.provenance.push(duplicate.provenance[0]);
  assert.throws(() => providerChanges({ pre: { [A]: {} }, post: { [A]: {} } }, duplicate));
});
test('raw envelope, nonce, header and implementation changes cannot match', () => {
  for (const mutate of [
    p => mutateWire(p, 8, (_, row) => { row.request.params[0].value = '0x1'; }),
    p => mutateWire(p, 8, (_, row) => { row.request.params[0].nonce = '0x1'; }),
    p => mutateWire(p, 8, (_, row) => { row.request.params[0].gasPrice = '0x0'; }),
    p => mutateWire(p, 8, (_, row) => { row.request.params[2].tracerConfig.onlyTopCall = true; }),
    p => mutateWire(p, 8, t => { t.value = '0x1'; }),
    p => mutateWire(p, 9, d => { d.post[original.plan.request.from].nonce++; }),
    p => mutateWire(p, 2, h => { h.timestamp = '0x1'; }),
    p => mutateWire(p, 20, h => { h.stateRoot = C; }),
    p => mutateWire(p, 20, h => { h.transactions = []; }),
    p => { p.implementation.sourceSha256 = 'changed'; },
    p => { p.transportEvidence.push(p.transportEvidence[0]); }
  ]) { const product = structuredClone(original.product); mutate(product); assert.notEqual(full({ product }).status, 'matched'); }
});
test('local retained-state/header/root binding and actual false channel values are preserved', () => {
  for (const mutate of [l => { l.output.stateDisposition = 'rolled_back'; }, l => { l.inputs.context.header.timestamp = '0x1'; }, l => { l.output.trace.input = '0x'; }, l => { l.output.environment.sourceParentHash = C; }]) {
    const local = structuredClone(original.local); mutate(local); assert.equal(full({ local }).status, 'incomplete');
  }
  const local = structuredClone(original.local); local.output.execution.returnData = '0x';
  const product = structuredClone(original.product); mutateWire(product, 9, d => { d.pre[original.plan.request.to].storage = null; });
  const result = full({ local, product }); assert.equal(result.status, 'mismatched'); assert.equal(result.checks.returnData, false); assert.match(result.reason, /Malformed storage/);
  assert.equal(full({ local: read('../ethereum-local-reference/publicnode-local.json') }).status, 'incomplete');
});
