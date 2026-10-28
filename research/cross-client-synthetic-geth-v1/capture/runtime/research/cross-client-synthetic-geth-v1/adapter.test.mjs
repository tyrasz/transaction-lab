// Unrelated synthetic preparation controls only; never launch Geth or execute
// any of the 16 target declarations. Fake result rows are labelled here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Common, Mainnet, Hardfork } from '../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { bytesToHex, hexToBytes } from '../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { keccak_256 } from '../../engines/fixture-evm/node_modules/@noble/hashes/sha3.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { declareFixture } from '../evm-lifecycle-differential-v1/runtime.mjs';
import { adaptSyntheticCase, contextOpcodes, logsHash, verifyEvidenceInventory, sha } from './adapter.mjs';

const SENDER='0x1a642f0e3c3af545e7acbd38b07251b3990914f1',TO='0x'+'22'.repeat(20),COINBASE='0x'+'33'.repeat(20),ZERO='0x'+'00'.repeat(32),KEY='0x'+'01'.repeat(32);
const copy=structuredClone;
async function control(){
  const pre={[SENDER]:{nonce:'0x0',balance:'0xa',code:'0x',storage:{}}};
  const fixture={config:{chainid:'0x01'},_info:{'fixture-format':'state_test'},pre,env:{currentCoinbase:COINBASE,currentGasLimit:'0x7270e00',currentRandom:ZERO,currentNumber:'0x1',currentTimestamp:'0x1',currentDifficulty:'0x0',currentBaseFee:'0x0',currentExcessBlobGas:'0x0'},
    transaction:{sender:SENDER,chainId:'0x1',to:TO,data:['0x'],value:['0x1'],gasLimit:['0x186a0'],gasPrice:'0x0',nonce:'0x0',secretKey:KEY},post:{Osaka:[{indexes:{data:0,gas:0,value:0}}]}};
  const declaration=await declareFixture(fixture,{index:1,id:'unrelated_adapter_transfer',category:'synthetic_control',postIndex:0,officialFixtureHash:ZERO,officialFileSha256:'0'.repeat(64)});
  const after={[SENDER]:{nonce:'0x1',balance:'0x9',code:'0x',storage:{}},[TO]:{nonce:'0x0',balance:'0x1',code:'0x',storage:{}}};
  const state=await loadState(after,new Common({chain:Mainnet,hardfork:Hardfork.Osaka}));
  const result={status:'completed',output:{execution:'success',returnData:'0x',logs:[],stateRoot:bytesToHex(await state.getStateRoot()),serializedTransaction:declaration.serializedTransaction},
    observedState:[{address:COINBASE,exists:false}],scope:{originalOfficialExpectedPostUsed:false,fullVmSignedTransaction:true,fullMptFinalization:true,zeroGasPrice:true,zeroBaseFee:true}};
  const reference={status:'completed',reason:null,exitCode:0,signal:null,stdout:JSON.stringify(result)+'\n',stderr:'',result};
  const product={attempt:{status:'completed',output:{profile:{sourceBlockHash:declaration.header.hash,sourceStateRoot:declaration.initialStateRoot,hardfork:'osaka'},execution:{status:'success'},logs:[],trace:{type:'CALL',input:'0x',output:'0x',calls:[]}}}};
  const comparison={status:'matched',checks:{execution:true,returnData:true,logs:true,gas:true,stateRoot:true},applied:{stateRoot:result.output.stateRoot}};
  return{declaration,reference,product,comparison};
}
test('unrelated wrapper preserves pre/message/header and exact signed bytes; expected data stays only in post',async()=>{
  const input=await control(),before=copy(input),a=await adaptSyntheticCase(input),f=a.wrapper[a.id];assert.deepEqual(input,before);
  assert.deepEqual(f.pre,input.declaration.pre);assert.equal(f.transaction.to,TO);assert.equal(f.transaction.nonce,'0x0');assert.equal(f.transaction.gasPrice,'0x0');assert.deepEqual(f.transaction.gasLimit,['0x186a0']);
  assert.equal(f.env.currentNumber,input.declaration.header.number);assert.equal(f.env.currentTimestamp,input.declaration.header.timestamp);assert.equal(f.env.currentRandom,input.declaration.header.mixHash);
  assert.equal(f.post.Osaka[0].txbytes,input.declaration.serializedTransaction);assert.deepEqual(f.post.Osaka[0].indexes,{data:0,gas:0,value:0});assert.equal(Object.hasOwn(f.post.Osaka[0],'expectException'),false);
  assert.equal(f.post.Osaka[0].hash,input.reference.result.output.stateRoot);assert.equal(a.scope.currentProductAccuracy,false);assert.equal(a.scope.fiveChannelAgreement,false);
  const changed=copy(input);changed.reference.result.output.stateRoot='0x'+'55'.repeat(32);changed.reference.stdout=JSON.stringify(changed.reference.result);changed.comparison.applied.stateRoot=changed.reference.result.output.stateRoot;
  const changedFixture=(await adaptSyntheticCase(changed)).wrapper[a.id];assert.deepEqual(changedFixture.pre,f.pre);assert.deepEqual(changedFixture.env,f.env);assert.deepEqual(changedFixture.transaction,f.transaction);assert.notEqual(changedFixture.post.Osaka[0].hash,f.post.Osaka[0].hash);
});
test('signature/nonce/header/context mutations fail rather than quietly changing the input question',async()=>{
  const input=await control();for(const change of [x=>x.declaration.transaction.nonce='1',x=>x.declaration.transaction.secretKey='0x'+'02'.repeat(32),x=>x.declaration.serializedTransaction='0xc0',x=>x.declaration.header.baseFeePerGas='0x1',x=>x.declaration.pre[SENDER].balance='0xb',x=>x.declaration.request.accessList=[],x=>x.declaration.transaction.blobVersionedHashes=[ZERO]]){
    const altered=copy(input);change(altered);await assert.rejects(adaptSyntheticCase(altered));
  }
});
test('root CREATE omits destination using the required empty-string convention, with signed creation bytes',async()=>{
  const input=await control(),d=input.declaration;
  // Build a second unrelated declaration, not a changed target or a Geth run.
  const fixture={config:{chainid:'0x01'},_info:{'fixture-format':'state_test'},pre:d.pre,env:d.transformations.originalEnvironment,transaction:{sender:SENDER,chainId:'0x1',to:'',data:['0x'],value:['0x0'],gasLimit:['0x186a0'],gasPrice:'0x0',nonce:'0x0',secretKey:KEY},post:{Osaka:[{indexes:{data:0,gas:0,value:0}}]}};
  input.declaration=await declareFixture(fixture,d.identity);input.reference.result.output.serializedTransaction=input.declaration.serializedTransaction;input.reference.stdout=JSON.stringify(input.reference.result);
  Object.assign(input.product.attempt.output.profile,{sourceBlockHash:input.declaration.header.hash,sourceStateRoot:input.declaration.initialStateRoot});input.product.attempt.output.trace.type='CREATE';
  const a=await adaptSyntheticCase(input);assert.equal(a.wrapper[a.id].transaction.to,'');assert.equal(a.wrapper[a.id].post.Osaka[0].txbytes,input.declaration.serializedTransaction);
});
test('log hash uses consensus ordered address/topics/data RLP, not receipt or JSON fields',()=>{
  assert.equal(logsHash([]),'0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347');
  const log={address:TO,topics:[],data:'0xab'};
  // Hand-written RLP for [[20-byte address, [], 0xab]]: outer d9, inner d8.
  const expected=bytesToHex(keccak_256(hexToBytes('0xd9d894'+TO.slice(2)+'c081ab')));assert.equal(logsHash([log]),expected);
  assert.notEqual(logsHash([log,{...log,data:'0xac'}]),logsHash([{...log,data:'0xac'},log]));
  for(const l of [{...log,index:0},{...log,topics:[TO]},{...log,data:'0x0'},{...log,address:TO.toUpperCase()}])assert.throws(()=>logsHash([l]));
});
test('context scan excludes PUSH bytes but rejects executable history/blob opcodes in fixed-profile preparation',async()=>{
  assert.deepEqual(contextOpcodes('0x6240494a00'),[]);assert.deepEqual(contextOpcodes('0x4060494a'),[{pc:0,opcode:'0x40'},{pc:3,opcode:'0x4a'}]);
  const input=await control();input.product.attempt.output.trace.calls=[{type:'CREATE',input:'0x600040',output:'0x',calls:[]}];await assert.rejects(adaptSyntheticCase(input),/not interchangeable/);
});
test('reference failure, inconsistent raw stdout, lost coinbase facts and false old-product comparison never create expectations',async()=>{
  const input=await control();for(const change of [x=>x.reference.exitCode=1,x=>x.reference.stdout='{}',x=>x.reference.result.observedState[0].exists=true,x=>x.product.attempt.output.logs=[{address:TO,topics:[],data:'0x'}],x=>x.comparison.checks.stateRoot=false]){
    const x=copy(input);change(x);if(x.reference.result!==undefined&&x.reference.stdout!=='{}')x.reference.stdout=JSON.stringify(x.reference.result);await assert.rejects(adaptSyntheticCase(x));
  }
});
test('original inventory verifier binds bytes and membership and rejects duplicate, traversal and symlink inputs',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'geth-synthetic-adapter-'));try{
    const plan=Buffer.from('{}\n'),value=Buffer.from('{"control":true}\n');await fs.writeFile(path.join(directory,'plan.json'),plan);await fs.writeFile(path.join(directory,'value.json'),value);
    const entry=(p,b)=>({path:p,bytes:b.length,sha256:sha(b)}),manifest={planSha256:sha(plan),files:[entry('plan.json',plan),entry('value.json',value)]};
    async function verify(m=manifest){const b=Buffer.from(JSON.stringify(m));await fs.writeFile(path.join(directory,'manifest.json'),b);return verifyEvidenceInventory({directory,manifestSha256:sha(b),planSha256:sha(plan)});}
    const p=await verify();assert.deepEqual(p.read('value.json'),{control:true});assert.throws(()=>p.read('foreign.json'));
    await assert.rejects(verify({...manifest,files:[...manifest.files,manifest.files[0]]}));await assert.rejects(verify({...manifest,files:[manifest.files[0],{...manifest.files[1],path:'../value.json'}]}));
    await fs.writeFile(path.join(directory,'value.json'),'{}');await assert.rejects(verify());await fs.unlink(path.join(directory,'value.json'));await fs.symlink('plan.json',path.join(directory,'value.json'));await assert.rejects(verify());
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
