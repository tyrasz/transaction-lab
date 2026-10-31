// Saved parsed-response audit. Deliberately imports no product or EVM modules.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MANIFEST_PIN = '044f99cb954c798550c34b602c92aac62c4c61b60bda15e90ca3bb63f7ffb2de';
const PROBE = '0x000000000000000000000000000000000000ba1a';
const sha = b => createHash('sha256').update(b).digest('hex');
const own = (v, k) => Object.hasOwn(v, k);
const hex = n => '0x' + BigInt(n).toString(16);
const addr = a => { assert.match(a, /^0x[0-9a-f]{40}$/); return a; };
const uint = x => { assert(typeof x === 'string' || typeof x === 'bigint' || Number.isSafeInteger(x)); const n = BigInt(x); assert(n >= 0n && n < 2n ** 256n); return n; };
const word = x => uint(x).toString(16).padStart(64, '0');
const decimal = x => { const n = BigInt(x), s = n < 0n ? '-' : '', a = n < 0n ? -n : n; const frac = (a % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return s + a / 10n ** 18n + (frac ? '.' + frac : ''); };
const pinned = header => ({ blockHash: header.hash, requireCanonical: true });
const envelope = request => ({ from: request.from, to: request.to, data: request.data, value: hex(request.value), gas: '0x4c4b40' });

export function committedNative(trace) {
  const net = new Map(); let frames = 0;
  const add = (a, n) => net.set(a, (net.get(a) ?? 0n) + n);
  function walk(frame, context, committed, depth) {
    assert(++frames <= 1000 && depth <= 32); const type = frame.type;
    assert(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(type), 'Lifecycle trace outside audit scope');
    addr(frame.from); addr(frame.to); const value = uint(frame.value ?? '0x0');
    if (context) assert.equal(frame.from, context, 'Trace storage-context sender');
    const live = committed && !frame.error;
    if (live && type === 'CALL' && value > 0n) { add(frame.from, -value); add(frame.to, value); }
    const next = ['DELEGATECALL', 'CALLCODE'].includes(type) ? context : frame.to;
    assert(next); assert(Array.isArray(frame.calls ?? []));
    for (const child of frame.calls ?? []) walk(child, next, live, depth + 1);
  }
  walk(trace, null, true, 0); return net;
}

export function nonceOnly(diff, sender, nonce, balance) {
  assert.deepEqual(Object.keys(diff).sort(), ['post', 'pre']);
  assert.deepEqual(Object.keys(diff.pre), [sender], 'Witness changed/read another account');
  assert.deepEqual(Object.keys(diff.post), [sender], 'Witness changed/read another account');
  assert.deepEqual(Object.keys(diff.pre[sender]).sort(), ['balance', 'nonce']);
  assert(Object.keys(diff.post[sender]).every(k => ['balance', 'nonce'].includes(k)));
  assert.equal(uint(diff.pre[sender].nonce), nonce); assert.equal(uint(diff.post[sender].nonce), nonce + 1n);
  assert.equal(uint(diff.pre[sender].balance), balance);
  if (own(diff.post[sender], 'balance')) assert.equal(uint(diff.post[sender].balance), balance);
}

export function witnessCode(header, accounts) {
  let code = '0x43600052426020524560405248606052446080524160a0524660c0527f' + word(uint(header.number) - 1n) + '4060e052';
  for (const [i, a] of accounts.entries()) code += '73' + addr(a).slice(2) + '3161' + (256 + i * 32).toString(16).padStart(4, '0') + '52';
  return code + '61' + (256 + accounts.length * 32).toString(16).padStart(4, '0') + '6000f3';
}

function matchRecord(records, request, response, used = new Set()) {
  const index = records.findIndex((r, i) => !used.has(i) && r.method === request.method && isDeepStrictEqual(r.params, request.params) &&
    (own(response, 'result') ? !r.error && isDeepStrictEqual(r.result, response.result) : isDeepStrictEqual(r.error, response.error)));
  assert(index >= 0, 'Evidence has no matching retained parsed RPC response'); used.add(index); return records[index];
}
function bindEvidence(evidence, records, header) {
  assert(Array.isArray(evidence.request) && Array.isArray(evidence.response));
  assert.equal(evidence.request.length, evidence.response.length);
  const pairs = new Map(), used = new Set();
  for (const q of evidence.request) {
    assert(Number.isSafeInteger(q.id) && q.id > 0 && !pairs.has(q.id));
    const rs = evidence.response.filter(r => r.id === q.id); assert.equal(rs.length, 1); const r = rs[0]; assert.equal(r.method, q.method);
    const raw = matchRecord(records, q, r, used);
    if (['eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'debug_traceCall'].includes(q.method)) assert.deepEqual(q.params[1], pinned(header));
    pairs.set(q.id, { q, r, raw });
  }
  return pairs;
}
function result(pair, method) { assert(pair); assert.equal(pair.q.method, method); assert(!pair.r.error && own(pair.r, 'result')); return pair.r.result; }
function originalOverrides(diff) {
  assert.deepEqual(Object.keys(diff).sort(), ['post', 'pre']); const out = {};
  assert.deepEqual(Object.keys(diff.pre).sort(), Object.keys(diff.post).sort(), 'Materialization/deletion outside measured audit scope');
  for (const account of Object.keys(diff.post)) {
    addr(account); const before = diff.pre[account], after = diff.post[account], row = {};
    assert(Object.keys(before).every(k => ['balance', 'nonce', 'code', 'storage'].includes(k)));
    assert(Object.keys(after).every(k => ['balance', 'nonce', 'code', 'storage'].includes(k)));
    for (const field of ['balance', 'nonce']) if (own(after, field)) row[field] = hex(uint(after[field]));
    if (own(after, 'code')) assert.equal(after.code, before.code, 'Runtime replacement outside audit scope');
    const slots = [...new Set([...Object.keys(before.storage ?? {}), ...Object.keys(after.storage ?? {})])].sort();
    if (slots.length) { row.stateDiff = {}; for (const slot of slots) { assert.match(slot, /^0x[0-9a-f]{64}$/); row.stateDiff[slot] = '0x' + word(after.storage?.[slot] ?? 0); } }
    if (Object.keys(row).length) out[account] = row;
  }
  return out;
}

export function auditAttempt(saved, declaration, provider, header, implementationHash) {
  assert.equal(saved.id, declaration.id + '-' + provider.id); assert.deepEqual(saved.provider, provider);
  assert.deepEqual(saved.input, { ...declaration.request, block: header.number });
  const records = saved.records; assert(records.length <= 70);
  assert.deepEqual(records.map(r => r.id), records.map((_, i) => i + 1));
  assert.deepEqual(records.map(r => r.completionSequence).sort((a, b) => a - b), records.map((_, i) => i + 1));
  const summary = { id: saved.id, rpcCalls: records.length, error: saved.error, nativeStatus: saved.report?.nativeBalanceChanges?.status ?? null, measurements: [] };
  if (saved.error) { summary.classification = 'attempt_unavailable'; return summary; }
  const report = saved.report, request = declaration.request, source = report.source, traceRequest = report.evidence.traceRequest;
  assert.deepEqual(report.request, request); assert.equal(report.implementation.sourceSha256, implementationHash);
  assert.equal(source.provider, new URL(provider.url).hostname); assert.equal(source.chainId, 999);
  assert.equal(source.blockHash, header.hash); assert.equal(source.blockNumber, uint(header.number).toString());
  assert.equal(source.timestamp, uint(header.timestamp).toString()); assert.equal(source.requestedBlock, header.number);
  assert.equal(source.blockBinding, 'explicit_block_hash');
  assert.deepEqual(traceRequest, { method: 'debug_traceCall', params: [envelope(request), pinned(header), { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } }] });
  const trace = report.evidence.traceResponse;
  matchRecord(records, traceRequest, { result: trace });
  assert.equal(trace.type, 'CALL'); assert.equal(trace.from, request.from); assert.equal(trace.to, request.to);
  assert.equal(trace.input, request.data); assert.equal(uint(trace.value), uint(request.value)); assert.equal(uint(trace.gas), 5000000n);
  assert.equal(report.execution.gasUsed, uint(trace.gasUsed).toString()); assert.equal(report.execution.returnData, trace.output ?? '0x');
  assert.equal(report.execution.status, trace.error ? 'reverted' : 'success'); assert.equal(report.execution.error, trace.error ?? null);
  const net = committedNative(trace), native = report.nativeBalanceChanges;
  summary.originalExecution = report.execution; summary.committedCallNet = [...net].map(([account, delta]) => ({ account, deltaRaw: delta.toString() }));
  assert.equal(native.feeScope, 'excluded');
  if (!['measured', 'partial'].includes(native.status)) {
    assert.deepEqual(native.assets, []); assert(!own(native, 'executionIdentity'));
    assert.deepEqual(report.evidence.nativeBalanceMeasurement, { request: [], response: [] });
    if (trace.error) { assert.equal(native.status, 'not_applicable'); assert.equal(net.size, 0); }
    if (report.evidence.nativeBalanceAudit) {
      const e = report.evidence.nativeBalanceAudit; assert.equal(e.verification, 'unverified'); const pairs = bindEvidence(e, records, header);
      summary.unavailableReason = e.reason;
      summary.witnessDiffAccountShapes = [...pairs.values()].filter(p => p.q.method === 'debug_traceCall' && p.q.params[0].to === PROBE && p.q.params[2].tracer === 'prestateTracer').map(p => ({ evidenceId: p.q.id,
        accounts: [...new Set([...Object.keys(p.r.result?.pre ?? {}), ...Object.keys(p.r.result?.post ?? {})])].map(account => ({ account, beforeFields: Object.keys(p.r.result.pre[account] ?? {}), afterFields: Object.keys(p.r.result.post[account] ?? {}) })) }));
    }
    summary.classification = native.status; return summary;
  }
  assert(!trace.error); assert.equal(native.basis, 'current_pinned_state_validated_native_balance'); assert.deepEqual(native.limits, { maxAccounts: 8 });
  assert(native.assets.length > 0 && native.assets.length <= 8); const accounts = native.assets.map(a => addr(a.account)); assert.equal(new Set(accounts).size, accounts.length);
  assert.equal(native.candidateAccountCount, accounts.length + native.omittedAccounts.length);
  assert.equal(native.status, native.omittedAccounts.length ? 'partial' : 'measured');
  const pairs = bindEvidence(report.evidence.nativeBalanceMeasurement, records, header);
  const find = (method, params) => { const matches = [...pairs.values()].filter(p => p.q.method === method && isDeepStrictEqual(p.q.params, params)); assert.equal(matches.length, 1); return matches[0]; };
  const balance = uint(result(find('eth_getBalance', [request.from, pinned(header)]), 'eth_getBalance'));
  const nonce = uint(result(find('eth_getTransactionCount', [request.from, pinned(header)]), 'eth_getTransactionCount'));
  const diffs = [...pairs.values()].filter(p => p.q.method === 'debug_traceCall' && p.q.params[0].to === request.to && p.q.params[2].tracer === 'prestateTracer' && !p.q.params[2].stateOverrides);
  assert.equal(diffs.length, 1); assert.deepEqual(diffs[0].q.params, [envelope(request), pinned(header), { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
  const diff = result(diffs[0], 'debug_traceCall'), overrides = originalOverrides(diff);
  assert.equal(uint(diff.pre[request.from].nonce), nonce); assert.equal(uint(diff.post[request.from].nonce), nonce + 1n);
  const id = native.executionIdentity;
  assert.equal(id.stateBlockHash, header.hash); assert.equal(id.blockNumber, uint(header.number).toString()); assert.equal(id.timestamp, uint(header.timestamp).toString());
  assert.equal(id.originalEnvelopeSha256, sha(JSON.stringify(envelope(request)))); assert.equal(id.stateOverridesSha256, sha(JSON.stringify(overrides)));
  assert.equal(id.stateBinding, 'block_hash'); assert.equal(id.headerContext, 'synthetic_unpriced_basefee_zero'); assert.equal(id.feePolicy, 'gas_price_omitted_no_query_native_debit'); assert.equal(id.method, 'debug_traceCall');
  const code = witnessCode(header, accounts), headers = [header.number, header.timestamp, header.gasLimit, 0, header.mixHash, header.miner, 999, header.parentHash].map(uint);
  for (const [i, asset] of native.assets.entries()) {
    assert.deepEqual(asset.asset, { type: 'native', symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 });
    assert.match(asset.beforeRaw, /^(0|[1-9][0-9]*)$/); assert.match(asset.afterRaw, /^(0|[1-9][0-9]*)$/); assert.match(asset.deltaRaw, /^(0|-?[1-9][0-9]*)$/);
    const before = uint(asset.beforeRaw), after = uint(asset.afterRaw), delta = BigInt(asset.deltaRaw);
    assert.equal(after - before, delta); assert.equal(delta, net.get(asset.account) ?? 0n);
    for (const k of ['before', 'after', 'delta']) assert.equal(asset[k], decimal(asset[k + 'Raw']));
    const anchor = pairs.get(asset.anchorEvidenceId); assert.deepEqual(anchor.q.params, [asset.account, pinned(header)]); assert.equal(uint(result(anchor, 'eth_getBalance')), before);
    const pre = diff.pre[asset.account], post = diff.post[asset.account];
    if (pre) { assert.equal(uint(pre.balance), before); assert.equal(uint(post.balance ?? pre.balance), after); } else assert.equal(delta, 0n);
    assert.equal(asset.queryEvidence.length, 2);
    for (const [sideIndex, q] of asset.queryEvidence.entries()) {
      const side = sideIndex ? 'after' : 'before'; assert.equal(q.state, side); assert.equal(q.wordIndex, 8 + i);
      const tracePair = pairs.get(q.traceEvidenceId), mutationPair = pairs.get(q.mutationEvidenceId);
      const expectedOverrides = { ...(sideIndex ? overrides : {}), [PROBE]: { code } };
      const call = { from: request.from, to: PROBE, data: '0x', value: '0x0', gas: '0x493e0' };
      for (const [pair, tracer, tracerConfig] of [[tracePair, 'callTracer', { withLog: true }], [mutationPair, 'prestateTracer', { diffMode: true }]])
        assert.deepEqual(pair.q.params, [call, pinned(header), { tracer, timeout: '15s', tracerConfig, stateOverrides: expectedOverrides }]);
      const witness = result(tracePair, 'debug_traceCall'); assert(!witness.error); assert.equal(witness.type, 'CALL'); assert.equal(witness.from, request.from); assert.equal(witness.to, PROBE); assert.equal(witness.input, '0x'); assert.equal(uint(witness.value), 0n); assert.equal(uint(witness.gas), 300000n); assert(uint(witness.gasUsed) > 0n && uint(witness.gasUsed) <= 300000n); assert.deepEqual(witness.calls ?? [], []); assert.deepEqual(witness.logs ?? [], []);
      assert.match(witness.output, /^0x[0-9a-f]+$/); assert.equal(witness.output.length, 2 + (8 + accounts.length) * 64);
      const words = witness.output.slice(2).match(/.{64}/g).map(w => BigInt('0x' + w)); assert.deepEqual(words.slice(0, 8), headers); assert.equal(words[q.wordIndex], sideIndex ? after : before);
      nonceOnly(result(mutationPair, 'debug_traceCall'), request.from, nonce + BigInt(sideIndex), balance + (sideIndex ? net.get(request.from) ?? 0n : 0n));
    }
    summary.measurements.push({ account: asset.account, beforeRaw: asset.beforeRaw, afterRaw: asset.afterRaw, deltaRaw: asset.deltaRaw, anchorEvidenceId: asset.anchorEvidenceId, queryEvidence: asset.queryEvidence });
  }
  const candidates = new Set(net.keys());
  for (const account of Object.keys(diff.post)) if (own(diff.post[account], 'balance') && uint(diff.post[account].balance) !== uint(diff.pre[account].balance)) candidates.add(account);
  assert.deepEqual([...candidates].sort(), [...accounts, ...native.omittedAccounts.map(x => x.account)].sort());
  const canonical = result(find('eth_getBlockByNumber', [header.number, false]), 'eth_getBlockByNumber'); assert.equal(canonical.hash, header.hash);
  summary.classification = 'measured_amounts_bound'; return summary;
}

export async function auditCapture(directory, manifestPin = MANIFEST_PIN, terminalPin = null) {
  const readBytes = name => fs.readFile(path.join(directory, name));
  const manifestBytes = await readBytes('manifest.json'), terminalBytes = await readBytes('terminal.json');
  assert.equal(sha(manifestBytes), manifestPin); if (terminalPin) assert.equal(sha(terminalBytes), terminalPin);
  const manifest = JSON.parse(manifestBytes), terminal = JSON.parse(terminalBytes), plan = JSON.parse(await readBytes('plan.json'));
  assert.equal(new Set(manifest.files.map(x => x.path)).size, manifest.files.length);
  for (const row of manifest.files) { assert(!path.isAbsolute(row.path) && !row.path.split('/').includes('..')); const b = await readBytes(row.path); assert.equal(b.length, row.bytes); assert.equal(sha(b), row.sha256); }
  const actual = []; async function walk(dir = '') { for (const e of await fs.readdir(path.join(directory, dir), { withFileTypes: true })) { assert(!e.isSymbolicLink()); const name = path.posix.join(dir, e.name); if (e.isDirectory()) await walk(name); else { assert(e.isFile()); actual.push(name); } } } await walk();
  assert.equal(terminal.manifestSha256, manifestPin); assert.equal(terminal.status, 'completed'); assert.equal(terminal.plannedAttempts, 10); assert.equal(plan.attempts, 10); assert.equal(plan.cases.length, 5); assert.equal(plan.providers.length, 2);
  const selectionBytes = await readBytes('selection.json'); assert.equal(sha(selectionBytes), terminal.selectionSha256); const selection = JSON.parse(selectionBytes); assert.equal(selection.error, null); const header = selection.selected;
  assert.equal(selection.records.length, 3); assert.equal(uint(selection.records[0].result), 999n); assert.equal(selection.records[1].params[0], 'latest'); assert.equal(uint(selection.records[1].result.number) - 2n, uint(header.number)); assert.deepEqual(selection.records[2].params, [header.number, false]); assert.deepEqual(selection.records[2].result, header); assert(selection.records.every(r => !r.error));
  const started = JSON.parse(await readBytes('STARTED.json')); assert.equal(started.manifestSha256, manifestPin); assert.deepEqual(started.runtime, plan.runtime);
  const results = []; assert.equal(terminal.outcomes.length, 10);
  for (let index = 0; index < 10; index++) {
    const declaration = plan.cases[Math.floor(index / 2)], provider = plan.providers[index % 2], row = terminal.outcomes[index];
    const filename = declaration.id + '-' + provider.id + '.json'; assert.equal(row.file, filename); const b = await readBytes(filename); assert.equal(sha(b), row.sha256); const saved = JSON.parse(b);
    const h = createHash('sha256'); for (const file of saved.report?.implementation.sourceFiles ?? []) { assert.match(file, /^[a-z0-9-]+\.js$/); h.update(file + '\0').update(await readBytes('runtime/src/' + file)).update('\0'); }
    const outcome = auditAttempt(saved, declaration, provider, header, h.digest('hex')); results.push(outcome);
    assert.equal(row.id, saved.id); assert.deepEqual(row.error, saved.error); assert.equal(row.rpcCalls, saved.records.length);
    assert.equal(row.execution, saved.error ? null : saved.report?.execution?.status ?? null); assert.equal(row.nativeStatus, saved.error ? 'unavailable' : saved.report?.nativeBalanceChanges?.status ?? null);
    assert.deepEqual(row.nativeAmounts, saved.error ? [] : (saved.report?.nativeBalanceChanges?.assets ?? []).map(({ account, beforeRaw, afterRaw, deltaRaw }) => ({ account, beforeRaw, afterRaw, deltaRaw })));
  }
  assert.deepEqual(actual.sort(), [...manifest.files.map(x => x.path), 'manifest.json', 'STARTED.json', 'selection.json', 'terminal.json', ...terminal.outcomes.map(x => x.file)].sort());
  for (let i = 0; i < 5; i++) { const a = terminal.outcomes[i * 2], b = terminal.outcomes[i * 2 + 1], c = terminal.comparisons[i]; assert.equal(c.case, plan.cases[i].id); assert.equal(c.status, a.error || b.error ? 'unavailable' : 'observed'); assert.equal(c.nativeAmountsEqual, !a.error && !b.error && ['measured', 'partial'].includes(a.nativeStatus) && ['measured', 'partial'].includes(b.nativeStatus) ? isDeepStrictEqual(a.nativeAmounts, b.nativeAmounts) : null); }
  return { schema: 1, status: 'passed_saved_evidence_audit', manifestSha256: manifestPin, terminalSha256: sha(terminalBytes), terminalExternallyPinned: Boolean(terminalPin), checkerSha256: sha(await fs.readFile(new URL(import.meta.url))), files: actual.length, block: { number: uint(header.number).toString(), hash: header.hash }, counts: { attempts: 10, measuredAttempts: results.filter(r => r.classification === 'measured_amounts_bound').length, measuredRows: results.reduce((n, r) => n + r.measurements.length, 0), unavailable: results.filter(r => r.classification === 'unavailable').length, notApplicable: results.filter(r => r.classification === 'not_applicable').length, failedAttempts: results.filter(r => r.classification === 'attempt_unavailable').length }, results, limitations: ['Parsed RPC responses only; raw HTTP wire bytes and actual transport drainage are not independently attested.', 'Provider consistency does not establish independent clients or proof-verified chain state.', 'No product, EVM, reference execution, or network calls are made by this checker.', 'Frozen source identity and saved response joins are checked; this is not full runtime or whole-engine correctness certification.', 'Fees are excluded. Only selected native candidates are measured; unavailable results are not promoted from diagnostic output.', 'A fixed five-case/two-provider diagnostic is not a general accuracy or coverage metric.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  auditCapture(path.resolve(process.argv[2]), process.argv[3] ?? MANIFEST_PIN, process.argv[4] ?? null).then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')).catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
}
