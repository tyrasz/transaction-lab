// Saved evidence validation only: signatures, encoding, tries and trace joins.
// No VM, RPC, subprocess, expected EVM output, or execution worker is invoked.
import assert from 'node:assert/strict';
import {isDeepStrictEqual as equal} from 'node:util';
import {createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {getCalldataFloorGas} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {ethereumNetworkCommon} from '../../engines/local-evm/ethereum-network.js';
import {verifyEthereumHeader} from '../../engines/local-evm/ethereum-header.js';
import {allocationRoot,normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';

const MAX=(1n<<256n)-1n,GAS=1000000n;
const bytes=v=>Uint8Array.from(Buffer.from(v.slice(2),'hex'));
const hex=v=>'0x'+Buffer.from(v).toString('hex');
const quantity=(v,max=MAX)=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);const n=BigInt(v);assert(n<=max);return n;};
const decimal=(v,max=MAX)=>{assert.equal(typeof v,'string');assert.match(v,/^(?:0|[1-9][0-9]*)$/);const n=BigInt(v);assert(n<=max);return n;};
const data=(v,length)=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:[0-9a-f]{2})*$/);assert(v.length<=131074);if(length!==undefined)assert.equal(v.length,2+2*length);return v;};
const address=v=>data(v,20),word=v=>data(v,32);
const object=v=>{assert(v!==null&&typeof v==='object'&&!Array.isArray(v));assert([Object.prototype,null].includes(Object.getPrototypeOf(v)));return v;};
const fields=(v,keys)=>{object(v);assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
const integer=(v,max)=>{assert(Number.isSafeInteger(v)&&v>=0&&v<=max);return v;};
const bool=v=>{assert.equal(typeof v,'boolean');return v;};
const intBytes=n=>n===0n?new Uint8Array():bytes('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));

function allocation(value){
  object(value);assert(Object.keys(value).length<=64);let count=0;
  for(const[a,row]of Object.entries(value)){
    address(a);fields(row,['nonce','balance','code','storage']);quantity(row.nonce,(1n<<64n)-1n);quantity(row.balance);data(row.code);object(row.storage);
    for(const[k,v]of Object.entries(row.storage)){word(k);word(v);assert(BigInt(v)>0n);assert(++count<=1024);}
  }
  const out=normalizeAllocation(value);assert.deepEqual(out,value);return out;
}
function error(value){
  if(value===null)return null;fields(value,['type','message']);assert.equal(typeof value.type,'string');assert.match(value.type,/^[A-Za-z_][A-Za-z_0-9]{0,127}$/);
  assert.equal(typeof value.message,'string');assert(value.message.length<=2048);return value;
}
function neutral(before,after,sender,logs){
  if(logs.length||!before[sender]||!after[sender]||BigInt(after[sender].nonce)!==BigInt(before[sender].nonce)+1n)return false;
  const adjusted=structuredClone(after);adjusted[sender].nonce=before[sender].nonce;return equal(before,adjusted);
}
function sourceContext(input,q){
  assert(['Shanghai','Osaka','Amsterdam'].includes(input.fork));assert.equal(input.chainId,input.fork==='Amsterdam'?11155111:1);
  const h=input.header;word(input.headerHash);assert.equal(h.hash,input.headerHash);
  const verified=verifyEthereumHeader({header:h,expectedHash:input.headerHash,chainId:input.chainId});assert.equal(verified.hardfork,input.fork.toLowerCase());
  const env={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,
    currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,withdrawals:[],
    ...(input.fork==='Shanghai'?{}:{currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot}),
    ...(input.fork==='Amsterdam'?{slotNumber:h.slotNumber}:{})};
  assert.equal(quantity(h.baseFeePerGas),7n);assert.deepEqual(input.environment,env);
  assert.equal(q.sourceHeaderHash,input.headerHash);assert.deepEqual(q.sourceEnvironment,env);
  assert.deepEqual(q.environment,{...env,currentBaseFee:'0x0'});assert.equal(q.entrypoint,'stock_'+input.fork+'_apply_body');
  const common=ethereumNetworkCommon(h,input.chainId);assert.equal(common.hardfork(),input.fork.toLowerCase());return common;
}
function signedQuery(input,q,template,initial,common){
  fields(template,['index','kind','request','phases']);integer(template.index,7);assert.equal(template.kind,'contract_call');assert.deepEqual(template.phases,['before','after']);
  assert.deepEqual(input.queryTemplates[template.index],template);
  const r=template.request;fields(r,['from','to','data','value','gas']);address(r.from);address(r.to);data(r.data);
  assert.equal(r.from,input.request.from);assert.equal(r.value,'0');assert.equal(r.gas,'1000000');assert.deepEqual(q.request,r);
  assert.deepEqual(input.queries[template.index],{to:r.to,data:r.data});
  assert(initial[r.from]);assert.equal(initial[r.from].code,'0x');const nonce=quantity(initial[r.from].nonce,(1n<<64n)-2n);
  assert.equal(decimal(q.senderNonceBefore,(1n<<64n)-2n),nonce);
  data(q.signedBytes);assert(q.signedBytes.startsWith('0x02'));const signed=bytes(q.signedBytes),tx=createTxFromRLP(signed,{common});
  assert.equal(tx.type,2);assert(tx.isSigned());assert(tx.verifySignature());assert.deepEqual(tx.getValidationErrors(),[]);
  assert.equal(hex(tx.serialize()),q.signedBytes);assert.equal(word(q.transactionHash),hex(keccak(signed)));assert.equal(hex(tx.hash()),q.transactionHash);
  assert.equal(tx.getSenderAddress().toString(),r.from);assert.equal(tx.chainId,BigInt(input.chainId));assert.equal(tx.nonce,nonce);
  assert.equal(tx.gasLimit,GAS);assert.equal(tx.value,0n);assert.equal(tx.maxFeePerGas,0n);assert.equal(tx.maxPriorityFeePerGas,0n);
  assert(tx.gasLimit<=quantity(input.header.gasLimit));
  assert.equal(tx.to.toString(),r.to);assert.equal(hex(tx.data),r.data);assert.deepEqual(tx.accessList,[]);
  // The Python adapter's explicit envelope omits EthereumJS's redundant v.
  const {v,...envelope}=tx.toJSON();assert.equal(v,envelope.yParity);assert.deepEqual(q.envelope,envelope);
  assert.equal(decimal(q.intrinsicGas,GAS),tx.getIntrinsicGas());
  if(input.fork==='Shanghai')assert.equal(q.calldataFloor,null);
  else assert.equal(decimal(q.calldataFloor,GAS),getCalldataFloorGas(tx));
  return tx;
}
function logsAndReceipt(q,fork){
  fields(q.receipt,['status','chargedGas','logs']);assert(['success','failed'].includes(q.receipt.status));
  const charged=decimal(q.chargedGas,GAS);assert.equal(decimal(q.receipt.chargedGas,GAS),charged);
  assert(Array.isArray(q.logs)&&q.logs.length<=1024);assert.deepEqual(q.receipt.logs,q.logs);
  for(const l of q.logs){fields(l,['address','topics','data']);address(l.address);assert(Array.isArray(l.topics)&&l.topics.length<=4);l.topics.forEach(word);data(l.data);}
  const encodedLogs=q.logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]);
  assert.equal(word(q.logsHash),hex(keccak(RLP.encode(encodedLogs))));
  const bloom=Buffer.alloc(256);
  for(const l of q.logs)for(const v of[l.address,...l.topics]){const hash=keccak(bytes(v));for(let i=0;i<6;i+=2){const bit=((hash[i]<<8)|hash[i+1])&2047;bloom[255-(bit>>3)]|=1<<(bit&7);}}
  assert.equal(data(q.receiptBloom,256),hex(bloom));
  const receipt=bytes(data(q.receiptBytes));assert.equal(receipt[0],2);
  const decoded=RLP.decode(receipt.slice(1));assert(Array.isArray(decoded)&&decoded.length===4);
  assert.equal(hex(RLP.encode(decoded)),hex(receipt.slice(1)));
  assert.deepEqual(decoded,[q.receipt.status==='success'?Uint8Array.of(1):new Uint8Array(),intBytes(charged),Uint8Array.from(bloom),encodedLogs]);
  const block=decimal(q.singleTransactionBlockGasUsed,GAS);assert.equal(decimal(q.blockGasUsed,GAS),block);
  if(fork==='Amsterdam'){const regular=decimal(q.blockExecutionGasUsed,GAS),state=decimal(q.blockStateGasUsed,GAS);assert.equal(block,regular>state?regular:state);}
  else{assert.equal(q.blockExecutionGasUsed,null);assert.equal(q.blockStateGasUsed,null);assert.equal(block,charged);}
  assert.deepEqual(q.requests,[]);
  assert(Array.isArray(q.storageClears)&&q.storageClears.length<=64);assert.deepEqual(q.storageClears,[...new Set(q.storageClears)].sort());q.storageClears.forEach(address);
  return receipt;
}
async function trieRoot(payload,reported){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);assert.equal(word(reported),hex(trie.root()));}
function terminal(q){
  assert.equal(q.transactionEndGasMeaning,'grant_minus_remaining_before_refund_and_floor');
  let status=q.receipt.status==='success'?'success':'failed',returned=null;
  if(q.transactionEnd===null){assert.equal(q.returnDataAvailability,'unavailable_no_TransactionEnd_event');assert.equal(q.returnData,null);}
  else{
    const t=q.transactionEnd;fields(t,['returnData','gasUsed','error']);error(t.error);data(t.returnData);
    assert.equal(typeof t.gasUsed,'string');assert.match(t.gasUsed,/^(?:0|-?[1-9][0-9]*)$/);assert(BigInt(t.gasUsed)>=-MAX&&BigInt(t.gasUsed)<=MAX);
    assert.equal(q.returnDataAvailability,'official_TransactionEnd');assert.equal(t.error===null,q.receipt.status==='success');
    if(t.error?.type==='Revert')status='reverted';returned=t.returnData;assert.equal(q.returnData,returned);
  }
  assert.equal(q.executionStatus,status);return{executionStatus:status,returnData:returned};
}
function lifecycle(q,target){
  const l=q.lifecycle;fields(l,['source','eventCount','frames','selfdestructs']);assert.equal(l.source,'official_EELS_trace_events');integer(l.eventCount,200000);
  assert(Array.isArray(l.frames)&&l.frames.length<=128);assert(Array.isArray(l.selfdestructs)&&l.selfdestructs.length<=64);
  assert(l.eventCount>=l.frames.length+l.selfdestructs.length);
  for(const[index,f]of l.frames.entries()){
    fields(f,['index','parent','depth','address','codeAddress','ended','error']);assert.equal(f.index,index);integer(f.depth,128);address(f.address);if(f.codeAddress!==null)address(f.codeAddress);bool(f.ended);error(f.error);
    if(index===0){assert.equal(f.parent,null);assert.equal(f.depth,0);assert.equal(f.address,q.request.to);assert.equal(f.codeAddress,q.request.to);}
    else{integer(f.parent,index-1);assert.equal(f.depth,l.frames[f.parent].depth+1);}
    if(f.error!==null)assert.equal(f.ended,true);
  }
  if(l.frames.length&&q.transactionEnd!==null)assert.deepEqual(l.frames[0].error,q.transactionEnd.error);
  const seen=new Set();let observed=false;
  for(const s of l.selfdestructs){
    fields(s,['frame','depth','address','beneficiary','pc','completed','error','committed','frameError']);integer(s.frame,l.frames.length-1);
    const f=l.frames[s.frame];assert.equal(s.depth,f.depth);assert.equal(s.address,f.address);integer(s.pc,65535);bool(s.completed);bool(s.committed);error(s.error);error(s.frameError);
    assert.deepEqual(s.frameError,f.error);if(s.beneficiary!==null)address(s.beneficiary);else assert.equal(s.completed,false);
    if(s.completed)assert.equal(s.error,null);if(s.error!==null){assert.equal(s.completed,false);assert.deepEqual(s.error,f.error);}
    // SELFDESTRUCT halts a frame, so at most one start is possible per frame.
    assert(!seen.has(s.frame));seen.add(s.frame);
    let retained=q.receipt.status==='success'&&s.completed&&s.error===null;
    for(let frame=f;frame!==null;frame=frame.parent===null?null:l.frames[frame.parent])retained=retained&&frame.ended&&frame.error===null;
    assert.equal(s.committed,retained);
    observed ||= s.address===target&&s.beneficiary===target&&s.completed&&s.error===null&&s.frameError===null;
  }
  assert.equal(bool(q.targetSelfdestructObserved),observed);return observed;
}

/** Validate one saved contract phase without invoking either implementation. */
export async function validateQueryReference({input,reference:q,template,initialAllocation}){
  fields(q,['status','request','signedBytes','transactionHash','envelope','senderNonceBefore','intrinsicGas','calldataFloor',
    'inputStateRoot','initialAllocation','allocation','stateRoot','sourceHeaderHash','sourceEnvironment','environment','entrypoint',
    'executionStatus','returnData','chargedGas','singleTransactionBlockGasUsed','blockGasUsed','blockExecutionGasUsed','blockStateGasUsed',
    'logs','receipt','receiptBytes','receiptBloom','receiptsRoot','transactionsRoot','logsHash','transactionEnd','transactionEndGasMeaning',
    'returnDataAvailability','storageClears','requests','neutralExceptSenderNonce','targetSelfdestructObserved','lifecycle']);
  assert.equal(q.status,'observed');const initial=allocation(initialAllocation),final=allocation(q.allocation);assert.deepEqual(allocation(q.initialAllocation),initial);
  assert.equal(word(q.inputStateRoot),await allocationRoot(initial));assert.equal(word(q.stateRoot),await allocationRoot(final));
  assert.equal(word(input.initialStateRoot),await allocationRoot(allocation(input.allocation)));assert.equal(input.header.stateRoot,input.initialStateRoot);
  const common=sourceContext(input,q);signedQuery(input,q,template,initial,common);
  // With no authorization and an initially code-empty sender, the signed
  // wrapper's outer nonce survives either success or message rollback.
  const sender=q.request.from;assert(final[sender]);assert.equal(final[sender].code,'0x');assert.equal(BigInt(final[sender].nonce),BigInt(initial[sender].nonce)+1n);
  // Bind the wrapper's declared STOP scaffold and nonempty fee recipient.
  for(const a of input.amendment.addresses){address(a);assert.deepEqual(initial[a],input.allocation[a]);assert.deepEqual(final[a],initial[a]);}
  const coinbase=initial[input.header.miner];assert(coinbase&&(BigInt(coinbase.nonce)>0n||coinbase.code!=='0x'));
  const receipt=logsAndReceipt(q,input.fork);await trieRoot(receipt,q.receiptsRoot);await trieRoot(bytes(q.signedBytes),q.transactionsRoot);
  const result=terminal(q),targetObserved=lifecycle(q,address(input.target));
  const isNeutral=neutral(initial,final,q.request.from,q.logs);assert.equal(bool(q.neutralExceptSenderNonce),isNeutral);
  return{...result,chargedGas:q.chargedGas,singleTransactionBlockGasUsed:q.singleTransactionBlockGasUsed,logs:structuredClone(q.logs),
    inputStateRoot:q.inputStateRoot,stateRoot:q.stateRoot,neutralExceptSenderNonce:isNeutral,
    scalar:result.returnData!==null&&/^0x[0-9a-f]{64}$/.test(result.returnData)?BigInt(result.returnData).toString():null,
    targetSelfdestructObserved:targetObserved};
}
