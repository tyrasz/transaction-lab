// Read-only reconstruction and observations, not an oracle or winner selector.
import assert from 'node:assert/strict';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
export const bytes=h=>Uint8Array.from(Buffer.from(h.replace(/^0x/,''),'hex')),hex=b=>'0x'+Buffer.from(b).toString('hex');
export const q=v=>'0x'+BigInt(v).toString(16),word=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
export const completedExecution=o=>!!o&&o.completedExecution===true&&['success','reverted','failed'].includes(o.executionStatus);
const int=v=>{const n=BigInt(v);assert(n>=0n&&n<2n**256n);return n===0n?new Uint8Array():bytes(n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));};
function address(v){assert.equal(typeof v,'string');const a=v.startsWith('0x')?v:'0x'+v;assert.match(a,/^0x[0-9a-f]{40}$/);return a;}
function quantity(v,max=2n**256n-1n){assert.equal(typeof v,'string');assert.match(v,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);const n=BigInt(v);assert(n<=max);return n;}
function data(v,wordOnly=false){assert.equal(typeof v,'string');assert.match(v,wordOnly?/^0x[0-9a-f]{64}$/:/^0x(?:[0-9a-f]{2})*$/);return v;}
export function normalizeAllocation(input){const out={};for(const[a,row]of Object.entries(input)){const key=address(a);assert(!Object.hasOwn(out,key));assert.match(row.code??'0x',/^0x(?:[0-9a-f]{2})*$/);const storage={};
 for(const[k,v]of Object.entries(row.storage??{})){const slot=k.startsWith('0x')?BigInt(k):BigInt('0x'+k);assert(slot>=0n&&slot<2n**256n);assert(BigInt(v)>=0n&&BigInt(v)<2n**256n);if(BigInt(v)!==0n)storage[word(slot)]=word(v);}
 out[key]={nonce:q(row.nonce??0),balance:q(row.balance??0),code:row.code??'0x',storage};}return out;}
export async function allocationRoot(input){const alloc=normalizeAllocation(input),state=await createMPT({useKeyHashing:true});for(const[a,row]of Object.entries(alloc)){const storage=await createMPT({useKeyHashing:true});
 for(const[k,v]of Object.entries(row.storage))await storage.put(bytes(k),RLP.encode(int(v)));
 await state.put(bytes(a),RLP.encode([int(row.nonce),int(row.balance),storage.root(),keccak(bytes(row.code))]));}return hex(state.root());}
export function applyDelta(input,changes){const out=normalizeAllocation(input),seen=new Set();assert(Array.isArray(changes.accounts));for(const row of changes.accounts){address(row.address);assert(!seen.has(row.address));seen.add(row.address);assert.equal(row.reset,undefined);
 const before=out[row.address],a=before??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};if(row.existence)assert.equal(row.existence.before,!!before);
 for(const field of['nonce','balance'])if(row[field])assert.equal(BigInt(row[field].before),BigInt(a[field]));if(row.code)assert.equal(row.code.before,a.code);
 for(const s of row.storage??[])assert.equal(BigInt(s.before),BigInt(a.storage[word(s.slot)]??0));
 if(row.existence?.after===false){delete out[row.address];continue;}for(const field of['nonce','balance','code'])if(row[field])a[field]=row[field].after;
 for(const s of row.storage??[])if(BigInt(s.after)===0n)delete a.storage[word(s.slot)];else a.storage[word(s.slot)]=word(s.after);out[row.address]=a;}return normalizeAllocation(out);}
export function targetObservation(input,allocation){const a=normalizeAllocation(allocation)[input.target];return{exists:!!a,nonce:a?BigInt(a.nonce).toString():null,balance:a?BigInt(a.balance).toString():null,code:a?.code??null,
 slots:Object.fromEntries(input.sentinel.slots.map(k=>[k,a?BigInt(a.storage[word(k)]??0).toString():null]))};}
export function behavior(input,target){if(!target)return null;if(target.code!==input.sentinel.runtime)return'not_deployed';
 if(input.collision!=='storage')return'deployed_control';
 if(target.slots['0']==='999'&&target.slots['1']==='123456'&&target.slots['2']==='42'&&target.slots['991']==='123456')return'deployed_preserving_initial_storage';
 if(target.slots['0']==='0'&&target.slots['1']==='0'&&target.slots['2']==='42'&&target.slots['991']==='0')return'deployed_clearing_initial_storage';return'other_deployed_state';}
export function compareObservations(observations){const fields=['executionStatus','returnData','gasUsed','singleTransactionBlockGasUsed','stateRoot','target','logs'];const pairs={};
 for(const[a,b]of[['product','ethereumjs'],['product','geth'],['ethereumjs','geth']]){const x=observations[a],y=observations[b];pairs[a+'_'+b]=Object.fromEntries(fields.map(k=>[k,!completedExecution(x)||!completedExecution(y)||x[k]==null||y[k]==null?null:JSON.stringify(x[k])===JSON.stringify(y[k])]));}return pairs;}
export function parseTrace(raw,input){assert(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=4194304);const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(text.endsWith('\n'));const lines=text.slice(0,-1).split('\n');assert(lines.length<=100000);
 const stack=[];let root=null,first=null,frames=0,steps=0;
 for(const [i,line]of lines.entries()){assert(line.length>0&&root===null);const e=JSON.parse(line);assert(e&&typeof e==='object'&&!Array.isArray(e));
  if(Object.hasOwn(e,'type')){assert(['CALL','CALLCODE','DELEGATECALL','STATICCALL','CREATE','CREATE2','SELFDESTRUCT'].includes(e.type));address(e.from);address(e.to);quantity(e.gas,2n**64n-1n);data(e.input??'0x');
   if(stack.length===0){assert.equal(i,0);assert.equal(e.type,input.rootCreate?'CREATE':'CALL');assert.equal(e.from,input.request.from);assert.equal(e.to,input.rootCreate?input.target:input.request.to);assert.equal(e.input??'0x',input.request.data);assert.equal(quantity(e.value),BigInt(input.request.value));assert.equal(BigInt(e.gas),BigInt(input.inputGas.gethRootGas));first=e;}
   stack.push(e);assert(stack.length<=1025);frames++;
  }else if(Object.hasOwn(e,'output')){assert(stack.length>0);assert.match(e.output,/^(?:[0-9a-f]{2})*$/);assert(e.error===undefined||e.error===null||typeof e.error==='string'&&e.error.length>0&&e.error.length<=512);assert(quantity(e.gasUsed,2n**64n-1n)<=BigInt(stack.pop().gas));if(stack.length===0){assert.equal(i,lines.length-1);root={returnData:'0x'+e.output,executionGasUsed:BigInt(e.gasUsed).toString(),error:e.error??null};}
  }else{assert(stack.length>0);assert(Number.isSafeInteger(e.pc)&&e.pc>=0);assert(Number.isSafeInteger(e.op)&&e.op>=0&&e.op<=255);assert.equal(e.depth,stack.length);assert(Array.isArray(e.stack)&&e.stack.length<=1024);steps++;}
 }assert(root&&first&&stack.length===0);return{...root,rootGas:BigInt(first.gas).toString(),frames,steps};}
export async function gethObservation(input,outputs){const r=outputs.result;assert(r.rejected===undefined||Array.isArray(r.rejected)&&r.rejected.length===0);assert(Array.isArray(r.receipts)&&r.receipts.length===1);assert.equal(outputs.body,input.transactionBody);
 const receipt=r.receipts[0];assert.equal(quantity(receipt.type),2n);assert.equal(receipt.transactionHash,input.transactionHash);assert.equal(quantity(receipt.transactionIndex),0n);assert.equal(quantity(receipt.blockNumber),BigInt(input.header.number));assert.deepEqual(r.requests,[]);assert.equal(quantity(r.blobGasUsed),0n);assert.equal(quantity(r.currentBaseFee),BigInt(input.header.baseFeePerGas));data(r.stateRoot,true);data(r.logsHash,true);quantity(r.gasUsed,BigInt(input.request.gas));
 const allocation=normalizeAllocation(outputs.allocation),root=await allocationRoot(allocation);assert.equal(root,r.stateRoot);
 for(const a of input.amendment.addresses)assert.deepEqual(allocation[a],input.allocation[a]);
 const trace=parseTrace(outputs.trace,input),status=quantity(receipt.status);assert(status===0n||status===1n);assert.equal(status===1n,trace.error===null);assert.equal(quantity(receipt.gasUsed,BigInt(input.request.gas)),quantity(receipt.cumulativeGasUsed));assert(Array.isArray(receipt.logs)&&receipt.logs.length<=1024);
 const logs=receipt.logs.map((l,i)=>{assert.equal(address(l.address),l.address);assert(Array.isArray(l.topics)&&l.topics.length<=4);for(const t of l.topics)data(t,true);data(l.data);assert.equal(l.transactionHash,input.transactionHash);assert.equal(quantity(l.logIndex),BigInt(i));assert.equal(quantity(l.transactionIndex),0n);assert.equal(quantity(l.blockNumber),BigInt(input.header.number));return{address:l.address,topics:l.topics,data:l.data};});
 assert.equal(hex(keccak(RLP.encode(logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)])))),r.logsHash);
 const target=targetObservation(input,allocation);return{completedExecution:true,allocation,stateRoot:root,executionStatus:trace.error==='execution reverted'?'reverted':trace.error?'failed':'success',executionError:trace.error,returnData:trace.returnData,
  gasUsed:BigInt(receipt.gasUsed).toString(),executionGasUsed:trace.executionGasUsed,preRefundGasWithFloor:null,singleTransactionBlockGasUsed:BigInt(r.gasUsed).toString(),regularGasUsed:null,stateGasUsed:null,
  target,targetBehavior:behavior(input,target),logs,trace};}
