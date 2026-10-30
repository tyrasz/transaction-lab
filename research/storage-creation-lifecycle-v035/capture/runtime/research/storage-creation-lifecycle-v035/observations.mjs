// Saved artifact projection only. No EVM, subprocess, or RPC.
import assert from 'node:assert/strict';
import {isDeepStrictEqual as equal} from 'node:util';
import {allocationRoot,normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';
import {eelsObservation as originalEelsObservation,CHANNELS,comparePair} from '../storage-creation-forks-v035/observations.mjs';
import {applyCandidateDelta} from './delta.mjs';
import {validateQueryReference} from './query-observations.mjs';
export {CHANNELS,comparePair};

const decimal=(v,max=(1n<<256n)-1n)=>{assert.equal(typeof v,'string');assert.match(v,/^(?:0|[1-9][0-9]*)$/);assert(BigInt(v)<=max);return v;};
const bytes=v=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:[0-9a-f]{2})*$/);assert(v.length<=131074);return v;};
const balance=(allocation,address)=>BigInt(allocation[address]?.balance??0).toString();
const scalar=returned=>typeof returned==='string'&&/^0x[0-9a-f]{64}$/.test(returned)?BigInt(returned).toString():null;
export function neutralExceptSenderNonce(before,after,sender,logs){
  const a=normalizeAllocation(before),b=normalizeAllocation(after);
  if(!a[sender]||!b[sender]||!Array.isArray(logs)||logs.length)return false;
  if(BigInt(b[sender].nonce)!==BigInt(a[sender].nonce)+1n)return false;
  b[sender].nonce=a[sender].nonce;return equal(a,b);
}
function execution(input,output,allocation,gasLimit){
  assert(['success','reverted','failed'].includes(output.execution.status));
  return {executionStatus:output.execution.status,returnData:bytes(output.execution.returnData),
    chargedGas:decimal(output.gasAccounting.gasUsed,BigInt(gasLimit)),
    singleTransactionBlockGasUsed:decimal(input.fork==='Amsterdam'?output.gasAccounting.singleTransactionBlockGasUsed:output.gasAccounting.gasUsed,BigInt(gasLimit)),
    target:{address:input.target,account:allocation[input.target]??null},logs:output.logs};
}
const values=(before,after)=>before===null||after===null?null:{beforeRaw:before,afterRaw:after,deltaRaw:(BigInt(after)-BigInt(before)).toString()};
function projectedMeasurement(row){
  if(row.status!=='measured'){assert.equal(row.values,null);return null;}
  assert(Array.isArray(row.values)&&row.values.length===1);
  const v=row.values[0];decimal(v.beforeRaw);decimal(v.afterRaw);assert.equal(v.deltaRaw,(BigInt(v.afterRaw)-BigInt(v.beforeRaw)).toString());
  return {beforeRaw:v.beforeRaw,afterRaw:v.afterRaw,deltaRaw:v.deltaRaw};
}
function selfdestructs(frame,address){
  if(!frame)return false;
  return frame.executionAddress===address&&frame.error===null&&frame.selfdestruct?.beneficiary===address || (frame.calls??[]).some(f=>selfdestructs(f,address));
}
export async function productObservation(input,report){
  assert.equal(report.id,input.id);assert.equal(report.status,'completed');
  const attempt=report.attempt;assert.equal(attempt.status,'completed');const p=attempt.preview;
  assert(['complete','partial','unavailable'].includes(p.status));assert(p.original?.output);
  const allocation=await applyCandidateDelta(input,p.original.changes);
  const out={completedExecution:true,...execution(input,p.original.output,allocation,input.request.gas),stateRoot:await allocationRoot(allocation),allocation,queries:[]};
  assert.equal(p.measurements.length,input.queries.length);
  for(let index=0;index<input.queries.length;index++){
    const descriptor=input.queries[index],m=p.measurements[index];assert.deepEqual(m.descriptor,descriptor);
    assert(['measured','unavailable','not_attempted'].includes(m.status));
    const row={index,kind:descriptor.kind==='native_balance'?'native_balance':'contract_call',measurementStatus:m.status,values:projectedMeasurement(m),before:null,after:null};
    for(const phase of['before','after']){
      const observed=m[phase];if(observed===null)continue;assert(observed&&typeof observed==='object');
      if(!observed.changesBefore||!observed.changesAfter)continue;
      const initial=await applyCandidateDelta(input,observed.changesBefore),final=await applyCandidateDelta(input,observed.changesAfter),expected=phase==='before'?input.allocation:allocation;
      assert.deepEqual(initial,expected,'Query started from another snapshot');
      if(row.kind==='native_balance'){
        assert.deepEqual(final,initial);assert.equal(observed.output,null);
        if(observed.status==='measured'){assert.equal(observed.values.length,1);assert.equal(observed.values[0].raw,balance(initial,descriptor.account));}
        row[phase]={kind:row.kind,balance:balance(initial,descriptor.account),inputStateRoot:await allocationRoot(initial)};
      }else if(observed.output&&['success','reverted','failed'].includes(observed.output.execution.status)){
        const e=execution(input,observed.output,final,'1000000');
        assert.equal(observed.output.profile.executionBaseFee,'0');assert.equal(observed.output.profile.gasPrice,'0');
        row[phase]={...e,inputStateRoot:await allocationRoot(initial),stateRoot:await allocationRoot(final),neutralExceptSenderNonce:neutralExceptSenderNonce(initial,final,input.request.from,e.logs),scalar:scalar(e.returnData),targetSelfdestructObserved:selfdestructs(observed.output.trace,input.target)};
      }
    }
    out.queries.push(row);
  }
  return out;
}

export async function eelsObservation(input,report){
  const out=await originalEelsObservation(input,report);out.queries=[];
  const {signingModule,...scope}=report.queryReferenceScope;
  assert.equal(typeof signingModule,'string');assert(signingModule.startsWith('/')&&signingModule.includes('/venv/'));
  assert.deepEqual(scope,{profile:'synthetic_unpriced_context',sourceBaseFee:'7',executionBaseFee:'0',gasPrice:'0',
    sourceHeaderHash:input.headerHash,canonicalHeaderRehashed:false,entrypoint:'stock_apply_body_signed_type2_zero_fee',
    senderNonceSource:'each_reference_snapshot',snapshotSource:'EELS_initial_or_settled_original_allocation',queryWritesReused:false,
    queryGasLimit:'1000000',wrapperCaveat:'stock_system_processing_and_zero_fee_credits_retained; inert_system_scaffold_and_preexisting_nonempty_query_coinbase'});
  assert(Array.isArray(report.queryReferences)&&report.queryReferences.length===input.queries.length);
  for(let index=0;index<input.queries.length;index++){
    const descriptor=input.queries[index],saved=report.queryReferences[index];assert.equal(saved.index,index);assert.equal(saved.kind,input.queryTemplates[index].kind);assert.deepEqual(saved.template,input.queryTemplates[index]);
    const row={index,kind:descriptor.kind==='native_balance'?'native_balance':'contract_call',measurementStatus:null,values:null,before:null,after:null};
    for(const phase of['before','after']){
      const q=saved[phase],initial=phase==='before'?input.allocation:out.allocation;
      if(q?.status!=='observed')continue;
      assert.equal(q.inputStateRoot,await allocationRoot(initial));
      if(row.kind==='native_balance'){
        assert.deepEqual(Object.keys(q).sort(),['status','account','inputStateRoot','balance'].sort());
        assert.equal(q.account,descriptor.account);assert.equal(q.balance,balance(initial,descriptor.account));
        row[phase]={kind:row.kind,balance:q.balance,inputStateRoot:q.inputStateRoot};
      }else{
        row[phase]=await validateQueryReference({input,reference:q,template:input.queryTemplates[index],initialAllocation:initial});
      }
    }
    const measurable=q=>q!==null&&(row.kind==='native_balance'||q.executionStatus==='success'&&q.neutralExceptSenderNonce&&q.scalar!==null);
    if(row.before!==null&&row.after!==null){row.measurementStatus=measurable(row.before)&&measurable(row.after)?'measured':'unavailable';if(row.measurementStatus==='measured')row.values=values(row.kind==='native_balance'?row.before.balance:row.before.scalar,row.kind==='native_balance'?row.after.balance:row.after.scalar);}
    out.queries.push(row);
  }
  return out;
}
export function comparePreview(a,b){
  if(!a||!b)return null;assert.equal(a.queries.length,b.queries.length);
  return a.queries.map((x,index)=>{const y=b.queries[index];assert.equal(x.index,y.index);assert.equal(x.kind,y.kind);
    const channels={admission:y.measurementStatus===null?null:x.measurementStatus===y.measurementStatus,values:x.values===null||y.values===null?null:equal(x.values,y.values)};
    for(const phase of['before','after']){
      const p=x[phase],q=y[phase],keys=x.kind==='native_balance'?['balance','inputStateRoot']:['executionStatus','returnData','chargedGas','singleTransactionBlockGasUsed','logs','inputStateRoot','stateRoot','neutralExceptSenderNonce','targetSelfdestructObserved'];
      for(const key of keys)channels[phase+'.'+key]=p?.[key]==null||q?.[key]==null?null:equal(p[key],q[key]);
    }
    return {index,kind:x.kind,channels};
  });
}
