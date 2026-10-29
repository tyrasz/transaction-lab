import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function save(name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : json(value));
  const fd = fs.openSync(path.join(ROOT, name), 'wx', 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { path: name, bytes: bytes.length, sha256: sha(bytes) };
}
const ZERO = '0x' + '00'.repeat(20);
const CALL = { from: ZERO, to: ZERO, data: '0x', value: '0x0', gas: '0x186a0', gasPrice: '0x0' };
const LIMITS = { requests: 6, responseBytes: 1048576, requestMs: 25000, overallMs: 120000 };
const SEQUENCE = [
  { id: 1, method: 'eth_chainId', params: [] },
  { id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
  { id: 3, method: 'eth_call', params: [CALL, '$selected.number'] },
  { id: 4, method: 'eth_createAccessList', params: [CALL, '$selected.number'] },
  { id: 5, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [CALL] }], validation: false, traceTransfers: true, returnFullTransactions: false }, '$selected.number'] },
  { id: 6, method: 'eth_getBlockByNumber', params: ['$selected.number', false] },
];
const SCOPE = {
  purpose: 'One provider capability observation, not deposit interpretation or accuracy evidence.',
  requests: 'Six sequential JSON-RPC POSTs maximum, one endpoint, no retries or substitutions.',
  noOp: 'Empty calldata and zero value to the zero address; address code and account state are not independently proven. A successful empty return alone does not prove absence of code.',
  blockBinding: 'All three capability calls use the single observed latest block NUMBER. The final reread checks its hash. This is provider-reported number binding, not a block-hash state selector, proof, finality or consensus verification.',
  simulation: 'eth_simulateV1 normally constructs synthetic successor block context from the selected base; it is not claimed equal to eth_call execution in that selected block.',
  capture: 'Exact sent JSON request bytes and HTTP entity response bytes after native fetch content decoding; not TLS or compressed transport bytes.',
  dependencies: 'Native Node.js only. No viem invocation, asset tracing workflow, contract discovery, CCTP/deposit transaction, funds, signing, broadcast, paid endpoint or credentials.',
  failures: 'Every attempted response/error is retained. Failed chain/header preparation skips dependent calls; method-specific failures do not trigger retries. A timing/byte bound can skip remaining fixed slots.',
};

if (process.argv[2] === 'declare') {
  const plan = { schemaVersion: 1, declaredAt: new Date().toISOString(), endpoint: 'https://arb1.arbitrum.io/rpc', expectedChainId: '0xa4b1',
    source: { runSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), documentationSha256: sha(fs.readFileSync(path.join(ROOT, 'documentation.json'))) },
    runtime: { node: process.version, execPath: process.execPath }, limits: LIMITS, sequence: SEQUENCE, scope: SCOPE };
  const entry = save('plan.json', plan); console.log(json(entry));
} else if (process.argv[2] === 'run') {
  const planBytes = fs.readFileSync(path.join(ROOT, 'plan.json'));
  if (sha(planBytes) !== process.argv[3]) throw new Error('Explicit plan hash mismatch.');
  const plan = JSON.parse(planBytes);
  if (plan.source.runSha256 !== sha(fs.readFileSync(fileURLToPath(import.meta.url))) || plan.source.documentationSha256 !== sha(fs.readFileSync(path.join(ROOT, 'documentation.json')))) throw new Error('Declared source changed.');
  if (JSON.stringify(plan.sequence) !== JSON.stringify(SEQUENCE) || JSON.stringify(plan.limits) !== JSON.stringify(LIMITS) || plan.endpoint !== 'https://arb1.arbitrum.io/rpc' || plan.expectedChainId !== '0xa4b1' || plan.runtime.node !== process.version) throw new Error('Declared runtime or policy mismatch.');
  const startWall = Date.now(), startMono = performance.now();
  save('STARTED.json', { schemaVersion: 1, planSha256: sha(planBytes), startedAt: new Date(startWall).toISOString(), pid: process.pid, node: process.version });
  const elapsed = () => Math.max(Date.now() - startWall, performance.now() - startMono);
  const rows = []; let selected = null, chainVerified = false, fatal = null;
  async function request(item, params) {
    const prefix = String(item.id).padStart(3, '0');
    const body = JSON.stringify({ jsonrpc: '2.0', id: item.id, method: item.method, params });
    const requestFile = save(prefix + '-request.json', body);
    const row = { id: item.id, method: item.method, status: 'unavailable', request: requestFile, startedAt: new Date().toISOString(), httpStatus: null,
      response: null, observedResponseBytes: 0, responseComplete: false, rpcResult: null, rpcError: null, error: null };
    const controller = new AbortController(), now = performance.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(LIMITS.requestMs, LIMITS.overallMs - elapsed())));
    const chunks = []; let retained = 0, reader;
    try {
      const response = await fetch(plan.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body,
        redirect: 'error', signal: controller.signal });
      row.httpStatus = response.status; row.headers = Object.fromEntries(['content-type', 'content-length', 'content-encoding', 'date'].map(k => [k, response.headers.get(k)]));
      if (!response.body) throw new Error('Missing response body.');
      reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) { row.responseComplete = true; break; }
        row.observedResponseBytes += part.value.byteLength;
        const available = LIMITS.responseBytes - retained;
        if (available > 0) { const data = Buffer.from(part.value.subarray(0, available)); chunks.push(data); retained += data.length; }
        if (row.observedResponseBytes > LIMITS.responseBytes) { controller.abort(); throw new Error('Response byte limit exceeded; only bounded prefix retained.'); }
      }
      if (controller.signal.aborted || performance.now() - now > LIMITS.requestMs || elapsed() > LIMITS.overallMs || Date.now() < startWall) throw new Error('Request or global timing bound exceeded.');
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const parsed = JSON.parse(decoded);
      if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== item.id || Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')) throw new Error('Malformed JSON-RPC envelope.');
      if (Object.hasOwn(parsed, 'error')) { row.status = 'rpc_error'; row.rpcError = parsed.error; }
      else { row.status = response.ok ? 'rpc_result' : 'http_error'; row.rpcResult = parsed.result; }
      if (!response.ok) row.status = 'http_error';
    } catch (error) {
      row.error = { name: error?.name ?? 'Error', message: error?.message ?? 'Unknown failure' };
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { try { await reader.cancel(); } catch {} }
      row.durationMs = performance.now() - now; row.finishedAt = new Date().toISOString();
      row.response = save(prefix + '-response.body', Buffer.concat(chunks));
      save(prefix + '-exchange.json', row);
    }
    return row;
  }
  try {
    for (const item of SEQUENCE) {
      let skip = elapsed() >= LIMITS.overallMs || Date.now() < startWall ? 'overall_timing_bound' : null;
      if (item.id > 1 && !chainVerified) skip ??= 'chain_identity_unavailable';
      if (item.id > 2 && !selected) skip ??= 'selected_header_unavailable';
      if (skip) { rows.push({ id: item.id, method: item.method, status: 'not_attempted', reason: skip }); continue; }
      const params = item.params.map(p => p === '$selected.number' ? selected.number : p);
      const row = await request(item, params); rows.push(row);
      if (item.id === 1) chainVerified = row.status === 'rpc_result' && row.rpcResult === plan.expectedChainId;
      if (item.id === 2 && row.status === 'rpc_result') {
        const h = row.rpcResult;
        if (h && typeof h.number === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h.number) && typeof h.hash === 'string' && /^0x[0-9a-f]{64}$/.test(h.hash)) {
          selected = { number: h.number, hash: h.hash }; save('selected-header.json', h);
        }
      }
    }
  } catch (error) { fatal = { name: error?.name ?? 'Error', message: error?.message ?? 'Unknown failure' }; }
  for (const item of SEQUENCE) if (!rows.some(row => row.id === item.id)) rows.push({ id: item.id, method: item.method, status: 'not_attempted', reason: 'capture_failed' });
  const after = rows.find(row => row.id === 6), wallMs = Date.now() - startWall, monotonicMs = performance.now() - startMono;
  const results = { schemaVersion: 1, status: fatal ? 'capture_failed' : 'captured', planSha256: sha(planBytes), startedAt: new Date(startWall).toISOString(), finishedAt: new Date().toISOString(),
    timing: { wallMs, monotonicMs, withinBounds: wallMs >= 0 && wallMs <= LIMITS.overallMs && monotonicMs <= LIMITS.overallMs },
    calls: rows.filter(row => row.request).length, responseBytes: rows.reduce((n, row) => n + (row.response?.bytes ?? 0), 0), chainVerified, selected,
    selectedNumberHashReconfirmed: Boolean(selected && after?.status === 'rpc_result' && after.rpcResult?.number === selected.number && after.rpcResult?.hash === selected.hash),
    sourceUnchanged: plan.source.runSha256 === sha(fs.readFileSync(fileURLToPath(import.meta.url))) && plan.source.documentationSha256 === sha(fs.readFileSync(path.join(ROOT, 'documentation.json'))),
    rows, fatal, scope: SCOPE };
  save('results.json', results);
  const files = fs.readdirSync(ROOT).filter(name => fs.statSync(path.join(ROOT, name)).isFile()).sort().map(name => {
    const bytes = fs.readFileSync(path.join(ROOT, name)); return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  });
  const manifest = save('evidence-manifest.json', { schemaVersion: 1, planSha256: sha(planBytes), files });
  console.log(json({ manifest, calls: results.calls, responseBytes: results.responseBytes, selected, chainVerified, selectedNumberHashReconfirmed: results.selectedNumberHashReconfirmed, timing: results.timing,
    outcomes: rows.map(row => ({ id: row.id, method: row.method, status: row.status, rpcError: row.rpcError, error: row.error })), fatal }));
} else throw new Error('Use declare, then run with exact declared plan SHA-256.');
