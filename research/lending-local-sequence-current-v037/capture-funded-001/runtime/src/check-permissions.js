import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { replay } from './server.js';
import { RpcClient, RpcError, assertNoProviderErrorResult } from './rpc.js';
import { validateReplay } from './validate.js';

export const PERMISSION_PROVIDERS = [
  { id: 'drpc', url: 'https://hyperliquid.drpc.org' },
  { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' },
];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DIRECTORY = resolve(ROOT, 'reports/permission-comparisons');
const MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const IDENTITY = ['transactionHash','transactionIndex','postTransactionIndex','stateBlockHash','blockNumber','timestamp','stateBinding','headerContext','method'];
const choose = (object, fields) => Object.fromEntries(fields.map(key => [key, object?.[key] ?? null]));
const lower = value => typeof value === 'string' ? value.toLowerCase() : value;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function exact(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0x[0-9a-f]+|[0-9]+)$/i).test(value)) throw new Error('Malformed exact integer.');
  const n = BigInt(value);
  if (n > MAX || n < (signed ? -MAX : 0n)) throw new Error('Exact integer outside supported range.');
  return n.toString();
}
const quantity = value => value === undefined || value === null ? null : exact(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
function logProjection(log) {
  return { address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data), logIndex: quantity(log.logIndex), position: quantity(log.position) };
}
function traceProjection(frame) {
  if (!frame || typeof frame.type !== 'string') throw new Error('Missing trace.');
  return { type: frame.type, from: lower(frame.from), to: lower(frame.to), input: lower(frame.input ?? '0x'), output: lower(frame.output ?? '0x'), value: quantity(frame.value ?? '0'), gasUsed: quantity(frame.gasUsed), error: frame.error ?? null, logs: (frame.logs ?? []).map(logProjection), calls: (frame.calls ?? []).map(traceProjection) };
}
function receiptProjection(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) throw new Error('Missing receipt.');
  return { transactionHash: lower(receipt.transactionHash), blockHash: lower(receipt.blockHash), from: lower(receipt.from), to: lower(receipt.to), ...Object.fromEntries(['transactionIndex','blockNumber','status','gasUsed','effectiveGasPrice'].map(key => [key, quantity(receipt[key])])), logs: receipt.logs.map(logProjection) };
}
const pairKey = item => `${lower(item.asset?.address ?? item.token)}:${lower(item.owner)}:${lower(item.spender)}`;
function allowanceProjection(measurement) {
  if (measurement?.status !== 'measured' || !Array.isArray(measurement.allowances) || !measurement.allowances.length) throw new Error('Allowance measurement unavailable.');
  const seen = new Set();
  const allowances = measurement.allowances.map(item => {
    if (![item.asset?.address,item.owner,item.spender].every(value => ADDRESS.test(value ?? ''))) throw new Error('Malformed allowance identity.');
    const key = pairKey(item);
    if (seen.has(key)) throw new Error('Duplicate allowance pair.');
    seen.add(key);
    const beforeRaw = exact(item.beforeRaw), afterRaw = exact(item.afterRaw), deltaRaw = exact(item.deltaRaw,true);
    if (BigInt(afterRaw)-BigInt(beforeRaw)!==BigInt(deltaRaw)) throw new Error('Inconsistent allowance delta.');
    return { token: lower(item.asset.address), owner: lower(item.owner), spender: lower(item.spender), beforeRaw, afterRaw, deltaRaw, consistency: choose(item.consistency,['eventComparison','lastEventAmountRaw','requestComparison']) };
  }).sort((a,b)=>pairKey(a).localeCompare(pairKey(b)));
  return { status: measurement.status, basis: measurement.basis, executionIdentity: choose(measurement.executionIdentity,IDENTITY), allowances };
}
function permissionProjection(permissions) {
  if (!Array.isArray(permissions?.observations)) throw new Error('Missing permission observations.');
  return permissions.observations.filter(o=>['permit_request','approval_request','approval_event'].includes(o.kind)).map(o=>({token:lower(o.asset?.address),...choose(o,['kind','owner','spender','amountRaw','deadlineRaw','submitter','permitCaller','relayed','framePath','eventCorrelation','implementation','signatureVerification'])}));
}

// Values are from decoded original public calls/events and independently captured
// transaction-position allowance queries, not this runner or the analyzer output.
const SOURCES = [
  { id:'usdc-approve-hyperlend', file:'approve-usdc-hyperlend', pairs:[['0xc6bf059aabef5668c32ebeef3dae82e59d4ebc4a','0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b','0','1660000000','1660000000']], knownLimitation:'The prior dRPC response omitted this transaction index from its block header; final allowance must stay unavailable if that incomplete evidence recurs.' },
  { id:'husdc-relayed-permit', file:'permit-husdc-direct', pairs:[['0x3e248867a2a2ddd1d901f7d595c4d02c6519b32a','0x8a0f75a499c17632e5ee6cc4156099292f3e68f9','0',MAX.toString(),MAX.toString()]] },
  { id:'usdc-router-permit-consumed', file:'router-permit-candidate', pairs:[['0x0c71073344e27e33cb57fcb587fc412d689dfd1d','0x693f12e9e6b35b34458793546065e8b08e0299d6','0',(MAX-25000000n).toString(),MAX.toString()],['0x693f12e9e6b35b34458793546065e8b08e0299d6','0x04de1ef694923844bae419d4f832196f21767f86','0','0','24812500']] },
];
export async function loadPermissionCases() {
  const cases = [];
  for (const source of SOURCES) {
    const sourceArtifact = `reports/permission-discovery/${source.file}-verified.json`;
    const bytes = await readFile(resolve(ROOT,sourceArtifact));
    const raw = JSON.parse(bytes), decoded = JSON.parse(await readFile(resolve(ROOT,`reports/permission-discovery/${source.file}-decoded.json`)));
    if (sha(bytes)!==decoded.rawSha256 || !Object.values(raw.checks).every(v=>v===true)) throw new Error('Original permission evidence integrity check failed.');
    const tx=raw.captures.transaction.response.result, receipt=raw.captures.receipt.response.result, trace=raw.captures.callTrace.response.result;
    if (tx.hash!==decoded.transactionHash || receipt.transactionHash!==tx.hash || receipt.blockHash!==decoded.block.hash || exact(tx.transactionIndex)!==decoded.block.transactionIndex) throw new Error('Original permission identity mismatch.');
    const permissionCalls = decoded.calls.filter(call=>['approve','permit'].includes(call.operation));
    const pairs = source.pairs.map(([owner,spender,beforeRaw,afterRaw,eventAmountRaw])=>{
      const call=permissionCalls.find(c=>c.owner===owner&&c.spender===spender);
      if (!call || call.valueRaw!==eventAmountRaw) throw new Error('Expected original permission amount differs from captured calldata.');
      return { token:call.token,owner,spender,beforeRaw,afterRaw,deltaRaw:(BigInt(afterRaw)-BigInt(beforeRaw)).toString(),eventAmountRaw,eventComparison:afterRaw===eventAmountRaw?'matches_last_observed_event':'differs_from_last_observed_event',requestComparison:afterRaw===eventAmountRaw?'matches_requested_amount':'differs_from_requested_amount' };
    });
    cases.push({id:source.id,request:validateReplay({chainId:999,transactionHash:tx.hash}),originalRequest:{chainId:999,from:tx.from,to:tx.to,data:tx.input,value:exact(tx.value)},expected:{transactionHash:tx.hash,block:decoded.block,gasUsed:decoded.execution.gasUsed,pairs,permissionCalls,knownLimitation:source.knownLimitation??null},evidence:{sourceArtifact,sourceSha256:sha(bytes),receipt,trace}});
  }
  return cases;
}

/** Validate one report independently so a missing second provider cannot hide an incorrect first result. */
export function validatePermissionReport(report,item) {
  const checks=[];
  if (report === null || report === undefined) return {status:'unavailable',checks,reason:'The provider did not return a historical permission report.'};
  const check=(name,actual,expected)=>checks.push({name,equal:same(actual,expected),actual,expected});
  try {
    const e=item.expected,b=e.block;
    check('successful historical execution',report?.execution?.status,'success');
    check('original transaction gas used',report?.execution?.gasUsed,e.gasUsed);
    check('original request',report?.request,item.originalRequest);
    check('original identity',choose(report?.source,['chainId','transactionHash','transactionIndex','blockNumber','blockHash','timestamp','mode','blockBinding']),{chainId:999,transactionHash:e.transactionHash,transactionIndex:b.transactionIndex,blockNumber:b.number,blockHash:b.hash,timestamp:b.timestamp,mode:'historical_trace',blockBinding:'transaction_hash'});
    check('original receipt',receiptProjection(report?.evidence?.receipt),receiptProjection(item.evidence.receipt));
    check('original trace',traceProjection(report?.evidence?.traceResponse),traceProjection(item.evidence.trace));
    check('protocol coverage stays partial',report?.coverage?.status,'partial');
    check('permission coverage stays limited',report?.permissions?.coverage?.status,'limited');
    check('security remains explicitly unassessed',report?.security?.status,'not_assessed');
    check('no security findings are inferred',report?.security?.findings,[]);
    const observations=report?.permissions?.observations??[];
    const requested=observations.filter(o=>['approval_request','permit_request'].includes(o.kind));
    const emitted=observations.filter(o=>o.kind==='approval_event');
    check('known permission request count',requested.length,e.permissionCalls.length);
    check('known Approval event count',emitted.length,e.pairs.length);
    for(const call of e.permissionCalls){
      const found=requested.filter(o=>o.asset?.address===call.token&&o.owner===call.owner&&o.spender===call.spender);
      const observation=found.length===1?found[0]:null;
      check(`permission ${call.path} amount and correlation`,choose(observation,['kind','amountRaw','framePath','eventCorrelation']),{kind:call.operation==='permit'?'permit_request':'approval_request',amountRaw:call.valueRaw,framePath:call.path,eventCorrelation:'matched'});
      if(call.operation==='permit')check(`permit ${call.path} owner, external submitter and immediate caller`,choose(observation,['owner','submitter','permitCaller','relayed','deadlineRaw','signatureVerification']),{owner:call.owner,submitter:call.submitter,permitCaller:call.immediateCaller,relayed:call.submitterDiffersFromOwner,deadlineRaw:call.deadlineRaw,signatureVerification:'not_independently_verified'});
    }
    for(const pair of e.pairs){const events=emitted.filter(o=>pairKey(o)===pairKey(pair));check(`Approval ${pairKey(pair)} original amount`,events.length===1?events[0].amountRaw:null,pair.eventAmountRaw);}
    if(report?.allowanceChanges?.status!=='measured')return {status:checks.every(c=>c.equal)?'unavailable':'mismatched',checks,reason:'Exact historical allowance measurement is unavailable; original permission evidence alone does not establish the final allowance.'};
    const projection=allowanceProjection(report.allowanceChanges);
    check('historical allowance basis',projection.basis,'historical_transaction_position_allowance');
    check('historical allowance execution identity',projection.executionIdentity,{transactionHash:e.transactionHash,transactionIndex:b.transactionIndex,postTransactionIndex:(BigInt(b.transactionIndex)+1n).toString(),stateBlockHash:b.hash,blockNumber:b.number,timestamp:b.timestamp,stateBinding:'block_hash_and_transaction_index',headerContext:'original_block',method:'debug_traceCallMany'});
    check('final allowance verification flag',report.permissions.coverage.allowanceStateVerified,true);
    const expected=e.pairs.map(p=>({token:p.token,owner:p.owner,spender:p.spender,beforeRaw:p.beforeRaw,afterRaw:p.afterRaw,deltaRaw:p.deltaRaw,consistency:{eventComparison:p.eventComparison,lastEventAmountRaw:p.eventAmountRaw,requestComparison:p.requestComparison}})).sort((a,b)=>pairKey(a).localeCompare(pairKey(b)));
    check('independent exact final allowances and event distinction',projection.allowances,expected);
    return {status:checks.every(c=>c.equal)?'matched':'mismatched',checks,projection};
  } catch {
    const mismatched=checks.some(check=>!check.equal)||report?.allowanceChanges?.status==='measured';
    return {status:mismatched?'mismatched':'unavailable',checks,reason:mismatched
      ? 'Reported evidence contradicts expectations or a claimed measured result is malformed; this is a comparison failure.'
      : 'Report lacks well-formed original evidence or exact, unique allowance pairs; no comparison success is inferred.'};
  }
}
export function comparePermissionReports(left,right,item) {
  const validations=[validatePermissionReport(left,item),validatePermissionReport(right,item)];
  if(validations.some(v=>v.status==='mismatched'))return {status:'mismatched',matches:false,validations,checks:[]};
  if(validations.some(v=>v.status!=='matched'))return {status:'incomplete',matches:false,validations,checks:[]};
  const checks=[
    ['cross-provider final allowances and identity',validations[0].projection,validations[1].projection],
    ['cross-provider permission observations',permissionProjection(left.permissions),permissionProjection(right.permissions)],
    ['cross-provider original receipt',receiptProjection(left.evidence.receipt),receiptProjection(right.evidence.receipt)],
    ['cross-provider original trace',traceProjection(left.evidence.traceResponse),traceProjection(right.evidence.traceResponse)],
  ].map(([name,a,b])=>({name,equal:same(a,b),left:a,right:b}));
  const matches=checks.every(c=>c.equal);
  return {status:matches?'matched':'mismatched',matches,validations,checks};
}
function safeError(error) {
  const codes=new Set(['RPC_ERROR','METHOD_NOT_ALLOWED','RPC_HTTP_ERROR','RPC_INVALID_RESPONSE','RPC_EXECUTION_ERROR','RPC_TIMEOUT','RPC_CONNECTION_ERROR','RPC_CHAIN_MISMATCH','BLOCK_UNAVAILABLE','BLOCK_MISMATCH','TRACE_UNAVAILABLE','TRACE_MISMATCH','TRANSACTION_UNAVAILABLE','TRACE_RECEIPT_MISMATCH','TRANSACTION_CHANGED']);
  return {code:error instanceof RpcError&&codes.has(error.code)?error.code:'PERMISSION_CHECK_ERROR',message:'The read-only historical permission check could not be completed.',...(Number.isSafeInteger(error?.detail?.rpcCode)?{rpcCode:error.detail.rpcCode}:{})};
}
function trackedClient(provider,rpcFactory) {
  const rpc=rpcFactory({url:provider.url}),records=[],call=rpc.call.bind(rpc);let sequence=0;
  rpc.call=async(method,params=[])=>{
    const record={sequence:++sequence,request:{jsonrpc:'2.0',id:rpc.nextId,method,params:structuredClone(params)}};records.push(record);const start=performance.now();
    try {const result=await call(method,params);assertNoProviderErrorResult(method,result);record.response={jsonrpc:'2.0',id:record.request.id,result:structuredClone(result)};return result;}
    catch(error){record.error=safeError(error);throw error;}
    finally {record.durationMs=Math.round(performance.now()-start);}
  };
  return {rpc,records};
}
/** Exactly three fixed historical transactions × two fixed public providers, sequentially and without retry. */
export async function runPermissionChecks({outputDirectory=DEFAULT_DIRECTORY,writeReport=true,rpcFactory=options=>new RpcClient(options),replayImpl=replay}={}) {
  const createdAt=new Date().toISOString();
  const report={schemaVersion:'1.0',createdAt,kind:'bounded_historical_permission_comparison',status:'incomplete',providers:PERMISSION_PROVIDERS,cases:[],summary:{matched:0,mismatched:0,incomplete:0,total:3,runs:{planned:6,attempted:0,completed:0,measured:0,unavailable:0,failed:0}},limitations:[
    'Three reviewed public historical transactions are a regression corpus, not held-out evaluation or a vendor score.',
    'Two providers may share infrastructure or execution engines. Their agreement does not prove implementation independence.',
    'Durations are individual observations, not a performance benchmark.',
    'Permission changes do not establish transaction-wide protocol coverage, spender reputation, signing intent or security safety.',
    'Known dRPC incomplete-header evidence is retained as unavailable if it recurs; no retry or provider substitution is performed.',
    'Original public calldata contains historical signatures. These remain in raw requests/responses only; decoded comparisons omit signature components.',
    'Successful public RPC data is retained after the shared provider-error guard. Arbitrary exceptions and provider error metadata are replaced with fixed messages and bounded codes.',
  ]};
  try {
    for(const item of await loadPermissionCases()){
      const runs=[];
      for(const provider of PERMISSION_PROVIDERS){
        const start=performance.now();let tracked;report.summary.runs.attempted++;
        try {
          tracked=trackedClient(provider,rpcFactory);
          const response=await replayImpl(structuredClone(item.request),tracked.rpc);
          const validation=validatePermissionReport(response,item);
          runs.push({provider:provider.id,request:item.request,response,validation,durationMs:Math.round(performance.now()-start),rpcCalls:tracked.records});
          report.summary.runs.completed++;
          report.summary.runs[response?.allowanceChanges?.status==='measured'?'measured':'unavailable']++;
        } catch(error){runs.push({provider:provider.id,request:item.request,error:safeError(error),durationMs:Math.round(performance.now()-start),rpcCalls:tracked?.records??[]});report.summary.runs.failed++;}
      }
      const comparison=comparePermissionReports(runs[0].response,runs[1].response,item);
      report.cases.push({...item,status:comparison.status,comparison,runs});report.summary[comparison.status]++;
    }
    report.status=report.summary.mismatched?'failed':report.summary.incomplete?'incomplete':'passed';
  }catch(error){report.error=safeError(error);report.summary.incomplete=report.summary.total-report.summary.matched-report.summary.mismatched;report.status='failed';}
  if(writeReport){await mkdir(outputDirectory,{recursive:true});report.outputPath=resolve(outputDirectory,createdAt.replace(/[:.]/g,'-')+'.json');await writeFile(report.outputPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length>2){console.error('Usage: node src/check-permissions.js');process.exitCode=1;}
  else try {const r=await runPermissionChecks();console.log(`Permission comparison: ${r.summary.matched}/${r.summary.total} matched, ${r.summary.mismatched} mismatched, ${r.summary.incomplete} incomplete; ${r.summary.runs.attempted} bounded attempts.`);if(r.outputPath)console.log(`Evidence: ${r.outputPath}`);console.log('No vendor score or transaction-wide safety verdict.');process.exitCode=r.status==='passed'?0:1;}
  catch {console.error('The permission check could not be saved or completed.');process.exitCode=1;}
}
