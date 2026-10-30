import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../..');
const PREFIX = 'research/storage-creation-integration-v035', OLD = 'research/amsterdam-storage-creation-v033';
const EELS = 'research/storage-creation-v035/eels-comparison', CAPTURE = path.join(HERE, 'capture');
const DEPS = ['engines/local-evm/node_modules', 'engines/fixture-evm/node_modules'];
const OWN = ['worker.mjs', 'run.mjs', 'run.test.mjs', 'delta.mjs', 'delta.test.mjs', 'PLAN.md'];
const LIMITS = Object.freeze({ processMs: 20000, totalMs: 150000, processBytes: 8 * 1024 * 1024, totalBytes: 48 * 1024 * 1024 });
const PINS = Object.freeze({ eelsManifest: '0e56b466ed87ee7eeaf2d656598df87123d08c0ff588f89131e06f7eb881b390',
  comparator: '655ee2e0da330fedbf00ded12944abc01c15f978359ab94464f397a7f556bd96',
  oldManifest: '0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9' });
const CHANNELS = ['executionStatus', 'returnData', 'chargedGas', 'singleTransactionBlockGasUsed', 'stateRoot', 'target', 'logs'];
export const sha = value => createHash('sha256').update(value).digest('hex');
const read = p => fs.readFileSync(p), json = p => JSON.parse(read(p)), n = i => String(i + 1).padStart(3, '0');
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return sha(read(file)); }
function walk(base, relative = '') { return fs.readdirSync(path.join(base, relative)).sort().flatMap(name => {
  const p = relative ? relative + '/' + name : name, stat = fs.lstatSync(path.join(base, p));
  return stat.isDirectory() ? walk(base, p) : [p];
}).sort(); }
function entry(base, relative) {
  const file = path.join(base, relative), stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const resolved = fs.realpathSync(file); assert(resolved.startsWith(base + path.sep)); assert(fs.statSync(resolved).isFile());
    return { path: relative, kind: 'symlink', target: fs.readlinkSync(file), resolvedSha256: sha(read(resolved)) };
  }
  assert(stat.isFile() && stat.size <= 64 * 1024 * 1024);
  return { path: relative, kind: 'file', bytes: stat.size, mode: stat.mode & 511, sha256: sha(read(file)) };
}
function nodeIdentity() { return { executable: fs.realpathSync(process.execPath), version: process.version, sha256: sha(read(process.execPath)) }; }
const finite = (value, maximum) => Number.isFinite(value) && value >= 0 && value <= maximum;
export function validateRecordedProcess({ plan, index, record, stdout, stderr }) {
  assert(Number.isSafeInteger(index) && index >= 0 && index < 6);
  assert(Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr));
  assert.deepEqual(record.args, ['--max-old-space-size=256', path.join(plan.capturePath, 'runtime', PREFIX, 'worker.mjs'), path.join(plan.capturePath, plan.inputs[index].path)]);
  assert.equal(record.executable, plan.node.executable);
  assert(Number.isInteger(record.timeoutMs) && record.timeoutMs > 0 && record.timeoutMs <= LIMITS.processMs);
  for (const [kind, bytes] of [['stdout', stdout], ['stderr', stderr]]) assert.deepEqual(record[kind], { path: n(index) + '.' + kind, bytes: bytes.length, sha256: sha(bytes) });
  const bounded = finite(record.wallMs, record.timeoutMs + 1000) && finite(record.monotonicMs, record.timeoutMs + 1000) && stdout.length + stderr.length <= LIMITS.processBytes;
  assert(record.status === null || Number.isInteger(record.status));
  assert(record.signal === null || typeof record.signal === 'string');
  assert(record.error === null || record.error && typeof record.error.name === 'string' && typeof record.error.message === 'string');
  if (!bounded || record.status !== 0 || record.signal !== null || record.error !== null || stderr.length !== 0) return { status: 'unavailable', bounded, report: null };
  try {
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)), a = report.attempt;
    assert.equal(report.id, plan.inputs[index].id); assert.equal(report.inputSha256, plan.inputs[index].sha256);
    assert.equal(report.scope, 'isolated_unsigned_priced_product_call_from_unchanged_initial_declaration');
    assert.equal(report.expectedPoststateConsumed, false); assert.equal(report.otherClientOutputsConsumed, false); assert.equal(report.error, null);
    assert(Number.isSafeInteger(record.pid) && record.pid > 0); assert.equal(report.workerPid, record.pid);
    assert.equal(report.processClosureValid, true); assert.equal(a.status, 'completed'); assert.equal(a.broker.pendingAtReturn, 0);
    assert.equal(a.isolation.processClosed, true); assert(Number.isSafeInteger(a.isolation.childPid) && a.isolation.childPid > 0 && a.isolation.childPid !== report.workerPid);
    assert(['success', 'reverted', 'failed'].includes(a.output.execution.status));
    return { status: 'observed', bounded, report };
  } catch { return { status: 'unavailable', bounded, report: null }; }
}
function sourcePaths() {
  const files = ['package.json', 'engines/evm-context.js', 'reports/ethereum-proof-capability/capture.json',
    OLD + '/cases.mjs', OLD + '/observations.mjs', ...OWN.map(p => PREFIX + '/' + p)];
  for (const engine of ['local-evm', 'fixture-evm']) {
    const dir = 'engines/' + engine;
    for (const item of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }))
      if (item.isFile() && (item.name.endsWith('.js') || ['package.json', 'package-lock.json'].includes(item.name))) files.push(dir + '/' + item.name);
  }
  for (const p of ['proof-fixture.js', 'lifecycle-fixture.js', 'authorization-fixture.js', 'fee-fixture.js',
    'amsterdam-execution-fixture.js', 'amsterdam-creation-attempts-fixture.js', 'amsterdam-storage-collision-fixture.js']) files.push('engines/local-evm/test/' + p);
  for (const dep of DEPS) files.push(...walk(ROOT, dep));
  return [...new Set(files)].sort();
}
function copyRows(from, to, rows) {
  for (const row of rows.filter(row => row.kind === 'file')) {
    const out = path.join(to, row.path); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, read(path.join(from, row.path)), { flag: 'wx', mode: row.mode }); fs.chmodSync(out, row.mode);
  }
  for (const row of rows.filter(row => row.kind === 'symlink')) { const out = path.join(to, row.path); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.symlinkSync(row.target, out); }
}
function checkRuntime(plan) {
  assert.deepEqual(nodeIdentity(), plan.node);
  const runtime = path.join(CAPTURE, 'runtime');
  assert.deepEqual(walk(runtime), plan.files.map(row => row.path));
  for (const row of plan.files) assert.deepEqual(entry(runtime, row.path), row);
  for (const { id, ...row } of plan.inputs) { assert.deepEqual(entry(CAPTURE, row.path), row); assert.equal(json(path.join(CAPTURE, row.path)).id, id); }
  assert.equal(sha(read(path.join(CAPTURE, 'runtime', PREFIX, 'run.mjs'))), sha(read(fileURLToPath(import.meta.url))));
}
async function reference() {
  assert.equal(sha(read(path.join(ROOT, EELS, 'compare.mjs'))), PINS.comparator);
  assert.equal(sha(read(path.join(ROOT, EELS, 'capture/manifest.json'))), PINS.eelsManifest);
  assert.equal(sha(read(path.join(ROOT, OLD, 'capture/manifest.json'))), PINS.oldManifest);
  const module = await import(pathToFileURL(path.join(ROOT, EELS, 'compare.mjs')).href), result = await module.compareSaved();
  assert(result.evidenceUsable); assert.equal(result.rows.length, 6); assert(result.rows.every(row => row.eels.status === 'observed'));
  return result;
}
export async function freeze() {
  assert(!fs.existsSync(CAPTURE), 'Never reuse a partial capture');
  const refs = await reference(), files = sourcePaths().map(p => entry(ROOT, p));
  assert(files.length < 6000 && files.reduce((sum, row) => sum + (row.bytes ?? 0), 0) < 64 * 1024 * 1024);
  copyRows(ROOT, path.join(CAPTURE, 'runtime'), files);
  const inputs = [];
  for (let i = 0; i < 6; i++) {
    const rel = 'inputs/' + n(i) + '.json', bytes = read(path.join(ROOT, OLD, 'capture', rel));
    assert.deepEqual(bytes, read(path.join(ROOT, EELS, 'capture', rel)));
    const input = JSON.parse(bytes); assert.equal(input.index, i); assert.equal(input.id, refs.rows[i].id);
    fs.mkdirSync(path.join(CAPTURE, 'inputs'), { recursive: true }); fs.writeFileSync(path.join(CAPTURE, rel), bytes, { flag: 'wx' }); inputs.push({ ...entry(CAPTURE, rel), id: input.id });
  }
  const referenceSha256 = save(path.join(CAPTURE, 'reference-verification.json'), refs);
  const plan = { schemaVersion: 1, createdAt: new Date().toISOString(), sourceRoot: ROOT, capturePath: CAPTURE, node: nodeIdentity(),
    limits: LIMITS, referencePins: PINS, referenceSha256, files, inputs };
  const planSha256 = save(path.join(CAPTURE, 'plan.json'), plan); checkRuntime(plan);
  return { planSha256, files: files.length, sourceBytes: files.reduce((sum, row) => sum + (row.bytes ?? 0), 0), inputs: inputs.length };
}
export async function run(pin) {
  assert.equal(sha(read(path.join(CAPTURE, 'plan.json'))), pin); const plan = json(path.join(CAPTURE, 'plan.json'));
  assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.referencePins, PINS); checkRuntime(plan);
  assert(!fs.existsSync(path.join(CAPTURE, 'STARTED.json')), 'Never retry a capture');
  assert.deepEqual(walk(CAPTURE), [...plan.files.map(row => 'runtime/' + row.path), ...plan.inputs.map(row => row.path), 'plan.json', 'reference-verification.json'].sort());
  const ledger = new Map(walk(CAPTURE).map(p => [p, entry(CAPTURE, p)]));
  const put = (relative, value) => { const hash = save(path.join(CAPTURE, relative), value); ledger.set(relative, entry(CAPTURE, relative)); return hash; };
  const putBytes = (relative, bytes) => { fs.writeFileSync(path.join(CAPTURE, relative), bytes, { flag: 'wx' }); ledger.set(relative, entry(CAPTURE, relative)); };
  const check = () => { checkRuntime(plan); assert.deepEqual(walk(CAPTURE), [...ledger.keys()].sort()); for (const row of ledger.values()) assert.deepEqual(entry(CAPTURE, row.path), row); };
  const wall0 = Date.now(), mono0 = performance.now(); let lastWall = 0, lastMono = 0, reversed = false, totalBytes = 0, fatal = null;
  const timing = () => { const wallMs = Date.now() - wall0, monotonicMs = performance.now() - mono0; reversed ||= wallMs < lastWall || monotonicMs < lastMono; lastWall = wallMs; lastMono = monotonicMs; return { wallMs, monotonicMs, reversed }; };
  const rows = plan.inputs.map((row, i) => ({ index: i, id: json(path.join(CAPTURE, row.path)).id, status: 'not_attempted', process: null }));
  put('STARTED.json', { at: new Date(wall0).toISOString(), planSha256: pin });
  try {
    for (const row of rows) {
      check(); const elapsed = timing(); assert(!elapsed.reversed && Math.max(elapsed.wallMs, elapsed.monotonicMs) < LIMITS.totalMs);
      const timeoutMs = Math.floor(Math.min(LIMITS.processMs, LIMITS.totalMs - Math.max(elapsed.wallMs, elapsed.monotonicMs)));
      assert(timeoutMs >= 1, 'Sub-millisecond remainder cannot disable the process timeout');
      const args = ['--max-old-space-size=256', path.join(CAPTURE, 'runtime', PREFIX, 'worker.mjs'), path.join(CAPTURE, plan.inputs[row.index].path)];
      row.status = 'unavailable'; const start = Date.now(), mono = performance.now();
      const result = spawnSync(plan.node.executable, args, { cwd: path.join(CAPTURE, 'runtime'), encoding: null, timeout: timeoutMs,
        maxBuffer: LIMITS.processBytes, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC' } });
      const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0); totalBytes += stdout.length + stderr.length;
      const processRecord = { executable: plan.node.executable, args, pid: result.pid ?? null, timeoutMs, wallMs: Date.now() - start, monotonicMs: performance.now() - mono,
        status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code ?? null } : null,
        stdout: { path: n(row.index) + '.stdout', bytes: stdout.length, sha256: sha(stdout) }, stderr: { path: n(row.index) + '.stderr', bytes: stderr.length, sha256: sha(stderr) } };
      for (const [kind, bytes] of [['stdout', stdout], ['stderr', stderr]]) putBytes(processRecord[kind].path, bytes);
      const processSha256 = put(n(row.index) + '-process.json', processRecord); row.process = n(row.index) + '-process.json';
      put(n(row.index) + '-seal.json', { at: new Date().toISOString(), processSha256, stdout: processRecord.stdout, stderr: processRecord.stderr });
      assert(processRecord.wallMs >= 0 && processRecord.monotonicMs >= 0 && Math.max(processRecord.wallMs, processRecord.monotonicMs) <= timeoutMs + 1000 &&
        stdout.length + stderr.length <= LIMITS.processBytes && totalBytes <= LIMITS.totalBytes && !processRecord.error && !processRecord.signal, 'Process bounds or termination failed');
      row.status = validateRecordedProcess({ plan, index: row.index, record: processRecord, stdout, stderr }).status;
      console.log(JSON.stringify({ index: row.index, id: row.id, status: row.status }));
    }
  } catch (error) { fatal = { name: error.name, message: error.message }; }
  let sourceUnchanged = false; try { check(); sourceUnchanged = true; } catch (error) { fatal ??= { name: error.name, message: error.message }; }
  const elapsed = timing(); if (elapsed.reversed || Math.max(elapsed.wallMs, elapsed.monotonicMs) > LIMITS.totalMs || totalBytes > LIMITS.totalBytes) fatal ??= { name: 'BoundsError', message: 'Terminal bounds failed' };
  const results = { planSha256: pin, rows, fatal, sourceUnchanged, evidenceUsable: !fatal && sourceUnchanged, totalBytes, elapsed };
  put('results.json', results);
  const manifestSha256 = save(path.join(CAPTURE, 'manifest.json'), { planSha256: pin, files: [...ledger.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
  return { evidenceUsable: results.evidenceUsable, counts: Object.fromEntries(['observed', 'unavailable', 'not_attempted'].map(s => [s, rows.filter(row => row.status === s).length])), fatal, elapsed, totalBytes, manifestSha256 };
}
export async function compare(planPin, manifestPin) {
  assert.match(planPin, /^[0-9a-f]{64}$/); assert.match(manifestPin, /^[0-9a-f]{64}$/);
  assert.equal(sha(read(path.join(CAPTURE, 'plan.json'))), planPin); assert.equal(sha(read(path.join(CAPTURE, 'manifest.json'))), manifestPin);
  const plan = json(path.join(CAPTURE, 'plan.json')), manifest = json(path.join(CAPTURE, 'manifest.json')), results = json(path.join(CAPTURE, 'results.json'));
  assert.equal(sha(read(path.join(CAPTURE, 'plan.json'))), manifest.planSha256); assert.equal(results.planSha256, manifest.planSha256);
  assert.deepEqual(walk(CAPTURE), [...manifest.files.map(row => row.path), 'manifest.json'].sort());
  assert.deepEqual(walk(CAPTURE), [...plan.files.map(row => 'runtime/' + row.path), ...plan.inputs.map(row => row.path), 'plan.json', 'reference-verification.json',
    'STARTED.json', 'results.json', 'manifest.json', ...results.rows.filter(row => row.process !== null).flatMap(row =>
      [n(row.index) + '-process.json', n(row.index) + '-seal.json', n(row.index) + '.stdout', n(row.index) + '.stderr'])].sort());
  for (const row of manifest.files) assert.deepEqual(entry(CAPTURE, row.path), row);
  checkRuntime(plan); assert.equal(sha(read(path.join(CAPTURE, 'reference-verification.json'))), plan.referenceSha256);
  assert.deepEqual(plan.limits, LIMITS); assert.deepEqual(plan.referencePins, PINS);
  assert.equal(results.evidenceUsable, results.sourceUnchanged && results.fatal === null && results.elapsed.reversed === false &&
    finite(results.elapsed.wallMs, LIMITS.totalMs) && finite(results.elapsed.monotonicMs, LIMITS.totalMs) && finite(results.totalBytes, LIMITS.totalBytes));
  const refs = await reference(); assert.deepEqual(refs, json(path.join(CAPTURE, 'reference-verification.json')));
  const imp = rel => import(pathToFileURL(path.join(CAPTURE, 'runtime', rel)).href);
  const { applyCandidateDelta } = await imp(PREFIX + '/delta.mjs');
  const { allocationRoot, targetObservation, behavior } = await imp(OLD + '/observations.mjs');
  const rows = []; let totalBytes = 0;
  assert.equal(results.rows.length, 6); assert.deepEqual(results.rows.map(row => row.index), [0, 1, 2, 3, 4, 5]);
  for (const row of results.rows) {
    const input = json(path.join(CAPTURE, plan.inputs[row.index].path)); assert.equal(input.id, row.id);
    assert.deepEqual(read(path.join(CAPTURE, plan.inputs[row.index].path)), read(path.join(ROOT, EELS, 'capture', plan.inputs[row.index].path)));
    let product = null, unavailable = null;
    let report = null;
    if (row.process !== null) {
      assert.equal(row.process, n(row.index) + '-process.json');
      const p = json(path.join(CAPTURE, row.process)), seal = json(path.join(CAPTURE, n(row.index) + '-seal.json'));
      assert.equal(seal.processSha256, sha(read(path.join(CAPTURE, row.process)))); assert.deepEqual(seal.stdout, p.stdout); assert.deepEqual(seal.stderr, p.stderr);
      const stdout = read(path.join(CAPTURE, p.stdout.path)), stderr = read(path.join(CAPTURE, p.stderr.path)); totalBytes += stdout.length + stderr.length;
      const validated = validateRecordedProcess({ plan, index: row.index, record: p, stdout, stderr }); assert.equal(validated.status, row.status); report = validated.report;
    } else assert.equal(row.status, 'not_attempted');
    if (row.status === 'observed' && results.evidenceUsable) {
      assert(report);
      try {
        const allocation = await applyCandidateDelta(input, report.attempt.changes), o = report.attempt.output, target = targetObservation(input, allocation);
        product = { completedExecution: true, executionStatus: o.execution.status, returnData: o.execution.returnData,
          chargedGas: o.gasAccounting.gasUsed, singleTransactionBlockGasUsed: o.gasAccounting.singleTransactionBlockGasUsed,
          stateRoot: await allocationRoot(allocation), target, targetBehavior: behavior(input, target), logs: o.logs, allocation };
      } catch (error) { unavailable = { name: error.name, message: error.message }; }
    }
    const eels = refs.rows[row.index].eels.observation;
    rows.push({ index: row.index, id: row.id, status: row.status, product, eels, reconstructionError: unavailable,
      comparison: Object.fromEntries(CHANNELS.map(k => [k, !product || product[k] == null || eels[k] == null ? null : isDeepStrictEqual(product[k], eels[k])])) });
  }
  assert.equal(totalBytes, results.totalBytes);
  const all = rows.flatMap(row => Object.values(row.comparison));
  return { kind: 'candidate_to_saved_EELS', planSha256: manifest.planSha256, manifestSha256: sha(read(path.join(CAPTURE, 'manifest.json'))),
    referencePins: PINS, evidenceUsable: results.evidenceUsable, channels: CHANNELS, rows,
    counts: { matchedCases: rows.filter(row => Object.values(row.comparison).every(v => v === true)).length,
      mismatchedCases: rows.filter(row => Object.values(row.comparison).some(v => v === false)).length,
      unavailableCases: rows.filter(row => !row.product).length, matchedChannels: all.filter(v => v === true).length,
      mismatchedChannels: all.filter(v => v === false).length, unavailableChannels: all.filter(v => v === null).length } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2]; assert(['freeze', 'run', 'compare'].includes(action));
  console.log(JSON.stringify(action === 'freeze' ? await freeze() : action === 'run' ? await run(process.argv[3]) : await compare(process.argv[3], process.argv[4]), null, 2));
}
