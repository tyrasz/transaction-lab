import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const runtime = ['ethereum-call.js', 'ethereum-header.js', 'ethereum-preview.js', 'ethereum-profile.js', 'execute.js',
  'isolated-call.js', 'isolated-protocol.js', 'isolated-worker.js', 'preview-mutations.js', 'preview-queries.js',
  'proof-state.js', 'rpc-state-inputs.js', 'verified-state-proof.js'];
const dep = 'engines/local-evm/node_modules/example';
async function fixture(t, { escaped = false, importDrift = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (name, content) => { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), content); };
  await put('package.json', '{"type":"module"}');
  await put('src/config.js', "export const VERSION='test';\n");
  await put('src/validate.js', 'export class InputError extends Error {}\n');
  await put('src/rpc.js', 'export const helper=1;\n');
  await put('src/server.js', "import './rpc.js';\nimport './validate.js';\nimport './local-loader.js';\n");
  await put('src/local-loader.js', await readFile(path.join(project, 'src/local-loader.js')));
  await put('src/local-simulation.js', `import { appendFile } from 'node:fs/promises';
    ${importDrift ? `await appendFile(new URL('../${dep}/index.js',import.meta.url),'// drift');` : ''}
    export const LOCAL_CAPABILITIES={available:true,limits:{apiOutputBytes:10000000}};
    export const validateLocalSimulation=x=>x;
    export async function simulateLocal(input,rpc){
      if(input.mutate)await appendFile(new URL('../${dep}/index.js',import.meta.url),'// mutation');
      if(input.cancel)rpc.controller.abort();
      return {status:'complete',execution:{status:'success'},measurements:[{values:['7']}],attempt:{preview:{values:['7']}}};
    }
    export function withholdLocalSimulation(result,code){return Object.assign(result,{status:'unavailable',error:{code},execution:{status:'unavailable'},measurements:[],attempt:{preview:null}});}
  `);
  await put('engines/local-evm/package.json', '{"type":"module","version":"test"}');
  await put('engines/local-evm/package-lock.json', '{"lockfileVersion":3}');
  for (const name of runtime) await put('engines/local-evm/' + name, '// Synthetic source-inventory fixture.\n');
  for (const [name, content] of Object.entries({ 'package.json': '{"type":"module","version":"1.0.0"}', 'index.js': '// dependency\n', 'index.js.map': '{}', 'LICENSE': 'fixture license', 'test/control.js': '// complete dependency tree includes tests\n' })) await put(dep + '/' + name, content);
  await mkdir(path.join(directory, 'engines/local-evm/node_modules/.bin'), { recursive: true });
  await symlink(escaped ? '../../../../package.json' : '../example/index.js', path.join(directory, 'engines/local-evm/node_modules/.bin/example'));
  return directory;
}
async function run(directory, source) {
  const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile, appendFile, writeFile, rename, rm } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    const loaderUrl=${JSON.stringify(pathToFileURL(path.join(directory, 'src/local-loader.js')).href)};
    ${source}
  `], { cwd: directory, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(stderr, ''); return stdout.trim() ? JSON.parse(stdout) : null;
}

test('local loader binds full static closure, worker entry, entire dependencies, symlink target and Node bytes', async t => {
  const directory = await fixture(t);
  const result = await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const first=loadLocalApi();assert.equal(loadLocalApi(),first);
    const api=await first;assert.equal(await loadLocalApi(),api);await api.assertSourcesUnchanged();
    const identity=api.implementation;assert.ok(Object.isFrozen(identity.inventory));
    assert.equal(identity.sourceSha256,createHash('sha256').update(JSON.stringify({files:identity.inventory,runtime:identity.runtime})).digest('hex'));
    for(const row of identity.inventory)if(row.kind==='file'){const data=await readFile(row.path);assert.equal(data.length,row.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),row.sha256);}
    assert.equal(identity.runtime.executableSha256,createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
    console.log(JSON.stringify(identity));
  `);
  for (const name of ['src/server.js', 'src/rpc.js', 'src/validate.js', 'src/local-loader.js', ...runtime.map(name => 'engines/local-evm/' + name), dep + '/LICENSE', dep + '/test/control.js', dep + '/index.js.map']) assert.ok(result.sourceFiles.includes(name), name);
  assert.deepEqual(result.inventory.find(row => row.kind === 'symlink'), { path: 'engines/local-evm/node_modules/.bin/example', kind: 'symlink', target: '../example/index.js' });
});

test('missing optional worker at startup stays unavailable until a new process', async t => {
  const directory = await fixture(t);
  await run(directory, `
    await rename('engines/local-evm/isolated-worker.js','engines/local-evm/worker.saved');
    const {loadLocalApi}=await import(loaderUrl);
    await rename('engines/local-evm/worker.saved','engines/local-evm/isolated-worker.js');
    assert.equal(await loadLocalApi(),null);assert.equal(await loadLocalApi(),null);
  `);
  await run(directory, `const {loadLocalApi}=await import(loaderUrl);assert.ok(await loadLocalApi());`);
});

test('changed source between startup and lazy import rejects, rather than relabeling cached modules', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);await appendFile('src/rpc.js','// change');
    await assert.rejects(loadLocalApi(),{code:'LOCAL_PREVIEW_SOURCE_CHANGED'});
  `);
});

test('changed source during lazy import is rejected', async t => {
  const directory = await fixture(t, { importDrift: true });
  await run(directory, `const {loadLocalApi}=await import(loaderUrl);await assert.rejects(loadLocalApi(),{code:'LOCAL_PREVIEW_SOURCE_CHANGED'});`);
});

test('every simulation rechecks added dependency files before invoking its adapter', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    await writeFile('${dep}/new.js','// addition');
    await assert.rejects(api.simulateLocal({},{}),{code:'LOCAL_PREVIEW_SOURCE_CHANGED'});
  `);
});

test('source changes during a simulation remove all nested preview amounts afterward', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    const result=await api.simulateLocal({mutate:true},{});
    assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_PREVIEW_SOURCE_CHANGED');
    assert.equal(result.execution.status,'unavailable');assert.deepEqual(result.measurements,[]);assert.equal(result.attempt.preview,null);
  `);
});

test('escaping dependency symlinks are rejected before import', async t => {
  const directory = await fixture(t, { escaped: true });
  await run(directory, `const {loadLocalApi}=await import(loaderUrl);await assert.rejects(loadLocalApi(),{code:'LOCAL_PREVIEW_SOURCE_CHANGED'});`);
});

test('cancellation or exhausted deadline after execution is rechecked after final source verification', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    const controller=new AbortController();
    const cancelled=await api.simulateLocal({cancel:true},{controller,usage:()=>({remainingWallMs:10000})},{signal:controller.signal});
    assert.equal(cancelled.error.code,'LOCAL_PREVIEW_CANCELLED');assert.equal(cancelled.execution.status,'unavailable');assert.equal(cancelled.attempt.preview,null);assert.deepEqual(cancelled.measurements,[]);
    const expired=await api.simulateLocal({},{usage:()=>({remainingWallMs:0})});
    assert.equal(expired.error.code,'LOCAL_PREVIEW_BUDGET');assert.equal(expired.attempt.preview,null);assert.deepEqual(expired.measurements,[]);
    const stable=await api.simulateLocal({},{usage:()=>({remainingWallMs:10000})});
    assert.equal(stable.status,'complete');assert.ok(stable.timing.totalMs>=0);assert.equal(stable.usage.remainingWallMs,10000);
  `);
});

test('real installed closure contains all current local runtime and complete pinned dependency tree without copying it', async () => {
  const result = await run(project, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();assert.ok(api);await api.assertSourcesUnchanged();
    console.log(JSON.stringify({files:api.implementation.sourceFiles,sha:api.implementation.sourceSha256}));
  `);
  assert.ok(result.files.length > 1600);
  for (const name of runtime) assert.ok(result.files.includes('engines/local-evm/' + name), name);
  for (const name of ['@ethereumjs/evm/package.json', '@ethereumjs/common/package.json', '@ethereumjs/statemanager/package.json', '@ethereumjs/util/package.json', '@noble/hashes/LICENSE']) assert.ok(result.files.includes('engines/local-evm/node_modules/' + name), name);
  assert.match(result.sha, /^[a-f0-9]{64}$/);
});
