import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const same = JSON.parse(await readFile(new URL('./same-context-probes.json', import.meta.url)));
const initial = JSON.parse(await readFile(new URL('./stateful-capability-probes.json', import.meta.url)));
const probes = [];
for (const [index, provider] of ['drpc', 'hyperlend-archive'].entries()) {
  const source = same.probes.find(p => p.provider === provider && p.variant === 'same_number_same_time');
  const block = initial.probes.find(p => p.provider === provider && p.label === 'pin_latest_block').response.result;
  const request = structuredClone(source.request);
  request.id = 9500 + index;
  request.params[0].blockStateCalls[0].blockOverrides = { number: block.number, time: block.timestamp, gasLimit: block.gasLimit, baseFeePerGas: block.baseFeePerGas, prevRandao: block.mixHash, feeRecipient: block.miner };
  const response = JSON.parse(execFileSync('curl', ['--silent', '--show-error', '--max-time', '25', '-H', 'Content-Type: application/json', '--data-binary', '@-', source.url], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  probes.push({ provider, url: source.url, request, response, pinnedBlock: block });
  await writeFile(new URL('./header-context-probes.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), probes }, null, 2)}\n`);
  const output = response.result?.[0];
  console.log(JSON.stringify({ provider, error: response.error, number: output?.number, timestamp: output?.timestamp, baseFeePerGas: output?.baseFeePerGas, mixHash: output?.mixHash, statuses: output?.calls.map(c => c.status), errors: output?.calls.map(c => c.error) }));
}
