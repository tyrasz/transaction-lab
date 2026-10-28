import test from 'node:test';
import assert from 'node:assert/strict';
import { EVM_CONTEXT_LIMITS, normalizeEvmContext, rpcEvmContext } from '../engines/evm-context.js';
const address='0x'+'ab'.repeat(20), key='0x'+'cd'.repeat(32), hash='0x01'+'ef'.repeat(31);
test('optional context preserves absence, empty access lists, ordered duplicates and detached lowercase bytes',()=>{
 assert.deepEqual(normalizeEvmContext({from:address}),{}); assert.deepEqual(rpcEvmContext({}),{});
 assert.deepEqual(normalizeEvmContext({accessList:[]}),{accessList:[]});
 const input={accessList:[{address:address.toUpperCase(),storageKeys:[key,key]},{address,storageKeys:[]}],blobVersionedHashes:[hash,hash]};
 const out=normalizeEvmContext(input); assert.deepEqual(out,{accessList:[{address,storageKeys:[key,key]},{address,storageKeys:[]}],blobVersionedHashes:[hash,hash]});
 input.accessList[0].storageKeys[0]='changed';assert.equal(out.accessList[0].storageKeys[0],key);assert(Object.isFrozen(out.accessList[0].storageKeys));
 assert.deepEqual(rpcEvmContext({blobVersionedHashes:[hash]}),{blobVersionedHashes:[hash],maxFeePerBlobGas:'0x0'});
});
test('fixed occurrence limits include duplicate addresses and total slots across entries',()=>{
 assert.equal(normalizeEvmContext({accessList:Array.from({length:128},()=>({address,storageKeys:[]}))}).accessList.length,128);
 assert.equal(normalizeEvmContext({accessList:[{address,storageKeys:Array(1024).fill(key)}]}).accessList[0].storageKeys.length,1024);
 assert.equal(normalizeEvmContext({blobVersionedHashes:Array(32).fill(hash)}).blobVersionedHashes.length,32);
 for(const value of [{accessList:Array.from({length:129},()=>({address,storageKeys:[]}))},{accessList:[{address,storageKeys:Array(1024).fill(key)},{address,storageKeys:[key]}]},{blobVersionedHashes:Array(33).fill(hash)}])assert.throws(()=>normalizeEvmContext(value),{code:'EVM_CONTEXT_INVALID'});
 assert.deepEqual(EVM_CONTEXT_LIMITS,{accessListEntries:128,storageKeys:1024,blobVersionedHashes:32});
});
test('strict records, dense arrays, byte lengths and hash version reject ambiguous input without invoking accessors',()=>{
 let called=0;const getter={get accessList(){called++;return[];}};
 const accessorArray=[];Object.defineProperty(accessorArray,'0',{get(){called++;return hash;},enumerable:true});
 const extra=[];extra.label='x'; const hidden={};Object.defineProperty(hidden,'accessList',{value:[]});
 for(const input of [null,[],Object.create(null),new Proxy({},{}),getter,hidden,{accessList:undefined},{accessList:[{address,storageKeys:[],extra:0}]},{accessList:[{address:'0x1',storageKeys:[]}]},{accessList:[{address,storageKeys:[key.slice(0,-2)]}]},{accessList:new Array(1)},{accessList:extra},{blobVersionedHashes:[]},{blobVersionedHashes:accessorArray},{blobVersionedHashes:['0x02'+hash.slice(4)]},{blobVersionedHashes:[hash+'00']},{blobVersionedHashes:[123]}])assert.throws(()=>normalizeEvmContext(input),{code:'EVM_CONTEXT_INVALID'});
 assert.equal(called,0);
});
