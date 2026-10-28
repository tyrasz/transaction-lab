import test from 'node:test';
import assert from 'node:assert/strict';
import {sha, parseRaw, classify, storageEncodingOnly, recordedCapturePaths} from './checks.mjs';
const expected = {name:'storage_clear_refund',fork:'Osaka',stateRoot:'0x'+'12'.repeat(32)};
const stream = value => { const b=Buffer.from(value); return {base64:b.toString('base64'),bytes:b.length,sha256:sha(b)}; };
const raw = () => ({processCompletion:'spawnSync_returned_after_child_and_pipes_closed',timeoutMs:5000,elapsedMs:1,exitCode:0,signal:null,error:null,stdout:stream(JSON.stringify([{...expected,pass:true}])),stderr:stream('')});
test('clean exact match; false assertion is mismatch and process failure unavailable',()=>{
  assert.equal(classify(raw(),expected),'matched');
  const failed=raw();failed.stdout=stream(JSON.stringify([{...expected,pass:false,error:'logs mismatch'}]));assert.equal(classify(failed,expected),'mismatched');
  for(const edit of [{exitCode:1},{signal:'SIGTERM'},{error:{code:'ETIMEDOUT'}},{elapsedMs:5001}])assert.equal(classify({...raw(),...edit},expected),'unavailable');
});
test('reject forged, truncated, malformed and foreign raw output',()=>{
  const a=raw();a.stdout.bytes++;assert.throws(()=>parseRaw(a,5000));
  const b=raw();b.stdout.base64+='!';assert.throws(()=>parseRaw(b,5000));
  const c=raw();c.stdout=stream(Buffer.from([255]));assert.throws(()=>parseRaw(c,5000));
  const d=raw();d.stdout=stream(JSON.stringify([{...expected,name:'foreign',pass:true}]));assert.throws(()=>classify(d,expected));
  const e=raw();e.stdout=stream(JSON.stringify([{...expected,pass:true,extra:1}]));assert.throws(()=>classify(e,expected));
});
const original=()=>({storage_clear_refund:{pre:{a:{nonce:'0x0',balance:'0x7',code:'0x',storage:{key:'0x7'}}},env:{number:'0x1'},transaction:{data:['0x'],authorizationList:[{v:'0x0'}]},post:{Osaka:[{hash:'root',logs:'logs',txbytes:'signed'}]}}});
test('only uint256-preserving storage values change; all other input and expectations remain exact',()=>{
  const old=original(),fixed=structuredClone(old);fixed.storage_clear_refund.pre.a.storage.key='0x'+'0'.repeat(63)+'7';
  assert.equal(storageEncodingOnly(old,fixed).length,1);
  for(const mutate of [x=>x.pre.a.storage.key='0x'+'0'.repeat(63)+'8',x=>x.pre.a.nonce='0x1',x=>x.pre.a.code='0x00',x=>x.env.number='0x2',x=>x.transaction.authorizationList[0].v='0x1',x=>x.post.Osaka[0].hash='other',x=>x.post.Osaka[0].logs='other',x=>x.post.Osaka[0].txbytes='other']){const bad=structuredClone(fixed);mutate(bad.storage_clear_refund);assert.throws(()=>storageEncodingOnly(old,bad));}
});
test('invalid or oversized logical storage values rejected',()=>{
  for(const value of ['0x','-1','0x'+'1'.repeat(65)]){const old=original();old.storage_clear_refund.pre.a.storage.key=value;assert.throws(()=>storageEncodingOnly(old,old));}
});
test('recorded process paths bind frozen roots independently of the current checkout',()=>{
  const frozenRoot='/original/worktree',currentRoot='/merged/main';
  const rel='research/delegated-sender-geth-v1/authorization-controls/capture';
  const recorded=recordedCapturePaths(frozenRoot,frozenRoot+'/'+rel);
  assert.equal(recorded.original,frozenRoot+'/'+rel);
  assert.notEqual(recorded.original,currentRoot+'/'+rel);
  assert.equal(recorded.followup,frozenRoot+'/research/delegated-sender-geth-v1/authorization-controls/storage-encoding-followup/capture');
  assert.throws(()=>recordedCapturePaths(frozenRoot,currentRoot+'/'+rel));
  assert.throws(()=>recordedCapturePaths('/original/../worktree'));
  assert.throws(()=>recordedCapturePaths('relative'));
});
