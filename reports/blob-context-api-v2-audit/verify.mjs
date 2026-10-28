// Offline API-v2 evidence audit. No network or VM execution. The source copy
// preserves the exact current bytes matched at audit time to the API fingerprint.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const HERE=dirname(fileURLToPath(import.meta.url)),ROOT=resolve(HERE,'../..'),PACKET=join(ROOT,'reports/blob-context-api-v2');
const IMPLEMENTATION='b035863ce536cf70ac92cdf72eb381bc9cfe0f4a2ef59d135e9678f640b177ba';
const PINS={'capture.mjs':'2d541edca1db86be46a5fc4a858f9d60e9851f3aeb954db5b3b07f8669c9d4f4','declaration.json':'bf4704e29f2cbf2f31f056d6bdab60847d872c06be0d024d2c8209a1ef1a9f83','metadata.json':'289069c215c7c5480a37661aa6b8241bb1992c04e61947d2ad6846aa37ad00e3','request.json':'e01dde12cc2ee2724546f1d4f2113efc384a46466797f17cd178479c0e0e03fd','response.json':'94b7639c151081a68823759f1edefeebe00fdca85d7561bef8c611123a39d365'};
const sha=x=>createHash('sha256').update(x).digest('hex'),json=p=>JSON.parse(readFileSync(p));
const bytes=(base,path)=>{assert(!path.startsWith('/')&&!path.split('/').some(x=>['..','.',''].includes(x)));const file=join(base,path);assert(lstatSync(file).isFile());return readFileSync(file);};
export async function audit(){
  for(const[path,hash]of Object.entries(PINS))assert.equal(sha(bytes(PACKET,path)),hash);
  const request=json(join(PACKET,'request.json')),report=json(join(PACKET,'response.json')),meta=json(join(PACKET,'metadata.json')),declaration=json(join(PACKET,'declaration.json'));
  assert.equal(meta.status,200);assert.equal(meta.responseSha256,PINS['response.json']);assert.equal(meta.responseBytes,bytes(PACKET,'response.json').length);assert.equal(declaration.requestSha256,PINS['request.json']);assert.equal(declaration.sourceSha256,PINS['capture.mjs']);assert.equal(declaration.attempts,1);assert.equal(declaration.submissions,0);
  const original=bytes(ROOT,'reports/ordinary-ethereum-unresolved-v4/cases/007/request.json');assert.equal(sha(original),declaration.inputArtifactSha256);assert.deepEqual(request,JSON.parse(original).apiRequest);assert.deepEqual(report.apiRequest,request);
  const snapshot=json(join(HERE,'source-snapshot.json')),fingerprint=createHash('sha256');assert.deepEqual(snapshot.implementation,report.implementation);assert.deepEqual(meta.implementation,report.implementation);assert.equal(report.implementation.sourceSha256,IMPLEMENTATION);assert.equal(declaration.expectedImplementationSha256,IMPLEMENTATION);
  assert.deepEqual(snapshot.files.map(x=>x.path),report.implementation.sourceFiles);
  for(const row of snapshot.files){const data=bytes(join(HERE,'source'),row.path);assert.equal(data.length,row.bytes);assert.equal(sha(data),row.sha256);fingerprint.update(row.path+'\0').update(data).update('\0');}assert.equal(fingerprint.digest('hex'),IMPLEMENTATION);
  // Header hashing uses the already frozen local verifier and its full archived
  // dependency inventory, never a current module import or provider label.
  const prior=join(ROOT,'reports/ordinary-ethereum-unresolved-v4'),sourceBytes=bytes(prior,'source-manifest.json');assert.equal(sha(sourceBytes),'39789b5a98d4ba89356f4d1c35566863d30d51fa665b1f430e3c19f572b93696');
  const source=JSON.parse(sourceBytes);for(const row of source.files){const target=join(prior,'runtime',row.path);if(row.kind==='symlink'){assert(lstatSync(target).isSymbolicLink());assert.equal(readlinkSync(target),row.target);}else{const data=bytes(join(prior,'runtime'),row.path);assert.equal(data.length,row.bytes);assert.equal(sha(data),row.sha256);}}
  const {verifyEthereumHeader}=await import(pathToFileURL(join(prior,'runtime/engines/local-evm/ethereum-header.js')));
  assert.equal(report.transportEvidence.length,12);assert.equal(report.evidence.length,12);let wireBytes=0;
  for(let i=0;i<12;i++){
    const wire=report.transportEvidence[i],engine=report.evidence[i];assert.equal(wire.id,i+1);assert.equal(engine.id,i+1);assert.equal(wire.httpStatus,200);assert.equal(wire.provider,'eth.drpc.org');
    assert.equal(wire.requestText,JSON.stringify(wire.request));assert.equal(sha(wire.requestText),wire.requestSha256);assert.equal(Buffer.byteLength(wire.requestText),wire.requestBytes);
    assert.equal(wire.transport.complete,true);assert.equal(sha(wire.responseText),wire.transport.responseSha256);assert.equal(Buffer.byteLength(wire.responseText),wire.transport.observedBytes);wireBytes+=wire.transport.observedBytes;
    const body=JSON.parse(wire.responseText);assert.equal(body.jsonrpc,'2.0');assert.equal(body.id,wire.id);assert(Object.hasOwn(body,'result')&&!Object.hasOwn(body,'error'));assert.deepEqual(engine.result,body.result);assert.deepEqual({method:engine.method,params:engine.params},{method:wire.request.method,params:wire.request.params});
  }
  const e=report.evidence,header=e[1].result,pinned={blockHash:request.block,requireCanonical:true};assert.equal(e[0].result,'0x1');assert.deepEqual(e[1].params,[request.block,false]);assert.deepEqual(e[11].params,[header.number,false]);assert.deepEqual(e[11].result,header);verifyEthereumHeader({header,expectedHash:request.block});
  for(const row of e.slice(2,7))assert.deepEqual(row.params.at(-1),pinned);
  const expectedCall={from:request.from,to:request.to,data:request.data,gas:'0x4c4b40',value:'0x'+BigInt(request.value).toString(16),blobVersionedHashes:request.blobVersionedHashes,maxFeePerBlobGas:'0x0'};
  const blockOverrides={baseFeePerGas:'0x0',blobBaseFee:'0x0'};
  for(const [index,tracer,config]of[[7,'callTracer',{withLog:true}],[8,'prestateTracer',{diffMode:true}]]){assert.deepEqual(e[index].params,[expectedCall,pinned,{tracer,timeout:'15s',tracerConfig:config,blockOverrides}]);}
  assert.deepEqual(e[7].result,report.execution.trace);assert.equal(e[7].result.gasUsed,'0x5208');assert.equal(report.execution.status,'success');assert(!e[7].result.error);assert.equal(report.execution.returnData,'0x');
  const sender=request.from,nonce=BigInt(e[2].result),balance=BigInt(e[3].result),diff=e[8].result;assert.deepEqual(Object.keys(diff).sort(),['post','pre']);assert.deepEqual(Object.keys(diff.pre),[sender]);assert.deepEqual(Object.keys(diff.post),[sender]);assert.deepEqual(diff.pre[sender],{balance:'0x'+balance.toString(16),nonce:Number(nonce)});assert.deepEqual(diff.post[sender],{nonce:Number(nonce+1n)});
  assert.deepEqual(report.stateDiff,{pre:{[sender]:{balance:balance.toString(),nonce:nonce.toString()}},post:{[sender]:{nonce:(nonce+1n).toString()}}});
  const probe='0x000000000000000000000000000000000000ba1a',postOverride={[sender]:{nonce:'0x'+(nonce+1n).toString(16)}};
  const code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(BigInt(header.number)-1n).toString(16).padStart(64,'0')+'4060e05260004961010052600149610120524a610140526101606000f3';
  const witnessWords=[header.number,header.timestamp,header.gasLimit,0,header.mixHash,header.miner,1,header.parentHash,request.blobVersionedHashes[0],0,0].map(BigInt);
  assert.equal(request.blobVersionedHashes.length,1);
  for(const [index,state]of[[9,'before'],[10,'after']]){
    const row=e[index],call={from:sender,to:probe,data:'0x',value:'0x0',gas:'0x493e0',blobVersionedHashes:request.blobVersionedHashes,maxFeePerBlobGas:'0x0'};
    assert.deepEqual(row.params,[call,pinned,{tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true},blockOverrides,stateOverrides:{...(state==='after'?postOverride:{}),[probe]:{code}}}]);
    assert(!row.result.error&&!row.result.revertReason);assert.equal(row.result.output.length,2+64*11);assert.deepEqual(Array.from({length:11},(_,i)=>BigInt('0x'+row.result.output.slice(2+i*64,66+i*64))),witnessWords);
    assert.equal(row.result.from,call.from);assert.equal(row.result.to,probe);assert.equal(row.result.input,'0x');assert.equal(row.result.value,'0x0');assert.equal(row.result.gas,call.gas);assert.deepEqual(row.result.calls??[],[]);assert.deepEqual(row.result.logs??[],[]);
    assert.deepEqual(report.blobContextValidation.witnesses[index-9],{state,traceEvidenceId:index+1,hashWordStart:8,hashCount:1,outOfRangeIndex:1,blobBaseFeeRaw:'0'});
  }
  assert.equal(report.executionIdentity.originalEnvelopeSha256,sha(JSON.stringify(expectedCall)));assert.equal(report.executionIdentity.completeOverridesSha256,sha(JSON.stringify(postOverride)));assert.equal(report.canonicalStatus,'verified');assert.equal(report.blobContextValidation.status,'verified');assert.equal(report.blobContextValidation.sourceExcessBlobGas,BigInt(header.excessBlobGas).toString());assert.equal(report.blobContextValidation.sidecarsVerified,false);assert.equal(report.blobContextValidation.feeSettlement,false);assert.equal(report.measurements.length,0);assert.equal(report.security.status,'not_assessed');
  return {status:'verified',responseSha256:PINS['response.json'],implementationSha256:IMPLEMENTATION,preservedSourceFiles:snapshot.files.length,joinedRpcRecords:12,responseEntityBytes:wireBytes,
    headerHash:header.hash,headerHashRecomputed:true,initialAndFinalRawHeaderEqual:true,originalTraceAndDiffSameEnvelope:true,exactSyntheticBlockOverrides:blockOverrides,execution:'success',gasUsed:'21000',stateChanges:'sender_nonce_only',beforeNonce:nonce.toString(),afterNonce:(nonce+1n).toString(),witnessWordsPerState:11,blobHash:request.blobVersionedHashes[0],observedBaseFee:'0',observedBlobBaseFee:'0',
    limitations:{independentLocalExecution:false,consensusOrFinalityVerified:false,originalTransactionPosition:false,signedFeesOrBlobSidecarsVerified:false,populationAccuracyClaim:false,transportEnvelope:'successful_RPC_responseText_retained_by_actual_API_transport; outer_HTTP_headers_not_retained'}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const out=await audit();if(process.argv[2]==='--write')writeFileSync(join(HERE,'results.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});else if(process.argv[2]==='--verify')assert.deepEqual(out,json(join(HERE,'results.json')));console.log(JSON.stringify(out,null,2));}
