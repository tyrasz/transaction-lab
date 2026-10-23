import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RpcClient, RpcError, normalizeBlock } from './rpc.js';
import { validateSimulation, validateReplay, InputError } from './validate.js';
import { analyzeTrace } from './analyze.js';
import { measureBalances } from './balances.js';
import { measureLendingBalances } from './lending-balances.js';
import { measureAllowances } from './allowances.js';
import { createStateContext } from './state.js';
import { analyzePermissions } from './permissions.js';
import { EXAMPLES, METADATA, CAPABILITIES, VERSION } from './config.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const engineFiles = ['allowances.js','analyze.js','balances.js','config.js','lending.js','lending-balances.js','permissions.js','revert.js','rpc.js','server.js','state.js','validate.js'];
const engineHash = createHash('sha256');
for (const name of engineFiles) engineHash.update(name+'\0').update(await readFile(path.join(ROOT,'src',name))).update('\0');
const implementation = Object.freeze({name:'Transaction Lab',version:VERSION,sourceSha256:engineHash.digest('hex'),sourceFiles:engineFiles});
const STATIC = { '/': ['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
const TRACER = { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } };
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x[0-9a-f]+$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isQuantity = value => typeof value === 'string' && QUANTITY.test(value);
const sameHex = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const sameQuantity = (left, right) => isQuantity(left) && isQuantity(right) && BigInt(left) === BigInt(right);

function includePermissionCoverage(analysis, permissions, allowanceChanges) {
  if (allowanceChanges?.status === 'measured') {
    permissions.coverage.allowanceStateVerified = true;
    permissions.coverage.allowanceStateScope = 'Only the token, owner and spender pairs listed in allowanceChanges were measured after the whole transaction.';
  }
  if (analysis.coverage.status === 'unsupported' && permissions.observations.some(item => item.tokenVerified === true)) {
    analysis.coverage = {status:'partial',reasons:[...analysis.coverage.reasons, allowanceChanges?.status === 'measured'
      ? 'Configured ERC20 permission pairs have measured final allowance values. Other transaction effects remain outside full protocol coverage.'
      : 'Configured ERC20 approval requests and events were interpreted separately. Final allowance state and other effects remain unverified.']};
  }
}

function validateRootTrace(trace, request) {
  // A top-level message to an existing account is CALL. DELEGATECALL is valid in
  // child frames, but cannot replace the root of this API's requested message.
  if (!isObject(trace) || trace.type !== 'CALL' || !ADDRESS.test(trace.from ?? '') ||
      !ADDRESS.test(trace.to ?? '') || typeof trace.input !== 'string' || !DATA.test(trace.input) ||
      !isQuantity(trace.gasUsed) || (trace.value !== undefined && !isQuantity(trace.value)) ||
      (trace.output !== undefined && (typeof trace.output !== 'string' || !DATA.test(trace.output))) ||
      (trace.error !== undefined && typeof trace.error !== 'string') ||
      (trace.revertReason !== undefined && typeof trace.revertReason !== 'string')) {
    throw new RpcError('Provider did not return a complete root call trace.', 'TRACE_UNAVAILABLE');
  }
  // Some tracers omit zero values; an omitted nonzero value is not evidence of
  // the requested transaction and must not become an empty successful preview.
  const value = trace.value === undefined ? 0n : BigInt(trace.value);
  if (!sameHex(trace.from, request.from) || !sameHex(trace.to, request.to) ||
      !sameHex(trace.input, request.data) || value !== BigInt(request.value)) {
    throw new RpcError('The returned trace does not match the requested transaction.', 'TRACE_MISMATCH');
  }
}

function validateConfirmedTransaction(tx, receipt, transactionHash) {
  if (!isObject(tx) || !isObject(receipt) || !sameHex(tx.hash, transactionHash) ||
      !sameHex(receipt.transactionHash, transactionHash) || !HASH.test(tx.blockHash ?? '') ||
      !sameHex(tx.blockHash, receipt.blockHash) || !sameQuantity(tx.blockNumber, receipt.blockNumber) ||
      !sameQuantity(tx.transactionIndex, receipt.transactionIndex) || !ADDRESS.test(tx.from ?? '') ||
      !ADDRESS.test(tx.to ?? '') || !isQuantity(tx.value) || typeof tx.input !== 'string' ||
      !DATA.test(tx.input) || !isQuantity(receipt.gasUsed) || !['0x0', '0x1'].includes(receipt.status) ||
      (tx.chainId !== undefined && (!isQuantity(tx.chainId) || BigInt(tx.chainId) !== 999n)) ||
      (receipt.from !== undefined && !sameHex(tx.from, receipt.from)) ||
      (receipt.to !== undefined && !sameHex(tx.to, receipt.to))) {
    throw new RpcError('A confirmed contract-call transaction and matching receipt are required.', 'TRANSACTION_UNAVAILABLE');
  }
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new InputError('Content-Type must be application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new InputError('Request body exceeds the 128 KiB limit.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('Request body is not valid JSON.'); }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  res.end(JSON.stringify(body));
}

async function persistReport(report, reportDir) {
  const dir = path.join(reportDir, 'simulations');
  await mkdir(dir, {recursive:true});
  await writeFile(path.join(dir, `${report.id}.json`), JSON.stringify(report, null, 2)+'\n', {mode:0o600});
  const files = (await readdir(dir)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  if (files.length > 40) {
    const items = await Promise.all(files.map(async name => { try { const value=JSON.parse(await readFile(path.join(dir,name),'utf8')); return {name,at:value.createdAt}; } catch {return {name,at:''};} }));
    items.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    for (const item of items.slice(0, items.length-40)) await unlink(path.join(dir,item.name));
  }
}

export async function simulate(input, rpc) {
  const start = performance.now();
  const {block: blockTag, ...request} = validateSimulation(input);
  await rpc.verifyChain();
  const block = normalizeBlock(await rpc.call('eth_getBlockByNumber', [blockTag, false]));
  if (blockTag !== 'latest' && BigInt(blockTag).toString() !== block.number) {
    throw new RpcError('Provider returned a different block than requested.', 'BLOCK_MISMATCH');
  }
  // Block hashes avoid silently moving to another block during a reorganization.
  const traceRequest = {
    method: 'debug_traceCall',
    params: [{ from:request.from, to:request.to, data:request.data, value:'0x'+BigInt(request.value).toString(16), gas:'0x4c4b40' }, block.hash, TRACER],
  };
  const trace = await rpc.call(traceRequest.method, traceRequest.params);
  validateRootTrace(trace, request);
  const analysis = analyzeTrace({request, trace, block, metadata:METADATA, mode:'simulation'});
  const permissions = analyzePermissions({request,trace,metadata:METADATA});
  const stateContext = createStateContext({request,block,rpc});
  const balanceMethod = ['withdraw','borrow','repay'].includes(analysis.protocol?.operation) ? measureLendingBalances : measureBalances;
  const [balanceResult,allowanceResult] = await Promise.all([
    balanceMethod({request,block,rpc,metadata:METADATA,analysis,stateContext}),
    measureAllowances({request,trace,block,rpc,metadata:METADATA,analysis,permissions,stateContext}),
  ]);
  const {evidence:balanceEvidence,...balanceChanges} = balanceResult;
  const {evidence:allowanceEvidence,...allowanceChanges} = allowanceResult;
  includePermissionCoverage(analysis,permissions,allowanceChanges);
  return {
    schemaVersion:'1.0', implementation, id:randomUUID(), createdAt:new Date().toISOString(), request,
    source:{provider:rpc.provider,chainId:999,blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,mode:'simulation',blockBinding:'explicit_block_hash',requestedBlock:blockTag},
    ...analysis, balanceChanges, allowanceChanges, permissions, timing:{totalMs:Math.round(performance.now()-start),rpcMs:Math.round(rpc.rpcMs)},
    evidence:{traceMethod:traceRequest.method,traceRequest,traceResponse:trace,balanceMeasurement:balanceEvidence,allowanceMeasurement:allowanceEvidence},
  };
}

export async function replay(input, rpc) {
  const start = performance.now();
  const {transactionHash} = validateReplay(input);
  await rpc.verifyChain();
  const [tx,receipt] = await Promise.all([
    rpc.call('eth_getTransactionByHash',[transactionHash]), rpc.call('eth_getTransactionReceipt',[transactionHash]),
  ]);
  validateConfirmedTransaction(tx, receipt, transactionHash);
  let request;
  try {
    const normalized = validateSimulation({chainId:999,from:tx.from,to:tx.to,data:tx.input,value:BigInt(tx.value).toString()});
    const {block:unused,...transactionRequest} = normalized;
    request = transactionRequest;
  } catch {
    throw new RpcError('The historical transaction is malformed or exceeds supported input limits.', 'TRANSACTION_UNAVAILABLE');
  }
  const block = normalizeBlock(await rpc.call('eth_getBlockByHash',[tx.blockHash,false]));
  if (!sameHex(block.hash, tx.blockHash) || block.number !== BigInt(tx.blockNumber).toString()) {
    throw new RpcError('Provider returned block metadata that does not match the transaction.', 'BLOCK_MISMATCH');
  }
  const traceRequest = {method:'debug_traceTransaction',params:[transactionHash,TRACER]};
  const trace = await rpc.call(traceRequest.method,traceRequest.params);
  validateRootTrace(trace, request);
  const traceFailed = Boolean(trace.error || trace.revertReason);
  if ((receipt.status === '0x0') !== traceFailed || !sameQuantity(receipt.gasUsed, trace.gasUsed)) {
    throw new RpcError('The historical trace disagrees with the receipt status or gas usage.', 'TRACE_RECEIPT_MISMATCH');
  }
  // debug_traceTransaction accepts a transaction hash, not a block identity.
  // Recheck the receipt so a reorganization during tracing is not presented as
  // a trace proven to belong to the earlier block. Raw responses stay intact.
  const confirmedReceipt = await rpc.call('eth_getTransactionReceipt', [transactionHash]);
  try { validateConfirmedTransaction(tx, confirmedReceipt, transactionHash); }
  catch { throw new RpcError('The transaction receipt changed during historical tracing.', 'TRANSACTION_CHANGED'); }
  if (confirmedReceipt.status !== receipt.status || !sameQuantity(confirmedReceipt.gasUsed, receipt.gasUsed)) {
    throw new RpcError('The transaction receipt changed during historical tracing.', 'TRANSACTION_CHANGED');
  }
  const analysis = analyzeTrace({request,trace,block,metadata:METADATA,mode:'historical_trace'});
  const permissions = analyzePermissions({request,trace,metadata:METADATA});
  includePermissionCoverage(analysis,permissions);
  return {
    schemaVersion:'1.0',implementation,id:randomUUID(),createdAt:new Date().toISOString(),request,
    source:{provider:rpc.provider,chainId:999,blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,mode:'historical_trace',blockBinding:'transaction_hash',transactionHash,transactionIndex:BigInt(tx.transactionIndex).toString()},
    ...analysis,permissions,balanceChanges:{status:'not_applicable',basis:null,assets:[],warnings:['Historical balance measurement requires state at the original transaction position. This replay currently returns execution and event evidence only.']},
    allowanceChanges:{status:'not_applicable',basis:null,allowances:[],warnings:['Historical final allowance measurement requires state at the original transaction position. This replay returns permission observations only.']},
    timing:{totalMs:Math.round(performance.now()-start),rpcMs:Math.round(rpc.rpcMs)},
    evidence:{traceMethod:traceRequest.method,traceRequest,traceResponse:trace,receipt,receiptRechecked:true},
  };
}

export function createAppServer({rpcFactory=()=>new RpcClient(),reportDir=path.join(ROOT,'reports'),persist=true}={}) {
  let inFlight=0;
  return http.createServer(async(req,res)=>{
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return json(res,403,{error:{code:'INVALID_HOST',message:'This service accepts local requests only.'}});
      const url = new URL(req.url,'http://'+host);
      if (req.method==='GET' && STATIC[url.pathname]) {
        const [name,type]=STATIC[url.pathname];
        const data=await readFile(path.join(ROOT,'public',name));
        res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
        return res.end(data);
      }
      if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{status:'ok',version:VERSION,readOnly:true});
      if(req.method==='GET' && url.pathname==='/api/config') return json(res,200,{chains:[{chainId:999,name:'HyperEVM'}],examples:EXAMPLES,capabilities:CAPABILITIES,projectStatus:'Research preview · correctness and coverage under active development'});
      if(req.method==='GET' && url.pathname==='/api/benchmarks') {
        try { return json(res,200,JSON.parse(await readFile(path.join(reportDir,'latest-benchmark.json'),'utf8'))); }
        catch(error) { if(error.code==='ENOENT')return json(res,200,{status:'not_run'}); throw error; }
      }
      if(req.method==='POST' && ['/api/simulate','/api/replay'].includes(url.pathname)) {
        if(req.headers.origin && req.headers.origin!=='http://'+host) return json(res,403,{error:{code:'ORIGIN_NOT_ALLOWED',message:'Cross-origin requests are not accepted.'}});
        const input=await readJson(req);
        if(inFlight>=2)return json(res,429,{error:{code:'BUSY',message:'Two simulations are already running. Try again shortly.'}});
        // Validate before constructing a provider client or making any network request.
        if(url.pathname==='/api/simulate')validateSimulation(input);else validateReplay(input);
        inFlight++;
        try {
          const report=await (url.pathname==='/api/simulate'?simulate(input,rpcFactory()):replay(input,rpcFactory()));
          if(persist){try{await persistReport(report,reportDir);}catch{report.warnings=[...(report.warnings||[]),'The local report could not be saved. Download this response to preserve it.'];}}
          return json(res,200,report);
        }finally{inFlight--;}
      }
      return json(res,404,{error:{code:'NOT_FOUND',message:'Endpoint not found.'}});
    }catch(error){
      if(error instanceof InputError)return json(res,400,{error:{code:error.code,message:error.message}});
      if(error instanceof RpcError)return json(res,502,{error:{code:error.code,message:error.message,detail:error.detail}});
      console.error('Request failed:',error?.name,error?.message);
      return json(res,500,{error:{code:'INTERNAL_ERROR',message:'The request could not be completed.'}});
    }
  });
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 5174);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be an integer from 1024 to 65535.');
  const server=createAppServer();
  server.requestTimeout=30000;
  server.headersTimeout=10000;
  server.listen(port,'127.0.0.1',()=>console.log(`Transaction Lab: http://127.0.0.1:${port}`));
}
