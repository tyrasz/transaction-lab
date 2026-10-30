// Artifact-only consistency/proof check; does not import a fixture or execute EVM.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {validateInputFacts} from '../../engines/local-evm/input-facts.js';
import {verifyEthereumHeader} from '../../engines/local-evm/ethereum-header.js';
const HOME=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HOME,'../..'),P=path.join(HOME,'probe');
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(fs.readFileSync(path.join(P,p)));
const mb=fs.readFileSync(path.join(P,'manifest.json'));assert.equal(sha(mb),'c5d1567da8ddca3af04002858b010555747e170de4cb1fbe3fed97269d087164');const m=JSON.parse(mb);
function walk(root,base=''){return fs.readdirSync(path.join(root,base),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(root,path.join(base,e.name)):[path.join(base,e.name)]).sort();}
assert.deepEqual(walk(P),[...m.files.map(f=>f.path),'manifest.json'].sort());for(const f of m.files){const b=fs.readFileSync(path.join(P,f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
const plan=read('plan.json'),before=read('source-before.json'),after=read('source-after.json'),r=read('results.json');assert.deepEqual(before.files,after.files);assert.equal(after.sourceUnchanged,true);assert.equal(r.usable,true);assert.equal(r.fatal,null);assert.equal(r.attempted,12);assert.equal(r.declared,12);assert.equal(r.rows.length,12);assert.equal(plan.actualIsolatedExecutions,12);
for(const p of ['engines/local-evm/input-facts.js','engines/local-evm/ethereum-header.js'])assert.equal(sha(fs.readFileSync(path.join(ROOT,p))),before.files.find(f=>f.path===p).sha256);
let verifiedFacts=0,proofReplies=0,rpcReplies=0;const rows=[];
for(let i=0;i<12;i++){const n=String(i+1).padStart(3,'0'),input=read('inputs/'+n+'.json'),out=read('outputs/'+n+'.json'),a=out.parentResult;assert.equal(input.id,plan.cases[i][0]);assert.equal(out.index,i);assert.equal(out.id,input.id);assert.equal(a.status,'completed');assert.equal(a.error,null);assert.equal(a.isolation.processClosed,true);assert.equal(a.broker.pendingAtReturn,0);
 verifyEthereumHeader({header:input.header,expectedHash:input.header.hash,chainId:input.chainId});
 const msgs=out.childMessages.map(raw=>JSON.parse(raw)),results=msgs.filter(m=>m.type==='result');assert.equal(results.length,1);for(const[k,v]of Object.entries(results[0].result))assert.deepEqual(a[k],v);
 assert.equal(out.proofRecords.length,a.inputEvidence.length);assert.equal(a.broker.calls,out.proofRecords.length);for(let j=0;j<out.proofRecords.length;j++){const wire=out.proofRecords[j],e=a.inputEvidence[j];assert.deepEqual(e.request,{method:wire.method,params:wire.params});assert.deepEqual(e.result,wire.result);rpcReplies++;if(wire.method==='eth_getProof')proofReplies++;}
 await validateInputFacts({inputs:a.inputs,inputEvidence:a.inputEvidence,stateRoot:input.header.stateRoot,chainId:input.chainId});verifiedFacts+=Object.keys(a.inputs.accounts).length;
 const status=a.output.execution.status;if(status==='unavailable'){assert.equal(a.output.execution.error.code,'LOCAL_EXECUTION_FAILED');assert.equal(a.output.stateDisposition,'rolled_back');assert.deepEqual(a.changes.accounts,[]);assert.equal(a.output.feeAccounting,undefined);assert.equal(a.output.gasAccounting,null);}else assert(['success','failed'].includes(status));
 rows.push({index:i,id:input.id,status,error:a.output.execution.error,steps:a.output.usage.steps,frames:a.output.usage.frames,returnData:a.output.execution.returnData,chargedGas:a.output.feeAccounting?.chargedGas??null});
}
console.log(JSON.stringify({schemaVersion:1,manifestSha256:sha(mb),planSha256:sha(fs.readFileSync(path.join(P,'plan.json'))),artifactFiles:m.files.length,verifiedFacts,proofReplies,rpcReplies,rows,scope:{artifactOnly:true,clientOrEvmExecution:false,syntheticAuthenticatedState:true,sourceUnchangedDuringProbe:true,completeDependencyArchive:false,noConsensusWinnerClaim:true}},null,2));
