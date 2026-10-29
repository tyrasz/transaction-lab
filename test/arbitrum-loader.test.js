import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile), dependency = 'engines/arbitrum-evm/node_modules/example';
async function fixture(t, escaped = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arbitrum-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (file, value) => { const target = path.join(directory, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, value); };
  await put('package.json', '{"type":"module"}');
  await put('src/config.js', "export const VERSION='test';\n");
  await put('src/server.js', "import './arbitrum-loader.js';\n");
  await put('src/arbitrum-loader.js', await readFile(new URL('../src/arbitrum-loader.js', import.meta.url)));
  await put('src/arbitrum-simulation.js', `import {appendFile} from 'node:fs/promises';
    export const validateArbitrumSimulation=x=>x;
    export async function simulateArbitrum(input,options){
      globalThis.engineCalls=(globalThis.engineCalls??0)+1;
      globalThis.engineSignal=options.signal;
      if(globalThis.engineHook)await globalThis.engineHook(options.signal);
      if(input.mutate)await appendFile(new URL('../${dependency}/index.js',import.meta.url),'// changed');
      if(input.cancel)options.controller.abort();
      return {status:'partial',execution:{status:'success'},assetChanges:[{deltaRaw:'-100'}],rawViem:{retained:true},protocol:{intent:'retained'}};
    }
    export function withholdArbitrumSimulation(result,code){return Object.assign(result,{status:'unavailable',error:{code},execution:{status:'unavailable'},assetChanges:[],coverage:{inventoryComplete:false}});}
  `);
  await put('engines/arbitrum-evm/package.json', '{"type":"module"}');
  await put('engines/arbitrum-evm/package-lock.json', '{"lockfileVersion":3}');
  await put('engines/arbitrum-evm/index.js', '// synthetic optional entry\n');
  await put(dependency + '/index.js', '// synthetic dependency\n');
  await put(dependency + '/LICENSE', 'test license');
  await mkdir(path.join(directory, 'engines/arbitrum-evm/node_modules/.bin'), { recursive: true });
  await symlink(escaped ? '../../../../package.json' : '../example/index.js', path.join(directory, 'engines/arbitrum-evm/node_modules/.bin/example'));
  return directory;
}
async function run(directory, statements) {
  const { stderr } = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {appendFile,writeFile,rename} from 'node:fs/promises';
    const {loadArbitrumApi}=await import(${JSON.stringify(pathToFileURL(path.join(directory, 'src/arbitrum-loader.js')).href)});
    ${statements}
  `], { cwd: directory, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(stderr, '');
}

test('Arbitrum loader binds stable startup, complete dependency additions and cached identity', async t => {
  const directory = await fixture(t);
  await run(directory, `const pending=loadArbitrumApi();assert.equal(pending,loadArbitrumApi());const api=await pending;
    assert.equal(await loadArbitrumApi(),api);assert.ok(Object.isFrozen(api.implementation));
    assert.equal(api.implementation.sourceFileCount,11);assert.match(api.implementation.sourceSha256,/^[0-9a-f]{64}$/);
    await api.assertSourcesUnchanged();await writeFile('${dependency}/added.js','// new');
    await assert.rejects(api.simulateArbitrum({}),{code:'ARBITRUM_SOURCE_CHANGED'});`);
});

test('source drift after startup is rejected before engine invocation', async t => {
  const directory = await fixture(t);
  await run(directory, `await appendFile('src/config.js','// drift');
    const attempt=loadArbitrumApi();await assert.rejects(attempt,{code:'ARBITRUM_SOURCE_CHANGED'});assert.equal(attempt,loadArbitrumApi());`);
});

test('post-execution drift and cancellation remove usable values but preserve the raw attempt', async t => {
  for (const mode of ['mutate', 'cancel']) {
    const directory = await fixture(t);
    await run(directory, `const api=await loadArbitrumApi(), controller=new AbortController();
      const report=await api.simulateArbitrum({${mode}:true},{controller,signal:controller.signal});
      assert.equal(report.execution.status,'unavailable');assert.deepEqual(report.assetChanges,[]);
      assert.equal(report.error.code,'${mode === 'mutate' ? 'ARBITRUM_SOURCE_CHANGED' : 'ARBITRUM_CANCELLED'}');
      assert.deepEqual(report.rawViem,{retained:true});assert.deepEqual(report.protocol,{intent:'retained'});`);
  }
});

test('escaped dependency symlink cannot produce an available engine identity', async t => {
  const directory = await fixture(t, true);
  await run(directory, `await assert.rejects(loadArbitrumApi(),{code:'ARBITRUM_SOURCE_CHANGED'});`);
});

test('source hashing shares the request deadline and cancellation before engine dispatch', async t => {
  for (const mode of ['deadline', 'cancel', 'reversed']) {
    const directory = await fixture(t);
    await run(directory, `const api=await loadArbitrumApi(),controller=new AbortController(),originalNow=Date.now;
      const initial=Date.now();let injected=false;
      queueMicrotask(()=>{injected=true;${mode === 'cancel' ? 'controller.abort();' : `Date.now=()=>initial${mode === 'deadline' ? '+120001' : '-1'};`}});
      try{await assert.rejects(api.simulateArbitrum({},{signal:controller.signal}),{code:'${mode === 'cancel' ? 'ARBITRUM_CANCELLED' : 'ARBITRUM_DEADLINE'}'});}
      finally{Date.now=originalNow;}
      assert.equal(injected,true);assert.equal(globalThis.engineCalls??0,0);`);
  }
});

test('shared timer spans source hashing and aborts in-flight engine work without granting a fresh window', async t => {
  for (const phase of ['hash', 'engine']) {
    const directory = await fixture(t);
    await run(directory, `const api=await loadArbitrumApi(),originalSetTimeout=globalThis.setTimeout;
      let fire,timers=0,fired=false;
      globalThis.setTimeout=(callback,ms,...args)=>{
        if(ms!==120000)return originalSetTimeout(callback,ms,...args);
        timers++;fire=()=>{fired=true;callback();};
        const handle=originalSetTimeout(()=>{},120000);
        ${phase === 'hash' ? 'queueMicrotask(fire);' : ''}
        return handle;
      };
      try{
        ${phase === 'hash' ? `await assert.rejects(api.simulateArbitrum({}),{code:'ARBITRUM_DEADLINE'});
          assert.equal(globalThis.engineCalls??0,0);` : `globalThis.engineHook=async signal=>{
            assert.equal(signal.aborted,false);
            const stopped=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
            fire();await stopped;
          };
          const report=await api.simulateArbitrum({});
          assert.equal(globalThis.engineCalls,1);assert.equal(globalThis.engineSignal.aborted,true);
          assert.equal(report.error.code,'ARBITRUM_DEADLINE');assert.equal(report.execution.status,'unavailable');
          assert.deepEqual(report.assetChanges,[]);assert.deepEqual(report.rawViem,{retained:true});`}
      }finally{globalThis.setTimeout=originalSetTimeout;}
      assert.equal(fired,true);assert.equal(timers,1);`);
  }
});

test('caller cancellation is relayed to the shared engine signal and cleaned up after success', async t => {
  const directory = await fixture(t);
  await run(directory, `const api=await loadArbitrumApi(),controller=new AbortController();
    globalThis.engineHook=async signal=>{
      assert.notEqual(signal,controller.signal);
      const cancelled=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      controller.abort();await cancelled;
    };
    const report=await api.simulateArbitrum({},{signal:controller.signal});
    assert.equal(report.error.code,'ARBITRUM_CANCELLED');assert.equal(report.execution.status,'unavailable');assert.deepEqual(report.assetChanges,[]);
    delete globalThis.engineHook;const next=await api.simulateArbitrum({});assert.equal(next.status,'partial');`);
});
