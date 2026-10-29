// Artifact-only verification of this fixed, completed capability packet.
// No imports from the producer, network, simulation or dependency execution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = { manifest: 'f8bf46b665cc4edbc2fb6e9ca552fa3f468c9b408d79bb0a14e0790c5557cb36', plan: '54e76a72a4f03361e7f3410e001a9dd504773225aca4fa5dca32fa9beec744fe' };
const sha = b => createHash('sha256').update(b).digest('hex');
const bytes = name => fs.readFileSync(path.join(ROOT, name));
const read = name => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(name)));
assert.equal(sha(bytes('evidence-manifest.json')), EXPECTED.manifest);
assert.equal(sha(bytes('plan.json')), EXPECTED.plan);
const manifest = read('evidence-manifest.json'), plan = read('plan.json'), results = read('results.json'), started = read('STARTED.json');
assert.equal(manifest.planSha256, EXPECTED.plan);
const names = new Set();
for (const file of manifest.files) {
  assert.match(file.path, /^[a-zA-Z0-9.-]+$/); assert.ok(!names.has(file.path)); names.add(file.path);
  assert.ok(fs.lstatSync(path.join(ROOT, file.path)).isFile());
  const b = bytes(file.path); assert.equal(b.length, file.bytes); assert.equal(sha(b), file.sha256);
}
for (const name of ['run.mjs', 'documentation.json', 'plan.json', 'STARTED.json', 'selected-header.json', 'results.json']) assert.ok(names.has(name));
assert.equal(plan.source.runSha256, sha(bytes('run.mjs'))); assert.equal(plan.source.documentationSha256, sha(bytes('documentation.json')));
assert.equal(started.planSha256, EXPECTED.plan); assert.equal(results.planSha256, EXPECTED.plan);
assert.equal(plan.endpoint, 'https://arb1.arbitrum.io/rpc'); assert.equal(plan.expectedChainId, '0xa4b1');
assert.deepEqual(plan.limits, { requests: 6, responseBytes: 1048576, requestMs: 25000, overallMs: 120000 });
assert.equal(results.sourceUnchanged, true); assert.equal(results.fatal, null); assert.equal(results.status, 'captured');
assert.equal(results.timing.withinBounds, true);
for (const value of [results.timing.wallMs, results.timing.monotonicMs]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 120000);
assert.equal(results.startedAt, started.startedAt); assert.ok(Date.parse(started.startedAt) >= Date.parse(plan.declaredAt));
assert.equal(Date.parse(results.finishedAt) - Date.parse(started.startedAt), results.timing.wallMs);
const header = read('selected-header.json');
assert.deepEqual(results.selected, { number: header.number, hash: header.hash });
const zero = '0x' + '00'.repeat(20), call = { from: zero, to: zero, data: '0x', value: '0x0', gas: '0x186a0', gasPrice: '0x0' };
const expected = [
  ['eth_chainId', []], ['eth_getBlockByNumber', ['latest', false]], ['eth_call', [call, header.number]],
  ['eth_createAccessList', [call, header.number]],
  ['eth_simulateV1', [{ blockStateCalls: [{ calls: [call] }], validation: false, traceTransfers: true, returnFullTransactions: false }, header.number]],
  ['eth_getBlockByNumber', [header.number, false]],
];
assert.equal(results.rows.length, 6); assert.equal(results.calls, 6); assert.equal(plan.sequence.length, 6);
let total = 0, previousFinish = Date.parse(started.startedAt); const replies = [];
for (let i = 0; i < 6; i++) {
  const id = i + 1, prefix = String(id).padStart(3, '0');
  for (const suffix of ['-request.json', '-response.body', '-exchange.json']) assert.ok(names.has(prefix + suffix));
  const request = read(prefix + '-request.json'), response = read(prefix + '-response.body'), exchange = read(prefix + '-exchange.json');
  assert.deepEqual(exchange, results.rows[i]); assert.deepEqual(request, { jsonrpc: '2.0', id, method: expected[i][0], params: expected[i][1] });
  const declared = plan.sequence[i]; assert.equal(declared.id, id); assert.equal(declared.method, request.method);
  assert.deepEqual(declared.params.map(p => p === '$selected.number' ? header.number : p), request.params);
  assert.equal(response.jsonrpc, '2.0'); assert.equal(response.id, id);
  assert.equal(Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'), false);
  assert.equal(exchange.id, id); assert.equal(exchange.httpStatus, 200); assert.equal(exchange.error, null); assert.equal(exchange.responseComplete, true);
  assert.ok(Number.isFinite(exchange.durationMs) && exchange.durationMs >= 0 && exchange.durationMs <= 25000);
  assert.ok(Date.parse(exchange.startedAt) >= previousFinish); previousFinish = Date.parse(exchange.finishedAt);
  for (const field of ['request', 'response']) {
    const artifact = exchange[field]; assert.ok(names.has(artifact.path)); assert.equal(artifact.sha256, sha(bytes(artifact.path))); assert.equal(artifact.bytes, bytes(artifact.path).length);
  }
  assert.equal(exchange.response.bytes, exchange.observedResponseBytes); assert.ok(exchange.response.bytes <= 1048576); total += exchange.response.bytes;
  if (Object.hasOwn(response, 'error')) { assert.equal(exchange.status, 'rpc_error'); assert.deepEqual(exchange.rpcError, response.error); assert.equal(exchange.rpcResult, null); }
  else { assert.equal(exchange.status, 'rpc_result'); assert.deepEqual(exchange.rpcResult, response.result); assert.equal(exchange.rpcError, null); }
  replies.push(response);
}
assert.equal(names.size, 24); assert.equal(total, results.responseBytes);
assert.equal(replies[0].result, '0xa4b1'); assert.equal(results.chainVerified, true);
assert.deepEqual(replies[1].result, header); assert.deepEqual(replies[5].result, header); assert.equal(results.selectedNumberHashReconfirmed, true);
assert.equal(replies[2].result, '0x');
assert.deepEqual(replies[3].error, { code: -32601, message: 'the method eth_createAccessList does not exist/is not available' });
const simulation = replies[4].result; assert.equal(simulation.length, 1); assert.equal(simulation[0].parentHash, header.hash);
assert.equal(BigInt(simulation[0].number), BigInt(header.number) + 1n);
assert.deepEqual(simulation[0].calls, [{ returnData: '0x', logs: [], gasUsed: '0x5208', maxUsedGas: '0x5208', status: '0x1' }]);
console.log(JSON.stringify({ status: 'verified', mode: 'artifact_only_no_network_or_execution', evidenceManifestSha256: EXPECTED.manifest, planSha256: EXPECTED.plan,
  baseFiles: names.size, requests: 6, responseBytes: total, blockNumber: BigInt(header.number).toString(), blockHash: header.hash,
  providerNumberHashReconfirmed: true, observations: { eth_call: 'empty_successful_result', eth_createAccessList: 'method_unavailable_-32601', eth_simulateV1: 'one_successful_noop_call_synthetic_successor_block' },
  excludes: ['full_viem_asset_change_workflow', 'deposit_semantics', 'CCTP_or_HyperCore_settlement', 'proof_or_consensus_verification', 'accuracy_or_reliability_rate'] }, null, 2));
