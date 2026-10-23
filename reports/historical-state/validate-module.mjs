// Bounded live module validation, public read-only calls only.
import { readFile, writeFile } from 'node:fs/promises';
import { createHistoricalStateContext } from '../../src/historical-state.js';
import { RpcClient } from '../../src/rpc.js';
import { USDC, HUSDC, VUSDC } from '../../src/config.js';
const base = new URL('.', import.meta.url);
const report = { retrievedAt: new Date().toISOString(), runs: [] };
for (const endpoint of ['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive']) {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const source = JSON.parse(await readFile(new URL(`../lending-discovery/${operation}-evidence.json`, base)));
    const transaction = source.captures.transaction.response.result, receipt = source.captures.receipt.response.result, trace = source.captures.historicalTrace.response.result, header = source.captures.block.response.result;
    const request = { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() };
    const block = { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() };
    const rpc = new RpcClient({ url: endpoint });
    const context = createHistoricalStateContext({ request, block, rpc, transaction, receipt, trace });
    const started = performance.now();
    const run = { endpoint, operation, request, block, balances: [] };
    try {
      for (const token of [USDC, operation === 'withdraw' ? HUSDC : VUSDC]) {
        const result = await context.readPair({ to: token, data: '0x70a08231' + request.from.slice(2).padStart(64, '0') });
        run.balances.push({ token, ...Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.toString()])) });
      }
      await context.verifyCanonical(); run.status = 'measured'; run.executionIdentity = context.executionIdentity;
    } catch (error) { run.status = 'unavailable'; run.error = error.name === 'StateValidationError' ? error.message : 'Unexpected validation failure.'; }
    run.durationMs = Math.round(performance.now()-started); run.evidence = context.snapshotEvidence();
    report.runs.push(run);
    await writeFile(new URL('module-validation.json',base),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({endpoint,operation,status:run.status,error:run.error,durationMs:run.durationMs,balances:run.balances,rpcCalls:run.evidence.request.length}));
  }
}
