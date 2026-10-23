import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, normalizeBlock } from '../src/rpc.js';

test('write and signing methods never reach the RPC transport',async()=>{
  let calls=0;
  const rpc=new RpcClient({fetchImpl:async()=>{calls++;throw new Error('unexpected');}});
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','eth_sign','debug_setHead']) {
    await assert.rejects(rpc.call(method),{code:'METHOD_NOT_ALLOWED'});
  }
  assert.equal(calls,0);
});
test('rejects a provider on the wrong chain',async()=>{
  const rpc=new RpcClient({fetchImpl:async(url,init)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:'0x1'}))});
  await assert.rejects(rpc.verifyChain(),{code:'RPC_CHAIN_MISMATCH'});
});
test('preserves provider execution errors separately from transport failures',async()=>{
  const rpc=new RpcClient({fetchImpl:async(url,init)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,error:{code:-32000,message:'historical state unavailable'}}))});
  await assert.rejects(rpc.call('debug_traceCall',[]),{code:'RPC_EXECUTION_ERROR',message:'The tracing provider does not have the requested historical state.'});
});
test('rejects wrong response identifiers rather than using unrelated state',async()=>{
  const rpc=new RpcClient({fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:123,result:'0x3e7'}))});
  await assert.rejects(rpc.verifyChain(),{code:'RPC_INVALID_RESPONSE'});
});
test('normalizes block numbers as exact integers',()=>{
  assert.deepEqual(normalizeBlock({hash:'0x'+'ab'.repeat(32),number:'0x20000000000001',timestamp:'0x10'}),{hash:'0x'+'ab'.repeat(32),number:'9007199254740993',timestamp:'16'});
  assert.throws(()=>normalizeBlock(null),{code:'BLOCK_UNAVAILABLE'});
});

test('provider errors never expose credential-bearing messages or nested response data',async()=>{
  const secret='sample-private-provider-key';
  const rpc=new RpcClient({url:`https://rpc.example.test/v1/${secret}?api_key=${secret}`,fetchImpl:async(url,init)=>new Response(JSON.stringify({
    jsonrpc:'2.0',id:JSON.parse(init.body).id,error:{code:-32000,message:`Rejected ${url}`,data:{requestHeaders:{Authorization:`Bearer ${secret}`},response:'0xdeadbeef'}},
  }))});
  await assert.rejects(rpc.call('debug_traceCall',[]),error=>{
    assert.equal(error.code,'RPC_EXECUTION_ERROR');
    assert.deepEqual(error.detail,{rpcCode:-32000});
    assert.doesNotMatch(JSON.stringify({message:error.message,detail:error.detail}),new RegExp(`${secret}|Authorization|rpc\\.example`));
    return true;
  });
});

test('malformed JSON envelopes and invalid URL errors stay bounded and credential-free',async()=>{
  for(const payload of [null,[],{jsonrpc:'2.0',id:1}]) {
    const rpc=new RpcClient({fetchImpl:async()=>new Response(JSON.stringify(payload))});
    await assert.rejects(rpc.call('eth_chainId'),{code:'RPC_INVALID_RESPONSE'});
  }
  assert.throws(()=>new RpcClient({url:'not-a-url-private-key'}),error=>{
    assert.equal(error.code,'INVALID_RPC_URL');
    assert.doesNotMatch(error.message,/private-key/);
    return true;
  });
});

test('historical call-many is a permitted read method while destructive debug methods remain blocked',async()=>{
  const requests=[];
  const rpc=new RpcClient({fetchImpl:async(url,init)=>{
    const request=JSON.parse(init.body);requests.push(request);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:[[{type:'CALL',output:'0x'}]]}));
  }});
  const params=[[{transactions:[{from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),data:'0x'}]}],{blockNumber:{blockHash:'0x'+'a'.repeat(64),requireCanonical:true},transactionIndex:0},{tracer:'callTracer'}];
  assert.deepEqual(await rpc.call('debug_traceCallMany',params),[[{type:'CALL',output:'0x'}]]);
  assert.deepEqual(requests[0].params,params);
  for(const method of ['debug_setHead','debug_clearTxpool','miner_start','engine_newPayloadV3'])await assert.rejects(rpc.call(method,[]),{code:'METHOD_NOT_ALLOWED'});
  assert.equal(requests.length,1);
});

test('nested RPC error envelopes are sanitized before any successful result can be captured',async()=>{
  const secret='REVIEW_ONLY_PROVIDER_CREDENTIAL';
  const frame={type:'CALL',from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),input:'0x',output:'0x',gasUsed:'0x5208'};
  const error={code:-32603,message:`Upstream https://rpc.invalid/${secret} rejected request`,data:{requestUrl:secret}};
  for(const [method,result] of [
    ['debug_traceCallMany',[[{error}]]],
    ['debug_traceCallMany',[[{error:secret}]]],
    ['debug_traceCall',{error}],
    ['debug_traceTransaction',{...frame,calls:[{...frame,error}]}],
    ['eth_getBlockByHash',{error}],
  ]) {
    const rpc=new RpcClient({fetchImpl:async(url,init)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result}))});
    await assert.rejects(rpc.call(method,[]),failure=>{
      assert.equal(failure.code,'RPC_EXECUTION_ERROR');
      assert.ok(failure.detail.rpcCode===-32603 || failure.detail.rpcCode===null);
      assert.doesNotMatch(JSON.stringify({message:failure.message,detail:failure.detail}),new RegExp(`${secret}|requestUrl|rpc\\.invalid`));
      return true;
    });
  }
});

test('valid EVM reverts and their raw output remain unchanged by the RPC envelope guard',async()=>{
  const frame={type:'CALL',from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),input:'0x',output:'0xdeadbeef',gasUsed:'0x5208',error:'execution reverted',revertReason:'Contract-defined public reason'};
  for(const [method,result] of [['debug_traceCall',frame],['debug_traceTransaction',{...frame,error:undefined,calls:[frame]}],['debug_traceCallMany',[[frame]]]]) {
    const serialized=JSON.parse(JSON.stringify(result));
    const rpc=new RpcClient({fetchImpl:async(url,init)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result}))});
    assert.deepEqual(await rpc.call(method,[]),serialized);
  }
});
