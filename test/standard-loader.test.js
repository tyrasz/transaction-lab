import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const project = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
// Independent inventory, rather than importing the implementation's own list.
const files = [
  'package.json',
  ...[
    'account-effects', 'affected-balances', 'allowances', 'analyze', 'balances',
    'config', 'current-state', 'historical-state', 'lending-balances', 'lending',
    'permissions', 'query-validation', 'revert', 'rpc', 'server', 'standard-loader',
    'standard-rpc', 'standard-simulation', 'state-diff', 'state', 'validate',
  ].map(name => `src/${name}.js`),
  ...['package.json', 'package-lock.json', 'unsigned-call.js', 'provider-state-diff.js', 'discovery.js'].map(name => `engines/standard-evm/${name}`),
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => `engines/standard-evm/node_modules/@noble/hashes/${name}`),
].sort();

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standard-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(files.map(async file => {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(project, file)));
  }));
  return directory;
}

async function subprocess(directory, statements) {
  const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile, writeFile, appendFile, rename, rm } from 'node:fs/promises';
    const loaderUrl = ${JSON.stringify(pathToFileURL(path.join(directory, 'src/standard-loader.js')).href)};
    ${statements}
  `], { cwd: directory, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(stderr, '');
  return stdout.trim() ? JSON.parse(stdout) : null;
}

test('independent inventory covers static server imports and the optional engine import closure', async () => {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(path.join(project, file), 'utf8');
    const imports = /^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
      else {
        assert.ok(specifier.startsWith('@noble/hashes/'), `Undeclared runtime dependency: ${specifier}`);
        await visit(`engines/standard-evm/node_modules/${specifier}`);
      }
    }
  }
  await visit('src/server.js');
  await visit('src/standard-simulation.js');
  const runtime = files.filter(file => file.endsWith('.js'));
  assert.deepEqual([...visited].sort(), runtime);
  assert.equal(files.length, 31);
});

test('stable startup loads the real adapter once with the complete immutable disk identity', async t => {
  const directory = await fixture(t);
  const result = await subprocess(directory, `
    const { loadStandardApi } = await import(loaderUrl);
    const first = loadStandardApi();
    assert.equal(loadStandardApi(), first, 'Concurrent loads share one promise.');
    const api = await first;
    assert.equal(await loadStandardApi(), api);
    assert.equal(typeof api.simulateStandard, 'function');
    assert.equal(api.STANDARD_EXAMPLES.length, 2);
    assert.ok(Object.isFrozen(api.implementation));
    assert.ok(Object.isFrozen(api.implementation.sourceFiles));
    console.log(JSON.stringify(api.implementation));
  `);
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(await readFile(path.join(directory, file))).update('\0');
  assert.deepEqual(result.sourceFiles, files);
  assert.equal(result.sourceSha256, hash.digest('hex'));
  assert.equal(result.version, JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version);
});

test('optional dependency absent at startup remains unavailable after installation until restart', async t => {
  const directory = await fixture(t);
  await subprocess(directory, `
    await rename('engines/standard-evm/node_modules/@noble/hashes', 'temporarily-uninstalled-hashes');
    const { loadStandardApi } = await import(loaderUrl);
    await rename('temporarily-uninstalled-hashes', 'engines/standard-evm/node_modules/@noble/hashes');
    const first = loadStandardApi();
    assert.equal(await first, null, 'Restoring dependencies after the snapshot must not activate this process.');
    assert.equal(loadStandardApi(), first);
  `);
  await subprocess(directory, `
    const { loadStandardApi } = await import(loaderUrl);
    assert.equal(typeof (await loadStandardApi()).simulateStandard, 'function', 'A fresh process can load the restored dependency.');
  `);
});

for (const changedFile of ['src/analyze.js', 'src/config.js', 'src/standard-rpc.js', 'engines/standard-evm/node_modules/@noble/hashes/utils.js']) {
  test(`rejects post-startup drift in ${changedFile} before optional import and caches rejection`, async t => {
    const directory = await fixture(t);
    await subprocess(directory, `
      const { loadStandardApi } = await import(loaderUrl);
      const file = ${JSON.stringify(changedFile)};
      const original = await readFile(file);
      await appendFile(file, ${JSON.stringify('\n// Synthetic isolated startup-drift control.\n')});
      const first = loadStandardApi();
      await assert.rejects(first, /source changed after startup; restart is required/);
      await writeFile(file, original);
      assert.equal(loadStandardApi(), first);
      await assert.rejects(loadStandardApi(), /source changed after startup/);
    `);
  });
}

test('rejects changes during optional module evaluation after the pre-import check', async t => {
  const directory = await fixture(t);
  // This is a synthetic local module-evaluation side effect, not chain evidence.
  const target = path.join(directory, 'src/standard-simulation.js');
  await writeFile(target, (await readFile(target, 'utf8')) + `
    await (await import('node:fs/promises')).appendFile(new URL('./analyze.js', import.meta.url), '\\n// Synthetic during-import drift.\\n');
  `);
  await subprocess(directory, `
    const { loadStandardApi } = await import(loaderUrl);
    await assert.rejects(loadStandardApi(), /source changed while loading; restart is required/);
  `);
});

test('removing an optional source after startup withholds the adapter', async t => {
  const directory = await fixture(t);
  await subprocess(directory, `
    const { loadStandardApi } = await import(loaderUrl);
    await rm('engines/standard-evm/node_modules/@noble/hashes/sha3.js');
    assert.equal(await loadStandardApi(), null);
  `);
});
