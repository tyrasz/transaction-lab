// Initial-only synthetic allocations; no expected poststate feeds execution.
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
export { TARGET, TX_SENDER, account, code, compareAmsterdamFullVM } from './amsterdam-execution-fixture.js';
export { initcode, factoryCode, createdAddress, word } from './lifecycle-fixture.js';
export const HELPER='0x'+'66'.repeat(20);
export const IMPLEMENTATION='0x'+'77'.repeat(20);
export const qty=n=>'0x'+BigInt(n).toString(16);
export async function creationAttemptFixture({body,nonce=7n,balance=1000n,accounts={},gas='5000000'}={}){
  return amsterdamExecutionFixture({target:{nonce,balance,code:body},accounts,gas});
}
const p2=n=>'61'+n.toString(16).padStart(4,'0');
// Tiny labelled assembler keeps CODECOPY and jumps correct in nested branches.
export function program(parts){
  const offsets=new Map();let at=0;
  for(const part of parts){if(typeof part==='string')at+=part.length/2;else if(part.label)offsets.set(part.label,at);else at+=3;}
  return'0x'+parts.map(part=>typeof part==='string'?part:part.label?'':p2(offsets.get(part.push2))).join('');
}
export function callBytes(address,{opcode='f1',value=0,gas=3000000,inputLength=0}={}){
  return'60006000'+p2(inputLength)+'6000'+(['f1','f2'].includes(opcode)?p2(value):'')+'73'+address.slice(2)+'62'+gas.toString(16).padStart(6,'0')+opcode+'50';
}
export function createParts(init,{kind='CREATE',value=0,salt='0x'+'00'.repeat(31)+'7b',label='init'}={}){
  const copy=[p2(init.length/2),{push2:label},'600039'];
  const op=(kind==='CREATE2'?'7f'+salt.slice(2):'')+p2(init.length/2)+'6000'+p2(value)+(kind==='CREATE2'?'f5':'f0');
  return{copy,op};
}
export function terminalCreation(init,opts={}){
  const{copy,op}=createParts(init,opts);
  return program([...copy,{push2:'terminal'},'56',{label:'init'},init,{label:'terminal'},'5b'+op]);
}
export function reentrantCreation(init,target){
  const{copy,op}=createParts(init);
  const body=program(['36',{push2:'inner'},'57',...copy,op+'50'+callBytes(HELPER),...copy,op+'5000',{label:'inner'},'5b',...copy,op+'5000',{label:'init'},init]);
  const helper='0x6001600053'+callBytes(target,{inputLength:1,gas:2000000})+'00';
  return{body,helper};
}
