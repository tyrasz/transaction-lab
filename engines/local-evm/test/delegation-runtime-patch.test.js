import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCAL_RUNTIME_PATCH as patch, applyLocalRuntimePatch as applyDelegationRuntimePatch, assertLocalRuntimePatched as assertDelegationRuntimePatched } from '../delegation-runtime-patch.js';

const installed = fileURLToPath(new URL('../node_modules/@ethereumjs/evm/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const errorCode = { code: 'LOCAL_EVM_RUNTIME_UNVERIFIED' };
function originalBytes(spec) {
  const bytes = fs.readFileSync(path.join(installed, spec.path));
  if (sha(bytes) === spec.originalSha256) return bytes;
  assert([spec.patchedSha256, spec.previousSha256].includes(sha(bytes)), 'test inputs must be exact stock, previous or corrected dependency bytes');
  let text = bytes.toString();
  const replacements = sha(bytes) === spec.previousSha256 ? spec.replacements.slice(0, spec.previousReplacementCount) : spec.replacements;
  for (const { before, after } of replacements) text = text.replace(after, before);
  const original = Buffer.from(text); assert.equal(sha(original), spec.originalSha256); return original;
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-runtime-patch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@ethereumjs/evm', version: '10.1.3' }));
  for (const spec of patch.files) {
    const file = path.join(directory, spec.path); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, originalBytes(spec), { mode: 0o644 });
  }
  return directory;
}
const snapshot = directory => patch.files.map(spec => fs.readFileSync(path.join(directory, spec.path)));

test('three delegation guards and two collision predicates are the only executable changes', t => {
  const directory = fixture(t), before = snapshot(directory);
  assert.throws(() => assertDelegationRuntimePatched(directory), errorCode);
  assert.deepEqual(snapshot(directory), before, 'read-only check must not patch');
  const result = applyDelegationRuntimePatch(directory);
  assert.deepEqual(result.changed, ['dist/esm/evm.js', 'dist/esm/opcodes/gas.js', 'dist/esm/interpreter.js']);
  assert.equal(patch.files.reduce((n, spec) => n + spec.replacements.length, 0), 6); // Includes one comment-only replacement.
  for (const [i, spec] of patch.files.entries()) {
    const after = fs.readFileSync(path.join(directory, spec.path));
    assert.equal(sha(before[i]), spec.originalSha256); assert.equal(sha(after), spec.patchedSha256);
    let restored = after.toString();
    for (const { before: old, after: corrected } of spec.replacements) {
      assert.equal(restored.split(corrected).length, 2); restored = restored.replace(corrected, old);
    }
    assert.deepEqual(Buffer.from(restored), before[i]);
    assert.deepEqual(after.toString().match(/\.slice\([^)]*\)/g), before[i].toString().match(/\.slice\([^)]*\)/g));
    assert.equal(fs.statSync(path.join(directory, spec.path)).mode & 0o777, 0o644);
  }
  const evm = fs.readFileSync(path.join(directory, patch.files[0].path), 'utf8');
  assert(evm.includes('recipientCode.length === 23 && equalsBytes(recipientCode.slice(0, 3)'));
  assert(evm.includes('message.code.length === 23 && equalsBytes(message.code.slice(0, 3)'));
  assert(fs.readFileSync(path.join(directory, patch.files[1].path), 'utf8').includes('code.length === 23 && equalsBytes(code.slice(0, 3)'));
  assert(!evm.includes('equalsBytes(toAccount.storageRoot, KECCAK256_RLP)'));
  const interpreter = fs.readFileSync(path.join(directory, patch.files[2].path), 'utf8');
  assert(!interpreter.includes('equalsBytes(toAccount.storageRoot, KECCAK256_RLP)'));
  assert(evm.includes('toAccount.nonce && toAccount.nonce > BIGINT_0'));
  assert(interpreter.includes('toAccount.nonce > BIGINT_0'));
  assert.deepEqual(result.patches, ['eip7702-exact-designation-length-v1', 'nonce-code-creation-collision-v1']);
  assert.deepEqual(result.files, patch.files.map(spec => ({ path: spec.path, sha256: spec.patchedSha256 })));
});

test('the exact v034 runtime upgrades without rewriting the unchanged delegation gas file', t => {
  const directory = fixture(t), evm = patch.files[0], gas = patch.files[1];
  let oldEvm = originalBytes(evm).toString();
  for (const { before, after } of evm.replacements.slice(0, evm.previousReplacementCount)) oldEvm = oldEvm.replace(before, after);
  assert.equal(sha(oldEvm), evm.previousSha256);
  fs.writeFileSync(path.join(directory, evm.path), oldEvm);
  let oldGas = originalBytes(gas).toString();
  for (const { before, after } of gas.replacements) oldGas = oldGas.replace(before, after);
  assert.equal(sha(oldGas), gas.patchedSha256);
  fs.writeFileSync(path.join(directory, gas.path), oldGas);
  const unchanged = fs.statSync(path.join(directory, gas.path));
  assert.throws(() => assertDelegationRuntimePatched(directory), errorCode);
  const result = applyDelegationRuntimePatch(directory);
  assert.deepEqual(result.changed, [evm.path, patch.files[2].path]);
  assert.equal(fs.statSync(path.join(directory, gas.path)).ino, unchanged.ino);
  assert.equal(fs.statSync(path.join(directory, gas.path)).mtimeMs, unchanged.mtimeMs);
  assertDelegationRuntimePatched(directory);
});

test('already corrected bytes are verified without rewriting; explicit apply is idempotent', t => {
  const directory = fixture(t); applyDelegationRuntimePatch(directory);
  const before = snapshot(directory), stats = patch.files.map(spec => fs.statSync(path.join(directory, spec.path)));
  const checked = assertDelegationRuntimePatched(directory), applied = applyDelegationRuntimePatch(directory);
  assert.deepEqual(applied.changed, []); assert.deepEqual(applied.files, checked.files); assert.deepEqual(snapshot(directory), before);
  patch.files.forEach((spec, i) => { const current = fs.statSync(path.join(directory, spec.path));
    assert.equal(current.ino, stats[i].ino); assert.equal(current.mtimeMs, stats[i].mtimeMs); });
});

test('an original/corrected mixture is not verified until an explicit application completes it', t => {
  const directory = fixture(t); applyDelegationRuntimePatch(directory);
  fs.writeFileSync(path.join(directory, patch.files[1].path), originalBytes(patch.files[1]));
  assert.throws(() => assertDelegationRuntimePatched(directory), errorCode);
  assert.deepEqual(applyDelegationRuntimePatch(directory).changed, [patch.files[1].path]);
  assertDelegationRuntimePatched(directory);
});

test('all files are validated before writing: unknown bytes in either file leave both untouched', t => {
  for (const spec of patch.files) {
    const directory = fixture(t); fs.appendFileSync(path.join(directory, spec.path), '\n// unrecognized change\n');
    const before = snapshot(directory);
    assert.throws(() => applyDelegationRuntimePatch(directory), errorCode);
    assert.throws(() => assertDelegationRuntimePatched(directory), errorCode);
    assert.deepEqual(snapshot(directory), before);
  }
});

test('unexpected package versions/names, truncated runtime and missing files fail without writes', t => {
  for (const metadata of [{ name: '@ethereumjs/evm', version: '10.1.4' }, { name: 'other', version: '10.1.3' }, { name: '@ethereumjs/evm', version: 10 }]) {
    const directory = fixture(t), before = snapshot(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
    assert.throws(() => applyDelegationRuntimePatch(directory), errorCode); assert.deepEqual(snapshot(directory), before);
  }
  const directory = fixture(t), first = fs.readFileSync(path.join(directory, patch.files[0].path));
  fs.truncateSync(path.join(directory, patch.files[1].path), 1);
  assert.throws(() => applyDelegationRuntimePatch(directory), errorCode);
  fs.unlinkSync(path.join(directory, patch.files[1].path));
  assert.throws(() => applyDelegationRuntimePatch(directory), errorCode);
  assert.deepEqual(fs.readFileSync(path.join(directory, patch.files[0].path)), first);
});

test('symlinked runtime files are refused without mutating the linked file or the other runtime', t => {
  const directory = fixture(t), spec = patch.files[1], file = path.join(directory, spec.path), target = path.join(directory, 'untouched.js');
  fs.renameSync(file, target); fs.symlinkSync(target, file);
  const before = fs.readFileSync(target), first = fs.readFileSync(path.join(directory, patch.files[0].path));
  assert.throws(() => applyDelegationRuntimePatch(directory), errorCode);
  assert.deepEqual(fs.readFileSync(target), before); assert.deepEqual(fs.readFileSync(path.join(directory, patch.files[0].path)), first);
});
