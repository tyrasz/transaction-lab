// Bounded public, read-only capability research. Never signs or broadcasts.
import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('.', import.meta.url);
const observed = JSON.parse(await readFile(new URL('../lending-discovery/withdraw-evidence.json', base)));
const tx = observed.captures.transaction.response.result;
const block = observed.captures.block.response.result;
const ownerWord = tx.from.slice(2).padStart(64, '0');
const balanceCall = { from: tx.from, to: '0x744e4f26ee30213989216e1632d9be3547c4885b', data: '0x70a08231' + ownerWord };
const originalCall = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, gasPrice: tx.gasPrice };
const pinned = { blockHash: block.hash, requireCanonical: true };
const probes = [
  ['client', 'web3_clientVersion', []],
  ['canonical-block', 'eth_getBlockByNumber', [block.number, false]],
  ['historical-transaction', 'debug_traceTransaction', [tx.hash, { tracer: 'callTracer', tracerConfig: { withLog: true } }]],
  ['historical-prestate-diff', 'debug_traceTransaction', [tx.hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]],
  ...[undefined, '0x0', tx.transactionIndex, '0x5', '0x6', '0x100000'].map(index => [`balance-index-${index ?? 'omitted'}`, 'debug_traceCall', [balanceCall, pinned, { tracer: 'callTracer', ...(index === undefined ? {} : { txIndex: index }) }]]),
  ['original-at-index', 'debug_traceCall', [originalCall, pinned, { tracer: 'callTracer', tracerConfig: { withLog: true }, txIndex: tx.transactionIndex }]],
  ['trace-call-many', 'trace_callMany', [[[balanceCall, ['trace']], [originalCall, ['trace', 'stateDiff']], [balanceCall, ['trace']]], block.number]],
];
const report = { retrievedAt: new Date().toISOString(), purpose: 'Determine whether public RPC supports original transaction-position state, not block-end or parent-only approximations.', transactionHash: tx.hash, blockHash: block.hash, blockNumber: block.number, transactionIndex: tx.transactionIndex, methodsAreReadOnly: true, providers: [] };
let save = Promise.resolve();
await Promise.all(['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive'].map(async endpoint => {
  const provider = { endpoint, captures: [] }; report.providers.push(provider);
  for (const [label, method, params] of probes) {
    const request = { jsonrpc: '2.0', id: provider.captures.length + 1, method, params };
    let response, status;
    try {
      const http = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
      status = http.status;
      const raw = await http.text();
      response = raw.length < 8 * 1024 * 1024 ? JSON.parse(raw) : { localError: 'Response exceeded probe capture bound.' };
    } catch { response = { localError: 'Public RPC request failed or returned non-JSON.' }; }
    provider.captures.push({ label, request, httpStatus: status ?? null, response });
    console.log(JSON.stringify({ provider: new URL(endpoint).hostname, label, result: response.error ?? response.localError ?? (typeof response.result === 'string' ? response.result : { output: response.result?.output, gasUsed: response.result?.gasUsed, keys: Object.keys(response.result ?? {}) }) }));
    const serialized = JSON.stringify(report, null, 2) + '\n';
    save = save.then(() => writeFile(new URL('capability-probes.json', base), serialized)); await save;
  }
}));
