import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const prior = JSON.parse(await readFile(new URL('./poststate-capability-probes.json', import.meta.url)));
const probes = [];
let id = 9000;
for (const provider of ['drpc', 'hyperlend-archive']) {
  const source = prior.probes.find(p => p.provider === provider && p.label === 'stateful_reduced_gas');
  const block = prior.summaries.find(s => s.provider === provider).block;
  for (const variant of ['same_number_same_time', 'next_number_same_time']) {
    const request = structuredClone(source.request);
    request.id = id++;
    request.params[0].blockStateCalls[0].blockOverrides = { number: variant === 'same_number_same_time' ? block.number : `0x${(BigInt(block.number) + 1n).toString(16)}`, time: block.timestamp };
    const body = execFileSync('curl', ['--silent', '--show-error', '--max-time', '25', '-H', 'Content-Type: application/json', '--data-binary', '@-', source.url], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const response = JSON.parse(body);
    probes.push({ provider, url: source.url, variant, block, request, response });
    await writeFile(new URL('./same-context-probes.json', import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), probes }, null, 2)}\n`);
    console.log(JSON.stringify({ provider, variant, error: response.error, blockNumber: response.result?.[0]?.number, timestamp: response.result?.[0]?.timestamp, statuses: response.result?.[0]?.calls?.map(c => c.status) }));
  }
}
