// Public historical permit/allowance queries only. Never signs or broadcasts.
import { readFile, writeFile } from 'node:fs/promises';
import { createHistoricalStateContext } from '../../src/historical-state.js';
import { RpcClient } from '../../src/rpc.js';
import { StateValidationError } from '../../src/state.js';
import { analyzePermissions } from '../../src/permissions.js';
import { METADATA, USDC, HUSDC } from '../../src/config.js';
const report = { retrievedAt: new Date().toISOString(), runs: [] };
for (const name of ['permit-husdc-direct-verified', 'router-permit-candidate-verified']) {
  const source = JSON.parse(await readFile(new URL(`../permission-discovery/${name}.json`, import.meta.url)));
  const get = label => source.captures[label].response.result;
  const transaction=get('transaction'),receipt=get('receipt'),header=get('block'),trace=get('callTrace');
  const request={chainId:999,from:transaction.from,to:transaction.to,data:transaction.input,value:BigInt(transaction.value).toString()};
  const block={hash:header.hash,number:BigInt(header.number).toString(),timestamp:BigInt(header.timestamp).toString()};
  const observations=analyzePermissions({request,trace,block,metadata:METADATA}).observations;
  const pairs=[...new Map(observations.filter(o=>o.tokenVerified&&[USDC,HUSDC].includes(o.asset?.address)&&['approval_request','permit_request','approval_event'].includes(o.kind)).map(o=>[`${o.asset.address}:${o.owner}:${o.spender}`,{token:o.asset.address,owner:o.owner,spender:o.spender}])).values()];
  for (const endpoint of ['https://hyperliquid.drpc.org','https://rpc.hyperlend.finance/archive']) {
    const context=createHistoricalStateContext({request,block,rpc:new RpcClient({url:endpoint}),transaction,receipt,trace});
    const run={source:`../permission-discovery/${name}.json`,name,endpoint,request,block,observations,pairs,allowances:[]};const started=performance.now();
    try {
      for(const pair of pairs){const result=await context.readPair({to:pair.token,data:'0xdd62ed3e'+pair.owner.slice(2).padStart(64,'0')+pair.spender.slice(2).padStart(64,'0')});run.allowances.push({...pair,...Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.toString()]))});}
      if(!pairs.length)throw new StateValidationError('No verified allowance pairs were discovered.');
      await context.verifyCanonical();run.status='measured';run.executionIdentity=context.executionIdentity;
    }catch(error){run.status='unavailable';run.error=error instanceof StateValidationError?error.message:'Unexpected historical permit validation failure.';}
    run.durationMs=Math.round(performance.now()-started);run.evidence=context.snapshotEvidence();report.runs.push(run);
    await writeFile(new URL('permit-module-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({name,endpoint,status:run.status,error:run.error,durationMs:run.durationMs,allowances:run.allowances}));
  }
}
