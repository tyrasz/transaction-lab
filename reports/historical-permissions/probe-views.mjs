// Bounded allowance view-shape probes at a known original Hyperlend supply.
// Public read-only RPC only; never signs or broadcasts.
import { writeFile } from 'node:fs/promises';
import { RpcClient, assertNoProviderErrorResult } from '../../src/rpc.js';
import { EXAMPLES, USDC, HUSDC, POOL } from '../../src/config.js';
const report = { retrievedAt: new Date().toISOString(), purpose: 'Verify allowance view behavior at an original supply position.', providers: [] };
const hash = EXAMPLES.find(e => e.id === 'hyperlend-usdc-supply').transactionHash;
for (const endpoint of ['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive']) {
  const rpc = new RpcClient({ url: endpoint });
  const provider = { endpoint, transactionHash: hash, captures: [] }; report.providers.push(provider);
  async function call(label, method, params) {
    const record = { label, request: { method, params } }; provider.captures.push(record);
    try { const result = await rpc.call(method, params); assertNoProviderErrorResult(method, result); record.response = { result }; return result; }
    catch (error) { record.response = { error: { code: error.code ?? 'RPC_ERROR', message: 'The public read-only RPC probe failed.', ...(Number.isSafeInteger(error.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) } }; return null; }
    finally { await writeFile(new URL('view-probes.json', import.meta.url), JSON.stringify(report, null, 2) + '\n'); }
  }
  const tx = await call('transaction', 'eth_getTransactionByHash', [hash]);
  if (!tx) continue;
  const header = await call('block', 'eth_getBlockByHash', [tx.blockHash, false]);
  const receipt = await call('receipt', 'eth_getTransactionReceipt', [hash]);
  const trace = await call('trace', 'debug_traceTransaction', [hash, { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
  if (!header || !receipt || !trace) continue;
  for (const token of [USDC, HUSDC]) for (const offset of [0, 1]) {
    const query = { from: tx.from, to: token, value: '0x0', data: '0xdd62ed3e' + tx.from.slice(2).padStart(64, '0') + POOL.slice(2).padStart(64, '0'), gas: '0x493e0', gasPrice: tx.gasPrice };
    const result = await call(`${token === USDC ? 'usdc' : 'husdc'}-${offset ? 'after' : 'before'}`, 'debug_traceCallMany', [[{ transactions: [query] }], { blockNumber: { blockHash: header.hash, requireCanonical: true }, transactionIndex: Number(BigInt(tx.transactionIndex)) + offset }, { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
    console.log(JSON.stringify({endpoint,token,offset,result:result?.[0]?.[0]}));
  }
}
