// A single selected development request, not a blind cohort or accuracy test.
// No retries or transaction submission. Preserve the request before dispatch.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const [inputPath, outputPath, portText = '5174'] = process.argv.slice(2);
const port = Number(portText);
if (!inputPath || !outputPath || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Use: capture-local-api.mjs INPUT OUTPUT [LOOPBACK_PORT]');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requestText = await readFile(resolve(inputPath), 'utf8'); JSON.parse(requestText);
const output = resolve(outputPath); await mkdir(output, { recursive: false });
const save = (name, bytes) => writeFile(join(output, name), bytes, { flag: 'wx' });
await save('request.json', requestText);
const startedAt = new Date().toISOString(), url = `http://127.0.0.1:${port}/api/evm/local-preview`;
await save('declaration.json', JSON.stringify({ kind: 'selected_development_api_capture', startedAt, url,
  requestSha256: sha(requestText), requestBytes: Buffer.byteLength(requestText), attempts: 1,
  profile: 'unsigned_unpriced_block_end', currentStateQuote: false, submission: false }, null, 2) + '\n');
let metadata;
try {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText, signal: AbortSignal.timeout(200000) });
  const bytes = Buffer.from(await response.arrayBuffer()); await save('response.json', bytes);
  const result = JSON.parse(bytes.toString('utf8'));
  metadata = { startedAt, finishedAt: new Date().toISOString(), status: response.status, headers: Object.fromEntries(response.headers),
    responseBytes: bytes.length, responseSha256: sha(bytes), resultStatus: result.status, execution: result.execution,
    measurements: result.measurements?.map(row => ({ identity: row.identity, status: row.status, values: row.values, reason: row.reason })),
    sourceSha256: result.implementation?.sourceSha256, version: result.implementation?.version, usage: result.usage, error: result.error };
} catch (error) {
  metadata = { startedAt, finishedAt: new Date().toISOString(), status: 'capture_failed', error: { name: error.name, message: error.message } };
}
await save('metadata.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ output, ...metadata }, null, 2));
