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
import { collectNativeEffects } from './native-effects.js';
import { composeSequenceOverrides } from './sequence-state.js';
import { encodePositionQuery, decodePositionResult, comparePositionResults, PositionQueryError } from './position-queries.js';
import { rpcEvmContext, EvmContextError } from '../evm-context.js';

const ADDRESS=/^0x[0-9a-f]{40}$/i, WORD=/^0x[0-9a-f]{64}$/i, BYTES=/^0x(?:[0-9a-f]{2})*$/i;
const BALANCE=/^0x70a082310{24}[0-9a-f]{40}$/i, ALLOWANCE=/^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/i;
const MAX=(1n<<256n)-1n, MAX_NONCE=(1n<<64n)-1n, PROBE='0x000000000000000000000000000000000000ba1a';
const LIMITS=Object.freeze({rpc:64,queries:8,responseBytes:8*1024*1024,evidenceBytes:32*1024*1024,wallMs:120000});
const lower=x=>typeof x==='string'?x.toLowerCase():'';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const isAddress=x=>typeof x==='string'&&ADDRESS.test(x),isWord=x=>typeof x==='string'&&WORD.test(x),isBytes=x=>typeof x==='string'&&BYTES.test(x);
const quantity=(x,max=MAX)=>{if(typeof x==='string'&&x.length>80)return null;const n=uint(x);return n!==null&&n>=0n&&n<=max?n:null;};
const hex=x=>'0x'+BigInt(x).toString(16), sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Continuations are private capabilities tied to an unmodified in-process result.
// Serialized reports and caller-supplied overrides cannot supply starting state.
const continuations = new WeakMap();
export const SEQUENCE_LIMITS=Object.freeze({minCalls:2,maxCalls:4,rpc:257,responseBytes:8*1024*1024,evidenceBytes:128*1024*1024,wallMs:240000});
class ValidationError extends Error {}
const need=(condition,message)=>{if(!condition)throw new ValidationError(message);};
const publicError=e=>e instanceof ValidationError||e instanceof StateValidationError?e.message:e instanceof PositionQueryError?'The declared position query or its returned ABI words are invalid.':e instanceof EvmContextError?'The optional EVM context is malformed or exceeds its fixed bounds.':'The provider did not complete a valid bounded read-only request.';
const tracer=diff=>({tracer:diff?'prestateTracer':'callTracer',timeout:'15s',tracerConfig:diff?{diffMode:true}:{withLog:true}});
const failed=frame=>Boolean(frame.error||frame.revertReason);
const visit=(frame,fn)=>{fn(frame);for(const child of frame.calls)visit(child,fn);};
// Geth can omit zero basic prefields. Accept that representation only when
// the caller independently read that exact original value at the pinned hash.
const observedPre=(record,field,independent)=>record[field]===undefined&&independent===0n?0n:quantity(record[field]);
const envelopeKeys=request=>['data','from','gas','to','value'].every(key=>Object.hasOwn(request,key))&&Object.keys(request).every(key=>['data','from','gas','to','value','accessList','blobVersionedHashes'].includes(key));
function header(raw){
  need(record(raw)&&isWord(raw.hash)&&isWord(raw.parentHash)&&isWord(raw.mixHash)&&isAddress(raw.miner),'An explicit complete post-Merge block header is required.');
  need(['number','timestamp','gasLimit','baseFeePerGas'].every(k=>quantity(raw[k])!==null)&&uint(raw.number)>0n&&uint(raw.gasLimit)>0n,'Malformed block header quantities.');
  return {hash:lower(raw.hash),parentHash:lower(raw.parentHash),mixHash:lower(raw.mixHash),miner:lower(raw.miner),...Object.fromEntries(['number','timestamp','gasLimit','baseFeePerGas'].map(k=>[k,uint(raw[k]).toString()]))};
}
export function normalizeQuery(query){
  need(record(query)&&Object.keys(query).sort().join()==='data,to'&&isAddress(query.to)&&typeof query.data==='string'&&(BALANCE.test(query.data)||ALLOWANCE.test(query.data)),'Only canonical ERC-20 balanceOf and allowance queries are supported.');
  return {to:lower(query.to),data:lower(query.data)};
}
/** The legacy raw ERC-20 form is unchanged. Typed descriptors declare an ABI,
 * not a verified protocol deployment; chain identity comes only from the call. */
export function normalizeMeasurementQuery(query,chainId){
  if(!record(query)||!Object.hasOwn(query,'kind'))return normalizeQuery(query);
  for(const key of Reflect.ownKeys(query)){
    const descriptor=Object.getOwnPropertyDescriptor(query,key);
    need(typeof key==='string'&&['kind','contract','user','marketId'].includes(key)&&descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'Unsupported typed position-query field.');
  }
  const {identity}=encodePositionQuery({...query,chainId});
  return {kind:identity.kind,contract:identity.contract,user:identity.user,...(identity.marketId===undefined?{}:{marketId:identity.marketId})};
}
export function compileMeasurementQuery(query,chainId){
  const descriptor=normalizeMeasurementQuery(query,chainId);
  if(!Object.hasOwn(descriptor,'kind'))return {descriptor,query:{...descriptor}};
  const {identity,query:compiled,signature,returnBytes}=encodePositionQuery({...descriptor,chainId});
  return {descriptor,query:compiled,position:{identity,signature,returnBytes}};
}
const newMeasurement=compiled=>({query:structuredClone(compiled.query),status:'unavailable',reason:'Not reached.',...(compiled.position?{position:structuredClone(compiled.position),contractIdentityVerified:false}:{})});
function clearMeasurementAmounts(entry){
  for(const field of ['beforeRaw','afterRaw','deltaRaw','basis','beforeReturnData','afterReturnData','rows'])delete entry[field];
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
  need(trace.type==='CALL'&&trace.from===call.from&&trace.to===call.to&&trace.input===call.data&&quantity(trace.value)===quantity(call.value)&&quantity(raw.gas)===quantity(call.gas),'Returned trace does not match the exact unsigned envelope.');
  need(BigInt(trace.gasUsed)>0n&&BigInt(trace.gasUsed)<=BigInt(call.gas),'Returned trace has invalid gas use.');
  return trace;
}
/** These checks establish observed query behavior, not honest token economics,
 * source attestation, complete asset discovery or a maliciousness verdict. */
function validateReadTrace(raw,call,returnBytes,{allowDelegateAbiChanges=false}={}){
  const root=bindTrace(raw,call);
  need(isBytes(root.output)&&root.output.length===2+returnBytes*2,returnBytes===32?'Query did not return exactly one uint256 word.':'Position query did not return its exact declared static ABI tuple.');
  function check(frame,context,depth){
    need(!failed(frame)&&frame.value==='0'&&frame.logs.length===0,'Query trace has a failure, native transfer or event.');
    if(depth)need(['STATICCALL','DELEGATECALL'].includes(frame.type),'Query descendants must use STATICCALL or DELEGATECALL.');
    for(const child of frame.calls){
      need(child.from===context,'Query child caller differs from its execution context.');
      // Scalar token queries retain their proxy-forwarding restriction. A
      // declared position getter can call a library with a different ABI;
      // its root tuple and isolated nonce-only mutation proofs still bind it.
      if(child.type==='DELEGATECALL'&&!allowDelegateAbiChanges)need(child.input===frame.input&&child.output===frame.output,'Query delegate does not preserve its input and output.');
      check(child,child.type==='DELEGATECALL'?context:child.to,depth+1);
    }
  }
  check(root,root.to,0);return root;
}
export function validateQueryTrace(raw,call){
  const root=validateReadTrace(raw,call,32);return {amountRaw:BigInt(root.output).toString(),gasUsed:root.gasUsed};
}
/** Trace-shape validation only. A before/after measurement additionally needs
 * both isolated mutation proofs, complete state overrides and canonical checks. */
export function validatePositionTrace(raw,call,position){
  const root=validateReadTrace(raw,call,position.returnBytes,{allowDelegateAbiChanges:true});
  const decoded=decodePositionResult(position.identity,root.output);
  need(isDeepStrictEqual(decoded.query,{to:call.to,data:call.data})&&isDeepStrictEqual({identity:decoded.identity,signature:decoded.signature,returnBytes:decoded.returnBytes},position),'Position query identity differs from the compiled call.');
  return root.output;
}
function validateNonceOnlyDiff(diff,{sender,nonce,balance},label){
  need(isAddress(sender)&&typeof nonce==='bigint'&&nonce>=0n&&nonce<MAX_NONCE&&typeof balance==='bigint'&&balance>=0n&&balance<=MAX,'Explicit independently read sender state is required.');
  const before=diff.pre[sender],after=diff.post[sender];
  need(Object.keys(diff.pre).length===1&&Object.keys(diff.post).length===1&&before&&after,`${label} must change only the sender nonce.`);
  need([before,after].every(value=>Object.keys(value).every(k=>['nonce','balance'].includes(k))),`${label} changed code or storage.`);
  need(observedPre(before,'nonce',nonce)===nonce&&quantity(after.nonce)===nonce+1n,`${label} sender nonce transition is inconsistent.`);
  need(observedPre(before,'balance',balance)===balance&&(after.balance===undefined||quantity(after.balance)===balance),`${label} debited native funds or its starting balance is not independently established.`);
}
export function validateQueryDiff(raw,anchors){
  validateNonceOnlyDiff(normalizeProviderStateDiff(raw).diff,anchors,'Query');
}
/** A reverted trace alone never proves unchanged state. This unpriced profile
 * requires an explicit complete diff showing only the sender nonce increment;
 * omitted zero prefields need independent starting-state anchors as above. */
export function validateRevertedStateDiff(raw,anchors){
  const normalized=normalizeProviderStateDiff(raw);
  validateNonceOnlyDiff(normalized.diff,anchors,'Reverted execution');return normalized;
}

/** Executes the exact supplied unsigned call at block-end state. Query calls
 * are isolated before/after the COMPLETE original state overrides, and their
 * own nonce-only effects are discarded. Every requested query stays in output.
 * rpc.call must enforce a per-request timeout <=25s and retain raw transport
 * evidence externally; this function retains bounded parsed evidence too. */
export async function simulateUnsignedCall({rpc,chainId,blockHash,request,queries,previous,now=()=>performance.now()}){
  const start=now(),evidence=[],measurements=[],automatic=queries===undefined;let retained=0,latched=null;
  const result={schemaVersion:'0.2',kind:'experimental_standard_evm_unsigned_call',security:{status:'not_assessed'},execution:{status:'unavailable'},measurements,evidence,
    nativeEffects:{status:'unavailable',reason:'Original state changes not reached.',feeScope:'excluded',maxAccounts:8,measurements:[]},
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
  let pinned,identity,rawHeader,nonce,balance,postBalance,overrides,originalCall,predecessor,initialOverrides,originalContext={};
  const initialOptions=()=>initialOverrides?{stateOverrides:structuredClone(initialOverrides)}:{};
  function startingBasic(account,field,pinnedValue,evidenceId){
    const carried=initialOverrides?.[account]?.[field];
    const value=carried===undefined?pinnedValue:quantity(carried,field==='nonce'?MAX_NONCE:MAX);
    need(value!==null,'Carried basic state is malformed.');
    if(predecessor)result.startingState.basicStateReads.push({account,field,pinnedEvidenceId:evidenceId,pinnedRaw:pinnedValue.toString(),startingRaw:value.toString(),basis:carried===undefined?'pinned_block_read':'validated_previous_state_override'});
    return value;
  }
  const nativeAnchors=new Map(),nativeExpected=new Map(),targetCodes=new Map();
  async function witness(after){
    const rows=result.nativeEffects.measurements;
    const blobs=originalContext.blobVersionedHashes??[],blobWords=blobs.length?blobs.length+2:0;
    let code='0x43600052426020524560405248606052446080524160a0524660c0527f'+(BigInt(identity.number)-1n).toString(16).padStart(64,'0')+'4060e052';
    for(const [i,row] of rows.entries())code+='73'+row.account.slice(2)+'3161'+(256+32*i).toString(16).padStart(4,'0')+'52';
    if(blobs.length){
      // Include every declared index and the first out-of-range index. The
      // final word independently observes the synthetic zero blob base fee.
      for(let i=0;i<=blobs.length;i++)code+='60'+i.toString(16).padStart(2,'0')+'4961'+(256+32*(rows.length+i)).toString(16).padStart(4,'0')+'52';
      code+='4a61'+(256+32*(rows.length+blobs.length+1)).toString(16).padStart(4,'0')+'52';
    }
    code+='61'+(256+32*(rows.length+blobWords)).toString(16).padStart(4,'0')+'6000f3';
    // The witness retains the original access list, so each occurrence also
    // consumes transaction intrinsic gas. Preserve the legacy message budget.
    const accessGas=(originalContext.accessList??[]).reduce((sum,row)=>sum+2400n+1900n*BigInt(row.storageKeys.length),0n);
    const input={from:originalCall.from,to:PROBE,data:'0x',value:'0x0',gas:'0x'+(300000n+accessGas).toString(16),...originalContext};
    const stateOverrides={...(after?overrides:initialOverrides??{}),[PROBE]:{code}},traceEvidenceId=evidence.length+1;
    const output=bindTrace(await call('debug_traceCall',[input,pinned,{...tracer(false),stateOverrides}]),input);
    need(!failed(output)&&output.calls.length===0&&output.logs.length===0&&output.output.length===514+64*(rows.length+blobWords),'Header and native-balance witness is incomplete.');
    const expected=[identity.number,identity.timestamp,identity.gasLimit,0,identity.mixHash,identity.miner,chainId,identity.parentHash].map(BigInt);
    need(expected.every((n,i)=>BigInt('0x'+output.output.slice(2+i*64,66+i*64))===n),'Execution header does not match the pinned synthetic BASEFEE-zero profile.');
    if(blobs.length){
      const expectedBlobs=[...blobs,0,0].map(BigInt),offset=514+64*rows.length;
      need(expectedBlobs.every((n,i)=>BigInt('0x'+output.output.slice(offset+i*64,offset+(i+1)*64))===n),'Execution blob hashes or synthetic BLOBBASEFEE-zero context do not match the declared call.');
      result.blobContextValidation.witnesses.push({state:after?'after':'before',traceEvidenceId,hashWordStart:8+rows.length,hashCount:blobs.length,outOfRangeIndex:blobs.length,blobBaseFeeRaw:'0'});
    }
    if(rows.length){
      const mutationEvidenceId=evidence.length+1;
      validateQueryDiff(await call('debug_traceCall',[input,pinned,{...tracer(true),stateOverrides}]),{sender:originalCall.from,nonce:nonce+(after?1n:0n),balance:after?postBalance:balance});
      for(const [i,row] of rows.entries()){
        const observed=BigInt('0x'+output.output.slice(514+64*i,578+64*i));
        need(observed===(after?nativeExpected.get(row.account):nativeAnchors.get(row.account).value),'Native-balance witness disagrees with pinned balances or complete original state changes.');
        row[after?'afterRaw':'beforeRaw']=observed.toString();
        row.queryEvidence.push({state:after?'after':'before',traceEvidenceId,mutationEvidenceId,wordIndex:8+i});
      }
    }
  }

  try{
    need(quantity(chainId,BigInt(Number.MAX_SAFE_INTEGER))!==null&&BigInt(chainId)>0n&&isWord(blockHash),'A positive chain ID and explicit block hash are required.');
    originalContext=rpcEvmContext(request);
    need(record(request)&&envelopeKeys(request)&&isAddress(request.from)&&isAddress(request.to)&&typeof request.data==='string'&&request.data.length<=65538&&isBytes(request.data)&&quantity(request.value)!==null&&quantity(request.gas)!==null&&BigInt(request.gas)>21000n&&BigInt(request.gas)<=5000000n,'Unsupported unsigned call envelope.');
    need(automatic||(Array.isArray(queries)&&queries.length>0&&queries.length<=LIMITS.queries),'Between one and eight explicit queries are required.');
    let compiled=automatic?[]:queries.map(query=>compileMeasurementQuery(query,chainId)),normalized=compiled.map(item=>item.descriptor);
    need(new Set(compiled.map(item=>item.query.to+item.query.data)).size===compiled.length,'Duplicate queries must be removed before execution.');
    measurements.push(...compiled.map(newMeasurement));
    if(compiled.some(item=>item.position)){
      result.schemaVersion='0.4';result.scope.queries='observed_ERC20_queries_and_declared_position_ABI_fields';
      result.scope.positionContracts='caller_declared_not_authenticated';
    }
    originalCall={from:lower(request.from),to:lower(request.to),data:lower(request.data),gas:hex(request.gas),value:hex(request.value),...originalContext};
    need(originalCall.from!==PROBE&&originalCall.to!==PROBE&&compiled.every(item=>item.query.to!==PROBE),'Input overlaps the reserved header witness.');
    pinned={blockHash:lower(blockHash),requireCanonical:true};
    if(previous!==undefined){
      predecessor=record(previous)?continuations.get(previous):undefined;
      need(predecessor&&sha(previous)===predecessor.resultSha256,'Continuation requires an unmodified validated in-process predecessor.');
      need(predecessor.chainId===BigInt(chainId).toString()&&predecessor.blockHash===pinned.blockHash&&predecessor.sender===originalCall.from&&predecessor.priorCalls<SEQUENCE_LIMITS.maxCalls,'Continuation chain, block, sender or length does not match.');
      initialOverrides=structuredClone(predecessor.overrides);
      result.scope.state='pinned_block_end_plus_prior_validated_calls';
      result.startingState={kind:'after_previous_simulation',previousResultSha256:predecessor.resultSha256,priorCalls:predecessor.priorCalls,completeOverridesSha256:sha(initialOverrides),overrides:structuredClone(initialOverrides),basicStateReads:[]};
    }
    result.request={chainId:BigInt(chainId).toString(),block:pinned,transaction:originalCall,queries:normalized};
    if(automatic)result.request.querySelection='bounded_observed_trace_candidates';
    need(quantity(await call('eth_chainId',[]))===BigInt(chainId),'Provider chain identity differs from the request.');
    rawHeader=await call('eth_getBlockByHash',[pinned.blockHash,false]);identity=header(rawHeader);need(identity.hash===pinned.blockHash,'Provider returned the wrong source block.');result.block=identity;
    if(originalContext.blobVersionedHashes){
      need(BigInt(chainId)===1n&&BigInt(identity.timestamp)>=1710338135n&&quantity(rawHeader.excessBlobGas,MAX_NONCE)!==null&&quantity(rawHeader.blobGasUsed,MAX_NONCE)!==null,'Blob context requires an explicit Cancun-or-later Ethereum header.');
      result.blobContextValidation={status:'unavailable',basis:'same_context_BLOBHASH_and_BLOBBASEFEE_witnesses',sourceExcessBlobGas:quantity(rawHeader.excessBlobGas).toString(),executionBlobBaseFee:'0',hashCount:originalContext.blobVersionedHashes.length,witnesses:[],sidecarsVerified:false,feeSettlement:false};
    }
    if(predecessor)need(isDeepStrictEqual(rawHeader,predecessor.rawHeader),'Continuation header or block contents differ from the predecessor.');
    nonce=quantity(await call('eth_getTransactionCount',[originalCall.from,pinned]),MAX_NONCE-2n);
    need(nonce!==null,'Sender basic state is incomplete.');nonce=startingBasic(originalCall.from,'nonce',nonce,evidence.length);
    need(nonce<=MAX_NONCE-2n,'Carried sender nonce exceeds the supported range.');
    balance=quantity(await call('eth_getBalance',[originalCall.from,pinned]));need(balance!==null,'Sender basic state is incomplete.');
    const pinnedSenderBalance=balance;balance=startingBasic(originalCall.from,'balance',balance,evidence.length);
    nativeAnchors.set(originalCall.from,{value:balance,pinnedValue:pinnedSenderBalance,evidenceId:evidence.length});
    need(await call('eth_getCode',[originalCall.from,pinned])==='0x','Only code-free senders are supported.');
    for(const target of new Set([originalCall.to,...compiled.map(item=>item.query.to)])){
      const code=await call('eth_getCode',[target,pinned]);need(typeof code==='string'&&BYTES.test(code)&&(code!=='0x'||(target===originalCall.to&&!compiled.some(item=>item.query.to===target))),'A declared target has no valid runtime code.');targetCodes.set(target,code);
    }
    need(await call('eth_getCode',[PROBE,pinned])==='0x','Reserved header witness address is not code-free.');
    const originalTraceEvidenceId=evidence.length+1;
    const rawTrace=await call('debug_traceCall',[originalCall,pinned,{...tracer(false),...initialOptions()}]),trace=bindTrace(rawTrace,originalCall);
    result.execution={status:failed(trace)?'reverted_or_failed':'success',gasUsed:trace.gasUsed,returnData:trace.output,error:trace.error,revertReason:trace.revertReason,trace:rawTrace};
    if(failed(trace)){
      result.nativeEffects={...result.nativeEffects,status:'not_applicable',reason:'Original execution did not succeed.'};
      if(automatic)result.discovery={status:'not_applicable',reason:'Original execution did not succeed.',queries:[],candidates:[]};
      for(const entry of measurements)Object.assign(entry,{status:'not_applicable',reason:'Original execution did not succeed.'});
      const diffEvidenceId=evidence.length+1;
      const rawDiff=await call('debug_traceCall',[originalCall,pinned,{...tracer(true),...initialOptions()}]);
      const normalizedDiff=validateRevertedStateDiff(rawDiff,{sender:originalCall.from,nonce,balance});
      result.stateDiff=normalizedDiff.diff;
      result.providerCodeHashChecks={basis:'Keccak256_of_explicit_provider_runtime_code_only',independentStateAttestation:false,claims:normalizedDiff.codeHashChecks};
      if(predecessor){
        const composed=composeSequenceOverrides(initialOverrides,result.stateDiff);overrides=composed.overrides;result.startingState.overlapChecks=composed.overlapChecks;
      }else overrides=buildStateOverrides(result.stateDiff);
      postBalance=balance;
      const beforeWitnessEvidenceId=evidence.length+1;await witness(false);
      const afterWitnessEvidenceId=evidence.length+1;await witness(true);
      result.revertStateValidation={status:'unavailable',basis:'explicit_original_nonce_only_diff_and_same_context_header_witnesses',
        originalTraceEvidenceId,diffEvidenceId,beforeWitnessEvidenceId,afterWitnessEvidenceId,
        sender:originalCall.from,beforeNonceRaw:nonce.toString(),afterNonceRaw:(nonce+1n).toString(),balanceRaw:balance.toString(),
        changesBeyondSenderNonce:'none_observed',feeSettlement:false};
      result.executionIdentity={chainId:BigInt(chainId).toString(),stateBlockHash:pinned.blockHash,blockNumber:identity.number,timestamp:identity.timestamp,originalEnvelopeSha256:sha(originalCall),completeOverridesSha256:sha(overrides),actualBlockBaseFee:identity.baseFeePerGas,executionBaseFee:'0',omittedZeroPrefields:predecessor?'accepted_only_with_validated_starting_basic_state':'accepted_only_with_independent_pinned_basic_state_reads'};
    }else{
      visit(trace,frame=>need(!['CREATE','CREATE2','SELFDESTRUCT'].includes(frame.type)&&frame.from!==PROBE&&frame.to!==PROBE,'Original execution contains unsupported lifecycle or witness-address behavior.'));
      if(automatic){
        result.discovery=discoverTokenQueries({request:originalCall,trace:rawTrace,maxQueries:LIMITS.queries});
        need(record(result.discovery)&&Array.isArray(result.discovery.queries)&&result.discovery.queries.length<=LIMITS.queries,'Automatic query selection exceeded its supported bounds.');
        normalized=result.discovery.queries.map(normalizeQuery);compiled=normalized.map(query=>compileMeasurementQuery(query,chainId));
        need(new Set(normalized.map(q=>q.to+q.data)).size===normalized.length&&normalized.every(q=>q.to!==PROBE),'Automatic query selection contains duplicate or reserved targets.');
        result.request.queries=normalized;
        measurements.push(...compiled.map(newMeasurement));
        // Observed token calls/logs are hypotheses about query targets, not
        // balance measurements. Every selected target still needs pinned code,
        // and each before/after query follows the existing trace/diff checks.
        for(const target of new Set(normalized.map(q=>q.to))){
          const code=targetCodes.has(target)?targetCodes.get(target):await call('eth_getCode',[target,pinned]);need(typeof code==='string'&&BYTES.test(code)&&code!=='0x','A selected target has no valid runtime code.');
        }
      }
      const normalizedDiff=normalizeProviderStateDiff(await call('debug_traceCall',[originalCall,pinned,{...tracer(true),...initialOptions()}])),diff=normalizedDiff.diff;result.stateDiff=diff;
      result.providerCodeHashChecks={basis:'Keccak256_of_explicit_provider_runtime_code_only',independentStateAttestation:false,claims:normalizedDiff.codeHashChecks};
      need(!Object.hasOwn(diff.pre,PROBE)&&!Object.hasOwn(diff.post,PROBE),'Original state changes overlap the header witness.');
      const collection=collectNativeEffects(trace,diff);
      result.nativeEffects={...collection,status:'unavailable',counts:{...collection.counts,measured:0},measurements:[]};
      const effectiveDiff=structuredClone(diff),normalizations=[];
      // Reserve both header traces, both optional native mutation checks, all
      // token queries and the final canonical check before adding native reads.
      const reserve=4*normalized.length+(collection.candidates.length?5:3);
      async function basic(method,account){
        need(evidence.length+reserve<LIMITS.rpc,'Complete native state preparation exceeds the reserved RPC budget.');
        return call(method,[account,pinned]);
      }
      async function anchor(account){
        if(!nativeAnchors.has(account)){
          const pinnedValue=quantity(await basic('eth_getBalance',account));need(pinnedValue!==null,'Pinned native balance is malformed.');
          const value=startingBasic(account,'balance',pinnedValue,evidence.length);
          nativeAnchors.set(account,{value,pinnedValue,evidenceId:evidence.length});
        }
        return nativeAnchors.get(account).value;
      }
      // A value transfer can fund an empty address without CREATE. Normalize
      // that provider representation only after independently anchoring all
      // empty basic fields; leave the original reported diff intact.
      for(const account of Object.keys(diff.post).filter(account=>!Object.hasOwn(diff.pre,account))){
        const post=diff.post[account];
        need(quantity(post.balance)>0n&&(post.nonce===undefined||quantity(post.nonce)===0n)&&(post.code===undefined||post.code==='0x')&&(post.storage===undefined||Object.keys(post.storage).length===0),'Unsupported newly created account state.');
        need(BigInt(collection.netValueByAccount[account]??'0')>0n&&await anchor(account)===0n,'New funded account lacks an independently established empty balance.');
        const nonceId=evidence.length+1;
        const pinnedNonce=quantity(await basic('eth_getTransactionCount',account),MAX_NONCE);need(pinnedNonce!==null,'Pinned account nonce is malformed.');
        need(startingBasic(account,'nonce',pinnedNonce,evidence.length)===0n,'New funded account did not have an empty nonce.');
        const codeId=evidence.length+1;need(await basic('eth_getCode',account)==='0x','New funded account did not have empty code.');
        effectiveDiff.pre[account]={balance:'0',...(post.nonce===undefined?{}:{nonce:'0'}),...(post.code===undefined?{}:{code:'0x'})};
        normalizations.push({account,basis:predecessor?'validated_starting_zero_balance_zero_nonce_and_pinned_empty_code':'pinned_zero_balance_zero_nonce_empty_code',balanceEvidenceId:nativeAnchors.get(account).evidenceId,nonceEvidenceId:nonceId,codeEvidenceId:codeId});
      }
      // Validate every reported native transition, including accounts omitted
      // from the eight-account display. Missing pre.balance is never guessed.
      for(const candidate of collection.candidates){
        const account=candidate.account,pre=effectiveDiff.pre[account],post=effectiveDiff.post[account],net=BigInt(candidate.netValueRaw);
        need(Boolean(pre)===Boolean(post),'Native account lifecycle changes are unsupported.');
        if(pre){
          const initial=pre.balance===undefined?await anchor(account):quantity(pre.balance);
          need(initial!==null&&(pre.balance!==undefined||initial===0n),'Omitted native prebalance was not independently established as zero.');
          const final=post.balance===undefined?initial:quantity(post.balance);
          need(final!==null&&final-initial===net,'Native state diff disagrees with committed CALL value effects.');
          nativeExpected.set(account,final);
        }else need(net===0n,'Native transfer is absent from the complete original state diff.');
      }
      if(predecessor){
        const composed=composeSequenceOverrides(initialOverrides,effectiveDiff);overrides=composed.overrides;result.startingState.overlapChecks=composed.overlapChecks;
      }else overrides=buildStateOverrides(effectiveDiff);
      if(normalizations.length)result.nativeEffects.stateNormalization=normalizations;
      const before=diff.pre[originalCall.from],after=diff.post[originalCall.from];
      postBalance=after?.balance===undefined?balance:quantity(after.balance);
      need(before&&after&&observedPre(before,'nonce',nonce)===nonce&&quantity(after.nonce)===nonce+1n&&observedPre(before,'balance',balance)===balance&&postBalance!==null&&postBalance===balance+BigInt(collection.netValueByAccount[originalCall.from]??'0'),'Original execution does not match the unpriced sender nonce/balance profile.');
      need([before,after].every(value=>Object.keys(value).every(k=>['nonce','balance'].includes(k))),'Sender state has unsupported fields.');
      for(const candidate of result.nativeEffects.candidates.filter(candidate=>candidate.selected)){
        const account=candidate.account;
        if(!nativeAnchors.has(account)&&evidence.length+reserve>=LIMITS.rpc){candidate.selected=false;candidate.reason='rpc-budget';continue;}
        const initial=await anchor(account),pre=effectiveDiff.pre[account];
        need(!pre||observedPre(pre,'balance',initial)===initial,'Native state prebalance differs from its pinned independent read.');
        if(!nativeExpected.has(account))nativeExpected.set(account,initial);
        result.nativeEffects.measurements.push({account,status:'unavailable',reason:'Witness not reached.',anchorEvidenceId:nativeAnchors.get(account).evidenceId,...(predecessor?{startingBalance:{basis:initialOverrides[account]?.balance===undefined?'pinned_block_read':'validated_previous_state_override',pinnedRaw:nativeAnchors.get(account).pinnedValue.toString(),startingRaw:initial.toString(),completeOverridesSha256:sha(initialOverrides)}}:{}),queryEvidence:[]});
      }
      result.nativeEffects.selectedAccounts=result.nativeEffects.measurements.map(row=>row.account);
      result.nativeEffects.counts.selected=result.nativeEffects.measurements.length;
      result.nativeEffects.counts.omitted=collection.candidates.length-result.nativeEffects.measurements.length;
      await witness(false);await witness(true);
      for(const row of result.nativeEffects.measurements){delete row.reason;Object.assign(row,{status:'measured',deltaRaw:(BigInt(row.afterRaw)-BigInt(row.beforeRaw)).toString(),basis:predecessor?'validated_carried_balances_and_isolated_BALANCE_witnesses_with_nonce_only_effects':'pinned_balance_reads_and_isolated_BALANCE_witnesses_with_nonce_only_effects'});}
      result.nativeEffects.counts.measured=result.nativeEffects.measurements.length;
      result.nativeEffects.status=collection.candidates.length===0?'none':result.nativeEffects.counts.omitted?'partial':'measured';
      result.executionIdentity={chainId:BigInt(chainId).toString(),stateBlockHash:pinned.blockHash,blockNumber:identity.number,timestamp:identity.timestamp,originalEnvelopeSha256:sha(originalCall),completeOverridesSha256:sha(overrides),actualBlockBaseFee:identity.baseFeePerGas,executionBaseFee:'0',omittedZeroPrefields:predecessor?'accepted_only_with_validated_starting_basic_state':'accepted_only_with_independent_pinned_basic_state_reads'};
      for(const entry of measurements){
        try{
          const values=[];entry.queryEvidence=[];
          for(const afterState of [false,true]){
            const queryCall={from:originalCall.from,...entry.query,value:'0x0',gas:'0x493e0'},extra=afterState?{stateOverrides:overrides}:initialOptions();
            const proof={state:afterState?'after':'before',traceEvidenceId:evidence.length+1};entry.queryEvidence.push(proof);
            const qTrace=await call('debug_traceCall',[queryCall,pinned,{...tracer(false),...extra}]);
            const value=entry.position?validatePositionTrace(qTrace,queryCall,entry.position):validateQueryTrace(qTrace,queryCall).amountRaw;
            proof.mutationEvidenceId=evidence.length+1;
            const qDiff=await call('debug_traceCall',[queryCall,pinned,{...tracer(true),...extra}]);
            validateQueryDiff(qDiff,{sender:originalCall.from,nonce:nonce+(afterState?1n:0n),balance:afterState?postBalance:balance});values.push(value);
          }
          const payload=entry.position?{
            beforeReturnData:values[0],afterReturnData:values[1],
            rows:comparePositionResults({request:entry.position.identity,before:values[0],after:values[1]}).rows,
          }:{beforeRaw:values[0],afterRaw:values[1],deltaRaw:(BigInt(values[1])-BigInt(values[0])).toString()};
          delete entry.reason;Object.assign(entry,{status:'measured',...payload,basis:'isolated_traced_ABI_queries_with_nonce_only_effects'});
        }catch(error){entry.reason=publicError(error);}
      }
    }
    const confirmedRaw=await call('eth_getBlockByNumber',[hex(identity.number),false]),confirmed=header(confirmedRaw);
    need(JSON.stringify(confirmed)===JSON.stringify(identity)&&isDeepStrictEqual(confirmedRaw,rawHeader),'Canonical header or block contents changed during simulation.');
    result.canonicalStatus='verified';
    if(result.revertStateValidation)result.revertStateValidation.status='verified';
    if(result.blobContextValidation)result.blobContextValidation.status='verified';
  }catch(error){latched=publicError(error);}
  if(latched){result.measurementFailure=latched;result.canonicalStatus='unverified';result.nativeEffects.status='unavailable';result.nativeEffects.reason=latched;if(result.nativeEffects.counts)result.nativeEffects.counts.measured=0;for(const entry of [...measurements,...result.nativeEffects.measurements]){clearMeasurementAmounts(entry);Object.assign(entry,{status:'unavailable',reason:latched});}}
  result.accounting={rpcCalls:evidence.length,retainedResultBytes:retained,limits:LIMITS};
  if(!latched&&result.execution.status==='success'&&result.canonicalStatus==='verified'&&overrides){
    continuations.set(result,{chainId:BigInt(chainId).toString(),blockHash:pinned.blockHash,sender:originalCall.from,priorCalls:(predecessor?.priorCalls??0)+1,rawHeader:structuredClone(rawHeader),overrides:structuredClone(overrides),resultSha256:sha(result)});
  }
  return result;
}

function invalidateSequenceAmounts(result,reason){
  continuations.delete(result);
  result.canonicalStatus='unverified';result.measurementFailure??=reason;result.sequenceValidationFailure=reason;
  if(result.revertStateValidation)result.revertStateValidation.status='unavailable';
  if(result.blobContextValidation)result.blobContextValidation.status='unavailable';
  result.nativeEffects.status='unavailable';result.nativeEffects.reason=reason;
  if(result.nativeEffects.counts)result.nativeEffects.counts.measured=0;
  for(const entry of [...result.measurements,...result.nativeEffects.measurements]){
    clearMeasurementAmounts(entry);
    Object.assign(entry,{status:'unavailable',reason});
  }
}

/** Ordered, separate unsigned calls at one unchanged block context. Only an
 * actual successful validated predecessor can supply subsequent state. Query
 * mutations are discarded and later failures never imply an atomic rollback. */
export async function simulateUnsignedSequence({rpc,chainId,blockHash,calls,now=()=>performance.now()}){
  // Validate every envelope before the first provider request; otherwise an
  // invalid last input could leave a misleading successful partial sequence.
  need(quantity(chainId,BigInt(Number.MAX_SAFE_INTEGER))!==null&&BigInt(chainId)>0n&&isWord(blockHash),'A positive chain ID and explicit block hash are required.');
  need(Array.isArray(calls)&&calls.length>=SEQUENCE_LIMITS.minCalls&&calls.length<=SEQUENCE_LIMITS.maxCalls,'An ordered sequence requires between two and four calls.');
  let sender;
  const inputs=calls.map(input=>{
    need(record(input)&&Object.keys(input).every(key=>['request','queries'].includes(key)),'Unsupported sequence input fields.');
    const request=input.request;
    rpcEvmContext(request);
    need(record(request)&&envelopeKeys(request)&&isAddress(request.from)&&isAddress(request.to)&&typeof request.data==='string'&&request.data.length<=65538&&isBytes(request.data)&&quantity(request.value)!==null&&quantity(request.gas)!==null&&BigInt(request.gas)>21000n&&BigInt(request.gas)<=5000000n,'Unsupported unsigned sequence envelope.');
    sender??=lower(request.from);need(lower(request.from)===sender,'Every sequence call must use the same sender.');
    need(lower(request.from)!==PROBE&&lower(request.to)!==PROBE,'Input overlaps the reserved header witness.');
    if(input.queries!==undefined){
      need(Array.isArray(input.queries)&&input.queries.length>0&&input.queries.length<=LIMITS.queries,'Between one and eight explicit queries are required.');
      const queries=input.queries.map(query=>compileMeasurementQuery(query,chainId));
      need(queries.every(item=>item.query.to!==PROBE)&&new Set(queries.map(item=>item.query.to+item.query.data)).size===queries.length,'Sequence queries contain duplicate or reserved targets.');
    }
    return structuredClone(input);
  });
  const start=now(),evidence=[];let retained=0,activeIndex=0,previous,referenceHeader,sharedFailure;
  const result={schemaVersion:'0.1',kind:'experimental_standard_evm_unsigned_sequence',security:{status:'not_assessed'},canonicalStatus:'unverified',
    scope:{state:'pinned_block_end_plus_prior_validated_calls',atomic:false,stopsOnFailure:true,fees:'excluded',blockTimeAdvancement:false,queryMutationsCarried:false,signedTransactionValidation:false,allEffectsCoverage:'inconclusive'},
    sequence:{status:'unavailable',completedSteps:0,attemptedSteps:0},
    steps:inputs.map((input,index)=>({index,input:structuredClone(input.request),stateSource:index===0?{kind:'initial_block'}:{kind:'after_step',stepIndex:index-1},status:'skipped',reason:'Not reached.'})),sequenceEvidence:evidence};
  async function boundedCall(method,params,final=false){
    need(now()-start<SEQUENCE_LIMITS.wallMs,'Sequence exceeded its scheduling deadline.');
    need(evidence.length<SEQUENCE_LIMITS.rpc-(final?0:1),'Sequence exceeded its shared RPC budget.');
    const item={id:evidence.length+1,...(final?{kind:'final_canonical_check'}:{stepIndex:activeIndex}),method,paramsSha256:sha(params)};evidence.push(item);
    try{
      const value=await rpc.call(method,structuredClone(params));
      need(now()-start<SEQUENCE_LIMITS.wallMs,'Sequence exceeded its scheduling deadline.');assertNoProviderErrorResult(method,value);
      const serialized=JSON.stringify(value),bytes=Buffer.byteLength(serialized);
      need(bytes<=SEQUENCE_LIMITS.responseBytes&&retained+bytes<=SEQUENCE_LIMITS.evidenceBytes,'Sequence evidence exceeded its shared byte budget.');
      retained+=bytes;Object.assign(item,{resultBytes:bytes,resultSha256:sha(value)});
      return structuredClone(value);
    }catch(error){item.error=publicError(error);throw error;}
  }
  for(const [index,input] of inputs.entries()){
    activeIndex=index;const step=result.steps[index];result.sequence.attemptedSteps++;
    const output=await simulateUnsignedCall({rpc:{call:(method,params)=>boundedCall(method,params)},chainId,blockHash,...input,...(previous?{previous}:{}),now});
    step.result=output;delete step.reason;
    const sourceHeader=output.evidence.find(item=>item.method==='eth_getBlockByHash'&&item.result)?.result;
    if(!referenceHeader&&sourceHeader)referenceHeader=structuredClone(sourceHeader);
    result.block??=output.block;
    if(sourceHeader&&referenceHeader&&!isDeepStrictEqual(sourceHeader,referenceHeader))sharedFailure='Sequence steps do not share an identical source header and block contents.';
    if(output.canonicalStatus!=='verified')sharedFailure??='A sequence step could not validate its shared state and canonical context.';
    if(output.execution.status==='reverted_or_failed'&&output.canonicalStatus==='verified'){
      step.status='reverted_or_failed';step.reason='Original execution did not succeed.';
      Object.assign(result.sequence,{status:'stopped',stoppedAtIndex:index,reason:step.reason});break;
    }
    if(!continuations.has(output)){
      step.status='unavailable';step.reason=output.measurementFailure??'Complete validated continuation state is unavailable.';
      Object.assign(result.sequence,{status:'unavailable',stoppedAtIndex:index,reason:step.reason});break;
    }
    step.status='completed';result.sequence.completedSteps++;previous=output;
    if(index===inputs.length-1)result.sequence.status='completed';
  }
  for(const step of result.steps.filter(step=>step.status==='skipped'))step.reason='Skipped because an earlier call did not complete with validated state.';
  try{
    need(Boolean(referenceHeader),'Sequence source header was not established.');
    const params=[hex(header(referenceHeader).number),false],id=evidence.length+1;
    const confirmed=await boundedCall('eth_getBlockByNumber',params,true);
    result.finalVerification={sequenceEvidenceId:id,method:'eth_getBlockByNumber',params,result:confirmed};
    need(isDeepStrictEqual(confirmed,referenceHeader),'Canonical header or block contents changed during the sequence.');
    need(!sharedFailure,sharedFailure);
    result.canonicalStatus='verified';
  }catch(error){
    const reason=publicError(error);result.canonicalStatus='unverified';
    Object.assign(result.sequence,{status:'unavailable',reason});
    for(const step of result.steps)if(step.result){invalidateSequenceAmounts(step.result,reason);if(step.status==='completed'){step.status='unavailable';step.reason=reason;}}
    result.sequence.completedSteps=0;
  }
  // These capabilities are scoped to this invocation, not exposed as a way
  // to extend a returned sequence beyond its declared bounded input list.
  for(const step of result.steps)if(step.result)continuations.delete(step.result);
  result.accounting={rpcCalls:evidence.length,retainedResultBytes:retained,limits:SEQUENCE_LIMITS};
  return result;
}
