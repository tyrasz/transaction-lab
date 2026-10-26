// Offline evidence verification only. This file never imports a network client.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => readFile(new URL(file, import.meta.url));
const raw = await read('capture.json');
assert.equal(sha(raw), 'ada8360af17b2ebce8caa301ddea304814e730f2e1d492517ae5669081601d80');
const capture = JSON.parse(raw), manifest = JSON.parse(await read('manifest.json'));
assert.deepEqual(capture.manifest, manifest);
assert.equal(sha(await read('run.mjs')), manifest.sourceSha256);
assert.equal(capture.records.length, 48); assert.equal(capture.accounting.rpc, 48);
const allowed = new Map(manifest.chains.flatMap(chain => chain.providers.map(provider => [provider.id, provider.url])));
let bytes = 0, successes = 0, errors = 0;
for (const [index, record] of capture.records.entries()) {
  assert.equal(record.request.id, index + 1); assert.equal(record.endpoint, allowed.get(record.provider));
  assert.equal(JSON.stringify(record.request), record.requestText); assert.equal(sha(record.requestText), record.requestSha256);
  assert.equal(record.bodyComplete, true); assert.equal(record.transportError, undefined);
  const body = Buffer.from(record.responseBase64, 'base64');
  assert.equal(body.length, record.responseBytes); assert.equal(sha(body), record.responseSha256);
  assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), record.responseText);
  assert.deepEqual(JSON.parse(record.responseText), record.response);
  assert.equal(record.response.jsonrpc, '2.0'); assert.equal(record.response.id, record.request.id);
  assert.equal(Object.hasOwn(record.response, 'result') !== Object.hasOwn(record.response, 'error'), true);
  assert.deepEqual(JSON.parse(await read(`response-${String(index + 1).padStart(2, '0')}.json`)), record);
  assert.ok(record.responseBytes <= manifest.limits.responseBytes); assert.ok(record.elapsedMs < manifest.limits.requestMs);
  bytes += body.length; if (record.rpcOutcome === 'result') successes++; else { assert.equal(record.rpcOutcome, 'error'); errors++; }
}
assert.equal(bytes, capture.accounting.responseBytes); assert.equal(successes, 33); assert.equal(errors, 15);
for (const provider of capture.providers) {
  const rows = capture.records.filter(record => record.provider === provider.id), by = label => rows.find(record => record.label === label);
  assert.equal(rows.length, 12); assert.deepEqual(rows.map(record => record.label), manifest.probes);
  const header = by('fixed-header').response.result;
  assert.equal(by('chain').response.result, '0x' + provider.chainId.toString(16));
  assert.equal(provider.blockHash, header.hash); assert.equal(provider.blockNumber, BigInt(header.number).toString());
  assert.equal(by('canonical-header-recheck').response.result.hash, header.hash);
  assert.equal(by('canonical-header-recheck').response.result.number, header.number);
  assert.equal(by('usdc-balance-hash-call').response.result, '0x' + '0'.repeat(64));
  assert.equal(by('code-stateDiff-hash-call-witness').response.result, '0x' + '0'.repeat(62) + '2a');
  for (const row of rows.filter(row => ['eth_call', 'debug_traceCall'].includes(row.request.method))) assert.deepEqual(row.request.params[1], { blockHash: header.hash, requireCanonical: true });
  const simulation = by('usdc-eth_simulateV1-next-block').response.result;
  assert.equal(simulation.length, 1); assert.equal(BigInt(simulation[0].number), BigInt(header.number) + 1n); assert.equal(BigInt(simulation[0].timestamp), BigInt(header.timestamp) + (provider.chainId === 1 ? 12n : 2n));
  assert.equal(simulation[0].calls.length, 1); assert.equal(simulation[0].calls[0].status, '0x1');
  assert.equal(simulation[0].calls[0].returnData, by('usdc-balance-hash-call').response.result);
  if (provider.id === 'ethereum-drpc') {
    const trace = by('usdc-hash-callTracer').response.result;
    assert.equal(trace.type, 'CALL'); assert.equal(trace.output, by('usdc-balance-hash-call').response.result); assert.equal(trace.error, undefined);
    assert.equal(trace.calls.length, 1); assert.equal(trace.calls[0].type, 'DELEGATECALL');
    assert.equal(by('hash-overridden-callTracer-witness').response.result.output, by('code-stateDiff-hash-call-witness').response.result);
    const prestate = by('usdc-hash-full-prestateTracer').response.result;
    assert.match(prestate[trace.to].code, /^0x[0-9a-f]+$/); assert.match(prestate[trace.calls[0].to].code, /^0x[0-9a-f]+$/);
    assert.deepEqual(Object.keys(by('usdc-hash-diff-prestateTracer').response.result).sort(), ['post', 'pre']);
  }
}
process.stdout.write(JSON.stringify({ status: 'verified_offline', rpc: 48, results: successes, errors, rawResponseBytes: bytes, captureSha256: sha(raw), networkCalls: 0 }) + '\n');
