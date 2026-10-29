import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX, V2, classify, deriveVector, inventory, sha, verifyCapture, verifyPair } from './verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const capture = path.join(root, PREFIX, 'capture-v2');
const MANIFEST = '53c93e308a683020cf827b974bfdc2a696acf87e4b11544d1b99ed2db0462976';
const read = file => JSON.parse(fs.readFileSync(file));
function sample(batch = '001') {
  const record = JSON.parse(fs.readFileSync(path.join(capture, 'batches/' + batch + '.stdout'), 'utf8').split('\n')[0]);
  const [fork, source] = record.id.split('/'), [file, index] = source.split('#');
  const vector = read(path.join(capture, 'runtime', PREFIX, 'inputs/upstream/core/vm/testdata/precompiles', file))[Number(index)];
  return { row: deriveVector(file, vector, Number(index), fork), record };
}

test('both complete packets verify offline, preserving the first failure and all corrected denominators', () => {
  const result = verifyPair(root, MANIFEST);
  assert.deepEqual(result.correctedCapture.counts, { matched: 1838, mismatched: 0, unavailable: 0, unsupported: 18, not_attempted: 0 });
  assert.equal(result.firstCapture.nullOutputs, 1838); assert.equal(result.firstCapture.counts.unavailable, 1838);
  assert.equal(result.productionRuntimeAndInputsUnchangedBetweenAttempts, true);
});

test('independent raw classification rejects wrong output, gas, logs, state and fork context', () => {
  const { row, record } = sample(); assert.equal(classify(row, record).status, 'matched');
  for (const mutate of [
    r => { r.output.execution.returnData = r.output.trace.output = '0x'; },
    r => { r.output.execution.executionGasUsed = '1'; r.output.trace.gasUsed = '0x1'; },
    r => { r.output.logs = [{}]; }, r => { r.changes.accounts = []; },
    r => { r.output.profile.hardfork = 'cancun'; },
  ]) { const bad = structuredClone(record); mutate(bad); assert.equal(classify(row, bad).status, 'mismatched'); }
  for (const mutate of [r => { r.input.request.data = '0x'; }, r => { r.id += 'x'; }, r => { r.output.trace.input = '0x'; }, r => { r.output.profile.sourceStateProofVerified = true; }]) {
    const bad = structuredClone(record); mutate(bad); assert.throws(() => classify(row, bad));
  }
});

test('recognized invalid input is exceptional failure, never a success inferred from an empty return', () => {
  const { row, record } = sample('010'); assert.equal(row.failure, true); assert.equal(classify(row, record).status, 'matched');
  record.output.execution.status = 'success'; record.output.execution.error = record.output.trace.error = null;
  assert.equal(classify(row, record).status, 'mismatched');
});

test('every oversized upstream vector stays unsupported with its original gas and bytes', () => {
  const plan = read(path.join(capture, 'runtime', PREFIX, 'inputs/plan.json'));
  const unsupported = plan.rows.filter(row => row.status === 'unsupported'); assert.equal(unsupported.length, 18);
  for (const expected of unsupported) {
    const vector = read(path.join(capture, 'runtime', PREFIX, 'inputs/upstream/core/vm/testdata/precompiles', expected.file))[expected.index];
    const { data, ...derived } = deriveVector(expected.file, vector, expected.index, expected.fork);
    assert.deepEqual(derived, expected); assert.equal(data.length / 2 - 1, expected.inputBytes);
  }
});

test('file inventory rejects changed bytes, extra files and a substituted symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bls-review-inventory-'));
  try {
    const file = path.join(dir, 'a'); fs.writeFileSync(file, 'initial'); const stat = fs.statSync(file);
    const entries = [{ path: 'a', kind: 'file', bytes: 7, sha256: sha(Buffer.from('initial')), mode: stat.mode & 0o777 }]; inventory(dir, entries);
    fs.writeFileSync(file, 'changed'); assert.throws(() => inventory(dir, entries)); fs.writeFileSync(file, 'initial');
    fs.writeFileSync(path.join(dir, 'extra'), 'x'); assert.throws(() => inventory(dir, entries)); fs.unlinkSync(path.join(dir, 'extra'));
    fs.unlinkSync(file); fs.symlinkSync('/dev/null', file); assert.throws(() => inventory(dir, entries));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('relocated artifacts still verify while resealed false counts and failed process exits reject', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bls-review-packet-')), copied = path.join(dir, 'capture-v2');
  try {
    fs.cpSync(capture, copied, { recursive: true, verbatimSymlinks: true });
    assert.equal(verifyCapture(copied, { ...V2, manifest: MANIFEST }).counts.matched, 1838);
    const originalManifest = fs.readFileSync(path.join(copied, 'manifest.json'));
    for (const [relative, mutate] of [
      ['results.json', value => { value.counts.matched--; }],
      ['batches/001.process.json', value => { value.status = 1; }],
      ['batches/001.process.json', value => { value.signal = 'SIGKILL'; }],
      ['results.json', value => { value.timing.monotonicMs = 600001; }],
    ]) {
      const target = path.join(copied, relative), original = fs.readFileSync(target), value = JSON.parse(original); mutate(value);
      const replacement = Buffer.from(JSON.stringify(value, null, 2) + '\n'); fs.writeFileSync(target, replacement);
      const manifest = JSON.parse(originalManifest), entry = manifest.files.find(row => row.path === relative);
      entry.bytes = replacement.length; entry.sha256 = sha(replacement);
      const sealed = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); fs.writeFileSync(path.join(copied, 'manifest.json'), sealed);
      assert.throws(() => verifyCapture(copied, { ...V2, manifest: sha(sealed) }));
      fs.writeFileSync(target, original); fs.writeFileSync(path.join(copied, 'manifest.json'), originalManifest);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
