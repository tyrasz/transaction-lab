import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHeaderSelection, replayHeaderSelection, assertFirstTargetFresh, HEADER_SELECTION_POLICY, SELECTION_ENDPOINT } from './selection.mjs';

// Saved genuine header; injected clocks intentionally place it near its original
// timestamp. These are input-only controls, not a new current-state observation.
const template = JSON.parse(readFileSync(new URL('../lending-local-sequence-v037/capture/inputs/001.json', import.meta.url)));
const header = template.header, base = Number(BigInt(header.timestamp)) * 1000 + 1000;
const binding = { intentPlanSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64) };
const clone = value => structuredClone(value);
const at = (wall = 0, mono = wall) => ({ wallMs: base + wall, monotonicMs: 100 + mono });
const create = () => createHeaderSelection({ sourceBinding: binding, started: at() });
function wire(request, result, extra = {}) {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(request.requestText).id, result }));
  return { ...request, httpStatus: 200, responseBase64: bytes.toString('base64'), responseBytesObserved: bytes.length, complete: true, error: null, ...extra };
}
function chain(s) { const r = s.request(at(1)); s.accept(wire(r, '0x1'), at(2)); }
function latest(s, value = header, receipt = at(4)) { const r = s.request(at(3)); s.accept(wire(r, value), receipt); }
function ready() { const s = create(); chain(s); latest(s); const r = s.request(at(5)); s.accept(wire(r, header), at(6)); return s; }

test('exactly three prescribed requests select one complete header; saved reduction agrees', () => {
  const s = ready(), result = s.finish(at(7));
  assert.equal(result.status, 'selected');
  assert.deepEqual(result.events.filter(e => e.kind === 'request').map(e => JSON.parse(e.request.requestText)), [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: [header.number, false] },
  ]);
  assert.deepEqual(replayHeaderSelection(result), result);
  assert.deepEqual(result.header, header);
  assert.equal(result.scope.sourceIdentityVerifiedHere, false);
  assert.equal(result.scope.nativeIoClosureVerifiedHere, false);
  assert.throws(() => s.request(at(8)), /No further/);
});

test('no retry, concurrent request, skipped read or completion after failure', () => {
  const s = create(), r = s.request(at(1));
  assert.throws(() => s.accept(wire(r, '0xaa36a7'), at(2)), /not mainnet/);
  assert.equal(replayHeaderSelection(s.snapshot()).status, 'unavailable');
  assert.throws(() => s.request(at(3)), /No further/);
  const concurrent = create(); concurrent.request(at(1));
  assert.throws(() => concurrent.request(at(2)), /No further/);
  assert.throws(() => create().finish(at(1)), /All three/);
});

test('raw transport and JSON-RPC identity failures are retained and withheld', () => {
  for (const mutate of [
    r => ({ ...r, endpoint: 'https://alternate.invalid' }),
    r => ({ ...r, requestText: r.requestText.replace('eth_chainId', 'eth_getBalance') }),
    r => ({ ...r, httpStatus: 429 }),
    r => ({ ...r, complete: false, error: 'cancelled' }),
    r => { const b = Buffer.from('{"jsonrpc":"2.0","id":2,"result":"0x1"}'); return { ...r, responseBase64: b.toString('base64'), responseBytesObserved: b.length }; },
    r => { const b = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1","error":null}'); return { ...r, responseBase64: b.toString('base64'), responseBytesObserved: b.length }; },
    r => { const b = Buffer.from('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"rate limited"}}'); return { ...r, httpStatus: 429, responseBase64: b.toString('base64'), responseBytesObserved: b.length }; },
  ]) {
    const s = create(), request = s.request(at(1)), raw = mutate(wire(request, '0x1'));
    assert.throws(() => s.accept(raw, at(2)));
    const saved = s.snapshot();
    assert.deepEqual(saved.events[1].record, raw);
    assert.equal(saved.header, null);
    assert.equal(replayHeaderSelection(saved).status, 'unavailable');
  }
});

test('header authenticity and complete canonical reread are both required', () => {
  const badHash = clone(header); badHash.stateRoot = '0x' + '00'.repeat(32);
  const s = create(); chain(s);
  assert.throws(() => latest(s, badHash), /do not hash/);
  assert.equal(replayHeaderSelection(s.snapshot()).status, 'unavailable');
  for (const mutate of [h => { h.number = '0x1'; }, h => { h.hash = '0x' + '00'.repeat(32); }, h => { h.transactions = []; }]) {
    const changed = clone(header); mutate(changed);
    assert.notDeepEqual(changed, header);
    const r = create(); chain(r); latest(r); const request = r.request(at(5));
    assert.throws(() => r.accept(wire(request, changed), at(6)), /complete selected header/);
    assert.equal(replayHeaderSelection(r.snapshot()).status, 'unavailable');
  }
});

test('stale and future selection uses header timestamp and latest receipt clock', () => {
  for (const shift of [120001, -31001]) {
    const start = { wallMs: Number(BigInt(header.timestamp)) * 1000 + shift, monotonicMs: 0 };
    const s = createHeaderSelection({ sourceBinding: binding, started: start });
    const request = s.request(start); s.accept(wire(request, '0x1'), start);
    const latestRequest = s.request(start);
    assert.throws(() => s.accept(wire(latestRequest, header), start), /stale or too far/);
    assert.equal(replayHeaderSelection(s.snapshot()).status, 'unavailable');
  }
});

test('both request clocks and both phase clocks are enforced; reversal is rejected', () => {
  for (const end of [at(15002, 2), at(2, 15002), at(0, 2), at(2, 0)]) {
    const s = create(), request = s.request(at(1));
    assert.throws(() => s.accept(wire(request, '0x1'), end), /budget|reversal/);
    assert.equal(replayHeaderSelection(s.snapshot()).status, 'unavailable');
  }
  for (const end of [at(60001, 6), at(6, 60001)]) {
    const s = ready();
    assert.throws(() => s.finish(end), /phase exceeded/);
  }
});

test('terminal drain and first-target freshness are separately bounded', () => {
  const selected = ready().finish(at(7));
  const last = selected.latestReceived;
  assert.equal(assertFirstTargetFresh(selected, { wallMs: last.wallMs + 180000, monotonicMs: last.monotonicMs + 180000 }).elapsedSinceLatestMs, 180000);
  for (const elapsed of [[180001, 10], [10, 180001], [-1, 10], [10, -1]]) {
    assert.throws(() => assertFirstTargetFresh(selected, { wallMs: last.wallMs + elapsed[0], monotonicMs: last.monotonicMs + elapsed[1] }), /freshness|reversal/);
  }
  assert.throws(() => ready().finish(at(10007)), /drain interval/);
  assert.throws(() => ready().finish(at(7, 10007)), /drain interval/);
});

test('bounded failure prefix is retained, while oversized observed body is unusable', () => {
  const s = create(), request = s.request(at(1));
  const raw = wire(request, null, { responseBase64: Buffer.from('prefix').toString('base64'), responseBytesObserved: HEADER_SELECTION_POLICY.responseBytes + 1, complete: false, error: 'body cap' });
  assert.throws(() => s.accept(raw, at(2)), /byte limit/);
  const saved = replayHeaderSelection(s.snapshot());
  assert.equal(saved.events[1].record.responseBase64, raw.responseBase64);
  assert.equal(saved.responseBytesObserved, HEADER_SELECTION_POLICY.responseBytes + 1);
  assert.equal(saved.status, 'unavailable');
});

test('invalid encodings, hidden properties and missing external pin are refused', () => {
  assert.throws(() => createHeaderSelection({ sourceBinding: { ...binding, nodeSha256: '' }, started: at() }), /SHA-256/);
  for (const value of ['abc', 'AA==\n']) {
    const s = create(), request = s.request(at(1));
    assert.throws(() => s.accept(wire(request, null, { responseBase64: value }), at(2)), /base64/);
  }
  const s = create(), request = s.request(at(1)); let touched = false;
  const hostile = wire(request, '0x1'); Object.defineProperty(hostile, 'complete', { enumerable: true, get() { touched = true; return true; } });
  assert.throws(() => s.accept(hostile, at(2)), /accessor/); assert.equal(touched, false);
  const utf = create(), utfRequest = utf.request(at(1));
  assert.throws(() => utf.accept(wire(utfRequest, null, { responseBase64: '/w==', responseBytesObserved: 1 }), at(2)), /encoded data/);
});

test('saved transcript recomputes hashes, counters, header, request and terminal status', () => {
  const selected = ready().finish(at(7));
  for (const mutate of [r => { r.responseBytesObserved++; }, r => { r.requests--; }, r => { r.header = null; },
    r => { r.events[1].responseSha256 = '0'.repeat(64); }, r => { r.events[0].request.requestText += ' '; },
    r => { r.status = 'unavailable'; }, r => { r.events.splice(1, 1); }, r => { r.events.push({ kind: 'finish', clock: at(8) }); }]) {
    const changed = clone(selected); mutate(changed);
    assert.throws(() => replayHeaderSelection(changed));
  }
});

test('explicit source/persistence/closure failure stays unavailable with full denominator delegated to coordinator', () => {
  const s = create(); chain(s);
  const failed = s.fail('Coordinator reports incomplete native I/O drainage.', at(3));
  assert.equal(replayHeaderSelection(failed).status, 'unavailable');
  assert.equal(failed.header, null);
  assert.throws(() => assertFirstTargetFresh(failed, at(4)), /No usable/);
  assert.equal(SELECTION_ENDPOINT, 'https://eth.drpc.org');
});

test('pre-event clock/schema failures retain replayable unavailable markers, never dispatch authority', () => {
  for (const end of [at(60001, 1), at(1, 60001)]) {
    const s = create();
    assert.throws(() => s.request(end), /phase exceeded/);
    const saved = replayHeaderSelection(s.snapshot());
    assert.equal(saved.requests, 0); assert.equal(saved.status, 'unavailable');
    assert.equal(saved.events[0].kind, 'failure');
    assert.throws(() => assertFirstTargetFresh(saved, end), /No usable/);
  }
  const malformed = create(), request = malformed.request(at(1));
  assert.throws(() => malformed.accept({ ...wire(request, '0x1'), extra: true }, at(2)), /unexpected fields/);
  const saved = replayHeaderSelection(malformed.snapshot());
  assert.equal(saved.status, 'unavailable'); assert.equal(saved.header, null);
  assert.equal(saved.events[1].kind, 'failure');
  assert.deepEqual(saved.events[1].clock, at(1), 'Unavailable marker uses last accepted clock, not an invented transport timestamp.');
});

test('late terminal work preserves all raw responses but cannot become selected by replay', () => {
  for (const end of [at(10007), at(7, 10007), at(60001)]) {
    const s = ready(); assert.throws(() => s.finish(end), /budget|drain/);
    const saved = replayHeaderSelection(s.snapshot());
    assert.equal(saved.status, 'unavailable');
    assert.equal(saved.events.filter(e => e.kind === 'response').length, 3);
    const forged = structuredClone(saved); forged.status = 'selected'; forged.header = header;
    assert.throws(() => replayHeaderSelection(forged));
  }
  const stale = ready().finish(at(7));
  stale.started.wallMs += 200000;
  for (const event of stale.events) event.clock.wallMs += 200000;
  stale.latestReceived.wallMs += 200000; stale.finished.wallMs += 200000;
  assert.throws(() => replayHeaderSelection(stale), /continues after selection failure/);
  const expired = create().fail('Coordinator timed out before selection completed.', at(60001));
  assert.equal(replayHeaderSelection(expired).status, 'unavailable');
});
