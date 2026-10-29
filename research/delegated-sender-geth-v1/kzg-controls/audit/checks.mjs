import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const REL = 'research/delegated-sender-geth-v1/kzg-controls';
export const PINS = Object.freeze({
  binary: '10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521',
  toolchain: '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333',
});
export const NAMES = Object.freeze(['cancun_direct_official_point', 'prague_direct_official_point', 'osaka_direct_official_point', 'bpo1_direct_official_point', 'bpo2_direct_official_point', 'nested_call_value', 'nested_callcode_value', 'nested_delegatecall_value', 'nested_staticcall', 'nested_staticcall_caught_oog', 'nested_call_enclosing_revert', 'direct_incorrect_proof', 'direct_malformed_proof', 'direct_zero_polynomial_infinity', 'direct_exact_precompile_gas', 'direct_below_precompile_gas']);
export const LIMITS = Object.freeze({cases:16,workerMs:20000,workerOutputBytes:16777216,preparationMs:360000,gethPerCaseMs:5000,gethTotalMs:120000,gethOutputBytes:1048576});
export function relative(value) {
  assert.equal(typeof value, 'string'); assert(value.length && !value.includes('\\') && !path.posix.isAbsolute(value));
  assert.equal(path.posix.normalize(value), value); assert(!value.split('/').some(p => p === '..' || p === '.')); return value;
}
export function recordedPaths(plan) {
  assert.equal(typeof plan.sourceRoot, 'string'); assert(path.posix.isAbsolute(plan.sourceRoot));
  assert.equal(path.posix.normalize(plan.sourceRoot), plan.sourceRoot);
  const capture = path.posix.join(plan.sourceRoot, REL, 'capture'); assert.equal(plan.captureDirectory, capture);
  return {capture, runtime:path.posix.join(capture,'runtime'), worker:path.posix.join(capture,'runtime',REL,'worker.mjs')};
}
export function parseRaw(raw, { timeout, bytes }) {
  assert.equal(raw.processCompletion, 'spawnSync_returned_after_child_and_pipes_closed');
  assert(Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs > 0 && raw.timeoutMs <= timeout);
  assert(Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0);
  assert(raw.exitCode === null || Number.isSafeInteger(raw.exitCode));
  assert(raw.signal === null || typeof raw.signal === 'string'); assert(raw.error === null || typeof raw.error === 'string');
  const streams = {};
  for (const name of ['stdout','stderr']) {
    const s = raw[name]; assert.equal(typeof s.base64, 'string');
    const b = Buffer.from(s.base64,'base64'); assert.equal(b.toString('base64'), s.base64);
    assert.equal(b.length,s.bytes); assert.equal(sha(b),s.sha256);
    streams[name] = new TextDecoder('utf-8',{fatal:true}).decode(b);
  }
  const total = raw.stdout.bytes + raw.stderr.bytes; assert(total <= bytes);
  const clean = raw.exitCode === 0 && raw.signal === null && raw.error === null && raw.elapsedMs <= raw.timeoutMs;
  let parsed = null, jsonValid = false;
  if (clean) { try { parsed = JSON.parse(streams.stdout); jsonValid = true; } catch { /* Retain a closed malformed process as unavailable. */ } }
  return {clean, bytes:total, parsed, jsonValid, ...streams};
}
// Independent raw adjudication: never import the producer's adjudicate helper.
export function classifyGeth(raw, expected) {
  const parsed = parseRaw(raw,{timeout:5000,bytes:1048576});
  if (!parsed.clean) return {status:'unavailable',reason:raw.error??'process_or_time_failure'};
  try {
    assert(parsed.jsonValid); const rows = parsed.parsed; assert(Array.isArray(rows) && rows.length === 1);
    const r = rows[0]; assert.deepEqual(Object.keys(r).sort(), (r.error === undefined ? ['fork','name','pass','stateRoot'] : ['error','fork','name','pass','stateRoot']).sort());
    assert.equal(r.name,expected.name); assert.equal(r.fork,expected.fork); assert.equal(typeof r.pass,'boolean');
    assert.match(r.stateRoot,/^0x[0-9a-f]{64}$/); if (r.pass) assert.equal(r.error,undefined); else if (r.error !== undefined) assert.equal(typeof r.error,'string');
    return {status:r.pass && r.stateRoot === expected.stateRoot ? 'matched' : 'mismatched',
      checks:{stateRoot:r.stateRoot === expected.stateRoot,internalLogHash:r.pass},result:r};
  } catch { return {status:'unavailable',reason:'invalid_or_foreign_result'}; }
}
export function checkTiming(results) {
  assert.equal(results.status,'complete'); assert.equal(results.comparisonsUsable,true); assert.equal(results.sourceUnchanged,true); assert.equal(results.fatal,null);
  let sum = 0;
  for (const [name,limit] of [['preparation',360000],['geth',120000]]) {
    const t = results.phaseTimings[name]; assert.equal(t.status,'within_budget'); assert.equal(t.clockValid,true); assert.equal(t.limitMs,limit);
    for (const n of [t.wallElapsedMs,t.monotonicElapsedMs]) assert(Number.isFinite(n) && n >= 0 && n <= limit);
    sum += t.monotonicElapsedMs;
  }
  assert(Number.isFinite(results.elapsedMs) && results.elapsedMs >= sum && results.elapsedMs - sum < 1000);
}
export function bindProcess(raw, {binary,args}) { assert.equal(raw.binary,binary); assert.deepEqual(raw.args,args); }
export function storageWords(allocation) {
  for (const a of Object.values(allocation)) for (const [k,v] of Object.entries(a.storage)) {
    assert.match(k,/^0x[0-9a-f]{64}$/); assert.match(v,/^0x[0-9a-f]{64}$/);
  }
}

// Independent fixed-input binding; no producer case builder or cryptographic execution.
export function bindKzgDeclaration(input,index,officialBytes){
  assert.equal(sha(officialBytes),'e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d');
  const vector=JSON.parse(officialBytes)[0],original=Buffer.from(vector.Input,'hex'),data=Buffer.from(original);
  assert.equal(original.length,192);assert.equal(vector.Gas,50000);
  if(index===11){const n=BigInt('0x'+data.subarray(64,96).toString('hex'))+1n;Buffer.from(n.toString(16).padStart(64,'0'),'hex').copy(data,64);}
  if(index===12)data.fill(0,144,192);
  if(index===13){data.fill(0);data[96]=0xc0;data[144]=0xc0;const h=createHash('sha256').update(data.subarray(96,144)).digest();h[0]=1;h.copy(data,0);}
  const r=input.request,a=input.allocation,target='0x4444444444444444444444444444444444444444',sender='0x1a642f0e3c3af545e7acbd38b07251b3990914f1',coinbase='0x9999999999999999999999999999999999999999';
  const nested=index>=5&&index<=10;
  assert.equal(r.data,'0x'+data.toString('hex'));assert.equal(r.from,sender);assert.equal(r.to,nested?target:'0x000000000000000000000000000000000000000a');
  assert.equal(r.value,'19');assert.deepEqual(r.fees,{maxFeePerGas:'13',maxPriorityFeePerGas:'3'});
  assert.equal(r.gas,index<14?'200000':String(21000+Array.from(data).reduce((n,b)=>n+(b===0?4:16),0)+(index===14?50000:49999)));
  assert.equal(input.fork,index<5?['Cancun','Prague','Osaka','BPO1','BPO2'][index]:index>=14?'Cancun':'Osaka');
  assert.equal(input.header.baseFeePerGas,'0x7');assert.equal(input.header.excessBlobGas,'0x0');assert.equal(input.header.blobGasUsed,'0x0');assert.equal(input.header.miner,coinbase);
  assert.deepEqual(a[sender],{nonce:'0x1',balance:'0xe8d4a51000',code:'0x',storage:{}});
  assert.deepEqual(a[coinbase],{nonce:'0x1',balance:'0x1',code:'0x',storage:{}});
  let code='0x00';
  if(nested){const kind=['f1','f2','f4','fa','fa','f1'][index-5],value=['f1','f2'].includes(kind)?'6005':'';
    code='0x602a60035536600060003760406000366000'+value+'600a62'+(index===9?'00c34f':'00c350')+kind+'60405260005160005560205160015560405160025560a160606000a160606000'+(index===10?'fd':'f3');}
  assert.deepEqual(a[target],{nonce:'0x1',balance:'0x64',code,storage:{}});
  assert.equal(a['0x000000000000000000000000000000000000000a'],undefined);
}
