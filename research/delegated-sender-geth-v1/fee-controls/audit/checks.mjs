import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const REL = 'research/delegated-sender-geth-v1/fee-controls';
export const PINS = Object.freeze({
  manifest: '43d8d063d06ceea69ef3ef3f4a71cac0c227f47fc32c1993212af8fd7b5b6d7a',
  plan: 'd5ae96b7f621ab2d5f3206e0068f65313deeb1cf308d97c02ca22c00f0586c68',
  source: '29e1761097cef073599c05e41c75acce45cdb78f8429c8dde78a4f68f691df86',
  binary: '10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521',
  toolchain: '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333',
});
export const NAMES = Object.freeze(['effective_prepayment','cap_clipped_price','sender_coinbase','self_authorized_sender_coinbase','authorization_authority_coinbase','exact_cap_value_affordability','zero_tip_empty_storage_coinbase','zero_tip_empty_storage_coinbase_revert','shanghai_deleted_coinbase','cancun_preexisting_coinbase','cancun_created_deleted_coinbase','authorization_revert','authorization_out_of_gas','storage_clear_refund','authorization_storage_calldata_floor','priced_root_create']);
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
  return {clean, bytes:total, parsed:clean ? JSON.parse(streams.stdout) : null, ...streams};
}
// Independent raw adjudication: never import the producer's adjudicate helper.
export function classifyGeth(raw, expected) {
  const parsed = parseRaw(raw,{timeout:5000,bytes:1048576});
  if (!parsed.clean) return {status:'unavailable',reason:'process_or_time_failure'};
  const rows = parsed.parsed; assert(Array.isArray(rows) && rows.length === 1);
  const r = rows[0]; assert.deepEqual(Object.keys(r).sort(), (r.error === undefined ? ['fork','name','pass','stateRoot'] : ['error','fork','name','pass','stateRoot']).sort());
  assert.equal(r.name,expected.name); assert.equal(r.fork,expected.fork); assert.equal(typeof r.pass,'boolean');
  assert.match(r.stateRoot,/^0x[0-9a-f]{64}$/); if (r.pass) assert.equal(r.error,undefined); else if (r.error !== undefined) assert.equal(typeof r.error,'string');
  return {status:r.pass && r.stateRoot === expected.stateRoot ? 'matched' : 'mismatched',
    checks:{stateRoot:r.stateRoot === expected.stateRoot,internalLogHash:r.pass},result:r};
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
