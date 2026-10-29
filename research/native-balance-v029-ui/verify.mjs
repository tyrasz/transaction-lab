// Artifact-only checks. Does not start a server, worker, VM, or RPC client.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const raw=name=>readFile(new URL(name,import.meta.url));
const json=async name=>JSON.parse(await raw(name));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const [intended,request,result,http,browser,closed,declaration]=await Promise.all(['intended-request.json','request.json','response.json','http.json','browser.json','server-closed.json','declaration.json'].map(json));
assert.deepEqual(request,intended);assert.deepEqual(result.apiRequest,{...intended,gas:'5000000'});
assert.equal(http.status,200);assert.deepEqual(http.errors,[]);assert.equal(closed.runs,1);assert.equal(closed.clients,1);assert.deepEqual(closed.errors,[]);
assert.equal(result.status,'complete');assert.equal(result.execution.status,'success');assert.equal(result.source.canonicalStatus,'verified');
assert.equal(result.attempt.preview.usage.executions,1);assert.equal(result.attempt.preview.scope.nativeBalanceCoverage,'explicit_accounts_only');
assert.equal(result.attempt.isolation.processSeparated,true);assert.equal(result.attempt.isolation.processClosed,true);assert.equal(result.attempt.broker.pendingAtReturn,0);
assert.equal(result.drain.complete,true);assert.equal(result.transportEvidence.length,9);assert.equal(closed.proofRequests,9);
for(const [i,wire]of result.transportEvidence.entries()){
  assert.equal(wire.id,i+1);assert.equal(wire.provider,'fixture.invalid');assert.equal(wire.status,'completed');assert.equal(wire.httpStatus,200);
  assert.equal(sha(wire.requestText),wire.requestSha256);assert.equal(Buffer.byteLength(wire.requestText),wire.requestBytes);assert.deepEqual(JSON.parse(wire.requestText),wire.request);
  assert.equal(sha(wire.responseText),wire.transport.responseSha256);assert.equal(Buffer.byteLength(wire.responseText),wire.transport.observedBytes);assert.equal(wire.transport.complete,true);
  const response=JSON.parse(wire.responseText);assert.equal(response.id,wire.id);assert(!Object.hasOwn(response,'error'));
  assert(['eth_chainId','eth_getBlockByHash','eth_getBlockByNumber','eth_getProof','eth_getCode'].includes(wire.request.method));
  if(['eth_getProof','eth_getCode'].includes(wire.request.method))assert.deepEqual(wire.request.params.at(-1),{blockHash:intended.block,requireCanonical:true});
}
const expected=[['1000000000000','999999789877','-210123'],['9','132','123']];
function eth(raw){const n=BigInt(raw),a=n<0n?-n:n,f=(a%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return`${n<0n?'-':''}${a/10n**18n}${f?'.'+f:''} ETH`;}
for(const [i,row]of result.measurements.entries()){
  assert.equal(row.status,'measured');assert.equal(row.query,null);assert.equal(row.returnBytes,0);assert.deepEqual(row.descriptor,intended.queries[i]);
  assert.deepEqual(row.identity,{...intended.queries[i],chainId:'1'});assert.equal(row.values.length,1);
  const v=row.values[0];assert.equal(v.name,'balance');assert.deepEqual(v.unit,{kind:'native_wei',scale:'1000000000000000000'});
  const amounts=[v.beforeRaw,v.afterRaw,v.deltaRaw];assert.deepEqual(amounts,expected[i]);assert.equal(BigInt(v.afterRaw)-BigInt(v.beforeRaw),BigInt(v.deltaRaw));
  assert.equal(browser.rows[i].account,row.identity.account);assert.deepEqual(browser.rows[i].wei,amounts.map(v=>v+' wei'));assert.deepEqual(browser.rows[i].eth,amounts.map(eth));
}
assert.equal(result.measurements.length,2);assert.equal(browser.rows.length,2);assert.equal(browser.coverage,'2 / 2 measured');assert.equal(browser.execution,'Success');assert.equal(browser.rawJsonRunId,result.id);
assert.equal(result.attempt.preview.original.output.feeAccounting.gasCharge,'210000');assert.equal(browser.fee,'Gas limit: 5,000,000 · simulated fee: 210,000 wei');
assert.equal(browser.staleEdit.resultHidden,true);assert.equal(browser.staleEdit.resubmitted,false);assert.equal(browser.tabClosed,true);
for(const source of declaration.sources){const bytes=await readFile(new URL('../../'+source.path,import.meta.url));assert.equal(bytes.length,source.bytes);assert.equal(sha(bytes),source.sha256);}
console.log(JSON.stringify({status:'verified',scope:'Artifact-only consistency check of one synthetic browser HTTP run; no target replay or public-chain accuracy claim',id:result.id,execution:result.execution.status,requestedAccounts:2,measurements:expected,feeWei:'210000',proofCalls:9,oneOriginalExecution:true,canonicalHeader:'synthetic_fixture_confirmed',sourceSha256:result.implementation.sourceSha256,responseSha256:sha(await raw('response.json')),browserStaleInvalidation:true,serverClosed:true},null,2));
