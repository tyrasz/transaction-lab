import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const initial = JSON.parse(await readFile(new URL('./stateful-capability-probes.json', import.meta.url)));
const probes = [];
const summaries = [];
let id = 8000;
async function rpc(provider, url, label, method, params) {
  const request = { jsonrpc: '2.0', id: id++, method, params };
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response, transportError = null;
  try {
    const body = execFileSync('curl', ['--silent', '--show-error', '--max-time', '25', '-H', 'Content-Type: application/json', '--data-binary', '@-', url], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    try { response = JSON.parse(body); } catch { response = { unparsedBody: body }; }
  } catch (error) { transportError = String(error.message); response = error.stdout ? { unparsedBody: error.stdout.toString() } : null; }
  probes.push({ provider, url, label, startedAt, elapsedMs: Math.round(performance.now() - start), request, response, transportError });
  console.log(JSON.stringify({ provider, label, error: response?.error ?? transportError, resultType: Array.isArray(response?.result) ? 'array' : typeof response?.result }));
  await save();
  return response;
}
async function save() {
  await writeFile(new URL('./poststate-capability-probes.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), purpose: 'Read-only simulations and ephemeral eth_call state overrides only; no onchain writes', initialEvidence: './stateful-capability-probes.json', probes, summaries }, null, 2)}\n`);
}
const ZERO_WORD = `0x${'0'.repeat(64)}`;
for (const provider of ['drpc', 'hyperlend-archive']) {
  const prior = initial.probes.filter(p => p.provider === provider);
  const originalSimulation = prior.find(p => p.label === 'stateful_balance_supply_balance');
  const prestate = prior.find(p => p.label === 'prestate_diff');
  const beforeUSDC = prior.find(p => p.label === 'balance_before_usdc');
  const beforeHUSDC = prior.find(p => p.label === 'balance_before_husdc');
  const block = prior.find(p => p.label === 'pin_latest_block')?.response?.result;
  if (!originalSimulation || !block) continue;
  const { url } = originalSimulation;
  const params = structuredClone(originalSimulation.request.params);
  params[0].blockStateCalls[0].calls.forEach((call, index) => { call.gas = index === 2 ? '0x7a120' : '0x186a0'; });
  const stateful = await rpc(provider, url, 'stateful_reduced_gas', 'eth_simulateV1', params);
  const calls = stateful?.result?.[0]?.calls;
  const summary = { provider, block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, stateful: stateful?.error ? { error: stateful.error } : null, poststate: null };
  if (calls?.length === 5 && calls.every(call => call.status === '0x1')) {
    summary.stateful = { success: true, simulatedBlock: stateful.result[0].number, simulatedTimestamp: stateful.result[0].timestamp, usdcBeforeRaw: BigInt(calls[0].returnData).toString(), usdcAfterRaw: BigInt(calls[3].returnData).toString(), usdcDeltaRaw: (BigInt(calls[3].returnData) - BigInt(calls[0].returnData)).toString(), husdcBeforeRaw: BigInt(calls[1].returnData).toString(), husdcAfterRaw: BigInt(calls[4].returnData).toString(), husdcDeltaRaw: (BigInt(calls[4].returnData) - BigInt(calls[1].returnData)).toString() };
  }
  const diff = prestate?.response?.result;
  if (diff?.pre && diff?.post) {
    const overrides = {};
    for (const account of new Set([...Object.keys(diff.pre), ...Object.keys(diff.post)])) {
      const beforeStorage = diff.pre[account]?.storage ?? {};
      const afterStorage = diff.post[account]?.storage ?? {};
      const storageKeys = new Set([...Object.keys(beforeStorage), ...Object.keys(afterStorage)]);
      if (storageKeys.size) overrides[account] = { stateDiff: Object.fromEntries([...storageKeys].map(slot => [slot, afterStorage[slot] ?? ZERO_WORD])) };
    }
    const afterUSDC = await rpc(provider, url, 'poststate_balance_usdc', 'eth_call', [...beforeUSDC.request.params, overrides]);
    const afterHUSDC = await rpc(provider, url, 'poststate_balance_husdc', 'eth_call', [...beforeHUSDC.request.params, overrides]);
    if (afterUSDC?.result && afterHUSDC?.result) {
      summary.poststate = { success: true, basis: 'balanceOf before and after applying all changed storage slots from prestateTracer diff at identical block hash and timestamp', limits: 'Storage-only reconstruction is justified for this observed deposit: no account creations, deletions, code changes, or changed native balances were present. Do not generalize to arbitrary transactions without handling all diff fields.', usdcBeforeRaw: BigInt(beforeUSDC.response.result).toString(), usdcAfterRaw: BigInt(afterUSDC.result).toString(), usdcDeltaRaw: (BigInt(afterUSDC.result) - BigInt(beforeUSDC.response.result)).toString(), husdcBeforeRaw: BigInt(beforeHUSDC.response.result).toString(), husdcAfterRaw: BigInt(afterHUSDC.result).toString(), husdcDeltaRaw: (BigInt(afterHUSDC.result) - BigInt(beforeHUSDC.response.result)).toString() };
    }
    const trace = await rpc(provider, url, 'same_block_call_trace', 'debug_traceCall', [params[0].blockStateCalls[0].calls[2], prestate.request.params[1], { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]);
    const logs = [];
    function walk(frame) { if (!frame || frame.error) return; logs.push(...(frame.logs ?? [])); for (const child of frame.calls ?? []) walk(child); }
    walk(trace?.result);
    const mint = logs.find(log => log.address?.toLowerCase() === '0x744e4f26ee30213989216e1632d9be3547c4885b' && log.topics?.[0] === '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196');
    if (mint) summary.mintEventAtPinnedBlock = { valueRaw: BigInt(`0x${mint.data.slice(2, 66)}`).toString(), balanceIncreaseRaw: BigInt(`0x${mint.data.slice(66, 130)}`).toString() };
  }
  summaries.push(summary);
  await save();
  console.log(JSON.stringify(summary));
}
