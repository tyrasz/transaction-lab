// Query candidates only. ABI-shaped events and calldata do not establish token
// identity, honest economics, authorization, a balance change or asset coverage.
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const ZERO = '0x' + '0'.repeat(40);
const MAX = (1n << 256n) - 1n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const FRAME_FIELDS = new Set(['type','from','to','input','output','value','gas','gasUsed','error','revertReason','logs','calls']);
const LOG_FIELDS = new Set(['address','topics','data','position','index','logIndex','removed']);
export const DISCOVERY_LIMITS = Object.freeze({maxQueries:8,maxCandidates:128,maxFrames:1000,maxDepth:32,maxLogs:2000,maxObservations:512,maxReferences:1024,maxDiagnostics:256,maxStringBytes:8*1024*1024});
const lower = value => value.toLowerCase();
const address = value => typeof value === 'string' && ADDRESS.test(value);
const word = value => typeof value === 'string' && WORD.test(value);
const uint = value => typeof value === 'string' && value.length <= 66 && QUANTITY.test(value) && BigInt(value) <= MAX ? BigInt(value) : null;
const requestValue = value => typeof value === 'string' && value.length <= 78 && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX ? BigInt(value) : uint(value);
const pad = value => value.slice(2).padStart(64, '0');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
class DiscoveryError extends Error {
  constructor(message, code = 'INVALID_TRACE', truncated = false) { super(message); this.code = code; this.truncated = truncated; }
}
const need = (condition, message, code, truncated) => { if (!condition) throw new DiscoveryError(message, code, truncated); };
function plain(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= allowed.size && keys.every(key => typeof key === 'string' && allowed.has(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key), 'value'));
}
function denseArray(value, max) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({length:value.length}, (_, i) => Object.getOwnPropertyDescriptor(value,String(i))).every(d => d && Object.hasOwn(d,'value'));
}
const topicAddress = value => word(value) && /^0x0{24}/i.test(value) ? '0x' + value.slice(26).toLowerCase() : null;

/** Pure bounded discovery from one complete raw callTracer object. request is
 * the engine's exact {from,to,data,value,gas} envelope. Queries are deterministic
 * hypotheses; only separate isolated state reads can supply their values.
 * Normal query selection never drops candidates: unselected entries remain
 * visible. A hard limit or malformed tree withholds every selected query. */
export function discoverTokenQueries({request, trace, maxQueries = 8} = {}) {
  const counts = {complete:false,truncated:false,frames:0,logs:0,observations:0,candidates:0,selected:0,omitted:0,failedFrames:0,staticFrames:0,nftTransferLogs:0,malformedKnownSignatures:0,zeroAddressCandidatesExcluded:0};
  const result = {schemaVersion:'1.0',status:'unavailable',basis:'committed_erc20_shaped_events_and_calls',queries:[],candidates:[],observations:[],diagnostics:[],counts,
    limits:{...DISCOVERY_LIMITS,maxQueries},scope:{candidateBasis:'ABI_shape_only',tokenIdentityVerified:false,allEffectsCoverage:'inconclusive',noCandidatesMeansNoAssets:false,
      selection:'sender_balances_then_sender_owned_allowances_then_other_balances_then_other_allowances; lexical_query_tiebreak',
      eventAmounts:'emitted_values_only_not_state_changes',callAmounts:'requested_values_only_not_state_changes',
      observationOrder:'events_then_call_hypotheses_not_execution_chronology',
      excluded:'failed_or_static_subtrees; zero_address_balance_accounts; NFT-shaped shared-selector call candidates'}};
  const frames = [], candidates = new Map(), seen = new WeakSet();
  let stringBytes = 0, references = 0, sender;
  function budget(condition, message) { need(condition,message,'DISCOVERY_LIMIT',true); }
  function text(value) {
    need(typeof value === 'string','Trace contains a non-string text field.');
    budget(value.length <= DISCOVERY_LIMITS.maxStringBytes,'Trace string evidence exceeds the discovery byte limit.');
    stringBytes += Buffer.byteLength(value,'utf8');
    budget(stringBytes <= DISCOVERY_LIMITS.maxStringBytes,'Trace string evidence exceeds the discovery byte limit.');
    return value;
  }
  function diagnostic(code,message,frame,logIndex) {
    budget(result.diagnostics.length < DISCOVERY_LIMITS.maxDiagnostics,'Discovery diagnostic evidence exceeds its limit.');
    result.diagnostics.push({code,message,callPath:frame?.path ?? [],...(logIndex === undefined ? {} : {logIndex})});
  }
  function candidate(kind, token, first, second, observationId) {
    if (kind === 'balanceOf' && first === ZERO) { counts.zeroAddressCandidatesExcluded++; return; }
    const query = {to:token,data:kind === 'balanceOf' ? '0x70a08231'+pad(first) : '0xdd62ed3e'+pad(first)+pad(second)};
    const key = query.to + ':' + query.data;
    let entry = candidates.get(key);
    if (!entry) {
      budget(candidates.size < DISCOVERY_LIMITS.maxCandidates,'Discovery exceeded its distinct candidate limit.');
      entry = {id:key,kind,token,...(kind === 'balanceOf' ? {account:first} : {owner:first,spender:second}),query,
        priority:kind === 'balanceOf' ? (first === sender ? 0 : 2) : (first === sender ? 1 : 3),selection:'unavailable',observationIds:[]};
      candidates.set(key,entry);
    }
    if (!entry.observationIds.includes(observationId)) {
      budget(++references <= DISCOVERY_LIMITS.maxReferences,'Discovery candidate references exceed their limit.');
      entry.observationIds.push(observationId);
    }
  }
  function observe(frame, kind, token, fields, logIndex) {
    budget(result.observations.length < DISCOVERY_LIMITS.maxObservations,'Discovery observation evidence exceeds its limit.');
    const id = `${frame.path.length ? frame.path.join('.') : 'root'}:${logIndex === undefined ? 'call' : 'log:'+logIndex}`;
    const observation = {id,kind,token,submitter:sender,...fields,provenance:{callPath:[...frame.path],...(logIndex === undefined ? {} : {logIndex}),
      frameType:frame.raw.type,codeAddress:lower(frame.raw.to),storageAddress:frame.context,frameFrom:lower(frame.raw.from),messageSender:frame.messageSender},effectEstablished:false};
    result.observations.push(observation);
    return id;
  }
  function walk(raw, path, parent) {
    budget(++counts.frames <= DISCOVERY_LIMITS.maxFrames && path.length <= DISCOVERY_LIMITS.maxDepth,'Trace exceeds the discovery frame or depth limit.');
    need(plain(raw,FRAME_FIELDS) && !seen.has(raw),'Trace contains a malformed, repeated or cyclic frame.'); seen.add(raw);
    need(['CALL','STATICCALL','DELEGATECALL'].includes(raw.type),'Trace contains an unsupported execution context.');
    need(address(raw.from) && address(raw.to),'Trace contains malformed execution addresses.'); text(raw.from);text(raw.to);text(raw.type);
    need(BYTES.test(text(raw.input)) && BYTES.test(text(raw.output === undefined ? '0x' : raw.output)),'Trace contains malformed execution bytes.');
    const gas = uint(raw.gas), gasUsed = uint(raw.gasUsed), value = uint(raw.value === undefined ? '0x0' : raw.value);
    need(gas !== null && gasUsed !== null && value !== null && gasUsed <= gas && gas <= uint(request.gas),'Trace contains incomplete or inconsistent gas/value quantities.');
    text(raw.gas);text(raw.gasUsed);if(raw.value!==undefined)text(raw.value);
    for (const field of ['error','revertReason']) if (Object.hasOwn(raw,field)) {
      need(typeof raw[field] === 'string' && raw[field].length > 0 && raw[field].length <= 2000,'Trace contains malformed failure metadata.');text(raw[field]);
    }
    const children = raw.calls === undefined ? [] : raw.calls, logs = raw.logs === undefined ? [] : raw.logs;
    budget(!Array.isArray(children) || children.length <= DISCOVERY_LIMITS.maxFrames,'Trace child list exceeds its discovery limit.');
    budget(!Array.isArray(logs) || logs.length + counts.logs <= DISCOVERY_LIMITS.maxLogs,'Trace event list exceeds its discovery limit.');
    need(denseArray(children,DISCOVERY_LIMITS.maxFrames) && denseArray(logs,DISCOVERY_LIMITS.maxLogs),'Trace contains malformed child or event arrays.');
    const failed = Boolean(parent?.failed || raw.error || raw.revertReason), isStatic = Boolean(parent?.isStatic || raw.type === 'STATICCALL');
    const context = raw.type === 'DELEGATECALL' ? parent?.context : lower(raw.to);
    if (parent) {
      need(lower(raw.from) === parent.context,'Trace child caller does not match the executing storage context.');
      if (raw.type === 'DELEGATECALL') need(value === parent.value,'Trace delegate value differs from its inherited context.');
    } else {
      need(raw.type === 'CALL' && lower(raw.from) === sender && lower(raw.to) === lower(request.to) && lower(raw.input) === lower(request.data) && value === requestValue(request.value) && gas === uint(request.gas) && gasUsed > 0n,'Trace root does not match the unsigned request.');
    }
    if (isStatic) need(value === 0n,'Static execution context contains a native-value transfer.');
    const messageSender = raw.type === 'DELEGATECALL' ? parent.messageSender : lower(raw.from);
    const frame = {raw,path,context,failed,isStatic,value,messageSender};frames.push(frame);
    if(failed)counts.failedFrames++;if(isStatic)counts.staticFrames++;
    for (const log of logs) {
      budget(++counts.logs <= DISCOVERY_LIMITS.maxLogs,'Trace exceeds the discovery event limit.');
      need(plain(log,LOG_FIELDS) && address(log.address) && denseArray(log.topics,4),'Trace contains malformed event fields.');text(log.address);
      need(log.topics.every(topic => word(text(topic))) && BYTES.test(text(log.data)),'Trace contains malformed event topics or bytes.');
      need(lower(log.address) === context,'Event emitter does not match the executing storage context.');
      for(const field of ['position','index','logIndex']) if(Object.hasOwn(log,field)) {
        need(uint(log[field]) !== null,'Trace contains malformed event positions.');text(log[field]);
        if(field==='position')need(uint(log[field])<=BigInt(children.length),'Event position exceeds its direct child count.');
      }
      if(Object.hasOwn(log,'removed'))need(log.removed===false,'Trace contains removed or malformed event evidence.');
    }
    for(let index=0;index<children.length;index++)walk(children[index],[...path,index],frame);
  }
  try {
    need(Number.isInteger(maxQueries) && maxQueries >= 1 && maxQueries <= DISCOVERY_LIMITS.maxQueries,'Discovery query limit must be between one and eight.','INVALID_DISCOVERY_INPUT');
    need(plain(request,new Set(['from','to','data','value','gas'])) && address(request.from) && address(request.to) && typeof request.data === 'string' && request.data.length <= 65538 && BYTES.test(request.data) && requestValue(request.value) !== null && uint(request.gas) !== null && uint(request.gas) > 21000n && uint(request.gas) <= 5000000n,'Discovery requires the exact supported unsigned request.','INVALID_DISCOVERY_INPUT');
    sender = lower(request.from);walk(trace,[],null);
    if (trace.error || trace.revertReason) {
      result.status='not_applicable';result.reason='Original execution did not succeed; reverted observations cannot discover committed effects.';counts.complete=true;return result;
    }
    const nftTokens = new Set(), events = [];
    // First collect NFT-shaped evidence across the whole committed tree. A call
    // appearing before such a log must not escape the shared-selector warning.
    for(const frame of frames) {
      if(frame.failed || frame.isStatic)continue;
      for(const [logIndex,log] of (frame.raw.logs??[]).entries()) {
        const signature = lower(log.topics[0]??'');
        if(signature!==TRANSFER && signature!==APPROVAL)continue;
        if(log.topics.length===4 && lower(log.data)==='0x' && topicAddress(log.topics[1]) && topicAddress(log.topics[2])) {
          nftTokens.add(frame.context);if(signature===TRANSFER)counts.nftTransferLogs++;
          diagnostic('NFT_SHAPED_EVENT_EXCLUDED','Four-topic NFT-shaped events do not identify ERC20 balance or allowance queries.',frame,logIndex);continue;
        }
        const first=topicAddress(log.topics[1]),second=topicAddress(log.topics[2]);
        if(log.topics.length!==3 || !word(log.data) || !first || !second) {
          counts.malformedKnownSignatures++;diagnostic('MALFORMED_ERC20_EVENT','Known Transfer/Approval signature has a noncanonical ERC20 event encoding and was excluded.',frame,logIndex);continue;
        }
        events.push({frame,logIndex,signature,first,second,amountRaw:BigInt(log.data).toString()});
      }
    }
    for(const {frame,logIndex,signature,first,second,amountRaw} of events) {
      const token=frame.context;
      if(signature===TRANSFER) {
        const id=observe(frame,'transfer_event',token,{from:first,to:second,amountRaw,amountMeaning:'emitted_transfer_amount'},logIndex);
        candidate('balanceOf',token,first,null,id);candidate('balanceOf',token,second,null,id);
      } else {
        const id=observe(frame,'approval_event',token,{owner:first,spender:second,amountRaw,amountMeaning:'emitted_approval_value'},logIndex);
        candidate('allowance',token,first,second,id);
      }
    }
    for(const frame of frames) {
      if(frame.failed || frame.isStatic || frame.raw.type!=='CALL')continue;
      const input=lower(frame.raw.input),selector=input.slice(0,10),token=frame.context,caller=lower(frame.raw.from);
      if(!['0xa9059cbb','0x23b872dd','0x095ea7b3'].includes(selector))continue;
      const words=input.slice(10).match(/.{64}/g)??[],expected=selector==='0x23b872dd'?3:2;
      const first=topicAddress('0x'+(words[0]??'')),second=selector==='0x23b872dd'?topicAddress('0x'+(words[1]??'')):null;
      if(input.length!==10+expected*64 || !first || (selector==='0x23b872dd'&&!second)) {
        counts.malformedKnownSignatures++;diagnostic('MALFORMED_ERC20_CALL','Known transfer/transferFrom/approve selector has noncanonical ABI arguments and was excluded.',frame);continue;
      }
      if(nftTokens.has(token)) {diagnostic('NFT_CALL_AMBIGUITY','ERC20-shaped call candidates were suppressed because this token also emitted a committed NFT-shaped event.',frame);continue;}
      if(frame.value!==0n) {diagnostic('NONZERO_CALL_VALUE_EXCLUDED','ERC20-shaped call with nonzero native value was excluded from call-only discovery.',frame);continue;}
      const amountRaw=BigInt('0x'+words[expected-1]).toString(),output=lower(frame.raw.output??'0x');
      const returnEvidence=output==='0x'?'empty':word(output)?(BigInt(output)===0n?'false':BigInt(output)===1n?'true':'noncanonical'):'noncanonical';
      const common={amountRaw,returnEvidence,amountMeaning:selector==='0x095ea7b3'?'requested_allowance_value':'requested_transfer_amount'};
      if(selector==='0xa9059cbb') {
        const id=observe(frame,'transfer_call',token,{owner:caller,recipient:first,...common});
        candidate('balanceOf',token,caller,null,id);candidate('balanceOf',token,first,null,id);
      } else if(selector==='0x23b872dd') {
        const id=observe(frame,'transfer_from_call',token,{owner:first,spender:caller,recipient:second,...common});
        candidate('balanceOf',token,first,null,id);candidate('balanceOf',token,second,null,id);candidate('allowance',token,first,caller,id);
      } else {
        const id=observe(frame,'approve_call',token,{owner:caller,spender:first,...common});
        candidate('allowance',token,caller,first,id);
      }
    }
    result.candidates=[...candidates.values()].sort((a,b)=>a.priority-b.priority||lexical(a.id,b.id));
    for(const [index,entry] of result.candidates.entries())entry.selection=index<maxQueries?'selected':'omitted_query_limit';
    result.queries=result.candidates.filter(c=>c.selection==='selected').map(c=>({...c.query}));
    counts.complete=true;counts.selected=result.queries.length;counts.omitted=result.candidates.length-counts.selected;
    result.status=result.queries.length?'discovered':'none';
    result.reason=result.queries.length?'Selected queries are ABI-shaped hypotheses requiring separate before/after state validation.':'No eligible query candidates were found; this does not establish that assets or effects are absent.';
  } catch(error) {
    result.status='unavailable';result.reason=error instanceof DiscoveryError?error.message:'Discovery could not validate a bounded trace.';
    counts.truncated=error instanceof DiscoveryError&&error.truncated;result.queries=[];
    result.candidates=[...candidates.values()].sort((a,b)=>a.priority-b.priority||lexical(a.id,b.id));
    for(const entry of result.candidates)entry.selection='unavailable';
    if(result.diagnostics.length<DISCOVERY_LIMITS.maxDiagnostics)result.diagnostics.push({code:error instanceof DiscoveryError?error.code:'INVALID_TRACE',message:result.reason,callPath:[]});
  }
  counts.candidates=result.candidates.length;counts.observations=result.observations.length;
  return result;
}
