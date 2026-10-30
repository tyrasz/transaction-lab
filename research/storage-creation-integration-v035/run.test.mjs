// Driver preparation only. Fabricated reports exercise artifact validation;
// the only actual subprocesses are tiny timeout/output-limit scripts, not EVMs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sha, validateRecordedProcess } from './run.mjs';

const PREFIX = 'research/storage-creation-integration-v035';
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
function fixture(index = 0, capturePath = '/synthetic/capture') {
  const plan = { capturePath, node: { executable: process.execPath }, inputs: Array.from({ length: 6 }, (_, i) => ({
    path: 'inputs/' + String(i + 1).padStart(3, '0') + '.json', id: 'fixed_case_' + i,
    sha256: sha('fixed input ' + i),
  })) };
  const report = { id: plan.inputs[index].id, inputSha256: plan.inputs[index].sha256,
    scope: 'isolated_unsigned_priced_product_call_from_unchanged_initial_declaration',
    expectedPoststateConsumed: false, otherClientOutputsConsumed: false, workerPid: 12345,
    processClosureValid: true, error: null, attempt: { status: 'completed',
      broker: { pendingAtReturn: 0 }, isolation: { processClosed: true, childPid: 12346 },
      output: { execution: { status: 'success' } } } };
  const record = { pid: report.workerPid, executable: plan.node.executable,
    args: ['--max-old-space-size=256', path.join(capturePath, 'runtime', PREFIX, 'worker.mjs'), path.join(capturePath, plan.inputs[index].path)],
    timeoutMs: 20000, wallMs: 20, monotonicMs: 20.25, status: 0, signal: null, error: null };
  const f = { plan, index, record, report, stdout: encoded(report), stderr: Buffer.alloc(0) };
  bind(f); return f;
}
function bind(f) {
  const number = String(f.index + 1).padStart(3, '0');
  for (const kind of ['stdout', 'stderr']) f.record[kind] = { path: number + '.' + kind, bytes: f[kind].length, sha256: sha(f[kind]) };
  return f;
}
function validate(f) { return validateRecordedProcess(f); }
function changedReport(mutate) {
  const f = fixture(); mutate(f.report, f); f.stdout = encoded(f.report); bind(f); return validate(f);
}

test('all six fixed positions admit completed success/revert/failure reports without dropping the denominator', () => {
  for (let index = 0; index < 6; index++) for (const status of ['success', 'reverted', 'failed']) {
    const f = fixture(index); f.report.attempt.output.execution.status = status; f.stdout = encoded(f.report); bind(f);
    assert.deepEqual(validate(f), { status: 'observed', bounded: true, report: f.report });
  }
});

test('argv executable input position and raw stream identities are exact, including byte-preserving substitutions', () => {
  for (const mutate of [
    f => { f.record.executable += '-other'; },
    f => { f.record.args[0] = '--max-old-space-size=512'; },
    f => { f.record.args[1] = '/other/worker.mjs'; },
    f => { f.record.args[2] = path.join(f.plan.capturePath, f.plan.inputs[1].path); },
    f => { f.record.args.push('--extra'); },
    f => { f.record.stdout.path = '../001.stdout'; },
    f => { f.record.stderr.path = '002.stderr'; },
    f => { f.record.stdout.bytes++; },
    f => { f.record.stderr.sha256 = '0'.repeat(64); },
    f => { f.stdout = Buffer.from(f.stdout); f.stdout[2] ^= 1; },
    f => { f.index = 6; }, f => { f.index = -1; }, f => { f.index = 0.5; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validate(f)); }
});

test('rehashed report identity and expected-output flags cannot manufacture an observed case', () => {
  for (const mutate of [
    r => { r.id = 'fixed_case_1'; }, r => { r.inputSha256 = '0'.repeat(64); },
    r => { r.scope = 'reference execution'; }, r => { r.expectedPoststateConsumed = true; },
    r => { r.otherClientOutputsConsumed = true; }, r => { r.error = { message: 'failed' }; },
  ]) assert.equal(changedReport(mutate).status, 'unavailable');
});

test('closure is rederived from broker and distinct actual worker/child identities, not a self-label', () => {
  for (const mutate of [
    r => { r.processClosureValid = false; },
    r => { r.attempt.broker.pendingAtReturn = 1; },
    r => { r.attempt.broker.pendingAtReturn = '0'; },
    r => { r.attempt.isolation.processClosed = false; },
    r => { r.attempt.isolation = null; },
    r => { r.attempt.isolation.childPid = r.workerPid; },
    r => { r.attempt.isolation.childPid = 0; },
    r => { r.workerPid++; }, r => { r.workerPid = 0; }, r => { r.workerPid = 1.5; },
  ]) assert.equal(changedReport(mutate).status, 'unavailable');
});

test('unavailable, incomplete and unsupported executions stay unavailable even with process exit zero', () => {
  for (const mutate of [
    r => { r.attempt.status = 'unavailable'; }, r => { r.attempt.status = 'partial'; },
    r => { r.attempt.output.execution.status = 'unsupported'; },
    r => { r.attempt.output.execution.status = 'invalid'; },
    r => { r.attempt.output.execution.status = 'unavailable'; },
    r => { r.attempt.output = null; }, r => { r.attempt = null; },
  ]) assert.equal(changedReport(mutate).status, 'unavailable');
});

test('malformed JSON, UTF-8, missing reports and unexpected stderr retain unavailable outcomes', () => {
  for (const stdout of [Buffer.alloc(0), Buffer.from('{'), Buffer.from('null\n'), Buffer.from('{}\n'),
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])]) {
    const f = fixture(); f.stdout = stdout; bind(f); assert.equal(validate(f).status, 'unavailable');
  }
  const f = fixture(); f.stderr = Buffer.from('warning\n'); bind(f); assert.equal(validate(f).status, 'unavailable');
});

test('both elapsed clocks and combined output bytes enforce finite process bounds', () => {
  for (const key of ['wallMs', 'monotonicMs']) for (const value of [-1, NaN, Infinity, 21001]) {
    const f = fixture(); f.record[key] = value; const result = validate(f);
    assert.equal(result.status, 'unavailable'); assert.equal(result.bounded, false);
  }
  for (const timeout of [0, -1, 20001, 1.5]) {
    const f = fixture(); f.record.timeoutMs = timeout; assert.throws(() => validate(f));
  }
  const f = fixture(); f.stdout = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20); bind(f);
  assert.deepEqual(validate(f), { status: 'unavailable', bounded: false, report: null });
});

test('exit, signal and spawn errors remain unavailable without changing the six fixed slots', () => {
  const rows = [];
  for (let index = 0; index < 6; index++) {
    const f = fixture(index);
    if (index === 1) f.record.status = 1;
    if (index === 2) { f.record.status = null; f.record.signal = 'SIGKILL'; }
    if (index === 3) f.record.error = { name: 'Error', message: 'spawn timeout', code: 'ETIMEDOUT' };
    if (index === 4) f.record.error = { name: 'Error', message: 'output bound', code: 'ENOBUFS' };
    if (index === 5) { f.record.status = null; f.record.pid = 0; }
    rows.push(validate(f).status);
  }
  assert.deepEqual(rows, ['observed', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
});

test('the actual Node subprocess adapter terminates harmless timeout and output-overflow scripts', () => {
  const capture = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-driver-preparation-'));
  try {
    const f = fixture(0, capture), worker = f.record.args[1]; fs.mkdirSync(path.dirname(worker), { recursive: true });
    for (const [source, timeout, maxBuffer, errorCode] of [
      ['setInterval(() => {}, 1000);', 100, 1024, 'ETIMEDOUT'],
      ['process.stdout.write(Buffer.alloc(65536));', 2000, 1024, 'ENOBUFS'],
    ]) {
      fs.writeFileSync(worker, source);
      const wall = Date.now(), mono = performance.now();
      const result = spawnSync(process.execPath, f.record.args, { encoding: null, timeout, maxBuffer,
        killSignal: 'SIGKILL', env: { LANG: 'C', TZ: 'UTC' } });
      assert.equal(result.error?.code, errorCode); assert.equal(result.signal, 'SIGKILL');
      f.stdout = result.stdout ?? Buffer.alloc(0); f.stderr = result.stderr ?? Buffer.alloc(0);
      Object.assign(f.record, { pid: result.pid, timeoutMs: timeout, wallMs: Date.now() - wall,
        monotonicMs: performance.now() - mono, status: result.status, signal: result.signal,
        error: { name: result.error.name, message: result.error.message, code: result.error.code } });
      bind(f); assert.equal(validate(f).status, 'unavailable');
    }
  } finally { fs.rmSync(capture, { recursive: true, force: true }); }
});
