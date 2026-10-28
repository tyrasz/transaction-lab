import assert from 'node:assert/strict';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createTx, createTxFromRLP } from '@ethereumjs/tx';
import { createVM, runTx } from '@ethereumjs/vm';
import { MerkleStateManager } from '@ethereumjs/statemanager';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex, bigIntToBytes, setLengthLeft, eoaCode7702RecoverAuthority } from '@ethereumjs/util';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';

const MAX_GAS=16777216n;
const ENV_KEYS=['currentCoinbase','currentGasLimit','currentNumber','currentTimestamp','currentRandom','currentDifficulty','currentBaseFee','currentExcessBlobGas'];
const TX_KEYS=['chainId','nonce','gasPrice','gasLimit','to','value','data','accessLists','sender','secretKey','maxFeePerGas','maxPriorityFeePerGas','authorizationList'];
const hex=v=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:[0-9a-fA-F]{2})*$/);return hexToBytes(v);};
const qty=v=>{assert.equal(typeof v,'string');assert.match(v,/^0x[0-9a-fA-F]+$/);const n=BigInt(v);assert(n>=0n&&n<(1n<<256n));return n;};
const word=v=>setLengthLeft(bigIntToBytes(qty(v)),32);
export async function loadState(alloc,common){
 assert(alloc&&typeof alloc==='object'&&!Array.isArray(alloc));assert(Object.keys(alloc).length<=128);
 const state=new MerkleStateManager({common});const seen=new Set();let slots=0;
 for(const [address,a]of Object.entries(alloc)){
  assert.match(address,/^0x[0-9a-fA-F]{40}$/);assert(!seen.has(address.toLowerCase()));seen.add(address.toLowerCase());assert.deepEqual(Object.keys(a).sort(),['balance','code','nonce','storage']);
  const addr=createAddressFromString(address);await state.putAccount(addr,createAccount({nonce:qty(a.nonce),balance:qty(a.balance)}));await state.putCode(addr,hex(a.code));const keys=new Set();
  for(const [key,value]of Object.entries(a.storage)){assert(++slots<=1024);const k=bytesToHex(word(key));assert(!keys.has(k));keys.add(k);await state.putStorage(addr,word(key),bigIntToBytes(qty(value)));}
 }
 return state;
}
export function fixtureBlock(env,common){
 assert.deepEqual(Object.keys(env).sort(),ENV_KEYS.toSorted());assert.equal(qty(env.currentDifficulty),0n);
 return createBlock({header:{coinbase:env.currentCoinbase,gasLimit:qty(env.currentGasLimit),number:qty(env.currentNumber),timestamp:qty(env.currentTimestamp),mixHash:word(env.currentRandom),difficulty:0n,baseFeePerGas:qty(env.currentBaseFee),excessBlobGas:qty(env.currentExcessBlobGas)},withdrawals:[]},{common});
}
export function signedTransaction(transaction,post,common){
 assert(Object.keys(transaction).every(k=>TX_KEYS.includes(k)));assert.equal(qty(transaction.chainId),1n);const ix=post.indexes;
 for(const k of ['gas','value','data'])assert(Number.isSafeInteger(ix[k])&&ix[k]>=0);
 const gasLimit=qty(transaction.gasLimit[ix.gas]),data=transaction.data[ix.data];assert(gasLimit<=MAX_GAS);assert(hex(data).length<=32768);
 const accessList=transaction.accessLists?.[ix.data];
 const type=transaction.authorizationList!==undefined?4:transaction.maxFeePerGas!==undefined?2:accessList!==undefined&&accessList!==null?1:0;
 const fields={type,nonce:qty(transaction.nonce),gasLimit,to:transaction.to||undefined,value:qty(transaction.value[ix.value]),data};
 if(type===2||type===4){fields.maxFeePerGas=qty(transaction.maxFeePerGas);fields.maxPriorityFeePerGas=qty(transaction.maxPriorityFeePerGas);}else fields.gasPrice=qty(transaction.gasPrice);
 if(type>0){fields.chainId=1n;fields.accessList=accessList??[];}
 if(type===4)fields.authorizationList=transaction.authorizationList.map(a=>{assert(Object.keys(a).every(k=>['chainId','address','nonce','v','yParity','r','s','signer'].includes(k)));if(a.v!==undefined)assert.equal(qty(a.v),qty(a.yParity));const normalized=Object.fromEntries(['chainId','address','nonce','yParity','r','s'].map(k=>[k,a[k]]));if(a.signer!==undefined)assert.equal(eoaCode7702RecoverAuthority(normalized).toString(),a.signer.toLowerCase());return normalized;});
 const rebuilt=createTx(fields,{common}).sign(hex(transaction.secretKey));
 assert.equal(bytesToHex(rebuilt.serialize()),post.txbytes.toLowerCase(),'Reconstructed signed transaction differs from official bytes');
 const tx=createTxFromRLP(hex(post.txbytes),{common});assert.equal(bytesToHex(tx.serialize()),post.txbytes.toLowerCase());assert(tx.verifySignature(),'Signature verification failed');assert.equal(tx.getSenderAddress().toString(),transaction.sender.toLowerCase(),'Fixture sender/signature mismatch');
 return tx;
}
// Deliberately closed mapping: an unrecognized error never proves an expected rejection.
export function admissionCategory(error){
 const m=error?.message??'';
 if(/the tx doesn't have the correct nonce/.test(m))return 'NONCE_MISMATCH';
 if(/sender doesn't have enough funds/.test(m))return 'INSUFFICIENT_ACCOUNT_FUNDS';
 if(/gasPrice.*less than.*baseFeePerGas|maxFeePerGas.*less than.*baseFeePerGas/.test(m))return 'INSUFFICIENT_MAX_FEE_PER_GAS';
 if(/gas limit is too low|tx gas limit.*lower than.*minimum gas/.test(m))return 'INTRINSIC_GAS_TOO_LOW';
 if(/tx has a higher gas limit than the block/.test(m))return 'GAS_ALLOWANCE_EXCEEDED';
 return null;
}
export function compareResult(observed,post){
 const expected=post.expectException??null;
 const expectedCategory=expected===null?null:expected.replace(/^TransactionException\./,'');
 const checks={admission:expected===null?observed.admission==='accepted':observed.admission==='rejected'&&observed.admissionCategory!==null&&observed.admissionCategory===expectedCategory,stateRoot:observed.stateRoot===post.hash.toLowerCase(),logsHash:observed.logsHash===post.logs.toLowerCase()};
 if(post.receipt){checks.receiptStatus=observed.receiptStatus===post.receipt.status;checks.gasUsed=observed.gasUsed===qty(post.receipt.cumulativeGasUsed).toString();checks.transactionHash=observed.transactionHash===post.receipt.transactionHash.toLowerCase();checks.receiptBloom=observed.receiptBloom===post.receipt.bloom.toLowerCase();}
 return {status:Object.values(checks).every(Boolean)?'matched':'mismatched',checks,expectedException:expected,actualAdmissionCategory:observed.admissionCategory};
}
/** Official state-test transition: signed transaction, actual fork/fees and full
 * MPT state. No sparse product state, traces, overrides, or admission bypasses. */
export async function executeStateTest(fixture,postIndex=0){
 assert.equal(fixture._info['fixture-format'],'state_test');assert.equal(fixture.config.chainid,'0x01');
 const common=new Common({chain:Mainnet,hardfork:Hardfork.Osaka});const post=fixture.post.Osaka[postIndex];assert(post);
 // The supplied Osaka blob fee schedule must equal the configured fork, rather
 // than being silently ignored. This slice has no type-3 transactions/KZG.
 const schedule=fixture.config.blobSchedule?.Osaka;assert(schedule);assert.equal(qty(schedule.target),6n);assert.equal(qty(schedule.max),9n);assert.equal(qty(schedule.baseFeeUpdateFraction),5007716n);
 const state=await loadState(fixture.pre,common),preStateRoot=bytesToHex(await state.getStateRoot());
 const block=fixtureBlock(fixture.env,common);const tx=signedTransaction(fixture.transaction,post,common);
 const expectedState=post.state?await loadState(post.state,common):null;if(expectedState)assert.equal(bytesToHex(await expectedState.getStateRoot()),post.hash.toLowerCase(),'Official full poststate does not match its root');
 let missingHistory=false;
 const blockchain={getBlock:async()=>{missingHistory=true;throw Error('Fixture has no supplied BLOCKHASH ancestry');},shallowCopy(){return this;}};
 const vm=await createVM({common,stateManager:state,blockchain});let result,error;
 try{result=await runTx(vm,{tx,block});}catch(e){error=e;}
 if(missingHistory)throw Error('Unsupported fixture ancestry access; no fabricated block hash');
 const logs=result?.execResult.logs??[];
 const observed={fork:common.hardfork(),preStateRoot,transactionHash:bytesToHex(tx.hash()),serializedTransaction:bytesToHex(tx.serialize()),sender:tx.getSenderAddress().toString(),admission:result?'accepted':'rejected',admissionCategory:error?admissionCategory(error):null,error:error?{name:error.name,message:error.message}:null,execution:result?(result.execResult.exceptionError?.error??'success'):null,returnData:result?bytesToHex(result.execResult.returnValue):null,gasUsed:result?result.totalGasSpent.toString():null,executionGasUsed:result?result.execResult.executionGasUsed.toString():null,gasRefund:result?result.gasRefund.toString():null,stateRoot:bytesToHex(await state.getStateRoot()),logs:logs.map(([a,t,d])=>({address:bytesToHex(a),topics:t.map(bytesToHex),data:bytesToHex(d)})),logsHash:bytesToHex(keccak_256(RLP.encode(logs))),receiptStatus:result?Boolean(result.receipt.status):null,receiptBloom:result?bytesToHex(result.receipt.bitvector):null};
 return {observed,comparison:compareResult(observed,post),scope:{signedTransaction:true,realFees:true,fullMptPoststate:true,fixtureReceiptGasCompared:!!post.receipt,skipFlags:false,sparseProductAccuracy:false,consensusHeaderValidation:false,kzgSidecarAdmission:false}};
}
