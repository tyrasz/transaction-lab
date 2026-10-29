import { performance } from 'node:perf_hooks';
import { ENDPOINT,LIMITS,sha,clone,fail } from './common.js';
/** Serial wire broker. Unsettled fetch/body adapters are counted, never treated as cancelled merely because the host stopped awaiting them. */
export function createTransport({policy,fetchImpl=fetch,signal,now=()=>performance.now(),wall=()=>Date.now()}){
  const start=now(),startWall=wall();let last=start,lastWall=startWall,phase='selection',generation=0,sequence=Promise.resolve(),closed=false,hardFailure=null,viemStopped=false,active=null,adapterPending=0,queued=0,nextId=0,observedBytes=0,retainedBytes=0;const evidence=[],denials=[],discarded=[];
  function elapsed(){const n=now(),w=wall();if(!Number.isFinite(n)||!Number.isFinite(w)||n<last||w<lastWall){hardFailure='ARBITRUM_BUDGET';}last=n;lastWall=w;return Math.max(n-start,w-startWall,0);}
  function check(){const ms=elapsed();if(signal?.aborted)fail('ARBITRUM_CANCELLED');if(closed||hardFailure)fail(hardFailure??'ARBITRUM_UNAVAILABLE');if(ms>=LIMITS.overallMs)fail('ARBITRUM_BUDGET');}
  const cancel=()=>{hardFailure='ARBITRUM_CANCELLED';active?.abort();};signal?.addEventListener('abort',cancel,{once:true});
  async function bounded(promise,abortSignal){adapterPending++;const tracked=Promise.resolve(promise).finally(()=>adapterPending--);let listener;const abort=new Promise((_,reject)=>{listener=()=>reject(Object.assign(new Error('Request stopped.'),{arbitrumCode:signal?.aborted?'ARBITRUM_CANCELLED':'ARBITRUM_BUDGET'}));abortSignal.addEventListener('abort',listener,{once:true});if(abortSignal.aborted)listener();});try{return await Promise.race([tracked,abort]);}finally{abortSignal.removeEventListener('abort',listener);}}
  async function perform(method,params,p,g){check();if(g!==generation){discarded.push({method,phase:p});fail('ARBITRUM_UNAVAILABLE');}
    if(p==='viem'&&(viemStopped||elapsed()>=LIMITS.viemDispatchMs||nextId>=LIMITS.calls-LIMITS.finalReserveCalls)){viemStopped=true;fail('ARBITRUM_BUDGET');}
    if(nextId>=LIMITS.calls)fail('ARBITRUM_BUDGET');
    const id=++nextId,request={jsonrpc:'2.0',id,method,params},requestText=JSON.stringify(request);if(Buffer.byteLength(requestText)>LIMITS.requestBytes){hardFailure='ARBITRUM_BUDGET';fail(hardFailure);}
    const controller=new AbortController();active=controller;const begin=now(),deadline=p==='viem'?LIMITS.viemDispatchMs:LIMITS.overallMs;const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(LIMITS.requestMs,deadline-elapsed())));
    const row={id,phase:p,request,requestText,requestSha256:sha(requestText),status:'unavailable',dispatched:false,httpStatus:null,responseComplete:false,responseText:'',responseSha256:null,observedBytes:0,retainedBytes:0,error:null,durationMs:null};const chunks=[];let reader,result;
    try{check();row.dispatched=true;const response=await bounded(fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:requestText,redirect:'error',signal:controller.signal}),controller.signal);row.httpStatus=response.status;if(!response.body)fail('ARBITRUM_UNAVAILABLE');reader=response.body.getReader();
      while(true){const part=await bounded(reader.read(),controller.signal);if(part.done){row.responseComplete=true;break;}row.observedBytes+=part.value.byteLength;observedBytes+=part.value.byteLength;const retain=Math.min(part.value.byteLength,LIMITS.responseBytes-row.retainedBytes,LIMITS.totalBytes-retainedBytes);if(retain>0){const chunk=Buffer.from(part.value.subarray(0,retain));chunks.push(chunk);row.retainedBytes+=chunk.length;retainedBytes+=chunk.length;}if(row.observedBytes>LIMITS.responseBytes||observedBytes>LIMITS.totalBytes){hardFailure='ARBITRUM_BUDGET';fail(hardFailure);}}
      check();if(controller.signal.aborted||now()-begin>LIMITS.requestMs||elapsed()>deadline)fail('ARBITRUM_BUDGET');
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(parsed?.jsonrpc!=='2.0'||parsed.id!==id||Object.hasOwn(parsed,'result')===Object.hasOwn(parsed,'error'))fail('ARBITRUM_EVIDENCE');
      if(!response.ok)fail('ARBITRUM_UNAVAILABLE');
      if(Object.hasOwn(parsed,'error')){row.status='rpc_error';const e=new Error(typeof parsed.error?.message==='string'?parsed.error.message:'Provider error');if(Number.isInteger(parsed.error?.code))e.code=parsed.error.code;if(parsed.error?.data!==undefined)e.data=parsed.error.data;throw e;}
      result=parsed.result;try{policy.observe(method,params,result,id);}catch{hardFailure='ARBITRUM_EVIDENCE';fail(hardFailure);}row.status='rpc_result';
    }catch(e){row.error={code:e?.arbitrumCode??'ARBITRUM_RPC',message:e?.arbitrumCode?'Bounded provider request unavailable.':'Provider request failed.'};if(e?.arbitrumCode==='ARBITRUM_BUDGET'){if(p==='viem')viemStopped=true;else hardFailure='ARBITRUM_BUDGET';}if(e?.arbitrumCode==='ARBITRUM_EVIDENCE')hardFailure='ARBITRUM_EVIDENCE';if(signal?.aborted)hardFailure='ARBITRUM_CANCELLED';throw e;}
    finally{clearTimeout(timer);controller.abort();active=null;if(reader){adapterPending++;try{Promise.resolve(reader.cancel()).catch(()=>{}).finally(()=>adapterPending--);}catch{adapterPending--;}}const bytes=Buffer.concat(chunks);row.responseText=bytes.toString('utf8');row.responseSha256=sha(bytes);if(!Buffer.from(row.responseText).equals(bytes))row.responseBase64=bytes.toString('base64');row.durationMs=Math.max(0,now()-begin);evidence.push(row);}
    return result;
  }
  return {
    request({method,params=[]}){let copy;const p=phase,g=generation;try{check();if(queued>=LIMITS.calls)fail('ARBITRUM_BUDGET');copy=clone(params);policy.validate(method,copy,p);}catch(e){hardFailure=e?.arbitrumCode??'ARBITRUM_EVIDENCE';if(denials.length<LIMITS.calls)denials.push({method,phase:p,code:hardFailure});return Promise.reject(e);}queued++;const work=sequence.then(()=>perform(method,copy,p,g)).finally(()=>queued--);sequence=work.catch(()=>{});return work;},
    setPhase(p){phase=p;generation++;},endPhase(){generation++;active?.abort();},
    async drain(){await sequence;return {complete:adapterPending===0,pendingAdapterOperations:adapterPending};},
    finish(){closed=true;generation++;active?.abort();signal?.removeEventListener('abort',cancel);},
    snapshot(){const ms=elapsed();return clone({calls:evidence.filter(r=>r.dispatched).length,requestAttempts:nextId,observedBytes,retainedBytes,elapsedMs:ms,limits:LIMITS,withinBounds:ms<=LIMITS.overallMs&&!hardFailure,hardFailure,viemStopped,denials,discarded,pendingAdapterOperations:adapterPending,evidence});},
  };
}
