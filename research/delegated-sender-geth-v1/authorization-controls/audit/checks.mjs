import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const sha = b => createHash('sha256').update(b).digest('hex');
export function recordedCapturePaths(sourceRoot, originalDirectory) {
  assert.equal(typeof sourceRoot, 'string');
  assert(path.posix.isAbsolute(sourceRoot));
  assert.equal(path.posix.normalize(sourceRoot), sourceRoot);
  const original = path.posix.join(sourceRoot, 'research/delegated-sender-geth-v1/authorization-controls/capture');
  if (originalDirectory !== undefined) assert.equal(originalDirectory, original);
  return {original, followup: path.posix.resolve(original, '../storage-encoding-followup/capture')};
}
export function parseRaw(raw, limit) {
  assert.equal(raw.processCompletion, 'spawnSync_returned_after_child_and_pipes_closed');
  assert(Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 && raw.timeoutMs <= limit);
  assert(Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0);
  let bytes = 0;
  for (const stream of [raw.stdout, raw.stderr]) {
    assert.equal(typeof stream.base64, 'string');
    const b = Buffer.from(stream.base64, 'base64');
    assert.equal(b.toString('base64'), stream.base64);
    assert.equal(b.length, stream.bytes);
    assert.equal(sha(b), stream.sha256);
    bytes += b.length;
  }
  const clean = raw.exitCode === 0 && raw.signal === null && raw.error === null && raw.elapsedMs <= raw.timeoutMs;
  return {bytes, parsed: clean ? JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(raw.stdout.base64, 'base64'))) : null};
}

export function classify(raw, expected) {
  const {parsed} = parseRaw(raw, 5000);
  if (parsed === null) return 'unavailable';
  assert(Array.isArray(parsed) && parsed.length === 1);
  const result = parsed[0];
  assert(Object.keys(result).every(k => ['name', 'fork', 'pass', 'stateRoot', 'error'].includes(k)));
  assert.equal(result.name, expected.name);
  assert.equal(result.fork, expected.fork);
  assert.equal(typeof result.pass, 'boolean');
  assert.match(result.stateRoot, /^0x[0-9a-f]{64}$/);
  if (result.pass) assert.equal(result.error, undefined);
  return result.pass && result.stateRoot === expected.stateRoot ? 'matched' : 'mismatched';
}

export function storageEncodingOnly(original, corrected) {
  assert.deepEqual(Object.keys(original), ['storage_clear_refund']);
  const reconstructed = structuredClone(original);
  const edits = [];
  for (const [address, account] of Object.entries(reconstructed.storage_clear_refund.pre)) {
    for (const [key, before] of Object.entries(account.storage)) {
      assert.match(before, /^0x[0-9a-fA-F]+$/);
      const value = BigInt(before);
      assert(value >= 0n && value < 2n ** 256n);
      const after = '0x' + value.toString(16).padStart(64, '0');
      assert.equal(BigInt(after), value);
      account.storage[key] = after;
      edits.push({address, key, before, after});
    }
  }
  assert.deepEqual(corrected, reconstructed);
  return edits;
}
