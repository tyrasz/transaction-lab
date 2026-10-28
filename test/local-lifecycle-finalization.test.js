import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLocal, LOCAL_CAPABILITIES } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { lifecycleFixture, createdAddress, FACTORY, SENDER } from '../engines/local-evm/test/lifecycle-fixture.js';

// Actual public adapter/transport/child with synthetic authenticated inputs.
// No public network or provider-derived execution output supplies the state.
test('actual local API exposes constructor deletion and carries it through stable queries', async () => {
  const beneficiary = '0x4444444444444444444444444444444444444444';
  const target = createdAddress({creator:SENDER,nonce:1n});
  const f = await lifecycleFixture({code:'0x602a60005260206000f3',accounts:{[target]:{nonce:0n,balance:17n,code:'0x'}}});
  const rpc = new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);
    const result=request.method==='eth_chainId'?'0x1':['eth_getBlockByHash','eth_getBlockByNumber'].includes(request.method)?f.header:await f.rpc.call(request.method,request.params);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  }});
  const result=await simulateLocal({chainId:1,from:SENDER,to:null,data:'0x73'+beneficiary.slice(2)+'ff',value:'5',block:f.header.hash,queries:[{to:FACTORY,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}]},rpc);
  assert.equal(result.status,'complete');assert.equal(result.execution.status,'success');assert.equal(result.source.canonicalStatus,'verified');
  const original=result.attempt.preview.original;
  assert.equal(original.output.lifecycle.finalizedDeletions[0].address,target);
  assert.deepEqual(original.changes.accounts.find(row=>row.address===target),{address:target,existence:{before:true,after:false,basis:'same_invocation_created_contract_deletion'},balance:{before:'0x11',after:'0x0'}});
  assert.equal(result.measurements[0].status,'measured');assert.equal(result.measurements[0].values[0].deltaRaw,'0');
  assert.deepEqual(result.attempt.preview.measurements[0].after.changesBefore,original.changes);
  assert.equal(LOCAL_CAPABILITIES.selfdestruct,'Cancun_or_later_existing_balance_transfer_and_same_invocation_created_contract_deletion');
  assert(LOCAL_CAPABILITIES.limitations.some(value=>value.includes('Shanghai destruction remains unsupported')));
});

test('actual local API retains authenticated empty-account cleanup even after a root revert', async () => {
  const target='0x0000000000000000000000000000000000000003',getter='0x7777777777777777777777777777777777777777';
  const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
  for(const reverts of [false,true]) {
    const f=await lifecycleFixture({code:'0x6000600060006000600060036001f1'+(reverts?'5060006000fd':'60005260206000f3'),accounts:{
      [target]:{nonce:0n,balance:0n,code:'0x',storage:{[word(0)]:word(42)}},
      [getter]:{nonce:1n,balance:0n,code:'0x602a60005260206000f3'},
    }});
    const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(_url,options)=>{
      const request=JSON.parse(options.body);
      const result=request.method==='eth_chainId'?'0x1':['eth_getBlockByHash','eth_getBlockByNumber'].includes(request.method)?f.header:await f.rpc.call(request.method,request.params);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
    }});
    const result=await simulateLocal({chainId:1,from:SENDER,to:FACTORY,data:'0x',value:'0',block:f.header.hash,queries:[{to:getter,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')}]},rpc);
    assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.execution.status,reverts?'reverted':'success');
    assert.equal(result.source.canonicalStatus,'verified');
    const original=result.attempt.preview.original;
    assert.equal(original.output.lifecycle.emptyAccountCleanup.deletions[0].address,target);
    assert.deepEqual(original.changes.accounts.find(row=>row.address===target),{address:target,existence:{before:true,after:false,basis:'eip161_empty_account_cleanup'}});
    assert.equal(result.measurements[0].status,'measured');assert.equal(result.measurements[0].values[0].deltaRaw,'0');
    assert.deepEqual(result.attempt.preview.measurements[0].after.changesBefore,original.changes);
  }
  assert.equal(LOCAL_CAPABILITIES.emptyAccountCleanup,'EIP161_retained_unsigned_message_touches_including_RIPEMD160_exception');
});
