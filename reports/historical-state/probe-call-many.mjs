// Bounded read-only follow-up: transaction-position context, no broadcasts.
import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('.', import.meta.url);
const source = JSON.parse(await readFile(new URL('../lending-discovery/withdraw-evidence.json', base)));
const tx = source.captures.transaction.response.result, block = source.captures.block.response.result;
const balance = token => ({ from: tx.from, to: token, data: '0x70a08231' + tx.from.slice(2).padStart(64, '0') });
const hBalance = balance('0x744e4f26ee30213989216e1632d9be3547c4885b');
const uBalance = balance('0xb88339cb7199b77e23db6e890353e22632ba630f');
const original = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, gasPrice: tx.gasPrice };
const probes = [
  ...[0, 4, 5, 6, 1048576].map(index => [`balance-position-${index}`, 'debug_traceCallMany', [[{ transactions: [hBalance] }], { blockNumber: block.number, transactionIndex: index }, { tracer: 'callTracer' }]]),
  ['original-position-4', 'debug_traceCallMany', [[{ transactions: [uBalance, hBalance, original, uBalance, hBalance] }], { blockNumber: { blockHash: block.hash, requireCanonical: true }, transactionIndex: 4 }, { tracer: 'callTracer', tracerConfig: { withLog: true } }]],
];
const report = { retrievedAt: new Date().toISOString(), transactionHash: tx.hash, blockHash: block.hash, originalIndex: 4, methodsAreReadOnly: true, providers: [] };
let save = Promise.resolve();
await Promise.all(['https://hyperliquid.drpc.org', 'https://rpc.hyperlend.finance/archive'].map(async endpoint => {
  const provider = { endpoint, captures: [] }; report.providers.push(provider);
  for (const [label, method, params] of probes) {
    const request = { jsonrpc: '2.0', id: provider.captures.length + 1, method, params };
    let response, status;
    try {
      const http = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
      status = http.status; const raw = await http.text();
      response = raw.length < 8 * 1024 * 1024 ? JSON.parse(raw) : { localError: 'Response exceeded probe capture bound.' };
    } catch { response = { localError: 'Public RPC request failed or returned non-JSON.' }; }
    provider.captures.push({ label, request, httpStatus: status ?? null, response });
    console.log(JSON.stringify({ provider: new URL(endpoint).hostname, label, result: response.error ?? response.localError ?? response.result?.map(bundle => bundle.map(t => ({ output: t.output, gasUsed: t.gasUsed, error: t.error }))) }));
    const text = JSON.stringify(report, null, 2) + '\n'; save = save.then(() => writeFile(new URL('call-many-probes.json', base), text)); await save;
  }
}));
