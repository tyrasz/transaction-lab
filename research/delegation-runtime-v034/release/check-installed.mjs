// Three read-only localhost requests; no simulation, public RPC or broadcast.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadLocalApi } from '../../../src/local-loader.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const port = process.argv[2], destination = process.argv[3];
assert(['5174', '5175'].includes(port));
assert(['candidate-http.json', 'installed-http.json'].includes(destination));
const expected = JSON.parse(fs.readFileSync(path.join(directory, 'implementation.json')));
const local = await loadLocalApi();
assert.deepEqual(local.implementation, expected);
const httpRequests = [];
for (const endpoint of ['/api/health', '/api/config', '/app.js']) {
  const url = `http://127.0.0.1:${port}${endpoint}`, startedAt = new Date().toISOString();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  httpRequests.push({ request: { method: 'GET', url }, startedAt, finishedAt: new Date().toISOString(),
    status: response.status, headers: Object.fromEntries(response.headers), body });
  assert.equal(response.status, 200);
}
const health = JSON.parse(httpRequests[0].body), config = JSON.parse(httpRequests[1].body);
assert.equal(health.version, '0.34.0'); assert.equal(health.readOnly, true);
for (const name of ['localEvm', 'standardEvm', 'arbitrumEvm']) assert.equal(config[name].available, true);
assert(config.localEvm.capabilities.chainIds.includes(11155111));
assert.equal(config.localEvm.capabilities.amsterdam.authorizationList, true);
assert.equal(config.localEvm.capabilities.amsterdam.storageOnlyCreationCollision, false);
const ui = fs.readFileSync(path.join(root, 'public/app.js'));
assert.equal(httpRequests[2].body, ui.toString());
assert.equal(local.implementation.runtimePatches[0].id, 'eip7702-exact-designation-length-v1');
await local.assertSourcesUnchanged();
const summary = { checkedAt: new Date().toISOString(), version: health.version, readOnly: health.readOnly,
  sourceSha256: local.implementation.sourceSha256, sourceFiles: local.implementation.sourceFiles.length, runtimePatches: local.implementation.runtimePatches,
  installedInventoryMatchesCandidate: true, servedUiSha256: createHash('sha256').update(ui).digest('hex'),
  allOptionalEnginesAvailable: true, sepoliaAvailable: true, amsterdamAuthorizationsAvailable: true, publicRpcRequests: 0 };
fs.writeFileSync(path.join(directory, destination), JSON.stringify({ ...summary, httpRequests }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
