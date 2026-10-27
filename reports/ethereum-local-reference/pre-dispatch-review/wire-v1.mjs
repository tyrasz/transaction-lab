import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
export const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};

// Public endpoints only. Retain exact observed prefixes even on RPC/HTTP
// failure; abort/race every await, and never accept or mutate a late result.
export async function captureHttp({url,body,deadline,requestMs,responseBytes,shared,fetchImpl=fetch}){
  const began=performance.now(),requestText=JSON.stringify(body),record={url,requestText,requestSha256:sha(requestText),requestBytes:Buffer.byteLength(requestText),startedAt:new Date().toISOString()};
  const chunks=[],digest=createHash('sha256'),controller=new AbortController();let reader,timer,observed=0,kept=0,complete=false,settled=false;
  const expires=Math.min(deadline,began+requestMs),check=()=>{if(settled||performance.now()>=expires)fail('deadline');};
  try{
    check();if(shared.bytes>=shared.maxBytes)fail('shared_byte_budget');
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('deadline'),{code:'deadline'}));},Math.max(1,expires-performance.now()));});
    const fetching=Promise.resolve(fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:requestText,redirect:'error',signal:controller.signal}));
    fetching.then(r=>{if(settled||controller.signal.aborted){try{Promise.resolve(r.body?.cancel()).catch(()=>{});}catch{}}}).catch(()=>{});
    const response=await Promise.race([fetching,timeout]);check();record.httpStatus=response.status;record.headers=Object.fromEntries(response.headers);reader=response.body?.getReader();if(!reader)fail('missing_body');
    for(;;){const part=await Promise.race([reader.read(),timeout]);check();if(part.done){complete=true;break;}
      const bytes=Buffer.from(part.value),room=Math.max(0,Math.min(responseBytes-kept,shared.maxBytes-shared.bytes));digest.update(bytes);observed+=bytes.length;shared.bytes+=bytes.length;
      const retained=bytes.subarray(0,room);chunks.push(retained);kept+=retained.length;if(retained.length!==bytes.length)fail('response_byte_budget');
    }
    const raw=Buffer.concat(chunks);record.responseSha256=sha(raw);record.responseText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);check();
    if(!response.ok)fail('http_error');
    record.parsed=JSON.parse(record.responseText);check();record.status='completed';
  }catch(error){record.status='failed';record.error=['deadline','shared_byte_budget','response_byte_budget','missing_body','http_error'].includes(error?.code)?error.code:'transport_or_encoding_error';}
  finally{settled=true;clearTimeout(timer);controller.abort();try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}
    const raw=Buffer.concat(chunks);record.rawBase64=raw.toString('base64');record.transport={complete:complete&&observed===kept,observedBytes:observed,retainedBytes:kept,observedSha256:digest.digest('hex'),retainedSha256:sha(raw),durationMs:performance.now()-began};}
  return record;
}

export function proofTransport({provider,header,shared,deadline,save}){
  const records=[];
  return {records,async call(method,params){
    if(!['eth_getProof','eth_getCode'].includes(method))fail('method_not_allowed');
    if(records.length>=64||performance.now()>=deadline||shared.bytes>=shared.maxBytes)fail('attempt_budget');
    if(JSON.stringify(params.at(-1))!==JSON.stringify({blockHash:header.hash,requireCanonical:true}))fail('state_binding');
    const id=records.length+1,request={jsonrpc:'2.0',id,method,params:structuredClone(params)};
    const record=await captureHttp({url:provider.url,body:request,deadline,requestMs:25000,responseBytes:8*1024*1024,shared});record.id=id;record.request=request;
    const p=record.parsed;
    if(record.status==='completed'&&(!p||typeof p!=='object'||Array.isArray(p)||p.jsonrpc!=='2.0'||p.id!==id||Object.hasOwn(p,'result')===Object.hasOwn(p,'error'))){record.status='failed';record.error='jsonrpc_envelope';}
    if(record.status==='completed'&&Object.hasOwn(p,'error')){record.status='failed';record.error='rpc_error';}
    records.push(record);await save(record);
    if(record.status!=='completed')fail(record.error);return structuredClone(p.result);
  }};
}
