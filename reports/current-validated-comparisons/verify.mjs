// Offline-only packet audit. No live product modules are imported or hashed.
// After capture is sealed: --pin CAPTURE_SHA256 once, then --verify.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const DIR = new URL('./', import.meta.url), ROOT = new URL('../../', import.meta.url);
const sha = x => createHash('sha256').update(x).digest('hex');
const hashObject = x => sha(JSON.stringify(x));
const load = async path => JSON.parse(await readFile(new URL(path, DIR)));
const json = x => JSON.stringify(x, null, 2) + '\n';
const captureBytes = await readFile(new URL('capture.json', DIR)), captureSha256 = sha(captureBytes), capture = JSON.parse(captureBytes);
const plan = await load('plan.json'), binding = await load('frozen-core.json'), manifest = await load('manifest.json');
assert.ok(['complete', 'stopped_without_retry'].includes(capture.status), 'Cannot pin a running capture.');
for (const entry of manifest.files) assert.equal(sha(await readFile(new URL(entry.file, DIR))), entry.sha256, entry.file);
for (const [file, expected] of [['plan.json', capture.planSha256], ['capture.mjs', capture.scriptSha256], ['frozen-core.json', capture.coreBindingSha256]]) assert.equal(sha(await readFile(new URL(file, DIR))), expected);
assert.equal(plan.scriptSha256, capture.scriptSha256); assert.equal(binding.planSha256, capture.planSha256); assert.equal(binding.scriptSha256, capture.scriptSha256);
assert.deepEqual(capture.implementation, { version: binding.version, sourceSha256: binding.sourceSha256, sourceFiles: binding.sourceFiles });
for (const source of plan.sources) assert.equal(sha(await readFile(new URL(source.path, ROOT))), source.sha256);
if (process.argv[2] === '--pin') {
  assert.equal(process.argv[3], captureSha256, 'Supply the independently reported final capture hash.');
  await writeFile(new URL('capture-pin.json', DIR), json({ schemaVersion: '1.0', captureSha256, planSha256: capture.planSha256, coreBindingSha256: capture.coreBindingSha256, implementation: capture.implementation }), { flag: 'wx' });
  console.log(json({ status: 'pinned_offline', captureSha256, networkCalls: 0 })); process.exit(0);
}
assert.ok(process.argv[2] === '--verify' || process.argv[2] === undefined);
const pin = await load('capture-pin.json');
assert.equal(pin.captureSha256, captureSha256); assert.equal(pin.planSha256, capture.planSha256); assert.equal(pin.coreBindingSha256, capture.coreBindingSha256); assert.deepEqual(pin.implementation, capture.implementation);

const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f', HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b', DEBT = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b', POOL_IMPL = '0xbebb62c7ff8b96db4325d9481c44e09a92d49b06', PROBE = '0x000000000000000000000000000000000000ba1a';
const IMPL = { [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8', [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3', [DEBT]: '0x8158e5569475a443a5723ccac462930f590449ed' };
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, BYTES = /^0x(?:[0-9a-f]{2})*$/, MAX = (1n << 256n) - 1n;
const hex = x => '0x' + BigInt(x).toString(16), lower = x => typeof x === 'string' ? x.toLowerCase() : '';
function integer(x, max = MAX) { assert.ok((typeof x === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(x)) || (Number.isSafeInteger(x) && x >= 0)); const n = BigInt(x); assert.ok(n >= 0n && n <= max); return n; }
function object(x) { assert.ok(x && typeof x === 'object' && !Array.isArray(x)); return x; }
function canonicalDiff(raw) {
  assert.deepEqual(Object.keys(object(raw)).sort(), ['post', 'pre']);
  const result = {}, accounts = new Set(), slots = new Set();
  for (const side of ['pre', 'post']) {
    const normalized = {};
    for (const [key, record] of Object.entries(object(raw[side]))) {
      const address = lower(key); assert.match(address, ADDRESS); assert.equal(Object.hasOwn(normalized, address), false); accounts.add(address); assert.ok(accounts.size <= 100);
      const out = {};
      for (const field of Object.keys(object(record)).sort()) {
        assert.ok(['balance', 'nonce', 'code', 'storage'].includes(field));
        if (field === 'balance' || field === 'nonce') out[field] = integer(record[field], field === 'nonce' ? (1n << 64n) - 1n : MAX).toString();
        else if (field === 'code') { assert.match(lower(record.code), BYTES); out.code = lower(record.code); }
        else {
          const storage = {};
          for (const [key, value] of Object.entries(object(record.storage))) {
            const slot = lower(key); assert.match(slot, WORD); assert.match(lower(value), WORD); assert.equal(Object.hasOwn(storage, slot), false);
            storage[slot] = lower(value); slots.add(address + ':' + slot); assert.ok(slots.size <= 2000);
          }
          out.storage = Object.fromEntries(Object.keys(storage).sort().map(k => [k, storage[k]]));
        }
      }
      normalized[address] = out;
    }
    result[side] = Object.fromEntries(Object.keys(normalized).sort().map(k => [k, normalized[k]]));
  }
  return result;
}
function deriveOverrides(diff) {
  assert.deepEqual(Object.keys(diff.pre), Object.keys(diff.post)); const out = {};
  for (const address of Object.keys(diff.pre)) {
    const before = diff.pre[address], after = diff.post[address], override = {};
    if (after.code !== undefined) assert.equal(after.code, before.code);
    for (const field of ['balance', 'nonce']) if (after[field] !== undefined) override[field] = hex(after[field]);
    const slots = [...new Set([...Object.keys(before.storage ?? {}), ...Object.keys(after.storage ?? {})])];
    if (slots.length) override.stateDiff = Object.fromEntries(slots.map(slot => [slot, after.storage?.[slot] ?? '0x' + '0'.repeat(64)]));
    if (Object.keys(override).length) out[address] = override;
  }
  return out;
}
function nonceDiff(raw, sender, nonce, balance) {
  const d = canonicalDiff(raw); assert.deepEqual(Object.keys(d.pre), [sender]); assert.deepEqual(Object.keys(d.post), [sender]);
  for (const side of ['pre', 'post']) assert.ok(Object.keys(d[side][sender]).every(k => ['nonce', 'balance'].includes(k)));
  assert.equal(integer(d.pre[sender].nonce), nonce); assert.equal(integer(d.post[sender].nonce), nonce + 1n); assert.equal(integer(d.pre[sender].balance), balance);
  if (d.post[sender].balance !== undefined) assert.equal(integer(d.post[sender].balance), balance);
}
function frame(f, type, from, to, input, count, output) {
  object(f); assert.equal(f.type, type); assert.equal(lower(f.from), from); assert.equal(lower(f.to), to); assert.equal(lower(f.input), input);
  assert.equal(integer(f.value ?? '0x0'), 0n); assert.ok(!f.error && !f.revertReason); assert.equal((f.logs ?? []).length, 0); assert.equal((f.calls ?? []).length, count);
  assert.ok(integer(f.gasUsed) > 0n && integer(f.gasUsed) <= 300000n); if (output !== undefined) assert.equal(lower(f.output), output);
}
function queryAmount(trace, call) {
  const allowance = /^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/.test(call.data), balance = /^0x70a082310{24}[0-9a-f]{40}$/.test(call.data);
  assert.ok(balance || allowance); assert.ok(Object.hasOwn(IMPL, call.to)); if (allowance) assert.notEqual(call.to, DEBT);
  assert.match(lower(trace.output), WORD); frame(trace, 'CALL', call.from, call.to, call.data, 1);
  const position = balance && call.to !== USDC, child = trace.calls[0]; frame(child, 'DELEGATECALL', call.to, IMPL[call.to], call.data, position ? 1 : 0, lower(trace.output));
  if (position) {
    const data = (call.to === HUSDC ? '0xd15e0053' : '0x386497fd') + USDC.slice(2).padStart(64, '0'), pool = child.calls[0];
    assert.match(lower(pool.output), WORD); assert.ok(BigInt(pool.output) > 0n); frame(pool, 'STATICCALL', call.to, POOL, data, 1);
    frame(pool.calls[0], 'DELEGATECALL', POOL, POOL_IMPL, data, 0, lower(pool.output));
  }
  return BigInt(trace.output).toString();
}
const same = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
const one = xs => { assert.equal(xs.length, 1); return xs[0]; };
const totals = { attempted: 0, http200: 0, failedHttp: 0, rpcCalls: 0, rpcResponseBytes: 0, httpResponseBytes: 0 }, seen = new Set(), outcomes = [];
for (const item of capture.cases) for (const run of item.runs) {
  const specification = one(plan.cases.filter(c => c.id === item.id)); assert.ok(specification.providers.includes(run.provider));
  const key = item.id + ':' + run.provider; assert.equal(seen.has(key), false); seen.add(key); totals.attempted++;
  assert.deepEqual(run.request, specification.request); assert.deepEqual(JSON.parse(run.http.request.bodyText), run.request); assert.deepEqual(run.http.request.body, run.request);
  assert.equal(run.http.request.method, 'POST'); assert.match(run.http.request.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/simulate$/);
  for (const [i, e] of run.rpcCalls.entries()) {
    totals.rpcCalls++; totals.rpcResponseBytes += e.responseBytes ?? 0; assert.equal(e.request.id, i + 1); assert.equal(e.request.jsonrpc, '2.0');
    if (e.requestText) { assert.deepEqual(JSON.parse(e.requestText), e.request); assert.equal(e.requestText, JSON.stringify(e.request)); }
    if (e.response) { assert.equal(e.error, undefined); assert.equal(e.httpStatus, 200); assert.equal(e.bodyComplete, true); assert.deepEqual(JSON.parse(e.responseText), e.response); assert.equal(sha(e.responseText), e.responseSha256); assert.equal(Buffer.byteLength(e.responseText), e.responseBytes); assert.equal(e.response.id, i + 1); assert.equal(e.response.jsonrpc, '2.0'); assert.equal(Object.hasOwn(e.response, 'error'), false); assert.ok(e.responseBytes <= plan.budgets.maxResponseBytes); }
    else { assert.ok(e.error); assert.equal(e.responseBodyWithheld, true); }
  }
  assert.ok(run.rpcCalls.length <= plan.budgets.maxRpcCallsPerRun);
  const http = run.http.response;
  if (http) { totals.httpResponseBytes += http.responseBytes; assert.deepEqual(JSON.parse(http.bodyText), http.body); assert.equal(sha(http.bodyText), http.bodySha256); assert.equal(Buffer.byteLength(http.bodyText), http.responseBytes); assert.ok(http.responseBytes <= plan.budgets.maxResponseBytes); if (http.status === 200) { totals.http200++; assert.deepEqual(run.response, http.body); } else totals.failedHttp++; }
  else { totals.failedHttp++; totals.httpResponseBytes += run.http.failure?.responseBytes ?? 0; assert.ok(run.error); }
  const body = run.response, result = { caseId: item.id, provider: run.provider, httpStatus: http?.status ?? null, rpcCalls: run.rpcCalls.length, error: run.error?.code ?? null, execution: body?.execution?.status ?? null, statuses: Object.fromEntries(['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges'].map(k => [k, body?.[k]?.status ?? null])), queries: [], references: [] };
  outcomes.push(result);
  if (!body) {
    result.apiError = http?.body?.error ?? null;
    result.references = (specification.knownReference?.queries ?? []).map(ref => ({ id: ref.id, status: 'not_measured_or_unavailable', expected: { beforeRaw: ref.beforeRaw, afterRaw: ref.afterRaw, deltaRaw: ref.deltaRaw }, observed: null }));
    continue;
  }
  assert.equal(body.implementation.sourceSha256, binding.sourceSha256); assert.equal(body.implementation.version, binding.version); assert.deepEqual(body.implementation.sourceFiles, binding.sourceFiles);
  assert.equal(body.source.mode, 'simulation'); assert.equal(body.source.blockHash, specification.expectedBlockHash); assert.equal(integer(body.source.blockNumber), integer(run.request.block));
  assert.equal(body.source.requestedBlock, run.request.block); assert.equal(body.source.blockBinding, 'explicit_block_hash');
  const pinned = { blockHash: specification.expectedBlockHash, requireCanonical: true }, sender = run.request.from;
  const originalCall = { from: sender, to: run.request.to, data: run.request.data, value: '0x0', gas: '0x4c4b40' };
  const calls = run.rpcCalls.filter(e => e.request.method === 'debug_traceCall');
  const rootTrace = one(calls.filter(e => same(e.request.params[0], originalCall) && e.request.params[2]?.tracer === 'callTracer'));
  assert.deepEqual(rootTrace.request.params, [originalCall, pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }]);
  assert.deepEqual(body.evidence.traceRequest, { method: 'debug_traceCall', params: rootTrace.request.params }); assert.deepEqual(body.evidence.traceResponse, rootTrace.response.result);
  const measured = ['balanceChanges', 'allowanceChanges', 'affectedBalanceChanges'].filter(k => body[k]?.status === 'measured');
  const diffs = calls.filter(e => same(e.request.params[0], originalCall) && e.request.params[2]?.tracer === 'prestateTracer');
  let proof = null;
  try {
    const originalDiff = one(diffs); assert.deepEqual(originalDiff.request.params, [originalCall, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
    const diff = canonicalDiff(originalDiff.response.result), overrides = deriveOverrides(diff);
    const read = (method, address) => one(run.rpcCalls.filter(e => e.request.method === method && same(e.request.params, [address, pinned]))).response.result;
    const nonce = integer(read('eth_getTransactionCount', sender)), balance = integer(read('eth_getBalance', sender));
    assert.equal(read('eth_getCode', sender), '0x'); assert.equal(read('eth_getCode', PROBE), '0x'); assert.match(lower(read('eth_getCode', run.request.to)), BYTES); assert.notEqual(read('eth_getCode', run.request.to), '0x');
    assert.equal(integer(diff.pre[sender].nonce), nonce); assert.equal(integer(diff.post[sender].nonce), nonce + 1n); assert.equal(integer(diff.pre[sender].balance), balance);
    const afterNonce = integer(overrides[sender].nonce), afterBalance = overrides[sender].balance === undefined ? balance : integer(overrides[sender].balance);
    const header = one(run.rpcCalls.filter(e => e.request.method === 'eth_getBlockByHash' && same(e.request.params, [pinned.blockHash, false]))).response.result;
    assert.equal(header.hash, pinned.blockHash); assert.equal(integer(header.number), integer(run.request.block)); assert.equal(integer(header.timestamp).toString(), body.source.timestamp);
    const witnesses = calls.filter(e => e.request.params[0]?.to === PROBE); assert.equal(witnesses.length, 2);
    const code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + (BigInt(header.number) - 1n).toString(16).padStart(64, '0') + '4060e0526101006000f3';
    for (const [i, witness] of witnesses.entries()) {
      assert.deepEqual(witness.request.params, [{ from: sender, to: PROBE, data: '0x', value: '0x0', gas: '0x493e0' }, pinned, { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true }, stateOverrides: { ...(i ? overrides : {}), [PROBE]: { code } } }]);
      frame(witness.response.result, 'CALL', sender, PROBE, '0x', 0); const output = witness.response.result.output; assert.equal(output.length, 514);
      const expected = [header.number, header.timestamp, header.gasLimit, 0, header.mixHash, header.miner, 999, header.parentHash].map(BigInt);
      expected.forEach((value, j) => assert.equal(BigInt('0x' + output.slice(2 + j * 64, 66 + j * 64)), value));
    }
    proof = { overrides, nonce, balance, afterNonce, afterBalance, header };
    result.preparation = 'raw_same_envelope_pinned_diff_nonce_and_eight_field_witnesses';
  } catch { result.preparation = 'unavailable_or_rejected_evidence_retained'; }
  if (measured.length) assert.ok(proof, 'Measured output requires a complete current profile proof.');
  const queryGroups = new Map();
  for (const e of calls.filter(e => e.request.params[0]?.gas === '0x493e0' && e.request.params[0]?.to !== PROBE)) {
    const call = e.request.params[0], key = call.to + ':' + call.data; if (!queryGroups.has(key)) queryGroups.set(key, []); queryGroups.get(key).push(e);
  }
  assert.ok(queryGroups.size <= 12);
  for (const [key, entries] of queryGroups) {
    const query = { key, to: entries[0].request.params[0].to, data: entries[0].request.params[0].data, callIds: entries.map(e => e.request.id), status: 'unavailable_or_rejected_evidence_retained' };
    try {
      assert.ok(proof); assert.equal(entries.length, 4); const values = [];
      entries.forEach((entry, i) => {
        const after = i >= 2, trace = i % 2 === 0, call = { from: sender, to: query.to, data: query.data, value: '0x0', gas: '0x493e0' };
        assert.deepEqual(entry.request.params, [call, pinned, { tracer: trace ? 'callTracer' : 'prestateTracer', timeout: '15s', tracerConfig: trace ? { withLog: true } : { diffMode: true }, ...(after ? { stateOverrides: proof.overrides } : {}) }]);
        assert.ok(entry.response); if (trace) values.push(queryAmount(entry.response.result, call)); else nonceDiff(entry.response.result, sender, after ? proof.afterNonce : proof.nonce, after ? proof.afterBalance : proof.balance);
      });
      Object.assign(query, { status: 'validated_from_raw_four_call_evidence', beforeRaw: values[0], afterRaw: values[1], deltaRaw: (BigInt(values[1]) - BigInt(values[0])).toString() });
    } catch { /* Retain unsupported/incomplete actual outcomes without inventing values. */ }
    result.queries.push(query);
  }
  const queryFor = (token, data) => one(result.queries.filter(q => q.to === token && q.data === data));
  for (const field of measured) {
    const view = body[field], id = view.executionIdentity; assert.equal(view.basis, field === 'allowanceChanges' ? 'current_pinned_state_validated_allowance' : 'current_pinned_state_validated_query');
    assert.equal(id.headerContext, 'synthetic_unpriced_basefee_zero'); assert.equal(id.feePolicy, 'gas_price_omitted_no_query_native_debit'); assert.equal(id.stateBinding, 'block_hash'); assert.equal(id.stateBlockHash, pinned.blockHash); assert.equal(id.method, 'debug_traceCall');
    assert.equal(id.originalEnvelopeSha256, hashObject(originalCall)); assert.equal(id.stateOverridesSha256, hashObject(proof.overrides));
    assert.equal(id.validation.queryMutation, 'sender_nonce_increment_only_with_unchanged_native_balance'); assert.equal(id.validation.queryImplementation, 'configured_address_paths_before_and_after_no_runtime_code_attestation'); assert.equal(id.validation.actualBlockBaseFeeRaw, BigInt(proof.header.baseFeePerGas).toString());
    assert.deepEqual(id.validation.headerFields, ['number','timestamp','gasLimit','baseFee_zero','prevRandao','coinbase','chainId','parentHash']);
    for (const asset of view.assets ?? []) { const q = queryFor(asset.asset.address, '0x70a08231' + asset.account.slice(2).padStart(64, '0')); assert.equal(q.status, 'validated_from_raw_four_call_evidence'); assert.deepEqual([asset.beforeRaw, asset.afterRaw, asset.deltaRaw], [q.beforeRaw, q.afterRaw, q.deltaRaw]); }
    for (const allowance of view.allowances ?? []) { const q = queryFor(allowance.asset.address, '0xdd62ed3e' + allowance.owner.slice(2).padStart(64, '0') + allowance.spender.slice(2).padStart(64, '0')); assert.equal(q.status, 'validated_from_raw_four_call_evidence'); assert.deepEqual([allowance.beforeRaw, allowance.afterRaw, allowance.deltaRaw], [q.beforeRaw, q.afterRaw, q.deltaRaw]); }
    for (const reuse of view.reusedPairs ?? []) { const asset = body.balanceChanges.assets[reuse.balanceChangeIndex]; assert.equal(body.balanceChanges.status, 'measured'); assert.equal(asset.asset.address, reuse.token); assert.equal(asset.account, reuse.account); }
  }
  if (measured.length) {
    const finalHeaders = run.rpcCalls.filter(e => e.request.method === 'eth_getBlockByNumber' && e.request.id > rootTrace.request.id); assert.ok(finalHeaders.length >= 1);
    for (const e of finalHeaders) for (const field of ['hash','number','timestamp','gasLimit','baseFeePerGas','mixHash','miner','parentHash']) assert.equal(lower(e.response.result[field]), lower(proof.header[field]));
  }
  for (const ref of specification.knownReference?.queries ?? []) {
    const observed = result.queries.find(q => q.to === ref.to && q.data === ref.data);
    result.references.push({ id: ref.id, status: !observed || observed.status !== 'validated_from_raw_four_call_evidence' ? 'not_measured_or_unavailable' : same([observed.beforeRaw, observed.afterRaw, observed.deltaRaw], [ref.beforeRaw, ref.afterRaw, ref.deltaRaw]) ? 'matches_recorded_query_reference' : 'differs_from_recorded_query_reference', expected: { beforeRaw: ref.beforeRaw, afterRaw: ref.afterRaw, deltaRaw: ref.deltaRaw }, observed: observed?.status === 'validated_from_raw_four_call_evidence' ? { beforeRaw: observed.beforeRaw, afterRaw: observed.afterRaw, deltaRaw: observed.deltaRaw } : null });
  }
}
for (const skip of capture.skipped) { const key = skip.caseId + ':' + skip.provider; assert.equal(seen.has(key), false); seen.add(key); assert.ok(plan.cases.some(c => c.id === skip.caseId && c.providers.includes(skip.provider))); }
assert.equal(seen.size, 8); for (const [key, value] of Object.entries(totals)) assert.equal(capture.summary[key], value);
assert.equal(capture.summary.responseBytes, totals.rpcResponseBytes + totals.httpResponseBytes); assert.ok(totals.rpcCalls <= plan.budgets.maxRpcCalls);
if (capture.status === 'complete') { assert.equal(capture.skipped.length, 0); assert.equal(totals.attempted, 8); assert.ok(capture.summary.responseBytes <= plan.budgets.maxTotalResponseBytes); }
const comparisons = plan.cases.map(c => {
  const pair = outcomes.filter(o => o.caseId === c.id); const a = pair.find(o => o.provider === 'drpc'), b = pair.find(o => o.provider === 'hyperlend-archive');
  const keys = [...new Set(pair.flatMap(o => o.queries.map(q => q.key)))].sort();
  const comparable = a?.httpStatus === 200 && b?.httpStatus === 200;
  return { caseId: c.id, status: comparable ? 'recorded_results_available' : 'not_comparable', executionStatusAgreement: comparable && a.execution !== null && b.execution !== null ? a.execution === b.execution : null, measurementStatusesAgree: comparable ? same(a.statuses, b.statuses) : null, queries: keys.map(key => { const aq = a?.queries.find(q => q.key === key), bq = b?.queries.find(q => q.key === key); return { key, status: aq?.status !== 'validated_from_raw_four_call_evidence' || bq?.status !== 'validated_from_raw_four_call_evidence' ? 'not_comparable' : same([aq.beforeRaw, aq.afterRaw, aq.deltaRaw], [bq.beforeRaw, bq.afterRaw, bq.deltaRaw]) ? 'exact_values_agree' : 'values_disagree' }; }) };
});
console.log(json({ status: 'verified_offline_packet', captureSha256, implementation: capture.implementation, totals, measuredRunCount: outcomes.filter(o => Object.values(o.statuses).includes('measured')).length, skipped: capture.skipped, outcomes, comparisons, networkCalls: 0, liveSourceImportedOrHashed: false, limitations: ['Checks recorded evidence and scoped configured query behavior; not independent EVM execution or a cryptographic state proof.', 'Unavailable/reverted/error outcomes and reference/provider differences are retained without retries or fabricated quantities.', 'No historical-value expectation is applied to the new direct/router parent-state simulations.'] }));
