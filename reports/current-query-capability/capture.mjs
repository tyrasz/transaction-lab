// Bounded read-only development capability probe; no production module is changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildStateOverrides } from './frozen/state.js';
import { assertNoProviderErrorResult } from './frozen/rpc.js';
import { semanticTrace, validateQuery, hasContractLifecycle } from './frozen/query-validator.js';

const DIR = new URL('./', import.meta.url), ROOT = new URL('../../', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hex = value => '0x' + BigInt(value).toString(16);
const ADDRESS = /^0x[0-9a-f]{40}$/, QUANTITY = /^0x[0-9a-f]+$/i, WORD = /^0x[0-9a-f]{64}$/i;
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f', HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const DEBT = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d', POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
const PROBE = '0x000000000000000000000000000000000000ba1a';
const ENDPOINTS = { A: 'https://hyperliquid.drpc.org', B: 'https://rpc.hyperlend.finance/archive' };
const LIMITS = { maxRpc: 128, plannedRpc: 126, responseBytes: 8 * 1024 * 1024, totalResponseBytes: 64 * 1024 * 1024, requestMs: 25000, wallMs: 10 * 60 * 1000, retries: 0 };
const SAFE_CODES = new Set(['HTTP_ERROR', 'INVALID_JSON_RPC', 'RPC_ERROR', 'REQUEST_TIMEOUT', 'WALL_LIMIT', 'RESPONSE_BYTE_LIMIT', 'TOTAL_BYTE_LIMIT', 'RPC_LIMIT', 'RPC_EXECUTION_ERROR']);
const tracer = kind => ({ tracer: kind === 'trace' ? 'callTracer' : 'prestateTracer', timeout: '15s', tracerConfig: kind === 'trace' ? { withLog: true } : { diffMode: true } });
const sourceSpecs = [
  ['reports/live/v0.6-current-transfer-checks.json', '8851de07c31f2d17dbb9661ceabdaec7d71907cd07eab3f1bd62e7eebf41a2fb'],
  ['reports/lending-discovery/measured-current-balances.json', '549b97369980a8c0c24a7db4cfe22eb9e1114927a20860de7a9b7e6398ef459c'],
  ['reports/lending-discovery/borrow-evidence.json', '102152aa23209503b4a0ce108cf8c92b5abdb340e3c31ea0343d3999b0b8b0be'],
  ['research/current-query-validation/PLAN.md', '5ff926263435de2fa3a0f0234444053f8ebf0893798718ccfbe1b0e9542460da'],
];
const sources = [];
for (const [path, expected] of sourceSpecs) { const bytes = await readFile(new URL(path, ROOT)); assert.equal(sha(bytes), expected); sources.push({ path, sha256: expected, bytes: bytes.length }); }
const frozenBytes = await readFile(new URL('frozen-sources.json', DIR)), frozen = JSON.parse(frozenBytes);
for (const entry of frozen.entries) assert.equal(sha(await readFile(new URL('frozen/' + entry.file, DIR))), entry.sha256);
const supply = JSON.parse(await readFile(new URL(sourceSpecs[0][0], ROOT))).runs[0].response.body;
const supplyHeader = supply.evidence.balanceMeasurement.response.find(entry => entry.method === 'eth_getBlockByHash').result;
const borrow = JSON.parse(await readFile(new URL(sourceSpecs[1][0], ROOT))).cases.find(entry => entry.operation === 'borrow');
const borrowHeader = JSON.parse(await readFile(new URL(sourceSpecs[2][0], ROOT))).currentBlock;
const original = request => ({ from: request.from, to: request.to, data: request.data, value: '0x0', gas: '0x4c4b40' });
const balance = (id, to, account) => ({ id, to, data: '0x70a08231' + account.slice(2).padStart(64, '0'), account, kind: 'balance' });
const allowance = (id, to, owner) => ({ id, to, data: '0xdd62ed3e' + owner.slice(2).padStart(64, '0') + POOL.slice(2).padStart(64, '0'), owner, spender: POOL, kind: 'allowance' });
const cases = [
  { id: 'supply', header: supplyHeader, original: original(supply.request), source: sourceSpecs[0][0], queries: [balance('usdc', USDC, supply.request.from), balance('husdc', HUSDC, supply.request.from), allowance('usdc-allowance', USDC, supply.request.from)], previousMeasurements: [...supply.balanceChanges.assets, ...supply.allowanceChanges.allowances] },
  { id: 'borrow', header: borrowHeader, original: original(borrow.request), source: sourceSpecs[1][0], queries: [balance('usdc', USDC, borrow.request.from), balance('husdc', HUSDC, borrow.request.from), balance('debt', DEBT, borrow.request.from), allowance('husdc-allowance', HUSDC, borrow.request.from)], previousMeasurements: borrow.balanceChanges.assets },
].map(item => ({ ...item, pinned: { blockHash: item.header.hash, requireCanonical: true }, anchorTransactionHash: item.header.transactions[0] }));
for (const item of cases) {
  assert.ok(ADDRESS.test(item.original.from)); assert.equal(item.original.to, POOL); assert.ok(WORD.test(item.anchorTransactionHash));
  assert.equal(item.original.value, '0x0'); assert.equal(item.original.gas, '0x4c4b40');
}
function labels(item) {
  return ['header', 'sender-nonce', 'sender-balance', 'sender-code', 'witness-code', 'original-trace', 'original-diff', 'header-before', 'header-after', 'anchor-transaction', 'anchor-nonce-end', 'anchor-nonce-parent', 'anchor-trace', 'anchor-diff', ...item.queries.flatMap(query => ['before-trace', 'before-diff', 'after-trace', 'after-diff'].map(stage => `${query.id}-${stage}`)), 'direct-usdc-before', 'direct-usdc-after', 'canonical'];
}
const scheduled = Object.keys(ENDPOINTS).flatMap(provider => [{ provider, caseId: null, label: 'chain' }, ...cases.flatMap(item => labels(item).map(label => ({ provider, caseId: item.id, label })))]);
assert.equal(scheduled.length, LIMITS.plannedRpc);
const scriptSha256 = sha(await readFile(new URL('capture.mjs', DIR)));
const command = process.argv[2];
if (command === '--plan') {
  await writeFile(new URL('plan.json', DIR), json({ schemaVersion: '1.0', createdAt: new Date().toISOString(), purpose: 'Current unsigned-query capability evidence at two fixed recorded states; not a historical replay, production release, accuracy benchmark or security classification.', sources, frozenSourcesSha256: sha(frozenBytes), frozenCommit: frozen.commit, scriptSha256, endpoints: ENDPOINTS, limits: LIMITS, cases, scheduled, policy: {
    binding: 'The identical EIP-1898 {blockHash,requireCanonical:true} object is used for both original tracers, token queries, state reads and witnesses. Parent anchor read is explicitly separate. No bare-hash/number fallback.',
    originalEnvelope: 'Exact recorded normalized original from/to/data/value0/gas5000000; omit gasPrice, maxFeePerGas, maxPriorityFeePerGas and nonce everywhere.',
    queryEnvelope: 'Original external sender, exact fixed token/calldata, explicit zero value, gas300000, no fee or nonce fields. Every before/after tracer is isolated.',
    afterOverrides: 'All fields from frozen buildStateOverrides(original diff), byte-for-byte identical across all after token queries and direct after eth_call. Never apply a query diff to another query.',
    headerWitness: 'An isolated predeclared empty-code address receives only ephemeral witness code; after witness adds this disjoint code entry to the complete original overrides. It returns NUMBER,TIMESTAMP,GASLIMIT,BASEFEE,PREVRANDAO,COINBASE,CHAINID,BLOCKHASH(number-1). No block overrides.',
    stateAnchor: 'Use the first transaction hash in each saved ordinary block list, without replacement. Read its returned sender nonce at selected and parent block hashes, then trace a USDC query from that sender. A nonce visible in query prestate equal to selected state and different from parent is the proposed state-position witness; an equal or unavailable anchor remains inconclusive.',
    skips: 'After queries require successful original trace, no lifecycle operations, and valid complete original diff. Witnesses additionally require the reserved address to be unused and have empty pinned code. Anchor dependencies may fail independently. A chain/header failure skips that cell; global budget failures skip remaining labels. Every skip is retained.',
    caps: 'No retries, fallback, replacement blocks/wallets or more than126 scheduled RPCs.8MiB per response,64MiB total,25s per call and10min monotonic overall. A cap-crossing final chunk is counted and discarded; no additional request after total cap. Remaining two authorized RPC slots are unused.',
    provenance: 'Frozen historical pure path checks are applied to a locally wrapped single current trace only. No historical transaction-index, fee, receipt or executionIdentity label is reused. Runtime bytecode attestation and malicious override controls are outside this capture.',
  } }), { flag: 'wx' }); console.log('Plan saved; no network.'); process.exit(0);
}
const planBytes = await readFile(new URL('plan.json', DIR)), plan = JSON.parse(planBytes);
assert.equal(plan.scriptSha256, scriptSha256); assert.equal(plan.frozenSourcesSha256, sha(frozenBytes)); assert.deepEqual(plan.cases, cases); assert.deepEqual(plan.scheduled, scheduled); assert.deepEqual(plan.limits, LIMITS);
if (command === '--validate') { console.log(json({ status: 'validated_no_network', plannedRpc: scheduled.length, scriptSha256, planSha256: sha(planBytes), frozenCommit: frozen.commit })); process.exit(0); }
if (!['--run', '--verify'].includes(command)) throw new Error('Use --plan, --validate, --run, or --verify.');
const live = command === '--run', began = performance.now();
const capture = live ? { schemaVersion: '1.0', status: 'running', startedAt: new Date().toISOString(), planSha256: sha(planBytes), scriptSha256, frozenSourcesSha256: sha(frozenBytes), records: [], skipped: [], responseBytes: 0 } : JSON.parse(await readFile(new URL('capture.json', DIR)));
assert.equal(capture.planSha256, sha(planBytes)); assert.equal(capture.scriptSha256, scriptSha256);
if (live) await writeFile(new URL('capture.json', DIR), json(capture), { flag: 'wx' });
let sequence = 0, recordCursor = 0, skipCursor = 0, stopped = null;
const save = async () => { if (live) await writeFile(new URL('capture.json', DIR), json(capture)); };
function skip(provider, caseId, label, reason) {
  assert.deepEqual(scheduled[sequence++], { provider, caseId, label });
  const record = { provider, caseId, label, reason };
  if (live) capture.skipped.push(record); else assert.deepEqual(capture.skipped[skipCursor++], record);
  return null;
}
async function rpc(provider, caseId, label, method, params, reason = null) {
  if (reason) return skip(provider, caseId, label, reason);
  if (live && (stopped || performance.now() - began >= LIMITS.wallMs || capture.responseBytes >= LIMITS.totalResponseBytes)) { stopped ??= performance.now() - began >= LIMITS.wallMs ? 'WALL_LIMIT' : 'TOTAL_BYTE_LIMIT'; return skip(provider, caseId, label, stopped); }
  // Budget-terminal skips are replayed exactly; no delayed request is invented.
  if (!live && capture.skipped[skipCursor]?.provider === provider && capture.skipped[skipCursor]?.caseId === caseId && capture.skipped[skipCursor]?.label === label) return skip(provider, caseId, label, capture.skipped[skipCursor].reason);
  assert.deepEqual(scheduled[sequence++], { provider, caseId, label });
  const request = { jsonrpc: '2.0', id: live ? capture.records.length + 1 : recordCursor + 1, method, params: structuredClone(params) };
  if (!live) {
    const record = capture.records[recordCursor++]; assert.equal(record.provider, provider); assert.equal(record.caseId, caseId); assert.equal(record.label, label); assert.deepEqual(record.request, request);
    if (record.error) { assert.ok(record.observedBytesSha256 || record.responseSha256); return null; }
    assert.equal(record.httpStatus, 200); assert.equal(record.bodyComplete, true); assert.equal(record.responseBytes, Buffer.byteLength(record.responseRaw)); assert.equal(sha(record.responseRaw), record.responseSha256); assert.deepEqual(JSON.parse(record.responseRaw), record.response); assert.equal(record.response.id, request.id); assertNoProviderErrorResult(method, record.response.result);
    return structuredClone(record.response.result);
  }
  assert.ok(capture.records.length < LIMITS.maxRpc);
  const record = { provider, endpoint: ENDPOINTS[provider], caseId, label, startedAt: new Date().toISOString(), request, responseBytes: 0 };
  capture.records.push(record);
  const start = performance.now(), controller = new AbortController(), hash = createHash('sha256'), chunks = [];
  let reader, timer, closed = false, complete = false, digest;
  const finishHash = () => digest ??= hash.digest('hex');
  const fail = code => Object.assign(new Error(code), { code });
  const cancel = candidate => { try { void candidate?.cancel().catch(() => {}); } catch {} };
  const deadline = () => { if (performance.now() - began >= LIMITS.wallMs) { stopped = 'WALL_LIMIT'; throw fail(stopped); } if (performance.now() - start >= LIMITS.requestMs) throw fail('REQUEST_TIMEOUT'); };
  async function execute() {
    const response = await fetch(ENDPOINTS[provider], { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
    if (closed || controller.signal.aborted) { try { cancel(response.body?.getReader()); } catch {} throw fail('REQUEST_TIMEOUT'); }
    deadline(); record.httpStatus = response.status; record.responseHeaders = Object.fromEntries(['content-type', 'date', 'server'].flatMap(key => response.headers.has(key) ? [[key, response.headers.get(key)]] : []));
    if (!response.body?.getReader) throw fail('INVALID_JSON_RPC'); reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (closed || controller.signal.aborted) { cancel(reader); throw fail('REQUEST_TIMEOUT'); }
      if (done) { deadline(); break; }
      const chunk = Buffer.from(value); record.responseBytes += chunk.length; capture.responseBytes += chunk.length; hash.update(chunk); deadline();
      if (capture.responseBytes > LIMITS.totalResponseBytes) { stopped = 'TOTAL_BYTE_LIMIT'; throw fail(stopped); }
      if (record.responseBytes > LIMITS.responseBytes) throw fail('RESPONSE_BYTE_LIMIT'); chunks.push(chunk);
    }
    complete = true; record.responseSha256 = finishHash(); if (!response.ok) throw fail('HTTP_ERROR');
    let raw, payload; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); payload = JSON.parse(raw); } catch { throw fail('INVALID_JSON_RPC'); }
    if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || payload.id !== request.id) throw fail('INVALID_JSON_RPC');
    if (Object.hasOwn(payload, 'error')) { if (Number.isSafeInteger(payload.error?.code)) record.rpcErrorCode = payload.error.code; throw fail('RPC_ERROR'); }
    if (!Object.hasOwn(payload, 'result')) throw fail('INVALID_JSON_RPC'); assertNoProviderErrorResult(method, payload.result);
    const result = structuredClone(payload.result); deadline(); assert.equal(sha(Buffer.from(raw)), record.responseSha256); record.responseRaw = raw; record.response = payload; record.bodyComplete = true; return result;
  }
  let result = null;
  try { result = await Promise.race([execute(), new Promise((_, reject) => { timer = setTimeout(() => { const code = performance.now() - began >= LIMITS.wallMs ? 'WALL_LIMIT' : 'REQUEST_TIMEOUT'; if (code === 'WALL_LIMIT') stopped = code; controller.abort(); reject(fail(code)); }, Math.max(1, Math.min(LIMITS.requestMs, LIMITS.wallMs - (performance.now() - began)))); })]); }
  catch (error) { record.error = { code: SAFE_CODES.has(error?.code) ? error.code : 'TRANSPORT_UNAVAILABLE', message: 'The fixed read-only capability request did not complete; arbitrary provider exception text is omitted.' }; record.bodyComplete = complete; record.observedBytesSha256 = finishHash(); }
  finally { closed = true; clearTimeout(timer); if (record.error) { controller.abort(); cancel(reader); } record.completedAt = new Date().toISOString(); record.elapsedMs = Math.round(performance.now() - start); }
  await save(); console.log(json({ provider, caseId, label, id: request.id, outcome: record.error?.code ?? 'response', bytes: record.responseBytes })); return result;
}
const quantity = value => typeof value === 'string' && QUANTITY.test(value) ? BigInt(value) : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
function querySummary(trace, query, sender) {
  if (!trace) return { status: 'unavailable' };
  try { const result = validateQuery([[trace]], query, sender); return { status: 'validated_known_path', amountRaw: result.amount.toString(), gasUsed: result.gasUsed.toString() }; }
  catch { return { status: 'invalid_query_path_or_output' }; }
}
function diffSummary(diff, sender, expectedNonce, expectedBalance) {
  if (!diff) return { status: 'unavailable' };
  try {
    buildStateOverrides(diff);
    const accounts = [...new Set([...Object.keys(diff.pre), ...Object.keys(diff.post)])];
    const pre = diff.pre[sender], post = diff.post[sender];
    const checks = { onlySenderChanged: accounts.length === 1 && accounts[0] === sender, onlyNonceAndBalanceFields: accounts.every(account => [diff.pre[account], diff.post[account]].every(value => value && Object.keys(value).every(field => ['nonce', 'balance'].includes(field)))), noStorageOrCode: accounts.every(account => [diff.pre[account], diff.post[account]].every(value => value && value.code === undefined && !Object.keys(value.storage ?? {}).length)), expectedStartNonce: expectedNonce !== null && quantity(pre?.nonce) === expectedNonce, incrementsExactlyOnce: quantity(pre?.nonce) !== null && quantity(post?.nonce) === quantity(pre.nonce) + 1n, expectedStartBalance: expectedBalance !== null && quantity(pre?.balance) === expectedBalance, noNativeDebit: quantity(pre?.balance) !== null && (post?.balance === undefined || quantity(post.balance) === quantity(pre.balance)) };
    return { status: Object.values(checks).every(Boolean) ? 'matches_candidate_sender_nonce_only_unpriced_profile' : 'outside_candidate_profile', checks, changedAccounts: accounts, senderBefore: pre ?? null, senderAfter: post ?? null };
  } catch { return { status: 'invalid_diff' }; }
}
function witnessCode(number) { return '0x43600052426020524560405248606052446080524160a0524660c0527f' + (BigInt(number) - 1n).toString(16).padStart(64, '0') + '4060e0526101006000f3'; }
function witnessSummary(trace, header, sender) {
  try {
    const frame = semanticTrace(trace); assert.equal(frame.type, 'CALL'); assert.equal(frame.from, sender); assert.equal(frame.to, PROBE); assert.equal(frame.value, '0'); assert.equal(frame.input, '0x'); assert.equal(frame.error, null); assert.equal(frame.revertReason, null); assert.equal(frame.calls.length, 0); assert.equal(frame.logs.length, 0); assert.equal(frame.output.length, 514);
    const names = ['number', 'timestamp', 'gasLimit', 'baseFee', 'prevRandao', 'coinbase', 'chainId', 'parentHash'];
    const values = Array.from({ length: 8 }, (_, index) => BigInt('0x' + frame.output.slice(2 + index * 64, 66 + index * 64)).toString());
    const expected = [header.number, header.timestamp, header.gasLimit, header.baseFeePerGas, header.mixHash, header.miner, 999, header.parentHash].map(value => BigInt(value).toString());
    return { status: 'observed', values: Object.fromEntries(names.map((name, index) => [name, values[index]])), headerValues: Object.fromEntries(names.map((name, index) => [name, expected[index]])), differences: names.filter((_, index) => values[index] !== expected[index]) };
  } catch { return { status: trace ? 'invalid_witness' : 'unavailable' }; }
}
const observations = [];
for (const provider of Object.keys(ENDPOINTS)) {
  const chain = await rpc(provider, null, 'chain', 'eth_chainId', []);
  for (const item of cases) {
    const call = (label, method, params, reason) => rpc(provider, item.id, label, method, params, reason);
    const out = { provider, caseId: item.id, block: { hash: item.header.hash, number: BigInt(item.header.number).toString(), timestamp: BigInt(item.header.timestamp).toString() }, originalEnvelope: item.original, queries: [] }; observations.push(out);
    if (chain !== '0x3e7') { for (const label of labels(item)) skip(provider, item.id, label, 'chain_not_confirmed'); out.status = 'skipped_chain_not_confirmed'; continue; }
    const header = await call('header', 'eth_getBlockByHash', [item.header.hash, false]);
    const headerValid = header && ['hash', 'parentHash', 'number', 'timestamp', 'gasLimit', 'baseFeePerGas', 'mixHash', 'miner'].every(key => header[key] === item.header[key]);
    if (!headerValid) { for (const label of labels(item).slice(1)) skip(provider, item.id, label, 'pinned_header_not_confirmed'); out.status = 'skipped_header_not_confirmed'; continue; }
    const nonce = await call('sender-nonce', 'eth_getTransactionCount', [item.original.from, item.pinned]);
    const nativeBalance = await call('sender-balance', 'eth_getBalance', [item.original.from, item.pinned]);
    const senderCode = await call('sender-code', 'eth_getCode', [item.original.from, item.pinned]);
    const probeCode = await call('witness-code', 'eth_getCode', [PROBE, item.pinned]);
    out.sender = { address: item.original.from, nonce, nativeBalance, code: senderCode };
    const originalTrace = await call('original-trace', 'debug_traceCall', [item.original, item.pinned, tracer('trace')]);
    const originalDiff = await call('original-diff', 'debug_traceCall', [item.original, item.pinned, tracer('diff')]);
    let overrides = null, normalized = null;
    try { normalized = semanticTrace(originalTrace); assert.equal(normalized.type, 'CALL'); assert.equal(normalized.from, item.original.from); assert.equal(normalized.to, item.original.to); assert.equal(normalized.input, item.original.data); assert.equal(normalized.value, '0'); assert.equal(normalized.error, null); assert.equal(normalized.revertReason, null); assert.equal(hasContractLifecycle(normalized), false); overrides = buildStateOverrides(originalDiff); out.originalValidation = 'successful_known_envelope_no_lifecycle_valid_diff'; }
    catch { out.originalValidation = 'unavailable_reverted_or_outside_diff_scope'; }
    out.originalOverrides = overrides; out.originalOverridesSha256 = overrides ? sha(json(overrides)) : null;
    const expectedBeforeNonce = quantity(nonce), expectedBalance = quantity(nativeBalance);
    const expectedAfterNonce = overrides?.[item.original.from]?.nonce !== undefined ? quantity(overrides[item.original.from].nonce) : expectedBeforeNonce;
    const expectedAfterBalance = overrides?.[item.original.from]?.balance !== undefined ? quantity(overrides[item.original.from].balance) : expectedBalance;
    const used = frame => frame.from === PROBE || frame.to === PROBE || frame.calls.some(used);
    const safeWitness = probeCode === '0x' && normalized && !used(normalized) && !Object.hasOwn(overrides ?? {}, PROBE);
    const witness = { from: item.original.from, to: PROBE, data: '0x', value: '0x0', gas: '0x493e0' };
    const code = witnessCode(header.number);
    const beforeWitness = await call('header-before', 'debug_traceCall', [witness, item.pinned, { ...tracer('trace'), stateOverrides: { [PROBE]: { code } } }], safeWitness ? null : 'witness_address_not_proven_disjoint');
    const afterWitness = await call('header-after', 'debug_traceCall', [witness, item.pinned, { ...tracer('trace'), stateOverrides: { ...overrides, [PROBE]: { code } } }], !overrides ? 'original_poststate_unavailable' : safeWitness ? null : 'witness_address_not_proven_disjoint');
    out.headerWitness = { before: witnessSummary(beforeWitness, header, item.original.from), after: witnessSummary(afterWitness, header, item.original.from) };
    const anchor = await call('anchor-transaction', 'eth_getTransactionByHash', [item.anchorTransactionHash]);
    const anchorValid = anchor && anchor.hash === item.anchorTransactionHash && anchor.blockHash === item.header.hash && anchor.blockNumber === item.header.number && ADDRESS.test(anchor.from) && quantity(anchor.nonce) !== null;
    const anchorNonce = await call('anchor-nonce-end', 'eth_getTransactionCount', [anchor?.from, item.pinned], anchorValid ? null : 'fixed_anchor_transaction_unavailable');
    const parentNonce = await call('anchor-nonce-parent', 'eth_getTransactionCount', [anchor?.from, { blockHash: header.parentHash, requireCanonical: true }], anchorValid ? null : 'fixed_anchor_transaction_unavailable');
    const anchorQuery = { from: anchor?.from, to: USDC, data: item.queries[0].data, value: '0x0', gas: '0x493e0' };
    const anchorTrace = await call('anchor-trace', 'debug_traceCall', [anchorQuery, item.pinned, tracer('trace')], anchorValid ? null : 'fixed_anchor_transaction_unavailable');
    const anchorDiff = await call('anchor-diff', 'debug_traceCall', [anchorQuery, item.pinned, tracer('diff')], anchorValid ? null : 'fixed_anchor_transaction_unavailable');
    const anchorPath = querySummary(anchorTrace, anchorQuery, anchor?.from), tracedNonce = quantity(anchorDiff?.pre?.[anchor?.from]?.nonce);
    const endNonce = quantity(anchorNonce), priorNonce = quantity(parentNonce);
    out.anchor = { transactionHash: item.anchorTransactionHash, sender: anchor?.from ?? null, transactionNonce: anchor?.nonce ?? null, directEndNonce: anchorNonce, directParentNonce: parentNonce, tracedPreNonce: tracedNonce?.toString() ?? null, queryPath: anchorPath, classification: anchorPath.status === 'validated_known_path' && tracedNonce !== null && endNonce !== null && priorNonce !== null && endNonce !== priorNonce ? tracedNonce === endNonce ? 'traced_state_matches_end_and_differs_from_parent' : tracedNonce === priorNonce ? 'traced_state_matches_parent_and_differs_from_end' : 'traced_state_matches_neither_anchor' : 'inconclusive' };
    for (const query of item.queries) {
      const envelope = { from: item.original.from, to: query.to, data: query.data, value: '0x0', gas: '0x493e0' };
      const bt = await call(`${query.id}-before-trace`, 'debug_traceCall', [envelope, item.pinned, tracer('trace')]);
      const bd = await call(`${query.id}-before-diff`, 'debug_traceCall', [envelope, item.pinned, tracer('diff')]);
      const at = await call(`${query.id}-after-trace`, 'debug_traceCall', [envelope, item.pinned, { ...tracer('trace'), stateOverrides: overrides }], overrides ? null : 'original_poststate_unavailable');
      const ad = await call(`${query.id}-after-diff`, 'debug_traceCall', [envelope, item.pinned, { ...tracer('diff'), stateOverrides: overrides }], overrides ? null : 'original_poststate_unavailable');
      const before = querySummary(bt, query, item.original.from), after = querySummary(at, query, item.original.from);
      out.queries.push({ ...query, envelope, before, after, deltaRaw: before.amountRaw !== undefined && after.amountRaw !== undefined ? (BigInt(after.amountRaw) - BigInt(before.amountRaw)).toString() : null, beforeDiff: diffSummary(bd, item.original.from, expectedBeforeNonce, expectedBalance), afterDiff: diffSummary(ad, item.original.from, expectedAfterNonce, expectedAfterBalance) });
    }
    const usdc = { from: item.original.from, to: USDC, data: item.queries[0].data, value: '0x0', gas: '0x493e0' };
    const directBefore = await call('direct-usdc-before', 'eth_call', [usdc, item.pinned]);
    const directAfter = await call('direct-usdc-after', 'eth_call', [usdc, item.pinned, overrides], overrides ? null : 'original_poststate_unavailable');
    out.directUSDC = { before: directBefore, after: directAfter, beforeMatchesTrace: WORD.test(directBefore ?? '') && out.queries[0].before.amountRaw === BigInt(directBefore).toString(), afterMatchesTrace: WORD.test(directAfter ?? '') && out.queries[0].after.amountRaw === BigInt(directAfter).toString() };
    const canonical = await call('canonical', 'eth_getBlockByNumber', [item.header.number, false]);
    out.canonical = canonical && ['hash', 'parentHash', 'number', 'timestamp'].every(key => canonical[key] === header[key]) ? 'confirmed' : 'unavailable_or_mismatched';
    out.status = out.originalValidation === 'successful_known_envelope_no_lifecycle_valid_diff' && out.canonical === 'confirmed' ? 'captured_current_capability_observations' : 'incomplete_current_capability_observations';
    await save();
  }
}
assert.equal(sequence, scheduled.length);
const summary = { schemaVersion: '1.0', planSha256: sha(planBytes), frozenCommit: frozen.commit, scope: 'Development capability observations only. Query-path checks use frozen historical pure logic; fee/nonce/header observations are current-specific and do not enable production measurements.', observations, limits: ['Both providers may share underlying node/client behavior; this is not an independent execution oracle.', 'No fresh runtime-code hashes for token/Pool dependencies, malicious-override controls, signature validation, paid infrastructure, signing or broadcasts.', 'Header witnesses may expose a synthetic BASEFEE. No unchanged-header label is assumed.', 'Anchors classify only the observed sender nonce under the exact tested wrapper; they do not prove every storage account or arbitrary state transition.', 'Recorded cases are development controls, not prospective or representative accuracy evidence.'] };
if (live) {
  capture.status = stopped ? 'completed_with_budget_skips' : 'complete'; capture.completedAt = new Date().toISOString(); capture.elapsedMs = Math.round(performance.now() - began); capture.summarySha256 = sha(json(summary)); await save(); await writeFile(new URL('summary.json', DIR), json(summary), { flag: 'wx' });
} else {
  assert.equal(recordCursor, capture.records.length); assert.equal(skipCursor, capture.skipped.length); assert.equal(capture.records.reduce((sum, record) => sum + record.responseBytes, 0), capture.responseBytes); assert.equal(capture.summarySha256, sha(json(summary))); assert.deepEqual(JSON.parse(await readFile(new URL('summary.json', DIR))), summary);
}
console.log(json({ status: live ? capture.status : 'verified_offline', rpcRequests: capture.records.length, skipped: capture.skipped.length, responseBytes: capture.responseBytes, cases: observations.map(item => ({ provider: item.provider, caseId: item.caseId, status: item.status, anchor: item.anchor?.classification, headerDifferences: item.headerWitness?.before.differences, queries: item.queries.map(query => ({ id: query.id, before: query.before.status, after: query.after.status, deltaRaw: query.deltaRaw })) })) }));
