import {isDeepStrictEqual as equal} from 'node:util';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(c,m)=>{if(!c)throw Error(m);},addr=/^0x[0-9a-f]{40}$/,word=/^0x[0-9a-f]{64}$/,data=/^0x(?:[0-9a-f]{2})*$/;
const own=(o,k)=>Object.hasOwn(o,k),record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const quantity=x=>{need((typeof x==='string'&&/^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/.test(x))||(Number.isSafeInteger(x)&&x>=0),'Malformed quantity');return BigInt(x);};
const q=x=>'0x'+quantity(x).toString(16),canonical=x=>JSON.parse(JSON.stringify(x));
const sort=rows=>rows.sort((a,b)=>a.address.localeCompare(b.address)).map(row=>({...row,...(row.storage?{storage:row.storage.sort((a,b)=>a.slot.localeCompare(b.slot))}:{})}));

// Independent interpretation of Geth's sparse prestateTracer diff. Every
// supplied preimage is checked against proof-verified initial state. Omitted
// pre-storage words can mean zero only when the independent proof says zero.
// No product state-diff/override helper is imported.
export function providerChanges(raw,inputs){
  need(record(raw)&&equal(Object.keys(raw).sort(),['post','pre']),'Raw diff requires exactly pre/post');
  need(record(raw.pre)&&record(raw.post),'Diff maps missing');const out=[];
  for(const address of [...new Set([...Object.keys(raw.pre),...Object.keys(raw.post)])].sort()){
    need(addr.test(address),'Malformed/case-ambiguous address');const before=inputs.accounts[address],proof=inputs.provenance.find(p=>p.account===address)?.accountProof;
    need(before?.exists===true&&proof,'Unknown or unsupported account lifecycle');
    const pre=raw.pre[address]??{},post=raw.post[address]??{};need(record(pre)&&record(post),'Malformed account');
    for(const phase of [pre,post])need(Object.keys(phase).every(k=>['balance','nonce','code','codeHash','storage'].includes(k)),'Unknown account field');
    for(const key of ['balance','nonce'])if(own(pre,key))need(quantity(pre[key])===quantity(before[key]),'Raw prior basic state differs from proof');
    if(own(pre,'code'))need(pre.code===before.code,'Raw prior code differs from proof');
    if(own(pre,'codeHash'))need(pre.codeHash===proof.codeHash,'Raw prior code hash differs from proof');
    if(own(post,'code'))need(post.code===before.code,'Runtime code mutation unsupported');
    if(own(post,'codeHash'))need(post.codeHash===proof.codeHash,'Runtime code hash mutation unsupported');
    const changes={address};
    for(const key of ['balance','nonce'])if(own(post,key)){const old=quantity(before[key]),next=quantity(post[key]);if(old!==next)changes[key]={before:q(old.toString()),after:q(next.toString())};}
    const ps=pre.storage??{},ns=post.storage??{};need(record(ps)&&record(ns),'Malformed storage');const storage=[];
    for(const slot of [...new Set([...Object.keys(ps),...Object.keys(ns)])].sort()){
      need(word.test(slot)&&word.test(before.storage[slot]??''),'Unknown or malformed prior storage');const old=before.storage[slot];
      if(own(ps,slot))need(word.test(ps[slot])&&ps[slot]===old,'Raw prior storage differs from proof');else need(BigInt(old)===0n,'Omitted nonzero prior storage');
      const next=own(ns,slot)?ns[slot]:'0x'+'0'.repeat(64);need(word.test(next),'Malformed next storage');
      if(old!==next)storage.push({slot,before:old,after:next});
    }
    if(storage.length)changes.storage=storage;if(Object.keys(changes).length>1)out.push(changes);
  }
  return sort(out);
}
export function committedLogs(frame){
  need(record(frame)&&typeof frame.type==='string','Missing trace frame');
  if(own(frame,'error')){need(typeof frame.error==='string'&&frame.error.length>0,'Malformed trace error');return[];}
  const calls=frame.calls??[],logs=frame.logs??[];need(Array.isArray(calls)&&Array.isArray(logs),'Malformed trace children');
  const children=calls.map(committedLogs),clean=logs.map(l=>{need(record(l)&&addr.test(l.address)&&Array.isArray(l.topics)&&l.topics.every(t=>word.test(t))&&data.test(l.data),'Malformed log');return{address:l.address,topics:l.topics,data:l.data};});
  if(!children.some(x=>x.length))return clean;
  if(!logs.length)return children.flat();
  need(logs.every((l,i)=>Number.isSafeInteger(l.position)&&l.position>=0&&l.position<=calls.length&&(i===0||l.position>=logs[i-1].position)),'Ambiguous cross-frame log order');
  const result=[];for(let i=0;i<=calls.length;i++){for(let n=0;n<logs.length;n++)if(logs[n].position===i)result.push(clean[n]);if(i<calls.length)result.push(...children[i]);}return result;
}
function originalRecords(product,request,header){
  need(Array.isArray(product.transportEvidence),'Raw provider wire evidence missing');
  for(const row of product.transportEvidence){need(typeof row.requestText==='string'&&equal(JSON.parse(row.requestText),row.request)&&sha(row.requestText)===row.requestSha256&&Buffer.byteLength(row.requestText)===row.requestBytes,'Provider request hash mismatch');if(row.responseText!==undefined)need(row.transport?.complete===true&&sha(row.responseText)===row.transport.responseSha256&&Buffer.byteLength(row.responseText)===row.transport.observedBytes,'Provider response hash mismatch');}
  const records=product.transportEvidence.filter(r=>r.request?.method==='debug_traceCall').filter(r=>{
    const [call,selector,options]=r.request.params;return call?.from===request.from&&call?.to===request.to&&call?.data===request.data&&selector?.blockHash===header.hash&&!own(options??{},'stateOverrides');
  });
  const selected={};
  for(const row of records){const [call,selector,options]=row.request.params;need(equal(selector,{blockHash:header.hash,requireCanonical:true}),'Original block selector differs');
    need(quantity(call.value)===0n&&quantity(call.gas)===5000000n,'Original value/gas differs');
    need(Object.keys(call).every(k=>['from','to','data','value','gas','nonce'].includes(k)),'Original envelope differs');
    need(Object.keys(options).every(k=>['tracer','tracerConfig','timeout'].includes(k)),'Unexpected original override');
    const key=options.tracer==='callTracer'?'trace':options.tracer==='prestateTracer'&&options.tracerConfig?.diffMode===true?'diff':null;if(!key)continue;
    need(!selected[key]&&row.responseText,'Original evidence ambiguous or absent');const wire=JSON.parse(row.responseText);need(wire.id===row.id&&wire.jsonrpc==='2.0'&&own(wire,'result')&&!own(wire,'error'),'Invalid successful wire envelope');selected[key]={id:row.id,call,params:row.request.params,result:wire.result};
  }
  need(selected.trace&&selected.diff,'Original trace/diff missing');need(equal(selected.trace.call,selected.diff.call),'Trace/diff envelopes differ');return selected;
}
export function compareReference(local,product,request,header){
  const result={status:'incomplete',checks:{},limitations:['One selected workload; no population score or independent consensus/finality.','Unsigned unpriced calls; no signature validation, fee settlement or original transaction-position claim.','All effects outside supported local execution and demanded verified state remain unassessed.']};
  try{
    need(['success','reverted','failed'].includes(local.output?.execution?.status),'Local execution unavailable');need(local.inputs.status==='available','Local input collection unavailable');
    need(product.canonicalStatus==='verified','Product canonical state unavailable');const raw=originalRecords(product,request,header);result.providerEvidenceIds={trace:raw.trace.id,diff:raw.diff.id};
    need(quantity(raw.trace.call.nonce)===quantity(local.inputs.accounts[request.from]?.nonce),'Provider nonce differs from independently proven sender');
    const trace=raw.trace.result;need(trace.from===request.from&&trace.to===request.to&&trace.input===request.data&&quantity(trace.gas)===5000000n,'Trace root identity differs');
    const status=trace.error?(trace.error==='execution reverted'?'reverted':'failed'):'success';
    result.checks.executionStatus=local.output.execution.status===status;
    need(typeof trace.output==='string'&&data.test(trace.output),'Raw return bytes missing');result.checks.returnData=local.output.execution.returnData===trace.output;
    result.providerLogs=committedLogs(trace);result.checks.committedLogs=equal(local.output.logs,result.providerLogs);
    result.providerChanges=providerChanges(raw.diff.result,local.inputs);result.localChanges=sort(canonical(local.changes.accounts));result.checks.fullObservedStateChanges=equal(result.localChanges,result.providerChanges);
    result.providerRootGas=quantity(trace.gasUsed).toString();result.localTransactionStyleGas=local.output.gasAccounting?.gasUsed??null;result.checks.gasAccounting=result.providerRootGas===result.localTransactionStyleGas;
    result.status=Object.values(result.checks).every(Boolean)?'matched':'mismatched';
  }catch(error){result.status=Object.values(result.checks).includes(false)?'mismatched':'incomplete';result.reason=typeof error.message==='string'?error.message:'Evidence incomplete';}
  return result;
}
