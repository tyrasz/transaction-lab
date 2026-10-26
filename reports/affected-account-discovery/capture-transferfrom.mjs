import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {RpcClient,RpcError} from '../../src/rpc.js';
const endpoint='https://hyperliquid.drpc.org';
const candidates=[['direct-transferfrom-a','0xe2f9761a3fac3ba83ee15fc5e6f12b55d15cd804b321a2cffd9d2c16d6c38dfe'],['direct-transferfrom-b','0xc650c2592cd04133cf7ff88969468c3e454e0b36e989fdb09a943dce283686d1']];
const source='../permission-discovery/search/usdc-permit-filter.html';
const sourceSha256=createHash('sha256').update(await readFile(new URL(source,import.meta.url))).digest('hex');
for(const [name,transactionHash] of candidates){
 const rpc=new RpcClient({url:endpoint}),captures={};
 const call=async(label,method,params=[])=>{const record={request:{jsonrpc:'2.0',id:rpc.nextId,method,params}};captures[label]=record;try{const result=await rpc.call(method,params);record.response={jsonrpc:'2.0',id:record.request.id,result};return result;}catch(error){record.error={code:error instanceof RpcError?error.code:'CAPTURE_FAILED',message:'Public read-only capture failed.',...(Number.isSafeInteger(error?.detail?.rpcCode)?{rpcCode:error.detail.rpcCode}:{})};return null;}};
 const chain=await call('chainId','eth_chainId');
 const tx=await call('transaction','eth_getTransactionByHash',[transactionHash]);
 const receipt=await call('receipt','eth_getTransactionReceipt',[transactionHash]);
 const trace=await call('callTrace','debug_traceTransaction',[transactionHash,{tracer:'callTracer',timeout:'15s',tracerConfig:{withLog:true}}]);
 const diff=await call('prestateDiff','debug_traceTransaction',[transactionHash,{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true}}]);
 const block=tx?await call('block','eth_getBlockByHash',[tx.blockHash,false]):null;
 const canonical=tx?await call('canonicalBlock','eth_getBlockByNumber',[tx.blockNumber,false]):null;
 const at=(b,index)=>b?.transactions?.[Number(BigInt(index))];
 const checks={chain999:chain==='0x3e7',transactionHash:tx?.hash===transactionHash,receiptHash:receipt?.transactionHash===transactionHash,successfulReceipt:receipt?.status==='0x1',blockHash:Boolean(tx&&receipt&&block&&canonical&&new Set([tx.blockHash,receipt.blockHash,block.hash,canonical.hash]).size===1),transactionIndex:Boolean(tx&&receipt&&tx.transactionIndex===receipt.transactionIndex),blockByHashPosition:Boolean(tx&&at(block,tx.transactionIndex)===transactionHash),canonicalBlockPosition:Boolean(tx&&at(canonical,tx.transactionIndex)===transactionHash),traceRootMatches:Boolean(tx&&trace&&trace.type==='CALL'&&trace.from===tx.from&&trace.to===tx.to&&trace.input===tx.input),traceGasMatchesReceipt:Boolean(trace&&receipt&&BigInt(trace.gasUsed)===BigInt(receipt.gasUsed))};
 const result={retrievedAt:new Date().toISOString(),kind:'observed_public_historical_transaction',rpc:endpoint,transactionHash,explorerUrl:'https://hyperevmscan.io/tx/'+transactionHash,source:{artifact:source,sha256:sourceSha256,method:'First two Transfer From rows from the saved bounded USDC explorer page; no new scan.'},checks,captures,limits:{candidateCount:2,maxRequestsPerCandidate:7,retries:0,broadcasts:0}};
 await writeFile(new URL(name+'-evidence.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({name,transactionHash,checks,block:tx?BigInt(tx.blockNumber).toString():null,index:tx?BigInt(tx.transactionIndex).toString():null,rootFrom:tx?.from,rootTo:tx?.to,selector:tx?.input?.slice(0,10),callCount:Object.keys(captures).length}));
}
