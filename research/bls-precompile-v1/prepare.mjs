import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {FILES,GETH_COMMIT,TOOLCHAIN_SHA,SOURCE_INVENTORY_SHA,PREFIX,FORKS,LIMITS,sha,jsonBytes,declaredRows} from './cases.mjs';

export function prepare(directory,toolchain){
  const dest=path.join(directory,'inputs');assert(!fs.existsSync(dest),'Input preparation is single-use');
  const tb=fs.readFileSync(path.join(toolchain,'toolchain-manifest.json')),ib=fs.readFileSync(path.join(toolchain,'source-inventory.json'));
  assert.equal(sha(tb),TOOLCHAIN_SHA);assert.equal(sha(ib),SOURCE_INVENTORY_SHA);const inv=JSON.parse(ib);assert.equal(inv.commit,GETH_COMMIT);
  const names=[...FILES.map(f=>'core/vm/testdata/precompiles/'+f),'COPYING','COPYING.LESSER','core/vm/contracts.go','core/vm/contracts_test.go','params/protocol_params.go'];
  const originals=names.map(p=>{const row=inv.files.find(f=>f.path===p);assert(row);const b=fs.readFileSync(path.join(toolchain,'source',p));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);return{...row,buffer:b};});
  const actual=fs.readdirSync(path.join(toolchain,'source/core/vm/testdata/precompiles')).filter(f=>/^(?:fail-)?bls.*\.json$/.test(f)).sort();assert.deepEqual(actual,FILES,'No BLS corpus files may be silently excluded');
  fs.mkdirSync(dest,{recursive:true});const records=[];for(const f of originals){const p=path.join(dest,'upstream',f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,f.buffer,{flag:'wx'});assert.equal(sha(fs.readFileSync(p)),f.sha256);const{buffer,...entry}=f;records.push(entry);}
  fs.writeFileSync(path.join(dest,'toolchain-manifest.json'),tb,{flag:'wx'});fs.writeFileSync(path.join(dest,'source-inventory.json'),ib,{flag:'wx'});
  const provenance={schemaVersion:1,repository:'https://github.com/ethereum/go-ethereum',tag:'v1.17.10',commit:GETH_COMMIT,toolchainManifestSha256:TOOLCHAIN_SHA,sourceInventorySha256:SOURCE_INVENTORY_SHA,files:records,license:'Upstream COPYING and COPYING.LESSER retained unchanged; fixture provenance follows pinned go-ethereum source.',acquiredAt:new Date().toISOString()};
  fs.writeFileSync(path.join(dest,'provenance.json'),jsonBytes(provenance),{flag:'wx'});
  const raw=Object.fromEntries(FILES.map(f=>[f,fs.readFileSync(path.join(dest,'upstream/core/vm/testdata/precompiles',f))]));
  const rows=declaredRows(raw).map(({data,...r})=>r);
  const plan={schemaVersion:1,kind:'fixed_official_bls_public_profile_component_corpus',createdAt:new Date().toISOString(),provenanceSha256:sha(jsonBytes(provenance)),forks:FORKS,limits:LIMITS,rows,
    scope:{expectedOutputsEnterExecutor:false,sourceProofVerified:false,sourceHeaderVerified:false,syntheticInitialAccounts:true,unsignedUnpriced:true,fullTransactionConformance:false,publicProfileBoundsPreserved:true,pureOversizedExecution:false,independentExpectedBytes:'Pinned Geth source vectors; Geth is not re-executed.',errorStringsComparedLiterally:false,errorSemantics:'Expected malformed input must produce an exceptional failed execution, empty return, full message gas consumption, and a recognized BLS invalid-input error. Client error wording is retained separately.'}};
  fs.writeFileSync(path.join(dest,'plan.json'),jsonBytes(plan),{flag:'wx'});return{planSha256:sha(jsonBytes(plan)),vectors:928,rows:rows.length,admitted:rows.filter(r=>r.status==='admitted').length,unsupported:rows.filter(r=>r.status==='unsupported').length};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');console.log(JSON.stringify(prepare(path.join(root,PREFIX),path.resolve(root,'../evm-toolchains/geth-v1.17.10')),null,2));}
