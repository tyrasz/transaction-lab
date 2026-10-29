import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const POLICY = Object.freeze({ endpoint: 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111,
  sender: '0x6efb29cee3b414272eb7a8f3ebabf873d36bc033', recipient: '0x000000000000000000000000000000000000dead',
  value: '1000000000000000', gas: '21000', calls: 12, responseBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024,
  requestMs: 25000, selectionMs: 30000, productEndMs: 85000, productMs: 55000, finalHeaderMs: 110000,
  loopbackEndMs: 115000, drainMs: 5000, totalMs: 120000, retries: 0,
  loopback: 'http://127.0.0.1:5174/api/evm/local-preview' });
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const error = e => ({ name: String(e?.name ?? 'Error'), message: String(e?.message ?? e).slice(0, 2000), code: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : null });
export const REQUEST = Object.freeze({ from: POLICY.sender, to: POLICY.recipient, value: POLICY.value, gas: POLICY.gas, data: '0x' });
export const QUERIES = Object.freeze([POLICY.sender, POLICY.recipient].map(account => Object.freeze({ kind: 'native_balance', account })));

export async function sourceIdentity() {
  const { loadLocalApi } = await import('../../src/local-loader.js');
  const api = await loadLocalApi(); assert(api); await api.assertSourcesUnchanged();
  const harness = ['PLAN.md', 'run.mjs', 'verify.mjs', 'run.test.mjs'].map(name => {
    const b = fs.readFileSync(path.join(HERE, name)); return { path: name, bytes: b.length, sha256: sha(b) };
  });
  const identity = { implementation: api.implementation, harness };
  return { identity, sha256: sha(JSON.stringify(identity)), check: () => api.assertSourcesUnchanged() };
}
export function writer(directory) {
  fs.mkdirSync(directory); const ledger = new Map(); let sealed = false;
  function save(name, value) {
    assert(!sealed && /^[a-zA-Z0-9._-]+$/.test(name));
    const bytes = Buffer.from(json(value)), fd = fs.openSync(path.join(directory, name), 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const row = { path: name, bytes: bytes.length, sha256: sha(bytes) }; ledger.set(name, row); return row;
  }
  function check() {
    assert.deepEqual(fs.readdirSync(directory).sort(), [...ledger.keys()].sort());
    for (const row of ledger.values()) { const p = path.join(directory, row.path), stat = fs.lstatSync(p); assert(stat.isFile() && !stat.isSymbolicLink()); const b = fs.readFileSync(p); assert.equal(b.length, row.bytes); assert.equal(sha(b), row.sha256); }
  }
  function seal() { check(); const rows = [...ledger.values()].sort((a,b) => a.path.localeCompare(b.path)); const row = save('manifest.json', { schemaVersion: 1, files: rows }); sealed = true; return row; }
  return { save, check, seal };
}

// Native fetch only; no retry/batch/fallback transport. Timed-out work is kept
// in active/cancelling until it actually settles and cannot write late files.
export function recorder({ fetchImpl = fetch, wall = Date.now, mono = () => performance.now() } = {}) {
  const startWall = wall(), startMono = mono(), rows = [], active = new Set(), cancelling = new Set();
  let bytes = 0, publicCalls = 0, closed = false, hardFailure = null;
  function sample() {
    const wallMs = wall() - startWall, monotonicMs = mono() - startMono;
    if (![wallMs,monotonicMs].every(n => Number.isFinite(n) && n >= 0)) hardFailure ??= 'clock_reversal';
    return { wallMs, monotonicMs, elapsedMs: Math.max(wallMs, monotonicMs) };
  }
  function check(endMs) { const t = sample(); assert(!closed && !hardFailure && t.elapsedMs < endMs && t.elapsedMs < POLICY.totalMs, hardFailure ?? 'phase_deadline'); return t; }
  function track(set, p) { set.add(p); p.then(() => set.delete(p), () => set.delete(p)); return p; }
  function cancel(reader) { if (reader) { try { track(cancelling, Promise.resolve(reader.cancel())); } catch { hardFailure ??= 'reader_cancel_failed'; } } }
  async function exchange(url, body, { phase, endMs, signal } = {}) {
    const begun = check(endMs); if (url === POLICY.endpoint) { assert(publicCalls < POLICY.calls, 'RPC_count_limit'); publicCalls++; }
    const row = { index: rows.length + 1, phase, url, requestText: body, requestBytes: Buffer.byteLength(body), requestSha256: sha(body), started: begun,
      httpStatus: null, responseBase64: '', responseBytes: 0, responseSha256: sha(''), completeBody: false, error: null };
    rows.push(row); const controller = new AbortController(); let reader, timer, finished = false, chunks = [], count = 0;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort(); cancel(reader); reject(Error('request_or_phase_deadline')); }, Math.max(1, Math.min(POLICY.requestMs, endMs - begun.elapsedMs, POLICY.totalMs - begun.elapsedMs))); });
    const task = track(active, (async () => {
      const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: controller.signal });
      assert(!finished && !controller.signal.aborted); row.httpStatus = response.status;
      assert(response.body?.getReader, 'response_body_missing'); reader = response.body.getReader();
      while (true) {
        const part = await reader.read(); assert(!finished && !controller.signal.aborted); check(endMs);
        if (part.done) break;
        const b = Buffer.from(part.value); count += b.length; bytes += b.length;
        if (count > POLICY.responseBytes || bytes > POLICY.totalBytes) { hardFailure ??= 'response_byte_limit'; cancel(reader); throw Error(hardFailure); }
        chunks.push(b);
      }
      row.completeBody = true; return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    })());
    try { const text = await Promise.race([task, timeout]); check(endMs); assert.equal(row.httpStatus, 200, 'HTTP_status'); return text; }
    catch (e) { row.error = error(e); throw e; }
    finally {
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); abort(); if (!row.completeBody) cancel(reader);
      const retained = Buffer.concat(chunks); row.responseBase64 = retained.toString('base64'); row.responseBytes = retained.length; row.responseSha256 = sha(retained); row.finished = sample();
    }
  }
  async function rpc(method, params, phase, endMs, signal) {
    const id = publicCalls + 1, body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const text = await exchange(POLICY.endpoint, body, { phase, endMs, signal }), reply = JSON.parse(text);
    assert(reply && !Array.isArray(reply) && reply.jsonrpc === '2.0' && reply.id === id);
    assert(Object.hasOwn(reply, 'result') !== Object.hasOwn(reply, 'error'), 'RPC_envelope');
    if (reply.error) throw Object.assign(Error(String(reply.error.message)), { code: reply.error.code }); return reply.result;
  }
  async function drain() {
    closed = true; let timer;
    try { await Promise.race([Promise.allSettled([...active, ...cancelling]), new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(POLICY.drainMs, POLICY.totalMs - sample().elapsedMs))); })]); }
    finally { clearTimeout(timer); }
    const timing = sample(); return { complete: active.size === 0 && cancelling.size === 0, active: active.size, cancelling: cancelling.size, hardFailure, publicCalls, responseBytes: bytes, timing,
      withinDeadline: !hardFailure && timing.elapsedMs <= POLICY.totalMs };
  }
  return { rpc, exchange, sample, check, drain, rows, terminal() { const timing = sample(); return { timing, hardFailure }; } };
}

export async function runSmoke({ directory = path.join(HERE, 'capture'), expectedSourceSha256, fetchImpl = fetch } = {}) {
  assert(/^[0-9a-f]{64}$/.test(expectedSourceSha256 ?? ''), 'explicit_source_pin_required');
  const source = await sourceIdentity(); assert.equal(source.sha256, expectedSourceSha256);
  const w = writer(directory); w.save('STARTED.json', { startedAt: new Date().toISOString(), sourceSha256: source.sha256 });
  w.save('source.json', source.identity); w.save('plan.json', { schemaVersion: 1, policy: POLICY, request: REQUEST, queries: QUERIES, sourceSha256: source.sha256,
    priorV2ManifestSha256: 'ed60aad67ef1a2656a08b3d3ff5228fcd5492d576d78eac6a76c6044e99a460c', execution: 'owned_internal_isolated_engine', publicHttpSupportClaim: false });
  const t = recorder({ fetchImpl }), report = { status: 'unavailable', usable: false, error: null, headerConfirmed: false, sourceUnchanged: false, preview: null, publicHttp: null };
  let header, phaseError;
  try {
    assert.equal(await t.rpc('eth_chainId', [], 'selection', POLICY.selectionMs), '0xaa36a7');
    header = await t.rpc('eth_getBlockByNumber', ['latest', false], 'selection', POLICY.selectionMs);
    const { verifyEthereumHeader } = await import('../../engines/local-evm/ethereum-header.js');
    const verification = verifyEthereumHeader({ header, expectedHash: header?.hash, chainId: POLICY.chainId });
    w.save('header.json', header); w.save('header-verification.json', verification);
    w.save('request.json', { chainId: POLICY.chainId, request: REQUEST, queries: QUERIES, blockHash: header.hash });
    const { executeIsolatedEthereumPreview } = await import('../../engines/local-evm/isolated-call.js');
    const rpc = { call(method, params, signal) {
      assert(['eth_getProof','eth_getCode'].includes(method), 'input_method');
      assert([POLICY.sender,POLICY.recipient].includes(params[0]), 'input_account');
      assert.deepEqual(params.at(-1), { blockHash: header.hash, requireCanonical: true });
      if (method === 'eth_getProof') assert.deepEqual(params[1], []);
      return t.rpc(method, params, 'input', POLICY.productEndMs, signal?.signal ?? signal);
    } };
    const remaining = Math.floor(POLICY.productEndMs - t.check(POLICY.productEndMs).elapsedMs);
    report.preview = await executeIsolatedEthereumPreview({ request: REQUEST, queries: QUERIES, chainId: POLICY.chainId, header, rpc,
      limits: { wallMs: Math.min(POLICY.productMs, remaining), requestMs: 20000, calls: 8, responseBytes: POLICY.responseBytes, totalResponseBytes: POLICY.totalBytes,
        drainMs: 1000, inputs: { accounts: 4, slots: 1 }, execution: { gas: 1000000, steps: 10000, frames: 16, traceBytes: 1048576 } } });
    const row = w.save('preview.json', report.preview); w.save('PRODUCT_SEALED.json', { previewSha256: row.sha256, wireCount: t.rows.length, timestamp: t.sample() });
    t.check(POLICY.productEndMs);
  } catch (e) { report.error = error(e); phaseError = e; }
  if (header) {
    try { const final = await t.rpc('eth_getBlockByNumber', [header.number, false], 'final_header', POLICY.finalHeaderMs); w.save('final-header.json', final); assert(isDeepStrictEqual(final, header), 'selected_header_changed'); t.check(POLICY.finalHeaderMs); report.headerConfirmed = true; }
    catch (e) { report.error ??= error(e); }
    const input = { chainId: POLICY.chainId, ...REQUEST, block: header.hash, queries: QUERIES };
    try {
      const before = t.rows.length;
      try { const text = await t.exchange(POLICY.loopback, JSON.stringify(input), { phase: 'public_http', endMs: POLICY.loopbackEndMs }); report.publicHttp = { response: JSON.parse(text) }; }
      catch (e) { report.publicHttp = { error: error(e) }; }
      const row = t.rows[before];
      if (row) { report.publicHttp.httpStatus = row.httpStatus; if (row.completeBody) { try { report.publicHttp.response = JSON.parse(Buffer.from(row.responseBase64, 'base64').toString('utf8')); } catch { /* retained raw bytes */ } } }
      w.save('public-http.json', { request: input, ...report.publicHttp });
      t.check(POLICY.loopbackEndMs);
    } catch (e) { report.publicHttp = { error: error(e) }; report.error ??= error(e); }
  }
  report.transport = await t.drain();
  for (const row of t.rows) w.save('wire-' + String(row.index).padStart(2, '0') + '.json', row);
  try { const after = await sourceIdentity(); assert.equal(after.sha256, source.sha256); await source.check(); report.sourceUnchanged = true; }
  catch (e) { report.error ??= error(e); }
  const terminal = t.terminal(); report.transport.terminalAfterIntegrity = terminal.timing;
  report.transport.hardFailure ??= terminal.hardFailure;
  report.transport.withinDeadline &&= !terminal.hardFailure && terminal.timing.elapsedMs <= POLICY.totalMs;
  report.usable = !phaseError && !report.error && report.headerConfirmed && report.sourceUnchanged && report.transport.complete && report.transport.withinDeadline
    && report.preview?.status === 'completed' && report.preview.preview?.status === 'complete';
  report.status = report.usable ? 'completed' : 'unavailable';
  w.save('results.json', report); const manifest = w.seal();
  return { directory, manifestSha256: manifest.sha256, status: report.status, usable: report.usable, execution: report.preview?.preview?.original?.output?.execution ?? null,
    measurements: report.preview?.preview?.measurements ?? null, publicHttp: report.publicHttp, transport: report.transport, error: report.error };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'inspect') { const source = await sourceIdentity(); console.log(json({ sourceSha256: source.sha256, implementationSha256: source.identity.implementation.sourceSha256, files: source.identity.implementation.inventory.length, runtime: source.identity.implementation.runtime })); }
  else if (process.argv[2] === 'run') console.log(json(await runSmoke({ expectedSourceSha256: process.argv[3] })));
  else throw Error('Use inspect or run <exact reviewed source SHA256>.');
}
