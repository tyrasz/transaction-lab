import assert from 'node:assert/strict';
import { decodeAbiParameters,encodeAbiParameters } from 'viem';
import { ETH,WORD,clone } from './common.js';
import { balanceData,helperData,nativeProbe } from './policy.js';
import { callShape,simulationShape } from './wire-validation.js';
function probeValue(call){return call?.status==='0x1'&&typeof call.returnData==='string'&&WORD.test(call.returnData)?BigInt(call.returnData).toString():null;}
function metadata(blocks,i){let decimals=null,symbol=null;const d=probeValue(blocks[3].calls[i]);if(d!==null&&BigInt(d)<=255n)decimals=Number(d);const call=blocks[5].calls[i];if(call.status==='0x1')try{const params=[{type:'string'}],v=decodeAbiParameters(params,call.returnData)[0];if(typeof v==='string'&&v.length<=128&&encodeAbiParameters(params,[v])===call.returnData)symbol=v;}catch{}return {decimals,symbol,metadataTrust:'untrusted_provider'};}
export function projectObservations({request,policy,evidence}){
  const {selected,discovery,main,assets,scratch}=policy.state;
  assert.ok(selected&&discovery&&main);
  const simulations=evidence.filter(r=>r.request.method==='eth_simulateV1'&&r.status==='rpc_result');assert.equal(simulations.length,2);
  for(const row of simulations){const raw=JSON.parse(row.responseText);assert.equal(raw.id,row.id);simulationShape(raw.result,row.request.params[0].blockStateCalls,selected);}
  assert.deepEqual(callShape(discovery[0].calls[0]),callShape(main[0].calls[0]));
  const original=main[0].calls[0], execution={status:original.status==='0x1'?'success':original.error?.code===3?'reverted':'failed',data:original.error?.data??original.returnData,gasUsed:BigInt(original.gasUsed).toString(),logs:original.logs.map(l=>clone(l)),error:original.error?clone(original.error):null};
  const postId=simulations[1].id;
  const rows=[ETH,...assets].map((address,i)=>{
    const native=i===0,data=native?nativeProbe(request.from):helperData(address,balanceData(request.from));
    const pre=evidence.find(r=>r.request.method==='eth_call'&&r.request.params[0].data===data&&(native?r.request.params[0].to===undefined:r.request.params[0].to===scratch));
    let before=null,reason=null;
    if(pre?.status==='rpc_result'){const raw=JSON.parse(pre.responseText).result;if(typeof raw==='string'&&WORD.test(raw))before=BigInt(raw).toString();else reason=raw==='0x'?'empty_pre_balance_is_not_observed_zero':'invalid_pre_balance';}
    else reason=pre?'failed_pre_balance':'missing_pre_balance';
    const post=main[native?1:2].calls[native?0:i-1],after=probeValue(post);
    if(after===null)reason??=post.status==='0x0'?'failed_post_balance':'invalid_post_balance';
    const measured=before!==null&&after!==null;
    return {owner:request.from,token:{address,...(native?{symbol:'ETH',decimals:18,metadataTrust:'declared_native_asset'}:metadata(main,i-1))},status:measured?'measured':'unverified',beforeRaw:measured?before:null,afterRaw:measured?after:null,deltaRaw:measured?(BigInt(after)-BigInt(before)).toString():null,reason:measured?null:reason,evidence:{preRpcId:pre?.id??null,postRpcId:postId,postBlockIndex:native?1:2,postCallIndex:native?0:i-1}};
  });
  return {execution,assetChanges:rows};
}
