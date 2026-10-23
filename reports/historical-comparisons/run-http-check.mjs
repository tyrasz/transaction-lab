import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../../src/server.js';
import { runHistoricalChecks } from '../../src/check-historical.js';
import { RpcError } from '../../src/rpc.js';
const directory = fileURLToPath(new URL('./', import.meta.url));
let activeRpc;
const httpRuns = [];
const server = createAppServer({ persist: false, rpcFactory: () => activeRpc });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}/api/replay`;
try {
  const report = await runHistoricalChecks({ writeReport: false, replayImpl: async (request, rpc) => {
    activeRpc = rpc;
    const record = { transactionHash: request.transactionHash, provider: rpc.provider, request: { method: 'POST', path: '/api/replay', body: structuredClone(request) } };
    httpRuns.push(record);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(240000) });
    record.response = { status: response.status, contentType: response.headers.get('content-type'), body: await response.json() };
    console.log(JSON.stringify({ transactionHash: request.transactionHash, provider: rpc.provider, httpStatus: response.status, measurementStatus: record.response.body.balanceChanges?.status ?? null, measurementWarning: record.response.body.balanceChanges?.status === 'measured' ? null : record.response.body.balanceChanges?.warnings?.at(-1) ?? null }));
    if (!response.ok) throw new RpcError('The local historical API route did not return success.', 'RPC_ERROR');
    return record.response.body;
  } });
  report.executionTransport = { kind: 'ephemeral_local_http', route: 'POST /api/replay', persistedApiReports: false, originalServerUntouched: true, httpRuns };
  report.outputPath = `${directory}/${report.createdAt.replace(/[:.]/g, '-')}-http.json`;
  await mkdir(directory, { recursive: true });
  await writeFile(report.outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, summary: report.summary, outputPath: report.outputPath }));
  for (const item of report.cases) console.log(JSON.stringify({ id: item.id, status: item.status, failedChecks: item.comparison.checks.filter(check => !check.equal).map(check => ({name:check.name,provider:check.provider})), observations: item.comparison.observations, incompleteReason: item.comparison.reason ?? null }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
} finally { await new Promise(resolve => server.close(resolve)); }
