import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {captureHttp} from '../standard-evm/cohort-http.mjs';
export const ENDPOINT='https://eth.drpc.org';
const METHODS=new Set(['eth_chainId','eth_getBlockByHash','eth_getBlockByNumber','eth_getProof','eth_getCode','eth_getTransactionCount','eth_getBalance','debug_traceCall']);
// The API clients keep their own guards. This extra adapter retains exact entity
// bytes and tracks actual native fetch/read/cancel promises after managed timeout.
export function createCapture({kind,save,fetchImpl=fetch,now=()=>performance.now(),wallMs}){
 assert(['local','provider'].includes(kind));const limits={calls:kind==='local'?260:258,bytes:(kind==='local'?32:128)*1024*1024,responseBytes:8*1024*1024,requestMs:25000};
 const budget={bytes:0,maxBytes:limits.bytes},pending=new Set(),controller=new AbortController(),started=now();let calls=0,unaccountedData=false,saveFailed=false,cancelFailed=false,closed=false;
 const track=p=>{p=Promise.resolve(p);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 const usage=()=>({calls,observedBytes:budget.bytes,pending:pending.size,unaccountedData,saveFailed,cancelFailed,closed,limits});
 const cancel=async fn=>{try{return await fn();}catch(e){cancelFailed=true;controller.abort();throw e;}};
 const fetcher=async(url,options)=>{
  assert.equal(new URL(url).href,new URL(ENDPOINT).href);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  assert(!closed&&!unaccountedData&&!saveFailed&&!cancelFailed&&calls<limits.calls&&budget.bytes<budget.maxBytes&&now()-started<wallMs,'Capture closed or exhausted');
  const body=JSON.parse(options.body);assert.equal(JSON.stringify(body),options.body);assert(METHODS.has(body.method));if(kind==='local')assert.notEqual(body.method,'debug_traceCall');
  const bodies=new Set();let captureFinished=false;
  const trackedFetch=async(...args)=>{
   const r=await fetchImpl(...args),nativeBody=r.body;let reader,closing;
   // One actual cancellation per acquired body, even if headers or getReader
   // fail before captureHttp obtains a reader. Late responses close immediately.
   const close=()=>closing??=track(cancel(()=>Promise.resolve().then(()=>reader?reader.cancel():nativeBody.cancel())));
   if(nativeBody){bodies.add(close);if(captureFinished||args[1]?.signal?.aborted)close();}
   try{return{ok:r.ok,status:r.status,headers:r.headers,body:nativeBody?{cancel:close,getReader(){reader=nativeBody.getReader();return{read:()=>reader.read(),cancel:close};}}:null};}
   catch(e){if(nativeBody)close();throw e;}
  };
  const id=++calls;let record;
  try{record=await captureHttp({url:ENDPOINT,body,deadline:started+wallMs,requestMs:limits.requestMs,responseBytes:limits.responseBytes,shared:budget,fetchImpl:trackedFetch,
   signal:AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]),track,onUnaccountedData:()=>{unaccountedData=true;controller.abort();}});}
  finally{captureFinished=true;for(const close of bodies)close();}
  // Parsed/text copies live in the API evidence; wire evidence stores exact raw
  // Base64 once, including bounded prefixes of error/overflow bodies.
  const {parsed,responseText,...wire}=record;
  try{save(`wire/${String(id).padStart(4,'0')}.json`,{id,...wire});}catch(e){saveFailed=true;controller.abort();throw e;}
  if(!record.transport.complete||!Number.isInteger(record.httpStatus))throw Object.assign(new Error('Captured response incomplete'),{code:record.error??'CAPTURE_INCOMPLETE'});
  return new Response(Buffer.from(record.rawBase64,'base64'),{status:record.httpStatus,headers:{'content-type':'application/json'}});
 };
 return{fetch:fetcher,usage,cancel(){closed=true;controller.abort();},async drain(timeoutMs=25000){closed=true;controller.abort();const began=performance.now();let timer;
  try{while(pending.size){const left=timeoutMs-(performance.now()-began);if(left<=0)break;const settled=await Promise.race([Promise.allSettled([...pending]).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),left);})]);clearTimeout(timer);if(!settled)break;}}
  finally{clearTimeout(timer);}return{complete:pending.size===0&&!unaccountedData&&!saveFailed&&!cancelFailed,pending:pending.size,unaccountedData,saveFailed,cancelFailed,durationMs:performance.now()-began,timeoutMs};}};
}
