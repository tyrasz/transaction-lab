// Synthetic development controls. Signed full-VM references share EthereumJS
// opcode/crypto dependencies; product deltas are also applied to a third MPT.
import test from 'node:test';
import assert from 'node:assert/strict';
import {executeEthereumCall} from '../ethereum-call.js';
import {executeIsolatedEthereumCall,executeIsolatedEthereumPreview} from '../isolated-call.js';
import {amsterdamDelegatedSenderFixture as fixture,compareAmsterdamFullVM,compareDelegatedQuery,assertDelegated,
  TX_SENDER,TARGET,DELEGATE,RECIPIENT,ABSENT,GETTER,HELPER,COINBASE,DESIGNATION,RETURN42,REVERT,
  account,code,slot,word,native,scalarQuery,initcode,factoryCode,createdAddress,callBytes,reentrantCreation} from './amsterdam-delegated-sender-fixture.js';
const initialBalance=1000000000000n;
async function run(f,{status='success'}={}){
  const output=await executeEthereumCall({request:f.request,header:f.header,chainId:11155111,stateManager:f.stateManager,blockchain:f.inputs.blockchain});
  assert.equal(output.execution.status,status,JSON.stringify(output.execution));assertDelegated(output);const changes=f.stateManager.snapshotChanges();
  const reference=await compareAmsterdamFullVM(f,output,changes);
  const isolated=await executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc});
  assert.equal(isolated.status,'completed',JSON.stringify(isolated.error));assert.equal(isolated.isolation.processClosed,true);assert.equal(isolated.broker.pendingAtReturn,0);
  assert.deepEqual(isolated.changes,changes);assert.deepEqual(isolated.output.execution,output.execution);assert.deepEqual(isolated.output.trace,output.trace);assert.deepEqual(isolated.output.gasAccounting,output.gasAccounting);assertDelegated(isolated.output);
  return{output,changes,reference,isolated};
}
const gasCharge=o=>BigInt(o.feeAccounting?.gasCharge??'0');
const unchanged=(changes,address)=>assert.equal(changes.accounts.some(r=>r.address===address),false);
const ledger=frame=>{assert(Array.isArray(frame.creationAttempts));return frame.creationAttempts;};

test('existing delegation permits priced/unpriced transfer to existing and absent recipients without executing its implementation',async()=>{
  for(const priced of[false,true])for(const to of[RECIPIENT,ABSENT]){
    const f=await fixture({priced,to,value:'7',delegateCode:'0x602a600055fe'}),{output,changes}=await run(f);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-7n-gasCharge(output));
    assert.equal((await account(f.stateManager,to)).balance,to===RECIPIENT?10n:7n);assert.equal(await code(f.stateManager,TX_SENDER),DESIGNATION);assert.equal(await slot(f.stateManager,TX_SENDER,0),0n);
    assert.equal(f.calls.some(c=>c.params[0]===DELEGATE),false);unchanged(changes,DELEGATE);assert.equal(output.trace.calls.length,0);assert.equal(output.logs.length,1);
  }
});

test('self-call retains sender ADDRESS/caller/origin, value and storage context with exact fee/gas settlement',async()=>{
  for(const priced of[false,true]){
    const body='0x3060005233602052326040523460605273'+DELEGATE.slice(2)+'31608052602a60005560a06000f3';
    const f=await fixture({priced,delegateCode:body,value:'7'}),{output,changes}=await run(f);
    const words=output.execution.returnData.slice(2).match(/.{64}/g).map(v=>BigInt('0x'+v));assert.deepEqual(words,[BigInt(TX_SENDER),BigInt(TX_SENDER),BigInt(TX_SENDER),7n,9n]);
    assert.equal(output.trace.executionAddress,TX_SENDER);assert.equal(output.trace.caller,TX_SENDER);assert.equal(await slot(f.stateManager,TX_SENDER,0),42n);assert.equal(await slot(f.stateManager,DELEGATE,0),0n);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output));unchanged(changes,DELEGATE);
  }
});

test('top-level delegation access charges cold/warm gas and preserves preparation-OOG nonce and fees',async()=>{
  for(const [gas,accessList,status,paid,message]of[
    ['14999',undefined,'failed','14999','2999'],
    ['100000',undefined,'success','15000','3000'],
    ['100000',[{address:DELEGATE,storageKeys:[]}],'success','16280','100'],
  ]){
    const f=await fixture({gas,...(accessList?{accessList}:{})}),{output}=await run(f,{status});
    assert.equal(output.gasAccounting.gasUsed,paid);assert.equal(output.execution.executionGasUsed,message);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output));
    assert.equal(await code(f.stateManager,TX_SENDER),DESIGNATION);assert.equal(output.trace.calls.length,0);assert.equal(output.logs.length,0);
    if(status==='failed')assert.equal(output.execution.error,'out of gas');
  }
});

test('a nonself recipient does not implicitly warm the sender implementation',async()=>{
  const amounts=[];
  for(const warm of[false,true]){
    const f=await fixture({to:TARGET,target:{nonce:1n,code:'0x73'+DELEGATE.slice(2)+'3160005260206000f3'},...(warm?{accessList:[{address:DELEGATE,storageKeys:[]}]}:{})}),{output}=await run(f);
    assert.equal(output.execution.returnData,word(9));assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);amounts.push(BigInt(output.execution.executionGasUsed));
  }
  assert.equal(amounts[0]-amounts[1],2900n,'Only the explicit access list warms the unrelated implementation');
});

test('nested callbacks resolve sender delegation and roll back reverted sender storage only',async()=>{
  for(const reverted of[false,true]){
    const f=await fixture({to:TARGET,delegateCode:'0x602a600055'+(reverted?REVERT:RETURN42),target:{nonce:1n,code:'0x'+callBytes(TX_SENDER)+'00'}}),{output,changes}=await run(f);
    const callback=output.trace.calls[0];assert.equal(callback.executionAddress,TX_SENDER);assert.equal(callback.caller,TARGET);assert.equal(callback.error,reverted?'revert':null);assert.equal(await slot(f.stateManager,TX_SENDER,0),reverted?0n:42n);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);unchanged(changes,DELEGATE);
  }
});

test('CREATE uses post-outer sender nonce two and initial collision still increments it without an entered constructor',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TX_SENDER,nonce:2n,init});
  for(const collision of[false,true]){
    const f=await fixture({delegateCode:factoryCode(init,{value:5}),accounts:collision?{[target]:{nonce:3n,balance:17n}}:{}}),{output}=await run(f);
    const a=ledger(output.trace);assert.equal(a.length,1);assert.equal(a[0].nonceBefore,'0x2');assert.equal(a[0].nonceAfter,'0x3');assert.equal(a[0].target,target);assert.equal(a[0].disposition,collision?'collision':'entered');assert.equal(output.trace.calls.length,collision?0:1);
    assert.equal((await account(f.stateManager,TX_SENDER)).nonce,3n);assert.equal((await account(f.stateManager,target)).balance,collision?17n:5n);assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output)-(collision?0n:5n));
  }
});

test('repeated CREATE2 by the outer sender counts success plus collision and transfers endowment once',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TX_SENDER,kind:'CREATE2',init});
  for(const priced of[false,true]){
    const f=await fixture({priced,delegateCode:factoryCode(init,{kind:'CREATE2',value:5,repeat:2})}),{output}=await run(f);
    assert.deepEqual(ledger(output.trace).map(a=>[a.position,a.nonceBefore,a.nonceAfter,a.disposition]),[[0,'0x2','0x3','entered'],[1,'0x3','0x4','collision']]);
    assert.equal(output.trace.calls.length,1);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,4n);assert.equal((await account(f.stateManager,target)).balance,5n);assert.equal(await code(f.stateManager,target),'0x00');assert.equal(output.logs.length,1);
    assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output)-5n);
  }
});

test('constructor REVERT and INVALID retain sender creation nonce but roll back target funding/storage/code',async()=>{
  for(const init of['600160005560006000fd','fe']){
    const target=createdAddress({creator:TX_SENDER,nonce:2n,init}),f=await fixture({delegateCode:factoryCode(init,{value:5,tail:'5000'})}),{output,changes}=await run(f);
    assert.equal(output.trace.calls[0].error,init==='fe'?'invalid opcode':'revert');assert.equal(ledger(output.trace)[0].result,'0x0');assert.equal((await account(f.stateManager,TX_SENDER)).nonce,3n);assert.equal(await account(f.stateManager,target),undefined);unchanged(changes,target);
    assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output));assert.equal(output.logs.length,0);
  }
});

test('root and caught ancestor rollback remove observed sender creation increments while preserving outer nonce and fees',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TX_SENDER,kind:'CREATE2',init}),body=factoryCode(init,{kind:'CREATE2',value:5,repeat:2,tail:'50'+REVERT});
  for(const callback of[false,true]){
    const f=await fixture({delegateCode:body,...(callback?{to:TARGET,target:{nonce:1n,code:'0x'+callBytes(TX_SENDER)+'00'}}:{})}),{output,changes}=await run(f,{status:callback?'success':'reverted'});
    const frame=callback?output.trace.calls[0]:output.trace;assert.equal(frame.error,'revert');assert.equal(ledger(frame).length,2);assert.equal(ledger(frame)[1].disposition,'collision');assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal(await account(f.stateManager,target),undefined);unchanged(changes,target);
    assert.equal((await account(f.stateManager,TX_SENDER)).balance,initialBalance-gasCharge(output));assert.equal(output.logs.length,0);
  }
});

test('reentrant sender creates at chronological nonces two, three and four without double-counting its outer increment',async()=>{
  const init=initcode('00',''),r=reentrantCreation(init,TX_SENDER),f=await fixture({delegateCode:r.body,accounts:{[HELPER]:{nonce:1n,code:r.helper}}}),{output}=await run(f);
  assert.deepEqual(ledger(output.trace).map(a=>[a.position,a.nonceBefore]),[[0,'0x2'],[2,'0x4']]);assert.deepEqual(ledger(output.trace.calls[1].calls[0]).map(a=>a.nonceBefore),['0x3']);
  assert.equal((await account(f.stateManager,TX_SENDER)).nonce,5n);for(const nonce of[2n,3n,4n])assert.equal((await account(f.stateManager,createdAddress({creator:TX_SENDER,nonce,init}))).nonce,1n);
});

test('top-level CREATE from an existing delegated sender derives pre-outer nonce address without running delegation code',async()=>{
  const init=initcode('00',''),target=createdAddress({creator:TX_SENDER,nonce:1n,init}),f=await fixture({to:null,data:'0x'+init,value:'5',delegateCode:'0xfe'}),{output}=await run(f);
  assert.equal(output.trace.type,'CREATE');assert.equal(output.trace.to,target);assert.equal((await account(f.stateManager,TX_SENDER)).nonce,2n);assert.equal((await account(f.stateManager,target)).balance,5n);assert.equal(await code(f.stateManager,TX_SENDER),DESIGNATION);assert.equal(await code(f.stateManager,target),'0x00');assert.equal(f.calls.some(c=>c.params[0]===DELEGATE),false);
});

test('real preview normalizes only fresh query nonce, permits reverted helper creation and rejects surviving mutations',async()=>{
  for(const mode of['neutral','mutating','reverted_mutation']){
    const mutating=mode==='mutating',reverted=mode==='reverted_mutation';
    const f=await fixture({delegateCode:factoryCode(initcode('00',''),{value:5,tail:'5000'}),accounts:{
      [GETTER]:{nonce:1n,code:'0x'+(mutating?callBytes(TX_SENDER):reverted?callBytes(RECIPIENT):'')+RETURN42},
      ...(reverted?{[RECIPIENT]:{nonce:1n,balance:3n,code:'0x'+callBytes(TX_SENDER)+REVERT}}:{}),
    }});
    const q=scalarQuery(GETTER),r=await executeIsolatedEthereumPreview({request:f.request,header:f.header,chainId:11155111,rpc:f.rpc,queries:[native(TX_SENDER),q,native(COINBASE)]});
    assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);const p=r.preview;assert.equal(p.original.output.execution.status,'success');assertDelegated(p.original.output);
    const ref=await compareAmsterdamFullVM(f,p.original.output,p.original.changes);assert.equal(p.original.changes.accounts.find(a=>a.address===TX_SENDER).nonce.after,'0x3');
    assert.deepEqual(p.measurements.map(m=>m.status),['measured',mutating?'unavailable':'measured','measured']);assert.equal(p.status,mutating?'partial':'complete');
    const sender=p.measurements[0].values[0],miner=p.measurements[2].values[0];assert.equal(sender.beforeRaw,initialBalance.toString());assert.equal(sender.afterRaw,(await account(ref.state,TX_SENDER)).balance.toString());assert.equal(miner.afterRaw,(await account(ref.state,COINBASE)).balance.toString());assert.equal(sender.deltaRaw,(-gasCharge(p.original.output)-5n).toString());
    const m=p.measurements[1];if(mutating){assert.equal(m.values,null);assert.equal(m.after,null);assert.equal(m.before.output.execution.status,'success');assert.equal(m.before.output.trace.calls[0].creationAttempts.length,1);}
    else{assert.deepEqual(m.values.map(v=>[v.beforeRaw,v.afterRaw,v.deltaRaw]),[['42','42','0']]);for(const side of[m.before,m.after]){assert.equal(side.mutationValidation.status,'verified');assertDelegated(side.output);assert.equal(side.output.feeAccounting,undefined);if(reverted){assert.equal(side.output.trace.calls[0].error,'revert');assert.equal(side.output.trace.calls[0].calls[0].creationAttempts.length,1);}}await compareDelegatedQuery(f,m.before,q);await compareDelegatedQuery(f,m.after,q,{state:ref.state});}
    assert.deepEqual(p.measurements[2].after.changesBefore,p.original.changes);
  }
});
