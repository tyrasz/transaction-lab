import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
export function walk(root,relative=''){return fs.readdirSync(path.join(root,relative)).sort().flatMap(n=>{const p=relative?relative+'/'+n:n,s=fs.lstatSync(path.join(root,p));return s.isDirectory()?walk(root,p):[p];}).sort();}
export function safe(p){assert(typeof p==='string'&&p&&!path.isAbsolute(p)&&!p.includes('\\')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'));return p;}
export function entry(root,p){safe(p);const full=path.join(root,p),s=fs.lstatSync(full);
 if(s.isSymbolicLink()){const target=fs.readlinkSync(full),resolved=fs.realpathSync(full);assert(!path.isAbsolute(target)&&resolved.startsWith(root+path.sep)&&fs.statSync(resolved).isFile());return{path:p,kind:'symlink',target,resolvedSha256:sha(read(resolved))};}
 assert(s.isFile()&&s.size<=256*1024*1024);return{path:p,kind:'file',mode:s.mode&511,bytes:s.size,sha256:sha(read(full))};}
export function checkRows(root,rows){for(const r of rows)assert.deepEqual(entry(root,r.path),r);}
export function copyRows(from,to,rows){for(const r of rows.filter(r=>r.kind==='file')){const p=path.join(to,safe(r.path));fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,read(path.join(from,r.path)),{flag:'wx',mode:r.mode});fs.chmodSync(p,r.mode);}for(const r of rows.filter(r=>r.kind==='symlink')){const p=path.join(to,r.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.symlinkSync(r.target,p);}}
export function nodeIdentity(){return{executable:fs.realpathSync(process.execPath),version:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,sha256:sha(read(process.execPath))};}
export function createLedger(root){
 const rows=new Map(walk(root).map(p=>[p,{...entry(root,p),origin:'preexisting'}]));let failed=false;
 const total=()=>[...rows.values()].reduce((s,r)=>s+(r.bytes??0),0);
 const identities=()=>[...rows.values()].map(({origin,...r})=>r).sort((a,b)=>a.path.localeCompare(b.path));
 const protect=fn=>{try{return fn();}catch(e){failed=true;throw e;}};
 const w={get failed(){return failed;},verify(){return protect(()=>{assert.deepEqual(walk(root),[...rows.keys()].sort(),'Unregistered artifact');checkRows(root,identities());});},
 write(p,bytes){return protect(()=>{safe(p);assert(!rows.has(p)&&Buffer.isBuffer(bytes)&&bytes.length<=256*1024*1024&&total()+bytes.length<=2*1024*1024*1024);let dir=root;for(const n of p.split('/').slice(0,-1)){dir=path.join(dir,n);fs.mkdirSync(dir,{recursive:true});assert(fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink());}
 const f=path.join(root,p),fd=fs.openSync(f,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const r=entry(root,p);assert.equal(r.sha256,sha(bytes));rows.set(p,{...r,origin:'written'});return r.sha256;});},
 save(p,value){return w.write(p,Buffer.from(JSON.stringify(value,null,2)+'\n'));},
 adopt(prefix,expected){return protect(()=>{safe(prefix);assert(!rows.has(prefix));checkRows(root,identities());const newPaths=walk(root).filter(p=>!rows.has(p));assert(newPaths.every(p=>p.startsWith(prefix+'/')),'Unexpected external write');
 const actual=newPaths.map(p=>entry(root,p));assert(total()+actual.reduce((s,r)=>s+(r.bytes??0),0)<=2*1024*1024*1024);if(expected)assert.deepEqual(actual,expected.map(r=>({...r,path:prefix+'/'+r.path})).sort((a,b)=>a.path.localeCompare(b.path)));
 for(const r of actual)rows.set(r.path,{...r,origin:expected?'worker_original_write_ledger':'retained_unsealed_failure'});});},
 seal(extra={}){w.verify();w.save('write-ledger.json',{schemaVersion:1,files:[...rows.values()].sort((a,b)=>a.path.localeCompare(b.path))});w.verify();const pin=w.save('manifest.json',{...extra,files:identities()});w.verify();return pin;}};return Object.freeze(w);
}
export function verifyPacket(root,pin){assert.equal(sha(read(path.join(root,'manifest.json'))),pin);const m=json(path.join(root,'manifest.json'));assert.deepEqual(walk(root),[...m.files.map(r=>r.path),'manifest.json'].sort());checkRows(root,m.files);const l=json(path.join(root,'write-ledger.json'));assert.equal(l.schemaVersion,1);assert.deepEqual(l.files.map(({origin,...r})=>r),m.files.filter(r=>r.path!=='write-ledger.json'));return m;}
