// Pure/fake-fetch controls only. Saved header clocks are injected; no network,
// EVM, target execution, source freezing or archive preparation occurs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureHeaderSelection } from './select-current-header.mjs';
import { replayHeaderSelection, HEADER_SELECTION_POLICY, SELECTION_ENDPOINT } from './selection.mjs';

const header = JSON.parse(readFileSync(new URL('../lending-local-sequence-v037/capture/inputs/001.json', import.meta.url))).header;
const base = Number(BigInt(header.timestamp)) * 1000 + 1000;
const sourceBinding = { intentPlanSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64) };
const sha = v => createHash('sha256').update(v).digest('hex');
const clock = () => ({ wallMs: base, monotonicMs: 0 });
const answer = (options, result) => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result });
function setup(overrides = {}) {
  const wires = [], requests = [];
  return { wires, requests, args: { sourceBinding, clock,
    save: (path, value) => { wires.push({ path, value: structuredClone(value) }); },
    fetchImpl: async (url, options) => { requests.push({ url, body: options.body }); return new Response(answer(options, requests.length === 1 ? '0x1' : header)); },
    ...overrides } };
}
function fakeReaderResponse(text, { cancel = async () => {}, headers = new Headers(), getReader } = {}) {
  let sent = false;
  return { ok: true, status: 200, headers, body: {
    cancel,
    getReader: getReader ?? (() => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(text) }), cancel })),
  } };
}

test('three fixed reads retain exact wire bytes, clocks and request/response joins before selection', async () => {
  const f = setup(), result = await captureHeaderSelection(f.args);
  assert.equal(result.error, null); assert.equal(result.selection.status, 'selected');
  assert.deepEqual(replayHeaderSelection(result.selection), result.selection);
  assert.equal(result.drain.complete, true); assert.equal(result.drain.pendingIo, 0); assert.equal(result.drain.pendingSaves, 0);
  assert.equal(result.usage.calls, 3); assert.equal(result.usage.savedWires, 3);
  assert.deepEqual(f.requests.map(r => JSON.parse(r.body)), [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: [header.number, false] },
  ]);
  let observed = 0;
  for (let i = 0; i < 3; i++) {
    const { path, value: wire } = f.wires[i], join = result.usage.wireJoins[i], req = result.selection.events[i * 2], res = result.selection.events[i * 2 + 1];
    assert.equal(path, `wire/000${i + 1}.json`); assert.equal(wire.url, SELECTION_ENDPOINT); assert.equal(wire.dispatched, true);
    assert.equal(wire.requestText, req.request.requestText); assert.deepEqual(wire.requestClock, req.clock); assert.deepEqual(wire.responseClock, res.clock);
    assert.equal(wire.rawBase64, res.record.responseBase64);
    assert.equal(join.requestSha256, sha(wire.requestText)); assert.equal(join.responseSha256, sha(Buffer.from(wire.rawBase64, 'base64')));
    assert.equal(join.observedBytes, wire.transport.observedBytes); assert.equal(join.saved, true);
    assert(!Object.hasOwn(wire, 'parsed')); assert(!Object.hasOwn(wire, 'responseText'));
    observed += wire.transport.observedBytes;
  }
  assert.equal(result.usage.observedBytes, observed);
  assert.equal(result.usage.retainedBytes, observed);
});

test('HTTP/rate-limit/raw malformed responses remain failure evidence with no retry', async () => {
  for (const [body, status] of [[' {"jsonrpc":"2.0","id":null,"error":{"code":-32000}}\n', 429], ['not json', 200], ['{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}', 200]]) {
    let calls = 0;
    const f = setup({ fetchImpl: async () => { calls++; return new Response(body, { status }); } });
    const result = await captureHeaderSelection(f.args);
    assert.equal(calls, 1); assert.equal(result.selection.status, 'unavailable'); assert(result.error);
    assert.equal(result.drain.complete, true); assert.equal(result.usage.savedWires, 1);
    assert.equal(Buffer.from(f.wires[0].value.rawBase64, 'base64').toString(), body);
    assert.equal(f.wires[0].value.httpStatus, status);
    assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
  }
});

test('overflow counts the entire received chunk while retaining only the bounded prefix', async () => {
  const bytes = Buffer.alloc(HEADER_SELECTION_POLICY.responseBytes + 37, 120);
  const f = setup({ fetchImpl: async () => new Response(bytes) });
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.observedBytes, bytes.length); assert.equal(result.usage.retainedBytes, HEADER_SELECTION_POLICY.responseBytes);
  assert.equal(Buffer.from(f.wires[0].value.rawBase64, 'base64').length, HEADER_SELECTION_POLICY.responseBytes);
  assert.equal(f.wires[0].value.transport.complete, false);
  assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
});

test('actual body cancellation rejection prevents the next request and is not drained', async () => {
  const f = setup({ fetchImpl: async (_, options) => fakeReaderResponse(answer(options, '0x1'), { cancel: async () => { throw Error('cancel rejected'); } }) });
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.usage.calls, 1); assert.equal(result.selection.status, 'unavailable');
  assert.equal(result.drain.cancelFailed, true); assert.equal(result.drain.complete, false); assert.equal(result.drain.pendingIo, 0);
  assert.equal(result.usage.savedWires, 1); assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
});

test('malformed headers or reader acquisition still cancel the acquired native body', async () => {
  for (const invalid of ['headers', 'reader']) {
    let cancelled = 0;
    const f = setup({ fetchImpl: async (_, options) => fakeReaderResponse(answer(options, '0x1'), {
      cancel: async () => { cancelled++; }, ...(invalid === 'headers' ? { headers: null } : { getReader: () => { throw Error('reader refused'); } }),
    }) });
    const result = await captureHeaderSelection(f.args);
    assert.equal(cancelled, 1); assert.equal(result.usage.calls, 1); assert.equal(result.selection.status, 'unavailable');
    assert.equal(result.drain.complete, true); assert.equal(result.usage.savedWires, 1);
  }
});

test('failed persistence preserves response transcript but withholds selection and later reads', async () => {
  let saves = 0;
  const f = setup({ save: () => { if (++saves === 2) throw Error('disk unavailable'); } });
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.usage.calls, 2); assert.equal(result.usage.savedWires, 1);
  assert.equal(result.usage.wireJoins[1].saved, false); assert.equal(result.drain.saveFailed, true); assert.equal(result.drain.complete, false);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.selection.events.filter(e => e.kind === 'response').length, 2);
  assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
});

test('late ignored-abort fetch remains pending at cutoff and cannot mutate returned records', async () => {
  let resolveFetch, offset = 0, cancelled = 0;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  const f = setup({ clock: () => ({ wallMs: base + offset, monotonicMs: offset }), fetchImpl: () => { offset = 60001; return pending; } });
  const result = await captureHeaderSelection(f.args), saved = JSON.stringify(f.wires), returned = JSON.stringify(result);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.drain.complete, false); assert(result.drain.pendingIo > 0);
  resolveFetch({ ok: true, status: 200, headers: new Headers(), body: { cancel: async () => { cancelled++; } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, 1); assert.equal(JSON.stringify(f.wires), saved); assert.equal(JSON.stringify(result), returned);
});

test('late read bytes are flagged even when native promises eventually settle', async () => {
  let offset = 0, resolveRead, cancelled = 0;
  const reading = new Promise(resolve => { resolveRead = resolve; });
  const f = setup({ clock: () => ({ wallMs: base + offset, monotonicMs: offset }), fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: {
    getReader: () => ({ read: () => { offset = 16001; setTimeout(() => resolveRead({ done: false, value: Buffer.from('late data') }), 40); return reading; }, cancel: async () => { cancelled++; } }),
  } }) });
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.usage.calls, 1); assert.equal(result.selection.status, 'unavailable'); assert.equal(result.drain.pendingIo, 0);
  assert.equal(result.drain.unaccountedData, true); assert.equal(result.drain.complete, false); assert.equal(cancelled, 1);
  assert.equal(f.wires[0].value.transport.retainedBytes, 0);
});

test('clock reversal before native dispatch yields unavailable with no invented wire', async () => {
  let samples = 0, calls = 0;
  const f = setup({ clock: () => ({ wallMs: base + (samples++ ? -1 : 0), monotonicMs: 0 }), fetchImpl: async () => { calls++; throw Error('must not dispatch'); } });
  const result = await captureHeaderSelection(f.args);
  assert.equal(calls, 0); assert.equal(f.wires.length, 0); assert.equal(result.usage.calls, 0);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.drain.clockInvalid, true); assert.equal(result.drain.complete, false);
  assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
});

test('terminal phase overrun after raw persistence preserves all three replies without selection', async () => {
  let offset = 0, saves = 0;
  const f = setup({ clock: () => ({ wallMs: base + offset, monotonicMs: offset }) });
  const save = f.args.save;
  f.args.save = (path, wire) => { save(path, wire); if (++saves === 3) offset = 60001; };
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.usage.calls, 3); assert.equal(f.wires.length, 3); assert.equal(result.usage.savedWires, 3);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.drain.timedOut, true); assert.equal(result.drain.complete, false);
  assert.equal(result.selection.events.filter(e => e.kind === 'response').length, 3);
  assert.equal(replayHeaderSelection(result.selection).status, 'unavailable');
});

test('pending asynchronous persistence is bounded and cannot claim drainage', async () => {
  let offset = 0;
  const f = setup({ clock: () => ({ wallMs: base + offset, monotonicMs: offset }), save: () => { offset = 59999; return new Promise(() => {}); } });
  // The fake clock change happens within save; a small subsequent clock advance
  // lets the phase watchdog terminate the still-pending write without real delay.
  setTimeout(() => { offset = 60001; }, 5);
  const result = await captureHeaderSelection(f.args);
  assert.equal(result.usage.calls, 1); assert.equal(result.selection.status, 'unavailable');
  assert.equal(result.drain.pendingSaves, 1); assert.equal(result.drain.saveFailed, true); assert.equal(result.drain.complete, false);
});

test('invalid initialization never fabricates a selection or dispatches a native request', async () => {
  let calls = 0;
  const f = setup({ sourceBinding: { ...sourceBinding, nodeSha256: '' }, fetchImpl: async () => { calls++; } });
  const result = await captureHeaderSelection(f.args);
  assert.equal(calls, 0); assert.equal(result.selection, null); assert(result.error); assert.equal(result.usage.calls, 0); assert.equal(f.wires.length, 0);
});

test('late fetch with throwing headers closes its acquired body without rewriting returned failure bytes', async () => {
  let resolveFetch, offset = 0, cancelled = 0;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  const f = setup({ clock: () => ({ wallMs: base + offset, monotonicMs: offset }), fetchImpl: () => { offset = 60001; return pending; } });
  const result = await captureHeaderSelection(f.args), saved = JSON.stringify(f.wires), returned = JSON.stringify(result);
  assert.equal(result.selection.status, 'unavailable'); assert.equal(result.drain.complete, false); assert(result.drain.pendingIo > 0);
  const late = { ok: true, status: 200, body: { cancel: async () => { cancelled++; } } };
  Object.defineProperty(late, 'headers', { get() { throw Error('late malformed headers'); } });
  resolveFetch(late); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, 1); assert.equal(JSON.stringify(f.wires), saved); assert.equal(JSON.stringify(result), returned);
});
