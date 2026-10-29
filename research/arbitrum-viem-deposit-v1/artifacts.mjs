import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const SOURCE_ROOTS = ['PLAN.md', 'artifacts.mjs', 'policy.mjs', 'transport.mjs', 'prepare.mjs', 'run.mjs', 'verify.mjs', 'run.test.mjs', 'package.json', 'package-lock.json', 'scenario.json', 'preparation', 'node_modules'];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const text = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v instanceof Error ? safeError(v) : v, 2) + '\n';
export function save(root, name, value) {
  assert.match(name, /^[a-zA-Z0-9_.\/-]+$/); assert.ok(!name.split('/').includes('..'));
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : text(value));
  const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true });
  const fd = fs.openSync(filename, 'wx', 0o644);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { path: name, bytes: data.length, sha256: sha(data) };
}
export function artifactWriter(root) {
  const written = []; let failure = null;
  return {
    write(name, value) {
      try { if (failure) throw failure; const entry = save(root, name, value); written.push(entry); return entry; }
      catch (error) { failure = error; throw error; }
    },
    verify() {
      if (failure) throw failure;
      for (const entry of written) {
        const filename = path.join(root, entry.path); assert.ok(fs.lstatSync(filename).isFile()); const bytes = fs.readFileSync(filename);
        assert.equal(bytes.length, entry.bytes, 'Saved artifact changed size.'); assert.equal(sha(bytes), entry.sha256, 'Saved artifact changed after durable write.');
      }
    },
  };
}
export function inventory(root, roots) {
  const files = [];
  function visit(relative) {
    const filename = path.join(root, relative), stat = fs.lstatSync(filename);
    if (stat.isDirectory()) for (const child of fs.readdirSync(filename).sort()) visit(path.posix.join(relative, child));
    else if (stat.isFile()) { const data = fs.readFileSync(filename); files.push({ path: relative, bytes: data.length, sha256: sha(data), mode: stat.mode & 0o777 }); }
    else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(filename), resolved = fs.realpathSync(filename);
      assert.ok(resolved.startsWith(fs.realpathSync(root) + path.sep), 'Source symlink escapes experiment.');
      files.push({ path: relative, symlink: target, sha256: sha(target), mode: stat.mode & 0o777 });
    } else throw new Error('Unsupported source file type.');
  }
  for (const relative of roots) visit(relative);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export function verifyInventory(root, manifest) { assert.deepEqual(inventory(root, manifest.roots), manifest.files); }
export function safeError(error) {
  if (!error || typeof error !== 'object') return { name: 'ThrownValue', message: String(error).slice(0, 4096) };
  const out = {};
  for (const key of ['name', 'message', 'shortMessage', 'details', 'code']) {
    const value = error[key]; if (typeof value === 'string' || typeof value === 'number') out[key] = typeof value === 'string' ? value.slice(0, 32768) : value;
  }
  if (error.cause && error.cause !== error) out.cause = { name: String(error.cause.name ?? 'Error'), message: String(error.cause.message ?? error.cause).slice(0, 32768), ...(Number.isInteger(error.cause.code) ? { code: error.cause.code } : {}) };
  return out;
}
