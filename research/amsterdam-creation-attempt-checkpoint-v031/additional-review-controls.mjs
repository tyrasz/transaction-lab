import assert from 'node:assert/strict';
const root='/Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v031/engines/local-evm/';
const {creationAttemptFixture:fixture,TARGET,IMPLEMENTATION,initcode,factoryCode,callBytes,compareAmsterdamFullVM}=await import(root+'test/amsterdam-creation-attempts-fixture.js');
const {executeEthereumCall}=await import(root+'ethereum-call.js');
const {executeIsolatedEthereumCall}=await import(root+'isolated-call.js');
const {validateExecutionChanges}=await import(root+'execution-changes.js');
const tests=[
 ['CALLCODE creator context',()=>fixture({body:'0x'+callBytes(IMPLEMENTATION,{opcode:'f2',value:5})+'00',accounts:{[IMPLEMENTATION]:{nonce:11n,code:factoryCode(initcode('00',''),{value:5})}}})],
 ['7702 destination creator context',()=>fixture({body:'0xef0100'+IMPLEMENTATION.slice(2),accounts:{[IMPLEMENTATION]:{nonce:11n,code:factoryCode(initcode('00',''),{value:5})}}})],
 ['constructor selfdestruct followed by repeated CREATE2 collision',()=>fixture({body:factoryCode('30ff',{kind:'CREATE2',value:5,repeat:2})})],
];
const results=[];
for(const [name,make] of tests){
 const f=await make();
 const output=await executeEthereumCall({request:f.request,header:f.header,stateManager:f.stateManager,blockchain:f.inputs.blockchain,chainId:11155111});
 assert.equal(output.execution.status,'success',JSON.stringify(output.execution));
 const changes=f.stateManager.snapshotChanges();
 validateExecutionChanges({output,inputs:f.inputs.snapshotInputs(),changes,sender:f.request.from,destination:f.request.to,request:f.request,header:f.header,common:f.common});
 await compareAmsterdamFullVM(f,output,changes);
 const isolated=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc:f.rpc,chainId:11155111});
 assert.equal(isolated.status,'completed',JSON.stringify(isolated.error));assert.deepEqual(isolated.changes,changes);
 results.push({name,status:'passed',rootAttempts:output.trace.creationAttempts.length,children:output.trace.calls.length});
}
console.log(JSON.stringify({scope:'Synthetic ephemeral review controls; shared EthereumJS signed reference and third MPT, no independent client or public RPC.',results},null,2));
