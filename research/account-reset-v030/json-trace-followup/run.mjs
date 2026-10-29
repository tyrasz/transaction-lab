import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { sha, json, save, walk, entry, checkSources, BINARY_SHA } from '../archive.mjs';
import { LIMITS, inspectOutputFiles, OutputBoundsError, validTime, validProcessTime, validProcessOutput } from '../run.mjs';
import { parseRootTrace, comparePrefix } from './trace.mjs';

export const PREFIX = 'research/account-reset-v030/json-trace-followup';
export const ORIGINAL = Object.freeze({ manifest: 'df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1', plan: '38dd6775fd91592ca3e152e27994c840b6eebaf8101ef53a12066f43f657a3f7', source: 'f8ad4fa047b5db8117829b310889d39ab356700a68fd09e9bda82356caa0c787' });
const OWN = ['run.mjs', 'trace.mjs', 'run.test.mjs', 'PLAN.md'];
const decode = b => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
const copy = (from, to, mode = 0o644) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, fs.readFileSync(from), { flag: 'wx', mode }); fs.chmodSync(to, mode); };
export function checkedRaw(bytes) {
  const raw = decode(bytes); assert.equal(raw.process.status, 0); assert.equal(raw.process.signal, null); assert.equal(raw.process.error, null);
  assert(validProcessTime(raw.process)); assert(validProcessOutput(raw));
  for (const stream of [raw.stdout, raw.stderr]) { const b = Buffer.from(stream.base64, 'base64'); assert.equal(b.toString('base64'), stream.base64); assert.equal(b.length, stream.bytes); assert.equal(sha(b), stream.sha256); }
  assert.deepEqual(decode(Buffer.from(raw.stdout.base64, 'base64')), raw.result);
  return raw.result;
}
export function checkInherited(capture) {
  const base = path.join(capture, 'inherited'), mb = fs.readFileSync(path.join(base, 'manifest.json')); assert.equal(sha(mb), ORIGINAL.manifest);
  const manifest = decode(mb), index = new Map(manifest.files.map(f => [f.path, f]));
  const read = p => { const f = entry(base, p); assert.deepEqual(f, index.get(p)); return fs.readFileSync(path.join(base, p)); };
  assert.equal(sha(read('plan.json')), ORIGINAL.plan); assert.equal(sha(read('source-manifest.json')), ORIGINAL.source);
  const oldPlan = decode(read('plan.json')), rows = [], expectedPaths = ['manifest.json', 'plan.json', 'source-manifest.json'];
  assert.deepEqual(oldPlan.declarations.map(d => d.count), [3, 3, 5, 2, 2]);
  for (let i = 0; i < oldPlan.declarations.length; i++) {
    const d = oldPlan.declarations[i], n = String(i + 1).padStart(3, '0');
    const files = [d.files.declaration, d.files.alloc, d.files.env, ...d.files.prefixes];
    for (const f of files) { const b = read(f.path); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); expectedPaths.push(f.path); }
    const input = decode(read(d.files.declaration.path));
    assert.equal(input.id, d.id); assert.equal(input.requests.length, d.count);
    assert.deepEqual(decode(read(d.files.alloc.path)), input.allocation); assert.deepEqual(decode(read(d.files.env.path)), input.environment);
    d.files.prefixes.forEach((f, j) => assert.equal(decode(read(f.path)), input.prefixBodies[j]));
    let productHash, expected;
    for (const phase of ['product', 'expectations']) {
      const p = `${phase}/${n}.json`, b = read(p), seal = decode(read(p + '.seal.json'));
      assert.equal(b.length, seal.bytes); assert.equal(sha(b), seal.sha256); const result = checkedRaw(b); assert.equal(result.id, d.id);
      if (phase === 'product') productHash = sha(b); else { expected = result; assert.equal(expected.productSha256, productHash); }
      expectedPaths.push(p, p + '.seal.json');
    }
    rows.push({ declaration: d, input, expected });
  }
  assert.deepEqual(walk(base), expectedPaths.sort());
  return rows;
}
export function freeze(root, capture) {
  assert(!fs.existsSync(capture), 'A partial or completed freeze cannot be reused');
  const original = path.join(root, 'research/account-reset-v030/capture'), mb = fs.readFileSync(path.join(original, 'manifest.json'));
  assert.equal(sha(mb), ORIGINAL.manifest); const oldManifest = decode(mb);
  assert.deepEqual(walk(original).filter(p => p !== 'manifest.json'), oldManifest.files.map(f => f.path));
  for (const f of oldManifest.files) assert.deepEqual(entry(original, f.path), f);
  const source = checkSources(original, ORIGINAL.source), oldPlan = json(path.join(original, 'plan.json')); assert.equal(sha(fs.readFileSync(path.join(original, 'plan.json'))), ORIGINAL.plan);
  const inherited = new Set(['manifest.json', 'plan.json', 'source-manifest.json']);
  oldPlan.declarations.forEach((d, i) => { [d.files.declaration, d.files.alloc, d.files.env, ...d.files.prefixes].forEach(f => inherited.add(f.path)); for (const phase of ['product', 'expectations']) { const p = `${phase}/${String(i + 1).padStart(3, '0')}.json`; inherited.add(p); inherited.add(p + '.seal.json'); } });
  for (const p of [...inherited].sort()) copy(path.join(original, p), path.join(capture, 'inherited', p));
  for (const f of source.files) {
    const to = path.join(capture, 'runtime', f.path); fs.mkdirSync(path.dirname(to), { recursive: true });
    if (f.kind === 'symlink') fs.symlinkSync(f.target, to); else copy(path.join(original, 'runtime', f.path), to, f.mode);
  }
  const additional = OWN.map(n => entry(root, PREFIX + '/' + n));
  for (const f of additional) copy(path.join(root, f.path), path.join(capture, 'runtime', f.path), f.mode);
  const files = [...source.files, ...additional].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  // Match the bytewise sorting used by the inherited inventory walker.
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const f of source.toolFiles) copy(path.join(original, 'toolchain', f.path), path.join(capture, 'toolchain', f.path));
  const inventory = json(path.join(original, 'toolchain/source-inventory.json')), toolFiles = [...source.toolFiles];
  for (const p of ['eth/tracers/logger/logger_json.go', 'eth/tracers/logger/gen_callframe.go', 'eth/tracers/logger/gen_structlog.go', 'core/vm/evm.go', 'core/vm/instructions.go']) {
    const expected = inventory.files.find(f => f.path === p); assert(expected); const b = fs.readFileSync(path.join(source.geth.directory, 'source', p)); assert.equal(b.length, expected.bytes); assert.equal(sha(b), expected.sha256);
    const target = 'source/' + p; copy(path.join(source.geth.directory, target), path.join(capture, 'toolchain', target)); toolFiles.push({ path: target, bytes: b.length, sha256: sha(b) });
  }
  const manifest = { ...source, files, toolFiles, supplementalSourceRoot: root, original: ORIGINAL, productRuntimeRerun: false };
  const sourceIdentity = save(path.join(capture, 'source-manifest.json'), manifest);
  checkSources(capture, sourceIdentity.sha256); const declarations = checkInherited(capture).map(r => ({ id: r.input.id, count: r.input.requests.length }));
  for (const f of additional) assert.deepEqual(entry(root, f.path), f);
  const plan = { schemaVersion: 1, at: new Date().toISOString(), original: ORIGINAL, sourceManifestSha256: sourceIdentity.sha256, limits: LIMITS, declarations, traceFlags: ['--trace', '--trace.nostack', '--trace.callframes', '--trace.memory'], scope: { classification: 'declared_harness_correction_known_synthetic_sequences', originalOutcomesUnchanged: true, productRerun: false, exactOriginalInputsAndProductExpectations: true, gethPrefixes: 15, signedTransactionExecutions: 33, returnSource: 'balanced_JSONL_call_frames_final_root_OnExit', fullVMExecuted: false, publicRpc: false, populationAccuracy: false } };
  const planIdentity = save(path.join(capture, 'plan.json'), plan);
  return { planSha256: planIdentity.sha256, sourceSha256: sourceIdentity.sha256, sources: files.length, prefixes: 15 };
}
export function run(capture, pin) {
  assert.equal(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(path.join(capture, 'runtime', PREFIX, 'run.mjs')), 'Only the archived driver may dispatch');
  assert.match(pin, /^[a-f0-9]{64}$/); const pb = fs.readFileSync(path.join(capture, 'plan.json')); assert.equal(sha(pb), pin); const plan = decode(pb);
  assert.deepEqual(plan.original, ORIGINAL); assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.traceFlags, ['--trace', '--trace.nostack', '--trace.callframes', '--trace.memory']);
  const source = checkSources(capture, plan.sourceManifestSha256), inherited = checkInherited(capture);
  assert.deepEqual(plan.declarations, inherited.map(r => ({ id: r.input.id, count: r.input.requests.length })));
  const ledger = new Map(), unhashed = new Map(), admit = p => { const f = entry(capture, p); ledger.set(p, f); return f; }, put = (p, v) => { const f = save(path.join(capture, p), v); admit(p); return f; };
  for (const p of ['plan.json', 'source-manifest.json', ...walk(capture, 'inherited')]) admit(p);
  const checkLedger = () => { for (const [p, f] of ledger) assert.deepEqual(entry(capture, p), f); };
  const wall0 = Date.now(), mono0 = performance.now(); let previousWall = 0, previousMono = 0, reversed = false, totalBytes = 0, fatal = null;
  const timing = () => { const wallMs = Date.now() - wall0, monotonicMs = performance.now() - mono0; reversed ||= wallMs < previousWall || monotonicMs < previousMono; previousWall = wallMs; previousMono = monotonicMs; return { wallMs, monotonicMs, clockReversed: reversed }; };
  const remaining = () => { const t = timing(); assert(!t.clockReversed && validTime(t.wallMs, t.monotonicMs)); const n = Math.floor(Math.min(LIMITS.processMs, LIMITS.totalMs - Math.max(t.wallMs, t.monotonicMs))); assert(n > 0); return n; };
  const guard = () => { checkLedger(); checkSources(capture, plan.sourceManifestSha256); checkInherited(capture); assert(totalBytes <= LIMITS.totalOutputBytes); return remaining(); };
  put('STARTED.json', { at: new Date(wall0).toISOString(), planSha256: pin });
  const rows = inherited.flatMap(r => Array.from({ length: r.input.requests.length }, (_, i) => ({ id: r.input.id, prefix: i + 1, status: 'not_attempted', channels: null, reason: null })));
  try {
    let rowIndex = 0;
    for (let i = 0; i < inherited.length; i++) for (let count = 1; count <= inherited[i].input.requests.length; count++, rowIndex++) {
      guard(); assert.equal(sha(fs.readFileSync(source.geth.binary.path)), BINARY_SHA);
      const { declaration: d, input, expected } = inherited[i], p = `geth/${String(i + 1).padStart(3, '0')}-${String(count).padStart(2, '0')}`, out = path.join(capture, p);
      assert(!fs.existsSync(out)); fs.mkdirSync(out, { recursive: true }); rows[rowIndex] = { ...rows[rowIndex], status: 'unavailable', reason: 'Dispatch started' };
      const args = ['t8n', '--state.fork=Shanghai', '--state.chainid=1', '--state.reward=-1', '--input.alloc=' + path.join(capture, 'inherited', d.files.alloc.path), '--input.env=' + path.join(capture, 'inherited', d.files.env.path), '--input.txs=' + path.join(capture, 'inherited', d.files.prefixes[count - 1].path), '--output.basedir=' + out, '--output.alloc=alloc.json', '--output.result=result.json', '--output.body=body.rlp', ...plan.traceFlags];
      const timeoutMs = remaining(), start = performance.now(), startWall = Date.now();
      const process = spawnSync(source.geth.binary.path, args, { cwd: path.join(capture, 'runtime'), encoding: null, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: LIMITS.processBytes, env: { PATH: globalThis.process.env.PATH ?? '', TZ: 'UTC', LANG: 'C' } });
      const elapsedMs = performance.now() - start, wallElapsedMs = Date.now() - startWall, pack = bytes => { const b = bytes ?? Buffer.alloc(0); totalBytes += b.length; return { bytes: b.length, sha256: sha(b), base64: b.toString('base64') }; };
      const raw = { process: { executable: source.geth.binary.path, args, timeoutMs, elapsedMs, wallElapsedMs, status: process.status, signal: process.signal, error: process.error ? { name: process.error.name, code: process.error.code ?? null, message: process.error.message } : null }, stdout: pack(process.stdout), stderr: pack(process.stderr) };
      put(p + '-process.json', raw);
      let comparison = { status: 'unavailable', channels: null, reason: 'Geth process did not close cleanly' }, parsedRoots = null;
      try {
        const scan = inspectOutputFiles(out, totalBytes); totalBytes = scan.totalBytes; for (const f of scan.files) admit(p + '/' + f.path);
        assert.deepEqual(scan.files.map(f => f.path), ['alloc.json', 'result.json', 'body.rlp', ...input.signed.slice(0, count).map((tx, j) => `trace-${j}-${tx.hash}.jsonl`)].sort());
        if (raw.process.status === 0 && raw.process.signal === null && raw.process.error === null && validProcessOutput(raw) && validProcessTime(raw.process)) {
          parsedRoots = input.signed.slice(0, count).map((tx, j) => parseRootTrace(fs.readFileSync(path.join(out, `trace-${j}-${tx.hash}.jsonl`)), input.requests[j]));
          comparison = comparePrefix(input, count, expected, decode(fs.readFileSync(path.join(out, 'result.json'))), decode(fs.readFileSync(path.join(out, 'body.rlp'))), parsedRoots);
        }
      } catch (error) {
        if (error instanceof OutputBoundsError) {
          totalBytes = error.totalBytes;
          for (const f of error.files) { const name = p + '/' + f.path; unhashed.set(name, { ...f, path: name, kind: 'unhashed_output', observedKind: f.kind, sha256: null, reason: 'output_bounds_failure' }); }
          put(p + '-output-bound-failure.json', { name: error.name, message: error.message, totalBytes, files: [...unhashed.values()] }); throw error;
        }
        comparison = { status: 'unavailable', channels: null, reason: 'Malformed or unbound JSONL evidence: ' + error.message };
      }
      assert(validProcessOutput(raw), 'Geth process output bound failed'); assert(validProcessTime(raw.process), 'Geth elapsed bound failed'); guard();
      rows[rowIndex] = { id: input.id, prefix: count, ...comparison }; put(p + '-comparison.json', { ...rows[rowIndex], parsedRoots }); console.log(JSON.stringify(rows[rowIndex]));
    }
  } catch (error) { fatal = { name: error?.name ?? null, message: error?.message ?? String(error) }; }
  let sourceUnchanged = false, artifactsUnchanged = false;
  try { checkSources(capture, plan.sourceManifestSha256); sourceUnchanged = true; checkInherited(capture); checkLedger(); artifactsUnchanged = unhashed.size === 0; } catch (error) { fatal ??= { name: error.name, message: error.message }; }
  const terminalTiming = timing(); terminalTiming.valid = !terminalTiming.clockReversed && validTime(terminalTiming.wallMs, terminalTiming.monotonicMs) && totalBytes <= LIMITS.totalOutputBytes;
  if (!terminalTiming.valid) fatal ??= { name: 'BoundsError', message: 'Terminal elapsed/output bound failed' };
  const results = { schemaVersion: 1, original: ORIGINAL, planSha256: pin, sourceManifestSha256: plan.sourceManifestSha256, status: fatal ? 'interrupted' : 'complete', comparisonsUsable: fatal === null && sourceUnchanged && artifactsUnchanged, sourceUnchanged, artifactsUnchanged, artifactHashCoverageComplete: unhashed.size === 0, fatal, terminalTiming, totalOutputBytes: totalBytes, rows, counts: Object.fromEntries(['matched', 'mismatched', 'unavailable', 'not_attempted'].map(s => [s, rows.filter(r => r.status === s).length])), scope: plan.scope };
  put('results.json', results); checkLedger(); const manifest = save(path.join(capture, 'manifest.json'), { schemaVersion: 1, planSha256: pin, artifactHashCoverageComplete: unhashed.size === 0, files: walk(capture).filter(p => p !== 'manifest.json').map(p => unhashed.get(p) ?? entry(capture, p)) });
  return { ...results.counts, comparisonsUsable: results.comparisonsUsable, manifestSha256: manifest.sha256 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  if (process.argv[2] === 'freeze') console.log(JSON.stringify(freeze(root, path.join(root, PREFIX, 'capture')), null, 2));
  else if (process.argv[2] === 'run') console.log(JSON.stringify(run(path.resolve(process.argv[3]), process.argv[4]), null, 2));
  else throw Error('Use freeze or archived run CAPTURE_PATH EXTERNAL_PLAN_SHA');
}
