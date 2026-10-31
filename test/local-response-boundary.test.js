// HTTP response/persistence controls with synthetic adapter records and a
// bounded fake clock/store. No EVM execution or public RPC is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { validateLocalSimulation, withholdLocalSimulation, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { validateLocalSequence, withholdLocalSequence, LOCAL_SEQUENCE_CAPABILITIES } from '../src/local-sequence.js';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
const call = { to: B, data: '0x', value: '0' };
const input = sequence => ({ chainId: 1, from: A, ...(sequence ? { calls: [call, call] } : call), queries: [{ kind: 'native_balance', account: A }] });
const measurement = () => ({ status: 'measured', values: [{ beforeRaw: '100', afterRaw: '90', deltaRaw: '-10' }] });
function report(sequence) {
  const original = { output: { execution: { status: 'success' } } };
  const core = { inputs: {}, inputEvidence: [], inputUsage: {}, inputReads: {} };
  return { kind: sequence ? 'local_proof_sequence' : 'local_proof_preview', id: randomUUID(), createdAt: new Date().toISOString(), status: 'complete', error: null,
    source: { canonicalStatus: 'verified' }, transportEvidence: [],
    ...(sequence ? { steps: [0, 1].map(index => ({ index, request: { from: A, ...call }, status: 'completed', execution: { status: 'success' }, measurements: [measurement()] })),
      attempt: { status: 'completed', sequence: { ...core, steps: [0, 1].map(index => ({ index, request: { from: A, ...call }, original, measurements: [measurement()] })) } } }
      : { execution: { status: 'success' }, measurements: [measurement()], attempt: { status: 'completed', preview: { ...core, original, measurements: [measurement()] } } }) };
}
function withheld(value, sequence, code) {
  assert.equal(value.status, 'unavailable'); assert.equal(value.error.code, code); assert.equal(value.source.canonicalStatus, 'unverified');
  if (sequence) { assert.equal(value.attempt.sequence, null); assert(value.steps.every(step => step.execution.status === 'unavailable' && step.measurements.length === 0)); }
  else { assert.equal(value.attempt.preview, null); assert.equal(value.execution.status, 'unavailable'); assert.deepEqual(value.measurements, []); }
  assert(!JSON.stringify(value).includes('beforeRaw')); assert(!JSON.stringify(value).includes('deltaRaw'));
}

async function drive(t, { sequence, stage, publish, discard: afterDiscard, serialize, saveFailure = false, stageCleanupFailure = false, cleanupFailure = false, discardFallback = false, realStore = false, missingUsage = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-response-boundary-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { remaining: 10000, valid: true }, events = [], pending = new Map(), published = new Map();
  let signal, status, body, responseHeaders, cancels = 0;
  const req = Readable.from([Buffer.from(JSON.stringify(input(sequence)))]);
  Object.assign(req, { method: 'POST', url: sequence ? '/api/evm/local-sequence' : '/api/evm/local-preview', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, aborted: false });
  const res = new EventEmitter(); Object.assign(res, { destroyed: false, writableEnded: false,
    writeHead(value, headers) { status = value; responseHeaders = headers; return this; }, end(text) { body = JSON.parse(String(text)); this.writableEnded = true; events.push('response'); return this; } });
  const context = { clock, events, req, res, pending, published, get signal() { return signal; }, abort() { req.aborted = true; req.emit('aborted'); } };
  const store = {
    async stage(value, text) {
      events.push('stage'); assert.equal(signal.aborted, false); assert.equal(req.listenerCount('aborted'), 1); assert.equal(res.listenerCount('close'), 1);
      if (saveFailure) throw Error('Declared save failure');
      const token = { id: value.id, didPublish: false }; pending.set(token.id, text);
      await stage?.(context);
      if (stageCleanupFailure) throw Object.assign(Error('Declared stage cleanup failure'), { localReportToken: token });
      return token;
    },
    async publish(token) {
      events.push('publish'); token.publishAttempted = true; published.set(token.id, pending.get(token.id)); pending.delete(token.id); token.didPublish = true;
      await publish?.(context);
    },
    async discard(token, text) {
      events.push('discard'); assert(!text.includes('beforeRaw'));
      if (cleanupFailure) throw Error('Declared OS cleanup failure');
      pending.delete(token.id);
      if (discardFallback) published.set(token.id, text); else published.delete(token.id);
      await afterDiscard?.(context);
    },
  };
  const rpc = { ...(!missingUsage ? { usage: () => ({ remainingWallMs: clock.remaining, clockValid: clock.valid }) } : {}), cancel() { cancels++; } };
  const simulate = async (_input, _rpc, options) => {
    signal = options.signal; const value = report(sequence);
    if (serialize) Object.defineProperty(value, 'toJSON', { value() { serialize(context); return this; } });
    return value;
  };
  const api = { validateLocalSimulation, withholdLocalSimulation, LOCAL_CAPABILITIES, validateLocalSequence, withholdLocalSequence, LOCAL_SEQUENCE_CAPABILITIES,
    implementation: { name: 'synthetic response boundary', version: 'test' }, simulateLocal: simulate, simulateLocalSequence: simulate };
  const server = createAppServer({ persist: true, reportDir: directory, localLoader: async () => api, proofRpcFactory: () => rpc,
    ...(realStore ? {} : { localReportStore: store }) });
  try { await server.listeners('request')[0](req, res); } finally { req.destroy(); server.close(); }
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0); assert.equal(signal.aborted, true); assert(cancels >= 1);
  assert.match(responseHeaders['server-timing'], /^local_response;dur=\d+\.\d{3};desc="Adapter through final response check; excludes delivery"$/);
  return { ...context, directory, status, body, responseHeaders };
}

for (const sequence of [false, true]) {
  const mode = sequence ? 'sequence' : 'single';
  test(`${mode}: deadline crossed while serializing is withheld before staging`, async t => {
    const result = await drive(t, { sequence, serialize: ({ clock }) => { clock.remaining = 0; } });
    assert.equal(result.status, 200); withheld(result.body, sequence, 'LOCAL_PREVIEW_BUDGET'); assert.deepEqual(result.events, ['response']);
  });
  test(`${mode}: slow staging cannot publish actionable results after deadline`, async t => {
    const result = await drive(t, { sequence, stage: async ({ clock }) => { await Promise.resolve(); clock.remaining = 0; } });
    withheld(result.body, sequence, 'LOCAL_PREVIEW_BUDGET'); assert.deepEqual(result.events, ['stage', 'discard', 'response']);
    assert.equal(result.pending.size, 0); assert.equal(result.published.size, 0);
  });
  test(`${mode}: expiry during publication removes the saved actionable result`, async t => {
    const result = await drive(t, { sequence, publish: async ({ clock, published }) => { assert([...published.values()].every(text => text.includes('beforeRaw'))); await Promise.resolve(); clock.remaining = 0; } });
    withheld(result.body, sequence, 'LOCAL_PREVIEW_BUDGET'); assert.deepEqual(result.events, ['stage', 'publish', 'discard', 'response']);
    assert.equal(result.pending.size, 0); assert.equal(result.published.size, 0);
  });
  test(`${mode}: cancellation listeners survive publication and invalidate the saved report`, async t => {
    const result = await drive(t, { sequence, publish: async context => { assert.equal(context.signal.aborted, false); context.abort(); assert.equal(context.signal.aborted, true); } });
    withheld(result.body, sequence, 'LOCAL_PREVIEW_CANCELLED'); assert.equal(result.published.size, 0); assert(result.events.includes('discard'));
  });
  test(`${mode}: successful filesystem publication saves exactly the returned JSON without staging debris`, async t => {
    const result = await drive(t, { sequence, realStore: true }); assert.equal(result.status, 200); assert.equal(result.body.status, 'complete');
    const files = await readdir(join(result.directory, 'simulations')); assert.deepEqual(files, [result.body.id + '.json']);
    assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'simulations', files[0]), 'utf8')), result.body);
  });
  test(`${mode}: fallback after failed publication is unavailable before cleanup crosses the deadline`, async t => {
    const result = await drive(t, { sequence, discardFallback: true,
      publish: () => { throw Error('Declared retention failure after rename'); },
      discard: async ({ clock, published }) => {
        const saved = JSON.parse([...published.values()][0]); withheld(saved, sequence, 'LOCAL_PREVIEW_OUTPUT');
        await Promise.resolve(); clock.remaining = 0;
      } });
    withheld(result.body, sequence, 'LOCAL_PREVIEW_BUDGET');
    withheld(JSON.parse(result.published.get(result.body.id)), sequence, 'LOCAL_PREVIEW_OUTPUT');
    assert.deepEqual(result.events, ['stage', 'publish', 'discard', 'response']);
  });
  test(`${mode}: cleanup fallback cannot retain a complete result even while the HTTP response remains valid`, async t => {
    const result = await drive(t, { sequence, discardFallback: true, publish: () => { throw Error('Declared retention failure after rename'); } });
    assert.equal(result.body.status, 'complete'); assert(result.body.warnings.some(value => value.includes('could not be saved')));
    withheld(JSON.parse(result.published.get(result.body.id)), sequence, 'LOCAL_PREVIEW_OUTPUT');
  });
}

test('missing transport deadline metadata cannot bypass final response validation', async t => {
  const result = await drive(t, { sequence: true, missingUsage: true }); withheld(result.body, true, 'LOCAL_PREVIEW_BUDGET');
  assert.deepEqual(result.events, ['response']);
});

test('ordinary persistence failure retains a valid response with the existing warning', async t => {
  const result = await drive(t, { sequence: true, saveFailure: true });
  assert.equal(result.body.status, 'complete'); assert(result.body.warnings.some(value => value.includes('could not be saved'))); assert.equal(result.published.size, 0);
});

test('OS cleanup refusal remains an unavailable response and explicitly identifies the saved-file risk', async t => {
  const result = await drive(t, { sequence: true, cleanupFailure: true, publish: ({ clock }) => { clock.remaining = 0; } });
  withheld(result.body, true, 'LOCAL_PREVIEW_BUDGET');
  assert(result.body.warnings.some(value => value.includes('do not use that file')));
  assert.equal(result.published.size, 1, 'The control must retain the refused cleanup, not pretend filesystem rollback succeeded.');
});

test('a failed stage retains its cleanup token and cannot publish after a deadline', async t => {
  const result = await drive(t, { sequence: true, stageCleanupFailure: true, stage: ({ clock }) => { clock.remaining = 0; } });
  withheld(result.body, true, 'LOCAL_PREVIEW_BUDGET');
  assert.deepEqual(result.events, ['stage', 'discard', 'response']); assert.equal(result.pending.size, 0); assert.equal(result.published.size, 0);
});

test('refused staging cleanup is identified instead of silently losing a pending complete report', async t => {
  const result = await drive(t, { sequence: true, stageCleanupFailure: true, cleanupFailure: true, stage: ({ clock }) => { clock.remaining = 0; } });
  withheld(result.body, true, 'LOCAL_PREVIEW_BUDGET');
  assert(result.body.warnings.some(value => value.includes('do not use that file')));
  assert.equal(result.pending.size, 1); assert.equal(result.published.size, 0); assert(!result.events.includes('publish'));
});

test('HTTP timing includes awaited persistence without adding a self-referential JSON duration', async t => {
  let stagingElapsed = 0;
  const result = await drive(t, { sequence: true, stage: async () => {
    const began = performance.now(); await new Promise(resolve => setTimeout(resolve, 10)); stagingElapsed = performance.now() - began;
  } });
  const responseElapsed = Number(result.responseHeaders['server-timing'].match(/dur=([\d.]+)/)[1]);
  assert(responseElapsed >= stagingElapsed - 0.001, 'The final timing header must include the completed staging interval.');
  assert.deepEqual(JSON.parse(result.published.get(result.body.id)), result.body);
  assert.equal(result.body.responsePreparedMs, undefined); assert.equal(result.body.serverTiming, undefined);
});

test('post-publication retention failure removes the saved body before adding the response warning', async t => {
  const result = await drive(t, { sequence: true, publish: () => { throw Error('Declared retention failure after rename'); } });
  assert.equal(result.body.status, 'complete'); assert(result.body.warnings.some(value => value.includes('could not be saved')));
  assert.deepEqual(result.events, ['stage', 'publish', 'discard', 'response']); assert.equal(result.published.size, 0); assert.equal(result.pending.size, 0);
});
