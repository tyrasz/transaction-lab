// Pure amendment-boundary controls; no VM, provider call or packet rewriting.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {assertComparatorAmendment,assertOnlyExceptionChannelChanged} from './reanalyze-exception.mjs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
test('amendment permits only the reviewed source bytes',()=>{
 const old=read('../delegated-sender-current-v038/capture-001/runtime/research/ordinary-local-coverage-v1/outcomes.mjs');
 const current=read('../ordinary-local-coverage-v1/outcomes.mjs');assertComparatorAmendment(old,current);
 for(const [a,b]of[[old,current+'\n'],[old+'\n',current],[old,current.replace('INVALID(?!','INVALID.*(?!')]])assert.throws(()=>assertComparatorAmendment(a,b));
});
test('amendment cannot conceal another changed result or drop a position',()=>{
 const before=JSON.parse(read('./comparison-first.json')),rows=structuredClone(before.rows);
 rows[0].channels.executionStatus={status:'match',product:{status:'failed',exception:'invalid_opcode'},oracle:{status:'failed',exception:'invalid_opcode'}};
 rows[0].outcome.comparison='match';rows[0].allChannelsComplete=true;rows[0].reasons=[];
 const after={rows,counts:{matched:10,mismatched:0,unavailable:0},metrics:{matched:10,mismatched:0,unavailable:0}};
 assertOnlyExceptionChannelChanged(before,after);
 for(const change of[r=>r.rows.pop(),r=>r.rows[0].channels.gasAccounting.product='1',r=>r.rows[1].delegation.target='0x0',r=>r.rows[0].evidence.oracle.rawExecutionError='out of gas',r=>r.counts.matched=11]){
  const altered=structuredClone(after);change(altered);assert.throws(()=>assertOnlyExceptionChannelChanged(before,altered));
 }
});
