import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ENDPOINT,LIMITS} from './selection.mjs';
export const errorOf=e=>({name:typeof e?.name==='string'?e.name:'Error',message:String(e?.message??e).slice(0,4096)});
export function transport({save,fetchImpl=fetch,now=()=>performance.now(),wall=()=>Date.now()}){
  const startMono=now(),startWall=wall();let lastMono=startMono,lastWall=startWall,reversed=false,calls=0,total=0,retained=0,pending=0,closed=false,fatal=null;const records=[],denials=[];
  function clock(){const m=now(),w=wall();reversed||=!Number.isFinite(m)||!Number.isFinite(w)||m<lastMono||w<lastWall;lastMono=m;lastWall=w;return Math.max(0,m-startMono,w-startWall);}
  async function bounded(promise,signal){pending++;const tracked=Promise.resolve(promise).finally(()=>pending--);let stop;const abort=new Promise((_,reject)=>{stop=()=>reject(Error('Request deadline/cancellation'));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});try{return await Promise.race([tracked,abort]);}finally{signal.removeEventListener('abort',stop);}}
  return{
    async request(method,params,phase){
      const limit=phase==='final'?LIMITS.totalMs:LIMITS.collectionMs;
      try{assert(['eth_chainId','eth_getBlockByNumber','eth_getLogs','eth_call','eth_getCode'].includes(method));assert(!closed&&!fatal&&!reversed);assert(clock()<limit&&!reversed);assert(calls<(phase==='final'?LIMITS.calls:LIMITS.calls-1));}
      catch(e){denials.push({method,params,phase,error:errorOf(e)});throw Error('Read not dispatched: scope, deadline or budget');}
      const id=calls+1,text=JSON.stringify({jsonrpc:'2.0',id,method,params});assert(Buffer.byteLength(text)<=LIMITS.requestBytes);calls=id;
      const prefix='wire/'+String(id).padStart(3,'0'),request=save(prefix+'-request.json',Buffer.from(text));const begin=clock(),control=new AbortController(),timer=setTimeout(()=>control.abort(),Math.max(1,Math.min(LIMITS.requestMs,limit-begin)));
      const row={id,phase,method,request,status:'unavailable',httpStatus:null,startedAt:new Date(wall()).toISOString(),responseComplete:false,observedBytes:0,response:null,error:null};let reader,value;const chunks=[];let count=0;
      try{
        const response=await bounded(fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:text,redirect:'error',signal:control.signal}),control.signal);
        row.httpStatus=response.status;assert(response.body);reader=response.body.getReader();
        while(true){const part=await bounded(reader.read(),control.signal);if(part.done){row.responseComplete=true;break;}const n=part.value.byteLength;total+=n;row.observedBytes+=n;
          const take=Math.max(0,Math.min(n,LIMITS.responseBytes-count,LIMITS.totalBytes-retained));if(take){const b=Buffer.from(part.value.subarray(0,take));chunks.push(b);count+=b.length;retained+=b.length;}
          if(row.observedBytes>LIMITS.responseBytes||total>LIMITS.totalBytes){fatal='response_byte_budget';throw Error(fatal);}}
        assert(!control.signal.aborted&&clock()-begin<=LIMITS.requestMs&&clock()<limit&&!reversed);
        const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));assert.equal(parsed.jsonrpc,'2.0');assert.equal(parsed.id,id);assert.notEqual(Object.hasOwn(parsed,'result'),Object.hasOwn(parsed,'error'));
        if(!response.ok){row.status='http_error';throw Error('HTTP '+response.status);}if(Object.hasOwn(parsed,'error')){row.status='rpc_error';row.rpcError=parsed.error;throw Error('RPC '+String(parsed.error?.code)+': '+String(parsed.error?.message));}
        row.status='rpc_result';value=parsed.result;
      }catch(e){row.error=errorOf(e);throw e;}finally{
        clearTimeout(timer);control.abort();if(reader){pending++;try{Promise.resolve(reader.cancel()).catch(()=>{}).finally(()=>pending--);}catch{pending--;}}
        row.durationMs=clock()-begin;row.finishedAt=new Date(wall()).toISOString();row.response=save(prefix+'-response.body',Buffer.concat(chunks));save(prefix+'-record.json',row);records.push(row);
      }return value;
    },
    async finish(){closed=true;const end=Math.min(LIMITS.totalMs,clock()+1000);while(pending&&clock()<end)await new Promise(r=>setTimeout(r,5));return this.snapshot();},
    snapshot(){const elapsedMs=clock();return{calls,observedBytes:total,retainedBytes:retained,elapsedMs,wallMs:lastWall-startWall,monotonicMs:lastMono-startMono,withinBounds:!reversed&&elapsedMs<=LIMITS.totalMs,clockReversed:reversed,pendingOperations:pending,fatal,records,denials};}
  };
}
