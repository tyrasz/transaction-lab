import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, readlink, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { freezeCohortSources, inspectCohortSources, inspectNodeRuntime, verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const localFiles = ['isolated-call.js', 'isolated-worker.js', 'isolated-protocol.js', 'ethereum-call.js', 'ethereum-profile.js', 'ethereum-header.js', 'execute.js', 'rpc-state-inputs.js', 'proof-state.js', 'verified-state-proof.js'];
const write = async (root, path, content) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
const extra = 'research/standard-evm/cohort-deployments.json';

async function fixture(t, { drift = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'cohort-freeze-test-')), root = join(temp, 'repo'), out = join(temp, 'capture');
  t.after(() => rm(temp, { recursive: true, force: true })); await mkdir(root);
  await write(root, 'package.json', JSON.stringify({ type: 'module', version: 'test-only' }));
  await write(root, 'src/product.js', 'export const syntheticFixture = true;\n');
  await write(root, 'engines/evm-context.js', '// Shared transaction-context fixture.');
  // Tiny declared product closure, never the production source tree. The fake
  // loader calculates actual bytes; no asserted hash bypass is supplied to freeze.
  const loader = `import {readFile,writeFile} from 'node:fs/promises';import{createHash}from'node:crypto';
const root=new URL('../',import.meta.url);let calls=0;
export async function loadStandardApi(){
${drift ? "if(++calls===2)await writeFile(new URL('engines/local-evm/execute.js',root),'changed during freeze');" : ''}
const sourceFiles=['package.json','src/product.js','src/standard-loader.js','engines/standard-evm/package.json','engines/standard-evm/package-lock.json'].sort();
const hash=createHash('sha256');for(const path of sourceFiles)hash.update(path+'\\0').update(await readFile(new URL(path,root))).update('\\0');
return{implementation:{name:'Synthetic product fixture',version:'test-only',sourceSha256:hash.digest('hex'),sourceFiles}};}`;
  await write(root, 'src/standard-loader.js', loader);
  for (const engine of ['local-evm', 'standard-evm']) {
    await write(root, `engines/${engine}/package.json`, JSON.stringify({ type: 'module', version: 'test-only' }));
    await write(root, `engines/${engine}/package-lock.json`, '{"lockfileVersion":3}');
    await write(root, `engines/${engine}/node_modules/fixture/package.json`, '{"name":"fixture","version":"1.0.0"}');
    await write(root, `engines/${engine}/node_modules/fixture/index.js`, 'export const fixture = true;');
    await write(root, `engines/${engine}/node_modules/fixture/LICENSE`, 'Synthetic fixture license text.');
    await write(root, `engines/${engine}/node_modules/fixture/tests/test.js`, '// Deliberately retained dependency test.');
    await write(root, `engines/${engine}/node_modules/fixture/index.js.map`, '{"version":3}');
  }
  for (const path of localFiles) await write(root, `engines/local-evm/${path}`, '// Synthetic source fixture: ' + path);
  await write(root, 'engines/local-evm/nested/helper.js', '// Nested runtime helper.');
  await write(root, 'engines/local-evm/test/ignored.test.js', '// Not runtime.');
  await write(root, 'engines/local-evm/node_modules/.bin/tool', 'temporary');
  await rm(join(root, 'engines/local-evm/node_modules/.bin/tool'));
  await symlink('../fixture/index.js', join(root, 'engines/local-evm/node_modules/.bin/tool'));
  await write(root, 'research/standard-evm/cohort-runner.mjs', 'export const syntheticRunner = true;');
  await write(root, 'research/standard-evm/cohort-runner.test.mjs', '// Not runtime.');
  await write(root, extra, '{"synthetic":true}');
  await write(root, 'reports/ethereum-lending-local-reference/wire.mjs', '// Synthetic reused wire fixture.');
  return { root, out, temp };
}

test('conservative read-only inventory includes full dependency bytes, nested local JS and explicit metadata', async t => {
  const f = await fixture(t), result = await inspectCohortSources({ repoRoot: f.root, extraFiles: [extra] });
  assert.equal(result.productImplementation.name, 'Synthetic product fixture');
  for (const path of [extra, 'research/standard-evm/cohort-runner.mjs', 'engines/local-evm/nested/helper.js', 'engines/local-evm/node_modules/fixture/tests/test.js', 'engines/standard-evm/node_modules/fixture/index.js.map', 'engines/standard-evm/node_modules/fixture/LICENSE', 'reports/ethereum-lending-local-reference/wire.mjs']) assert(result.files.some(item => item.path === path), path);
  assert(!result.files.some(item => item.path === 'engines/local-evm/test/ignored.test.js'));
  assert(!result.files.some(item => item.path.endsWith('cohort-runner.test.mjs')));
  assert.deepEqual(result.files.map(item => item.path), [...result.files.map(item => item.path)].sort());
  assert(result.localImplementation.sourceFiles.includes('engines/evm-context.js'));
  assert(result.localImplementation.sourceFiles.every(path => path.startsWith('engines/local-evm/') || path === 'engines/evm-context.js'));
  assert.equal(result.limitations.planFrozen, false); assert.equal(result.limitations.publicDispatchAuthorized, false);
  assert.deepEqual(await readdir(f.temp), ['repo']);
});

test('exclusive freeze verifies without the working copy and retains direct internal dependency links', async t => {
  const f = await fixture(t), frozen = await freezeCohortSources({ repoRoot: f.root, outputDirectory: f.out, extraFiles: [extra] });
  const bytes = await readFile(join(f.out, 'source-manifest.json'));
  assert.equal(frozen.manifestSha256, sha(bytes)); assert.equal(frozen.manifestBytes, bytes.length); assert.equal(frozen.status, 'verified');
  assert.equal(await readlink(join(f.out, 'runtime/engines/local-evm/node_modules/.bin/tool')), '../fixture/index.js');
  await rm(f.root, { recursive: true });
  const verified = await verifyFrozenSources({ outputDirectory: f.out, expectedManifestSha256: frozen.manifestSha256 });
  assert.deepEqual(verified.manifest, frozen.manifest);
  await write(f.out, 'plan.json', '{"separatelyFrozen":true}');
  assert.equal((await verifyFrozenSources({ outputDirectory: f.out, expectedManifestSha256: frozen.manifestSha256 })).status, 'verified');
});

test('existing output directory is never replaced or repaired', async t => {
  const f = await fixture(t); await mkdir(f.out); await write(f.out, 'sentinel', 'keep');
  await assert.rejects(freezeCohortSources({ repoRoot: f.root, outputDirectory: f.out }), { code: 'EEXIST' });
  assert.deepEqual(await readdir(f.out), ['sentinel']); assert.equal(await readFile(join(f.out, 'sentinel'), 'utf8'), 'keep');
});

test('archive verification rejects additions, removals, changed bytes, modes and rewritten manifest hashes', async t => {
  const f = await fixture(t), frozen = await freezeCohortSources({ repoRoot: f.root, outputDirectory: f.out });
  const options = { outputDirectory: f.out, expectedManifestSha256: frozen.manifestSha256 };
  await write(f.out, 'runtime/unlisted.js', '// Added'); await assert.rejects(verifyFrozenSources(options), /added or removed/); await rm(join(f.out, 'runtime/unlisted.js'));
  const path = join(f.out, 'runtime/engines/local-evm/execute.js'), bytes = await readFile(path), mode = (await lstat(path)).mode & 0o777;
  await writeFile(path, '// Changed'); await assert.rejects(verifyFrozenSources(options), /bytes, modes or links changed/); await writeFile(path, bytes);
  await chmod(path, mode ^ 0o100); await assert.rejects(verifyFrozenSources(options), /bytes, modes or links changed/); await chmod(path, mode);
  await rm(path); await assert.rejects(verifyFrozenSources(options), /added or removed/); await writeFile(path, bytes, { mode });
  const manifestPath = join(f.out, 'source-manifest.json'), manifest = await readFile(manifestPath);
  await writeFile(manifestPath, manifest + ' '); await assert.rejects(verifyFrozenSources(options), /frozen hash/);
});

test('source mutation during capture leaves an incomplete archive without a usable manifest', async t => {
  const f = await fixture(t, { drift: true });
  await assert.rejects(freezeCohortSources({ repoRoot: f.root, outputDirectory: f.out }), /changed while freezing/);
  assert((await readdir(f.out)).includes('runtime')); assert(!(await readdir(f.out)).includes('source-manifest.json'));
});

test('dependency escapes, chains, cycles and non-dependency symlinks fail closed', async t => {
  const f = await fixture(t), link = join(f.root, 'engines/local-evm/node_modules/.bin/tool');
  for (const target of ['/etc/passwd', '../../../../package.json', '../fixture/missing.js', './tool']) {
    await rm(link); await symlink(target, link); await assert.rejects(inspectCohortSources({ repoRoot: f.root }));
  }
  await rm(link); await symlink('../fixture/index.js', link);
  await symlink('index.js', join(f.root, 'engines/local-evm/node_modules/fixture/alias.js'));
  await rm(link); await symlink('../fixture/alias.js', link); await assert.rejects(inspectCohortSources({ repoRoot: f.root }), /directly to a regular/);
  await rm(link); await symlink('../fixture/index.js', link);
  await rm(join(f.root, 'engines/local-evm/execute.js')); await symlink('ethereum-call.js', join(f.root, 'engines/local-evm/execute.js'));
  await assert.rejects(inspectCohortSources({ repoRoot: f.root }), /only inside installed/);
});

test('directory links and unsafe extras cannot pull an undeclared source tree into the archive', async t => {
  const f = await fixture(t);
  for (const path of ['../package.json', '/absolute.json', 'research/standard-evm/../secret', 'src/product.js']) await assert.rejects(inspectCohortSources({ repoRoot: f.root, extraFiles: [path] }));
  await symlink('fixture', join(f.root, 'engines/local-evm/node_modules/linked-directory'));
  await assert.rejects(inspectCohortSources({ repoRoot: f.root }), /directly to a regular/);
});

test('new runtime cohort modules present at freeze time are automatically included; source directories cannot contain the output', async t => {
  const f = await fixture(t);
  await write(f.root, 'research/standard-evm/cohort-pilot.mjs', '// Later declared runtime module.');
  const info = await inspectCohortSources({ repoRoot: f.root }); assert(info.files.some(item => item.path.endsWith('/cohort-pilot.mjs')));
  for (const path of ['research/standard-evm/archive', 'engines/local-evm/archive', 'engines/standard-evm/node_modules/archive']) await assert.rejects(freezeCohortSources({ repoRoot: f.root, outputDirectory: join(f.root, path) }), /outside the source trees/);
});

test('Node executable identity is concrete, separately verified, and included in local identity', async t => {
  const actual = await inspectNodeRuntime(); assert.match(actual.executableSha256, /^[a-f0-9]{64}$/); assert(actual.executableBytes > 0);
  assert.equal(actual.node, process.version); assert.equal(actual.platform, process.platform); assert.equal(actual.arch, process.arch);
  assert.deepEqual(await verifyNodeRuntime(actual), actual);
  await assert.rejects(verifyNodeRuntime({ ...actual, executableSha256: '0'.repeat(64) }), /differs/);
  const f = await fixture(t), info = await inspectCohortSources({ repoRoot: f.root });
  const files = info.files.filter(item => item.path.startsWith('engines/local-evm/') || item.path === 'engines/evm-context.js');
  assert.equal(info.localImplementation.sourceSha256, sha(JSON.stringify({ files, runtime: info.runtime })));
});
