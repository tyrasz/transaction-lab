import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const candidates=[['direct-transferfrom-a','direct-transferfrom-a-evidence.json'],['direct-transferfrom-b','direct-transferfrom-b-evidence.json'],['router-permit-consumption','../permission-discovery/router-permit-candidate-verified.json']];
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC='0xb88339cb7199b77e23db6e890353e22632ba630f';
const address=w=>'0x'+w.slice(-40).toLowerCase();
const quantities=v=>BigInt(v).toString();
const results=[];
for(const [id,artifact] of candidates){
 const bytes=await readFile(new URL(artifact,import.meta.url)),raw=JSON.parse(bytes),c=raw.captures;
 const tx=c.transaction.response.result,receipt=c.receipt.response.result,trace=c.callTrace.response.result,block=c.block.response.result;
 const calls=[];
 const walk=(f,path='0')=>{
  if(f.type==='CALL'&&f.input?.slice(0,10)==='0x23b872dd'){
   const words=f.input.slice(10).match(/.{64}/g);
   if(words.length===3)calls.push({framePath:path,token:f.to,owner:address(words[0]),recipient:address(words[1]),spender:f.from,externalTransactionSender:tx.from,rootContract:tx.to,amountRaw:quantities('0x'+words[2]),ownerDiffersFromExternalSender:address(words[0])!==tx.from,spenderDiffersFromRootContract:f.from!==tx.to,success:!f.error&&!f.revertReason,returnData:f.output,delegateTargets:(f.calls??[]).filter(child=>child.type==='DELEGATECALL').map(child=>child.to)});
  }
  (f.calls??[]).forEach((child,index)=>walk(child,path+'.'+index));
 };
 walk(trace);
 const events=receipt.logs.filter(log=>log.topics[0]===TRANSFER&&log.topics.length===3).map(log=>({token:log.address,from:address(log.topics[1]),to:address(log.topics[2]),amountRaw:quantities(log.data),logIndex:quantities(log.logIndex)}));
 const nets=new Map();for(const e of events)for(const [account,sign] of [[e.from,-1n],[e.to,1n]]){const key=e.token+':'+account;nets.set(key,(nets.get(key)??0n)+sign*BigInt(e.amountRaw));}
 const eventDeltas=[...nets].map(([key,n])=>({token:key.slice(0,42),account:key.slice(43),eventNetRaw:n.toString(),measurementStatus:'not_queried_for_this_research',basis:'receipt_Transfer_events_only'}));
 const participants=[...new Set(events.filter(e=>e.token===USDC).flatMap(e=>[e.from,e.to]))];
 const allowancePairs=[...new Map(calls.filter(call=>call.token===USDC).map(call=>[call.owner+':'+call.spender,{token:USDC,owner:call.owner,spender:call.spender}])).values()];
 const result={id,kind:'observed_public_historical_development_case',provenance:{artifact,sha256:sha(bytes),explorerUrl:raw.explorerUrl},identity:{chainId:999,transactionHash:tx.hash,blockHash:tx.blockHash,blockNumber:quantities(tx.blockNumber),transactionIndex:quantities(tx.transactionIndex),timestamp:quantities(block.timestamp)},externalSender:tx.from,rootContract:tx.to,status:receipt.status==='0x1'?'success':'reverted',checks:raw.checks,transferFromCalls:calls,transferEvents:events,eventDeltas,requiredIndependentQueries:{status:'not_run_in_this_milestone',reason:'Scope is accountEffects event projection joined to measurements already available. New balance queries are deferred.',position:{stateBlockHash:tx.blockHash,beforeIndex:quantities(tx.transactionIndex),afterIndex:(BigInt(tx.transactionIndex)+1n).toString()},balances:participants.map(account=>({token:USDC,account,data:'0x70a08231'+account.slice(2).padStart(64,'0')})),allowances:allowancePairs.map(pair=>({...pair,data:'0xdd62ed3e'+pair.owner.slice(2).padStart(64,'0')+pair.spender.slice(2).padStart(64,'0')}))}};
 if(id==='router-permit-consumption'){
  const priorPath='../permission-comparisons/2026-10-25T15-26-52-549Z-http.json',priorBytes=await readFile(new URL(priorPath,import.meta.url)),prior=JSON.parse(priorBytes),runs=prior.cases.find(item=>item.id==='usdc-router-permit-consumed').runs;
  result.availableIndependentState={artifact:priorPath,sha256:sha(priorBytes),basis:'historical_transaction_position_allowance',providers:runs.map(run=>({provider:run.provider,executionIdentity:run.response.allowanceChanges.executionIdentity,allowances:run.response.allowanceChanges.allowances.map(a=>({token:a.asset.address,owner:a.owner,spender:a.spender,beforeRaw:a.beforeRaw,afterRaw:a.afterRaw,deltaRaw:a.deltaRaw}))})),balanceStatus:'No independent token balance queries in the prior permission capture.'};
 }else result.availableIndependentState={status:'not_queried',evidence:'Original prestate storage diff is retained, but no token-storage-layout inference or balanceOf/allowance query result is substituted for a measured state value.'};
 await writeFile(new URL(id+'-decoded.json',import.meta.url),JSON.stringify(result,null,2)+'\n');results.push(result);
}
const lending=[];for(const operation of ['supply','withdraw','borrow','repay']){const fixturePath=`../../fixtures/hyperlend-observed-historical-${operation}.json`;const fixture=JSON.parse(await readFile(new URL(fixturePath,import.meta.url)));const transferFromCalls=[];const walk=(f,path='0')=>{if(f.type==='CALL'&&f.to===USDC&&f.input?.startsWith('0x23b872dd')){const w=f.input.slice(10).match(/.{64}/g);transferFromCalls.push({path,owner:address(w[0]),recipient:address(w[1]),spender:f.from,amountRaw:quantities('0x'+w[2])});}(f.calls??[]).forEach((child,i)=>walk(child,path+'.'+i));};walk(fixture.input.trace);lending.push({operation,transactionHash:fixture.provenance.transactionHash,sourceFixture:fixturePath,transferFromCalls});}
await writeFile(new URL('summary.json',import.meta.url),JSON.stringify({generatedAt:new Date().toISOString(),scope:'Development cases for affected-account event projection and transferFrom permission consumption; not held-out scoring.',newPublicRequests:14,retries:0,caseCount:3,cases:results.map(r=>({id:r.id,identity:r.identity,provenance:r.provenance,transferFromCalls:r.transferFromCalls,usdcEventDeltas:r.eventDeltas.filter(e=>e.token===USDC),independentQueries:r.requiredIndependentQueries})),existingLendingRegressionImplications:lending},null,2)+'\n');
console.log(JSON.stringify({cases:results.map(r=>({id:r.id,identity:r.identity,transferFrom:r.transferFromCalls,usdcNet:r.eventDeltas.filter(e=>e.token===USDC),balanceQueryCount:r.requiredIndependentQueries.balances.length,allowancePairCount:r.requiredIndependentQueries.allowances.length})),lending},null,2));
