// Pure post-execution comparison. This module cannot modify state, execute a
// call or obtain missing inputs. Provider outputs enter only this final stage.
import { isDeepStrictEqual } from 'node:util';

const ADDRESS=/^0x[0-9a-f]{40}$/i, WORD=/^0x[0-9a-f]{64}$/i, BYTES=/^0x(?:[0-9a-f]{2})*$/i;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x), ZERO='0x'+'0'.repeat(64);
const MAX=(1n<<256n)-1n, LIMITS={frames:1000,depth:32,logs:2000,accounts:128,slots:8192,bytes:8*1024*1024};
class Incomplete extends Error {}
function need(ok,message){if(!ok)throw new Incomplete(message);}
function uint(x,max=MAX){need((typeof x==='string'&&x.length<=80&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(x))||(Number.isSafeInteger(x)&&x>=0),'Malformed unsigned comparison quantity.');const n=BigInt(x);need(n>=0n&&n<=max,'Comparison quantity exceeds its bound.');return n;}
function addr(x){need(typeof x==='string'&&ADDRESS.test(x),'Malformed comparison address.');return x.toLowerCase();}
function bytes(x){need(typeof x==='string'&&BYTES.test(x),'Malformed comparison byte string.');return x.toLowerCase();}
function word(x){need(typeof x==='string'&&WORD.test(x),'Malformed comparison storage/topic word.');return x.toLowerCase();}
function bounded(x){need(Buffer.byteLength(JSON.stringify(x))<=LIMITS.bytes,'Comparison evidence exceeds its byte bound.');}
function failure(value){if(value===undefined||value===null)return null;need(typeof value==='string'&&value.length>0&&value.length<=2000,'Malformed comparison failure field.');return ['revert','execution reverted'].includes(value)?'revert':value;}
function frameError(frame){const error=failure(frame.error);if(frame.revertReason!==undefined){need(typeof frame.revertReason==='string'&&frame.revertReason.length<=2000,'Malformed revert reason.');need(!frame.revertReason||error!==null,'A nonempty revert reason contradicts successful frame evidence.');}return error;}
function result(expected,actual){return isDeepStrictEqual(expected,actual)?{status:'matched'}:{status:'diverged',expected,actual};}
function checked(fn){try{return fn();}catch(error){return {status:'unavailable',reason:error instanceof Incomplete?error.message:'Comparison evidence is malformed or unsupported.'};}}
const unavailable=reason=>({status:'unavailable',reason});
function inputAccount(inputs,address){const value=inputs.accounts?.[address];need(value?.exists===true,'Comparison requires an explicit existing input account.');return value;}

function intrinsic(data){const s=bytes(data);let n=21000n;for(let i=2;i<s.length;i+=2)n+=s.slice(i,i+2)==='00'?4n:16n;return n;}
function envelopeProof(inputs,envelope,local){
  need(object(envelope)&&Object.keys(envelope).sort().join()==='data,from,gas,to,value','Unsupported original envelope fields.');
  const computed=intrinsic(envelope.data),gas=uint(envelope.gas);need(gas>computed&&gas<=5000000n&&uint(envelope.value)===0n,'Unsupported original gas/value profile.');
  need(isDeepStrictEqual(inputs.request,{from:addr(envelope.from),to:addr(envelope.to),data:bytes(envelope.data),value:'0',gasLimit:(gas-computed).toString()}),'Local request is not the input-derived message envelope.');
  need(inputs.profile?.expectedOutputsUsed===false&&uint(inputs.profile.intrinsicGas)===computed&&uint(inputs.profile.sourceGasLimit)===gas,'Intrinsic gas is not bound to declared input bytes.');
  need(local.environment?.chainId===999&&local.environment?.hardfork==='cancun'&&local.environment?.baseFeePerGas==='0'&&uint(inputs.block.baseFeePerGas)===0n,'Local execution environment is outside the declared unpriced Cancun profile.');
  need(local.semantics?.feeSettlement===false&&local.semantics?.kind==='unsigned_message','Local result is not the declared unsigned message profile.');
  need(local.stateDisposition==='message_result_retained_in_supplied_manager','Completed local result is not retained in the supplied state manager.');
  for(const field of ['number','timestamp','gasLimit'])need(uint(local.environment[field])===uint(inputs.block[field]),'Local header differs from supplied input context.');
  for(const field of ['mixHash','miner'])need(local.environment[field]?.toLowerCase()===inputs.block[field]?.toLowerCase(),'Local header differs from supplied input context.');
  need(word(local.environment.sourceBlockHash)===word(inputs.profile.sourceBlockHash)&&word(local.environment.sourceBlockHash)===word(inputs.block.hash)&&word(local.environment.sourceParentHash)===word(inputs.block.parentHash),'Local state identity differs from supplied input context.');
  return {intrinsic:computed,gas};
}
function tree(raw,{provider,gas,intrinsic}){
  let count=0;function visit(frame,depth){
    need(object(frame)&&++count<=LIMITS.frames&&depth<=LIMITS.depth,'Missing, excessive or malformed call tree.');
    need(['CALL','STATICCALL','DELEGATECALL','CALLCODE'].includes(frame.type),'Call-tree lifecycle/unknown frame is outside comparison scope.');
    need(Array.isArray(frame.calls??[]),'Malformed child-call array.');
    if(frame.incomplete)throw new Incomplete('Local call tree contains an incomplete frame.');
    const error=frameError(frame);
    let budget=uint(frame.gas),used=uint(frame.gasUsed);
    if(depth===0){need(frame.type==='CALL','Unsupported root call type.');need(budget===(provider?gas:gas-intrinsic),'Root gas does not match the declared envelope.');if(provider){need(used>=intrinsic,'Provider root gas use is below intrinsic gas.');budget-=intrinsic;used-=intrinsic;}}
    need(used<=budget,'Frame gas use exceeds its declared budget.');
    // Native callTracer always serializes input; output is omitempty. A
    // STATICCALL has no value operand, so its omitted value is known zero.
    // Other call types require an explicit observed value in this profile.
    const value=provider&&frame.type==='STATICCALL'&&frame.value===undefined?'0x0':frame.value;
    const output=provider&&frame.output===undefined?'0x':frame.output;
    return {type:frame.type,from:addr(frame.from),to:addr(frame.to),input:bytes(frame.input),value:uint(value).toString(),gas:budget.toString(),gasUsed:used.toString(),output:bytes(output),error,calls:(frame.calls??[]).map(child=>visit(child,depth+1))};
  }const trace=visit(raw,0);return {trace,frames:count};
}
function logPayload(log){need(object(log),'Malformed log.');need(Array.isArray(log.topics)&&log.topics.length<=4,'Malformed log topics.');need(!log.removed,'Removed logs are not committed evidence.');return {address:addr(log.address),topics:log.topics.map(word),data:bytes(log.data)};}
function providerLogs(trace){
  const found=[];let frames=0;const byIndex=(a,b)=>a.index<b.index?-1:a.index>b.index?1:0;
  function visit(frame,reverted=false,depth=0){need(object(frame)&&++frames<=LIMITS.frames&&depth<=LIMITS.depth,'Malformed/excessive log call tree.');const error=frameError(frame),failed=reverted||Boolean(error);need(Array.isArray(frame.logs??[])&&Array.isArray(frame.calls??[]),'Malformed log or child array.');
    const calls=frame.calls??[],own=[];
    if(!failed)for(const log of frame.logs??[]){need(found.length<LIMITS.logs,'Excessive committed logs.');const payload=logPayload(log),hasIndex=Object.hasOwn(log,'index'),hasLogIndex=Object.hasOwn(log,'logIndex');need(hasIndex||hasLogIndex,'Committed log lacks a provider ordering index.');const index=uint(hasIndex?log.index:log.logIndex);if(hasIndex&&hasLogIndex)need(index===uint(log.logIndex),'Conflicting provider log ordering fields.');const position=Object.hasOwn(log,'position')?Number(uint(log.position,BigInt(calls.length))):null;const entry={index,payload,position};own.push(entry);found.push(entry);}
    const children=calls.map(child=>visit(child,failed,depth+1));own.sort(byIndex);
    let previousChildMax=null;
    for(const child of children)if(child.length){need(previousChildMax===null||previousChildMax<child[0].index,'Provider log indices contradict sibling-call ordering.');previousChildMax=child.at(-1).index;}
    let lastPosition=-1;
    for(const log of own)if(log.position!==null){need(log.position>=lastPosition,'Provider log positions contradict index ordering.');lastPosition=log.position;
      // Position counts completed direct subcalls, including reverted ones.
      // Check only positions actually supplied; index gaps are permitted.
      for(let i=0;i<children.length;i++){const child=children[i];if(child.length)need(i<log.position?child.at(-1).index<log.index:log.index<child[0].index,'Provider log position contradicts child-log ordering.');}
    }
    return [...own,...children.flat()].sort(byIndex);
  }visit(trace);found.sort((a,b)=>a.index<b.index?-1:a.index>b.index?1:0);need(new Set(found.map(x=>x.index.toString())).size===found.length,'Duplicate provider committed-log index.');return found.map(x=>x.payload);
}
function canonicalDiff(raw){
  need(object(raw)&&Object.keys(raw).sort().join()==='post,pre','A complete pre/post diff object is required.');const result={},allAccounts=new Set();let slots=0;
  for(const side of ['pre','post']){need(object(raw[side]),'Malformed diff side.');const out={};for(const[key,v]of Object.entries(raw[side])){const a=addr(key);need(!Object.hasOwn(out,a)&&object(v),'Duplicate or malformed diff account.');allAccounts.add(a);need(allAccounts.size<=LIMITS.accounts,'Excessive diff accounts.');need(Object.keys(v).every(k=>['nonce','balance','code','storage'].includes(k)),'Unknown state-diff field.');const r={};for(const field of ['nonce','balance'])if(Object.hasOwn(v,field))r[field]=uint(v[field],field==='nonce'?(1n<<64n)-1n:MAX).toString();if(Object.hasOwn(v,'code'))r.code=bytes(v.code);
      if(Object.hasOwn(v,'storage')){need(object(v.storage),'Malformed diff storage.');r.storage={};for(const[k,value]of Object.entries(v.storage)){const s=word(k);need(!Object.hasOwn(r.storage,s)&&++slots<=LIMITS.slots,'Duplicate or excessive diff slots.');r.storage[s]=word(value);}}out[a]=r;
    }result[side]=Object.fromEntries(Object.keys(out).sort().map(k=>[k,out[k]]));}need(isDeepStrictEqual(Object.keys(result.pre),Object.keys(result.post)),'Account creation, deletion or missing diff side is unsupported.');return result;
}
function expectedChanges(raw,inputs){
  const diff=canonicalDiff(raw),changes={},baselineDifferences=[];
  for(const[a,before]of Object.entries(diff.pre)){
    const initial=inputAccount(inputs,a),after=diff.post[a],out={};
    for(const field of ['nonce','balance','code'])if(Object.hasOwn(before,field)){const actual=field==='code'?bytes(initial.code):uint(initial[field]).toString();if(actual!==before[field])baselineDifferences.push({address:a,field,expected:before[field],actual});}
    for(const field of ['nonce','balance'])if(Object.hasOwn(after,field)){need(Object.hasOwn(before,field),'Changed basic field lacks its provider pre-value.');if(before[field]!==after[field])out[field]={before:before[field],after:after[field]};}
    if(Object.hasOwn(after,'code'))need(after.code===before.code&&after.code===initial.code,'Runtime code changes or absent code baseline are unsupported.');
    const storage={};for(const slot of [...new Set([...Object.keys(before.storage??{}),...Object.keys(after.storage??{})])].sort()){
      need(Object.hasOwn(initial.storage,slot),'Diff requires an uncaptured original storage value.');const initialValue=word(initial.storage[slot]),hasPre=Object.hasOwn(before.storage??{},slot),hasPost=Object.hasOwn(after.storage??{},slot);
      if(hasPre&&initialValue!==before.storage[slot])baselineDifferences.push({address:a,field:'storage',slot,expected:before.storage[slot],actual:initialValue});
      if(!hasPre)need(initialValue===ZERO,'Post-only storage requires an explicit zero input value.');
      // Geth diff removes cleared slots from post. The explicit pre value and
      // captured base value, not arbitrary absence, authorize this zero form.
      const prev=hasPre?before.storage[slot]:initialValue,next=hasPost?after.storage[slot]:ZERO;
      if(prev!==next)storage[slot]={before:prev,after:next};
    }if(Object.keys(storage).length)out.storage=storage;if(Object.keys(out).length)changes[a]=out;
  }return {changes,baselineDifferences};
}
function observedChanges(raw,inputs){
  need(object(raw)&&Array.isArray(raw.accounts)&&raw.accounts.length<=LIMITS.accounts,'A bounded local state snapshot is required.');const changes={};let count=0;
  for(const entry of raw.accounts){const a=addr(entry.address),initial=inputAccount(inputs,a);need(!Object.hasOwn(changes,a)&&Object.keys(entry).every(k=>['address','nonce','balance','storage'].includes(k)),'Duplicate or unsupported local state change.');const out={};
    for(const field of ['nonce','balance'])if(Object.hasOwn(entry,field)){const v=entry[field];need(object(v)&&Object.keys(v).sort().join()==='after,before','Malformed local basic-field change.');const prev=uint(v.before).toString(),next=uint(v.after).toString();need(prev===uint(initial[field]).toString()&&prev!==next,'Local change baseline differs from its explicit input or is unchanged.');out[field]={before:prev,after:next};}
    if(Object.hasOwn(entry,'storage')){need(Array.isArray(entry.storage),'Malformed local storage changes.');const storage={};for(const item of entry.storage){need(object(item)&&Object.keys(item).sort().join()==='after,before,slot','Malformed local storage change.');const slot=word(item.slot),prev=word(item.before),next=word(item.after);need(++count<=LIMITS.slots&&!Object.hasOwn(storage,slot)&&Object.hasOwn(initial.storage,slot)&&prev===word(initial.storage[slot])&&prev!==next,'Unknown, duplicate or inconsistent local storage change.');storage[slot]={before:prev,after:next};}if(Object.keys(storage).length)out.storage=Object.fromEntries(Object.keys(storage).sort().map(k=>[k,storage[k]]));}
    need(Object.keys(out).length>0,'Empty local change entry.');changes[a]=out;
  }return Object.fromEntries(Object.keys(changes).sort().map(k=>[k,changes[k]]));
}

export function compareRecordedExecution({inputs,envelope,localExecution,localChanges,providerTrace,providerDiff}){
  const scope={kind:'one_recorded_unsigned_call',state:'captured_accounts_and_slots_only',gas:'Cancun_intrinsic_input_rule_root_only_zero_refund',calls:'full_entered_message_tree',logs:'ordered_committed_logs_using_distinct_provider_indices_and_available_positions',providerNormalization:{omittedOutput:'empty_bytes_native_callTracer_omitempty',omittedValue:'zero_for_STATICCALL_only',input:'required',logIndexGaps:'permitted',logPosition:'validate_if_supplied'},expectedOutputsUsedAsInputs:false,independentStateProof:false};
  if(!['success','reverted','failed'].includes(localExecution?.execution?.status))return {status:'unavailable',scope,reason:'Local execution did not complete; no output agreement is inferred.',execution:unavailable('Local execution unavailable.'),callTree:unavailable('Local execution unavailable.'),logs:unavailable('Local execution unavailable.'),state:unavailable('Local execution unavailable.')};
  const binding=checked(()=>{bounded({inputs,envelope,localExecution,localChanges,providerTrace,providerDiff});const proof=envelopeProof(inputs,envelope,localExecution);return {status:'matched',intrinsic:proof.intrinsic.toString(),gas:proof.gas.toString()};});
  if(binding.status!=='matched')return {status:'unavailable',scope,reason:binding.reason,execution:binding,callTree:binding,logs:binding,state:binding};
  const proof={gas:BigInt(binding.gas),intrinsic:BigInt(binding.intrinsic)},zeroRefund=localExecution.execution.gasRefundCounter==='0';
  const execution=checked(()=>{need(object(providerTrace),'Missing original provider trace.');need(zeroRefund,'Nonzero transaction-refund gas normalization is not supported.');const error=frameError(providerTrace),status=error===null?'success':error==='revert'?'reverted':'failed';const providerUsed=uint(providerTrace.gasUsed);need(providerUsed>=proof.intrinsic,'Provider gas use is below intrinsic gas.');const expected={status,error,returnData:bytes(providerTrace.output??'0x'),executionGasUsed:(providerUsed-proof.intrinsic).toString()};const actual={status:localExecution.execution.status,error:failure(localExecution.execution.error),returnData:bytes(localExecution.execution.returnData),executionGasUsed:uint(localExecution.execution.executionGasUsed).toString()};return {...result(expected,actual),intrinsicGas:proof.intrinsic.toString()};});
  const callTree=checked(()=>{need(zeroRefund,'Nonzero transaction-refund root gas normalization is not supported.');const expected=tree(providerTrace,{provider:true,...proof}),actual=tree(localExecution.trace,{provider:false,...proof});need(expected.trace.from===addr(envelope.from)&&expected.trace.to===addr(envelope.to)&&expected.trace.input===bytes(envelope.data)&&expected.trace.value==='0','Provider root differs from the fixed envelope.');return {...result(expected.trace,actual.trace),providerFrames:expected.frames,localFrames:actual.frames};});
  const logs=checked(()=>{const expected=providerLogs(providerTrace);need(Array.isArray(localExecution.logs)&&localExecution.logs.length<=LIMITS.logs,'Malformed/excessive local committed logs.');const actual=localExecution.logs.map(logPayload);return {...result(expected,actual),providerCount:expected.length,localCount:actual.length};});
  const state=checked(()=>{const expected=expectedChanges(providerDiff,inputs),actual=observedChanges(localChanges,inputs);const comparison=result(expected.changes,actual);return {...comparison,status:expected.baselineDifferences.length?'diverged':comparison.status,baselineDifferences:expected.baselineDifferences,providerChangedAccounts:Object.keys(expected.changes).length,localChangedAccounts:Object.keys(actual).length,normalization:{omittedPostBasicField:'unchanged',preOnlyStorage:'cleared_to_zero_with_explicit_pre_and_input',postOnlyStorage:'requires_explicit_zero_input',accountCreationDeletion:'unsupported',codeChanges:'unsupported'}};});
  const views=[execution,callTree,logs,state];return {status:views.some(v=>v.status==='unavailable')?'unavailable':views.some(v=>v.status==='diverged')?'diverged':'matched',scope,execution,callTree,logs,state};
}
