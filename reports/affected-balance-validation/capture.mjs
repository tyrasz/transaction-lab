// Development oracle capture only. Never signs, broadcasts, or retries a request.
// --verify replays recorded replies through the frozen validation context offline.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createHistoricalStateContext } from './frozen-context/historical-state.js';
import { normalizeBlock, assertNoProviderErrorResult, RpcError } from './frozen-context/rpc.js';

const mode = process.argv[2];
if (!['--capture', '--verify'].includes(mode)) throw new Error('Use --capture once for live reads, or --verify for offline validation.');
const directory = new URL('./', import.meta.url);
const endpoint = 'https://hyperliquid.drpc.org';
const token = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const budgets = { maxRpcCalls: 60, maxBalanceEvidenceCalls: 28, maxResponseBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, timeoutMs: 25000, totalTimeoutMs: 8 * 60 * 1000, retries: 0 };
const cases = [
  { id: 'router', source: '../permission-discovery/router-permit-candidate-verified.json', accounts: ['0x0c71073344e27e33cb57fcb587fc412d689dfd1d','0x693f12e9e6b35b34458793546065e8b08e0299d6','0x04de1ef694923844bae419d4f832196f21767f86','0x7fe37fc2f987eb981a0fc63cf1eabf04463550d4','0xb4894380282533a86cb241145fac54aaac995f18'] },
  { id: 'direct-a', source: '../affected-account-discovery/direct-transferfrom-a-evidence.json', accounts: ['0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379','0x2908da1b63c4f7ce001bf5d875d179930a79eed4'] },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const units = raw => { const n=BigInt(raw),sign=n<0n?'-':'',s=(n<0n?-n:n).toString().padStart(7,'0'); return sign+s.slice(0,-6)+'.'+s.slice(-6); };
const readJson = async path => JSON.parse(await readFile(new URL(path,directory),'utf8'));
const sourceManifest = await readJson('frozen-context-manifest.json');
for (const source of sourceManifest.sources) assert.equal(sha(await readFile(new URL(source.frozen,directory))),source.sha256,'Frozen validation dependency changed');
let recording = mode === '--verify' ? await readJson('capture.json') : {
  schemaVersion:'1.0',startedAt:new Date().toISOString(),status:'running',endpoint,budgets,
  sourceManifestSha256:sha(await readFile(new URL('frozen-context-manifest.json',directory))),
  scriptSha256:sha(await readFile(new URL('./capture.mjs',import.meta.url))),
  scope:'Independent balanceOf state queries for seven predeclared USDC account pairs; same provider and existing frozen context, not an independent execution engine.',
  calls:[],cases:[],totalResponseBytes:0,
};
const started=Date.now();
let caseId, cursor=0;
async function save() { if(mode==='--capture') await writeFile(new URL('capture.json',directory),JSON.stringify(recording,null,2)+'\n'); }
if(mode==='--capture') await writeFile(new URL('capture.json',directory),JSON.stringify(recording,null,2)+'\n',{flag:'wx'});
function receiptIdentity(receipt) {
  return Object.fromEntries(['transactionHash','blockHash','blockNumber','transactionIndex','status','gasUsed','effectiveGasPrice','from','to','logs'].map(key=>[key,receipt[key]]));
}
async function rpcCall(method,params) {
  assert.ok(['eth_chainId','eth_getTransactionReceipt','eth_getBlockByHash','eth_getBlockByNumber','debug_traceTransaction','debug_traceCallMany'].includes(method),'Read method is not allowed');
  let entry;
  if(mode==='--verify') {
    entry=recording.calls[cursor++];
    assert.ok(entry,'Unexpected offline RPC request');
    assert.deepEqual({caseId:entry.caseId,method:entry.request.method,params:entry.request.params},{caseId,method,params},'Recorded request order/content changed');
    assert.equal(sha(Buffer.from(entry.responseText)),entry.responseSha256,'Raw response bytes changed');
  } else {
    if(recording.calls.length>=budgets.maxRpcCalls||Date.now()-started>budgets.totalTimeoutMs) throw new Error('Run budget exhausted');
    entry={caseId,requestedAt:new Date().toISOString(),request:{jsonrpc:'2.0',id:recording.calls.length+1,method,params}};
    recording.calls.push(entry);
    await save();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),budgets.timeoutMs);
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(entry.request),signal:controller.signal});
      entry.httpStatus=response.status;
      const chunks=[]; let count=0;
      for await(const chunk of response.body) {
        count+=chunk.length;
        recording.totalResponseBytes+=chunk.length;
        if(count>budgets.maxResponseBytes||recording.totalResponseBytes>budgets.maxTotalBytes) {controller.abort();throw new Error('Response byte budget exhausted');}
        chunks.push(Buffer.from(chunk));
      }
      entry.responseText=Buffer.concat(chunks).toString('utf8');
      entry.responseSha256=sha(Buffer.from(entry.responseText));
      entry.response=JSON.parse(entry.responseText);
    } catch(error) {entry.captureError={name:error.name,message:error.message};}
    finally {clearTimeout(timer);entry.completedAt=new Date().toISOString();await save();}
  }
  if(entry.captureError) throw new RpcError('Public evidence request failed.','RPC_CONNECTION_ERROR');
  assert.deepEqual(JSON.parse(entry.responseText),entry.response,'Parsed response differs from raw bytes');
  if(entry.httpStatus!==200) throw new RpcError('Public RPC returned HTTP failure.','RPC_HTTP_ERROR');
  const response=entry.response;
  assert.equal(response.jsonrpc,'2.0');assert.equal(response.id,entry.request.id);
  if(response.error) throw new RpcError('Public RPC rejected the read.','RPC_EXECUTION_ERROR',{rpcCode:response.error.code});
  assert.ok(Object.hasOwn(response,'result'),'Missing RPC result');
  assertNoProviderErrorResult(method,response.result);
  return structuredClone(response.result);
}
const outputs=[];
for(const specification of cases) {
  caseId=specification.id;
  const sourceBytes=await readFile(new URL(specification.source,directory)),source=JSON.parse(sourceBytes);
  const tx=source.captures.transaction.response.result,receipt=source.captures.receipt.response.result,trace=source.captures.callTrace.response.result;
  const block=normalizeBlock(source.captures.block.response.result);
  const request={chainId:999,from:tx.from,to:tx.to,data:tx.input,value:BigInt(tx.value).toString()};
  const out={id:caseId,source:{path:specification.source,sha256:sha(sourceBytes)},transactionHash:tx.hash,blockHash:tx.blockHash,blockNumber:BigInt(tx.blockNumber).toString(),transactionIndex:BigInt(tx.transactionIndex).toString(),status:'pending',accounts:specification.accounts,balances:[],unattempted:[],checks:[]};
  let context;
  const firstCall=mode==='--capture'?recording.calls.length:cursor;
  try {
    assert.equal(tx.transactionIndex,'0x0');
    assert.equal(await rpcCall('eth_chainId',[]),'0x3e7');out.checks.push('fresh_chain_id');
    assert.deepEqual(receiptIdentity(await rpcCall('eth_getTransactionReceipt',[tx.hash])),receiptIdentity(receipt));out.checks.push('fresh_receipt_matches_saved_original');
    const rpc={provider:'drpc',call:rpcCall};
    context=createHistoricalStateContext({request,block,rpc,transaction:tx,receipt,trace});
    await context.prepare();out.checks.push('original_position_replay_header_runtime_and_state_diff_validated');
    for(const account of specification.accounts) {
      const {before,after,delta}=await context.readPair({to:token,data:'0x70a08231'+account.slice(2).padStart(64,'0')});
      out.balances.push({token,account,beforeRaw:before.toString(),afterRaw:after.toString(),deltaRaw:delta.toString(),before:units(before),after:units(after),delta:units(delta),basis:'original_position_balanceOf_uint256_returns',validation:'known_proxy_implementation_trace_and_query_nonce_fee_diff'});
    }
    await context.verifyCanonical();out.checks.push('final_canonical_binding');
    out.status='measured';out.executionIdentity=context.executionIdentity;
  } catch(error) {
    out.status='unavailable';out.error={name:error.name,message:error.message};
    out.unvalidatedPartialReads=out.balances;out.balances=[];
    out.unattempted=specification.accounts.filter(account=>!out.unvalidatedPartialReads.some(item=>item.account===account));
  }
  out.rpcCalls=(mode==='--capture'?recording.calls.length:cursor)-firstCall;
  out.contextEvidence=context?.snapshotEvidence()??null;
  outputs.push(out);
  if(mode==='--capture') {recording.cases=outputs;await save();}
  console.log(JSON.stringify({caseId,status:out.status,rpcCalls:out.rpcCalls,balances:out.balances,error:out.error}));
}
if(mode==='--verify') {
  assert.equal(cursor,recording.calls.length,'Unused recorded requests');
  assert.deepEqual(outputs,recording.cases,'Validated oracle differs from captured result');
  assert.equal(recording.sourceManifestSha256,sha(await readFile(new URL('frozen-context-manifest.json',directory))));
} else {
  recording.status=outputs.every(item=>item.status==='measured')?'complete':'completed_with_unavailable_cases';
  recording.completedAt=new Date().toISOString();
  recording.balanceEvidenceCalls=recording.calls.filter(entry=>entry.request.method==='debug_traceCallMany'&&entry.request.params?.[0]?.[0]?.transactions?.[0]?.data?.startsWith('0x70a08231')).length;
  assert.ok(recording.balanceEvidenceCalls<=budgets.maxBalanceEvidenceCalls);
  await save();
  const oracle={schemaVersion:'1.0',createdAt:recording.completedAt,scope:'Development USDC reference values only; no security or general coverage score.',basis:'independent_original_position_balanceOf_queries',captureSha256:sha(await readFile(new URL('capture.json',directory))),sameProvider:true,independentExecutionEngine:false,sharedValidationAdapter:true,cases:outputs.map(({id,status,transactionHash,blockHash,blockNumber,transactionIndex,balances,error})=>({id,status,transactionHash,blockHash,blockNumber,transactionIndex,balances,...(error?{error}:{})}))};
  await writeFile(new URL('oracle.json',directory),JSON.stringify(oracle,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({mode,status:recording.status,rpcCalls:recording.calls.length,balanceEvidenceCalls:recording.balanceEvidenceCalls,totalResponseBytes:recording.totalResponseBytes}));
