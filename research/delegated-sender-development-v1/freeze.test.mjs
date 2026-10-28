import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectDevelopmentSourcePaths, inspectCohortSources } from './freeze.mjs';

const folder = 'research/delegated-sender-development-v1';
test('development notes are an exact bounded optional filename, not an arbitrary file or link', async t => {
  const root = mkdtempSync('/tmp/delegated-source-docs-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, folder); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.mjs'), '// unrelated source control'); writeFileSync(join(dir, 'PLAN.md'), 'Plan');
  writeFileSync(join(dir, 'run.test.mjs'), '// excluded test control');
  assert.deepEqual(await inspectDevelopmentSourcePaths(root), [folder + '/PLAN.md', folder + '/run.mjs']);
  writeFileSync(join(dir, 'NOTES.md'), 'Post-freeze launch note');
  assert.deepEqual(await inspectDevelopmentSourcePaths(root), [folder + '/NOTES.md', folder + '/PLAN.md', folder + '/run.mjs']);
  unlinkSync(join(dir, 'NOTES.md'));
  for (const name of ['notes.md', 'README.md', 'other.json', 'nested/NOTES.md', 'nested/PLAN.md']) {
    const path = join(dir, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'unexpected');
    await assert.rejects(inspectDevelopmentSourcePaths(root), /Unexpected coverage source file/); unlinkSync(path);
  }
  writeFileSync(join(dir, 'NOTES.md'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(inspectDevelopmentSourcePaths(root), /documentation exceeds/); unlinkSync(join(dir, 'NOTES.md'));
  symlinkSync('PLAN.md', join(dir, 'NOTES.md')); await assert.rejects(inspectDevelopmentSourcePaths(root), /Symlinks/);
});

test('current development inventory binds the exact notes bytes', async () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url)), manifest = await inspectCohortSources({ repoRoot });
  const path = folder + '/NOTES.md', bytes = readFileSync(join(repoRoot, path)), row = manifest.files.find(item => item.path === path);
  assert.equal(row.kind, 'file'); assert.equal(row.bytes, bytes.length);
  assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
});
