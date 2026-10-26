// Experimental provider execution on ordinary EVM chains. No signing, sending,
// guessed balances, protocol-specific expected amounts or expected-output input.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { normalizeProviderStateDiff } from './provider-state-diff.js';
import { buildStateOverrides, uint, StateValidationError } from '../../src/state.js';
import { semanticTrace } from '../../src/query-validation.js';
import { assertNoProviderErrorResult } from '../../src/rpc.js';
import { discoverTokenQueries } from './discovery.js';

const ADDRESS=/^0x[0-9a-f]{40}$/i, WORD=/^0x[0-9a-f]{64}$/i, BYTES=/^0x(?:[0-9a-f]{2})*$/i;
const BALANCE=/^0x70a082310{24}[0-9a-f]{40}$/i, ALLOWANCE=/^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/i;
const MAX=(1n<<256n)-1n, MAX_NONCE=(1n<<64n)-1n, PROBE='0x000000000000000000000000000000000000ba1a';
const LIMITS=Object.freeze({rpc:64,queries:8,responseBytes:8*1024*1024,evidenceBytes:32*1024*1024,wallMs:120000});
const lower=x=>typeof x==='string'?x.toLowerCase():'';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const isAddress=x=>typeof x==='string'&&ADDRESS.test(x),isWord=x=>typeof x==='string'&&WORD.test(x),isBytes=x=>typeof x==='string'&&BYTES.test(x);
const quantity=(x,max=MAX)=>{if(typeof x==='string'&&x.length>80)return null;const n=uint(x);return n!==null&&n>=0n&&n<=max?n:null;};
const hex=x=>'0x'+BigInt(x).toString(16), sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
class ValidationError extends Error {}
const need=(condition,message)=>{if(!condition)throw new ValidationError(message);};
const publicError=e=>e instanceof ValidationError||e instanceof StateValidationError?e.message:'The provider did not complete a valid bounded read-only request.';
const tracer=diff=>({tracer:diff?'prestateTracer':'callTracer',timeout:'15s',tracerConfig:diff?{diffMode:true}:{withLog:true}});
const failed=frame=>Boolean(frame.error||frame.revertReason);
const visit=(frame,fn)=>{fn(frame);for(const child of frame.calls)visit(child,fn);};
// Geth can omit zero basic prefields. Accept that representation only when
// the caller independently read that exact original value at the pinned hash.
const observedPre=(record,field,independent)=>record[field]===undefined&&independent===0n?0n:quantity(record[field]);
function header(raw){
  need(record(raw)&&isWord(raw.hash)&&isWord(raw.parentHash)&&isWord(raw.mixHash)&&isAddress(raw.miner),'An explicit complete post-Merge block header is required.');
  need(['number','timestamp','gasLimit','baseFeePerGas'].every(k=>quantity(raw[k])!==null)&&uint(raw.number)>0n&&uint(raw.gasLimit)>0n,'Malformed block header quantities.');
  return {hash:lower(raw.hash),parentHash:lower(raw.parentHash),mixHash:lower(raw.mixHash),miner:lower(raw.miner),...Object.fromEntries(['number','timestamp','gasLimit','baseFeePerGas'].map(k=>[k,uint(raw[k]).toString()]))};
}
export function normalizeQuery(query){
  need(record(query)&&Object.keys(query).sort().join()==='data,to'&&isAddress(query.to)&&typeof query.data==='string'&&(BALANCE.test(query.data)||ALLOWANCE.test(query.data)),'Only canonical ERC-20 balanceOf and allowance queries are supported.');
  return {to:lower(query.to),data:lower(query.data)};
}
function bindTrace(raw,call){
  const stack=[{frame:raw,depth:0}];let count=0;
  while(stack.length){
    const {frame,depth}=stack.pop();
    need(record(frame)&&++count<=1000&&depth<=32,'Malformed or excessive trace frame tree.');
    const gas=quantity(frame.gas),used=quantity(frame.gasUsed);
    need(isBytes(frame.input)&&gas!==null&&used!==null&&used<=gas&&gas<=BigInt(call.gas),'Trace frame lacks complete bounded input and gas evidence.');
    for(const field of ['error','revertReason'])if(Object.hasOwn(frame,field))need(typeof frame[field]==='string'&&frame[field].length>0&&frame[field].length<=2000,'Trace frame has malformed explicit failure metadata.');
    need(frame.calls===undefined||(Array.isArray(frame.calls)&&frame.calls.length<=1000-count),'Malformed or excessive trace child list.');
    for(const child of frame.calls??[])stack.push({frame:child,depth:depth+1});
  }
  const trace=semanticTrace(raw);
  need(trace.type==='CALL'&&trace.from===call.from&&trace.to===call.to&&trace.input===call.data&&trace.value==='0'&&quantity(raw.gas)===quantity(call.gas),'Returned trace does not match the exact unsigned envelope.');
  need(BigInt(trace.gasUsed)>0n&&BigInt(trace.gasUsed)<=BigInt(call.gas),'Returned trace has invalid gas use.');
  return trace;
}
/** These checks establish observed query behavior, not honest token economics,
 * source attestation, complete asset discovery or a maliciousness verdict. */
export function validateQueryTrace(raw,call){
  const root=bindTrace(raw,call);need(WORD.test(root.output),'Query did not return exactly one uint256 word.');
  function check(frame,context,depth){
    need(!failed(frame)&&frame.value==='0'&&frame.logs.length===0,'Query trace has a failure, native transfer or event.');
    if(depth)need(['STATICCALL','DELEGATECALL'].includes(frame.type),'Query descendants must use STATICCALL or DELEGATECALL.');
    for(const child of frame.calls){
      need(child.from===context,'Query child caller differs from its execution context.');
      if(child.type==='DELEGATECALL')need(child.input===frame.input&&child.output===frame.output,'Query delegate does not preserve its input and output.');
      check(child,child.type==='DELEGATECALL'?context:child.to,depth+1);
    }
  }
  check(root,root.to,0);return {amountRaw:BigInt(root.output).toString(),gasUsed:root.gasUsed};
}
export function validateQueryDiff(raw,{sender,nonce,balance}){
  need(isAddress(sender)&&typeof nonce==='bigint'&&nonce>=0n&&nonce<MAX_NONCE&&typeof balance==='bigint'&&balance>=0n&&balance<=MAX,'Explicit independently read sender state is required.');
  const {diff}=normalizeProviderStateDiff(raw),before=diff.pre[sender],after=diff.post[sender];
  need(Object.keys(diff.pre).length===1&&Object.keys(diff.post).length===1&&before&&after,'Query must change only the sender nonce.');
  need([before,after].every(value=>Object.keys(value).every(k=>['nonce','balance'].includes(k))),'Query changed code or storage.');
  need(observedPre(before,'nonce',nonce)===nonce&&quantity(after.nonce)===nonce+1n,'Query sender nonce transition is inconsistent.');
  need(observedPre(before,'balance',balance)===balance&&(after.balance===undefined||quantity(after.balance)===balance),'Query debited native funds or its starting balance is not independently established.');
}

/** Executes the exact supplied unsigned call at block-end state. Query calls
 * are isolated before/after the COMPLETE original state overrides, and their
 * own nonce-only effects are discarded. Every requested query stays in output.
 * rpc.call must enforce a per-request timeout <=25s and retain raw transport
 * evidence externally; this function retains bounded parsed evidence too. */
export async function simulateUnsignedCall({rpc,chainId,blockHash,request,queries,now=()=>performance.now()}){
  const start=now(),evidence=[],measurements=[],automatic=queries===undefined;let retained=0,latched=null;
  const result={schemaVersion:'0.2',kind:'experimental_standard_evm_unsigned_call',security:{status:'not_assessed'},execution:{status:'unavailable'},measurements,evidence,
    scope:{state:'pinned_block_end',fees:'gas_price_omitted_no_fee_settlement',baseFee:'synthetic_zero_required',queries:'observed_ERC20_balanceOf_and_allowance_values',discovery:'explicit_queries_only',runtimeCodeAttestation:false,allEffectsCoverage:'inconclusive',signedTransactionValidation:false}};
  if(automatic){
    result.schemaVersion='0.3';result.scope.discovery='bounded_observed_trace_candidates';
    result.discovery={status:'unavailable',reason:'Original trace not reached.',queries:[],candidates:[]};
  }
  function deadline(){need(now()-start<LIMITS.wallMs,'Simulation exceeded its scheduling deadline.');}
  async function call(method,params){
    deadline();need(evidence.length<LIMITS.rpc,'Simulation exceeded its RPC budget.');
    const item={id:evidence.length+1,method,params:structuredClone(params)};evidence.push(item);
    try{
      const value=await rpc.call(method,structuredClone(params));deadline();assertNoProviderErrorResult(method,value);
      const text=JSON.stringify(value),bytes=Buffer.byteLength(text);need(bytes<=LIMITS.responseBytes&&retained+bytes<=LIMITS.evidenceBytes,'Simulation evidence exceeded its byte budget.');
      retained+=bytes;item.result=JSON.parse(text);return structuredClone(item.result);
    }catch(error){item.error=publicError(error);throw error;}
  }
  let pinned,identity,rawHeader,nonce,balance,overrides,originalCall;
  async function witness(after){
    const code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(BigInt(identity.number)-1n).toString(16).padStart(64,'0')+'4060e0526101006000f3';
    const input={from:originalCall.from,to:PROBE,data:'0x',value:'0x0',gas:'0x493e0'};
    const output=bindTrace(await call('debug_traceCall',[input,pinned,{...tracer(false),stateOverrides:{...(after?overrides:{}),[PROBE]:{code}}}]),input);
    need(!failed(output)&&output.calls.length===0&&output.logs.length===0&&output.output.length===514,'Header witness is incomplete.');
    const expected=[identity.number,identity.timestamp,identity.gasLimit,0,identity.mixHash,identity.miner,chainId,identity.parentHash].map(BigInt);
    need(expected.every((n,i)=>BigInt('0x'+output.output.slice(2+i*64,66+i*64))===n),'Execution header does not match the pinned synthetic BASEFEE-zero profile.');
  }
  try{
    need(quantity(chainId,BigInt(Number.MAX_SAFE_INTEGER))!==null&&BigInt(chainId)>0n&&isWord(blockHash),'A positive chain ID and explicit block hash are required.');
    need(record(request)&&Object.keys(request).sort().join()==='data,from,gas,to,value'&&isAddress(request.from)&&isAddress(request.to)&&typeof request.data==='string'&&request.data.length<=65538&&isBytes(request.data)&&quantity(request.value)===0n&&quantity(request.gas)!==null&&BigInt(request.gas)>21000n&&BigInt(request.gas)<=5000000n,'Unsupported unsigned call envelope.');
    need(automatic||(Array.isArray(queries)&&queries.length>0&&queries.length<=LIMITS.queries),'Between one and eight explicit queries are required.');
    let normalized=automatic?[]:queries.map(normalizeQuery);need(new Set(normalized.map(q=>q.to+q.data)).size===normalized.length,'Duplicate queries must be removed before execution.');
    measurements.push(...normalized.map(query=>({query,status:'unavailable',reason:'Not reached.'})));
    originalCall={from:lower(request.from),to:lower(request.to),data:lower(request.data),gas:hex(request.gas),value:'0x0'};
    need(originalCall.from!==PROBE&&originalCall.to!==PROBE&&normalized.every(q=>q.to!==PROBE),'Input overlaps the reserved header witness.');
    pinned={blockHash:lower(blockHash),requireCanonical:true};
    result.request={chainId:BigInt(chainId).toString(),block:pinned,transaction:originalCall,queries:normalized};
    if(automatic)result.request.querySelection='bounded_observed_trace_candidates';
    need(quantity(await call('eth_chainId',[]))===BigInt(chainId),'Provider chain identity differs from the request.');
    rawHeader=await call('eth_getBlockByHash',[pinned.blockHash,false]);identity=header(rawHeader);need(identity.hash===pinned.blockHash,'Provider returned the wrong source block.');result.block=identity;
    nonce=quantity(await call('eth_getTransactionCount',[originalCall.from,pinned]),MAX_NONCE-2n);
    balance=quantity(await call('eth_getBalance',[originalCall.from,pinned]));need(nonce!==null&&balance!==null,'Sender basic state is incomplete.');
    need(await call('eth_getCode',[originalCall.from,pinned])==='0x','Only code-free senders are supported.');
    for(const target of new Set([originalCall.to,...normalized.map(q=>q.to)])){
      const code=await call('eth_getCode',[target,pinned]);need(typeof code==='string'&&BYTES.test(code)&&code!=='0x','A declared target has no valid runtime code.');
    }
    need(await call('eth_getCode',[PROBE,pinned])==='0x','Reserved header witness address is not code-free.');
    const rawTrace=await call('debug_traceCall',[originalCall,pinned,tracer(false)]),trace=bindTrace(rawTrace,originalCall);
    result.execution={status:failed(trace)?'reverted_or_failed':'success',gasUsed:trace.gasUsed,returnData:trace.output,error:trace.error,revertReason:trace.revertReason,trace:rawTrace};
    if(failed(trace)){
      if(automatic)result.discovery={status:'not_applicable',reason:'Original execution did not succeed.',queries:[],candidates:[]};
      for(const entry of measurements)Object.assign(entry,{status:'not_applicable',reason:'Original execution did not succeed.'});
    }else{
      visit(trace,frame=>need(!['CREATE','CREATE2','SELFDESTRUCT'].includes(frame.type)&&frame.from!==PROBE&&frame.to!==PROBE,'Original execution contains unsupported lifecycle or witness-address behavior.'));
      if(automatic){
        result.discovery=discoverTokenQueries({request:originalCall,trace:rawTrace,maxQueries:LIMITS.queries});
        need(record(result.discovery)&&Array.isArray(result.discovery.queries)&&result.discovery.queries.length<=LIMITS.queries,'Automatic query selection exceeded its supported bounds.');
        normalized=result.discovery.queries.map(normalizeQuery);
        need(new Set(normalized.map(q=>q.to+q.data)).size===normalized.length&&normalized.every(q=>q.to!==PROBE),'Automatic query selection contains duplicate or reserved targets.');
        result.request.queries=normalized;
        measurements.push(...normalized.map(query=>({query,status:'unavailable',reason:'Not reached.'})));
        // Observed token calls/logs are hypotheses about query targets, not
        // balance measurements. Every selected target still needs pinned code,
        // and each before/after query follows the existing trace/diff checks.
        for(const target of new Set(normalized.map(q=>q.to).filter(to=>to!==originalCall.to))){
          const code=await call('eth_getCode',[target,pinned]);need(typeof code==='string'&&BYTES.test(code)&&code!=='0x','A selected target has no valid runtime code.');
        }
      }
      const normalizedDiff=normalizeProviderStateDiff(await call('debug_traceCall',[originalCall,pinned,tracer(true)])),diff=normalizedDiff.diff;result.stateDiff=diff;
      result.providerCodeHashChecks={basis:'Keccak256_of_explicit_provider_runtime_code_only',independentStateAttestation:false,claims:normalizedDiff.codeHashChecks};
      overrides=buildStateOverrides(diff);need(!Object.hasOwn(diff.pre,PROBE)&&!Object.hasOwn(diff.post,PROBE),'Original state changes overlap the header witness.');
      const before=diff.pre[originalCall.from],after=diff.post[originalCall.from];
      need(before&&after&&observedPre(before,'nonce',nonce)===nonce&&quantity(after.nonce)===nonce+1n&&observedPre(before,'balance',balance)===balance&&(after.balance===undefined||quantity(after.balance)===balance),'Original execution does not match the unpriced sender nonce/balance profile.');
      need([before,after].every(value=>Object.keys(value).every(k=>['nonce','balance'].includes(k))),'Sender state has unsupported fields.');
      await witness(false);await witness(true);
      result.executionIdentity={chainId:BigInt(chainId).toString(),stateBlockHash:pinned.blockHash,blockNumber:identity.number,timestamp:identity.timestamp,originalEnvelopeSha256:sha(originalCall),completeOverridesSha256:sha(overrides),actualBlockBaseFee:identity.baseFeePerGas,executionBaseFee:'0',omittedZeroPrefields:'accepted_only_with_independent_pinned_basic_state_reads'};
      for(const entry of measurements){
        try{
          const values=[];entry.queryEvidence=[];
          for(const afterState of [false,true]){
            const queryCall={from:originalCall.from,...entry.query,value:'0x0',gas:'0x493e0'},extra=afterState?{stateOverrides:overrides}:{};
            const proof={state:afterState?'after':'before',traceEvidenceId:evidence.length+1};entry.queryEvidence.push(proof);
            const qTrace=await call('debug_traceCall',[queryCall,pinned,{...tracer(false),...extra}]);
            const observed=validateQueryTrace(qTrace,queryCall);
            proof.mutationEvidenceId=evidence.length+1;
            const qDiff=await call('debug_traceCall',[queryCall,pinned,{...tracer(true),...extra}]);
            validateQueryDiff(qDiff,{sender:originalCall.from,nonce:nonce+(afterState?1n:0n),balance});values.push(observed.amountRaw);
          }
          delete entry.reason;Object.assign(entry,{status:'measured',beforeRaw:values[0],afterRaw:values[1],deltaRaw:(BigInt(values[1])-BigInt(values[0])).toString(),basis:'isolated_traced_ABI_queries_with_nonce_only_effects'});
        }catch(error){entry.reason=publicError(error);}
      }
    }
    const confirmedRaw=await call('eth_getBlockByNumber',[hex(identity.number),false]),confirmed=header(confirmedRaw);
    need(JSON.stringify(confirmed)===JSON.stringify(identity)&&isDeepStrictEqual(confirmedRaw,rawHeader),'Canonical header or block contents changed during simulation.');
    result.canonicalStatus='verified';
  }catch(error){latched=publicError(error);}
  if(latched){result.measurementFailure=latched;result.canonicalStatus='unverified';for(const entry of measurements){delete entry.beforeRaw;delete entry.afterRaw;delete entry.deltaRaw;delete entry.basis;Object.assign(entry,{status:'unavailable',reason:latched});}}
  result.accounting={rpcCalls:evidence.length,retainedResultBytes:retained,limits:LIMITS};
  return result;
}
