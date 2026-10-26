// One fixed synthetic approve->supply sequence. All public calls are read-only.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const DIR = new URL('./', import.meta.url), sha = b => createHash('sha256').update(b).digest('hex');
const planBytes = await fs.readFile(new URL('plan.json', DIR)), plan = JSON.parse(planBytes);
assert.equal(plan.scriptSha256, sha(await fs.readFile(new URL(import.meta.url))));
assert.equal(plan.endpoint, 'https://eth.drpc.org');
assert.deepEqual(plan.limits, { requests: 30, candidates: 1, responseBytes: 8388608, totalBytes: 33554432, requestMs: 25000, wallMs: 360000, retries: 0 });
for (const f of [...plan.sources, ...plan.inputs]) { const b = await fs.readFile(new URL(f.path, DIR)); assert.equal(b.length, f.bytes); assert.equal(sha(b), f.sha256); }
const { buildStateOverrides } = await import('./source/src/state.js');
const { normalizeProviderStateDiff } = await import('./source/engines/standard-evm/provider-state-diff.js');
const { keccak_256 } = await import('./source/engines/standard-evm/node_modules/@noble/hashes/sha3.js');
const selector = signature => '0x' + Buffer.from(keccak_256(Buffer.from(signature))).toString('hex').slice(0, 8);
assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
assert.equal(selector('supply(address,uint256,address,uint16)'), '0x617ba037');
const prior = JSON.parse(await fs.readFile(new URL('inputs/aave-response.json', DIR)));
assert.equal(plan.supply.data, '0x617ba037' + prior.apiRequest.data.slice(10, 10 + 4 * 64));
assert.equal(plan.approval.data, '0x095ea7b3' + plan.pool.slice(2).padStart(64, '0') + BigInt(plan.amountRaw).toString(16).padStart(64, '0'));
const docs = (await fs.readFile(new URL('inputs/aave-pool-docs.html', DIR), 'utf8')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
assert(docs.includes('supply ( address asset , uint256 amount , address onBehalfOf , uint16 referralCode )'));
assert(docs.includes('standard ERC20 approve() method'));
if (process.argv.includes('--check')) { console.log(JSON.stringify({ status: 'preflight_passed', planSha256: sha(planBytes), candidateCount: 1, networkCalls: 0 })); process.exit(0); }
assert.equal(process.argv.length, 2);
const ledger = { schemaVersion: '1.0', startedAt: new Date().toISOString(), endpoint: plan.endpoint, planSha256: sha(planBytes), developmentOnly: true,
  syntheticSequence: true, exactHistoricalReplay: false, requests: [], observedBytes: 0, retainedBytes: 0, candidate: { id: plan.id, status: 'started' }, stage: 'preflight' };
const started = performance.now();
await fs.mkdir(new URL('raw/', DIR), { recursive: false });
await fs.writeFile(new URL('STARTED', DIR), ledger.startedAt + '\n', { flag: 'wx' });
const checkpoint = () => fs.writeFile(new URL('progress.json', DIR), JSON.stringify(ledger, null, 2) + '\n');
async function rpc(role, method, params) {
  assert(plan.methods.includes(method));
  assert(ledger.requests.length < plan.limits.requests && ledger.observedBytes < plan.limits.totalBytes && performance.now() - started < plan.limits.wallMs);
  const id = ledger.requests.length + 1, name = String(id).padStart(3, '0'), request = { jsonrpc: '2.0', id, method, params };
  const requestText = JSON.stringify(request), record = { id, role, request, requestText, requestSha256: sha(requestText), requestBytes: Buffer.byteLength(requestText), startedAt: new Date().toISOString() };
  ledger.requests.push(record); await checkpoint();
  const controller = new AbortController(), began = performance.now();
  const timeoutMs = Math.min(plan.limits.requestMs, plan.limits.wallMs - (began - started));
  let timer, reader, complete = false, status, bytes = 0, kept = 0, valid = false;
  const chunks = [], digest = createHash('sha256');
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); });
  const check = () => assert(performance.now() - began < timeoutMs && performance.now() - started < plan.limits.wallMs);
  let result;
  try {
    const fetching = fetch(plan.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestText, redirect: 'error', signal: controller.signal });
    fetching.then(r => { if (controller.signal.aborted) Promise.resolve(r.body?.cancel()).catch(() => {}); }).catch(() => {});
    const response = await Promise.race([fetching, deadline]); check(); status = response.status;
    reader = response.body.getReader();
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); check();
      if (part.done) { complete = true; break; }
      const data = Buffer.from(part.value); bytes += data.length; ledger.observedBytes += data.length; digest.update(data);
      const room = Math.min(plan.limits.responseBytes - kept, plan.limits.totalBytes - ledger.retainedBytes), prefix = data.subarray(0, Math.max(0, room));
      chunks.push(prefix); kept += prefix.length; ledger.retainedBytes += prefix.length;
      assert.equal(prefix.length, data.length);
    }
    const body = Buffer.concat(chunks), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), parsed = JSON.parse(text);
    record.response = parsed; check();
    assert(response.ok); assert.equal(parsed.jsonrpc, '2.0'); assert.equal(parsed.id, id);
    assert.notEqual(Object.hasOwn(parsed, 'error'), Object.hasOwn(parsed, 'result'));
    if (Object.hasOwn(parsed, 'error')) record.status = 'rpc_error';
    else { result = parsed.result; record.status = 'success'; valid = true; }
  } catch { record.status = 'transport_validation_or_budget_failure'; }
  finally {
    clearTimeout(timer); if (!complete) { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }
    const body = Buffer.concat(chunks);
    Object.assign(record, { httpStatus: status ?? null, completedAt: new Date().toISOString(), durationMs: performance.now() - began,
      raw: { file: 'raw/' + name + '.body', complete, observedBytes: bytes, bytes: kept, observedPrefixSha256: digest.digest('hex'), sha256: sha(body) } });
    await fs.writeFile(new URL(record.raw.file, DIR), body, { flag: 'wx' });
    await fs.writeFile(new URL('raw/' + name + '.json', DIR), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await checkpoint();
  }
  assert(valid, 'RPC_OBSERVATION_UNAVAILABLE'); return result;
}
const tracer = { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } };
const diffTracer = { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } };
const word = x => BigInt(x).toString(16).padStart(64, '0'), addressWord = a => a.slice(2).padStart(64, '0');
const flat = (frame, path = []) => [{ frame, path }, ...(frame.calls ?? []).flatMap((child, i) => flat(child, [...path, i]))];
const checkRoot = (trace, tx) => { assert.equal(trace.type, 'CALL'); assert.equal(trace.from.toLowerCase(), tx.from); assert.equal(trace.to.toLowerCase(), tx.to); assert.equal(trace.input, tx.data); assert.equal(BigInt(trace.value ?? '0x0'), 0n); assert.equal(BigInt(trace.gas), 5000000n); };
const successful = trace => !trace.error && !trace.revertReason;
const noTransientCode = trace => { for (const { frame } of flat(trace)) assert(!['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type)); };
try {
  ledger.stage = 'pinned_inputs';
  assert.equal(await rpc('chain', 'eth_chainId', []), '0x1');
  const block = await rpc('pinned_header', 'eth_getBlockByHash', [plan.blockHash, false]); assert.equal(block.hash, plan.blockHash); ledger.block = block;
  const pinned = { blockHash: block.hash, requireCanonical: true }, candidate = ledger.candidate;
  candidate.senderCode = await rpc('sender_code', 'eth_getCode', [plan.sender, pinned]); assert.equal(candidate.senderCode, '0x');
  candidate.nonceBefore = await rpc('sender_nonce', 'eth_getTransactionCount', [plan.sender, pinned]);
  candidate.nativeBalanceBefore = await rpc('sender_native_balance', 'eth_getBalance', [plan.sender, pinned]);
  const balanceQuery = { from: plan.sender, to: plan.usdc, data: '0x70a08231' + addressWord(plan.sender), value: '0x0', gas: '0x493e0' };
  const allowanceQuery = { from: plan.sender, to: plan.usdc, data: '0xdd62ed3e' + addressWord(plan.sender) + addressWord(plan.pool), value: '0x0', gas: '0x493e0' };
  candidate.balanceBefore = await rpc('usdc_balance_before', 'eth_call', [balanceQuery, pinned]);
  candidate.allowanceBefore = await rpc('allowance_before', 'eth_call', [allowanceQuery, pinned]);
  assert.match(candidate.balanceBefore, /^0x[0-9a-f]{64}$/); assert.match(candidate.allowanceBefore, /^0x[0-9a-f]{64}$/);
  assert(BigInt(candidate.balanceBefore) >= BigInt(plan.amountRaw)); assert.equal(BigInt(candidate.allowanceBefore), 0n);
  ledger.stage = 'deposit_without_approval';
  candidate.withoutApproval = await rpc('supply_without_approval', 'debug_traceCall', [plan.supply, block.hash, tracer]);
  checkRoot(candidate.withoutApproval, plan.supply); assert(!successful(candidate.withoutApproval));
  candidate.failedFrames = flat(candidate.withoutApproval).filter(({ frame }) => !successful(frame)).map(({ frame, path }) => ({ path, type: frame.type, from: frame.from, to: frame.to, input: frame.input, error: frame.error ?? null, revertReason: frame.revertReason ?? null, output: frame.output ?? null }));
  ledger.stage = 'actual_approval_execution';
  candidate.approvalTrace = await rpc('approve_trace', 'debug_traceCall', [plan.approval, block.hash, tracer]);
  checkRoot(candidate.approvalTrace, plan.approval); assert(successful(candidate.approvalTrace)); noTransientCode(candidate.approvalTrace); assert.equal(BigInt(candidate.approvalTrace.output), 1n);
  const approvalTopic = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const approvalEvents = flat(candidate.approvalTrace).flatMap(({ frame }) => frame.logs ?? []).filter(log => log.address.toLowerCase() === plan.usdc && log.topics[0] === approvalTopic);
  assert.equal(approvalEvents.length, 1); assert.deepEqual(approvalEvents[0].topics.slice(1), ['0x' + addressWord(plan.sender), '0x' + addressWord(plan.pool)]); assert.equal(BigInt(approvalEvents[0].data).toString(), plan.amountRaw);
  candidate.approvalDiffRaw = await rpc('approve_pre_post_diff', 'debug_traceCall', [plan.approval, block.hash, diffTracer]);
  const normalized = normalizeProviderStateDiff(candidate.approvalDiffRaw), diff = normalized.diff;
  candidate.codeHashChecks = normalized.codeHashChecks;
  assert.equal(BigInt(diff.pre[plan.sender].nonce), BigInt(candidate.nonceBefore)); assert.equal(BigInt(diff.post[plan.sender].nonce), BigInt(candidate.nonceBefore) + 1n);
  let changedSlots = 0;
  for (const account of new Set([...Object.keys(diff.pre), ...Object.keys(diff.post)])) {
    const before = diff.pre[account], after = diff.post[account]; assert(before && after);
    if (account !== plan.sender) assert.equal(after.nonce ?? before.nonce, before.nonce);
    assert.equal(after.balance ?? before.balance, before.balance);
    if (after.code !== undefined) assert.equal(after.code, before.code);
    for (const slot of new Set([...Object.keys(before.storage ?? {}), ...Object.keys(after.storage ?? {})])) {
      const b = before.storage?.[slot] ?? '0x' + word(0), a = after.storage?.[slot] ?? '0x' + word(0);
      if (b !== a) { assert.equal(account, plan.usdc); assert.equal(BigInt(b), 0n); assert.equal(BigInt(a).toString(), plan.amountRaw); changedSlots++; }
    }
  }
  assert.equal(changedSlots, 1);
  const overrides = buildStateOverrides(diff); candidate.completeApprovalOverrides = overrides; candidate.completeApprovalOverridesSha256 = sha(JSON.stringify(overrides));
  assert.equal(BigInt(overrides[plan.sender].nonce), BigInt(candidate.nonceBefore) + 1n);
  assert(Object.values(overrides).every(value => !Object.hasOwn(value, 'balance') && !Object.hasOwn(value, 'code')));
  ledger.stage = 'allowance_after_actual_approval';
  candidate.allowanceAfterTrace = await rpc('allowance_after_approval_trace', 'debug_traceCall', [allowanceQuery, block.hash, { ...tracer, stateOverrides: overrides }]);
  assert(successful(candidate.allowanceAfterTrace)); assert.equal(candidate.allowanceAfterTrace.to, plan.usdc); assert.equal(candidate.allowanceAfterTrace.input, allowanceQuery.data);
  assert.match(candidate.allowanceAfterTrace.output, /^0x[0-9a-f]{64}$/); assert.equal(BigInt(candidate.allowanceAfterTrace.output).toString(), plan.amountRaw);
  candidate.allowanceQueryDiffRaw = await rpc('allowance_after_approval_diff', 'debug_traceCall', [allowanceQuery, block.hash, { ...diffTracer, stateOverrides: overrides }]);
  const queryDiff = normalizeProviderStateDiff(candidate.allowanceQueryDiffRaw).diff;
  assert.deepEqual(Object.keys(queryDiff.pre), [plan.sender]); assert.deepEqual(Object.keys(queryDiff.post), [plan.sender]);
  assert.deepEqual(Object.keys(queryDiff.pre[plan.sender]), ['nonce']); assert.deepEqual(Object.keys(queryDiff.post[plan.sender]), ['nonce']);
  assert.equal(BigInt(queryDiff.pre[plan.sender].nonce), BigInt(candidate.nonceBefore) + 1n); assert.equal(BigInt(queryDiff.post[plan.sender].nonce), BigInt(candidate.nonceBefore) + 2n);
  ledger.stage = 'deposit_after_actual_approval';
  candidate.afterApproval = await rpc('supply_after_approval', 'debug_traceCall', [plan.supply, block.hash, { ...tracer, stateOverrides: overrides }]);
  checkRoot(candidate.afterApproval, plan.supply); assert(successful(candidate.afterApproval)); noTransientCode(candidate.afterApproval);
  candidate.afterApprovalDiffRaw = await rpc('supply_after_approval_diff', 'debug_traceCall', [plan.supply, block.hash, { ...diffTracer, stateOverrides: overrides }]);
  const deposited = normalizeProviderStateDiff(candidate.afterApprovalDiffRaw).diff;
  assert.equal(BigInt(deposited.pre[plan.sender].nonce), BigInt(candidate.nonceBefore) + 1n); assert.equal(BigInt(deposited.post[plan.sender].nonce), BigInt(candidate.nonceBefore) + 2n);
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  candidate.committedTransferEvents = flat(candidate.afterApproval).flatMap(({ frame }) => frame.logs ?? []).filter(log => log.topics[0] === transferTopic);
  const cash = candidate.committedTransferEvents.filter(log => log.address.toLowerCase() === plan.usdc && log.topics[1] === '0x' + addressWord(plan.sender));
  assert.equal(cash.length, 1); assert.equal(BigInt(cash[0].data).toString(), plan.amountRaw); assert.equal(cash[0].topics[2], '0x' + addressWord(plan.aToken));
  ledger.stage = 'canonical_recheck';
  candidate.finalHeader = await rpc('final_full_header', 'eth_getBlockByNumber', [block.number, false]); assert.deepEqual(candidate.finalHeader, block);
  candidate.status = 'usable_synthetic_sequence'; ledger.status = 'fixture_found';
} catch { ledger.status = 'incomplete_or_failed_fixed_candidate'; ledger.candidate.status = 'failed_at_' + ledger.stage; }
ledger.completedAt = new Date().toISOString(); ledger.durationMs = performance.now() - started; ledger.retries = 0;
await fs.writeFile(new URL('capture.json', DIR), JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o444 }); await checkpoint();
console.log(JSON.stringify({ status: ledger.status, stage: ledger.stage, requests: ledger.requests.length, observedBytes: ledger.observedBytes, candidateStatus: ledger.candidate.status, planSha256: ledger.planSha256 }, null, 2));
