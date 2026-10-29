import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const PREFIX='research/delegated-sender-geth-v1/fee-controls';
export const PRODUCT_COMMIT='d9251793d2ca7c3dccdfffeb6de51da83b306445';
export const BINARY_SHA='10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521';
export const TOOLCHAIN_SHA='791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const json=p=>JSON.parse(fs.readFileSync(p));
export function save(p,v){const b=Buffer.from(JSON.stringify(v,null,2)+'\n');fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{bytes:b.length,sha256:sha(b)};}
export function walk(root,sub=''){const out=[];for(const e of fs.readdirSync(path.join(root,sub),{withFileTypes:true})){const p=sub?sub+'/'+e.name:e.name;if(e.isDirectory())out.push(...walk(root,p));else {assert(e.isFile()||e.isSymbolicLink());out.push(p);}assert(out.length<=10000);}return out.sort();}
export function entry(root,p){assert(p&&!path.isAbsolute(p)&&!p.split('/').includes('..')&&!p.includes('\\'));const file=path.join(root,p),s=fs.lstatSync(file);
  if(s.isSymbolicLink()){const target=fs.readlinkSync(file),r=path.posix.normalize(path.posix.join(path.posix.dirname(p),target));assert(!path.isAbsolute(target)&&!r.startsWith('../'));assert(p.includes('/node_modules/')&&r.startsWith(p.split('/node_modules/')[0]+'/node_modules/'));assert(fs.lstatSync(path.join(root,r)).isFile());return{path:p,kind:'symlink',target};}
  assert(s.isFile()&&s.size<=16*1024*1024);const b=fs.readFileSync(file);return{path:p,kind:'file',bytes:b.length,sha256:sha(b),mode:s.mode&0o777};
}
export function sourcePaths(root){const paths=['package.json','engines/evm-context.js','reports/ethereum-proof-capability/capture.json','research/delegated-sender-geth-v1/run.mjs'];
  for(const engine of ['local-evm','fixture-evm']){
    const base='engines/'+engine;
    for(const e of fs.readdirSync(path.join(root,base),{withFileTypes:true}))if(e.isFile()&&(e.name.endsWith('.js')||['package.json','package-lock.json'].includes(e.name)))paths.push(base+'/'+e.name);
    paths.push(...walk(root,base+'/node_modules'));
  }
  for(const f of ['fee-fixture.js','fee-crosscheck.test.js','authorization-fixture.js','lifecycle-fixture.js','proof-fixture.js'])paths.push('engines/local-evm/test/'+f);
  for(const f of ['archive.mjs','cases.mjs','worker.mjs','run.mjs','run.test.mjs','PLAN.md'])paths.push(PREFIX+'/'+f);
  return [...new Set(paths)].sort();
}
export function nodeIdentity(){const executable=fs.realpathSync(process.execPath);return{version:process.version,platform:process.platform,arch:process.arch,executable,sha256:sha(fs.readFileSync(executable))};}
export function sourceCommit(root,paths){
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024,timeout:10000});
  const repositoryCommit=git(['rev-parse','HEAD']).trim();git(['merge-base','--is-ancestor',PRODUCT_COMMIT,repositoryCommit]);
  const trackedPaths=git(['ls-files','-z','--',...paths]).split('\0').filter(Boolean).sort();
  const productPaths=trackedPaths.filter(p=>!p.startsWith(PREFIX+'/'));
  git(['diff','--exit-code',PRODUCT_COMMIT,'--',...productPaths]);
  return{productCommit:PRODUCT_COMMIT,repositoryCommit,trackedPaths,productPaths,trackedProductUnchanged:true};
}
export function toolchainIdentity(root){const directory=path.resolve(root,'../evm-toolchains/geth-v1.17.10'),manifest=path.join(directory,'toolchain-manifest.json');assert.equal(sha(fs.readFileSync(manifest)),TOOLCHAIN_SHA);const m=json(manifest);assert.equal(m.binary.sha256,BINARY_SHA);assert.equal(sha(fs.readFileSync(m.binary.path)),BINARY_SHA);assert.equal(sha(fs.readFileSync(path.join(directory,m.source.inventory.path))),m.source.inventory.sha256);assert.equal(sha(fs.readFileSync(path.join(directory,m.build.moduleInventory.path))),m.build.moduleInventory.sha256);
  for(const f of m.source.interpretationSources)assert.equal(sha(fs.readFileSync(path.join(directory,f.path))),f.sha256);
  return{directory,manifestSha256:TOOLCHAIN_SHA,binary:m.binary,source:m.source,dependencyInventory:m.build.moduleInventory,buildManifest:m.build.rawManifest};
}
export function freezeSources(root,capture){assert(!fs.existsSync(capture),'No reuse of a partial freeze');const paths=sourcePaths(root),files=paths.map(p=>entry(root,p));assert(files.length<=10000&&files.reduce((s,f)=>s+(f.bytes??0),0)<=64*1024*1024);const node=nodeIdentity(),geth=toolchainIdentity(root),git=sourceCommit(root,paths);fs.mkdirSync(path.join(capture,'runtime'),{recursive:true});
  for(const f of files){const dest=path.join(capture,'runtime',f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});if(f.kind==='symlink')fs.symlinkSync(f.target,dest);else{fs.writeFileSync(dest,fs.readFileSync(path.join(root,f.path)),{flag:'wx',mode:f.mode});fs.chmodSync(dest,f.mode);}}
  assert.deepEqual(paths.map(p=>entry(path.join(capture,'runtime'),p)),files);assert.deepEqual(sourcePaths(root),paths);assert.deepEqual(paths.map(p=>entry(root,p)),files);assert.deepEqual(nodeIdentity(),node);assert.deepEqual(sourceCommit(root,paths),git);
  fs.mkdirSync(path.join(capture,'toolchain'));for(const f of ['toolchain-manifest.json','source-inventory.json','dependency-inventory.json','build-manifest.json'])fs.writeFileSync(path.join(capture,'toolchain',f),fs.readFileSync(path.join(geth.directory,f)),{flag:'wx'});
  return {manifest:{schemaVersion:1,files,node,geth,git},identity:save(path.join(capture,'source-manifest.json'),{schemaVersion:1,files,node,geth,git})};
}
export function checkSources(capture,expected){const b=fs.readFileSync(path.join(capture,'source-manifest.json'));assert.equal(sha(b),expected);const m=JSON.parse(b),runtime=path.join(capture,'runtime');assert.deepEqual(walk(runtime),m.files.map(f=>f.path));assert.deepEqual(m.files.map(f=>entry(runtime,f.path)),m.files);assert.deepEqual(nodeIdentity(),m.node);assert.equal(sha(fs.readFileSync(m.geth.binary.path)),BINARY_SHA);
  assert.equal(m.git.productCommit,PRODUCT_COMMIT);assert.equal(m.git.trackedProductUnchanged,true);
  const bound={'toolchain-manifest.json':TOOLCHAIN_SHA,'source-inventory.json':m.geth.source.inventory.sha256,'dependency-inventory.json':m.geth.dependencyInventory.sha256,'build-manifest.json':m.geth.buildManifest.sha256};for(const[f,h]of Object.entries(bound))assert.equal(sha(fs.readFileSync(path.join(capture,'toolchain',f))),h);return m;
}
