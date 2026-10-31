// New current-runtime inventory. Old captures/manifests remain unchanged.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {files, checkRows, sha} from '../storage-creation-lifecycle-v035/toolchain.mjs';
export {files, checkRows, sha};
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLCHAIN_FILE = 'research/local-sequence-v036-reference/toolchain.json';
export const TOOLCHAIN_SHA256 = '3c69ebf10c2650c6f5ad29bcc7bf738766f72fd9b7ff01424f3cc2227b3aca19';
export const DEPENDENCIES = Object.freeze(['research/storage-creation-lifecycle-v035/toolchain.mjs']);
export function verifyToolchain(manifestPath = path.join(ROOT, TOOLCHAIN_FILE)) {
  const size = fs.statSync(manifestPath).size; assert(size <= 2 * 1024 * 1024);
  const raw = fs.readFileSync(manifestPath); assert.equal(sha(raw), TOOLCHAIN_SHA256);
  const t = JSON.parse(raw);
  for (const key of ['source','venv']) {
    const base = path.join(t.toolchain,key);
    assert.deepEqual(files(base),t[key].map(r=>r.path).sort()); checkRows(base,t[key]);
  }
  assert.deepEqual(files(t.stdlibPath,['site-packages']),t.stdlib.map(r=>r.path).sort());
  checkRows(t.stdlibPath,t.stdlib); checkRows('',t.runtime);
  assert.equal(fs.existsSync(path.join(path.dirname(t.stdlibPath),'python312.zip')),t.stdlibZipExists);
  assert.equal(t.python,path.join(t.toolchain,'venv/bin/python'));
  return {sha256:TOOLCHAIN_SHA256,bytes:raw.length,manifest:structuredClone(t),
    entries:t.source.length+t.venv.length+t.stdlib.length+t.runtime.length};
}
