// Synthetic prestate and authentic MPT proofs only; no expected output enters
// either the isolated product or the separately sequenced full-VM counterpart.
import { shanghaiFixture } from './shanghai-fixture.js';
import { createdAddress, factoryCode, initcode, word } from './lifecycle-fixture.js';

const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
export const RESET_HELPER=address(0x8888), RESET_GETTER=address(0x9999), RESET_BENEFICIARY=address(0x5555);
// Fresh constructor checks an undemanded old slot was cleared, then writes two
// slots. Runtime must execute newly installed code and read those new slots.
export const RESET_RUNTIME='6000546001540160005260206000f3';
export const RESET_INIT=initcode(RESET_RUNTIME,'6103df5415600055602a600155');
export const RESET_TARGET=createdAddress({creator:RESET_HELPER,kind:'CREATE2',init:RESET_INIT});
const call=(to,{gas=900000,out=32}={})=>`60${out.toString(16).padStart(2,'0')}600060006000600073${to.slice(2)}62${gas.toString(16).padStart(6,'0')}f1`;

export async function resetPreviewFixture({helperReverts=true}={}){
  // Clear memory before CALL: an empty return must not reuse copied initcode.
  const success='6000600052'+call(RESET_TARGET,{gas:200000})+'5060206000'+(helperReverts?'fd':'f3');
  // The retaining variant reverts a before-state collision but returns after
  // successful recreation, so only its after-phase is a mutating getter.
  const collisionOffset=9+41+5+success.length/2; // factory CODECOPY + CREATE2 + branch
  const tail=helperReverts?'50'+success:'1561'+collisionOffset.toString(16).padStart(4,'0')+'57'+success+'5b600060005260206000fd';
  const helperCode=factoryCode(RESET_INIT,{kind:'CREATE2',value:1,tail});
  const f=await shanghaiFixture({code:'0x'+call(RESET_TARGET,{out:0})+'5000',accounts:{
    [RESET_TARGET]:{nonce:3n,balance:17n,code:'0x6000545073'+RESET_BENEFICIARY.slice(2)+'ff',storage:{[word(0)]:999n,[word(1)]:888n,[word(991)]:99n}},
    [RESET_BENEFICIARY]:{nonce:1n,balance:5n,code:'0x'},
    [RESET_HELPER]:{nonce:1n,balance:2n,code:helperCode},
    [RESET_GETTER]:{nonce:1n,balance:0n,code:'0x'+call(RESET_HELPER)+'5060206000f3'},
  }});
  const query={to:RESET_GETTER,data:'0x70a08231'+f.request.from.slice(2).padStart(64,'0')};
  return Object.assign(f,{query,queryRequest:{from:f.request.from,...query,value:'0',gas:'1000000'}});
}
