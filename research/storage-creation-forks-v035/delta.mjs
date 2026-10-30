// Independent full-allocation reconstruction for the eight fixed fork/rollback
// creation diagnostics. This validates delta representation, not EVM execution.
// SELFDESTRUCT, prior-query overlays and other reset families are out of scope.
import assert from 'node:assert/strict';
import {types} from 'node:util';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {allocationRoot,normalizeAllocation,bytes,hex,word} from '../amsterdam-storage-creation-v033/observations.mjs';

const SCOPE='Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const BASIS='contract_creation_storage_clear';
const EMPTY_STORAGE_ROOT='0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const ZERO=word(0),ADDRESS=/^0x[0-9a-f]{40}$/,WORD=/^0x[0-9a-f]{64}$/,DATA=/^0x(?:[0-9a-f]{2})*$/;
const UINT64=(1n<<64n)-1n,UINT256=(1n<<256n)-1n;
function object(value){assert(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype);}
function fields(value,required,optional=[]){object(value);const keys=Reflect.ownKeys(value);assert(required.every(k=>keys.includes(k)));for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);assert(typeof k==='string'&&[...required,...optional].includes(k)&&d.enumerable&&Object.hasOwn(d,'value'));}}
function array(value,max){assert(Array.isArray(value)&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max);assert.equal(Reflect.ownKeys(value).length,value.length+1);for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));assert(d?.enumerable&&Object.hasOwn(d,'value'));}}
function quantity(value,max=UINT256){assert.equal(typeof value,'string');assert.match(value,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);assert(value.length<=66);const n=BigInt(value);assert(n<=max);return n;}
function data(value,maxBytes){assert.equal(typeof value,'string');assert.match(value,DATA);assert(value.length<=2+maxBytes*2);return value;}
function storageWord(value){assert.equal(typeof value,'string');assert.match(value,WORD);return value;}
function integer(value){const n=BigInt(value);assert(n>=0n&&n<=UINT256);const s=n.toString(16);return n===0n?new Uint8Array():bytes(s.padStart(Math.ceil(s.length/2)*2,'0'));}
async function storageRoot(storage){const trie=await createMPT({useKeyHashing:true});for(const[k,v]of Object.entries(storage)){storageWord(k);storageWord(v);assert(BigInt(v)>0n);await trie.put(bytes(k),RLP.encode(integer(v)));}return hex(trie.root());}

export async function applyCandidateDelta(input,changes){
  object(input);assert(['Shanghai','Cancun','Prague','Osaka','Amsterdam'].includes(input.fork));
  assert.equal(input.chainId,input.fork==='Amsterdam'?11155111:1);
  assert.equal(typeof input.rootCreate,'boolean');assert(['success','constructor_revert','ancestor_revert'].includes(input.scenario));
  assert.equal(typeof input.target,'string');assert.match(input.target,ADDRESS);
  const out=normalizeAllocation(input.allocation),initialTarget=out[input.target];
  assert.equal(await allocationRoot(out),storageWord(input.initialStateRoot),'Full frozen prestate must match its declared root');
  assert.equal(input.header.stateRoot,input.initialStateRoot);
  const initialRoot=await storageRoot(initialTarget?.storage??{});
  assert.equal(initialRoot,storageWord(input.initialTargetStorageRoot),'Declared target root must match the full initial storage trie');
  assert(initialTarget);assert.equal(initialTarget.nonce,'0x0');assert.equal(initialTarget.code,'0x');
  assert.notEqual(initialRoot,EMPTY_STORAGE_ROOT);
  fields(changes,['scope','accounts']);assert.equal(changes.scope,SCOPE);array(changes.accounts,128);
  const seen=new Set();let slots=0;
  for(const row of changes.accounts){
    fields(row,['address'],['existence','nonce','balance','storage','code','reset']);
    assert.equal(typeof row.address,'string');assert.match(row.address,ADDRESS);assert(!seen.has(row.address));seen.add(row.address);
    assert(Object.keys(row).length>1,'Empty account delta is not meaningful');
    const before=out[row.address],a=before??{nonce:'0x0',balance:'0x0',code:'0x',storage:{}};
    if(Object.hasOwn(row,'existence')){
      fields(row.existence,['before','after','basis']);assert.equal(row.existence.before,false);assert.equal(row.existence.after,true,'Deletion is outside the eight-case diagnostic');
      assert.equal(before,undefined);assert.equal(row.reset,undefined);
      if(row.address===input.target){
        assert.equal(row.existence.basis,input.rootCreate?'top_level_contract_creation':'internal_contract_creation');
        assert(row.nonce&&row.nonce.before==='0x0'&&quantity(row.nonce.after,UINT64)>0n);
      }
      else{
        assert.equal(row.existence.basis,'positive_native_funding_of_proof_absent_account');
        assert.equal(row.nonce,undefined);assert.equal(row.code,undefined);assert.equal(row.storage,undefined);
        assert(row.balance&&row.balance.before==='0x0'&&quantity(row.balance.after)>0n);
      }
    }else assert(before,'A newly materialized account requires an explicit existence delta');
    // Validate all before values against the immutable original namespace.
    // Clearing storage must not accidentally reset prefunding, nonce or code.
    for(const field of['nonce','balance'])if(Object.hasOwn(row,field)){
      fields(row[field],['before','after']);const max=field==='nonce'?UINT64:UINT256;
      assert.equal(quantity(row[field].before,max),BigInt(a[field]));assert.notEqual(quantity(row[field].after,max),BigInt(a[field]));
    }
    if(Object.hasOwn(row,'code')){fields(row.code,['before','after']);assert.equal(data(row.code.before,131072),a.code);data(row.code.after,24576);assert.notEqual(row.code.after,row.code.before);}
    if(Object.hasOwn(row,'reset')){
      fields(row.reset,['basis','initialStorageRoot']);assert.equal(row.reset.basis,BASIS);
      assert.equal(row.address,input.target);assert(before);assert.equal(row.existence,undefined);
      assert.equal(row.reset.initialStorageRoot,initialRoot,'Reset must authenticate the original full storage trie');
      assert.notEqual(initialRoot,EMPTY_STORAGE_ROOT);assert.equal(a.nonce,'0x0');assert.equal(a.code,'0x');
      assert(row.nonce&&row.nonce.before==='0x0'&&quantity(row.nonce.after,UINT64)>0n);
      assert(!row.code||row.code.before==='0x');
    }
    const deployment=row.address===input.target&&row.nonce&&BigInt(row.nonce.after)>0n;
    if(deployment){
      assert.equal(row.nonce.before,'0x0');assert.equal(a.code,'0x');
      if(initialRoot!==EMPTY_STORAGE_ROOT)assert(row.reset,'Storage-only deployment requires explicit clear provenance');
    }
    if(Object.hasOwn(row,'storage')){
      array(row.storage,1024);assert(row.storage.length>0);const seenSlots=new Set();
      for(const s of row.storage){
        fields(s,['slot','before','after']);storageWord(s.slot);storageWord(s.before);storageWord(s.after);
        assert(!seenSlots.has(s.slot));seenSlots.add(s.slot);assert(++slots<=1024);assert.notEqual(s.before,s.after);
        if(row.reset){assert.equal(s.before,ZERO);assert.notEqual(s.after,ZERO);}
        else assert.equal(BigInt(s.before),BigInt(a.storage[s.slot]??0));
      }
    }
    // A reset's rows are the complete nonzero contents of the NEW namespace.
    // Old equal writes must survive; unmentioned old slots must disappear.
    if(row.reset)a.storage={};
    for(const field of['nonce','balance','code'])if(row[field])a[field]=row[field].after;
    for(const s of row.storage??[])if(s.after===ZERO)delete a.storage[s.slot];else a.storage[s.slot]=s.after;
    out[row.address]=a;
  }
  return normalizeAllocation(out);
}
