import assert from 'node:assert/strict';
import { RLP } from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import { bytesToHex } from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import { createTx,createTxFromRLP } from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { feeCommon,TEST_KEY,bytes } from '../../engines/local-evm/test/fee-fixture.js';
import { resetFixture,request,FACTORY,INSPECTOR } from '../../engines/local-evm/test/sequential-reset-fixture.js';
import { resetPreviewFixture } from '../../engines/local-evm/test/reset-preview-fixture.js';
export const IDS=['delete_fund_inspect','delete_recreate_getter','repeated_recreation','constructor_revert','reverting_recreation_getter'];
export async function fixtureAt(index){
 assert(Number.isSafeInteger(index)&&index>=0&&index<IDS.length);const f=index===4?await resetPreviewFixture():await resetFixture({constructorReverts:index===3});
 const requests=index===0?[request(f,f.victim),request(f,f.victim,{value:'7'}),request(f,INSPECTOR)]:index===1?[request(f,f.victim),request(f,FACTORY),request(f,f.victim)]:index===2?[request(f,f.victim),request(f,FACTORY),request(f,f.victim,{data:'0x01'}),request(f,FACTORY),request(f,f.victim)]:index===3?[request(f,f.victim),request(f,FACTORY)]:[f.request,f.queryRequest];
 return Object.assign(f,{index,id:IDS[index],requests});
}
export function declaration(f){
 const common=feeCommon(f);assert.equal(common.hardfork(),'shanghai');assert.equal(BigInt(f.header.baseFeePerGas),0n);
 const nonce=BigInt(f.allocation[f.requests[0].from].nonce),signed=f.requests.map((r,i)=>{
  assert.equal(r.from,f.requests[0].from);assert(r.to);assert.equal(r.authorizationList,undefined);assert.equal(r.blobVersionedHashes,undefined);assert.equal(r.accessList,undefined);
  assert(BigInt(r.gas)<=5000000n);assert.equal(BigInt(r.fees?.maxFeePerGas??0),0n);assert.equal(BigInt(r.fees?.maxPriorityFeePerGas??0),0n);
  const tx=createTx({type:2,chainId:1n,nonce:nonce+BigInt(i),gasLimit:BigInt(r.gas),to:r.to,value:BigInt(r.value),data:r.data,maxFeePerGas:0n,maxPriorityFeePerGas:0n},{common}).sign(bytes(TEST_KEY)),serialized=bytesToHex(tx.serialize()),decoded=createTxFromRLP(bytes(serialized),{common});
  assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(decoded.nonce,nonce+BigInt(i));return{bytes:serialized,hash:bytesToHex(tx.hash()),nonce:decoded.nonce.toString()};
 });
 const h=f.header,environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:'0x0',currentBaseFee:'0x0',withdrawals:[]};
 const allocation=Object.fromEntries(Object.entries(f.allocation).map(([a,row])=>[a,{...row,storage:Object.fromEntries(Object.entries(row.storage).map(([k,v])=>['0x'+BigInt(k).toString(16).padStart(64,'0'),'0x'+BigInt(v).toString(16).padStart(64,'0')]))}]));
 return {index:f.index,id:f.id,header:f.header,allocation,requests:f.requests,signed,environment,prefixBodies:signed.map((_,i)=>bytesToHex(RLP.encode(signed.slice(0,i+1).map(t=>bytes(t.bytes))))),scope:{classification:'known_synthetic_development_sequences',chainId:1,fork:'shanghai',publicRpc:false,unsignedProduct:true,signedType2Counterparts:true,zeroFees:true,transactionOrderDeclared:true,populationAccuracy:false}};
}
