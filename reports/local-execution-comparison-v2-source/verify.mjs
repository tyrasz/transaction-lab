// Reexecute the original v2 profile from immutable archived source. Never load
// the current local engine, replace original results, or access a provider.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DIR = new URL('./', import.meta.url), ROOT = new URL('../../', DIR);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async url => JSON.parse(await readFile(url));
const RESULT_SHA = 'c2eec4623db8890e21cdff02cdd31f0249c055e3485abdf026784c4ae81df803';
const ENGINE_SHA = 'ff8e4d13a2160256b35ab1f3a64e3c05e750e515e8b87b4f3ce4b59d7bed6575';
const LOCK_SHA = '78b150d101a54b715a5d292a86566764723c9222e4379706ef681b46dbee4feb';
const RUNNER_SHA = '585d44ad0a098cdb04a894cba7f01db5938193593cc2c2c248165c5e11ef7f5f';
const resultBytes = await readFile(new URL('reports/local-execution-comparison-v2/results.json', ROOT));
assert.equal(sha(resultBytes), RESULT_SHA);
const report = JSON.parse(resultBytes), inventory = await json(new URL('source-inventory.json', DIR));
assert.deepEqual(inventory, report.provenance.engine);
assert.equal(inventory.sourceSha256, ENGINE_SHA); assert.equal(inventory.lockSha256, LOCK_SHA);
assert.deepEqual([process.version, process.versions.v8, process.platform, process.arch], [inventory.node, inventory.v8, inventory.platform, inventory.arch], 'The original runner binds its runtime identity exactly.');
const preservation = await json(new URL('preservation.json', DIR));
assert.equal(preservation.recoveredFromCommit, '9d64eb60e5363bfa8f43f4cc1100ce3ed2e1f4bc');
assert.equal(preservation.originalEngineSourceSha256, ENGINE_SHA); assert.equal(preservation.originalLockSha256, LOCK_SHA);
assert.equal(preservation.files.length, inventory.files.length);
const digest = createHash('sha256');
for (const entry of inventory.files) {
  const bytes = await readFile(new URL('engine/' + entry.file, DIR));
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  const recovered = preservation.files.find(row => row.archivePath === 'engine/' + entry.file);
  assert.ok(recovered); assert.equal(recovered.gitPath, 'engines/local-evm/' + entry.file);
  assert.equal(recovered.sha256, entry.sha256); assert.equal(recovered.bytes, entry.bytes);
  digest.update(entry.file + '\0').update(bytes).update('\0');
}
assert.equal(digest.digest('hex'), ENGINE_SHA);
const runner = await readFile(new URL('runner/run.mjs', DIR));
assert.equal(sha(runner), RUNNER_SHA); assert.equal(sha(runner), report.provenance.runnerSha256);
assert.deepEqual(runner, await readFile(new URL('reports/local-execution-comparison-v2/run.mjs', ROOT)));
for (const entry of preservation.packets) {
  const bytes = await readFile(new URL(entry.file, ROOT)); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
}
const originalPacket = await json(new URL('reports/local-execution-comparison-v2/packet-manifest.json', ROOT));
for (const entry of originalPacket.files) {
  const bytes = await readFile(new URL('reports/local-execution-comparison-v2/' + entry.file, ROOT));
  assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
}

// Reuse installed dependencies only after the original lock/direct-version
// identity and preservation-time package metadata identities have been checked.
// This does not attest complete installed tarball contents retrospectively.
const lockBytes = await readFile(new URL('engine/package-lock.json', DIR)); assert.equal(sha(lockBytes), LOCK_SHA);
const lock = JSON.parse(lockBytes), packageJson = await json(new URL('engine/package.json', DIR));
const dependencyInventory = await json(new URL('dependency-inventory.json', DIR));
assert.equal(dependencyInventory.originalLockSha256, LOCK_SHA);
const lockedPackages = Object.entries(lock.packages).filter(([location]) => location !== '');
assert.deepEqual(dependencyInventory.packages.map(row => row.location), lockedPackages.map(([location]) => location));
for (const [location, locked] of lockedPackages) {
  const installedBytes = await readFile(new URL('engines/local-evm/' + location + '/package.json', ROOT));
  const installed = JSON.parse(installedBytes), recorded = dependencyInventory.packages.find(row => row.location === location);
  assert.deepEqual(recorded, { location, name: installed.name, version: locked.version, lockIntegrity: locked.integrity ?? null, installedPackageJsonSha256: sha(installedBytes) });
  assert.equal(installed.version, locked.version);
}
const direct = Object.entries(packageJson.dependencies).sort(([a], [b]) => a < b ? -1 : 1).map(([name, version]) => ({ name, version, lockIntegrity: lock.packages['node_modules/' + name].integrity ?? null }));
assert.deepEqual(direct, inventory.dependencies);

const temp = await mkdtemp(join(tmpdir(), 'transaction-lab-v2-reproduction-'));
let originalVerification;
try {
  await mkdir(join(temp, 'engines'), { recursive: true });
  await cp(new URL('engine/', DIR), join(temp, 'engines/local-evm'), { recursive: true });
  await symlink(fileURLToPath(new URL('engines/local-evm/node_modules', ROOT)), join(temp, 'engines/local-evm/node_modules'), 'dir');
  await mkdir(join(temp, 'reports'), { recursive: true });
  for (const name of ['local-execution-state', 'local-execution-comparison', 'local-execution-comparison-v2']) {
    await cp(new URL('reports/' + name, ROOT), join(temp, 'reports', name), { recursive: true });
  }
  await mkdir(join(temp, 'reports/local-execution-comparison-v1-source'));
  await cp(new URL('reports/local-execution-comparison-v1-source/source-inventory.json', ROOT), join(temp, 'reports/local-execution-comparison-v1-source/source-inventory.json'));
  await cp(new URL('runner/run.mjs', DIR), join(temp, 'reports/local-execution-comparison-v2/run.mjs'));
  const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('network-guard.mjs', DIR)), join(temp, 'reports/local-execution-comparison-v2/run.mjs'), '--verify'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message); assert.equal(result.stderr, '');
  originalVerification = JSON.parse(result.stdout);
  assert.deepEqual(originalVerification, await json(new URL('reports/local-execution-comparison-v2/verification.json', ROOT)), 'The original verifier output must remain identical.');
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(JSON.stringify({ status: 'verified_archived_v2_by_reexecution', recoveredFromCommit: preservation.recoveredFromCommit,
  archivedEngineFiles: inventory.files.length, verifiedInstalledDependencyMetadata: lockedPackages.length,
  engineSourceSha256: ENGINE_SHA, lockSha256: LOCK_SHA, runnerSha256: RUNNER_SHA, resultsSha256: RESULT_SHA,
  originalVerification, currentEngineImported: false, originalPacketChanged: false, networkCalls: 0,
  limitations: ['The original runner requires exact Node/V8/platform identity and exact report equality; no output normalization was added.',
    'Installed dependencies are reused with pinned lock/version and preservation-time metadata checks; historical complete installed-code attestation is not claimed.'] }, null, 2));
