// Read-only validation of the historical allowance context at a known supply.
import { readFile, writeFile } from 'node:fs/promises';
import { createHistoricalStateContext } from '../../src/historical-state.js';
import { RpcClient } from '../../src/rpc.js';
import { USDC, HUSDC, POOL } from '../../src/config.js';
const sources = JSON.parse(await readFile(new URL('view-probes.json', import.meta.url)));
const report = { retrievedAt: new Date().toISOString(), runs: [] };
for (const provider of sources.providers) {
  const captured = label => provider.captures.find(c => c.label === label).response.result;
  const transaction = captured('transaction'), receipt = captured('receipt'), trace = captured('trace'), header = captured('block');
  const request = { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() };
  const block = { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() };
  const rpc = new RpcClient({ url: provider.endpoint });
  const context = createHistoricalStateContext({ request, block, rpc, transaction, receipt, trace });
  const run = { endpoint: provider.endpoint, request, block, allowances: [] }, started = performance.now();
  try {
    for (const token of [USDC, HUSDC]) {
      const query = { to: token, data: '0xdd62ed3e' + request.from.slice(2).padStart(64, '0') + POOL.slice(2).padStart(64, '0') };
      const measured = await context.readPair(query);
      run.allowances.push({ token, owner: request.from, spender: POOL, ...Object.fromEntries(Object.entries(measured).map(([key,value])=>[key,value.toString()])) });
    }
    await context.verifyCanonical(); run.status = 'measured'; run.executionIdentity = context.executionIdentity;
  } catch (error) { run.status = 'unavailable'; run.error = error.name === 'StateValidationError' ? error.message : 'Unexpected historical allowance validation failure.'; }
  run.durationMs = Math.round(performance.now()-started); run.evidence = context.snapshotEvidence(); report.runs.push(run);
  await writeFile(new URL('view-module-validation.json',import.meta.url), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({endpoint:run.endpoint,status:run.status,error:run.error,durationMs:run.durationMs,allowances:run.allowances}));
}
