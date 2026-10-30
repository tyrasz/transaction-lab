// Full-allocation reconstruction, not another execution or lifecycle oracle.
// Original and cumulative query snapshots both use the GLOBAL initial state.
// Lifecycle/trace validation belongs to the product parent; this adapter checks
// representation and authenticated before-values without predicting an outcome.
import assert from 'node:assert/strict';
import {types} from 'node:util';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {allocationRoot,bytes,hex,word} from '../amsterdam-storage-creation-v033/observations.mjs';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const CREATION='contract_creation_storage_clear';
const CLEARING='same_invocation_created_contract_clearing_eip8246';
const SHANGHAI='shanghai_selfdestruct_deletion';
const DELETION='same_invocation_created_contract_deletion';
const FUNDING='positive_native_funding_of_proof_absent_account';
const EMPTY='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const ZERO=word(0),ADDRESS=/^0x[0-9a-f]{40}$/,WORD=/^0x[0-9a-f]{64}$/,DATA=/^0x(?:[0-9a-f]{2})*$/;
const UINT64=(1n<<64n)-1n,UINT256=(1n<<256n)-1n;
function object(value){
  assert(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype);
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);assert(typeof key==='string'&&d.enumerable&&Object.hasOwn(d,'value'));}
}
function fields(value,required,optional=[]){object(value);const keys=Object.keys(value);assert(required.every(k=>keys.includes(k)));assert(keys.every(k=>required.includes(k)||optional.includes(k)));}
function array(value,max){assert(Array.isArray(value)&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max);assert.equal(Reflect.ownKeys(value).length,value.length+1);for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));assert(d?.enumerable&&Object.hasOwn(d,'value'));}}
function address(value){assert.equal(typeof value,'string');assert.match(value,ADDRESS);return value;}
function storageWord(value){assert.equal(typeof value,'string');assert.match(value,WORD);return value;}
function quantity(value,max=UINT256){assert.equal(typeof value,'string');assert(value.length<=66);assert.match(value,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);const n=BigInt(value);assert(n<=max);return n;}
function data(value,maxBytes){assert.equal(typeof value,'string');assert(value.length<=2+maxBytes*2);assert.match(value,DATA);return value;}
function integer(value){const n=BigInt(value),s=n.toString(16);return n===0n?new Uint8Array():bytes(s.padStart(Math.ceil(s.length/2)*2,'0'));}
async function storageRoot(storage){const trie=await createMPT({useKeyHashing:true});for(const[k,v]of Object.entries(storage))await trie.put(bytes(k),RLP.encode(integer(v)));return hex(trie.root());}
function allocation(input){
  object(input);assert(Object.keys(input).length<=64);const out={};let slots=0;
  for(const [key,row]of Object.entries(input)){
    address(key);fields(row,['nonce','balance','code','storage']);quantity(row.nonce,UINT64);quantity(row.balance);data(row.code,131072);object(row.storage);
    const storage={};for(const[k,v]of Object.entries(row.storage)){storageWord(k);storageWord(v);assert(BigInt(v)>0n&&++slots<=1024);storage[k]=v;}
    out[key]={nonce:row.nonce,balance:row.balance,code:row.code,storage};
  }return out;
}

export async function applyCandidateDelta(input,changes){
  object(input);assert(['Shanghai','Osaka','Amsterdam'].includes(input.fork));assert.equal(input.chainId,input.fork==='Amsterdam'?11155111:1);
  object(input.header);address(input.target);
  const initial=allocation(input.allocation);
  assert.equal(await allocationRoot(initial),storageWord(input.initialStateRoot),'Full global initial allocation root differs');
  assert.equal(input.header.stateRoot,input.initialStateRoot,'Header and global initial state differ');
  const roots=new Map([[input.target,storageWord(input.initialTargetStorageRoot)]]);
  if(input.queryCreation!==null){
    fields(input.queryCreation,['creator','target','nonce','salt','initcode','initialStorageRoot']);
    const q=input.queryCreation;address(q.creator);address(q.target);assert.notEqual(q.target,input.target);storageWord(q.salt);data(q.initcode,32768);
    assert.equal(typeof q.nonce,'string');assert.match(q.nonce,/^(?:0|[1-9][0-9]*)$/);assert(BigInt(q.nonce)<=UINT64);
    roots.set(q.target,storageWord(q.initialStorageRoot));
  }
  for(const [target,root]of roots){
    const a=initial[target];assert(a,'Declared creation target must exist in the global initial allocation');assert.equal(a.nonce,'0x0');assert.equal(a.code,'0x');
    assert.notEqual(root,EMPTY);assert.equal(await storageRoot(a.storage),root,'Declared target root differs from its complete initial storage');
  }
  fields(changes,['scope','accounts']);assert.equal(changes.scope,SCOPE);array(changes.accounts,128);
  const out=structuredClone(initial),seen=new Set();let slots=0;
  for(const row of changes.accounts){
    fields(row,['address'],['existence','nonce','balance','storage','code','reset']);address(row.address);assert(!seen.has(row.address));seen.add(row.address);
    assert(Object.keys(row).length>1,'Empty account delta');
    const before=initial[row.address],a=before?structuredClone(before):{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};
    for(const field of ['nonce','balance'])if(Object.hasOwn(row,field)){
      fields(row[field],['before','after']);const max=field==='nonce'?UINT64:UINT256;
      assert.equal(quantity(row[field].before,max),BigInt(a[field]),'Before value must use the global initial account');
      assert.notEqual(quantity(row[field].after,max),BigInt(a[field]),'No-op account field');
    }
    if(Object.hasOwn(row,'code')){fields(row.code,['before','after']);assert.equal(data(row.code.before,131072),a.code);data(row.code.after,24576);assert.notEqual(row.code.before,row.code.after);}
    if(Object.hasOwn(row,'existence')){
      fields(row.existence,['before','after','basis']);assert.equal(row.existence.before,Boolean(before));assert.equal(typeof row.existence.after,'boolean');assert.notEqual(row.existence.before,row.existence.after);assert.equal(row.reset,undefined);
      if(row.existence.after===false){
        assert(roots.has(row.address),'Whole-account finalization is limited to declared creation targets');
        assert.equal(row.existence.basis,input.fork==='Shanghai'?SHANGHAI:input.fork==='Amsterdam'?CLEARING:DELETION);
        assert.equal(row.nonce,undefined);assert.equal(row.code,undefined);assert.equal(row.storage,undefined);
        if(BigInt(a.balance)>0n)assert.deepEqual(row.balance,{before:a.balance,after:'0x0'});else assert.equal(row.balance,undefined);
        // Whole deletion includes hidden storage and any earlier fee credit.
        // Do not add a coinbase credit again after applying this final snapshot.
        delete out[row.address];continue;
      }
      assert.equal(row.existence.basis,FUNDING);assert.equal(row.nonce,undefined);assert.equal(row.code,undefined);assert.equal(row.storage,undefined);
      assert(row.balance&&row.balance.before==='0x0'&&BigInt(row.balance.after)>0n);
    }else assert(before,'Materialization needs explicit existence provenance');

    if(Object.hasOwn(row,'reset')){
      fields(row.reset,['basis','initialStorageRoot']);assert(roots.has(row.address),'Reset target was not declared');
      assert.equal(storageWord(row.reset.initialStorageRoot),roots.get(row.address),'Reset must bind the global initial storage root');
      assert(before);assert.equal(row.existence,undefined);
      if(row.reset.basis===CREATION){
        assert(row.nonce&&row.nonce.before==='0x0'&&BigInt(row.nonce.after)>0n);
        assert(!row.code||row.code.before==='0x');
      }else{
        assert.equal(row.reset.basis,CLEARING);assert.equal(input.fork,'Amsterdam');
        // T and Q initially have nonce zero and empty code. Final clearing
        // restores those fields, so no net nonce/code delta is representable.
        assert.equal(row.nonce,undefined);assert.equal(row.code,undefined);assert.equal(row.storage,undefined);
        assert(BigInt(row.balance?.after??a.balance)>0n,'Zero-balance final clearing must remove the account');
      }
    }
    if(roots.has(row.address)&&(row.code||(row.nonce&&BigInt(row.nonce.after)>0n)))assert.equal(row.reset?.basis,CREATION,'Storage-only deployment needs explicit creation clearing');
    if(row.code)assert(roots.has(row.address)&&row.reset?.basis===CREATION,'Code changes outside declared creation are not part of this matrix');
    if(Object.hasOwn(row,'storage')){
      array(row.storage,1024);assert(row.storage.length>0);const seenSlots=new Set();
      for(const s of row.storage){
        fields(s,['slot','before','after']);storageWord(s.slot);storageWord(s.before);storageWord(s.after);
        assert(++slots<=1024&&!seenSlots.has(s.slot));seenSlots.add(s.slot);assert.notEqual(s.before,s.after);
        if(row.reset){assert.equal(s.before,ZERO);assert.notEqual(s.after,ZERO);}
        else assert.equal(s.before,a.storage[s.slot]??ZERO,'Storage before-value must use the global initial namespace');
      }
    }
    // Reset rows enumerate all nonzero new-namespace writes, including values
    // equal to old storage. No reset means a sparse diff against the old trie.
    if(row.reset)a.storage={};
    for(const field of ['nonce','balance','code'])if(row[field])a[field]=row[field].after;
    for(const s of row.storage??[])if(s.after===ZERO)delete a.storage[s.slot];else a.storage[s.slot]=s.after;
    out[row.address]=a;
  }
  return out;
}
