// Post-seal comparison only. No execution, network or expected-output repair.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname,resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url)),reports=resolve(here,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const expected={v2:'834962759a7629aabaedc4b778b828f4df92b11b4c8e548ad7b3648ff95d2f13',v3:'a8a5de3bb276a6669b1ce4abc39d8c641f389889786ad9f13aec0e2664543a26'};
const manifests=Object.fromEntries(Object.entries(expected).map(([version,digest])=>{
  const bytes=readFileSync(resolve(reports,'standard-evm-positions-'+version,'manifest.json'));assert.equal(sha(bytes),digest);return[version,JSON.parse(bytes)];
}));
function load(version,id){
  const path='reports/standard-evm-positions-'+version+'/'+id+'-response.json',bytes=readFileSync(resolve(reports,'standard-evm-positions-'+version,id+'-response.json'));
  const entry=manifests[version].files.find(x=>x.path===id+'-response.json');assert.ok(entry);assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);
  return{path,sha256:sha(bytes),report:JSON.parse(bytes)};
}
const ids=['aave-position','morpho-vault-position','aave-approval-position-sequence'];
const pairs=ids.map(id=>({id,old:load('v2',id),now:load('v3',id)}));
const comparisons=[];let tokens=0;
for(const pair of pairs){
  const oldParts=pair.old.report.steps?.map(x=>x.result)??[pair.old.report],nowParts=pair.now.report.steps?.map(x=>x.result)??[pair.now.report];assert.equal(oldParts.length,nowParts.length);
  for(const[i,part]of nowParts.entries()){
    const old=oldParts[i],newTokens=part.measurements.filter(x=>!x.position),oldTokens=old.measurements.filter(x=>!x.position);
    assert.deepEqual(newTokens,oldTokens);assert.deepEqual(part.preview.queries,old.preview.queries);tokens+=newTokens.length;
    comparisons.push({caseId:pair.id,stepIndex:pair.now.report.steps?i:null,tokenQueries:newTokens.length,engineTokenRowsExactlyEqual:true,previewTokenRowsExactlyEqual:true});
  }
}
const oldMorpho=pairs[1].old.report.measurements.find(x=>x.position),newMorpho=pairs[1].now.report.measurements.find(x=>x.position);
assert.deepEqual(newMorpho,oldMorpho);assert.deepEqual(pairs[1].now.report.preview.positions,pairs[1].old.report.preview.positions);
const standalone=pairs[0].now.report.measurements.find(x=>x.position),steps=pairs[2].now.report.steps.map(x=>x.result.measurements.find(m=>m.position));
assert.equal(standalone.status,'measured');for(const step of steps)assert.equal(step.status,'measured');
assert.equal(steps[0].beforeReturnData,steps[0].afterReturnData);
assert.equal(steps[1].beforeReturnData,steps[0].afterReturnData);
assert.equal(steps[1].beforeReturnData,standalone.beforeReturnData);assert.equal(steps[1].afterReturnData,standalone.afterReturnData);assert.deepEqual(steps[1].rows,standalone.rows);
for(const row of steps[0].rows){assert.equal(row.beforeRaw,row.afterRaw);assert.equal(row.deltaRaw,'0');}
const output={schemaVersion:'1.0',basis:'post_seal_exact_recorded_response_comparison_not_new_execution',
  manifests:Object.fromEntries(Object.entries(expected).map(([v,sha256])=>[v,{sha256}])),
  responseFiles:pairs.flatMap(p=>[p.old,p.now]).map(({path,sha256})=>({path,sha256})),
  tokenRows:{count:tokens,allExactlyEqual:true,comparisons},
  morphoPosition:{engineAndPreviewExactlyEqual:true,owner:newMorpho.position.identity.user,rows:newMorpho.rows},
  aavePosition:{approvalTupleUnchanged:true,supplyBeforeEqualsApprovalAfter:true,supplyBeforeAndAfterMatchStandalone:true,approvalRows:steps[0].rows,supplyRows:steps[1].rows}};
process.stdout.write(JSON.stringify(output,null,2)+'\n');
