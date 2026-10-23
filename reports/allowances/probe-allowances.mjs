import { mkdir, writeFile } from 'node:fs/promises';
import { RpcClient, normalizeBlock } from '../../src/rpc.js';
import { analyzeTrace } from '../../src/analyze.js';
import { analyzePermissions } from '../../src/permissions.js';
import { measureAllowances } from '../../src/allowances.js';
import { EXAMPLES, METADATA, POOL, USDC, HUSDC } from '../../src/config.js';

const rpc = new RpcClient({ url: 'https://hyperliquid.drpc.org' });
await rpc.verifyChain();
const header = await rpc.call('eth_getBlockByNumber', ['latest', false]);
const block = normalizeBlock(header);
const owner = EXAMPLES.find(example => example.id === 'hyperlend-usdc-supply').request.from;
const cases = [];
await mkdir(new URL('.', import.meta.url), { recursive: true });
for (const token of [USDC, HUSDC]) for (const [label, amount] of [['max', (1n << 256n) - 1n], ['revoke', 0n], ['bounded', 100000000n]]) {
  const request = { chainId: 999, from: owner, to: token, value: '0', data: `0x095ea7b3${POOL.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` };
  const traceRequest = { method: 'debug_traceCall', params: [{ from: owner, to: token, value: '0x0', data: request.data, gas: '0x4c4b40' }, { blockHash: block.hash, requireCanonical: true }, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }] };
  const trace = await rpc.call(traceRequest.method, traceRequest.params);
  const analysis = analyzeTrace({ request, trace, block, metadata: METADATA, mode: 'simulation' });
  const permissions = analyzePermissions({ request, trace, metadata: METADATA });
  const result = await measureAllowances({ request, trace, block, rpc, metadata: METADATA, analysis, permissions });
  cases.push({ id: `${token === USDC ? 'usdc' : 'husdc'}-${label}`, request, traceEvidence: { request: traceRequest, response: trace }, permissions, result });
  await writeFile(new URL('./public-allowance-probes.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), purpose: 'Unsigned read-only simulations. No approval was signed, broadcast, or persisted.', provider: rpc.provider, block, header, owner, spender: POOL, cases }, null, 2)}\n`);
  console.log(JSON.stringify({ id: cases.at(-1).id, execution: analysis.execution.status, measurement: result.status, allowances: result.allowances.map(allowance => ({ beforeRaw: allowance.beforeRaw, afterRaw: allowance.afterRaw, changed: allowance.changed, consistency: allowance.consistency.eventComparison })), warnings: result.status !== 'measured' ? result.warnings : [] }));
}
