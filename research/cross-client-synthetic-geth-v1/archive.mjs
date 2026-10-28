// Bounded source/input archive only. This module never executes a target.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { inspectNodeRuntime, verifyNodeRuntime } from '../standard-evm/cohort-freeze.mjs';
import { CORPUS } from './adapter.mjs';
export { inspectNodeRuntime, verifyNodeRuntime };
export const RELEASED_DISPATCH_SHA='eafecc8f260a0136cbc005bd1d713ac3cabb29886c26e0d2b443eaf273788236';
export const TOOLCHAIN_SHA='791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333';
export const COMMIT='1df30b18d9ed35ee9d28ffd4648442c2204554ad';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const need=(v,m)=>{if(!v)throw Object.assign(Error(m),{code:'SYNTHETIC_GETH_INVALID'});};
const DEPS=['engines/local-evm/node_modules','engines/fixture-evm/node_modules'];
const MAX_FILES=20000,MAX_TOTAL=512*1024*1024,MAX_FILE=32*1024*1024;
export const SEMANTICS=['cmd/evm/staterunner.go','cmd/evm/reporter.go','tests/state_test_util.go','tests/init.go'];
export function safePath(p){need(typeof p==='string'&&p.length>0&&p.length<=1024&&!path.isAbsolute(p)&&!p.includes('\\')&&!p.includes('\0')&&path.posix.normalize(p)===p&&!p.split('/').some(x=>['','.','..'].includes(x)),'Unsafe path');return p;}
export function read(root,p){safePath(p);let current=root;for(const part of p.split('/')){current=path.join(current,part);need(!fs.lstatSync(current).isSymbolicLink(),'Linked artifact path');}const s=fs.lstatSync(current);need(s.isFile()&&s.size<=MAX_FILE,'Bounded regular artifact required');return fs.readFileSync(current);}
export function identity(root,p){const b=read(root,p);return{bytes:b.length,sha256:sha(b)};}
export function write(root,p,value){safePath(p);let current=root;need(fs.lstatSync(current).isDirectory()&&!fs.lstatSync(current).isSymbolicLink(),'Real artifact root required');for(const part of p.split('/').slice(0,-1)){const parent=current;current=path.join(current,part);try{fs.mkdirSync(current);syncDir(parent);}catch(e){if(e.code!=='EEXIST')throw e;}need(fs.lstatSync(current).isDirectory()&&!fs.lstatSync(current).isSymbolicLink(),'Real artifact parent required');}const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');need(b.length<=MAX_FILE,'Artifact too large');const fd=fs.openSync(path.join(root,p),'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(current);return{bytes:b.length,sha256:sha(b)};}
function syncDir(p){const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function walk(root,p='',skip=()=>false){const found=[];for(const e of fs.readdirSync(path.join(root,p),{withFileTypes:true})){const next=p?p+'/'+e.name:e.name;safePath(next);if(skip(next,e))continue;if(e.isDirectory())found.push(...walk(root,next,skip));else{need(e.isFile()||e.isSymbolicLink(),'Special archive member');found.push(next);}need(found.length<=MAX_FILES,'Archive file limit');}return found.sort();}
function entry(root,p){const s=fs.lstatSync(path.join(root,p));if(s.isSymbolicLink()){const dep=DEPS.find(d=>p.startsWith(d+'/'));need(dep,'Only dependency links are supported');const target=fs.readlinkSync(path.join(root,p));need(!path.isAbsolute(target)&&!target.includes('\\')&&!target.includes('\0'),'Unsafe dependency link');const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(p),target));need(resolved.startsWith(dep+'/'),'Dependency link escapes closure');read(root,resolved);return{path:p,kind:'symlink',target};}return{path:p,kind:'file',...identity(root,p),mode:s.mode&0o777};}
function inventory(root,paths){need(paths.length<=MAX_FILES&&new Set(paths.map(p=>p.toLowerCase())).size===paths.length,'Duplicate/large inventory');const rows=paths.slice().sort().map(p=>entry(root,p));need(rows.reduce((s,r)=>s+(r.bytes??0),0)<=MAX_TOTAL,'Archive byte limit');const byPath=new Map(rows.map(r=>[r.path,r]));for(const r of rows)if(r.kind==='symlink')need(byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(r.path),r.target)))?.kind==='file','Dependency link target absent');return rows;}
export async function inspectSources(repoRoot){
 const root=fs.realpathSync(repoRoot),paths=new Set(['package.json','engines/evm-context.js','research/standard-evm/cohort-freeze.mjs','research/cross-client-geth-v1/run.mjs','research/evm-lifecycle-differential-v1/runtime.mjs']);
 for(const engine of ['engines/local-evm','engines/fixture-evm'])for(const p of walk(root,engine,(p)=>p===engine+'/test'||p===engine+'/node_modules'))if(p.endsWith('.js')||['package.json','package-lock.json'].includes(path.basename(p)))paths.add(p);
 for(const dep of DEPS)for(const p of walk(root,dep))paths.add(p);
 for(const p of walk(root,'research/cross-client-synthetic-geth-v1',(p,e)=>e.isDirectory())){need(p.endsWith('.mjs')||p.endsWith('/PLAN.md'),'Unexpected harness source');paths.add(p);}
 const manifestBytes=read(root,CORPUS.directory+'/manifest.json');need(sha(manifestBytes)===CORPUS.manifestSha256,'Original corpus manifest drift');const old=JSON.parse(manifestBytes);need(old.planSha256===CORPUS.planSha256&&old.files.length===100,'Original corpus identity/count drift');
 paths.add(CORPUS.directory+'/manifest.json');for(const r of old.files){safePath(r.path);const p=CORPUS.directory+'/'+r.path;need(equal(identity(root,p),{bytes:r.bytes,sha256:r.sha256}),'Original artifact drift');paths.add(p);}
 need(identity(root,'research/cross-client-geth-v1/run.mjs').sha256===RELEASED_DISPATCH_SHA,'Released dispatcher drift');
 const files=inventory(root,[...paths]);return{schemaVersion:1,node:await inspectNodeRuntime(),files,filesCount:files.length,bytes:files.reduce((s,r)=>s+(r.bytes??0),0),oldCorpusManifestSha256:CORPUS.manifestSha256,oldCorpusFiles:100,releasedDispatcherSha256:RELEASED_DISPATCH_SHA};
}
export async function archiveSources({repoRoot,capture}){
 const root=fs.realpathSync(repoRoot),destination=path.join(fs.realpathSync(path.dirname(path.resolve(capture))),path.basename(capture));need(!fs.existsSync(destination),'New capture directory required');
 const relative=path.relative(root,destination).split(path.sep).join('/');need(relative!==''&&!relative.startsWith('engines/')&&!relative.startsWith(CORPUS.directory+'/')&&relative!==CORPUS.directory,'Capture overlaps immutable source');
 const before=await inspectSources(root);fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'runtime'));
 for(const r of before.files){need(equal(entry(root,r.path),r),'Source drift before copy');const out=path.join(destination,'runtime',r.path);fs.mkdirSync(path.dirname(out),{recursive:true});if(r.kind==='symlink')fs.symlinkSync(r.target,out);else{const b=read(root,r.path);need(sha(b)===r.sha256&&b.length===r.bytes,'Source drift during copy');fs.writeFileSync(out,b,{flag:'wx',mode:r.mode});fs.chmodSync(out,r.mode);}}
 need(equal(await inspectSources(root),before),'Source drift during archive');const saved=write(destination,'source-manifest.json',before);await verifyArchive({capture:destination,expectedSourceSha256:saved.sha256});return{capture:destination,sourceManifestSha256:saved.sha256,manifest:before};
}
export async function verifyArchive({capture,expectedSourceSha256}){
 need(typeof expectedSourceSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedSourceSha256),'Source manifest hash required');const bytes=read(capture,'source-manifest.json');need(sha(bytes)===expectedSourceSha256,'Source manifest differs');const m=JSON.parse(bytes);need(m.schemaVersion===1&&Array.isArray(m.files)&&m.files.length<=MAX_FILES,'Source inventory invalid');
 const paths=walk(path.join(capture,'runtime'));need(equal(paths,m.files.map(r=>r.path)),'Exact runtime membership differs');need(equal(inventory(path.join(capture,'runtime'),paths),m.files),'Source bytes/modes/links differ');need(m.filesCount===paths.length&&m.bytes===m.files.reduce((s,r)=>s+(r.bytes??0),0),'Source totals differ');
 need(m.oldCorpusManifestSha256===CORPUS.manifestSha256&&m.oldCorpusFiles===100&&m.releasedDispatcherSha256===RELEASED_DISPATCH_SHA,'Source provenance differs');need(identity(path.join(capture,'runtime'),'research/cross-client-geth-v1/run.mjs').sha256===RELEASED_DISPATCH_SHA,'Archived dispatcher differs');await verifyNodeRuntime(m.node);return m;
}
export function verifyTool(bytes){need(sha(bytes)===TOOLCHAIN_SHA,'Toolchain manifest differs');const t=JSON.parse(bytes);need(t.source.commit===COMMIT&&t.source.tree==='cc329acc8f69375efe7e3cbba00e1acb1e2d373f'&&t.go.archiveSha256==='dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2','Tool source/compiler differs');const b=fs.readFileSync(t.binary.path),s=fs.lstatSync(t.binary.path);need(s.isFile()&&!s.isSymbolicLink()&&b.length===t.binary.bytes&&sha(b)===t.binary.sha256,'Exact external Geth binary differs');return t;}
export function seal(capture,planSha256){const files=walk(capture).filter(p=>p!=='manifest.json').map(p=>{const s=fs.lstatSync(path.join(capture,p));if(s.isSymbolicLink()){need(p.startsWith('runtime/'),'Nonruntime link');return{path:p,kind:'symlink',target:fs.readlinkSync(path.join(capture,p))};}return{path:p,...identity(capture,p)};});need(files.length<=MAX_FILES,'Evidence file cap');const saved=write(capture,'manifest.json',{schemaVersion:1,planSha256,files});return{manifestSha256:saved.sha256,files:files.length};}
