// Offline source capture, not a plan freeze or authorization to dispatch RPCs.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, readlink, symlink, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute, sep, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const MAX_FILES = 20000, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024, MAX_MANIFEST = 8 * 1024 * 1024;
const DEPS = ['engines/local-evm/node_modules', 'engines/standard-evm/node_modules'];
const LOCAL_ROOT = 'engines/local-evm';
const SHARED_CONTEXT = 'engines/evm-context.js';
const REQUIRED_LOCAL = ['isolated-call.js', 'isolated-worker.js', 'isolated-protocol.js', 'ethereum-call.js', 'ethereum-profile.js', 'ethereum-header.js', 'execute.js', 'rpc-state-inputs.js', 'proof-state.js', 'verified-state-proof.js', 'package.json', 'package-lock.json'].map(p => `${LOCAL_ROOT}/${p}`);
const WIRE = 'reports/ethereum-lending-local-reference/wire.mjs';
const POLICY = 'Current isolated local product engine and complete installed local/standard dependencies; source-bound ordinary-local coverage and reused cohort modules. Engine-only comparison, no API or asset-inventory coverage.';
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { code: 'COHORT_FREEZE_INVALID' }); };
const ordered = values => [...values].sort();

function sourcePath(path) {
  need(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\\') && !path.includes('\0') && !isAbsolute(path) && posix.normalize(path) === path && !path.split('/').some(p => p === '.' || p === '..' || p === ''), 'Source path must be a canonical repository-relative path.');
  return path;
}
async function directory(path) {
  const stat = await lstat(path); need(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a real directory, not a symlink.');
}
async function noLinkedParents(root, path) {
  const parts = sourcePath(path).split('/');
  for (let i = 1; i < parts.length; i++) await directory(join(root, ...parts.slice(0, i)));
}
async function walk(root, subpath, skip = () => false) {
  await noLinkedParents(root, subpath); await directory(join(root, subpath));
  const result = [];
  async function visit(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`; sourcePath(child); if (skip(child, entry)) continue;
      if (entry.isDirectory()) await visit(child);
      else { need(entry.isFile() || entry.isSymbolicLink(), 'Only regular source files and bounded dependency symlinks are supported.'); result.push(child); need(result.length <= MAX_FILES, 'Source file count exceeded.'); }
    }
  }
  await visit(subpath); return ordered(result);
}
async function entry(root, path) {
  sourcePath(path); await noLinkedParents(root, path);
  const stat = await lstat(join(root, path));
  if (stat.isSymbolicLink()) {
    const dependencyRoot = DEPS.find(prefix => path.startsWith(prefix + '/'));
    need(dependencyRoot, 'Symlinks are allowed only inside installed dependency trees.');
    const target = await readlink(join(root, path));
    need(target && !isAbsolute(target) && !target.includes('\\') && !target.includes('\0'), 'Dependency symlink target must be relative.');
    const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target));
    need(resolvedTarget.startsWith(dependencyRoot + '/'), 'Dependency symlink escapes its complete installed tree.');
    await noLinkedParents(root, resolvedTarget);
    const destination = await lstat(join(root, resolvedTarget));
    // A single file link is enough for npm .bin. Reject link chains, cycles and
    // directory links rather than treating another source tree as installed.
    need(destination.isFile() && !destination.isSymbolicLink(), 'Dependency symlink must point directly to a regular archived file.');
    return { path, kind: 'symlink', target };
  }
  need(stat.isFile() && stat.size <= MAX_FILE, 'Source is not a bounded regular file.');
  const bytes = await readFile(join(root, path));
  need(bytes.length <= MAX_FILE, 'Source file exceeded its byte limit.');
  return { path, kind: 'file', bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 };
}
async function inventory(root, paths) {
  need(paths.length <= MAX_FILES && new Set(paths).size === paths.length && new Set(paths.map(p => p.toLowerCase())).size === paths.length, 'Source inventory contains too many or ambiguous paths.');
  const result = []; let total = 0;
  for (const path of ordered(paths)) { const item = await entry(root, path); total += item.bytes ?? 0; need(total <= MAX_TOTAL, 'Source inventory exceeded its byte limit.'); result.push(item); }
  const byPath = new Map(result.map(item => [item.path, item]));
  for (const item of result) if (item.kind === 'symlink') need(byPath.get(posix.normalize(posix.join(posix.dirname(item.path), item.target)))?.kind === 'file', 'Dependency symlink target is missing from the source closure.');
  return result;
}
async function fingerprint(root, paths) {
  const digest = createHash('sha256');
  for (const path of paths) { need((await entry(root, path)).kind === 'file', 'Product implementation entries must be regular files.'); digest.update(path + '\0').update(await readFile(join(root, path))).update('\0'); }
  return digest.digest('hex');
}
function implementation(value) {
  need(value && typeof value.name === 'string' && value.name.length > 0 && typeof value.version === 'string' && value.version.length > 0 && /^[a-f0-9]{64}$/.test(value.sourceSha256) && Array.isArray(value.sourceFiles) && value.sourceFiles.length > 0 && value.sourceFiles.length <= MAX_FILES, 'Implementation identity is incomplete.');
  value.sourceFiles.forEach(sourcePath);
  need(isDeepStrictEqual(value.sourceFiles, ordered(new Set(value.sourceFiles))), 'Implementation source paths must be unique and sorted.');
}
const localIdentity = (files, runtime, version) => {
  const local = files.filter(item => item.path.startsWith(LOCAL_ROOT + '/') || item.path === SHARED_CONTEXT || item.path === 'package.json');
  return { name: 'Transaction Lab isolated Ethereum product engine', version, sourceSha256: sha(JSON.stringify({ files: local, runtime })), sourceFiles: local.map(item => item.path) };
};

/** Hash the actual executable; do not copy it or infer it from a version string. */
export async function inspectNodeRuntime() {
  const executable = await realpath(process.execPath), before = await lstat(executable);
  need(before.isFile() && before.size <= MAX_TOTAL, 'Node executable is not a bounded regular file.');
  const digest = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(executable)) { bytes += part.length; need(bytes <= MAX_TOTAL, 'Node executable exceeded its byte limit.'); digest.update(part); }
  const after = await lstat(executable);
  need(bytes === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino, 'Node executable changed while being hashed.');
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, executableBytes: bytes, executableSha256: digest.digest('hex') };
}
export async function verifyNodeRuntime(expected) {
  const actual = await inspectNodeRuntime(); need(isDeepStrictEqual(actual, expected), 'Current Node executable/runtime differs from the frozen runtime.'); return actual;
}

/** Read-only inventory. extras only add files; they cannot replace derived paths. */
export async function inspectCohortSources({ repoRoot, extraFiles = [] }) {
  const root = await realpath(resolve(repoRoot)); await directory(root);
  need(Array.isArray(extraFiles) && extraFiles.length === 0, 'The source inventory is fixed.');
  const local = await walk(root, LOCAL_ROOT, path => path === `${LOCAL_ROOT}/test` || path === `${LOCAL_ROOT}/node_modules`);
  const localSources = local.filter(path => path.endsWith('.js') || ['package.json', 'package-lock.json'].includes(posix.basename(path)));
  const standard = await walk(root, 'engines/standard-evm', path => path === 'engines/standard-evm/test' || path === 'engines/standard-evm/node_modules');
  const standardSources = standard.filter(path => path.endsWith('.js') || ['package.json', 'package-lock.json'].includes(posix.basename(path)));
  const research = await walk(root, 'research/standard-evm');
  const cohort = research.filter(path => posix.dirname(path) === 'research/standard-evm' && /^cohort-.*\.mjs$/.test(posix.basename(path)) && !path.endsWith('.test.mjs'));
  const owned = (await walk(root, 'research/ordinary-local-coverage-v1')).filter(path => !path.endsWith('.test.mjs'));
  need(owned.every(path => path.endsWith('.mjs') || path.endsWith('/PLAN.md')), 'Unexpected coverage source file.');
  const dependencyPaths = (await Promise.all(DEPS.map(path => walk(root, path)))).flat();
  const paths = ordered(new Set(['package.json', ...localSources, ...standardSources, ...REQUIRED_LOCAL, SHARED_CONTEXT, ...dependencyPaths, ...cohort, ...owned, WIRE, 'research/standard-evm/cohort-deployments.json']));
  const files = await inventory(root, paths), runtime = await inspectNodeRuntime();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  need(typeof pkg.version === 'string' && pkg.version.length > 0, 'Release version missing.');
  const localImplementation = localIdentity(files, runtime, pkg.version);
  return { schemaVersion: '1.0', policy: POLICY, extraFiles: [], localImplementation, runtime, files,
    filesCount: files.length, regularFileBytes: files.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    localIdentityAlgorithm: 'SHA256(JSON.stringify({files:complete_local_inventory_plus_shared_context_and_release_package,runtime:node_executable_identity}))',
    limitations: { sourceIdentityOnly: true, osSandbox: false, dependencySafetyAttested: false, planFrozen: false, seedPredeclared: false, publicDispatchAuthorized: false } };
}

/** Creates a new directory exclusively. A failed partial archive is left intact
 * without source-manifest.json; callers must never reuse or repair it in place. */
export async function freezeCohortSources({ repoRoot, outputDirectory, extraFiles = [] }) {
  const root = await realpath(resolve(repoRoot)), requestedOut = resolve(outputDirectory);
  // Canonicalize the existing parent before checking overlap: /tmp aliases (or
  // a linked parent directory) must not bypass the source-tree exclusion.
  const out = join(await realpath(dirname(requestedOut)), basename(requestedOut));
  await directory(dirname(out));
  const relativeOut = relative(root, out).split(sep).join('/');
  need(out !== root && !DEPS.some(prefix => relativeOut === prefix || relativeOut.startsWith(prefix + '/')) && relativeOut !== LOCAL_ROOT && !relativeOut.startsWith(LOCAL_ROOT + '/') && relativeOut !== 'research' && !relativeOut.startsWith('research/') && relativeOut !== 'engines' && !relativeOut.startsWith('engines/'), 'Archive output must be outside the source trees it captures.');
  const before = await inspectCohortSources({ repoRoot: root, extraFiles });
  await mkdir(out); await mkdir(join(out, 'runtime'));
  for (const item of before.files) {
    need(isDeepStrictEqual(await entry(root, item.path), item), 'Source changed before its archive copy.');
    const destination = join(out, 'runtime', item.path); await mkdir(dirname(destination), { recursive: true });
    if (item.kind === 'symlink') await symlink(item.target, destination);
    else {
      const bytes = await readFile(join(root, item.path)); need(bytes.length === item.bytes && sha(bytes) === item.sha256, 'Source changed during its archive copy.');
      await writeFile(destination, bytes, { flag: 'wx', mode: item.mode }); await chmod(destination, item.mode);
    }
  }
  need(isDeepStrictEqual(await inventory(join(out, 'runtime'), before.files.map(item => item.path)), before.files), 'Archive copy readback differs from source inventory.');
  const after = await inspectCohortSources({ repoRoot: root, extraFiles });
  need(isDeepStrictEqual(before, after), 'Source tree or Node runtime changed while freezing.');
  const manifest = { ...before, createdAt: new Date().toISOString() }, text = JSON.stringify(manifest, null, 2) + '\n';
  need(Buffer.byteLength(text) <= MAX_MANIFEST, 'Source manifest exceeded its byte limit.');
  await writeFile(join(out, 'source-manifest.json'), text, { flag: 'wx' });
  const result = await verifyFrozenSources({ outputDirectory: out, expectedManifestSha256: sha(text) });
  return { ...result, outputDirectory: out };
}

/** Verifies only archive bytes and manifest. No imports from archived code, no
 * working-tree dependency and no executable requirement on the inspecting host.
 * The caller must bind expectedManifestSha256 in its separately frozen plan. */
export async function verifyFrozenSources({ outputDirectory, expectedManifestSha256 } = {}) {
  const out = await realpath(resolve(outputDirectory)); await directory(out);
  const manifestFile = join(out, 'source-manifest.json'), stat = await lstat(manifestFile);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_MANIFEST, 'Source manifest is not a bounded regular file.');
  const bytes = await readFile(manifestFile), manifestSha256 = sha(bytes);
  if (expectedManifestSha256 !== undefined) need(/^[a-f0-9]{64}$/.test(expectedManifestSha256) && manifestSha256 === expectedManifestSha256, 'Source manifest differs from its frozen hash.');
  const manifest = JSON.parse(bytes);
  need(manifest?.schemaVersion === '1.0' && manifest.policy === POLICY && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, 'Source manifest shape is invalid.');
  implementation(manifest.localImplementation);
  const paths = manifest.files.map(item => sourcePath(item.path));
  need(isDeepStrictEqual(paths, ordered(new Set(paths))), 'Manifest inventory is not unique canonical order.');
  await directory(join(out, 'runtime'));
  // Walk the entire archived tree: an unlisted executable/helper cannot hide.
  const actualPaths = (await walk(out, 'runtime')).map(path => path.slice('runtime/'.length));
  need(isDeepStrictEqual(actualPaths, paths), 'Archived sources were added or removed.');
  const actual = await inventory(join(out, 'runtime'), paths);
  need(isDeepStrictEqual(actual, manifest.files), 'Archived source bytes, modes or links changed.');
  need(manifest.filesCount === actual.length && manifest.regularFileBytes === actual.reduce((sum, item) => sum + (item.bytes ?? 0), 0), 'Manifest source totals differ.');
  const byPath = new Set(paths);
  // Shared helpers belong to the frozen product/local inventory. Older sealed
  // runtimes predate them and must remain verifiable under their own inventory.
  for (const path of [...manifest.localImplementation.sourceFiles, ...REQUIRED_LOCAL, WIRE, 'package.json', ...['run.mjs','freeze.mjs','verify.mjs','case.mjs','PLAN.md'].map(name=>'research/ordinary-local-coverage-v1/'+name)]) need(byPath.has(path), 'Required implementation source is absent.');
  const pkg = JSON.parse(await readFile(join(out, 'runtime', 'package.json'), 'utf8'));
  need(isDeepStrictEqual(localIdentity(actual, manifest.runtime, pkg.version), manifest.localImplementation), 'Archived local-runtime identity differs.');
  return { status: 'verified', manifest, manifestSha256, manifestBytes: bytes.length };
}
