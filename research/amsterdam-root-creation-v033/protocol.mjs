import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const HOME=path.dirname(fileURLToPath(import.meta.url));
export const ORIGINAL=path.resolve(HOME,'../amsterdam-storage-creation-v033/capture');
export const CAPTURE=path.join(HOME,'capture');
export const PINS=Object.freeze({manifest:'0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9',source:'8d5c2e8dfa1ab8229a194ad5fc616f1bbf68cacc863cd36c46234476ba705444',plan:'f5ce939bf9238d1ff52e5a22ff2596459e82faa67da053f6758c864f68ed69fe'});
export const INDICES=Object.freeze([0,2,4]);
export const FILES=Object.freeze(['PLAN.md','protocol.mjs','worker.mjs','run.mjs','run.test.mjs','verify.mjs']);
export const LIMITS=Object.freeze({processes:6,processMs:15000,totalMs:120000,processBytes:2097152,totalBytes:12582912});
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const read=p=>JSON.parse(fs.readFileSync(p));
export const number=i=>String(i+1).padStart(3,'0');
export function walk(root,sub=''){const paths=[];for(const e of fs.readdirSync(path.join(root,sub),{withFileTypes:true})){const p=sub?sub+'/'+e.name:e.name;if(e.isDirectory())paths.push(...walk(root,p));else{assert(e.isFile()||e.isSymbolicLink());paths.push(p);}}return paths.sort();}
export function entry(root,p){assert(p&&!path.isAbsolute(p)&&!p.split('/').includes('..'));const full=path.join(root,p),s=fs.lstatSync(full);if(s.isSymbolicLink())return{path:p,kind:'symlink',target:fs.readlinkSync(full)};assert(s.isFile());const b=fs.readFileSync(full);return{path:p,kind:'file',bytes:b.length,sha256:sha(b),mode:s.mode&511};}
export function save(p,value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.mkdirSync(path.dirname(p),{recursive:true});const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{bytes:b.length,sha256:sha(b)};}
export function match(root,f){const got=entry(root,f.path);if(f.kind==='dependency_link')assert.deepEqual(got,{path:f.path,kind:'symlink',target:f.target});else assert.deepEqual(got,f);}
export async function original(){
 for(const[name,pin]of[['manifest.json',PINS.manifest],['source-manifest.json',PINS.source],['plan.json',PINS.plan]])assert.equal(sha(fs.readFileSync(path.join(ORIGINAL,name))),pin);
 const manifest=read(path.join(ORIGINAL,'manifest.json'));assert.equal(manifest.artifactHashCoverageComplete,true);assert.deepEqual(walk(ORIGINAL),[...manifest.files.map(f=>f.path),'manifest.json'].sort());for(const f of manifest.files)match(ORIGINAL,f);
 const prefix=path.join(ORIGINAL,'runtime/research/amsterdam-storage-creation-v033');
 const archive=await import(pathToFileURL(path.join(prefix,'archive.mjs')).href);const source=archive.checkSources(ORIGINAL,PINS.source);
 const cases=await import(pathToFileURL(path.join(prefix,'cases.mjs')).href),observations=await import(pathToFileURL(path.join(prefix,'observations.mjs')).href);
 return{source,cases,observations,manifest,plan:read(path.join(ORIGINAL,'plan.json')),results:read(path.join(ORIGINAL,'results.json'))};
}
export function expectedWorker(){const file=path.join(ORIGINAL,'runtime/research/amsterdam-storage-creation-v033/worker.mjs');let text=fs.readFileSync(file,'utf8');const old='assert.deepEqual(input,await declaration(input.index));';assert.equal(text.split(old).length,2);text=text.replace(old,'assert.deepEqual(input,JSON.parse(JSON.stringify(await declaration(input.index))));');return text.replace(/from '([^']+)'/g,(whole,p)=>p.startsWith('.')?"from '"+path.relative(HOME,path.resolve(path.dirname(file),p))+"'":whole);}
export function checkOwn(plan){assert.deepEqual(plan.original,PINS);assert.deepEqual(plan.indices,INDICES);assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.files.map(f=>f.path),FILES);for(const f of plan.files){match(HOME,f);const b=fs.readFileSync(path.join(CAPTURE,'source',f.path));assert.equal(sha(b),f.sha256);assert.equal(b.length,f.bytes);}assert.equal(fs.readFileSync(path.join(HOME,'worker.mjs'),'utf8'),expectedWorker());
 for(const f of plan.inputs){match(CAPTURE,f);assert.deepEqual(fs.readFileSync(path.join(CAPTURE,f.path)),fs.readFileSync(path.join(ORIGINAL,f.path)));}
}
export const validTime=(wall,mono,max)=>[wall,mono].every(n=>Number.isFinite(n)&&n>=0&&n<=max);
export function unpack(value){const b=Buffer.from(value.base64,'base64');assert.equal(b.toString('base64'),value.base64);assert.equal(b.length,value.bytes);assert.equal(sha(b),value.sha256);return b;}
export function bounded(raw){const p=raw.process;return Number.isSafeInteger(p.timeoutMs)&&p.timeoutMs>0&&p.timeoutMs<=LIMITS.processMs&&validTime(p.wallMs,p.monotonicMs,p.timeoutMs)&&p.error?.code!=='ENOBUFS'&&[raw.stdout.bytes,raw.stderr.bytes].every(n=>Number.isSafeInteger(n)&&n>=0)&&raw.stdout.bytes+raw.stderr.bytes<=LIMITS.processBytes;}
export function report(raw){assert(bounded(raw));assert.equal(raw.process.status,0);assert.equal(raw.process.signal,null);assert.equal(raw.process.error,null);new TextDecoder('utf-8',{fatal:true}).decode(unpack(raw.stderr));return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unpack(raw.stdout)));}
export function projected(out){return{status:out.observation?'observed':out.mode==='product'?(out.attempt?.output?.execution?.status??'unavailable'):'unavailable',observation:out.observation,withheldState:out.withheldState??null,error:out.error??out.attempt?.error??null};}
