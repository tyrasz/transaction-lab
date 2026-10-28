import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { adjudicate, dispatch, exactPattern, fixturePost, inside, verify, sha, LIMITS } from './run.mjs';

const id='unrelated/parser[id].*(one)+$',stateRoot='0x'+'11'.repeat(32),other='0x'+'22'.repeat(32);
const expected={id,stateRoot};
const row={name:id,fork:'Osaka',pass:true,stateRoot};
const raw=(r=row,more={})=>({reason:null,exitCode:0,signal:null,stdout:JSON.stringify([r]),...more});

test('exact regex protects metacharacters and matches only the selected ID',()=>{
  const regex=new RegExp(exactPattern(id));assert(regex.test(id));assert(!regex.test(id+'x'));assert(!regex.test('x'+id));
  assert.throws(()=>exactPattern(''));assert.throws(()=>exactPattern('x'.repeat(4096)));
});
test('positive result reports only root and Geth internal log assertion',()=>{
  const result=adjudicate(raw(),expected);assert.equal(result.status,'matched');
  assert.deepEqual(result.checks,{reportedPass:true,stateRoot:true,logHashCheckedByGeth:true});
  assert.match(result.scope,/receipt\/gas\/return not checked/);
});
test('exit zero with pass false is a mismatch even when root agrees',()=>{
  const r=adjudicate(raw({...row,pass:false,error:'logs hash mismatch'}),expected);
  assert.equal(r.status,'mismatched');assert.equal(r.checks.logHashCheckedByGeth,false);
});
test('wrong root cannot pass irrespective of reported pass flag',()=>{
  for(const pass of [false,true])assert.equal(adjudicate(raw({...row,pass,stateRoot:other}),expected).status,'mismatched');
});
test('missing execution root is unavailable, never a fixture match',()=>{
  assert.equal(adjudicate(raw({name:id,fork:'Osaka',pass:false,error:'cannot execute'}),expected).status,'unavailable');
});
test('foreign, ambiguous, malformed and unsupported output all withhold results',()=>{
  for(const value of [[],[row,row],{},[{...row,name:'other'}],[{...row,fork:'Cancun'}],[{...row,pass:1}],[{...row,stateRoot:'0x12'}],[{...row,error:'bad'}],[{...row,stateRoot:undefined}],[{...row,state:{}}]])
    assert.equal(adjudicate(raw(row,{stdout:JSON.stringify(value)}),expected).status,'unavailable');
  assert.equal(adjudicate(raw(row,{stdout:'not json'}),expected).status,'unavailable');
});
test('process failure always overrides a valid-looking result',()=>{
  for(const more of [{exitCode:1},{signal:'SIGKILL'},{reason:'case_deadline'},{reason:'output_limit'}])assert.equal(adjudicate(raw(row,more),expected).status,'unavailable');
});
test('safe relative path rejects escape, aliases, empty and absolute paths',()=>{
  assert.equal(inside('/tmp/control','a/b.json'),'/tmp/control/a/b.json');
  for(const p of ['../x','/x','a/../x','a//b','a/./b','','a/'])assert.throws(()=>inside('/tmp/control',p));
});
test('fixture admission requires original identity and exactly one Osaka post',()=>{
  const item={fork:'Osaka',postIndex:0,fixtureHash:other};
  const f={_info:{hash:other},config:{chainid:'0x01'},post:{Osaka:[{hash:stateRoot,logs:other}]}};
  assert.deepEqual(fixturePost(f,item),f.post.Osaka[0]);
  const bad=[{...f,_info:{hash:stateRoot}},{...f,config:{chainid:'0x02'}},{...f,post:{Osaka:[...f.post.Osaka,...f.post.Osaka]}},{...f,post:{Cancun:f.post.Osaka}},{...f,post:{Osaka:[{...f.post.Osaka[0],expectException:''}]}}];
  for(const value of bad)assert.throws(()=>fixturePost(value,item));
  assert.throws(()=>fixturePost(f,{...item,postIndex:1}));
});

function fakeSpawn(action,inspect=()=>{}) {
  return (binary,args,options)=>{
    inspect(binary,args,options);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    let closed=false;child.finish=(code=0,signal=null)=>{if(!closed){closed=true;child.emit('close',code,signal);}};
    child.kill=signal=>{queueMicrotask(()=>child.finish(null,signal));return true;};queueMicrotask(()=>action(child));return child;
  };
}
test('dispatch records exact command, minimal environment and both raw streams',async()=>{
  const r=await dispatch({binary:'/tmp/evm',input:'/tmp/frozen/one.json',id,spawnImpl:fakeSpawn(c=>{
    c.stdout.emit('data',Buffer.from(JSON.stringify([row])));c.stderr.emit('data',Buffer.from('diagnostic'));c.finish();
  },(binary,args,options)=>{
    assert.equal(binary,'/tmp/evm');assert.deepEqual(args,['statetest','--statetest.fork=Osaka','--run='+exactPattern(id),'/tmp/frozen/one.json']);
    assert.deepEqual(options.env,{PATH:'/usr/bin:/bin',GOMAXPROCS:'2',GOMEMLIMIT:'256MiB'});assert.equal(options.cwd,'/tmp/frozen');
  })});
  assert.equal(r.stderr,'diagnostic');assert.equal(adjudicate(r,expected).status,'matched');
});
test('dispatch bounds combined output and invalidates a prior valid prefix',async()=>{
  const r=await dispatch({binary:'/tmp/evm',input:'/tmp/one',id,spawnImpl:fakeSpawn(c=>{
    c.stdout.emit('data',Buffer.from(JSON.stringify([row])));c.stderr.emit('data',Buffer.alloc(LIMITS.outputBytes));
  })});
  assert.equal(r.reason,'output_limit');assert.equal(r.signal,'SIGKILL');assert.equal(adjudicate(r,expected).status,'unavailable');
  assert(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=LIMITS.outputBytes);
});
test('dispatch timeout kills and remains unavailable',async()=>{
  const r=await dispatch({binary:'/tmp/evm',input:'/tmp/one',id,timeoutMs:10,spawnImpl:fakeSpawn(()=>{})});
  assert.equal(r.reason,'case_deadline');assert.equal(r.signal,'SIGKILL');
});
test('dispatch retains synchronous and asynchronous spawn failures',async()=>{
  const options={binary:'/tmp/evm',input:'/tmp/one',id};
  assert.equal((await dispatch({...options,spawnImpl:()=>{throw Error('spawn');}})).reason,'spawn_failure');
  const r=await dispatch({...options,spawnImpl:fakeSpawn(c=>{c.emit('error',Error('ENOENT'));c.finish(-2);})});assert.equal(r.reason,'spawn_failure');
});
test('dispatch rejects invalid execution limits before spawning',async()=>{
  for(const timeoutMs of [0,-1,Infinity,NaN,LIMITS.perCaseMs+1])await assert.rejects(dispatch({binary:'/tmp/evm',input:'/tmp/one',id,timeoutMs,spawnImpl:()=>{throw Error('should not spawn');}}));
});
test('unconfirmed process close settles within bounded grace and cannot pass',async()=>{
  let killed=0;const started=performance.now();
  const r=await dispatch({binary:'/tmp/evm',input:'/tmp/one',id,timeoutMs:10,closeGraceMs:10,spawnImpl:fakeSpawn(c=>{c.kill=()=>{killed++;return false;};})});
  assert.equal(r.processClosed,false);assert.equal(r.reason,'case_deadline');assert(killed>0);assert(performance.now()-started<1000);assert.equal(adjudicate(r,expected).status,'unavailable');
});
test('invalid UTF8 is retained byte-for-byte and cannot yield a match',async()=>{
  const bytes=Buffer.from([255]);const r=await dispatch({binary:'/tmp/evm',input:'/tmp/one',id,spawnImpl:fakeSpawn(c=>{
    c.stdout.emit('data',Buffer.from(JSON.stringify([row])));c.stderr.emit('data',bytes);c.finish();
  })});
  assert.equal(r.reason,'invalid_utf8');assert.equal(r.stderr,null);assert.deepEqual(r.stderrRaw,{base64:'/w==',bytes:1,sha256:sha(bytes)});assert.equal(adjudicate(r,expected).status,'unavailable');
});
test('verification requires explicit external plan identity before reading files',async()=>{
  await assert.rejects(verify('/nonexistent/capture'),/Explicit external plan hash/);
  await assert.rejects(verify('/nonexistent/capture','bad'),/Explicit external plan hash/);
});
