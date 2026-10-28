import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const base=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const PROPOSAL_SHA='445f0f9945a338ef6b49a719f603f2debf4dd72c3f92ff7679ac57ae91626546';
export function buildSelection(directory=base){
 const raw=fs.readFileSync(path.join(directory,'proposal.json'));
 assert.equal(hash(raw),PROPOSAL_SHA,'Fixed pre-execution proposal changed');
 const proposal=JSON.parse(raw),preparation=JSON.parse(fs.readFileSync(path.join(directory,'preparation.json')));
 assert.equal(preparation.status,'complete');assert.equal(preparation.executions,0);assert.equal(preparation.publicRequests,0);
 assert.equal(preparation.archiveSha256,proposal.archiveSha256);assert.equal(proposal.selected.length,16);
 assert.equal(new Set(proposal.selected.map(r=>r.id)).size,16);
 const selected=proposal.selected.map((row,i)=>{
  assert.equal(row.index,i+1);assert.equal(row.postIndex,0);assert.equal(row.fork,'Osaka');
  assert.match(row.file,/^candidates\/state_tests\/[a-zA-Z0-9_\/-]+\.json$/);
  const bytes=fs.readFileSync(path.join(directory,row.file)),record=preparation.sources.find(r=>r.path===row.file);
  assert(record);assert.equal(bytes.length,record.bytes);assert.equal(hash(bytes),record.sha256);
  const fixture=JSON.parse(bytes)[row.id];assert(fixture);assert.equal(fixture._info.hash,row.fixtureHash);
  return {...row,family:row.category,fileSha256:record.sha256};
 });
 return {schemaVersion:1,purpose:'Unmodified official signed dependency conformance; not the sparse product finalizer.',proposalSha256:PROPOSAL_SHA,release:proposal.release,releaseCommit:proposal.releaseCommit,assetSha256:proposal.archiveSha256,limits:{gas:16777216,calldataBytes:32768,preAccounts:128,preStorageSlots:1024,vectorMs:10000,totalMs:360000,childHeapMiB:512,childOutputBytes:1048576},selected};
}
if(process.argv[1]===fileURLToPath(import.meta.url))fs.writeFileSync(path.join(base,'selection.json'),JSON.stringify(buildSelection(),null,2)+'\n',{flag:'wx'});
