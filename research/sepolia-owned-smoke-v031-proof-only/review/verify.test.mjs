import test from 'node:test';
import assert from 'node:assert/strict';
import {audit,loadPacket,inspectSemantics,accountLeaf,headerIdentity,wireEvidence,sha} from './verify.mjs';
const packet=loadPacket(),copy=()=>structuredClone(packet);
const wires=p=>[1,2,3,4,5,6].map(i=>p[`wire-0${i}.json`]);
const proof=(p,index)=>JSON.parse(Buffer.from(p[`wire-0${index+3}.json`].responseBase64,'base64')).result;
const rejoin=p=>{p['results.json'].preview=structuredClone(p['preview.json']);return p;};

test('full fixed artifact/source inventory and independently derived saved semantics pass',()=>{
  const r=audit();assert.equal(r.artifactFiles,17);assert.equal(r.implementationEntries,1720);assert.equal(r.usable,true);assert.equal(r.accounts.length,2);assert.equal(r.header.headerFields,23);assert.equal(r.publicHttpStatus,400);
});

test('both account proofs reject altered key/root/leaf facts/node bytes and extra nodes',()=>{
  for(const[i,address]of ['0x6efb29cee3b414272eb7a8f3ebabf873d36bc033','0x000000000000000000000000000000000000dead'].entries()){
    const a=proof(packet,i),root=packet['header.json'].stateRoot;
    for(const patch of [{nonce:'0x1'},{balance:'0x0'},{codeHash:'0x'+'00'.repeat(32)},{storageHash:'0x'+'00'.repeat(32)},{storageProof:[{}]},{accountProof:[...a.accountProof,a.accountProof.at(-1)]}])assert.throws(()=>accountLeaf(root,address,{...a,...patch},9-i));
    assert.throws(()=>accountLeaf('0x'+'00'.repeat(32),address,a,9-i));
    assert.throws(()=>accountLeaf(root,'0x'+'12'.repeat(20),{...a,address:'0x'+'12'.repeat(20)},9-i));
    const changed=structuredClone(a);changed.accountProof[0]=changed.accountProof[0].slice(0,-2)+'ff';assert.throws(()=>accountLeaf(root,address,changed,9-i));
  }
});

test('each of all 23 header fields is bound to the stored block hash',()=>{
  const h=packet['header.json'];
  const keys=['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash','blockAccessListHash','slotNumber'];
  const quantities=new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas','slotNumber']);
  for(const key of keys){const x=structuredClone(h);x[key]=quantities.has(key)?'0x'+(BigInt(h[key])+1n).toString(16):h[key].slice(0,-1)+(h[key].endsWith('0')?'1':'0');assert.throws(()=>headerIdentity(x),key);}
  assert.throws(()=>headerIdentity({...h,slotNumber:'0x0aee7fc'}));
});

test('raw response identity, transport timing, fake code wire and final-header drift are rejected',()=>{
  let p=copy();p['wire-03.json'].responseBase64='AA==';assert.throws(()=>wireEvidence(wires(p)));
  p=copy();p['wire-03.json'].finished.monotonicMs=-1;assert.throws(()=>wireEvidence(wires(p)));
  p=copy();const w=p['wire-04.json'],req=JSON.parse(w.requestText);req.method='eth_getCode';req.params.splice(1,1);w.requestText=JSON.stringify(req);w.requestSha256=sha(w.requestText);w.requestBytes=Buffer.byteLength(w.requestText);assert.throws(()=>inspectSemantics(p));
  p=copy();p['final-header.json'].hash='0x'+'00'.repeat(32);assert.throws(()=>inspectSemantics(p));
  p=copy();p['PRODUCT_SEALED.json'].timestamp={wallMs:90000,monotonicMs:90000,elapsedMs:90000};assert.throws(()=>inspectSemantics(p));
});

test('derived code cannot masquerade as a supplied response or lose its proof join',()=>{
  for(const patch of [{codeEvidenceId:1},{codeDerivation:'rpc_code_response'},{proofEvidenceId:2}]){
    const p=copy();for(const view of[p['preview.json'].preview,p['preview.json'].preview.original])Object.assign(view.inputs.provenance[0],patch);assert.throws(()=>inspectSemantics(rejoin(p)));
  }
  const p=copy();for(const view of[p['preview.json'].preview,p['preview.json'].preview.original])view.inputEvidence[0].result.balance='0x0';assert.throws(()=>inspectSemantics(rejoin(p)));
});

test('coherently repeated nonce/value/measurement forgeries fail independent arithmetic',()=>{
  let p=copy();p['preview.json'].preview.original.changes.accounts[0].nonce.after='0xb6c9e';assert.throws(()=>inspectSemantics(rejoin(p)));
  p=copy();const q=p['preview.json'].preview;q.original.changes.accounts[1].balance.after='0x933f384b3d8e0bd9d7';for(const m of q.measurements){m.after.changesBefore=structuredClone(q.original.changes);m.after.changesAfter=structuredClone(q.original.changes);}q.measurements[1].values[0].afterRaw='2716226852586137573847';q.measurements[1].values[0].deltaRaw='1000000000000001';q.measurements[1].after.values[0].raw='2716226852586137573847';assert.throws(()=>inspectSemantics(rejoin(p)));
  p=copy();p['preview.json'].preview.measurements[0].before.changesAfter.accounts=[{}];assert.throws(()=>inspectSemantics(rejoin(p)));
  p=copy();p['preview.json'].preview.original.output.profile.feesSettled=true;assert.throws(()=>inspectSemantics(rejoin(p)));
  p=copy();p['results.json'].transport.terminalAfterIntegrity={wallMs:120001,monotonicMs:120001,elapsedMs:120001};assert.throws(()=>inspectSemantics(p));
});
