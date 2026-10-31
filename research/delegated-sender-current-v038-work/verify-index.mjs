// Verify the staged immutable packets, including normally ignored dependencies.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const packets=[
 ['research/delegated-sender-current-v038/capture-001','3c845b025d9a722e5afa00406d87763656cd38fb6c4ca2bede6ba1918d9115e9'],
 ['research/delegated-sender-current-v038/prepared-001','d7bc4c4fb3199ba1393fd2a8e3012155d1e8b8aa3f0ec84b1fe0af93f1a4ae7e'],
];
const results=[];
for(const [prefix,pin]of packets){
 const bytes=fs.readFileSync(path.join(root,prefix,'manifest.json'));assert.equal(sha(bytes),pin);
 const manifest=JSON.parse(bytes),rows=[...manifest.files,{path:'manifest.json',kind:'file',mode:420,bytes:bytes.length,sha256:pin}];
 const expected=new Map(rows.map(r=>[prefix+'/'+r.path,r]));
 const lines=execFileSync('git',['ls-files','--stage','-z','--',prefix],{cwd:root}).toString().split('\0').filter(Boolean);
 const staged=lines.map(line=>{const match=/^(\d+) ([a-f0-9]+) 0\t(.+)$/.exec(line);assert(match);return{mode:match[1],oid:match[2],path:match[3]};});
 assert.deepEqual(staged.map(r=>r.path).sort(),[...expected.keys()].sort());
 const blobs=execFileSync('git',['cat-file','--batch'],{cwd:root,input:staged.map(r=>r.oid+'\n').join(''),maxBuffer:128*1024*1024});
 let offset=0,totalBytes=0;
 for(const r of staged){
  const end=blobs.indexOf(10,offset);assert(end>=offset);const [oid,type,size]=blobs.subarray(offset,end).toString().split(' ');
  assert.equal(oid,r.oid);assert.equal(type,'blob');const n=Number(size);assert(Number.isSafeInteger(n)&&n>=0);
  const body=blobs.subarray(end+1,end+1+n);assert.equal(body.length,n);assert.equal(blobs[end+1+n],10);offset=end+n+2;
  const e=expected.get(r.path);if(e.kind==='symlink'){assert.equal(r.mode,'120000');assert.equal(body.toString(),e.target);}
  else{assert.equal(r.mode,e.mode&64?'100755':'100644');assert.equal(body.length,e.bytes);assert.equal(sha(body),e.sha256);}
  totalBytes+=n;
 }
 assert.equal(offset,blobs.length);results.push({path:prefix,manifestSha256:pin,trackedFiles:staged.length,stagedBytesVerified:totalBytes});
}
console.log(JSON.stringify({status:'verified',packets:results,networkCalls:0,targetsExecuted:0},null,2));
