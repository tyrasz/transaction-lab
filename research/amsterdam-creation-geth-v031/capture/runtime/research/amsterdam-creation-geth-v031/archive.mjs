import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sha, json, save, walk, entry, nodeIdentity, toolchainIdentity, BINARY_SHA, TOOLCHAIN_SHA } from '../delegated-sender-geth-v1/fee-controls/archive.mjs';
export { sha, json, save, walk, entry, nodeIdentity, BINARY_SHA, TOOLCHAIN_SHA };
export const PREFIX = 'research/amsterdam-creation-geth-v031';
const OWN = ['archive.mjs', 'cases.mjs', 'worker.mjs', 'run.mjs', 'run.test.mjs', 'PLAN.md'];
const INTERPRETATION = ['COPYING', 'COPYING.LESSER', 'cmd/evm/internal/t8ntool/transition.go', 'cmd/evm/internal/t8ntool/execution.go', 'cmd/evm/internal/t8ntool/tx_iterator.go', 'cmd/evm/internal/t8ntool/gen_execresult.go', 'cmd/evm/internal/t8ntool/file_tracer.go', 'core/state_transition.go', 'core/state_processor.go', 'core/gaspool.go', 'core/vm/gascosts.go', 'core/vm/evm.go', 'core/vm/instructions.go', 'core/vm/gas_table.go', 'cmd/evm/internal/t8ntool/gen_stenv.go', 'params/protocol_params.go', 'tests/init.go', 'eth/tracers/logger/logger_json.go', 'eth/tracers/logger/gen_callframe.go', 'eth/tracers/logger/gen_structlog.go'];
export function sourcePaths(root) {
  const paths = ['package.json', 'engines/evm-context.js', 'reports/ethereum-proof-capability/capture.json',
    'research/delegated-sender-geth-v1/fee-controls/archive.mjs', ...OWN.map(p => PREFIX + '/' + p)];
  for (const engine of ['local-evm', 'fixture-evm']) {
    const p = 'engines/' + engine;
    for (const e of fs.readdirSync(path.join(root,p), {withFileTypes:true}))
      if(e.isFile() && (e.name.endsWith('.js') || ['package.json','package-lock.json'].includes(e.name))) paths.push(p+'/'+e.name);
    paths.push(...walk(root, p + '/node_modules'));
  }
  for (const p of ['proof-fixture.js','lifecycle-fixture.js','authorization-fixture.js','fee-fixture.js',
    'amsterdam-execution-fixture.js','amsterdam-creation-attempts-fixture.js']) paths.push('engines/local-evm/test/'+p);
  return [...new Set(paths)].sort();
}
const toolPins = geth => ({ 'toolchain-manifest.json': TOOLCHAIN_SHA, 'source-inventory.json': geth.source.inventory.sha256, 'dependency-inventory.json': geth.dependencyInventory.sha256, 'build-manifest.json': geth.buildManifest.sha256 });
export function freezeSources(root, capture) {
  assert(!fs.existsSync(capture), 'A partial or completed freeze cannot be reused');
  const files = sourcePaths(root).map(p => entry(root, p));
  assert(files.length <= 6000 && files.reduce((n, f) => n + (f.bytes ?? 0), 0) <= 48 * 1024 * 1024);
  const node = nodeIdentity(), geth = toolchainIdentity(root), repositoryCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  for (const f of files) {
    const dest = path.join(capture, 'runtime', f.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.kind === 'symlink') fs.symlinkSync(f.target, dest);
    else { fs.writeFileSync(dest, fs.readFileSync(path.join(root, f.path)), { flag: 'wx', mode: f.mode }); fs.chmodSync(dest, f.mode); }
  }
  assert.deepEqual(files.map(f => entry(path.join(capture, 'runtime'), f.path)), files);
  assert.deepEqual(sourcePaths(root), files.map(f => f.path)); assert.deepEqual(files.map(f => entry(root, f.path)), files);
  const inventory = json(path.join(geth.directory, 'source-inventory.json')), pins = toolPins(geth), toolFiles = [];
  for (const p of [...Object.keys(pins), ...INTERPRETATION.map(p => 'source/' + p)]) {
    const b = fs.readFileSync(path.join(geth.directory, p));
    if (pins[p]) assert.equal(sha(b), pins[p]);
    else { const f = inventory.files.find(f => f.path === p.slice(7)); assert(f); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
    const dest = path.join(capture, 'toolchain', p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, b, { flag: 'wx' });
    toolFiles.push({ path: p, bytes: b.length, sha256: sha(b) });
  }
  const manifest = { schemaVersion: 1, sourceRoot: root, repositoryCommit, workingTreeSnapshot: true, files, node, geth, toolFiles };
  return { manifest, identity: save(path.join(capture, 'source-manifest.json'), manifest) };
}
export function checkSources(capture, pin) {
  const bytes = fs.readFileSync(path.join(capture, 'source-manifest.json')); assert.equal(sha(bytes), pin);
  const m = JSON.parse(bytes), runtime = path.join(capture, 'runtime');
  assert.deepEqual(walk(runtime), m.files.map(f => f.path)); assert.deepEqual(m.files.map(f => entry(runtime, f.path)), m.files);
  assert.deepEqual(nodeIdentity(), m.node); assert.equal(sha(fs.readFileSync(m.geth.binary.path)), BINARY_SHA);
  assert.equal(m.geth.manifestSha256, TOOLCHAIN_SHA);
  for (const f of m.toolFiles) { const b = fs.readFileSync(path.join(capture, 'toolchain', f.path)); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
  for (const [p, h] of Object.entries(toolPins(m.geth))) assert.equal(sha(fs.readFileSync(path.join(capture, 'toolchain', p))), h);
  return m;
}
