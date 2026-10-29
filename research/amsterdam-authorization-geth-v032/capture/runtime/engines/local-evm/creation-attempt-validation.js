// Parent-side chronological consistency checks for Amsterdam's actual creator
// nonce-write observations. This is not opcode/memory replay or an independent
// execution proof. Inputs and a query's starting overlay are separately bound
// by the enclosing parent before these observations can authorize a result.
import { types, isDeepStrictEqual } from 'node:util';
import { createAddressFromString, createContractAddress, createContractAddress2 } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { canonicalStateChanges } from './preview-mutations.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from './verified-state-proof.js';
import { existingDelegationTarget } from './sender-delegation.js';

const ADDRESS=/^0x[0-9a-f]{40}$/, WORD=/^0x[0-9a-f]{64}$/, DATA=/^0x(?:[0-9a-f]{2})*$/;
const UINT64=(1n<<64n)-1n, UINT256=(1n<<256n)-1n;
const need=x=>{if(!x)throw Error('Creation attempts do not match their authenticated starting state and chronological trace.');};
const hex=n=>'0x'+n.toString(16), bytes=x=>Uint8Array.from(Buffer.from(x.slice(2),'hex'));
const codeHash=code=>'0x'+Buffer.from(keccak_256(bytes(code))).toString('hex');
function record(value,keys){
  need(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const own=Reflect.ownKeys(value);need(own.length===keys.length&&keys.every(k=>own.includes(k)));
  for(const key of own){const d=Object.getOwnPropertyDescriptor(value,key);need(typeof key==='string'&&d.enumerable&&Object.hasOwn(d,'value'));}
}
function read(value,key){
  need(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const d=Object.getOwnPropertyDescriptor(value,key);need(d?.enumerable&&Object.hasOwn(d,'value'));return d.value;
}
function array(value,max){
  need(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max&&Reflect.ownKeys(value).length===value.length+1);
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));need(d?.enumerable&&Object.hasOwn(d,'value'));}
}
function quantity(value,max=UINT256){need(typeof value==='string'&&value.length<=66&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value));const n=BigInt(value);need(n<=max);return n;}
function data(value,max){need(typeof value==='string'&&DATA.test(value)&&value.length<=2+max*2);return value;}
const address=value=>{need(typeof value==='string'&&ADDRESS.test(value));return value;};
const clone=map=>new Map([...map].map(([key,value])=>[key,{...value}]));

export function validateCreationAttempts({output,inputs,startingChanges,rootNoncePrepared=false,fees=null,common}) {
  need(common?.isActivatedEIP(7928)===true&&[1n,11155111n].includes(common.chainId()));
  need(typeof rootNoncePrepared==='boolean');
  const root=read(output,'trace'), sender=address(read(root,'from'));
  const prior=new Map(startingChanges?canonicalStateChanges(startingChanges).accounts.map(row=>[row.address,row]):[]);
  const proofs=new Map((inputs.provenance??[]).map(row=>[row.account,row.accountProof]));
  let state=new Map(), counts=new Map(), frameCount=0, attemptCount=0;
  function account(key){
    address(key);
    if(!state.has(key)){
      const fact=inputs.accounts?.[key], proof=proofs.get(key);need(fact&&typeof fact.exists==='boolean'&&proof&&proof.exists===fact.exists);
      need(typeof proof.storageRoot==='string'&&WORD.test(proof.storageRoot));
      const code=fact.exists?data(fact.code,131072):'0x',nonce=fact.exists?BigInt(fact.nonce):0n,balance=fact.exists?BigInt(fact.balance):0n;
      need(nonce>=0n&&nonce<=UINT64&&balance>=0n&&balance<=UINT256&&codeHash(code)===proof.codeHash);
      let current={exists:fact.exists,nonce,balance,code,storageRoot:proof.storageRoot};
      const row=prior.get(key);
      if(row?.existence?.after===false)current={exists:false,nonce:0n,balance:0n,code:'0x',storageRoot:EMPTY_STORAGE_ROOT};
      else if(row){
        if(row.existence)current.exists=row.existence.after;
        if(row.nonce)current.nonce=BigInt(row.nonce.after);
        if(row.balance)current.balance=BigInt(row.balance.after);
        if(row.code)current.code=row.code.after;
        if(row.reset){need(row.reset.initialStorageRoot===proof.storageRoot);current.storageRoot=EMPTY_STORAGE_ROOT;}
      }
      state.set(key,current);
    }
    return state.get(key);
  }
  function transfer(from,to,value){
    const source=account(from),target=account(to);need(value<=source.balance);
    if(from!==to){need(target.balance+value<=UINT256);source.balance-=value;target.balance+=value;if(value>0n)target.exists=true;}
  }
  function currentCode(frame){
    if(['CREATE','CREATE2'].includes(frame.type))return data(frame.input,32768);
    let code=account(frame.to).code;
    const delegation=existingDelegationTarget(code,common);
    if(delegation!==null)code=account(delegation).code; // The pinned EVM resolves one designation.
    return code;
  }
  function opcode(code,pc,type){
    const codeBytes=bytes(code);need(pc<BigInt(codeBytes.length));const target=Number(pc);
    let at=0;while(at<target){const op=codeBytes[at++];if(op>=0x60&&op<=0x7f)at+=op-0x5f;}
    need(at===target&&codeBytes[target]===(type==='CREATE'?0xf0:0xf5));
  }
  function walk(frame,parent=null,depth=0,inheritedStatic=false){
    need(++frameCount<=1000&&depth<=32);
    for(const key of ['calls','creationAttempts','type','depth','error','from','caller','to','executionAddress','input','output','value'])read(frame,key);
    array(frame.calls,1000);array(frame.creationAttempts,1000);
    need(['CALL','CALLCODE','DELEGATECALL','STATICCALL','CREATE','CREATE2'].includes(frame.type)&&frame.depth===depth);
    const creation=['CREATE','CREATE2'].includes(frame.type),isStatic=inheritedStatic||frame.type==='STATICCALL';
    const value=quantity(frame.value);data(frame.input,32768);data(frame.output,1048576);
    need(frame.error===null||(typeof frame.error==='string'&&frame.error.length>0));address(frame.from);address(frame.caller);
    if(parent){need(frame.from===parent.executionAddress);need(frame.caller===(frame.type==='DELEGATECALL'?parent.caller:parent.executionAddress));
      if(frame.type==='DELEGATECALL')need(frame.value===parent.value);}
    else need(frame.from===frame.caller);
    if(creation){need(frame.to===frame.executionAddress);need(frame.to===null&&frame.error!==null||typeof frame.to==='string'&&ADDRESS.test(frame.to));}
    else {address(frame.to);need(frame.executionAddress===(['DELEGATECALL','CALLCODE'].includes(frame.type)?parent?.executionAddress:frame.to));}
    if(isStatic){need(!creation&&frame.creationAttempts.length===0);if(['CALL','STATICCALL'].includes(frame.type))need(value===0n);}
    // CALLCODE checks affordability before entering its child, even though it
    // retains the parent's execution account and transfers no native value.
    if(frame.type==='CALLCODE')need(value<=account(frame.executionAddress).balance);
    const saved=clone(state),savedCounts=new Map(counts);
    // No entered body or descendants: a pre-execution failure need not have
    // loaded its destination, transferred value, or initialized a constructor.
    if(frame.error!==null&&frame.creationAttempts.length===0&&frame.calls.length===0)return;
    if(creation){
      const target=account(frame.executionAddress);need(target.nonce===0n&&target.code==='0x'&&target.storageRoot===EMPTY_STORAGE_ROOT);
      target.exists=true;target.nonce=1n;
    }
    if(!['DELEGATECALL','CALLCODE','STATICCALL'].includes(frame.type))transfer(frame.from,frame.executionAddress,value);
    // Runtime is fixed when this frame enters, including delegated execution.
    const code=frame.creationAttempts.length?currentCode(frame):null;
    let cursor=0;
    for(const entry of frame.creationAttempts){
      need(++attemptCount<=1000);record(entry,['position','type','pc','nonceBefore','nonceAfter','value','input','salt','target','targetBefore','disposition','result']);
      need(Number.isSafeInteger(entry.position)&&entry.position>=cursor&&entry.position<=frame.calls.length);
      need(['CREATE','CREATE2'].includes(entry.type));need(Number.isSafeInteger(entry.pc)&&entry.pc>=0);const pc=BigInt(entry.pc),before=quantity(entry.nonceBefore,UINT64),after=quantity(entry.nonceAfter,UINT64);
      const endowment=quantity(entry.value),result=quantity(entry.result);data(entry.input,32768);address(entry.target);
      need(entry.type==='CREATE'?entry.salt===null:typeof entry.salt==='string'&&WORD.test(entry.salt));
      need(['entered','collision'].includes(entry.disposition));record(entry.targetBefore,['exists','nonce','codeHash','storageRoot']);
      need(typeof entry.targetBefore.exists==='boolean');quantity(entry.targetBefore.nonce,UINT64);
      need(typeof entry.targetBefore.codeHash==='string'&&WORD.test(entry.targetBefore.codeHash)&&typeof entry.targetBefore.storageRoot==='string'&&WORD.test(entry.targetBefore.storageRoot));
      opcode(code,pc,entry.type);
      while(cursor<entry.position){const child=frame.calls[cursor++];need(!['CREATE','CREATE2'].includes(read(child,'type')));walk(child,frame,depth+1,isStatic);}
      const creator=account(frame.executionAddress);need(creator.exists&&creator.nonce===before&&before<UINT64&&after===before+1n&&endowment<=creator.balance);
      const target=entry.type==='CREATE'?createContractAddress(createAddressFromString(frame.executionAddress),before).toString():createContractAddress2(createAddressFromString(frame.executionAddress),bytes(entry.salt),bytes(entry.input)).toString();
      need(entry.target===target);creator.nonce=after;counts.set(frame.executionAddress,(counts.get(frame.executionAddress)??0)+1);
      const current=account(target);
      need(isDeepStrictEqual(entry.targetBefore,{exists:current.exists,nonce:hex(current.nonce),codeHash:codeHash(current.code),storageRoot:current.storageRoot}));
      if(entry.disposition==='collision'){
        // A known current nonce/code suffices. A storage-root-only collision
        // remains outside this bounded observation contract.
        need(current.exists&&(current.nonce>0n||current.code!=='0x')&&result===0n);
      } else {
        need(current.nonce===0n&&current.code==='0x'&&current.storageRoot===EMPTY_STORAGE_ROOT&&cursor<frame.calls.length);
        const child=frame.calls[cursor++];
        for(const key of ['type','from','input','value','to','executionAddress','error'])read(child,key);
        need(child.type===entry.type&&child.from===frame.executionAddress&&child.input===entry.input&&child.value===entry.value);
        need(child.to===target&&child.executionAddress===target||child.error!==null&&child.to===null&&child.executionAddress===null);
        need(result===(child.error===null?BigInt(target):0n));walk(child,frame,depth+1,isStatic);
      }
    }
    while(cursor<frame.calls.length){const child=frame.calls[cursor++];need(!['CREATE','CREATE2'].includes(read(child,'type')));walk(child,frame,depth+1,isStatic);}
    if(frame.error===null){
      if(creation){const target=account(frame.executionAddress);target.code=frame.output;}
      const sd=Object.getOwnPropertyDescriptor(frame,'selfdestruct');
      if(sd){need(sd.enumerable&&Object.hasOwn(sd,'value')&&!isStatic);record(sd.value,['beneficiary']);address(sd.value.beneficiary);
        if(sd.value.beneficiary!==frame.executionAddress)transfer(frame.executionAddress,sd.value.beneficiary,account(frame.executionAddress).balance);
      }
    }else{state=saved;counts=savedCounts;}
  }
  const caller=account(sender);
  if(rootNoncePrepared){
    // Only the enclosing parent's independently reconstructed authorization
    // preparation may select this path. Its overlay contains nonce/code
    // preparation, never fee debits or message writes. Fees remain applied
    // exactly once below, and the prepared outer nonce must not advance again.
    const row=prior.get(sender),initial=inputs.accounts[sender];
    const initialNonce=initial.exists?BigInt(initial.nonce):0n;
    need(row?.nonce&&initialNonce<UINT64&&BigInt(row.nonce.before)===initialNonce&&
      caller.exists&&caller.nonce>initialNonce&&BigInt(row.nonce.after)===caller.nonce);
    need([...prior.values()].every(item=>item.balance===undefined&&item.storage===undefined&&item.reset===undefined));
  }else{need(caller.nonce<UINT64);caller.nonce++;caller.exists=true;}
  if(fees){const debit=fees.plan.totalUpfrontDebit??fees.plan.upfrontGasDebit;need(caller.balance>=debit);caller.balance-=debit;}
  walk(root);
  return counts;
}
