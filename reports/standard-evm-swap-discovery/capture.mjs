// Bounded development-case discovery. Never signs, broadcasts or funds an account.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { keccak_256 } from '../../engines/standard-evm/node_modules/@noble/hashes/sha3.js';
const DIR = new URL('./', import.meta.url), sha = b => createHash('sha256').update(b).digest('hex');
const plan = JSON.parse(await fs.readFile(new URL('plan.json', DIR)));
assert.equal(plan.scriptSha256, sha(await fs.readFile(import.meta.url.startsWith('file:') ? new URL(import.meta.url) : import.meta.url)));
const selector = text => Buffer.from(keccak_256(Buffer.from(text))).toString('hex').slice(0, 8);
const topic = text => '0x' + Buffer.from(keccak_256(Buffer.from(text))).toString('hex');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984', POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const word = x => x.replace(/^0x/, '').padStart(64, '0'), hex = n => '0x' + BigInt(n).toString(16), lower = x => x.toLowerCase();
const TRANSFER = topic('Transfer(address,address,uint256)'), SWAP = topic('Swap(address,address,int256,int256,uint160,uint128,int24)');
const tracer = { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } };
const ledger = { startedAt: new Date().toISOString(), endpoint: plan.endpoint, planSha256: sha(await fs.readFile(new URL('plan.json', DIR))), requests: [], observedBytes: 0, retainedBytes: 0, candidates: [], selected: null };
const started = performance.now();
await fs.mkdir(new URL('raw/', DIR), { recursive: true });
await fs.writeFile(new URL('STARTED', DIR), ledger.startedAt + '\n', { flag: 'wx' });
async function checkpoint() { await fs.writeFile(new URL('progress.json', DIR), JSON.stringify(ledger, null, 2) + '\n'); }
async function rpc(method, params) {
  assert.ok(plan.methods.includes(method), 'Unplanned RPC method.');
  if (ledger.requests.length >= plan.limits.requests || ledger.observedBytes >= plan.limits.totalBytes || performance.now() - started >= plan.limits.wallMs) throw new Error('Discovery budget exhausted.');
  const id = ledger.requests.length + 1, name = String(id).padStart(3, '0'), request = { jsonrpc: '2.0', id, method, params };
  const requestText = JSON.stringify(request), record = { id, request, requestText, requestSha256: sha(requestText), startedAt: new Date().toISOString() };
  ledger.requests.push(record); await checkpoint();
  const controller = new AbortController(), began = performance.now();
  const timeoutMs = Math.min(plan.limits.requestMs, plan.limits.wallMs - (began - started));
  let timer, reader, complete = false, status, bytes = 0, kept = 0;
  const chunks = [], digest = createHash('sha256');
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out.')); }, timeoutMs); });
  const check = () => { if (performance.now() - began >= timeoutMs || performance.now() - started >= plan.limits.wallMs) throw new Error('Request timed out.'); };
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
      if (prefix.length !== data.length) throw new Error('Response byte budget exhausted.');
    }
    const body = Buffer.concat(chunks), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), parsed = JSON.parse(text);
    record.response = parsed; check();
    assert.equal(response.ok, true); assert.equal(parsed.jsonrpc, '2.0'); assert.equal(parsed.id, id);
    assert.notEqual(Object.hasOwn(parsed, 'error'), Object.hasOwn(parsed, 'result'));
    if (Object.hasOwn(parsed, 'error')) { record.status = 'rpc_error'; return null; }
    result = parsed.result; record.status = 'success';
  } catch { record.status = 'transport_validation_or_budget_failure'; }
  finally {
    clearTimeout(timer); if (!complete) { controller.abort(); try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }
    const body = Buffer.concat(chunks);
    Object.assign(record, { httpStatus: status ?? null, completedAt: new Date().toISOString(), durationMs: performance.now() - began,
      raw: { file: 'raw/' + name + '.body', complete, observedBytes: bytes, bytes: kept, observedPrefixSha256: digest.digest('hex'), sha256: sha(body) } });
    await fs.writeFile(new URL(record.raw.file, DIR), body, { flag: 'wx' });
    await fs.writeFile(new URL('raw/' + name + '.json', DIR), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await checkpoint();
  }
  return result ?? null;
}
function transfer(log) {
  if (log.topics?.length !== 3 || lower(log.topics[0]) !== TRANSFER || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  return { token: lower(log.address), from: '0x' + log.topics[1].slice(-40).toLowerCase(), to: '0x' + log.topics[2].slice(-40).toLowerCase(), amountRaw: BigInt(log.data).toString() };
}
function traceTransfers(frame, failed = false, output = []) {
  const reverted = failed || Boolean(frame.error || frame.revertReason);
  if (!reverted) for (const log of frame.logs ?? []) { const value = transfer(log); if (value) output.push(value); }
  for (const child of frame.calls ?? []) traceTransfers(child, reverted, output);
  return output;
}
function qualifying(transfers, sender) { return transfers.some(x => x.token === USDC && x.from === sender && BigInt(x.amountRaw) > 0n) && transfers.some(x => x.token === WETH && x.to === sender && BigInt(x.amountRaw) > 0n); }
try {
  assert.equal(await rpc('eth_chainId', []), '0x1');
  const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]); assert.ok(finalized?.hash); ledger.finalized = finalized;
  const from = BigInt(finalized.number) - 19n;
  const pool = await rpc('eth_call', [{ to: FACTORY, data: '0x' + selector('getPool(address,address,uint24)') + word(USDC) + word(WETH) + word('0x1f4') }, { blockHash: finalized.hash, requireCanonical: true }]);
  assert.equal(pool, '0x' + word(POOL));
  const logs = await rpc('eth_getLogs', [{ address: POOL, fromBlock: hex(from), toBlock: finalized.number, topics: [SWAP] }]); assert.ok(Array.isArray(logs));
  ledger.window = { fromBlock: hex(from), toBlock: finalized.number, logCount: logs.length, factoryPoolVerified: true };
  const eligible = logs.filter(log => log.removed === false && log.topics?.length === 3 && /^0x[0-9a-fA-F]{320}$/.test(log.data) && BigInt('0x' + log.data.slice(2, 66)) < 2n ** 255n);
  eligible.sort((a, b) => {
    const score = x => lower(x.topics[1]) === lower(x.topics[2]) ? 1 : 0;
    return score(a) - score(b) || Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || Number(BigInt(b.transactionIndex) - BigInt(a.transactionIndex));
  });
  const hashes = [...new Set(eligible.map(log => log.transactionHash))].slice(0, plan.limits.candidates);
  ledger.candidateOrder = hashes;
  for (const hash of hashes) {
    const candidate = { hash, status: 'started', requestIds: [] }, first = ledger.requests.length + 1; ledger.candidates.push(candidate);
    try {
      const tx = await rpc('eth_getTransactionByHash', [hash]); assert.ok(tx && lower(tx.hash) === lower(hash)); candidate.transaction = tx;
      if (BigInt(tx.value) !== 0n || !tx.to) { candidate.status = 'rejected_nonzero_value_or_creation'; continue; }
      const receipt = await rpc('eth_getTransactionReceipt', [hash]); candidate.receipt = receipt;
      assert.ok(receipt && lower(receipt.transactionHash) === lower(hash) && receipt.blockHash === tx.blockHash && receipt.transactionIndex === tx.transactionIndex && receipt.status === '0x1');
      candidate.receiptTransfers = receipt.logs.map(transfer).filter(Boolean);
      if (!qualifying(candidate.receiptTransfers, lower(tx.from))) { candidate.status = 'rejected_not_sender_USDC_to_WETH'; continue; }
      const block = await rpc('eth_getBlockByHash', [tx.blockHash, false]); candidate.block = block;
      assert.ok(block && block.hash === tx.blockHash && block.number === tx.blockNumber && block.transactions[Number(BigInt(tx.transactionIndex))] === tx.hash);
      const parent = await rpc('eth_getBlockByHash', [block.parentHash, false]); candidate.parent = parent;
      assert.ok(parent && parent.hash === block.parentHash && BigInt(parent.number) + 1n === BigInt(block.number));
      const pinned = { blockHash: parent.hash, requireCanonical: true };
      candidate.senderCode = await rpc('eth_getCode', [tx.from, pinned]);
      if (candidate.senderCode !== '0x') { candidate.status = 'rejected_sender_has_code_or_code_unavailable'; continue; }
      candidate.originalTrace = await rpc('debug_traceTransaction', [hash, tracer]);
      assert.ok(candidate.originalTrace && !candidate.originalTrace.error && lower(candidate.originalTrace.from) === lower(tx.from) && lower(candidate.originalTrace.to) === lower(tx.to) && candidate.originalTrace.input === tx.input);
      const request = { from: lower(tx.from), to: lower(tx.to), data: lower(tx.input), value: '0x0', gas: '0x4c4b40' };
      candidate.parentRequest = request; candidate.parentTrace = await rpc('debug_traceCall', [request, parent.hash, tracer]);
      if (!candidate.parentTrace) { candidate.status = 'parent_simulation_unavailable'; continue; }
      const trace = candidate.parentTrace;
      assert.equal(lower(trace.from), request.from); assert.equal(lower(trace.to), request.to); assert.equal(trace.input, request.data); assert.equal(BigInt(trace.value ?? '0x0'), 0n);
      candidate.parentTransfers = traceTransfers(trace);
      candidate.status = trace.error || trace.revertReason ? 'parent_simulation_reverted' : qualifying(candidate.parentTransfers, request.from) ? 'selected' : 'parent_success_without_requested_token_directions';
      if (candidate.status === 'selected') {
        ledger.selected = { hash, request, parentHash: parent.hash, parentNumber: parent.number, sourceBlockHash: block.hash, sourceBlockNumber: block.number, sourceTransactionIndex: tx.transactionIndex };
        candidate.parentDiff = await rpc('debug_traceCall', [request, parent.hash, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
        candidate.tokenMetadata = [];
        for (const token of [USDC, WETH]) for (const signature of ['decimals()', 'symbol()']) candidate.tokenMetadata.push({ token, signature, result: await rpc('eth_call', [{ to: token, data: '0x' + selector(signature) }, pinned]) });
        candidate.finalSourceBlock = await rpc('eth_getBlockByNumber', [block.number, false]); candidate.finalParentBlock = await rpc('eth_getBlockByNumber', [parent.number, false]);
        candidate.canonicalRecheck = candidate.finalSourceBlock?.hash === block.hash && candidate.finalParentBlock?.hash === parent.hash;
        break;
      }
    } catch { candidate.status = 'candidate_validation_or_budget_failure'; }
    finally { candidate.requestIds = Array.from({ length: ledger.requests.length - first + 1 }, (_, i) => first + i); await checkpoint(); }
  }
  ledger.status = ledger.selected ? 'candidate_found' : 'no_candidate_found_within_frozen_bounds';
} catch { ledger.status = 'discovery_validation_or_budget_failure'; }
ledger.completedAt = new Date().toISOString(); ledger.durationMs = performance.now() - started;
await fs.writeFile(new URL('capture.json', DIR), JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
await checkpoint();
console.log(JSON.stringify({ status: ledger.status, requests: ledger.requests.length, observedBytes: ledger.observedBytes, candidates: ledger.candidates.map(x => ({ hash: x.hash, status: x.status })), selected: ledger.selected }, null, 2));
