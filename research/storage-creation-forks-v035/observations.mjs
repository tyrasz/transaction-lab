// Saved-output validation only. No execution, subprocess, RPC or expected poststate.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {allocationRoot,normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';
import {applyCandidateDelta} from './delta.mjs';

export const CHANNELS=Object.freeze(['executionStatus','returnData','chargedGas','singleTransactionBlockGasUsed','stateRoot','target','logs']);
const hex=b=>'0x'+Buffer.from(b).toString('hex'),bytes=s=>Uint8Array.from(Buffer.from(s.slice(2),'hex'));
const address=x=>{assert.match(x,/^0x[0-9a-f]{40}$/);return x;},word=x=>{assert.match(x,/^0x[0-9a-f]{64}$/);return x;};
function data(x){assert.equal(typeof x,'string');assert.match(x,/^0x(?:[0-9a-f]{2})*$/);assert(x.length<=131074);return x;}
function decimal(x,max=(1n<<256n)-1n){assert.equal(typeof x,'string');assert.match(x,/^(?:0|[1-9][0-9]*)$/);const n=BigInt(x);assert(n<=max);return n;}
function quantity(x,max=(1n<<256n)-1n){assert.equal(typeof x,'string');assert.match(x,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);const n=BigInt(x);assert(n<=max);return n;}
function fields(x,keys){assert(x&&typeof x==='object'&&!Array.isArray(x));assert.deepEqual(Object.keys(x).sort(),[...keys].sort());}
const target=(input,allocation)=>({address:input.target,account:allocation[input.target]??null});

export async function productObservation(input,report){
  assert.equal(report.id,input.id);assert.equal(report.status,'completed');
  const a=report.attempt,o=a.output;assert.equal(a.status,'completed');
  assert(['success','reverted','failed'].includes(o.execution.status));data(o.execution.returnData);
  const chargedGas=decimal(o.gasAccounting.gasUsed,BigInt(input.request.gas)).toString();
  // Historical settlement exposes charged gas alone: for one transaction it
  // is also the block contribution. Amsterdam reports a separate block value
  // from its execution/state gas dimensions; never replace that with charged gas.
  const singleTransactionBlockGasUsed=input.fork==='Amsterdam'
    ?decimal(o.gasAccounting.singleTransactionBlockGasUsed,BigInt(input.request.gas)).toString():chargedGas;
  const allocation=await applyCandidateDelta(input,a.changes);
  return{completedExecution:true,executionStatus:o.execution.status,returnData:o.execution.returnData,
    chargedGas,singleTransactionBlockGasUsed,
    stateRoot:await allocationRoot(allocation),target:target(input,allocation),logs:o.logs,allocation};
}

export async function eelsObservation(input,out){
  assert.equal(out.status,'completed');assert.equal(out.id,input.id);assert.equal(out.fork,input.fork);
  assert.equal(out.signedBytes,input.signedBytes);assert.equal(out.transactionHash,input.transactionHash);assert.equal(out.sender,input.request.from);
  assert.deepEqual(out.envelope,input.transaction);assert.deepEqual(out.environment,input.environment);
  for(const name of['initialStateRoot','originalStateRoot','initialTargetStorageRoot'])assert.equal(out[name],input[name]);
  assert.equal(out.intrinsicGas,input.inputGas.intrinsic);assert.equal(out.calldataFloor,input.inputGas.calldataFloor);
  assert.equal(out.headerValidation,'declared_environment_only_not_full_block_validation');
  assert.equal(out.blockHashContext,'declared_parent_hash_only_no_earlier_hashes_supplied');
  assert.equal(out.scope,'one_signed_transaction_in_stock_'+input.fork+'_apply_body_with_declared_system_scaffold_and_empty_withdrawals');
  const allocation=out.allocation;assert(allocation&&typeof allocation==='object'&&!Array.isArray(allocation));assert(Object.keys(allocation).length<=64);let slots=0;
  for(const[a,row]of Object.entries(allocation)){
    address(a);fields(row,['nonce','balance','code','storage']);quantity(row.nonce,(1n<<64n)-1n);quantity(row.balance);data(row.code);
    assert(row.storage&&typeof row.storage==='object'&&!Array.isArray(row.storage));
    for(const[k,v]of Object.entries(row.storage)){word(k);word(v);assert(BigInt(v)>0n);assert(++slots<=1024);}
  }
  assert.deepEqual(normalizeAllocation(allocation),allocation);assert.equal(await allocationRoot(allocation),word(out.stateRoot));
  for(const a of input.amendment.addresses)assert.deepEqual(allocation[a],input.allocation[a]);
  assert.deepEqual({address:out.target.address,account:out.target.account},target(input,allocation));
  assert.deepEqual(out.target.storage,Object.fromEntries(input.sentinel.slots.map(s=>[s,BigInt(allocation[input.target]?.storage['0x'+BigInt(s).toString(16).padStart(64,'0')]??0).toString()])));
  assert(Array.isArray(out.storageClears)&&out.storageClears.length<=64);assert.deepEqual(out.storageClears,[...new Set(out.storageClears)].sort());out.storageClears.forEach(address);
  fields(out.receipt,['status','chargedGas','logs']);assert(['success','failed'].includes(out.receipt.status));
  const charged=decimal(out.receipt.chargedGas,BigInt(input.request.gas));
  if(input.fork==='Amsterdam'){
    const regular=decimal(out.blockExecutionGasUsed,BigInt(input.request.gas)),state=decimal(out.blockStateGasUsed,BigInt(input.request.gas));
    assert.equal(decimal(out.blockGasUsed,BigInt(input.request.gas)),regular>state?regular:state);
  }else{assert.equal(out.blockExecutionGasUsed,null);assert.equal(out.blockStateGasUsed,null);assert.equal(decimal(out.blockGasUsed,BigInt(input.request.gas)),charged);}
  const logs=out.receipt.logs;assert(Array.isArray(logs)&&logs.length<=1024);
  for(const l of logs){fields(l,['address','topics','data']);address(l.address);assert(Array.isArray(l.topics)&&l.topics.length<=4);l.topics.forEach(word);data(l.data);}
  const logRlp=logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]);
  assert.equal(hex(keccak(RLP.encode(logRlp))),word(out.logsHash));
  const bloom=Buffer.alloc(256);
  for(const l of logs)for(const v of[l.address,...l.topics]){const h=keccak(bytes(v));for(let j=0;j<6;j+=2){const n=((h[j]<<8)|h[j+1])&2047;bloom[255-(n>>3)]|=1<<(n&7);}}
  const receipt=bytes(data(out.receiptBytes));assert.equal(receipt[0],2);const decoded=RLP.decode(receipt.slice(1));assert(Array.isArray(decoded)&&decoded.length===4);
  assert.equal(hex(RLP.encode(decoded)),hex(receipt.slice(1)));assert.equal(hex(decoded[0]),out.receipt.status==='success'?'0x01':'0x');
  const gas=charged===0n?'':charged.toString(16).padStart(Math.ceil(charged.toString(16).length/2)*2,'0');
  assert.equal(hex(decoded[1]),'0x'+gas);assert.equal(hex(decoded[2]),hex(bloom));assert.deepEqual(decoded[3],logRlp);
  for(const[payload,reported]of[[receipt,out.receiptsRoot],[bytes(input.signedBytes),out.transactionsRoot]]){const trie=await createMPT({useKeyHashing:false});await trie.put(RLP.encode(new Uint8Array()),payload);assert.equal(hex(trie.root()),word(reported));}
  assert.deepEqual(out.requests,[]);assert.equal(out.transactionEndGasMeaning,'grant_minus_remaining_before_refund_and_floor');
  let executionStatus=out.receipt.status==='success'?'success':'failed',returnData=null;
  if(out.transactionEnd===null)assert.equal(out.returnDataAvailability,'unavailable_no_TransactionEnd_event');
  else{
    const t=out.transactionEnd;fields(t,['error','gasUsed','returnData']);assert.equal(out.returnDataAvailability,'official_TransactionEnd');assert.match(t.gasUsed,/^-?(?:0|[1-9][0-9]*)$/);
    returnData=data(t.returnData);assert.equal(t.error===null,out.receipt.status==='success');
    if(t.error!==null){fields(t.error,['type','message']);assert.equal(typeof t.error.type,'string');assert.equal(typeof t.error.message,'string');assert(t.error.message.length<=2048);if(t.error.type==='Revert')executionStatus='reverted';}
  }
  return{completedExecution:true,executionStatus,returnData,chargedGas:charged.toString(),singleTransactionBlockGasUsed:out.blockGasUsed,
    stateRoot:out.stateRoot,target:target(input,allocation),logs,allocation,storageClears:out.storageClears,
    blockExecutionGasUsed:out.blockExecutionGasUsed,blockStateGasUsed:out.blockStateGasUsed,transactionEnd:out.transactionEnd};
}
export function comparePair(a,b){return Object.fromEntries(CHANNELS.map(k=>[k,!a?.completedExecution||!b?.completedExecution||a[k]==null||b[k]==null?null:isDeepStrictEqual(a[k],b[k])]));}
