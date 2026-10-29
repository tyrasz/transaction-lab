import assert from 'node:assert/strict';
const uint=(v,max=Number.MAX_SAFE_INTEGER)=>{assert(Number.isSafeInteger(v)&&v>=0&&v<=max);return v;};
const qty=v=>{assert.equal(typeof v,'string');assert.match(v,/^0x[0-9a-f]+$/i);const n=BigInt(v);assert(n<(1n<<64n));return n;};
const data=(v,n)=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:[0-9a-f]{2})*$/i);if(n!==undefined)assert.equal(v.length,2+n*2);return v.toLowerCase();};
const fields=(v,required,optional=[])=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert(required.every(k=>Object.hasOwn(v,k)));assert(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));};
export function decodeTrace(raw,request){
 assert(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=4194304);const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(text.endsWith('\n'));
 const lines=text.slice(0,-1).split('\n');assert(lines.length<=100000);const events=lines.map(l=>{assert(l.length>0);const o=JSON.parse(l);assert(o&&typeof o==='object'&&!Array.isArray(o));return o;});
 let cursor=0,opcodeCount=0,frameCount=0;
 const frame=depth=>{
  assert(depth<=1025);const entered=events[cursor++];fields(entered,['from','to','gas','value','type'],['input']);
  assert(['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(entered.type));data(entered.from,20);data(entered.to,20);data(entered.input??'0x');const gas=qty(entered.gas);
  if(entered.value!==null){assert.equal(typeof entered.value,'string');assert.match(entered.value,/^0x[0-9a-f]+$/i);assert(BigInt(entered.value)<(1n<<256n));}frameCount++;
  if(depth===1){assert.equal(entered.type,'CALL');assert.equal(data(entered.from,20),request.from);assert.equal(data(entered.to,20),request.to);assert.equal(data(entered.input??'0x'),request.data);assert.equal(typeof entered.value,'string');assert.equal(BigInt(entered.value),BigInt(request.value));let intrinsic=21000n;for(const b of Buffer.from(request.data.slice(2),'hex'))intrinsic+=b===0?4n:16n;assert.equal(gas,BigInt(request.gas)-intrinsic);}
  for(;;){assert(cursor<events.length,'Missing frame exit');const e=events[cursor];
   if(Object.hasOwn(e,'type')){frame(depth+1);continue;}
   cursor++;
   if(Object.hasOwn(e,'output')){fields(e,['output','gasUsed'],['error']);assert.equal(typeof e.output,'string');assert.match(e.output,/^(?:[0-9a-f]{2})*$/i);const used=qty(e.gasUsed);assert(used<=gas);if(e.error!==undefined){assert.equal(typeof e.error,'string');assert(e.error.length>0&&e.error.length<=4096);}return{output:'0x'+e.output.toLowerCase(),gasUsed:String(used),error:e.error??null};}
   fields(e,['pc','op','gas','gasCost','memSize','stack','depth','refund','opName'],['memory','error']);uint(e.pc);uint(e.op,255);qty(e.gas);qty(e.gasCost);uint(e.memSize);uint(e.refund);assert.equal(e.depth,depth);assert.equal(e.stack,null);assert.equal(typeof e.opName,'string');if(e.memory!==undefined)assert.equal((data(e.memory).length-2)/2,e.memSize);if(e.error!==undefined)assert.equal(typeof e.error,'string');opcodeCount++;
  }
 };
 const root=frame(1);assert.equal(cursor,events.length,'Events after root exit');return{...root,opcodeCount,frameCount,records:events.length};
}
export function compare(input,count,expected,result,body,roots){
 assert.equal(body,input.prefixBodies[count-1]);assert.equal(result.receipts.length,count);assert.equal(roots.length,count);assert.deepEqual(result.rejected??[],[]);
 const end=expected.steps[count-1],channels={stateRoot:data(result.stateRoot,32)===end.stateRoot,logsHash:data(result.logsHash,32)===end.logsHash,gas:qty(result.gasUsed)===BigInt(end.cumulativeGasUsed),execution:true,returnData:true};
 for(let i=0;i<count;i++){
  const r=result.receipts[i],e=expected.steps[i],t=roots[i];assert.equal(data(r.transactionHash,32),input.signed[i].hash);assert.equal(qty(r.transactionIndex),BigInt(i));assert.equal(qty(r.type),2n);assert([0n,1n].includes(qty(r.status)));assert(Array.isArray(r.logs));
  channels.gas&&=qty(r.gasUsed)===BigInt(e.gasUsed)&&qty(r.cumulativeGasUsed)===BigInt(e.cumulativeGasUsed)&&BigInt(t.gasUsed)===BigInt(e.execution.executionGasUsed);
  channels.execution&&=(qty(r.status)===1n)===(e.execution.status==='success')&&(t.error===null)===(e.execution.status==='success');channels.returnData&&=t.output===e.execution.returnData;
 }
 return{status:Object.values(channels).every(Boolean)?'matched':'mismatched',channels,reason:null};
}
