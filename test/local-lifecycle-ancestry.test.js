import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLocal } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { lifecycleFixture, factoryCode, initcode, createdAddress, RUNTIME, FACTORY, SENDER, word } from '../engines/local-evm/test/lifecycle-fixture.js';
import { fixture as ancestryFixture, blockhashCode } from '../engines/local-evm/test/ancestry-fixture.js';

// Explicitly synthetic, cryptographically valid inputs; production adapter,
// production transport and the real fixed child execute all EVM work here.
// The getter is ABI-shaped test bytecode, not an attested token contract.
const query={to:FACTORY,data:'0x70a08231'+SENDER.slice(2).padStart(64,'0')};
function getterFactory(kind, tail='50602a60005500') {
 const raw=factoryCode(initcode(),{kind,tail}).slice(2),getter='60005460005260206000f3',target=5+getter.length/2,prefix=`361560${target.toString(16).padStart(2,'0')}57${getter}5b`;
 const adjusted=raw.slice(0,8)+(parseInt(raw.slice(8,12),16)+prefix.length/2).toString(16).padStart(4,'0')+raw.slice(12);
 return '0x'+prefix+adjusted;
}
async function factory(kind,tail) {
 const code=getterFactory(kind,tail);
 return lifecycleFixture({code,accounts:{[FACTORY]:{nonce:7n,balance:1000n,code,storage:{[word(0)]:word(7)}}}});
}
function transport(f,{finalHeader,ancestorHeader}={}) {
 const wire=[];
 const rpc=new ProofRpcClient({url:'https://fixture.invalid',fetchImpl:async(_url,options)=>{
  const request=JSON.parse(options.body);wire.push(request);let result;
  if(request.method==='eth_chainId')result='0x1';
  else if(request.method==='eth_getBlockByNumber')result=finalHeader?finalHeader(f.header):f.header;
  else if(request.method==='eth_getBlockByHash'&&request.params[0]===f.header.hash)result=f.header;
  else {result=await f.rpc.call(request.method,request.params);if(request.method==='eth_getBlockByHash'&&ancestorHeader)result=ancestorHeader(result);}
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 }});
 const input={chainId:1,from:f.request.from,to:f.request.to,data:f.request.data,value:f.request.value,block:f.header.hash,queries:[query]};
 return {rpc,wire,input};
}

for(const kind of ['CREATE','CREATE2'])test(`actual local API retains ${kind} deployment and measured getter across canonical-header validation`,async()=>{
 const f=await factory(kind),{rpc,wire,input}=transport(f),result=await simulateLocal(input,rpc),target=createdAddress({kind});
 assert.equal(result.status,'complete');assert.equal(result.execution.status,'success');assert.equal(result.source.canonicalStatus,'verified');
 assert.equal(result.attempt.isolation.processSeparated,true);assert.equal(result.attempt.broker.pendingAtReturn,0);
 const original=result.attempt.preview.original,created=original.changes.accounts.find(row=>row.address===target);
 assert.deepEqual(created.existence,{before:false,after:true,basis:'internal_contract_creation'});assert.deepEqual(created.code,{before:'0x',after:'0x'+RUNTIME});
 assert.deepEqual(created.storage,[{slot:word(0),before:word(0),after:word(42)}]);assert.deepEqual(original.inputs.accounts[target],{exists:false});
 assert.equal(original.output.trace.calls[0].type,kind);assert.equal(original.output.trace.calls[0].to,target);
 assert.deepEqual(result.measurements[0].values,[{name:'balance',beforeRaw:'7',afterRaw:'42',deltaRaw:'35',unit:{kind:'token_raw_units',scale:null}}]);
 assert.equal(result.measurements[0].identity.account,SENDER);assert.equal(result.measurements[0].identity.token,FACTORY);
 const pair=result.attempt.preview.measurements[0];assert.deepEqual(pair.after.changesBefore,original.changes);assert.equal(pair.after.mutationValidation.status,'verified');
 assert.equal(wire.at(-1).method,'eth_getBlockByNumber');assert.deepEqual(wire.at(-1).params,[f.header.number,false]);assert.equal(rpc.snapshotEvidence().every(row=>row.status==='completed'),true);
});

test('API keeps a genuine parent revert and zero getter delta without retaining the reverted deployment',async()=>{
 const f=await factory('CREATE2','5060006000fd'),{rpc,input}=transport(f),result=await simulateLocal(input,rpc);
 assert.equal(result.status,'complete');assert.equal(result.execution.status,'reverted');assert.equal(result.source.canonicalStatus,'verified');
 assert.deepEqual(result.attempt.preview.original.changes.accounts,[{address:SENDER,nonce:{before:'0x1',after:'0x2'}}]);
 assert.equal(result.measurements[0].values[0].beforeRaw,'7');assert.equal(result.measurements[0].values[0].afterRaw,'7');assert.equal(result.measurements[0].values[0].deltaRaw,'0');
});

test('API and proof transport authenticate two ancestor headers once for original and both query sides',async()=>{
 const f=await ancestryFixture(blockhashCode(3)),{rpc,wire,input}=transport(f),result=await simulateLocal(input,rpc);
 assert.equal(result.status,'complete');assert.equal(result.source.canonicalStatus,'verified');
 const expected=BigInt(f.blocks.at(-4).hash).toString(),value=result.measurements[0].values[0];assert.equal(value.beforeRaw,expected);assert.equal(value.afterRaw,expected);assert.equal(value.deltaRaw,'0');
 const headers=wire.filter(row=>row.method==='eth_getBlockByHash');assert.deepEqual(headers.map(row=>row.params),[[f.header.hash,false],[f.header.parentHash,false],[f.blocks.at(-2).parentHash,false]]);
 assert.equal(result.attempt.preview.inputs.ancestry.headers.length,2);assert.equal(result.attempt.preview.original.inputs.ancestry.headers.length,2);assert.equal(wire.length,9);
 assert.equal(rpc.snapshotEvidence().every(row=>row.status==='completed'),true);assert.equal(wire.at(-1).method,'eth_getBlockByNumber');
});

test('final header mismatch withholds creation and ancestry query values despite completed local work',async()=>{
 for(const f of [await factory('CREATE2'),await ancestryFixture(blockhashCode(2))]){
  const {rpc,input}=transport(f,{finalHeader:header=>({...header,size:'0x'+(BigInt(header.size??'0x0')+1n).toString(16)})}),result=await simulateLocal(input,rpc);
  assert.equal(result.status,'unavailable');assert.equal(result.error.code,'LOCAL_PREVIEW_CANONICAL');assert.equal(result.source.canonicalStatus,'unverified');
  assert.deepEqual(result.measurements,[]);assert.equal(result.attempt.preview,null);assert.equal(result.execution.status,'unavailable');
 }
});

test('hash-contradicting ancestor bytes cannot yield any API measurements or a canonical success',async()=>{
 const f=await ancestryFixture(blockhashCode(2)),{rpc,input}=transport(f,{ancestorHeader:header=>({...header,stateRoot:word(1)})}),result=await simulateLocal(input,rpc);
 assert.equal(result.status,'unavailable');assert.deepEqual(result.measurements,[]);assert.equal(result.attempt.preview,null);assert.equal(result.execution.status,'unavailable');
 assert.equal(result.attempt.error.code,'LOCAL_ISOLATED_ANCESTRY');assert.equal(result.source.canonicalStatus,'unverified');
});
