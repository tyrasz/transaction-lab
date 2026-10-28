// One selected historical provider-API verification. No independent proof
// comparison, retries, signed admission or transaction submission.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const source = await readFile(new URL('./capture.mjs', import.meta.url));
const originalBytes = await readFile(new URL('../ordinary-ethereum-unresolved-v4/cases/007/request.json', import.meta.url));
const request = JSON.parse(originalBytes).apiRequest, text = JSON.stringify(request);
const save = (name, value) => writeFile(new URL(name, import.meta.url), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await save('request.json', text);
await save('declaration.json', { startedAt: new Date().toISOString(), sourceSha256: sha(source), inputArtifactSha256: sha(originalBytes), requestSha256: sha(text),
  expectedImplementationSha256: '99dfe5fb959e2bfa761ae62c17266d9b1dd9ebca60e03d0b237f496eeb8afaef',
  purpose: 'selected_historical_blob_call_actual_provider_HTTP_API', attempts: 1, profile: 'unsigned_unpriced_original_parent_block',
  independentExecutionComparison: false, originalTransactionPosition: false, submissions: 0 });
let metadata;
try {
  const response = await fetch('http://127.0.0.1:5174/api/evm/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(170000) });
  const body = await response.text(); await save('response.json', body); const result = JSON.parse(body);
  metadata = { status: response.status, responseSha256: sha(body), responseBytes: Buffer.byteLength(body),
    implementation: result.implementation, canonicalStatus: result.canonicalStatus, execution: result.execution?.status,
    blobContextValidation: result.blobContextValidation, measurementFailure: result.measurementFailure, accounting: result.accounting,
    sourceMatches: result.implementation?.sourceSha256 === '99dfe5fb959e2bfa761ae62c17266d9b1dd9ebca60e03d0b237f496eeb8afaef' };
} catch (error) { metadata = { status: 'capture_failed', error: { name: error.name, message: error.message } }; }
metadata.finishedAt = new Date().toISOString(); await save('metadata.json', metadata);
console.log(JSON.stringify({ status: metadata.status, canonicalStatus: metadata.canonicalStatus, execution: metadata.execution, sourceMatches: metadata.sourceMatches, calls: metadata.accounting?.rpcCalls, blobContext: metadata.blobContextValidation?.status }, null, 2));
