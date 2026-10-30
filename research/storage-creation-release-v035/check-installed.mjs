// GET-only localhost release checks. No simulation, public RPC or broadcast.
// Usage: node check-installed.mjs candidate|installed EXPECTATIONS_JSON
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const VERSION='0.35.0',CREATION_STORAGE='clear_existing_target_storage_before_initcode_preserve_balance_rollback_with_creation';
const UI=['app.js','index.html','style.css'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const PATCHES=[{id:'local-evm-runtime-fixes-v2',package:'@ethereumjs/evm',version:'10.1.3',
  patches:['eip7702-exact-designation-length-v1','nonce-code-creation-collision-v1'],files:[
    {path:'dist/esm/evm.js',sha256:'cbe4513aa0b6b82f873582ffbed4338a756ad2587523927f730de34a23b3558f'},
    {path:'dist/esm/opcodes/gas.js',sha256:'b014bb84c89c87a222e990ef10dffd6b91ee1eb19ab58539d2d6bc6763680970'},
    {path:'dist/esm/interpreter.js',sha256:'abd65f8177f73f9726f3f28d97de63a809ac620bfc2cd42d075e0fc2e739a45c'},
  ]}];
const limits={requests:5,requestMs:15000,totalMs:90000,responseBytes:2097152,totalBytes:8388608};
const readBounded=(file,max)=>{const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=max);const b=fs.readFileSync(file);assert(b.length<=max);return b;};
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const errorRecord=e=>({name:e?.name??'Error',code:e?.code??null,message:String(e?.message??e)});

export async function checkInstalled(mode,expectationsPath){
  assert(['candidate','installed'].includes(mode));assert.equal(typeof expectationsPath,'string');
  const reportFile=path.join(HERE,mode+'-http.json'),startFile=path.join(HERE,mode+'-http.STARTED.json');
  assert(!fs.existsSync(reportFile)&&!fs.existsSync(startFile),'Never overwrite or retry an existing release check');
  const expectedPath=path.resolve(expectationsPath),expectedBytes=readBounded(expectedPath,8*1024*1024),expected=JSON.parse(expectedBytes);
  assert.equal(expected.version,VERSION);assert.deepEqual(Object.keys(expected.roots).sort(),['candidate','installed']);
  for(const root of Object.values(expected.roots))assert(typeof root==='string'&&path.isAbsolute(root)&&fs.realpathSync(root)===root);
  assert.notEqual(expected.roots.candidate,expected.roots.installed);
  assert.equal(expected.implementation.version,VERSION);assert.match(expected.implementation.sourceSha256,/^[0-9a-f]{64}$/);
  assert(Array.isArray(expected.implementation.inventory)&&expected.implementation.inventory.length>0);
  assert.deepEqual(expected.implementation.runtimePatches,PATCHES);
  assert.deepEqual(Object.keys(expected.uiBaseline).sort(),[...UI].sort());
  const baseline=new Map();
  for(const name of UI){
    const row=expected.uiBaseline[name];assert.deepEqual(Object.keys(row).sort(),['path','sha256']);assert(path.isAbsolute(row.path));assert.match(row.sha256,/^[0-9a-f]{64}$/);
    const bytes=readBounded(row.path,limits.responseBytes);assert.equal(sha(bytes),row.sha256,'Explicit UI baseline changed');baseline.set(name,bytes);
  }
  const root=expected.roots[mode],port=mode==='candidate'?5175:5174,wall0=Date.now(),mono0=performance.now();let lastWall=0,lastMono=0,totalBytes=0;
  const timing=()=>{const wallMs=Date.now()-wall0,monotonicMs=performance.now()-mono0;assert(wallMs>=lastWall&&monotonicMs>=lastMono,'Clock reversed');lastWall=wallMs;lastMono=monotonicMs;assert(Math.max(wallMs,monotonicMs)<=limits.totalMs,'Release check deadline');return{wallMs,monotonicMs};};
  const report={status:'unavailable',mode,version:VERSION,root,port,startedAt:new Date().toISOString(),expectationsPath:expectedPath,
    expectationsSha256:sha(expectedBytes),limits,publicRpcRequests:0,simulationRequests:0,httpRequests:[],error:null};
  save(startFile,{mode,root,port,startedAt:report.startedAt,expectationsSha256:report.expectationsSha256});
  try{
    assert.equal(JSON.parse(readBounded(path.join(root,'package.json'),65536)).version,VERSION);
    const {loadLocalApi}=await import(pathToFileURL(path.join(root,'src/local-loader.js')).href);
    const local=await loadLocalApi();assert(local,'Local engine unavailable');
    assert.deepEqual(local.implementation,expected.implementation,'Fresh implementation identity differs from predeclared candidate');
    assert.deepEqual(local.implementation.runtimePatches,PATCHES);await local.assertSourcesUnchanged();
    report.implementationBefore=local.implementation;
    for(const name of UI)assert.deepEqual(readBounded(path.join(root,'public',name),limits.responseBytes),baseline.get(name),'Checkout UI differs from explicit baseline');
    const endpoints=['/api/health','/api/config','/app.js','/','/style.css'];
    for(const endpoint of endpoints){
      const elapsed=timing(),timeoutMs=Math.floor(Math.min(limits.requestMs,limits.totalMs-Math.max(elapsed.wallMs,elapsed.monotonicMs)));assert(timeoutMs>=1);
      const row={request:{method:'GET',url:`http://127.0.0.1:${port}${endpoint}`},startedAt:new Date().toISOString(),timeoutMs,status:null,headers:null,body:null,error:null};report.httpRequests.push(row);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),chunks=[];let reader,bytes=0;
      try{
        const response=await fetch(row.request.url,{method:'GET',redirect:'error',signal:controller.signal});
        row.status=response.status;row.headers=Object.fromEntries(response.headers);reader=response.body?.getReader();assert(reader,'Missing HTTP body');
        for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;totalBytes+=part.value.byteLength;assert(bytes<=limits.responseBytes&&totalBytes<=limits.totalBytes,'HTTP body bound');chunks.push(Buffer.from(part.value));}
        const raw=Buffer.concat(chunks);row.bytes=raw.length;row.sha256=sha(raw);row.body=new TextDecoder('utf-8',{fatal:true}).decode(raw);
        assert.equal(row.status,200);timing();
      }catch(error){row.error=errorRecord(error);if(row.body===null){const raw=Buffer.concat(chunks);row.partialBytes=raw.length;row.partialBody=raw.toString('utf8');}throw error;}
      finally{clearTimeout(timer);controller.abort();if(reader)await reader.cancel().catch(()=>{});row.finishedAt=new Date().toISOString();}
    }
    assert.equal(report.httpRequests.length,limits.requests);
    const health=JSON.parse(report.httpRequests[0].body),config=JSON.parse(report.httpRequests[1].body);
    assert.equal(health.status,'ok');assert.equal(health.version,VERSION);assert.equal(health.readOnly,true);
    for(const name of ['localEvm','standardEvm','arbitrumEvm'])assert.equal(config[name].available,true);
    assert.deepEqual(config.localEvm.capabilities,local.LOCAL_CAPABILITIES);
    assert.deepEqual(config.localEvm.examples,local.LOCAL_EXAMPLES);
    assert.deepEqual(config.localEvm.capabilities.chainIds,[1,11155111]);
    assert.equal(config.localEvm.capabilities.creationStorage,CREATION_STORAGE);
    assert.equal(config.localEvm.capabilities.amsterdam.authorizationList,true);
    assert.equal(config.localEvm.capabilities.amsterdam.storageOnlyCreationCollision,false);
    for(const [index,name]of [[2,'app.js'],[3,'index.html'],[4,'style.css']])assert.deepEqual(Buffer.from(report.httpRequests[index].body),baseline.get(name),'Served UI differs from explicit baseline');
    for(const name of UI){assert.deepEqual(readBounded(expected.uiBaseline[name].path,limits.responseBytes),baseline.get(name));assert.deepEqual(readBounded(path.join(root,'public',name),limits.responseBytes),baseline.get(name));}
    assert.deepEqual(readBounded(expectedPath,8*1024*1024),expectedBytes,'Expectation bytes changed during check');
    await local.assertSourcesUnchanged();assert.deepEqual(local.implementation,expected.implementation);report.implementationAfter=local.implementation;
    report.elapsed=timing();report.totalBytes=totalBytes;report.status='verified';report.uiSha256=Object.fromEntries(UI.map(name=>[name,sha(baseline.get(name))]));
    report.installedInventoryMatchesCandidate=true;report.allOptionalEnginesAvailable=true;
  }catch(error){report.error=errorRecord(error);report.totalBytes=totalBytes;report.elapsed={wallMs:Date.now()-wall0,monotonicMs:performance.now()-mono0};}
  report.finishedAt=new Date().toISOString();save(reportFile,report);
  return{status:report.status,mode,reportPath:reportFile,reportSha256:sha(fs.readFileSync(reportFile)),sourceSha256:report.implementationAfter?.sourceSha256??null,error:report.error};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  assert.equal(process.argv.length,4,'Use candidate|installed EXPECTATIONS_JSON');
  const result=await checkInstalled(process.argv[2],process.argv[3]);console.log(JSON.stringify(result,null,2));if(result.status!=='verified')process.exitCode=1;
}
