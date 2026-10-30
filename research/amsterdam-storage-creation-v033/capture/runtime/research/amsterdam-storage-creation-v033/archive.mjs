import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sha, json, save, walk, entry as baseEntry, nodeIdentity, toolchainIdentity, BINARY_SHA, TOOLCHAIN_SHA } from '../delegated-sender-geth-v1/fee-controls/archive.mjs';
export { sha, json, save, walk, nodeIdentity, BINARY_SHA, TOOLCHAIN_SHA };
export function entry(root,p){const f=path.join(root,p),st=fs.lstatSync(f);if(st.isSymbolicLink()&&/^(?:runtime\/)?engines\/(?:local-evm|fixture-evm)\/node_modules$/.test(p))return{path:p,kind:'dependency_link',target:fs.readlinkSync(f)};return baseEntry(root,p);}
export const DEPENDENCY_SOURCE_SHA='f60cfd73f3987ac3f1a7cc826251a44cf2a2f8b36dacbc7ebb0f1e818e0fcc41';
export const DEPENDENCY_CAPTURE='research/amsterdam-creation-geth-v031/capture';
const TREES=['engines/local-evm/node_modules','engines/fixture-evm/node_modules'];
export function dependencyIdentity(root){const capture=path.join(root,DEPENDENCY_CAPTURE),b=fs.readFileSync(path.join(capture,'source-manifest.json'));assert.equal(sha(b),DEPENDENCY_SOURCE_SHA);const manifest=JSON.parse(b),files=manifest.files.filter(f=>TREES.some(t=>f.path.startsWith(t+'/')));assert(files.length>3000);assert.deepEqual(TREES.flatMap(t=>walk(path.join(capture,'runtime'),t)).sort(),files.map(f=>f.path));for(const f of files)assert.deepEqual(baseEntry(path.join(capture,'runtime'),f.path),f);return{captureRelative:'../../amsterdam-creation-geth-v031/capture',sourceSha256:DEPENDENCY_SOURCE_SHA,files};}
export const PREFIX = 'research/amsterdam-storage-creation-v033';
const OWN = ['archive.mjs', 'cases.mjs', 'worker.mjs', 'run.mjs', 'run.test.mjs', 'observations.mjs', 'PLAN.md', 'SOURCES.md', 'source-notes.json'];
const INTERPRETATION = ['COPYING', 'COPYING.LESSER', 'cmd/evm/internal/t8ntool/transition.go', 'cmd/evm/internal/t8ntool/execution.go', 'cmd/evm/internal/t8ntool/tx_iterator.go', 'cmd/evm/internal/t8ntool/gen_execresult.go', 'cmd/evm/internal/t8ntool/file_tracer.go', 'core/state_transition.go', 'core/tracing/hooks.go', 'core/state_processor.go', 'core/gaspool.go', 'core/vm/gascosts.go', 'core/vm/evm.go', 'core/vm/instructions.go', 'core/vm/gas_table.go', 'cmd/evm/internal/t8ntool/gen_stenv.go', 'params/protocol_params.go', 'tests/init.go', 'eth/tracers/logger/logger_json.go', 'eth/tracers/logger/gen_callframe.go', 'eth/tracers/logger/gen_structlog.go'];
export function sourcePaths(root) {
  const paths = ['package.json', 'engines/evm-context.js', 'reports/ethereum-proof-capability/capture.json',
    'research/delegated-sender-geth-v1/fee-controls/archive.mjs', ...OWN.map(p => PREFIX + '/' + p)];
  for (const engine of ['local-evm', 'fixture-evm']) {
    const p = 'engines/' + engine;
    for (const e of fs.readdirSync(path.join(root,p), {withFileTypes:true}))
      if(e.isFile() && (e.name.endsWith('.js') || ['package.json','package-lock.json'].includes(e.name))) paths.push(p+'/'+e.name);
    // Dependency bytes are reused only from the independently pinned sealed archive.
  }
  for (const p of ['proof-fixture.js','lifecycle-fixture.js','authorization-fixture.js','fee-fixture.js',
    'amsterdam-execution-fixture.js','amsterdam-creation-attempts-fixture.js','amsterdam-storage-collision-fixture.js']) paths.push('engines/local-evm/test/'+p);
  if(fs.existsSync(path.join(root,PREFIX,'sources')))paths.push(...walk(root,PREFIX+'/sources'));
  return [...new Set(paths)].sort();
}
const toolPins = geth => ({ 'toolchain-manifest.json': TOOLCHAIN_SHA, 'source-inventory.json': geth.source.inventory.sha256, 'dependency-inventory.json': geth.dependencyInventory.sha256, 'build-manifest.json': geth.buildManifest.sha256 });
export function freezeSources(root, capture) {
  assert(!fs.existsSync(capture), 'A partial or completed freeze cannot be reused');
  const files = sourcePaths(root).map(p => entry(root, p)), dependencyReference=dependencyIdentity(root);
  for(const f of dependencyReference.files)assert.deepEqual(baseEntry(root,f.path),f);
  assert.deepEqual(TREES.flatMap(t=>walk(root,t)).sort(),dependencyReference.files.map(f=>f.path));
  assert(files.length <= 6000 && files.reduce((n, f) => n + (f.bytes ?? 0), 0) <= 48 * 1024 * 1024);
  const node = nodeIdentity(), geth = toolchainIdentity(root), repositoryCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  for (const f of files) {
    const dest = path.join(capture, 'runtime', f.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.kind === 'symlink') fs.symlinkSync(f.target, dest);
    else { fs.writeFileSync(dest, fs.readFileSync(path.join(root, f.path)), { flag: 'wx', mode: f.mode }); fs.chmodSync(dest, f.mode); }
  }
  for(const p of TREES){const dest=path.join(capture,'runtime',p),target=path.relative(path.dirname(dest),path.join(root,DEPENDENCY_CAPTURE,'runtime',p));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.symlinkSync(target,dest);files.push({path:p,kind:'dependency_link',target});}
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert.deepEqual(files.map(f => entry(path.join(capture, 'runtime'), f.path)), files);
  assert.deepEqual(sourcePaths(root), files.filter(f=>f.kind!=='dependency_link').map(f => f.path)); assert.deepEqual(files.filter(f=>f.kind!=='dependency_link').map(f => entry(root, f.path)), files.filter(f=>f.kind!=='dependency_link'));
  assert.deepEqual(dependencyIdentity(root),dependencyReference);
  const inventory = json(path.join(geth.directory, 'source-inventory.json')), pins = toolPins(geth), toolFiles = [];
  for (const p of [...Object.keys(pins), ...[...INTERPRETATION,'core/state/statedb.go','core/state/state_object.go'].map(p => 'source/' + p)]) {
    const b = fs.readFileSync(path.join(geth.directory, p));
    if (pins[p]) assert.equal(sha(b), pins[p]);
    else { const f = inventory.files.find(f => f.path === p.slice(7)); assert(f); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
    const dest = path.join(capture, 'toolchain', p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, b, { flag: 'wx' });
    toolFiles.push({ path: p, bytes: b.length, sha256: sha(b) });
  }
  const manifest = { schemaVersion: 1, sourceRoot: root, repositoryCommit, workingTreeSnapshot: true, files, dependencyReference, node, geth, toolFiles };
  return { manifest, identity: save(path.join(capture, 'source-manifest.json'), manifest) };
}
export function checkSources(capture, pin) {
  const bytes = fs.readFileSync(path.join(capture, 'source-manifest.json')); assert.equal(sha(bytes), pin);
  const m = JSON.parse(bytes), runtime = path.join(capture, 'runtime');
  const repoRoot=path.resolve(capture,'../../..');assert.deepEqual(dependencyIdentity(repoRoot),m.dependencyReference);
  for(const t of TREES){const link=m.files.find(f=>f.path===t);assert.equal(link.kind,'dependency_link');assert.equal(link.target,path.relative(path.dirname(path.join(runtime,t)),path.join(repoRoot,DEPENDENCY_CAPTURE,'runtime',t)));assert.equal(fs.realpathSync(path.join(runtime,t)),fs.realpathSync(path.join(repoRoot,DEPENDENCY_CAPTURE,'runtime',t)));}
  assert.deepEqual(walk(runtime), m.files.map(f => f.path)); assert.deepEqual(m.files.map(f => entry(runtime, f.path)), m.files);
  assert.deepEqual(nodeIdentity(), m.node); assert.equal(sha(fs.readFileSync(m.geth.binary.path)), BINARY_SHA);
  assert.equal(m.geth.manifestSha256, TOOLCHAIN_SHA);
  for (const f of m.toolFiles) { const b = fs.readFileSync(path.join(capture, 'toolchain', f.path)); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
  for (const [p, h] of Object.entries(toolPins(m.geth))) assert.equal(sha(fs.readFileSync(path.join(capture, 'toolchain', p))), h);
  return m;
}
