// One actual local-app HTTP simulation. No direct RPC, retries, signing or send.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..');
const SOURCE = 'reports/current-validated-decimal/plan.json';
const URL = 'http://127.0.0.1:5174/api/simulate';
const LIMITS = { httpAttempts: 1, httpWallMs: 150000, responseBytes: 8388608, redirects: 0, retries: 0 };
const sha = value => createHash('sha256').update(value).digest('hex');
const read = name => readFile(join(HERE, name));
const save = (name, value) => writeFile(join(HERE, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
async function sourceIdentity() {
  const server = await readFile(join(ROOT, 'src/server.js'), 'utf8');
  const names = [...server.match(/const engineFiles = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const hash = createHash('sha256'), files = [];
  for (const name of names) {
    const bytes = await readFile(join(ROOT, 'src', name));
    hash.update(name + '\0').update(bytes).update('\0');
    files.push({ path: 'src/' + name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const config = await readFile(join(ROOT, 'src/config.js'), 'utf8');
  return { name: 'Transaction Lab', version: config.match(/export const VERSION = '([^']+)'/)[1], sourceSha256: hash.digest('hex'), sourceFiles: names, files };
}
async function selectedInput() {
  const bytes = await readFile(join(ROOT, SOURCE)), source = JSON.parse(bytes);
  const selected = source.cases.filter(c => c.id === 'current-supply'); assert.equal(selected.length, 1);
  const request = { ...selected[0].request, block: 'latest' };
  const { block: oldBlock, ...oldFields } = selected[0].request, { block, ...newFields } = request;
  assert.deepEqual(newFields, oldFields); assert.equal(block, 'latest');
  return { source: { path: SOURCE, sha256: sha(bytes), caseId: 'current-supply', priorBlock: oldBlock }, request };
}
if (process.argv[2] === '--prepare') {
  const { source, request } = await selectedInput(), body = JSON.stringify(request), identity = await sourceIdentity();
  await save('request.json', body);
  await save('source-identity.json', identity);
  await save('declaration.json', { schemaVersion: 1, declaredAt: new Date().toISOString(), purpose: 'One selected current-state Hyperlend USDC supply development check through the actual local app.', source,
    transformation: 'Only request.block changed to latest; all other fields preserved exactly.', request: { method: 'POST', url: URL, headers: { 'content-type': 'application/json' }, bodySha256: sha(body), bytes: Buffer.byteLength(body) },
    expectedImplementation: { name: identity.name, version: identity.version, sourceSha256: identity.sourceSha256, sourceFiles: identity.sourceFiles },
    scriptSha256: sha(await read('capture.mjs')), sourceIdentitySha256: sha(await read('source-identity.json')), limits: LIMITS,
    scope: { readOnlySimulation: true, signing: false, broadcasts: false, independentExecutionComparison: false, historicalTransactionReplay: false, reliabilityRate: false, clientDeadlineDoesNotProveServerCancellation: true } });
  console.log(JSON.stringify({ prepared: true, declarationSha256: sha(await read('declaration.json')), implementation: identity.sourceSha256, version: identity.version }));
} else if (process.argv[2] === '--capture') {
  const declarationBytes = await read('declaration.json'), declaration = JSON.parse(declarationBytes), body = await read('request.json');
  assert.equal(sha(await read('capture.mjs')), declaration.scriptSha256); assert.equal(sha(body), declaration.request.bodySha256);
  assert.equal(sha(await read('source-identity.json')), declaration.sourceIdentitySha256);
  assert.deepEqual(await sourceIdentity(), JSON.parse(await read('source-identity.json')));
  const selected = await selectedInput(); assert.deepEqual(selected.source, declaration.source); assert.deepEqual(selected.request, JSON.parse(body));
  assert.deepEqual(declaration.limits, LIMITS); assert.equal(declaration.request.url, URL);
  const startedAt = new Date().toISOString(), began = performance.now();
  await save('STARTED.json', { startedAt, declarationSha256: sha(declarationBytes), requestSha256: sha(body), attempt: 1 });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), LIMITS.httpWallMs);
  const chunks = []; let size = 0, metadata = { startedAt, attempts: 1, requestSha256: sha(body) }, phase = 'fetch';
  try {
    const response = await fetch(URL, { method: 'POST', headers: declaration.request.headers, body, redirect: 'error', signal: controller.signal });
    metadata.http = { status: response.status, statusText: response.statusText, url: response.url, headers: Object.fromEntries(response.headers) }; phase = 'body';
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMITS.responseBytes) { controller.abort(); throw Object.assign(new Error('Response exceeded the declared byte ceiling.'), { code: 'RESPONSE_LIMIT' }); }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks); await save('response.json', bytes); phase = 'parse';
    const report = JSON.parse(bytes.toString('utf8'));
    metadata = { ...metadata, status: 'response_captured', responseBytes: bytes.length, responseSha256: sha(bytes), implementation: report.implementation ?? null,
      sourceMatches: report.implementation?.sourceSha256 === declaration.expectedImplementation.sourceSha256 && report.implementation?.version === declaration.expectedImplementation.version,
      execution: report.execution ?? null, protocol: report.protocol ?? null, balanceStatus: report.balanceChanges?.status ?? null, allowanceStatus: report.allowanceChanges?.status ?? null,
      affectedBalanceStatus: report.affectedBalanceChanges?.status ?? null };
  } catch (error) {
    if (phase !== 'parse' && chunks.length) await save('response.partial.body', Buffer.concat(chunks));
    metadata = { ...metadata, status: phase === 'parse' ? 'non_json_response_captured' : 'capture_failed', failurePhase: phase,
      error: { name: error?.name ?? 'Error', code: error?.code ?? error?.cause?.code ?? null, message: controller.signal.aborted ? 'Client deadline or response bound reached.' : 'The single HTTP attempt or response parsing failed.' }, observedResponseBytes: size };
  } finally { clearTimeout(timer); }
  metadata.finishedAt = new Date().toISOString(); metadata.durationMs = performance.now() - began;
  metadata.sourceUnchangedDuringAttempt = JSON.stringify(await sourceIdentity()) === (await read('source-identity.json')).toString().trim();
  // Compare parsed forms because the saved inventory is intentionally pretty-printed.
  metadata.sourceUnchangedDuringAttempt = JSON.stringify(await sourceIdentity()) === JSON.stringify(JSON.parse(await read('source-identity.json')));
  await save('metadata.json', metadata);
  console.log(JSON.stringify({ status: metadata.status, httpStatus: metadata.http?.status, execution: metadata.execution?.status, balanceStatus: metadata.balanceStatus, allowanceStatus: metadata.allowanceStatus, sourceMatches: metadata.sourceMatches, durationMs: metadata.durationMs }));
} else throw new Error('Use --prepare once, then --capture once.');
