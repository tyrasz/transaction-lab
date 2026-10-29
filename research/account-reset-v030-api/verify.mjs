// Read retained bytes only. No RPC, subprocess, VM or target replay.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir=new URL('./capture/',import.meta.url),sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=name=>readFile(new URL(name,dir));const json=async name=>JSON.parse(await bytes(name));
const manifest=await json('evidence-manifest.json'),names=[];
async function walk(prefix=''){for(const e of await readdir(new URL(prefix,dir),{withFileTypes:true})){const name=prefix+e.name;assert(!e.isSymbolicLink());if(e.isDirectory())await walk(name+'/');else{assert(e.isFile());if(name!=='evidence-manifest.json')names.push(name);}}}
await walk();assert.deepEqual(names.sort(),manifest.files.map(r=>r.path).sort());
for(const row of manifest.files){assert(!row.path.includes('..')&&!row.path.startsWith('/'));const b=await bytes(row.path);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
const declaration=await json('declaration.json'),results=await json('results.json');assert.equal(results.sourceUnchanged,true);assert.equal(results.results.length,2);
const summary=[];
for(const [index,id]of ['neutral','retaining'].entries()){
  const [request,fixture,report,wire,handler]=await Promise.all(['request.json','fixture.json','response.json','proof-replies.json','handler.json'].map(name=>json(id+'/'+name)));
  assert.equal(declaration.cases[index].id,id);assert.deepEqual(report.implementation,declaration.implementation);assert.equal(handler.status,200);assert.equal(handler.factories,1);assert.equal(handler.finalHeaders,1);assert.deepEqual(handler.errors,[]);
  assert.deepEqual(report.apiRequest,request);assert.equal(report.status,id==='neutral'?'complete':'partial');assert.equal(report.execution.status,'success');assert.equal(report.source.canonicalStatus,'verified');
  assert.equal(report.attempt.isolation.processSeparated,true);assert.equal(report.attempt.isolation.processClosed,true);assert.equal(report.attempt.broker.pendingAtReturn,0);assert.equal(report.drain.complete,true);
  assert.equal(wire.length,report.transportEvidence.length);
  for(const [i,row]of wire.entries()){
    const q=JSON.parse(row.requestText),answer=JSON.parse(row.responseText),e=report.transportEvidence[i];assert.equal(q.id,i+1);assert.equal(answer.id,q.id);assert(!Object.hasOwn(answer,'error'));
    assert.equal(e.requestText,row.requestText);assert.equal(e.responseText,row.responseText);assert.equal(e.requestSha256,sha(row.requestText));assert.equal(e.requestBytes,Buffer.byteLength(row.requestText));assert.equal(e.transport.responseSha256,sha(row.responseText));assert.equal(e.transport.observedBytes,Buffer.byteLength(row.responseText));assert.equal(e.status,'completed');assert.equal(e.httpStatus,200);assert.equal(e.provider,'fixture.invalid');
    if(q.method==='eth_chainId')assert.equal(answer.result,'0x1');
    else if(['eth_getBlockByHash','eth_getBlockByNumber'].includes(q.method))assert.deepEqual(answer.result,fixture.header);
    else{assert(['eth_getProof','eth_getCode'].includes(q.method));assert.deepEqual(q.params.at(-1),{blockHash:fixture.header.hash,requireCanonical:true});}
  }
  const [query,native]=report.measurements,core=report.attempt.preview,m=core.measurements[0];assert.equal(report.measurements.length,2);assert.equal(core.usage.executions,3);
  assert.equal(m.before.status,'measured');assert.equal(m.before.values[0].raw,'0');assert.equal(m.before.output.trace.calls[0].calls[0].error,'create collision');assert.equal(m.after.output.execution.status,'success');assert.equal(BigInt(m.after.output.execution.returnData),43n);
  if(id==='neutral'){assert.equal(query.status,'measured');assert.deepEqual(query.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['0','43','43']]);assert.equal(m.after.mutationValidation.status,'verified');assert.equal(m.after.output.trace.calls[0].error,'revert');}
  else{assert.equal(query.status,'unavailable');assert.equal(query.values,null);assert.equal(m.after.status,'unavailable');assert.equal(m.after.values,null);assert(m.after.changesAfter.accounts.some(row=>row.reset));}
  assert.equal(native.status,'measured');assert.deepEqual(native.values,[{name:'balance',beforeRaw:'17',afterRaw:'0',deltaRaw:'-17',unit:{kind:'native_wei',scale:'1000000000000000000'}}]);assert.equal(native.query,null);assert.equal(native.returnBytes,0);assert.deepEqual(core.measurements[1].after.changesBefore,core.original.changes);
  summary.push({id,status:report.status,execution:report.execution.status,queryStatus:query.status,queryValues:query.values,nativeValues:native.values,rpcCalls:wire.length});
}
console.log(JSON.stringify({status:'verified',scope:'Artifact-only consistency of synthetic in-process HTTP-handler captures; no independent EVM/client or public-chain claim',manifestSha256:sha(await bytes('evidence-manifest.json')),implementation:declaration.implementation.sourceSha256,results:summary},null,2));
