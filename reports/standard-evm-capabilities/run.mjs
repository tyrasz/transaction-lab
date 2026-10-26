import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const ZERO = '0x' + '00'.repeat(20), WITNESS = '0x000000000000000000000000000000000000feed';
const LIMITS = Object.freeze({ rpc: 48, responseBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, requestMs: 25000, wallMs: 600000 });
const CHAINS = [
  { chainId: 1, name: 'ethereum', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', providers: [
    { id: 'ethereum-publicnode', url: 'https://ethereum-rpc.publicnode.com' }, { id: 'ethereum-drpc', url: 'https://eth.drpc.org' },
  ] },
  { chainId: 8453, name: 'base', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', providers: [
    { id: 'base-official', url: 'https://mainnet.base.org' }, { id: 'base-publicnode', url: 'https://base-rpc.publicnode.com' },
  ] },
];
const SOURCES = [
  { url: 'https://ethereum.publicnode.com/', purpose: 'Provider-published Ethereum public endpoint.' },
  { url: 'https://drpc.org/docs/ethereum-api', purpose: 'Provider-published Ethereum public endpoint.' },
  { url: 'https://docs.base.org/get-started/connect-to-base', purpose: 'Base-published mainnet endpoint and chain ID.' },
  { url: 'https://base.publicnode.com/', purpose: 'Provider-published Base public endpoint.' },
  { url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses', purpose: 'Circle-issued Ethereum and Base USDC addresses.' },
  { url: 'https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects', purpose: 'Read-only call and ephemeral code/stateDiff override semantics.' },
  { url: 'https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug', purpose: 'debug_traceCall callTracer/prestateTracer and stateOverrides.' },
  { url: 'https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth', purpose: 'eth_simulateV1; numeric parent block creates a subsequent synthetic block.' },
];
const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'web3_clientVersion', 'eth_call', 'debug_traceCall', 'eth_simulateV1', 'trace_call']);
const mode = process.argv[2];
if (!['--check', '--run'].includes(mode) || process.argv.length !== 3) throw new Error('Use --check or --run. No network on --check.');
const manifest = { schemaVersion: '1.0', createdAt: new Date().toISOString(), limits: LIMITS, chains: CHAINS, sources: SOURCES,
  sourceSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  scope: 'Read-only capability survey, not a deposit simulation or assurance of exact current/historical execution.',
  discipline: 'At most12 calls per provider,48 total; no retries, endpoint replacement, fallback block or hidden method fallback. The first endpoint per chain selects one finalized header; the second must bind that same hash. Failed prerequisites skip dependent probes.',
  witness: 'Separate synthetic code+stateDiff override at0x000000000000000000000000000000000000feed returns uint25642. It never changes token balances, allowances, or deposit inputs; it only tests whether ephemeral override parameters are applied.',
  probes: ['chain', 'fixed-header', 'client-version', 'usdc-balance-hash-call', 'code-stateDiff-hash-call-witness', 'usdc-hash-callTracer', 'usdc-hash-full-prestateTracer', 'usdc-hash-diff-prestateTracer', 'hash-overridden-callTracer-witness', 'usdc-eth_simulateV1-next-block', 'usdc-trace_call-numeric', 'canonical-header-recheck'] };
if (mode === '--check') { process.stdout.write(JSON.stringify({ status: 'ready', providers: CHAINS.flatMap(c => c.providers).length, maxRpc: LIMITS.rpc, sourceSha256: manifest.sourceSha256 }) + '\n'); process.exit(0); }
await writeFile(directory + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
const started = performance.now(), records = [], providers = [], chainBindings = [], overall = { rpc: 0, responseBytes: 0 };
function remaining() { return LIMITS.wallMs - (performance.now() - started); }
function safeError(error) { return { name: typeof error?.name === 'string' && ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error.name) ? error.name : 'Error', code: ['RPC_CAP', 'BYTE_CAP', 'WALL_CAP', 'RESPONSE_CAP', 'INVALID_UTF8', 'INVALID_JSON', 'INVALID_ENVELOPE'].includes(error?.code) ? error.code : 'TRANSPORT_UNAVAILABLE', message: 'The bounded public request did not complete; local exception text is withheld.' }; }
async function rpc(provider, label, method, params) {
  if (!methods.has(method)) throw new Error('Method outside read-only survey.');
  if (overall.rpc >= LIMITS.rpc || overall.responseBytes >= LIMITS.totalBytes || remaining() <= 0) return null;
  const request = { jsonrpc: '2.0', id: ++overall.rpc, method, params }, requestText = JSON.stringify(request), begin = performance.now();
  const record = { provider: provider.id, endpoint: provider.url, label, startedAt: new Date().toISOString(), request, requestText, requestSha256: sha(requestText), responseBytes: 0, bodyComplete: false };
  records.push(record);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(LIMITS.requestMs, remaining()));
  const chunks = [], hash = createHash('sha256'); let reader;
  try {
    const response = await fetch(provider.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: requestText, signal: controller.signal });
    record.http = { status: response.status, headers: Object.fromEntries(response.headers) };
    if (!response.body) throw Object.assign(new Error(), { code: 'INVALID_ENVELOPE' });
    reader = response.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (performance.now() - begin >= LIMITS.requestMs || remaining() <= 0) throw Object.assign(new Error(), { code: 'WALL_CAP' });
      if (next.done) { record.bodyComplete = true; break; }
      const bytes = Buffer.from(next.value); record.responseBytes += bytes.length; overall.responseBytes += bytes.length; hash.update(bytes);
      if (record.responseBytes > LIMITS.responseBytes || overall.responseBytes > LIMITS.totalBytes) throw Object.assign(new Error(), { code: 'RESPONSE_CAP' });
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks); record.responseBase64 = body.toString('base64');
    try { record.responseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { throw Object.assign(new Error(), { code: 'INVALID_UTF8' }); }
    try { record.response = JSON.parse(record.responseText); } catch { throw Object.assign(new Error(), { code: 'INVALID_JSON' }); }
    if (record.response?.jsonrpc !== '2.0' || record.response?.id !== request.id || !Object.hasOwn(record.response, 'result') && !Object.hasOwn(record.response, 'error')) throw Object.assign(new Error(), { code: 'INVALID_ENVELOPE' });
    record.rpcOutcome = Object.hasOwn(record.response, 'error') ? 'error' : response.ok ? 'result' : 'http_error';
  } catch (error) { record.transportError = safeError(error); }
  finally {
    clearTimeout(timer); controller.abort(); try { await reader?.cancel(); } catch {}
    record.responseSha256 = hash.digest('hex'); record.completedAt = new Date().toISOString(); record.elapsedMs = Math.round((performance.now() - begin) * 1000) / 1000;
    await writeFile(directory + `response-${String(request.id).padStart(2, '0')}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    process.stdout.write(JSON.stringify({ id: request.id, provider: provider.id, label, outcome: record.rpcOutcome ?? 'transport_error', bytes: record.responseBytes }) + '\n');
  }
  return record;
}
const getResult = record => record?.rpcOutcome === 'result' ? record.response.result : undefined;
function validHeader(header) { return header && typeof header.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(header.hash) && typeof header.number === 'string' && /^0x[0-9a-f]+$/i.test(header.number) && typeof header.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(header.timestamp); }
for (const chain of CHAINS) {
  let fixedHeader = null;
  for (const [index, provider] of chain.providers.entries()) {
    const summary = { id: provider.id, chainId: chain.chainId, results: {}, notAttempted: [] }; providers.push(summary);
    const chainResponse = await rpc(provider, 'chain', 'eth_chainId', []);
    if (getResult(chainResponse) !== '0x' + chain.chainId.toString(16)) { summary.skipped = 'chain_identity_unavailable_or_mismatched'; continue; }
    if (index > 0 && !fixedHeader) { summary.skipped = 'first_provider_finalized_binding_unavailable_no_substitution'; continue; }
    const headerResponse = await rpc(provider, 'fixed-header', index === 0 ? 'eth_getBlockByNumber' : 'eth_getBlockByHash', [index === 0 ? 'finalized' : fixedHeader.hash, false]);
    const header = getResult(headerResponse);
    if (!validHeader(header) || index > 0 && (!fixedHeader || header.hash !== fixedHeader.hash || header.number !== fixedHeader.number || header.timestamp !== fixedHeader.timestamp)) { summary.skipped = 'selected_finalized_header_unavailable_or_mismatched'; continue; }
    if (index === 0) { fixedHeader = header; chainBindings.push({ chain: chain.name, chainId: chain.chainId, provider: provider.id, finalizedHeader: header, responseId: headerResponse.request.id }); }
    const pin = { blockHash: fixedHeader.hash, requireCanonical: true };
    summary.blockHash = header.hash; summary.blockNumber = BigInt(header.number).toString();
    const call = { from: ZERO, to: chain.token, data: '0x70a08231' + '0'.repeat(64), value: '0x0', gas: '0x493e0' };
    const witnessCall = { ...call, to: WITNESS, data: '0x' }, overrides = { [WITNESS]: { code: '0x60005460005260206000f3', stateDiff: { [word(0)]: word(42) } } };
    const tracer = { tracer: 'callTracer', timeout: '15s', tracerConfig: { withLog: true } };
    const probes = [
      ['client-version', 'web3_clientVersion', []],
      ['usdc-balance-hash-call', 'eth_call', [call, pin]],
      ['code-stateDiff-hash-call-witness', 'eth_call', [witnessCall, pin, overrides]],
      ['usdc-hash-callTracer', 'debug_traceCall', [call, pin, tracer]],
      ['usdc-hash-full-prestateTracer', 'debug_traceCall', [call, pin, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: false, disableCode: false, disableStorage: false, includeEmpty: true } }]],
      ['usdc-hash-diff-prestateTracer', 'debug_traceCall', [call, pin, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]],
      ['hash-overridden-callTracer-witness', 'debug_traceCall', [witnessCall, pin, { ...tracer, stateOverrides: overrides }]],
      ['usdc-eth_simulateV1-next-block', 'eth_simulateV1', [{ blockStateCalls: [{ calls: [call] }], validation: false, traceTransfers: false, returnFullTransactions: false }, fixedHeader.number]],
      ['usdc-trace_call-numeric', 'trace_call', [call, ['trace', 'stateDiff'], fixedHeader.number]],
      ['canonical-header-recheck', 'eth_getBlockByNumber', [fixedHeader.number, false]],
    ];
    for (const [label, method, params] of probes) {
      const record = await rpc(provider, label, method, params);
      if (!record) { summary.notAttempted.push(label); continue; }
      const value = getResult(record); summary.results[label] = { responseId: record.request.id, outcome: record.rpcOutcome ?? 'transport_error', ...(record.response?.error ? { error: record.response.error } : {}), ...(record.transportError ? { transportError: record.transportError } : {}) };
      if (label === 'code-stateDiff-hash-call-witness') summary.results[label].expected42 = value === word(42);
      if (label === 'hash-overridden-callTracer-witness') summary.results[label].expected42 = value?.output === word(42) && !value.error;
      if (label === 'canonical-header-recheck') summary.results[label].sameHash = value?.hash === fixedHeader.hash && value?.number === fixedHeader.number;
    }
  }
}
const capture = { manifest, finishedAt: new Date().toISOString(), accounting: { ...overall, elapsedMs: Math.round(performance.now() - started) }, chainBindings, providers, records };
const bytes = JSON.stringify(capture, null, 2) + '\n';
await writeFile(directory + 'capture.json', bytes, { flag: 'wx', mode: 0o444 });
await writeFile(directory + 'summary.json', JSON.stringify({ captureSha256: sha(bytes), accounting: capture.accounting, providers }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
process.stdout.write(JSON.stringify({ finished: true, sha256: sha(bytes), ...capture.accounting }) + '\n');
