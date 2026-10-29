// Artifact-only checks. No EVM, transaction runner, child process, or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const PINS = Object.freeze({ manifest: '339bcd0951d66deec7f981d24e9bb14d04062a565256d4234b5aa731878a98e0', plan: 'a32e63e57de64bfa4f97b6b7e17535a1d3e87bdaeaf077eda66c25f2f03b98b7', source: '66eb6a304a5eb0090119505568fbabf9176b07860d4e3b490f730b4847ccebb4', binary: '10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521', toolchain: '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333' });
export const IDS = ['stop_baseline', 'post_target_call_oog'];
export const ADDRESSES = Object.freeze({ sender: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1', target: '0x'+'22'.repeat(20), child: '0x'+'33'.repeat(20), authority: '0x'+'44'.repeat(20), implementation: '0x'+'55'.repeat(20), coinbase: '0x'+'99'.repeat(20) });
export const SYSTEM = ['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282'];
export const sha = b => createHash('sha256').update(b).digest('hex');
export const read = p => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(p)));
export const q = n => '0x'+BigInt(n).toString(16);
export function walk(root,sub='') { return fs.readdirSync(path.join(root,sub),{withFileTypes:true}).flatMap(e=>{const p=sub?sub+'/'+e.name:e.name;return e.isDirectory()?walk(root,p):[p];}).sort(); }
export function inventory(root, rows) {
  const names=rows.map(f=>f.path);assert.equal(new Set(names).size,names.length);
  for(const f of rows){assert(f.path&&!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'));const p=path.join(root,f.path),s=fs.lstatSync(p);
    if(f.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),f.target);assert(!path.isAbsolute(f.target));const resolved=path.resolve(path.dirname(p),f.target);assert(resolved.startsWith(path.resolve(root)+path.sep));assert(fs.statSync(resolved).isFile());}
    else{assert(s.isFile());assert.equal(s.size,f.bytes);assert(s.size<=16*1024*1024);assert.equal(sha(fs.readFileSync(p)),f.sha256);if(f.mode!==undefined)assert.equal(s.mode&0o777,f.mode);}}
}
export function rawStream(s){const b=Buffer.from(s.base64,'base64');assert.equal(b.toString('base64'),s.base64);assert.equal(b.length,s.bytes);assert.equal(sha(b),s.sha256);return b;}
export function processRecord(raw){const p=raw.process;assert.equal(p.status,0);assert.equal(p.signal,null);assert.equal(p.error,null);assert(Number.isInteger(p.timeoutMs)&&p.timeoutMs>0&&p.timeoutMs<=15000);for(const v of [p.elapsedMs,p.wallElapsedMs])assert(Number.isFinite(v)&&v>=0&&v<=p.timeoutMs);const stdout=rawStream(raw.stdout),stderr=rawStream(raw.stderr);assert(stdout.length+stderr.length<=2097152);return {stdout,stderr};}
export function normalizedAllocation(a){return Object.fromEntries(Object.entries(a).map(([k,v])=>{assert(/^0x[0-9a-f]{40}$/.test(k));assert(Object.keys(v).every(x=>['nonce','balance','code','storage'].includes(x)));return[k,{nonce:q(v.nonce??0),balance:q(v.balance),code:v.code??'0x',storage:v.storage??{}}];}).sort(([a],[b])=>a.localeCompare(b)));}
export function feePoststate(initial,gas){const out=structuredClone(initial),a=ADDRESSES;out[a.sender].nonce=q(BigInt(out[a.sender].nonce)+1n);out[a.sender].balance=q(BigInt(out[a.sender].balance)-BigInt(gas)*10n);out[a.coinbase]={nonce:'0x0',balance:q(BigInt(gas)*3n),code:'0x',storage:{}};return normalizedAllocation(out);}
export function finalPath(records,input){
  assert(Array.isArray(records)&&records.length>1&&records.length<1000);let at=0,frames=0,ops=0;
  function frame(depth,from,to,gas){const enter=records[at++];assert.deepEqual(enter,{from,to,gas:q(gas),value:'0x0',type:'CALL'});frames++;
    const opRows=[],children=[];let exit;
    while(at<records.length){const x=records[at];if(Object.hasOwn(x,'from')){assert(depth===1);const call=opRows.at(-1);assert.equal(call.op,241);assert.equal(call.error,undefined);assert.equal(call.stack.length,7);const childTo='0x'+BigInt(call.stack.at(-2)).toString(16).padStart(40,'0');children.push(frame(depth+1,to,childTo,BigInt(call.stack.at(-1))));continue;}
      at++;if(Object.hasOwn(x,'output')){assert.deepEqual(Object.keys(x).sort(),x.error?['error','gasUsed','output']:['gasUsed','output']);assert.equal(x.output,'');assert(/^0x[0-9a-f]+$/.test(x.gasUsed));exit=x;break;}
      assert(Number.isSafeInteger(x.pc)&&Number.isSafeInteger(x.op));assert.equal(x.depth,depth);assert.equal(x.memSize,0);assert.equal(x.refund,0);assert(Array.isArray(x.stack)&&x.stack.every(s=>/^0x[0-9a-f]+$/.test(s)));assert(/^0x[0-9a-f]+$/.test(x.gas)&&/^0x[0-9a-f]+$/.test(x.gasCost));const code=input.allocation[to].code;assert.equal(x.op,parseInt(code.slice(2+x.pc*2,4+x.pc*2),16));opRows.push(x);ops++;
    }assert(exit);return{enter,ops:opRows,children,exit};}
  const root=frame(1,ADDRESSES.sender,ADDRESSES.target,16762216n);assert.equal(at,records.length);
  if(input.index===0){assert.equal(root.children.length,0);assert.equal(root.ops.length,1);assert.equal(root.ops[0].pc,0);assert.equal(root.ops[0].op,0);assert.equal(root.exit.gasUsed,'0x0');assert.equal(root.exit.error,undefined);return{frames,opcodeRecords:ops,root,diagnosis:{kind:'STOP',messageGasUsed:'0'}};}
  assert.equal(root.children.length,3);const calls=root.ops.filter(x=>x.op===241);assert.deepEqual(calls.map(x=>x.pc),[36,74,112,150]);
  for(let i=0;i<root.ops.length-1;i++){const a=root.ops[i],b=root.ops[i+1];assert.equal(BigInt(b.gas),BigInt(a.gas)-BigInt(a.gasCost));}
  for(let i=0;i<3;i++){const child=root.children[i];assert.equal(child.enter.to,ADDRESSES.child);assert.equal(child.enter.gas,q([16000000,600000,154547][i]));assert.equal(child.exit.gasUsed,child.enter.gas);assert.equal(child.exit.error,'invalid opcode: INVALID');assert.deepEqual(child.ops.map(x=>[x.pc,x.op]),[[0,254],[0,254]]);assert.equal(child.ops[1].error,'invalid opcode: INVALID');}
  const last=calls.at(-1);assert.equal(root.ops.at(-1),last);assert.equal(last.gas,'0x1116');assert.deepEqual(last.stack,['0x0','0x0','0x0','0x0','0x0',ADDRESSES.authority,'0x0']);assert.equal(last.error,'out of gas: out of gas');assert.equal(root.exit.error,last.error);assert.equal(root.exit.gasUsed,'0xffc568');
  assert.equal(input.allocation[ADDRESSES.authority].code,'0xef0100'+ADDRESSES.implementation.slice(2));
  return{frames,opcodeRecords:ops,root,diagnosis:{kind:'delegated_CALL_cold_resolution_OOG',pc:150,authority:ADDRESSES.authority,implementation:ADDRESSES.implementation,gasBeforeOpcode:'4374',staticWarmCost:'100',additionalColdAuthorityCost:'2900',remainingBeforeDelegation:'1374',coldDelegationCost:'3000',requestedChildGas:'0',enteredChildren:3,messageGasUsed:'16762216'}};
}
export function channels(expected,result){const receipt=result.receipts[0];return{stateRoot:expected.stateRoot===result.stateRoot,logsHash:expected.execution.logsHash===result.logsHash,receiptStatus:BigInt(expected.receipt.status)===BigInt(receipt.status),receiptGas:BigInt(expected.gas.totalGasSpent)===BigInt(receipt.gasUsed),blockGas:BigInt(result.gasUsed)===(BigInt(expected.gas.txRegularGas)>BigInt(expected.gas.txStateGas)?BigInt(expected.gas.txRegularGas):BigInt(expected.gas.txStateGas))};}
