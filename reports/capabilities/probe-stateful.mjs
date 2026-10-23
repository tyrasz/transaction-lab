import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const fixture = JSON.parse(await readFile(new URL('../../fixtures/hyperlend-observed-supply.json', import.meta.url)));
const { chainId, ...baseCall } = fixture.input.request;
const supply = { ...baseCall, value: '0x0', gas: '0x1e8480' };
const tokens = ['0xb88339cb7199b77e23db6e890353e22632ba630f', '0x744e4f26ee30213989216e1632d9be3547c4885b'];
const balances = tokens.map(to => ({ from: supply.from, to, data: `0x70a08231${supply.from.slice(2).padStart(64, '0')}`, gas: '0x7a120' }));
const providers = [
  { id: 'drpc', url: 'https://hyperliquid.drpc.org' },
  { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' },
];
const probes = [];
let id = 7000;
async function rpc(provider, label, method, params) {
  const request = { jsonrpc: '2.0', id: id++, method, params };
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response, transportError = null;
  try {
    const text = execFileSync('curl', ['--silent', '--show-error', '--max-time', '25', '-H', 'Content-Type: application/json', '--data-binary', '@-', provider.url], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    try { response = JSON.parse(text); } catch { response = { unparsedBody: text }; }
  } catch (error) {
    transportError = String(error.message);
    response = error.stdout ? { unparsedBody: error.stdout.toString() } : null;
  }
  const probe = { provider: provider.id, url: provider.url, label, startedAt, elapsedMs: Math.round(performance.now() - start), request, response, transportError };
  probes.push(probe);
  console.log(JSON.stringify({ provider: provider.id, label, elapsedMs: probe.elapsedMs, error: response?.error ?? transportError, resultType: Array.isArray(response?.result) ? 'array' : typeof response?.result }));
  await writeFile(new URL('./stateful-capability-probes.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), purpose: 'Read-only capability probing; no signatures or transactions broadcast', sources: ['https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth_simulatev1', 'https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer', 'https://docs.hyperlend.finance/developer-documentation/data-and-indexers'], probes }, null, 2)}\n`);
  return response;
}
for (const provider of providers) {
  const chain = await rpc(provider, 'chain_id', 'eth_chainId', []);
  if (chain?.result !== '0x3e7') continue;
  const blockResponse = await rpc(provider, 'pin_latest_block', 'eth_getBlockByNumber', ['latest', false]);
  const block = blockResponse?.result;
  if (!block?.hash || !block?.number) continue;
  const pinned = { blockHash: block.hash, requireCanonical: true };
  await rpc(provider, 'stateful_balance_supply_balance', 'eth_simulateV1', [{
    blockStateCalls: [{ blockOverrides: { number: `0x${(BigInt(block.number) + 1n).toString(16)}`, time: `0x${(BigInt(block.timestamp) + 1n).toString(16)}` }, calls: [...balances, supply, ...balances] }],
    validation: false,
    traceTransfers: false,
    returnFullTransactions: false,
  }, block.number]);
  await rpc(provider, 'prestate_diff', 'debug_traceCall', [supply, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
  for (const [index, call] of balances.entries()) await rpc(provider, `balance_before_${index ? 'husdc' : 'usdc'}`, 'eth_call', [call, pinned]);
}
