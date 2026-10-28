// Synthetic research controls only. Expected fixture poststates are never inputs.
import assert from 'node:assert/strict';
import { Common, Mainnet, Hardfork } from '../../engines/fixture-evm/node_modules/@ethereumjs/common/dist/esm/index.js';
import { createBlock } from '../../engines/fixture-evm/node_modules/@ethereumjs/block/dist/esm/index.js';
import { createTx } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { createVM, runTx } from '../../engines/fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { getMerkleStateProof } from '../../engines/fixture-evm/node_modules/@ethereumjs/statemanager/dist/esm/index.js';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex, bigIntToBytes, generateAddress } from '../../engines/fixture-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { loadState } from '../../engines/fixture-evm/state-test.js';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { canonicalStateChanges } from '../../engines/local-evm/preview-mutations.js';
import { validateExecutionChanges } from '../../engines/local-evm/execution-changes.js';

export const FIXED = Object.freeze({ number:22000000, timestamp:1764798551, gas:5000000, productMs:10000, referenceMs:10000, totalMs:360000, calls:256, responseBytes:8*1024*1024, responseTotalBytes:32*1024*1024, outputBytes:16*1024*1024 });
export const quantity=n=>'0x'+BigInt(n).toString(16);
const n=hex=>hex==='0x'?0n:BigInt(hex);
const addr=createAddressFromString;
const word=x=>'0x'+n(x).toString(16).padStart(64,'0');
const common=()=>new Common({chain:Mainnet,hardfork:Hardfork.Osaka});
const h0='0x'+'00'.repeat(32),addressPattern=/^0x[0-9a-f]{40}$/;

export function blockFromHeader(h){
 const block=createBlock({header:{parentHash:h.parentHash,uncleHash:h.sha3Uncles,coinbase:h.miner,stateRoot:h.stateRoot,transactionsTrie:h.transactionsRoot,receiptTrie:h.receiptsRoot,logsBloom:h.logsBloom,difficulty:n(h.difficulty),number:n(h.number),gasLimit:n(h.gasLimit),gasUsed:n(h.gasUsed),timestamp:n(h.timestamp),extraData:h.extraData,mixHash:h.mixHash,nonce:h.nonce,baseFeePerGas:n(h.baseFeePerGas),withdrawalsRoot:h.withdrawalsRoot,blobGasUsed:n(h.blobGasUsed),excessBlobGas:n(h.excessBlobGas),parentBeaconBlockRoot:h.parentBeaconBlockRoot,requestsHash:h.requestsHash},withdrawals:[]},{common:common()});
 assert.equal(bytesToHex(block.hash()),h.hash);return block;
}
function rpcHeader(block){const b=block.header;const h={parentHash:bytesToHex(b.parentHash),sha3Uncles:bytesToHex(b.uncleHash),miner:b.coinbase.toString(),stateRoot:bytesToHex(b.stateRoot),transactionsRoot:bytesToHex(b.transactionsTrie),receiptsRoot:bytesToHex(b.receiptTrie),logsBloom:bytesToHex(b.logsBloom),difficulty:quantity(b.difficulty),number:quantity(b.number),gasLimit:quantity(b.gasLimit),gasUsed:quantity(b.gasUsed),timestamp:quantity(b.timestamp),extraData:bytesToHex(b.extraData),mixHash:bytesToHex(b.mixHash),nonce:bytesToHex(b.nonce),baseFeePerGas:quantity(b.baseFeePerGas),withdrawalsRoot:bytesToHex(b.withdrawalsRoot),blobGasUsed:quantity(b.blobGasUsed),excessBlobGas:quantity(b.excessBlobGas),parentBeaconBlockRoot:bytesToHex(b.parentBeaconBlockRoot),requestsHash:bytesToHex(b.requestsHash),hash:bytesToHex(block.hash())};assert.equal(verifyEthereumHeader({header:h,expectedHash:h.hash}).hardfork,'osaka');return h;}

export async function declareFixture(fixture, identity){
 assert.equal(fixture.config.chainid,'0x01');assert.equal(fixture._info['fixture-format'],'state_test');
 const tx=fixture.transaction,p=fixture.post.Osaka[identity.postIndex];assert(p);assert(!tx.accessLists&&!tx.authorizationList&&!tx.maxFeePerGas);assert.equal(BigInt(tx.chainId),1n);
 const pre=structuredClone(fixture.pre),from=tx.sender.toLowerCase(),initial=pre[Object.keys(pre).find(a=>a.toLowerCase()===from)];assert(initial);assert.equal(n(initial.nonce),n(tx.nonce));
 const oldGas=n(tx.gasLimit[p.indexes.gas]),gas=oldGas>BigInt(FIXED.gas)?BigInt(FIXED.gas):oldGas;
 const state=await loadState(pre,common()),initialStateRoot=bytesToHex(await state.getStateRoot());
 const block=createBlock({header:{parentHash:h0,stateRoot:initialStateRoot,coinbase:fixture.env.currentCoinbase,number:BigInt(FIXED.number),timestamp:BigInt(FIXED.timestamp),gasLimit:n(fixture.env.currentGasLimit),gasUsed:0n,difficulty:0n,baseFeePerGas:0n,mixHash:word(fixture.env.currentRandom),blobGasUsed:0n,excessBlobGas:0n,parentBeaconBlockRoot:h0},withdrawals:[]},{common:common()});
 const header=rpcHeader(block),request={from,to:tx.to?tx.to.toLowerCase():null,data:tx.data[p.indexes.data].toLowerCase(),value:n(tx.value[p.indexes.value]).toString(),gas:gas.toString()};
 const transaction={type:0,chainId:1,from,to:request.to,data:request.data,value:request.value,gasLimit:request.gas,nonce:n(tx.nonce).toString(),gasPrice:'0',secretKey:tx.secretKey.toLowerCase()};
 const signed=makeTransaction(transaction);assert.equal(signed.getSenderAddress().toString(),from);
 return {schemaVersion:1,identity:structuredClone(identity),kind:'synthetic_zero_fee_counterpart_not_official_replay',pre,initialStateRoot,header,request,transaction,serializedTransaction:bytesToHex(signed.serialize()),transformations:{originalGas:oldGas.toString(),syntheticGas:gas.toString(),originalGasPrice:n(tx.gasPrice).toString(),syntheticGasPrice:'0',originalEnvironment:structuredClone(fixture.env),syntheticHeader:header,originalExpectedOutputsUsed:false}};
}
export function makeTransaction(tx){assert.equal(tx.type,0);assert.equal(tx.chainId,1);assert.equal(tx.gasPrice,'0');const value=createTx({type:0,nonce:BigInt(tx.nonce),gasLimit:BigInt(tx.gasLimit),gasPrice:0n,to:tx.to??undefined,value:BigInt(tx.value),data:tx.data},{common:common()}).sign(hexToBytes(tx.secretKey));assert(value.verifySignature());assert.equal(value.getSenderAddress().toString(),tx.from);return value;}
export async function validateDeclaration(d){
 assert.equal(d.kind,'synthetic_zero_fee_counterpart_not_official_replay');assert.equal(d.header.number,quantity(FIXED.number));assert.equal(d.header.timestamp,quantity(FIXED.timestamp));assert.equal(d.header.baseFeePerGas,'0x0');assert(BigInt(d.request.gas)<=BigInt(FIXED.gas));
 assert.deepEqual(d.request,{from:d.transaction.from,to:d.transaction.to,data:d.transaction.data,value:d.transaction.value,gas:d.transaction.gasLimit});
 assert.equal(bytesToHex(makeTransaction(d.transaction).serialize()),d.serializedTransaction);assert.equal(blockFromHeader(d.header).common.hardfork(),'osaka');
 const state=await loadState(d.pre,common());assert.equal(bytesToHex(await state.getStateRoot()),d.initialStateRoot);assert.equal(d.initialStateRoot,d.header.stateRoot);assert.equal((await state.getAccount(addr(d.request.from))).nonce,BigInt(d.transaction.nonce));return state;
}

/** The manager is private and immutable. Only this preallocation supplies facts. */
export async function proofSource(d){
 const state=await validateDeclaration(d),records=[];let byteCount=0,closed=false;const root=d.initialStateRoot;
 return {records,async assertUnchanged(){assert.equal(bytesToHex(await state.getStateRoot()),root);},close(){closed=true;},rpc:{async call(method,params,{signal}={}){
  assert(!closed&&!signal?.aborted);assert(records.length<FIXED.calls);const record={id:records.length+1,request:{method,params:structuredClone(params)},representation:'parsed_in_memory_proof_result_no_network_wire',status:'pending'};records.push(record);try{assert(['eth_getProof','eth_getCode'].includes(method),'Synthetic history is unavailable');assert(Array.isArray(params));assert.equal(params.length,method==='eth_getProof'?3:2);assert.match(params[0],addressPattern);assert.deepEqual(params.at(-1),{blockHash:d.header.hash,requireCanonical:true});
  const address=addr(params[0]);let result;
  if(method==='eth_getCode')result=bytesToHex(await state.getCode(address));else{
   assert(Array.isArray(params[1])&&params[1].length<=1024&&new Set(params[1]).size===params[1].length);params[1].forEach(key=>assert.match(key,/^0x[0-9a-f]{64}$/));
   result=await getMerkleStateProof(state,address,params[1].map(hexToBytes));
   // Remove redundant embedded child nodes; preserve canonical EIP-1186 zeros.
   const minimal=proof=>proof.filter((node,i)=>i===0||node.length>=66);
   result.accountProof=minimal(result.accountProof);
   if(!await state.getAccount(address))result.storageProof=params[1].map(key=>({key,value:'0x0',proof:[]}));
   else result.storageProof=result.storageProof.map(p=>({...p,value:quantity(n(p.value)),proof:minimal(p.proof)}));
  }
  const text=JSON.stringify(result),bytes=Buffer.byteLength(text);assert(bytes<=FIXED.responseBytes);byteCount+=bytes;assert(byteCount<=FIXED.responseTotalBytes);assert(!closed&&!signal?.aborted);Object.assign(record,{status:'received',result:structuredClone(result),bytes});return result;
  }catch(error){record.status='unavailable';record.error='Synthetic fixed-state read rejected or unavailable.';throw error;}
 }}};
}

export async function executeReference(d){
 const state=await validateDeclaration(d),tx=makeTransaction(d.transaction),block=blockFromHeader(d.header);let missingHistory=false;
 const observed=new Map(Object.entries(d.pre).map(([address,a])=>[address.toLowerCase(),new Set(Object.keys(a.storage).map(word))]));let recording=true;
 for(const method of ['getAccount','putAccount','deleteAccount','getCode','putCode','getStorage','putStorage']){const original=state[method].bind(state);state[method]=async(address,...args)=>{if(recording){const key=address.toString();if(!observed.has(key))observed.set(key,new Set());if(method==='getStorage'||method==='putStorage')observed.get(key).add(bytesToHex(args[0]));assert(observed.size<=256);assert([...observed.values()].reduce((n,s)=>n+s.size,0)<=2048);}return original(address,...args);};}
 const blockchain={async getBlock(){missingHistory=true;throw Error('Synthetic ancestry unavailable');},shallowCopy(){return this;}};
 const vm=await createVM({common:common(),stateManager:state,blockchain});const result=await runTx(vm,{tx,block});assert(!missingHistory,'No fabricated BLOCKHASH is allowed');
 recording=false;const observedState=await snapshotState(state,observed);
 const output={execution:result.execResult.exceptionError?.error==='revert'?'reverted':result.execResult.exceptionError?'failed':'success',returnData:bytesToHex(result.execResult.returnValue),logs:result.execResult.logs.map(([a,t,data])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(data)})),gasUsed:result.totalGasSpent.toString(),executionGasUsed:result.execResult.executionGasUsed.toString(),gasRefund:result.gasRefund.toString(),stateRoot:bytesToHex(await state.getStateRoot()),serializedTransaction:bytesToHex(tx.serialize())};
 return {status:'completed',output,observedState,scope:{synthetic:true,fullVmSignedTransaction:true,zeroGasPrice:true,zeroBaseFee:true,fullMptFinalization:true,sharedOpcodeLibrary:true,originalOfficialExpectedPostUsed:false}};
}

async function snapshotState(state,observed){const rows=[];for(const [address,slots]of [...observed].sort(([a],[b])=>a.localeCompare(b))){assert.match(address,addressPattern);const a=addr(address),account=await state.getAccount(a),storage=[];for(const slot of [...slots].sort()){assert.match(slot,/^0x[0-9a-f]{64}$/);storage.push({slot,value:word(bytesToHex(await state.getStorage(a,hexToBytes(slot))))});}rows.push({address,exists:!!account,nonce:(account?.nonce??0n).toString(),balance:(account?.balance??0n).toString(),code:account?bytesToHex(await state.getCode(a)):'0x',storageRoot:account?bytesToHex(account.storageRoot):null,storage});}return rows;}

export async function applyProductChanges(d,attempt,observedState=[]){
 assert.equal(attempt.status,'completed');assert(['success','reverted','failed'].includes(attempt.output.execution.status));
 const o=attempt.output,p=o.profile,t=o.trace;assert.deepEqual(attempt.headerVerification,verifyEthereumHeader({header:d.header,expectedHash:d.header.hash}));
 const input=hexToBytes(d.request.data),zeros=BigInt(input.filter(x=>x===0).length),nonzeros=BigInt(input.length)-zeros,creation=d.request.to===null;
 const intrinsic=21000n+4n*zeros+16n*nonzeros+(creation?32000n+2n*((BigInt(input.length)+31n)/32n):0n),floor=21000n+10n*(zeros+4n*nonzeros),declared=BigInt(d.request.gas);
 assert.equal(p.name,'ethereum_unsigned_unpriced_call');assert.equal(p.chainId,1);assert.equal(p.hardfork,'osaka');assert.equal(p.sourceBlockHash,d.header.hash);assert.equal(p.sourceStateRoot,d.initialStateRoot);assert.equal(p.actualBlockBaseFee,'0');assert.equal(p.executionBaseFee,'0');assert.equal(p.gasPrice,'0');assert.equal(p.declaredGasLimit,d.request.gas);assert.equal(p.intrinsicGas,intrinsic.toString());assert.equal(p.calldataFloor,floor.toString());assert.equal(p.messageGasLimit,(declared-intrinsic).toString());
 assert.equal(t.type,creation?'CREATE':'CALL');assert.equal(t.from,d.request.from);assert.equal(t.caller,d.request.from);assert.equal(t.input,d.request.data);assert.equal(n(t.value),BigInt(d.request.value));assert.equal(n(t.gas),declared-intrinsic);assert.equal(n(t.gasUsed),BigInt(o.execution.executionGasUsed));
 const destination=creation?bytesToHex(generateAddress(hexToBytes(d.request.from),bigIntToBytes(BigInt(d.transaction.nonce)))):d.request.to;assert.equal(t.to,destination);assert.equal(t.executionAddress,destination);
 const beforeRefund=intrinsic+BigInt(o.execution.executionGasUsed),counter=BigInt(o.execution.gasRefundCounter),refund=counter<beforeRefund/5n?counter:beforeRefund/5n,afterRefund=beforeRefund-refund;
 assert.deepEqual(o.gasAccounting,{beforeRefund:beforeRefund.toString(),appliedRefund:refund.toString(),floorAdjustment:(floor>afterRefund?floor-afterRefund:0n).toString(),gasUsed:(floor>afterRefund?floor:afterRefund).toString()});
 validateExecutionChanges({changes:attempt.changes,inputs:attempt.inputs,output:attempt.output,sender:d.request.from,destination:d.request.to});
 const changes=canonicalStateChanges(attempt.changes),state=await validateDeclaration(d),accounts=[];
 for(const row of changes.accounts){
  const address=addr(row.address),prior=await state.getAccount(address),beforeCode=bytesToHex(await state.getCode(address));
  if(row.existence)assert.equal(!!prior,row.existence.before);
  for(const field of ['nonce','balance'])if(row[field])assert.equal(prior?.[field]??0n,n(row[field].before));
  if(row.code)assert.equal(beforeCode,row.code.before);
  for(const s of row.storage??[])assert.equal(n(bytesToHex(await state.getStorage(address,hexToBytes(s.slot)))),n(s.before));
  if(row.existence?.after===false){await state.deleteAccount(address);assert.equal(await state.getAccount(address),undefined);}
  else{
   if(!prior){assert.equal(row.existence?.after,true);await state.putAccount(address,createAccount({nonce:0n,balance:0n}));}
   for(const field of ['nonce','balance'])if(row[field])await state.modifyAccountFields(address,{[field]:n(row[field].after)});
   if(row.code)await state.putCode(address,hexToBytes(row.code.after));
   for(const s of row.storage??[])await state.putStorage(address,hexToBytes(s.slot),bigIntToBytes(n(s.after)));
  }
  const after=await state.getAccount(address);accounts.push({address:row.address,existsBefore:!!prior,existsAfter:!!after,nonceBefore:(prior?.nonce??0n).toString(),nonceAfter:(after?.nonce??0n).toString(),balanceBefore:(prior?.balance??0n).toString(),balanceAfter:(after?.balance??0n).toString(),codeBefore:beforeCode,codeAfter:after?bytesToHex(await state.getCode(address)):'0x',storageRootBefore:prior?bytesToHex(prior.storageRoot):null,storageRootAfter:after?bytesToHex(after.storageRoot):null,storage:row.storage??[]});
 }
 assert(Array.isArray(observedState)&&observedState.length<=256);const observed=new Map();let slots=0;for(const row of observedState){assert(!observed.has(row.address));assert(Array.isArray(row.storage));assert((slots+=row.storage.length)<=2048);const keys=row.storage.map(s=>s.slot);assert.equal(new Set(keys).size,keys.length);observed.set(row.address,new Set(keys));}
 return {stateRoot:bytesToHex(await state.getStateRoot()),accounts,changes,observedState:await snapshotState(state,observed)};
}
export async function compare(d,attempt,reference){
 if(attempt.status!=='completed'||!['success','reverted','failed'].includes(attempt.output?.execution?.status)||reference.status!=='completed')return{status:'unavailable',reason:'One execution did not complete within its declared profile.',checks:null};
 const applied=await applyProductChanges(d,attempt,reference.observedState);assert.equal(reference.output.serializedTransaction,d.serializedTransaction);
 const exact=(a,b)=>{try{assert.deepEqual(a,b);return true;}catch{return false;}};
 const checks={execution:attempt.output.execution.status===reference.output.execution,returnData:attempt.output.execution.returnData===reference.output.returnData,logs:exact(attempt.output.logs.map(({address,topics,data})=>({address,topics,data})),reference.output.logs),gas:attempt.output.gasAccounting.gasUsed===reference.output.gasUsed,stateRoot:applied.stateRoot===reference.output.stateRoot&&exact(applied.observedState,reference.observedState)};
 return {status:Object.values(checks).every(Boolean)?'matched':'mismatched',checks,applied,scope:'Synthetic zero-fee differential with shared opcode library, independent sparse versus full-MPT finalization paths.'};
}
