import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { POLICY, REQUEST, STEPS, HARNESS, sha, json, decode } from './contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export function clock({ wall = Date.now, mono = () => performance.now() } = {}) {
  const w = wall(), m = mono(); let lastW = w, lastM = m, valid = true;
  return () => {
    const a = wall(), b = mono(); valid &&= Number.isFinite(a) && Number.isFinite(b) && a >= lastW && b >= lastM;
    lastW = a; lastM = b;
    const wallMs = a - w, monotonicMs = b - m;
    return { wallMs, monotonicMs, elapsedMs: Math.max(wallMs, monotonicMs), valid };
  };
}
export function writer(directory, { existing = false } = {}) {
  if (!existing) fs.mkdirSync(directory, { recursive: false });
  const ledger = new Map();
  function row(name) {
    assert(/^[a-zA-Z0-9._-]+$/.test(name));
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink()); const b = fs.readFileSync(file);
    return { path: name, bytes: b.length, sha256: sha(b) };
  }
  if (existing) for (const name of fs.readdirSync(directory)) ledger.set(name, row(name));
  function save(name, value) {
    assert(/^[a-zA-Z0-9._-]+$/.test(name) && !ledger.has(name));
    const b = Buffer.isBuffer(value) ? value : Buffer.from(json(value));
    const fd = fs.openSync(path.join(directory, name), 'wx');
    try { fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const saved = { path: name, bytes: b.length, sha256: sha(b) }; assert.deepEqual(row(name), saved); ledger.set(name, saved); return saved;
  }
  function check() {
    assert.deepEqual(fs.readdirSync(directory).sort(), [...ledger.keys()].sort());
    for (const [name, expected] of ledger) assert.deepEqual(row(name), expected);
  }
  return { save, check, seal() { check(); const manifest = { schemaVersion: 1, files: [...ledger.values()].sort((a,b) => a.path.localeCompare(b.path)) };
    return save('manifest.json', manifest).sha256; } };
}
export async function sourceIdentity() {
  const { loadLocalApi } = await import('../../src/local-loader.js');
  const api = await loadLocalApi(); assert(api); await api.assertSourcesUnchanged();
  assert.deepEqual(api.LOCAL_EXAMPLES[0].request, REQUEST);
  const harness = HARNESS.map(name => { const stat = fs.lstatSync(path.join(HERE, name)); assert(stat.isFile() && !stat.isSymbolicLink());
    const b = fs.readFileSync(path.join(HERE, name)); return { path: name, bytes: b.length, sha256: sha(b) }; });
  return { implementation: api.implementation, harness };
}
export async function prepare(directory) {
  const source = await sourceIdentity(), w = writer(directory);
  w.save('source-before.json', source);
  const plan = { schemaVersion: 1, policy: POLICY, request: REQUEST, sequence: STEPS,
    sourceSha256: sha(json(source)), root: ROOT, sourceBytesArchived: false };
  const planSha256 = w.save('plan.json', plan).sha256; w.check();
  return { directory, planSha256, sourceSha256: plan.sourceSha256, implementationSha256: source.implementation.sourceSha256 };
}

// A single native HTTP request; no redirects, retries, credentials or public URL.
// All event listeners are installed before dispatch. Abort retains the bounded
// body prefix and explicitly observes request and response closure.
export async function httpExchange({ index, step, now, requestImpl = http.request }) {
  assert.deepEqual(step, STEPS[index]);
  const started = now(), requestText = index === 2 ? JSON.stringify(REQUEST) : '';
  const row = { index, method: step.method, url: POLICY.origin + step.path, requestText, requestBytes: Buffer.byteLength(requestText), requestSha256: sha(requestText),
    started, httpStatus: null, responseHeaders: [], responseBase64: '', responseBytes: 0, responseSha256: sha(''), observedBytes: 0,
    completeBody: false, requestClosed: false, responseClosed: false, dispatched: false, error: null };
  const remaining = POLICY.totalMs - started.elapsedMs, timeoutMs = Math.max(1, Math.floor(Math.min(index < 2 ? POLICY.setupMs : remaining, remaining)));
  row.timeoutMs = timeoutMs;
  if (!started.valid || started.elapsedMs < 0 || remaining <= 0) { row.error = 'CLIENT_DEADLINE'; row.finished = now(); return row; }
  const cap = index < 2 ? POLICY.setupBytes : POLICY.resultBytes;
  return await new Promise(resolve => {
    let req, res, timer, closeTimer, done = false; const chunks = [];
    function finish() {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(closeTimer);
      const body = Buffer.concat(chunks); row.responseBase64 = body.toString('base64'); row.responseBytes = body.length; row.responseSha256 = sha(body); row.finished = now();
      if (!row.finished.valid || row.finished.elapsedMs > POLICY.totalMs || row.finished.elapsedMs - started.elapsedMs > timeoutMs) row.error ??= 'CLIENT_DEADLINE';
      if (!row.requestClosed || (res && !row.responseClosed)) row.error ??= 'CLIENT_CLOSE_UNCONFIRMED';
      resolve(row);
    }
    function closed() { if (row.requestClosed && (!res || row.responseClosed) && (row.completeBody || row.error)) finish(); }
    function stop(code) {
      row.error ??= code; res?.destroy(); req?.destroy();
      closeTimer ??= setTimeout(finish, POLICY.closeMs); closed();
    }
    timer = setTimeout(() => stop('CLIENT_TIMEOUT'), timeoutMs);
    try {
      row.dispatched = true;
      req = requestImpl(row.url, { method: step.method, agent: false, headers: { accept: 'application/json', connection: 'close',
        ...(index === 2 ? { 'content-type': 'application/json', 'content-length': row.requestBytes } : {}) } }, response => {
        res = response; row.httpStatus = response.statusCode; row.responseHeaders = [...response.rawHeaders];
        response.on('data', chunk => {
          if (done) return; const bytes = Buffer.from(chunk); row.observedBytes += bytes.length;
          const kept = chunks.reduce((n,b) => n + b.length, 0), room = Math.max(0, cap - kept);
          chunks.push(Buffer.from(bytes.subarray(0, room)));
          if (row.observedBytes > cap) stop('CLIENT_RESPONSE_LIMIT');
          else { const t = now(); if (!t.valid || t.elapsedMs > POLICY.totalMs || t.elapsedMs - started.elapsedMs > timeoutMs) stop('CLIENT_DEADLINE'); }
        });
        response.on('end', () => { row.completeBody = true; closed(); });
        response.on('aborted', () => stop('CLIENT_RESPONSE_ABORTED'));
        response.on('error', () => stop('CLIENT_RESPONSE_ERROR'));
        response.on('close', () => { row.responseClosed = true; if (!row.completeBody) row.error ??= 'CLIENT_RESPONSE_INCOMPLETE'; closed(); });
      });
      req.on('error', () => stop('CLIENT_CONNECTION_ERROR'));
      req.on('close', () => { row.requestClosed = true; closed(); });
      req.end(requestText || undefined);
    } catch { stop('CLIENT_DISPATCH_ERROR'); }
  });
}
export async function run({ directory, planSha256, exchange = httpExchange, identity = sourceIdentity, clockOptions } = {}) {
  const read = name => decode(fs.readFileSync(path.join(directory,name)));
  assert.equal(sha(fs.readFileSync(path.join(directory,'plan.json'))), planSha256);
  const plan = read('plan.json'), before = read('source-before.json');
  assert.deepEqual(plan.policy, POLICY); assert.deepEqual(plan.request, REQUEST); assert.deepEqual(plan.sequence, STEPS);
  assert.equal(plan.sourceSha256, sha(json(before))); assert.deepEqual(await identity(), before);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['plan.json','source-before.json']);
  const w = writer(directory, { existing: true }), now = clock(clockOptions), rows = [];
  w.save('STARTED.json', { planSha256, sourceSha256: plan.sourceSha256, at: new Date().toISOString() });
  let error = null, sourceUnchanged = false, report = null;
  try {
    for (const [index, step] of STEPS.entries()) {
      const row = await exchange({ index, step, now }); rows.push(row); w.save(`http-${index + 1}.json`,row);
      if (row.error || !row.completeBody || !row.requestClosed || !row.responseClosed || row.httpStatus !== 200) throw Error(row.error ?? 'HTTP_' + row.httpStatus);
      const parsed = decode(Buffer.from(row.responseBase64,'base64'));
      if (index === 0) { assert.equal(parsed.status,'ok'); assert.equal(parsed.readOnly,true); assert.equal(parsed.version,before.implementation.version); }
      if (index === 1) { assert.equal(parsed.localEvm?.available,true); assert(parsed.localEvm.capabilities.chainIds.includes(11155111)); assert.deepEqual(parsed.localEvm.examples[0].request,REQUEST); }
      if (index === 2) { report = parsed; w.save('api-response.json', report); }
    }
  } catch (e) { error = { phase: rows.length, message: String(e.message).slice(0,4096) }; }
  try { const after = await identity(); w.save('source-after.json',after); sourceUnchanged = JSON.stringify(after) === JSON.stringify(before); }
  catch(e) { w.save('source-after-error.json',{ message:String(e.message).slice(0,4096) }); }
  w.check(); const terminal = now();
  const withinDeadline = terminal.valid && terminal.wallMs >= 0 && terminal.monotonicMs >= 0 && terminal.elapsedMs <= POLICY.totalMs;
  const result = { schemaVersion:1, planSha256, sourceSha256:plan.sourceSha256, httpRequests:rows.length,
    postDispatched:rows.some(r=>r.method==='POST' && r.dispatched), clientComplete:error===null && rows.length===3, error,
    sourceUnchanged, withinDeadline, terminal, apiStatus:report?.status??null, executionStatus:report?.execution?.status??null,
    usable:error===null && sourceUnchanged && withinDeadline && report?.status==='complete' && report?.source?.canonicalStatus==='verified',
    publicRpcRequests:report?.transportEvidence?.length??null, independentClientEvidence:false };
  w.save('result.json',result); const manifestSha256 = w.seal();
  return { ...result, manifestSha256 };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode,directory,pin] = process.argv.slice(2);
  if (mode === 'prepare') console.log(json(await prepare(path.resolve(directory))));
  else if (mode === 'run') console.log(json(await run({ directory:path.resolve(directory),planSha256:pin })));
  else throw Error('Use prepare <directory> or run <directory> <plan SHA256>.');
}
