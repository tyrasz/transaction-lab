import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { LOCAL_RUNTIME_PATCH } from '../engines/local-evm/delegation-runtime-patch.js';

const execute = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const runtime = ['ethereum-call.js', 'ethereum-header.js', 'ethereum-preview.js', 'ethereum-sequence.js', 'ethereum-profile.js', 'execute.js',
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
  await put('src/local-sequence.js', `import { simulateLocal } from './local-simulation.js';
    export const LOCAL_SEQUENCE_CAPABILITIES={available:true,limits:{apiOutputBytes:10000000}};
    export const validateLocalSequence=x=>x;
    export async function simulateLocalSequence(input,rpc){
      await simulateLocal(input,rpc);
      return {status:'complete',steps:[{measurements:[{values:['9']}]}],attempt:{sequence:{steps:[{values:['9']}]}}};
    }
    export function withholdLocalSequence(result,code){return Object.assign(result,{status:'unavailable',error:{code},steps:[],attempt:{sequence:null}});}
  `);
  await put('engines/local-evm/package.json', '{"type":"module","version":"test"}');
  await put('engines/local-evm/package-lock.json', '{"lockfileVersion":3}');
  for (const name of runtime) await put('engines/local-evm/' + name, '// Synthetic source-inventory fixture.\n');
  // Keep the real byte guard and exact patched ESM inputs. The synthetic
  // adapter does not execute these dependency modules or bypass their guard.
  for (const name of ['engines/local-evm/delegation-runtime-patch.js',
    'engines/local-evm/node_modules/@ethereumjs/evm/package.json',
    ...LOCAL_RUNTIME_PATCH.files.map(file => 'engines/local-evm/node_modules/@ethereumjs/evm/' + file.path)]) {
    await put(name, await readFile(path.join(project, name)));
  }
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
  for (const name of ['src/server.js', 'src/rpc.js', 'src/validate.js', 'src/local-loader.js', 'src/local-sequence.js', 'engines/local-evm/delegation-runtime-patch.js', ...runtime.map(name => 'engines/local-evm/' + name), dep + '/LICENSE', dep + '/test/control.js', dep + '/index.js.map']) assert.ok(result.sourceFiles.includes(name), name);
  assert.deepEqual(result.inventory.find(row => row.kind === 'symlink'), { path: 'engines/local-evm/node_modules/.bin/example', kind: 'symlink', target: '../example/index.js' });
  assert.deepEqual(result.runtimePatches, [{ id: 'local-evm-runtime-fixes-v2',
    package: LOCAL_RUNTIME_PATCH.package, version: LOCAL_RUNTIME_PATCH.version, patches: LOCAL_RUNTIME_PATCH.patches,
    files: LOCAL_RUNTIME_PATCH.files.map(file => ({ path: file.path, sha256: file.patchedSha256 })) }]);
  for (const file of LOCAL_RUNTIME_PATCH.files) {
    assert.equal(result.inventory.find(row => row.path === 'engines/local-evm/node_modules/@ethereumjs/evm/' + file.path).sha256, file.patchedSha256);
  }
});

test('stock EVM bytes before loader startup refuse availability; explicitly patched copies pass with bound metadata', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const patchUrl=new URL('../engines/local-evm/delegation-runtime-patch.js',loaderUrl);
    const {LOCAL_RUNTIME_PATCH:patch}=await import(patchUrl);
    for(const spec of patch.files){
      const file='engines/local-evm/node_modules/@ethereumjs/evm/'+spec.path;
      let text=await readFile(file,'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),spec.patchedSha256);
      for(const {before,after} of spec.replacements){assert.equal(text.split(after).length,2);text=text.replace(after,before);}
      assert.equal(createHash('sha256').update(text).digest('hex'),spec.originalSha256);await writeFile(file,text);
    }
    const {loadLocalApi}=await import(loaderUrl);
    await assert.rejects(loadLocalApi(),{code:'LOCAL_EVM_RUNTIME_UNVERIFIED'});
    await assert.rejects(loadLocalApi(),{code:'LOCAL_EVM_RUNTIME_UNVERIFIED'});
    for(const spec of patch.files)assert.equal(createHash('sha256').update(await readFile('engines/local-evm/node_modules/@ethereumjs/evm/'+spec.path)).digest('hex'),spec.originalSha256);
  `);
  const result = await run(directory, `
    const patchUrl=new URL('../engines/local-evm/delegation-runtime-patch.js',loaderUrl);
    const {LOCAL_RUNTIME_PATCH:patch,applyLocalRuntimePatch}=await import(patchUrl);
    assert.equal(applyLocalRuntimePatch().changed.length,3);
    const {loadLocalApi}=await import(loaderUrl),api=await loadLocalApi();assert.ok(api);await api.assertSourcesUnchanged();
    for(const spec of patch.files)assert.equal(api.implementation.inventory.find(row=>row.path==='engines/local-evm/node_modules/@ethereumjs/evm/'+spec.path).sha256,spec.patchedSha256);
    assert(Object.isFrozen(api.implementation.runtimePatches));assert(Object.isFrozen(api.implementation.runtimePatches[0].files));
    console.log(JSON.stringify(api.implementation.runtimePatches));
  `);
  assert.deepEqual(result, [{ id: 'local-evm-runtime-fixes-v2',
    package: LOCAL_RUNTIME_PATCH.package, version: LOCAL_RUNTIME_PATCH.version, patches: LOCAL_RUNTIME_PATCH.patches,
    files: LOCAL_RUNTIME_PATCH.files.map(file => ({ path: file.path, sha256: file.patchedSha256 })) }]);
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
    assert.equal(stable.timing.totalMsScope,'Adapter execution and source verification; excludes response serialization, persistence and delivery.');
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


test('sequence wrapper removes nested amounts after source drift during execution', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    const result=await api.simulateLocalSequence({mutate:true},{});
    assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_PREVIEW_SOURCE_CHANGED');
    assert.deepEqual(result.steps,[]);assert.equal(result.attempt.sequence,null);
    await assert.rejects(api.simulateLocalSequence({},{}),{code:'LOCAL_PREVIEW_SOURCE_CHANGED'});
  `);
});

test('sequence wrapper checks cancellation and total deadline after final source hashing', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    const controller=new AbortController();
    const cancelled=await api.simulateLocalSequence({cancel:true},{controller,usage:()=>({remainingWallMs:10000})},{signal:controller.signal});
    assert.equal(cancelled.error.code,'LOCAL_PREVIEW_CANCELLED');assert.equal(cancelled.attempt.sequence,null);assert.deepEqual(cancelled.steps,[]);
    const expired=await api.simulateLocalSequence({},{usage:()=>({remainingWallMs:0})});
    assert.equal(expired.error.code,'LOCAL_PREVIEW_BUDGET');assert.equal(expired.attempt.sequence,null);assert.deepEqual(expired.steps,[]);
    const stable=await api.simulateLocalSequence({},{usage:()=>({remainingWallMs:10000})});
    assert.equal(stable.status,'complete');assert.ok(stable.timing.totalMs>=0);assert.equal(stable.usage.remainingWallMs,10000);
    assert.equal(stable.timing.totalMsScope,'Adapter execution and source verification; excludes response serialization, persistence and delivery.');
    assert.deepEqual(stable.steps[0].measurements[0].values,['9']);assert.deepEqual(stable.implementation,api.implementation);
  `);
});

for (const method of ['simulateLocal', 'simulateLocalSequence']) {
  for (const boundary of ['deadline', 'cancellation']) {
    test(`${method} withholds every nested amount when ${boundary} crosses during retained response serialization`, async t => {
      const directory = await fixture(t);
      await run(directory, `
        const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
        const controller=new AbortController(),events=[];let remainingWallMs=10000,serializations=0;
        const stringify=JSON.stringify;
        JSON.stringify=function(value,...args){
          const serialized=stringify.call(this,value,...args);
          // Installed only after loading and identity hashing. Change the fake
          // budget/signal only after the complete retained response, including
          // its identity and nested amounts, has actually been serialized.
          if(value?.implementation===api.implementation){
            serializations++;events.push('serialized');
            const retained=JSON.parse(serialized);assert.equal(retained.status,'complete');
            assert.deepEqual(retained.implementation,api.implementation);
            assert.ok(serialized.includes('"values"'));assert.equal(remainingWallMs,10000);assert.equal(controller.signal.aborted,false);
            ${boundary === 'deadline' ? 'remainingWallMs=0;' : 'controller.abort();'}
          }
          return serialized;
        };
        let result;
        try{
          result=await api.${method}({},{usage:()=>{events.push('usage:'+remainingWallMs);return{remainingWallMs};}},{signal:controller.signal});
        }finally{JSON.stringify=stringify;}
        assert.equal(serializations,1);
        assert.deepEqual(events,['usage:10000','serialized','usage:${boundary === 'deadline' ? '0' : '10000'}']);
        assert.equal(result.status,'unavailable');assert.equal(result.error.code,'${boundary === 'deadline' ? 'LOCAL_PREVIEW_BUDGET' : 'LOCAL_PREVIEW_CANCELLED'}');
        assert.equal(result.implementation,api.implementation);assert.equal(stringify(result).includes('"values"'),false);
        ${method === 'simulateLocal' ? "assert.equal(result.execution.status,'unavailable');assert.deepEqual(result.measurements,[]);assert.equal(result.attempt.preview,null);" : "assert.deepEqual(result.steps,[]);assert.equal(result.attempt.sequence,null);"}
      `);
    });
  }
}

test('final request recheck preserves the complete retained output cap for both wrappers', async t => {
  const directory = await fixture(t);
  await run(directory, `
    const {loadLocalApi}=await import(loaderUrl);const api=await loadLocalApi();
    for(const [method,capability] of [['simulateLocal','LOCAL_CAPABILITIES'],['simulateLocalSequence','LOCAL_SEQUENCE_CAPABILITIES']]){
      api[capability].limits.apiOutputBytes=1;
      const result=await api[method]({},{usage:()=>({remainingWallMs:10000})});
      assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_PREVIEW_OUTPUT');
      assert.equal(result.attempt,null);assert.equal(JSON.stringify(result).includes('"values"'),false);
    }
  `);
});
