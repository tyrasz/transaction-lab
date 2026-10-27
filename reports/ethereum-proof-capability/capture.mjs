import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

const ROOT = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ABSENCE_SEED = 'transaction-lab/eip1186-capability/v1/absent-account';
const ABSENCE = '0x' + sha(ABSENCE_SEED).slice(-40);
const SLOT = '0x' + '0'.repeat(64);
const PROVIDERS = [{ id: 'ethereum-drpc', url: 'https://eth.drpc.org' }, { id: 'ethereum-publicnode', url: 'https://ethereum-rpc.publicnode.com' }];
const LIMITS = { maxDispatches: 12, maxResponseBytes: 8 * 1024 * 1024, maxObservedResponseBytes: 32 * 1024 * 1024, maxRequestMs: 25000, maxSequenceMs: 360000 };
const ROLES = ['chain', 'header', 'usdc-proof', 'usdc-code', 'absence-candidate-proof', 'canonical-header'];
const word = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const validHeader = value => value && typeof value === 'object' && !Array.isArray(value) && word(value.hash) && word(value.stateRoot) && typeof value.number === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.number);
const saveJson = async (path, value, flag = 'wx') => writeFile(join(ROOT, path), JSON.stringify(value, null, 2) + '\n', { flag });

function rolePlan() {
  return PROVIDERS.flatMap((provider, p) => ROLES.map((role, i) => ({ id: p * 6 + i + 1, provider: provider.id, role, method: role === 'chain' ? 'eth_chainId' : role === 'header' ? (p === 0 ? 'eth_getBlockByNumber' : 'eth_getBlockByHash') : role === 'canonical-header' ? 'eth_getBlockByNumber' : role === 'usdc-code' ? 'eth_getCode' : 'eth_getProof', parameterRule: role === 'chain' ? '[]' : role === 'header' ? (p === 0 ? '[finalized,false], select once' : '[A.selected.hash,false]') : role === 'canonical-header' ? '[A.selected.number,false]' : role === 'usdc-code' ? 'USDC at A.selected.hash, requireCanonical:true' : role === 'usdc-proof' ? 'USDC slot0 at A.selected.hash, requireCanonical:true' : 'fixed absence-candidate slot0 at A.selected.hash, requireCanonical:true' })));
}
function paramsFor(role, providerIndex, anchor) {
  if (role === 'chain') return [];
  if (role === 'header') return providerIndex === 0 ? ['finalized', false] : [anchor.hash, false];
  if (role === 'canonical-header') return [anchor.number, false];
  const binding = { blockHash: anchor.hash, requireCanonical: true };
  if (role === 'usdc-code') return [USDC, binding];
  return [role === 'usdc-proof' ? USDC : ABSENCE, [SLOT], binding];
}
async function makePlan() {
  const bytes = await readFile(fileURLToPath(import.meta.url));
  return { schemaVersion: '1.0', purpose: 'Development capability discovery for independent Ethereum account/storage proof inputs; no execution trace inputs, transactions, accuracy score or holdout claim.', providers: PROVIDERS, limits: LIMITS, source: { path: 'capture.mjs', bytes: bytes.length, sha256: sha(bytes) }, targets: { usdc: USDC, storageKeys: [SLOT], absenceCandidate: ABSENCE, absenceSeed: ABSENCE_SEED, absenceDerivation: 'last20bytes_SHA256_UTF8_seed; existence is determined from returned proof, never assumed; no replacement' }, roles: rolePlan(), policy: { retries: 0, redirects: 'error', alternateProviders: false, latestFallback: false, selection: 'First provider selects one finalized header once. Every dependent read on both providers targets that exact hash.', headerMismatch: 'Retain disagreement and continue fixed hash proof probes only if returned header still has the selected hash and stateRoot. Never substitute a different block.', missingDependency: 'Retain planned role as not_attempted with a fixed reason.', wire: 'Exact UTF-8 bytes retained as .body files with SHA-256. Partial/over-limit/error bodies and all observed bytes are accounted for; no complete-body claim on partial captures.', authenticity: 'Provider header agreement is not consensus authentication. Proof verification must independently bind every account/storage leaf and code hash to the recorded stateRoot.' } };
}

async function run(expectedHash) {
  const planBytes = await readFile(join(ROOT, 'plan.json')), plan = JSON.parse(planBytes), planHash = sha(planBytes);
  if (expectedHash !== planHash || !isDeepStrictEqual(plan, await makePlan())) throw new Error('Plan or runner source binding mismatch.');
  await mkdir(join(ROOT, 'raw'), { recursive: true });
  const runtime = { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch };
  await saveJson('STARTED.json', { planSha256: planHash, startedAt: new Date().toISOString(), runtime, source: plan.source, limits: LIMITS });
  const started = performance.now(), records = [], headers = [], chains = [], violations = [];
  let anchor = null, dispatches = 0, observedBytes = 0, stopReason = null;
  for (const declared of plan.roles) {
    const p = Math.floor((declared.id - 1) / 6), provider = PROVIDERS[p];
    const record = { id: declared.id, provider: provider.id, role: declared.role, status: 'not_attempted', request: null, response: null };
    records.push(record);
    if (stopReason) { record.reason = stopReason; continue; }
    if (observedBytes >= LIMITS.maxObservedResponseBytes || dispatches >= LIMITS.maxDispatches) { stopReason = record.reason = 'response_or_dispatch_budget_exhausted'; continue; }
    if (performance.now() - started >= LIMITS.maxSequenceMs) { stopReason = record.reason = 'sequence_deadline'; continue; }
    if (declared.role !== 'chain' && chains[p] !== '0x1') { record.reason = 'ethereum_chain_identity_unavailable'; continue; }
    if (!(p === 0 && declared.role === 'header') && declared.role !== 'chain' && !anchor) { record.reason = 'selected_header_unavailable'; continue; }
    if (['usdc-proof', 'usdc-code', 'absence-candidate-proof'].includes(declared.role) && (!validHeader(headers[p]) || headers[p].hash.toLowerCase() !== anchor.hash.toLowerCase() || headers[p].stateRoot.toLowerCase() !== anchor.stateRoot.toLowerCase())) { record.reason = 'provider_header_binding_unavailable'; continue; }
    const request = { jsonrpc: '2.0', id: declared.id, method: declared.method, params: paramsFor(declared.role, p, anchor) };
    const requestText = JSON.stringify(request), began = performance.now();
    const controller = new AbortController(), timeoutMs = Math.max(1, Math.min(LIMITS.maxRequestMs, LIMITS.maxSequenceMs - (began - started)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const chunks = [], observedHash = createHash('sha256');
    let seen = 0, retained = 0, complete = false, response, failure = null;
    record.request = { url: provider.url, method: 'POST', headers: { 'content-type': 'application/json' }, body: request, bodyText: requestText, bytes: Buffer.byteLength(requestText), sha256: sha(requestText) };
    dispatches++; record.status = 'attempted';
    try {
      response = await fetch(provider.url, { method: 'POST', headers: record.request.headers, body: requestText, redirect: 'error', signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw Object.assign(new Error(), { code: 'EMPTY_BODY_STREAM' });
      for (;;) {
        const next = await reader.read();
        if (next.done) { complete = true; break; }
        const bytes = Buffer.from(next.value), beforeTotal = observedBytes;
        observedHash.update(bytes); seen += bytes.length; observedBytes += bytes.length;
        const keep = Math.max(0, Math.min(bytes.length, LIMITS.maxResponseBytes - retained, LIMITS.maxObservedResponseBytes - beforeTotal));
        if (keep) { chunks.push(bytes.subarray(0, keep)); retained += keep; }
        if (seen > LIMITS.maxResponseBytes || observedBytes > LIMITS.maxObservedResponseBytes) {
          failure = seen > LIMITS.maxResponseBytes ? 'response_byte_limit' : 'total_response_byte_limit';
          stopReason = 'response_budget_exhausted'; violations.push({ id: declared.id, code: failure }); controller.abort(); await reader.cancel().catch(() => {}); break;
        }
      }
    } catch {
      failure ??= controller.signal.aborted ? 'request_or_sequence_deadline' : 'transport_failure';
    } finally { clearTimeout(timer); }
    const body = Buffer.concat(chunks), bodyPath = `raw/${String(declared.id).padStart(3, '0')}.body`;
    await writeFile(join(ROOT, bodyPath), body, { flag: 'wx' });
    let bodyText = null, parsed = null;
    try { bodyText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { failure ??= 'invalid_utf8'; }
    if (complete && retained === seen && bodyText !== null) {
      try { parsed = JSON.parse(bodyText); } catch { failure ??= 'invalid_json'; }
    }
    if (parsed && (parsed.jsonrpc !== '2.0' || parsed.id !== declared.id || (Object.hasOwn(parsed, 'result') === Object.hasOwn(parsed, 'error')))) failure ??= 'jsonrpc_envelope_mismatch';
    if (response && !response.ok) failure ??= 'http_error';
    if (parsed?.error) failure ??= 'rpc_error';
    record.status = failure ? 'failed' : 'completed';
    record.response = { status: response?.status ?? null, headers: response ? Object.fromEntries(response.headers) : null, bodyPath, bodyText, parsed, retainedBytes: body.length, retainedSha256: sha(body), observedBytes: seen, observedSha256: observedHash.digest('hex'), complete: complete && retained === seen, elapsedMs: Math.round(performance.now() - began), error: failure };
    if (!failure) {
      if (declared.role === 'chain') chains[p] = parsed.result;
      if (declared.role === 'header') { headers[p] = parsed.result; if (p === 0 && validHeader(parsed.result)) anchor = parsed.result; }
    }
    await saveJson(`raw/${String(declared.id).padStart(3, '0')}.json`, record);
    process.stdout.write(`${declared.id} ${provider.id} ${declared.role}: ${record.status}${failure ? ' (' + failure + ')' : ''}\n`);
  }
  const capture = { schemaVersion: '1.0', planSha256: planHash, runtime, completedAt: new Date().toISOString(), selectedHeader: anchor, headerComparison: { exactProviderHeadersEqual: validHeader(headers[0]) && validHeader(headers[1]) ? isDeepStrictEqual(headers[0], headers[1]) : null, note: 'No headers, states or addresses were replaced. Offline proof verification is separate.' }, accounting: { planned: 12, dispatches, completed: records.filter(r => r.status === 'completed').length, failed: records.filter(r => r.status === 'failed').length, notAttempted: records.filter(r => r.status === 'not_attempted').length, observedResponseBytes: observedBytes, elapsedMs: Math.round(performance.now() - started), limits: LIMITS, violations }, records };
  await saveJson('capture.json', capture);
  const artifacts = ['plan.json', 'capture.mjs', 'STARTED.json', 'capture.json', ...records.filter(r => r.response).flatMap(r => [`raw/${String(r.id).padStart(3, '0')}.json`, r.response.bodyPath])];
  const inventory = [];
  for (const path of artifacts) { const bytes = await readFile(join(ROOT, path)); inventory.push({ path, bytes: bytes.length, sha256: sha(bytes) }); }
  await saveJson('manifest.json', { schemaVersion: '1.0', planSha256: planHash, files: inventory, filesCount: inventory.length, bytes: inventory.reduce((sum, row) => sum + row.bytes, 0), scope: 'Sealed raw development capability packet. Independent verification and commentary, if added, are outside this inventory.' });
  process.stdout.write(JSON.stringify({ captureSha256: sha(await readFile(join(ROOT, 'capture.json'))), manifestSha256: sha(await readFile(join(ROOT, 'manifest.json'))), accounting: capture.accounting }) + '\n');
}

if (process.argv[2] === '--plan') { await saveJson('plan.json', await makePlan()); process.stdout.write(sha(await readFile(join(ROOT, 'plan.json'))) + '\n'); }
else if (process.argv[2] === '--run' && /^[0-9a-f]{64}$/.test(process.argv[3] ?? '')) await run(process.argv[3]);
else throw new Error('Use --plan once, then --run with the exact plan SHA-256.');
