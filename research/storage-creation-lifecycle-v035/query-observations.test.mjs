// Hypothetical saved records only. No declared target, VM, reference process,
// RPC or subprocess executes. Coherent records exercise validation, not truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlock} from '../../engines/fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import {createTx} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {getCalldataFloorGas} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import {privateToAddress} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {ethereumNetworkCommon} from '../../engines/local-evm/ethereum-network.js';
import {allocationRoot} from '../amsterdam-storage-creation-v033/observations.mjs';
import {validateQueryReference} from './query-observations.mjs';

const hex=x=>'0x'+Buffer.from(x).toString('hex'),bytes=x=>Uint8Array.from(Buffer.from(x.slice(2),'hex'));
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),int=n=>n===0n?new Uint8Array():bytes('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));
const KEY=Uint8Array.from({length:32},()=>1),S=hex(privateToAddress(KEY)),T='0x'+'22'.repeat(20),G='0x'+'cc'.repeat(20),C='0x'+'99'.repeat(20);
const SYSTEMS=['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282'];
const account=(nonce='0x1',code='0x00')=>({nonce,balance:'0x9',code,storage:{}});
const rootFor=async payload=>{const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);return hex(trie.root());};
async function encodeReceipt(q){
  const logs=q.logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]),bloom=Buffer.alloc(256);
  for(const l of q.logs)for(const v of[l.address,...l.topics]){const h=keccak(bytes(v));for(let i=0;i<6;i+=2){const bit=((h[i]<<8)|h[i+1])&2047;bloom[255-(bit>>3)]|=1<<(bit&7);}}
  q.receipt={status:q.executionStatus==='success'?'success':'failed',chargedGas:q.chargedGas,logs:structuredClone(q.logs)};
  q.receiptBloom=hex(bloom);q.logsHash=hex(keccak(RLP.encode(logs)));
  q.receiptBytes=hex(Uint8Array.from([2,...RLP.encode([q.receipt.status==='success'?Uint8Array.of(1):new Uint8Array(),int(BigInt(q.chargedGas)),Uint8Array.from(bloom),logs])]));
  q.receiptsRoot=await rootFor(bytes(q.receiptBytes));
}
async function signQuery(record,overrides={},key=KEY){
  const {input,template,initialAllocation}=record,q=record.reference,r=template.request,common=ethereumNetworkCommon(input.header,input.chainId);
  const tx=createTx({type:2,chainId:BigInt(input.chainId),nonce:BigInt(initialAllocation[S].nonce),gasLimit:1000000n,to:r.to,value:0n,data:r.data,
    maxFeePerGas:0n,maxPriorityFeePerGas:0n,accessList:[],...overrides},{common}).sign(key);
  const {v,...envelope}=tx.toJSON();assert.equal(v,envelope.yParity);
  Object.assign(q,{signedBytes:hex(tx.serialize()),transactionHash:hex(tx.hash()),envelope,senderNonceBefore:tx.nonce.toString(),
    intrinsicGas:tx.getIntrinsicGas().toString(),calldataFloor:input.fork==='Shanghai'?null:getCalldataFloorGas(tx).toString(),
    transactionsRoot:await rootFor(tx.serialize())});
}
async function sample(fork='Osaka'){
  const chainId=fork==='Amsterdam'?11155111:1,number=fork==='Shanghai'?18000000:fork==='Amsterdam'?12018196:24000000,
    timestamp=fork==='Shanghai'?1681338455:fork==='Amsterdam'?1793261160:1764798551;
  const initialAllocation={[S]:account('0x1','0x'),[T]:{...account(),storage:{[word(0)]:word(42)}},[G]:account(),[C]:account('0x1','0x'),
    ...Object.fromEntries(SYSTEMS.map(a=>[a,{nonce:'0x1',balance:'0x0',code:'0x00',storage:{}}]))};
  const initialStateRoot=await allocationRoot(initialAllocation),common=ethereumNetworkCommon({number:String(number),timestamp:String(timestamp)},chainId);
  const b=createBlock({header:{number:BigInt(number),timestamp:BigInt(timestamp),stateRoot:initialStateRoot,coinbase:C,gasLimit:30000000n,
    baseFeePerGas:7n,...(fork==='Amsterdam'?{slotNumber:12345n}:{})},withdrawals:[]},{common}),j=b.header.toJSON(),aliases={sha3Uncles:'uncleHash',miner:'coinbase',transactionsRoot:'transactionsTrie',receiptsRoot:'receiptTrie'};
  const names=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot',
    ...(fork==='Shanghai'?[]:['blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash']),...(fork==='Amsterdam'?['blockAccessListHash','slotNumber']:[])];
  const header=Object.fromEntries(names.map(k=>[k,j[aliases[k]??k]]));header.hash=hex(b.hash());
  const environment={currentCoinbase:C,currentGasLimit:header.gasLimit,currentNumber:header.number,currentTimestamp:header.timestamp,currentRandom:header.mixHash,
    currentDifficulty:header.difficulty,currentBaseFee:header.baseFeePerGas,withdrawals:[],...(fork==='Shanghai'?{}:{currentExcessBlobGas:header.excessBlobGas,parentBeaconBlockRoot:header.parentBeaconBlockRoot}),
    ...(fork==='Amsterdam'?{slotNumber:header.slotNumber}:{})};
  const template={index:0,kind:'contract_call',request:{from:S,to:G,data:'0x70a08231'+S.slice(2).padStart(64,'0'),value:'0',gas:'1000000'},phases:['before','after']};
  const input={id:'hypothetical_saved_record',fork,chainId,header,headerHash:header.hash,environment,request:{from:S},initialStateRoot,
    allocation:structuredClone(initialAllocation),target:T,amendment:{addresses:SYSTEMS},queryTemplates:[template],queries:[{to:G,data:template.request.data}]};
  const final=structuredClone(initialAllocation);final[S].nonce='0x2';
  const reference={status:'observed',request:structuredClone(template.request),inputStateRoot:initialStateRoot,initialAllocation:structuredClone(initialAllocation),allocation:final,stateRoot:await allocationRoot(final),
    sourceHeaderHash:header.hash,sourceEnvironment:structuredClone(environment),environment:{...environment,currentBaseFee:'0x0'},entrypoint:'stock_'+fork+'_apply_body',
    executionStatus:'success',returnData:word(42),chargedGas:'25000',singleTransactionBlockGasUsed:fork==='Amsterdam'?'40000':'25000',blockGasUsed:fork==='Amsterdam'?'40000':'25000',
    blockExecutionGasUsed:fork==='Amsterdam'?'30000':null,blockStateGasUsed:fork==='Amsterdam'?'40000':null,logs:[],
    transactionEnd:{returnData:word(42),gasUsed:'3000',error:null},transactionEndGasMeaning:'grant_minus_remaining_before_refund_and_floor',returnDataAvailability:'official_TransactionEnd',
    storageClears:[],requests:[],neutralExceptSenderNonce:true,targetSelfdestructObserved:false,
    lifecycle:{source:'official_EELS_trace_events',eventCount:5,frames:[{index:0,parent:null,depth:0,address:G,codeAddress:G,ended:true,error:null}],selfdestructs:[]}};
  const record={input,reference,template,initialAllocation};await signQuery(record);await encodeReceipt(reference);return record;
}
const cached=new Map();async function fresh(fork='Osaka'){if(!cached.has(fork))cached.set(fork,sample(fork));return structuredClone(await cached.get(fork));}
async function refuses(mutator,fork='Osaka'){const r=await fresh(fork);await mutator(r);await assert.rejects(validateQueryReference(r));}

test('coherent hypothetical records project all three forks without changing input',async()=>{
  for(const fork of['Shanghai','Osaka','Amsterdam']){const r=await fresh(fork),saved=structuredClone(r),p=await validateQueryReference(r);
    assert.equal(p.executionStatus,'success');assert.equal(p.scalar,'42');assert.equal(p.neutralExceptSenderNonce,true);assert.equal(p.targetSelfdestructObserved,false);
    assert.equal(p.singleTransactionBlockGasUsed,fork==='Amsterdam'?'40000':'25000');assert.deepEqual(r,saved);}
});
test('source header, environment and synthetic base-fee changes are refused',async()=>{
  for(const mutate of[r=>{r.reference.sourceHeaderHash=word(99);},r=>{r.input.header.timestamp='0x1';},r=>{r.reference.sourceEnvironment.currentBaseFee='0x0';},
    r=>{r.reference.environment.currentBaseFee='0x7';},r=>{r.reference.environment.currentNumber='0x1';},r=>{r.reference.environment.extra='0';},r=>{r.reference.entrypoint='custom';}])await refuses(mutate);
});
test('signature bytes, recovered sender, nonce and zero-fee envelope are independently bound',async()=>{
  await refuses(r=>{r.reference.signedBytes=r.reference.signedBytes.slice(0,-2)+'00';});
  await refuses(r=>{r.reference.transactionHash=word(1);});await refuses(r=>{r.reference.envelope.nonce='0x2';});await refuses(r=>{r.reference.senderNonceBefore='2';});
  await refuses(r=>signQuery(r,{},Uint8Array.from({length:32},()=>2)));
  for(const overrides of[{nonce:2n},{gasLimit:999999n},{value:1n},{maxFeePerGas:1n},{maxPriorityFeePerGas:1n,maxFeePerGas:1n},{to:T},
    {data:'0x00'},{accessList:[{address:T,storageKeys:[]}]}])await refuses(r=>signQuery(r,overrides));
  await refuses(r=>{r.reference.request.from=T;});await refuses(r=>{r.reference.request.gas='1000001';});
});
test('initial and final allocation roots, source snapshots, intrinsic and floor are bound',async()=>{
  for(const mutate of[r=>{r.reference.inputStateRoot=word(1);},r=>{r.reference.stateRoot=word(2);},r=>{r.reference.initialAllocation[S].nonce='0x2';},
    r=>{r.reference.allocation[T].balance='0xa';},r=>{r.reference.intrinsicGas='1';},r=>{r.reference.calldataFloor='1';},r=>{r.reference.allocation[T].storage[word(3)]=word(0);},
    r=>{r.input.initialStateRoot=word(3);},r=>{r.input.allocation[T].balance='0xa';}])await refuses(mutate);
  await refuses(r=>{r.reference.calldataFloor='0';},'Shanghai');
});
test('receipt bytes, gas, ordered logs, bloom and both trie roots are independently bound',async()=>{
  for(const mutate of[r=>{r.reference.receiptBytes='0x02c0';},r=>{r.reference.receipt.chargedGas='25001';},r=>{r.reference.logsHash=word(1);},
    r=>{r.reference.receiptBloom='0x'+'00'.repeat(255)+'01';},r=>{r.reference.receiptsRoot=word(1);},r=>{r.reference.transactionsRoot=word(2);},
    r=>{r.reference.logs=[{address:T,topics:[],data:'0x'}];},r=>{r.reference.receipt.status='failed';},r=>{r.reference.requests=['0x'];}])await refuses(mutate);
  const r=await fresh();r.reference.logs=[{address:T,topics:[word(1)],data:word(2)}];r.reference.neutralExceptSenderNonce=false;await encodeReceipt(r.reference);
  const out=await validateQueryReference(r);assert.equal(out.neutralExceptSenderNonce,false);assert.deepEqual(out.logs,r.reference.logs);
});
test('historical charged gas and Amsterdam maximum dimensions remain distinct',async()=>{
  await refuses(r=>{r.reference.singleTransactionBlockGasUsed='40000';});await refuses(r=>{r.reference.blockExecutionGasUsed='25000';});
  for(const field of['singleTransactionBlockGasUsed','blockGasUsed','blockStateGasUsed','blockExecutionGasUsed'])await refuses(r=>{r.reference[field]=null;},'Amsterdam');
  await refuses(r=>{r.reference.singleTransactionBlockGasUsed='25000';r.reference.blockGasUsed='25000';},'Amsterdam');
  for(const bad of[null,1,'01','-1','1e3','0x1','1000001'])await refuses(r=>{r.reference.chargedGas=bad;});
});
test('missing official terminal preserves null return and scalar without inventing success data',async()=>{
  const r=await fresh();Object.assign(r.reference,{transactionEnd:null,returnData:null,returnDataAvailability:'unavailable_no_TransactionEnd_event'});
  const p=await validateQueryReference(r);assert.equal(p.returnData,null);assert.equal(p.scalar,null);assert.equal(p.executionStatus,'success');
  r.reference.returnData='0x';await assert.rejects(validateQueryReference(r));
  await refuses(x=>{x.reference.transactionEnd.error={type:'Revert',message:''};});await refuses(x=>{x.reference.transactionEnd.gasUsed='-0';});
});
function observedSelfdestruct(r,{ancestorRevert=false}={}){
  const q=r.reference,ancestorError=ancestorRevert?{type:'Revert',message:''}:null;
  q.lifecycle={source:'official_EELS_trace_events',eventCount:20,frames:[
    {index:0,parent:null,depth:0,address:G,codeAddress:G,ended:true,error:null},
    {index:1,parent:0,depth:1,address:'0x'+'bb'.repeat(20),codeAddress:'0x'+'bb'.repeat(20),ended:true,error:ancestorError},
    {index:2,parent:1,depth:2,address:T,codeAddress:T,ended:true,error:null}],selfdestructs:[
    {frame:2,depth:2,address:T,beneficiary:T,pc:1,completed:true,error:null,committed:!ancestorRevert,frameError:null}]};q.targetSelfdestructObserved=true;
}
test('SELFDESTRUCT observation and ancestor rollback are rederived from bounded frames',async()=>{
  for(const ancestorRevert of[false,true]){const r=await fresh('Amsterdam');observedSelfdestruct(r,{ancestorRevert});const p=await validateQueryReference(r);assert.equal(p.targetSelfdestructObserved,true);
    r.reference.lifecycle.selfdestructs[0].committed=ancestorRevert;await assert.rejects(validateQueryReference(r));}
  for(const mutate of[q=>{q.targetSelfdestructObserved=false;},q=>{q.lifecycle.frames[2].parent=2;},q=>{q.lifecycle.frames[2].depth=1;},
    q=>{q.lifecycle.selfdestructs[0].address=G;},q=>{q.lifecycle.selfdestructs[0].frameError={type:'Revert',message:''};},
    q=>{q.lifecycle.selfdestructs.push(structuredClone(q.lifecycle.selfdestructs[0]));},q=>{q.lifecycle.eventCount=200001;}]){
    const r=await fresh('Amsterdam');observedSelfdestruct(r);mutate(r.reference);await assert.rejects(validateQueryReference(r));}
});
test('neutrality is rederived from the entire state and logs, including retained mutations',async()=>{
  const r=await fresh();r.reference.allocation[T].storage={};r.reference.stateRoot=await allocationRoot(r.reference.allocation);r.reference.storageClears=[T];
  await assert.rejects(validateQueryReference(r));r.reference.neutralExceptSenderNonce=false;assert.equal((await validateQueryReference(r)).neutralExceptSenderNonce,false);
  await refuses(x=>{x.reference.neutralExceptSenderNonce=false;});await refuses(x=>{x.reference.storageClears=[T,T];});
  await refuses(async x=>{x.reference.allocation[S].nonce='0x3';x.reference.stateRoot=await allocationRoot(x.reference.allocation);x.reference.neutralExceptSenderNonce=false;});
});
