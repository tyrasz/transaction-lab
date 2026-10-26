// Offline-only independent assertions over the immutable raw capability packet.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildStateOverrides } from './frozen/state.js';
import { validateQuery } from './frozen/query-validator.js';

const dir = new URL('./', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async file => JSON.parse(await readFile(new URL(file, dir)));
const captureBytes = await readFile(new URL('capture.json', dir));
assert.equal(sha(captureBytes), '3c11faec39109a330d91428d9ad359ee1601fc3820f5ae17b9971c61e7ddfae2');
const capture = JSON.parse(captureBytes), plan = await load('plan.json'), summary = await load('summary.json');
for (const [file, expected] of [['plan.json', capture.planSha256], ['capture.mjs', capture.scriptSha256], ['frozen-sources.json', capture.frozenSourcesSha256], ['summary.json', capture.summarySha256]]) assert.equal(sha(await readFile(new URL(file, dir))), expected, file);
for (const entry of (await load('frozen-sources.json')).entries) assert.equal(sha(await readFile(new URL('frozen/' + entry.file, dir))), entry.sha256);
assert.equal(capture.status, 'complete'); assert.equal(capture.records.length, 126); assert.deepEqual(capture.skipped, []);
assert.equal(capture.responseBytes, 190386); assert.ok(capture.elapsedMs < plan.limits.wallMs);
let bytes = 0;
for (const [i, record] of capture.records.entries()) {
  assert.deepEqual({ provider: record.provider, caseId: record.caseId, label: record.label }, plan.scheduled[i]);
  assert.equal(record.endpoint, plan.endpoints[record.provider]); assert.equal(record.error, undefined);
  assert.equal(record.httpStatus, 200); assert.equal(record.bodyComplete, true);
  assert.equal(record.request.id, i + 1); assert.equal(record.response.id, i + 1);
  assert.equal(record.response.jsonrpc, '2.0'); assert.equal(Object.hasOwn(record.response, 'error'), false);
  assert.equal(Buffer.byteLength(record.responseRaw), record.responseBytes); bytes += record.responseBytes;
  assert.equal(sha(record.responseRaw), record.responseSha256); assert.deepEqual(JSON.parse(record.responseRaw), record.response);
  assert.ok(record.responseBytes <= plan.limits.responseBytes); assert.ok(record.elapsedMs < plan.limits.requestMs);
}
assert.equal(bytes, capture.responseBytes);
const expected = {
  supply: { usdc: ['344156193', '329090078'], husdc: ['3179075937', '3194142051'], 'usdc-allowance': ['115792089237316195423570985008687907853269984665640564039457584003202135963444', '115792089237316195423570985008687907853269984665640564039457584003202120897329'] },
  borrow: { usdc: ['569439069', '1404913479'], husdc: ['5677678780', '5677678780'], debt: ['2', '835474412'], 'husdc-allowance': ['0', '0'] },
};
let mainQueries = 0, diffs = 0, witnesses = 0, anchors = 0, priorPairs = 0;
for (const provider of ['A', 'B']) for (const item of plan.cases) {
  const records = capture.records.filter(r => r.provider === provider && r.caseId === item.id);
  const rec = label => { const found = records.filter(r => r.label === label); assert.equal(found.length, 1); return found[0]; };
  const result = label => rec(label).response.result;
  const observation = summary.observations.find(o => o.provider === provider && o.caseId === item.id);
  const sender = item.original.from, nonce = BigInt(result('sender-nonce')), native = BigInt(result('sender-balance'));
  assert.equal(result('sender-code'), '0x'); assert.equal(result('witness-code'), '0x');
  const overrides = buildStateOverrides(result('original-diff'));
  assert.deepEqual(overrides, observation.originalOverrides);
  for (const label of ['original-trace', 'original-diff']) { assert.deepEqual(rec(label).request.params[0], item.original); assert.deepEqual(rec(label).request.params[1], item.pinned); }
  assert.equal(result('original-trace').error, undefined);
  const afterNonce = BigInt(overrides[sender].nonce);
  assert.equal(afterNonce, nonce + 1n);
  for (const query of item.queries) {
    const values = [];
    for (const [stage, startNonce] of [['before', nonce], ['after', afterNonce]]) {
      const traceRecord = rec(query.id + '-' + stage + '-trace'), diffRecord = rec(query.id + '-' + stage + '-diff');
      const envelope = { from: sender, to: query.to, data: query.data, value: '0x0', gas: '0x493e0' };
      for (const record of [traceRecord, diffRecord]) {
        assert.deepEqual(record.request.params[0], envelope); assert.deepEqual(record.request.params[1], item.pinned);
        assert.deepEqual(record.request.params[2].stateOverrides, stage === 'after' ? overrides : undefined);
        assert.equal(record.request.params[2].blockOverrides, undefined);
      }
      const parsed = validateQuery([[traceRecord.response.result]], query, sender);
      values.push(parsed.amount.toString()); mainQueries++;
      const diff = diffRecord.response.result;
      assert.deepEqual(Object.keys(diff.pre), [sender]); assert.deepEqual(Object.keys(diff.post), [sender]);
      assert.deepEqual(Object.keys(diff.pre[sender]).sort(), ['balance', 'nonce']);
      assert.deepEqual(Object.keys(diff.post[sender]), ['nonce']);
      assert.equal(BigInt(diff.pre[sender].nonce), startNonce); assert.equal(BigInt(diff.post[sender].nonce), startNonce + 1n);
      assert.equal(BigInt(diff.pre[sender].balance), native); diffs++;
    }
    assert.deepEqual(values, expected[item.id][query.id]);
    const prior = item.previousMeasurements.find(p => p.asset.address === query.to && (query.kind === 'allowance' ? p.owner === query.owner && p.spender === query.spender : p.account === query.account));
    if (prior) { assert.deepEqual(values, [prior.beforeRaw, prior.afterRaw]); priorPairs++; }
  }
  for (const stage of ['before', 'after']) {
    const witness = observation.headerWitness[stage]; assert.equal(witness.status, 'observed');
    assert.deepEqual(witness.differences, ['baseFee']); assert.equal(witness.values.baseFee, '0'); assert.ok(BigInt(witness.headerValues.baseFee) > 0n);
    for (const key of Object.keys(witness.values).filter(k => k !== 'baseFee')) assert.equal(witness.values[key], witness.headerValues[key]);
    const raw = result('header-' + stage).output;
    assert.equal(raw.length, 514);
    for (const [i, key] of ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'].entries()) assert.equal(BigInt('0x' + raw.slice(2 + 64 * i, 66 + 64 * i)).toString(), witness.values[key]);
    witnesses++;
  }
  const anchor = result('anchor-transaction'), anchorDiff = result('anchor-diff');
  assert.equal(anchor.hash, item.anchorTransactionHash); assert.equal(anchor.blockHash, item.header.hash);
  assert.equal(BigInt(anchor.nonce), BigInt(result('anchor-nonce-parent')));
  assert.notEqual(BigInt(result('anchor-nonce-parent')), BigInt(result('anchor-nonce-end')));
  assert.equal(BigInt(anchorDiff.pre[anchor.from].nonce), BigInt(result('anchor-nonce-end')));
  assert.equal(observation.anchor.classification, 'traced_state_matches_end_and_differs_from_parent'); anchors++;
  assert.equal(result('canonical').hash, item.header.hash);
  for (const [i, stage] of ['before', 'after'].entries()) assert.equal(BigInt(result('direct-usdc-' + stage)).toString(), expected[item.id].usdc[i]);
}
let sameProviderPairs = 0;
for (const a of capture.records.filter(r => r.provider === 'A')) {
  const b = capture.records.find(r => r.provider === 'B' && r.caseId === a.caseId && r.label === a.label);
  if (a.caseId === 'supply' && a.label === 'canonical') {
    // Providers differ in estimated encoded block size only, not hash/header fields.
    const { size: aSize, ...aRest } = a.response.result, { size: bSize, ...bRest } = b.response.result;
    assert.equal(aSize, '0x660'); assert.equal(bSize, '0x782'); assert.deepEqual(aRest, bRest);
  } else { assert.deepEqual(a.response.result, b.response.result); sameProviderPairs++; }
}
assert.deepEqual({ mainQueries, diffs, witnesses, anchors, priorPairs, sameProviderPairs }, { mainQueries: 28, diffs: 28, witnesses: 8, anchors: 4, priorPairs: 12, sameProviderPairs: 62 });
console.log(JSON.stringify({ status: 'verified_offline', rpc: 126, responseBytes: bytes, mainQueries, diffs, witnesses, anchors, priorPairs, sameProviderPairs, networkCalls: 0, productionGateChanged: false }));
