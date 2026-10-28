import test from 'node:test';
import assert from 'node:assert/strict';
import { Common,Mainnet,Hardfork } from '@ethereumjs/common';
import { createTx } from '@ethereumjs/tx';
import { hexToBytes,bytesToHex,createAddressFromPrivateKey } from '@ethereumjs/util';
import { executeStateTest,loadState,compareResult,admissionCategory } from '../state-test.js';
const key='0x'+'20'.repeat(32),sender=createAddressFromPrivateKey(hexToBytes(key)).toString(),to='0x'+'11'.repeat(20),coinbase='0x'+'22'.repeat(20),common=()=>new Common({chain:Mainnet,hardfork:Hardfork.Osaka});
const q=n=>'0x'+BigInt(n).toString(16).padStart(2,'0');
const account=(balance,nonce=0,code='0x',storage={})=>({balance:q(balance),nonce:q(nonce),code,storage});
async function fixture({nonce=0,preNonce=0,balance=10n**18n,gas=21000,price=10,value=1,code='0x',expectedException}={}){
 const tx=createTx({type:0,nonce:BigInt(nonce),gasLimit:BigInt(gas),gasPrice:BigInt(price),to,value:BigInt(value),data:'0x'},{common:common()}).sign(hexToBytes(key));
 const pre={[sender]:account(balance,preNonce)};if(code!=='0x')pre[to]=account(0,1,code);
 const used=code==='0x'?21000n:21006n;
 const final=expectedException?pre:{[sender]:account(balance-BigInt(price)*used-(code==='0x'?BigInt(value):0n),preNonce+1),[to]:code==='0x'?account(value):pre[to],[coinbase]:account((BigInt(price)-7n)*used)};
 const state=await loadState(final,common()),hash=bytesToHex(await state.getStateRoot());
 const post={hash,logs:'0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',txbytes:bytesToHex(tx.serialize()),indexes:{data:0,gas:0,value:0},state:final};
 if(expectedException)post.expectException='TransactionException.'+expectedException;
 else post.receipt={transactionHash:bytesToHex(tx.hash()),cumulativeGasUsed:q(used),status:code==='0x',bloom:'0x'+'00'.repeat(256)};
 return {_info:{'fixture-format':'state_test'},config:{chainid:'0x01',blobSchedule:{Osaka:{target:'0x06',max:'0x09',baseFeeUpdateFraction:'0x4c6964'}}},env:{currentCoinbase:coinbase,currentGasLimit:'0x01c9c380',currentNumber:'0x01',currentTimestamp:'0x03e8',currentRandom:'0x00',currentDifficulty:'0x00',currentBaseFee:'0x07',currentExcessBlobGas:'0x00'},pre,transaction:{chainId:'0x01',nonce:q(nonce),gasPrice:q(price),gasLimit:[q(gas)],to,value:[q(value)],data:['0x'],sender,secretKey:key},post:{Osaka:[post]}};
}
test('synthetic signed transfer settles actual fees, nonce, recipient and beneficiary in full state',async()=>{const r=await executeStateTest(await fixture());assert.equal(r.comparison.status,'matched');assert.equal(r.observed.gasUsed,'21000');assert.equal(r.observed.execution,'success');assert.equal(r.scope.skipFlags,false);});
test('execution REVERT remains admitted and pays actual gas while rolling value back',async()=>{const r=await executeStateTest(await fixture({code:'0x60006000fd',gas:30000}));assert.equal(r.comparison.status,'matched');assert.equal(r.observed.execution,'revert');assert.equal(r.observed.admission,'accepted');assert.equal(r.observed.gasUsed,'21006');});
for(const [name,options]of Object.entries({nonce:{preNonce:1,expectedException:'NONCE_MISMATCH'},balance:{balance:1n,expectedException:'INSUFFICIENT_ACCOUNT_FUNDS'},fees:{price:6,expectedException:'INSUFFICIENT_MAX_FEE_PER_GAS'},intrinsic:{gas:20999,expectedException:'INTRINSIC_GAS_TOO_LOW'}}))test('full admission rejects '+name,async()=>{const r=await executeStateTest(await fixture(options));assert.equal(r.observed.admission,'rejected');assert.equal(r.comparison.status,'matched',JSON.stringify(r));});
test('unknown admission errors cannot count as expected exceptions',()=>{assert.equal(admissionCategory(new Error('something failed')),null);const r=compareResult({admission:'rejected',admissionCategory:null,stateRoot:'0x00',logsHash:'0x00'},{expectException:'OtherFailure',hash:'0x00',logs:'0x00'});assert.equal(r.status,'mismatched');});
test('changed fixture signature and sender cannot be admitted',async()=>{const f=await fixture();f.transaction.sender=coinbase;await assert.rejects(executeStateTest(f),/sender/);const g=await fixture();g.post.Osaka[0].txbytes=g.post.Osaka[0].txbytes.slice(0,-2)+'00';await assert.rejects(executeStateTest(g),/signed transaction/);});
test('wrong full expected state, root, receipt gas and logs cannot pass',async()=>{const f=await fixture();f.post.Osaka[0].state[sender].balance='0x01';await assert.rejects(executeStateTest(f),/poststate/);const g=await fixture();g.post.Osaka[0].logs='0x'+'00'.repeat(32);g.post.Osaka[0].receipt.cumulativeGasUsed='0x01';const r=await executeStateTest(g);assert.equal(r.comparison.status,'mismatched');assert.equal(r.comparison.checks.logsHash,false);assert.equal(r.comparison.checks.gasUsed,false);});
test('ambiguous storage keys and unrecognized environment fields reject',async()=>{const f=await fixture();f.pre[sender].storage={'0x00':'0x01','0x0000':'0x02'};await assert.rejects(executeStateTest(f));const g=await fixture();g.env.blockOverride={};await assert.rejects(executeStateTest(g));});
