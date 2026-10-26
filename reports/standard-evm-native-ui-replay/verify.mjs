// Offline audit of the completed browser-server playback, not a browser rerun.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const here=path.dirname(fileURLToPath(import.meta.url)),packet=path.resolve(here,'../standard-evm-native');
const sha=value=>createHash('sha256').update(value).digest('hex');
const bytes=file=>fs.readFile(path.join(here,file));
const json=async file=>JSON.parse(await bytes(file));
const binding=await json('binding.json'),log=await json('playback-results.json');
assert.equal(binding.manifestSha256,'75ba63b9da1d90f31346e518908bff8c69aad76bcdf910669d371349758e5d70');
assert.equal(sha(await fs.readFile(path.join(packet,'manifest.json'))),binding.manifestSha256);
assert.equal(sha(await fs.readFile(path.join(packet,'plan.json'))),binding.planSha256);
const plan=JSON.parse(await fs.readFile(path.join(packet,'plan.json')));
assert.deepEqual(binding.sourceFiles,plan.sources);assert.deepEqual(binding.implementation,plan.implementation);
for(const entry of binding.sourceFiles){const source=await fs.readFile(path.join(packet,'source',entry.path));assert.equal(source.length,entry.bytes);assert.equal(sha(source),entry.sha256);}
assert.equal(log.mode,'offline_browser_replay');assert.equal(log.publicNetworkRequests,0);assert.deepEqual(log.failures,[]);
assert.deepEqual(log.completed.map(row=>row.id),['internal-eth-swap','aave-no-native','native-transfer']);
const semantic=value=>{const copy=structuredClone(value);delete copy.id;delete copy.createdAt;delete copy.timing;for(const row of copy.transportEvidence)delete row.transport.durationMs;return copy;};
let count=0,retainedBytes=0;const cases=[];
for(const row of log.completed){
  const planned=plan.cases.find(item=>item.id===row.id);assert.deepEqual(row.input,planned.input);assert.equal(row.requestSha256,planned.requestSha256);
  const originalBytes=await fs.readFile(path.join(packet,row.id+'-response.json')),replayBytes=await bytes(row.id+'-response.json');
  assert.equal(sha(originalBytes),row.sourceResponseSha256);assert.equal(sha(replayBytes),row.replayResponseSha256);
  assert.equal(binding.sourceResponses.find(item=>item.id===row.id).sha256,row.sourceResponseSha256);
  const original=JSON.parse(originalBytes),replay=JSON.parse(replayBytes);assert.deepEqual(semantic(replay),semantic(original));
  assert.equal(row.httpStatus,200);assert.equal(row.semanticResult,'matched');
  assert.deepEqual(row.consumedRpcIds,original.transportEvidence.map((_,index)=>index+1));
  for(const [index,record]of original.transportEvidence.entries()){
    assert.equal(record.id,index+1);assert.equal(record.request.id,index+1);assert.equal(record.requestText,JSON.stringify(record.request));
    assert.equal(sha(record.requestText),record.requestSha256);assert.equal(sha(record.responseText),record.transport.responseSha256);
    assert.equal(record.transport.observedBytes,Buffer.byteLength(record.responseText));assert.equal(JSON.parse(record.responseText).id,index+1);
    count++;retainedBytes+=record.transport.observedBytes;
  }
  cases.push({id:row.id,httpStatus:200,semanticResult:'matched',consumedRpcResponses:row.consumedRpcIds.length,
    native:replay.preview.nativeBalances.map(item=>({account:item.account,status:item.status,beforeRaw:item.beforeRaw,afterRaw:item.afterRaw,deltaRaw:item.deltaRaw})),
    nativeStatus:replay.nativeEffects.status,measuredTokenQueries:replay.preview.queries.filter(item=>item.status==='measured').length});
}
console.log(JSON.stringify({status:'passed',verificationMode:'offline_file_audit_of_browser_replay',publicNetworkRequests:0,
  sourceFilesVerified:binding.sourceFiles.length,recordedRpcResponsesConsumed:count,recordedRpcResponseBytes:retainedBytes,cases,
  limitations:['This audit verifies archived source and replay data, not visual appearance.','Browser observations are separately recorded by the main task.','These are recorded provider responses, not new independent execution evidence.']},null,2));
