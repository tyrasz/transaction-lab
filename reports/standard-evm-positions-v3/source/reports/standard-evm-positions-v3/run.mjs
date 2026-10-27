// One-shot development capture. Importing this file never starts a server or RPC.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

import { INPUT_FILES, selectedCases } from './selection.mjs';
export { INPUT_FILES, selectedCases };
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
  'engines/standard-evm/unsigned-call.js', 'engines/standard-evm/position-queries.js', 'engines/standard-evm/provider-state-diff.js',
  'engines/standard-evm/discovery.js', 'engines/standard-evm/native-effects.js', 'engines/standard-evm/sequence-state.js',
  ...['package.json', 'sha3.js', '_u64.js', 'utils.js'].map(name => 'engines/standard-evm/node_modules/@noble/hashes/' + name),
].sort());
export const TEST_FILES = Object.freeze([
  ...['standard-auto-saved', 'standard-loader', 'standard-rpc', 'standard-server', 'standard-simulation', 'standard-sequence', 'standard-position', 'standard-position-ui'].map(name => 'test/' + name + '.test.js'),
  ...['discovery', 'native-effects', 'native-execution', 'provider-state-diff', 'sequence-state', 'sequence', 'unsigned-call', 'position-queries', 'position-execution'].map(name => 'engines/standard-evm/test/' + name + '.test.js'),
].sort());
export const DEPENDENCY_FILES = Object.freeze([
  "engines/standard-evm/node_modules/.package-lock.json",
  "engines/standard-evm/node_modules/@noble/hashes/LICENSE",
  "engines/standard-evm/node_modules/@noble/hashes/README.md",
  "engines/standard-evm/node_modules/@noble/hashes/_blake.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/_blake.js",
  "engines/standard-evm/node_modules/@noble/hashes/_md.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/_md.js",
  "engines/standard-evm/node_modules/@noble/hashes/_u64.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/_u64.js",
  "engines/standard-evm/node_modules/@noble/hashes/argon2.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/argon2.js",
  "engines/standard-evm/node_modules/@noble/hashes/blake1.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/blake1.js",
  "engines/standard-evm/node_modules/@noble/hashes/blake2.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/blake2.js",
  "engines/standard-evm/node_modules/@noble/hashes/blake3.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/blake3.js",
  "engines/standard-evm/node_modules/@noble/hashes/eskdf.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/eskdf.js",
  "engines/standard-evm/node_modules/@noble/hashes/hkdf.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/hkdf.js",
  "engines/standard-evm/node_modules/@noble/hashes/hmac.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/hmac.js",
  "engines/standard-evm/node_modules/@noble/hashes/index.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/index.js",
  "engines/standard-evm/node_modules/@noble/hashes/legacy.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/legacy.js",
  "engines/standard-evm/node_modules/@noble/hashes/package.json",
  "engines/standard-evm/node_modules/@noble/hashes/pbkdf2.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/pbkdf2.js",
  "engines/standard-evm/node_modules/@noble/hashes/scrypt.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/scrypt.js",
  "engines/standard-evm/node_modules/@noble/hashes/sha2.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/sha2.js",
  "engines/standard-evm/node_modules/@noble/hashes/sha3-addons.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/sha3-addons.js",
  "engines/standard-evm/node_modules/@noble/hashes/sha3.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/sha3.js",
  "engines/standard-evm/node_modules/@noble/hashes/src/_blake.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/_md.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/_u64.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/argon2.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/blake1.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/blake2.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/blake3.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/eskdf.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/hkdf.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/hmac.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/index.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/legacy.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/pbkdf2.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/scrypt.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/sha2.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/sha3-addons.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/sha3.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/utils.ts",
  "engines/standard-evm/node_modules/@noble/hashes/src/webcrypto.ts",
  "engines/standard-evm/node_modules/@noble/hashes/utils.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/utils.js",
  "engines/standard-evm/node_modules/@noble/hashes/webcrypto.d.ts",
  "engines/standard-evm/node_modules/@noble/hashes/webcrypto.js"
]);
export const SOURCE_FILES = Object.freeze([...new Set([...IMPLEMENTATION_FILES, ...TEST_FILES, ...DEPENDENCY_FILES,
  'public/app.js','public/index.html','public/style.css',
  // Pinned BEFORE-trace regression evidence only; never imported by the server
  // or passed as state/expected amounts to the new capture.
  'reports/standard-evm-positions-v2/aave-position-response.json',
  'reports/standard-evm-positions-v2/manifest.json',
  ...['run.mjs','freeze.mjs','selection.mjs','verify.mjs','checks.mjs','verify.test.mjs'].map(x=>'reports/standard-evm-positions-v3/'+x),
])].sort());
export const LIMITS = Object.freeze({ cases: 3, totalRpcCalls: 388, rpcResponseBytes: 8 * 1024 * 1024,
  rpcTotalBytes: 192 * 1024 * 1024, rpcRequestMs: 25000, totalWallMs: 600000,
  single: { rpcCalls: 65, rpcTotalBytes: 32 * 1024 * 1024, rpcWallMs: 145000, httpRequestMs: 160000 },
  sequence: { rpcCalls: 258, rpcTotalBytes: 128 * 1024 * 1024, rpcWallMs: 265000, httpRequestMs: 280000 },
  httpResponseBytes: 512 * 1024 * 1024, closeGraceMs: 5000, retries: 0, port: 0 });
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
export function validateCases(api, cases) {
  const plainSequence = value => ({ ...value, calls: value.calls.map(({ queries, ...call }) => call) });
  requireCheck(isDeepStrictEqual(plainSequence(cases[2].input), plainSequence(api.STANDARD_SEQUENCE_EXAMPLES[0].input)), 'SEQUENCE_EXAMPLE_ENVELOPE_CHANGED');
  for (const item of cases) {
    const normalized = (item.profile === 'sequence' ? api.validateStandardSequence : api.validateStandardSimulation)(structuredClone(item.input));
    requireCheck(isDeepStrictEqual(JSON.parse(JSON.stringify(normalized)), item.input), 'API_NORMALIZATION_CHANGED_INPUT');
  }
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
  requireCheck(isDeepStrictEqual(plan.cases, await selectedCases(root)), 'CASE_SELECTION_MISMATCH');
  for (const name of ['run.mjs','freeze.mjs','selection.mjs','verify.mjs','checks.mjs','verify.test.mjs']) {
    const expected = plan.sources.find(x => x.path === 'reports/standard-evm-positions-v3/' + name);
    requireCheck(sha(readFileSync(resolve(root, name))) === expected.sha256, 'RUNNER_HASH_MISMATCH');
  }
  const archive = resolve(root, 'source');
  requireCheck(fingerprint(archive) === plan.implementation.sourceSha256, 'IMPLEMENTATION_HASH_MISMATCH');
  requireCheck(isDeepStrictEqual(plan.implementation.sourceFiles, IMPLEMENTATION_FILES), 'IMPLEMENTATION_INVENTORY_MISMATCH');
  // No application import precedes validation of every archived source byte.
  const { loadStandardApi } = await import(pathToFileURL(resolve(archive, 'src/standard-loader.js')));
  const api = await loadStandardApi();
  requireCheck(api && isDeepStrictEqual(api.implementation, plan.implementation), 'IMPLEMENTATION_IDENTITY_MISMATCH');
  validateCases(api, plan.cases);
  return { plan, planSha256: sha(planBytes), archive, api };
}

function boundedPost(port, item, wallDeadline) {
  return new Promise(resolveResult => {
    const startedAt = new Date().toISOString(), start = performance.now(), chunks = [];
    let settled = false, status = null, bytes = 0, retainedBytes = 0;
    const digest = createHash('sha256');
    let req;
    const finish = (statusCode, complete) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const body = Buffer.concat(chunks);
      resolveResult({ caseId: item.id, startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - start,
        request: { method: 'POST', path: item.route, bodyText: item.requestText, bytes: item.requestBytes, sha256: item.requestSha256 },
        response: { status, complete, bodyText: body.toString('utf8'), observedBytes: bytes, retainedBytes, observedPrefixSha256: digest.digest('hex'), retainedPrefixSha256: sha(body) },
        ...(statusCode ? { error: { code: statusCode } } : {}) });
    };
    const timer = setTimeout(() => { finish('HTTP_REQUEST_TIMEOUT', false); req?.destroy(); }, Math.max(1, Math.min(LIMITS[item.profile].httpRequestMs, wallDeadline - performance.now())));
    req = httpRequest({ hostname: '127.0.0.1', port, path: item.route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': item.requestBytes } }, res => {
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
  const { StandardRpcClient, STANDARD_RPC_LIMITS, STANDARD_SEQUENCE_RPC_LIMITS } = await import(pathToFileURL(resolve(archive, 'src/standard-rpc.js')));
  for (const [profile, actual] of [['single', STANDARD_RPC_LIMITS], ['sequence', STANDARD_SEQUENCE_RPC_LIMITS]]) {
    const expected = LIMITS[profile];
    requireCheck(isDeepStrictEqual(actual, { calls: expected.rpcCalls, responseBytes: LIMITS.rpcResponseBytes, totalBytes: expected.rpcTotalBytes, wallMs: expected.rpcWallMs, requestMs: LIMITS.rpcRequestMs }), 'TRANSPORT_PROFILE_LIMIT_MISMATCH');
  }
  const runStarted = performance.now(), wallDeadline = runStarted + LIMITS.totalWallMs, wallAbort = new AbortController();
  let wallTimer;
  const generated = [], save = (name, value) => { writeJson(resolve(root, name), value); generated.push(name); };
  save('STARTED.json', { schemaVersion: '1.0', startedAt: new Date().toISOString(), planSha256,
    implementation: plan.implementation, sourceFiles: plan.sources, cases: plan.cases.map(x => ({ id: x.id, requestSha256: x.requestSha256 })), provider: PROVIDER, limits: LIMITS });
  for (const dir of ['http', 'client']) mkdirSync(resolve(root, dir), { recursive: false });
  let active = null, dispatched = 0, sequence = 0, sealed = false, fatal = null;
  const clients = [], exchanges = [], results = [], violations = [], handlerEnds = [];
  const server = createAppServer({ persist: false,
    rpcFactory: () => { violations.push('UNEXPECTED_LEGACY_RPC'); throw new Error('Legacy RPC forbidden.'); },
    standardRpcFactory: options => {
      requireCheck(active && !active.settled && clients.length < LIMITS.cases, 'UNPLANNED_RPC_CLIENT');
      const context = active;
      requireCheck(options?.profile === context.profile && !clients.some(x => x.caseId === context.id), 'RPC_PROFILE_OR_CLIENT_COUNT_MISMATCH');
      const rpc = new StandardRpcClient({ url: PROVIDER, profile: context.profile, fetchImpl: (url, options) => {
        if (context.settled || performance.now() - context.start >= LIMITS[context.profile].httpRequestMs || performance.now() >= wallDeadline || wallAbort.signal.aborted || clients.reduce((sum, item) => sum + item.rpc.observedBytes, 0) >= LIMITS.rpcTotalBytes || dispatched >= LIMITS.totalRpcCalls || new URL(url).href !== PROVIDER + '/') {
          violations.push('RPC_DISPATCH_REJECTED'); throw new Error('Capture RPC boundary exceeded.');
        }
        dispatched++;
        return fetch(url, { ...options, signal: AbortSignal.any([options.signal, context.abort.signal, wallAbort.signal]), redirect: 'error' });
      } });
      clients.push({ caseId: context.id, profile: context.profile, rpc }); return rpc;
    } });
  server.prependListener('request', (req, res) => {
    const index = ++sequence, context = active, item = plan.cases[index - 1], chunks = [], responseChunks = [];
    let responseBytes = 0, ended = false, resolveEnd;
    handlerEnds.push(new Promise(resolve => { resolveEnd = resolve; }));
    const startedAt = new Date().toISOString();
    if (!item || context?.id !== item.id || req.method !== 'POST' || req.url !== item?.route) violations.push('HTTP_REQUEST_ORDER_MISMATCH');
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
    wallTimer = setTimeout(() => wallAbort.abort(), Math.max(1, wallDeadline - performance.now()));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(LIMITS.port, '127.0.0.1', resolve); });
    const port = server.address().port;
    console.log('Position capture started: ' + resolve(root, 'STARTED.json') + '; archived service port ' + port);
    for (const [index, item] of plan.cases.entries()) {
      if (performance.now() >= wallDeadline || wallAbort.signal.aborted) { fatal = { code: 'CAPTURE_WALL_BUDGET_EXHAUSTED' }; break; }
      active = { id: item.id, profile: item.profile, start: performance.now(), abort: new AbortController(), settled: false };
      const client = await boundedPost(port, item, wallDeadline);
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
        profile: item.profile, route: item.route, hypothesis: item.hypothesis,
        sequenceStatus: item.profile === 'sequence' ? output?.sequence?.status ?? null : null,
        sequence: item.profile === 'sequence' ? output?.sequence ?? null : null,
        canonicalStatus: output?.canonicalStatus ?? null,
        steps: output?.steps?.map(step => ({ index: step.index, status: step.status, executionStatus: step.result?.execution?.status ?? null,
          canonicalStatus: step.result?.canonicalStatus ?? null, stateSource: step.stateSource,
          measuredTokenQueries: step.result?.measurements?.filter(x => !x.position && x.status === 'measured').length ?? 0,
          measuredPositionQueries: step.result?.measurements?.filter(x => x.position && x.status === 'measured').length ?? 0,
          measuredNativeAccounts: step.result?.nativeEffects?.measurements?.filter(x => x.status === 'measured').length ?? 0 })) ?? null,
        execution: output?.execution ?? null, nativeEffects: output?.nativeEffects ?? null,
        tokenMeasurements: output?.measurements?.filter(x => !x.position).length ?? 0,
        positionMeasurements: output?.measurements?.filter(x => x.position).length ?? 0,
        measuredPositionQueries: output?.measurements?.filter(x => x.position && x.status === 'measured').length ?? 0,
        measuredTokenQueries: output?.measurements?.filter(x => !x.position && x.status === 'measured').length ?? 0,
        measuredNativeAccounts: output?.nativeEffects?.measurements?.filter(x => x.status === 'measured').length ?? 0,
        error: client.error ?? output?.error ?? null });
      console.log('Captured ' + item.id + ': HTTP ' + client.response.status);
    }
  } catch (error) { fatal = { code: ['EACCES', 'EPERM', 'EADDRINUSE'].includes(error?.code) ? error.code : 'CAPTURE_INTERRUPTED' }; }
  finally {
    active?.abort.abort(); wallAbort.abort(); clearTimeout(wallTimer);
    server.closeAllConnections?.();
    await Promise.race([new Promise(resolve => server.close(() => resolve())), new Promise(resolve => setTimeout(resolve, LIMITS.closeGraceMs))]);
    await Promise.race([Promise.all(handlerEnds), new Promise(resolve => setTimeout(resolve, LIMITS.closeGraceMs))]);
    sealed = true;
  }
  for (const item of plan.cases) if (!results.some(x => x.id === item.id)) results.push({ id: item.id, attempted: false, reason: 'CAPTURE_INTERRUPTED_NO_REPLACEMENT' });
  const rpcEvidence = clients.map(({ caseId, profile, rpc }) => ({ caseId, profile, provider: PROVIDER, records: rpc.snapshotEvidence(), observedBytes: rpc.observedBytes }));
  const rpcCalls = rpcEvidence.reduce((sum, x) => sum + x.records.length, 0), responseBytes = rpcEvidence.reduce((sum, x) => sum + x.observedBytes, 0);
  if (rpcCalls > LIMITS.totalRpcCalls || dispatched > LIMITS.totalRpcCalls || responseBytes > LIMITS.rpcTotalBytes) violations.push('RECORDED_RPC_BUDGET_EXCEEDED');
  for (const entry of rpcEvidence) {
    if (entry.records.length > LIMITS[entry.profile].rpcCalls || entry.observedBytes > LIMITS[entry.profile].rpcTotalBytes) violations.push('RECORDED_PROFILE_BUDGET_EXCEEDED');
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
    statusMeaning: 'Capture process completion, not simulation success or an accuracy verdict. Declared reverts are retained outcomes.',
    durationMs: performance.now() - runStarted,
    planSha256, implementation: plan.implementation,
    planned: 3, attempted: results.filter(x => x.attempted).length, retries: 0, replacements: 0, rpcCalls,
    publicDispatches: dispatched, observedResponseBytes: responseBytes, sourceUnchanged, violations, fatal, cases: results,
    limitations: ['Three preselected position-query development cases; no prospective population or vendor score.',
      'Two historical deposit envelopes and one constructed Aave sequence start at their declared historical block ends. Prior outputs identify query subjects only, never state or amounts.',
      'Sequence calls are ordered, separate unsigned executions, not an atomic bundle or signed transaction sequence.',
      'Unsigned parent-block-end provider simulation; original signed fees and original transaction-position replay are excluded.',
      'Provider-reported native and token state consistency is not an independent execution oracle.',
      'Raw successful provider bodies are retained; rejected/error provider bodies retain only transport hashes/counts and sanitized errors.'] });
  const files = [...plan.sources.map(x => 'source/' + x.path), ...plan.inputs.map(x => x.path), 'run.mjs', 'freeze.mjs', 'selection.mjs', 'verify.mjs', 'checks.mjs', 'verify.test.mjs', 'plan.json', 'FROZEN.json', ...generated].sort();
  requireCheck(new Set(files).size === files.length, 'MANIFEST_DUPLICATE_PATH');
  writeJson(resolve(root, 'manifest.json'), { schemaVersion: '1.0', sealedAt: new Date().toISOString(), planSha256,
    implementationSha256: plan.implementation.sourceSha256, capturedRequests: exchanges.length, sourceFiles: plan.sources.length,
    plannedCases: plan.cases.map(x => ({ id: x.id, route: x.route, profile: x.profile, input: x.input, requestSha256: x.requestSha256 })), files: files.map(path => fileInfo(root, path)) });
  console.log('Sealed position capture: ' + resolve(root, 'manifest.json') + ' (' + rpcCalls + ' RPC calls)');
  if (fatal || violations.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  requireCheck(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'INVALID_ARGUMENTS');
  if (args[0] === '--check') { const { plan, planSha256 } = await verifyPacket(); console.log(JSON.stringify({ status: 'ready', planSha256, implementation: plan.implementation, cases: plan.cases.map(x => x.id), networkCalls: 0 })); }
  else await run();
}


