// Current local kernel is the evaluated product. The remote tracer is an oracle,
// never an input-state source for this attempt. No execution or networking here.
import { isDeepStrictEqual as equal } from 'node:util';
import { normalizeEvmContext, rpcEvmContext } from '../../engines/evm-context.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { validateInputFacts } from '../../engines/local-evm/input-facts.js';
import { validateExecutionChanges } from '../../engines/local-evm/execution-changes.js';
import { canonicalStateChanges } from '../../engines/local-evm/preview-mutations.js';
import { encode, decode } from '../../engines/local-evm/isolated-protocol.js';
import { verifyCohortWireRecord } from '../standard-evm/cohort-verify.mjs';
import { keccak_256 } from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';

const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/, SHA = /^[0-9a-f]{64}$/;
const ZERO = '0x' + '00'.repeat(32), EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const MAX = (1n << 256n) - 1n, MAX_BYTES = 96 * 1024 * 1024;
export const CHANNELS = Object.freeze(['executionStatus', 'returnData', 'committedLogs', 'gasAccounting', 'fullObservedStateChanges']);
const own = (o,k) => Object.hasOwn(o,k), record = o => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
class Incomplete extends Error {}
const need = (v, message) => { if (!v) throw new Incomplete(message); };
const matches = (v,p) => typeof v === 'string' && p.test(v);
function fields(o, required, optional = []) { need(record(o) && required.every(k=>own(o,k)) && Object.keys(o).every(k=>[...required,...optional].includes(k)), 'Missing or unknown evidence fields'); }
function q(v, max = MAX) {
  need((typeof v === 'string' && v.length <= 80 && /^(?:0x(?:0|[1-9a-f][0-9a-f]*)|0|[1-9][0-9]*)$/.test(v)) || (Number.isSafeInteger(v) && v >= 0 && !Object.is(v,-0)), 'Malformed canonical quantity');
  const n = BigInt(v); need(n <= max, 'Quantity exceeds bound'); return n;
}
const hx = v => '0x' + q(v).toString(16), hashCode = code => '0x' + Buffer.from(keccak_256(Buffer.from(code.slice(2),'hex'))).toString('hex');
const clone = value => decode(encode(value,MAX_BYTES),MAX_BYTES);
const reason = e => e instanceof Incomplete ? e.message : 'Evidence is malformed, incomplete, or fails independent binding';
const sort = rows => rows.sort((a,b)=>a.address.localeCompare(b.address)).map(r=>({...r,...(r.storage?{storage:r.storage.sort((a,b)=>a.slot.localeCompare(b.slot))}:{})}));

function callRequest(request) {
  fields(request,['from','to','data','value','gas'],['accessList','blobVersionedHashes']);
  need(matches(request.from,ADDRESS) && (request.to===null || matches(request.to,ADDRESS)) && matches(request.data,DATA) && request.data.length<=65538 && q(request.gas)===5000000n,'Request is outside fixed local profile');
  const context=normalizeEvmContext(request); need(!(request.to===null && context.blobVersionedHashes),'Blob creation is unsupported');
  return {from:request.from,to:request.to,data:request.data,value:hx(request.value),gas:'0x4c4b40',...context};
}
export function oracleRequests({request,header}) {
  const normalized=callRequest(request), context=rpcEvmContext(normalized);
  const call={from:normalized.from,...(normalized.to===null?{}:{to:normalized.to}),data:normalized.data,value:normalized.value,gas:normalized.gas,gasPrice:'0x0',...context};
  const selector={blockHash:header.hash,requireCanonical:true}, blockOverrides={baseFeePerGas:'0x0',...(context.blobVersionedHashes?{blobBaseFee:'0x0'}:{})};
  return [
    {label:'header_before',method:'eth_getBlockByHash',params:[header.hash,false]},
    {label:'call_trace',method:'debug_traceCall',params:[call,selector,{tracer:'callTracer',tracerConfig:{withLog:true},blockOverrides}]},
    {label:'state_diff',method:'debug_traceCall',params:[call,selector,{tracer:'prestateTracer',tracerConfig:{diffMode:true},blockOverrides}]},
    {label:'header_after',method:'eth_getBlockByNumber',params:[hx(header.number),false]},
  ];
}
function implementation(actual,expected) {
  for(const v of [actual,expected]) {
    fields(v,['name','version','sourceSha256','sourceFiles']);
    need(typeof v.name==='string'&&v.name.length>0&&typeof v.version==='string'&&v.version.length>0&&matches(v.sourceSha256,SHA)&&Array.isArray(v.sourceFiles)&&v.sourceFiles.length>0&&v.sourceFiles.length<=20000,'Concrete archived implementation identity missing');
    need(v.sourceFiles.every(p=>typeof p==='string'&&p&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='..'||x==='.')&&!p.includes('\\'))&&equal(v.sourceFiles,[...new Set(v.sourceFiles)].sort()),'Source inventory paths are ambiguous');
  }
  need(equal(actual,expected),'Local implementation differs from frozen source identity');
}
function costs(call,header) {
  const time=q(header.timestamp), forks=[[1681338455n,'shanghai'],[1710338135n,'cancun'],[1746612311n,'prague'],[1764798551n,'osaka'],[1765290071n,'bpo1'],[1767747671n,'bpo2']];
  const hardfork=forks.filter(([at])=>time>=at).at(-1)?.[1]; need(hardfork,'Unsupported declared mainnet fork');
  const bytes=Buffer.from(call.data.slice(2),'hex'); let zero=0n,nonzero=0n; for(const b of bytes)b===0?zero++:nonzero++;
  const addresses=BigInt(call.accessList?.length??0),slots=BigInt(call.accessList?.reduce((n,r)=>n+r.storageKeys.length,0)??0),access=addresses*2400n+slots*1900n;
  const creation=call.to===null?32000n:0n, init=call.to===null?2n*((BigInt(bytes.length)+31n)/32n):0n;
  const intrinsic=21000n+4n*zero+16n*nonzero+access+creation+init, floor=time>=1746612311n?21000n+10n*(zero+4n*nonzero):0n;
  need(intrinsic<=5000000n&&floor<=5000000n,'Request gas cannot cover intrinsic/floor');
  if(call.blobVersionedHashes)need(time>=1710338135n&&q(header.excessBlobGas,(1n<<64n)-1n)>=0n,'Blob context/header is unsupported');
  return {hardfork,zero,nonzero,addresses,slots,access,creation,init,intrinsic,floor};
}
function profileBinding(output,call,header) {
  const c=costs(call,header), expected={
    name:'ethereum_unsigned_unpriced_call',chainId:1,hardfork:c.hardfork,forkSchedule:'pinned_ethereumjs_common_10.1.3_mainnet',sourceBlockHash:header.hash,sourceStateRoot:header.stateRoot,
    sourceBlockIdentityVerified:false,sourceStateProofVerified:false,actualBlockBaseFee:q(header.baseFeePerGas).toString(),executionBaseFee:'0',gasPrice:'0',declaredGasLimit:'5000000',intrinsicGas:c.intrinsic.toString(),calldataFloor:c.floor.toString(),messageGasLimit:(5000000n-c.intrinsic).toString(),
    calldataZeroBytes:c.zero.toString(),calldataNonzeroBytes:c.nonzero.toString(),outerSignatureVerified:false,feesSettled:false,originalTransactionPosition:false,expectedOutputsUsed:false,
    ...(call.accessList?{accessList:call.accessList,accessListAddressCount:c.addresses.toString(),accessListStorageKeyCount:c.slots.toString(),accessListIntrinsicGas:c.access.toString()}:{}),
    ...(call.blobVersionedHashes?{blobVersionedHashes:call.blobVersionedHashes,executionBlobBaseFee:'0',sourceExcessBlobGas:q(header.excessBlobGas).toString()}:{}),
    ...(call.to===null?{operation:'create',initcodeBytes:(c.zero+c.nonzero).toString(),creationIntrinsicGas:'32000',initcodeWordGas:c.init.toString()}:{}),
  };
  need(equal(output.profile,expected),'Local full unsigned profile differs from independently derived request costs/context');
  const environment={chainId:1,hardfork:c.hardfork,number:q(header.number).toString(),timestamp:q(header.timestamp).toString(),gasLimit:q(header.gasLimit).toString(),baseFeePerGas:'0',mixHash:header.mixHash,miner:header.miner,sourceBlockHash:header.hash,sourceParentHash:header.parentHash,sourceBlockIdentityVerified:false};
  need(equal(output.environment,environment),'Local execution environment differs from pinned header'); return c;
}
async function bindLocal(local,call,header,expected) {
  implementation(local.implementation,expected); const a=local.attempt,o=a?.output;
  need(local.dispatch==='completed'&&a?.status==='completed'&&a.isolation?.processClosed===true&&a.broker?.pendingAtReturn===0,'Local isolated attempt did not complete/drain');
  const verified=verifyEthereumHeader({header,expectedHash:header.hash});
  need(equal(a.headerVerification,verified)&&equal(a.inputs?.context?.header,header)&&a.inputs.context.blockHash===header.hash&&a.inputs.context.stateRoot===header.stateRoot&&a.inputs.context.expectedOutputsUsed===false,'Local initial context differs');
  need(a.inputs.status==='available','Local proof inputs unavailable');
  await validateInputFacts({inputs:a.inputs,inputEvidence:a.inputEvidence,stateRoot:header.stateRoot});
  need(['success','reverted','failed'].includes(o?.execution?.status)&&o.stateDisposition==='message_result_retained_in_supplied_manager','Local execution incomplete');
  const error=o.execution.error;
  need(error===null||(typeof error==='string'&&error.length>0),'Malformed local EVM failure');
  need(o.execution.status===(error===null?'success':error==='revert'?'reverted':'failed'),'Local execution status contradicts error');
  const c=profileBinding(o,call,header), t=o.trace;
  need(t?.type===(call.to===null?'CREATE':'CALL')&&t.from===call.from&&t.caller===call.from&&t.input===call.data&&q(t.value)===q(call.value)&&q(t.gas)===5000000n-c.intrinsic&&t.output===o.execution.returnData&&t.error===error&&q(t.gasUsed)===q(o.execution.executionGasUsed),'Local root contradicts bound request/output');
  if(call.to!==null)need(t.to===call.to&&t.executionAddress===call.to,'Local root destination differs');
  validateExecutionChanges({changes:a.changes,inputs:a.inputs,output:o,sender:call.from,destination:call.to,selfdestructOnlyCreated:q(header.timestamp)>=1710338135n});
  return {attempt:a,output:o,costs:c};
}
function errorClass(error,local=false) {
  if(error===null)return {status:'success',exception:null};
  if(error===(local?'revert':'execution reverted'))return {status:'reverted',exception:'revert'};
  const aliases=[[/^out of gas$/,'out_of_gas'],[/^invalid opcode(?:: opcode 0x[0-9a-f]{2} not defined)?$/,'invalid_opcode'],[/^invalid (?:JUMP|jump)(?: destination)?$/,'invalid_jump'],[/^stack underflow(?: \([0-9]+ <=> [0-9]+\))?$/,'stack_underflow'],[/^stack (?:limit reached|overflow)(?: \([0-9]+\))?$/,'stack_overflow'],[/^(?:write protection|static state change)$/,'write_protection'],[/^return data out of bounds$/,'return_data_bounds'],[/^(?:contract address collision|create collision)$/,'create_collision'],[/^code size to deposit exceeds maximum code size$/,'code_size']];
  for(const [pattern,exception]of aliases)if(typeof error==='string'&&pattern.test(error))return {status:'failed',exception};
  throw new Incomplete('Unrecognized actual EVM exception; exception equality is unavailable');
}
function traceError(frame) {
  if(own(frame,'error'))need(typeof frame.error==='string'&&frame.error.length>0&&frame.error.length<=2000,'Malformed provider error');
  if(own(frame,'revertReason'))need(typeof frame.revertReason==='string'&&frame.revertReason.length<=2000&&(!frame.revertReason||own(frame,'error')),'Malformed provider revert reason');
  return frame.error??null;
}
function returned(frame) { need(!own(frame,'output')||matches(frame.output,DATA),'Malformed return data');return frame.output??'0x'; }
function rootBinding(trace,call,local) {
  fields(trace,['type','from','gas','gasUsed','input'],['to','value','output','error','revertReason','calls','logs']);
  need(trace.type===(call.to===null?'CREATE':'CALL')&&trace.from===call.from&&trace.input===call.data&&q(trace.value??'0x0')===q(call.value)&&q(trace.gas)===5000000n&&q(trace.gasUsed)<=5000000n,'Provider root request/gas differs');
  if(call.to!==null)need(trace.to===call.to,'Provider destination differs');
  else need(matches(trace.to,ADDRESS)&&trace.to===local.output.trace.to,'Provider CREATE address differs from independently derived local address');
  traceError(trace);returned(trace);return trace;
}
function payload(log) {
  fields(log,['address','topics','data'],['position','index','logIndex','removed']);
  need(matches(log.address,ADDRESS)&&Array.isArray(log.topics)&&log.topics.length<=4&&log.topics.every(t=>matches(t,WORD))&&matches(log.data,DATA)&&(!own(log,'removed')||log.removed===false),'Malformed log');
  return {address:log.address,topics:log.topics,data:log.data};
}
const ordinal = (v,max) => {need(typeof v==='number'||(typeof v==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v)),'Noncanonical log ordinal');return q(v,max);};
export function oracleLogs(trace) {
  let frames=0,logs=0;const found=[];
  function scan(f,ancestorFailed=false,depth=0,parent=null) {
    need(++frames<=1000&&depth<=32,'Excessive provider tree');
    fields(f,['type','from','to'],['gas','gasUsed','input','value','output','error','revertReason','calls','logs']);
    need(['CALL','CALLCODE','DELEGATECALL','STATICCALL','CREATE','CREATE2','SELFDESTRUCT'].includes(f.type)&&matches(f.from,ADDRESS)&&matches(f.to,ADDRESS),'Unsupported provider lifecycle/frame');
    if(parent)need(f.from===parent.context,'Provider descendant caller contradicts execution context');
    const context=['DELEGATECALL','CALLCODE'].includes(f.type)?parent?.context:f.to;
    const calls=f.calls??[],ownLogs=f.logs??[];need(Array.isArray(calls)&&Array.isArray(ownLogs),'Malformed children/logs');
    const err=traceError(f),failed=ancestorFailed||err!==null;returned(f);
    if(f.type==='SELFDESTRUCT')need(parent&&calls.length===0&&ownLogs.length===0&&q(f.value)>=0n,'Malformed SELFDESTRUCT marker');
    else need(matches(f.input,DATA)&&q(f.gasUsed)<=q(f.gas)&&q(f.gas)<=5000000n&&q(f.value??(f.type==='STATICCALL'?'0x0':undefined))>=0n,'Malformed descendant input/gas/value');
    if(f.type==='STATICCALL')need(q(f.value??'0x0')===0n,'Static value is nonzero');
    const entries=[];let previousPosition=-1,previousIndex=null;
    for(const log of ownLogs) {
      need(++logs<=2000,'Excessive logs');const p=payload(log);need(p.address===context,'Log emitter differs from execution context');
      const position=own(log,'position')?Number(ordinal(log.position,BigInt(calls.length))):null;
      const index=own(log,'index')||own(log,'logIndex')?ordinal(log.index??log.logIndex,0xffffffffn):null;
      if(own(log,'index')&&own(log,'logIndex'))need(index===ordinal(log.logIndex,0xffffffffn),'Conflicting log index aliases');
      if(position!==null){need(position>=previousPosition,'Decreasing log position');previousPosition=position;}
      if(index!==null){need(previousIndex===null||index>previousIndex,'Repeated/decreasing log index');previousIndex=index;}
      if(!failed){const entry={payload:p,position,index};entries.push(entry);found.push(entry);}
    }
    return {entries,children:calls.map(c=>scan(c,failed,depth+1,{context}))};
  }
  const tree=scan(trace),indexed=found.filter(e=>e.index!==null).length;
  need(indexed===0||indexed===found.length,'Partial log indices');
  if(indexed) {
    need(new Set(found.map(e=>e.index.toString())).size===found.length,'Duplicate log indices');
    const byIndex=(a,b)=>a.index<b.index?-1:a.index>b.index?1:0;
    function order(n) {
      const children=n.children.map(order);let previous=null;
      for(const c of children)if(c.length){need(previous===null||previous<c[0].index,'Sibling log order contradicts indices');previous=c.at(-1).index;}
      for(const e of n.entries)for(let i=0;i<children.length;i++){const c=children[i];if(!c.length)continue;need(e.index<c[0].index||e.index>c.at(-1).index,'Parent log interrupts child');if(e.position!==null)need(i<e.position?c.at(-1).index<e.index:e.index<c[0].index,'Log position/index contradiction');}
      return [...n.entries,...children.flat()].sort(byIndex);
    }
    return order(tree).map(e=>e.payload);
  }
  function order(n){const c=n.children.map(order);if(!c.some(x=>x.length))return n.entries.map(e=>e.payload);need(n.entries.every(e=>e.position!==null),'Missing log interleave positions');const out=[];for(let i=0;i<=c.length;i++){out.push(...n.entries.filter(e=>e.position===i).map(e=>e.payload));if(i<c.length)out.push(...c[i]);}return out;}
  return order(tree);
}

function initial(inputs,address) {
  const a=inputs.accounts[address],p=inputs.provenance.filter(r=>r.account===address);need(a&&p.length===1,'Oracle changed account lacks independently proven initial facts');
  const proof=p[0].accountProof;need(proof.exists===a.exists&&matches(proof.storageRoot,WORD)&&matches(proof.codeHash,WORD),'Account proof metadata missing');
  return {exists:a.exists,nonce:a.exists?q(a.nonce):0n,balance:a.exists?q(a.balance):0n,code:a.exists?a.code:'0x',storage:a.exists?a.storage:{},storageRoot:proof.storageRoot,codeHash:proof.codeHash};
}
function oldSlot(a,key) {const v=a.storage[key];if(v!==undefined){need(matches(v,WORD),'Malformed proven slot');return v;}need(!a.exists||a.storageRoot===EMPTY_ROOT,'Oracle slot was not independently proven');return ZERO;}
function preFields(pre,a) {
  fields(pre,[],['nonce','balance','code','codeHash','storage']);
  for(const k of ['nonce','balance'])if(own(pre,k))need(q(pre[k])===a[k],'Provider prior basic field differs from proof');
  if(own(pre,'code'))need(matches(pre.code,DATA)&&pre.code===a.code,'Provider prior code differs from proof');
  if(own(pre,'codeHash'))need(pre.codeHash===a.codeHash,'Provider prior code hash differs from proof');
  if(own(pre,'storage')){need(record(pre.storage),'Malformed prior storage');for(const [k,v]of Object.entries(pre.storage))need(matches(k,WORD)&&matches(v,WORD)&&v===oldSlot(a,k),'Provider prior slot differs from proof');}
}
export function oracleStateChanges(diff,inputs) {
  fields(diff,['pre','post']);need(record(diff.pre)&&record(diff.post),'Missing original state diff');
  const keys=[...new Set([...Object.keys(diff.pre),...Object.keys(diff.post)])].sort();need(keys.length<=128,'Excessive changed accounts');
  const out=[];let slots=0;
  for(const address of keys){
    need(matches(address,ADDRESS),'Malformed/case-ambiguous changed address');const a=initial(inputs,address),pre=diff.pre[address],post=diff.post[address];
    if(pre!==undefined)preFields(pre,a);
    if(post===undefined){need(pre!==undefined&&a.exists,'Unproven deletion');out.push({address,existence:{before:true,after:false},initialStorageRoot:a.storageRoot});continue;}
    fields(post,[],['nonce','balance','code','codeHash','storage']);
    need(!a.exists||pre!==undefined,'Existing changed account lacks raw prestate');
    const row={address,...(!a.exists?{existence:{before:false,after:true}}:{})};
    for(const k of ['nonce','balance'])if(own(post,k)){const n=q(post[k]);need(pre===undefined||own(pre,k)||a[k]===0n,'Missing nonzero prior basic field');if(n!==a[k])row[k]={before:hx(a[k].toString()),after:hx(n.toString())};}
    const code=own(post,'code')?post.code:a.code;need(matches(code,DATA)&&code.length<=49154,'Malformed/excessive runtime code');
    if(own(post,'codeHash'))need(matches(post.codeHash,WORD)&&post.codeHash===hashCode(code),'Unverified or inconsistent post codeHash');
    if(code!==a.code){need(own(post,'code')&&a.code==='0x'&&a.nonce===0n&&a.storageRoot===EMPTY_ROOT,'Unsupported runtime replacement');row.code={before:a.code,after:code};}
    const ps=pre?.storage??{},ns=post.storage??{};need(record(ps)&&record(ns),'Malformed sparse storage');const storage=[];
    for(const key of [...new Set([...Object.keys(ps),...Object.keys(ns)])].sort()){
      need(++slots<=1024&&matches(key,WORD),'Excessive/malformed changed slots');const old=oldSlot(a,key);
      if(!own(ps,key))need(old===ZERO,'Missing nonzero slot preimage');const next=own(ns,key)?ns[key]:ZERO;
      need(matches(next,WORD),'Malformed storage value');if(old!==next)storage.push({slot:key,before:old,after:next});
    }
    if(storage.length)row.storage=storage;
    // Empty omitted maps mean no *reported* slot delta. They never enumerate or
    // erase an unrequested storage trie. Whole-account deletion is separate.
    if(Object.keys(row).length>1)out.push(row);
  }
  return sort(out);
}
function localStateChanges(attempt) {
  const rows=canonicalStateChanges(attempt.changes).accounts;
  return sort(rows.map(row=>{
    const a=initial(attempt.inputs,row.address);
    if(row.existence?.after===false)return {address:row.address,existence:{before:true,after:false},initialStorageRoot:a.storageRoot};
    const {existence,...rest}=row;return {...rest,...(existence?{existence:{before:existence.before,after:existence.after}}:{})};
  }));
}
function localGas(local) {
  const {output:o,costs:c}=local,m=q(o.execution.executionGasUsed),r=q(o.execution.gasRefundCounter);
  need(m<=5000000n-c.intrinsic,'Message gas exceeds budget');const before=c.intrinsic+m,refund=r<before/5n?r:before/5n,base=before-refund,floor=c.floor>base?c.floor-base:0n;
  need(equal(o.gasAccounting,{beforeRefund:before.toString(),appliedRefund:refund.toString(),floorAdjustment:floor.toString(),gasUsed:(base+floor).toString()}),'Local charged gas accounting differs');return (base+floor).toString();
}
function oracleBindings(oracle,request,header) {
  need(['completed','unavailable'].includes(oracle?.dispatch)&&Array.isArray(oracle.records)&&oracle.records.length<=4,'Oracle was not attempted');
  const planned=oracleRequests({request,header}),results=new Map();let previous=0;const seen=new Set();
  for(const wire of oracle.records){
    verifyCohortWireRecord(wire);need(wire.provider==='drpc'&&wire.profile==='product'&&wire.globalId>previous,'Oracle wire provider/order/profile differs');previous=wire.globalId;
    const index=planned.findIndex(p=>p.method===wire.request.method&&equal(p.params,wire.request.params));need(index>=0&&!seen.has(index),'Foreign/duplicate oracle request');
    need([...seen].every(n=>n<index),'Oracle request order differs');seen.add(index);results.set(index,wire);
  }
  for(const index of [0,3])need(results.get(index)?.status==='completed'&&equal(results.get(index).parsed.result,header),'Oracle full header bracket missing or changed');
  verifyEthereumHeader({header:results.get(0).parsed.result,expectedHash:header.hash});
  return results;
}

export async function adjudicateLocalOutcome(input) {
  input=clone(input);fields(input,['transactionHash','request','header','expectedLocalImplementation','local','oracle']);need(matches(input.transactionHash,WORD),'Transaction identity missing');
  const result={outcome:{transactionHash:input.transactionHash,execution:'provider_unavailable',comparison:'not_comparable'},channels:Object.fromEntries(CHANNELS.map(k=>[k,{status:'unavailable',reason:'Comparison not reached'}])),reasons:[],allChannelsComplete:false,evidence:{},
    limitations:{evaluatedProduct:'current_isolated_local_kernel',oracle:'remote_native_trace_and_sparse_diff',artifactHashesBound:false,sourceIdentityAuthenticityVerified:false,providerContextExecutionAttested:false,headerConsensusOrFinalityVerified:false,fullPoststateRootCompared:false,fullCallTreeEquality:false,originalTransactionReplay:false,feeSettlement:false,completeEconomicInventory:false,securityScore:false}};
  const stop=(execution,comparison,why)=>{Object.assign(result.outcome,{execution,comparison});result.reasons.push(why);return result;};
  if(input.local?.dispatch==='budget_unattempted')return stop('budget_unattempted','budget_unattempted','Selected local execution was not reached within frozen budget');
  let call;
  try{call=callRequest(input.request);implementation(input.local?.implementation,input.expectedLocalImplementation);verifyEthereumHeader({header:input.header,expectedHash:input.header.hash});}catch(e){return stop('provider_unavailable','not_comparable',reason(e));}
  const status=input.local?.attempt?.output?.execution?.status;
  if(status==='unsupported'||status==='invalid') {
    const a=input.local.attempt;
    try {
      need(input.local.dispatch==='completed'&&a.status==='completed'&&a.isolation?.processClosed===true&&a.broker?.pendingAtReturn===0&&equal(a.headerVerification,verifyEthereumHeader({header:input.header,expectedHash:input.header.hash})),'Unsupported attempt is not a completed bound worker result');
      need(['LOCAL_ETHEREUM_INPUT_INVALID','LOCAL_ETHEREUM_FORK_UNSUPPORTED','LOCAL_SENDER_CODE_UNSUPPORTED','LOCAL_LIFECYCLE_UNSUPPORTED','LOCAL_STATE_UNSUPPORTED','LOCAL_BLOB_UNSUPPORTED','LOCAL_BLOCKHASH_MISSING','LOCAL_CALL_INSUFFICIENT_BALANCE','LOCAL_CALL_NONCE_OVERFLOW'].includes(a.output.execution.error?.code),'Unrecognized local rejection');
      need(a.changes?.accounts?.length===0&&['unchanged','rolled_back'].includes(a.output.stateDisposition),'Unsupported attempt retained state');
      return stop('unsupported','not_comparable','Local kernel rejected its declared bounded profile; raw attempt retained');
    }catch(e){return stop('provider_unavailable','not_comparable',reason(e));}
  }
  if(!['success','reverted','failed'].includes(status))return stop('provider_unavailable','not_comparable','Local proof/process execution did not complete; raw attempt retained');
  let local;
  try{local=await bindLocal(input.local,call,input.header,input.expectedLocalImplementation);}catch(e){return stop('provider_unavailable','not_comparable',reason(e));}
  result.outcome.execution=status;result.evidence.local={sourceSha256:input.local.implementation.sourceSha256,blockHash:input.header.hash,stateRoot:input.header.stateRoot,inputEvidenceCount:local.attempt.inputEvidence.length,rawExecutionError:local.output.execution.error};
  if(input.oracle?.dispatch==='budget_unattempted')return stop(status,'budget_unattempted','Local result completed but oracle was not reached within frozen budget');
  let wires,trace;
  try{wires=oracleBindings(input.oracle,input.request,input.header);need(wires.get(1)?.status==='completed','Original provider trace unavailable');trace=rootBinding(wires.get(1).parsed.result,call,local);}catch(e){return stop(status,'oracle_unavailable',reason(e));}
  result.evidence.oracle={wireIds:[...wires.values()].map(w=>w.globalId),rawExecutionError:trace.error??null};
  const channel=(name,fn)=>{try{const [product,oracle]=fn();result.channels[name]={status:equal(product,oracle)?'match':'mismatch',product,oracle};}catch(e){result.channels[name]={status:'unavailable',reason:reason(e)};}};
  channel('executionStatus',()=>[errorClass(local.output.execution.error,true),errorClass(traceError(trace))]);
  channel('returnData',()=>{need(matches(local.output.execution.returnData,DATA),'Local return bytes missing');return [local.output.execution.returnData,returned(trace)];});
  channel('committedLogs',()=>{need(Array.isArray(local.output.logs)&&local.output.logs.length<=2000,'Local committed logs missing');return [local.output.logs.map(payload),oracleLogs(trace)];});
  channel('gasAccounting',()=>[localGas(local),q(trace.gasUsed).toString()]);
  channel('fullObservedStateChanges',()=>{
    const diff=wires.get(2);need(diff?.status==='completed','Original prestate diff unavailable; no changes inferred from execution status');
    return [localStateChanges(local.attempt),oracleStateChanges(diff.parsed.result,local.attempt.inputs)];
  });
  const statuses=Object.values(result.channels).map(c=>c.status);result.allChannelsComplete=statuses.every(s=>s!=='unavailable');
  result.outcome.comparison=statuses.includes('mismatch')?'mismatch':statuses.every(s=>s==='match')?'match':'not_comparable';
  if(!result.allChannelsComplete)result.reasons.push('At least one of the five comparison channels lacks complete supported evidence');return result;
}
