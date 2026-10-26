// Offline reproduction using archived source, never the current engine tree.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = new URL('./', import.meta.url);
const root = new URL('../../', directory);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readBound = async (url, entry) => {
  const bytes = await readFile(url);
  assert.equal(bytes.length, entry.bytes, `${entry.path}: byte count`);
  assert.equal(sha(bytes), entry.sha256, `${entry.path}: hash`);
  return bytes;
};
const safePath = value => {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/);
  assert.ok(!value.split('/').some(part => part === '.' || part === '..'));
  return value;
};
const bindingBytes = await readFile(new URL('reproduction.json', directory));
assert.equal(sha(bindingBytes), '02f4b708f6b36dbbcfc9710851b51a7975441861c524c1f74fbb7c322883d0ac');
const binding = JSON.parse(bindingBytes);
const inventoryBytes = await readFile(new URL('source-inventory.json', directory));
assert.equal(sha(inventoryBytes), binding.sourceInventorySha256);
const inventory = JSON.parse(inventoryBytes);
assert.equal(inventory.length, 7);
assert.equal(new Set(inventory.map(entry => entry.path)).size, 7);
assert.deepEqual(binding.loaderPackage, { type: 'module' });

// Read and validate every file before creating the isolated tree. The external
// files are only the immutable evidence packet, not any current source files.
const tree = new Map();
for (const entry of inventory) {
  const relative = safePath(entry.path);
  tree.set(relative, await readBound(new URL(`source/${relative}`, directory), entry));
}
for (const entry of binding.evidence) {
  const relative = safePath(entry.path);
  assert.ok(relative.startsWith('reports/standard-evm-deposits/'));
  assert.ok(!tree.has(relative), 'Overlapping source/evidence path.');
  tree.set(relative, await readBound(new URL(relative, root), entry));
}
const verifier = await readBound(new URL(safePath(binding.originalVerifier.archivePath), directory), binding.originalVerifier);
const verifierPath = safePath(binding.originalVerifier.path);
assert.equal(verifierPath, 'reports/standard-evm-deposits/verify.mjs');
tree.set(verifierPath, verifier);
const capture = JSON.parse(tree.get('reports/standard-evm-deposits/capture.json'));
assert.deepEqual(inventory, capture.sourceInventoryBefore);
assert.deepEqual(inventory, capture.sourceInventoryAfter);
assert.deepEqual(capture.runtime, binding.captureRuntime);

const temporary = await mkdtemp(join(tmpdir(), 'standard-evm-deposits-v1-'));
try {
  // This minimal loader setting is not transaction data or a package dependency.
  await writeFile(join(temporary, 'package.json'), JSON.stringify(binding.loaderPackage) + '\n');
  for (const [relative, bytes] of tree) {
    const target = join(temporary, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  const child = spawnSync(process.execPath, [join(temporary, verifierPath)], {
    cwd: temporary,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_048_576,
    env: { PATH: process.env.PATH || '' },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.verified, true);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.sourceFiles, 7);
  console.log(JSON.stringify({
    archiveVerified: true,
    currentSourceFilesRead: 0,
    packageDependencies: 0,
    archivedSourceFiles: inventory.length,
    pinnedEvidenceFiles: binding.evidence.length,
    sourceInventorySha256: binding.sourceInventorySha256,
    originalVerifierSha256: binding.originalVerifier.sha256,
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
    originalVerifierResult: result,
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
