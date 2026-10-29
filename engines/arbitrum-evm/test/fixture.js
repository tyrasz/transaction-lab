import fs from 'node:fs';
import assert from 'node:assert/strict';
import { decodeFunctionData,encodeAbiParameters } from 'viem';
import { createHash } from 'node:crypto';
import { clone,hex,ZERO } from '../common.js';
import { STATIC_ABI,TRANSFER } from '../policy.js';
const root=new URL('./fixtures/retained-revert/',import.meta.url);
export const scenario=JSON.parse(fs.readFileSync(new URL('scenario.json',root)));
export const header=JSON.parse(fs.readFileSync(new URL('selected-header.json',root)));
export const TOKEN='0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
export function response(q,result){return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}),{headers:{'content-type':'application/json'}});}
export function recordedFetch(){const files=fs.readdirSync(root).filter(n=>n.endsWith('-request.json'));const records=files.map(n=>({q:JSON.parse(fs.readFileSync(new URL(n,root))),raw:JSON.parse(fs.readFileSync(new URL(n.replace('-request.json','-response.body'),root)))}));const calls=[];return {calls,fetch:async(_url,init)=>{const q=JSON.parse(init.body);calls.push(q);const hit=records.find(r=>r.q.method===q.method&&JSON.stringify(r.q.params)===JSON.stringify(q.params));assert.ok(hit,'Unexpected request '+q.method+' '+JSON.stringify(q.params));return new Response(JSON.stringify({...hit.raw,id:q.id}),{headers:{'content-type':'application/json'}});}};}
export function syntheticFetch({mutate,pre='100000000',post='0',revert=false,metadataFails=false}={}){
 const calls=[];let simulations=0,headerReads=0;
 const hash=s=>'0x'+createHash('sha256').update(s).digest('hex');
 const resultCall=(data='0x',logs=[],status='0x1')=>({status,returnData:data,gasUsed:'0x5208',logs,...(status==='0x0'?{error:{code:3,message:'execution reverted',data:'0x'}}:{})});
 const logs=[{address:TOKEN,topics:[TRANSFER,word(BigInt(scenario.from)),word(0)],data:word(100000000)}];
 return {calls,fetch:async(_url,init)=>{const q=JSON.parse(init.body);calls.push(q);let value;
  if(q.method==='eth_chainId')value='0xa4b1';
  else if(q.method==='eth_getBlockByNumber'){value=clone(header);headerReads++;}
  else if(q.method==='eth_getBalance')value='0x100000';
  else if(q.method==='eth_getCode')value='0xef0100'+'1'.repeat(40);
  else if(q.method==='eth_call')value=q.params[0].to===undefined?word(1000000):pre===null?'0x':word(pre);
  else if(q.method==='eth_simulateV1'){
   const pass=++simulations;let parent=header.hash;
   value=q.params[0].blockStateCalls.map((b,i)=>{const block={...clone(header),number:hex(BigInt(header.number)+1n+BigInt(i)),timestamp:hex(BigInt(header.timestamp)+1n+BigInt(i)),parentHash:parent,hash:hash('pass'+pass+'block'+i)};parent=block.hash;
    block.calls=b.calls.map((c,j)=>{
     if(i===0&&j===0)return resultCall('0x',revert?[]:logs,revert?'0x0':'0x1');
     if(i===0)return resultCall();if(i===1)return resultCall(word(1000000));
     const {args}=decodeFunctionData({abi:STATIC_ABI,data:c.data});const token=args[0].toLowerCase();
     if(i===2)return token===TOKEN?resultCall(word(post)):resultCall('0x',[],'0x0');
     if(metadataFails)return resultCall('0x',[],'0x0');
     if(i===3)return resultCall(word(6));if(i===4)return resultCall('0x',[],'0x0');return resultCall(encodeAbiParameters([{type:'string'}],['<img src=x onerror=alert(1)>']));
    });return block;});
  }else throw new Error('Unexpected method '+q.method);
  if(mutate)value=mutate({q,value,simulations,headerReads})??value;
  return response(q,value);
 }};
}
