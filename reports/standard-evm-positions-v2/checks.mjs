import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex'),jsonSha=x=>sha(JSON.stringify(x));
const keys=x=>Object.keys(x).sort(),own=(x,k)=>Object.hasOwn(x,k),plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const MAX=(1n<<256n)-1n,ZERO='0x'+'0'.repeat(64),PROBE='0x000000000000000000000000000000000000ba1a';
const q=x=>{assert.ok(typeof x==='string'||Number.isSafeInteger(x));assert.match(String(x),/^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i);const n=BigInt(x);assert.ok(n>=0n&&n<=MAX);return n;};
const hex=x=>'0x'+q(x).toString(16);
function recordAt(report,id){assert.ok(Number.isInteger(id)&&id>=1);const e=report.evidence[id-1];assert.equal(e?.id,id);assert.equal(e.error,undefined);assert.ok(own(e,'result'));return e;}
function unique(report,predicate){const rows=report.evidence.filter(predicate);assert.equal(rows.length,1);return rows[0];}
function options(diff,state){return{tracer:diff?'prestateTracer':'callTracer',timeout:'15s',tracerConfig:diff?{diffMode:true}:{withLog:true},...(state===null?{}:{stateOverrides:state})};}
function engineOnly(report){const copy=structuredClone(report);for(const k of ['apiRequest','source','preview'])delete copy[k];return copy;}

// This canonicalizer and composer do not import the engine's state helpers.
// Raw codeHash claims are checked with only the archived Keccak primitive.
export function normalizeDiff(raw,keccak){
  assert.deepEqual(keys(raw),['post','pre']);const out={pre:{},post:{}};let accounts=0,slots=0;
  for(const phase of ['pre','post']){assert.ok(plain(raw[phase]));for(const [address,item]of Object.entries(raw[phase])){
    assert.match(address,/^0x[0-9a-f]{40}$/i);const a=address.toLowerCase();assert.equal(own(out[phase],a),false);assert.ok(++accounts<=200&&plain(item));
    assert.ok(keys(item).every(k=>['balance','nonce','code','storage','codeHash'].includes(k)));
    const value={};for(const k of ['balance','nonce'])if(own(item,k)){value[k]=q(item[k]).toString();if(k==='nonce')assert.ok(q(item[k])<(1n<<64n));}
    if(own(item,'code')){assert.equal(typeof item.code,'string');assert.match(item.code,/^0x(?:[0-9a-f]{2})*$/i);assert.ok(item.code.length<=262146);value.code=item.code.toLowerCase();}
    if(own(item,'codeHash')){assert.match(item.codeHash,/^0x[0-9a-f]{64}$/i);assert.equal(typeof value.code,'string');assert.equal('0x'+Buffer.from(keccak(Buffer.from(value.code.slice(2),'hex'))).toString('hex'),item.codeHash.toLowerCase());}
    if(own(item,'storage')){assert.ok(plain(item.storage));value.storage={};for(const [key,word]of Object.entries(item.storage)){assert.match(key,/^0x[0-9a-f]{64}$/i);assert.equal(typeof word,'string');assert.match(word,/^0x[0-9a-f]{64}$/i);assert.equal(own(value.storage,key.toLowerCase()),false);assert.ok(++slots<=4000);value.storage[key.toLowerCase()]=word.toLowerCase();}}
    out[phase][a]=value;
  }}return out;
}
export function composeState(previous,diff){
  assert.deepEqual(keys(diff.pre),keys(diff.post),'This fixed packet has no account lifecycle transition.');
  const out=structuredClone(previous??{});
  for(const account of keys(diff.pre)){
    const pre=diff.pre[account],post=diff.post[account],old=out[account]??{},next={...old};
    if(own(post,'code'))assert.equal(post.code,pre.code,'Runtime code cannot change.');
    for(const field of ['nonce','balance'])if(own(old,field)&&own(pre,field))assert.equal(q(old[field]),q(pre[field]),'Carried basic state must match the next full original prestate.');
    for(const field of ['nonce','balance'])if(own(post,field))next[field]=hex(post[field]);
    const touched=[...new Set([...keys(pre.storage??{}),...keys(post.storage??{})])].sort();
    if(touched.length){next.stateDiff={...(old.stateDiff??{})};for(const slot of touched){if(own(old.stateDiff??{},slot))assert.equal(old.stateDiff[slot],pre.storage?.[slot]??ZERO,'Carried storage must match the next original prestate.');next.stateDiff[slot]=post.storage?.[slot]??ZERO;}}
    if(keys(next).length)out[account]=next;
  }
  const sorted={};for(const a of keys(out)){sorted[a]={};for(const k of ['balance','nonce'])if(own(out[a],k))sorted[a][k]=out[a][k];if(out[a].stateDiff)sorted[a].stateDiff=Object.fromEntries(keys(out[a].stateDiff).map(s=>[s,out[a].stateDiff[s]]));}return sorted;
}
function nonceOnly(raw,sender,nonce,balance){
  assert.deepEqual(keys(raw),['post','pre']);assert.deepEqual(keys(raw.pre),[sender]);assert.deepEqual(keys(raw.post),[sender]);
  const a=raw.pre[sender],b=raw.post[sender];for(const row of[a,b])assert.ok(keys(row).every(k=>['balance','nonce'].includes(k)));
  const pre=(k,n)=>own(a,k)?q(a[k]):(assert.equal(n,0n),0n);
  assert.equal(pre('nonce',nonce),nonce);assert.equal(pre('balance',balance),balance);assert.equal(q(b.nonce),nonce+1n);if(own(b,'balance'))assert.equal(q(b.balance),balance);
}
function rootTrace(raw,call){
  assert.equal(raw.type,'CALL');assert.equal(raw.from,call.from);assert.equal(raw.to,call.to);assert.equal(raw.input,call.data);assert.equal(q(raw.value??'0'),q(call.value));assert.equal(q(raw.gas),q(call.gas));assert.ok(q(raw.gasUsed)>0n&&q(raw.gasUsed)<=q(call.gas));
}
function queryWords(raw,call,count){
  rootTrace(raw,call);assert.match(raw.output,new RegExp('^0x[0-9a-f]{'+count*64+'}$','i'));let frames=0;
  function walk(frame,context,depth){assert.ok(++frames<=1000&&depth<=32);assert.equal(frame.error,undefined);assert.equal(frame.revertReason,undefined);assert.equal(q(frame.value??'0'),0n);assert.deepEqual(frame.logs??[],[]);assert.ok(q(frame.gasUsed)<=q(frame.gas)&&q(frame.gas)<=q(call.gas));assert.match(frame.input,/^0x(?:[0-9a-f]{2})*$/i);assert.match(frame.output,/^0x(?:[0-9a-f]{2})*$/i);assert.match(frame.from,/^0x[0-9a-f]{40}$/);assert.match(frame.to,/^0x[0-9a-f]{40}$/);assert.ok(Array.isArray(frame.calls??[]));
    for(const child of frame.calls??[]){assert.ok(['STATICCALL','DELEGATECALL'].includes(child.type));assert.equal(child.from,context);if(child.type==='DELEGATECALL'){assert.equal(child.input,frame.input);assert.equal(child.output,frame.output);}walk(child,child.type==='DELEGATECALL'?context:child.to,depth+1);}}
  walk(raw,raw.to,0);return Array.from({length:count},(_,i)=>q('0x'+raw.output.slice(2+i*64,66+i*64)));
}
function contextHeader(report,previousHeader){
  const start=unique(report,e=>e.method==='eth_getBlockByHash');assert.deepEqual(start.params,[report.request.block.blockHash,false]);assert.equal(start.result.hash,report.request.block.blockHash);
  if(previousHeader)assert.deepEqual(start.result,previousHeader,'Every step has the same complete source header.');
  const end=unique(report,e=>e.method==='eth_getBlockByNumber');assert.deepEqual(end.params,[hex(start.result.number),false]);assert.deepEqual(end.result,start.result,'Full final header must be unchanged.');
  return start.result;
}
function anchor(report,method,account){const e=unique(report,e=>e.method===method&&e.params[0]===account);assert.deepEqual(e.params,[account,report.request.block]);return q(e.result);}

export function validateStep(report,{input,shared,previous=null,previousReport=null,previousHeader=null,stepIndex=0,keccak}){
  assert.equal(report.canonicalStatus,'verified');assert.deepEqual(report.security,{status:'not_assessed'});assert.equal(report.scope.allEffectsCoverage,'inconclusive');
  const call={from:shared.from,to:input.to,data:input.data,gas:'0x4c4b40',value:hex(input.value)};
  const pinned={blockHash:shared.block,requireCanonical:true};assert.deepEqual(report.request.transaction,call);assert.deepEqual(report.request.block,pinned);
  assert.deepEqual(report.apiRequest,{chainId:1,from:shared.from,...input,block:shared.block});
  const header=contextHeader(report,previousHeader),sender=call.from;
  const pinnedNonce=anchor(report,'eth_getTransactionCount',sender),balance=anchor(report,'eth_getBalance',sender);
  const nonce=previous?.[sender]?.nonce===undefined?pinnedNonce:q(previous[sender].nonce);
  assert.equal(nonce,pinnedNonce+BigInt(stepIndex));assert.equal(previous?.[sender]?.balance,undefined,'These cases do not transfer native value.');
  if(previous){assert.equal(report.startingState.priorCalls,stepIndex);assert.equal(report.startingState.kind,'after_previous_simulation');assert.deepEqual(report.startingState.overrides,previous);assert.equal(report.startingState.completeOverridesSha256,jsonSha(previous));assert.equal(report.startingState.previousResultSha256,jsonSha(engineOnly(previousReport)));}
  else assert.equal(report.startingState,undefined);
  const original=unique(report,e=>e.method==='debug_traceCall'&&e.params[2]?.tracer==='callTracer'&&e.params[0]?.gas==='0x4c4b40');
  assert.deepEqual(original.params,[call,pinned,options(false,previous)]);assert.deepEqual(original.result,report.execution.trace);rootTrace(original.result,call);
  assert.equal(report.preview.nativeBalances.length,0);
  if(report.execution.status==='reverted_or_failed'){
    assert.equal(typeof original.result.error,'string');assert.ok(original.result.error.length>0);assert.equal(report.stateDiff,undefined);assert.equal(report.nativeEffects.status,'not_applicable');
    assert.deepEqual(report.request.queries,input.queries);assert.equal(report.measurements.length,input.queries.length);
    for(const [index,descriptor]of input.queries.entries()){
      const expected=independentQuery(descriptor,keccak),row=report.measurements[index],preview=(expected.position?report.preview.positions:report.preview.queries).find(x=>x.index===index);
      assert.deepEqual(row.query,expected.query);assert.equal(row.status,'not_applicable');assertNoAmounts(row);assert.deepEqual(row.queryEvidence??[],[]);
      if(expected.position){assert.deepEqual(row.position,expected.position);assert.equal(row.contractIdentityVerified,false);}
      assert.ok(preview);assert.equal(preview.status,'not_applicable');assertNoAmounts(preview);
    }
    assert.equal(report.evidence.filter(x=>x.method==='debug_traceCall').length,1,'No before/after query is executed after original revert.');
    return{status:'reverted_or_failed',header,overrides:previous,measurements:[],originalTraceEvidenceId:original.id,revertReason:report.execution.revertReason};
  }
  assert.equal(report.execution.status,'success');assert.equal(original.result.error,undefined);assert.equal(original.result.revertReason,undefined);
  assert.deepEqual(report.nativeEffects,{status:'none',feeScope:'excluded',maxAccounts:8,candidates:[],selectedAccounts:[],netValueByAccount:{},counts:{candidates:0,selected:0,omitted:0,measured:0},measurements:[]});
  const rawDiff=unique(report,e=>e.method==='debug_traceCall'&&e.params[2]?.tracer==='prestateTracer'&&e.params[0]?.gas==='0x4c4b40');assert.deepEqual(rawDiff.params,[call,pinned,options(true,previous)]);
  const diff=normalizeDiff(rawDiff.result,keccak);assert.deepEqual(diff,report.stateDiff);const after=composeState(previous,diff);
  assert.equal(q(diff.pre[sender].nonce),nonce);assert.equal(q(diff.post[sender].nonce),nonce+1n);assert.equal(q(diff.pre[sender].balance),balance);if(own(diff.post[sender],'balance'))assert.equal(q(diff.post[sender].balance),balance);
  assert.deepEqual(keys(diff.pre[sender]),['balance','nonce']);assert.deepEqual(keys(diff.post[sender]),['nonce']);
  assert.equal(report.executionIdentity.completeOverridesSha256,jsonSha(after));assert.equal(report.executionIdentity.originalEnvelopeSha256,jsonSha(call));assert.equal(report.executionIdentity.stateBlockHash,shared.block);assert.equal(report.executionIdentity.executionBaseFee,'0');
  // Check both synthetic header witness contexts independently, including the
  // complete carried state and the exact eight returned environmental words.
  const witnesses=report.evidence.filter(e=>e.method==='debug_traceCall'&&e.params[0]?.to===PROBE);assert.equal(witnesses.length,2);
  const code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(q(header.number)-1n).toString(16).padStart(64,'0')+'4060e0526101006000f3';
  const probe={from:sender,to:PROBE,data:'0x',value:'0x0',gas:'0x493e0'};
  for(const [i,w]of witnesses.entries()){assert.deepEqual(w.params,[probe,pinned,options(false,{...(i?after:previous??{}),[PROBE]:{code}})]);rootTrace(w.result,probe);assert.equal(w.result.error,undefined);assert.deepEqual(w.result.calls??[],[]);assert.deepEqual(w.result.logs??[],[]);assert.match(w.result.output,/^0x[0-9a-f]{512}$/);const words=Array.from({length:8},(_,j)=>q('0x'+w.result.output.slice(2+64*j,66+64*j)));assert.deepEqual(words,[header.number,header.timestamp,header.gasLimit,'0',header.mixHash,header.miner,'1',header.parentHash].map(q));}
  assert.equal(report.discovery,undefined);
  assert.deepEqual(report.request.queries,input.queries);
  const compiled=input.queries.map(descriptor=>independentQuery(descriptor,keccak));
  assert.deepEqual(report.measurements.map(m=>m.query),compiled.map(x=>x.query));
  const decoded=[];for(const[index,row]of report.measurements.entries()){
    const expected=compiled[index],preview=(expected.position?report.preview.positions:report.preview.queries).find(x=>x.index===index);
    assert.ok(preview);assert.equal(preview.status,row.status);
    if(expected.position){assert.deepEqual(row.position,expected.position);assert.equal(row.contractIdentityVerified,false);assert.equal(preview.contractIdentityVerified,false);for(const [k,v]of Object.entries(expected.position.identity))assert.deepEqual(preview[k],v);assert.equal(preview.userIsSender,expected.position.identity.user===sender);}
    if(row.status!=='measured'){assertNoAmounts(row);assertNoAmounts(preview);decoded.push({index,status:row.status,reason:row.reason??null,query:row.query});continue;}
    assert.deepEqual(row.queryEvidence.map(x=>x.state),['before','after']);const values=[],returns=[];
    for(const proof of row.queryEvidence){const isAfter=proof.state==='after',trace=recordAt(report,proof.traceEvidenceId),mutation=recordAt(report,proof.mutationEvidenceId),query={from:sender,...row.query,value:'0x0',gas:'0x493e0'},state=isAfter?after:previous;
      assert.equal(trace.method,'debug_traceCall');assert.deepEqual(trace.params,[query,pinned,options(false,state)]);assert.equal(mutation.method,'debug_traceCall');assert.deepEqual(mutation.params,[query,pinned,options(true,state)]);
      values.push(queryWords(trace.result,query,expected.fields?.length??1));returns.push(trace.result.output);nonceOnly(mutation.result,sender,nonce+(isAfter?1n:0n),balance);
    }
    if(expected.position){
      assert.equal(row.basis,'isolated_traced_ABI_queries_with_nonce_only_effects');assert.equal(row.beforeReturnData,returns[0]);assert.equal(row.afterReturnData,returns[1]);assert.equal(row.rows.length,expected.fields.length);
      for(const [i,field]of expected.fields.entries()){const [name,bits,unit]=field,a=values[0][i],b=values[1][i];assert.ok(a<(1n<<BigInt(bits))&&b<(1n<<BigInt(bits)));const r=row.rows[i];assert.equal(r.name,name);assert.equal(r.abiType,'uint'+bits);assert.equal(r.beforeRaw,a.toString());assert.equal(r.afterRaw,b.toString());assert.equal(r.deltaRaw,(b-a).toString());assert.equal(r.unit.kind,unit.kind);assert.equal(r.unit.scale,unit.scale);if(unit.currency===null)assert.equal(r.unit.currency,null);if(unit.token===null)assert.equal(r.unit.token,null);}
      assert.deepEqual(preview.rows,row.rows);assert.deepEqual(preview.queryEvidence,row.queryEvidence);assert.deepEqual(preview.query,row.query);
      decoded.push({index,status:'measured',query:row.query,position:row.position,rows:row.rows,queryEvidence:row.queryEvidence});
    }else{
      assert.equal(row.beforeRaw,values[0][0].toString());assert.equal(row.afterRaw,values[1][0].toString());assert.equal(row.deltaRaw,(values[1][0]-values[0][0]).toString());for(const field of ['beforeRaw','afterRaw','deltaRaw'])assert.equal(preview[field],row[field]);
      decoded.push({index,status:'measured',query:row.query,beforeRaw:row.beforeRaw,afterRaw:row.afterRaw,deltaRaw:row.deltaRaw,queryEvidence:row.queryEvidence});
    }
  }
  return{status:'success',header,overrides:after,measurements:decoded,originalTraceEvidenceId:original.id,originalDiffEvidenceId:rawDiff.id,completeOverridesSha256:jsonSha(after)};
}


export function assertNoAmounts(row){for(const field of ['beforeRaw','afterRaw','deltaRaw','before','after','delta','beforeReturnData','afterReturnData','rows'])assert.equal(row[field],undefined);}
export function independentQuery(descriptor,keccak){
  if(!descriptor.kind)return{query:descriptor};
  const aave=descriptor.kind==='aave_v3_user_account_data';assert.ok(aave||descriptor.kind==='morpho_blue_position');
  const signature=aave?'getUserAccountData(address)':'position(bytes32,address)';
  const selector=Buffer.from(keccak(Buffer.from(signature))).subarray(0,4).toString('hex');
  const query={to:descriptor.contract,data:'0x'+selector+(aave?'':descriptor.marketId.slice(2))+descriptor.user.slice(2).padStart(64,'0')};
  const identity={kind:descriptor.kind,chainId:'1',contract:descriptor.contract,user:descriptor.user,...(aave?{}:{marketId:descriptor.marketId})};
  const base={kind:'oracle_base_units',scale:null,currency:null},bp={kind:'basis_points',scale:'10000'};
  const fields=aave?[['totalCollateralBase',256,base],['totalDebtBase',256,base],['availableBorrowsBase',256,base],['currentLiquidationThreshold',256,bp],['ltv',256,bp],['healthFactor',256,{kind:'ratio',scale:'1000000000000000000'}]]:[['supplyShares',256,{kind:'supply_shares',scale:null}],['borrowShares',128,{kind:'borrow_shares',scale:null}],['collateral',128,{kind:'collateral_token_raw_units',scale:null,token:null}]];
  return{query,position:{identity,signature,returnBytes:fields.length*32},fields};
}
export function validateReport(report,planned,keccak){
  assert.deepEqual(report.apiRequest,planned.input);assert.deepEqual(report.security,{status:'not_assessed'});
  const shared={chainId:1,from:planned.input.from,block:planned.input.block};
  if(report.canonicalStatus!=='verified'){
    for(const part of report.steps?.map(x=>x.result).filter(Boolean)??[report])for(const row of [...part.measurements??[],...part.preview?.queries??[],...part.preview?.positions??[],...part.preview?.nativeBalances??[]]){assert.notEqual(row.status,'measured');assertNoAmounts(row);}
    return[{status:'unavailable',reason:'Canonical/shared context unverified; no amounts accepted.'}];
  }
  if(planned.profile==='single'){const {chainId,from,block,...input}=planned.input;return[validateStep(report,{input,shared,keccak})];}
  assert.equal(report.scope.atomic,false);assert.equal(report.scope.queryMutationsCarried,false);assert.equal(report.scope.fees,'excluded');assert.equal(report.scope.allEffectsCoverage,'inconclusive');assert.equal(report.steps.length,planned.input.calls.length);
  const decoded=[];let previous=null,previousReport=null,header=null,stopped=false;
  for(const [index,step]of report.steps.entries()){
    assert.equal(step.index,index);assert.deepEqual(step.input,planned.input.calls[index]);assert.deepEqual(step.stateSource,index?{kind:'after_step',stepIndex:index-1}:{kind:'initial_block'});
    if(stopped||step.status==='skipped'){assert.equal(step.status,'skipped');assert.equal(step.result,undefined);decoded.push({status:'skipped',reason:step.reason});stopped=true;continue;}
    if(step.result.execution.status!=='success'&&step.result.execution.status!=='reverted_or_failed'){assert.equal(step.status,'unavailable');for(const row of step.result.measurements)assertNoAmounts(row);decoded.push({status:'unavailable',reason:step.reason});stopped=true;continue;}
    const check=validateStep(step.result,{input:step.input,shared,previous,previousReport,previousHeader:header,stepIndex:index,keccak});decoded.push(check);header=check.header;
    if(check.status==='success'){assert.equal(step.status,'completed');previous=check.overrides;previousReport=step.result;}
    else{assert.equal(step.status,'reverted_or_failed');stopped=true;}
  }
  assert.equal(report.sequence.attemptedSteps,report.steps.filter(x=>x.result).length);assert.equal(report.sequence.completedSteps,report.steps.filter(x=>x.status==='completed').length);
  if(header){assert.equal(report.finalVerification.method,'eth_getBlockByNumber');assert.deepEqual(report.finalVerification.params,[hex(header.number),false]);assert.deepEqual(report.finalVerification.result,header);}
  return decoded;
}

