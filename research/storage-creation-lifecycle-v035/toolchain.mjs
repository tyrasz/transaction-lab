// Read-only validation of the previously inventoried official EELS toolchain.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const TOOLCHAIN_FILE='research/storage-creation-v035/eels-comparison/capture/toolchain.json';
export const TOOLCHAIN_SHA256='5e67873833811992160173737d5c6f229dad327281e7e915ecce206cac4cb005';
export const sha=raw=>createHash('sha256').update(raw).digest('hex');
export function files(root,omit=[]){const out=[];function walk(rel=''){for(const name of fs.readdirSync(path.join(root,rel)).sort()){if(!rel&&omit.includes(name))continue;const p=rel?rel+'/'+name:name,s=fs.lstatSync(path.join(root,p));if(s.isDirectory()){assert(!s.isSymbolicLink());walk(p);}else{assert(!s.isSymbolicLink()||fs.statSync(path.join(root,p)).isFile());out.push(p);}}}walk();assert(out.length<=30000);return out.sort();}
export function checkRows(base,rows){assert(rows.length<=30000);assert.equal(new Set(rows.map(r=>r.path)).size,rows.length);assert(rows.reduce((n,r)=>n+(r.bytes??0),0)<=536870912);for(const row of rows){
  const p=path.isAbsolute(row.path)?row.path:path.join(base,row.path),s=fs.lstatSync(p);assert(s.size<=67108864);
  if(row.kind==='symlink'){assert(s.isSymbolicLink());assert.equal(fs.readlinkSync(p),row.target);const resolved=fs.realpathSync(p);assert.equal(resolved,row.resolved);assert(fs.statSync(resolved).isFile());assert.equal(sha(fs.readFileSync(resolved)),row.resolvedSha256);}
  else{assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.size,row.bytes);assert.equal(s.mode&511,row.mode);assert.equal(sha(fs.readFileSync(p)),row.sha256);}
}}
export function verifyToolchain(manifestPath=path.join(ROOT,TOOLCHAIN_FILE)){
  const raw=fs.readFileSync(manifestPath);assert.equal(sha(raw),TOOLCHAIN_SHA256);const t=JSON.parse(raw);
  for(const key of['source','venv']){const base=path.join(t.toolchain,key);assert.deepEqual(files(base),t[key].map(r=>r.path).sort());checkRows(base,t[key]);}
  assert.deepEqual(files(t.stdlibPath,['site-packages']),t.stdlib.map(r=>r.path).sort());checkRows(t.stdlibPath,t.stdlib);checkRows('',t.runtime);
  assert.equal(fs.existsSync(path.join(path.dirname(t.stdlibPath),'python312.zip')),t.stdlibZipExists);
  assert.equal(t.python,path.join(t.toolchain,'venv/bin/python'));
  return{sha256:TOOLCHAIN_SHA256,bytes:raw.length,manifest:structuredClone(t),entries:t.source.length+t.venv.length+t.stdlib.length+t.runtime.length};
}
