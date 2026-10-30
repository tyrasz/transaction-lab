// Regression expectations derive from exact EIP-7702 designation semantics.
// Actual isolated product only: malformed-code references must not reuse the
// same previously buggy EthereumJS resolution as their expected oracle.
import test from 'node:test';import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3.js';
import {executeIsolatedEthereumCall} from '../isolated-call.js';
import {delegationRuntimeFixture as fixture,TX_SENDER,TARGET,DELEGATE,SECOND,ROUTER,RETURN42,EXACT,MALFORMED,word,designation} from './delegation-runtime-fixture.js';
import {amsterdamAuthorizationExecutionFixture,authorization,signedAuthorizationTransaction,AUTHORITY} from './amsterdam-authorization-execution-fixture.js';
import {signAuthorization} from './authorization-fixture.js';
const run=f=>executeIsolatedEthereumCall({request:f.request,header:f.header,chainId:f.chainId??1,rpc:f.rpc});
const row=(r,a)=>r.changes.accounts.find(x=>x.address===a);
const words=data=>data.slice(2).match(/.{64}/g).map(v=>BigInt('0x'+v));
function completed(r,status){assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(r.isolation.processClosed,true);assert.equal(r.broker.pendingAtReturn,0);assert.equal(r.output.execution.status,status,JSON.stringify(r.output.execution));return r.output;}
function feesAndNonce(r){const o=r.output;assert.deepEqual(row(r,TX_SENDER).nonce,{before:'0x1',after:'0x2'});assert.equal(o.feeAccounting.effectiveGasPrice,'10');assert.equal(BigInt(row(r,TX_SENDER).balance.before)-BigInt(row(r,TX_SENDER).balance.after),BigInt(o.feeAccounting.gasCharge)+BigInt(o.trace.value));}
function invalidRoot(r){const o=completed(r,'failed');assert.equal(o.execution.error,'invalid opcode');assert.equal(o.usage.steps,1);assert.equal(o.trace.error,'invalid opcode');assert.equal(o.execution.returnData,'0x');assert.equal(o.feeAccounting.chargedGas,o.feeAccounting.gasLimit);assert.deepEqual(row(r,TX_SENDER).nonce,{before:'0x1',after:'0x2'});assert.equal(BigInt(row(r,TX_SENDER).balance.before)-BigInt(row(r,TX_SENDER).balance.after),BigInt(o.feeAccounting.gasCharge));return o;}

test('malformed root designation lengths are ordinary invalid code with retained fees/nonce and reverted value',async()=>{
 for(const [fork,code]of [...MALFORMED.map(c=>['amsterdam',c]),['prague',MALFORMED[2]]]){
  const f=await fixture({fork,targetCode:code,value:'7'}),r=await run(f);invalidRoot(r);assert.equal(row(r,TARGET),undefined);assert.equal(r.inputs.accounts[TARGET].code,code);
  assert(!f.calls.some(c=>c.params[0]===DELEGATE),'Malformed bytes must not fetch a delegation target');
 }
});

test('all four call types catch malformed-code INVALID with raw context, value rollback and no extra delegation gas',async()=>{
 const cases=[['amsterdam','CALL',MALFORMED[0]],['amsterdam','CALLCODE',MALFORMED[1]],['amsterdam','DELEGATECALL',MALFORMED[2]],['amsterdam','STATICCALL',MALFORMED[2]],['prague','CALL',MALFORMED[2]]];
 for(const [fork,kind,targetCode]of cases){
  const f=await fixture({fork,kind,targetCode}),r=await run(f),o=completed(r,'success');assert.deepEqual(words(o.execution.returnData),[0n,0n,9n]);
  const child=o.trace.calls[0];assert.equal(child.type,kind);assert.equal(child.to,TARGET);assert.equal(child.error,'invalid opcode');assert.equal(child.gasUsed,'0x'+BigInt(['CALL','CALLCODE'].includes(kind)?102300:100000).toString(16));
  assert.equal(child.executionAddress,['CALLCODE','DELEGATECALL'].includes(kind)?ROUTER:TARGET);assert.equal(child.value,kind==='DELEGATECALL'?'0x7':kind==='STATICCALL'?'0x0':'0x5');
  assert.deepEqual(row(r,ROUTER).storage,[{slot:word(0),before:word(0),after:word(42)}]);assert.equal(row(r,TARGET),undefined);assert.equal(BigInt(row(r,ROUTER).balance.after),26n);feesAndNonce(r);
  const control=await run(await fixture({fork,kind,targetCode:'0xfe'}));completed(control,'success');assert.deepEqual(o.gasAccounting,control.output.gasAccounting,'Malformed code must not incur a delegation charge or warm its apparent implementation');
 }
});

test('exact 23-byte delegation resolves once under root and all four call contexts',async()=>{
 for(const fork of ['amsterdam','prague']){const f=await fixture({fork}),r=await run(f);completed(r,'success');assert.equal(r.output.execution.returnData,word(42));assert.equal(r.inputs.accounts[TARGET].code,EXACT);}
 for(const kind of ['CALL','CALLCODE','DELEGATECALL','STATICCALL']){const r=await run(await fixture({kind})),o=completed(r,'success');assert.deepEqual(words(o.execution.returnData),[1n,42n,9n]);assert.equal(o.trace.calls[0].error,null);assert.equal(o.trace.calls[0].executionAddress,['CALLCODE','DELEGATECALL'].includes(kind)?ROUTER:TARGET);}
 const chain=await fixture({delegateCode:designation(SECOND)}),r=await run(chain);invalidRoot(r);assert(!chain.calls.some(c=>c.params[0]===SECOND),'Do not follow a second designation');
});

test('preactivation designation bytes keep their ordinary invalid-opcode behavior',async()=>{
 for(const targetCode of [MALFORMED[0],EXACT]){const f=await fixture({fork:'cancun',targetCode}),r=await run(f);invalidRoot(r);assert(!f.calls.some(c=>c.params[0]===DELEGATE));}
});

test('EXTCODESIZE, EXTCODEHASH and EXTCODECOPY observe exact malformed and valid stored bytes',async()=>{
 const observer='0x73'+TARGET.slice(2)+'3b60005273'+TARGET.slice(2)+'3f60205260206000604073'+TARGET.slice(2)+'3c60606000f3';
 for(const targetCode of [...MALFORMED,EXACT]){const f=await fixture({targetCode,to:ROUTER,accounts:{[ROUTER]:{nonce:1n,code:observer}}}),r=await run(f),o=completed(r,'success');
  const expected=word((targetCode.length-2)/2).slice(2)+Buffer.from(keccak_256(Buffer.from(targetCode.slice(2),'hex'))).toString('hex')+targetCode.slice(2).padEnd(64,'0');assert.equal(o.execution.returnData,'0x'+expected);assert.equal(r.inputs.accounts[TARGET].code,targetCode);assert(!f.calls.some(c=>c.params[0]===DELEGATE));
 }
});

test('missing raw recipient or exact implementation proof/code rolls back fees, nonce and message writes',async()=>{
 for(const [address,method,kind]of [[TARGET,'eth_getProof','CALL'],[DELEGATE,'eth_getProof',null],[DELEGATE,'eth_getCode',null]]){
  const f=await fixture({kind}),call=f.rpc.call;let withheld=false;f.rpc.call=async(m,p,o)=>{if(m===method&&p[0]===address){withheld=true;throw Error('Synthetic missing proof/code');}return call(m,p,o);};
  const r=await run(f),o=completed(r,'unavailable');assert(withheld);assert.equal(o.stateDisposition,'rolled_back');assert.deepEqual(r.changes.accounts,[]);assert.equal(o.feeAccounting,undefined);assert.equal(o.gasAccounting,null);
 }
});

test('Amsterdam authorizations survive malformed recipient INVALID even below the spurious delegation access threshold',async()=>{
 for(const remaining of [100n,5000n]){
  const f=await amsterdamAuthorizationExecutionFixture({targetCode:MALFORMED[2],authorizationList:[authorization()]});
  f.request.gas=(signedAuthorizationTransaction(f).getIntrinsicGas()+44190n+remaining).toString();const r=await run(f),o=completed(r,'failed');
  assert.equal(o.execution.error,'invalid opcode');assert.equal(o.usage.steps,1);assert.equal(o.authorizationProcessing.preparation.phase,'message');assert.equal(o.authorizationProcessing.preparation.retained,true);assert.equal(o.authorizationProcessing.preparation.authorizationGasUsed,'44190');assert.equal(o.authorizationProcessing.preparation.executionStateGasUsed,'35190');
  assert.deepEqual(o.authorizationProcessing.entries,[{index:0,authority:AUTHORITY,status:'applied',reason:null}]);assert.deepEqual(row(r,AUTHORITY).nonce,{before:'0x0',after:'0x1'});assert.deepEqual(row(r,AUTHORITY).code,{before:'0x',after:EXACT});assert.equal(o.feeAccounting.chargedGas,f.request.gas);assert.equal(o.trace.gas,'0x'+remaining.toString(16));assert.equal(row(r,TARGET),undefined);
 }
});

test('historical Prague authorization/refund survives malformed recipient message failure',async()=>{
 const f=await fixture({fork:'prague',targetCode:MALFORMED[2],authorizationList:[signAuthorization()],accounts:{[AUTHORITY]:{nonce:0n,balance:7n,code:'0x'}}}),r=await run(f),o=completed(r,'failed');
 assert.equal(o.execution.error,'invalid opcode');assert.deepEqual(o.authorizationProcessing.entries,[{index:0,authority:AUTHORITY,status:'applied',reason:null}]);assert.equal(o.authorizationProcessing.gasRefundCounter,'12500');assert.deepEqual(row(r,AUTHORITY).code,{before:'0x',after:EXACT});assert.deepEqual(row(r,AUTHORITY).nonce,{before:'0x0',after:'0x1'});assert.equal(o.feeAccounting.chargedGas,(BigInt(f.request.gas)-12500n).toString());
});
