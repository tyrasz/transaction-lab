// Offline-only evidence comparison. Uses only Node built-ins; no RPC or fetch.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('./', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const captureBytes = await readFile(new URL('capture.json', directory));
assert.equal(sha(captureBytes), 'e7a2811020a5970f5a665d9948b543fc6d6155673ae823e8c86bff4f752f362c');
const capture = JSON.parse(captureBytes), planBytes = await readFile(new URL('plan.json', directory)), plan = JSON.parse(planBytes);
assert.equal(sha(planBytes), capture.planSha256);
assert.equal(sha(await readFile(new URL('capture.mjs', directory))), capture.scriptSha256);
assert.equal(capture.status, 'complete'); assert.equal(capture.requestsAttempted, 12); assert.equal(capture.calls.length, 12);
const pilotBytes = await readFile(new URL(plan.pilot.path, directory));
assert.equal(sha(pilotBytes), plan.pilot.sha256);
const pilot = JSON.parse(pilotBytes).records, priorA = pilot.find(item => item.id === 6).response.result, priorB = pilot.find(item => item.id === 7).response.result;
let sum = 0;
for (const [index, record] of capture.calls.entries()) {
  assert.equal(record.endpoint, plan.calls[index].endpoint); assert.equal(record.url, plan.endpoints[record.endpoint]);
  assert.deepEqual(record.request, { jsonrpc: '2.0', id: index + 1, method: plan.calls[index].method, params: plan.calls[index].params });
  assert.equal(record.error, undefined); assert.equal(record.httpStatus, 200); assert.equal(record.bodyComplete, true);
  assert.equal(record.responseBytes, Buffer.byteLength(record.responseRaw)); assert.equal(record.responseSha256, sha(record.responseRaw));
  assert.deepEqual(JSON.parse(record.responseRaw), record.response); assert.equal(record.response.id, record.request.id); assert.equal(record.response.jsonrpc, '2.0');
  assert.equal(Object.hasOwn(record.response, 'error'), false); assert.ok(record.responseBytes <= plan.limits.responseBytes);
  sum += record.responseBytes;
}
assert.equal(sum, capture.totalResponseBytes); assert.equal(sum, 7931); assert.ok(sum < plan.limits.totalResponseBytes);
const result = id => capture.calls.find(record => record.request.id === id).response.result;
for (const id of [1, 4, 5]) assert.equal(result(id), '0x3e7');
const officialBlock = result(2), systems = result(3);
assert.equal(officialBlock.hash, plan.blockHash); assert.equal(officialBlock.number, plan.blockNumber);
assert.deepEqual(officialBlock.transactions, priorA.transactions);
assert.deepEqual(priorB.transactions, [...plan.additionalHashes, ...officialBlock.transactions]);
assert.ok(Array.isArray(systems)); assert.equal(systems.length, 3);
const actionFields = ['type', 'chainId', 'nonce', 'gasPrice', 'gas', 'from', 'to', 'value', 'input', 'blockHash', 'blockNumber', 'transactionIndex'];
const project = item => Object.fromEntries(actionFields.map(field => [field, item[field]]));
const mappings = [];
for (const [index, providerHash] of plan.additionalHashes.entries()) {
  const a = result(6 + index * 2), b = result(7 + index * 2);
  assert.deepEqual(a, b); assert.equal(a.hash, providerHash);
  const matches = systems.filter(system => JSON.stringify(project(system)) === JSON.stringify(project(a)));
  assert.equal(matches.length, 1, 'Each additional provider transaction must have exactly one complete action-field match');
  const official = matches[0], keys = [...new Set([...Object.keys(official), ...Object.keys(a)])].sort();
  assert.deepEqual(keys.filter(key => official[key] !== a[key]), ['hash', 'r', 's', 'v']);
  assert.equal(official.r, '0x0'); assert.equal(official.s, '0x0'); assert.equal(official.v, '0x7f1');
  assert.equal(a.r, '0x1'); assert.equal(a.s, a.from); assert.equal(a.v, '0x7f2');
  assert.equal(official.blockHash, plan.blockHash); assert.equal(official.blockNumber, plan.blockNumber);
  assert.equal(BigInt(official.transactionIndex), BigInt(index));
  assert.match(official.input, /^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/);
  mappings.push({ index, providerHash, officialSystemHash: official.hash, matchedFields: project(official), differences: Object.fromEntries(['hash', 'r', 's', 'v'].map(field => [field, { official: official[field], A: a[field], B: b[field] }])), calldataShape: { selector: '0xa9059cbb', interpretation: 'ERC20 transfer(address,uint256)-shaped calldata only; no target bytecode or token metadata was verified in this diagnostic.', target: official.to, recipient: '0x' + official.input.slice(34, 74), amountRaw: BigInt('0x' + official.input.slice(74)).toString() }, evidenceRequestIds: { officialSystemList: 3, A: 6 + index * 2, B: 7 + index * 2 } });
}
assert.equal(result(12), null);
const comparison = { schemaVersion: '1.0', captureSha256: sha(captureBytes), planSha256: sha(planBytes), pilotSha256: sha(pilotBytes), observedAt: { startedAt: capture.startedAt, completedAt: capture.completedAt }, chainIds: { official: '999', A: '999', B: '999' }, block: { number: '49544166', hex: plan.blockNumber, hash: plan.blockHash }, lists: { officialOrdinary: officialBlock.transactions, pilotAOrdinary: priorA.transactions, pilotBAll: priorB.transactions, officialSystem: systems.map(item => item.hash) }, mappings, officialLookupOfFirstProviderHash: { requestId: 12, transactionHash: plan.additionalHashes[0], result: null }, conclusion: { status: 'three_unique_system_action_matches', confidenceScope: 'All twelve non-signature/non-hash fields match uniquely for each action, and A/B direct responses agree fully. Official method semantics attribute the matched actions to HyperCore.', limits: ['No cryptographic reconstruction of provider or official transaction hashes was performed.', 'No receipts, execution traces, pre/post balances, underlying client identity or raw system-action implementation code were requested.', 'Action identity does not establish execution-index or state equivalence, transaction-root correctness, recoverable ECDSA signatures, or which RPC representation is authoritative for replay.', 'The five common user transaction indices were not queried; a constant three-index offset is not established.', 'The failed prospective pilot remains selection_failed with metrics null; none of its outputs or selection rules were changed.'] }, budget: { requests: 12, responseBytes: sum, retries: 0, additionalRpcCallsPermitted: 0 } };
if (process.argv[2] === '--write') await writeFile(new URL('comparison.json', directory), json(comparison), { flag: 'wx' });
else assert.deepEqual(JSON.parse(await readFile(new URL('comparison.json', directory))), comparison);
console.log(json({ status: 'verified_offline', requests: 12, rawResponseBytes: sum, uniqueCompleteActionMatches: mappings.length, additionalRpcCalls: 0 }));
