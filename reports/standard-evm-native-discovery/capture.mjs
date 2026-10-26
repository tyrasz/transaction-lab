// Bounded development-case discovery. Never signs, broadcasts or funds an account.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const DIR = new URL('./', import.meta.url), sha = b => createHash('sha256').update(b).digest('hex');
const plan = JSON.parse(await fs.readFile(new URL('plan.json', DIR)));
assert.equal(plan.scriptSha256, sha(await fs.readFile(import.meta.url.startsWith('file:') ? new URL(import.meta.url) : import.meta.url)));
const tracer = { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } };
const ledger = { startedAt: new Date().toISOString(), endpoint: plan.endpoint, planSha256: sha(await fs.readFile(new URL('plan.json', DIR))), requests: [], observedBytes: 0, retainedBytes: 0, candidates: [], selected: null };
const started = performance.now();
await fs.mkdir(new URL('raw/', DIR), { recursive: true });
await fs.writeFile(new URL('STARTED', DIR), ledger.startedAt + '\n', { flag: 'wx' });
async function checkpoint() { await fs.writeFile(new URL('progress.json', DIR), JSON.stringify(ledger, null, 2) + '\n'); }
async function rpc(method, params) {
  assert.ok(plan.methods.includes(method), 'Unplanned RPC method.');
  if (ledger.requests.length >= plan.limits.requests || ledger.observedBytes >= plan.limits.totalBytes || performance.now() - started >= plan.limits.wallMs) throw new Error('Discovery budget exhausted.');
  const id = ledger.requests.length + 1, name = String(id).padStart(3, '0'), request = { jsonrpc: '2.0', id, method, params };
  const requestText = JSON.stringify(request), record = { id, request, requestText, requestSha256: sha(requestText), startedAt: new Date().toISOString() };
  ledger.requests.push(record); await checkpoint();
  const controller = new AbortController(), began = performance.now();
  const timeoutMs = Math.min(plan.limits.requestMs, plan.limits.wallMs - (began - started));
  let timer, reader, complete = false, status, bytes = 0, kept = 0;
  const chunks = [], digest = createHash('sha256');
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out.')); }, timeoutMs); });
  const check = () => { if (performance.now() - began >= timeoutMs || performance.now() - started >= plan.limits.wallMs) throw new Error('Request timed out.'); };
  let result;
  try {
    const fetching = fetch(plan.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText, redirect: 'error', signal: controller.signal });
    fetching.then(r => { if (controller.signal.aborted) Promise.resolve(r.body?.cancel()).catch(() => {}); }).catch(() => {});
    const response = await Promise.race([fetching, deadline]); check(); status = response.status;
    reader = response.body.getReader();
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); check();
      if (part.done) { complete = true; break; }
      const data = Buffer.from(part.value); bytes += data.length; ledger.observedBytes += data.length; digest.update(data);
      const room = Math.min(plan.limits.responseBytes - kept, plan.limits.totalBytes - ledger.retainedBytes), prefix = data.subarray(0, Math.max(0, room));
      chunks.push(prefix); kept += prefix.length; ledger.retainedBytes += prefix.length;
      if (prefix.length !== data.length) throw new Error('Response byte budget exhausted.');
    }
    const body = Buffer.concat(chunks), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), parsed = JSON.parse(text);
    record.response = parsed; check();
    assert.equal(response.ok, true); assert.equal(parsed.jsonrpc, '2.0'); assert.equal(parsed.id, id);
    assert.notEqual(Object.hasOwn(parsed, 'error'), Object.hasOwn(parsed, 'result'));
    if (Object.hasOwn(parsed, 'error')) { record.status = 'rpc_error'; return null; }
    result = parsed.result; record.status = 'success';
  } catch { record.status = 'transport_validation_or_budget_failure'; }
  finally {
    clearTimeout(timer); if (!complete) { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }
    const body = Buffer.concat(chunks);
    Object.assign(record, { httpStatus: status ?? null, completedAt: new Date().toISOString(), durationMs: performance.now() - began,
      raw: { file: 'raw/' + name + '.body', complete, observedBytes: bytes, bytes: kept, observedPrefixSha256: digest.digest('hex'), sha256: sha(body) } });
    await fs.writeFile(new URL(record.raw.file, DIR), body, { flag: 'wx' });
    await fs.writeFile(new URL('raw/' + name + '.json', DIR), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await checkpoint();
  }
  return result ?? null;
}

const lower=value=>value.toLowerCase(),hex=n=>'0x'+BigInt(n).toString(16);
try {
  assert.equal(await rpc('eth_chainId',[]),'0x1');
  const source=await rpc('eth_getBlockByNumber',['latest',true]);assert.ok(source?.hash&&Array.isArray(source.transactions));ledger.source=source;
  const parent=await rpc('eth_getBlockByHash',[source.parentHash,false]);assert.ok(parent&&parent.hash===source.parentHash&&BigInt(parent.number)+1n===BigInt(source.number));ledger.parent=parent;
  const pinned={blockHash:parent.hash,requireCanonical:true};
  const candidateTransactions=source.transactions.filter(tx=>tx&&typeof tx==='object'&&tx.to&&tx.input==='0x'&&BigInt(tx.value)>0n&&lower(tx.from)!==lower(tx.to)).slice(0,plan.limits.candidates);
  ledger.candidateOrder=candidateTransactions.map(tx=>tx.hash);
  for(const tx of candidateTransactions){
    const first=ledger.requests.length+1,c={hash:tx.hash,transaction:tx,status:'started',requestIds:[]};ledger.candidates.push(c);
    try {
      assert.equal(tx.blockHash,source.hash);assert.equal(tx.blockNumber,source.number);assert.equal(source.transactions[Number(BigInt(tx.transactionIndex))].hash,tx.hash);
      c.senderCode=await rpc('eth_getCode',[tx.from,pinned]);c.recipientCode=await rpc('eth_getCode',[tx.to,pinned]);
      if(c.senderCode!=='0x'||c.recipientCode!=='0x'){c.status='rejected_nonempty_or_unavailable_account_code';continue;}
      c.senderBalanceBefore=await rpc('eth_getBalance',[tx.from,pinned]);c.recipientBalanceBefore=await rpc('eth_getBalance',[tx.to,pinned]);c.senderNonceBefore=await rpc('eth_getTransactionCount',[tx.from,pinned]);
      assert.ok(c.senderBalanceBefore!==null&&c.recipientBalanceBefore!==null&&c.senderNonceBefore!==null);
      const request={from:lower(tx.from),to:lower(tx.to),data:tx.input,value:tx.value,gas:'0x4c4b40'};c.parentRequest=request;
      c.parentTrace=await rpc('debug_traceCall',[request,parent.hash,tracer]);
      if(!c.parentTrace){c.status='parent_simulation_unavailable';continue;}
      const trace=c.parentTrace;assert.equal(trace.type,'CALL');assert.equal(lower(trace.from),request.from);assert.equal(lower(trace.to),request.to);assert.equal(trace.input,request.data);assert.equal(BigInt(trace.value),BigInt(request.value));assert.equal(BigInt(trace.gas),5000000n);
      if(trace.error||trace.revertReason){c.status='parent_simulation_reverted';continue;}
      assert.equal((trace.calls??[]).length,0);assert.equal((trace.logs??[]).length,0);assert.equal(trace.output??'0x','0x');
      c.parentDiff=await rpc('debug_traceCall',[request,parent.hash,{tracer:'prestateTracer',timeout:'15s',tracerConfig:{diffMode:true}}]);
      assert.ok(c.parentDiff?.pre&&c.parentDiff?.post);
      const pre=c.parentDiff.pre,post=c.parentDiff.post,sender=request.from,recipient=request.to,value=BigInt(tx.value),senderBefore=BigInt(c.senderBalanceBefore),recipientBefore=BigInt(c.recipientBalanceBefore),nonce=BigInt(c.senderNonceBefore);
      for(const side of [pre,post])for(const[account,record]of Object.entries(side)){assert.ok([sender,recipient].includes(lower(account)));assert.ok(Object.keys(record).every(key=>['balance','nonce'].includes(key)));}
      assert.equal(BigInt(pre[sender]?.balance??(senderBefore===0n?'0':'-1')),senderBefore);assert.equal(BigInt(pre[sender]?.nonce??(nonce===0n?'0':'-1')),nonce);
      assert.equal(BigInt(post[sender]?.balance??'0'),senderBefore-value);assert.equal(BigInt(post[sender]?.nonce),nonce+1n);
      assert.equal(BigInt(pre[recipient]?.balance??(recipientBefore===0n?'0':'-1')),recipientBefore);assert.equal(BigInt(post[recipient]?.balance),recipientBefore+value);
      c.validatedNativeChanges=[{account:sender,beforeRaw:senderBefore.toString(),afterRaw:(senderBefore-value).toString(),deltaRaw:(-value).toString()},{account:recipient,beforeRaw:recipientBefore.toString(),afterRaw:(recipientBefore+value).toString(),deltaRaw:value.toString()}];
      c.receipt=await rpc('eth_getTransactionReceipt',[tx.hash]);assert.ok(c.receipt&&c.receipt.transactionHash===tx.hash&&c.receipt.blockHash===source.hash&&c.receipt.transactionIndex===tx.transactionIndex&&c.receipt.status==='0x1');
      c.originalTrace=await rpc('debug_traceTransaction',[tx.hash,tracer]);assert.ok(c.originalTrace&&!c.originalTrace.error&&!c.originalTrace.revertReason);assert.equal(lower(c.originalTrace.from),sender);assert.equal(lower(c.originalTrace.to),recipient);assert.equal(c.originalTrace.input,tx.input);assert.equal(BigInt(c.originalTrace.value),value);
      c.status='selected';ledger.selected={hash:tx.hash,request,parentHash:parent.hash,parentNumber:parent.number,sourceBlockHash:source.hash,sourceBlockNumber:source.number,sourceTransactionIndex:tx.transactionIndex};
      c.finalSourceBlock=await rpc('eth_getBlockByNumber',[source.number,true]);c.finalParentBlock=await rpc('eth_getBlockByNumber',[parent.number,false]);
      try {assert.deepEqual(c.finalSourceBlock,source);assert.deepEqual(c.finalParentBlock,parent);c.canonicalRecheck=true;}catch{c.canonicalRecheck=false;c.status='selected_but_canonical_unconfirmed';}
      break;
    }catch{c.status='candidate_validation_or_budget_failure';}
    finally{c.requestIds=Array.from({length:ledger.requests.length-first+1},(_,i)=>first+i);await checkpoint();}
  }
  ledger.status=ledger.selected?(ledger.candidates.at(-1).canonicalRecheck?'candidate_found':'candidate_found_but_canonical_unconfirmed'):'no_candidate_found_within_frozen_bounds';
}catch{ledger.status='discovery_validation_or_budget_failure';}
ledger.completedAt=new Date().toISOString();ledger.durationMs=performance.now()-started;
await fs.writeFile(new URL('capture.json',DIR),JSON.stringify(ledger,null,2)+'\n',{flag:'wx',mode:0o444});await checkpoint();
console.log(JSON.stringify({status:ledger.status,requests:ledger.requests.length,observedBytes:ledger.observedBytes,candidates:ledger.candidates.map(x=>({hash:x.hash,status:x.status})),selected:ledger.selected},null,2));
