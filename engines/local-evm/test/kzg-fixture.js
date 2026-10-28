// Saved official precompile input plus synthetic authenticated initial state.
// The optional full-VM comparison shares both EthereumJS and this KZG verifier;
// it checks transaction admission/finalization/MPT paths, not independent crypto.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bytesToHex } from '@ethereumjs/util';
import { createVM, runTx } from '../../fixture-evm/node_modules/@ethereumjs/vm/dist/esm/index.js';
import { createTx } from '../../fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import { loadState } from '../../fixture-evm/state-test.js';
import { verifyKzgProof } from '../kzg-point-evaluation.js';
import { feeFixture, feeCommon, feeBlock, TEST_KEY, TX_SENDER, TARGET, COINBASE, account, bytes, word, appliedRoot } from './fee-fixture.js';
import { compareExecution } from './authorization-fixture.js';
export { TX_SENDER, TARGET, COINBASE, account, bytes, word };
export { balance, slot } from './fee-fixture.js';
export const KZG_ADDRESS='0x'+'00'.repeat(19)+'0a';
const raw=readFileSync(new URL('./fixtures/kzg-point-evaluation/upstream/pointEvaluation.json',import.meta.url));
export const KZG_VECTOR_SOURCE_SHA256=createHash('sha256').update(raw).digest('hex');
assert.equal(KZG_VECTOR_SOURCE_SHA256,'e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d','Pinned official Geth vector bytes changed');
const vector=JSON.parse(raw)[0];
assert.equal(vector.Input.length,384);assert.equal(vector.Expected.length,128);assert.equal(vector.Gas,50000);
export const KZG_INPUT='0x'+vector.Input.toLowerCase();
export const KZG_OUTPUT='0x'+vector.Expected.toLowerCase();
export const KZG_VECTOR_NAME=vector.Name;

// Copies root calldata, or an explicitly embedded saved input, then invokes 0x0a.
// The default result is 64 return bytes followed by the CALL success flag.
export function kzgCallerCode({kind='STATICCALL',gas=50000,value=0,input,prefix='',tail='60405260606000f3'}={}){
  const op={CALL:'f1',CALLCODE:'f2',DELEGATECALL:'f4',STATICCALL:'fa'}[kind];assert(op);
  assert(Number.isInteger(gas)&&gas>=0&&gas<=0xffffff);assert(Number.isInteger(value)&&value>=0&&value<=255);
  const size=input===undefined?'36':'61'+((input.length-2)/2).toString(16).padStart(4,'0');
  const invoke=`60406000${size}6000${['CALL','CALLCODE'].includes(kind)?'60'+value.toString(16).padStart(2,'0'):''}600a62${gas.toString(16).padStart(6,'0')}${op}${tail}`;
  if(input===undefined)return '0x'+prefix+'366000600037'+invoke;
  assert.match(input,/^0x(?:[a-f0-9]{2})*$/);
  // PUSH2 size, PUSH2 offset, PUSH1 zero, CODECOPY = 9 bytes.
  const offset=prefix.length/2+9+invoke.length/2;
  return '0x'+prefix+size+'61'+offset.toString(16).padStart(4,'0')+'600039'+invoke+input.slice(2);
}

export async function kzgFixture({fork='osaka',priced=false,code='0x00',to=KZG_ADDRESS,data=KZG_INPUT,gas='200000',value='0',accounts={},...options}={}){
  const f=await feeFixture({...options,fork,baseFee:priced?7n:0n,maxFee:priced?13n:0n,priorityFee:priced?3n:0n,
    to,data,gas,value,target:{nonce:1n,balance:100n,code},accounts:{[COINBASE]:{nonce:1n,balance:1n,code:'0x'},...accounts}});
  if(!priced){delete f.request.executionProfile;delete f.request.fees;}
  return f;
}

export async function compareKzgFullVM(f,output,changes=f.stateManager.snapshotChanges()){
  const common=feeCommon(f);common.customCrypto.kzg={verifyProof:verifyKzgProof};
  const state=await loadState(f.allocation,common),block=feeBlock(f,common);
  assert.equal(bytesToHex(await state.getStateRoot()),f.header.stateRoot);assert.equal(bytesToHex(block.hash()),f.header.hash);
  const vm=await createVM({common,stateManager:state,blockchain:{async getBlock(){throw Error('No declared synthetic ancestry');},shallowCopy(){return this;}}});
  const r=f.request,tx=createTx({type:2,chainId:1n,nonce:BigInt(f.allocation[r.from].nonce),to:r.to,gasLimit:BigInt(r.gas),value:BigInt(r.value),data:r.data,
    maxFeePerGas:BigInt(r.fees?.maxFeePerGas??0),maxPriorityFeePerGas:BigInt(r.fees?.maxPriorityFeePerGas??0)},{common}).sign(bytes(TEST_KEY));
  assert.equal(tx.getSenderAddress().toString(),r.from);assert(tx.verifySignature());
  const result=await runTx(vm,{tx,block});compareExecution(output,result);
  assert.equal(await appliedRoot(f,changes,common),bytesToHex(await state.getStateRoot()),'Product deltas must reconstruct the same full MPT under the shared-crypto signed counterpart');
  return {state,common,tx,result};
}
