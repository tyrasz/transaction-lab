import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createAppServer} from '../../src/server.js';
import {RpcClient,RpcError,assertNoProviderErrorResult} from '../../src/rpc.js';
const directory=fileURLToPath(new URL('./',import.meta.url));
const providers={drpc:'https://hyperliquid.drpc.org',archive:'https://rpc.hyperlend.finance/archive'};
const cases=[
 {id:'hyperlend-usdc-supply',transactionHash:'0x25e076fc67489775131aafd134a1c6de8f974dea434000ba7568cf400df03cd2',providers:['drpc','archive'],source:'../../fixtures/hyperlend-observed-historical-supply.json'},
 {id:'hyperlend-usdc-repay',transactionHash:'0x682c1d2f131715b8d4b04c71cd8e75ef56a107f0bbd992379a44bf426f22102f',providers:['drpc','archive'],source:'../../fixtures/hyperlend-observed-historical-repay.json'},
 {id:'direct-transferfrom-a',transactionHash:'0xe2f9761a3fac3ba83ee15fc5e6f12b55d15cd804b321a2cffd9d2c16d6c38dfe',providers:['drpc'],source:'../affected-account-discovery/direct-transferfrom-a-evidence.json'},
 {id:'direct-transferfrom-b',transactionHash:'0xc650c2592cd04133cf7ff88969468c3e454e0b36e989fdb09a943dce283686d1',providers:['drpc'],source:'../affected-account-discovery/direct-transferfrom-b-evidence.json'},
];
const safeError=error=>({code:error instanceof RpcError?error.code:'CAPTURE_ERROR',message:'The bounded read-only API capture could not be completed.',...(Number.isSafeInteger(error?.detail?.rpcCode)?{rpcCode:error.detail.rpcCode}:{})});
let activeRpc;
const server=createAppServer({persist:false,rpcFactory:()=>activeRpc});
const report={schemaVersion:'1.0',createdAt:new Date().toISOString(),kind:'v0.6_affected_account_permission_development_capture',status:'incomplete',providers,cases:[],summary:{planned:6,attempted:0,http200:0,measuredAllowances:0,unavailableAllowances:0,measuredBalances:0,failed:0,rpcCalls:0},executionTransport:{kind:'ephemeral_local_http',route:'POST /api/replay',persistedApiReports:false,originalServerUntouched:true},limits:{attempts:6,retries:0,alternateTransactions:0,newBalanceQueryScope:false},limitations:['Reviewed development cases, not held-out evaluation, a vendor score or a performance benchmark.','Account effects combine event evidence with separately available measurements; unmeasured token balances remain unmeasured.','Provider failures and unavailable original-position evidence are retained without retry.','Two lending providers may share infrastructure or execution engines.','Only public read-only chain queries are issued; no signing or broadcasting.']};
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const url=`http://127.0.0.1:${server.address().port}/api/replay`;
try{
 for(const item of cases){
  const sourceBytes=await readFile(new URL(item.source,import.meta.url));
  const entry={id:item.id,transactionHash:item.transactionHash,source:{artifact:item.source,sha256:createHash('sha256').update(sourceBytes).digest('hex')},runs:[]};report.cases.push(entry);
  for(const provider of item.providers){
   const rpc=new RpcClient({url:providers[provider]}),call=rpc.call.bind(rpc),records=[];
   rpc.call=async(method,params=[])=>{const start=performance.now(),record={sequence:records.length+1,request:{jsonrpc:'2.0',id:rpc.nextId,method,params:structuredClone(params)}};records.push(record);try{const result=await call(method,params);assertNoProviderErrorResult(method,result);record.response={jsonrpc:'2.0',id:record.request.id,result:structuredClone(result)};return result;}catch(error){record.error=safeError(error);throw error;}finally{record.durationMs=Math.round(performance.now()-start);}};
   activeRpc=rpc;const request={chainId:999,transactionHash:item.transactionHash};
   const run={provider,providerHost:rpc.provider,request,http:{request:{method:'POST',path:'/api/replay',body:structuredClone(request)}},rpcCalls:records};entry.runs.push(run);report.summary.attempted++;const start=performance.now();
   try{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(240000)});
    const body=await response.json();run.http.response={status:response.status,contentType:response.headers.get('content-type')};run.response=body;
    if(response.status===200){report.summary.http200++;if(body.allowanceChanges?.status==='measured')report.summary.measuredAllowances++;if(body.allowanceChanges?.status==='unavailable')report.summary.unavailableAllowances++;if(body.balanceChanges?.status==='measured')report.summary.measuredBalances++;}else report.summary.failed++;
   }catch(error){run.error=safeError(error);report.summary.failed++;}
   run.durationMs=Math.round(performance.now()-start);report.summary.rpcCalls+=records.length;
   console.log(JSON.stringify({id:item.id,provider,httpStatus:run.http.response?.status??null,allowanceStatus:run.response?.allowanceChanges?.status??null,balanceStatus:run.response?.balanceChanges?.status??null,rpcCalls:records.length}));
   report.outputPath=`${directory}/${report.createdAt.replace(/[:.]/g,'-')}-http.json`;
   await mkdir(directory,{recursive:true});await writeFile(report.outputPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  }
 }
 report.status=report.summary.http200===6?'captured':'captured_with_failures';
 await writeFile(report.outputPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:report.status,summary:report.summary,outputPath:report.outputPath}));
 process.exitCode=report.summary.failed?1:0;
}finally{await new Promise(resolve=>server.close(resolve));}
