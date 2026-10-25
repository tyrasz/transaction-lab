// Real historical direct-approval validation. Public read-only calls only.
import { readFile, writeFile } from 'node:fs/promises';
import { createHistoricalStateContext } from '../../src/historical-state.js';
import { RpcClient } from '../../src/rpc.js';
import { StateValidationError } from '../../src/state.js';
const source = JSON.parse(await readFile(new URL('../permission-discovery/approve-usdc-hyperlend-verified.json', import.meta.url)));
const captured = name => source.captures[name].response.result;
const transaction = captured('transaction'), receipt = captured('receipt'), header = captured('block');
const trace = captured('callTrace');
const request = { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() };
const block = { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() };
const spender = '0x' + transaction.input.slice(34,74);
const report = { retrievedAt: new Date().toISOString(), source: '../permission-discovery/approve-usdc-hyperlend-verified.json', runs: [] };
for (const endpoint of ['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive']) {
  const context = createHistoricalStateContext({ request, block, rpc: new RpcClient({url:endpoint}), transaction, receipt, trace });
  const run = { endpoint, request, block, owner: request.from, spender }, started = performance.now();
  try {
    const measured = await context.readPair({ to: request.to, data: '0xdd62ed3e' + request.from.slice(2).padStart(64,'0') + spender.slice(2).padStart(64,'0') });
    run.allowance = Object.fromEntries(Object.entries(measured).map(([key,value])=>[key,value.toString()]));
    await context.verifyCanonical(); run.status='measured';run.executionIdentity=context.executionIdentity;
  } catch(error) {run.status='unavailable';run.error=error instanceof StateValidationError?error.message:'Unexpected historical approval validation failure.';}
  run.durationMs=Math.round(performance.now()-started);run.evidence=context.snapshotEvidence();report.runs.push(run);
  await writeFile(new URL('approval-module-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({endpoint,status:run.status,error:run.error,allowance:run.allowance,durationMs:run.durationMs}));
}
