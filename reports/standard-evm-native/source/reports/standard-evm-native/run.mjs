// One-shot development capture. Importing this file never starts a server or RPC.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
export const PROVIDER = 'https://eth.drpc.org';
export const IMPLEMENTATION_FILES = Object.freeze([
  'package.json', 'src/config.js', 'src/server.js', 'src/validate.js',
  'src/account-effects.js', 'src/affected-balances.js', 'src/allowances.js',
  'src/analyze.js', 'src/balances.js', 'src/current-state.js', 'src/historical-state.js',
  'src/lending-balances.js', 'src/lending.js', 'src/permissions.js', 'src/revert.js',
  'src/standard-loader.js', 'src/standard-rpc.js', 'src/standard-simulation.js',
  'src/rpc.js', 'src/state.js', 'src/state-diff.js', 'src/query-validation.js',
  'engines/standard-evm/package.json', 'engines/standard-evm/package-lock.json',
  'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/provider-state-diff.js',
  'engines/standard-evm/discovery.js', 'engines/standard-evm/native-effects.js',
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => 'engines/standard-evm/node_modules/@noble/hashes/' + name),
].sort());
export const SOURCE_FILES = Object.freeze([...IMPLEMENTATION_FILES,
  'engines/standard-evm/node_modules/@noble/hashes/LICENSE',
  'public/app.js', 'public/index.html', 'public/style.css',
  'reports/standard-evm-native/run.mjs', 'reports/standard-evm-native/freeze.mjs',
].sort());
export const LIMITS = Object.freeze({ cases: 3, rpcCallsPerCase: 65, totalRpcCalls: 195,
  rpcResponseBytes: 8 * 1024 * 1024, rpcTotalBytesPerCase: 32 * 1024 * 1024,
  rpcTotalBytes: 96 * 1024 * 1024, rpcRequestMs: 25000, rpcWallMs: 145000,
  httpRequestMs: 160000, httpResponseBytes: 128 * 1024 * 1024, closeGraceMs: 5000, retries: 0 });
export const INPUT_FILES = Object.freeze([
  { path: 'inputs/native-index.json', originalPath: 'reports/standard-evm-native-discovery/index.json', sha256: 'f4026a6a4eab5a8d1896a7953dd8af853ac7d65994dc368e7da129ddd17880fa' },
  { path: 'inputs/native-capture.json', originalPath: 'reports/standard-evm-native-discovery/capture.json', sha256: '59cf2cc3d92100ca62f9b13e69386ce4386bf308ca40f595904e9aab013a6b5c' },
  { path: 'inputs/native-manifest.json', originalPath: 'reports/standard-evm-native-discovery/manifest.json', sha256: '13a4087b44b2455860136f06aed3dd2ee9a2d87be367edcf2e25949dd4fadeda' },
  { path: 'inputs/swap-response.json', originalPath: 'reports/standard-evm-auto/swap-response.json', sha256: '2c28a1db535d44c493d51e6a6c01b9bcbfab50af66b033f043c67b07c4df0ff2' },
  { path: 'inputs/aave-response.json', originalPath: 'reports/standard-evm-auto/aave-response.json', sha256: '2fea1f944225742955948d2d9e93142095f9a78f7b1edb5f26047613a222388c' },
]);
export const sha = value => createHash('sha256').update(value).digest('hex');
export function requireCheck(value, code) { if (!value) { const error = new Error(code); error.code = code; throw error; } }
export function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
export function fileInfo(root, path) { const bytes = readFileSync(resolve(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }
export function listFiles(root, prefix = '') {
  return readdirSync(resolve(root, prefix)).flatMap(name => {
    const path = prefix ? prefix + '/' + name : name, stat = lstatSync(resolve(root, path));
    requireCheck(!stat.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
    return stat.isDirectory() ? listFiles(root, path) : (requireCheck(stat.isFile(), 'NON_FILE_NOT_ALLOWED'), [path]);
  }).sort();
}
export function fingerprint(root) {
  const hash = createHash('sha256');
  for (const path of IMPLEMENTATION_FILES) hash.update(path + '\0').update(readFileSync(resolve(root, path))).update('\0');
  return hash.digest('hex');
}
export function selectedCases(inputRoot) {
  const read = path => JSON.parse(readFileSync(resolve(inputRoot, path), 'utf8'));
  const native = read('inputs/native-index.json'), swap = read('inputs/swap-response.json'), aave = read('inputs/aave-response.json');
  const selected = native.selected;
  requireCheck(native.captureSha256 === INPUT_FILES[1].sha256 && native.status === 'candidate_found', 'NATIVE_SELECTION_INVALID');
  const input = { chainId: 1, from: selected.request.from, to: selected.request.to, data: selected.request.data,
    value: BigInt(selected.request.value).toString(10), block: selected.parentHash };
  requireCheck(input.value === '82848000000000000' && selected.request.gas === '0x4c4b40' && input.data === '0x', 'NATIVE_REQUEST_CHANGED');
  const cases = [
    { id: 'native-transfer', input, provenance: { inputFile: 'inputs/native-index.json', originalTransactionHash: selected.hash, sourceBlockHash: selected.sourceBlockHash, originalTransactionIndex: selected.sourceTransactionIndex, conversion: 'Only lossless hex wei to canonical decimal; fixed gas is supplied by the engine.' } },
    { id: 'internal-eth-swap', input: swap.apiRequest, provenance: { inputFile: 'inputs/swap-response.json', conversion: 'Exact unchanged automatic API request; contract-held assets do not imply sender ownership.' } },
    { id: 'aave-no-native', input: aave.apiRequest, provenance: { inputFile: 'inputs/aave-response.json', conversion: 'Exact unchanged automatic API request; no-native control.' } },
  ];
  return cases.map(item => {
    requireCheck(item.input.chainId === 1 && !Object.hasOwn(item.input, 'queries'), 'AUTOMATIC_INPUT_REQUIRED');
    const requestText = JSON.stringify(item.input);
    return { ...item, requestText, requestBytes: Buffer.byteLength(requestText), requestSha256: sha(requestText) };
  });
}

export async function verifyPacket(root = HERE) {
  const planBytes = readFileSync(resolve(root, 'plan.json')), plan = JSON.parse(planBytes);
  const frozen = JSON.parse(readFileSync(resolve(root, 'FROZEN.json')));
  requireCheck(frozen.planSha256 === sha(planBytes), 'FROZEN_PLAN_HASH_MISMATCH');
  requireCheck(plan.schemaVersion === '1.0' && plan.provider === PROVIDER && isDeepStrictEqual(plan.limits, LIMITS), 'PLAN_PROTOCOL_MISMATCH');
  requireCheck(isDeepStrictEqual(plan.sources.map(x => x.path), SOURCE_FILES), 'SOURCE_INVENTORY_MISMATCH');
  requireCheck(isDeepStrictEqual(listFiles(resolve(root, 'source')), SOURCE_FILES), 'ARCHIVE_INVENTORY_MISMATCH');
  for (const entry of plan.sources) requireCheck(isDeepStrictEqual(fileInfo(resolve(root, 'source'), entry.path), entry), 'ARCHIVE_HASH_MISMATCH');
  requireCheck(isDeepStrictEqual(plan.inputs.map(({ bytes, ...item }) => item), INPUT_FILES), 'INPUT_INVENTORY_MISMATCH');
  requireCheck(isDeepStrictEqual(listFiles(resolve(root, 'inputs')), INPUT_FILES.map(x => x.path.slice(7)).sort()), 'INPUT_ARCHIVE_MISMATCH');
  for (const entry of plan.inputs) requireCheck(isDeepStrictEqual(fileInfo(root, entry.path), { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }), 'INPUT_HASH_MISMATCH');
  requireCheck(isDeepStrictEqual(plan.cases, selectedCases(root)), 'CASE_SELECTION_MISMATCH');
  for (const name of ['run.mjs', 'freeze.mjs']) {
    const expected = plan.sources.find(x => x.path === 'reports/standard-evm-native/' + name);
    requireCheck(sha(readFileSync(resolve(root, name))) === expected.sha256, 'RUNNER_HASH_MISMATCH');
  }
  const archive = resolve(root, 'source');
  requireCheck(fingerprint(archive) === plan.implementation.sourceSha256, 'IMPLEMENTATION_HASH_MISMATCH');
  requireCheck(isDeepStrictEqual(plan.implementation.sourceFiles, IMPLEMENTATION_FILES), 'IMPLEMENTATION_INVENTORY_MISMATCH');
  // No application import precedes validation of every archived source byte.
  const { loadStandardApi } = await import(pathToFileURL(resolve(archive, 'src/standard-loader.js')));
  const api = await loadStandardApi();
  requireCheck(api && isDeepStrictEqual(api.implementation, plan.implementation), 'IMPLEMENTATION_IDENTITY_MISMATCH');
  for (const item of plan.cases) api.validateStandardSimulation(structuredClone(item.input));
  return { plan, planSha256: sha(planBytes), archive, api };
}

function boundedPost(port, item) {
  return new Promise(resolveResult => {
    const startedAt = new Date().toISOString(), start = performance.now(), chunks = [];
    let settled = false, status = null, bytes = 0, retainedBytes = 0;
    const digest = createHash('sha256');
    let req;
    const finish = (statusCode, complete) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const body = Buffer.concat(chunks);
      resolveResult({ caseId: item.id, startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - start,
        request: { method: 'POST', path: '/api/evm/simulate', bodyText: item.requestText, bytes: item.requestBytes, sha256: item.requestSha256 },
        response: { status, complete, bodyText: body.toString('utf8'), observedBytes: bytes, retainedBytes, observedPrefixSha256: digest.digest('hex'), retainedPrefixSha256: sha(body) },
        ...(statusCode ? { error: { code: statusCode } } : {}) });
    };
    const timer = setTimeout(() => { finish('HTTP_REQUEST_TIMEOUT', false); req?.destroy(); }, LIMITS.httpRequestMs);
    req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/evm/simulate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': item.requestBytes } }, res => {
      if (settled) { res.destroy(); return; }
      status = res.statusCode;
      res.on('data', chunk => {
        if (settled) return;
        const value = Buffer.from(chunk); digest.update(value); bytes += value.length;
        const prefix = value.subarray(0, Math.max(0, LIMITS.httpResponseBytes - retainedBytes)); chunks.push(prefix); retainedBytes += prefix.length;
        if (bytes > LIMITS.httpResponseBytes) { finish('HTTP_RESPONSE_TOO_LARGE', false); res.destroy(); req.destroy(); }
      });
      res.on('end', () => finish(null, true));
      res.on('error', () => finish('HTTP_RESPONSE_INTERRUPTED', false));
    });
    req.on('error', () => finish('HTTP_REQUEST_FAILED', false));
    req.end(item.requestText);
  });
}

export async function run(root = HERE) {
  const { plan, planSha256, archive } = await verifyPacket(root);
  requireCheck(!existsSync(resolve(root, 'manifest.json')), 'CAPTURE_ALREADY_SEALED');
  const { createAppServer } = await import(pathToFileURL(resolve(archive, 'src/server.js')));
  const { StandardRpcClient } = await import(pathToFileURL(resolve(archive, 'src/standard-rpc.js')));
  const generated = [], save = (name, value) => { writeJson(resolve(root, name), value); generated.push(name); };
  save('STARTED.json', { schemaVersion: '1.0', startedAt: new Date().toISOString(), planSha256,
    implementation: plan.implementation, sourceFiles: plan.sources, cases: plan.cases.map(x => ({ id: x.id, requestSha256: x.requestSha256 })), provider: PROVIDER, limits: LIMITS });
  for (const dir of ['http', 'client']) mkdirSync(resolve(root, dir), { recursive: false });
  let active = null, dispatched = 0, sequence = 0, sealed = false, fatal = null;
  const clients = [], exchanges = [], results = [], violations = [], handlerEnds = [];
  const server = createAppServer({ persist: false,
    rpcFactory: () => { violations.push('UNEXPECTED_LEGACY_RPC'); throw new Error('Legacy RPC forbidden.'); },
    standardRpcFactory: () => {
      requireCheck(active && !active.settled && clients.length < LIMITS.cases, 'UNPLANNED_RPC_CLIENT');
      const context = active;
      const rpc = new StandardRpcClient({ url: PROVIDER, fetchImpl: (url, options) => {
        if (context.settled || performance.now() - context.start >= LIMITS.httpRequestMs || dispatched >= LIMITS.totalRpcCalls || new URL(url).href !== PROVIDER + '/') {
          violations.push('RPC_DISPATCH_REJECTED'); throw new Error('Capture RPC boundary exceeded.');
        }
        dispatched++;
        return fetch(url, { ...options, signal: AbortSignal.any([options.signal, context.abort.signal]), redirect: 'error' });
      } });
      clients.push({ caseId: context.id, rpc }); return rpc;
    } });
  server.prependListener('request', (req, res) => {
    const index = ++sequence, context = active, item = plan.cases[index - 1], chunks = [], responseChunks = [];
    let responseBytes = 0, ended = false, resolveEnd;
    handlerEnds.push(new Promise(resolve => { resolveEnd = resolve; }));
    const startedAt = new Date().toISOString();
    if (!item || context?.id !== item.id || req.method !== 'POST' || req.url !== '/api/evm/simulate') violations.push('HTTP_REQUEST_ORDER_MISMATCH');
    req.on('data', chunk => { if (!sealed) chunks.push(Buffer.from(chunk)); });
    const append = (body, encoding) => {
      if (body === undefined || body === null || typeof body === 'function' || sealed) return;
      const value = Buffer.isBuffer(body) ? body : Buffer.from(body, typeof encoding === 'string' ? encoding : undefined);
      responseBytes += value.length;
      if (responseBytes <= LIMITS.httpResponseBytes) responseChunks.push(value); else violations.push('SERVER_HTTP_BODY_TOO_LARGE');
    };
    const originalWrite = res.write, originalEnd = res.end;
    res.write = function(body, encoding, callback) { append(body, encoding); return originalWrite.call(this, body, encoding, callback); };
    res.end = function(body, encoding, callback) {
      if (!ended && !sealed) {
        ended = true; append(body, encoding);
        const request = Buffer.concat(chunks), response = Buffer.concat(responseChunks);
        if (!item || request.toString('utf8') !== item.requestText) violations.push('HTTP_REQUEST_BODY_MISMATCH');
        const capture = { index, caseId: item?.id ?? null, startedAt, completedAt: new Date().toISOString(),
          request: { method: req.method, path: req.url, contentType: req.headers['content-type'], bodyText: request.toString('utf8'), bytes: request.length, sha256: sha(request) },
          response: { status: res.statusCode, bodyText: response.toString('utf8'), bytes: response.length, observedBytes: responseBytes, complete: response.length === responseBytes, sha256: sha(response) } };
        exchanges.push(capture); save('http/' + String(index).padStart(3, '0') + '.json', capture);
        resolveEnd();
      }
      return originalEnd.call(this, body, encoding, callback);
    };
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    console.log('Native capture started: ' + resolve(root, 'STARTED.json') + '; ephemeral port ' + port);
    for (const [index, item] of plan.cases.entries()) {
      active = { id: item.id, start: performance.now(), abort: new AbortController(), settled: false };
      const client = await boundedPost(port, item);
      active.settled = true; active.abort.abort();
      save('client/' + String(index + 1).padStart(3, '0') + '.json', client);
      let output = null;
      if (client.response.complete) {
        try { output = JSON.parse(client.response.bodyText); save(item.id + '-response.json', output); }
        catch { violations.push('API_RESPONSE_NOT_JSON'); }
      }
      const exchange = exchanges.find(x => x.caseId === item.id);
      if (client.response.complete && (!exchange || exchange.response.bodyText !== client.response.bodyText || exchange.response.status !== client.response.status)) violations.push('HTTP_RESPONSE_MISMATCH');
      if (output?.implementation && !isDeepStrictEqual(output.implementation, plan.implementation)) violations.push('OUTPUT_IMPLEMENTATION_MISMATCH');
      results.push({ id: item.id, attempted: true, httpStatus: client.response.status, complete: client.response.complete,
        captureStatus: client.response.complete ? 'response_captured' : 'incomplete',
        execution: output?.execution ?? null, nativeEffects: output?.nativeEffects ?? null,
        tokenMeasurements: output?.measurements?.length ?? 0,
        measuredTokenQueries: output?.measurements?.filter(x => x.status === 'measured').length ?? 0,
        measuredNativeAccounts: output?.nativeEffects?.measurements?.filter(x => x.status === 'measured').length ?? 0,
        error: client.error ?? output?.error ?? null });
      console.log('Captured ' + item.id + ': HTTP ' + client.response.status);
    }
  } catch (error) { fatal = { code: ['EACCES', 'EPERM', 'EADDRINUSE'].includes(error?.code) ? error.code : 'CAPTURE_INTERRUPTED' }; }
  finally {
    active?.abort.abort();
    server.closeAllConnections?.();
    await Promise.race([new Promise(resolve => server.close(() => resolve())), new Promise(resolve => setTimeout(resolve, LIMITS.closeGraceMs))]);
    await Promise.race([Promise.all(handlerEnds), new Promise(resolve => setTimeout(resolve, LIMITS.closeGraceMs))]);
    sealed = true;
  }
  for (const item of plan.cases) if (!results.some(x => x.id === item.id)) results.push({ id: item.id, attempted: false, reason: 'CAPTURE_INTERRUPTED_NO_REPLACEMENT' });
  const rpcEvidence = clients.map(({ caseId, rpc }) => ({ caseId, provider: PROVIDER, records: rpc.snapshotEvidence(), observedBytes: rpc.observedBytes }));
  const rpcCalls = rpcEvidence.reduce((sum, x) => sum + x.records.length, 0), responseBytes = rpcEvidence.reduce((sum, x) => sum + x.observedBytes, 0);
  if (rpcCalls > LIMITS.totalRpcCalls || dispatched > LIMITS.totalRpcCalls || responseBytes > LIMITS.rpcTotalBytes) violations.push('RECORDED_RPC_BUDGET_EXCEEDED');
  for (const entry of rpcEvidence) {
    const result = results.find(x => x.id === entry.caseId);
    if (result) { result.rpcCalls = entry.records.length; result.observedResponseBytes = entry.observedBytes; }
    const exchange = exchanges.find(x => x.caseId === entry.caseId);
    if (exchange?.response.complete) {
      try { const output = JSON.parse(exchange.response.bodyText); if (output.transportEvidence && !isDeepStrictEqual(output.transportEvidence, entry.records)) violations.push('API_TRANSPORT_EVIDENCE_MISMATCH'); } catch {}
    }
  }
  const sourceUnchanged = plan.sources.every(x => isDeepStrictEqual(fileInfo(archive, x.path), x));
  if (!sourceUnchanged) violations.push('ARCHIVE_CHANGED_DURING_CAPTURE');
  save('rpc-evidence.json', { schemaVersion: '1.0', clients: rpcEvidence, rpcCalls, publicDispatches: dispatched, observedResponseBytes: responseBytes });
  save('results.json', { schemaVersion: '1.0', completedAt: new Date().toISOString(), developmentOnly: true,
    status: fatal || violations.length ? 'incomplete' : 'completed',
    statusMeaning: 'Capture process completion, not simulation success or an accuracy verdict.',
    planSha256, implementation: plan.implementation,
    planned: 3, attempted: results.filter(x => x.attempted).length, retries: 0, replacements: 0, rpcCalls,
    publicDispatches: dispatched, observedResponseBytes: responseBytes, sourceUnchanged, violations, fatal, cases: results,
    limitations: ['Three preselected development cases; no prospective population or vendor score.',
      'Unsigned parent-block-end provider simulation; original signed fees and original transaction-position replay are excluded.',
      'Provider-reported native and token state consistency is not an independent execution oracle.',
      'Raw successful provider bodies are retained; rejected/error provider bodies retain only transport hashes/counts and sanitized errors.'] });
  const files = [...plan.sources.map(x => 'source/' + x.path), ...plan.inputs.map(x => x.path), 'run.mjs', 'freeze.mjs', 'plan.json', 'FROZEN.json', ...generated].sort();
  requireCheck(new Set(files).size === files.length, 'MANIFEST_DUPLICATE_PATH');
  writeJson(resolve(root, 'manifest.json'), { schemaVersion: '1.0', sealedAt: new Date().toISOString(), planSha256,
    implementationSha256: plan.implementation.sourceSha256, capturedRequests: exchanges.length, sourceFiles: plan.sources.length,
    plannedCases: plan.cases.map(x => ({ id: x.id, input: x.input, requestSha256: x.requestSha256 })), files: files.map(path => fileInfo(root, path)) });
  console.log('Sealed native capture: ' + resolve(root, 'manifest.json') + ' (' + rpcCalls + ' RPC calls)');
  if (fatal || violations.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  requireCheck(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'INVALID_ARGUMENTS');
  if (args[0] === '--check') { const { plan, planSha256 } = await verifyPacket(); console.log(JSON.stringify({ status: 'ready', planSha256, implementation: plan.implementation, cases: plan.cases.map(x => x.id), networkCalls: 0 })); }
  else await run();
}
