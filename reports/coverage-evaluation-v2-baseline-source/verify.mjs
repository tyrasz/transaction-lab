// Offline only: verify the exact archive, then run the unchanged original audit
// against the repository-shaped archive. No live repository sources are read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestSha256 = '5bd284cabfe3ea04c349a8f667c8a6c8e75916dd31ad08f8cb018e2f3d56395a';
const sourceSha256 = '37dfa8d10226b144da8895ac7860171aad5fe686a8d630326bd22fe18f042e72';
const originalPilot = 'reports/coverage-evaluation-v2/2026-10-26T07-52-08.304Z-60177bf2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);

export async function verify({ directory = here } = {}) {
  // Resolve the caller's root once (macOS temporary roots commonly have a
  // /var -> /private/var alias); all entries below it must remain nonsymlinked.
  directory = await fs.realpath(path.resolve(directory));
  const manifestBytes = await fs.readFile(path.join(directory, 'archive-manifest.json'));
  assert.equal(hash(manifestBytes), manifestSha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.copiedFromCommit, '35649a5d14606dc29cf930b6f5d158258fa374b3');
  assert.equal(manifest.originalPilot, originalPilot);
  assert.equal(manifest.frozenSourceSha256, sourceSha256);
  const repository = path.join(directory, 'repository');
  const seen = new Set();
  let retainedBytes = 0;
  for (const file of manifest.files) {
    assert.equal(file.archiveFile, 'repository/' + file.path);
    assert.ok(!seen.has(file.archiveFile)); seen.add(file.archiveFile);
    const absolute = path.resolve(directory, file.archiveFile);
    assert.ok(absolute.startsWith(repository + path.sep));
    assert.equal(await fs.realpath(absolute), absolute);
    const bytes = await fs.readFile(absolute);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(hash(bytes), file.sha256, file.path);
    retainedBytes += bytes.length;
  }
  const actual = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Symlinked archive entry: ' + child);
      if (entry.isDirectory()) await walk(child);
      else { assert.ok(entry.isFile()); actual.push(child); }
    }
  }
  await walk('repository');
  assert.deepEqual(actual.sort(), [...seen].sort(), 'Archive has exactly the bound source and evidence files.');
  const pilot = path.join(repository, originalPilot);
  const originalManifest = JSON.parse(await fs.readFile(path.join(pilot, 'manifest.json')));
  const sourceFiles = manifest.files.filter(file => file.kind === 'frozen_source');
  const evidenceFiles = manifest.files.filter(file => file.kind === 'unchanged_pilot_evidence');
  assert.equal(sourceFiles.length, 34); assert.equal(evidenceFiles.length, 14);
  assert.equal(sourceFiles.length + evidenceFiles.length, manifest.files.length);
  assert.deepEqual(sourceFiles.map(file => ({ file: file.path, sha256: file.sha256 })), originalManifest.implementation.files);
  assert.equal(hash(JSON.stringify(originalManifest.implementation.files, null, 2) + '\n'), sourceSha256);
  assert.deepEqual(manifest.engine, originalManifest.implementation.engine);
  const engineHash = createHash('sha256');
  for (const name of manifest.engine.sourceFiles) engineHash.update(name + '\0').update(await fs.readFile(path.join(repository, 'src', name))).update('\0');
  assert.equal(engineHash.digest('hex'), manifest.engine.sourceSha256);
  // The audited script imports Node builtins only. Its exact original bytes are
  // already pinned above. Do not pass --write, import product code, or fetch.
  const { stdout, stderr } = await execute(process.execPath, [path.join(pilot, 'audit.mjs')], {
    cwd: repository, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  });
  assert.equal(stderr, '');
  const originalAuditBytes = await fs.readFile(path.join(pilot, 'audit.json'));
  assert.equal(stdout, originalAuditBytes.toString('utf8'), 'Unchanged archived audit must reproduce its entire original output.');
  const audited = JSON.parse(stdout);
  assert.equal(audited.status, 'passed');
  assert.equal(audited.reportStatus, 'enumeration_inconclusive');
  return { verified: true, networkRequests: 0, liveSourceReads: 0, liveSourceImports: 0,
    archiveManifestSha256: manifestSha256, originalSourceSha256: sourceSha256,
    engine: manifest.engine, sourceFiles: sourceFiles.length, originalPilotFiles: evidenceFiles.length,
    retainedBytes, unchangedOriginalAuditOutputSha256: hash(originalAuditBytes),
    originalAuditResult: audited,
    limitations: ['This preserves the existing integrity/accounting audit; it is not a new live run or independent execution engine.',
      'The original inconclusive population denominator and unsupported observations remain unchanged.',
      'The phrase current complete source closure in the unchanged original audit refers here to its isolated archived repository.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const result = JSON.stringify(await verify(), null, 2) + '\n';
  if (process.argv[2] === '--write') await fs.writeFile(path.join(here, 'verification.json'), result, { flag: 'wx', mode: 0o444 });
  process.stdout.write(result);
}
