// Supplemental browser QA only. Serves the frozen product and executes its
// actual handler against exact recorded RPC bytes; public network is blocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const packet = path.resolve(here, '../standard-evm-native');
const sha = value => createHash('sha256').update(value).digest('hex');
const read = async file => fs.readFile(path.join(packet, file));
const json = async file => JSON.parse(await read(file));
const planBytes = await read('plan.json'), plan = JSON.parse(planBytes);
const manifestBytes = await read('manifest.json'), manifest = JSON.parse(manifestBytes);
const frozen = await json('FROZEN.json');
assert.equal(sha(planBytes), 'ba57bd952efd6bef3ac50d09a7969241666506b57498f6566a178f13399bb908');
assert.equal(frozen.planSha256, sha(planBytes));
assert.equal(manifest.planSha256, sha(planBytes));
assert.equal(plan.implementation.sourceSha256, '5e915486d876ad4bab26490ec807c599b5a5bb1df683481bebffa2adb71e9c60');
assert.equal(plan.implementation.version, '0.11.0');
for (const source of plan.sources) {
  const bytes = await read('source/' + source.path);
  assert.equal(bytes.length, source.bytes); assert.equal(sha(bytes), source.sha256);
}
const cases = new Map();
for (const item of plan.cases) {
  const file = item.id + '-response.json', bytes = await read(file);
  const entry = manifest.files.find(row => row.path === file);
  assert.ok(entry); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  const saved = JSON.parse(bytes);
  assert.deepEqual(saved.apiRequest, item.input); assert.deepEqual(saved.implementation, plan.implementation);
  for (const [index, record] of saved.transportEvidence.entries()) {
    assert.equal(record.id, index + 1); assert.equal(record.request.id, index + 1);
    assert.equal(record.request.jsonrpc, '2.0'); assert.equal(record.requestText, JSON.stringify(record.request));
    assert.equal(record.requestBytes, Buffer.byteLength(record.requestText)); assert.equal(record.requestSha256, sha(record.requestText));
    assert.equal(record.error, undefined); assert.equal(record.transport.complete, true); assert.equal(record.transport.bodyRetained, true);
    assert.equal(record.transport.observedBytes, Buffer.byteLength(record.responseText));
    for (const key of ['responseSha256','observedPrefixSha256','retainedPrefixSha256']) assert.equal(record.transport[key], sha(record.responseText));
    const response = JSON.parse(record.responseText);
    assert.equal(response.id, index + 1); assert.equal(response.jsonrpc, '2.0'); assert.ok(Object.hasOwn(response, 'result'));
  }
  cases.set(item.id, { ...item, saved, sourceResponseSha256: sha(bytes) });
}
const failures = [], completed = [];
function blocked() { failures.push('OUTBOUND_NETWORK_BLOCKED'); throw new Error('This browser replay does not permit outgoing connections.'); }
globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
const { createAppServer } = await import(pathToFileURL(path.join(packet, 'source/src/server.js')));
const { StandardRpcClient } = await import(pathToFileURL(path.join(packet, 'source/src/standard-rpc.js')));
const binding = { schemaVersion:'1.0', mode:'offline_browser_replay', url:'http://127.0.0.1:5176/',
  planSha256:sha(planBytes), manifestSha256:sha(manifestBytes), implementation:plan.implementation,
  sourceFiles:plan.sources, sourceResponses:[...cases.values()].map(item=>({id:item.id,sha256:item.sourceResponseSha256})),
  limitations:['Supplemental browser rendering check, not another live blockchain simulation.','Only exact recorded requests have responses; unexpected inputs or provider requests fail.','No product or original packet files are changed.'] };
await fs.writeFile(path.join(here,'binding.json'), JSON.stringify(binding,null,2)+'\n');
let active = null;
const server = createAppServer({ persist:false,
  rpcFactory:blocked,
  standardRpcFactory() {
    assert.ok(active && !active.rpc, 'One saved RPC client per matched case.');
    const context = active;
    context.rpc = new StandardRpcClient({url:plan.provider,fetchImpl:async(url,options)=>{
      const record = context.item.saved.transportEvidence[context.cursor++];
      try {
        assert.ok(record, 'Extra RPC call rejected.'); assert.equal(url.href,plan.provider+'/');
        assert.equal(options.method,'POST'); assert.equal(options.redirect,'error');
        assert.deepEqual(options.headers,{'content-type':'application/json'});
        assert.equal(options.body,record.requestText,'Exact recorded RPC wire order required.');
        assert.deepEqual(JSON.parse(options.body),record.request);
        context.consumed.push(record.id);
        return new Response(record.responseText,{status:record.httpStatus});
      } catch(error) { failures.push({caseId:context.item.id,index:context.cursor,error:error.message}); throw error; }
    }});
    return context.rpc;
  }
});
const originalHandler = server.listeners('request')[0];
server.removeAllListeners('request');
const semantic = value => { const copy=structuredClone(value); delete copy.id;delete copy.createdAt;delete copy.timing;for(const record of copy.transportEvidence)delete record.transport.durationMs;return copy; };
async function checkpoint() { await fs.writeFile(path.join(here,'playback-results.json'),JSON.stringify({mode:'offline_browser_replay',publicNetworkRequests:0,completed,failures},null,2)+'\n'); }
server.on('request',async(req,res)=>{
  if(req.method==='GET' && ['/','/index.html','/app.js','/style.css','/api/config','/api/health','/favicon.ico'].includes(req.url)) return originalHandler.call(server,req,res);
  try {
    assert.equal(req.method,'POST'); assert.equal(req.url,'/api/evm/simulate');assert.equal(active,null,'Only one replay at a time.');
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert.ok(bytes<=65536);chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8'), input=JSON.parse(body);
    const item=[...cases.values()].find(row=>JSON.stringify(row.input)===JSON.stringify(input));
    assert.ok(item,'No saved response exists for these exact inputs.');assert.ok(!completed.some(row=>row.id===item.id),'Each QA case is played once.');
    const context={item,cursor:0,consumed:[],startedAt:new Date().toISOString(),rpc:null};active=context;
    const responseChunks=[],write=res.write.bind(res),end=res.end.bind(res);
    res.write=(chunk,...args)=>{if(chunk)responseChunks.push(Buffer.from(chunk));return write(chunk,...args);};
    res.end=(chunk,...args)=>{if(chunk)responseChunks.push(Buffer.from(chunk));return end(chunk,...args);};
    const replayReq=Readable.from([Buffer.from(body)]);Object.assign(replayReq,{method:req.method,url:req.url,headers:req.headers});
    await originalHandler.call(server,replayReq,res);
    const responseBody=Buffer.concat(responseChunks).toString('utf8'), report=JSON.parse(responseBody);
    assert.equal(res.statusCode,200);assert.equal(context.cursor,item.saved.transportEvidence.length);
    assert.deepEqual(context.consumed,item.saved.transportEvidence.map(record=>record.id));
    assert.deepEqual(semantic(report),semantic(item.saved));
    await fs.writeFile(path.join(here,item.id+'-response.json'),responseBody);
    completed.push({id:item.id,startedAt:context.startedAt,completedAt:new Date().toISOString(),input,requestSha256:sha(body),sourceResponseSha256:item.sourceResponseSha256,replayResponseSha256:sha(responseBody),consumedRpcIds:context.consumed,semanticResult:'matched',httpStatus:res.statusCode});
    active=null;await checkpoint();
  } catch(error) {
    failures.push({message:error.message,at:new Date().toISOString()});active=null;await checkpoint();
    if(!res.headersSent){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Offline replay rejected this request. No provider was contacted.'}}));}
  }
});
server.listen(5176,'127.0.0.1',()=>console.log(JSON.stringify({status:'ready',url:binding.url,manifestSha256:binding.manifestSha256,plannedBrowserOrder:['internal-eth-swap','aave-no-native','native-transfer'],publicNetworkRequests:0})));
