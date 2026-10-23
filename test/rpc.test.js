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
