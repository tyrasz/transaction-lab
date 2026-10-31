import { readFile, readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { VERSION } from './config.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCAL = 'engines/arbitrum-evm', DEPS = `${LOCAL}/node_modules`;
const REQUIRED = ['index.js'];
const MAX_FILES = 20000, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw Object.assign(new Error('Arbitrum preview sources changed or are incomplete; restart is required.'), { code: 'ARBITRUM_SOURCE_CHANGED' }); };
const need = ok => { if (!ok) invalid(); };
const relativePath = path => typeof path === 'string' && path.length <= 1024 && !path.includes('\\') && !path.startsWith('/') && !path.includes('\0') && posix.normalize(path) === path && !path.split('/').some(part => ['', '.', '..'].includes(part));
async function parents(path) {
  need(relativePath(path));
  for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
    const stat = await lstat(join(ROOT, dir)); need(stat.isDirectory() && !stat.isSymbolicLink());
  }
}
async function bytes(path) {
  await parents(path); const stat = await lstat(join(ROOT, path));
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE);
  const result = await readFile(join(ROOT, path)); need(result.length <= MAX_FILE); return { result, mode: stat.mode & 0o777 };
}
async function inventory() {
  const paths = new Set(['package.json', `${LOCAL}/package.json`, `${LOCAL}/package-lock.json`]);
  const visited = new Set();
  async function source(path) {
    need(relativePath(path)); if (visited.has(path)) return; visited.add(path); paths.add(path); need(paths.size <= MAX_FILES);
    const { result } = await bytes(path);
    // All relative static imports in the server/adapter closure are bound.
    // Dynamic engine imports are covered by the complete Arbitrum runtime below.
    const imports = /^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    for (const match of result.toString('utf8').matchAll(imports)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) await source(posix.normalize(posix.join(posix.dirname(path), specifier)));
      else need(path.startsWith(LOCAL + '/') && !specifier.startsWith('/'));
    }
  }
  await source('src/server.js'); await source('src/arbitrum-loader.js'); await source('src/arbitrum-simulation.js');
  for (const name of REQUIRED) await source(`${LOCAL}/${name}`);
  const localStat = await lstat(join(ROOT, LOCAL)); need(localStat.isDirectory() && !localStat.isSymbolicLink());
  for (const entry of await readdir(join(ROOT, LOCAL), { withFileTypes: true })) if (entry.name.endsWith('.js')) {
    need(entry.isFile()); await source(`${LOCAL}/${entry.name}`);
  }
  async function walk(path) {
    await parents(path); const stat = await lstat(join(ROOT, path)); need(stat.isDirectory() && !stat.isSymbolicLink());
    for (const entry of await readdir(join(ROOT, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`; need(relativePath(child));
      if (entry.isDirectory()) await walk(child);
      else { need(entry.isFile() || entry.isSymbolicLink()); paths.add(child); need(paths.size <= MAX_FILES); }
    }
  }
  await walk(DEPS);
  const names = [...paths].sort(); need(new Set(names.map(name => name.toLowerCase())).size === names.length);
  const files = []; let total = 0;
  for (const path of names) {
    await parents(path); const stat = await lstat(join(ROOT, path));
    if (stat.isSymbolicLink()) {
      need(path.startsWith(DEPS + '/'));
      const target = await readlink(join(ROOT, path));
      need(typeof target === 'string' && !target.startsWith('/') && !target.includes('\\') && !target.includes('\0'));
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      need(resolved.startsWith(DEPS + '/') && paths.has(resolved));
      await parents(resolved); const destination = await lstat(join(ROOT, resolved));
      need(destination.isFile() && !destination.isSymbolicLink());
      files.push({ path, kind: 'symlink', target });
    } else {
      const read = await bytes(path); total += read.result.length; need(total <= MAX_TOTAL);
      files.push({ path, kind: 'file', bytes: read.result.length, mode: read.mode, sha256: sha(read.result) });
    }
  }
  return files;
}
async function runtimeIdentity() {
  const executable = await realpath(process.execPath), before = await lstat(executable);
  need(before.isFile() && before.size <= 512 * 1024 * 1024);
  const hash = createHash('sha256'); let count = 0;
  for await (const chunk of createReadStream(executable)) { count += chunk.length; need(count <= 512 * 1024 * 1024); hash.update(chunk); }
  const after = await lstat(executable);
  need(before.size === count && after.size === before.size && after.ino === before.ino && after.mtimeMs === before.mtimeMs);
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    executableBytes: count, executableSha256: hash.digest('hex') };
}
async function snapshot() { return { files: await inventory(), runtime: await runtimeIdentity() }; }
function frozen(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }
// Top-level snapshot completes before the server accepts requests. Optional
// dependency absence is sticky for this process, even if installed afterward.
const startup = await snapshot().then(value => ({ value }), error => ({ error }));
let loading;
export function loadArbitrumApi() {
  return loading ??= (async () => {
    if (startup.error) {
      if (['ENOENT', 'ERR_MODULE_NOT_FOUND'].includes(startup.error.code)) return null;
      throw startup.error;
    }
    async function assertSourcesUnchanged() {
      let actual;
      try { actual = await snapshot(); } catch { invalid(); }
      need(isDeepStrictEqual(actual, startup.value));
    }
    await assertSourcesUnchanged();
    let api;
    try { api = await import('./arbitrum-simulation.js'); }
    catch (error) { if (['ENOENT', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) return null; throw error; }
    await assertSourcesUnchanged();
    const implementation = frozen({ name: 'Transaction Lab Arbitrum provider preview', version: VERSION,
      sourceSha256: sha(JSON.stringify(startup.value)), sourceFileCount: startup.value.files.length,
      runtime: startup.value.runtime,
      identityAlgorithm: 'SHA256(JSON.stringify({files:sorted_complete_inventory,runtime:node_executable_identity}))' });
    return Object.freeze({ ...api, implementation, assertSourcesUnchanged,
      async simulateArbitrum(input, options = {}) {
        const began = performance.now(), wallBegan = Date.now(), controller = new AbortController();
        const callerSignal = options.signal;
        let expired = false, lastMono = began, lastWall = wallBegan;
        const elapsed = () => {
          const mono = performance.now(), wall = Date.now();
          if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < lastMono || wall < lastWall) expired = true;
          lastMono = mono; lastWall = wall;
          const value = Math.max(mono - began, wall - wallBegan);
          if (!Number.isFinite(value) || value >= 120000) expired = true;
          return Number.isFinite(value) ? Math.max(0, value) : 0;
        };
        const relayCancel = () => controller.abort();
        const timer = setTimeout(() => { expired = true; controller.abort(); }, 120000);
        callerSignal?.addEventListener('abort', relayCancel, { once: true });
        function beforeDispatch() {
          elapsed();
          const code = callerSignal?.aborted ? 'ARBITRUM_CANCELLED' : expired ? 'ARBITRUM_DEADLINE' : null;
          if (code) {
            controller.abort();
            throw Object.assign(new Error(code === 'ARBITRUM_CANCELLED' ? 'Arbitrum preview cancelled before dispatch.' : 'Arbitrum preview deadline elapsed before dispatch.'), { code });
          }
        }
        try {
          api.validateArbitrumSimulation(input);
          beforeDispatch();
          await assertSourcesUnchanged();
          // The source scan is part of the same request budget. A timer or
          // clock jump during hashing must not start a fresh provider window.
          beforeDispatch();
          const result = await api.simulateArbitrum(input, { ...options, signal: controller.signal });
          try { await assertSourcesUnchanged(); }
          catch { api.withholdArbitrumSimulation(result, 'ARBITRUM_SOURCE_CHANGED'); }
          elapsed();
          if (callerSignal?.aborted) api.withholdArbitrumSimulation(result, 'ARBITRUM_CANCELLED');
          else if (expired) api.withholdArbitrumSimulation(result, 'ARBITRUM_DEADLINE');
          result.implementation = implementation;
          if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) {
            api.withholdArbitrumSimulation(result, 'ARBITRUM_OUTPUT_LIMIT');
            result.rawViem = null; result.transportEvidence = [];
            result.coverage.evidenceOmitted = 'Response exceeded the 32 MiB API output limit.';
          }
          result.timing = { totalMs: elapsed() };
          if (callerSignal?.aborted) api.withholdArbitrumSimulation(result, 'ARBITRUM_CANCELLED');
          else if (expired) api.withholdArbitrumSimulation(result, 'ARBITRUM_DEADLINE');
          return result;
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', relayCancel);
          controller.abort();
        }
      },
    });
  })();
}
