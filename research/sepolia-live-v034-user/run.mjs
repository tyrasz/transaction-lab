import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadLocalApi } from '../../src/local-loader.js';
import { REQUEST } from '../sepolia-api-live-v033/contract.mjs';
import { verifyApiReport } from '../sepolia-api-live-v033/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'native';
assert(['native', 'weth'].includes(mode));
const destination = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'.toLowerCase();
const request = mode === 'native' ? REQUEST : {
  chainId: 11155111, from: REQUEST.from, to: destination,
  data: '0xd0e30db0', value: REQUEST.value, gas: '150000', block: 'latest',
  queries: [
    { kind: 'native_balance', account: REQUEST.from },
    { kind: 'native_balance', account: destination },
    { to: destination, data: '0x70a08231' + REQUEST.from.slice(2).padStart(64, '0') },
  ],
};
const folder = path.join(here, mode);
await fs.mkdir(folder);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => fs.writeFile(path.join(folder, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const origin = 'http://127.0.0.1:5174';
const api = await loadLocalApi();
await api.assertSourcesUnchanged();
await save('request.json', request);
await save('source-before.json', api.implementation);
const began = Date.now();
const records = [];
try {
  for (const [name, route, method] of [
    ['health', '/api/health', 'GET'], ['config', '/api/config', 'GET'],
    ['response', '/api/evm/local-preview', 'POST'],
  ]) {
    const started = new Date().toISOString();
    const body = method === 'POST' ? JSON.stringify(request) : undefined;
    const reply = await fetch(origin + route, {
      method, body, headers: body ? { 'content-type': 'application/json' } : {},
      redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 155000 : 10000),
    });
    const chunks = []; let bytes = 0;
    for await (const chunk of reply.body) {
      bytes += chunk.length;
      assert(bytes <= 96 * 1024 * 1024, 'Response exceeds local capture limit');
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    await save(name + '.json', raw);
    records.push({ started, ended: new Date().toISOString(), method, url: origin + route,
      requestText: body ?? '', httpStatus: reply.status, headers: Object.fromEntries(reply.headers),
      responseBytes: bytes, responseSha256: sha(raw) });
    assert.equal(reply.status, 200);
    const result = JSON.parse(raw);
    if (name === 'health') { assert.equal(result.readOnly, true); assert.equal(result.version, api.implementation.version); }
    if (name === 'config') assert.equal(result.localEvm.available, true);
    if (name === 'response') {
      assert.deepEqual(result.apiRequest, request);
      assert.deepEqual(result.implementation, api.implementation);
      await api.assertSourcesUnchanged();
      let verification;
      if (mode === 'native') verification = await verifyApiReport(result, api.implementation);
      else verification = { status: result.status, execution: result.execution, measurements: result.measurements };
      await save('verification.json', verification);
      console.log(JSON.stringify({ mode, status: result.status, execution: result.execution,
        source: { chainId: result.source?.chainId, blockNumber: result.source?.blockSelection?.blockNumber,
          blockHash: result.source?.blockSelection?.blockHash, canonicalStatus: result.source?.canonicalStatus },
        measurements: result.measurements, error: result.error, publicRpcRequests: result.transportEvidence?.length }, null, 2));
    }
  }
} catch (error) {
  await save('capture-error.json', { message: String(error.message), stack: error.stack });
  process.exitCode = 1;
} finally {
  await save('http-exchanges.json', records);
  await save('capture-summary.json', { mode, started: new Date(began).toISOString(), ended: new Date().toISOString(),
    elapsedMs: Date.now() - began, signed: false, broadcast: false, claimsWalletOwnership: false,
    sourceSha256: api.implementation.sourceSha256, captureError: process.exitCode === 1 });
}
