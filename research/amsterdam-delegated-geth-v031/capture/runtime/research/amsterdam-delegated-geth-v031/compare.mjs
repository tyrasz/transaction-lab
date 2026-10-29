import assert from 'node:assert/strict';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {keccak_256 as keccak} from '../../engines/local-evm/node_modules/@noble/hashes/sha3.js';
import {SYSTEM_SCAFFOLDING} from './cases.mjs';
export const DUMMY='0x1337'+'00'.repeat(30);
const object=v=>{assert(v&&typeof v==='object'&&!Array.isArray(v));return v;};
const keys=(v,required,optional=[])=>{object(v);assert(required.every(k=>Object.hasOwn(v,k)));assert(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));};
const hex=(v,n)=>{assert.equal(typeof v,'string');assert.match(v,n===undefined?/^0x(?:[a-f0-9]{2})*$/:new RegExp('^0x[a-f0-9]{'+n*2+'}$'));return v;};
const q=v=>{assert.equal(typeof v,'string');assert.match(v,/^0x(?:0|[1-9a-f][0-9a-f]*)$/);return BigInt(v);};
const dec=v=>{assert.equal(typeof v,'string');assert.match(v,/^(?:0|[1-9][0-9]*)$/);return BigInt(v);};
const bytes=h=>Uint8Array.from(Buffer.from(hex(h).slice(2),'hex')),h=b=>'0x'+Buffer.from(b).toString('hex'),max=(a,b)=>a>b?a:b;
const uint=n=>{assert(Number.isSafeInteger(n)&&n>=0);return n;};
const quantity=v=>{const n=q(v);assert(n<2n**64n);return n;};
export function logsCanonical(logs,input,receipt=false){assert(Array.isArray(logs)&&logs.length<=2000);return logs.map((row,i)=>{
  assert(row&&typeof row==='object'&&!Array.isArray(row));const fields=['address','topics','data'];
  if(receipt)fields.push('blockNumber','transactionHash','transactionIndex','blockHash','blockTimestamp','logIndex','removed');
  assert.deepEqual(Object.keys(row).sort(),fields.sort());const address=hex(row.address,20),data=hex(row.data);assert(Array.isArray(row.topics)&&row.topics.length<=4);const topics=row.topics.map(t=>hex(t,32));
  if(receipt){assert.equal(row.transactionHash,input.transactionHash);assert.equal(q(row.transactionIndex),0n);assert.equal(q(row.logIndex),BigInt(i));assert.equal(q(row.blockNumber),q(input.environment.currentNumber));assert.equal(q(row.blockTimestamp),q(input.environment.currentTimestamp));assert.equal(row.blockHash,DUMMY);assert.equal(row.removed,false);}
  return{address,topics,data};});}
export function logFacts(logs,{RLP,keccak}){const encoded=RLP.encode(logs.map(l=>[bytes(l.address),l.topics.map(bytes),bytes(l.data)]));const bloom=new Uint8Array(256);
  for(const l of logs)for(const v of[l.address,...l.topics]){const hash=keccak(bytes(v));for(let i=0;i<6;i+=2){const bit=((hash[i]<<8)|hash[i+1])&2047;bloom[255-(bit>>3)]|=1<<(bit&7);}}
  return{hash:h(keccak(encoded)),bloom:h(bloom)};}
export function parseRootTrace(bytes, input) {
  const request=input.request;
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4194304);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(text.endsWith('\n'), 'A complete JSONL file must end in a newline');
  const lines = text.slice(0, -1).split('\n'); assert(lines.length <= 100000);
  const stack = []; let root = null, rootEnter = null, opcodeCount = 0, frameCount = 0;
  for (let i = 0; i < lines.length; i++) {
    assert(lines[i].length > 0); const event = object(JSON.parse(lines[i]));
    assert(root === null, 'No event may follow the root exit');
    if (Object.hasOwn(event, 'type')) {
      keys(event, ['type', 'from', 'to', 'gas', 'value'], ['input']);
      assert(['CALL', 'STATICCALL', 'CALLCODE', 'DELEGATECALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(event.type));
      hex(event.from, 20); hex(event.to, 20); hex(event.input ?? '0x'); quantity(event.gas);
      assert(event.value === null || typeof event.value === 'string' && /^0x[0-9a-f]+$/i.test(event.value));
      if (event.value !== null) assert(BigInt(event.value) < 2n ** 256n);
      if (stack.length === 0) {
        assert.equal(i, 0); assert.equal(event.type, 'CALL');
        assert.equal(hex(event.from, 20), request.from); assert.equal(hex(event.to, 20), request.to);
        assert.equal(hex(event.input ?? '0x'), request.data); assert.equal(BigInt(event.value), BigInt(request.value));
        rootEnter = event;
      }
      stack.push(event); frameCount++; assert(stack.length <= 1025);
    } else if (Object.hasOwn(event, 'output')) {
      keys(event, ['output', 'gasUsed'], ['error']);
      assert(stack.length > 0); assert.equal(typeof event.output, 'string'); assert.match(event.output, /^(?:[0-9a-f]{2})*$/i);
      const used = quantity(event.gasUsed), frame = stack.pop(); assert(used <= quantity(frame.gas));
      if (event.error !== undefined) assert(typeof event.error === 'string' && event.error.length > 0 && event.error.length <= 4096);
      if (stack.length === 0) {
        assert.equal(i, lines.length - 1);
        root = { output: '0x' + event.output.toLowerCase(), gasUsed: used.toString(), error: event.error ?? null };
      }
    } else {
      keys(event, ['pc', 'op', 'gas', 'gasCost', 'memSize', 'stack', 'depth', 'refund', 'opName'], ['memory', 'error']);
      assert(stack.length > 0); uint(event.pc); assert(uint(event.op) <= 255); quantity(event.gas); quantity(event.gasCost);
      uint(event.memSize); assert(Array.isArray(event.stack)&&event.stack.length<=1024);for(const item of event.stack){assert.equal(typeof item,'string');assert.match(item,/^0x[0-9a-f]+$/i);assert(BigInt(item)<2n**256n);} assert.equal(event.depth, stack.length); uint(event.refund);
      assert.equal(typeof event.opName, 'string'); if (event.memory !== undefined) assert.equal((hex(event.memory).length - 2) / 2, event.memSize);
      if (event.error !== undefined) assert.equal(typeof event.error, 'string'); opcodeCount++;
    }
  }
  assert(root !== null && rootEnter !== null && stack.length === 0, 'Missing complete root exit');
  assert.equal(quantity(rootEnter.gas), BigInt(input.inputGas.gethRootGas), 'Root gas must match signed input minus pre-frame delegation charge');
  return { ...root, opcodeCount, frameCount, records: lines.length };
}
export function compareEvidence(input,e,outputs){
 assert.equal(e.id,input.id);assert.equal(e.transactionHash,input.transactionHash);assert.equal(e.initialStateRoot,input.initialStateRoot);
 const r=outputs.result;assert.equal(outputs.body,input.transactionBody);object(r);
 assert(r.rejected===undefined||Array.isArray(r.rejected)&&r.rejected.length===0);assert(Array.isArray(r.receipts)&&r.receipts.length===1);
 const receipt=r.receipts[0];assert.equal(q(receipt.type),2n);assert.equal(receipt.transactionHash,input.transactionHash);assert.equal(receipt.blockHash,DUMMY);assert.equal(q(receipt.blockNumber),q(input.environment.currentNumber));assert.equal(q(receipt.transactionIndex),0n);
 const status=q(receipt.status),gas=q(receipt.gasUsed);assert(status===0n||status===1n);assert.equal(q(receipt.cumulativeGasUsed),gas);assert(gas<=BigInt(input.request.gas));
 assert.deepEqual(r.requests,[]);assert.equal(q(r.blobGasUsed),0n);assert.equal(q(r.currentBaseFee),q(input.environment.currentBaseFee));assert.equal(r.currentDifficulty,null);
 const pl=logsCanonical(e.logs,input),gl=logsCanonical(receipt.logs,input,true),pf=logFacts(pl,{RLP,keccak}),gf=logFacts(gl,{RLP,keccak});
 assert.equal(e.execution.logsHash,pf.hash);assert.equal(hex(r.logsHash,32),gf.hash);assert.equal(hex(receipt.logsBloom,256),gf.bloom);assert.equal(hex(r.logsBloom,256),gf.bloom);
 for(const address of SYSTEM_SCAFFOLDING){const row=input.allocation[address],a=outputs.allocation[address.slice(2)]??outputs.allocation[address];assert(a);assert.equal(q(a.balance),BigInt(row.balance));assert.equal(q(a.nonce),BigInt(row.nonce));assert.equal(a.code,row.code);assert.deepEqual(a.storage??{},row.storage);}
 const trace=parseRootTrace(outputs.trace,input);assert.equal(status===1n,trace.error===null,'Receipt/root-exit status must join');
 const channels={stateRoot:hex(r.stateRoot,32)===e.stateRoot,logsHash:gf.hash===pf.hash,receiptStatus:status===BigInt(e.receipt.status),receiptGas:gas===dec(e.gas.totalGasSpent),blockGas:q(r.gasUsed)===max(dec(e.gas.txRegularGas),dec(e.gas.txStateGas)),returnData:trace.output===e.execution.returnData,messageGas:dec(trace.gasUsed)+dec(input.inputGas.topDelegateAccessGas)===dec(e.execution.executionGasUsed),exactLogs:JSON.stringify(pl)===JSON.stringify(gl),logsBloom:pf.bloom===gf.bloom};
 return{status:Object.values(channels).every(Boolean)?'matched':'mismatched',channels,reason:null,observed:{stateRoot:r.stateRoot,logsHash:r.logsHash,receiptStatus:status.toString(),receiptGas:gas.toString(),blockGas:q(r.gasUsed).toString(),root:trace,logs:gl,logsBloom:gf.bloom}};
}
